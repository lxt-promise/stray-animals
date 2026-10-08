<template>
  <div class="page">
    <div class="stat-grid">
      <div class="stat-card"><div class="num" style="color:#3ba776">¥{{ summary.income || 0 }}</div><div class="lbl">累计收入</div></div>
      <div class="stat-card"><div class="num" style="color:#e4694e">¥{{ summary.expense || 0 }}</div><div class="lbl">累计支出</div></div>
      <div class="stat-card"><div class="num">¥{{ summary.balance || 0 }}</div><div class="lbl">结余</div></div>
    </div>

    <div class="card">
      <div class="card-title">
        <span>收支明细</span>
        <el-button type="primary" size="small" @click="show = true">+ 记一笔</el-button>
      </div>
      <el-table :data="list" border stripe>
        <el-table-column prop="date" label="日期" width="120" />
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <span class="tag" :class="row.type === 'income' ? 'ok' : 'warn'">{{ row.type === 'income' ? '收入' : '支出' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="金额" width="110">
          <template #default="{ row }">
            <b :style="{ color: row.type === 'income' ? '#3ba776' : '#e4694e' }">
              {{ row.type === 'income' ? '+' : '-' }}{{ row.amount }}
            </b>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="说明" />
        <el-table-column prop="category" label="分类" width="100" />
        <el-table-column prop="operator" label="记录人" width="110" />
      </el-table>
      <div class="empty" v-if="!list.length"><span class="emoji">💰</span>暂无记录</div>
    </div>

    <el-dialog v-model="show" title="记一笔" width="480">
      <el-form :model="form" label-position="top">
        <el-form-item label="类型">
          <el-radio-group v-model="form.type">
            <el-radio value="income">收入</el-radio>
            <el-radio value="expense">支出</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-row :gutter="16">
          <el-col :span="12"><el-form-item label="金额"><el-input-number v-model="form.amount" :min="0" :precision="2" /></el-form-item></el-col>
          <el-col :span="12">
            <el-form-item label="分类">
              <el-select v-model="form.category" style="width:100%">
                <el-option label="捐赠" value="donation" /><el-option label="绝育" value="tnr" />
                <el-option label="医疗" value="medical" /><el-option label="猫粮" value="food" />
                <el-option label="其它" value="other" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="说明"><el-input v-model="form.title" /></el-form-item>
        <el-form-item label="日期"><el-input v-model="form.date" placeholder="留空为今天" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="show = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '@/api'

const list = ref([])
const summary = ref({})
const show = ref(false)
const form = ref({ type: 'expense', amount: 0, category: 'other', title: '', date: '' })

onMounted(load)
async function load() {
  list.value = await api.fund.list({}).catch(() => [])
  summary.value = await api.fund.summary({}).catch(() => ({}))
}

async function save() {
  if (!form.value.amount) return ElMessage.warning('请填写金额')
  await api.fund.add(form.value)
  ElMessage.success('已记录')
  show.value = false
  form.value = { type: 'expense', amount: 0, category: 'other', title: '', date: '' }
  load()
}
</script>
