/**
 * 喵园 CatCampus —— 后端云函数入口
 *
 * 架构原则：
 *  1. 所有数据库集合权限设为「仅管理端可读写」，客户端一律通过本函数访问，避免越权。
 *  2. 数据按 schoolId 隔离 —— 这是「先校园、后向外拓展」的架构支点。
 *  3. 权限三档：visitor（只读公开）/ member（社团写）/ admin（成员与角色管理），
 *     在 ACTIONS 表里声明，由统一入口 requireRole 校验，不再散落各处。
 *  4. 第一个注册的用户自动成为 admin，便于冷启动。
 *  5. 涉及猫只精确坐标的数据，对非社团成员做模糊化 —— 吸取街猫
 *     「直播暴露猫位置被虐猫者利用」的教训。
 *
 * 单函数 action 分发的工程治理（难点 3）：
 *  - ACTIONS 表驱动：每个 action 声明 handler + 所需角色，新增接口只改这张表；
 *  - 公共机制抽到 lib/（core / security / points / tnr / vision / map），
 *    本文件只放业务编排，便于将来按业务域拆成多个云函数时直接复用；
 *  - 统一超时保护与错误封装，AppError 携带语义码。
 */
const core = require('./lib/core')
const sec = require('./lib/security')
const points = require('./lib/points')
const tnr = require('./lib/tnr')
const vision = require('./lib/vision')
const maplib = require('./lib/map')
const vpay = require('./lib/vpay')

const {
  cloud, db, _, COL, AppError,
  isMember, isAdmin, requireRole, isSuper, requireSuper,
  resolveSchoolId, assertSchool,
  sanitizeCat, sanitizeSighting, escapeReg, pageOf, dayKey,
  ensureAllCollections
} = core

/* ==================== action 注册表 ====================
 * role: public | user | member | admin
 */
const ACTIONS = {
  /* 用户 & 学校 */
  'login':          { role: 'public', handler: login },
  'updateProfile':  { role: 'user',   handler: updateProfile },
  // 一键建齐所有集合（幂等）。部署后调一次，避免漏建集合导致的 -502005。
  'initCollections':{ role: 'admin',  handler: () => initCollections() },
  'createSchool':   { role: 'admin',  handler: createSchool },
  'updateSchool':   { role: 'admin',  handler: updateSchool },
  'listSchools':    { role: 'public', handler: listSchools },
  'getSchool':      { role: 'public', handler: getSchool },
  'bindSchool':     { role: 'user',   handler: bindSchool },

  /* 概览 */
  'getOverview':    { role: 'public', handler: getOverview },

  /* 猫档案：建档 / 改档属「管理员以上」权限（社团成员只能打卡、认领，不能改档案） */
  'listCats':       { role: 'public', handler: listCats },
  'getCat':         { role: 'public', handler: getCat },
  'saveCat':        { role: 'admin',  handler: saveCat },
  'removeCat':      { role: 'admin',  handler: removeCat },

  /* AI 猫脸识别 */
  'recognize':          { role: 'user',   handler: (u, e) => vision.runSync(u, e) },
  'recognizeStart':     { role: 'user',   handler: (u, e) => vision.start(u, e) },
  'recognizePoll':      { role: 'user',   handler: (u, e) => vision.poll(u, e) },
  'confirmRecognize':   { role: 'user',   handler: (u, e) => vision.confirm(u, e) },
  'buildAiIndex':       { role: 'member', handler: (u, e) => vision.buildIndex(u, e) },

  /* 目击打卡 */
  'addSighting':    { role: 'user',   handler: addSighting },
  'listSightings':  { role: 'public', handler: listSightings },
  'updateSighting': { role: 'user',   handler: updateSighting },
  'deleteSighting': { role: 'user',   handler: deleteSighting },

  /* TNR */
  'listTnr':        { role: 'member', handler: listTnr },
  'saveTnr':        { role: 'member', handler: saveTnr },
  'getTnrFlow':     { role: 'member', handler: () => ({ flow: tnr.flowMeta() }) },

  /* 任务排班 */
  'listTasks':      { role: 'public', handler: listTasks },
  'saveTask':       { role: 'member', handler: saveTask },
  'claimTask':      { role: 'user',   handler: claimTask },

  /* 资金 */
  'listFunds':      { role: 'member', handler: listFunds },
  'addFund':        { role: 'member', handler: addFund },

  /* 成员 & 申请 */
  'listMembers':    { role: 'member', handler: listMembers },
  'setRole':        { role: 'admin',  handler: setRole },
  'applyJoin':      { role: 'user',   handler: applyJoin },
  'listApplies':    { role: 'admin',  handler: listApplies },
  'handleApply':    { role: 'admin',  handler: handleApply },

  /* 地图 & 积分 */
  'listMapPoints':  { role: 'public', handler: (u, e) => maplib.mapPoints(u, e) },
  'pointsSummary':  { role: 'user',   handler: (u, e) => points.summary(u) },
  'listPoints':     { role: 'user',   handler: (me, e) => points.history(me.openid, e) },
  // 一次性迁移：把 users.points 的历史余额补记进 points 流水（幂等，可重复调用）
  'backfillPoints': { role: 'admin',  handler: backfillPointsLedger },

  /* 个人虚拟支付（仅封装「收钱 + 发货意图」，权益发放由业务侧消费 vpay_deliveries 完成） */
  'vpayConfig':          { role: 'public', handler: () => vpay.payConfig() },
  'vpayCreateOrder':     { role: 'user',   handler: (u, e) => vpay.createOrder(u, e) },
  'vpayQueryOrder':      { role: 'user',   handler: (u, e) => vpay.queryOrder(u, e) },
  'vpayRefund':          { role: 'admin',  handler: (u, e) => vpay.refundOrder(u, e) },
  'vpayListOrders':      { role: 'user',   handler: (u, e) => vpay.listOrders(u, e) },
  'vpayListDeliveries':  { role: 'admin',  handler: (u, e) => vpay.listDeliveries(u, e) },
  'vpayCompleteDelivery':{ role: 'admin',  handler: (u, e) => vpay.completeDelivery(u, e) },
  'vpayNotify':          { role: 'public', handler: (u, e) => vpay.handleNotify(u, e) }
}

