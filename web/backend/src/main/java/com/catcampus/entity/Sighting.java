package com.catcampus.entity;

import jakarta.persistence.*;
import lombok.Data;
import java.time.LocalDateTime;
import java.util.List;

/** 目击打卡 */
@Data
@Entity
@Table(name = "t_sighting", indexes = { @Index(columnList = "schoolId"), @Index(columnList = "catId") })
public class Sighting {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private Long catId;
    private String catName;

    /** true 表示尚未建档，待社团认领 */
    private Boolean pending = false;

    private Double locationLat;
    private Double locationLng;
    private String locationName;

    @Column(length = 2000)
    private String photos = "";

    private String health = "unknown";

    @Column(length = 2000)
    private String note;

    private Integer count = 1;

    private Long reporterId;
    private String reporterName;

    private Integer points = 0;

    private Long schoolId;

    private LocalDateTime createdAt;

    @Transient
    private List<String> photoList;

    @PrePersist
    public void prePersist() {
        if (createdAt == null) createdAt = LocalDateTime.now();
        if (pending == null) pending = false;
        if (count == null) count = 1;
    }
}
