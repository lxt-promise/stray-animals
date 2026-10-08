package com.catcampus.service;

import com.catcampus.common.CurrentUser;
import com.catcampus.entity.*;
import com.catcampus.repository.*;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** 首页概览统计 */
@Service
@RequiredArgsConstructor
public class StatService {

    private final CatRepository catRepository;
    private final SightingRepository sightingRepository;
    private final TnrRepository tnrRepository;
    private final TaskRepository taskRepository;
    private final FundService fundService;

    public Map<String, Object> overview(Long schoolId) {
        List<Cat> cats = catRepository.findAll().stream()
                .filter(c -> schoolId == null || schoolId.equals(c.getSchoolId()))
                .toList();

        long alive = cats.stream().filter(c -> !"rainbow".equals(c.getStatus()) && !"adopted".equals(c.getStatus())).count();
        long onCampus = cats.stream().filter(c -> "campus".equals(c.getStatus())).count();
        long sterilized = cats.stream().filter(c -> "yes".equals(c.getSterilized())
                && !"rainbow".equals(c.getStatus()) && !"adopted".equals(c.getStatus())).count();

        LocalDateTime monthStart = LocalDate.now().withDayOfMonth(1).atStartOfDay();
        long sightingMonth = sightingRepository.findAll().stream()
                .filter(s -> (schoolId == null || schoolId.equals(s.getSchoolId()))
                        && s.getCreatedAt() != null && !s.getCreatedAt().isBefore(monthStart))
                .count();
        long tnrMonth = tnrRepository.findAll().stream()
                .filter(t -> (schoolId == null || schoolId.equals(t.getSchoolId()))
                        && t.getCreatedAt() != null && !t.getCreatedAt().isBefore(monthStart))
                .count();
        long taskOpen = taskRepository.findAll().stream()
                .filter(t -> (schoolId == null || schoolId.equals(t.getSchoolId())) && "open".equals(t.getStatus()))
                .count();

        Map<String, Object> fund = CurrentUser.isMember()
                ? fundService.summary(schoolId)
                : Map.of("income", 0, "expense", 0, "balance", 0);

        Map<String, Object> m = new HashMap<>();
        m.put("catCount", alive);
        m.put("onCampus", onCampus);
        m.put("sterilized", sterilized);
        m.put("sterilizedRate", alive == 0 ? 0 : Math.round(sterilized * 100.0 / alive));
        m.put("sightingMonth", sightingMonth);
        m.put("tnrMonth", tnrMonth);
        m.put("taskOpen", taskOpen);
        m.put("fund", fund);
        return m;
    }

    /** 首页「最近目击」 */
    public List<Sighting> recent(Long schoolId, int n) {
        List<Sighting> list = sightingRepository.findAll().stream()
                .filter(s -> schoolId == null || schoolId.equals(s.getSchoolId()))
                .sorted((a, b) -> b.getCreatedAt().compareTo(a.getCreatedAt()))
                .limit(n)
                .toList();
        list.forEach(s -> s.setPhotoList(CatService.split(s.getPhotos())));
        return list;
    }
}
