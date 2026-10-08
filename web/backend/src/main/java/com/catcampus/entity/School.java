package com.catcampus.entity;

import jakarta.persistence.*;
import lombok.Data;
import java.time.LocalDateTime;

/** 学校 —— 数据隔离与「向外拓展」的支点 */
@Data
@Entity
@Table(name = "t_school")
public class School {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String name;

    private String campus;

    private String city;

    /** 校园地图中心点 */
    private Double centerLat;
    private Double centerLng;

    private Integer scale = 16;

    @Column(length = 500)
    private String intro;

    private LocalDateTime createdAt;

    @PrePersist
    public void prePersist() {
        if (createdAt == null) createdAt = LocalDateTime.now();
        if (scale == null) scale = 16;
    }
}
