package com.catcampus.repository;

import com.catcampus.entity.TnrRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface TnrRepository extends JpaRepository<TnrRecord, Long> {

    List<TnrRecord> findBySchoolIdOrderByCreatedAtDesc(Long schoolId);

    List<TnrRecord> findByCatIdOrderByCreatedAtDesc(Long catId);
}
