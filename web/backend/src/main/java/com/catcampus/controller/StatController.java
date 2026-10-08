package com.catcampus.controller;

import com.catcampus.common.CurrentUser;
import com.catcampus.common.Result;
import com.catcampus.entity.Sighting;
import com.catcampus.service.StatService;
import com.catcampus.service.UserService;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/stat")
@RequiredArgsConstructor
public class StatController {

    private final StatService statService;
    private final UserService userService;

    @GetMapping("/overview")
    public Result<Map<String, Object>> overview(@RequestParam(required = false) Long schoolId) {
        if (schoolId == null) schoolId = CurrentUser.schoolId();
        Map<String, Object> m = new HashMap<>(statService.overview(schoolId));
        m.put("recent", statService.recent(schoolId, 5));
        Long uid = CurrentUser.id();
        if (uid != null) {
            Map<String, Object> me = userService.safe(userService.getById(uid));
            me.put("isMember", CurrentUser.isMember());
            me.put("isAdmin", CurrentUser.isAdmin());
            m.put("me", me);
        }
        return Result.ok(m);
    }

    @GetMapping("/recent")
    public Result<List<Sighting>> recent(@RequestParam(required = false) Long schoolId,
                                         @RequestParam(defaultValue = "10") int size) {
        if (schoolId == null) schoolId = CurrentUser.schoolId();
        return Result.ok(statService.recent(schoolId, size));
    }
}
