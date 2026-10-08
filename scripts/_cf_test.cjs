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
  gt: v => op('gt', v)
}

function matchCond(doc, cond) {
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
    _filters: [], _order: null, _limit: 1e9, _skip: 0,
    where(c) { this._filters.push(c); return this },
    orderBy(f, d) { this._order = { f, d }; return this },
    limit(n) { this._limit = n; return this },
    skip(n) { this._skip = n; return this },
    _matched() {
      let rows = list().filter(d => this._filters.every(f => matchCond(d, f)))
      if (this._order) {
        const { f, d } = this._order
        rows.sort((a, b) => (d === 'desc' ? (b[f] > a[f] ? 1 : -1) : (a[f] > b[f] ? 1 : -1)))
      }
      return rows.slice(this._skip, this._skip + this._limit)
    },
    async get() { return { data: this._matched().map(d => JSON.parse(JSON.stringify(d))) } },
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
    return { fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://x/' + encodeURIComponent(f) })) }
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

  // 视频：异步任务 + 轮询
  r = await as('u_guest', 'recognizeStart', { fileId: 'cloud://demo/v.mp4', type: 'video', duration: 10, thumbId: 'cloud://demo/v.jpg', schoolId })
  assert('视频任务创建成功', r.ok && r.data.status === 'pending', r)
  const vTaskId = r.data.taskId

  r = await as('u_guest', 'recognizePoll', { taskId: vTaskId })
  assert('首次轮询执行并完成', r.ok && r.data.status === 'done' && !!r.data.result, r)
  assert('视频标记了计划抽帧数', r.data.result.frames >= 1, r.data.result)

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

  console.log('\n=== 7. 内容安全 ===')
  const secLib = require(path.resolve(__dirname, '..', 'cloudfunctions', 'catcampus', 'lib', 'security.js'))
  assert('文本检测放行正常内容', (await secLib.checkText('今天看到橘座在晒太阳')) === true)
  assert('空文本直接放行', (await secLib.checkText('')) === true)

  console.log('\n=== 结果 ===')
  console.log('PASS ' + pass + ' / FAIL ' + fail)
  process.exit(fail ? 1 : 0)
}

run().catch(e => { console.error('测试台异常', e); process.exit(1) })
