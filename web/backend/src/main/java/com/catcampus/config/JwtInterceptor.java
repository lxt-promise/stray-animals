package com.catcampus.config;

import com.catcampus.common.CurrentUser;
import com.catcampus.common.JwtUtil;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.util.AntPathMatcher;
import org.springframework.web.servlet.HandlerInterceptor;

import java.util.List;
import java.util.Map;

/**
 * JWT 鉴权拦截器。
 * 白名单内的接口可匿名访问（游客也能看猫谱、地图、动态），其余接口需登录。
 * 更细的权限（成员 / 管理员）由 Service 层的 CurrentUser.requireXxx 控制。
 */
@Component
@RequiredArgsConstructor
public class JwtInterceptor implements HandlerInterceptor {

    private static final AntPathMatcher MATCHER = new AntPathMatcher();

    private static final List<String> PUBLIC = List.of(
            "/api/auth/register",
            "/api/auth/login",
            "/api/cats",
            "/api/cats/map",
            "/api/cats/*",
            "/api/sightings",
            "/api/sightings/recent",
            "/api/stat/overview",
            "/api/stat/recent",
            "/api/schools",
            "/api/schools/*",
            // 识别服务健康检查：探活用，必须匿名
            "/api/vision/health",
            // ⚠️ /api/vision/recognize 与 /api/vision/build-index 绝不能匿名：
            //   recognize 的 url 参数直达识别服务无校验下载（未登录即可 SSRF 打内网/云元数据），
            //   build-index 会清空并重建特征库（未登录即可破坏识别功能）。
            //   两者改为登录后可用，更细的成员校验由 Service 层 CurrentUser 控制。
            "/uploads/**"
    );

    private final JwtUtil jwtUtil;

    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse resp, Object handler) {
        String uri = req.getRequestURI();
        if (isPublic(uri)) {
            // 公开接口也尝试识别身份（便于个性化），但不强制
            tryFill(req);
            return true;
        }

        Map<String, Object> claims = tryFill(req);
        if (claims == null) {
            resp.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            resp.setContentType("application/json;charset=UTF-8");
            try {
                resp.getWriter().write("{\"code\":401,\"msg\":\"请先登录\",\"data\":null}");
            } catch (Exception ignored) {}
            return false;
        }
        return true;
    }

    private Map<String, Object> tryFill(HttpServletRequest req) {
        String auth = req.getHeader("Authorization");
        String token = null;
        if (auth != null && auth.startsWith("Bearer ")) token = auth.substring(7);
        if (token == null) token = req.getParameter("token");
        Map<String, Object> claims = jwtUtil.parse(token);
        if (claims != null) {
            Long uid = claims.get("uid") == null ? null : Long.valueOf(claims.get("uid").toString());
            Long sid = claims.get("schoolId") == null ? null : Long.valueOf(claims.get("schoolId").toString());
            CurrentUser.set(uid, claims.get("role") == null ? null : claims.get("role").toString(), sid);
        }
        return claims;
    }

    private boolean isPublic(String uri) {
        for (String p : PUBLIC) {
            if (MATCHER.match(p, uri)) return true;
        }
        return false;
    }

    @Override
    public void afterCompletion(HttpServletRequest req, HttpServletResponse resp, Object handler, Exception ex) {
        CurrentUser.clear();
    }
}
