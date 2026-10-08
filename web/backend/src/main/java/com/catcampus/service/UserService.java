package com.catcampus.service;

import com.catcampus.common.BizException;
import com.catcampus.common.CurrentUser;
import com.catcampus.common.JwtUtil;
import com.catcampus.entity.Apply;
import com.catcampus.entity.User;
import com.catcampus.repository.ApplyRepository;
import com.catcampus.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Service
@RequiredArgsConstructor
public class UserService {

    private final UserRepository userRepository;
    private final ApplyRepository applyRepository;
    private final JwtUtil jwtUtil;
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();

    public Map<String, Object> register(String username, String password, String nickName, String contact, Long schoolId) {
        if (username == null || username.isBlank()) throw new BizException("请填写用户名");
        if (password == null || password.length() < 6) throw new BizException("密码至少 6 位");
        if (userRepository.existsByUsername(username)) throw new BizException("用户名已存在");

        // 冷启动：第一个注册的用户自动成为管理员
        boolean first = userRepository.count() == 0;

        User u = new User();
        u.setUsername(username);
        u.setPassword(encoder.encode(password));
        u.setNickName(nickName == null || nickName.isBlank() ? username : nickName);
        u.setContact(contact);
        u.setRole(first ? "admin" : "visitor");
        u.setSchoolId(schoolId);
        u.setLastSeenAt(LocalDateTime.now());
        userRepository.save(u);

        return toLoginResult(u);
    }

    public Map<String, Object> login(String username, String password) {
        User u = userRepository.findByUsername(username)
                .orElseThrow(() -> new BizException("用户不存在"));
        if (!encoder.matches(password, u.getPassword())) throw new BizException("密码错误");
        u.setLastSeenAt(LocalDateTime.now());
        userRepository.save(u);
        return toLoginResult(u);
    }

    private Map<String, Object> toLoginResult(User u) {
        String token = jwtUtil.createToken(u.getId(), u.getRole(), u.getSchoolId());
        Map<String, Object> res = new HashMap<>();
        res.put("token", token);
        res.put("user", safe(u));
        return res;
    }

    /** 脱敏：绝不外泄密码 */
    public Map<String, Object> safe(User u) {
        Map<String, Object> m = new HashMap<>();
        m.put("id", u.getId());
        m.put("username", u.getUsername());
        m.put("nickName", u.getNickName());
        m.put("avatarUrl", u.getAvatarUrl());
        m.put("role", u.getRole());
        m.put("schoolId", u.getSchoolId());
        m.put("points", u.getPoints());
        m.put("sightingCount", u.getSightingCount());
        m.put("catSeenCount", splitIds(u.getCatSeen()).size());
        return m;
    }

    public User getById(Long id) {
        return userRepository.findById(id).orElseThrow(() -> new BizException("用户不存在"));
    }

    public List<User> listBySchool(Long schoolId) {
        return userRepository.findAll().stream()
                .filter(u -> schoolId == null || schoolId.equals(u.getSchoolId()))
                .toList();
    }

    @Transactional
    public void setRole(Long userId, String role) {
        CurrentUser.requireAdmin();
        if (!List.of("visitor", "member", "admin").contains(role)) throw new BizException("角色非法");
        if (userId.equals(CurrentUser.id()) && !"admin".equals(role)) {
            throw new BizException("不能降级自己");
        }
        User u = getById(userId);
        u.setRole(role);
        if (CurrentUser.schoolId() != null) u.setSchoolId(CurrentUser.schoolId());
        userRepository.save(u);
    }

    public Map<String, Object> applyJoin(String nickName, String contact, String reason, String experience) {
        CurrentUser.requireLogin();
        Long uid = CurrentUser.id();
        User me = getById(uid);
        if ("member".equals(me.getRole()) || "admin".equals(me.getRole())) {
            return Map.of("status", "already");
        }
        boolean pending = applyRepository.findByUserIdOrderByCreatedAtDesc(uid).stream()
                .anyMatch(a -> "pending".equals(a.getStatus()));
        if (pending) return Map.of("status", "pending");

        Apply a = new Apply();
        a.setUserId(uid);
        a.setNickName(nickName == null ? me.getNickName() : nickName);
        a.setContact(contact);
        a.setReason(reason);
        a.setExperience(experience);
        a.setSchoolId(CurrentUser.schoolId());
        applyRepository.save(a);
        return Map.of("status", "submitted");
    }

    public List<Apply> listApplies(String status) {
        CurrentUser.requireAdmin();
        Long sid = CurrentUser.schoolId();
        if (sid == null) return applyRepository.findAll().stream()
                .filter(a -> status == null || status.equals(a.getStatus())).toList();
        return applyRepository.findBySchoolIdAndStatusOrderByCreatedAtDesc(sid, status == null ? "pending" : status);
    }

    @Transactional
    public void handleApply(Long id, boolean approve) {
        CurrentUser.requireAdmin();
        Apply a = applyRepository.findById(id).orElseThrow(() -> new BizException("申请不存在"));
        a.setStatus(approve ? "approved" : "rejected");
        a.setHandler(getById(CurrentUser.id()).getNickName());
        a.setHandledAt(LocalDateTime.now());
        applyRepository.save(a);

        if (approve) {
            User u = getById(a.getUserId());
            u.setRole("member");
            if (a.getSchoolId() != null) u.setSchoolId(a.getSchoolId());
            else if (CurrentUser.schoolId() != null) u.setSchoolId(CurrentUser.schoolId());
            userRepository.save(u);
        }
    }

    /** 逗号分隔 ID 串 → List<Long> */
    public static java.util.List<Long> splitIds(String s) {
        if (s == null || s.isBlank()) return new java.util.ArrayList<>();
        java.util.List<Long> out = new java.util.ArrayList<>();
        for (String part : s.split(",")) {
            String t = part.trim();
            if (!t.isEmpty()) {
                try { out.add(Long.valueOf(t)); } catch (NumberFormatException ignored) {}
            }
        }
        return out;
    }
}
