package com.catcampus.controller;

import com.catcampus.common.CurrentUser;
import com.catcampus.common.Result;
import com.catcampus.entity.Sighting;
import com.catcampus.service.SightingService;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/sightings")
@RequiredArgsConstructor
public class SightingController {

    private final SightingService sightingService;

    @GetMapping
    public Result<Map<String, Object>> list(@RequestParam(defaultValue = "1") int page,
                                            @RequestParam(defaultValue = "20") int size,
                                            @RequestParam(required = false) Long schoolId,
                                            @RequestParam(required = false) Long catId,
                                            @RequestParam(required = false) Boolean pending,
                                            @RequestParam(required = false) Boolean mine) {
        if (schoolId == null) schoolId = CurrentUser.schoolId();
        Page<Sighting> p = sightingService.page(page, size, schoolId, catId, pending,
                Boolean.TRUE.equals(mine) ? CurrentUser.id() : null);

        Map<String, Object> data = new HashMap<>();
        data.put("list", p.getContent());
        data.put("total", p.getTotalElements());
        data.put("page", page);
        data.put("pages", p.getTotalPages());
        return Result.ok(data);
    }

    @GetMapping("/recent")
    public Result<List<Sighting>> recent(@RequestParam(required = false) Long schoolId,
                                         @RequestParam(defaultValue = "5") int size) {
        if (schoolId == null) schoolId = CurrentUser.schoolId();
        return Result.ok(sightingService.recent(schoolId, size));
    }

    @PostMapping
    public Result<Sighting> add(@RequestBody Sighting s) {
        return Result.ok(sightingService.add(s));
    }
}
