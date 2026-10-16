/**
 * 云函数离线冒烟测试台
 * 用内存数据库桩替代 wx-server-sdk，真跑一遍路由与核心逻辑。
 * 运行：node scripts/_cf_test.cjs
 */
const Module = require('module')
const path = require('path')

/* ============ 内存数据库桩 ============ */
const store = {}
let autoId = 0
const nextId = () => 'doc_' + (++autoId)

const op = (kind, v) => ({ __op: kind, v })
const _cmd = {
  inc: n => op('inc', n),
  push: arr => op('push', arr),
  nin: arr => op('nin', arr),
  in: arr => op('in', arr),
  gte: v => op('gte', v),
  lte: v => op('lte', v),
  lt: v => op('lt', v),
  gt: v => op('gt', v),
  neq: v => op('neq', v),
  or: arr => op('or', arr)
}

function matchCond(doc, cond) {
  // _.or([...]) 作为整个 where 条件出现：任一支满足即命中
  if (cond && cond.__op === 'or') return (cond.v || []).some(sub => matchCond(doc, sub))
  return Object.keys(cond).every(k => {
    const want = cond[k]
    const got = doc[k]
    if (want && want.__op) {
      switch (want.__op) {
        case 'nin': return !(want.v || []).includes(got)
        case 'in': return (want.v || []).includes(got)
        case 'gte': return got >= want.v
        case 'lte': return got <= want.v
        case 'lt': return got < want.v
        case 'gt': return got > want.v
        // _.neq 语义与 MongoDB $ne 一致：字段必须存在且不等于目标值
        // （缺字段 undefined !== null 会误判为命中，必须显式排除）
        case 'neq': return got !== undefined && got !== want.v
        default: return true
      }
    }
    if (want && want.__regexp) return new RegExp(want.__regexp, want.__options || '').test(String(got || ''))
    if (k === '_id') return got === want
    return got === want
  })
}

function applyUpdate(doc, data) {
  Object.keys(data).forEach(k => {
    const v = data[k]
    if (v && v.__op === 'inc') doc[k] = (Number(doc[k]) || 0) + v.v
    else if (v && v.__op === 'push') doc[k] = (doc[k] || []).concat(v.v)
    else doc[k] = v
  })
}

function makeQuery(col) {
  const list = () => (store[col] = store[col] || [])
  const q = {
    _filters: [], _order: null, _limit: 1e9, _skip: 0, _field: null,
    where(c) { this._filters.push(c); return this },
    orderBy(f, d) { this._order = { f, d }; return this },
    limit(n) { this._limit = n; return this },
    skip(n) { this._skip = n; return this },
    // 字段投影（云数据库 .field()）：只返回 proj 中为 true 的字段，_id 始终保留
    field(proj) { this._field = proj; return this },
    _matched() {
      let rows = list().filter(d => this._filters.every(f => matchCond(d, f)))
      if (this._order) {
        const { f, d } = this._order
        rows.sort((a, b) => (d === 'desc' ? (b[f] > a[f] ? 1 : -1) : (a[f] > b[f] ? 1 : -1)))
      }
      return rows.slice(this._skip, this._skip + this._limit)
    },
    async get() {
      let rows = this._matched()
      if (this._field) {
        rows = rows.map(d => {
          const o = { _id: d._id }
          Object.keys(this._field).forEach(k => { if (this._field[k] && k !== '_id') o[k] = d[k] })
          return o
        })
      }
      return { data: JSON.parse(JSON.stringify(rows)) }
    },
    async count() { return { total: list().filter(d => this._filters.every(f => matchCond(d, f))).length } },
    async update({ data }) {
      const rows = list().filter(d => this._filters.every(f => matchCond(d, f)))
      rows.forEach(d => applyUpdate(d, data))
      return { stats: { updated: rows.length } }
    },
    async remove() {
      const rows = list().filter(d => this._filters.every(f => matchCond(d, f)))
      store[col] = list().filter(d => rows.indexOf(d) < 0)
      return { stats: { removed: rows.length } }
    },
    doc(id) { return makeDoc(col, id) },
    async add({ data }) {
      const doc = Object.assign({}, data)
      if (!doc._id) doc._id = nextId()
      list().push(doc)
      return { _id: doc._id }
    }
  }
  return q
}