/** 单次 action 处理超时保护（云函数上限 20s，AI 可放宽到 60s） */
const TIMEOUT_MS = Number(process.env.ACTION_TIMEOUT_MS) || 15000

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AppError('处理超时，请稍后重试', 504)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

exports.main = async (event, context) => {
  const action = (event && event.action) || ''
  const wxCtx = cloud.getWXContext()
  const openid = wxCtx.OPENID

  // 微信消息推送（虚拟支付发货/退款等）：以 HTTP 形式到达，无 action 字段，
  // 直接交给 vpay 处理，并把 XML 作为响应体原样返回给微信（决定平台是否重试）。
  if (!action && event && (event.body || event.httpMethod || event.xml)) {
    try {
      return await vpay.handleNotify(null, event)
    } catch (e) {
      console.error('[vpay notify]', e && (e.message || e))
      // 即便解析异常也回 success，避免平台暴力重试；异常已记日志
      return '<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>'
    }
  }

  const ok = data => ({ ok: true, data: data === undefined ? null : data })
  const fail = (msg, code) => ({ ok: false, msg, code: code || 400 })

  const def = ACTIONS[action]
  if (!def) return fail('未知的 action: ' + action, 404)

  try {
    const me = await getMe(openid)
    // 身份主键统一为自建的普通字段 openid（改名/重名都不影响）；
    // 旧文档缺 openid 时即时用微信上下文里的真实 openid 兜底，保证 requireSuper 等判断准确。
    if (me && !me.openid) me.openid = openid
    requireRole(me, def.role)
    const ctx = { openid, wxCtx, action }
    // 统一签名：handler(me, event, ctx)
    const data = await withTimeout(Promise.resolve(def.handler(me, event || {}, ctx)), TIMEOUT_MS)
    return ok(data)
  } catch (e) {
    console.error('[catcampus]', action, e && (e.message || e))
    if (e instanceof AppError) return fail(e.message, e.code)
    return fail(e && e.message ? e.message : '服务异常', 500)
  }
}

/* ==================== 基础 ==================== */

/**
 * 一键建齐所有集合（幂等）。
 * 云开发的集合必须在控制台手工创建，漏一个就会在第一次用到时抛
 * `-502005 database collection not exists`（例如 ai_tasks 只在识别时才碰到）。
 * 部署后调一次这个 action 即可全部建好；重复调用不会报错。
 */
async function initCollections() {
  const names = await ensureAllCollections()
  return { collections: names, count: names.length }
}

async function getMe(openid) {
  if (!openid) return null
  // 优先用自建 openid 字段；兼容历史文档（曾用系统 _openid）做兜底
  const res = await db.collection(COL.user)
    .where(_.or([{ openid: openid }, { _openid: openid }]))
    .limit(1).get()
  return res.data[0] || null
}

/* ==================== 用户 & 学校 ==================== */

async function login(me, event, ctx) {
  const openid = ctx && ctx.openid
  if (!openid) throw new AppError('无法获取用户身份', 401)
  const now = new Date()
  if (me) {
    // 旧文档缺 openid 字段时回填，保证后续以 openid 为稳定主键。
    // 关键：回填失败绝不能中断登录 —— 否则整个 login 拒绝，前端拿不到 user，
    // 表现为「变成爱猫同学 + 数据像全没了」，且 openid 永远补不回去。
    if (!me.openid) {
      await db.collection(COL.user).doc(me._id)
        .update({ data: { openid } })
        .catch(e => console.warn('[login] openid 回填失败，已忽略', e && e.message))
    }
    // 自愈：历史版本可能为同一 openid 产生过多个档案文档，
    // 登录时自动合并（积分/打卡数求和、图鉴并集、角色取最高），避免“数据清零”假象。
    // 同样不能因合并失败阻断登录，失败时退回当前档案。
    const merged = await mergeDuplicateUsers(openid)
      .catch(e => {
        console.warn('[login] 合并重复档案失败，已忽略', e && e.message)
        return null
      })
    const cur = merged || me
    return Object.assign({}, cur, {
      openid,
      isSuper: isSuper({ openid }),
      pointsToday: cur.pointsDay === dayKey() ? (cur.pointsToday || 0) : 0
    })
  }
  // 没找到档案：先尝试从历史打卡记录重建（防误清档案导致“数据全丢”假象）
  const rebuilt = await rebuildUserFromRecords(openid, now)
    .catch(e => {
      console.warn('[login] 从打卡记录重建失败，已忽略', e && e.message)
      return null
    })
  if (rebuilt) {
    return Object.assign({}, rebuilt, {
      pointsToday: rebuilt.pointsDay === dayKey() ? (rebuilt.pointsToday || 0) : 0
    })
  }
  // 首个用户或超级管理员自动成为 admin，便于冷启动与超管权限
  const total = await db.collection(COL.user).count()
  const isFirst = total.total === 0
  const superHere = isSuper({ openid })
  const doc = {
    openid,
    _openid: openid,
    nickName: event.nickName || '爱猫同学',
    avatarUrl: event.avatarUrl || '',
    role: (isFirst || superHere) ? 'admin' : 'visitor',
    schoolId: event.schoolId || '',
    points: 0,
    pointsDay: '',
    pointsToday: 0,
    sightingCount: 0,
    catSeen: [],
    createdAt: now,
    lastSeenAt: now
  }
  const add = await db.collection(COL.user).add({ data: doc })
  return Object.assign({}, doc, { _id: add._id, openid, isSuper: superHere })
}

const ROLE_RANK = { visitor: 0, member: 1, admin: 2 }

