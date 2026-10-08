<template>
  <div class="page" v-if="detail">
    <div class="card">
      <div class="hero">
        <div class="avatar">
          <el-image v-if="cat.avatar" :src="cat.avatar" fit="cover" :preview-src-list="[cat.avatar]" />
          <span v-else>🐱</span>
        </div>
        <div class="head">
          <div class="flex">
            <h2 class="name">{{ cat.name }}</h2>
            <span class="tag" :class="statusItem.tag">{{ statusItem.label }}</span>
            <span class="tag" :class="sterItem.tag">{{ sterItem.label }}</span>
          </div>
          <div class="small muted" v-if="cat.alias">别名：{{ cat.alias }}</div>
          <div class="tags">
            <span class="tag gray">{{ labelOf(PATTERN, cat.pattern, '其它') }}</span>
            <span class="tag gray">{{ labelOf(SEX, cat.sex) }}</span>
            <span class="tag gray" v-if="cat.earMark">耳标：{{ cat.earMark }}</span>
            <span class="tag gray">健康：{{ labelOf(HEALTH, cat.health) }}</span>
            <span class="tag gray" v-if="cat.locationName">常在：{{ cat.locationName }}</span>
          </div>
          <div class="tags" v-if="cat.characterList && cat.characterList.length">
            <span class="tag" v-for="c in cat.characterList" :key="c">{{ c }}</span>
          </div>
        </div>
        <el-button v-if="detail.canEdit" type="primary" size="small" @click="$router.push('/cats/' + cat.id + '/edit')">编辑档案</el-button>
      </div>

      <div class="note" v-if="cat.note">{{ cat.note }}</div>

      <div class="photos" v-if="cat.photoList && cat.photoList.length">
        <el-image v-for="(p, i) in cat.photoList" :key="i" :src="p" fit="cover" :preview-src-list="cat.photoList" />
      </div>
    </div>

    <!-- TNR（仅社团可见） -->
    <div class="card" v-if="detail.tnr && detail.tnr.length">
      <div class="card-title">TNR 记录</div>
      <div class="tnr" v-for="t in detail.tnr" :key="t.id">
        <span class="tag" :class="itemOf(TNR_STATUS, t.status).tag">{{ itemOf(TNR_STATUS, t.status).label }}</span>
        <span class="small muted">
          {{ t.surgeryDate || t.trapDate || '未排期' }}
          <span v-if="t.hospital">· {{ t.hospital }}</span>
          <span v-if="t.cost">· ¥{{ t.cost }}</span>
          <span v-if="t.operator">· {{ t.operator }}</span>
        </span>
      </div>
    </div>

    <!-- 目击时间线 -->
    <div class="card">
      <div class="card-title">目击记录 {{ detail.sightings.length }}</div>
      <el-timeline>
        <el-timeline-item v-for="s in detail.sightings" :key="s.id" :timestamp="fromNow(s.createdAt)" placement="top">
          <div class="flex">
            <span class="small muted">{{ s.reporterName }}</span>
            <span class="small muted" v-if="s.locationName">· {{ s.locationName }}</span>
            <span class="tag gray" v-if="s.health && s.health !== 'unknown'">{{ labelOf(HEALTH, s.health) }}</span>
          </div>
          <div class="small" v-if="s.note">{{ s.note }}</div>
          <div class="photos small-photos" v-if="s.photoList && s.photoList.length">
            <el-image v-for="(p, i) in s.photoList" :key="i" :src="p" fit="cover" :preview-src-list="s.photoList" />
          </div>
        </el-timeline-item>
      </el-timeline>
      <div class="empty" v-if="!detail.sightings.length">
        <span class="emoji">🐾</span>
        还没有人记录过它
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api'
import { PATTERN, SEX, HEALTH, CAT_STATUS, STERILIZED, TNR_STATUS, labelOf, itemOf, fromNow } from '@/utils/dict'
import { computed } from 'vue'

const route = useRoute()
const detail = ref(null)
const cat = computed(() => detail.value ? detail.value.cat : {})
const statusItem = computed(() => itemOf(CAT_STATUS, cat.value.status))
const sterItem = computed(() => itemOf(STERILIZED, cat.value.sterilized))

onMounted(async () => {
  detail.value = await api.cat.detail(route.params.id)
})
</script>

<style scoped>
.hero { display: flex; gap: 20px; align-items: flex-start; }
.avatar {
  width: 140px; height: 140px; border-radius: 18px; overflow: hidden; flex-shrink: 0;
  background: var(--brand-light); display: flex; align-items: center; justify-content: center; font-size: 64px;
}
.avatar :deep(.el-image) { width: 100%; height: 100%; }
.head { flex: 1; min-width: 0; }
.name { margin: 0; font-size: 24px; }
.tags { display: flex; flex-wrap: wrap; margin-top: 10px; }
.note { margin-top: 16px; line-height: 1.8; }
.photos { display: flex; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
.photos :deep(.el-image) { width: 160px; height: 160px; border-radius: 12px; }
.small-photos :deep(.el-image) { width: 90px; height: 90px; border-radius: 8px; }
.tnr { padding: 10px 0; border-bottom: 1px solid var(--line); }
.tnr:last-child { border-bottom: none; }
</style>
