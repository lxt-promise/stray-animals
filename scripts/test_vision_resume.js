/**
 * 识别链路行为级测试（cloudfunctions/catcampus/lib/vision.js）
 *
 * 背景：2026-10-13 一次回归把「改前能识别」改成「27 轮轮询全部 -504003」。
 * 根因是分步续跑的每一步仍逼近/超过客户端约 3s 的 callFunction 预算，
 * 步骤字段又没能落库 → 每轮从头重跑同一阶段 → 永不收敛。
 *
 * 本测试用 Module._load 拦截 stub 掉 core/security 的依赖（cloud/db 带真实延迟模拟），
 * vision.js 与 security.js 用真实实现，识别服务用本地 HTTP 服务器模拟（可配置快/慢/坏），
 * 然后断言四条生存线：
 *   1) 每一次 poll 调用都 < 3000ms（客户端预算）；
 *   2) 单次 poll 的 DB 往返 ≤ 7；
 *   3) 写入任务文档的 payload < 12KB（云数据库单文档体积红线，旧病根是整库 catsLite）；
 *   4) 各种扰动（AI 慢/坏、调用被杀、写入失败、慢雾）下任务最终都收敛到 done。
 *
 * 运行：node scripts/test_vision_resume.js
 */
const http = require('http')
const Module = require('module')
const VISON_PATH = 'E:/Agent/project/stray-animals/cloudfunctions/catcampus/lib/vision.js'

/* ==================== 延迟模拟 ==================== */
const RT = { db: 180, download: 700, imgCheck: 350, tempUrl: 300 }
const GETME_MS = 200        // index.js 里 getMe 的一次 DB 往返（poll 之外的开销）
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
function assertLt(actual, limit, msg) {
  assert(actual < limit, msg + '（实际 ' + actual + 'ms，上限 ' + limit + 'ms）')
}

/* ==================== AppError / _ / COL ==================== */
class AppError extends Error { constructor(m, c) { super(m); this.code = c } }
const COL = { cat: 'cats', aiTask: 'ai_tasks', aiSample: 'ai_samples', user: 'users', apply: 'applies' }
const _ = {
  inc: v => ({ __op: 'inc', v }),
  lt: v => ({ __op: 'lt', v }),
  nin: a => ({ __op: 'nin', a }),
  in: a => ({ __op: 'in', a }),
  or: a => ({ __op: 'or', a }),
  push: a => ({ __op: 'push', a })
}
function distanceM(a, b) {
  if (!a || !b || !isFinite(a.lat) || !isFinite(a.lng) || !isFinite(b.lat) || !isFinite(b.lng)) return null
  const R = 6371000
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return 2 * R * Math.asin(Math.sqrt(s))
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/* ==================== DB stub（带延迟 + 条件更新语义） ==================== */
const store = { cats: [], ai_tasks: [], ai_samples: [], users: [], applies: [] }
let opLog = []
let maxWriteBytes = 0
let failUpdates = 0     // >0 时 doc().update 返回 updated:0（模拟写入未生效）

const clone = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)))
function matchDoc(doc, where) {
  return Object.keys(where).every(k => {
    const cond = where[k]
    if (cond && typeof cond === 'object' && cond.__op === 'lt') return new Date(doc[k]).getTime() < new Date(cond.v).getTime()
    if (cond && typeof cond === 'object' && cond.__op === 'nin') return cond.a.indexOf(doc[k]) < 0
    if (cond && typeof cond === 'object' && cond.__op === 'in') return cond.a.indexOf(doc[k]) >= 0
    return doc[k] === cond
  })
}
function applyData(doc, data) {
  Object.keys(data).forEach(k => {
    const v = data[k]
    if (v && typeof v === 'object' && v.__op === 'inc') doc[k] = (Number(doc[k]) || 0) + v.v
    else if (v && typeof v === 'object' && v.__op === 'push') doc[k] = (doc[k] || []).concat(v.a)
    else doc[k] = v
  })
}
const db = {
  collection(name) {
    if (!store[name]) store[name] = []
    const coll = {}
    coll.add = async ({ data }) => {
      await sleep(RT.db); opLog.push('add:' + name)
      maxWriteBytes = Math.max(maxWriteBytes, JSON.stringify(data).length)
      const id = name + '_' + (store[name].length + 1) + '_' + Math.random().toString(36).slice(2, 6)
      store[name].push(Object.assign({ _id: id }, clone(data)))
      return { _id: id }
    }
    coll.doc = id => ({
      get: async () => {
        await sleep(RT.db); opLog.push('get:' + name)
        const d = store[name].find(x => x._id === id)
        return { data: d ? clone(d) : null }
      },
      update: async ({ data }) => {
        await sleep(RT.db); opLog.push('update:' + name)
        maxWriteBytes = Math.max(maxWriteBytes, JSON.stringify(data).length)
        if (failUpdates > 0) { failUpdates--; return { stats: { updated: 0 } } }
        const d = store[name].find(x => x._id === id)
        if (!d) return { stats: { updated: 0 } }
        applyData(d, data)
        return { stats: { updated: 1 } }
      }
    })
    coll.where = where => {
      const q = {}
      q.limit = n => { q._limit = n; return q }
      q.field = f => { q._field = f; return q }
      q.get = async () => {
        await sleep(RT.db); opLog.push('where-get:' + name)
        let list = store[name].filter(d => matchDoc(d, where))
        if (q._limit) list = list.slice(0, q._limit)
        const data = q._field
          ? list.map(d => { const o = { _id: d._id }; Object.keys(q._field).forEach(k => { if (q._field[k] && d[k] !== undefined) o[k] = clone(d[k]) }); return o })
          : list.map(clone)
        return { data }
      }
      q.update = async ({ data }) => {
        await sleep(RT.db); opLog.push('where-update:' + name)
        maxWriteBytes = Math.max(maxWriteBytes, JSON.stringify(data).length)
        const targets = store[name].filter(d => matchDoc(d, where))
        targets.forEach(d => applyData(d, data))
        return { stats: { updated: targets.length } }
      }
      return q
    }
    return coll
  }
}

