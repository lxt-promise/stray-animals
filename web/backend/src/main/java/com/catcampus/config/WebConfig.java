package com.catcampus.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.io.IOException;

@Configuration
@RequiredArgsConstructor
public class WebConfig implements WebMvcConfigurer {

    private final JwtInterceptor jwtInterceptor;

    @Value("${catcampus.upload-dir}")
    private String uploadDir;

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        // allowedOriginPatterns("*") + allowCredentials(true) 组合过宽：
        // 任意站点可带凭证跨域调用。收紧为本地开发常用源（生产用 CAMPUS_CORS_ORIGINS 覆盖）。
        String origins = System.getenv().getOrDefault("CAMPUS_CORS_ORIGINS",
                "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8080");
        registry.addMapping("/**")
                .allowedOriginPatterns(origins.split(","))
                .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS")
                .allowedHeaders("*")
                .allowCredentials(true)
                .maxAge(3600);
    }

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        registry.addResourceHandler("/uploads/**")
                .addResourceLocations("file:" + uploadDir + "/");
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(jwtInterceptor)
                .addPathPatterns("/api/**")
                .excludePathPatterns("/api/auth/register", "/api/auth/login");
    }

    /**
     * 安全响应头过滤器。
     *
     * <p>必须用 Filter 而不是 HandlerInterceptor：静态资源请求走
     * ResourceHttpRequestHandler，**不经过拦截器链** —— 用拦截器给 /uploads/**
     * 加 nosniff 是无效的（这是 SVG-XSS 防护链的最后一环：FileService 的扩展名
     * 白名单拦新上传，nosniff 兜住历史遗留的 .svg 不被当 XML 执行脚本）。
     */
    @org.springframework.stereotype.Component
    public static class SecurityHeadersFilter extends OncePerRequestFilter {
        @Override
        protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                        FilterChain chain) throws ServletException, IOException {
            response.setHeader("X-Content-Type-Options", "nosniff");
            response.setHeader("X-Frame-Options", "DENY");
            chain.doFilter(request, response);
        }
    }
}
