package com.catcampus.controller;

import com.catcampus.common.CurrentUser;
import com.catcampus.common.Result;
import com.catcampus.entity.User;
import com.catcampus.service.UserService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
public class AuthController {

    private final UserService userService;

    @PostMapping("/register")
    public Result<Map<String, Object>> register(@RequestBody Map<String, Object> body) {
        String username = str(body.get("username"));
        String password = str(body.get("password"));
        String nickName = str(body.get("nickName"));
        String contact = str(body.get("contact"));
        Long schoolId = body.get("schoolId") == null ? null : Long.valueOf(body.get("schoolId").toString());
        return Result.ok(userService.register(username, password, nickName, contact, schoolId));
    }

    @PostMapping("/login")
    public Result<Map<String, Object>> login(@RequestBody Map<String, Object> body) {
        return Result.ok(userService.login(str(body.get("username")), str(body.get("password"))));
    }

    @GetMapping("/me")
    public Result<Map<String, Object>> me() {
        Long uid = CurrentUser.id();
        if (uid == null) return Result.ok(null);
        User u = userService.getById(uid);
        Map<String, Object> m = new HashMap<>(userService.safe(u));
        m.put("isMember", CurrentUser.isMember());
        m.put("isAdmin", CurrentUser.isAdmin());
        return Result.ok(m);
    }

    private String str(Object o) { return o == null ? null : o.toString(); }
}
