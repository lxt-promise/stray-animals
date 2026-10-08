<template>
  <div class="page-narrow" v-if="ready">
    <div class="card">
      <div class="card-title">{{ isNew ? '新建猫档案' : '编辑猫档案' }}</div>

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
            <el-form-item label="绝育状态">
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

        <el-form-item label="常驻点位">
          <el-input v-model="form.locationName" placeholder="如：三食堂后门花坛" style="margin-bottom:10px" />
          <div class="map-pick" ref="mapEl"></div>
          <div class="small muted" style="margin-top:8px">在地图上点击可设置点位坐标</div>
        </el-form-item>

        <el-form-item>
          <el-checkbox v-model="form.spotPrivate">点位仅社团可见</el-checkbox>
          <div class="small muted" style="margin-top:6px">
            幼猫、伤病猫的精确位置建议开启——公开点位曾被虐猫者利用过。
          </div>
        </el-form-item>

        <el-form-item label="照片">
          <div class="upload-row">
            <div class="box" @click="pickAvatar">
              <el-image v-if="form.avatar" :src="form.avatar" fit="cover" />
              <div v-else class="ph"><span>+</span><small>头像</small></div>
            </div>
            <div class="box" v-for="(p, i) in photoList" :key="i" @click="removePhoto(i)">
              <el-image :src="p" fit="cover" />
            </div>
            <div class="box" @click="pickPhotos">
              <div class="ph"><span>+</span><small>相册</small></div>
            </div>
          </div>
          <div class="small muted">点击已上传的图片可移除；最多 6 张</div>
        </el-form-item>

        <el-form-item label="公开简介">
          <el-input v-model="form.note" type="textarea" :rows="3" placeholder="性格、喜好、与其它猫的关系…" />
        </el-form-item>
        <el-form-item label="内部备注（仅社团可见）">
          <el-input v-model="form.internalNote" type="textarea" :rows="2" placeholder="诱捕要点、投喂情况…" />
        </el-form-item>
        <el-form-item label="医疗备注（仅社团可见）">
          <el-input v-model="form.medicalNote" type="textarea" :rows="2" placeholder="病史、用药、疫苗…" />
        </el-form-item>
      </el-form>

      <div class="actions">
        <el-button @click="$router.back()">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存档案</el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api } from '@/api'
import { SEX, PATTERN, STERILIZED, CAT_STATUS, HEALTH, CHARACTER } from '@/utils/dict'
import L from 'leaflet'

const route = useRoute()
const router = useRouter()
const ready = ref(false)
const saving = ref(false)
const isNew = computed(() => !route.params.id || route.params.id === 'new')
const mapEl = ref(null)
let map = null
let marker = null

const form = ref({
  id: null,
  name: '',
  alias: '',
  sex: 'unknown',
  pattern: 'other',
  colorNote: '',
  sterilized: 'unknown',
  earMark: '',
  status: 'campus',
  health: 'unknown',
  locationName: '',
  locationLat: null,
  locationLng: null,
  spotPrivate: false,
  avatar: '',
  photos: '',
  note: '',
  internalNote: '',
  medicalNote: ''
})
const characters = ref([])
const photoList = computed(() => (form.value.photos ? form.value.photos.split(',').filter(Boolean) : []))

onMounted(async () => {
  if (!isNew.value) {
    const data = await api.cat.detail(route.params.id)
    const c = data.cat
    form.value = Object.assign(form.value, {
      id: c.id, name: c.name, alias: c.alias, sex: c.sex, pattern: c.pattern,
      colorNote: c.colorNote, sterilized: c.sterilized, earMark: c.earMark,
      status: c.status, health: c.health, locationName: c.locationName,
      locationLat: c.locationLat, locationLng: c.locationLng,
      spotPrivate: !!c.spotPrivate, avatar: c.avatar, photos: c.photos || '',
      note: c.note, internalNote: c.internalNote, medicalNote: c.medicalNote
    })
    characters.value = c.characterList || []
  }
  ready.value = true
  await nextTick()
  initMap()
})

function initMap() {
  const lat = form.value.locationLat || 39.98
  const lng = form.value.locationLng || 116.30
  map = L.map(mapEl.value).setView([lat, lng], 16)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19
  }).addTo(map)
  if (form.value.locationLat) {
    marker = L.marker([lat, lng]).addTo(map)
  }
  map.on('click', e => {
    form.value.locationLat = e.latlng.lat
    form.value.locationLng = e.latlng.lng
    if (marker) map.removeLayer(marker)
    marker = L.marker([e.latlng.lat, e.latlng.lng]).addTo(map)
  })
}

async function uploadFiles(files) {
  const fd = new FormData()
  files.forEach(f => fd.append('files', f))
  return await api.upload(fd)
}

function pickFile(multiple) {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = multiple
    input.onchange = () => resolve(Array.from(input.files || []))
    input.click()
  })
}

async function pickAvatar() {
  const files = await pickFile(false)
  if (!files.length) return
  const urls = await uploadFiles(files)
  form.value.avatar = urls[0]
}

async function pickPhotos() {
  const files = await pickFile(true)
  if (!files.length) return
  const urls = await uploadFiles(files.slice(0, 6))
  const cur = photoList.value.concat(urls).slice(0, 6)
  form.value.photos = cur.join(',')
}

function removePhoto(i) {
  const cur = photoList.value.slice()
  cur.splice(i, 1)
  form.value.photos = cur.join(',')
}

async function save() {
  if (!form.value.name.trim()) return ElMessage.warning('请填写名字')
  saving.value = true
  try {
    const payload = Object.assign({}, form.value, { characters: characters.value.join(',') })
    if (!isNew.value) payload.id = Number(route.params.id)
    const saved = await api.cat.save(payload)
    ElMessage.success('已保存')
    router.push('/cats/' + saved.id)
  } catch (e) { /* ignore */ }
  saving.value = false
}
</script>

<style scoped>
.map-pick { height: 240px; border-radius: 12px; overflow: hidden; }
.upload-row { display: flex; gap: 12px; flex-wrap: wrap; }
.box {
  width: 96px; height: 96px; border-radius: 12px; overflow: hidden; cursor: pointer;
  background: var(--bg); display: flex; align-items: center; justify-content: center;
}
.box :deep(.el-image) { width: 100%; height: 100%; }
.ph { display: flex; flex-direction: column; align-items: center; color: var(--text-sub); }
.ph span { font-size: 28px; }
.actions { display: flex; justify-content: flex-end; gap: 12px; }
</style>
