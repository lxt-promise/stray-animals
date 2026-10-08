const C = require('./const.js')

/** 取枚举的 label */
function labelOf(list, value) {
  const hit = list.filter(i => i.value === value)[0]
  return hit ? hit.label : '未知'
}
/** 取枚举的完整项 */
function itemOf(list, value) {
  return list.filter(i => i.value === value)[0] || { label: '未知', tag: 'gray' }
}

/** 时间格式化：2026/09/22 20:30 */
function formatTime(date) {
  if (!date) return ''
  const d = date instanceof Date ? date : new Date(typeof date === 'number' ? date : date.replace(/-/g, '/'))
  const p = n => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 相对时间：刚刚 / 5分钟前 / 3天前 */
function fromNow(date) {
  if (!date) return ''
  const t = date instanceof Date ? date.getTime() : new Date(typeof date === 'number' ? date : date.replace(/-/g, '/')).getTime()
  const diff = Date.now() - t
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + '分钟前'
  if (diff < 86400 * 1000) return Math.floor(diff / 3600000) + '小时前'
  if (diff < 30 * 86400 * 1000) return Math.floor(diff / 86400000) + '天前'
  return formatTime(date).split(' ')[0]
}

/** 日期：09-22 */
function shortDate(date) {
  if (!date) return ''
  const d = date instanceof Date ? date : new Date(typeof date === 'number' ? date : date.replace(/-/g, '/'))
  const p = n => (n < 10 ? '0' + n : '' + n)
  return p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/** 两点间距离（米），Haversine */
function distance(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => typeof v !== 'number' || isNaN(v))) return null
  const R = 6371000
  const rad = d => d * Math.PI / 180
  const dLat = rad(lat2 - lat1)
  const dLng = rad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(a)))
}

function distanceText(m) {
  if (m === null) return ''
  if (m < 1000) return m + 'm'
  return (m / 1000).toFixed(1) + 'km'
}

/** 金额：12.50 */
function money(n) {
  const v = Number(n) || 0
  return v.toFixed(2)
}

/** 毛色 → 稀有度（游戏化：三花/玳瑁/纯白更稀有） */
function rarityOf(pattern) {
  const map = {
    orange: 'common', tabby: 'common', cow: 'uncommon', tuxedo: 'uncommon',
    black: 'uncommon', gray: 'uncommon', siamese: 'rare',
    calico: 'epic', tortoiseshell: 'epic', white: 'rare', other: 'common'
  }
  return map[pattern] || 'common'
}

/** 生成猫的默认头像占位（按名字首字） */
function initialOf(name) {
  return (name || '?').trim().slice(0, 1)
}

function toast(title, icon) {
  wx.showToast({ title: String(title).slice(0, 20), icon: icon || 'none', duration: 1800 })
}

/** 需要社团权限才继续，否则提示并跳转 */
function requireMember(app) {
  if (app.isMember()) return true
  wx.showModal({
    title: '需要社团身份',
    content: '编辑猫档案、TNR 台账等属于社团协作功能。可在「我的」中申请加入社团。',
    confirmText: '去申请',
    success: r => { if (r.confirm) wx.switchTab({ url: '/pages/mine/mine' }) }
  })
  return false
}

module.exports = {
  C, labelOf, itemOf, formatTime, fromNow, shortDate,
  distance, distanceText, money, rarityOf, initialOf, toast, requireMember
}
