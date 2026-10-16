/**
 * 「我的」页 load() 并行化行为级测试
 *
 * 背景：load() 原来是 getSchool → listSightings → loadDex(listCats) → loadWorkbench
 * 四次串行云调用，「我的」页要等 3~4 个 RTT 才出全。四件事其实互不依赖
 * （loadDex 只用同步可取的 user.catSeen），已改成 Promise.all 一次性并行。
 *
 * 断言重点（全部打在输出数据上，不匹配源码形状）：
 *  - 真并行：用「门控 Promise」挂起每个 callApi —— 若是串行，第一个不 resolve
 *    后面的请求永远不会发起，调用计数会停在 1；
 *  - getSchool 的新返回值落进 data.school / globalData.school / picker scale；
 *  - getSchool 失败被局部 catch 吞掉，不影响打卡/图鉴/工作台，且不弹 toast；
 *  - listSightings 失败仍走外层 catch 弹 toast（保留「不再静默吞错」的行为）；
 *  - 非管理员不发起工作台 4 个请求。
 *
 * 运行：node scripts/test_mine_parallel.js
 */
const path = require('path')
const Module = require('module')
const ROOT = path.resolve(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')

let pass = 0, fail = 0
const failures = []
const assert = (name, cond, extra) => {
  if (cond) { pass++; return }
  fail++
  failures.push(name)
  console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))
}

/* ==================== 环境桩 ==================== */
const env = {
  admin: true,
  gated: true,            // true=请求挂起等放行（证明并行用）；false=立即返回
  failActions: [],        // 这些 action 直接 reject
  replies: {},            // action -> 返回值或 fn(data)
  calls: [],              // 调用顺序
  pending: [],            // 挂起中的 resolve
  toasts: []
}

const HOUR = 3600000
const FRESH_SCHOOL = { _id: 's1', name: '新学校名', scale: 17, center: { lat: 30.5, lng: 114.3 } }

const FAKE_APP = {
  globalData: {
    ready: true,
    user: {
      _id: 'u1', nickName: '测试用户', points: 42, sightingCount: 7,
      catSeen: ['c1', 'c3'], isSuper: false
    },
    // 缓存里的旧学校（scale 15，name 旧）—— 用来验证「以云端为准」
    school: { _id: 's1', name: '旧学校名', scale: 15, center: { lat: 30.5, lng: 114.3 } }
  },
  isMember: () => true,
  isAdmin: () => env.admin,
  isSuper: () => false,
  ensureReady: async () => {},
  callApi(action, data) {
    env.calls.push(action)
    if (env.failActions.indexOf(action) >= 0) {
      return Promise.reject(new Error(action + ' failed'))
    }
    const r = env.replies[action]
    const value = typeof r === 'function' ? r(data) : (r === undefined ? {} : r)
    if (!env.gated) return Promise.resolve(value)
    // 门控：只有被显式放行才 resolve —— 串行实现会让后面的请求根本发不起来
    return new Promise(resolve => { env.pending.push(() => resolve(value)) })
  }
}
global.getApp = () => FAKE_APP
global.wx = {
  showToast: o => env.toasts.push((o && o.title) || ''),
  showLoading: () => {}, hideLoading: () => {}, showModal: () => {},
  navigateTo: () => {}, switchTab: () => {}, stopPullDownRefresh: () => {},
  setStorageSync: () => {}, getStorageSync: () => '',
  cloud: { callFunction: async () => ({ result: {} }), uploadFile: async () => ({}) }
}
let pageOptions = null
global.Page = opts => { pageOptions = opts }
global.App = () => {}
global.Component = () => {}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request && /\.wxml$|\.wxss$|\.json$/.test(request)) return {}
  return origLoad.apply(this, arguments)
}

require(path.join(MP, 'pages/mine/mine.js'))
assert('mine.js 成功注册 Page', !!pageOptions)

function freshPage() {
  // 每个用例一份独立 data，避免互相污染
  return Object.assign({}, pageOptions, {
    data: JSON.parse(JSON.stringify(pageOptions.data)),
    setData(patch) { Object.assign(this.data, patch) }
  })
}

function reset(o) {
  o = o || {}
  // 恢复缓存学校：上一个用例成功时会把 globalData.school 改写成云端新值，
  // 不恢复的话「回落到缓存旧值」这类断言会被上个用例污染
  FAKE_APP.globalData.school = { _id: 's1', name: '旧学校名', scale: 15, center: { lat: 30.5, lng: 114.3 } }
  env.admin = o.admin !== undefined ? o.admin : true
  env.gated = o.gated !== undefined ? o.gated : true
  env.failActions = o.failActions || []
  env.calls = []
  env.pending = []
  env.toasts = []
  env.replies = {
    getSchool: () => FRESH_SCHOOL,
    listSightings: (d) => d && d.pending
      ? { list: [{ _id: 'p1' }, { _id: 'p2' }] }                                   // 工作台：待建档
      : { list: [{ _id: 'sg1', createdAt: new Date(Date.now() - 2 * HOUR).toISOString() }] },
    listCats: () => ({
      list: [{ _id: 'c1', name: '咪咪', avatar: '' }, { _id: 'c2', name: '喵喵', avatar: '' }],
      total: 2
    }),
    listTnr: () => ({ list: [{ status: 'todo' }, { status: 'done' }] }),
    listTasks: () => [{ status: 'open' }, { status: 'closed' }],
    listFunds: () => ({ summary: { income: 100, expense: 30 } })
  }
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)) }

