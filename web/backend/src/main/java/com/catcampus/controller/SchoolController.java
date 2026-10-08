package com.catcampus.controller;

import com.catcampus.common.Result;
import com.catcampus.entity.School;
import com.catcampus.entity.User;
import com.catcampus.service.SchoolService;
import com.catcampus.service.UserService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/schools")
@RequiredArgsConstructor
public class SchoolController {

    private final SchoolService schoolService;
    private final UserService userService;

    @GetMapping
    public Result<List<School>> list() {
        return Result.ok(schoolService.list());
    }

    @GetMapping("/{id}")
    public Result<School> get(@PathVariable Long id) {
        return Result.ok(schoolService.get(id));
    }

    /** 创建学校（管理员）—— 向外拓展 = 新建一个学校 */
    @PostMapping
    public Result<School> create(@RequestBody School s) {
        return Result.ok(schoolService.create(s));
    }

    /** 切换当前用户所属学校 */
    @PostMapping("/{id}/bind")
    public Result<Map<String, Object>> bind(@PathVariable Long id) {
        User u = schoolService.bind(id);
        return Result.ok(userService.safe(u));
    }
}
