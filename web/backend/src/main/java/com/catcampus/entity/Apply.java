package com.catcampus.entity;

import jakarta.persistence.*;
import lombok.Data;
import java.time.LocalDateTime;

/** 入社申请 */
@Data
@Entity
@Table(name = "t_apply")
public class Apply {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private Long userId;
    private String nickName;
    private String contact;

    @Column(length = 1000)
    private String reason;

    @Column(length = 1000)
    private String experience;

    private Long schoolId;

    /** pending / approved / rejected */
    private String status = "pending";

    private String handler;
    private LocalDateTime createdAt;
    private LocalDateTime handledAt;

    @PrePersist
    public void prePersist() {
        if (createdAt == null) createdAt = LocalDateTime.now();
        if (status == null) status = "pending";
    }
}
