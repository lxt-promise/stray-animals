package com.catcampus.controller;

import com.catcampus.common.CurrentUser;
import com.catcampus.common.Result;
import com.catcampus.entity.TaskItem;
import com.catcampus.service.TaskService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/tasks")
@RequiredArgsConstructor
public class TaskController {

    private final TaskService taskService;

    @GetMapping
    public Result<List<TaskItem>> list(@RequestParam(required = false) Long schoolId,
                                       @RequestParam(required = false) String status,
                                       @RequestParam(defaultValue = "false") boolean mine) {
        if (schoolId == null) schoolId = CurrentUser.schoolId();
        return Result.ok(taskService.list(schoolId, status, mine));
    }

    @PostMapping
    public Result<TaskItem> save(@RequestBody TaskItem t) {
        return Result.ok(taskService.save(t));
    }

    @PostMapping("/{id}/claim")
    public Result<TaskItem> claim(@PathVariable Long id,
                                  @RequestParam(defaultValue = "false") boolean cancel) {
        return Result.ok(taskService.claim(id, cancel));
    }
}
