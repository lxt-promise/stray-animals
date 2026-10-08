<template>
  <div class="page">
    <!-- 顶部：当前特征库规模 + 状态 -->
    <div class="card">
      <div class="flex-between">
        <div>
          <div class="card-title" style="margin-bottom:6px">
            猫档案手动录入
            <span class="tag" :class="ready ? 'ok' : 'warn'">{{ ready ? '识别服务在线' : '识别服务未连接' }}</span>
          </div>
          <div class="small muted">
            填信息 + 传照片，提交后这只猫会写进档案库，并同步进<b>特征库</b>（之后上传它的照片就能被识别出来）。
            这是内部工具，<b>不面向普通用户</b>。
          </div>
        </div>
        <div class="mini">
          <div class="num">{{ health?.indexed ?? '—' }}</div>
          <div class="lbl">特征库当前猫数</div>
        </div>
      </div>

      <div class="hint err mt" v-if="ready && health?.provider !== 'onnx'">
        当前识别服务用的是占位引擎（未加载真模型），录入后的猫能被检索到，但相似度区分不可靠。
        把 DINOv2 权重放到 <code>server/models/reid.onnx</code> 后重启识别服务即可。
      </div>
    </div>

    <div class="two-col">
      <!-- 左：表单 -->
      <div class="card">
        <div class="card-title">1 · 填写信息</div>
        <el-form :model="form" label-position="top">
          <el-row :gutter="16">
            <el-col :span="12">
              <el-form-item label="名字 *">
                <el-input v-model="form.name" placeholder="校园里大家怎么叫它" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="别名">
                <el-input v-model="form.alias" placeholder="其它称呼" />
              </el-form-item>
            </el-col>
          </el-row>

          <el-row :gutter="16">
            <el-col :span="8">
              <el-form-item label="性别">
                <el-select v-model="form.sex" style="width:100%">
                  <el-option v-for="i in SEX" :key="i.value" :label="i.label" :value="i.value" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="花色">
                <el-select v-model="form.pattern" style="width:100%">
                  <el-option v-for="i in PATTERN" :key="i.value" :label="i.label" :value="i.value" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="绝育">
                <el-select v-model="form.sterilized" style="width:100%">
                  <el-option v-for="i in STERILIZED" :key="i.value" :label="i.label" :value="i.value" />
                </el-select>
              </el-form-item>
            </el-col>
          </el-row>

          <el-row :gutter="16">
            <el-col :span="8">
              <el-form-item label="状态">
                <el-select v-model="form.status" style="width:100%">
                  <el-option v-for="i in CAT_STATUS" :key="i.value" :label="i.label" :value="i.value" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="健康">
                <el-select v-model="form.health" style="width:100%">
                  <el-option v-for="i in HEALTH" :key="i.value" :label="i.label" :value="i.value" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="耳标">
                <el-input v-model="form.earMark" placeholder="如：左耳" />
              </el-form-item>
            </el-col>
          </el-row>

          <el-form-item label="花色补充">
            <el-input v-model="form.colorNote" placeholder="如：白手套、左耳缺口" />
          </el-form-item>

          <el-form-item label="性格标签">
            <el-checkbox-group v-model="characters">
              <el-checkbox v-for="c in CHARACTER" :key="c" :label="c" :value="c" />
            </el-checkbox-group>
          </el-form-item>

          <el-row :gutter="16">
            <el-col :span="12">
              <el-form-item label="常驻点位名称">
                <el-input v-model="form.locationName" placeholder="如：三食堂后门花坛" />
              </el-form-item>
            </el-col>
            <el-col :span="5">
              <el-form-item label="纬度">
                <el-input v-model="form.locationLat" placeholder="可选" />
              </el-form-item>
            </el-col>
            <el-col :span="5">
              <el-form-item label="经度">
                <el-input v-model="form.locationLng" placeholder="可选" />
              </el-form-item>
            </el-col>
          </el-row>

          <el-form-item>
            <el-checkbox v-model="form.spotPrivate">点位仅社团可见</el-checkbox>
          </el-form-item>

          <el-form-item label="公开简介">
            <el-input v-model="form.note" type="textarea" :rows="2" placeholder="性格、喜好…" />
          </el-form-item>
          <el-form-item label="内部备注（仅社团可见）">
            <el-input v-model="form.internalNote" type="textarea" :rows="2" placeholder="诱捕要点、投喂情况…" />
          </el-form-item>
          <el-form-item label="医疗备注（仅社团可见）">
            <el-input v-model="form.medicalNote" type="textarea" :rows="2" placeholder="病史、用药、疫苗…" />
          </el-form-item>
        </el-form>
      </div>

      <!-- 右：照片 + 提交 -->
      <div class="card">
        <div class="card-title">2 · 上传照片</div>
        <div
          class="drop"
          :class="{ over: dragOver }"
          @click="pickPhotos"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="onDrop"
        >
          <template v-if="!files.length">
            <div class="drop-emoji">🐱</div>
            <div class="drop-main">点击选择，或把照片拖到这里</div>
            <div class="small muted">支持多张 JPG / PNG，单张 ≤ 10MB，最多 6 张</div>
          </template>
          <div v-else class="thumbs">
            <div class="thumb" v-for="(f, i) in files" :key="i">
              <img :src="f.url" alt="" />
              <span class="x" @click.stop="remove(i)">×</span>
            </div>
          </div>
        </div>

        <input ref="fileInput" type="file" accept="image/*" multiple style="display:none" @change="onPick" />

        <div class="small muted mt" v-if="files.length">已选 {{ files.length }} 张</div>

        <div class="actions mt">
          <el-button :disabled="submitting" @click="reset">清空</el-button>
          <el-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">
            {{ submitting ? '录入中…' : '保存并同步特征库' }}
          </el-button>
        </div>

        <!-- 结果 -->
        <div class="result mt" v-if="result">
          <div class="ok-banner">
            ✅ 已录入：<b>{{ result.cat?.name }}</b>
            <span class="small">（档案 ID {{ result.cat?.id }} · 照片 {{ result.photos?.length || 0 }} 张）</span>
          </div>

          <div v-if="result.build" class="build">
            <div>特征库同步：建成 <b>{{ result.build.built ?? 0 }}</b> 只 / 共发送 <b>{{ result.build.sent ?? 0 }}</b> 只</div>
            <div class="small muted" v-if="result.build.note">{{ result.build.note }}</div>
            <div class="small muted" v-if="result.build.failed && result.build.failed.length">
              未成功：{{ result.build.failed.join(', ') }}（照片可能无法被识别服务下载）
            </div>
          </div>
          <div class="build err" v-if="result.buildError">特征库同步失败：{{ result.buildError }}</div>

          <div class="flex mt" style="gap:10px">
            <el-button size="small" @click="goVision">去识别测试台验证</el-button>
            <el-button size="small" type="primary" plain @click="another">再录一只</el-button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">说明</div>
      <div class="small" style="line-height:2">
        <div>· 录入 = 写档案库（MySQL）+ 重建特征库（识别服务本地向量库）。</div>
        <div>· 想让这只猫被识别出来，<b>照片必须至少 1 张且能被识别服务下载</b>（本地走后端 8080 的 /uploads）。</div>
        <div>· 特征库以档案库为准：每次录入都会整体重建，所以删/改猫之后直接再录一次或点顶部「同步」即可保持一致。</div>
        <div>· 当前特征库里若还有早期标定用的测试猫，录入一次后会被整体重建清掉，只剩你录入的猫。</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '@/api'
