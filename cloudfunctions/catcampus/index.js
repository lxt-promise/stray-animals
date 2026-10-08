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
  isMember, isAdmin, requireRole,
  resolveSchoolId, assertSchool,
  sanitizeCat, sanitizeSighting, escapeReg, pageOf, dayKey
} = core

/* ==================== action 注册表 ====================
 * role: public | user | member | admin
 */
const ACTIONS = {
  /* 用户 & 学校 */
  'login':          { role: 'public', handler: login },
  'updateProfile':  { role: 'user',   handler: updateProfile },
  'createSchool':   { role: 'admin',  handler: createSchool },
  'listSchools':    { role: 'public', handler: listSchools },
  'getSchool':      { role: 'public', handler: getSchool },
  'bindSchool':     { role: 'user',   handler: bindSchool },

  /* 概览 */
  'getOverview':    { role: 'public', handler: getOverview },

  /* 猫档案 */
  'listCats':       { role: 'public', handler: listCats },
  'getCat':         { role: 'public', handler: getCat },
  'saveCat':        { role: 'member', handler: saveCat },
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

async function getMe(openid) {
  if (!openid) return null
  const res = await db.collection(COL.user).where({ _openid: openid }).limit(1).get()
  return res.data[0] || null
}

/* ==================== 用户 & 学校 ==================== */

async function login(me, event, ctx) {
  const openid = ctx && ctx.openid
  if (!openid) throw new AppError('无法获取用户身份', 401)
  const now = new Date()
  if (me) {
    await db.collection(COL.user).doc(me._id).update({ data: { lastSeenAt: now } })
    return Object.assign({}, me, { openid, pointsToday: me.pointsDay === dayKey() ? (me.pointsToday || 0) : 0 })
  }
  // 首个用户自动成为管理员
  const total = await db.collection(COL.user).count()
  const isFirst = total.total === 0
  const doc = {
    _openid: openid,
    nickName: event.nickName || '爱猫同学',
    avatarUrl: event.avatarUrl || '',
    role: isFirst ? 'admin' : 'visitor',
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
  return Object.assign({}, doc, { _id: add._id, openid })
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
  if (!event.name) throw new AppError('缺少学校名称')
  const textOk = await sec.checkText([event.name, event.campus, event.intro].filter(Boolean).join(' '))
  if (!textOk) throw new AppError('内容未通过安全检测')
  const doc = {
    name: event.name,
    campus: event.campus || '',
    city: event.city || '',
    center: event.center || null,     // { lat, lng } 地图默认中心
    scale: event.scale || 16,
    intro: event.intro || '',
    createdBy: me._openid,
    createdAt: new Date()
  }
  const add = await db.collection(COL.school).add({ data: doc })
  await db.collection(COL.user).doc(me._id).update({ data: { schoolId: add._id } })
  return Object.assign({}, doc, { _id: add._id })
}

async function listSchools() {
  const res = await db.collection(COL.school).orderBy('createdAt', 'asc').limit(50).get()
  return res.data
}

async function getSchool(event) {
  if (!event.schoolId) return null
  const res = await db.collection(COL.school).doc(event.schoolId).get()
  return res.data
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
    canEdit: isMember(me)
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
    updatedBy: me._openid,
    updatedAt: now
  }

  if (d._id) {
    await db.collection(COL.cat).doc(d._id).update({ data: payload })
    return { _id: d._id }
  }
  payload.createdAt = now
  payload.createdBy = me._openid
  payload.sightingCount = 0
  const add = await db.collection(COL.cat).add({ data: payload })
  return { _id: add._id }
}

async function removeCat(me, event) {
  await db.collection(COL.cat).doc(event.id).remove()
  return { _id: event.id }
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
    reporter: me._openid,
    reporterName: me.nickName || '',
    createdAt: now
  }

  // 积分走事务发放，日上限不会被并发打卡突破
  const g1 = await points.grant(me, 'sighting')
  const g2 = firstMeet ? await points.grant(me, 'firstMeet') : { gained: 0 }
  const g3 = isNewCat ? await points.grant(me, 'newCat') : { gained: 0 }
  const total = (g1.gained || 0) + (g2.gained || 0) + (g3.gained || 0)
  doc.points = total

  const add = await db.collection(COL.sighting).add({ data: doc })

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
  if (event.mine && me) where.reporter = me._openid

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
    updatedBy: me._openid,
    updatedAt: now
  }
  tnr.autoDates(payload, from, to, now)

  const catPatch = tnr.catSyncPatch(to, payload.earMark)
  const isCreate = !d._id
  if (isCreate) {
    payload.createdAt = now
    payload.createdBy = me._openid
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

  if (isCreate) await points.grant(me, 'tnrHelp')

  return { ok: true, _id: d._id || '', status: to, catSynced: !!(payload.catId && catPatch) }
}

/* ==================== 任务排班 ==================== */

async function listTasks(me, event) {
  const schoolId = resolveSchoolId(me, event)
  assertSchool(me, schoolId)
  const where = schoolId ? { schoolId } : {}
  if (event.status) where.status = event.status
  if (event.mine && me) where.assignee = me._openid
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
    updatedBy: me._openid,
    updatedAt: now
  }
  if (d._id) {
    await db.collection(COL.task).doc(d._id).update({ data: payload })
  } else {
    payload.createdAt = now
    payload.createdBy = me._openid
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
  if (event.cancel && t.assignee !== me._openid) throw new AppError('只能取消自己认领的任务', 403)

  await db.collection(COL.task).doc(event.id).update({
    data: {
      status: event.cancel ? 'open' : 'claimed',
      assignee: event.cancel ? '' : me._openid,
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
    createdBy: me._openid,
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
    points: u.points || 0,
    sightingCount: u.sightingCount || 0,
    lastSeenAt: u.lastSeenAt || null
  }))
}

async function setRole(me, event) {
  if (!['visitor', 'member', 'admin'].includes(event.role)) throw new AppError('角色非法')
  if (event.userId === me._id && event.role !== 'admin') {
    throw new AppError('不能降级自己（避免失去管理权限）')
  }
  await db.collection(COL.user).doc(event.userId).update({
    data: { role: event.role, updatedAt: new Date(), schoolId: me.schoolId || '' }
  })
  return { ok: true }
}

async function applyJoin(me, event) {
  if (isMember(me)) return { status: 'already' }
  const exist = await db.collection(COL.apply)
    .where({ _openid: me._openid, status: 'pending' }).limit(1).get()
  if (exist.data.length) return { status: 'pending' }

  const textOk = await sec.checkText([event.reason, event.experience, event.contact].filter(Boolean).join(' '))
  if (!textOk) throw new AppError('内容未通过安全检测')

  await db.collection(COL.apply).add({
    data: {
      _openid: me._openid,
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
    const u = await db.collection(COL.user).where({ _openid: apply.data._openid }).limit(1).get()
    if (u.data[0]) {
      await db.collection(COL.user).doc(u.data[0]._id).update({
        data: { role: 'member', schoolId: apply.data.schoolId || me.schoolId || '' }
      })
    }
  }
  return { ok: true }
}