function makeDoc(col, id) {
  const list = () => (store[col] = store[col] || [])
  return {
    async get() {
      const d = list().find(x => x._id === id)
      return { data: d ? JSON.parse(JSON.stringify(d)) : null }
    },
    async update({ data }) {
      const d = list().find(x => x._id === id)
      if (!d) throw new Error('doc not found: ' + id)
      applyUpdate(d, data)
      return { stats: { updated: 1 } }
    },
    async remove() {
      store[col] = list().filter(x => x._id !== id)
      return { stats: { removed: 1 } }
    }
  }
}

let txLock = Promise.resolve()

const fakeDb = {
  collection: col => makeQuery(col),
  command: _cmd,
  RegExp: ({ regexp, options }) => ({ __regexp: regexp, __options: options }),
  // 真实云开发事务具备隔离性（写冲突会失败重试），这里用互斥锁模拟串行化，
  // 否则测试无法反映「读-改-写」竞态是否被真正挡住
  async runTransaction(fn) {
    const prev = txLock
    let release
    txLock = new Promise(r => { release = r })
    await prev
    try {
      return await fn({ collection: col => makeQuery(col) })
    } finally {
      release()
    }
  },
  // 集合自愈（warmCollection/ensureCollection 用）：内存桩里建表即建数组
  async createCollection(name) {
    store[name] = store[name] || []
    return true
  }
}

const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test',
  init() {},
  database: () => fakeDb,
  getWXContext: () => ({ OPENID: currentOpenid }),
  openapi: {
    security: {
      async msgSecCheck() { return { errCode: 0 } },
      async imgSecCheck() { return { errCode: 0 } },
      async mediaCheckAsync() { return { traceId: 't1' } }
    }
  },
  async downloadFile() { return { fileContent: Buffer.from([1, 2, 3]) } },
  async getTempFileURL({ fileList }) {
    // fileID 里含 missing 的模拟「文件已不存在」：status 非 0 且无临时链接
    return {
      fileList: fileList.map(f => (/missing/.test(f)
        ? { fileID: f, tempFileURL: '', status: -1, errMsg: '文件不存在' }
        : { fileID: f, tempFileURL: 'https://x/' + encodeURIComponent(f), status: 0 }))
    }
  }
}

let currentOpenid = ''

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return fakeCloud
  return origLoad.apply(this, arguments)
}

/* ============ 加载被测云函数 ============ */
const CF = path.resolve(__dirname, '..', 'cloudfunctions', 'catcampus', 'index.js')
// 超管名单在 core.js 模块加载时从环境变量读取，必须在 require 之前注入，
// 否则 createSchool/updateSchool 等超管 action 会一律 403（测试台的 openid 是 u_admin）
process.env.SUPER_ADMIN_OPENIDS = process.env.SUPER_ADMIN_OPENIDS || 'u_admin'
const { main } = require(CF)

/* ============ 断言工具 ============ */
let pass = 0, fail = 0
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')) }
}
const as = (u, action, event) => { currentOpenid = u || ''; return main(Object.assign({ action }, event || {})) }