/** 合并同一 openid 的重复用户档案：保留最早的文档为主档，删掉其余 */
async function mergeDuplicateUsers(openid) {
  const res = await db.collection(COL.user)
    .where(_.or([{ openid }, { _openid: openid }]))
    .limit(10).get()
  const docs = res.data || []
  if (docs.length <= 1) return docs[0] || null

  const sorted = docs.slice().sort((a, b) =>
    new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
  const keep = sorted[0]
  let points = 0, sightingCount = 0
  let role = 'visitor', schoolId = '', nickName = '', avatarUrl = ''
  const seen = new Set()
  for (const d of sorted) {
    points += Number(d.points) || 0
    sightingCount += Number(d.sightingCount) || 0
    if ((ROLE_RANK[d.role] || 0) > (ROLE_RANK[role] || 0)) role = d.role
    ;(d.catSeen || []).forEach(id => seen.add(id))
    if (!schoolId && d.schoolId) schoolId = d.schoolId
    if (!nickName && d.nickName) nickName = d.nickName
    if (!avatarUrl && d.avatarUrl) avatarUrl = d.avatarUrl
  }
  const mergedDoc = {
    openid,
    points,
    sightingCount,
    role,
    schoolId,
    nickName,
    avatarUrl,
    catSeen: Array.from(seen),
    lastSeenAt: new Date()
  }
  await db.collection(COL.user).doc(keep._id).update({ data: mergedDoc })
  for (const d of sorted) {
    if (d._id !== keep._id) {
      await db.collection(COL.user).doc(d._id).remove().catch(() => {})
    }
  }
  return Object.assign({}, keep, mergedDoc)
}

/** 用户档案丢失时，从其历史打卡记录重建档案（积分按打卡单回加，图鉴按遇见重建） */
async function rebuildUserFromRecords(openid, now) {
  const res = await db.collection(COL.sighting)
    .where({ reporter: openid }).limit(1000).get()
  const list = res.data || []
  if (!list.length) return null
  const seen = new Set()
  let points = 0
  list.forEach(s => {
    if (s.catId) seen.add(s.catId)
    points += Number(s.points) || 0
  })
  const doc = {
    openid,
    _openid: openid,
    nickName: list[0].reporterName || ('猫友' + openid.slice(-4)),
    avatarUrl: '',
    role: isSuper({ openid }) ? 'admin' : 'member',
    schoolId: '',
    points,
    pointsDay: '',
    pointsToday: 0,
    sightingCount: list.length,
    catSeen: Array.from(seen),
    createdAt: now,
    lastSeenAt: now,
    recoveredAt: now
  }
  const add = await db.collection(COL.user).add({ data: doc })
  return Object.assign({}, doc, { _id: add._id, openid, isSuper: isSuper({ openid }) })
}

async function updateProfile(me, event) {
  const patch = {}
  if (event.nickName) {
    const okText = await sec.checkText(event.nickName)
    if (!okText) throw new AppError('昵称未通过安全检测', 400)
    patch.nickName = event.nickName
  }
  if (event.avatarUrl) {
    const okImg = await sec.checkImage(event.avatarUrl)
    if (!okImg) throw new AppError('头像未通过安全检测', 400)
    patch.avatarUrl = event.avatarUrl
  }
  patch.updatedAt = new Date()
  await db.collection(COL.user).doc(me._id).update({ data: patch })
  return Object.assign({}, me, patch)
}

async function createSchool(me, event) {
  // 仅超级管理员可创建学校
  requireSuper(me)
  if (!event.name) throw new AppError('缺少学校名称')
  const textOk = await sec.checkText([event.name, event.campus, event.intro].filter(Boolean).join(' '))
  if (!textOk) throw new AppError('内容未通过安全检测')
  const geo = normalizeSchoolGeo(event)
  const doc = {
    name: event.name,
    campus: event.campus || '',
    city: event.city || '',
    center: geo.center,     // { lat, lng } 地图默认中心
    bounds: geo.bounds,     // { sw:{lat,lng}, ne:{lat,lng} } 校园可视范围（地图只展示这块）
    scale: geo.scale,       // 进入地图时的缩放级别
    intro: event.intro || '',
    createdBy: me.openid,
    createdAt: new Date()
  }
  const add = await db.collection(COL.school).add({ data: doc })
  await db.collection(COL.user).doc(me._id).update({ data: { schoolId: add._id } })
  return Object.assign({}, doc, { _id: add._id })
}

/** 仅超管：更新学校信息（名称/简介/地图中心与范围） */
async function updateSchool(me, event) {
  requireSuper(me)
  if (!event.schoolId) throw new AppError('缺少学校 ID')
  const prev = await db.collection(COL.school).doc(event.schoolId).get()
  if (!prev.data) throw new AppError('学校不存在', 404)

  const patch = { updatedAt: new Date() }
  if (typeof event.name === 'string' && event.name.trim()) patch.name = event.name.trim()
  if (typeof event.campus === 'string') patch.campus = event.campus
  if (typeof event.city === 'string') patch.city = event.city
  if (typeof event.intro === 'string') patch.intro = event.intro

  // ⚠️ 必须用 `!== undefined` 判断，不能只用真值判断。
  // 客户端把 `center` / `scale` 以 undefined 传进来时（例如只调了 getSchool 没带 center），
  // `event.center || prev.data.center` 会走「未改」分支、进而继承旧 bounds ——
  // 但调用方其实是想「按新中心重算范围」，结果 bounds 一直停在老位置，
  // 表现出来就是「地图范围修改后不生效，还是默认值」。
  const hasCenter = event.center !== undefined && event.center !== null
  const hasScale = event.scale !== undefined && event.scale !== null
  const hasBounds = event.bounds !== undefined && event.bounds !== null

  if (hasCenter || hasScale || hasBounds) {
    const geo = normalizeSchoolGeo({
      center: hasCenter ? event.center : prev.data.center,
      scale: hasScale ? event.scale : prev.data.scale,
      // 只有「明确只改 bounds」时才继承旧值；改中心/缩放一律按新值重算
      bounds: hasBounds ? event.bounds : (!hasCenter && !hasScale ? prev.data.bounds : null)
    })
    patch.center = geo.center
    patch.bounds = geo.bounds
    patch.scale = geo.scale

    // 把「写进入参」和「最终落库值」一起打出来：
    // 排查「改了不生效」时，一眼就能分清是「参数没传进来」还是「落库被覆盖了」。
    console.log('[updateSchool] schoolId=', event.schoolId,
      'in.center=', JSON.stringify(event.center), 'in.scale=', event.scale,
      '=> out.center=', JSON.stringify(geo.center),
      'out.scale=', geo.scale, 'out.bounds=', JSON.stringify(geo.bounds))
  } else {
    console.log('[updateSchool] schoolId=', event.schoolId, '仅更新文字字段，地理信息未变')
  }

  // 安全检测：刻意包一层「失败即放行」的降级。
  // 学校名/简介属于后台运维文本，不是用户 UGC —— 若因 msgSecCheck 未开通、
  // 配额用尽或网络抖动而抛错，绝不能连累 地图范围（center/bounds/scale）也一起写不进去。
  // 这正是「改了范围却像没生效」的隐藏杀手之一。
  try {
    const textOk = await sec.checkText([patch.name, patch.campus, patch.intro].filter(Boolean).join(' '))
    if (!textOk) throw new AppError('内容未通过安全检测')
  } catch (e) {
    if (e instanceof AppError) throw e
    console.warn('[updateSchool] 文本安全检测异常，已降级放行', e && (e.message || e))
  }

  await db.collection(COL.school).doc(event.schoolId).update({ data: patch })
  return Object.assign({}, prev.data, patch, { _id: event.schoolId })
}

/**
 * 归一化学校地理信息。
 *  - center：无则用默认值（南京·东南大学四牌楼校区，README 里的示例学校）
 *  - scale：收敛到 12~18，越大越近
 *  - bounds：显式给了就用；否则按 center + scale 推一个「校园可视矩形」，
 *    地图端据此限制可视范围 —— 这样「选了某校就只展示这块区域」无需手工画框。
 */
function normalizeSchoolGeo(src) {
  const s = src || {}
  const DEFAULT_CENTER = { lat: 32.0585, lng: 118.7965 }   // 东南大学四牌楼校区
  // 必须同时是有限数字 —— 只判 typeof 的话，NaN 会一路带到 bounds，
  // 算出来的矩形全是 NaN，地图范围就「怎么改都不生效」。
  const cIn = s.center
  const cOk = cIn && typeof cIn.lat === 'number' && typeof cIn.lng === 'number' &&
    isFinite(cIn.lat) && isFinite(cIn.lng)
  const center = cOk ? { lat: Number(cIn.lat), lng: Number(cIn.lng) } : DEFAULT_CENTER
  const scale = Math.max(12, Math.min(18, Number(s.scale) || 16))

  let bounds = null
  if (s.bounds && s.bounds.sw && s.bounds.ne) {
    bounds = {
      sw: { lat: Number(s.bounds.sw.lat), lng: Number(s.bounds.sw.lng) },
      ne: { lat: Number(s.bounds.ne.lat), lng: Number(s.bounds.ne.lng) }
    }
    // 传进来的矩形若含非法坐标（NaN / 缺失），一律丢弃并按中心点重算，
    // 不能把一个坏矩形写进库 —— 那会让地图端 setBoundary 静默失效。
    const finite = v => v && isFinite(v.lat) && isFinite(v.lng)
    if (!finite(bounds.sw) || !finite(bounds.ne) ||
        bounds.sw.lat >= bounds.ne.lat || bounds.sw.lng >= bounds.ne.lng) {
      console.warn('[normalizeSchoolGeo] 传入 bounds 非法，改用中心点推算', JSON.stringify(s.bounds))
      bounds = null
    }
  }
  if (!bounds) {
    // 每级缩放约对应 1/2 的跨度：scale 16 → 约 ±0.006°（≈±660m）
    const half = 0.048 / Math.pow(2, scale - 12)
    const dLng = half / Math.max(0.2, Math.cos((center.lat * Math.PI) / 180))
    bounds = {
      sw: { lat: center.lat - half, lng: center.lng - dLng },
      ne: { lat: center.lat + half, lng: center.lng + dLng }
    }
  }
  return { center, bounds, scale }
}

async function listSchools() {
  const res = await db.collection(COL.school).orderBy('createdAt', 'asc').limit(50).get()
  return res.data
}

/**
 * 读学校。带 self-heal：
 * 历史学校档可能「有 center 但没 bounds」（甚至 center 为空），
 * 直接返回就会让地图端拿不到可视范围 —— 这也是「范围不生效」的常见来源。
 * 这里在读取时补算 bounds 并把校档修正回库（仅超管能改的字段，补算不改变用户意图）。
 */
async function getSchool(event) {
  if (!event.schoolId) return null
  const res = await db.collection(COL.school).doc(event.schoolId).get()
  const s = res.data
  if (!s) return null
  if (!needsGeoRepair(s)) return s
  const geo = normalizeSchoolGeo(s)
  const patch = {}
  if (!geoCenterValid(s.center)) patch.center = geo.center
  if (!geoScaleValid(s.scale)) patch.scale = geo.scale
  if (!(s.bounds && s.bounds.sw && s.bounds.ne)) patch.bounds = geo.bounds
  if (!Object.keys(patch).length) return s
  try {
    await db.collection(COL.school).doc(event.schoolId).update({ data: patch })
    console.log('[getSchool] 已补齐学校地理信息', event.schoolId, JSON.stringify(patch))
  } catch (e) {
    console.warn('[getSchool] 补齐回库失败，仅返回补算结果', e && (e.message || e))
  }
  return Object.assign({}, s, patch)
}

function geoCenterValid(c) {
  return !!(c && typeof c.lat === 'number' && typeof c.lng === 'number' && !isNaN(c.lat) && !isNaN(c.lng))
}
function geoScaleValid(v) {
  return Number(v) >= 12 && Number(v) <= 18
}
/** 是否需要补算地理信息（缺 center / 缺 bounds / scale 非法） */
function needsGeoRepair(s) {
  if (!s) return false
  return !geoCenterValid(s.center) || !geoScaleValid(s.scale) || !(s.bounds && s.bounds.sw && s.bounds.ne)
}

async function bindSchool(me, event) {
  await db.collection(COL.user).doc(me._id).update({ data: { schoolId: event.schoolId || '' } })
  return { schoolId: event.schoolId || '' }
}

/* ==================== 概览统计 ==================== */

async function getOverview(me, event) {
  const schoolId = resolveSchoolId(me, event)
  assertSchool(me, schoolId)
  const where = schoolId ? { schoolId } : {}
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)

  const [catAll, catOnCampus, sterilized, sightingMonth, tnrMonth, taskOpen, funds] = await Promise.all([
    db.collection(COL.cat).where(Object.assign({}, where, { status: _.nin(['rainbow', 'adopted']) })).count(),
    db.collection(COL.cat).where(Object.assign({}, where, { status: 'campus' })).count(),
    db.collection(COL.cat).where(Object.assign({}, where, { sterilized: 'yes', status: _.nin(['rainbow', 'adopted']) })).count(),
    db.collection(COL.sighting).where(Object.assign({}, where, { createdAt: _.gte(monthStart) })).count(),
    db.collection(COL.tnr).where(Object.assign({}, where, { createdAt: _.gte(monthStart) })).count(),
    db.collection(COL.task).where(Object.assign({}, where, { status: 'open' })).count(),
    isMember(me) ? listFundSummary(schoolId) : Promise.resolve({ income: 0, expense: 0 })
  ])

  const recent = await db.collection(COL.sighting)
    .where(where)
    .orderBy('createdAt', 'desc')
    .limit(5)
    .get()

  const catIds = [...new Set(recent.data.map(s => s.catId).filter(Boolean))]
  let catMap = {}
  if (catIds.length) {
    const cats = await db.collection(COL.cat).where({ _id: _.in(catIds) }).get()
    cats.data.forEach(c => { catMap[c._id] = { name: c.name, avatar: c.avatar, status: c.status } })
  }

  const alive = catAll.total || 0
  return {
    catCount: alive,
    onCampus: catOnCampus.total || 0,
    sterilized: sterilized.total || 0,
    sterilizedRate: alive ? Math.round((sterilized.total / alive) * 100) : 0,
    sightingMonth: sightingMonth.total || 0,
    tnrMonth: tnrMonth.total || 0,
    taskOpen: taskOpen.total || 0,
    fund: funds,
    recent: recent.data.map(s => Object.assign({}, s, { cat: catMap[s.catId] || null })),
    me: me ? { role: me.role, points: me.points || 0, sightingCount: me.sightingCount || 0, nickName: me.nickName } : null
  }
}

