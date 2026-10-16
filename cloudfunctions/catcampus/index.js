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
  // 启动聚合：一次调用拿齐 user + school + 首页概览。
  // 原来是 login → getSchool → getOverview 三次**串行**云调用，冷启动首页统计要等三轮。
  'homeInit':       { role: 'public', handler: homeInit },
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
  'recognize':          { role: 'user',   handler: (u, e, ctx) => vision.runSync(u, e, ctx) },
  'recognizeStart':     { role: 'user',   handler: (u, e, ctx) => vision.start(u, e, ctx) },
  'recognizePoll':      { role: 'user',   handler: (u, e, ctx) => vision.poll(u, e, ctx) },
  'confirmRecognize':   { role: 'user',   handler: (u, e) => vision.confirm(u, e) },
  'buildAiIndex':       { role: 'member', handler: (u, e) => vision.buildIndex(u, e) },
  // 建档 / 改档后自动入库（只建这一只，永不抛错，失败由 A/B 兜底）
  'autoIndexCat':       { role: 'admin',  handler: (u, e) => vision.buildIndexAuto(u, e) },
  // 全量建库（所有校区）。role=admin：跨校区动作，且会跑满云函数预算，权限收紧。
  'buildAiIndexAll':    { role: 'admin',  handler: (u, e) => vision.buildIndexAll(e || {}) },

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
  // 一键生成「游客体验数据」：给审核员看到非空页面（幂等，仅超管）
  'seedDemoData':   { role: 'admin',  handler: seedDemoData },
  // 排查用：列出猫档案的原始 avatar/photos 值 + 每个 fileID 的官方换链结果。
  // 「某只猫头像空白」时调它，一眼看出是「字段为空 / 本地临时路径 / 文件已不存在」。
  // 事件：{ action: 'debugCatMedia', name: '小灰灰' }（name 可省略 = 全校区）
  'debugCatMedia':  { role: 'admin',  handler: debugCatMedia },

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
  // ⚠️ 调用入口时间戳：客户端对云函数有约 3s 的硬预算（-504003），
  // 而这个预算是**从调用进入算起**的 —— 云函数冷启动 + getMe() 的 DB 往返都发生在
  // handler 之前。识别链路的预算必须由这里起算，否则「handler 内 2.4s」+「前置开销」
  // 必然顶穿 3s（现场表现：每次轮询都 -504003，识别永远不结束）。
  const startedAt = Date.now()
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
      // 错误分类决定微信是否重试：
      //   解析/参数类错误（AppError code=400，如「空的回调数据」）→ 回 0，重试也没用；
      //   DB/网络类临时故障 → 回**非 0**让微信重试。
      // 早期一律回 0：vpay_deliveries 漏建导致 add 抛 -502005 时，
      // 微信认为推送成功不再重试，用户付了钱却没有任何 delivery 记录（资损）。
      const isParseError = e instanceof AppError && Number(e.code) === 400
      if (isParseError) {
        return '<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>'
      }
      return '<xml><ErrCode>1</ErrCode><ErrMsg><![CDATA[internal error, will retry]]></ErrMsg></xml>'
    }
  }

  const ok = data => ({ ok: true, data: data === undefined ? null : data })
  const fail = (msg, code) => ({ ok: false, msg, code: code || 400 })

  // 定时触发器（云开发 timer，在 config.json 里声明）：
  //   event = { Type: 'Timer', TriggerName: 'aiIndexDaily', Time: '...' }
  // 由平台调度发起，没有 WX 上下文（OPENID 为空），走独立白名单分发。
  if (event && (event.Type === 'Timer' || event.type === 'Timer')) {
    return runTimer(event.TriggerName || event.triggerName || '', event)
  }

  const def = ACTIONS[action]
  if (!def) return fail('未知的 action: ' + action, 404)

  try {
    const me = await getMe(openid)
    // 身份主键统一为自建的普通字段 openid（改名/重名都不影响）；
    // 旧文档缺 openid 时即时用微信上下文里的真实 openid 兜底，保证 requireSuper 等判断准确。
    if (me && !me.openid) me.openid = openid
    requireRole(me, def.role)
    const ctx = { openid, wxCtx, action, startedAt }
    // 统一签名：handler(me, event, ctx)
    const data = await withTimeout(Promise.resolve(def.handler(me, event || {}, ctx)), TIMEOUT_MS)
    return ok(data)
  } catch (e) {
    console.error('[catcampus]', action, e && (e.message || e))
    if (e instanceof AppError) return fail(e.message, e.code)
    return fail(e && e.message ? e.message : '服务异常', 500)
  }
}

