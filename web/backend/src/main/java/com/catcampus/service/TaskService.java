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
        Long uid = CurrentUser.id();
        TaskItem t = taskRepository.findById(id).orElseThrow(() -> new BizException("任务不存在"));
        if (cancel) {
            // 归属校验：早期不校验 assigneeId，任何登录用户可以取消别人的认领（越权）
            if (t.getAssigneeId() == null || !t.getAssigneeId().equals(uid)) {
                throw new BizException("只能取消自己认领的任务");
            }
            t.setStatus("open");
            t.setAssigneeId(null);
            t.setAssigneeName(null);
        } else {
            // 状态校验：并发抢单时两个请求都读到 open，后写者静默覆盖先写者，
            // 两人都看到「认领成功」而任务只属于最后写入的人
            if (!"open".equals(t.getStatus())) {
                throw new BizException("任务已被认领");
            }
            User me = userRepository.findById(uid).orElseThrow(() -> new BizException("用户不存在"));
            t.setStatus("claimed");
            t.setAssigneeId(me.getId());
            t.setAssigneeName(me.getNickName());
        }
        return taskRepository.save(t);
    }
}