/* ==================== cloud stub ==================== */
const cloud = {
  getWXContext: () => ({ OPENID: 'ou_test' }),
  downloadFile: async ({ fileID }) => {
    await sleep(RT.download); opLog.push('downloadFile')
    return { fileContent: Buffer.alloc(600 * 1024) }   // 600KB → 走同步 imgSecCheck
  },
  getTempFileURL: async ({ fileList }) => {
    await sleep(RT.tempUrl); opLog.push('getTempFileURL:' + fileList.length)
    return { fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://tmp.example/' + encodeURIComponent(f) })) }
  },
  openapi: {
    security: {
      imgSecCheck: async () => { await sleep(RT.imgCheck); opLog.push('imgSecCheck'); return { errCode: 0 } },
      mediaCheckAsync: async () => { await sleep(50); opLog.push('mediaCheckAsync'); return { traceId: 'tr' } }
    }
  }
}
const coreStub = { cloud, db, _, COL, AppError, distanceM, cosine, warmCollection: () => {} }
const pointsStub = { grant: async () => ({ gained: 0, today: 0 }) }

/* ==================== Module 拦截（vision/security 真实现，core/points stub） ==================== */
const origLoad = Module._load
Module._load = function (request, parent) {
  const from = (parent && parent.filename) || ''
  if (/vision\.js$/.test(from)) {
    if (request === './core') return coreStub
    if (request === './points') return pointsStub
  }
  if (/security\.js$/.test(from) && request === './core') return coreStub
  return origLoad.apply(this, arguments)
}
const vision = require(VISON_PATH)

/* ==================== 识别服务（本地 HTTP，行为可配置） ==================== */
const aiBehavior = { delay: 900, mode: 'ok', candidates: 2 }
const aiServer = http.createServer((req, res) => {
  res.on('error', () => {})   // 调用方超时销毁后不再理会
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', () => {
    let parsed = {}
    try { parsed = JSON.parse(body || '{}') } catch (e) {}
    setTimeout(() => {
      try {
        if (res.writableEnded || res.destroyed || (res.socket && res.socket.destroyed)) return
        if (aiBehavior.mode === 'broken') {
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end('this is not json')
          return
        }
        if (aiBehavior.mode === 'http401') {
          // 忠实模拟服务端鉴权失败：响应体是合法 JSON 的 {"detail":...}
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ detail: 'invalid token' }))
          return
        }
        // 忠实模拟服务端契约：用请求里的 cats 回表 name；photos 没带所以 avatar 为空
        const nameById = {}
        ;(parsed.cats || []).forEach(c => { nameById[c.id] = c.name })
        const ids = (parsed.cats || []).map(c => c.id).slice(0, aiBehavior.candidates)
        const emb = []
        for (let i = 0; i < 8; i++) emb.push(Math.round(Math.random() * 100) / 100)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          features: { pattern: 'tabby', color: '橘色', size: '匀称', confidence: 0.91, tags: [{ k: '毛色', v: '橘色' }], embedding: emb },
          candidates: ids.map((cid, i) => ({
            catId: cid, name: nameById[cid] || '', avatar: '',
            score: 92 - i * 7, rawSim: 0.9, reason: '特征相似度 ' + (90 - i * 7) + '.0%'
          }))
        }))
      } catch (e) { /* 连接已销毁，忽略 */ }
    }, aiBehavior.delay)
  })
})

