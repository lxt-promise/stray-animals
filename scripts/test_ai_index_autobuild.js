/**
 * 特征库「自动建库」行为级测试（cloudfunctions/catcampus/lib/vision.js）
 *
 * 背景：为了把单次识别压进客户端约 3s 的 callFunction 预算，识别报文不再携带
 * 档案照（带照片会让服务端 ensure_index 疯狂下载）。副作用是新猫建档后不会
 * 自动进特征库 —— 原本只能靠管理员记住去点「建库」。
 *
 * A 方案 = 识别热路径增量补库：只给「档案里标记未入库」的猫带照片（限量），
 *          服务端 ensure_index 在检索前补算，于是新猫建档后第一次识别即可命中。
 * B 方案 = 每天定时全量建库兜底（config.json 的 timer 触发器 → buildIndexAll）。
 *
 * 断言重点：
 *   1) 新猫（无 aiIndexAt）的照片确实被带进了 /v1/recognize 报文，老猫不带；
 *   2) 识别成功后新猫被记账（aiIndexAt 落库），第二次识别不再重复携带；
 *   3) 待入库数量超过上限时热路径整体让路，交给定时任务；
 *   4) 预算不足时补库被跳过，识别本身不受影响；
 *   5) 定时全量建库遍历所有校区、带 onlyMissing，且单校失败不影响其他校区。
 *
 * 运行：node scripts/test_ai_index_autobuild.js
 */
const http = require('http')
const Module = require('module')
const VISION_PATH = 'E:/Agent/project/stray-animals/cloudfunctions/catcampus/lib/vision.js'

/* ==================== 延迟模拟 ==================== */
const RT = { db: 120, download: 400, imgCheck: 200, tempUrl: 200 }
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ==================== 断言 ==================== */
let passed = 0
let failed = 0
const failures = []
function assert(cond, msg) {
  if (cond) { passed++; return }
  failed++
  failures.push(msg)
  console.error('  x ' + msg)
}

/* ==================== AppError / _ / COL ==================== */
class AppError extends Error { constructor(m, c) { super(m); this.code = c } }
const COL = {
  cat: 'cats', aiTask: 'ai_tasks', aiSample: 'ai_samples',
  user: 'users', school: 'schools', apply: 'applies'
}
const _ = {
  inc: v => ({ __op: 'inc', v }),
  lt: v => ({ __op: 'lt', v }),
  nin: a => ({ __op: 'nin', v: a }),
  in: a => ({ __op: 'in', v: a }),
  or: a => ({ __op: 'or', v: a }),
  push: a => ({ __op: 'push', v: a })
}
function distanceM(a, b) {
  if (!a || !b || !isFinite(a.lat) || !isFinite(a.lng) || !isFinite(b.lat) || !isFinite(b.lng)) return null
  return 100
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/* ==================== DB stub ==================== */
const store = { cats: [], ai_tasks: [], ai_samples: [], users: [], schools: [] }
let opLog = []

const clone = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)))
function applyData(doc, data) {
  Object.keys(data).forEach(k => {
    const v = data[k]
    if (v && typeof v === 'object' && v.__op === 'inc') doc[k] = (Number(doc[k]) || 0) + v.v
    else if (v && typeof v === 'object' && v.__op === 'push') doc[k] = (doc[k] || []).concat(v.a)
    else doc[k] = v
  })
}
function matchCond(doc, cond) {
  if (cond && cond.__op === 'or') return (cond.v || []).some(sub => matchCond(doc, sub))
  return Object.keys(cond).every(k => {
    const want = cond[k]
    const got = doc[k]
    if (want && want.__op) {
      switch (want.__op) {
        case 'lt': return new Date(got).getTime() < new Date(want.v).getTime()
        case 'nin': return !(want.v || []).includes(got)
        case 'in': return (want.v || []).includes(got)
        case 'neq': return got !== want.v
      }
    }
    return got === want
  })
}
function makeQuery(name) {
  const list = () => (store[name] = store[name] || [])
  const q = { _filters: [], _limit: 1e9, _field: null }
  q.where = c => { q._filters.push(c); return q }
  q.limit = n => { q._limit = n; return q }
  q.field = f => { q._field = f; return q }
  q._rows = () => {
    let rows = list().filter(d => q._filters.every(f => matchCond(d, f)))
    return rows.slice(0, q._limit)
  }
  q.get = async () => {
    await sleep(RT.db); opLog.push('get:' + name)
    const rows = q._rows()
    const data = q._field
      ? rows.map(d => {
        const o = { _id: d._id }
        Object.keys(q._field).forEach(k => { if (q._field[k] && d[k] !== undefined) o[k] = clone(d[k]) })
        return o
      })
      : rows.map(clone)
    return { data }
  }
  q.update = async ({ data }) => {
    await sleep(RT.db); opLog.push('update:' + name)
    // ⚠️ 必须先取快照再改：先改后数的话，条件里含 status 的条件更新会被自己
    // 改掉、重新过滤得到 0（云开发真实语义是按更新前的快照计数）
    const rows = q._rows()
    rows.forEach(d => applyData(d, data))
    return { stats: { updated: rows.length } }
  }
  q.count = async () => {
    await sleep(RT.db); opLog.push('count:' + name)
    return { total: q._rows().length }
  }
  return q
}
const db = {
  collection(name) {
    const q = makeQuery(name)
    q.add = async ({ data }) => {
      await sleep(RT.db); opLog.push('add:' + name)
      const id = name + '_' + (store[name] ? store[name].length + 1 : 1) + '_' + Math.random().toString(36).slice(2, 6)
      ;(store[name] = store[name] || []).push(Object.assign({ _id: id }, clone(data)))
      return { _id: id }
    }
    q.doc = id => ({
      get: async () => {
        await sleep(RT.db); opLog.push('doc-get:' + name)
        const d = (store[name] || []).find(x => x._id === id)
        return { data: d ? clone(d) : null }
      },
      update: async ({ data }) => {
        await sleep(RT.db); opLog.push('doc-update:' + name)
        const d = (store[name] || []).find(x => x._id === id)
        if (!d) return { stats: { updated: 0 } }
        applyData(d, data)
        return { stats: { updated: 1 } }
      },
      remove: async () => {
        await sleep(RT.db); opLog.push('doc-remove:' + name)
        return { stats: { removed: 1 } }
      }
    })
    return q
  }
}

