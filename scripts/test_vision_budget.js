#!/usr/bin/env node
/**
 * 同步快路径预算（runSync + run 的 syncCtx）行为级测试（2026-10-15 ④）
 *
 * 现场：上传「另一只猫」识别，控制台刷
 *   `-504003 Invoking task timed out after 3 seconds`
 *   → 客户端 `同步识别未直接返回，转轮询接管` → pollResult 8 连败判死（已在 recognize.js 修）
 *
 * 本测试聚焦云函数侧那一半。先厘清一个曾经搞混的点：
 *   `POLL_BUDGET_MS=2400` 是**轮询**预算，语义是「一次调用只推进一步」；
 *   同步路径要串完三步，固定开销实测 ≈2.4~2.6s，复用 2400 会让每一步刚开工就被 defer。
 *   所以同步路径有自己的预算 `SYNC_BUDGET_MS=12000`（语义是「云函数自己能跑多久」，
 *   而不是「客户端愿意等多久」），并留 `PLATFORM_RESERVE_MS=1500` 给平台收尾。
 *
 * 于是同步路径的行为契约是：
 *   A 组 —— 预算充足 → 照常一把梭出结果（行为不回退）
 *   B 组 —— 预算见底 → 主动抛 409「转轮询接管」，且**必须在极短时间内**返回，
 *           绝不能像旧实现那样一路跑到被平台在 3s 处硬掐断（那才是 -504003 的来源）
 *   C 组 —— 早退时**已完成的步骤必须全部落库**（step/partial 都在），任务不判死，
 *           轮询能从断点接续收敛到 done —— 这是「提前收工」相对「硬掐断」的全部价值
 *   D 组 —— 不传 ctx（管理端/unrecognized 老调用方）→ 预算无限，与历史一致
 *   E 组 —— deadline 已过 → 立即交还（不白干）
 *
 * 用与 test_vision_resume.js 同款的 db/cloud stub（轻量版）。
 * 跑法：node scripts/test_vision_budget.js
 */
const http = require('http')
const Module = require('module')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const VISON_PATH = path.join(ROOT, 'cloudfunctions/catcampus/lib/vision.js')

/* ==================== stub 基础设施 ==================== */
const RT = { db: 180, download: 700, imgCheck: 350, tempUrl: 300 }
const sleep = ms => new Promise(r => setTimeout(r, ms))

let passed = 0, failed = 0
const failures = []
function assert(cond, msg) {
  if (cond) { passed++; return }
  failed++; failures.push(msg); console.error('  x ' + msg)
}

class AppError extends Error { constructor(m, c) { super(m); this.code = c } }
const COL = { cat: 'cats', aiTask: 'ai_tasks', aiSample: 'ai_samples', user: 'users' }
const _ = {
  inc: v => ({ __op: 'inc', v }), lt: v => ({ __op: 'lt', v }),
  nin: a => ({ __op: 'nin', a }), in: a => ({ __op: 'in', a }),
  or: a => ({ __op: 'or', a }), push: a => ({ __op: 'push', a })
}
const distanceM = () => 10
const cosine = () => 0.9

const store = { cats: [], ai_tasks: [], ai_samples: [], users: [] }
let maxWriteBytes = 0
const clone = o => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)))
function matchDoc(doc, where) {
  return Object.keys(where).every(k => {
    const c = where[k]
    if (c && typeof c === 'object' && c.__op === 'lt') return new Date(doc[k]).getTime() < new Date(c.v).getTime()
    if (c && typeof c === 'object' && c.__op === 'nin') return c.a.indexOf(doc[k]) < 0
    if (c && typeof c === 'object' && c.__op === 'in') return c.a.indexOf(doc[k]) >= 0
    return doc[k] === c
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
      await sleep(RT.db)
      maxWriteBytes = Math.max(maxWriteBytes, JSON.stringify(data).length)
      const id = name + '_' + (store[name].length + 1)
      store[name].push(Object.assign({ _id: id }, clone(data)))
      return { _id: id }
    }
    coll.doc = id => ({
      get: async () => { await sleep(RT.db); const d = store[name].find(x => x._id === id); return { data: d ? clone(d) : null } },
      update: async ({ data }) => {
        await sleep(RT.db)
        maxWriteBytes = Math.max(maxWriteBytes, JSON.stringify(data).length)
        const d = store[name].find(x => x._id === id)
        if (!d) return { stats: { updated: 0 } }
        applyData(d, data); return { stats: { updated: 1 } }
      }
    })
    coll.where = where => {
      const q = {}
      q.limit = n => { q._limit = n; return q }
      q.field = f => { q._field = f; return q }
      q.get = async () => {
        await sleep(RT.db)
        let list = store[name].filter(d => matchDoc(d, where))
        if (q._limit) list = list.slice(0, q._limit)
        return { data: list.map(clone) }
      }
      q.update = async ({ data }) => {
        await sleep(RT.db)
        const targets = store[name].filter(d => matchDoc(d, where))
        targets.forEach(d => applyData(d, data))
        return { stats: { updated: targets.length } }
      }
      return q
    }
    return coll
  }
}
const cloud = {
  async downloadFile() { await sleep(RT.download); return { fileContent: Buffer.from([1, 2, 3]) } },
  async getTempFileURL({ fileList }) { await sleep(RT.tempUrl); return { fileList: fileList.map(f => ({ fileID: f, status: 0, tempFileURL: 'https://x/' + encodeURIComponent(f) })) } }
}

