/**
 * 定时器白名单行为测试 —— 特征库「全量重建」入口 aiIndexRebuild
 *
 * 背景（真实故障）：特征库换成 COS 后桶是空的，但云库里每只猫的 aiIndexAt 仍记着
 * 「已入库」，于是增量模式的 aiIndexDaily 会把所有猫全部跳过（built=0，桶依旧空）。
 * 这个死锁只能靠 force=true 打破，而 force 入口只挂在定时器白名单里
 * （运维在云开发控制台 → 云函数 → 云端测试手工触发），不进 ACTIONS。
 *
 * 断言一律打在**输出数据**上：stub 的 vision.buildIndexAll 记录收到的参数，
 * 以及 exports.main 的返回值；不匹配源码形状。
 *
 * 跑法：node scripts/test_timer_index_rebuild.js
 */
const path = require('path')
const Module = require('module')

const CF_DIR = path.resolve(__dirname, '../cloudfunctions/catcampus')

// 单只猫的视图上限（源码真值）。本文件只测「定时任务与手动入口是否共用同一上限」，
// 数字本身不该写死在断言里 —— 否则每次调阈值都要改测试，还容易漏改。
const INDEX_PHOTOS = Number((require('fs')
  .readFileSync(path.join(CF_DIR, 'lib', 'vision.js'), 'utf8')
  .match(/^const INDEX_PHOTOS = (\d+)/m) || [])[1] || 0)

/* ==================== stub：只留 index.js 的接线，其余 lib 空壳 ==================== */
const calls = []

const visionStub = {
  buildIndexAll: async opts => {
    calls.push(opts || {})
    return {
      startedAt: new Date(), elapsed: 1200, schools: 1, processed: 1,
      built: 7, skipped: 0, timedOut: false, pendingSchools: [],
      results: [{ schoolId: 's1', ok: true, scanned: 7, built: 7, skipped: 0, indexed: 7 }]
    }
  }
}

const noop = async () => ({})
const coreStub = {
  cloud: { getWXContext: () => ({ OPENID: '' }), DYNAMIC_CURRENT_ENV: 'test-env' },
  db: { collection: () => ({ get: async () => ({ data: [] }) }) },
  _: {}, COL: {},
  AppError: class AppError extends Error {
    constructor(msg, code) { super(msg); this.code = code || 400 }
  },
  isMember: () => false, isAdmin: () => false, requireRole: () => {},
  isSuper: () => false, requireSuper: () => {}, resolveSchoolId: () => '',
  assertSchool: () => {}, sanitizeCat: x => x, sanitizeSighting: x => x,
  escapeReg: s => s, pageOf: () => ({}), dayKey: () => '',
  ensureAllCollections: async () => [], warmCollection: () => {}
}

const origLoad = Module._load
Module._load = function (request, parent) {
  const from = (parent && parent.filename) || ''
  if (request === 'wx-server-sdk') {
    return {
      init: () => {}, DYNAMIC_CURRENT_ENV: 'test-env',
      getWXContext: () => ({ OPENID: '' }),
      database: () => ({ collection: () => ({ get: async () => ({ data: [] }) }) })
    }
  }
  // 只有 index.js（本目录入口）引入 lib/* 时才替换；lib 之间互相引入保持原样
  if (/index\.js$/.test(from) && /^\.\/lib\//.test(request)) {
    if (request === './lib/vision') return visionStub
    if (request === './lib/core') return coreStub
    return new Proxy({}, { get: () => noop })   // security / points / tnr / map / vpay
  }
  return origLoad.apply(this, arguments)
}

const fn = require(path.join(CF_DIR, 'index.js'))

/* ==================== 断言工具 ==================== */
let pass = 0
const failures = []

function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); return }
  failures.push(name + (detail ? ' —— ' + detail : ''))
  console.log('  ✗ ' + name + (detail ? ' —— ' + detail : ''))
}

async function run(title, fnBody) {
  console.log('\n' + title)
  calls.length = 0
  try { await fnBody() } catch (e) {
    failures.push(title + ' 抛异常: ' + (e && e.message))
    console.log('  ✗ ' + title + ' 抛异常: ' + (e && e.message))
  }
}