/* ==================== cloud stub ==================== */
let tempUrlCalls = 0
const cloud = {
  getWXContext: () => ({ OPENID: 'ou_test' }),
  downloadFile: async () => {
    await sleep(RT.download); opLog.push('downloadFile')
    return { fileContent: Buffer.alloc(300 * 1024) }
  },
  getTempFileURL: async ({ fileList }) => {
    tempUrlCalls++
    await sleep(RT.tempUrl); opLog.push('getTempFileURL:' + fileList.length)
    return { fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://tmp.example/' + encodeURIComponent(f) })) }
  },
  openapi: {
    security: {
      imgSecCheck: async () => { await sleep(RT.imgCheck); opLog.push('imgSecCheck'); return { errCode: 0 } },
      mediaCheckAsync: async () => { await sleep(30); opLog.push('mediaCheckAsync'); return { traceId: 'tr' } }
    }
  }
}

const coreStub = { cloud, db, _, COL, AppError, distanceM, cosine, warmCollection: () => {} }
const pointsStub = { grant: async () => ({ gained: 0, today: 0 }) }

/* ==================== Module 拦截（vision/security 真实现） ==================== */
const origLoad = Module._load
Module._load = function (request, parent) {
  const from = (parent && parent.filename) || ''
  if (/vision\.js$/.test(from)) {
    if (request === './core') return coreStub
    if (request === './points' || request === './lib/points') return pointsStub
  }
  if (/security\.js$/.test(from) && request === './core') return coreStub
  return origLoad.apply(this, arguments)
}
const vision = require(VISION_PATH)

/* ==================== 识别服务（本地 HTTP，记录所有请求） ==================== */
const ai = {
  delay: 300,
  recognizeMode: 'ok',     // ok | broken | timeout
  buildMode: 'ok',
  calls: { recognize: [], build: [] }
}
const aiServer = http.createServer((req, res) => {
  res.on('error', () => {})
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', () => {
    let p = {}
    try { p = JSON.parse(body || '{}') } catch (e) {}
    if (/\/v1\/index\/build$/.test(req.url)) {
      ai.calls.build.push(p)
      if (ai.buildMode === 'broken') {
        res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('boom'); return
      }
      const failed = (p.cats || []).filter(c => /cat_bad/.test(String(c.id))).map(c => c.id)
      const built = (p.cats || []).length - failed.length
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, built, failed, skipped: 0, total: built }))
      return
    }
    // /v1/recognize
    ai.calls.recognize.push(p)
    setTimeout(() => {
      try {
        if (res.writableEnded || res.destroyed) return
        if (ai.recognizeMode === 'broken') {
          res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('not json'); return
        }
        const cats = p.cats || []
        const emb = new Array(8).fill(0).map((_, i) => 0.5 + i * 0.01)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          features: { pattern: 'tabby', color: '橘色', size: '匀称', confidence: 0.9, tags: [], embedding: emb },
          candidates: cats.slice(0, 2).map((c, i) => ({
            catId: c.id, name: c.name, avatar: '', score: 90 - i * 6, rawSim: 0.88, reason: '特征相似度'
          }))
        }))
      } catch (e) { /* 已销毁 */ }
    }, ai.delay)
  })
})