import { SEX, PATTERN, STERILIZED, CAT_STATUS, HEALTH, CHARACTER } from '@/utils/dict'

const router = useRouter()

const health = ref(null)
const ready = ref(false)
const dragOver = ref(false)
const fileInput = ref(null)
const files = ref([])          // [{file, url}]
const characters = ref([])
const submitting = ref(false)
const result = ref(null)

const form = reactive({
  name: '', alias: '', sex: 'unknown', pattern: 'other', colorNote: '',
  sterilized: 'unknown', earMark: '', status: 'campus', health: 'unknown',
  locationName: '', locationLat: '', locationLng: '', spotPrivate: false,
  note: '', internalNote: '', medicalNote: ''
})

const canSubmit = computed(() => form.name.trim().length > 0)

onMounted(refreshHealth)

async function refreshHealth() {
  try {
    health.value = await api.vision.health()
    ready.value = true
  } catch (e) {
    health.value = null
    ready.value = false
  }
}

function pickPhotos() { fileInput.value?.click() }
function onPick(e) {
  const list = Array.from(e.target.files || [])
  addFiles(list)
  e.target.value = ''
}
function onDrop(e) {
  dragOver.value = false
  addFiles(Array.from(e.dataTransfer.files || []))
}
function addFiles(list) {
  for (const f of list) {
    if (!f.type.startsWith('image/')) { ElMessage.warning('仅支持图片：' + f.name); continue }
    if (f.size > 10 * 1024 * 1024) { ElMessage.warning('超过 10MB：' + f.name); continue }
    if (files.value.length >= 6) { ElMessage.warning('最多 6 张'); break }
    files.value.push({ file: f, url: URL.createObjectURL(f) })
  }
}
function remove(i) {
  const f = files.value[i]
  if (f) URL.revokeObjectURL(f.url)
  files.value.splice(i, 1)
}
function reset() {
  files.value.forEach(f => URL.revokeObjectURL(f.url))
  files.value = []
  characters.value = []
  result.value = null
}

