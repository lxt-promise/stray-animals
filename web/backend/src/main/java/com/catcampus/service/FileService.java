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
import java.util.Set;
import java.util.UUID;

/** 本地文件存储；生产可替换为 OSS / COS，保持返回 URL 契约不变即可 */
@Slf4j
@Service
public class FileService {

    @Value("${catcampus.upload-dir}")
    private String uploadDir;

    /** 允许的图片扩展名白名单。
     *  ⚠️ 绝不能保留 .svg：SVG 是 XML 可携带 <script>，而 /uploads/** 是同源静态托管
     *  且在白名单内无需登录 —— 上传含脚本的 SVG 诱导已登录管理员打开，即可以其身份
     *  读取 localStorage 里的 JWT，完全冒充管理员（存储型 XSS）。 */
    private static final Set<String> ALLOWED_EXT = Set.of("jpg", "jpeg", "png", "webp", "gif");
    private static final Set<String> ALLOWED_CT = Set.of("image/jpeg", "image/png", "image/webp", "image/gif");

    public List<String> upload(List<MultipartFile> files) {
        CurrentUser.requireLogin();
        if (files == null || files.isEmpty()) throw new BizException("没有文件");
        if (files.size() > 6) throw new BizException("最多 6 张");

        List<String> urls = new ArrayList<>();
        for (MultipartFile f : files) {
            if (f.isEmpty()) continue;
            String ct = f.getContentType();
            if (ct == null || !ALLOWED_CT.contains(ct.toLowerCase())) throw new BizException("仅支持 JPG/PNG/WebP/GIF 图片");
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

    /** 扩展名归一化：白名单外一律回落 .jpg（配合 contentType 白名单双重校验） */
    private String extOf(String origin) {
        if (origin == null) return ".jpg";
        int i = origin.lastIndexOf('.');
        if (i < 0) return ".jpg";
        String e = origin.substring(i + 1).toLowerCase();
        return ALLOWED_EXT.contains(e) ? "." + e : ".jpg";
    }
}
