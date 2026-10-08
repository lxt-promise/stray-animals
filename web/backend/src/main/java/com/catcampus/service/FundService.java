package com.catcampus.service;

import com.catcampus.common.BizException;
import com.catcampus.common.CurrentUser;
import com.catcampus.entity.Fund;
import com.catcampus.entity.User;
import com.catcampus.repository.FundRepository;
import com.catcampus.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Service
@RequiredArgsConstructor
public class FundService {

    private final FundRepository fundRepository;
    private final UserRepository userRepository;

    public List<Fund> list(Long schoolId) {
        CurrentUser.requireMember();
        if (schoolId == null) return fundRepository.findAll();
        return fundRepository.findBySchoolIdOrderByDateDescIdDesc(schoolId);
    }

    public Map<String, Object> summary(Long schoolId) {
        if (schoolId == null) return Map.of("income", 0, "expense", 0, "balance", 0);
        BigDecimal income = fundRepository.findBySchoolIdAndType(schoolId, "income").stream()
                .map(f -> f.getAmount() == null ? BigDecimal.ZERO : f.getAmount())
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        BigDecimal expense = fundRepository.findBySchoolIdAndType(schoolId, "expense").stream()
                .map(f -> f.getAmount() == null ? BigDecimal.ZERO : f.getAmount())
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        Map<String, Object> m = new HashMap<>();
        m.put("income", income);
        m.put("expense", expense);
        m.put("balance", income.subtract(expense));
        return m;
    }

    @Transactional
    public Fund add(Fund f) {
        CurrentUser.requireMember();
        if (f.getAmount() == null || f.getAmount().compareTo(BigDecimal.ZERO) <= 0) throw new BizException("请填写金额");
        if (!"income".equals(f.getType()) && !"expense".equals(f.getType())) throw new BizException("类型错误");
        if (f.getSchoolId() == null) f.setSchoolId(CurrentUser.schoolId());
        if (f.getTitle() == null || f.getTitle().isBlank()) {
            f.setTitle("income".equals(f.getType()) ? "捐赠" : "支出");
        }
        if (f.getDate() == null || f.getDate().isBlank()) {
            f.setDate(java.time.LocalDate.now().toString());
        }
        User me = userRepository.findById(CurrentUser.id()).orElse(null);
        if (me != null) f.setOperator(me.getNickName());
        return fundRepository.save(f);
    }
}