/* ==================== 识别服务（可控延迟） ==================== */
const aiBehavior = { mode: 'ok', delay: 900 }
const aiServer = http.createServer((req, res) => {
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', async () => {
    await sleep(aiBehavior.delay)
    if (aiBehavior.mode === 'broken') { res.writeHead(200); return res.end('not json') }
    let req2 = {}
    try { req2 = JSON.parse(body) } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      features: { tags: [{ k: '毛色', v: '橘色' }], pattern: 'orange', color: '橘色', confidence: 0.9 },
      candidates: (req2.cats || []).slice(0, 3).map((c, i) => ({
        catId: c.id, name: c.name, avatar: c.photos && c.photos[0] || '', score: 90 - i * 5, reason: '特征相似度 90%'
      }))
    }))
  })
})

/* ==================== 模块注入 ==================== */
const coreStub = path.join(ROOT, 'cloudfunctions/catcampus/lib/core.js')
const secStub = path.join(ROOT, 'cloudfunctions/catcampus/lib/security.js')
const ptsStub = path.join(ROOT, 'cloudfunctions/catcampus/lib/points.js')
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename === VISON_PATH) {
    if (request === './core') {
      return { cloud, db, _, COL, AppError, distanceM, cosine, warmCollection: () => {} }
    }
    if (request === './security') {
      return {
        async checkImage() { await sleep(RT.imgCheck); return true },
        async checkMediaAsync() {},
        async checkText() { return true },
        async assertSightingSafe() {}
      }
    }
    if (request === './points') return { async grant() { return { gained: 0 } } }
  }
  return origLoad.apply(this, arguments)
}

const vision = require(VISON_PATH)

/* ==================== 场景 ==================== */
function seedCats(n) {
  store.cats.length = 0
  for (let i = 0; i < n; i++) {
    const id = 'cat_' + i
    store.cats.push({
      _id: id, name: '喵喵' + (i + 1), schoolId: 'school_1',
      pattern: ['orange', 'tabby', 'cow', 'white'][i % 4], color: '橘色',
      photos: ['cloud://' + id + '-1'], avatar: 'cloud://' + id + '-av',
      location: { lat: 32.0585, lng: 118.7967 }, aiIndexAt: new Date()
    })
  }
}

const USER = { _id: 'u1', openid: 'u1', role: 'member', schoolId: 'school_1' }

async function newTask() {
  const s = await vision.start(USER, { fileId: 'cloud://recognize/t.jpg', type: 'image' })
  return s.taskId
}

