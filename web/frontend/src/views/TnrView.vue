<template>
  <div class="page">
    <div class="card">
      <div class="card-title">
        <span>TNR 台账</span>
        <span class="small muted">共 {{ summary.total || 0 }} 条 · 完成 {{ summary.done || 0 }} · 支出 ¥{{ summary.cost || 0 }}</span>
      </div>
      <div class="flex">
        <el-radio-group v-model="filter" @change="applyFilter">
          <el-radio-button label="">全部</el-radio-button>
          <el-radio-button v-for="i in TNR_STATUS" :key="i.value" :label="i.value">{{ i.label }}</el-radio-button>
        </el-radio-group>
        <el-button type="primary" size="small" @click="openForm()">+ 新建记录</el-button>
      </div>
    </div>

    <el-table :data="filtered" border stripe>
      <el-table-column prop="catName" label="猫咪" width="120" />
      <el-table-column label="状态" width="120">
        <template #default="{ row }">
          <span class="tag" :class="itemOf(TNR_STATUS, row.status).tag">{{ itemOf(TNR_STATUS, row.status).label }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="trapDate" label="抓捕" width="110" />
      <el-table-column prop="surgeryDate" label="手术" width="110" />
      <el-table-column prop="releaseDate" label="放归" width="110" />
      <el-table-column prop="hospital" label="医院" />
      <el-table-column prop="cost" label="费用" width="90" />
      <el-table-column prop="operator" label="负责人" width="110" />
      <el-table-column label="操作" width="90">
        <template #default="{ row }"><el-button link type="primary" @click="openForm(row)">编辑</el-button></template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="show" :title="form.id ? '编辑 TNR 记录' : '新建 TNR 记录'" width="560">
      <el-form :model="form" label-position="top">
        <el-form-item label="猫咪">
          <el-select v-model="form.catId" filterable clearable placeholder="选择猫咪" style="width:100%">
            <el-option v-for="c in cats" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="状态">
              <el-select v-model="form.status" style="width:100%">
                <el-option v-for="i in TNR_STATUS" :key="i.value" :label="i.label" :value="i.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="费用（元）"><el-input-number v-model="form.cost" :min="0" :precision="2" /></el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="8"><el-form-item label="抓捕日期"><el-input v-model="form.trapDate" placeholder="2026-09-22" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="手术日期"><el-input v-model="form.surgeryDate" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="放归日期"><el-input v-model="form.releaseDate" /></el-form-item></el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="12"><el-form-item label="医院"><el-input v-model="form.hospital" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="耳标"><el-input v-model="form.earMark" placeholder="左 / 右" /></el-form-item></el-col>
        </el-row>
        <el-form-item label="负责人"><el-input v-model="form.operator" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.note" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="show = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '@/api'
import { TNR_STATUS, itemOf } from '@/utils/dict'

const list = ref([])
const cats = ref([])
const summary = ref({})
const filter = ref('')
const show = ref(false)
const form = ref({})

const filtered = computed(() => filter.value ? list.value.filter(t => t.status === filter.value) : list.value)
function applyFilter() {}

onMounted(async () => {
  list.value = await api.tnr.list({}).catch(() => [])
  summary.value = await api.tnr.summary({}).catch(() => ({}))
  const d = await api.cat.list({ size: 100 }).catch(() => ({ list: [] }))
  cats.value = d.list || []
})

function openForm(row) {
  form.value = row ? Object.assign({}, row) : { status: 'todo', cost: 0, catId: null }
  show.value = true
}

async function save() {
  const f = form.value
  if (!f.catId && !f.catName) return ElMessage.warning('请选择猫咪')
  await api.tnr.save(f)
  ElMessage.success('已保存')
  show.value = false
  list.value = await api.tnr.list({})
  summary.value = await api.tnr.summary({})
}
</script>
