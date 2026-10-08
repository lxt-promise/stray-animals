package com.catcampus.entity;

import com.fasterxml.jackson.annotation.JsonIgnore;
import jakarta.persistence.*;
import lombok.Data;
import java.time.LocalDateTime;

/** 用户 */
@Data
@Entity
@Table(name = "t_user")
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(unique = true, nullable = false, length = 64)
    private String username;

    @JsonIgnore
    @Column(nullable = false)
    private String password;

    private String nickName;

    private String avatarUrl;

    /** visitor / member / admin */
    @Column(nullable = false, length = 16)
    private String role = "visitor";

    private Long schoolId;

    private Integer points = 0;

    private Integer sightingCount = 0;

    /** 已收集图鉴的猫 ID，逗号分隔 */
    @Column(length = 1000)
    private String catSeen = "";

    private String contact;

    private LocalDateTime createdAt;

    private LocalDateTime lastSeenAt;

    @PrePersist
    public void prePersist() {
        if (createdAt == null) createdAt = LocalDateTime.now();
        if (role == null) role = "visitor";
        if (points == null) points = 0;
        if (sightingCount == null) sightingCount = 0;
        if (catSeen == null) catSeen = "";
    }
}