/* ==================== 1. 真并行 ==================== */
console.log('\n--- 1. load() 真并行（门控证明）---')
reset()
const p1 = freshPage()
const done1 = p1.load()
flush().then(async () => {
  // 此刻所有请求都挂起着 —— 串行实现只会发起第一个（getSchool），后面的永远等不到
  assert('管理员路径 7 个请求全部已发起', env.calls.length === 7, env.calls)
  assert('发起了 getSchool', env.calls.indexOf('getSchool') >= 0)
  assert('发起了 listSightings（我的打卡）', env.calls.indexOf('listSightings') >= 0)
  assert('发起了 listCats（图鉴）', env.calls.indexOf('listCats') >= 0)
  assert('发起了 listTnr/listTasks/listFunds（工作台）',
    env.calls.indexOf('listTnr') >= 0 && env.calls.indexOf('listTasks') >= 0 && env.calls.indexOf('listFunds') >= 0)

  // 放行全部挂起请求，等 load 收尾
  env.pending.splice(0).forEach(fn => fn())
  await done1

  assert('data.school 用上云端新值', p1.data.school && p1.data.school.name === '新学校名', p1.data.school && p1.data.school.name)
  assert('globalData.school 被同步刷新', FAKE_APP.globalData.school.name === '新学校名')
  assert('picker 同步新 scale=17 → index 3', p1.data.schoolScale === 17 && p1.data.scaleIndex === 3,
    { scale: p1.data.schoolScale, idx: p1.data.scaleIndex })
  assert('打卡列表带 timeText', p1.data.mySightings.length === 1 && !!p1.data.mySightings[0].timeText,
    p1.data.mySightings)
  assert('统计来自 user（42/7/2）',
    p1.data.stats.points === 42 && p1.data.stats.sightingCount === 7 && p1.data.stats.catSeen === 2,
    p1.data.stats)
  assert('图鉴 unlocked 按 catSeen 计算（c1 亮 / c2 灰）',
    p1.data.dex.length === 2 && p1.data.dex[0].unlocked === true && p1.data.dex[1].unlocked === false,
    p1.data.dex)
  assert('dexPercent = 2/2 = 100', p1.data.dexPercent === 100, p1.data.dexPercent)
  assert('工作台概览四指标正确',
    p1.data.wb.pendingSighting === 2 && p1.data.wb.todoTnr === 1 &&
    p1.data.wb.openTask === 1 && p1.data.wb.balance === '70.00', p1.data.wb)
  assert('loading 正常收尾', p1.data.loading === false)

  /* ==================== 2. getSchool 失败隔离 ==================== */
  console.log('\n--- 2. getSchool 失败不影响其他数据 ---')
  reset({ gated: false, failActions: ['getSchool'] })
  const p2 = freshPage()
  await p2.load()
  assert('学校回落到缓存旧值', p2.data.school.name === '旧学校名', p2.data.school.name)
  assert('picker 用缓存 scale=15 → index 1', p2.data.schoolScale === 15 && p2.data.scaleIndex === 1)
  assert('打卡/图鉴照常出', p2.data.mySightings.length === 1 && p2.data.dex.length === 2)
  assert('不弹错误 toast（局部 catch 吞掉）', env.toasts.length === 0, env.toasts)

  /* ==================== 3. listSightings 失败仍报错 ==================== */
  console.log('\n--- 3. listSightings 失败走外层 catch ---')
  reset({ admin: false, gated: false, failActions: ['listSightings'] })
  const p3 = freshPage()
  await p3.load()
  assert('弹 toast 且带原因', env.toasts.length === 1 && /listSightings/.test(env.toasts[0]), env.toasts)
  assert('loading 仍然收尾', p3.data.loading === false)

  /* ==================== 4. 非管理员不拉工作台 ==================== */
  console.log('\n--- 4. 非管理员不发起工作台请求 ---')
  reset({ admin: false, gated: false })
  const p4 = freshPage()
  await p4.load()
  assert('未发起 listTnr/listTasks/listFunds',
    env.calls.indexOf('listTnr') < 0 && env.calls.indexOf('listTasks') < 0 && env.calls.indexOf('listFunds') < 0,
    env.calls)
  assert('普通用户数据完整', p4.data.mySightings.length === 1 && p4.data.dex.length === 2)

  /* ==================== 结果 ==================== */
  console.log('\n=== 结果 ===')
  console.log('PASS ' + pass + ' / FAIL ' + fail)
  if (fail) { console.log('失败项：\n  ' + failures.join('\n  ')) }
  process.exit(fail ? 1 : 0)
})