async function listFundSummary(schoolId) {
  const where = schoolId ? { schoolId } : {}
  const [inc, exp] = await Promise.all([
    db.collection(COL.fund).where(Object.assign({}, where, { type: 'income' })).get(),
    db.collection(COL.fund).where(Object.assign({}, where, { type: 'expense' })).get()
  ])
  const sum = arr => arr.reduce((a, b) => a + (Number(b.amount) || 0), 0)
  return { income: sum(inc.data), expense: sum(exp.data) }
}

/* ==================== 猫档案 ==================== */

async function listCats(me, event) {
  const schoolId = resolveSchoolId(me, event)
  assertSchool(me, schoolId)
  const where = {}
  if (schoolId) where.schoolId = schoolId
  if (event.status) where.status = event.status
  if (event.sterilized) where.sterilized = event.sterilized
  if (event.pattern) where.pattern = event.pattern

  let q = db.collection(COL.cat).where(where)
  if (event.keyword) {
    q = q.where({ name: db.RegExp({ regexp: escapeReg(event.keyword), options: 'i' }) })
  }
  const { page, size, skip } = pageOf(event, 20, 50)
  const res = await q.orderBy('updatedAt', 'desc').skip(skip).limit(size).get()

  return {
    list: res.data.map(c => sanitizeCat(c, me)),
    hasMore: res.data.length === size,
    page
  }
}

