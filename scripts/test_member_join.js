/**
 * 「成员与身份」页 + 入社申请 行为级测试
 *
 * 用户反馈（2026-10-31）：社团申请过一次后，再次打开仍显示空白申请表单，
 * 应展示申请记录与状态。根因：非成员分支从不查询本人申请（listApplies 是 admin 接口），
 * 永远渲染空白表单。
 *
 * 修复：云函数新增 myApply（role:user，返回本人最新申请）；成员页非成员分支改为
 *   先查 myApply —— pending 显示「审核中」记录、rejected 显示记录 + 重新申请表单（预填）、
 *   无申请才显示空白表单。
 *
 * 断言打在意图上：
 *  - 云 myApply：本人无申请返回 null；有申请返回最新一条；按 openid 隔离；rejected 也返回。
 *  - 页 init（非成员）：myApply=null → 不预填、tab=apply；pending → 不预填；
 *    rejected → applyForm 预填上次内容。
 *  - 页 submitApply：成功后重新拉 myApply，界面切到「审核中」记录。
 *  - 成员分支不再调用 myApply（走 listMembers / listApplies）。
 *
 * 运行：node scripts/test_member_join.js
 */
const path = require('path')
const Module = require('module')
const ROOT = path.resolve(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')
const CF = path.join(ROOT, 'cloudfunctions', 'catcampus')

let pass = 0, fail = 0
const failures = []
const assert = (name, cond, extra) => {
  if (cond) { pass++; return }
  fail++
  failures.push(name)
  console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))
}

/* ============ 云环境桩（复用 catcampus/index.js 真实源码） ============ */
let store = {}
let currentOpenid = ''
const matchCond = (doc, cond) => {
  if (cond && cond.__op === 'or') return (cond.v || []).some(sub => matchCond(doc, sub))
  return Object.keys(cond).every(k => doc[k] === cond[k])
}
const clone = o => JSON.parse(JSON.stringify(o))
function makeQuery(col) {
  const list = () => (store[col] = store[col] || [])
  const q = {
    _filters: [], _order: null, _limit: 1e9, _skip: 0, _id: null, _field: null,
    where(c) { q._filters.push(c); return q },
    orderBy(f, d) { q._order = { f, d }; return q },
    limit(n) { q._limit = n; return q },
    skip(n) { q._skip = n; return q },
    doc(id) { q._id = id; return q },
    async get() {
      if (q._id) { const d = list().find(x => x._id === q._id); return { data: d ? clone(d) : null } }
      let rows = list().filter(d => q._filters.every(f => matchCond(d, f)))
      if (q._order) {
        const { f, d } = q._order
        rows = rows.slice().sort((a, b) => (d === 'desc' ? (b[f] > a[f] ? 1 : -1) : (a[f] > b[f] ? 1 : -1)))
      }
      rows = rows.slice(q._skip, q._skip + q._limit)
      return { data: rows.map(clone) }
    },
    async add(o) { const d = Object.assign({ _id: 'gen_' + Math.random().toString(36).slice(2) }, o.data); list().push(d); return { _id: d._id } },
    async update(o) { const r = list().find(x => x._id === q._id); if (r) Object.assign(r, o.data); return {} },
    async count() { return { total: list().filter(d => q._filters.every(f => matchCond(d, f))).length } }
  }
  return q
}
const fakeDb = {
  collection: name => makeQuery(name),
  serverDate: () => new Date(),
  command: {
    or: a => ({ __op: 'or', v: a }), and: a => ({ __op: 'and', v: a }),
    in: a => ({ __op: 'in', v: a }), nin: a => ({ __op: 'nin', v: a }),
    eq: v => ({ __op: 'eq', v }), neq: v => ({ __op: 'neq', v }),
    gt: v => ({ __op: 'gt', v }), gte: v => ({ __op: 'gte', v }),
    lt: v => ({ __op: 'lt', v }), lte: v => ({ __op: 'lte', v }),
    exists: v => ({ __op: 'exists', v }), inc: v => ({ __op: 'inc', v }),
    push: v => ({ __op: 'push', v }), remove: () => ({ __op: 'remove' })
  },
  RegExp: ({ regexp, options }) => ({ __regexp: regexp, __options: options || '' })
}
const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test', init() {}, database: () => fakeDb,
  getWXContext: () => ({ OPENID: currentOpenid }),
  async getTempFileURL({ fileList }) {
    return { fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://x/' + encodeURIComponent(f), status: 0 })) }
  }
}
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return fakeCloud
  if (request && /\.wxml$|\.wxss$|\.json$/.test(request)) return {}
  return origLoad.apply(this, arguments)
}
process.env.SUPER_ADMIN_OPENIDS = process.env.SUPER_ADMIN_OPENIDS || 'u_admin'
const { main: cfMain } = require(path.join(CF, 'index.js'))
const as = async (u, action, event) => {
  currentOpenid = u || ''
  const r = await cfMain(Object.assign({ action }, event || {}))
  return r && r.ok === false ? r : (r && r.data)
}

