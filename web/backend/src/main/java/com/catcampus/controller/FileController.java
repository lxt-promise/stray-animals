package com.catcampus.controller;

import com.catcampus.common.Result;
import com.catcampus.service.FileService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;

@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
public class FileController {

    private final FileService fileService;

    @PostMapping("/upload")
    public Result<List<String>> upload(@RequestParam("files") List<MultipartFile> files) {
        return Result.ok(fileService.upload(files));
    }
}