async function run() {
  await new Promise(r => aiServer.listen(0, '127.0.0.1', r))
  process.env.AI_ENDPOINT = 'http://127.0.0.1:' + aiServer.address().port + '/v1/recognize'

  console.log('—— A. 预算充足：同步路径照常出结果（行为不回退） ——')
  seedCats(10)
  // 同步路径预算 = SYNC_BUDGET_MS(12000) - PLATFORM_RESERVE_MS(1500) = 10500ms。
  // 三步串行的固定成本 ≈ 内容安全(下载700+送检350) + 换链300 + AI。这里 AI 给 250ms
  // 模拟服务温热，固定开销仍走真实 RT 值 —— 总耗时约 2.4s，远在预算内。
  aiBehavior.mode = 'ok'; aiBehavior.delay = 250
  {
    const taskId = await newTask()
    const t0 = Date.now()
    const r = await vision.runSync(USER, { taskId }, { startedAt: t0 })
    const ms = Date.now() - t0
    assert(r && r.candidates && r.candidates.length > 0, 'A 预算充足时应出结果，实际 ' + JSON.stringify(r).slice(0, 150))
    assert(store.ai_tasks.find(t => t._id === taskId).status === 'done', 'A 任务应为 done')
    assert(ms < 4000, 'A 一把梭应在同步预算内完成（实际 ' + ms + 'ms）')
    console.log('  （耗时 ' + ms + 'ms，含 3 步 DB 往返 + 内容安全下载/送检 + 换链 + AI 250ms）')
  }

  console.log('—— A2. 三步能串完就别 defer（预算充裕时不允许提前交还） ——')
  seedCats(10)
  aiBehavior.mode = 'ok'; aiBehavior.delay = 900   // AI 变慢，但仍在 10500ms 预算内
  {
    const taskId = await newTask()
    const t0 = Date.now()
    const r = await vision.runSync(USER, { taskId }, { startedAt: t0 })
    const ms = Date.now() - t0
    assert(r && r.candidates && r.candidates.length > 0, 'A2 AI 900ms 时仍应一把梭出结果')
    assert(store.ai_tasks.find(t => t._id === taskId).status === 'done', 'A2 任务应为 done')
    console.log('  （耗时 ' + ms + 'ms，AI 900ms，三步串完未 defer）')
  }

  console.log('—— B/C. 预算见底：主动转轮询、产物落库、步骤可续 ——')
  seedCats(10)
  aiBehavior.mode = 'ok'; aiBehavior.delay = 4000   // AI 吃满，逼出提前收工
  {
    const taskId = await newTask()
    // startedAt 往前挪 1000ms —— 等价于「冷启动 + getMe + 抢租约」已花掉 1.0s。
    // 同步预算 10500ms，还剩 9500ms，本可以把 ai 4000ms 那步也跑完；
    // 所以这里换成「把 startedAt 挪到几乎用尽预算」的方式逼 defer：
    // 直接挪 10000ms，剩 500ms，连第一步（要 SEC_RESERVE_MS=1500）都开不了工，
    // advance 必 defer，run() 据此抛「转轮询接管」，**一步都不做就交还**。
    const t0 = Date.now() - 10000
    const t1 = Date.now()
    let threw = null
    try { await vision.runSync(USER, { taskId }, { startedAt: t0 }) } catch (e) { threw = e }
    const ms = Date.now() - t1
    assert(!!threw, 'B 预算见底时必须主动抛出（转轮询），实际正常返回了')
    assert(threw && threw.code === 409, 'B 应抛 409「转轮询接管」语义，实际 code=' + (threw && threw.code) + ' msg=' + (threw && threw.message))
    assert(/转轮询/.test((threw && threw.message) || ''), 'B 错误文案要能让人知道是「转轮询」而不是故障')
    // 关键：早退要**早** —— 一步不做就走，绝不能把预算烧光再交还（那与超时无异）
    assert(ms < 2000, 'B 必须在极短时间内返回，不能被平台掐到 3s（实际 ' + ms + 'ms）')

    const task = store.ai_tasks.find(t => t._id === taskId)
    const stepAtHandoff = task.step          // 先记下来，后面轮询会把同一对象改成 done
    assert(task.status !== 'failed', 'C 提前收工绝不能把任务判死，实际 ' + task.status)
    assert(task.status !== 'done', 'C 也不该是 done（这一步其实没做完）')
    assert(task.step === '' || task.step === 'sec' || task.step === 'cats',
      'C step 必须停在可续跑的位置，实际 ' + JSON.stringify(task.step))

    // 轮询接手（给足预算）应能从断点跑到 done
    let done = null
    for (let i = 0; i < 60; i++) {
      const t2 = Date.now()
      const rr = await vision.poll(USER, { taskId }, { startedAt: t2 })
      if (rr.status === 'done') { done = rr; break }
      if (rr.status === 'failed') break
      await sleep(80)
    }
    assert(!!done, 'C 轮询应从断点接续收敛到 done')
    assert(done && done.result && done.result.candidates.length > 0, 'C 结果应有候选')
    console.log('  （交还 ' + ms + 'ms，任务 step=' + JSON.stringify(stepAtHandoff) + '，轮询接续完成）')
  }

  console.log('—— B2/C2. 预算只够前两步：做了的必须落库，第三步交轮询 ——')
  seedCats(10)
  // AI 给 1200ms：同步路径第三步的 aiTimeout = max(300, min(1800, 450-500)) = 300 < 500
  // 仍会 defer（我们要的就是它卡在第三步）；轮询路径下 aiTimeout ≈ 1540 能等到 1200ms 返回，
  // 于是轮询接手一次即可收敛 —— 场景干净不拖泥带水。
  aiBehavior.mode = 'ok'; aiBehavior.delay = 1200
  {
    const taskId = await newTask()
    // 预算 10500ms，这里只留 2700ms。逐步算（stub 开销：每轮 run 先 get 180，
    // ① 下载 700 + 送检 350 + patch 180 = 1230，② tempUrl 300 + patch 180 = 480）：
    //   ① ''     left 2700-180=2520 ≥ SEC_RESERVE_MS(1500) ✓ 做完剩 ≈1290
    //   ② 'sec'  1290 ≥ URL_RESERVE_MS(1000) ✓ 做完剩 ≈630
    //   ③ 'cats' left 630-180=450；aiTimeout = max(300, min(1800, 450-500)) = 300 < 500 → defer
    // 关键断言：step 停在 'cats' 且 partial.url 已在库里 —— 前两步的产物没白做，
    // 轮询接手只需补最后一步（这正是「提前收工」相对「硬掐断」的价值）。
    const t0 = Date.now() - 7800
    let threw = null
    try { await vision.runSync(USER, { taskId }, { startedAt: t0 }) } catch (e) { threw = e }
    const task = store.ai_tasks.find(t => t._id === taskId)
    assert(task.status !== 'failed', 'B2 不能判死，实际 ' + task.status)
    assert(threw, 'B2 预算不足应主动交还')
    assert(task.step === 'cats', 'B2 应推进到 cats（前两步做完），实际 step=' + JSON.stringify(task.step))
    assert(!!task.partial && !!task.partial.url, 'B2 换链产物必须已落库，实际 partial=' + JSON.stringify(task.partial))

    // 轮询接续：只剩第三步，应能收敛
    let done = null
    for (let i = 0; i < 20; i++) {
      const rr = await vision.poll(USER, { taskId }, { startedAt: Date.now() })
      if (rr.status === 'done') { done = rr; break }
      if (rr.status === 'failed') break
      await sleep(80)
    }
    assert(!!done, 'C2 轮询应只需补最后一步即收敛到 done')
    console.log('  （step=' + JSON.stringify(task.step) + '，partial.url 已落库，轮询补完第三步）')
  }

  console.log('—— D. 不传 ctx：预算无限，与历史行为一致 ——')
  seedCats(10)
  aiBehavior.mode = 'ok'; aiBehavior.delay = 900
  {
    const taskId = await newTask()
    const r = await vision.runSync(USER, { taskId })   // 不传 ctx
    assert(r && r.candidates && r.candidates.length > 0, 'D 不传 ctx 时应照常出结果（管理端/老调用方）')
  }

  console.log('—— E. deadline 已过：立即交还，不做任何白工 ——')
  {
    let threw = null
    const t0 = Date.now()
    try {
      await vision.runSync(USER, { fileId: 'cloud://recognize/legacy.jpg', type: 'image' },
        { startedAt: Date.now() - 20000 })
    } catch (e) { threw = e }
    const ms = Date.now() - t0
    assert(threw && threw.code === 409, 'E 旧调用方带过期 ctx 时应同样提前转轮询，实际 ' + (threw && threw.code))
    assert(ms < 2000, 'E 应立即交还（实际 ' + ms + 'ms），不能把预算烧完')
  }

  console.log('\n通过 ' + passed + ' 项，' + failed + ' 项失败')
  if (failures.length) { console.log('失败明细:'); failures.forEach(f => console.log(' - ' + f)) }
  console.log('最大单次写入: ' + maxWriteBytes + 'B')
  aiServer.close()
  process.exit(failed ? 1 : 0)
}

run().catch(e => { console.error('测试异常', e && e.stack || e); aiServer.close(); process.exit(1) })