async function getCat(me, event) {
  if (!event.id) throw new AppError('缺少猫 ID')
  const res = await db.collection(COL.cat).doc(event.id).get()
  const cat = res.data
  if (!cat) throw new AppError('猫咪不存在', 404)

  const [sightings, tnrList] = await Promise.all([
    db.collection(COL.sighting).where({ catId: cat._id }).orderBy('createdAt', 'desc').limit(10).get(),
    isMember(me)
      ? db.collection(COL.tnr).where({ catId: cat._id }).orderBy('createdAt', 'desc').limit(5).get()
      : Promise.resolve({ data: [] })
  ])
  return {
    cat: sanitizeCat(cat, me),
    sightings: sightings.data.map(s => sanitizeSighting(s, me)),
    tnr: tnrList.data,
    // 能否编辑档案 = 管理员及以上（超管在 login 时已被授予 admin 角色）
    canEdit: isAdmin(me)
  }
}

async function saveCat(me, event) {
  const d = event.data || {}
  if (!d.name) throw new AppError('请填写猫咪名字')

  const textOk = await sec.checkText([d.name, d.alias, d.note, d.internalNote, d.colorNote].filter(Boolean).join(' '))
  if (!textOk) throw new AppError('文字内容未通过安全检测，请修改后重试')

  const photos = (d.photos || []).slice(0, 9)
  if (photos.length) {
    const okImg = await sec.checkImage(photos[0])
    if (!okImg) throw new AppError('图片未通过安全检测')
  }

  const schoolId = d.schoolId || me.schoolId
  assertSchool(me, schoolId)
  const now = new Date()
  const payload = {
    name: d.name,
    alias: d.alias || '',
    sex: d.sex || 'unknown',
    pattern: d.pattern || 'other',
    colorNote: d.colorNote || '',
    sterilized: d.sterilized || 'unknown',
    earMark: d.earMark || '',
    status: d.status || 'campus',
    health: d.health || 'unknown',
    characters: d.characters || [],
    location: d.location || null,
    spotPrivate: !!d.spotPrivate,
    avatar: d.avatar || '',
    photos,
    birthday: d.birthday || '',
    relations: d.relations || [],
    note: d.note || '',
    internalNote: d.internalNote || '',
    medicalNote: d.medicalNote || '',
    schoolId: schoolId || '',
    updatedBy: me.openid,
    updatedAt: now
  }

  if (d._id) {
    await db.collection(COL.cat).doc(d._id).update({ data: payload })
    return { _id: d._id }
  }
  payload.createdAt = now
  payload.createdBy = me.openid
  payload.sightingCount = 0
  const add = await db.collection(COL.cat).add({ data: payload })
  return { _id: add._id }
}

async function removeCat(me, event) {
  await db.collection(COL.cat).doc(event.id).remove()
  return { _id: event.id }
}

