<template>
  <div class="page">
    <!-- 顶部：服务状态 -->
    <div class="card">
      <div class="flex-between">
        <div>
          <div class="card-title" style="margin-bottom:6px">
            识别测试台
            <span class="tag" :class="online ? 'ok' : 'warn'">
              {{ online ? '识别服务在线' : '识别服务未连接' }}
            </span>
          </div>
          <div class="small muted">
            上传一张猫的照片，调用本地识别服务，看它给出的候选与相似度。
            这是内部调试工具，<b>不属于小程序功能，也不出现在任何面向用户的界面里</b>。
          </div>
        </div>
        <div class="flex">
          <el-button size="small" @click="checkHealth" :loading="healthLoading">刷新状态</el-button>
          <el-button size="small" type="primary" @click="buildIndex" :loading="building">
            同步特征库
          </el-button>
        </div>
      </div>

      <div class="mini-grid mt" v-if="health">
        <div class="mini">
          <div class="num" :class="health.provider === 'onnx' ? 'good' : 'warn-num'">
            {{ health.provider || '—' }}
          </div>
          <div class="lbl">推理后端</div>
        </div>
        <div class="mini"><div class="num">{{ health.dim || '—' }}</div><div class="lbl">特征维度</div></div>
        <div class="mini"><div class="num">{{ health.indexed ?? 0 }}</div><div class="lbl">特征库猫数</div></div>
        <div class="mini">
          <div class="num" :class="health.ffmpeg ? 'good' : 'warn-num'">{{ health.ffmpeg ? '可用' : '缺失' }}</div>
          <div class="lbl">ffmpeg 抽帧</div>
        </div>
      </div>

      <div class="hint mt" v-if="health && health.provider !== 'onnx'">
        当前 <code>{{ health.provider }}</code> 是占位引擎（未加载真模型），识别结果只保证「同图结果一致」，不具备真实区分能力。
        把 DINOv2 权重放到 <code>server/models/reid.onnx</code> 后重启服务即可。
      </div>
      <div class="hint err mt" v-if="!online && healthError">
        {{ healthError }}
      </div>
    </div>

    <div class="two-col">
      <!-- 左：上传 -->
      <div class="card">
        <div class="card-title">1 · 选择图片</div>

        <div
          class="drop"
          :class="{ over: dragOver }"
          @click="pickFile"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="onDrop"
        >
          <template v-if="!previewUrl">
            <div class="drop-emoji">🐱</div>
            <div class="drop-main">点击选择，或把图片拖到这里</div>
            <div class="small muted">支持 JPG / PNG，单张不超过 10MB</div>
          </template>
          <img v-else :src="previewUrl" class="preview" alt="待识别图片" />
        </div>

        <input ref="fileInput" type="file" accept="image/*" style="display:none" @change="onPick" />

        <div class="flex mt" v-if="previewUrl">
          <el-button type="primary" @click="run" :loading="running" style="flex:1">
            {{ running ? '识别中…' : '开始识别' }}
          </el-button>
          <el-button @click="reset" :disabled="running">重新选择</el-button>
        </div>

        <div class="small muted mt" v-if="file">
          {{ file.name }} · {{ (file.size / 1024).toFixed(0) }} KB
        </div>
      </div>

      <!-- 右：结果 -->
      <div class="card">
        <div class="card-title">2 · 识别结果</div>

        <div class="empty" v-if="!result && !running">
          <span class="emoji">🔍</span>
          还没有结果
        </div>

        <div v-if="running" class="empty">
          <span class="emoji">⏳</span>
          正在提取特征并检索档案库…
        </div>

        <template v-if="result && !running">
          <!-- 属性标签 -->
          <div class="flex" style="flex-wrap:wrap;gap:6px">
            <span v-for="t in tags" :key="t.k" class="tag">
              {{ t.k }}：{{ t.v }}
            </span>
          </div>

          <!-- 候选列表 -->
          <div class="cands mt">
            <div class="cand" v-for="(c, i) in result.candidates" :key="c.catId">
              <div class="rank">{{ i + 1 }}</div>
              <img v-if="c.avatar" :src="c.avatar" class="cand-avatar" alt="" />
              <div v-else class="cand-avatar placeholder">🐱</div>
              <div class="cand-info">
                <div class="bold">{{ c.name || '未命名' }}</div>
                <div class="small muted">
                  {{ c.reason }}
                  <span v-if="c.rawSim"> · 原始余弦 {{ c.rawSim }}</span>
                </div>
                <el-progress
                  :percentage="c.score"
                  :stroke-width="8"
                  :color="scoreColor(c.score)"
                  :show-text="false"
                  style="margin-top:6px"
                />
              </div>
              <div class="score" :style="{ color: scoreColor(c.score) }">{{ c.score }}</div>
            </div>

            <div class="empty" v-if="!result.candidates || !result.candidates.length">
              <span class="emoji">🤔</span>
              特征库里还没有猫，先点右上角「同步特征库」
            </div>
          </div>

          <!-- 元信息 -->
          <div class="meta mt">
            <span>后端 {{ result.meta?.provider }}</span>
            <span>耗时 {{ result.meta?.latency }} ms</span>
            <span>库内 {{ result.meta?.indexed }} 只</span>
          </div>

          <div class="hint mt" v-if="topScore < 55">
            <b>识别结果不可靠。</b>
            {{ result.candidates?.length
              ? '最高分不到 55 分，说明这只猫很可能不在档案库里，或者照片里没有猫。'
              : '没有匹配到任何候选。' }}
          </div>
        </template>
      </div>
    </div>

    <!-- 说明 -->
    <div class="card">
      <div class="card-title">这个页面在验证什么</div>
      <div class="small" style="line-height:2">
        <div>· <b>上传链路</b>：图片走 <code>/api/upload</code> 落到本地磁盘，再由后端把绝对地址转给识别服务下载。</div>
        <div>· <b>为什么不直连识别服务</b>：会跨域，而且 token 会暴露在浏览器里。</div>
        <div>· <b>分数怎么算</b>：DINOv2 把图压成 768 维向量，和特征库里每只猫的代表向量算余弦相似度，再映射到 0~99。</div>
        <div>· <b>为什么分数普遍不高</b>：真实猫照片下，同一只猫约 0.96~0.99；不同猫也有 0.75~0.93，所以 70 分以下基本都是「不像」。</div>
        <div>· <b>换模型后</b>：阈值需要重新标定，跑一次 <code>server/tools/_realcat_probe.py</code>。</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '@/api'

