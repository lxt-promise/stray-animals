package com.catcampus.controller;

import com.catcampus.common.CurrentUser;
import com.catcampus.common.Result;
import com.catcampus.entity.Cat;
import com.catcampus.service.CatService;
import com.catcampus.service.FileService;
import com.catcampus.service.VisionService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 猫档案手动录入接口（内部工具）。
 *
 * <p>和「识别测试台」一样，是给运营者手动往档案库 + 特征库里加猫用的，不面向普通用户。
 * 一次请求同时完成：上传照片 → 落库 → 同步特征库（让这只猫立刻可被识别）。
 *
 * <p>需要登录（任何已登录账号即可，不强制社团成员），因为要写档案库。
 */
@Slf4j
@RestController
@RequestMapping("/api/cat-entry")
@RequiredArgsConstructor
public class CatEntryController {

    private final CatService catService;
    private final FileService fileService;
    private final VisionService visionService;

    @PostMapping
    public Result<Map<String, Object>> entry(
            @RequestPart(value = "photos", required = false) List<MultipartFile> photos,
            @RequestParam(required = false) String name,
            @RequestParam(required = false) String alias,
            @RequestParam(required = false) String sex,
            @RequestParam(required = false) String pattern,
            @RequestParam(required = false) String colorNote,
            @RequestParam(required = false) String sterilized,
            @RequestParam(required = false) String earMark,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String health,
            @RequestParam(required = false) String characters,
            @RequestParam(required = false) String locationName,
            @RequestParam(required = false) Double locationLat,
            @RequestParam(required = false) Double locationLng,
            @RequestParam(required = false) Boolean spotPrivate,
            @RequestParam(required = false) String note,
            @RequestParam(required = false) String internalNote,
            @RequestParam(required = false) String medicalNote) {

        CurrentUser.requireLogin();

        Cat cat = new Cat();
        if (name != null) cat.setName(name);
        if (alias != null) cat.setAlias(alias);
        if (sex != null) cat.setSex(sex);
        if (pattern != null) cat.setPattern(pattern);
        if (colorNote != null) cat.setColorNote(colorNote);
        if (sterilized != null) cat.setSterilized(sterilized);
        if (earMark != null) cat.setEarMark(earMark);
        if (status != null) cat.setStatus(status);
        if (health != null) cat.setHealth(health);
        if (characters != null) cat.setCharacters(characters);
        if (locationName != null) cat.setLocationName(locationName);
        if (locationLat != null) cat.setLocationLat(locationLat);
        if (locationLng != null) cat.setLocationLng(locationLng);
        if (spotPrivate != null) cat.setSpotPrivate(spotPrivate);
        if (note != null) cat.setNote(note);
        if (internalNote != null) cat.setInternalNote(internalNote);
        if (medicalNote != null) cat.setMedicalNote(medicalNote);

        // 1) 上传照片（最多 6 张，限图片）——FileService 内部已做校验
        List<String> urls = new ArrayList<>();
        if (photos != null && !photos.isEmpty()) {
            urls = fileService.upload(photos);
            if (!urls.isEmpty()) {
                cat.setAvatar(urls.get(0));
                cat.setPhotos(String.join(",", urls));
            }
        }

        // 2) 落库
        Cat saved = catService.save(cat);

        // 3) 同步特征库（清掉旧的、按档案库重建）——失败不阻断录入，只提示
        Map<String, Object> build = null;
        String buildError = null;
        try {
            build = visionService.buildIndex();
        } catch (Exception e) {
            buildError = e.getMessage();
            log.warn("[catcampus] 录入后同步特征库失败：{}", e.getMessage());
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("cat", saved);
        data.put("photos", urls);
        data.put("build", build);
        if (buildError != null) data.put("buildError", buildError);
        return Result.ok(data);
    }
}
