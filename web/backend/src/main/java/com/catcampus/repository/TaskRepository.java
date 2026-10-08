package com.catcampus.repository;

import com.catcampus.entity.TaskItem;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface TaskRepository extends JpaRepository<TaskItem, Long> {

    List<TaskItem> findBySchoolIdOrderByDateAscIdAsc(Long schoolId);
}
