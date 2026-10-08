package com.catcampus.common;

/** 当前登录用户上下文（ThreadLocal，拦截器写入、请求结束清理） */
public class CurrentUser {

    private static final ThreadLocal<Long> UID = new ThreadLocal<>();
    private static final ThreadLocal<String> ROLE = new ThreadLocal<>();
    private static final ThreadLocal<Long> SCHOOL = new ThreadLocal<>();

    public static void set(Long uid, String role, Long schoolId) {
        UID.set(uid);
        ROLE.set(role);
        SCHOOL.set(schoolId);
    }

    public static void clear() {
        UID.remove();
        ROLE.remove();
        SCHOOL.remove();
    }

    public static Long id() { return UID.get(); }
    public static String role() { return ROLE.get(); }
    public static Long schoolId() { return SCHOOL.get(); }

    public static boolean isMember() {
        String r = role();
        return "member".equals(r) || "admin".equals(r);
    }

    public static boolean isAdmin() { return "admin".equals(role()); }

    public static void requireMember() {
        if (!isMember()) throw new BizException(403, "需要社团成员权限");
    }

    public static void requireAdmin() {
        if (!isAdmin()) throw new BizException(403, "需要管理员权限");
    }

    public static void requireLogin() {
        if (id() == null) throw new BizException(401, "请先登录");
    }
}