/* ====================  fixtures ==================== */
const USER = { openid: 'ou_test', _id: 'user_1', catSeen: [], schoolId: 'school_1' }
function seedCats(n) {
  store.cats = []
  const patterns = ['tabby', 'cow', 'white', 'orange', 'calico', 'black', 'gray']
  const colors = ['橘色', '黑白', '纯白']
  for (let i = 0; i < n; i++) {
    const id = 'cat_' + String(i + 1).padStart(3, '0')
    store.cats.push({
      _id: id,
      name: '喵喵' + (i + 1),
      schoolId: 'school_1',
      pattern: patterns[i % patterns.length],
      color: colors[i % 3],
      photos: ['cloud://' + id + '-1', 'cloud://' + id + '-2', 'cloud://' + id + '-3'],
      avatar: 'cloud://' + id + '-av',
      location: { lat: 32.0585 + (i % 10) * 0.001, lng: 118.7967 + (i % 10) * 0.001 },
      // 偶数索引带 embedding：模拟已确认过、写回特征库的档案（本地兜底走向量打分的来源）
      embedding: i % 2 === 0 ? new Array(512).fill(0).map((_, j) => ((i * 31 + j * 7) % 100) / 100) : null
    })
  }
}
async function newTask(overrides) {
  const started = await vision.start(USER, Object.assign({
    fileId: 'cloud://recognize/test.jpg', type: 'image', location: { lat: 32.0585, lng: 118.7967 }
  }, overrides))
  return started.taskId
}
/** 模拟一次完整的客户端调用：前置开销（冷启动 + getMe 往返）+ vision.poll
 *
 * ⚠️ startedAt 必须传进去：真实入口 index.js main 就是这样调的 ——
 * 预算从「调用进入」起算，而不是从 poll() 内部起算。
 * 早期测试只在外面 sleep 模拟 getMe，却没把入口时间传进去，
 * 于是「每次 poll 都 < 3s」的断言在测试里永远为真，线上却每次 -504003。
 */
async function pollOnce(taskId, opts) {
  opLog = []
  const t0 = Date.now()
  await sleep((opts && opts.preMs != null) ? opts.preMs : GETME_MS)
  const r = await vision.poll(USER, { taskId }, { startedAt: t0 })
  return { r, ms: Date.now() - t0, ops: opLog.slice() }
}
/** 轮询到终局（测试里不等 2s 客户端间隔，租约每轮都释放，紧循环安全） */
async function drive(taskId, opts) {
  const maxRounds = (opts && opts.maxRounds) || 40
  const cadence = (opts && opts.cadence != null) ? opts.cadence : 100
  const rounds = []
  for (let n = 0; n < maxRounds; n++) {
    const rd = await pollOnce(taskId, opts)
    rounds.push(rd)
    if (rd.r.status === 'done' || rd.r.status === 'failed') break
    await sleep(cadence)
  }
  return rounds
}
function assertBudget(rounds, label) {
  rounds.forEach((rd, i) => {
    assertLt(rd.ms, 3000, label + ' 第' + (i + 1) + ' 次 poll 必须在 3s 内返回')
    // 只数 DB 往返（cloud 的 downloadFile/imgSecCheck 等不计入，由时长断言覆盖）
    const dbOps = rd.ops.filter(o => /^(get|update|where-update|where-get|add):/.test(o))
    assert(dbOps.length <= 7, label + ' 第' + (i + 1) + ' 次 poll DB 往返过多：' + dbOps.length + ' (' + dbOps.join(',') + ')')
  })
}

