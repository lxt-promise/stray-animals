<template>
  <div class="page">
    <div class="card">
      <div class="card-title">
        <span>喂猫排班</span>
        <el-button v-if="store.isMember" type="primary" size="small" @click="show = true">+ 发布任务</el-button>
      </div>
      <el-radio-group v-model="filter">
        <el-radio-button label="open">待认领</el-radio-button>
        <el-radio-button label="claimed">已认领</el-radio-button>
        <el-radio-button label="done">已完成</el-radio-button>
        <el-radio-button label="">全部</el-radio-button>
      </el-radio-group>
    </div>

    <div class="card" v-for="t in filtered" :key="t.id">
      <div class="flex-between">
        <div>
          <b>{{ t.title }}</b>
          <div class="small muted" style="margin-top:6px">
            {{ labelOf(TASK_TYPE, t.type) }} · {{ t.date || '未定日期' }}<span v-if="t.spot"> · {{ t.spot }}</span>
          </div>
          <div class="small" style="margin-top:8px" v-if="t.note">{{ t.note }}</div>
        </div>
        <div class="right">
          <span class="tag" :class="itemOf(TASK_STATUS, t.status).tag">{{ itemOf(TASK_STATUS, t.status).label }}</span>
          <div class="small muted" v-if="t.assigneeName" style="margin-top:8px">{{ t.assigneeName }}</div>
          <div class="acts" v-if="store.isMember">
            <el-button size="small" v-if="t.status === 'open'" @click="claim(t, false)">认领</el-button>
            <el-button size="small" v-if="t.status === 'claimed'" type="success" @click="done(t)">完成</el-button>
            <el-button size="small" v-if="t.status === 'claimed'" @click="claim(t, true)">取消</el-button>
          </div>
        </div>
      </div>
    </div>

    <div class="empty" v-if="!filtered.length"><span class="emoji">📅</span>暂无任务</div>

    <el-dialog v-model="show" title="发布任务" width="520">
      <el-form :model="form" label-position="top">
        <el-form-item label="标题"><el-input v-model="form.title" placeholder="如：周三晚喂三食堂点位" /></el-form-item>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="类型">
              <el-select v-model="form.type" style="width:100%">
                <el-option v-for="i in TASK_TYPE" :key="i.value" :label="i.label" :value="i.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12"><el-form-item label="日期"><el-input v-model="form.date" placeholder="2026-09-22" /></el-form-item></el-col>
        </el-row>
        <el-form-item label="点位"><el-input v-model="form.spot" /></el-form-item>
        <el-form-item label="联系方式（仅成员可见）"><el-input v-model="form.contact" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.note" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="show = false">取消</el-button>
        <el-button type="primary" @click="save">发布</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '@/api'
import { useUserStore } from '@/stores/user'
import { TASK_TYPE, TASK_STATUS, labelOf, itemOf } from '@/utils/dict'

const store = useUserStore()
const list = ref([])
const filter = ref('open')
const show = ref(false)
const form = ref({ title: '', type: 'feed', date: '', spot: '', note: '', contact: '' })

const filtered = computed(() => filter.value ? list.value.filter(t => t.status === filter.value) : list.value)

onMounted(load)
async function load() { list.value = await api.task.list({}).catch(() => []) }

async function save() {
  if (!form.value.title.trim()) return ElMessage.warning('请填写标题')
  await api.task.save(Object.assign({}, form.value, { status: 'open' }))
  ElMessage.success('已发布')
  show.value = false
  form.value = { title: '', type: 'feed', date: '', spot: '', note: '', contact: '' }
  load()
}

async function claim(t, cancel) {
  await api.task.claim(t.id, cancel)
  load()
}

async function done(t) {
  await api.task.save(Object.assign({}, t, { status: 'done' }))
  load()
}
</script>

<style scoped>
.right { text-align: right; }
.acts { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; }
</style>
