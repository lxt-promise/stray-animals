package com.catcampus.repository;

import com.catcampus.entity.Apply;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface ApplyRepository extends JpaRepository<Apply, Long> {

    List<Apply> findBySchoolIdAndStatusOrderByCreatedAtDesc(Long schoolId, String status);

    List<Apply> findByUserIdOrderByCreatedAtDesc(Long userId);
}