/* ==================== 场景 ==================== */

// S1 快路径：AI 900ms，200 只猫的库
async function s1() {
  seedCats(200)
  aiBehavior.mode = 'ok'; aiBehavior.delay = 900
  const taskId = await newTask()
  const rounds = await drive(taskId)
  assertBudget(rounds, 'S1')
  const last = rounds[rounds.length - 1].r
  assert(last.status === 'done', 'S1 应收敛到 done，实际 ' + last.status + ' ' + JSON.stringify(last).slice(0, 200))
  assert(last.result && last.result.provider === 'custom', 'S1 provider 应为 custom')
  assert(last.result.candidates.length > 0, 'S1 应有候选')
  assert(last.result.candidates[0].name && last.result.candidates[0].name !== '未知',
    'S1 候选名称应被 cats 回表 enriched，实际 ' + JSON.stringify(last.result.candidates[0]))
  assert(/^cloud:\/\//.test(last.result.candidates[0].avatar || ''),
    'S1 候选头像应回落到 cloud:// fileID（image 组件可渲染），实际 ' + last.result.candidates[0].avatar)
  const task = store.ai_tasks.find(t => t._id === taskId)
  assert(task.partial && task.partial.url, 'S1 partial 应含 url')
  assert(!task.partial.catsLite, 'S1 partial 不应含 catsLite（大文档病根）')
  assert(rounds.length <= 6, 'S1 轮询次数应 ≤6，实际 ' + rounds.length)
}

// S2 AI 持续超时（5s > 封顶）：每轮仍 <3s，超时不烧降级阈值，达总尝试上限后降级本地引擎
async function s2() {
  seedCats(50)
  aiBehavior.mode = 'ok'; aiBehavior.delay = 5000
  const taskId = await newTask()
  const rounds = await drive(taskId, { cadence: 100 })
  assertBudget(rounds, 'S2')
  const last = rounds[rounds.length - 1].r
  assert(last.status === 'done', 'S2 最终应降级本地引擎并 done，实际 ' + last.status)
  assert(last.result.provider === 'local', 'S2 provider 应为 local')
  assert(last.result.candidates.length > 0, 'S2 本地兜底也应有候选')
  const task = store.ai_tasks.find(t => t._id === taskId)
  assert(Number(task.partial.aiAttempts) >= 12, 'S2 aiAttempts 应达到上限 12，实际 ' + task.partial.aiAttempts)
  assert(Number(task.partial.featFails) === 0, 'S2 超时不应计入 featFails，实际 ' + task.partial.featFails)
}

// S3 AI 明确错误（非 JSON）：6 次后降级
async function s3() {
  seedCats(50)
  aiBehavior.mode = 'broken'; aiBehavior.delay = 100
  const taskId = await newTask()
  const rounds = await drive(taskId, { cadence: 100 })
  assertBudget(rounds, 'S3')
  const last = rounds[rounds.length - 1].r
  assert(last.status === 'done' && last.result.provider === 'local', 'S3 应降级本地引擎并 done')
  const task = store.ai_tasks.find(t => t._id === taskId)
  assert(Number(task.partial.featFails) >= 6, 'S3 featFails 应达到 6，实际 ' + task.partial.featFails)
}

