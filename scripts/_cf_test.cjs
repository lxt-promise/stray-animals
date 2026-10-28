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
  // 删除字段（云开发 _.remove() → mongo $unset）。真实语义：字段直接消失，
  // 这样 where({ x: _.exists(false) }) 才查得到 —— 写 null 是查不到的。
  remove: () => op('remove'),
  exists: v => op('exists', v),
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
        case 'exists': return want.v ? got !== undefined : got === undefined
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
    else if (v && v.__op === 'remove') delete doc[k]
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
  // 2026-10-17 语义变更：本地降级**不再伪造候选**。
  // 这个测试环境没配 AI_ENDPOINT，正确行为是「明确说这次没识别出来」，
  // 而不是用随机毛色/花纹去撞一个档案 —— 后者在界面上和真结果一模一样，
  // 实测把一只白猫"识别"成了随机撞上的候选，比报错更糟。
  assert('本地降级应标记 degraded', r.ok && r.data.degraded === true, r.data)
  assert('本地降级不得给假候选', Array.isArray(r.data.candidates) && r.data.candidates.length === 0, r.data.candidates)
  assert('本地降级不得伪造毛色/花纹',
    !r.data.features.pattern && !r.data.features.color && !(r.data.features.tags || []).length,
    r.data.features)
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
  // 先把标记写成「已入库」，再改档：必须真的把字段**删掉**（_.remove），而不是写 null。
  // null 字段对 where({ aiIndexAt: _.exists(false) }) 来说算「存在」，
  // 结果是「换过照片的猫再也不被自动补库」，而界面又看不出任何异常。
  ;(store['cats'] || []).forEach(c => { if (c._id === freshId) c.aiIndexAt = new Date() })
  await as('u_admin', 'saveCat', { data: { _id: freshId, name: '改名的', schoolId } })
  const editedDoc = (store['cats'] || []).find(c => c._id === freshId)
  assert('改档后已入库标记被删除（不是写 null）',
    editedDoc && !('aiIndexAt' in editedDoc), editedDoc && editedDoc.aiIndexAt)

  // 幂等闸（2026-10-24 现场：「每次都是点第二遍才保存成功」）：
  // 第一发 -504003 超时后客户端会自动重发，两次带同一个 saveToken；
  // 若第一发其实已经写库，第二发必须返回同一个 _id，而不是再建一只同名的猫。
  const tok = 'svtest' + Date.now()
  const first = await as('u_admin', 'saveCat', { data: { name: '幂等猫', pattern: 'white', schoolId, saveToken: tok }, attempt: 1 })
  const again = await as('u_admin', 'saveCat', { data: { name: '幂等猫', pattern: 'white', schoolId, saveToken: tok }, attempt: 2 })
  assert('同 saveToken 重试返回同一档案（不重复建档）',
    first.data._id === again.data._id && again.data.deduped === true, [first.data, again.data])
  assert('同 token 只落了一条档案',
    (store['cats'] || []).filter(c => c.saveToken === tok).length === 1)
  const other = await as('u_admin', 'saveCat', { data: { name: '幂等猫2', schoolId, saveToken: tok + 'x' }, attempt: 2 })
  assert('换 token 正常新建（查重不会误伤别人）',
    other.data._id !== first.data._id, other.data)
  r = await as('u_guest', 'getCat', { id: first.data._id })
  assert('saveToken 是内部字段，不下发给客户端',
    r.data.cat && !('saveToken' in r.data.cat), r.data.cat && r.data.cat.saveToken)

  // 预热接口：只为了让云函数实例提前起来（冷启动 1~1.5s 会顶破客户端 3s 预算）
  r = await as('u_guest', 'ping', {})
  assert('ping 可用于预热', r.ok === true && r.data && r.data.pong === true, r)

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
  // 原始 fileID 必须另存一份：编辑页把它写回数据库，否则 photos 会被临时链接覆盖，
  // 两小时后过期就再也换不回来（相册黑屏、建库下载失败的根因）
  assert('getCat 下发 photoIds（原始 fileID，与 photos 同下标）',
    Array.isArray(r.data.cat.photoIds) && r.data.cat.photoIds[0] === 'cloud://env.bucket/p1.jpg',
    r.data.cat.photoIds)
  assert('getCat 下发 avatarId', r.data.cat.avatarId === 'cloud://env.bucket/avatar.jpg', r.data.cat.avatarId)
  assert('photoIds 与 photos 等长（不删项，防下标错位）',
    (r.data.cat.photoIds || []).length === (r.data.cat.photos || []).length, r.data.cat.photoIds)

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

  // 合规红线（2026-10-16 二审）+ 可见性策略（超管在控制台按校区统一配置）：
  //
  // ① 非社团成员**不得**拿到用户生成内容（photos 图片 / 上报人身份），
  //    否则等于"用户内容的公开发布" —— 个人主体未开放该类目。
  // ② 打卡记录**默认 private（仅社团内部可见）**；公开与否由**超管**配置，
  //    打卡者传 public:true **不生效**（合规：用户端不得有发布入口）。
  //    成员（u_admin）仍可见全字段，用于核实存档。
  //
  // 默认状态下：记录全部 private —— 访客看不到任何打卡
  await as('u_admin', 'addSighting', { data: {
    catId: catId, schoolId,
    photos: ['cloud://env.bucket/priv.jpg'],
    behaviors: ['hiding']
  } })
  const privGuest = (await as('u_guest', 'listSightings', { schoolId, catId })).data.list || []
  assert('默认策略下访客看不到任何打卡',
    !privGuest.some(x => Array.isArray(x.behaviors) && x.behaviors.indexOf('hiding') >= 0),
    privGuest.map(x => x.behaviors))
  const privAdmin = (await as('u_admin', 'listSightings', { schoolId, catId })).data.list || []
  const privRow = privAdmin.find(x => Array.isArray(x.behaviors) && x.behaviors.indexOf('hiding') >= 0)
  assert('默认记录 visibility=private（成员可见以核实）',
    privRow && privRow.visibility === 'private', privRow && privRow.visibility)

  // 打卡者无法自行公开：显式传 public:true 也不生效（策略仍是关闭）
  await as('u_admin', 'addSighting', { data: {
    catId: catId, schoolId, public: true, photos: ['cloud://env.bucket/trypub.jpg'],
    behaviors: ['moving']
  } })
  const tryPub = (await as('u_admin', 'listSightings', { schoolId, catId })).data.list
    .find(x => Array.isArray(x.photos) && x.photos.some(p => /trypub\.jpg/.test(p)))
  assert('打卡者传 public:true 不生效（策略未开）',
    tryPub && tryPub.visibility === 'private', tryPub && tryPub.visibility)

  // 本人查自己的记录（mine:true）不受可见性限制
  const mineList = (await as('u_admin', 'listSightings', { mine: true, schoolId })).data.list || []
  assert('mine=true 能看到自己的私有记录',
    mineList.some(x => Array.isArray(x.behaviors) && x.behaviors.indexOf('hiding') >= 0),
    mineList.length)

  // ③ 普通用户不能改可见性策略
  const pol0 = await as('u_guest', 'setSightingVisibilityPolicy', { data: { public: true } })
  assert('普通用户不能改可见性策略', pol0.ok === false, pol0)

  // 超管开启校区策略 → 新记录变 public，访客可见（但仍无 photos/身份）
  const polOn = await as('u_admin', 'setSightingVisibilityPolicy', { data: { public: true }, schoolId })
  assert('超管可开启公开策略', polOn.ok === true && polOn.data.public === true, polOn.data)

  await as('u_admin', 'addSighting', { data: {
    catId: catId, schoolId,
    photos: ['cloud://env.bucket/p1.jpg'],
    behaviors: ['resting', 'unusual'], features: ['limping'], health: 'injured'
  } })
  const guestSight = (await as('u_guest', 'listSightings', { schoolId, catId })).data.list || []
  const gs = guestSight.find(x => Array.isArray(x.behaviors) && x.behaviors.length)
  assert('策略开启后访客可见打卡', !!gs, guestSight.map(x => x.behaviors))
  assert('非成员看不到 photos（用户图片）', gs && gs.photos === undefined, gs && gs.photos)
  assert('非成员看不到 reporter 身份', gs && gs.reporter === undefined, gs && gs.reporter)
  assert('非成员仍能看到结构化 health', gs && gs.health === 'injured', gs && gs.health)
  assert('非成员仍能看到结构化 behaviors',
    gs && JSON.stringify(gs.behaviors) === JSON.stringify(['resting', 'unusual']), gs && gs.behaviors)
  assert('非成员仍能看到结构化 features',
    gs && JSON.stringify(gs.features) === JSON.stringify(['limping']), gs && gs.features)
  assert('云端不再写入 note 字段（自由文本通道已关）', gs && gs.note === undefined, gs && gs.note)

  const adminSight = (await as('u_admin', 'listSightings', { schoolId, catId })).data.list || []
  const asx = adminSight.find(x => Array.isArray(x.features) && x.features.indexOf('limping') >= 0)
  assert('成员仍能看到 photos', asx && Array.isArray(asx.photos), asx && asx.photos)
  assert('策略开启后记录标为 visibility=public', asx && asx.visibility === 'public', asx && asx.visibility)

  // 之前的 private 记录**不追溯**变公开（策略只影响新记录）
  const oldPriv = (await as('u_admin', 'listSightings', { schoolId, catId })).data.list
    .find(x => Array.isArray(x.behaviors) && x.behaviors.indexOf('hiding') >= 0)
  assert('旧 private 记录不被追溯公开', oldPriv && oldPriv.visibility === 'private', oldPriv && oldPriv.visibility)

  // 关回策略：新记录恢复 private
  const polOff = await as('u_admin', 'setSightingVisibilityPolicy', { data: { public: false }, schoolId })
  assert('超管可关闭公开策略', polOff.ok === true && polOff.data.public === false, polOff.data)

  // ④ features 白名单：非法值必须被服务端丢弃（客户端可被篡改）
  await as('u_admin', 'addSighting', { data: {
    catId: catId, schoolId, photos: ['cloud://env.bucket/p2.jpg'],
    behaviors: ['resting', 'HACKED', 'eating', 123, null],
    features: ['thin', 'FAKE', 'collar']
  } })
  const badBehav = (await as('u_admin', 'listSightings', { schoolId, catId })).data.list
    .find(x => Array.isArray(x.photos) && x.photos.some(p => /p2\.jpg/.test(p)))
  assert('云端 behaviors 白名单过滤非法值',
    badBehav && JSON.stringify(badBehav.behaviors) === JSON.stringify(['resting', 'eating']),
    badBehav && badBehav.behaviors)
  assert('云端 features 白名单过滤非法值',
    badBehav && JSON.stringify(badBehav.features) === JSON.stringify(['thin', 'collar']),
    badBehav && badBehav.features)

  // ⑤ 新猫占位名由服务端按 pattern 生成，不接受用户自定义 catName
  await as('u_admin', 'addSighting', { data: {
    schoolId, pattern: 'orange',
    catName: '用户自己起的名字'
  } })
  const namedRow = (await as('u_admin', 'listSightings', { pending: true, schoolId })).data.list
    .find(x => x.pattern === 'orange' || /未命名/.test(x.catName || ''))
  assert('新猫占位名由服务端生成（不采用用户 catName）',
    namedRow && namedRow.catName === '未命名·橘猫', namedRow && namedRow.catName)

  // ⑥ 访客 listSightings 不返回 null 项（sanitize 返回 null 已被过滤）
  r = await as('u_guest', 'listSightings', { schoolId, catId })
  assert('访客 listSightings 不返回 null 项（sanitize 返回 null 已被过滤）',
    (r.data.list || []).every(x => x && typeof x === 'object'))

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

  console.log('\n=== 10. 图鉴收集按学校统计 ===')

  // 未绑定学校：不能凭空给进度。旧实现用 listCats（where 为空）会拿到**全环境**的猫，
  // 新用户一进来就显示「0 / 4」，那其实是别校的猫。
  r = await as('u_guest', 'listDex', {})
  assert('未绑定学校 → needSchool', r.ok && r.data.needSchool === true, r.data)
  assert('未绑定学校 → 不返回任何猫与总数',
    r.data.total === 0 && r.data.seen === 0 && r.data.list.length === 0, r.data)

  // 选已有学校 → 提交加入申请（需管理员审核，不再即选即绑）
  r = await as('u_guest', 'applySchool', { schoolId, reason: '我是本校学生' })
  assert('选已有学校 → 提交加入申请（待审，不立即绑定）',
    r.ok && r.data.status === 'submitted' && r.data.apply.type === 'join' && r.data.apply.schoolId === schoolId, r.data)
  const joinApplyId = r.data.apply._id
  assert('申请落库为 pending',
    (store['school_applies'] || []).find(a => a._id === joinApplyId).status === 'pending')
  assert('审核通过前不绑定（避免「选中即绑」挤进任意学校数据）',
    !store['users'].find(u => u._id === guestId).schoolId)

  // 管理员审核通过 → 才绑定
  r = await as('u_admin', 'handleSchoolApply', { id: joinApplyId, approve: true })
  assert('入校申请通过 → 绑定申请人',
    r.ok && r.data.status === 'approved' && r.data.schoolId === schoolId, r.data)
  assert('用户档案 schoolId 已落库',
    store['users'].find(u => u._id === guestId).schoolId === schoolId)

  // ⚠️ 前面的章节已经在这所学校里建了一批猫，所以这里用「相对口径」断言：
  // 本校猫数必须与 store 里同校猫数一致，而不是写死 1。
  const schoolCatIds = () => (store['cats'] || []).filter(c => c.schoolId === schoolId).map(c => c._id)
  r = await as('u_guest', 'listDex', {})
  const dexA = r.data
  assert('已绑定 → 只统计本校猫（与库内同校猫数一致）',
    r.ok && dexA.needSchool === false && dexA.total === schoolCatIds().length, { total: dexA.total, want: schoolCatIds().length })
  assert('图鉴里没有外校的猫', dexA.list.every(c => schoolCatIds().indexOf(c.id) >= 0),
    dexA.list.map(c => c.id))
  assert('catSeen 里本校的猫算已收集', dexA.seen === 1 &&
    dexA.percent === Math.round(1 / dexA.total * 100), { seen: dexA.seen, percent: dexA.percent })
  assert('已收集的猫标记 unlocked 且带 id',
    dexA.list.some(c => c.id === catId && c.unlocked === true), dexA.list.filter(c => c.unlocked))

  // 第二所学校：两校图鉴互不相通
  r = await as('u_admin', 'createSchool', { name: '第二大学', center: { lat: 31.2, lng: 121.4 } })
  const schoolB = r.data._id
  await as('u_admin', 'saveCat', { data: { name: 'B校的猫', pattern: 'white', schoolId: schoolB } })

  r = await as('u_guest', 'listDex', {})
  const bCatId = (store['cats'] || []).filter(c => c.schoolId === schoolB)[0]._id
  assert('别校建档不会混进本校图鉴',
    r.data.total === dexA.total && r.data.list.every(c => c.id !== bCatId), { total: r.data.total, bCatId })

  r = await as('u_other', 'login', {})
  await as('u_other', 'applySchool', { schoolId: schoolB, reason: '本校教职工' })
  // 入校申请需管理员审核通过才绑定
  const otherApply = (store['school_applies'] || []).filter(a => a.openid === 'u_other' && a.status === 'pending')[0]
  await as('u_admin', 'handleSchoolApply', { id: otherApply._id, approve: true })
  r = await as('u_other', 'listDex', {})
  assert('不同学校有各自的图鉴（B 校 1 只、0 收集）',
    r.data.total === 1 && r.data.seen === 0 && r.data.list[0].unlocked === false, r.data)
  assert('B 校图鉴里没有 A 校的猫', r.data.list[0].id !== catId, r.data.list[0])

  r = await as('u_guest', 'listDex', { brief: true })
  assert('brief 只回计数、不回清单（「我的」页用）',
    r.data.brief === true && r.data.list.length === 0 &&
    r.data.total === dexA.total && r.data.seen === 1, r.data)

  console.log('\n=== 11. 建校申请与超管审核 ===')
  const appliesBefore = (store['school_applies'] || []).length
  const schoolsBefore = (store['schools'] || []).length

  r = await as('u_other', 'applySchool', { schoolId: 'no_such_school' })
  assert('绑到不存在的学校 → 404（避免绑完数据全空）', r.ok === false && r.code === 404, r)

  r = await as('u_new', 'login', {})
  const newId = r.data._id
  r = await as('u_new', 'applySchool', {})
  assert('缺学校名 → 400', r.ok === false && r.code === 400, r)

  r = await as('u_new', 'applySchool', { name: '新大学', campus: '东校区', city: '南京', reason: '本校有流浪猫待照顾' })
  assert('提交新建申请 → submitted', r.ok && r.data.status === 'submitted', r.data)
  const applyId = r.data.apply._id
  assert('申请落库为 pending',
    (store['school_applies'] || []).find(a => a._id === applyId).status === 'pending')
  assert('审核通过前不建学校（否则别人能选到没审过的学校）',
    (store['schools'] || []).length === schoolsBefore, (store['schools'] || []).length)

  r = await as('u_new', 'applySchool', { name: '新大学', campus: '东校区', reason: '再次申请建校' })
  assert('重复提交不产生第二条待审',
    r.data.status === 'pending' && (store['school_applies'] || []).length === appliesBefore + 1,
    (store['school_applies'] || []).length)

  r = await as('u_new', 'mySchoolApply', {})
  assert('mySchoolApply 能读到自己待审的申请',
    r.data.pending && r.data.pending.name === '新大学', r.data)

  r = await as('u_other', 'listSchoolApplies', {})
  assert('非超管看不到申请列表', r.ok === false && r.code === 403, r)
  r = await as('u_other', 'handleSchoolApply', { id: applyId, approve: true })
  assert('非超管不能审核（否则谁都能给自己建校）', r.ok === false && r.code === 403, r)

  r = await as('u_admin', 'listSchoolApplies', { status: 'pending' })
  assert('超管能看到待审申请', r.ok && r.data.some(a => a._id === applyId), r.data)

  r = await as('u_admin', 'handleSchoolApply', { id: applyId, approve: true })
  assert('通过 → 建校 + 绑定申请人',
    r.ok && r.data.status === 'approved' && !!r.data.schoolId, r.data)
  const newSchoolId = r.data.schoolId
  assert('学校文档已创建',
    (store['schools'] || []).some(s => s._id === newSchoolId && s.name === '新大学'))
  assert('申请人已绑定新学校',
    store['users'].find(u => u._id === newId).schoolId === newSchoolId)
  assert('申请标记 approved',
    (store['school_applies'] || []).find(a => a._id === applyId).status === 'approved')

  r = await as('u_admin', 'handleSchoolApply', { id: applyId, approve: true })
  assert('重复审核 → 409（不会给同一申请建出两所学校）', r.ok === false && r.code === 409, r)

  r = await as('u_new', 'applySchool', { name: '假的大学', reason: '测试驳回' })
  const apply2 = r.data.apply._id
  r = await as('u_admin', 'handleSchoolApply', { id: apply2, approve: false })
  assert('驳回 → rejected', r.ok && r.data.status === 'rejected', r.data)
  assert('驳回不建学校', (store['schools'] || []).length === schoolsBefore + 1, (store['schools'] || []).length)
  assert('驳回不影响已有的学校绑定（仍停在国内学校）',
    store['users'].find(u => u._id === newId).schoolId === newSchoolId)
  r = await as('u_new', 'mySchoolApply', {})
  assert('mySchoolApply 能读到被驳回的申请',
    r.data.rejected && r.data.rejected.name === '假的大学', r.data)

  // 入校申请（join）的驳回路径：与建校申请共用 handleSchoolApply，但只驳回、不建校/不换绑
  r = await as('u_new', 'applySchool', { schoolId, reason: '我想加入A校' })
  assert('入校申请 → submitted（type=join）',
    r.ok && r.data.status === 'submitted' && r.data.apply.type === 'join', r.data)
  const joinRejId = r.data.apply._id
  r = await as('u_admin', 'handleSchoolApply', { id: joinRejId, approve: false })
  assert('入校申请驳回 → rejected', r.ok && r.data.status === 'rejected', r.data)
  assert('入校申请驳回不换绑（u_new 仍绑定新学校）',
    store['users'].find(u => u._id === newId).schoolId === newSchoolId)
  r = await as('u_new', 'mySchoolApply', {})
  assert('mySchoolApply 能读到被驳回的入校申请',
    r.data.rejected && r.data.rejected.type === 'join', r.data)

  console.log('\n=== 11b. 校园管理列表（超管）===')
  // 后台的校园列表 = 校档 + 每校的档案数/绑定用户数。
  // 为什么单独一个 action：listSchools 是**公开**选校接口，只回校名；
  // 后台要判断「哪所校区有数据、哪所是空壳」，必须多带计数。
  r = await as('u_other', 'listSchoolsAdmin', {})
  assert('非超管不能读校园列表', r.ok === false && r.code === 403, r)

  store['cats'] = store['cats'] || []
  store['cats'].push(
    { _id: 'scat1', name: '校猫甲', schoolId: newSchoolId, createdAt: new Date() },
    { _id: 'scat2', name: '校猫乙', schoolId: newSchoolId, createdAt: new Date() }
  )
  r = await as('u_admin', 'listSchoolsAdmin', {})
  const rowNew = (r.data || []).find(s => s._id === newSchoolId) || {}
  assert('超管能读到校园列表', r.ok && Array.isArray(r.data) && r.data.length > 0, r)
  assert('带该校档案数（按 schoolId 过滤）', rowNew.catCount === 2, rowNew.catCount)
  assert('带该校绑定用户数', rowNew.userCount === 1, rowNew.userCount)
  assert('保留校名/校区等原始字段，后台可直接回填表单',
    rowNew.name === '新大学' && rowNew.campus === '东校区', rowNew)

  console.log('\n=== 12. 打卡次数计数口径（「-2」的成因）===')
  // 直接造数据：两条属于 u_guest 的记录 + 双方各一份计数。
  // 目的是锁死「删除时回退的是记录作者，不是操作者」——原实现无条件给操作者 -1，
  // 超管在后台删两条别人的打卡，自己的次数就变成 -2。
  store['sightings'] = store['sightings'] || []
  const guestDoc = () => store['users'].find(u => u.openid === 'u_guest')
  const adminDoc = () => store['users'].find(u => u.openid === 'u_admin')
  const mkSighting = (id, reporter) => {
    store['sightings'].push({
      _id: id, reporter, food: 0, visibility: 'private',
      schoolId: newSchoolId || '', createdAt: new Date()
    })
  }

  mkSighting('sg_a', 'u_guest')
  mkSighting('sg_b', 'u_guest')
  guestDoc().sightingCount = 2
  adminDoc().sightingCount = 5

  r = await as('u_admin', 'deleteSighting', { id: 'sg_a' })
  assert('超管可删他人记录', r.ok === true, r)
  assert('回退的是作者（guest 2 → 1）', guestDoc().sightingCount === 1, guestDoc().sightingCount)
  assert('操作者（超管）计数不受影响（仍 5）', adminDoc().sightingCount === 5, adminDoc().sightingCount)

  // 本人删自己的：回退本人
  mkSighting('sg_c', 'u_guest')
  guestDoc().sightingCount = 1
  r = await as('u_guest', 'deleteSighting', { id: 'sg_c' })
  assert('本人删自己的记录 → 自己 -1', r.ok === true && guestDoc().sightingCount === 0,
    guestDoc().sightingCount)

  // 计数已经是 0（脏数据）：条件更新挡住，不能减成 -1
  mkSighting('sg_d', 'u_guest')
  guestDoc().sightingCount = 0
  r = await as('u_guest', 'deleteSighting', { id: 'sg_d' })
  assert('计数为 0 时删除不会变负（条件更新兜底）', r.ok === true && guestDoc().sightingCount === 0,
    guestDoc().sightingCount)

  // 已经是 -2 的脏数据：下一次 login 自动按真实条数重算
  mkSighting('sg_e', 'u_guest')
  guestDoc().sightingCount = -2
  r = await as('u_guest', 'login', {})
  const realCount = (store['sightings'] || []).filter(x => x.reporter === 'u_guest').length
  assert('login 返回值里的打卡次数已修正',
    r.ok && r.data.sightingCount === realCount, { got: r.data && r.data.sightingCount, realCount })
  assert('库里的计数同步修正（不再是 -2）',
    guestDoc().sightingCount === realCount, guestDoc().sightingCount)
  assert('count() 未多算他人记录', realCount ===
    (store['sightings'] || []).filter(x => x.reporter === 'u_guest').length, realCount)

  console.log('\n=== 13. 重复档案检测与清理（「录入一只，猫谱里两条一样」）===')
  // 成因：saveCat 超时后客户端自动重发 + 用户手点第二遍 → 建出同名同校的两只猫。
  // 小程序端此前没有删除入口，重复只能烂在猫谱里。这里提供「扫出来 + 删多余」。
  // ⚠️ 用「管理员当前绑定的学校」而不是开头的 schoolId：前面 11 节已经改绑过，
  // 用旧 schoolId 建cat会被 assertSchool 挡掉（测试会静默拿到失败响应）。
  const dupSchool = ((store['users'] || []).find(u => u.openid === 'u_admin') || {}).schoolId || schoolId
  const dupA = await as('u_admin', 'saveCat', { data: { name: '重复猫', pattern: 'white', schoolId: dupSchool } })
  const dupB = await as('u_admin', 'saveCat', {
    data: {
      name: ' 重复猫 ', pattern: 'white', schoolId: dupSchool,
      photos: ['cloud://env.bucket/d1.jpg', 'cloud://env.bucket/d2.jpg']
    }
  })
  await as('u_admin', 'saveCat', { data: { name: '重复猫', pattern: 'gray', schoolId: dupSchool } })

  r = await as('u_admin', 'findDuplicateCats', { schoolId: dupSchool })
  const dupGroup = ((r.data && r.data.groups) || []).find(g => g.name === '重复猫')
  assert('同校同名（含首尾空格差异）归为一组',
    r.ok && !!dupGroup && dupGroup.items.length === 3,
    r.data && r.data.groups)
  assert('建议保留「照片最多」的那条（特征库最全）',
    dupGroup && dupGroup.keepId === dupB.data._id,
    dupGroup && { keepId: dupGroup.keepId, want: dupB.data._id })
  const dupBItem = dupGroup && dupGroup.items.find(i => i._id === dupB.data._id)
  assert('照片数如实下发（前端据此判断删哪条）',
    dupBItem && dupBItem.photoCount === 2 && dupBItem.keep === true, dupBItem)
  assert('不同名的猫不会被误报成重复',
    !((r.data.groups || []).some(g => g.name === '橘座')),
    (r.data.groups || []).map(g => g.name))
  assert('扫描条数一并返回（区分「扫了没重复」与「没扫」）',
    Number(r.data.scanned) >= 3, r.data.scanned)

  await as('u_admin', 'removeCat', { id: dupA.data._id })
  r = await as('u_admin', 'findDuplicateCats', { schoolId: dupSchool })
  const dupGroup2 = ((r.data && r.data.groups) || []).find(g => g.name === '重复猫')
  assert('删掉一条后同组只剩 2 条', !!dupGroup2 && dupGroup2.items.length === 2,
    dupGroup2 && dupGroup2.items.length)

  r = await as('u_guest', 'findDuplicateCats', {})
  assert('非超管调用被拒（403，不能扫别人的档案）', r.ok === false && r.code === 403, r)

  console.log('\n=== 14. 超管删除猫档案（不可恢复 → 权限必须收紧）===')
  // 原实现只有 doc(id).remove()：ACTIONS 声明 role:'admin' ⇒ 任何校园管理员都能删，
  // 删不存在的 id 也静默成功。现在收紧为 requireSuper + 存在性校验。
  {
    const target = dupB.data._id
    const guest = (store['users'] || []).find(u => u.openid === 'u_guest')
    const oldRole = guest.role
    guest.role = 'admin'   // 提成校园管理员，但不在 SUPER_ADMIN_OPENIDS 里
    r = await as('u_guest', 'removeCat', { id: target })
    assert('校园管理员（非超管）删档案被拒（403）', r.ok === false && r.code === 403, r)
    assert('被拒后档案仍在', (store['cats'] || []).some(c => c._id === target))
    guest.role = oldRole

    r = await as('u_admin', 'removeCat', {})
    assert('缺 id 明确报错（不再静默成功）', r.ok === false, r)
    r = await as('u_admin', 'removeCat', { id: 'no_such_cat' })
    assert('删不存在的档案报「不存在或已被删除」',
      r.ok === false && /不存在|已被删除/.test(r.msg || r.message || ''), r)

    r = await as('u_admin', 'removeCat', { id: target })
    assert('超管删除成功并回带猫名（前端拿它做提示）',
      r.ok === true && r.data && r.data.name === '重复猫', r)
    assert('库里真的没了', !(store['cats'] || []).some(c => c._id === target))

    r = await as('u_admin', 'removeCat', { id: target })
    assert('重复删同一条报「不存在」（客户端超时重发会走到这里）', r.ok === false, r)

    // 目击记录**不**连带删除：那是别人真实发生过的记录，删猫顺手删记录等于抹掉他人贡献
    const sightCountBefore = (store['sightings'] || []).length
    const catWithSight = (store['cats'] || []).find(c =>
      (store['sightings'] || []).some(s => s.catId === c._id))
    if (catWithSight) {
      await as('u_admin', 'removeCat', { id: catWithSight._id })
      assert('删猫不连带删打卡记录（历史留痕）',
        (store['sightings'] || []).length === sightCountBefore, store['sightings'].length)
    } else {
      assert('删猫不连带删打卡记录（历史留痕）', true, '本轮无带记录的猫，跳过')
    }
  }

  console.log('\n=== 结果 ===')
  console.log('PASS ' + pass + ' / FAIL ' + fail)
  process.exit(fail ? 1 : 0)
}

run().catch(e => { console.error('测试台异常', e); process.exit(1) })
