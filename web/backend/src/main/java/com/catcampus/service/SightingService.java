package com.catcampus.service;

import com.catcampus.common.BizException;
import com.catcampus.common.CurrentUser;
import com.catcampus.entity.Cat;
import com.catcampus.entity.Sighting;
import com.catcampus.entity.User;
import com.catcampus.repository.CatRepository;
import com.catcampus.repository.SightingRepository;
import com.catcampus.repository.UserRepository;
import jakarta.persistence.criteria.Predicate;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class SightingService {

    /** 积分规则：只奖励「记录」行为，绝不奖励投喂（避免把公益异化成消费） */
    private static final int P_SIGHTING = 10;
    private static final int P_NEW_CAT = 30;
    private static final int P_FIRST_MEET = 20;
    private static final int DAILY_CAP = 60;

    private final SightingRepository sightingRepository;
    private final CatRepository catRepository;
    private final UserRepository userRepository;

    @Transactional
    public Sighting add(Sighting s) {
        CurrentUser.requireLogin();
        Long uid = CurrentUser.id();
        User me = userRepository.findById(uid).orElseThrow(() -> new BizException("用户不存在"));

        LocalDateTime todayStart = LocalDate.now().atStartOfDay();
        // 日上限按「今日已获积分合计」计算：早期只数基础打卡分（todayCount * 10），
        // 导致「不选猫 +30」「首次遇见 +20」不受 cap 约束 —— 每天 6 条不选猫的目击稳拿 240 分
        int todayEarned = sightingRepository.sumPointsByReporterIdAndCreatedAtAfter(uid, todayStart);
        int room = Math.max(0, DAILY_CAP - todayEarned);

        boolean named = s.getCatId() != null;
        Set<Long> seen = new java.util.HashSet<>(UserService.splitIds(me.getCatSeen()));
        boolean firstMeet = named && !seen.contains(s.getCatId());

        int want = P_SIGHTING;
        if (!named) want += P_NEW_CAT;
        if (firstMeet) want += P_FIRST_MEET;
        int gain = Math.min(want, room);   // 超出日上限的部分整体置 0，任何奖励都不绕过

        s.setPending(!named);
        s.setReporterId(uid);
        s.setReporterName(me.getNickName());
        s.setPoints(gain);
        if (s.getSchoolId() == null) s.setSchoolId(CurrentUser.schoolId());
        if (s.getCount() == null) s.setCount(1);
        if (!named && (s.getCatName() == null || s.getCatName().isBlank())) s.setCatName("未认领的新猫");

        Sighting saved = sightingRepository.save(s);

        // 积分/计数一律走原子 SQL：读-改-写（me.setPoints(...)+save）在并发打卡下
        // 会丢失更新（两个请求都读到旧值，后写的覆盖先写的）
        userRepository.addPoints(uid, gain);
        userRepository.addSightingCount(uid, 1);
        if (firstMeet) {
            seen.add(s.getCatId());
            userRepository.updateCatSeen(uid,
                    seen.stream().map(String::valueOf).collect(Collectors.joining(",")));
        }

        if (named) {
            catRepository.findById(s.getCatId()).ifPresent(c -> {
                c.setSightingCount((c.getSightingCount() == null ? 0 : c.getSightingCount()) + 1);
                c.setLastSeenAt(LocalDateTime.now());
                catRepository.save(c);
            });
        }
        saved.setPhotoList(CatService.split(saved.getPhotos()));
        return saved;
    }

    public Page<Sighting> page(int page, int size, Long schoolId, Long catId, Boolean pending, Long mine) {
        Specification<Sighting> spec = (root, query, cb) -> {
            List<Predicate> ps = new ArrayList<>();
            if (schoolId != null) ps.add(cb.equal(root.get("schoolId"), schoolId));
            if (catId != null) ps.add(cb.equal(root.get("catId"), catId));
            if (pending != null && pending) ps.add(cb.isTrue(root.get("pending")));
            if (mine != null) ps.add(cb.equal(root.get("reporterId"), mine));
            return cb.and(ps.toArray(new Predicate[0]));
        };
        Page<Sighting> p = sightingRepository.findAll(spec,
                PageRequest.of(Math.max(page - 1, 0), Math.min(size, 100),
                        Sort.by(Sort.Direction.DESC, "createdAt")));
        p.getContent().forEach(s -> s.setPhotoList(CatService.split(s.getPhotos())));

        // 附带猫名，前端免二次请求
        Set<Long> ids = p.getContent().stream().map(Sighting::getCatId).filter(x -> x != null).collect(Collectors.toSet());
        if (!ids.isEmpty()) {
            Map<Long, Cat> cats = catRepository.findAllById(ids).stream()
                    .collect(Collectors.toMap(Cat::getId, c -> c));
            p.getContent().forEach(s -> {
                if (s.getCatId() != null && cats.containsKey(s.getCatId())) {
                    s.setCatName(cats.get(s.getCatId()).getName());
                }
            });
        }
        return p;
    }

    /** 某只猫的目击时间线 */
    public List<Sighting> sightingsOf(Long catId) {
        List<Sighting> list = sightingRepository.findTop50ByCatIdOrderByCreatedAtDesc(catId);
        list.forEach(s -> s.setPhotoList(CatService.split(s.getPhotos())));
        return list;
    }

    public List<Sighting> recent(Long schoolId, int n) {
        List<Sighting> list = schoolId == null
                ? sightingRepository.findAll(Sort.by(Sort.Direction.DESC, "createdAt")).stream().limit(n).toList()
                : sightingRepository.findTop20BySchoolIdOrderByCreatedAtDesc(schoolId).stream().limit(n).toList();
        list.forEach(s -> s.setPhotoList(CatService.split(s.getPhotos())));
        return list;
    }
}
