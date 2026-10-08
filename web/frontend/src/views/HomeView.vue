<template>
  <div class="page">
    <!-- 概览统计 -->
    <div class="stat-grid" v-if="overview">
      <div class="stat-card">
        <div class="num">{{ overview.catCount }}</div>
        <div class="lbl">在册猫咪</div>
      </div>
      <div class="stat-card">
        <div class="num">{{ overview.sterilizedRate }}%</div>
        <div class="lbl">绝育率</div>
      </div>
      <div class="stat-card">
        <div class="num">{{ overview.sightingMonth }}</div>
        <div class="lbl">本月目击</div>
      </div>
      <div class="stat-card">
        <div class="num">{{ overview.tnrMonth }}</div>
        <div class="lbl">本月 TNR</div>
      </div>
      <div class="stat-card">
        <div class="num">{{ overview.taskOpen }}</div>
        <div class="lbl">待办任务</div>
      </div>
    </div>

    <!-- 欢迎 -->
    <div class="card hero">
      <div class="flex-between">
        <div>
          <div class="title">记录，是为了让它们少一点 🐾</div>
          <div class="small muted" style="margin-top:8px;line-height:1.7">
            学生在校园里拍照打卡，社团据此做绝育与救助决策。所有数据按学校隔离，向外拓展只需新建一个学校。
          </div>
        </div>
        <div class="actions">
          <el-button type="primary" @click="$router.push('/sighting')">去打卡</el-button>
          <el-button @click="$router.push('/map')">看地图</el-button>
        </div>
      </div>
    </div>

    <!-- TNR 进度 -->
    <div class="card" v-if="overview && overview.catCount">
      <div class="card-title">
        <span>TNR 进展</span>
        <span class="small muted">已绝育 {{ overview.sterilized }} / {{ overview.catCount }}</span>
      </div>
      <el-progress :percentage="overview.sterilizedRate" :stroke-width="14" color="#ff8a3d" />
      <div class="small muted" style="margin-top:12px">
        绝育率是衡量校园猫口是否可控的核心指标，国际通行做法是做到 70% 以上。
      </div>
    </div>

    <!-- 最近目击 -->
    <div class="card">
      <div class="card-title">
        <span>最新目击</span>
        <el-button link type="primary" @click="$router.push('/cats?tab=sighting')">查看全部 ›</el-button>
      </div>

      <div v-for="s in recent" :key="s.id" class="feed">
        <div class="feed-img">
          <el-image v-if="s.photoList && s.photoList.length" :src="s.photoList[0]" fit="cover" :preview-src-list="s.photoList" />
          <span v-else>🐱</span>
        </div>
        <div class="feed-body">
          <div class="flex">
            <b v-if="s.catId" class="link" @click="$router.push('/cats/' + s.catId)">{{ s.catName }}</b>
            <b v-else class="muted">{{ s.catName || '未认领的新猫' }}</b>
            <span class="tag gray" v-if="s.pending">待建档</span>
            <span class="small muted">{{ s.locationName }}</span>
          </div>
          <div class="small" style="margin-top:6px" v-if="s.note">{{ s.note }}</div>
          <div class="small muted" style="margin-top:6px">{{ s.reporterName }} · {{ fromNow(s.createdAt) }}</div>
        </div>
      </div>

      <div class="empty" v-if="!recent.length">
        <span class="emoji">🐾</span>
        还没有目击记录
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { api } from '@/api'
import { useUserStore } from '@/stores/user'
import { fromNow } from '@/utils/dict'

const store = useUserStore()
const overview = ref(null)
const recent = ref([])

onMounted(async () => {
  try {
    const data = await api.stat.overview({ schoolId: store.user?.schoolId })
    overview.value = data
    recent.value = data.recent || []
  } catch (e) { /* ignore */ }
})
</script>

<style scoped>
.hero .title { font-size: 20px; font-weight: 700; }
.actions { display: flex; gap: 10px; flex-shrink: 0; }
.feed { display: flex; gap: 14px; padding: 14px 0; border-bottom: 1px solid var(--line); }
.feed:last-child { border-bottom: none; }
.feed-img {
  width: 72px; height: 72px; border-radius: 12px; overflow: hidden; flex-shrink: 0;
  background: var(--brand-light); display: flex; align-items: center; justify-content: center; font-size: 32px;
}
.feed-img :deep(.el-image) { width: 100%; height: 100%; }
.feed-body { flex: 1; min-width: 0; }
.link { color: var(--brand-dark); cursor: pointer; }
</style>
