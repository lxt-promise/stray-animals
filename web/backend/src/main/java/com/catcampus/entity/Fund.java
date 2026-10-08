package com.catcampus.entity;

import jakarta.persistence.*;
import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDateTime;

/** 资金收支 */
@Data
@Entity
@Table(name = "t_fund")
public class Fund {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** income 收入 / expense 支出 */
    private String type;

    private BigDecimal amount = BigDecimal.ZERO;

    /** donation 捐赠 / tnr 绝育 / medical 医疗 / food 猫粮 / other */
    private String category = "other";

    private String title;
    private String date;

    private Long catId;

    /** 凭证图片 URL，逗号分隔 */
    @Column(length = 2000)
    private String proof = "";

    private String operator;
    private Long schoolId;

    private LocalDateTime createdAt;

    @PrePersist
    public void prePersist() {
        if (createdAt == null) createdAt = LocalDateTime.now();
        if (amount == null) amount = BigDecimal.ZERO;
    }
}
