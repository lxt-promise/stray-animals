<template>
  <div class="cat-card" @click="$router.push('/cats/' + cat.id)">
    <div class="avatar">
      <el-image v-if="cat.avatar" :src="cat.avatar" fit="cover" />
      <span v-else>🐱</span>
      <i class="dot" :style="{ background: rarityColor }"></i>
    </div>
    <div class="info">
      <div class="name-row">
        <span class="name">{{ cat.name }}</span>
        <span class="tag" :class="status.tag">{{ status.label }}</span>
      </div>
      <div class="meta small muted">
        {{ patternLabel }} · {{ sexLabel }}
        <span v-if="cat.locationName"> · {{ cat.locationName }}</span>
      </div>
      <div class="tags">
        <span class="tag" :class="ster.tag">{{ ster.label }}</span>
        <span class="tag">{{ rarityLabel }}</span>
        <span class="tag gray" v-if="cat.sightingCount">目击 {{ cat.sightingCount }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { itemOf, labelOf, PATTERN, SEX, STERILIZED, CAT_STATUS, RARITY, rarityOf } from '@/utils/dict'

const props = defineProps({ cat: { type: Object, required: true } })

const status = computed(() => itemOf(CAT_STATUS, props.cat.status))
const ster = computed(() => itemOf(STERILIZED, props.cat.sterilized))
const patternLabel = computed(() => labelOf(PATTERN, props.cat.pattern, '其它'))
const sexLabel = computed(() => labelOf(SEX, props.cat.sex, '未知'))
const rarity = computed(() => RARITY[rarityOf(props.cat.pattern)])
const rarityLabel = computed(() => rarity.value.label)
const rarityColor = computed(() => rarity.value.color)
</script>

<style scoped>
.cat-card {
  display: flex;
  gap: 14px;
  background: #fff;
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 16px;
  cursor: pointer;
  transition: transform .15s;
}
.cat-card:hover { transform: translateY(-2px); }
.avatar {
  width: 84px;
  height: 84px;
  border-radius: 14px;
  background: var(--brand-light);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 40px;
  position: relative;
  overflow: hidden;
  flex-shrink: 0;
}
.avatar :deep(.el-image) { width: 100%; height: 100%; }
.dot {
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid #fff;
}
.info { flex: 1; min-width: 0; }
.name-row { display: flex; align-items: center; gap: 8px; }
.name { font-size: 17px; font-weight: 600; }
.meta { margin: 6px 0 10px; }
.tags { display: flex; flex-wrap: wrap; }
</style>
