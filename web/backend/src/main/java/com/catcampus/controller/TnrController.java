package com.catcampus.controller;

import com.catcampus.common.CurrentUser;
import com.catcampus.common.Result;
import com.catcampus.entity.TnrRecord;
import com.catcampus.service.TnrService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/tnr")
@RequiredArgsConstructor
public class TnrController {

    private final TnrService tnrService;

    @GetMapping
    public Result<List<TnrRecord>> list(@RequestParam(required = false) Long schoolId) {
        CurrentUser.requireMember();
        if (schoolId == null) schoolId = CurrentUser.schoolId();
        return Result.ok(tnrService.list(schoolId));
    }

    @GetMapping("/summary")
    public Result<Map<String, Object>> summary(@RequestParam(required = false) Long schoolId) {
        CurrentUser.requireMember();
        if (schoolId == null) schoolId = CurrentUser.schoolId();
        return Result.ok(tnrService.summary(schoolId));
    }

    @PostMapping
    public Result<TnrRecord> save(@RequestBody TnrRecord t) {
        return Result.ok(tnrService.save(t));
    }
}
