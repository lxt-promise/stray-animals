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

/** 把任意来源的时间值安全转成 Date（无效返回 null）。
 *  兼容：Date / 时间戳 / ISO 字符串（云开发序列化后的 "2026-10-11T01:26:00.000Z"）/
 *  本地格式 "2026-09-22 20:30" / "2026/09/22 20:30"。
 *  注意：必须先按 ISO 原样解析，不能先把 "-" 换成 "/" —— 否则 ISO 串被破坏成
 *  "2026/10/11T...Z"，解析得到 Invalid Date，页面就会显示 NaN/NaN/NaN。 */
function toDate(v) {
  if (!v) return null
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v
  if (typeof v === 'number') {
    const d = new Date(v)
    return isNaN(d.getTime()) ? null : d
  }
  if (typeof v === 'string') {
    let d = new Date(v)
    if (!isNaN(d.getTime())) return d
    d = new Date(v.replace(/-/g, '/'))
    return isNaN(d.getTime()) ? null : d
  }
  if (typeof v === 'object' && v.$date) return toDate(v.$date)
  return null
}

/** 时间格式化：2026/09/22 20:30 */
function formatTime(date) {
  const d = toDate(date)
  if (!d) return ''
  const p = n => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 相对时间：刚刚 / 5分钟前 / 3天前 */
function fromNow(date) {
  const d = toDate(date)
  if (!d) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + '分钟前'
  if (diff < 86400 * 1000) return Math.floor(diff / 3600000) + '小时前'
  if (diff < 30 * 86400 * 1000) return Math.floor(diff / 86400000) + '天前'
  return formatTime(d).split(' ')[0]
}

/** 日期：09-22 */
function shortDate(date) {
  const d = toDate(date)
  if (!d) return ''
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
  return requireRole(app, 'member')
}

/** 需要管理员及以上（社团成员不够）才继续，否则提示并跳转 */
function requireAdmin(app) {
  return requireRole(app, 'admin')
}

/**
 * 统一的身份门槛：管理员及以上（含超级管理员）可过。
 * 超级管理员在登录时已被授予 admin 角色，这里再兜一层 isSuper()，
 * 避免「超管角色写入失败」时被误拦在门外。
 */
function isAdminPlus(app) {
  return !!app && (app.isAdmin() || app.isSuper())
}

/** 通用权限门槛：app / 所需角色 / 提示文案 */
function requireRole(app, need, opts) {
  const o = opts || {}
  const isAdminNeed = need === 'admin'
  if (isAdminNeed ? isAdminPlus(app) : app.isMember()) return true
  const title = o.title || (isAdminNeed ? '需要管理员权限' : '需要社团身份')
  const content = o.content || (isAdminNeed
    ? '建档 / 改档属管理员功能。如需录入猫咪，可在「我的」中申请加入社团并联系管理员开通。'
    : '编辑猫档案、TNR 台账等属于社团协作功能。可在「我的」中申请加入社团。')
  wx.showModal({
    title,
    content,
    confirmText: '去申请',
    success: r => { if (r.confirm) wx.switchTab({ url: o.url || '/pages/mine/mine' }) }
  })
  return false
}

/** 安全加载封装：用计数器保证 wx.showLoading / wx.hideLoading 严格配对。
 *  避免「显示了却没隐藏」导致蒙层卡死、界面像“没登录”一样点不动，
 *  也避免「重复隐藏」触发微信的 `showLoading 与 hideLoading 必须配对使用` 告警。
 *  支持嵌套/连续调用：只有最后一次 hideBusy 才真正关闭 loading。 */
let _loadingCount = 0
function showBusy(title) {
  let t = '加载中'
  if (typeof title === 'string') t = title
  else if (title && title.title) t = title.title
  if (_loadingCount === 0) wx.showLoading({ title: t, mask: true })
  _loadingCount++
}
function hideBusy() {
  _loadingCount = Math.max(0, _loadingCount - 1)
  if (_loadingCount === 0) wx.hideLoading()
}

module.exports = {
  C, labelOf, itemOf, toDate, formatTime, fromNow, shortDate,
  distance, distanceText, money, rarityOf, initialOf, toast,
  requireMember, requireAdmin, requireRole, isAdminPlus,
  showBusy, hideBusy
}
