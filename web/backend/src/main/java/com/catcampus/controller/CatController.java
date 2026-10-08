package com.catcampus.controller;

import com.catcampus.common.CurrentUser;
import com.catcampus.common.Result;
import com.catcampus.entity.Cat;
import com.catcampus.entity.Sighting;
import com.catcampus.entity.TnrRecord;
import com.catcampus.service.CatService;
import com.catcampus.service.SightingService;
import com.catcampus.service.TnrService;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/cats")
@RequiredArgsConstructor
public class CatController {

    private final CatService catService;
    private final SightingService sightingService;
    private final TnrService tnrService;

    /** 猫谱列表（公开） */
    @GetMapping
    public Result<Map<String, Object>> list(@RequestParam(defaultValue = "1") int page,
                                            @RequestParam(defaultValue = "20") int size,
                                            @RequestParam(required = false) Long schoolId,
                                            @RequestParam(required = false) String status,
                                            @RequestParam(required = false) String sterilized,
                                            @RequestParam(required = false) String pattern,
                                            @RequestParam(required = false) String keyword) {
        if (schoolId == null) schoolId = CurrentUser.schoolId();
        Page<Cat> p = catService.page(page, size, schoolId, status, sterilized, pattern, keyword);
        p.getContent().forEach(catService::sanitize);

        Map<String, Object> data = new HashMap<>();
        data.put("list", p.getContent());
        data.put("total", p.getTotalElements());
        data.put("page", page);
        data.put("pages", p.getTotalPages());
        return Result.ok(data);
    }

    /** 地图点位（公开） */
    @GetMapping("/map")
    public Result<List<Cat>> map(@RequestParam(required = false) Long schoolId) {
        if (schoolId == null) schoolId = CurrentUser.schoolId();
        List<Cat> list = catService.mapCats(schoolId);
        list.forEach(catService::sanitize);
        return Result.ok(list);
    }

    @GetMapping("/{id}")
    public Result<Map<String, Object>> detail(@PathVariable Long id) {
        Cat c = catService.detail(id);
        catService.sanitize(c);
        Map<String, Object> data = new HashMap<>();
        data.put("cat", c);
        data.put("sightings", sightingService.sightingsOf(id));
        data.put("tnr", CurrentUser.isMember() ? tnrService.ofCat(id) : List.of());
        data.put("canEdit", CurrentUser.isMember());
        return Result.ok(data);
    }

    /** 新建/编辑（社团成员） */
    @PostMapping
    public Result<Cat> save(@RequestBody Cat cat) {
        CurrentUser.requireMember();
        return Result.ok(catService.save(cat));
    }

    /** 删除（管理员） */
    @DeleteMapping("/{id}")
    public Result<?> delete(@PathVariable Long id) {
        CurrentUser.requireAdmin();
        catService.delete(id);
        return Result.ok();
    }
}
