/**
 * 学校申请「重复提交」与「管理员通知」的前端行为级测试。
 *
 * 背景（2026-10-30 用户反馈）：
 *   1. 用户申请绑定学校后，管理员未收到任何通知；
 *   2. 申请可以点多次，设计不合理。
 *
 * 本测试锁住修复后的**行为**，不锁实现细节：
 *   - 已有一条待审申请时，选校 / 新建入口都被挡住（并给出明确提示）；
 *   - 提交按钮防连点：请求未回来前再点，不会发出第二个 applySchool；
 *   - 后端返回 already_pending / 提交成功，都要把入口锁上；
 *   - 工作台显示待审计数、未读通知红点。
 *
 * 运行：node scripts/test_school_apply_guard.js
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
  gated: false,
  calls: [],
  pending: [],
  toasts: [],
  isAdmin: true,
  replies: {}
}

const FAKE_APP = {
  globalData: {
    ready: true,
    user: { _id: 'u1', nickName: '测试用户', schoolId: 's1', isSuper: true },
    school: { _id: 's1', name: '某大学' }
  },
  isMember: () => true,
  // 身份可切换：待审锁对管理员不生效（管理员可免审直绑），两种身份都要测
  isAdmin: () => env.isAdmin,
  // 与 isAdmin 同一开关：普通用户既不是管理员也不是超管，isAdminPlus 才为 false
  isSuper: () => env.isAdmin,
  setSchool: s => { FAKE_APP.globalData.school = s || null; return s },
  ensureReady: async () => {},
  callApi(action) {
    env.calls.push(action)
    const r = env.replies[action]
    try {
      const value = typeof r === 'function' ? r() : (r === undefined ? {} : r)
      if (!env.gated) return Promise.resolve(value)
      return new Promise(resolve => { env.pending.push(() => resolve(value)) })
    } catch (e) {
      // 云端鉴权失败是「返回 reject」而不是同步抛错，
      // 桩必须同样返回 rejected promise，页面的 .catch 才接得住
      return Promise.reject(e)
    }
  }
}
global.getApp = () => FAKE_APP
global.wx = {
  showToast: o => env.toasts.push((o && o.title) || ''),
  showLoading: () => {}, hideLoading: () => {}, showModal: () => {},
  navigateTo: () => {}, switchTab: () => {}, stopPullDownRefresh: () => {},
  setStorageSync: () => {}, getStorageSync: () => '',
  requestSubscribeMessage: () => {},
  getLocation: () => {},
  cloud: {}
}
let pageOptions = null
global.Page = opts => { pageOptions = opts }
global.App = () => {}
global.Component = () => {}

const origLoad = Module._load
Module._load = function (request) {
  if (request && /\.wxml$|\.wxss$|\.json$/.test(request)) return {}
  return origLoad.apply(this, arguments)
}

require(path.join(MP, 'pages/mine/mine.js'))
assert('mine.js 成功注册 Page', !!pageOptions)

function freshPage() {
  return Object.assign({}, pageOptions, {
    data: JSON.parse(JSON.stringify(pageOptions.data)),
    setData(patch) {
      Object.keys(patch).forEach(k => {
        if (k.indexOf('.') < 0) { this.data[k] = patch[k]; return }
        const parts = k.split('.')
        let o = this.data
        for (let i = 0; i < parts.length - 1; i++) {
          if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {}
          o = o[parts[i]]
        }
        o[parts[parts.length - 1]] = patch[k]
      })
    }
  })
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)) }

/**
 * 排空所有挂起请求。
 * 不能只放行一轮：提交成功后续还会去读 mySchoolApply（也是挂起的），
 * 只放行一次会让「提交」这个 Promise 永远不落地，测试就卡死了。
 */
const drain = async () => {
  for (let i = 0; i < 12; i++) {
    await flush()
    if (!env.pending.length) return
    const ps = env.pending
    env.pending = []
    ps.forEach(f => f())
  }
}
function reset(o) {
  o = o || {}
  env.calls = []
  env.pending = []
  env.toasts = []
  env.gated = !!o.gated
  env.isAdmin = o.isAdmin === undefined ? true : !!o.isAdmin
  env.replies = {
    mySchoolApply: () => o.pending
      ? { pending: { _id: 'a1', type: 'join', schoolName: '某大学', label: '某大学' }, rejected: null }
      : { pending: null, rejected: null },
    applySchool: () => o.applyResult || { status: 'submitted', apply: { _id: 'a1', type: 'join', schoolName: '某大学' } },
    listSchoolApplies: () => [{ _id: 'a1' }, { _id: 'a2' }],
    listNotices: () => ({ list: [{ _id: 'n1', read: false }, { _id: 'n2', read: false }, { _id: 'n3', read: true }], unread: 2 }),
    listSightings: () => ({ list: [] }),
    listTnr: () => ({ list: [] }),
    listTasks: () => [],
    listFunds: () => ({ summary: { income: 0, expense: 0 } }),
    listSchools: () => [{ _id: 's1', name: '某大学' }],
    listDex: () => ({ total: 0, seen: 0, list: [] })
  }
}

