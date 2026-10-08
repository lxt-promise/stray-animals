package com.catcampus.entity;

import jakarta.persistence.*;
import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDateTime;

/** TNR 台账：抓捕 Trap - 绝育 Neuter - 放归 Return */
@Data
@Entity
@Table(name = "t_tnr")
public class TnrRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private Long catId;
    private String catName;

    /** todo 待抓捕 / trapping 诱捕中 / surgery 手术住院 / released 已放归 / adopted 转领养 */
    private String status = "todo";

    private String trapDate;
    private String surgeryDate;
    private String releaseDate;

    private String hospital;
    private String vet;

    private BigDecimal cost = BigDecimal.ZERO;

    private String earMark;
    private String operator;

    @Column(length = 1000)
    private String note;

    private Long schoolId;

    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;

    @PrePersist
    public void prePersist() {
        if (createdAt == null) createdAt = LocalDateTime.now();
        if (updatedAt == null) updatedAt = createdAt;
        if (status == null) status = "todo";
        if (cost == null) cost = BigDecimal.ZERO;
    }

    @PreUpdate
    public void preUpdate() { updatedAt = LocalDateTime.now(); }
}