async function run() {
  console.log('\n=== 1. 路由与权限 ===')
  let r = await as('u_admin', 'noSuchAction')
  assert('未知 action 返回 404', r.ok === false && r.code === 404, r)

  // 建管理员
  r = await as('u_admin', 'login', { nickName: '管理员' })
  assert('首个用户自动成为 admin', r.ok && r.data.role === 'admin', r)
  const adminId = r.data._id

  r = await as('u_guest', 'login', {})
  assert('第二个用户为 visitor', r.ok && r.data.role === 'visitor', r)
  const guestId = r.data._id

  r = await as('u_guest', 'saveCat', { data: { name: '测试猫' } })
  assert('visitor 建档被拒 403', r.ok === false && r.code === 403, r)

  r = await as('', 'listCats', {})
  assert('未登录也能看公开猫谱', r.ok === true, r)

  console.log('\n=== 2. 学校与多校隔离 ===')
  r = await as('u_admin', 'createSchool', { name: '示例大学', center: { lat: 30.5, lng: 114.3 } })
  assert('管理员建校成功', r.ok && !!r.data._id, r)
  const schoolId = r.data._id

  r = await as('u_admin', 'saveCat', { data: { name: '橘座', pattern: 'orange', colorNote: '橘色', location: { lat: 30.5001, lng: 114.3001 }, internalNote: '怕生', schoolId } })
  assert('成员建档成功', r.ok && !!r.data._id, r)
  const catId = r.data._id

  r = await as('u_guest', 'listCats', { schoolId })
  const guestCat = r.data.list[0]
  assert('游客看不到内部备注', guestCat && guestCat.internalNote === undefined, guestCat)
  assert('游客看到坐标已脱敏字段', guestCat && guestCat.location !== undefined)

  r = await as('u_admin', 'listCats', { schoolId })
  assert('成员可见内部备注', r.data.list[0].internalNote === '怕生', r.data.list[0])

  console.log('\n=== 3. TNR 状态机 ===')
  r = await as('u_admin', 'saveTnr', { data: { catId, status: 'todo', schoolId } })
  assert('新建 TNR 待抓捕', r.ok && r.data.status === 'todo', r)
  const tnrRows = store['tnr_records']
  const tnrId = tnrRows[tnrRows.length - 1]._id

  r = await as('u_admin', 'saveTnr', { data: { _id: tnrId, catId, status: 'released', schoolId } })
  assert('待抓捕 → 已放归 被拒（跳级）', r.ok === false && r.code === 400, r)

  r = await as('u_admin', 'saveTnr', { data: { _id: tnrId, catId, status: 'trapped', schoolId } })
  assert('待抓捕 → 已抓捕 通过', r.ok && r.data.status === 'trapped', r)
  assert('自动回填抓捕日期', !!tnrRows.find(t => t._id === tnrId).trapDate, tnrRows.find(t => t._id === tnrId))

  r = await as('u_admin', 'saveTnr', { data: { _id: tnrId, catId, status: 'released', earMark: '左耳', schoolId } })
  assert('已抓捕 → 已放归 通过', r.ok && r.data.status === 'released', r)
  const catAfter = store['cats'].find(c => c._id === catId)
  assert('放归同步猫档案为已绝育', catAfter.sterilized === 'yes' && catAfter.earMark === '左耳', catAfter)

  r = await as('u_admin', 'saveTnr', { data: { _id: tnrId, catId, status: 'trapped', schoolId } })
  assert('已放归 → 已捕获 被拒（回跳）', r.ok === false && r.code === 400, r)
  assert('错误文案列出允许的流转', /允许变更为/.test(r.msg), r.msg)

  r = await as('u_admin', 'saveTnr', { data: { _id: tnrId, catId, status: 'adopted', schoolId } })
  assert('已放归 → 转领养 通过', r.ok && r.data.status === 'adopted', r)

  r = await as('u_admin', 'saveTnr', { data: { _id: tnrId, catId, status: 'todo', schoolId } })
  assert('终态（转领养）不可再变更', r.ok === false && r.code === 400, r)
  assert('终态提示文案正确', /终态/.test(r.msg), r.msg)

  console.log('\n=== 4. 积分并发与日上限 ===')
  // 给游客 8 次并发打卡
  const results = await Promise.all(
    Array.from({ length: 8 }).map(() => as('u_guest', 'addSighting', { data: { note: '看到一只猫', schoolId } }))
  )
  assert('并发打卡全部成功', results.every(x => x.ok), results.filter(x => !x.ok))
  const guest = store['users'].find(u => u._id === guestId)
  const gained = results.reduce((a, b) => a + (b.data.pointsGained || 0), 0)
  assert('积分总额未超日上限 60', guest.points <= 60 && guest.pointsToday <= 60, { points: guest.points, gained })
  assert('用户积分与发放总额一致', guest.points === gained, { points: guest.points, gained })

  console.log('\n=== 5. AI 识别 ===')
  r = await as('u_guest', 'recognize', { fileId: 'cloud://demo/a.jpg', type: 'image', schoolId })
  assert('本地引擎返回候选', r.ok && Array.isArray(r.data.candidates) && r.data.candidates.length > 0, r)
  assert('候选带分数与理由', r.data.candidates[0].score >= 0 && typeof r.data.candidates[0].reason === 'string', r.data.candidates[0])
  assert('返回低置信标记', typeof r.data.lowConfidence === 'boolean', r.data)
  assert('返回 taskId 供确认', !!r.data.taskId, r.data)
  const imgTaskId = r.data.taskId

  r = await as('u_guest', 'confirmRecognize', { taskId: imgTaskId, catId, correct: true })
  assert('人工确认成功', r.ok === true, r)
  assert('确认后解锁图鉴', (store['users'].find(u => u._id === guestId).catSeen || []).includes(catId))
  assert('确认样本已落库', (store['ai_samples'] || []).length === 1, store['ai_samples'])

  // 视频：异步任务 + 轮询。
  // ⚠️ 2026-10-13 起语义变化：每次轮询只推进一个步骤（分步续跑，保 3s 客户端预算），
  // 必须轮询到终局，不能再期待「一次 poll 跑完整条链路」。
  r = await as('u_guest', 'recognizeStart', { fileId: 'cloud://demo/v.mp4', type: 'video', duration: 10, thumbId: 'cloud://demo/v.jpg', schoolId })
  assert('视频任务创建成功', r.ok && r.data.status === 'pending', r)
  const vTaskId = r.data.taskId

  let vPolls = 0
  let vDone = null
  while (vPolls < 20) {
    vPolls++
    r = await as('u_guest', 'recognizePoll', { taskId: vTaskId })
    if (r.ok && r.data.status === 'done') { vDone = r.data; break }
    if (r.ok && r.data.status === 'failed') break
  }
  assert('轮询到终局并完成', !!vDone && !!vDone.result, r)
  assert('每步一poll、轮次有界', vPolls >= 2 && vPolls <= 8, '实际轮次 ' + vPolls)
  assert('视频标记了计划抽帧数', vDone.result.frames >= 1, vDone.result)

  r = await as('u_guest', 'recognizePoll', { taskId: vTaskId })
  assert('重复轮询幂等', r.ok && r.data.status === 'done' && !!r.data.result, r)
  assert('重复轮询不重复建样本', (store['ai_samples'] || []).length === 1)

  // 并发轮询：只有一个真正执行
  const before = (store['ai_tasks'] || []).find(t => t._id === vTaskId).attempts
  await Promise.all([0, 1, 2].map(() => as('u_guest', 'recognizePoll', { taskId: 'task_x' })))
  assert('不存在的任务返回 404', (await as('u_guest', 'recognizePoll', { taskId: 'nope' })).code === 404)

  console.log('\n=== 6. 地图点位聚合 ===')
  // 再建两只靠近的猫 + 一只私有的
  await as('u_admin', 'saveCat', { data: { name: '奶牛', pattern: 'cow', location: { lat: 30.50015, lng: 114.30015 }, schoolId } })
  await as('u_admin', 'saveCat', { data: { name: '奶糖', pattern: 'white', location: { lat: 30.5002, lng: 114.3002 }, schoolId } })
  const priv = await as('u_admin', 'saveCat', { data: { name: '秘密', pattern: 'gray', spotPrivate: true, location: { lat: 30.6, lng: 114.4 }, schoolId } })
  const privId = priv.data._id

  r = await as('u_guest', 'listMapPoints', { schoolId, zoom: 16 })
  assert('游客拿到点位', r.ok && r.data.total >= 3, r.data.total)
  assert('游客看不到私有点位', !r.data.points.some(p => p.catId === privId) && !r.data.clusters.some(c => c.cats.some(p => p.catId === privId)), r.data)
  assert('相邻猫被聚合成簇', r.data.clusters.length >= 1, r.data.clusters)
  assert('簇内含多只猫', r.data.clusters[0] && r.data.clusters[0].count >= 2, r.data.clusters[0])
  assert('游客作用域标记为 public', r.data.scope === 'public', r.data.scope)

  r = await as('u_admin', 'listMapPoints', { schoolId, zoom: 16 })
  assert('成员可见私有点位', r.data.points.some(p => p.catId === privId) || r.data.clusters.some(c => c.cats.some(p => p.catId === privId)), r.data)
  assert('成员作用域标记为 member', r.data.scope === 'member', r.data.scope)

  // —— 点位来源：以每只猫「最后一次打卡位置」为准，只认档案里的猫 ——
  const findPt = r => r.data.points.find(p => p.catId === cid)
    || (r.data.clusters.reduce((a, c) => a.concat(c.cats || []), []).find(p => p.catId === cid))
  const allCats = r => r.data.points.concat(r.data.clusters.reduce((a, c) => a.concat(c.cats || []), []))

  // 1) 档案没填常驻位置的猫：无打卡不上图，打卡后按打卡点位上图
  const noLoc = await as('u_admin', 'saveCat', { data: { name: '无址', pattern: 'orange', schoolId } })
  const cid = noLoc.data._id
  r = await as('u_admin', 'listMapPoints', { schoolId, zoom: 16 })
  assert('无常驻位置且无打卡的猫不上图', !findPt(r), r.data)
  await as('u_admin', 'addSighting', { data: { catId: cid, location: { lat: 30.5004, lng: 114.3004 }, feedStatus: 'fed', schoolId } })
  r = await as('u_admin', 'listMapPoints', { schoolId, zoom: 16 })
  const p1 = findPt(r)
  assert('无档案位置的猫打卡后上图', !!p1, r.data)
  assert('点位取自打卡坐标', !!p1 && Math.abs(p1.lat - 30.5004) < 1e-6 && Math.abs(p1.lng - 114.3004) < 1e-6, p1)
  assert('标记点位来源为打卡', !!p1 && p1.fromSighting === true, p1)

  // 2) 有档案位置的猫：在新地点再打卡 → 图标移到新打卡点
  const moved = await as('u_admin', 'saveCat', { data: { name: '搬家', pattern: 'tabby', location: { lat: 30.61, lng: 114.41 }, schoolId } })
  const mid = moved.data._id
  r = await as('u_admin', 'listMapPoints', { schoolId, zoom: 16 })
  const ptBefore = r.data.points.find(p => p.catId === mid)
  assert('初始使用档案常驻位置', !!ptBefore && Math.abs(ptBefore.lat - 30.61) < 1e-6 && ptBefore.fromSighting !== true, ptBefore)
  await as('u_admin', 'addSighting', { data: { catId: mid, location: { lat: 30.5005, lng: 114.3005 }, feedStatus: 'passed', schoolId } })
  r = await as('u_admin', 'listMapPoints', { schoolId, zoom: 16 })
  const ptAfter = r.data.points.find(p => p.catId === mid)
    || (r.data.clusters.reduce((a, c) => a.concat(c.cats || []), []).find(p => p.catId === mid))
  assert('再打卡后移到新点位', !!ptAfter && Math.abs(ptAfter.lat - 30.5005) < 1e-6, ptAfter)

  // 3) 未认领的新猫打卡（无 catId）不产生点位
  const totalBefore = r.data.total
  await as('u_admin', 'addSighting', { data: { catName: '流浪新人', location: { lat: 30.5006, lng: 114.3006 }, schoolId } })
  r = await as('u_admin', 'listMapPoints', { schoolId, zoom: 16 })
  assert('未认领打卡不产生点位', r.data.total === totalBefore && !allCats(r).some(p => !p.catId), r.data.total)

  console.log('\n=== 7. 内容安全 ===')
  const secLib = require(path.resolve(__dirname, '..', 'cloudfunctions', 'catcampus', 'lib', 'security.js'))
  assert('文本检测放行正常内容', (await secLib.checkText('今天看到橘座在晒太阳')) === true)
  assert('空文本直接放行', (await secLib.checkText('')) === true)

  console.log('\n=== 8. 定时触发器（特征库每晚自动建库）===')
  // 定时触发器由平台构造 event：{ Type:'Timer', TriggerName, Time }，没有 OPENID。
  // 未配置 AI_ENDPOINT 时每个校区都会建库失败，但任务本身必须返回成功 ——
  // 定时任务不能因为单个校区故障就被判死（否则第二天也不会再跑）。
  const prevEp = process.env.AI_ENDPOINT
  delete process.env.AI_ENDPOINT
  r = await main({ Type: 'Timer', TriggerName: 'aiIndexDaily', Time: '2026-10-13T19:00:00Z' })
  assert('定时触发器 aiIndexDaily 正常返回', r.ok === true, r)
  assert('定时任务遍历了全部校区', r.ok && r.data.schools >= 1, r && r.data)
  assert('定时任务逐个校区处理', r.ok && r.data.processed === r.data.schools, r && r.data)

  r = await main({ Type: 'Timer', TriggerName: 'noSuchTimer' })
  assert('未知定时任务返回 404', r.ok === false && r.code === 404, r)

  // 定时器 event 不含 action，不能混进普通 action 路由
  r = await main({ Type: 'Timer', TriggerName: 'aiIndexDaily' })
  assert('定时分支与 action 路由互不干扰', r.ok === true && !('code' in r), r)

  if (prevEp !== undefined) process.env.AI_ENDPOINT = prevEp

  // 全量建库属管理员动作：普通成员不能触发
  r = await as('u_guest', 'buildAiIndexAll', {})
  assert('游客触发全量建库被拒 403', r.ok === false && r.code === 403, r)

  // 建档 / 改档要清空「已入库」标记，触发下次识别时自动补库
  const fresh = await as('u_admin', 'saveCat', { data: { name: '新来的', pattern: 'orange', schoolId } })
  const freshId = fresh.data._id
  const freshDoc = (store['cats'] || []).find(c => c._id === freshId)
  assert('建档后清除已入库标记', freshDoc && !freshDoc.aiIndexAt, freshDoc)
  await as('u_admin', 'saveCat', { data: { _id: freshId, name: '改名的', schoolId } })
  const editedDoc = (store['cats'] || []).find(c => c._id === freshId)
  assert('改档后同样清除标记', editedDoc && !editedDoc.aiIndexAt, editedDoc)

  console.log('\n=== 9. 猫档案媒体换链（「头像空白」根因）===')

  // 情形一（小白）：头像/照片是 cloud://，客户端读不到「别人上传的」私有文件，
  // 必须由管理端云函数换成 https 临时链接
  const mediaCat = await as('u_admin', 'saveCat', { data: {
    name: '换链猫', schoolId,
    avatar: 'cloud://env.bucket/avatar.jpg',
    photos: ['cloud://env.bucket/p1.jpg', 'cloud://env.bucket/p2.jpg']
  } })
  const mediaId = mediaCat.data._id

  r = await as('u_guest', 'listCats', { schoolId })
  const rowMedia = r.data.list.find(c => c._id === mediaId)
  assert('listCats 头像已换 https', rowMedia && /^https:\/\//.test(rowMedia.avatar), rowMedia && rowMedia.avatar)
  assert('listCats 不动 photos（列表只要头像，省一次批量调用）',
    rowMedia && /^cloud:\/\//.test(rowMedia.photos[0]), rowMedia && rowMedia.photos[0])

  r = await as('u_guest', 'getCat', { id: mediaId })
  assert('getCat 头像换 https', /^https:\/\//.test(r.data.cat.avatar), r.data.cat.avatar)
  assert('getCat 相册照片也换 https',
    (r.data.cat.photos || []).every(p => /^https:\/\//.test(p)), r.data.cat.photos)

  // 情形二（小灰灰）：avatar 为空但有相册 → 头像回退 photos[0]，
  // 与地图 mapPoints 的口径一致（「档案有照片、列表却是占位图」）
  const noAvatar = await as('u_admin', 'saveCat', { data: {
    name: '无头像猫', schoolId, photos: ['cloud://env.bucket/only.jpg']
  } })
  r = await as('u_guest', 'listCats', { schoolId })
  const rowNoAvatar = r.data.list.find(c => c._id === noAvatar.data._id)
  assert('avatar 为空时用 photos[0] 顶上', rowNoAvatar && /^https:\/\//.test(rowNoAvatar.avatar),
    rowNoAvatar && rowNoAvatar.avatar)

  // 情形三：文件真的不存在 → **保留原 fileID**（交前端 <image>/兜底链处理），绝不置空
  const gone = await as('u_admin', 'saveCat', { data: {
    name: '文件没了', schoolId, avatar: 'cloud://env.bucket/missing.jpg'
  } })
  r = await as('u_guest', 'listCats', { schoolId })
  const rowGone = r.data.list.find(c => c._id === gone.data._id)
  assert('换链失败保留原 fileID（不置空）',
    rowGone && rowGone.avatar === 'cloud://env.bucket/missing.jpg', rowGone && rowGone.avatar)

  // 情形四：本地临时路径（wxfile://）——建档时没上传成功就落库的脏数据，
  // 归一化不能把它当可用地址留着
  const dirty = await as('u_admin', 'saveCat', { data: {
    name: '脏数据猫', schoolId, photos: ['wxfile://tmp/local.jpg']
  } })
  r = await as('u_guest', 'getCat', { id: dirty.data._id })
  assert('getCat 不把 wxfile:// 换成伪 https',
    (r.data.cat.photos || [])[0] === 'wxfile://tmp/local.jpg', r.data.cat.photos)

  // 目击照片：列表只换前 3 张（20 条 × 9 张 = 180 个 fileID 会把这次调用拖长几百毫秒），
  // 第 4 张起保持原样，交给前端 photo.js 懒换
  await as('u_admin', 'addSighting', { data: {
    catId: catId, schoolId,
    photos: ['cloud://env.bucket/s1.jpg', 'cloud://env.bucket/s2.jpg',
             'cloud://env.bucket/s3.jpg', 'cloud://env.bucket/s4.jpg']
  } })
  r = await as('u_admin', 'listSightings', { schoolId, catId })
  const sightRow = (r.data.list || [])[0]
  assert('listSightings 前 3 张照片换 https',
    sightRow && /^https:\/\//.test(sightRow.photos[0]) && /^https:\/\//.test(sightRow.photos[2]),
    sightRow && sightRow.photos)
  assert('listSightings 第 4 张不换（留给前端懒换）',
    sightRow && sightRow.photos[3] === 'cloud://env.bucket/s4.jpg', sightRow && sightRow.photos)

  // 合规红线（2026-10-16 审核驳回「社交-笔记」）：
  // 非社团成员**不得**拿到用户生成内容（note 文字 / photos 图片 / 上报人身份），
  // 否则等于"用户内容的公开发布" —— 个人主体未开放该类目。
  // 成员（u_admin）仍可见全字段，用于核实存档。
  await as('u_admin', 'addSighting', { data: {
    catId: catId, schoolId,
    photos: ['cloud://env.bucket/p1.jpg'],
    note: '右前腿有伤', behaviors: ['resting', 'unusual'], health: 'injured'
  } })
  const guestSight = (await as('u_guest', 'listSightings', { schoolId, catId })).data.list || []
  const gs = guestSight.find(x => Array.isArray(x.behaviors) && x.behaviors.length)
  assert('非成员看不到 note（用户文字）', gs && gs.note === undefined, gs && gs.note)
  assert('非成员看不到 photos（用户图片）', gs && gs.photos === undefined, gs && gs.photos)
  assert('非成员看不到 reporter 身份', gs && gs.reporter === undefined, gs && gs.reporter)
  assert('非成员仍能看到结构化 health', gs && gs.health === 'injured', gs && gs.health)
  assert('非成员仍能看到结构化 behaviors',
    gs && JSON.stringify(gs.behaviors) === JSON.stringify(['resting', 'unusual']), gs && gs.behaviors)

  const adminSight = (await as('u_admin', 'listSightings', { schoolId, catId })).data.list || []
  const asx = adminSight.find(x => x.note === '右前腿有伤')
  assert('成员仍能看到 note 全文', !!asx, adminSight.map(x => x.note))
  assert('成员仍能看到 photos', asx && Array.isArray(asx.photos), asx && asx.photos)

  // behaviors 白名单：非法值必须被服务端丢弃（客户端可被篡改）
  await as('u_admin', 'addSighting', { data: {
    catId: catId, schoolId, photos: ['cloud://env.bucket/p2.jpg'],
    behaviors: ['resting', 'HACKED', 'eating', 123, null]
  } })
  const badBehav = (await as('u_admin', 'listSightings', { schoolId, catId })).data.list
    .find(x => Array.isArray(x.photos) && x.photos.some(p => /p2\.jpg/.test(p)))
  assert('云端 behaviors 白名单过滤非法值',
    badBehav && JSON.stringify(badBehav.behaviors) === JSON.stringify(['resting', 'eating']),
    badBehav && badBehav.behaviors)

  // note 长度兜底：老客户端/直接调用可绕过前端 maxlength
  await as('u_admin', 'addSighting', { data: {
    catId: catId, schoolId, photos: ['cloud://env.bucket/p3.jpg'],
    note: '这是一段非常长的用户自由文本内容用来测试服务端是否真的做了截断保护措施'
  } })
  const longNote = (await as('u_admin', 'listSightings', { schoolId, catId })).data.list
    .find(x => Array.isArray(x.photos) && x.photos.some(p => /p3\.jpg/.test(p)))
  assert('云端 note 截断到 20 字', longNote && longNote.note.length === 20, longNote && longNote.note)

  r = await as('u_admin', 'getCat', { id: catId })
  const sightInCat = (r.data.sightings || [])[0]
  assert('getCat 的目击照片同样换 https',
    sightInCat && /^https:\/\//.test(sightInCat.photos[0]), sightInCat && sightInCat.photos)

  // 诊断接口：一眼看出「字段为空 / 本地路径 / 文件已不存在」
  r = await as('u_guest', 'debugCatMedia', { name: '文件没了' })
  assert('debugCatMedia 需管理员权限', r.ok === false && r.code === 403, r)

  r = await as('u_admin', 'debugCatMedia', { name: '文件没了', schoolId })
  const dbg = r.data.rows[0]
  assert('debugCatMedia 报出媒体类型 cloud', dbg && dbg.media[0] && dbg.media[0].kind === 'cloud', dbg)
  assert('debugCatMedia 报出换链失败状态',
    dbg && dbg.media[0].urlOk === false && dbg.media[0].status === -1,
    dbg && dbg.media[0])

  r = await as('u_admin', 'debugCatMedia', { name: '无头像猫', schoolId })
  assert('debugCatMedia 提示「没设头像但有相册」',
    r.data.rows[0] && /photos\[0\]/.test(r.data.rows[0].hint || ''), r.data.rows[0])

  console.log('\n=== 结果 ===')
  console.log('PASS ' + pass + ' / FAIL ' + fail)
  process.exit(fail ? 1 : 0)
}

run().catch(e => { console.error('测试台异常', e); process.exit(1) })
