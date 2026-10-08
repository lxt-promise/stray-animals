<template>
  <div class="page-narrow">
    <div class="card">
      <div class="card-title">目击打卡</div>
      <el-form :model="form" label-position="top">
        <el-form-item label="你遇见了谁">
          <el-select v-model="form.catId" placeholder="选择猫咪" clearable filterable style="width:100%">
            <el-option v-for="c in cats" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
          <div class="small muted" style="margin-top:8px">
            不选 = 这是一只尚未建档的猫，社团成员核实后会为它建立正式档案（额外 +30 猫粮值）
          </div>
        </el-form-item>

        <el-form-item label="临时名字（新猫时填写）" v-if="!form.catId">
          <el-input v-model="form.catName" placeholder="如：图书馆门口的橘猫" />
        </el-form-item>

        <el-form-item label="照片">
          <div class="upload-row">
            <div class="box" v-for="(p, i) in photos" :key="i" @click="removePhoto(i)">
              <el-image :src="p" fit="cover" />
            </div>
            <div class="box" @click="pickPhotos">
              <div class="ph"><span>+</span><small>拍照 / 选图</small></div>
            </div>
          </div>
          <div class="small muted">照片是核实身份的关键，最多 6 张</div>
        </el-form-item>

        <el-form-item label="地点">
          <el-input v-model="form.locationName" placeholder="如：教三楼北侧" style="margin-bottom:10px" />
          <div class="map-pick" ref="mapEl"></div>
          <div class="small muted" style="margin-top:8px">在地图上点击可标记目击位置</div>
        </el-form-item>

        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item label="健康观察">
              <el-select v-model="form.health" style="width:100%">
                <el-option v-for="i in HEALTH" :key="i.value" :label="i.label" :value="i.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="数量">
              <el-input-number v-model="form.count" :min="1" :max="20" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="描述">
          <el-input v-model="form.note" type="textarea" :rows="3" placeholder="它在做什么？精神状态如何？" />
        </el-form-item>
      </el-form>

      <el-button type="primary" class="block" :loading="saving" @click="submit">提交打卡</el-button>
    </div>

    <div class="card">
      <div class="card-title">我的打卡</div>
      <div v-for="s in mine" :key="s.id" class="feed">
        <div class="small">
          <b>{{ s.catName || '新猫' }}</b>
          <span class="muted"> · {{ s.locationName || '未标注' }} · {{ fromNow(s.createdAt) }}</span>
        </div>
        <div class="small muted" v-if="s.note">{{ s.note }}</div>
      </div>
      <div class="empty" v-if="!mine.length"><span class="emoji">🐾</span>还没有记录</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '@/api'
import { HEALTH, fromNow } from '@/utils/dict'
import L from 'leaflet'

const cats = ref([])
const photos = ref([])
const mine = ref([])
const saving = ref(false)
const mapEl = ref(null)
let map = null
let marker = null

const form = ref({
  catId: null, catName: '', health: 'unknown', count: 1, note: '',
  locationName: '', locationLat: null, locationLng: null
})

onMounted(async () => {
  const d = await api.cat.list({ size: 100 }).catch(() => ({ list: [] }))
  cats.value = d.list || []
  const s = await api.sighting.list({ mine: true, size: 10 }).catch(() => ({ list: [] }))
  mine.value = s.list || []
  await nextTick()
  map = L.map(mapEl.value).setView([39.98, 116.30], 16)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map)
  map.on('click', e => {
    form.value.locationLat = e.latlng.lat
    form.value.locationLng = e.latlng.lng
    if (marker) map.removeLayer(marker)
    marker = L.marker([e.latlng.lat, e.latlng.lng]).addTo(map)
  })
  tryLocate()
})

function tryLocate() {
  if (!navigator.geolocation) return
  navigator.geolocation.getCurrentPosition(p => {
    const lat = p.coords.latitude, lng = p.coords.longitude
    form.value.locationLat = lat
    form.value.locationLng = lng
    map.setView([lat, lng], 17)
    marker = L.marker([lat, lng]).addTo(map)
  }, () => {})
}

function pickFile() {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = 'image/*'; input.multiple = true
    input.onchange = () => resolve(Array.from(input.files || []))
    input.click()
  })
}

async function pickPhotos() {
  const files = await pickFile()
  if (!files.length) return
  const fd = new FormData()
  files.slice(0, 6).forEach(f => fd.append('files', f))
  const urls = await api.upload(fd)
  photos.value = photos.value.concat(urls).slice(0, 6)
}

function removePhoto(i) { photos.value.splice(i, 1) }

async function submit() {
  saving.value = true
  try {
    const res = await api.sighting.add(Object.assign({}, form.value, { photos: photos.value.join(',') }))
    ElMessage.success('打卡成功，猫粮值 +' + (res.points || 0))
    photos.value = []
    form.value.note = ''
    const s = await api.sighting.list({ mine: true, size: 10 })
    mine.value = s.list || []
  } catch (e) { /* ignore */ }
  saving.value = false
}
</script>

<style scoped>
.upload-row { display: flex; gap: 12px; flex-wrap: wrap; }
.box { width: 96px; height: 96px; border-radius: 12px; overflow: hidden; cursor: pointer; background: var(--bg);
  display: flex; align-items: center; justify-content: center; }
.box :deep(.el-image) { width: 100%; height: 100%; }
.ph { display: flex; flex-direction: column; align-items: center; color: var(--text-sub); }
.ph span { font-size: 28px; }
.map-pick { height: 240px; border-radius: 12px; overflow: hidden; }
.block { width: 100%; }
.feed { padding: 10px 0; border-bottom: 1px solid var(--line); }
.feed:last-child { border-bottom: none; }
</style>
