<template>
  <div class="page">
    <div class="card">
      <div class="card-title">社团协作工作台</div>
      <div class="small muted" v-if="!store.isMember" style="line-height:1.8">
        这里是为社团成员准备的协作区：TNR 台账、喂猫排班、资金公示、成员管理。
        因为会接触到猫的精确位置和医疗信息，需要人工审核后才能开放。
      </div>
      <el-button v-if="!store.isMember" type="primary" class="mt" @click="$router.push('/member')">申请加入社团</el-button>
    </div>

    <div class="entry-grid" v-if="store.isMember">
      <div class="entry" @click="$router.push('/tnr')">
        <div class="ico">✂️</div><div class="txt">TNR 台账</div><div class="desc">抓捕 / 绝育 / 放归</div>
      </div>
      <div class="entry" @click="$router.push('/task')">
        <div class="ico">📅</div><div class="txt">喂猫排班</div><div class="desc">发布与认领</div>
      </div>
      <div class="entry" @click="$router.push('/fund')">
        <div class="ico">💰</div><div class="txt">资金公示</div><div class="desc">收支透明</div>
      </div>
      <div class="entry" @click="$router.push('/member')">
        <div class="ico">👥</div><div class="txt">成员管理</div><div class="desc">角色与审核</div>
      </div>
      <div class="entry" @click="$router.push('/cats/new/edit')">
        <div class="ico">🐱</div><div class="txt">新建档案</div><div class="desc">录入新猫</div>
      </div>
      <div class="entry" @click="$router.push('/cats?tab=sighting')">
        <div class="ico">📷</div><div class="txt">目击审核</div><div class="desc">认领建档</div>
      </div>
    </div>

    <div class="card" v-if="store.isMember">
      <div class="card-title">待办概览</div>
      <div class="mini-grid">
        <div class="mini"><div class="num">{{ stat.taskOpen || 0 }}</div><div class="lbl">待认领任务</div></div>
        <div class="mini"><div class="num">{{ tnrSummary.total || 0 }}</div><div class="lbl">TNR 记录</div></div>
        <div class="mini"><div class="num">¥{{ fund.balance || 0 }}</div><div class="lbl">资金结余</div></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { api } from '@/api'
import { useUserStore } from '@/stores/user'

const store = useUserStore()
const stat = ref({})
const tnrSummary = ref({})
const fund = ref({})

onMounted(async () => {
  if (!store.isMember) return
  stat.value = await api.stat.overview({}).catch(() => ({}))
  tnrSummary.value = await api.tnr.summary({}).catch(() => ({}))
  fund.value = await api.fund.summary({}).catch(() => ({}))
})
</script>

<style scoped>
.entry-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; }
.entry { background: #fff; border-radius: var(--radius); box-shadow: var(--shadow); padding: 24px; text-align: center; cursor: pointer; }
.entry:hover { transform: translateY(-2px); }
.entry .ico { font-size: 32px; }
.entry .txt { font-weight: 600; margin-top: 8px; }
.entry .desc { font-size: 12px; color: var(--text-sub); margin-top: 4px; }
.mini-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.mini { background: var(--bg); border-radius: 12px; padding: 16px; text-align: center; }
.mini .num { font-size: 26px; font-weight: 700; color: var(--brand); }
.mini .lbl { font-size: 12px; color: var(--text-sub); margin-top: 4px; }
</style>