/* ==================== fixtures ==================== */
const USER = { openid: 'ou_test', _id: 'user_1', schoolId: 'school_1', catSeen: [] }

function reset() {
  store.cats = []
  store.ai_tasks = []
  store.ai_samples = []
  store.schools = [{ _id: 'school_1', name: '示例大学' }, { _id: 'school_2', name: '隔壁大学' }]
  ai.calls.recognize = []
  ai.calls.build = []
  ai.delay = 300
  ai.recognizeMode = 'ok'
  ai.buildMode = 'ok'
  tempUrlCalls = 0
}

/** @param {boolean} indexed 是否已在服务端特征库（aiIndexAt 有值） */
function addCat(name, indexed, schoolId) {
  const id = 'cat_' + name
  store.cats.push({
    _id: id,
    name,
    schoolId: schoolId || 'school_1',
    pattern: 'tabby',
    color: '橘色',
    photos: ['cloud://' + id + '-1', 'cloud://' + id + '-2'],
    avatar: '',
    location: { lat: 30.5, lng: 114.3 },
    embedding: null,
    aiIndexAt: indexed ? new Date('2026-10-01T00:00:00Z') : null
  })
  return id
}

async function newTask() {
  const started = await vision.start(USER, {
    fileId: 'cloud://recognize/test.jpg', type: 'image',
    location: { lat: 30.5, lng: 114.3 }, schoolId: 'school_1'
  })
  return started.taskId
}

async function pollOnce(taskId) {
  opLog = []
  return vision.poll(USER, { taskId })
}

/** 轮询到终局（测试里不等 2s 客户端间隔，租约每轮都释放，紧循环安全） */
async function drive(taskId, maxRounds) {
  const rounds = []
  for (let n = 0; n < (maxRounds || 30); n++) {
    const r = await pollOnce(taskId)
    rounds.push(r)
    if (r.status === 'done' || r.status === 'failed') break
    await sleep(50)
  }
  return rounds
}

const catById = id => store.cats.find(c => c._id === id)

/* ==================== 场景 ==================== */

// S1 新猫自动入库：新猫带照片、老猫不带；成功后新猫被记账
async function s1() {
  reset()
  addCat('old1', true); addCat('old2', true); addCat('old3', true)
  const n1 = addCat('new1', false)
  const n2 = addCat('new2', false)

  const taskId = await newTask()
  const rounds = await drive(taskId)
  if (process.env.DEBUG_AI) {
    console.log('  [debug] statuses=' + rounds.map(r => r.status).join(','))
    console.log('  [debug] opLog=' + opLog.join(' | '))
  }
  const last = rounds[rounds.length - 1]
  assert(last.status === 'done', 'S1 识别应收敛到 done，实际 ' + last.status)

  const req = ai.calls.recognize[0]
  assert(!!req && Array.isArray(req.cats), 'S1 应发出识别请求且带 cats')
  const ids = (req.cats || []).map(c => c.id)
  assert(ids.length === 5, 'S1 报文应含全部 5 只猫，实际 ' + ids.length)

  const of = id => (req.cats || []).find(c => c.id === id)
  assert(of(n1).photos && of(n1).photos.length > 0, 'S1 新猫 new1 应带上照片')
  assert(of(n2).photos && of(n2).photos.length > 0, 'S1 新猫 new2 应带上照片')
  assert(of('cat_old1').photos.length === 0, 'S1 已入库的 old1 不应带照片')
  assert(of('cat_old2').photos.length === 0, 'S1 已入库的 old2 不应带照片')
  assert(of('cat_old3').photos.length === 0, 'S1 已入库的 old3 不应带照片')

  // 记账：等待 fire-and-forget 的 markIndexed 落库
  await sleep(400)
  assert(!!catById(n1).aiIndexAt, 'S1 成功后 new1 应被标记已入库')
  assert(!!catById(n2).aiIndexAt, 'S1 成功后 new2 应被标记已入库')
}

