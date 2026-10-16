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
  point: 'points',      // 猫粮流水（记录表，与 users 分离）
  aiTask: 'ai_tasks',   // AI 识别异步任务（难点 1：短视频异步化）
  aiSample: 'ai_samples', // 用户确认的识别样本（人机协同闭环，为后续训练攒数据）
  vpayOrder: 'vpay_orders',       // 虚拟支付订单（待支付/已支付/已发货/已退款）
  vpayNotify: 'vpay_notifies',    // 微信推送原始事件（发货/退款/投诉等，审计用）
  vpayDelivery: 'vpay_deliveries' // 发货意图（业务侧消费：发放权益后标记 delivered）
}

/**
 * 集合自愈：第一次用到某个集合时若不存在，直接建出来。
 *
 * 为什么需要：云开发的集合**不会**因为代码里写了名字就自动存在，
 * 必须在控制台手工建。漏建任何一个，第一次用到就抛
 * `-502005 database collection not exists`，而且报错点在深层的 DB 调用处，
 * 对使用者非常不友好（例如 `ai_tasks` 只在识别时才碰到，很容易在部署时漏掉）。
 *
 * 这里用「惰性建表 + 进程内缓存」兜住：
 *  - 第一次访问某集合前先确保它存在（缓存命中则零开销，不额外查库）；
 *  - 并发时可能重复发起 createCollection，重复建会报「已存在」，
 *    当作成功吞掉即可（幂等）。
 */
const _collectionReady = {}
/** 正在后台创建中的集合（避免并发重复发起 createCollection） */
const _collectionCreating = {}

/**
 * ⚠️ 性能红线：这个函数**绝不能**在请求热路径上被 await。
 *
 * 踩过的坑：`ensureCollection` 最初是 `await db.createCollection(name)`，
 * 也就是一次完整的服务端往返（实测 300~500ms）。首次识别时它插在
 * `getMe → ensureCollection → ai_tasks.add → ...` 的链条里，把单次
 * `recognize` 的耗时推到约 2.9s，直接顶穿客户端 `cloud.callFunction`
 * 约 3s 的调用预算，报 `-504003 Invoking task timed out after 3 seconds`。
 *
 * 正确做法：把「建集合」当**后台副作用**发起，不阻塞当前请求。
 *  - 冷路径：本次请求正常执行；若集合真不存在，本次可能仍失败，
 *    但后台创建已完成，重试即成功（前端本来就有重试/重进页面的机会）。
 *  - 热路径：`_collectionReady` 命中，零开销、不发任何请求。
 *  - 部署后调一次 `initCollections` 才是根治手段，这里是兜底。
 */
function ensureCollection(name) {
  if (!name || _collectionReady[name]) return Promise.resolve()
  if (_collectionCreating[name]) return _collectionCreating[name]

  _collectionCreating[name] = db.createCollection(name)
    .then(() => {
      _collectionReady[name] = true
      console.log('[db] 已自动创建集合', name)
    })
    .catch(e => {
      // -501001 / 已存在 等一律视为「集合可用」，不打断业务
      const msg = (e && (e.errMsg || e.message)) || ''
      if (/exist|已存在|-501001/i.test(msg)) {
        _collectionReady[name] = true
      } else {
        console.warn('[db] 自动创建集合失败（若后续仍报集合不存在，请在控制台手工建）', name, msg)
      }
    })
    .finally(() => { delete _collectionCreating[name] })

  return _collectionCreating[name]
}

/**
 * 预热：不 await 地发起建表，只用于「写操作前顺手确保一下」。
 * 与 ensureCollection 的区别是调用方明确表示「不等结果」。
 */
function warmCollection(name) {
  ensureCollection(name).catch(() => {})
}

/** 用前先确保集合存在（写操作建议都套一层；读不存在的集合返回空，不会报错） */
function coll(name) {
  return {
    // 注意：这里是 warm（不等建表结果），不是 await ensureCollection。
    // 若 await，又会把一次 300~500ms 的建表往返塞进每次写操作里。
    add: async arg => { warmCollection(name); return db.collection(name).add(arg) },
    doc: id => db.collection(name).doc(id),
    where: w => db.collection(name).where(w),
    orderBy: (f, o) => db.collection(name).orderBy(f, o),
    limit: n => db.collection(name).limit(n),
    skip: n => db.collection(name).skip(n),
    count: async () => {
      try { return await db.collection(name).count() }
      catch (e) { warmCollection(name); return { total: 0 } }
    },
    get: async () => {
      try { return await db.collection(name).get() }
      catch (e) { warmCollection(name); return { data: [] } }
    }
  }
}