function toNum(v) {
  if (v === '' || v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function submit() {
  if (!form.name.trim()) return ElMessage.warning('请填写名字')
  if (!files.value.length) return ElMessage.warning('至少上传 1 张照片，否则无法进特征库')
  submitting.value = true
  result.value = null
  try {
    const fd = new FormData()
    files.value.forEach(f => fd.append('photos', f.file))
    fd.append('name', form.name)
    fd.append('alias', form.alias)
    fd.append('sex', form.sex)
    fd.append('pattern', form.pattern)
    fd.append('colorNote', form.colorNote)
    fd.append('sterilized', form.sterilized)
    fd.append('earMark', form.earMark)
    fd.append('status', form.status)
    fd.append('health', form.health)
    fd.append('characters', characters.value.join(','))
    fd.append('locationName', form.locationName)
    const lat = toNum(form.locationLat), lng = toNum(form.locationLng)
    if (lat != null) fd.append('locationLat', String(lat))
    if (lng != null) fd.append('locationLng', String(lng))
    fd.append('spotPrivate', form.spotPrivate ? 'true' : 'false')
    fd.append('note', form.note)
    fd.append('internalNote', form.internalNote)
    fd.append('medicalNote', form.medicalNote)

    result.value = await api.catEntry(fd)
    ElMessage.success('录入成功，特征库已同步')
    await refreshHealth()
  } catch (e) {
    ElMessage.error(e.message || '录入失败')
  } finally {
    submitting.value = false
  }
}

function goVision() { router.push('/vision') }
function another() { reset() }
</script>

<style scoped>
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
@media (max-width: 980px) { .two-col { grid-template-columns: 1fr; } }

.flex-between { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.mini { background: var(--bg); border-radius: 12px; padding: 12px 18px; text-align: center; min-width: 120px; }
.mini .num { font-size: 26px; font-weight: 700; color: var(--brand); }
.mini .lbl { font-size: 12px; color: var(--text-sub); margin-top: 4px; }

.drop {
  border: 2px dashed var(--line); border-radius: var(--radius); background: var(--bg);
  min-height: 200px; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 8px; cursor: pointer; transition: all .2s; padding: 14px;
}
.drop:hover, .drop.over { border-color: var(--brand); background: var(--brand-light); }
.drop-emoji { font-size: 40px; }
.drop-main { font-weight: 600; }
.thumbs { display: flex; flex-wrap: wrap; gap: 10px; }
.thumb { position: relative; width: 84px; height: 84px; border-radius: 10px; overflow: hidden; }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb .x {
  position: absolute; top: 2px; right: 2px; width: 20px; height: 20px; border-radius: 50%;
  background: rgba(0,0,0,.6); color: #fff; display: flex; align-items: center; justify-content: center;
  cursor: pointer; font-size: 14px;
}

.actions { display: flex; justify-content: flex-end; gap: 12px; }
.result .ok-banner { background: #eafaf0; border: 1px solid #b7e6c8; color: #1f7a45; border-radius: 12px; padding: 12px 14px; }
.result .build { background: var(--bg); border-radius: 12px; padding: 12px 14px; margin-top: 10px; line-height: 1.9; }
.result .build.err { background: #fdeae6; color: var(--warn); }

.hint.err { background: #fdeae6; color: var(--warn); }
.hint code { background: #fff; border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; font-size: 12px; }
</style>