/* ==================== 积分流水迁移 ==================== */

/**
 * 一次性迁移：把 users.points 里的历史余额补记进 points 流水表。
 *
 * 背景：points（猫粮流水）是后期才加的记录表 —— 之前发放积分只更新 users.points，
 * 不写流水，所以新表是空的、历史猫粮值「看不见」。余额本身没有丢（users.points
 * 一直在），只是缺流水记录。
 *
 * 设计要点：
 *  - 幂等：只在用户**还没有任何流水**时补一条 kind='migrate' 的期初行；
 *    已有流水的用户一律跳过 —— 重复调用不会产生重复记录、不会重复加分。
 *  - 不改 users.points（余额不动，只补记录）。
 *  - 期初行的 balance 直接取当前 users.points，delta 等于 balance（作为「期初建账」）。
 */
async function backfillPointsLedger(me, event) {
  const pageSize = 100
  let skip = 0
  let migrated = 0
  let skipped = 0
  const details = []

  while (true) {
    const res = await db.collection(COL.user)
      .orderBy('createdAt', 'asc').skip(skip).limit(pageSize).get()
    const users = res.data || []
    if (!users.length) break

    for (const u of users) {
      const balance = Number(u.points) || 0
      // 没有余额的不需要迁移
      if (balance <= 0) { skipped++; continue }
      // 已有流水（无论多少）→ 说明已经迁移过或正常发放过，跳过
      const existed = await db.collection(COL.point)
        .where({ userId: u._id }).limit(1).count()
      if (existed.total > 0) { skipped++; continue }

      await db.collection(COL.point).add({
        data: {
          openid: u.openid || u._openid || '',
          userId: u._id,
          kind: 'migrate',
          reason: '历史猫粮值迁入（期初建账）',
          delta: balance,
          balance,
          refType: 'migrate',
          refId: '',
          createdAt: (u.createdAt) || new Date()
        }
      })
      migrated++
      if (details.length < 20) details.push({ userId: u._id, nickName: u.nickName || '', balance })
    }

    skip += users.length
    if (users.length < pageSize) break
  }

  console.log('[backfillPoints] 迁移', migrated, '人，跳过', skipped, '人（无余额或已有流水）')
  return { migrated, skipped, sample: details }
}

/* ==================== 目击打卡 ==================== */

async function addSighting(me, event) {
  const d = event.data || {}
  await sec.assertSightingSafe(d)

  const now = new Date()
  const photos = (d.photos || []).slice(0, 6)
  const schoolId = d.schoolId || me.schoolId || ''
  assertSchool(me, schoolId)

  // 首次遇见（图鉴解锁）判断：读一次用户档案，避免并发重复加
  const seen = me.catSeen || []
  const firstMeet = !!(d.catId && seen.indexOf(d.catId) < 0)
  const isNewCat = !d.catId

  const doc = {
    catId: d.catId || '',
    catName: d.catName || (d.catId ? '' : '未认领的新猫'),
    pending: !d.catId,
    location: d.location || null,
    locationName: d.locationName || '',
    photos,
    health: d.health || 'unknown',
    note: d.note || '',
    count: Number(d.count) || 1,
    schoolId,
    reporter: me.openid,
    reporterName: me.nickName || '',
    createdAt: now
  }

  // 先落库拿到 id，再发积分并挂上关联（流水记录表与 users 解耦）
  const add = await db.collection(COL.sighting).add({ data: doc })
  const g1 = await points.grant(me, 'sighting', null, { refType: 'sighting', refId: add._id })
  const g2 = firstMeet ? await points.grant(me, 'firstMeet', null, { refType: 'cat', refId: d.catId }) : { gained: 0 }
  const g3 = isNewCat ? await points.grant(me, 'newCat', null, { refType: 'cat', refId: d.catId }) : { gained: 0 }
  const total = (g1.gained || 0) + (g2.gained || 0) + (g3.gained || 0)
  await db.collection(COL.sighting).doc(add._id).update({ data: { points: total } })
  doc.points = total

  const patch = { sightingCount: _.inc(1) }
  if (firstMeet) patch.catSeen = _.push([d.catId])
  await db.collection(COL.user).doc(me._id).update({ data: patch })

  if (d.catId) {
    await db.collection(COL.cat).doc(d.catId).update({
      data: { sightingCount: _.inc(1), lastSeenAt: now, lastSeenBy: me.nickName || '' }
    }).catch(() => {})
  }

  return Object.assign({}, doc, {
    _id: add._id,
    pointsGained: total,
    firstMeet,
    dailyCapped: !!(g1.capped || g3.capped),
    pointsToday: (g1.today || 0)
  })
}

async function listSightings(me, event) {
  const schoolId = resolveSchoolId(me, event)
  assertSchool(me, schoolId)
  const where = {}
  if (schoolId) where.schoolId = schoolId
  if (event.catId) where.catId = event.catId
  if (event.pending) where.pending = true
  if (event.mine && me) where.reporter = me.openid

  const { page, size, skip } = pageOf(event, 20, 50)
  const res = await db.collection(COL.sighting)
    .where(where).orderBy('createdAt', 'desc').skip(skip).limit(size).get()

  const catIds = [...new Set(res.data.map(s => s.catId).filter(Boolean))]
  let catMap = {}
  if (catIds.length) {
    const cats = await db.collection(COL.cat).where({ _id: _.in(catIds) }).get()
    cats.data.forEach(c => { catMap[c._id] = { name: c.name, avatar: c.avatar } })
  }
  return {
    list: res.data.map(s => Object.assign(sanitizeSighting(s, me), { cat: catMap[s.catId] || null })),
    hasMore: res.data.length === size,
    page
  }
}

/* ==================== 目击记录管理（修改/删除上传记录） ==================== */

// 超管可改/删任意记录；本人可改/删自己发布的记录
function assertSightingOwner(me, s) {
  if (!s) throw new AppError('记录不存在', 404)
  if (isSuper(me) || s.reporter === me.openid) return true
  throw new AppError('无权操作该记录', 403)
}