/**
 * 一次性把所有集合都建齐（部署后调一次即可；也可由 ensureAllCollections 幂等重跑）。
 *
 * 必须**并发**建，不能 for-await 串行 —— 14 个集合 × 每次约 400ms 的服务端往返
 * ≈ 5.6s，串行同样会顶穿调用预算。并发后总耗时约等于单次。
 */
async function ensureAllCollections() {
  const names = Object.values(COL)
  await Promise.all(names.map(n => ensureCollection(n)))
  const failed = names.filter(n => !_collectionReady[n])
  if (failed.length) console.warn('[db] 以下集合创建未确认成功（可到控制台手工补建）', failed)
  return names
}

/** 角色等级：用于 requireRole 的比较 */
const ROLE_LEVEL = { visitor: 0, member: 1, admin: 2 }

/**
 * 超级管理员：以 openid 标识（绝不用昵称，改名/重名都不影响）。
 * 默认包含项目拥有者 Promise；可用云函数环境变量 SUPER_ADMIN_OPENIDS（逗号分隔）覆盖。
 * 超管在登录时自动获得 admin 角色，并独享「创建学校 / 更改管理员身份 / 修改上传记录」等权限。
 */
// 注意：以数据库里 Promise 档案的真实 _openid 为准（oKivox...），
// o6zAJ... 为早期误填的 openid，保留是为了兼容旧会话，新部署请以后者为准。
const SUPER_ADMIN_OPENIDS = (process.env.SUPER_ADMIN_OPENIDS || 'oKivoxRmuKFIMtqqFun-8pUpureM,o6zAJs5bk37YM7pl3csLZnY3mdqc')
  .split(',').map(s => (s || '').trim()).filter(Boolean)

function isSuper(user) {
  return !!(user && user.openid && SUPER_ADMIN_OPENIDS.indexOf(user.openid) >= 0)
}

/** 仅超级管理员可执行；其余一律 403 */
function requireSuper(user) {
  if (!user) throw new AppError('请先登录', 401)
  if (!isSuper(user)) throw new AppError('仅超级管理员可执行此操作', 403)
  return user
}

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
  // isFinite 而非 typeof：NaN 坐标进来会产出 NaN:NaN 的模糊点
  if (!loc || !isFinite(loc.lat) || !isFinite(loc.lng)) return loc
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

/**
 * 目击记录脱敏。
 *
 * ⚠️ 2026-10-16 合规加严（审核驳回「社交-笔记」类目）：
 *   原来只对非成员做**点位模糊**，其余字段（用户自由文本 note、用户上传的 photos）
 *   照原样下发给所有人 —— 审核据此认定小程序存在「用户自行生成内容（文字、图片）的公开发布」，
 *   属社交-笔记范畴，个人主体未开放。
 *
 *   现在对外（非社团成员）只暴露**结构化的猫况聚合信息**：
 *     保留：catId / health / feedStatus / behaviors / count / createdAt（及模糊后的 location）
 *     移除：note（用户文字）、photos（用户图片）、reporter / reporterName（身份）
 *   成员（社团管理者）仍可见全字段 —— 他们需要原文与图片来核实存档。
 *
 *   这样即使用户传了照片、填了补充，对公众也只是一条"某时某地某猫状态正常"的**登记记录**，
 *   不构成内容发布/传播。前端展示层同样不应渲染这些字段（见 sighting 列表页）。
 */
function sanitizeSighting(s, user) {
  if (!s) return s
  if (isMember(user)) return s
  const out = Object.assign({}, s)
  if (out.location) out.location = blurLocation(out.location)
  // 用户生成内容一律不下发（合规红线）
  delete out.note
  delete out.photos
  delete out.reporter
  delete out.reporterName
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

/** Haversine 距离（米）。
 *  坐标校验必须用 isFinite 而非 typeof === 'number'：NaN/Infinity 也是 number，
 *  放过去会把 NaN 距离带进打分与地图（矩形全变 NaN、静默失效）。 */
function distanceM(a, b) {
  if (!a || !b || !isFinite(a.lat) || !isFinite(a.lng) || !isFinite(b.lat) || !isFinite(b.lng)) return null
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
  ensureCollection, ensureAllCollections, coll, warmCollection,
  roleOf, isMember, isAdmin, requireRole,
  SUPER_ADMIN_OPENIDS, isSuper, requireSuper,
  resolveSchoolId, assertSchool, scopeWhere,
  blurLocation, needBlur, sanitizeCat, sanitizeSighting,
  escapeReg, pageOf, dayKey, startOfDay, distanceM, cosine
}
