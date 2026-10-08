<template>
  <div class="page">
    <el-tabs v-model="tab">
      <el-tab-pane label="入社申请" name="apply" />
      <el-tab-pane label="成员管理" name="member" v-if="store.isMember" />
    </el-tabs>

    <!-- 申请表单（访客） -->
    <div class="card" v-if="tab === 'apply'">
      <div class="card-title">申请加入社团</div>
      <div class="small muted" style="line-height:1.8;margin-bottom:16px">
        社团成员可以编辑猫档案、登记 TNR、发布任务、管理资金。因为会接触到猫的精确位置和医疗信息，所以需要人工审核。
      </div>
      <el-form :model="form" label-position="top">
        <el-row :gutter="16">
          <el-col :span="12"><el-form-item label="称呼"><el-input v-model="form.nickName" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="联系方式"><el-input v-model="form.contact" placeholder="微信 / 手机号" /></el-form-item></el-col>
        </el-row>
        <el-form-item label="为什么想加入"><el-input v-model="form.reason" type="textarea" :rows="3" /></el-form-item>
        <el-form-item label="相关经历"><el-input v-model="form.experience" type="textarea" :rows="2" placeholder="喂猫 / 救助 / TNR 经验（选填）" /></el-form-item>
      </el-form>
      <el-button type="primary" :loading="saving" @click="submitApply">提交申请</el-button>
      <div class="small muted" style="margin-top:12px" v-if="store.isMember">你已是社团成员，无需再申请</div>
    </div>

    <!-- 成员列表 -->
    <div class="card" v-if="tab === 'member' && store.isMember">
      <div class="card-title">成员 {{ members.length }}</div>
      <el-table :data="members" border stripe>
        <el-table-column prop="nickName" label="昵称" />
        <el-table-column label="角色" width="120">
          <template #default="{ row }">
            <span class="tag" :class="row.role === 'admin' ? 'warn' : (row.role === 'member' ? 'ok' : 'gray')">
              {{ ROLE_LABEL[row.role] }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="sightingCount" label="打卡" width="90" />
        <el-table-column prop="points" label="猫粮值" width="100" />
        <el-table-column label="操作" width="200" v-if="store.isAdmin">
          <template #default="{ row }">
            <el-button link type="primary" @click="setRole(row, 'member')">设为成员</el-button>
            <el-button link @click="setRole(row, 'visitor')">取消成员</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 待审核 -->
    <div class="card" v-if="store.isAdmin">
      <div class="card-title">待审核申请 {{ applies.length }}</div>
      <div v-for="a in applies" :key="a.id" class="apply-item">
        <div class="flex-between">
          <div>
            <b>{{ a.nickName }}</b>
            <span class="small muted"> · {{ a.contact }}</span>
          </div>
          <div>
            <el-button size="small" type="success" @click="handle(a.id, true)">通过</el-button>
            <el-button size="small" @click="handle(a.id, false)">拒绝</el-button>
          </div>
        </div>
        <div class="small" style="margin-top:8px" v-if="a.reason">{{ a.reason }}</div>
        <div class="small muted" v-if="a.experience">经历：{{ a.experience }}</div>
      </div>
      <div class="empty" v-if="!applies.length"><span class="emoji">📮</span>暂无待审核</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '@/api'
import { useUserStore } from '@/stores/user'
import { ROLE_LABEL } from '@/utils/dict'

const store = useUserStore()
const tab = ref('apply')
const members = ref([])
const applies = ref([])
const saving = ref(false)
const form = ref({ nickName: '', contact: '', reason: '', experience: '' })

onMounted(async () => {
  if (store.isMember) {
    members.value = await api.user.members({}).catch(() => [])
    tab.value = 'member'
  }
  if (store.isAdmin) applies.value = await api.user.applies({ status: 'pending' }).catch(() => [])
})

async function submitApply() {
  if (!form.value.reason.trim()) return ElMessage.warning('请说明你的动机')
  saving.value = true
  const res = await api.user.apply(form.value).catch(() => null)
  saving.value = false
  if (res) ElMessage.success(res.status === 'already' ? '你已是成员' : '已提交，等待审核')
}

async function setRole(row, role) {
  await api.user.setRole(row.id, role)
  ElMessage.success('已更新')
  members.value = await api.user.members({})
}

async function handle(id, approve) {
  await api.user.handleApply(id, approve)
  ElMessage.success(approve ? '已通过' : '已拒绝')
  applies.value = await api.user.applies({ status: 'pending' })
  members.value = await api.user.members({}).catch(() => [])
}
</script>

<style scoped>
.apply-item { padding: 14px 0; border-bottom: 1px solid var(--line); }
.apply-item:last-child { border-bottom: none; }
</style>
