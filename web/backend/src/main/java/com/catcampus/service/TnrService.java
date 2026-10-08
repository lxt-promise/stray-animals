package com.catcampus.service;

import com.catcampus.common.BizException;
import com.catcampus.common.CurrentUser;
import com.catcampus.entity.Cat;
import com.catcampus.entity.TnrRecord;
import com.catcampus.repository.CatRepository;
import com.catcampus.repository.TnrRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

@Service
@RequiredArgsConstructor
public class TnrService {

    private final TnrRepository tnrRepository;
    private final CatRepository catRepository;

    public List<TnrRecord> list(Long schoolId) {
        if (schoolId == null) return tnrRepository.findAll();
        return tnrRepository.findBySchoolIdOrderByCreatedAtDesc(schoolId);
    }

    public Map<String, Object> summary(Long schoolId) {
        List<TnrRecord> all = list(schoolId);
        long done = all.stream().filter(t -> "released".equals(t.getStatus()) || "adopted".equals(t.getStatus())).count();
        BigDecimal cost = all.stream().map(t -> t.getCost() == null ? BigDecimal.ZERO : t.getCost())
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        return Map.of("total", all.size(), "done", done, "cost", cost);
    }

    @Transactional
    public TnrRecord save(TnrRecord t) {
        CurrentUser.requireMember();
        if (t.getCatId() == null && (t.getCatName() == null || t.getCatName().isBlank())) {
            throw new BizException("请选择或填写猫咪");
        }
        if (t.getSchoolId() == null) t.setSchoolId(CurrentUser.schoolId());
        TnrRecord saved = tnrRepository.save(t);

        // 完成手术或放归 → 同步猫档案的绝育状态（台账与档案联动，避免两处数据打架）
        if (saved.getCatId() != null && ("released".equals(saved.getStatus()) || "surgery".equals(saved.getStatus()))) {
            catRepository.findById(saved.getCatId()).ifPresent(c -> {
                c.setSterilized("yes");
                if (saved.getEarMark() != null && !saved.getEarMark().isBlank()) c.setEarMark(saved.getEarMark());
                if ("campus".equals(c.getStatus()) || c.getStatus() == null) c.setStatus("campus");
                catRepository.save(c);
            });
        }
        return saved;
    }

    public List<TnrRecord> ofCat(Long catId) {
        return tnrRepository.findByCatIdOrderByCreatedAtDesc(catId);
    }
}
