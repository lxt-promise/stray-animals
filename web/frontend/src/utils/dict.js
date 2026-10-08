/** 与小程序的枚举保持一致：改这里就能全局生效 */
export const SEX = [
  { value: 'male', label: '公' },
  { value: 'female', label: '母' },
  { value: 'unknown', label: '未知' }
]

export const PATTERN = [
  { value: 'tabby', label: '狸花', rarity: 'common' },
  { value: 'orange', label: '橘猫', rarity: 'common' },
  { value: 'cow', label: '奶牛', rarity: 'uncommon' },
  { value: 'black', label: '纯黑', rarity: 'uncommon' },
  { value: 'white', label: '纯白', rarity: 'rare' },
  { value: 'gray', label: '灰蓝', rarity: 'uncommon' },
  { value: 'calico', label: '三花', rarity: 'epic' },
  { value: 'tortoiseshell', label: '玳瑁', rarity: 'epic' },
  { value: 'siamese', label: '暹罗', rarity: 'rare' },
  { value: 'other', label: '其它', rarity: 'common' }
]

export const STERILIZED = [
  { value: 'yes', label: '已绝育', tag: 'ok' },
  { value: 'no', label: '未绝育', tag: 'warn' },
  { value: 'unknown', label: '未知', tag: 'gray' }
]

export const CAT_STATUS = [
  { value: 'campus', label: '在校', tag: 'ok' },
  { value: 'kitten', label: '幼猫', tag: 'warn' },
  { value: 'sick', label: '伤病', tag: 'warn' },
  { value: 'foster', label: '寄养中', tag: 'info' },
  { value: 'adopted', label: '已领养', tag: 'info' },
  { value: 'missing', label: '长期未见', tag: 'gray' },
  { value: 'rainbow', label: '已去喵星', tag: 'gray' }
]

export const HEALTH = [
  { value: 'healthy', label: '健康' },
  { value: 'mild', label: '轻微异常' },
  { value: 'sick', label: '生病' },
  { value: 'injured', label: '外伤' },
  { value: 'unknown', label: '未知' }
]

export const CHARACTER = ['亲人', '高冷', '粘人', '怕生', '话痨', '能吃', '打架王', '爱晒太阳', '夜行侠', '带崽']

export const TNR_STATUS = [
  { value: 'todo', label: '待抓捕', tag: 'gray' },
  { value: 'trapping', label: '诱捕中', tag: 'warn' },
  { value: 'surgery', label: '手术/住院', tag: 'info' },
  { value: 'released', label: '已放归', tag: 'ok' },
  { value: 'adopted', label: '转领养', tag: 'ok' }
]

export const TASK_TYPE = [
  { value: 'feed', label: '喂猫' },
  { value: 'trap', label: '抓捕' },
  { value: 'medical', label: '送医' },
  { value: 'clean', label: '清洁' },
  { value: 'other', label: '其它' }
]

export const TASK_STATUS = [
  { value: 'open', label: '待认领', tag: 'warn' },
  { value: 'claimed', label: '已认领', tag: 'info' },
  { value: 'done', label: '已完成', tag: 'ok' }
]

export const RARITY = {
  common: { label: '常见', color: '#b0b0b0' },
  uncommon: { label: '少见', color: '#5bb974' },
  rare: { label: '稀有', color: '#4e8fe4' },
  epic: { label: '史诗', color: '#9b7be0' }
}

export const ROLE_LABEL = { admin: '管理员', member: '社团成员', visitor: '爱猫同学' }

export function labelOf(list, value, fallback = '未知') {
  const item = list.find(i => i.value === value)
  return item ? item.label : fallback
}

export function itemOf(list, value) {
  return list.find(i => i.value === value) || { value, label: '未知', tag: 'gray' }
}

export function rarityOf(pattern) {
  const p = PATTERN.find(i => i.value === pattern)
  return p ? p.rarity : 'common'
}

export function fromNow(t) {
  if (!t) return ''
  const d = new Date(typeof t === 'string' ? t.replace(' ', 'T') : t)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前'
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前'
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前'
  return d.toLocaleDateString('zh-CN')
}