/* ==================== 用例 ==================== */
;(async () => {
  await run('T1 未知 TriggerName 被白名单拒绝（不执行任何建库）', async () => {
    const r = await fn.main({ Type: 'Timer', TriggerName: 'dropAllTables' }, {})
    ok(r && r.ok === false && r.code === 404, '返回 404', JSON.stringify(r))
    ok(calls.length === 0, '未调用 buildIndexAll', 'calls=' + calls.length)
  })

  await run('T2 aiIndexDaily 默认增量（不 force）', async () => {
    const r = await fn.main({ Type: 'Timer', TriggerName: 'aiIndexDaily' }, {})
    ok(r && r.ok === true, '执行成功', JSON.stringify(r))
    ok(calls.length === 1, '调用 buildIndexAll 一次', 'calls=' + calls.length)
    const o = calls[0] || {}
    ok(o.force === undefined || o.force === false, 'force 未开启（增量）', JSON.stringify(o))
    ok(o.budgetMs === 15000, 'budgetMs 默认 15000', String(o.budgetMs))
  })

  await run('T3 aiIndexRebuild 强制全量（force=true）—— 特征库丢失后的恢复手段', async () => {
    const r = await fn.main({ Type: 'Timer', TriggerName: 'aiIndexRebuild' }, {})
    ok(r && r.ok === true, '执行成功', JSON.stringify(r))
    ok(r && r.data && r.data.built === 7, '回传服务端建成数量', JSON.stringify(r && r.data))
    const o = calls[0] || {}
    ok(o.force === true, 'force=true（忽略 aiIndexAt 记账）', JSON.stringify(o))
    // 视图上限取源码里的真值（2026-10-24 由 5 提到 8）。
    // 这里曾写死 photosPerCat: 5 —— 于是定时任务与后台手动入口用了两套张数，
    // 调阈值只改常量时定时任务纹丝不动。正确行为是**不覆盖**，交给 buildIndexAll
    // 用全局上限；所以断言「要么不传、要么等于全局上限」，而不是等于某个数字。
    ok(o.photosPerCat === undefined || o.photosPerCat === INDEX_PHOTOS,
      '全量重建不自行写死张数（默认走全局上限 ' + INDEX_PHOTOS + '）', String(o.photosPerCat))
  })

  await run('T4 运维可在 event 里覆盖预算（不必改环境变量）', async () => {
    await fn.main({ Type: 'Timer', TriggerName: 'aiIndexRebuild', budgetMs: 45000, photosPerCat: 2 }, {})
    const o = calls[0] || {}
    ok(o.budgetMs === 45000, 'budgetMs 被覆盖为 45000', String(o.budgetMs))
    ok(o.photosPerCat === 2, 'photosPerCat 被覆盖为 2', String(o.photosPerCat))
  })

  await run('T5 小写 type 也能识别（平台 event 字段大小写不一致）', async () => {
    const r = await fn.main({ type: 'Timer', triggerName: 'aiIndexRebuild' }, {})
    ok(r && r.ok === true && calls.length === 1, '小写字段同样命中', JSON.stringify(r))
  })

  await run('T6 普通 action 调用不会误触建库（防伪造 Timer event）', async () => {
    const r = await fn.main({ action: 'noSuchAction' }, {})
    ok(r && r.ok === false, '未知 action 报错', JSON.stringify(r))
    ok(calls.length === 0, '未调用 buildIndexAll', 'calls=' + calls.length)
  })

  await run('T7 小程序端无法调用 aiIndexRebuild（不在 ACTIONS 表内）', async () => {
    const r = await fn.main({ action: 'aiIndexRebuild' }, {})
    ok(r && r.ok === false && /未知/.test(r.msg || ''), '作为 action 时是「未知 action」', JSON.stringify(r))
    ok(calls.length === 0, '未调用 buildIndexAll', 'calls=' + calls.length)
  })

  console.log('\n' + '='.repeat(46))
  console.log(failures.length
    ? '失败 ' + failures.length + ' 项：\n  - ' + failures.join('\n  - ')
    : '全部通过：' + pass + ' 项')
  process.exit(failures.length ? 1 : 0)
})()