/* ============ 页面桩 ============ */
const env = { replies: {}, calls: [], toasts: [], modals: [], isMember: false, isAdmin: false }
let MEMBER_PAGE = null
const FAKE_APP = {
  globalData: { ready: true, user: { _id: 'u1', nickName: '测试同学' } },
  isMember: () => env.isMember,
  isAdmin: () => env.isAdmin,
  ensureReady: async () => {},
  async callApi(action, data) {
    env.calls.push(action)
    const r = env.replies[action]
    return typeof r === 'function' ? r(data) : (r === undefined ? {} : r)
  }
}
global.getApp = () => FAKE_APP
global.wx = {
  showToast: o => env.toasts.push((o && o.title) || ''),
  showModal: o => { env.modals.push(o && o.title); if (o && o.success) o.success() },
  showLoading: () => {}, hideLoading: () => {}, navigateTo: () => {}, switchTab: () => {},
  stopPullDownRefresh: () => {}
}
global.Page = opts => { MEMBER_PAGE = opts }
global.App = () => {}
global.Component = () => {}
require(path.join(MP, 'pages/member/member.js'))
assert('member.js 成功注册 Page', !!MEMBER_PAGE)

function freshPage() {
  return Object.assign({}, MEMBER_PAGE, {
    data: JSON.parse(JSON.stringify(MEMBER_PAGE.data)),
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

async function main() {
  console.log('\n=== A. 云 myApply：本人申请查询与隔离 ===')
  store = {
    users: [
      { _id: 'u_a', openid: 'u_a', role: 'visitor', schoolId: '', nickName: '小明' },
      { _id: 'u_b', openid: 'u_b', role: 'visitor', schoolId: '', nickName: '别人' }
    ],
    applies: []
  }
  let r = await as('u_a', 'myApply', {})
  assert('A1 本人无申请返回 null', r === null || r === undefined, r)

  store.applies = [
    { _id: 'a1', openid: 'u_a', nickName: '小明', status: 'pending', reason: '想帮忙', createdAt: new Date(Date.now() - 1000) },
    { _id: 'a2', openid: 'u_a', nickName: '小明', status: 'pending', reason: '更新', createdAt: new Date() }
  ]
  r = await as('u_a', 'myApply', {})
  assert('A2 返回本人最新一条（按时间倒序）', r && r._id === 'a2' && r.status === 'pending', r)

  store.applies.push({ _id: 'a3', openid: 'u_b', nickName: '别人', status: 'pending', createdAt: new Date() })
  r = await as('u_a', 'myApply', {})
  assert('A3 只返回本人申请，不串号', r && r._id === 'a2' && r.openid === 'u_a', r)

  store.applies.push({ _id: 'a4', openid: 'u_a', status: 'rejected', reason: '不行', createdAt: new Date(Date.now() + 2000) })
  r = await as('u_a', 'myApply', {})
  assert('A4 最新为 rejected 也返回（前端据此给重新申请）', r && r._id === 'a4' && r.status === 'rejected', r)

  console.log('\n=== B. 页 init（非成员）展示申请记录而非空白表单 ===')
  env.isMember = false; env.isAdmin = false
  env.replies = { myApply: null }
  {
    const p = freshPage(); await p.init()
    assert('B1 无申请：myApply=null、tab=apply、loading 结束',
      p.data.myApply === null && p.data.tab === 'apply' && p.data.loading === false, p.data)
    assert('B1 不预填表单', p.data.applyForm.reason === '', p.data.applyForm)
    assert('B1 调了 myApply', env.calls.indexOf('myApply') >= 0, env.calls)
  }
  env.replies = { myApply: { _id: 'a2', openid: 'u_a', nickName: '小明', status: 'pending', reason: '想帮忙' } }
  {
    const p = freshPage(); await p.init()
    assert('B2 pending：myApply 已设置、状态正确', p.data.myApply && p.data.myApply.status === 'pending', p.data.myApply)
    assert('B2 pending 不预填表单', p.data.applyForm.reason === '', p.data.applyForm)
  }
  env.replies = { myApply: { _id: 'a4', openid: 'u_a', nickName: '小明', status: 'rejected', reason: '上次理由', contact: 'wx123', experience: '喂过猫' } }
  {
    const p = freshPage(); await p.init()
    assert('B3 rejected：myApply 设置', p.data.myApply && p.data.myApply.status === 'rejected', p.data.myApply)
    assert('B3 rejected 预填申请表单',
      p.data.applyForm.reason === '上次理由' && p.data.applyForm.contact === 'wx123' && p.data.applyForm.experience === '喂过猫', p.data.applyForm)
  }

  console.log('\n=== C. submitApply 成功后刷新本人申请状态 ===')
  env.replies = {
    myApply: () => ({ _id: 'new', openid: 'u_a', status: 'pending' }),
    applyJoin: () => ({ status: 'submitted' })
  }
  {
    env.calls = []; env.modals = []
    const p = freshPage()
    p.data.applyForm = { nickName: '小明', contact: 'wx', reason: '想帮忙', experience: '' }
    p.data.myApply = null
    await p.submitApply()
    assert('C 提交后重新拉 myApply（>=1 次）', env.calls.filter(c => c === 'myApply').length >= 1, env.calls)
    assert('C 界面切到审核中记录', p.data.myApply && p.data.myApply.status === 'pending', p.data.myApply)
    assert('C 弹了「已提交」弹窗', env.modals.indexOf('已提交') >= 0, env.modals)
  }
  env.replies = { myApply: () => null, applyJoin: () => ({ status: 'already' }) }
  {
    env.toasts = []
    const p = freshPage()
    p.data.applyForm = { nickName: '', contact: '', reason: '想帮忙', experience: '' }
    await p.submitApply()
    assert('C2 已是成员：弹提示、不刷新', env.toasts.indexOf('你已是社团成员') >= 0, env.toasts)
  }

  console.log('\n=== D. 成员分支不调用 myApply ===')
  env.isMember = true; env.isAdmin = false
  env.replies = { listMembers: [], listApplies: [] }
  {
    env.calls = []
    const p = freshPage(); p.data.tab = 'member'; await p.init()
    assert('D 成员分支不调 myApply（走 listMembers）',
      env.calls.indexOf('myApply') < 0 && env.calls.indexOf('listMembers') >= 0, env.calls)
  }

  console.log('\n' + '='.repeat(52))
  if (fail) {
    console.log('失败 ' + fail + ' 项 / 通过 ' + pass + ' 项')
    failures.forEach(f => console.log('  ✗ ' + f))
    process.exit(1)
  }
  console.log('全部通过：' + pass + ' 项')
}
main().catch(e => { console.error('测试脚本异常：', e); process.exit(1) })