async function updateSighting(me, event) {
  if (!event.id) throw new AppError('缺少记录 ID')
  const res = await db.collection(COL.sighting).doc(event.id).get()
  assertSightingOwner(me, res.data)
  const d = event.data || {}
  const patch = { updatedAt: new Date(), updatedBy: me.openid }
  if (typeof d.note === 'string') {
    const ok = await sec.checkText(d.note)
    if (!ok) throw new AppError('备注未通过安全检测')
    patch.note = d.note
  }
  if (d.health && ['unknown', 'healthy', 'sick', 'injured', 'suspected'].indexOf(d.health) >= 0) patch.health = d.health
  if (typeof d.locationName === 'string') patch.locationName = d.locationName
  if (Number(d.count) > 0) patch.count = Number(d.count)
  await db.collection(COL.sighting).doc(event.id).update({ data: patch })
  return { ok: true }
}

async function deleteSighting(me, event) {
  if (!event.id) throw new AppError('缺少记录 ID')
  const res = await db.collection(COL.sighting).doc(event.id).get()
  assertSightingOwner(me, res.data)
  // 同步回退用户打卡计数（仅当该记录确实计过分）
  if (res.data && res.data.points) {
    const u = await db.collection(COL.user).doc(me._id).get()
    const next = Math.max(0, (u.data ? (u.data.sightingCount || 0) : 0) - 1)
    await db.collection(COL.user).doc(me._id).update({ data: { sightingCount: next } }).catch(() => {})
  }
  await db.collection(COL.sighting).doc(event.id).remove()
  return { ok: true }
}

/* ==================== TNR 台账 ==================== */

async function listTnr(me, event) {
  const schoolId = resolveSchoolId(me, event)
  assertSchool(me, schoolId)
  const where = schoolId ? { schoolId } : {}
  if (event.status) where.status = event.status
  if (event.catId) where.catId = event.catId
  const res = await db.collection(COL.tnr)
    .where(where).orderBy('createdAt', 'desc').limit(100).get()

  const catIds = [...new Set(res.data.map(t => t.catId).filter(Boolean))]
  let catMap = {}
  if (catIds.length) {
    const cats = await db.collection(COL.cat).where({ _id: _.in(catIds) }).get()
    cats.data.forEach(c => { catMap[c._id] = { name: c.name, avatar: c.avatar, sterilized: c.sterilized } })
  }
  return {
    list: res.data.map(t => Object.assign({}, t, { cat: catMap[t.catId] || null })),
    flow: tnr.flowMeta()
  }
}

async function saveTnr(me, event) {
  const d = event.data || {}
  if (!d.catId && !(d.catName || '').trim()) throw new AppError('请选择或填写猫咪')

  const now = new Date()
  const to = d.status || 'todo'
  let from = ''

  if (d._id) {
    const prev = await db.collection(COL.tnr).doc(d._id).get()
    if (!prev.data) throw new AppError('记录不存在', 404)
    from = prev.data.status || 'todo'
  }
  // 状态机：非法流转直接拒绝（含「已放归 → 待抓捕」这类回跳）
  tnr.assertTransition(from, to)

  if (d.note) {
    const okText = await sec.checkText(d.note)
    if (!okText) throw new AppError('备注未通过安全检测')
  }

  const schoolId = d.schoolId || me.schoolId || ''
  assertSchool(me, schoolId)

  const payload = {
    catId: d.catId || '',
    catName: (d.catName || '').trim(),
    status: to,
    trapDate: d.trapDate || '',
    surgeryDate: d.surgeryDate || '',
    releaseDate: d.releaseDate || '',
    hospital: d.hospital || '',
    vet: d.vet || '',
    cost: Number(d.cost) || 0,
    earMark: d.earMark || '',
    operator: d.operator || me.nickName || '',
    note: d.note || '',
    schoolId,
    updatedBy: me.openid,
    updatedAt: now
  }
  tnr.autoDates(payload, from, to, now)

  const catPatch = tnr.catSyncPatch(to, payload.earMark)
  const isCreate = !d._id
  if (isCreate) {
    payload.createdAt = now
    payload.createdBy = me.openid
  }

  // 记录与猫档案在同一个事务里写，保证状态一致
  try {
    await db.runTransaction(async tx => {
      if (isCreate) {
        await tx.collection(COL.tnr).add({ data: payload })
      } else {
        await tx.collection(COL.tnr).doc(d._id).update({ data: payload })
      }
      if (payload.catId && catPatch) {
        await tx.collection(COL.cat).doc(payload.catId).update({ data: catPatch })
      }
    })
  } catch (e) {
    console.warn('[saveTnr] 事务失败，降级为分步写入', e && e.message)
    if (isCreate) {
      await db.collection(COL.tnr).add({ data: payload })
    } else {
      await db.collection(COL.tnr).doc(d._id).update({ data: payload })
    }
    if (payload.catId && catPatch) {
      await db.collection(COL.cat).doc(payload.catId).update({ data: catPatch }).catch(() => {})
    }
  }

  if (isCreate) await points.grant(me, 'tnrHelp', null, { refType: 'tnr', refId: d._id || '' })

  return { ok: true, _id: d._id || '', status: to, catSynced: !!(payload.catId && catPatch) }
}

/* ==================== 任务排班 ==================== */

async function listTasks(me, event) {
  const schoolId = resolveSchoolId(me, event)
  assertSchool(me, schoolId)
  const where = schoolId ? { schoolId } : {}
  if (event.status) where.status = event.status
  if (event.mine && me) where.assignee = me.openid
  const res = await db.collection(COL.task)
    .where(where).orderBy('date', 'asc').limit(100).get()

  // 任务对所有人可见（便于认领），但联系方式仅成员可见
  return res.data.map(t => {
    const o = Object.assign({}, t)
    if (!isMember(me)) delete o.contact
    return o
  })
}

