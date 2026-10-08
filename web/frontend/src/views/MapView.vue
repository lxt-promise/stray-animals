<template>
  <div class="page map-page">
    <div class="card map-card">
      <div class="card-title">
        <span>校园猫地图</span>
        <span class="small muted">共 {{ cats.length }} 个点位</span>
      </div>
      <div class="map-wrap">
        <div id="catmap" class="map"></div>
        <div class="side">
          <div class="side-title">点位列表</div>
          <div class="side-list">
            <div
              class="side-item"
              v-for="c in cats"
              :key="c.id"
              :class="{ on: activeId === c.id }"
              @click="focus(c)"
            >
              <div class="flex">
                <b>{{ c.name }}</b>
                <span class="tag" :class="c.sterilized === 'yes' ? 'ok' : 'warn'">
                  {{ c.sterilized === 'yes' ? '已绝育' : '未绝育' }}
                </span>
              </div>
              <div class="small muted">{{ c.locationName || '校园内' }}</div>
              <el-button link type="primary" size="small" @click.stop="$router.push('/cats/' + c.id)">查看档案 ›</el-button>
            </div>
            <div class="empty" v-if="!cats.length">
              <span class="emoji">🗺️</span>
              还没有猫点位
            </div>
          </div>
        </div>
      </div>
      <div class="small muted" style="margin-top:12px">
        标注为「仅社团可见」的幼猫/伤病猫，地图上显示的是模糊位置——这是为了防止点位被别有用心的人利用。
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { api } from '@/api'
import L from 'leaflet'

const cats = ref([])
const activeId = ref(null)
let map = null
const markers = new Map()

onMounted(async () => {
  cats.value = await api.cat.map({}).catch(() => [])
  initMap()
})

onBeforeUnmount(() => { if (map) map.remove() })

function initMap() {
  const first = cats.value[0]
  const lat = first ? first.locationLat : 39.98
  const lng = first ? first.locationLng : 116.30
  map = L.map('catmap').setView([lat, lng], 16)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap',
    maxZoom: 19
  }).addTo(map)

  cats.value.forEach(c => {
    if (c.locationLat == null) return
    const done = c.sterilized === 'yes'
    const icon = L.divIcon({
      className: '',
      html: `<div class="pin ${done ? 'done' : ''}">${done ? '✂' : '🐱'}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    })
    const m = L.marker([c.locationLat, c.locationLng], { icon })
      .addTo(map)
      .bindPopup(`<b>${c.name}</b><br/>${c.locationName || ''}<br/>${done ? '已绝育' : '未绝育'}`)
    m.on('click', () => { activeId.value = c.id })
    markers.set(c.id, m)
  })
}

function focus(c) {
  activeId.value = c.id
  if (map && c.locationLat != null) {
    map.setView([c.locationLat, c.locationLng], 18)
    const m = markers.get(c.id)
    if (m) m.openPopup()
  }
}
</script>

<style scoped>
.map-card { padding: 20px; }
.map-wrap { display: flex; gap: 16px; height: 520px; }
.map { flex: 1; border-radius: 12px; }
.side { width: 280px; display: flex; flex-direction: column; }
.side-title { font-weight: 600; margin-bottom: 10px; }
.side-list { overflow-y: auto; flex: 1; }
.side-item { padding: 10px; border-radius: 10px; cursor: pointer; margin-bottom: 6px; }
.side-item:hover { background: var(--bg); }
.side-item.on { background: var(--brand-light); }
</style>

<style>
/* Leaflet 自定义图钉（非 scoped） */
.pin {
  width: 32px; height: 32px; border-radius: 50%;
  background: #ff8a3d; color: #fff; font-size: 16px;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 10px rgba(0,0,0,.2); border: 2px solid #fff;
}
.pin.done { background: #3ba776; }
</style>
