package com.catcampus.repository;

import com.catcampus.entity.User;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface UserRepository extends JpaRepository<User, Long> {

    Optional<User> findByUsername(String username);

    boolean existsByUsername(String username);

    /** 原子加分：读-改-写会并发丢失（两个打卡都读到 100 各 +10 写回 110） */
    @Modifying
    @Query("update User u set u.points = coalesce(u.points, 0) + ?2 where u.id = ?1")
    int addPoints(Long id, int delta);

    /** 原子打卡计数 */
    @Modifying
    @Query("update User u set u.sightingCount = coalesce(u.sightingCount, 0) + ?2 where u.id = ?1")
    int addSightingCount(Long id, int delta);

    /** 图鉴（catSeen 逗号串）原子覆盖 */
    @Modifying
    @Query("update User u set u.catSeen = ?2 where u.id = ?1")
    int updateCatSeen(Long id, String catSeen);
}
