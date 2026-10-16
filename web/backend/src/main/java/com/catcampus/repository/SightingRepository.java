package com.catcampus.repository;

import com.catcampus.entity.Sighting;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;

@Repository
public interface SightingRepository extends JpaRepository<Sighting, Long>, JpaSpecificationExecutor<Sighting> {

    List<Sighting> findTop20BySchoolIdOrderByCreatedAtDesc(Long schoolId);

    List<Sighting> findTop50ByCatIdOrderByCreatedAtDesc(Long catId);

    int countByReporterIdAndCreatedAtAfter(Long reporterId, LocalDateTime from);

    /** 今日已获积分合计（日上限按真实收益计算，而不是只数基础打卡分） */
    @Query("select coalesce(sum(s.points), 0) from Sighting s where s.reporterId = ?1 and s.createdAt > ?2")
    int sumPointsByReporterIdAndCreatedAtAfter(Long reporterId, LocalDateTime from);
}