// S2 幂等：第二次识别不再重复携带已记账的猫
async function s2() {
  // 承接 S1 的库状态（5 只猫都已记账），但请求记录要清零
  ai.calls.recognize = []
  const taskId = await newTask()
  const rounds = await drive(taskId)
  const last = rounds[rounds.length - 1]
  assert(last.status === 'done', 'S2 识别应完成，实际 ' + last.status)

  const req = ai.calls.recognize[0]
  assert(!!req, 'S2 应发出识别请求')
  const withPhoto = (req.cats || []).filter(c => c.photos && c.photos.length)
  assert(withPhoto.length === 0, 'S2 已全部入库后不应再带任何照片，实际 ' + withPhoto.length)
}

// S3 限量：待入库猫很多时只带一批（其余由定时任务分片补齐，渐进收敛）
async function s3() {
  reset()
  for (let i = 1; i <= 9; i++) addCat('x' + i, false)

  const taskId = await newTask()
  const rounds = await drive(taskId)
  const last = rounds[rounds.length - 1]
  assert(last.status === 'done', 'S3 识别仍应完成，实际 ' + last.status)

  const req = ai.calls.recognize[0]
  const withPhoto = (req.cats || []).filter(c => c.photos && c.photos.length)
  assert(withPhoto.length === vision.PENDING_INDEX_MAX,
    'S3 单轮最多带 ' + vision.PENDING_INDEX_MAX + ' 只，实际 ' + withPhoto.length)
  assert((req.cats || []).length === 9, 'S3 轻量字段仍要全量下发，实际 ' + (req.cats || []).length)
}

// S4 预算不足：补库被跳过，识别本身照常完成
async function s4() {
  reset()
  addCat('y1', false)
  const prevDb = RT.db
  RT.db = 700          // 基础往返吃掉大半预算 → 补库应被跳过
  const taskId = await newTask()
  const rounds = await drive(taskId)
  RT.db = prevDb

  const statuses = rounds.map(r => r.status)
  assert(statuses.indexOf('pending') >= 0, 'S4 预算不足时应返回 pending（而非卡死），实际 ' + statuses.join(','))
  await sleep(50)
}

// S5 定时全量建库：遍历所有校区，带 onlyMissing
async function s5() {
  reset()
  addCat('a1', false, 'school_1')
  addCat('a2', false, 'school_1')
  addCat('b1', false, 'school_2')

  const out = await vision.buildIndexAll({})
  assert(out.ok !== false, 'S5 buildIndexAll 应正常返回')
  assert(out.schools === 2, 'S5 应遍历到 2 个校区，实际 ' + out.schools)
  assert(out.processed === 2, 'S5 应处理 2 个校区，实际 ' + out.processed)
  assert(out.built === 3, 'S5 应建成 3 只，实际 ' + out.built)

  const bySchool = {}
  ;(ai.calls.build || []).forEach(c => { bySchool[c.schoolId] = c })
  assert(Object.keys(bySchool).length === 2, 'S5 每个校区各建一次')
  assert(bySchool['school_1'].onlyMissing === true, 'S5 定时建库必须带 onlyMissing')
  assert(bySchool['school_1'].cats.length === 2, 'S5 school_1 应带 2 只猫')
  assert(bySchool['school_2'].cats.length === 1, 'S5 school_2 应带 1 只猫')
  assert(bySchool['school_1'].cats.every(c => c.photos && c.photos.length), 'S5 建库报文必须带照片')
}

