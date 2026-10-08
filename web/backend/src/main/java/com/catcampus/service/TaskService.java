package com.catcampus.service;

import com.catcampus.common.BizException;
import com.catcampus.common.CurrentUser;
import com.catcampus.entity.TaskItem;
import com.catcampus.entity.User;
import com.catcampus.repository.TaskRepository;
import com.catcampus.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@RequiredArgsConstructor
public class TaskService {

    private final TaskRepository taskRepository;
    private final UserRepository userRepository;

    public List<TaskItem> list(Long schoolId, String status, boolean mine) {
        List<TaskItem> list = schoolId == null
            ? taskRepository.findAll()
            : taskRepository.findBySchoolIdOrderByDateAscIdAsc(schoolId);

        // 前端「待认领 / 我认领的 / 全部」三个 Tab 的过滤
        if (status != null && !status.isBlank()) {
            list = list.stream().filter(t -> status.equals(t.getStatus())).toList();
        }
        if (mine) {
            Long uid = CurrentUser.id();
            list = list.stream()
                .filter(t -> t.getAssigneeId() != null && t.getAssigneeId().equals(uid))
                .toList();
        }

        // 联系方式仅社团成员可见
        if (!CurrentUser.isMember()) list.forEach(t -> t.setContact(null));
        return list;
    }

    @Transactional
    public TaskItem save(TaskItem t) {
        CurrentUser.requireMember();
        if (t.getTitle() == null || t.getTitle().isBlank()) throw new BizException("请填写任务标题");
        if (t.getSchoolId() == null) t.setSchoolId(CurrentUser.schoolId());
        if (t.getId() == null && t.getStatus() == null) t.setStatus("open");
        return taskRepository.save(t);
    }

    @Transactional
    public TaskItem claim(Long id, boolean cancel) {
        CurrentUser.requireLogin();
        TaskItem t = taskRepository.findById(id).orElseThrow(() -> new BizException("任务不存在"));
        if (cancel) {
            t.setStatus("open");
            t.setAssigneeId(null);
            t.setAssigneeName(null);
        } else {
            User me = userRepository.findById(CurrentUser.id()).orElseThrow(() -> new BizException("用户不存在"));
            t.setStatus("claimed");
            t.setAssigneeId(me.getId());
            t.setAssigneeName(me.getNickName());
        }
        return taskRepository.save(t);
    }
}