const fileInput = ref(null)
const file = ref(null)
const previewUrl = ref('')
const dragOver = ref(false)

const health = ref(null)
const healthError = ref('')
const healthLoading = ref(false)
const building = ref(false)

const running = ref(false)
const result = ref(null)

const online = computed(() => !!health.value && !healthError.value)
const tags = computed(() => result.value?.features?.tags || [])
const topScore = computed(() => result.value?.candidates?.[0]?.score ?? 100)

function scoreColor(s) {
  if (s >= 80) return '#3ba776'
  if (s >= 55) return '#ff8a3d'
  return '#c9c9c9'
}

async function checkHealth() {
  healthLoading.value = true
  healthError.value = ''
  try {
    health.value = await api.vision.health()
  } catch (e) {
    health.value = null
    healthError.value = e.message || '识别服务未启动。请在 server 目录执行：..\\env\\Scripts\\python -m uvicorn app.main:app --host 127.0.0.1 --port 8090'
  } finally {
    healthLoading.value = false
  }
}

async function buildIndex() {
  building.value = true
  try {
    const r = await api.vision.buildIndex()
    ElMessage.success(`特征库已同步：${r.built ?? 0} 只成功，共 ${r.sent ?? 0} 只`)
    await checkHealth()
  } catch (e) {
    ElMessage.error(e.message || '同步失败')
  } finally {
    building.value = false
  }
}

function pickFile() {
  fileInput.value?.click()
}

function onPick(e) {
  const f = e.target.files?.[0]
  if (f) accept(f)
}

function onDrop(e) {
  dragOver.value = false
  const f = e.dataTransfer.files?.[0]
  if (f) accept(f)
}

function accept(f) {
  if (!f.type.startsWith('image/')) return ElMessage.warning('请选择图片文件')
  if (f.size > 10 * 1024 * 1024) return ElMessage.warning('图片不能超过 10MB')
  file.value = f
  previewUrl.value = URL.createObjectURL(f)
  result.value = null
}

function reset() {
  file.value = null
  previewUrl.value = ''
  result.value = null
}

async function run() {
  if (!file.value) return
  running.value = true
  result.value = null
  try {
    // 1) 上传拿到可访问地址
    const fd = new FormData()
    fd.append('files', file.value)
    const urls = await api.upload(fd)
    const path = Array.isArray(urls) ? urls[0] : urls
    if (!path) throw new Error('上传失败')

    // 2) 交给后端代理识别
    const abs = new URL(path, window.location.origin).href
    result.value = await api.vision.recognize(abs)
  } catch (e) {
    ElMessage.error(e.message || '识别失败')
  } finally {
    running.value = false
  }
}

onMounted(checkHealth)
</script>

<style scoped>
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}
@media (max-width: 860px) {
  .two-col { grid-template-columns: 1fr; }
}

.drop {
  border: 2px dashed var(--line);
  border-radius: var(--radius);
  background: var(--bg);
  min-height: 260px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  cursor: pointer;
  transition: all .2s;
  overflow: hidden;
}
.drop:hover, .drop.over { border-color: var(--brand); background: var(--brand-light); }
.drop-emoji { font-size: 44px; }
.drop-main { font-weight: 600; }
.preview { max-width: 100%; max-height: 380px; object-fit: contain; display: block; }

.mini-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.mini { background: var(--bg); border-radius: 12px; padding: 14px; text-align: center; }
.mini .num { font-size: 22px; font-weight: 700; color: var(--brand); }
.mini .num.good { color: var(--ok); }
.mini .num.warn-num { color: var(--warn); }
.mini .lbl { font-size: 12px; color: var(--text-sub); margin-top: 4px; }

.hint {
  background: var(--brand-light);
  border-radius: 12px;
  padding: 12px 16px;
  font-size: 13px;
  line-height: 1.8;
}
.hint.err { background: #fdeae6; color: var(--warn); }
.hint code, .small code {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 12px;
}

.cands { display: flex; flex-direction: column; gap: 10px; }
.cand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 12px;
  background: var(--bg);
}
.rank {
  width: 22px; height: 22px; flex: none;
  border-radius: 50%;
  background: var(--brand); color: #fff;
  font-size: 12px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
}
.cand-avatar { width: 44px; height: 44px; border-radius: 10px; object-fit: cover; flex: none; }
.cand-avatar.placeholder {
  display: flex; align-items: center; justify-content: center;
  background: #fff; font-size: 20px;
}
.cand-info { flex: 1; min-width: 0; }
.score { font-size: 20px; font-weight: 700; flex: none; }

.meta {
  display: flex; gap: 16px;
  font-size: 12px; color: var(--text-sub);
}
</style>
