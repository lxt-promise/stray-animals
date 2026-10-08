package com.catcampus.controller;

import com.catcampus.common.CurrentUser;
import com.catcampus.common.Result;
import com.catcampus.entity.Apply;
import com.catcampus.entity.User;
import com.catcampus.service.UserService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequiredArgsConstructor
public class UserController {

    private final UserService userService;

    /** 成员列表（社团可见） */
    @GetMapping("/api/users")
    public Result<List<Map<String, Object>>> members(@RequestParam(required = false) Long schoolId) {
        CurrentUser.requireMember();
        if (schoolId == null) schoolId = CurrentUser.schoolId();
        List<Map<String, Object>> list = userService.listBySchool(schoolId).stream()
                .map(userService::safe)
                .toList();
        return Result.ok(list);
    }

    /** 角色调整（管理员） */
    @PostMapping("/api/users/{id}/role")
    public Result<?> setRole(@PathVariable Long id, @RequestBody Map<String, String> body) {
        userService.setRole(id, body.get("role"));
        return Result.ok();
    }

    /** 提交入社申请 */
    @PostMapping("/api/applies")
    public Result<Map<String, Object>> apply(@RequestBody Map<String, String> body) {
        return Result.ok(userService.applyJoin(body.get("nickName"), body.get("contact"),
                body.get("reason"), body.get("experience")));
    }

    /** 申请列表（管理员） */
    @GetMapping("/api/applies")
    public Result<List<Apply>> applies(@RequestParam(required = false) String status) {
        return Result.ok(userService.listApplies(status));
    }

    /** 审核（管理员） */
    @PostMapping("/api/applies/{id}")
    public Result<?> handle(@PathVariable Long id, @RequestBody Map<String, Object> body) {
        boolean approve = Boolean.parseBoolean(String.valueOf(body.get("approve")));
        userService.handleApply(id, approve);
        return Result.ok();
    }
}