// S4 悲观语义：调用在写步骤前被 3s 预算杀掉 → 租约期内并发 poll 只见 running，过期后回收续跑
async function s4() {
  seedCats(20)
  aiBehavior.mode = 'ok'; aiBehavior.delay = 900
  const taskId = await newTask()
  const first = await pollOnce(taskId)
  assert(first.r.status === 'pending' && first.r.progress === 30, 'S4 第一步应推进到 30，实际 ' + JSON.stringify(first.r))
  // 模拟第二次调用的云函数抢到租约后、写步骤前被杀
  const task = store.ai_tasks.find(t => t._id === taskId)
  task.status = 'running'
  task.leaseUntil = new Date(Date.now() + 5000)
  const blocked = await pollOnce(taskId)
  assert(blocked.r.status === 'running', 'S4 租约有效时并发 poll 应看到 running，实际 ' + blocked.r.status)
  assertLt(blocked.ms, 1500, 'S4 并发 poll 应快速返回')
  assert(blocked.ops.length <= 3, 'S4 并发 poll 不应推进步骤，实际 ops: ' + blocked.ops.join(','))
  assert(blocked.ops.indexOf('downloadFile') < 0, 'S4 并发 poll 不应重跑内容安全')
  // 执行者已死：租约过期 → 回收并续跑
  task.leaseUntil = new Date(Date.now() - 1000)
  const rounds = await drive(taskId)
  assertBudget(rounds, 'S4 恢复后')
  const last = rounds[rounds.length - 1].r
  assert(last.status === 'done', 'S4 恢复后应收敛到 done，实际 ' + last.status)
  assert(last.result.candidates.length > 0, 'S4 恢复后应有候选')
}

// S5 断点续跑：步骤已落库但状态没释放（杀在两个写中间）→ 恢复后不重跑前面步骤
async function s5() {
  seedCats(20)
  aiBehavior.mode = 'ok'; aiBehavior.delay = 900
  const taskId = await newTask()
  await pollOnce(taskId)   // step '' → 'sec'
  const task = store.ai_tasks.find(t => t._id === taskId)
  assert(task.step === 'sec', 'S5 前提：第一步应已落库为 sec')
  task.status = 'running'
  task.leaseUntil = new Date(Date.now() - 1000)
  const rounds = await drive(taskId)
  assertBudget(rounds, 'S5 中断续跑')
  const last = rounds[rounds.length - 1].r
  assert(last.status === 'done', 'S5 应续跑到 done')
  assert(rounds[0].ops.indexOf('downloadFile') < 0, 'S5 恢复后不应重跑内容安全（断点续跑），实际 ops: ' + rounds[0].ops.join(','))
  assert(rounds[0].ops.indexOf('getTempFileURL:1') >= 0, 'S5 恢复后应从换链接继续，实际 ops: ' + rounds[0].ops.join(','))
}

// S6 写入未生效：必须 error 级吼叫 + 退回 pending 重试，绝不当成功继续走
async function s6() {
  seedCats(20)
  aiBehavior.mode = 'ok'; aiBehavior.delay = 900
  const errs = []
  const origErr = console.error
  console.error = (...a) => { errs.push(a.join(' ')) }
  const taskId = await newTask()
  failUpdates = 1
  const { r } = await pollOnce(taskId)
  console.error = origErr
  assert(r.status === 'pending', 'S6 写入失败应退回 pending 等待重试，实际 ' + r.status)
  assert(errs.some(e => /任务字段更新未生效/.test(e)), 'S6 写入失败必须 error 级吼叫，实际 ' + JSON.stringify(errs.slice(0, 3)))
  const task = store.ai_tasks.find(t => t._id === taskId)
  assert(task.step === '', 'S6 写入失败后 step 不应前进，实际 ' + task.step)
  const rounds = await drive(taskId)
  const last = rounds[rounds.length - 1].r
  assert(last.status === 'done', 'S6 恢复后应 done，实际 ' + last.status)
}

// S7 同步安全检测连续未完成 → 降级异步送检，保证收敛
async function s7() {
  seedCats(5)
  aiBehavior.mode = 'ok'; aiBehavior.delay = 900
  const taskId = await newTask()
  const task = store.ai_tasks.find(t => t._id === taskId)
  task.partial = { secTries: 2 }
  const { r, ops } = await pollOnce(taskId)
  assert(r.status === 'pending', 'S7 应推进，实际 ' + r.status)
  assert(ops.indexOf('downloadFile') < 0, 'S7 降级后不应再下载整图，实际 ops: ' + ops.join(','))
  assert(ops.indexOf('mediaCheckAsync') >= 0, 'S7 应走异步送检，实际 ops: ' + ops.join(','))
}

