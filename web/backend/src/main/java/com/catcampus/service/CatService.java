package com.catcampus.service;

import com.catcampus.common.BizException;
import com.catcampus.entity.Cat;
import com.catcampus.entity.Sighting;
import com.catcampus.repository.CatRepository;
import com.catcampus.repository.SightingRepository;
import jakarta.persistence.criteria.Predicate;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

@Service
@RequiredArgsConstructor
public class CatService {

    private final CatRepository catRepository;
    private final SightingRepository sightingRepository;

    /** 列表（动态条件） */
    public Page<Cat> page(int page, int size, Long schoolId, String status, String sterilized,
                          String pattern, String keyword) {
        Specification<Cat> spec = (root, query, cb) -> {
            List<Predicate> ps = new ArrayList<>();
            if (schoolId != null) ps.add(cb.equal(root.get("schoolId"), schoolId));
            if (notBlank(status)) ps.add(cb.equal(root.get("status"), status));
            if (notBlank(sterilized)) ps.add(cb.equal(root.get("sterilized"), sterilized));
            if (notBlank(pattern)) ps.add(cb.equal(root.get("pattern"), pattern));
            if (notBlank(keyword)) {
                String like = "%" + keyword.trim() + "%";
                ps.add(cb.or(
                        cb.like(root.get("name"), like),
                        cb.like(root.get("alias"), like),
                        cb.like(root.get("locationName"), like)
                ));
            }
            return cb.and(ps.toArray(new Predicate[0]));
        };
        Page<Cat> p = catRepository.findAll(spec, PageRequest.of(Math.max(page - 1, 0), Math.min(size, 100),
                Sort.by(Sort.Direction.DESC, "updatedAt")));
        p.getContent().forEach(this::fillTransient);
        return p;
    }

    /** 地图用：所有有点位的猫 */
    public List<Cat> mapCats(Long schoolId) {
        List<Cat> all = schoolId == null
                ? catRepository.findAll()
                : catRepository.findAll().stream().filter(c -> schoolId.equals(c.getSchoolId())).toList();
        List<Cat> list = all.stream()
                .filter(c -> c.getLocationLat() != null && c.getLocationLng() != null)
                .toList();
        list.forEach(this::fillTransient);
        return list;
    }

    public Cat detail(Long id) {
        Cat c = catRepository.findById(id).orElseThrow(() -> new BizException("猫咪不存在"));
        fillTransient(c);
        return c;
    }

    public List<Sighting> sightingsOf(Long catId) {
        List<Sighting> list = sightingRepository.findTop50ByCatIdOrderByCreatedAtDesc(catId);
        list.forEach(s -> s.setPhotoList(split(s.getPhotos())));
        return list;
    }

    @Transactional
    public Cat save(Cat cat) {
        if (cat.getName() == null || cat.getName().isBlank()) throw new BizException("请填写猫咪名字");
        if (cat.getId() != null) {
            Cat old = catRepository.findById(cat.getId()).orElseThrow(() -> new BizException("猫咪不存在"));
            cat.setCreatedAt(old.getCreatedAt());
            cat.setSightingCount(old.getSightingCount());
            if (cat.getSchoolId() == null) cat.setSchoolId(old.getSchoolId());
        }
        if (cat.getSchoolId() == null) {
            cat.setSchoolId(com.catcampus.common.CurrentUser.schoolId());
        }
        Cat saved = catRepository.save(cat);
        fillTransient(saved);
        return saved;
    }

    public void delete(Long id) {
        catRepository.deleteById(id);
    }

    /** 填充非持久化字段，方便前端直接渲染 */
    public void fillTransient(Cat c) {
        c.setPhotoList(split(c.getPhotos()));
        c.setCharacterList(split(c.getCharacters()));
    }

    /** 隐私脱敏：非社团成员看不到精确坐标与内部信息 */
    public void sanitize(Cat c) {
        if (com.catcampus.common.CurrentUser.isMember()) return;
        if (Boolean.TRUE.equals(c.getSpotPrivate()) || "kitten".equals(c.getStatus()) || "sick".equals(c.getStatus())) {
            if (c.getLocationLat() != null) {
                double seed = Math.sin(c.getLocationLat() * 1000 + c.getLocationLng() * 1000);
                c.setLocationLat(c.getLocationLat() + (seed % 1) * 0.0007);
                c.setLocationLng(c.getLocationLng() + (Math.cos(c.getLocationLat() * 977) % 1) * 0.0007);
            }
        }
        c.setInternalNote(null);
        c.setMedicalNote(null);
    }

    public static List<String> split(String s) {
        if (s == null || s.isBlank()) return new ArrayList<>();
        return Arrays.stream(s.split(",")).map(String::trim).filter(x -> !x.isEmpty()).toList();
    }

    private boolean notBlank(String s) { return s != null && !s.isBlank(); }
}
