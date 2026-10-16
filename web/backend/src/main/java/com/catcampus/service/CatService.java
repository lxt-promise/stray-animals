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
        validateGeo(cat);
        if (cat.getId() != null) {
            Cat old = catRepository.findById(cat.getId()).orElseThrow(() -> new BizException("猫咪不存在"));
            // 数据隔离：编辑路径必须同校。早期不校验，A 校成员可编辑/覆盖 B 校档案
            // （schoolId 由请求体可控，还可传 null 让记录混进全局查询）
            Long mySchool = com.catcampus.common.CurrentUser.schoolId();
            if (mySchool != null && old.getSchoolId() != null && !mySchool.equals(old.getSchoolId())) {
                throw new BizException("无权编辑其他校区的档案");
            }
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
        Cat old = catRepository.findById(id).orElseThrow(() -> new BizException("猫咪不存在"));
        Long mySchool = com.catcampus.common.CurrentUser.schoolId();
        if (mySchool != null && old.getSchoolId() != null && !mySchool.equals(old.getSchoolId())) {
            throw new BizException("无权删除其他校区的档案");
        }
        catRepository.delete(old);
    }

    /** 坐标入库前校验。
     *  Spring 的 String→Double 走 parseDouble，可接收字面量 "NaN"/"Infinity"；
     *  Jackson 可把 1e400 转成 Infinity。这些值会让地图点位异常或消失，
     *  且隐私抖动脱敏对 NaN 毫无意义（Math.sin(NaN) = NaN）。 */
    private void validateGeo(Cat cat) {
        if (cat.getLocationLat() != null) {
            double lat = cat.getLocationLat();
            if (!Double.isFinite(lat) || Math.abs(lat) > 90) throw new BizException("纬度超出范围（-90 ~ 90）");
        }
        if (cat.getLocationLng() != null) {
            double lng = cat.getLocationLng();
            if (!Double.isFinite(lng) || Math.abs(lng) > 180) throw new BizException("经度超出范围（-180 ~ 180）");
        }
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
            // 两个坐标必须同时判空：前端两个输入框互相独立，只填纬度时
            // locationLat != null && locationLng == null，下面拆箱直接 NPE 500
            if (c.getLocationLat() != null && c.getLocationLng() != null) {
                double lat = c.getLocationLat();
                double lng = c.getLocationLng();
                double seed = Math.sin(lat * 1000 + lng * 1000);
                c.setLocationLat(lat + (seed % 1) * 0.0007);
                c.setLocationLng(lng + (Math.cos(lat * 977) % 1) * 0.0007);
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
