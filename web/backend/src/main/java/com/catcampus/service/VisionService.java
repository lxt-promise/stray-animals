package com.catcampus.service;

import com.catcampus.common.BizException;
import com.catcampus.entity.Cat;
import com.catcampus.repository.CatRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 识别服务代理。
 *
 * <p>职责边界：浏览器不能直连 Python 识别服务（跨域、且 token 会暴露在前端），
 * 所以由 Spring Boot 这一层代转一次。这样前端只跟同源的 /api 打交道，
 * token 也只存在于服务端配置里。
 *
 * <p>配置项（application.yml 的 catcampus.vision.*）：
 * <ul>
 *   <li>{@code base-url} 识别服务地址，如 http://127.0.0.1:8090</li>
 *   <li>{@code token}    与 server/.env 里的 API_TOKEN 保持一致</li>
 *   <li>{@code school-id} 建库时用的校区标识，留空表示全局库</li>
 * </ul>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class VisionService {

    private final CatRepository catRepository;

    @Value("${catcampus.vision.base-url:http://127.0.0.1:8090}")
    private String baseUrl;

    @Value("${catcampus.vision.token:}")
    private String token;

    @Value("${catcampus.vision.school-id:}")
    private String schoolId;

    @Value("${catcampus.vision.timeout-seconds:120}")
    private int timeoutSeconds;

    /**
     * 识别服务下载猫照片时要连的「后端地址」。
     * 照片由本后端在 /uploads/** 托管，必须用后端地址（默认 8080）；
     * 不能用 {@link #baseUrl}（那是识别服务自身的 8090，它并不托管上传文件）。
     */
    @Value("${catcampus.vision.asset-base-url:http://127.0.0.1:8080}")
    private String assetBaseUrl;

    /** 每次识别最多带多少只猫过去（云函数侧也是这个量级） */
    private static final int MAX_CATS = 200;

    /**
     * SSRF 防护：识别服务会去下载 imageUrl，该参数历史上无校验直达 Python 侧
     * httpx.get(follow_redirects=True) —— 未登录攻击者可让服务端请求内网地址、
     * 云元数据（169.254.169.254）、localhost 服务做盲探测。
     *
     * 策略：允许同源相对路径（/uploads/...，前端正常用法）；完整 URL 则
     * host 必须与配置的 assetBaseUrl 一致（照片本就由本后端托管，正常流程必然同源）。
     * 本地部署时 assetBaseUrl 是 127.0.0.1，也不会被误伤。
     */
    private void assertAllowedImageUrl(String imageUrl) {
        URI uri;
        try {
            uri = URI.create(imageUrl);
        } catch (Exception e) {
            throw new BizException("图片地址格式错误");
        }
        // 相对路径：同源引用，放行
        if (uri.getScheme() == null && uri.getHost() == null) return;
        String scheme = uri.getScheme();
        if (scheme == null || (!scheme.equalsIgnoreCase("http") && !scheme.equalsIgnoreCase("https"))) {
            throw new BizException("图片地址必须是 http/https");
        }
        String host = uri.getHost();
        if (host == null) throw new BizException("图片地址缺少主机名");
        String allowHost;
        try {
            allowHost = URI.create(assetBaseUrl).getHost();
        } catch (Exception e) {
            allowHost = null;
        }
        if (allowHost == null || !allowHost.equalsIgnoreCase(host)) {
            log.warn("[catcampus] 拒绝非白域名图片地址：host={}", host);
            throw new BizException("图片地址不在允许的域名内");
        }
    }

    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    // ------------------------------------------------------------ 健康检查

    /** 探测识别服务是否可用，并回传引擎信息（provider / dim / ffmpeg） */
    public Map<String, Object> health() {
        try {
            Map<String, Object> body = get("/health", authHeader()).orElseThrow(
                    () -> new BizException("识别服务无响应"));
            Map<String, Object> out = new LinkedHashMap<>(body);
            out.put("endpoint", baseUrl);
            return out;
        } catch (BizException e) {
            throw e;
        } catch (Exception e) {
            log.warn("[catcampus] 识别服务不可用: {}", e.getMessage());
            throw new BizException("识别服务不可用：" + rootMsg(e));
        }
    }

    // ------------------------------------------------------------ 识别

    /**
     * 用一张图片调识别服务，返回其原始响应（features / candidates / meta）。
     *
     * @param imageUrl 必须是识别服务能直接下载到的完整 URL
     */
    public Map<String, Object> recognize(String imageUrl) {
        if (imageUrl == null || imageUrl.isBlank()) throw new BizException("缺少图片地址");
        assertAllowedImageUrl(imageUrl);

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("url", imageUrl);
        payload.put("type", "image");
        payload.put("frames", 1);
        payload.put("schoolId", schoolId);
        payload.put("school_id", schoolId);
        payload.put("cats", catRefs());

        Map<String, Object> body = post("/v1/recognize", payload, authHeader())
                .orElseThrow(() -> new BizException("识别服务无响应"));

        // 服务端把同一张图缓存的向量回传了 768 个浮点数，前端用不上，剔掉省带宽
        Object feat = body.get("features");
        if (feat instanceof Map<?, ?> f) {
            ((Map<String, Object>) f).remove("embedding");
            body.put("features", f);
        }
        return body;
    }

    /**
     * 把猫档案库同步成特征库。
     *
     * <p>特征库是「照片 → 向量」的缓存。本方法先把当前校区（或全局）的特征库清空，
     * 再按档案库重新建一遍——保证「特征库 == 档案库里有照片的猫」，
     * 新增 / 改名 / 删猫之后调一次就完全一致，不会残留历史校准用的测试猫。
     */
    public Map<String, Object> buildIndex() {
        // 1) 先清空，让档案库成为特征库的唯一真相来源
        try {
            delete("/v1/index?schoolId=" + encode(schoolId), authHeader());
        } catch (Exception e) {
            log.warn("[catcampus] 清空特征库失败（继续尝试重建）：{}", e.getMessage());
        }

        List<Cat> cats = catRepository.findAll().stream()
                .filter(c -> !photoUrlsOf(c).isEmpty())
                .limit(MAX_CATS)
                .toList();

        Map<String, Object> out = new LinkedHashMap<>();
        if (cats.isEmpty()) {
            out.put("built", 0);
            out.put("sent", 0);
            out.put("total", 0);
            out.put("cleared", true);
            out.put("note", "档案库里还没有带照片的猫，特征库已清空");
            return out;
        }

        List<Map<String, Object>> refs = new ArrayList<>();
        for (Cat c : cats) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", String.valueOf(c.getId()));
            m.put("name", c.getName() == null ? "" : c.getName());
            m.put("pattern", c.getPattern() == null ? "" : c.getPattern());
            m.put("color", c.getColorNote() == null ? "" : c.getColorNote());
            m.put("photos", photoUrlsOf(c));
            refs.add(m);
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("schoolId", schoolId);
        payload.put("cats", refs);
        payload.put("photosPerCat", 4);

        Map<String, Object> body = post("/v1/index/build", payload, authHeader())
                .orElseThrow(() -> new BizException("建库失败：识别服务无响应"));
        body.put("sent", refs.size());
        return body;
    }

    private static String encode(String s) {
        try {
            return java.net.URLEncoder.encode(s == null ? "" : s, "UTF-8");
        } catch (Exception e) {
            return s == null ? "" : s;
        }
    }

    // ------------------------------------------------------------ 内部

    /**
     * 识别请求里带的猫列表。
     *
     * <p>识别服务自己维护特征库，这里主要是让候选能显示名字 / 头像 ——
     * 以及万一特征库为空时，服务端还能用这些照片现场补算一次（冷启动兜底）。
     */
    private List<Map<String, Object>> catRefs() {
        List<Map<String, Object>> refs = new ArrayList<>();
        for (Cat c : catRepository.findAll()) {
            if (refs.size() >= MAX_CATS) break;
            List<String> photos = photoUrlsOf(c);
            if (photos.size() > 2) photos = photos.subList(0, 2);   // 只带两张，避免请求体过大
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", String.valueOf(c.getId()));
            m.put("name", c.getName() == null ? "" : c.getName());
            m.put("pattern", c.getPattern() == null ? "" : c.getPattern());
            m.put("color", c.getColorNote() == null ? "" : c.getColorNote());
            m.put("photos", photos);
            refs.add(m);
        }
        return refs;
    }

    /** 把猫档案的照片字段转成识别服务可直接下载的绝对 URL */
    private List<String> photoUrlsOf(Cat c) {
        List<String> out = new ArrayList<>();
        String raw = c.getPhotos();
        if (raw != null && !raw.isBlank()) {
            Arrays.stream(raw.split(","))
                    .map(String::trim)
                    .filter(s -> !s.isEmpty())
                    .forEach(s -> out.add(absolute(s)));
        }
        if (out.isEmpty() && c.getAvatar() != null && !c.getAvatar().isBlank()) {
            out.add(absolute(c.getAvatar()));
        }
        return out;
    }

    /**
     * 相对路径补齐成绝对地址。
     * 识别服务在另一台机器上，拿到的 "/uploads/x.jpg" 是没法下载的，必须补成
     * 「后端可访问地址 + /uploads/x.jpg」。注意这里用的是 {@link #assetBaseUrl}（后端），
     * 不是 vision 的 base-url。
     */
    private String absolute(String url) {
        if (url.startsWith("http://") || url.startsWith("https://")) return url;
        String host = stripScheme(assetBaseUrl);
        return host + (url.startsWith("/") ? url : "/" + url);
    }

    private static String stripScheme(String u) {
        Matcher m = Pattern.compile("^(https?://[^/]+)").matcher(u == null ? "" : u);
        return m.find() ? m.group(1) : "";
    }

    private String[] authHeader() {
        return (token == null || token.isBlank()) ? new String[0] : new String[]{"Authorization", "Bearer " + token};
    }

    /** 把 400 的 JSON 详情抽成一句人话 */
    private static String rootMsg(Throwable e) {
        String m = e.getMessage();
        if (m == null) return "未知错误";
        Matcher matcher = Pattern.compile("\"detail\"\\s*:\\s*\"([^\"]+)\"").matcher(m);
        return matcher.find() ? matcher.group(1) : m;
    }

    private java.util.Optional<Map<String, Object>> get(String path, String... headers) {
        HttpRequest.Builder b = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + path))
                .timeout(Duration.ofSeconds(Math.max(5, timeoutSeconds)))
                .GET();
        for (int i = 0; i + 1 < headers.length; i += 2) b.header(headers[i], headers[i + 1]);
        return send(b.build());
    }

    private java.util.Optional<Map<String, Object>> delete(String path, String... headers) {
        HttpRequest.Builder b = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + path))
                .timeout(Duration.ofSeconds(Math.max(5, timeoutSeconds)))
                .DELETE();
        for (int i = 0; i + 1 < headers.length; i += 2) b.header(headers[i], headers[i + 1]);
        return send(b.build());
    }

    private java.util.Optional<Map<String, Object>> post(String path, Map<String, Object> payload, String... headers) {
        String json = toJson(payload);
        HttpRequest.Builder b = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + path))
                .timeout(Duration.ofSeconds(Math.max(5, timeoutSeconds)))
                .header("Content-Type", "application/json; charset=utf-8")
                .POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8));
        for (int i = 0; i + 1 < headers.length; i += 2) b.header(headers[i], headers[i + 1]);
        return send(b.build());
    }

    @SuppressWarnings("unchecked")
    private java.util.Optional<Map<String, Object>> send(HttpRequest req) {
        try {
            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            String body = resp.body();
            if (resp.statusCode() >= 300) {
                throw new BizException("识别服务返回 " + resp.statusCode() + "：" + rootMsg(new RuntimeException(body)));
            }
            Object parsed = json.parse(body);
            if (parsed instanceof Map<?, ?> m) return java.util.Optional.of((Map<String, Object>) m);
            throw new BizException("识别服务返回格式异常");
        } catch (BizException e) {
            throw e;
        } catch (Exception e) {
            throw new BizException("调用识别服务失败：" + rootMsg(e));
        }
    }

    /** 极简 JSON 编解码，避免为一个小功能引入额外依赖 */
    private final MiniJson json = new MiniJson();

    private String toJson(Object o) {
        return json.write(o);
    }

    /**
     * 仅覆盖本场景所需的 JSON 读写（对象 / 数组 / 字符串 / 数字 / 布尔 / null）。
     * 不支持转义以外的花哨特性，够用即可。
     */
    static class MiniJson {

        String write(Object o) {
            StringBuilder sb = new StringBuilder();
            writeTo(sb, o);
            return sb.toString();
        }

        private void writeTo(StringBuilder sb, Object o) {
            if (o == null) {
                sb.append("null");
            } else if (o instanceof String s) {
                sb.append('"').append(escape(s)).append('"');
            } else if (o instanceof Boolean || o instanceof Number) {
                sb.append(o);
            } else if (o instanceof Map<?, ?> m) {
                sb.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> e : m.entrySet()) {
                    if (!first) sb.append(',');
                    first = false;
                    sb.append('"').append(escape(String.valueOf(e.getKey()))).append("\":");
                    writeTo(sb, e.getValue());
                }
                sb.append('}');
            } else if (o instanceof Iterable<?> it) {
                sb.append('[');
                boolean first = true;
                for (Object v : it) {
                    if (!first) sb.append(',');
                    first = false;
                    writeTo(sb, v);
                }
                sb.append(']');
            } else {
                sb.append('"').append(escape(String.valueOf(o))).append('"');
            }
        }

        private static String escape(String s) {
            StringBuilder sb = new StringBuilder(s.length() + 8);
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"' -> sb.append("\\\"");
                    case '\\' -> sb.append("\\\\");
                    case '\n' -> sb.append("\\n");
                    case '\r' -> sb.append("\\r");
                    case '\t' -> sb.append("\\t");
                    default -> {
                        if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                        else sb.append(c);
                    }
                }
            }
            return sb.toString();
        }

        Object parse(String s) {
            P p = new P(s);
            p.ws();
            Object v = p.value();
            return v;
        }

        private static class P {
            private final String s;
            private int i;

            P(String s) { this.s = s; }

            void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

            Object value() {
                ws();
                if (i >= s.length()) return null;
                char c = s.charAt(i);
                return switch (c) {
                    case '{' -> obj();
                    case '[' -> arr();
                    case '"' -> str();
                    case 't' -> { i += 4; yield Boolean.TRUE; }
                    case 'f' -> { i += 5; yield Boolean.FALSE; }
                    case 'n' -> { i += 4; yield null; }
                    default -> num();
                };
            }

            Map<String, Object> obj() {
                Map<String, Object> m = new LinkedHashMap<>();
                i++; // {
                ws();
                if (i < s.length() && s.charAt(i) == '}') { i++; return m; }
                while (i < s.length()) {
                    ws();
                    String k = str();
                    ws();
                    if (i < s.length() && s.charAt(i) == ':') i++;
                    m.put(k, value());
                    ws();
                    if (i < s.length() && s.charAt(i) == ',') { i++; continue; }
                    if (i < s.length() && s.charAt(i) == '}') { i++; break; }
                    break;
                }
                return m;
            }

            List<Object> arr() {
                List<Object> l = new ArrayList<>();
                i++; // [
                ws();
                if (i < s.length() && s.charAt(i) == ']') { i++; return l; }
                while (i < s.length()) {
                    l.add(value());
                    ws();
                    if (i < s.length() && s.charAt(i) == ',') { i++; continue; }
                    if (i < s.length() && s.charAt(i) == ']') { i++; break; }
                    break;
                }
                return l;
            }

            String str() {
                StringBuilder sb = new StringBuilder();
                if (i < s.length() && s.charAt(i) == '"') i++;
                while (i < s.length()) {
                    char c = s.charAt(i++);
                    if (c == '"') break;
                    if (c == '\\' && i < s.length()) {
                        char e = s.charAt(i++);
                        switch (e) {
                            case 'n' -> sb.append('\n');
                            case 'r' -> sb.append('\r');
                            case 't' -> sb.append('\t');
                            case 'b' -> sb.append('\b');
                            case 'f' -> sb.append('\f');
                            case 'u' -> {
                                if (i + 4 <= s.length()) {
                                    sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                                    i += 4;
                                }
                            }
                            default -> sb.append(e);
                        }
                    } else {
                        sb.append(c);
                    }
                }
                return sb.toString();
            }

            Object num() {
                int st = i;
                while (i < s.length() && "-+.eE0123456789".indexOf(s.charAt(i)) >= 0) i++;
                String t = s.substring(st, i);
                if (t.isEmpty()) return null;
                if (t.contains(".") || t.contains("e") || t.contains("E")) return Double.parseDouble(t);
                try {
                    return Long.parseLong(t);
                } catch (NumberFormatException ex) {
                    return Double.parseDouble(t);
                }
            }
        }
    }
}