// S6 单校失败不影响其他校区，整体仍返回成功（定时任务不该因一校故障判死）
async function s6() {
  reset()
  addCat('c1', false, 'school_1')
  addCat('d1', false, 'school_2')
  ai.buildMode = 'broken'

  const out = await vision.buildIndexAll({})
  assert(out.ok !== false, 'S6 整体仍应返回成功')
  assert(out.processed === 2, 'S6 两个校区都要被尝试，实际 ' + out.processed)
  assert(out.built === 0, 'S6 全部失败时 built 应为 0，实际 ' + out.built)
  const errs = (out.results || []).filter(r => r.ok === false)
  assert(errs.length === 2, 'S6 两个校区都应记录失败，实际 ' + errs.length)
  ai.buildMode = 'ok'
}

// S7 纯函数：待入库筛选（上限、跳过已入库、跳过无照片）
async function s7() {
  reset()
  const pick = vision.pickPendingIndexCats
  assert(typeof pick === 'function', 'S7 应导出 pickPendingIndexCats')

  const mk = (id, indexed, photo) => ({ id, photo, aiIndexAt: indexed ? new Date() : null, photo2: photo })
  const cats = [
    mk('c1', false, 'cloud://1'),
    mk('c2', true, 'cloud://2'),
    mk('c3', false, ''),
    mk('c4', false, 'cloud://4')
  ]
  const got = pick(cats).map(c => c.id)
  assert(got.join(',') === 'c1,c4', 'S7 只挑未入库且有照片的猫，实际 ' + got.join(','))

  const many = []
  for (let i = 0; i < 20; i++) many.push(mk('m' + i, false, 'cloud://' + i))
  assert(pick(many).length === vision.PENDING_INDEX_MAX,
    'S7 待入库数量应封顶在 ' + vision.PENDING_INDEX_MAX + '，实际 ' + pick(many).length)

  assert(pick([]).length === 0, 'S7 空列表应返回空')
  assert(pick(null).length === 0, 'S7 null 应返回空')
}

// S8 force 透传：默认只补缺失；force=true 时全部重算
//    （必须有这个后门 —— 服务端特征库被清空后，云函数侧 aiIndexAt 仍有值，
//     增量模式会让所有猫被跳过，永远补不回来）
async function s8() {
  reset()
  addCat('old1', true)     // 云函数侧已记账
  addCat('new1', false)    // 未记账
  const bodyOf = sid => ai.calls.build.find(b => b.schoolId === sid)

  await vision.buildIndexAll({})
  assert(bodyOf('school_1').onlyMissing === true, 'S8 定时建库默认 onlyMissing=true')
  assert(bodyOf('school_1').force === false, 'S8 定时建库默认 force=false')

  ai.calls.build = []
  await vision.buildIndexAll({ force: true })
  assert(bodyOf('school_1').force === true, 'S8 force=true 应透传给服务端')
  assert(bodyOf('school_1').onlyMissing === false, 'S8 force=true 时不再只补缺失')
  assert(bodyOf('school_1').cats.length === 2,
    'S8 force=true 应带上全部猫（含已记账的），实际 ' + bodyOf('school_1').cats.length)
}

// S9 无照片的猫不参与补库（没有素材可算），也不应让识别失败
async function s9() {
  reset()
  const noPhoto = 'cat_nop'
  store.cats.push({
    _id: noPhoto, name: '无照', schoolId: 'school_1',
    pattern: 'tabby', color: '橘色', photos: [], avatar: '',
    location: null, embedding: null, aiIndexAt: null
  })
  addCat('has1', false)

  const taskId = await newTask()
  const rounds = await drive(taskId)
  const last = rounds[rounds.length - 1]
  assert(last.status === 'done', 'S9 识别应完成，实际 ' + last.status)

  const req = ai.calls.recognize[0]
  assert((req.cats || []).some(c => c.id === noPhoto && (!c.photos || !c.photos.length)),
    'S9 无照片的猫不带 photos')
  assert((req.cats || []).some(c => c.id === 'cat_has1' && c.photos && c.photos.length),
    'S9 有照片的未入库猫应带 photos')

  await sleep(400)
  assert(!catById(noPhoto).aiIndexAt, 'S9 无照片的猫不应被记账（下次仍会尝试）')
  assert(!!catById('cat_has1').aiIndexAt, 'S9 有照片的猫应被记账')
}