async function main() {

/* ==================== 1. 有待审 → 选校入口被挡 ==================== */
console.log('\n--- 1. 已有一条待审：选校 / 新建入口被挡 ---')
{
  // 普通用户身份：管理员可免审直绑，本来就不该被待审挡住
  reset({ pending: true, isAdmin: false })
  const p = freshPage()
  // canCreate 打开：本例测的是「待审锁入口」，建校权限由下面单独一组断言覆盖。
  // 两者是两件事 —— 有待审时即便有建校权限也不能再建。
  p.setData({
    applyLocked: true,
    joinSchoolId: 's2',
    schoolPolicy: { reviewBind: true, reviewCreate: true, canCreate: true }
  })

  p.openSchoolPicker()
  assert('选校被挡：不发起学校列表请求', env.calls.indexOf('listSchools') < 0, env.calls)
  assert('选校被挡：给出明确提示',
    env.toasts.some(t => /待审/.test(t)), env.toasts)

  env.toasts = []
  p.setData({ showSchoolForm: false })
  p.toggleSchoolForm()
  assert('新建表单不展开', p.data.showSchoolForm === false)
  assert('新建被挡：给出明确提示', env.toasts.some(t => /待审/.test(t)), env.toasts)
}

/* ==================== 1b. 建校权限：非管理员连表单都打不开 ==================== */
console.log('\n--- 1b. 没有建校权限：入口被挡且说明原因（不是填完才 403）---')
{
  reset({ isAdmin: false })
  const p = freshPage()
  p.setData({ applyLocked: false, schoolPolicy: { reviewBind: false, reviewCreate: false, canCreate: false } })

  env.toasts = []
  p.setData({ showSchoolForm: false })
  p.toggleSchoolForm()
  assert('非管理员：新建表单不展开', p.data.showSchoolForm === false)
  assert('非管理员：说明「仅管理员可创建学校」',
    env.toasts.some(t => /仅管理员可创建学校/.test(t)), env.toasts)

  // 直接调提交也要被挡（绕过 UI 的那条路）
  env.toasts = []
  env.calls = []
  p.setData({ schoolForm: { name: '野鸡大学', campus: '', city: '', intro: '', reason: '' } })
  await p.submitSchoolApply()
  await flush()
  assert('非管理员：提交也不发请求', env.calls.indexOf('applySchool') < 0, env.calls)
  assert('非管理员：提交被挡并说明原因',
    env.toasts.some(t => /仅管理员可创建学校/.test(t)), env.toasts)
}

/* ==================== 2. 提交防连点 ==================== */
console.log('\n--- 2. 提交防连点（请求未回时再点不发第二个）---')
{
  reset({ gated: true })
  const p = freshPage()
  p.setData({ joinSchoolId: 's2', joinReason: '我是本校学生' })

  const first = p.submitJoinApply()
  await flush()
  const second = p.submitJoinApply()   // 第一次还没回来
  await flush()
  const n1 = env.calls.filter(a => a === 'applySchool').length
  assert('第一次只发 1 个 applySchool', n1 === 1, env.calls)
  assert('第二次被 submitting 挡住（仍是 1 个）', n1 === 1, env.calls)

  // 排空挂起请求（提交成功后还会再去读 mySchoolApply，放行一轮不够）
  await drain()
  await Promise.all([first, second])
  await flush()
  assert('提交完成后 submitting 复位', p.data.submitting === false)
}

/* ==================== 3. 提交成功 → 入口上锁（管理员除外） ==================== */
console.log('\n--- 3. 提交成功后锁入口；管理员不锁（可免审直绑）---')
{
  // 提交成功后云端已落库，mySchoolApply 必然返回那条 pending ——
  // 入口的锁正是从这里来的，所以本用例让它返回待审
  reset({ pending: true, isAdmin: false })
  const p = freshPage()
  p.setData({ joinSchoolId: 's2', joinReason: '我是本校学生' })
  await p.submitJoinApply()
  await flush()
  assert('提交成功', env.calls.indexOf('applySchool') >= 0)
  assert('普通用户：提交后 applyLocked = true', p.data.applyLocked === true)
  assert('提交后 submitting 复位', p.data.submitting === false)

  // 管理员不该被待审锁住：他可以免审直绑，锁住等于让他干等自己那条申请
  reset({ pending: true, isAdmin: true })
  const p2 = freshPage()
  p2.setData({ joinSchoolId: 's2', joinReason: '我是本校学生' })
  await p2.submitJoinApply()
  await flush()
  assert('管理员：提交后 applyLocked = false', p2.data.applyLocked === false)
  assert('管理员仍看到待审横幅', !!(p2.data.schoolApply && p2.data.schoolApply.pending))
}

/* ==================== 4. 后端已有待审 → 同样上锁 ==================== */
console.log('\n--- 4. 后端返回 already_pending → 上锁 ---')
{
  // pending:true 是必须的：后端既已返回 already_pending，mySchoolApply 必然也查得到那条待审，
  // 入口的锁正是从它来的（只断言 status 而让 mySchoolApply 返回空，测的就不是真实链路了）
  reset({ pending: true, isAdmin: false, applyResult: { status: 'pending', reason: 'already_pending', apply: { _id: 'a9', type: 'join', schoolName: '某大学' } } })
  const p = freshPage()
  p.setData({ joinSchoolId: 's2', joinReason: '我是本校学生' })
  await p.submitJoinApply()
  await flush()
  assert('已有待审时 applyLocked = true', p.data.applyLocked === true)
  assert('提示「已有待审申请」', env.toasts.some(t => /已有待审/.test(t)), env.toasts)
}

/* ==================== 5. 工作台概览已迁到独立页 ==================== */
// 原第 5/6 节测「我的」页的 loadWorkbench（待审计数 + 未读通知）。
// 2026-10-30 工作台概览已剥离到 pages/workbench（管理员 + 超管可见的独立页），
// 「我的」页 load() 不再加载它。相关断言迁移到 scripts/test_mine_parallel.js 第 8 节
// （工作台页概览 + 入口权限）。

console.log('\n============================')
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail) { console.log('失败项：' + failures.join(' / ')); process.exit(1) }
}

main().catch(e => { console.error('测试异常', e); process.exit(1) })