// S8 慢雾：基础往返就吃掉大半预算 → 不抢租约不开工，恢复后照常收敛
async function s8() {
  seedCats(5)
  aiBehavior.mode = 'ok'; aiBehavior.delay = 900
  RT.db = 800
  const taskId = await newTask()
  const slow = await pollOnce(taskId)   // 慢雾下的第一次 poll
  RT.db = 180
  assert(slow.r.status === 'pending', 'S8 预算不足应回 pending，实际 ' + slow.r.status)
  assertLt(slow.ms, 3000, 'S8 应快速返回')
  assert(slow.ops.indexOf('downloadFile') < 0, 'S8 预算不足不应开工内容安全，实际 ops: ' + slow.ops.join(','))
  const task = store.ai_tasks.find(t => t._id === taskId)
  assert(task.status === 'pending', 'S8 应释放租约，实际 ' + task.status)
  assert(task.step === '', 'S8 步骤不应前进，实际 ' + task.step)
  // 网络恢复后照常收敛
  const rounds = await drive(taskId)
  const last = rounds[rounds.length - 1].r
  assert(last.status === 'done', 'S8 恢复后应 done，实际 ' + last.status)
}

// S9 同步快路径：AI 2500ms（超过 3s 客户端预算，但同步路径允许等满）→ 一把出真实匹配
async function s9() {
  seedCats(20)
  aiBehavior.mode = 'ok'; aiBehavior.delay = 2500
  const taskId = await newTask()
  const t0 = Date.now()
  const r = await vision.runSync(USER, { taskId })
  const ms = Date.now() - t0
  assert(r && r.candidates && r.candidates.length > 0, 'S9 同步路径应出结果')
  assert(r.provider === 'custom', 'S9 provider 应为 custom')
  assertLt(ms, 12000, 'S9 同步路径应在 action 预算(15s)内完成')
  const task = store.ai_tasks.find(t => t._id === taskId)
  assert(task.status === 'done', 'S9 任务应 done')
}

// S10 同步路径可重试错误：不判死，轮询接管后收敛
async function s10() {
  seedCats(10)
  aiBehavior.mode = 'broken'; aiBehavior.delay = 100
  const taskId = await newTask()
  let threw = null
  try { await vision.runSync(USER, { taskId }) } catch (e) { threw = e }
  assert(threw && /非 JSON/.test(threw.message), 'S10 同步路径应抛错，实际 ' + (threw && threw.message))
  const task = store.ai_tasks.find(t => t._id === taskId)
  assert(task.status !== 'failed', 'S10 可重试错误不应把任务判死，实际 ' + task.status)
  assert(task.lastError, 'S10 应记录 lastError')
  // 客户端会持续轮询十几秒等到租约过期；测试里直接模拟「租约已过期」
  task.leaseUntil = new Date(Date.now() - 1000)
  aiBehavior.mode = 'ok'; aiBehavior.delay = 900
  const rounds = await drive(taskId)
  const last = rounds[rounds.length - 1].r
  assert(last.status === 'done', 'S10 轮询接管后应 done，实际 ' + last.status)
}

// S11 兼容旧调用方：不传 taskId 的 runSync
async function s11() {
  seedCats(10)
  aiBehavior.mode = 'ok'; aiBehavior.delay = 900
  const r = await vision.runSync(USER, { fileId: 'cloud://recognize/legacy.jpg', type: 'image' })
  assert(r && r.candidates && r.candidates.length > 0, 'S11 兼容路径应出结果')
  assert(r.taskId, 'S11 应返回 taskId')
}