/* ==================== 定时触发器 ==================== */

/**
 * 定时任务分发。
 *
 * 两条硬规矩：
 *  1. **白名单制**：只放行表内 TriggerName，未知的直接 404 —— 定时器 event 由平台
 *     构造，但也防有人用测试调用手工塞一个 Type:'Timer' 的 event 来触发管理端动作。
 *  2. **不复用 ACTIONS 的 requireRole**：定时触发没有 OPENID，getMe 必然返回 null，
 *     走角色校验只会 401；而它本来就是系统调度，天然具备最高执行权。
 *
 * ⚠️ 预算：定时触发的调用不受客户端约 3s 的限制，但受**云函数自身超时**限制
 * （控制台配置，常见默认 20s，最高 60s）。所以每个任务都必须自带 deadline 分片推进，
 * 且要求幂等 —— 这次没跑完，下一次接着跑。
 */
async function runTimer(name, event) {
  // 运维手工触发（云开发控制台 → 云函数 → 云端测试）时可在 event 里覆盖预算，
  // 不必去改环境变量 —— 定时任务自身不带这些字段，走默认值。
  const budget = Number(event && event.budgetMs) || Number(process.env.AI_INDEX_TIME_BUDGET_MS) || 15000
  const TABLE = {
    // 每天一次：把所有校区档案猫补进服务端特征库（只补缺失的，幂等）
    aiIndexDaily: () => vision.buildIndexAll({ budgetMs: budget }),

    // 整体重建：忽略云库里的 aiIndexAt 记账，全部重新计算（force=true）。
    //
    // 为什么必须有它：换存储介质 / 清空对象存储 / 迁移服务之后，服务端特征库是空的，
    // 但云库里每只猫的 aiIndexAt 还记着「已入库」—— 增量模式的 aiIndexDaily 会把它们
    // **全部跳过**（built=0，桶依然是空的）。只有 force 能打破这个死锁。
    //
    // 只挂在定时器白名单里（需要运维在控制台手工触发），不进 ACTIONS ——
    // 全量重算是重活，不该由小程序端一个按钮就发起。
    aiIndexRebuild: () => vision.buildIndexAll({
      budgetMs: budget,
      photosPerCat: Number(event && event.photosPerCat) || 3,
      force: true
    })
  }

  const fn = TABLE[name]
  if (!fn) {
    console.warn('[timer] 未知的 TriggerName:', name)
    return { ok: false, msg: '未知的定时任务: ' + name, code: 404 }
  }

  try {
    const data = await fn()
    console.log('[timer] ' + name + ' 完成', JSON.stringify({
      processed: data.processed, built: data.built,
      skipped: data.skipped, timedOut: data.timedOut
    }))
    return { ok: true, data }
  } catch (e) {
    console.error('[timer]', name, e && (e.message || e))
    return { ok: false, msg: (e && e.message) || '定时任务执行失败', code: 500 }
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
/**
 * 启动聚合：一次云函数调用拿齐「用户 + 学校 + 首页概览」。
 *
 * 为什么要它：启动链路原本是 login → getSchool → getOverview **三次串行**云调用。
 * `wx.cloud.callFunction` 每次都有固定开销（网络往返 + 实例调度），
 * 串行三次等于把这部分成本乘 3 —— 首页统计卡要等第三轮才渲染。
 * 合并成一次调用后，学校与概览在**同一次实例内并行**取，只付一次固定成本。
 *
 * ⚠️ 失败隔离：概览拉不到（比如学校刚删）不能连累登录 ——
 * 否则整个启动挂掉，前端 user/school 全空，表现为「变成爱猫同学 + 数据像全没了」。
 * 所以学校与概览各自 try/catch，登录本身抛错则让前端走旧路径回落。
 */
async function homeInit(me, event, ctx) {
  const user = await login(me, event, ctx)
  const schoolId = (user && user.schoolId) || ''

  // user 可能被 login 重建/合并过，用最新这份往下传，保证角色与积分口径一致
  const freshMe = Object.assign({}, me || {}, user)

  const schoolP = schoolId
    ? getSchool({ schoolId }).catch(e => {
        console.warn('[homeInit] 学校拉取失败，降级为未绑定', e && e.message)
        return null
      })
    : Promise.resolve(null)

  const overviewP = getOverview(freshMe, Object.assign({}, event, { schoolId }))
    .catch(e => {
      // 概览是增强信息，失败就降级成 null：首页会自己走「无学校引导 / 单独重试」
      console.warn('[homeInit] 概览拉取失败，稍后由页面单独重试', e && e.message)
      return null
    })

  const [school, overview] = await Promise.all([schoolP, overviewP])
  return { user, school, overview }
}

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

  const [catAll, catOnCampus, sterilized, sightingMonth, tnrMonth, taskOpen, funds, recent] = await Promise.all([
    db.collection(COL.cat).where(Object.assign({}, where, { status: _.nin(['rainbow', 'adopted']) })).count(),
    db.collection(COL.cat).where(Object.assign({}, where, { status: 'campus' })).count(),
    db.collection(COL.cat).where(Object.assign({}, where, { sterilized: 'yes', status: _.nin(['rainbow', 'adopted']) })).count(),
    db.collection(COL.sighting).where(Object.assign({}, where, { createdAt: _.gte(monthStart) })).count(),
    db.collection(COL.tnr).where(Object.assign({}, where, { createdAt: _.gte(monthStart) })).count(),
    db.collection(COL.task).where(Object.assign({}, where, { status: 'open' })).count(),
    isMember(me) ? listFundSummary(schoolId) : Promise.resolve({ income: 0, expense: 0 }),
    // 最近目击与上面的统计是**互不依赖**的，必须一起并行：
    // 早先它单独 await 排在 7 个 count 后面，白多一次串行 DB 往返。
    db.collection(COL.sighting).where(where).orderBy('createdAt', 'desc').limit(5).get()
  ])

  const recentData = (recent && recent.data) || []
  const catIds = [...new Set(recentData.map(s => s.catId).filter(Boolean))]
  let catMap = {}
  if (catIds.length) {
    const cats = await db.collection(COL.cat).where({ _id: _.in(catIds) }).get()
    cats.data.forEach(c => { catMap[c._id] = { name: c.name, avatar: c.avatar, status: c.status } })
  }

  // 首页「最新目击」缩略图换 https（同 listSightings，客户端读不到他人私有文件）
  const recentOut = recentData.map(s => Object.assign({}, s, { cat: catMap[s.catId] || null }))
  await maplib.attachSightingMediaUrls(recentOut)

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
    recent: recentOut,
    me: me ? { role: me.role, points: me.points || 0, sightingCount: me.sightingCount || 0, nickName: me.nickName } : null
  }
}

