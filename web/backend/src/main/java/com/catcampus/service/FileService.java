package com.catcampus.service;

import com.catcampus.common.BizException;
import com.catcampus.common.CurrentUser;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** 本地文件存储；生产可替换为 OSS / COS，保持返回 URL 契约不变即可 */
@Slf4j
@Service
public class FileService {

    @Value("${catcampus.upload-dir}")
    private String uploadDir;

    public List<String> upload(List<MultipartFile> files) {
        CurrentUser.requireLogin();
        if (files == null || files.isEmpty()) throw new BizException("没有文件");
        if (files.size() > 6) throw new BizException("最多 6 张");

        List<String> urls = new ArrayList<>();
        for (MultipartFile f : files) {
            if (f.isEmpty()) continue;
            String ct = f.getContentType();
            if (ct == null || !ct.startsWith("image/")) throw new BizException("仅支持图片");
            if (f.getSize() > 10L * 1024 * 1024) throw new BizException("单张图片不能超过 10MB");
            urls.add(save(f));
        }
        return urls;
    }

    private String save(MultipartFile f) {
        try {
            String ext = extOf(f.getOriginalFilename());
            String name = LocalDate.now() + "/" + UUID.randomUUID().toString().replace("-", "").substring(0, 12) + ext;
            Path dir = Paths.get(uploadDir).toAbsolutePath().normalize();
            Path target = dir.resolve(name);
            Files.createDirectories(target.getParent());
            f.transferTo(target);
            return "/uploads/" + name;
        } catch (IOException e) {
            log.error("[catcampus] 上传失败", e);
            throw new BizException("上传失败");
        }
    }

    private String extOf(String origin) {
        if (origin == null) return ".jpg";
        int i = origin.lastIndexOf('.');
        if (i < 0) return ".jpg";
        String e = origin.substring(i).toLowerCase();
        return (e.length() > 5) ? ".jpg" : e;
    }
}
