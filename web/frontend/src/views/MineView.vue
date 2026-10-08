<template>
  <div class="page">
    <div class="card">
      <div class="flex-between">
        <div class="flex">
          <div class="avatar">{{ (store.user?.nickName || '猫')[0] }}</div>
          <div>
            <div class="bold" style="font-size:18px">{{ store.user?.nickName }}</div>
            <div class="small muted" style="margin-top:6px">
              <span class="tag" :class="store.isMember ? 'ok' : 'gray'">
                {{ store.isAdmin ? '管理员' : (store.isMember ? '社团成员' : '爱猫同学') }}
              </span>
              {{ store.school?.name || '未绑定学校' }}
            </div>
          </div>
        </div>
        <el-button @click="store.logout()">退出</el-button>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card"><div class="num">{{ store.user?.points || 0 }}</div><div class="lbl">猫粮值</div></div>
      <div class="stat-card"><div class="num">{{ store.user?.sightingCount || 0 }}</div><div class="lbl">打卡次数</div></div>
      <div class="stat-card"><div class="num">{{ store.user?.catSeenCount || 0 }}</div><div class="lbl">图鉴收集</div></div>
    </div>

    <!-- 学校 -->
    <div class="card">
      <div class="card-title">
        <span>学校</span>
        <el-button link type="primary" @click="showSchool = !showSchool">{{ showSchool ? '收起' : '创建 / 切换' }}</el-button>
      </div>

      <div v-if="!showSchool">
        <div class="small muted" v-if="store.school">{{ store.school.name }} {{ store.school.campus }} {{ store.school.city }}</div>
        <div class="small muted" v-else>未绑定学校，管理员可在下方创建</div>
      </div>

      <div v-else>
        <el-form :model="schoolForm" label-position="top" v-if="store.isAdmin">
          <el-row :gutter="16">
            <el-col :span="8"><el-form-item label="学校名称"><el-input v-model="schoolForm.name" /></el-form-item></el-col>
            <el-col :span="8"><el-form-item label="校区"><el-input v-model="schoolForm.campus" /></el-form-item></el-col>
            <el-col :span="8"><el-form-item label="城市"><el-input v-model="schoolForm.city" /></el-form-item></el-col>
          </el-row>
          <el-button type="primary" size="small" @click="createSchool">创建并绑定</el-button>
        </el-form>
        <div class="small muted mt" v-else>仅管理员可创建学校</div>

        <div class="mt">
          <div class="bold small" style="margin-bottom:10px">已有学校</div>
          <div class="school-item" v-for="s in schools" :key="s.id" @click="bind(s.id)">
            {{ s.name }} {{ s.campus }} {{ s.city }}
          </div>
        </div>
      </div>
    </div>

    <!-- 我的打卡 -->
    <div class="card">
      <div class="card-title">我的打卡</div>
      <div v-for="s in mine" :key="s.id" class="feed">
        <div class="flex-between">
          <div>
            <b>{{ s.catName || '新猫' }}</b>
            <span class="small muted"> · {{ s.locationName || '未标注' }}</span>
          </div>
          <span class="small muted">{{ fromNow(s.createdAt) }}</span>
        </div>
        <div class="small muted" v-if="s.note">{{ s.note }}</div>
      </div>
      <div class="empty" v-if="!mine.length"><span class="emoji">🐾</span>还没有记录</div>
    </div>

    <div class="card">
      <div class="small muted" style="line-height:1.8">
        猫粮值规则：目击打卡 +10，上报新猫 +30，首次遇见某只猫 +20，参与 TNR 记录 +50。每日打卡上限 60，防止刷分。
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '@/api'
import { useUserStore } from '@/stores/user'
import { fromNow } from '@/utils/dict'

const store = useUserStore()
const mine = ref([])
const schools = ref([])
const showSchool = ref(false)
const schoolForm = ref({ name: '', campus: '', city: '' })

onMounted(async () => {
  const d = await api.sighting.list({ mine: true, size: 20 }).catch(() => ({ list: [] }))
  mine.value = d.list || []
  schools.value = await api.school.list().catch(() => [])
})

async function createSchool() {
  if (!schoolForm.value.name) return ElMessage.warning('请填写学校名称')
  await api.school.create(schoolForm.value)
  await store.loadMe()
  ElMessage.success('创建成功')
  showSchool.value = false
  schools.value = await api.school.list()
}

async function bind(id) {
  await api.school.bind(id)
  await store.loadMe()
  ElMessage.success('已切换学校')
}
</script>

<style scoped>
.avatar {
  width: 56px; height: 56px; border-radius: 50%;
  background: var(--brand-light); color: var(--brand-dark);
  display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 700;
}
.school-item { padding: 12px; background: var(--bg); border-radius: 10px; margin-bottom: 8px; cursor: pointer; }
.school-item:hover { background: var(--brand-light); }
.feed { padding: 12px 0; border-bottom: 1px solid var(--line); }
.feed:last-child { border-bottom: none; }
</style>
