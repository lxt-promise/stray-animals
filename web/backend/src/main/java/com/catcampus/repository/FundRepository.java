package com.catcampus.repository;

import com.catcampus.entity.Fund;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface FundRepository extends JpaRepository<Fund, Long> {

    List<Fund> findBySchoolIdOrderByDateDescIdDesc(Long schoolId);

    List<Fund> findBySchoolIdAndType(Long schoolId, String type);
}
