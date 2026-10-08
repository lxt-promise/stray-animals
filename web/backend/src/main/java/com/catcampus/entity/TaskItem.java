package com.catcampus.entity;

import jakarta.persistence.*;
import lombok.Data;
import java.time.LocalDateTime;

/** 喂猫排班 / 社团任务 */
@Data
@Entity
@Table(name = "t_task")
public class TaskItem {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String title;

    /** feed 喂猫 / trap 抓捕 / medical 送医 / clean 清洁 / other */
    private String type = "feed";

    private String date;
    private String spot;

    private Long assigneeId;
    private String assigneeName;

    /** open 待认领 / claimed 已认领 / done 已完成 */
    private String status = "open";

    @Column(length = 1000)
    private String note;

    /** 联系方式仅社团成员可见 */
    private String contact;

    private Long schoolId;

    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;

    @PrePersist
    public void prePersist() {
        if (createdAt == null) createdAt = LocalDateTime.now();
        if (updatedAt == null) updatedAt = createdAt;
        if (status == null) status = "open";
    }

    @PreUpdate
    public void preUpdate() { updatedAt = LocalDateTime.now(); }
}