/**
 * 经费汇总（只算收入/支出总额）。
 *
 * ⚠️ 必须做**字段投影**：`fund` 集合里可能存着凭证图、备注等大字段，
 * 而这里只用到 `amount`。不投影就等于为了加几个数把整表搬回来 ——
 * 记录一多，首页启动被这条查询拖垮。
 */
async function listFundSummary(schoolId) {
  const where = schoolId ? { schoolId } : {}
  const pick = q => (typeof q.field === 'function' ? q.field({ amount: true }) : q)
  const [inc, exp] = await Promise.all([
    pick(db.collection(COL.fund).where(Object.assign({}, where, { type: 'income' }))).get(),
    pick(db.collection(COL.fund).where(Object.assign({}, where, { type: 'expense' }))).get()
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

  const list = res.data.map(c => sanitizeCat(c, me))
  // 头像换 https 临时链接（管理端权限，能读环境内所有文件）：
  // 客户端读不到「别人上传的」私有文件，服务端不换就会出现
  // 「自己传的猫有头像、别人传的空白」。列表只要头像，不换 photos（省一次批量调用）。
  await maplib.attachCatMediaUrls(list, { photos: false })

  return {
    list,
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
  const catOut = sanitizeCat(cat, me)
  const sightOut = sightings.data.map(s => sanitizeSighting(s, me))
  // 档案详情：头像 + 相册 + 目击照片一并换 https（详情页照片多，上限内一次批量够用）
  await maplib.attachCatMediaUrls([catOut])
  await maplib.attachSightingMediaUrls(sightOut)
  return {
    cat: catOut,
    sightings: sightOut,
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
    // 清空「已入库」标记：建档或改档（尤其是换照片）后，服务端特征库需要重新收录。
    // 之后的第一次识别会顺带把这只猫的照片带给服务端补算（见 lib/vision.js 的
    // pickPendingIndexCats），所以管理员不必手动点「建库」。
    aiIndexAt: null,
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

/**
 * 一键生成「游客体验数据」（仅超管，幂等）。
 *
 * 目的：审核员以游客身份进入小程序，猫谱/地图/首页若全是空页，
 * 极易被判「页面功能不完整」而拒审。这里把演示数据造齐。
 *
 * 规则（安全阀）：
 *  - 已绑定学校则直接用；没绑定才创建示范学校，并把自己绑上去
 *  - 本校已有猫档案则整体跳过 —— 绝不往真实数据里混演示猫
 *  - 演示猫不带照片（猫卡显示首字母占位），坐标按学校中心做百米级偏移
 *  - 直接落库、不走 secCheck：内容是代码里写死的受控文案，且不烧检测配额
 * 审核通过后如需清理：管理员在猫谱页对演示猫逐个「删除」即可。
 */
/**
 * 头像/照片「为什么空白」的现场取证。
 *
 * 判读方法（rows[].media 每项的 kind）：
 *  - cloud   ：云存储 fileID。看 status —— 0=文件正常（换链成功）；
 *              非 0 = 文件已不存在或无权限，这就是空白根因，重新上传一张即可。
 *  - http    ：外部 http(s) 地址。若指向 127.0.0.1/localhost 这类本机地址，
 *              换设备必然加载不出来。
 *  - local   ：wxfile:// / http://tmp 之类的**本机临时路径**——
 *              说明建档时没上传成功就把本地路径存进了库，必须重新上传。
 *  - empty   ：字段本身为空，即这只猫压根没设头像（占位图是正常表现）。
 */
async function debugCatMedia(me, event) {
  requireRole(me, 'admin')
  const schoolId = resolveSchoolId(me, event)
  const where = schoolId ? { schoolId } : {}
  let q = db.collection(COL.cat).where(where)
  if (event.name) q = q.where({ name: event.name })
  const res = await q.limit(50).get()

  const rows = res.data.map(c => {
    const media = []
    if (c.avatar) media.push(c.avatar)
    ;(Array.isArray(c.photos) ? c.photos : []).forEach(p => media.push(p))
    return {
      _id: c._id,
      name: c.name,
      schoolId: c.schoolId || '',
      avatar: c.avatar || '',
      photoCount: (Array.isArray(c.photos) ? c.photos : []).length,
      aiIndexAt: c.aiIndexAt || null,
      media: media.map(m => ({
        value: m,
        kind: /^cloud:\/\//.test(m) ? 'cloud'
          : (/^https?:\/\//.test(m) ? (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(m) ? 'local-http' : 'http') : 'local')
      }))
    }
  })
  const probes = await maplib.probeTempUrls(rows.reduce((a, r) => a.concat(r.media.map(m => m.value)), []))
  const pmap = {}
  probes.forEach(p => { pmap[p.fileID] = p })
  rows.forEach(r => {
    r.media.forEach(m => {
      if (m.kind === 'cloud') {
        const p = pmap[m.value] || {}
        m.urlOk = !!p.hasUrl
        m.status = p.status
        m.errMsg = p.errMsg
      }
    })
    if (!r.avatar) r.hint = (r.photoCount ? 'avatar 为空但有相册（已由服务端回退用 photos[0]）' : '没有任何照片，占位图是正常表现')
  })
  return { schoolId, total: rows.length, rows }
}

async function seedDemoData(me, event) {
  requireSuper(me)
  let schoolId = me.schoolId || ''
  let school = null
  if (schoolId) {
    const s = await db.collection(COL.school).doc(schoolId).get().catch(() => null)
    school = s && s.data
  }
  if (!school) {
    const geo = normalizeSchoolGeo({ center: { lat: 32.0585, lng: 118.7965 }, scale: 16 })
    school = {
      name: '喵园示范校区', campus: '', city: '南京市',
      center: geo.center, bounds: geo.bounds, scale: geo.scale,
      intro: '校园流浪猫救助与信息查询示范点',
      createdBy: me.openid, createdAt: new Date()
    }
    const add = await db.collection(COL.school).add({ data: school })
    schoolId = add._id
    await db.collection(COL.user).doc(me._id).update({ data: { schoolId } }).catch(() => {})
  }

  const exist = await db.collection(COL.cat).where({ schoolId }).count()
  if (exist.total > 0) {
    return { schoolId, skipped: true, reason: '本校已有猫档案，不混入演示数据', total: exist.total }
  }

  const c = (school.center && isFinite(school.center.lat)) ? school.center : { lat: 32.0585, lng: 118.7965 }
  const demo = [
    { name: '大橘', pattern: 'orange', sex: 'male', sterilized: 'yes', health: 'good',
      characters: ['friendly', 'foodie'], colorNote: '橘白爪，圆脸', earMark: '左耳缺口',
      locationName: '一食堂后门花坛', location: { lat: c.lat + 0.0012, lng: c.lng + 0.0008 },
      note: '饭点准时出现，亲人可摸，全校最贪吃的一只。' },
    { name: '狸花', pattern: 'tabby', sex: 'female', sterilized: 'no', health: 'good',
      characters: ['shy'], colorNote: '标准狸花条纹', earMark: '',
      locationName: '图书馆东侧草坪', location: { lat: c.lat - 0.0015, lng: c.lng + 0.0010 },
      note: '警惕性高，请保持距离投喂，已列入 TNR 排期。' },
    { name: '奶牛', pattern: 'cow', sex: 'male', sterilized: 'yes', health: 'good',
      characters: ['playful', 'foodie'], colorNote: '黑白块分明', earMark: '右耳缺口',
      locationName: '宿舍区3栋楼下', location: { lat: c.lat + 0.0006, lng: c.lng - 0.0012 },
      note: '活泼好动，爱和同学玩逗猫棒。' },
    { name: '小白', pattern: 'white', sex: 'unknown', sterilized: 'yes', health: 'good',
      characters: ['quiet', 'shy'], colorNote: '纯白，蓝眼睛', earMark: '',
      locationName: '操场看台下方', location: { lat: c.lat - 0.0008, lng: c.lng - 0.0015 },
      note: '胆小怕生，远距离观察即可，请勿追赶。' },
    { name: '三花', pattern: 'calico', sex: 'female', sterilized: 'unknown', health: 'good',
      characters: ['friendly'], colorNote: '三花，尾尖白', earMark: '',
      locationName: '教学楼A栋南侧', location: { lat: c.lat + 0.0018, lng: c.lng - 0.0006 },
      note: '喜欢下午晒太阳，偶遇率最高。' }
  ]
  const now = new Date()
  let created = 0
  for (const d of demo) {
    await db.collection(COL.cat).add({
      data: Object.assign({}, d, {
        status: 'campus',
        spotPrivate: false,
        avatar: '', photos: [],
        birthday: '', relations: [],
        internalNote: '', medicalNote: '',
        schoolId, sightingCount: 0,
        createdBy: me.openid, updatedBy: me.openid,
        createdAt: now, updatedAt: now
      })
    })
    created++
  }
  return { schoolId, schoolName: school.name, created }
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

/** 投喂状态白名单（与小程序 utils/const.js 的 FEED_STATUS 保持一致，前后端各维护一份） */
const FEED_STATUS_VALUES = ['passed', 'fed', 'fedByOther']

/** 健康观察白名单 —— 必须与小程序 utils/const.js 的 C.HEALTH 逐值对齐。
 *  曾出现后端用 ['unknown','healthy','sick','injured','suspected']、前端用
 *  good/cold/ringworm/stomatitis/eye/injured/severe/unknown 的口径不一致：
 *  用户在打卡页选「感冒/猫藓/口炎」编辑保存时被后端静默丢弃，只有 injured/unknown 能改。 */
const HEALTH_VALUES = ['good', 'cold', 'ringworm', 'stomatitis', 'eye', 'injured', 'severe', 'unknown']

/** 目击行为标签白名单 —— 与小程序 utils/const.js 的 C.SIGHT_BEHAVIOR 逐值对齐。
 *  ⚠️ 合规背景（2026-10-16 审核驳回「社交-笔记」）：
 *    原打卡页有自由文本 textarea「它在做什么？」，审核认定「用户自行生成文字 + 图片 + 公开可见」
 *    属社交-笔记（个人主体未开放类目）。改为**预设标签多选**后形态变为「登记猫况」。
 *    白名单服务端必须再过滤一次：客户端可被篡改，不能信任任意字符串。
 *    新增项只写**客观状态**，不要加主观评价/情绪类词汇（否则又回到"创作"形态）。 */
const SIGHT_BEHAVIOR_VALUES = [
  'resting', 'eating', 'moving', 'playing', 'hiding', 'alert', 'withOthers', 'unusual'
]

async function addSighting(me, event) {
  const d = event.data || {}
  await sec.assertSightingSafe(d)

  const now = new Date()
  const photos = (d.photos || []).slice(0, 6)
  const schoolId = d.schoolId || me.schoolId || ''
  assertSchool(me, schoolId)

  // 首次遇见（图鉴解锁）判定：必须用「条件更新 catSeen」原子完成。
  // 旧写法读的是请求开始时的用户快照（me.catSeen）——两条并发打卡同猫都读不到
  // 对方刚 push 的 catId，会双双判定 firstMeet 各发 20 分（日上限只削峰值不防重复）。
  // 现在把标记提到发奖之前：updated===1 表示本次调用真正把它加进了图鉴，
  // 并发下只有一个请求能更新成功，天然幂等。
  let firstMeet = false
  if (d.catId) {
    const mark = await db.collection(COL.user)
      .where({ _id: me._id, catSeen: _.nin([d.catId]) })
      .update({ data: { catSeen: _.push([d.catId]) } })
    firstMeet = !!(mark && mark.stats && mark.stats.updated)
  }
  const isNewCat = !d.catId

  // 投喂状态：白名单校验，非法值 / 老客户端不传 → 回落「路过」
  const feedStatus = FEED_STATUS_VALUES.indexOf(d.feedStatus) >= 0 ? d.feedStatus : 'passed'
  const isFedByMe = feedStatus === 'fed'

  // 行为标签：白名单过滤（合规改造，替代原自由文本「描述」）。
  // 只接受预设枚举内的值 —— 客户端若被篡改塞入任意字符串，这里直接丢掉。
  // 老客户端仍可能只传 note（自由文本），下面 note 统一截断到 20 字兜底。
  const behaviors = Array.isArray(d.behaviors)
    ? d.behaviors.filter(b => SIGHT_BEHAVIOR_VALUES.indexOf(b) >= 0).slice(0, 8)
    : []

  const doc = {
    catId: d.catId || '',
    catName: d.catName || (d.catId ? '' : '未认领的新猫'),
    pending: !d.catId,
    location: d.location || null,
    locationName: d.locationName || '',
    photos,
    health: HEALTH_VALUES.indexOf(d.health) >= 0 ? d.health : 'unknown',
    feedStatus,
    behaviors,
    // 补充限 20 字：原为自由描述，合规改造后只留极短结构化补充
    note: String(d.note || '').slice(0, 20),
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
  // 投喂奖励：仅「本人投喂」发放；照片是投喂佐证（防刷），有图再叠加一笔
  const g4 = isFedByMe ? await points.grant(me, 'feed', null, { refType: 'sighting', refId: add._id }) : { gained: 0 }
  const g5 = (isFedByMe && photos.length)
    ? await points.grant(me, 'feedPhoto', null, { refType: 'sighting', refId: add._id })
    : { gained: 0 }
  const grants = [g1, g2, g3, g4, g5]
  const total = grants.reduce((acc, g) => acc + (g.gained || 0), 0)
  await db.collection(COL.sighting).doc(add._id).update({ data: { points: total } })
  doc.points = total

  // 图鉴标记已在发奖前条件更新完成，这里只累加打卡次数
  await db.collection(COL.user).doc(me._id).update({ data: { sightingCount: _.inc(1) } })

  if (d.catId) {
    const catPatch = { sightingCount: _.inc(1), lastSeenAt: now, lastSeenBy: me.nickName || '' }
    // 本人投喂：同步「最近投喂」，避免多人重复投喂同一处
    if (isFedByMe) {
      catPatch.lastFedAt = now
      catPatch.lastFedBy = me.nickName || ''
    }
    await db.collection(COL.cat).doc(d.catId).update({ data: catPatch }).catch(() => {})
  }

  return Object.assign({}, doc, {
    _id: add._id,
    pointsGained: total,
    firstMeet,
    feedStatus,
    feedGained: (g4.gained || 0) + (g5.gained || 0),
    // 积分明细（前端弹窗展示用，数额以云端为准，避免前后端各写一份）
    pointsDetail: {
      base: g1.gained || 0,
      firstMeet: g2.gained || 0,
      newCat: g3.gained || 0,
      feed: g4.gained || 0,
      feedPhoto: g5.gained || 0
    },
    dailyCapped: !!(g1.capped || g3.capped || g4.capped || g5.capped),
    // 取最后一笔的 today（当日累计，含前面所有发放）
    pointsToday: grants.reduce((acc, g) => (g && g.today != null ? g.today : acc), 0)
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
  const list = res.data.map(s => Object.assign(sanitizeSighting(s, me), { cat: catMap[s.catId] || null }))
  // 目击照片换 https 临时链接：客户端读不到「别人上传的」私有文件，
  // 不换就会「自己发的图能看、别人发的图空白」。
  await maplib.attachSightingMediaUrls(list)
  return {
    list,
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
  if (d.health && HEALTH_VALUES.indexOf(d.health) >= 0) patch.health = d.health
  if (typeof d.locationName === 'string') patch.locationName = d.locationName
  if (Number(d.count) > 0) patch.count = Number(d.count)
  await db.collection(COL.sighting).doc(event.id).update({ data: patch })
  return { ok: true }
}

async function deleteSighting(me, event) {
  if (!event.id) throw new AppError('缺少记录 ID')
  const res = await db.collection(COL.sighting).doc(event.id).get()
  assertSightingOwner(me, res.data)
  const s = res.data || {}
  // 删除一条发过积分的记录，必须连积分一起撤销，否则出现
  // 「打卡次数少了、猫粮值还在、流水还挂着」的账实不符。
  // 老记录没有 points 字段（后加的），积分部分跳过，计数仍回退。
  if (s.points > 0) {
    const u = await db.collection(COL.user).doc(me._id).get()
    const cur = u.data || {}
    const back = Math.min(Number(s.points) || 0, Number(cur.points) || 0)
    const next = Math.max(0, (Number(cur.points) || 0) - (Number(s.points) || 0))
    if (back > 0) {
      await db.collection(COL.user).doc(me._id).update({ data: { points: next } }).catch(() => {})
      // 负向流水，保持「余额 = 流水累加」可对账（points 页会显示 -N）
      await db.collection(COL.point).add({
        data: {
          openid: me.openid,
          userId: me._id,
          kind: 'revoke',
          reason: '删除目击记录退回',
          delta: -back,
          balance: next,
          refType: 'sighting',
          refId: event.id,
          createdAt: new Date()
        }
      }).catch(() => {})
    }
  }
  await db.collection(COL.user).doc(me._id)
    .update({ data: { sightingCount: _.inc(-1) } }).catch(() => {})
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
  // 并发抢单防护：check-then-update 之间另一个用户的认领会落库、后写者静默覆盖。
  // 必须用「带条件的更新」——stats.updated === 0 说明条件已不满足（被抢/非本人）。
  const where = event.cancel
    ? { _id: event.id, assignee: me.openid }
    : { _id: event.id, status: 'open' }
  const upd = await db.collection(COL.task).where(where).update({
    data: {
      status: event.cancel ? 'open' : 'claimed',
      assignee: event.cancel ? '' : me.openid,
      assigneeName: event.cancel ? '' : (me.nickName || ''),
      updatedAt: new Date()
    }
  })
  if (!upd || !upd.stats || !upd.stats.updated) {
    throw new AppError(event.cancel ? '只能取消自己认领的任务' : '该任务已被认领', event.cancel ? 403 : 409)
  }
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
  const list = res.data.map(u => ({
    _id: u._id,
    nickName: u.nickName,
    avatarUrl: u.avatarUrl,
    role: u.role,
    isSuper: isSuper({ openid: u.openid || u._openid }),
    points: u.points || 0,
    sightingCount: u.sightingCount || 0,
    lastSeenAt: u.lastSeenAt || null
  }))
  // 成员头像换 https：客户端读不到「别人上传的」私有文件，
  // 不换就会「自己的头像正常、其他成员都是一片空白」。
  const avatarIds = list.map(u => u.avatarUrl)
    .filter(v => typeof v === 'string' && v.indexOf('cloud://') === 0)
  const avatarMap = avatarIds.length ? await maplib.fetchTempUrls(avatarIds) : {}
  list.forEach(u => { if (avatarMap[u.avatarUrl]) u.avatarUrl = avatarMap[u.avatarUrl] })
  return list
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
