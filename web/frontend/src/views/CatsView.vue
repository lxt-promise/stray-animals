<template>
  <div class="page">
    <el-tabs v-model="tab" @tab-change="load">
      <el-tab-pane label="猫谱" name="cats" />
      <el-tab-pane label="目击动态" name="sighting" />
    </el-tabs>

    <!-- 猫谱 -->
    <template v-if="tab === 'cats'">
      <div class="card">
        <div class="filters">
          <el-input v-model="keyword" placeholder="搜索名字 / 别名 / 点位" clearable style="width:240px" @keyup.enter="reload" @clear="reload" />
          <el-select v-model="status" placeholder="状态" clearable style="width:140px" @change="reload">
            <el-option v-for="i in CAT_STATUS" :key="i.value" :label="i.label" :value="i.value" />
          </el-select>
          <el-select v-model="sterilized" placeholder="绝育" clearable style="width:140px" @change="reload">
            <el-option v-for="i in STERILIZED" :key="i.value" :label="i.label" :value="i.value" />
          </el-select>
          <el-select v-model="pattern" placeholder="花色" clearable style="width:140px" @change="reload">
            <el-option v-for="i in PATTERN" :key="i.value" :label="i.label" :value="i.value" />
          </el-select>
          <el-button type="primary" @click="reload">搜索</el-button>
          <el-button v-if="store.isMember" @click="$router.push('/cats/new/edit')">+ 新建档案</el-button>
        </div>
      </div>

      <div class="cat-grid">
        <CatCard v-for="c in list" :key="c.id" :cat="c" />
      </div>

      <div class="empty" v-if="!loading && !list.length">
        <span class="emoji">🐱</span>
        还没有猫咪档案
      </div>

      <div class="pager" v-if="total > size">
        <el-pagination background layout="prev, pager, next" :total="total" :page-size="size" v-model:current-page="page" @current-change="load" />
      </div>
    </template>

    <!-- 目击动态 -->
    <template v-else>
      <div class="card" v-for="s in sightings" :key="s.id">
        <div class="flex-between">
          <div class="flex">
            <b v-if="s.catId" class="link" @click="$router.push('/cats/' + s.catId)">{{ s.catName }}</b>
            <b v-else class="muted">{{ s.catName }}</b>
            <span class="tag gray" v-if="s.pending">待建档</span>
            <span class="small muted">{{ s.locationName }}</span>
          </div>
          <span class="small muted">{{ fromNow(s.createdAt) }}</span>
        </div>
        <div class="small" style="margin-top:8px" v-if="s.note">{{ s.note }}</div>
        <div class="photos" v-if="s.photoList && s.photoList.length">
          <el-image v-for="(p, i) in s.photoList" :key="i" :src="p" fit="cover" :preview-src-list="s.photoList" />
        </div>
        <div class="small muted" style="margin-top:8px">
          {{ s.reporterName }} · 健康：{{ labelOf(HEALTH, s.health) }} · 获得猫粮值 {{ s.points }}
        </div>
      </div>

      <div class="empty" v-if="!loading && !sightings.length">
        <span class="emoji">📷</span>
        暂无目击记录
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api'
import { useUserStore } from '@/stores/user'
import CatCard from '@/components/CatCard.vue'
import { CAT_STATUS, STERILIZED, PATTERN, HEALTH, labelOf, fromNow } from '@/utils/dict'

const route = useRoute()
const store = useUserStore()

const tab = ref(route.query.tab === 'sighting' ? 'sighting' : 'cats')
const list = ref([])
const sightings = ref([])
const loading = ref(false)
const page = ref(1)
const size = 20
const total = ref(0)
const keyword = ref('')
const status = ref('')
const sterilized = ref('')
const pattern = ref('')

onMounted(load)
watch(tab, load)

function reload() { page.value = 1; load() }

async function load() {
  loading.value = true
  try {
    if (tab.value === 'cats') {
      const data = await api.cat.list({
        page: page.value, size,
        keyword: keyword.value || undefined,
        status: status.value || undefined,
        sterilized: sterilized.value || undefined,
        pattern: pattern.value || undefined
      })
      list.value = data.list
      total.value = data.total
    } else {
      const data = await api.sighting.list({ page: 1, size: 30 })
      sightings.value = data.list
    }
  } catch (e) { /* ignore */ }
  loading.value = false
}
</script>

<style scoped>
.filters { display: flex; gap: 12px; flex-wrap: wrap; }
.cat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
.pager { margin-top: 20px; display: flex; justify-content: center; }
.photos { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.photos :deep(.el-image) { width: 120px; height: 120px; border-radius: 10px; }
.link { color: var(--brand-dark); cursor: pointer; }
</style>
