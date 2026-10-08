package com.catcampus.repository;

import com.catcampus.entity.Sighting;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;

@Repository
public interface SightingRepository extends JpaRepository<Sighting, Long>, JpaSpecificationExecutor<Sighting> {

    List<Sighting> findTop20BySchoolIdOrderByCreatedAtDesc(Long schoolId);

    List<Sighting> findTop50ByCatIdOrderByCreatedAtDesc(Long catId);

    int countByReporterIdAndCreatedAtAfter(Long reporterId, LocalDateTime from);
}