async function saveTask(me, event) {
  const d = event.data || {}
  if (!d.title) throw new AppError('请填写任务标题')
  const textOk = await sec.checkText([d.title, d.spot, d.note].filter(Boolean).join(' '))
  if (!textOk) throw new AppError('内容未通过安全检测')

  const now = new Date()
  const schoolId = d.schoolId || me.schoolId || ''
  assertSchool(me, schoolId)
  const payload = {
    title: d.title,
    type: d.type || 'feed',
    date: d.date || '',
    spot: d.spot || '',
    location: d.location || null,
    assignee: d.assignee || '',
    assigneeName: d.assigneeName || '',
    status: d.status || 'open',
    note: d.note || '',
    contact: d.contact || '',
    schoolId,
    updatedBy: me.openid,
    updatedAt: now
  }
  if (d._id) {
    await db.collection(COL.task).doc(d._id).update({ data: payload })
  } else {
    payload.createdAt = now
    payload.createdBy = me.openid
    await db.collection(COL.task).add({ data: payload })
  }
  return { ok: true, _id: d._id || '' }
}

async function claimTask(me, event) {
  if (!event.id) throw new AppError('缺少任务 ID')
  // 只允许认领「待认领」或自己的任务，避免并发抢单覆盖
  const res = await db.collection(COL.task).doc(event.id).get()
  const t = res.data
  if (!t) throw new AppError('任务不存在', 404)
  if (!event.cancel && t.status !== 'open') throw new AppError('该任务已被认领', 409)
  if (event.cancel && t.assignee !== me.openid) throw new AppError('只能取消自己认领的任务', 403)

  await db.collection(COL.task).doc(event.id).update({
    data: {
      status: event.cancel ? 'open' : 'claimed',
      assignee: event.cancel ? '' : me.openid,
      assigneeName: event.cancel ? '' : (me.nickName || ''),
      updatedAt: new Date()
    }
  })
  return { ok: true }
}

/* ==================== 资金 ==================== */

async function listFunds(me, event) {
  const schoolId = resolveSchoolId(me, event)
  assertSchool(me, schoolId)
  const where = schoolId ? { schoolId } : {}
  if (event.type) where.type = event.type
  const res = await db.collection(COL.fund)
    .where(where).orderBy('date', 'desc').limit(200).get()
  const summary = await listFundSummary(schoolId)
  return { list: res.data, summary }
}

async function addFund(me, event) {
  const d = event.data || {}
  const amount = Number(d.amount)
  if (!amount) throw new AppError('请填写金额')
  if (!['income', 'expense'].includes(d.type)) throw new AppError('类型错误')
  const textOk = await sec.checkText(d.title || '')
  if (!textOk) throw new AppError('内容未通过安全检测')

  const schoolId = d.schoolId || me.schoolId || ''
  assertSchool(me, schoolId)
  const doc = {
    type: d.type,
    amount: Math.abs(amount),
    category: d.category || 'other',
    title: d.title || (d.type === 'income' ? '捐赠' : '支出'),
    date: d.date || new Date(),
    catId: d.catId || '',
    proof: d.proof || [],
    operator: me.nickName || '',
    schoolId,
    createdBy: me.openid,
    createdAt: new Date()
  }
  await db.collection(COL.fund).add({ data: doc })
  return { ok: true }
}

/* ==================== 成员 & 申请 ==================== */

async function listMembers(me, event) {
  const schoolId = resolveSchoolId(me, event)
  assertSchool(me, schoolId)
  const where = schoolId ? { schoolId } : {}
  const res = await db.collection(COL.user)
    .where(where).orderBy('createdAt', 'desc').limit(200).get()
  return res.data.map(u => ({
    _id: u._id,
    nickName: u.nickName,
    avatarUrl: u.avatarUrl,
    role: u.role,
    isSuper: isSuper({ openid: u.openid || u._openid }),
    points: u.points || 0,
    sightingCount: u.sightingCount || 0,
    lastSeenAt: u.lastSeenAt || null
  }))
}

async function setRole(me, event) {
  requireSuper(me)
  if (!['visitor', 'member', 'admin'].includes(event.role)) throw new AppError('角色非法')
  if (event.userId === me._id && event.role !== 'admin') {
    throw new AppError('不能降级自己（避免失去管理权限）')
  }
  // 禁止改动超级管理员身份（超管由 openid 决定，改名/改角色均无效）
  const target = await db.collection(COL.user).doc(event.userId).get()
  if (target.data && isSuper({ openid: target.data.openid || target.data._openid })) {
    throw new AppError('超级管理员身份不可更改', 403)
  }
  await db.collection(COL.user).doc(event.userId).update({
    data: { role: event.role, updatedAt: new Date(), schoolId: me.schoolId || '' }
  })
  return { ok: true }
}

async function applyJoin(me, event) {
  if (isMember(me)) return { status: 'already' }
  const exist = await db.collection(COL.apply)
    .where({ openid: me.openid, status: 'pending' }).limit(1).get()
  if (exist.data.length) return { status: 'pending' }

  const textOk = await sec.checkText([event.reason, event.experience, event.contact].filter(Boolean).join(' '))
  if (!textOk) throw new AppError('内容未通过安全检测')

  await db.collection(COL.apply).add({
    data: {
      openid: me.openid,
      _openid: me.openid,
      nickName: event.nickName || me.nickName || '',
      contact: event.contact || '',
      reason: event.reason || '',
      experience: event.experience || '',
      schoolId: event.schoolId || me.schoolId || '',
      status: 'pending',
      createdAt: new Date()
    }
  })
  return { status: 'submitted' }
}

async function listApplies(me, event) {
  const schoolId = resolveSchoolId(me, event)
  assertSchool(me, schoolId)
  const where = { status: event.status || 'pending' }
  if (schoolId) where.schoolId = schoolId
  const res = await db.collection(COL.apply)
    .where(where).orderBy('createdAt', 'desc').limit(100).get()
  return res.data
}

async function handleApply(me, event) {
  const apply = await db.collection(COL.apply).doc(event.id).get()
  if (!apply.data) throw new AppError('申请不存在', 404)
  const now = new Date()
  await db.collection(COL.apply).doc(event.id).update({
    data: { status: event.approve ? 'approved' : 'rejected', handler: me.nickName, handledAt: now }
  })
  if (event.approve) {
    const u = await db.collection(COL.user).where({ openid: apply.data.openid }).limit(1).get()
    if (u.data[0]) {
      await db.collection(COL.user).doc(u.data[0]._id).update({
        data: { role: 'member', schoolId: apply.data.schoolId || me.schoolId || '' }
      })
    }
  }
  return { ok: true }
}
