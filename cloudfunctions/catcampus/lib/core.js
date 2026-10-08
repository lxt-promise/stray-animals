/**
 * 核心层 —— 所有业务模块的单一依赖源
 *
 * 职责边界（对应技术难点 2「数据隔离与安全」）：
 *  1. 数据库句柄与集合常量
 *  2. 三级角色鉴权（visitor / member / admin）
 *  3. schoolId 多校隔离：解析 + 归属校验
 *  4. 坐标模糊化与字段脱敏（服务端统一处理，绝不交给客户端）
 *  5. 通用工具（分页、距离、日期）
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

/** 集合名集中管理，新增集合只改这里 */
const COL = {
  user: 'users',
  school: 'schools',
  cat: 'cats',
  sighting: 'sightings',
  tnr: 'tnr_records',
  task: 'tasks',
  fund: 'funds',
  apply: 'applies',
  aiTask: 'ai_tasks',   // AI 识别异步任务（难点 1：短视频异步化）
  aiSample: 'ai_samples', // 用户确认的识别样本（人机协同闭环，为后续训练攒数据）
  vpayOrder: 'vpay_orders',       // 虚拟支付订单（待支付/已支付/已发货/已退款）
  vpayNotify: 'vpay_notifies',    // 微信推送原始事件（发货/退款/投诉等，审计用）
  vpayDelivery: 'vpay_deliveries' // 发货意图（业务侧消费：发放权益后标记 delivered）
}

/** 角色等级：用于 requireRole 的比较 */
const ROLE_LEVEL = { visitor: 0, member: 1, admin: 2 }

/* ==================== 权限 ==================== */

function roleOf(user) {
  return (user && user.role) || 'visitor'
}
function isMember(user) {
  const r = roleOf(user)
  return r === 'member' || r === 'admin'
}
function isAdmin(user) {
  return roleOf(user) === 'admin'
}

/**
 * 统一鉴权入口：每个 action 开头调一次
 * @param {Object} user 用户档案（未登录为 null）
 * @param {'public'|'user'|'member'|'admin'} minRole
 */
function requireRole(user, minRole) {
  if (!minRole || minRole === 'public') return user
  if (!user) throw new AppError('请先登录', 401)
  if (minRole === 'user') return user
  const need = ROLE_LEVEL[minRole] || 0
  if ((ROLE_LEVEL[roleOf(user)] || 0) < need) {
    const label = { member: '社团成员', admin: '管理员' }[minRole] || minRole
    throw new AppError('需要' + label + '权限', 403)
  }
  return user
}

/** 业务异常：带 HTTP 语义码，便于前端区分处理 */
class AppError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'AppError'
    this.code = code || 400
  }
}

/* ==================== 多校隔离 ==================== */

/**
 * 解析本次请求作用的 schoolId。
 * 优先级：显式传参 > 用户所属学校。两者都没有时返回 ''（表示跨校/未绑定）。
 */
function resolveSchoolId(user, event) {
  return (event && event.schoolId) || (user && user.schoolId) || ''
}

/**
 * 校验用户是否属于该校（防止传参越权访问别的学校数据）。
 * 用户未绑定学校时放行——此时只能看公开数据，由各查询自行加 schoolId 过滤。
 */
function assertSchool(user, schoolId) {
  if (!schoolId) return true
  if (!user || !user.schoolId) return true
  if (user.schoolId !== schoolId) throw new AppError('不可访问其他学校的数据', 403)
  return true
}

/** 生成带 schoolId 的查询条件，所有列表查询统一走这里 */
function scopeWhere(user, event, extra) {
  const where = Object.assign({}, extra || {})
  const schoolId = resolveSchoolId(user, event)
  if (schoolId) where.schoolId = schoolId
  return where
}

/* ==================== 坐标模糊化 & 脱敏 ==================== */

/**
 * 坐标模糊化：约 ±120m 随机偏移。
 * 偏移由坐标本身取种子 —— 同一坐标每次结果一致（可被缓存），但无法反推真实位置。
 * 吸取街猫「直播暴露猫位置被虐猫者利用」的教训，幼猫/病猫/私密点位必须走这里。
 */
function blurLocation(loc, radiusM) {
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return loc
  const r = radiusM || 120
  const seed = Math.sin(loc.lat * 1237.13 + loc.lng * 917.71)
  const seed2 = Math.cos(loc.lat * 531.77 + loc.lng * 1481.31)
  const dLat = (r / 111320)
  const dLng = (r / (111320 * Math.cos((loc.lat * Math.PI) / 180)))
  return {
    lat: loc.lat + (frac(seed) - 0.5) * 2 * dLat,
    lng: loc.lng + (frac(seed2) - 0.5) * 2 * dLng,
    name: loc.name || '',
    blurred: true
  }
}

function frac(n) {
  const x = Math.abs(Number(n) || 0)
  return x - Math.floor(x)
}

/** 判断该猫的点位是否需要对当前用户隐藏/模糊 */
function needBlur(cat) {
  return !!(cat && (cat.spotPrivate || cat.status === 'kitten' || cat.health === 'sick'))
}

/**
 * 猫档案脱敏：非社团成员看不到精确点位、内部备注、医疗与联系方式。
 * 服务端统一处理 —— 客户端拿不到就是拿不到。
 */
function sanitizeCat(cat, user) {
  if (!cat) return cat
  if (isMember(user)) return cat
  const out = Object.assign({}, cat)
  if (out.location) {
    out.location = needBlur(cat) ? blurLocation(out.location) : Object.assign({}, out.location)
  }
  delete out.internalNote
  delete out.medicalNote
  delete out.contact
  return out
}

/** 目击记录脱敏：非成员看不到精确点位与上报人联系方式 */
function sanitizeSighting(s, user) {
  if (!s) return s
  if (isMember(user)) return s
  const out = Object.assign({}, s)
  if (out.location) out.location = blurLocation(out.location)
  return out
}

/* ==================== 通用工具 ==================== */

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 分页参数收敛，防止 size 过大拖垮单次查询 */
function pageOf(event, defaultSize, maxSize) {
  const page = Math.max(1, Number(event && event.page) || 1)
  const size = Math.min(maxSize || 50, Math.max(1, Number(event && (event.size || defaultSize)) || defaultSize))
  return { page, size, skip: (page - 1) * size }
}

/** 本地日期键 YYYY-MM-DD（按云函数所在时区，与小程序一致） */
function dayKey(d) {
  const t = d || new Date()
  const y = t.getFullYear()
  const m = String(t.getMonth() + 1).padStart(2, '0')
  const day = String(t.getDate()).padStart(2, '0')
  return y + '-' + m + '-' + day
}

/** 当日零点，用于「本月/今日」统计 */
function startOfDay(d) {
  const t = d || new Date()
  return new Date(t.getFullYear(), t.getMonth(), t.getDate())
}

/** Haversine 距离（米） */
function distanceM(a, b) {
  if (!a || !b || typeof a.lat !== 'number' || typeof b.lat !== 'number') return null
  const R = 6371000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const la1 = (a.lat * Math.PI) / 180
  const la2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** 余弦相似度（用于 embedding 向量比对） */
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

module.exports = {
  cloud, db, _, COL, ROLE_LEVEL, AppError,
  roleOf, isMember, isAdmin, requireRole,
  resolveSchoolId, assertSchool, scopeWhere,
  blurLocation, needBlur, sanitizeCat, sanitizeSighting,
  escapeReg, pageOf, dayKey, startOfDay, distanceM, cosine
}
