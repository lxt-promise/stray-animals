package com.catcampus.controller;

import com.catcampus.common.CurrentUser;
import com.catcampus.common.Result;
import com.catcampus.entity.Fund;
import com.catcampus.service.FundService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/funds")
@RequiredArgsConstructor
public class FundController {

    private final FundService fundService;

    @GetMapping
    public Result<List<Fund>> list(@RequestParam(required = false) Long schoolId) {
        if (schoolId == null) schoolId = CurrentUser.schoolId();
        return Result.ok(fundService.list(schoolId));
    }

    @GetMapping("/summary")
    public Result<Map<String, Object>> summary(@RequestParam(required = false) Long schoolId) {
        if (schoolId == null) schoolId = CurrentUser.schoolId();
        return Result.ok(fundService.summary(schoolId));
    }

    @PostMapping
    public Result<Fund> add(@RequestBody Fund f) {
        return Result.ok(fundService.add(f));
    }
}
