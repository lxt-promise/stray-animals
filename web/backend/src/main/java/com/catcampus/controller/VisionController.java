package com.catcampus.controller;

import com.catcampus.common.Result;
import com.catcampus.service.VisionService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * 识别测试台接口（内部工具，不面向普通用户）。
 *
 * <p>浏览器不直连 Python 识别服务，统一由这里代转，避免跨域 + token 暴露。
 */
@RestController
@RequestMapping("/api/vision")
@RequiredArgsConstructor
public class VisionController {

    private final VisionService visionService;

    /** 识别服务是否在线，以及当前用的是真模型还是占位引擎 */
    @GetMapping("/health")
    public Result<Map<String, Object>> health() {
        return Result.ok(visionService.health());
    }

    /** 用一张图片跑一次识别 */
    @PostMapping("/recognize")
    public Result<Map<String, Object>> recognize(@RequestBody Map<String, String> body) {
        return Result.ok(visionService.recognize(body.get("url")));
    }

    /** 把猫档案库同步成特征库（识别前先建一次，之后走缓存） */
    @PostMapping("/build-index")
    public Result<Map<String, Object>> buildIndex() {
        return Result.ok(visionService.buildIndex());
    }
}