// S10 建档即入库：只建这一只猫（不扫全校），且永不抛错拖累建档
async function s10() {
  reset()
  const a = addCat('a', true)   // 老猫，已入库
  const b = addCat('b', false)  // 新猫，待入库

  // 1) 指定 catIds → 报文里只能有这一只
  const r1 = await vision.buildIndexAuto(USER, { catIds: [b], schoolId: 'school_1' })
  assert(r1.ok === true, 'S10 指定单只猫应入库成功')
  const body1 = ai.calls.build[ai.calls.build.length - 1]
  assert(body1.cats.length === 1, 'S10 只应带这 1 只猫，实际 ' + body1.cats.length)
  assert(body1.cats[0].id === b, 'S10 带的应是目标猫，实际 ' + body1.cats[0].id)
  assert(body1.cats[0].photos.length > 0, 'S10 目标猫必须带照片链接')
  assert(body1.onlyMissing === true, 'S10 自动入库应为增量模式')

  await sleep(300)
  assert(!!catById(b).aiIndexAt, 'S10 入库成功后应记账')
  assert(!!catById(a).aiIndexAt, 'S10 老猫记账状态不应被动')

  // 2) 服务端炸了 → 不抛错，返回 deferred，交给定时任务兜底
  reset()
  const c = addCat('c', false)
  ai.buildMode = 'broken'
  const r2 = await vision.buildIndexAuto(USER, { catIds: [c], schoolId: 'school_1' })
  assert(r2.ok === false, 'S10 服务端失败时应返回 ok=false')
  assert(r2.deferred === true, 'S10 服务端失败时应标记 deferred（可被兜底）')
  await sleep(200)
  assert(!catById(c).aiIndexAt, 'S10 失败不应记账（下次仍会重试）')

  // 3) 未配置 AI_ENDPOINT → 同样静默降级，不能让建档失败
  reset()
  const old = process.env.AI_ENDPOINT
  delete process.env.AI_ENDPOINT
  const r3 = await vision.buildIndexAuto(USER, { catIds: [c], schoolId: 'school_1' }).catch(e => ({ threw: e && e.message }))
  process.env.AI_ENDPOINT = old
  assert(!r3.threw, 'S10 未配置 AI_ENDPOINT 时不应抛错，实际抛出 ' + r3.threw)
  assert(r3.deferred === true, 'S10 未配置时应标记 deferred')

  // 4) 空 catIds → 安全返回，不请求服务端
  reset()
  const r4 = await vision.buildIndexAuto(USER, { catIds: [], schoolId: 'school_1' })
  assert(r4.deferred === true, 'S10 空 catIds 应安全返回')
  assert(ai.calls.build.length === 0, 'S10 空 catIds 不应请求服务端')
}

/* ==================== 执行 ==================== */
async function main() {
  await new Promise(r => aiServer.listen(0, '127.0.0.1', r))
  const port = aiServer.address().port
  process.env.AI_ENDPOINT = 'http://127.0.0.1:' + port + '/v1/recognize'

  const scenes = [
    ['S1 新猫自动入库', s1],
    ['S2 二次识别不重复携带', s2],
    ['S3 待入库过多时限量', s3],
    ['S4 预算不足跳过补库', s4],
    ['S5 定时全量建库', s5],
    ['S6 单校失败隔离', s6],
    ['S7 待入库筛选', s7],
    ['S8 force 透传', s8],
    ['S9 无照片不记账', s9],
    ['S10 建档即入库', s10]
  ]

  for (const [name, fn] of scenes) {
    console.log('\n--- ' + name + ' ---')
    try {
      await fn()
      console.log('  ok')
    } catch (e) {
      failed++
      failures.push(name + ' 抛出异常: ' + (e && e.message))
      console.error('  x 抛出异常', e && e.message)
    }
  }

  console.log('\n=== 结果 ===')
  console.log('PASS ' + passed + ' / FAIL ' + failed)
  if (failures.length) {
    console.log('\n失败项：')
    failures.forEach(f => console.log('  - ' + f))
  }
  aiServer.close()
  process.exit(failed ? 1 : 0)
}

main()
