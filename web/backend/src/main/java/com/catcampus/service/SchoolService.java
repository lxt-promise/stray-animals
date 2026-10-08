package com.catcampus.service;

import com.catcampus.common.BizException;
import com.catcampus.common.CurrentUser;
import com.catcampus.entity.School;
import com.catcampus.entity.User;
import com.catcampus.repository.SchoolRepository;
import com.catcampus.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@RequiredArgsConstructor
public class SchoolService {

    private final SchoolRepository schoolRepository;
    private final UserRepository userRepository;

    public List<School> list() {
        return schoolRepository.findAll();
    }

    public School get(Long id) {
        return schoolRepository.findById(id).orElse(null);
    }

    @Transactional
    public School create(School s) {
        CurrentUser.requireAdmin();
        if (s.getName() == null || s.getName().isBlank()) throw new BizException("请填写学校名称");
        School saved = schoolRepository.save(s);

        // 创建者自动绑定该校
        User me = userRepository.findById(CurrentUser.id()).orElse(null);
        if (me != null) {
            me.setSchoolId(saved.getId());
            userRepository.save(me);
        }
        return saved;
    }

    @Transactional
    public User bind(Long schoolId) {
        CurrentUser.requireLogin();
        User me = userRepository.findById(CurrentUser.id()).orElseThrow(() -> new BizException("用户不存在"));
        me.setSchoolId(schoolId);
        return userRepository.save(me);
    }
}