// S12 兼容旧版本遗留任务：partial 里带一整库 catsLite，新代码能接管且不撑爆文档
async function s12() {
  seedCats(10)
  aiBehavior.mode = 'ok'; aiBehavior.delay = 900
  const taskId = await newTask()
  const task = store.ai_tasks.find(t => t._id === taskId)
  task.step = 'sec'
  task.status = 'running'
  task.leaseUntil = new Date(Date.now() - 1000)
  task.partial = {
    sec: true, url: 'https://tmp.example/old', videoUrl: '',
    catsLite: store.cats.map(c => ({ id: c._id, name: c.name, pattern: c.pattern, color: c.color, photo: c.avatar, location: c.location, embedding: null }))
  }
  const rounds = await drive(taskId)
  assertBudget(rounds, 'S12 兼容旧任务')
  const last = rounds[rounds.length - 1].r
  assert(last.status === 'done', 'S12 旧任务应续跑到 done，实际 ' + last.status)
  const t2 = store.ai_tasks.find(x => x._id === taskId)
  assert(t2.partial.catsLite, 'S12 旧 partial 字段应被保留')
  assert(/^https?:/.test(t2.partial.url || ''), 'S12 url 应被刷新为临时链接')
}

// S13 人工确认幂等（vision.js 重写后的回归烟测）
async function s13() {
  seedCats(10)
  aiBehavior.mode = 'ok'; aiBehavior.delay = 900
  const taskId = await newTask()
  await drive(taskId)
  const r1 = await vision.confirm(USER, { taskId, catId: 'cat_001', correct: true })
  assert(r1.ok, 'S13 确认应成功')
  const r2 = await vision.confirm(USER, { taskId, catId: 'cat_001', correct: true })
  assert(r2.duplicated === true, 'S13 重复确认应被幂等拦截，实际 ' + JSON.stringify(r2))
}

// S14 视频路径：封面帧作代表帧 + 异步媒体检测
async function s14() {
  seedCats(10)
  aiBehavior.mode = 'ok'; aiBehavior.delay = 900
  const taskId = await newTask({ type: 'video', fileId: 'cloud://recognize/v.mp4', thumbId: 'cloud://recognize/v-thumb.jpg', duration: 12 })
  const rounds = await drive(taskId)
  assertBudget(rounds, 'S14 视频')
  const last = rounds[rounds.length - 1].r
  assert(last.status === 'done', 'S14 视频应 done，实际 ' + last.status)
  assert(last.result.frames === 6, 'S14 12s 视频应计划抽 6 帧，实际 ' + last.result.frames)
  assert(rounds[0].ops.indexOf('mediaCheckAsync') >= 0, 'S14 视频应走异步媒体检测，实际 ops: ' + rounds[0].ops.join(','))
  const task = store.ai_tasks.find(t => t._id === taskId)
  assert(task.partial.videoUrl, 'S14 应有 videoUrl')
}

// S15 前置开销（冷启动 + 慢 getMe）吃掉大半预算 → 必须早退，绝不能硬干活
//
// 背景（2026-10-14 线上事故）：小程序每次轮询都 -504003「Invoking task timed out after 3 seconds」。
// 根因：poll 的 2.4s 预算从 **handler 内部** 起算，云函数冷启动（加载 node_modules）
// 和 getMe() 的 DB 往返都在这之前发生 —— 2.4s + 前置开销必然顶穿客户端约 3s 的硬预算。
// 修复：预算改从调用入口（ctx.startedAt）起算，前置慢就自然早退 pending。
async function s15() {
  seedCats(10)
  aiBehavior.mode = 'ok'; aiBehavior.delay = 900
  const taskId = await newTask({ type: 'image' })
  // 冷启动 + getMe 合计 1.4s：剩余预算只剩 1s，不足以完成任何一步
  const rounds = await drive(taskId, { maxRounds: 5, cadence: 50, preMs: 1400 })
  assertBudget(rounds, 'S15 慢前置')
  const maxMs = Math.max.apply(null, rounds.map(r => r.ms))
  assertLt(maxMs, 3000, 'S15 前置 1.4s 时单次调用仍须 < 3s（实际 ' + maxMs + 'ms）')
  // 早退的判据：每轮只做极少的 DB 往返（读完任务就退），绝不抢租约、绝不调 AI
  rounds.forEach((rd, i) => {
    const dbOps = rd.ops.filter(o => /^(get|update|where-update|where-get|add):/.test(o))
    assert(dbOps.length <= 3, 'S15 第' + (i + 1) + '轮应早退（DB 往返 ≤3），实际 ' + dbOps.length + ' (' + dbOps.join(',') + ')')
    assert(rd.r && rd.r.status === 'pending', 'S15 第' + (i + 1) + '轮应回 pending，实际 ' + (rd.r && rd.r.status))
  })
  // 预算够时仍要能正常推进（证明只是早退、不是永久卡死）
  const normal = await drive(taskId, { maxRounds: 40, cadence: 50 })
  const last = normal[normal.length - 1].r
  assert(last.status === 'done', 'S15 前置恢复正常后应能跑到 done，实际 ' + last.status)
}

