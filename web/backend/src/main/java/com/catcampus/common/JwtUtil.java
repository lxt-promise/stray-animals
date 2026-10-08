package com.catcampus.common;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

/**
 * 极简 JWT（HS256）实现 —— 不引入 jjwt，避免 JDK 版本与依赖冲突。
 * 仅用于本项目内部鉴权，生产环境请替换为更完善的方案。
 */
@Component
public class JwtUtil {

    private final byte[] secret;
    private final long expireMillis;
    private final ObjectMapper mapper = new ObjectMapper();

    public JwtUtil(@Value("${catcampus.jwt-secret}") String secret,
                   @Value("${catcampus.jwt-expire-hours}") long expireHours) {
        this.secret = secret.getBytes(StandardCharsets.UTF_8);
        this.expireMillis = expireHours * 3600L * 1000L;
    }

    public String createToken(Long userId, String role, Long schoolId) {
        Map<String, Object> claims = new HashMap<>();
        claims.put("uid", userId);
        claims.put("role", role == null ? "visitor" : role);
        claims.put("schoolId", schoolId);
        return createToken(claims);
    }

    public String createToken(Map<String, Object> claims) {
        try {
            long now = System.currentTimeMillis();
            claims.put("iat", now / 1000);
            claims.put("exp", (now + expireMillis) / 1000);

            String header = b64(mapper.writeValueAsString(Map.of("alg", "HS256", "typ", "JWT")));
            String payload = b64(mapper.writeValueAsString(claims));
            String signingInput = header + "." + payload;
            return signingInput + "." + b64Url(hmac(signingInput));
        } catch (Exception e) {
            throw new BizException("生成令牌失败");
        }
    }

    /** 解析并返回 claims；令牌无效或过期时返回 null */
    @SuppressWarnings("unchecked")
    public Map<String, Object> parse(String token) {
        if (token == null || token.isBlank()) return null;
        String[] parts = token.split("\\.");
        if (parts.length != 3) return null;
        try {
            String signingInput = parts[0] + "." + parts[1];
            String expect = b64Url(hmac(signingInput));
            if (!constantTimeEquals(expect, parts[2])) return null;

            String json = new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8);
            Map<String, Object> claims = mapper.readValue(json, Map.class);
            Object exp = claims.get("exp");
            if (exp == null) return null;
            long expSec = ((Number) exp).longValue();
            if (System.currentTimeMillis() / 1000 > expSec) return null;
            return claims;
        } catch (Exception e) {
            return null;
        }
    }

    private byte[] hmac(String data) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret, "HmacSHA256"));
        return mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
    }

    private static String b64(String s) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(s.getBytes(StandardCharsets.UTF_8));
    }

    private static String b64Url(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (a.length() != b.length()) return false;
        int r = 0;
        for (int i = 0; i < a.length(); i++) r |= a.charAt(i) ^ b.charAt(i);
        return r == 0;
    }
}
