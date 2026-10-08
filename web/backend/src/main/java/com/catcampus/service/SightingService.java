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
        int todayCount = sightingRepository.countByReporterIdAndCreatedAtAfter(uid, todayStart);

        boolean named = s.getCatId() != null;
        int gain = todayCount * P_SIGHTING >= DAILY_CAP ? 0 : P_SIGHTING;
        if (!named) gain += P_NEW_CAT;

        Set<Long> seen = new java.util.HashSet<>(UserService.splitIds(me.getCatSeen()));
        boolean firstMeet = named && !seen.contains(s.getCatId());
        if (firstMeet) gain += P_FIRST_MEET;

        s.setPending(!named);
        s.setReporterId(uid);
        s.setReporterName(me.getNickName());
        s.setPoints(gain);
        if (s.getSchoolId() == null) s.setSchoolId(CurrentUser.schoolId());
        if (s.getCount() == null) s.setCount(1);
        if (!named && (s.getCatName() == null || s.getCatName().isBlank())) s.setCatName("未认领的新猫");

        Sighting saved = sightingRepository.save(s);

        me.setPoints((me.getPoints() == null ? 0 : me.getPoints()) + gain);
        me.setSightingCount((me.getSightingCount() == null ? 0 : me.getSightingCount()) + 1);
        if (firstMeet) {
            seen.add(s.getCatId());
            me.setCatSeen(seen.stream().map(String::valueOf).collect(Collectors.joining(",")));
        }
        userRepository.save(me);

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
