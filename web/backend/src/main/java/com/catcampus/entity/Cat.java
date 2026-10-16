package com.catcampus.entity;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.persistence.*;
import lombok.Data;
import java.time.LocalDateTime;
import java.util.List;

/** 猫档案 */
@Data
@Entity
@Table(name = "t_cat", indexes = { @Index(columnList = "schoolId"), @Index(columnList = "status") })
public class Cat {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String name;

    private String alias;

    /** male / female / unknown */
    private String sex = "unknown";

    /** tabby / orange / cow / black / white / calico / tortoiseshell / siamese / gray / other */
    private String pattern = "other";

    private String colorNote;

    /** yes / no / unknown */
    private String sterilized = "unknown";

    private String earMark;

    /** campus / adopted / foster / kitten / sick / missing / rainbow */
    private String status = "campus";

    /** healthy / mild / sick / injured / unknown */
    private String health = "unknown";

    /** 性格标签，逗号分隔 */
    @Column(length = 200)
    private String characters = "";

    private Double locationLat;
    private Double locationLng;
    private String locationName;

    /** 精确点位仅社团可见（幼猫/伤病猫建议开启） */
    private Boolean spotPrivate = false;

    private String avatar;

    /** 照片 URL，逗号分隔 */
    @Column(length = 2000)
    private String photos = "";

    @Column(length = 2000)
    private String note;

    /** 内部备注 / 医疗备注：只允许写入（管理端提交），永不读出。
     *  ⚠️ 不能用 @JsonIgnore —— 它同时阻断序列化和反序列化，
     *  前端 save() 提交的这两个字段会被 Jackson 静默丢弃（功能整体失效且无报错）。
     *  不读出的语义由 CatService.sanitize 置 null + 这里的 WRITE_ONLY 双保险。 */
    @JsonProperty(access = JsonProperty.Access.WRITE_ONLY)
    @Column(length = 2000)
    private String internalNote;

    @JsonProperty(access = JsonProperty.Access.WRITE_ONLY)
    @Column(length = 2000)
    private String medicalNote;

    private Long schoolId;

    private Integer sightingCount = 0;

    private LocalDateTime lastSeenAt;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;

    /** 非持久化：返回给前端的照片数组 */
    @Transient
    private List<String> photoList;

    @Transient
    private List<String> characterList;

    @PrePersist
    public void prePersist() {
        if (createdAt == null) createdAt = LocalDateTime.now();
        if (updatedAt == null) updatedAt = createdAt;
        if (sightingCount == null) sightingCount = 0;
        if (spotPrivate == null) spotPrivate = false;
    }

    @PreUpdate
    public void preUpdate() {
        updatedAt = LocalDateTime.now();
    }
}