// S16 识别服务返回 HTTP 401（鉴权失败）→ 必须显式失败，绝不能包装成「建成 0 只」
//
// 背景（2026-10-14 线上事故）：AI_TOKEN 与 API_TOKEN 不一致 → /v1/index/build 全部 401，
// 旧版 callVisionApi 只解析响应体不看状态码，{"detail":"invalid token"} 被静默 resolve，
// 管理页显示「已建 0 只，跳过 0 只」—— 鉴权故障被伪装成「没猫可建」，排查方向全错。
async function s16() {
  seedCats(10)
  aiBehavior.mode = 'http401'; aiBehavior.delay = 50
  let err = null
  try {
    await vision.buildIndex(USER, { schoolId: USER.schoolId, photosPerCat: 2, timeoutMs: 1500 })
  } catch (e) { err = e }
  assert(err && /HTTP 401/.test(err.message),
    'S16 buildIndex 应抛「HTTP 401」，实际: ' + (err && err.message))
  assert(/invalid token/.test(err && err.message || ''),
    'S16 错误信息应带上服务端 detail（便于定位鉴权），实际: ' + (err && err.message))
}

/* ====================  runner ==================== */
(async () => {
  await new Promise(r => aiServer.listen(0, '127.0.0.1', r))
  process.env.AI_ENDPOINT = 'http://127.0.0.1:' + aiServer.address().port + '/v1/recognize'

  const scenarios = [
    ['S1 快路径（AI 900ms / 200 只猫）', s1],
    ['S2 AI 持续超时 → 有界重试后降级', s2],
    ['S3 AI 明确错误 → 6 次后降级', s3],
    ['S4 调用被杀 → 租约恢复', s4],
    ['S5 断点续跑（杀在两个写中间）', s5],
    ['S6 写入未生效 → 吼叫 + 重试', s6],
    ['S7 同步检测连续未完成 → 异步送检', s7],
    ['S8 慢雾 → 不抢租约不开工', s8],
    ['S9 同步快路径（AI 2500ms）', s9],
    ['S10 同步可重试错误 → 轮询接管', s10],
    ['S11 兼容旧调用方（无 taskId）', s11],
    ['S12 兼容旧版本遗留任务', s12],
    ['S13 人工确认幂等烟测', s13],
    ['S14 视频路径', s14],
    ['S15 前置开销（冷启动+慢 getMe）→ 早退不超时', s15],
    ['S16 鉴权 401 → 显式失败不假成功', s16]
  ]
  for (const [name, fn] of scenarios) {
    console.log('=== ' + name + ' ===')
    opLog = []
    try {
      await fn()
    } catch (e) {
      failed++
      failures.push(name + ' 异常: ' + (e && e.stack || e))
      console.error('  x 异常', e && e.stack || e)
    }
  }

  // 全局红线：全程最大单次写入必须远小于云数据库单文档上限（旧病根是整库 catsLite 上 MB）
  assert(maxWriteBytes < 12288, '全程最大单次写入必须 < 12KB，实际 ' + maxWriteBytes + 'B')

  console.log('\n========== 结果 ==========')
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项')
  console.log('全程最大单次写入: ' + maxWriteBytes + 'B')
  if (failures.length) {
    console.log('失败明细:')
    failures.forEach(f => console.log(' - ' + f))
  }
  aiServer.close(() => process.exit(failed ? 1 : 0))
})()
