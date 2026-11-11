/**
 * 行为级测试：管理员免审绑校 + 待审申请可撤回。
 *
 * 背景（2026-10-30 用户反馈）：
 *   1. 管理员选择学校也要提交申请、等超管审核，不合理；
 *   2. 「换校需管理员审核通过后才生效（仅显示附近 25km 内）」这段文案要删；
 *   3. 提交申请后还有问题 —— 待审期间入口全灰且**无法撤销**，管理员不审就彻底卡死。
 *
 * 本测试锁住的是**意图**，不是实现细节：
 *   - 管理员能直接换校（不落申请、不等审核）；
 *   - 普通用户**调不通**这条接口 —— 权限豁免必须收在服务端，前端传什么都没用；
 *   - 普通管理员仍不能靠直绑绕进隐藏校（超管才可以）；
 *   - 直绑会把本人待审申请撤掉，否则超管审完又把他绑回旧目标；
 *   - 待审申请可以撤回，且只能撤自己的、只能撤 pending 的；
 *   - 那段「审核 / 25km」文案已从前端消失。
 *
 * 运行：node scripts/test_school_bind_admin.js
 */
'use strict'
const Module = require('module')
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const CF = path.join(ROOT, 'cloudfunctions', 'catcampus')
const MP = path.join(ROOT, 'miniprogram')

let pass = 0, fail = 0
const failures = []
const assert = (name, cond, extra) => {
  if (cond) { pass++; return }
  fail++
  failures.push(name)
  console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))
}

/* ==================== 云环境桩 ====================
 * 只桩掉 wx-server-sdk（core.js 的入口），index.js 与 lib/* 全部用真实源码跑。 */
let store = {}

const matchCond = (doc, cond) => {
  if (!cond) return true
  if (cond.__op === 'or') return (cond.v || []).some(sub => matchCond(doc, sub))
  return Object.keys(cond).every(k => {
    const cv = cond[k]
    if (cv && cv.__op === 'in') return (cv.v || []).indexOf(doc[k]) >= 0
    return doc[k] === cv
  })
}

function makeQuery(col) {
  const list = () => (store[col] = store[col] || [])
  const q = {
    _filters: [], _order: null, _limit: 1e9, _skip: 0, _field: null, _id: null,
    where(c) { q._filters.push(c); return q },
    orderBy(f, d) { q._order = { f, d }; return q },
    limit(n) { q._limit = n; return q },
    skip(n) { q._skip = n; return q },
    field(p) { q._field = p; return q },
    doc(id) { q._id = id; return q },
    async get() {
      if (q._id) {
        const d = list().find(x => x._id === q._id)
        return { data: d ? JSON.parse(JSON.stringify(d)) : null }
      }
      let rows = list().filter(d => q._filters.every(f => matchCond(d, f)))
      if (q._order) {
        const { f, d } = q._order
        rows = rows.slice().sort((a, b) => (d === 'desc' ? (b[f] > a[f] ? 1 : -1) : (a[f] > b[f] ? 1 : -1)))
      }
      rows = rows.slice(q._skip, q._skip + q._limit)
      return { data: JSON.parse(JSON.stringify(rows)) }
    },
    // 条件更新：只改命中的行，返回真实 updated 数（并发抢占靠这个数字判定）
    async update({ data }) {
      let n = 0
      if (q._id) {
        const d = list().find(x => x._id === q._id)
        if (d) { Object.assign(d, data); n++ }
        return { stats: { updated: n } }
      }
      list().forEach(d => {
        if (q._filters.every(f => matchCond(d, f))) { Object.assign(d, data); n++ }
      })
      return { stats: { updated: n } }
    },
    async count() { return { total: list().filter(d => q._filters.every(f => matchCond(d, f))).length } }
  }
  return q
}

const op = (name, v) => ({ __op: name, v })
const fakeDb = {
  collection: name => makeQuery(name),
  serverDate: () => new Date(),
  command: {
    or: arr => op('or', arr), and: arr => op('and', arr),
    in: arr => op('in', arr), nin: arr => op('nin', arr),
    eq: v => op('eq', v), neq: v => op('neq', v),
    gt: v => op('gt', v), gte: v => op('gte', v),
    lt: v => op('lt', v), lte: v => op('lte', v),
    exists: v => op('exists', v), inc: v => op('inc', v),
    push: v => op('push', v), remove: () => op('remove')
  },
  RegExp: ({ regexp, options }) => ({ __regexp: regexp, __options: options || '' })
}

let currentOpenid = ''
const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test',
  init() {},
  database: () => fakeDb,
  getWXContext: () => ({ OPENID: currentOpenid }),
  async getTempFileURL({ fileList }) {
    return { fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://x/' + f, status: 0 })) }
  }
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return fakeCloud
  return origLoad.apply(this, arguments)
}

process.env.SUPER_ADMIN_OPENIDS = 'u_super'
const { main } = require(path.join(CF, 'index.js'))

const cfSrc = fs.readFileSync(path.join(CF, 'index.js'), 'utf8')
const mineSrc = fs.readFileSync(path.join(MP, 'pages', 'mine', 'mine.js'), 'utf8')
const mineWxml = fs.readFileSync(path.join(MP, 'pages', 'mine', 'mine.wxml'), 'utf8')

/** 调用一个 action；失败时返回错误体（便于断言 code） */
const as = async (u, action, event) => {
  currentOpenid = u || ''
  const r = await main(Object.assign({ action }, event || {}))
  return r && r.ok === false ? r : (r && r.data)
}

function seed() {
  store = {
    users: [
      { _id: 'U_A', openid: 'u_admin', role: 'admin', schoolId: 'sch_a', nickName: '管理员' },
      { _id: 'U_S', openid: 'u_super', role: 'admin', schoolId: '', nickName: '超管' },
      { _id: 'U_U', openid: 'u_user', role: 'user', schoolId: 'sch_a', nickName: '普通用户' }
    ],
    schools: [
      { _id: 'sch_a', name: '南京大学', campus: '仙林校区' },
      { _id: 'sch_b', name: '东南大学', campus: '' },
      { _id: 'sch_hidden', name: '测试校园', hidden: true }
    ],
    school_applies: []
  }
}
const user = id => (store.users || []).find(u => u.openid === id)
const apply = id => (store.school_applies || []).find(a => a._id === id)

async function run() {
  console.log('\n=== 1. 管理员选校直接绑定（不落申请、不等审核） ===')
  {
    seed()
    const r = await as('u_admin', 'bindSchoolSelf', { schoolId: 'sch_b' })
    assert('管理员直绑成功', r && r.ok === true, r)
    assert('用户 schoolId 已切换', user('u_admin').schoolId === 'sch_b', user('u_admin').schoolId)
    assert('没有产生任何待审申请', (store.school_applies || []).length === 0)
    assert('返回新学校档案', r && r.school && r.school._id === 'sch_b')
  }

  console.log('\n=== 2. 普通用户调 bindSchoolSelf 必须被拒 ===')
  {
    seed()
    const r = await as('u_user', 'bindSchoolSelf', { schoolId: 'sch_b' })
    assert('普通用户被 403 拒绝', r && r.ok === false && r.code === 403, r)
    assert('普通用户的绑定没被改动', user('u_user').schoolId === 'sch_a', user('u_user').schoolId)
  }

  console.log('\n=== 3. 隐藏校不能被普通管理员绕过 ===')
  {
    seed()
    const r1 = await as('u_admin', 'bindSchoolSelf', { schoolId: 'sch_hidden' })
    assert('admin 绑隐藏校被拒（403）', r1 && r1.ok === false && r1.code === 403, r1)
    assert('admin 没被绑进去', user('u_admin').schoolId === 'sch_a')

    const r2 = await as('u_super', 'bindSchoolSelf', { schoolId: 'sch_hidden' })
    assert('super 可绑隐藏校（白名单豁免）', r2 && r2.ok === true, r2)
    assert('super 已绑到隐藏校', user('u_super').schoolId === 'sch_hidden')
  }

  console.log('\n=== 4. 直绑后本人待审申请作废（否则超管审完又绑回去） ===')
  {
    seed()
    store.school_applies = [
      { _id: 'AP1', openid: 'u_admin', status: 'pending', type: 'join', schoolId: 'sch_b', schoolName: '东南大学' },
      { _id: 'AP2', openid: 'u_user', status: 'pending', type: 'join', schoolId: 'sch_b', schoolName: '东南大学' }
    ]
    await as('u_admin', 'bindSchoolSelf', { schoolId: 'sch_b' })
    assert('本人待审已撤回', apply('AP1').status === 'withdrawn', apply('AP1').status)
    assert('别人的待审不受影响', apply('AP2').status === 'pending', apply('AP2').status)
  }

  console.log('\n=== 5. 学校不存在 → 404，不能脏绑 ===')
  {
    seed()
    const r = await as('u_admin', 'bindSchoolSelf', { schoolId: 'sch_nope' })
    assert('不存在的学校报 404', r && r.ok === false && r.code === 404, r)
    assert('原绑定未被清空', user('u_admin').schoolId === 'sch_a')
  }

  console.log('\n=== 6. 待审申请可撤回（解锁入口，打破死局） ===')
  {
    seed()
    store.school_applies = [
      { _id: 'AP1', openid: 'u_user', status: 'pending', type: 'join', schoolId: 'sch_b', schoolName: '东南大学' }
    ]
    const r = await as('u_user', 'withdrawSchoolApply', { id: 'AP1' })
    assert('撤回成功', r && r.ok === true, r)
    assert('状态变为 withdrawn', apply('AP1').status === 'withdrawn', apply('AP1').status)
    // 撤回后不能再撤：条件更新只命中 pending
    const again = await as('u_user', 'withdrawSchoolApply', { id: 'AP1' })
    assert('重复撤回被 409 拒绝', again && again.ok === false && again.code === 409, again)
  }

  console.log('\n=== 7. 撤回的边界：别人的 / 已通过的 ===')
  {
    seed()
    store.school_applies = [
      { _id: 'AP1', openid: 'u_admin', status: 'pending', type: 'join', schoolId: 'sch_b' },
      { _id: 'AP2', openid: 'u_user', status: 'approved', type: 'join', schoolId: 'sch_b' }
    ]
    const r1 = await as('u_user', 'withdrawSchoolApply', { id: 'AP1' })
    assert('撤不了别人的申请', r1 && r1.ok === false && r1.code === 409, r1)
    assert('别人的申请状态没变', apply('AP1').status === 'pending')

    const r2 = await as('u_user', 'withdrawSchoolApply', { id: 'AP2' })
    assert('已通过的申请撤不回来', r2 && r2.ok === false && r2.code === 409, r2)
    assert('已通过状态没被改写', apply('AP2').status === 'approved')
  }

  console.log('\n=== 8. 撤回的申请不再出现在超管待审列表 ===')
  {
    seed()
    store.school_applies = [
      { _id: 'AP1', openid: 'u_user', status: 'pending', type: 'join', schoolId: 'sch_b', schoolName: '东南大学' },
      { _id: 'AP2', openid: 'u_admin', status: 'pending', type: 'join', schoolId: 'sch_b', schoolName: '东南大学' }
    ]
    await as('u_user', 'withdrawSchoolApply', { id: 'AP1' })
    const list = await as('u_super', 'listSchoolApplies', { status: 'pending' })
    const ids = (list || []).map(a => a._id)
    assert('待审列表只剩未撤回的那条', ids.length === 1 && ids[0] === 'AP2', ids)
  }

  console.log('\n=== 9. 前端：删除审核/25km 文案 + 管理员免审分流 ===')
  {
    assert('mine.js 不再出现「换校需管理员审核通过后才生效」',
      mineSrc.indexOf('换校需管理员审核通过后才生效') < 0)
    assert('mine.js 不再拼「25km 内」副文案', mineSrc.indexOf('25km 内') < 0)
    assert('mine.wxml 不再出现 25km 文案', mineWxml.indexOf('25km') < 0)
    assert('pickHint 已删除', !/pickHint\s*\(/.test(mineSrc))
    // 2026-10-30 起免审范围从「仅管理员」扩到「推广期所有人」：
    // 普通用户是否直绑由服务端 policy 决定，管理员无条件直绑。
    assert('管理员 / 免审模式选校都走直绑',
      /isAdminPlus \|\| !this\.data\.schoolPolicy\.reviewBind\)\s*return\s*this\.bindSchoolDirect/.test(mineSrc))
    assert('存在 bindSchoolDirect 实现', /bindSchoolDirect\s*\(\s*opt\s*\)\s*\{/.test(mineSrc))
    assert('存在撤回处理', /withdrawApply\s*\(\s*\)\s*\{/.test(mineSrc))
    assert('待审锁对管理员不生效', /applyLocked:\s*!!pending\s*&&\s*!isAdminPlus/.test(mineSrc))
    assert('审核通过后会自动同步学校',
      /_syncedSchoolId/.test(mineSrc) && /approved\.schoolId/.test(mineSrc))
  }

  console.log('\n=== 10. action 已注册且权限档位正确 ===')
  {
    assert('bindSchoolSelf 注册为 admin', /'bindSchoolSelf':\s*\{\s*role:\s*'admin'/.test(cfSrc))
    assert('withdrawSchoolApply 注册为 user', /'withdrawSchoolApply':\s*\{\s*role:\s*'user'/.test(cfSrc))
  }

  console.log('\n=== 11. 历史文档（只有系统 _openid、没有自建 openid）也能直绑 ===')
  {
    // 模拟早期注册的用户：只存了系统字段 _openid，没有自建 openid。
    // 旧实现 `where({openid: me.openid})` 查不到 → 报「用户档案不存在」。
    // 2026-10-30 修复：bindUserToSchool 改用 me._id 直更，绕开这个坑。
    seed()
    store.users.push({ _id: 'U_HIST', _openid: 'u_hist', role: 'admin', schoolId: 'sch_a', nickName: '老用户' })
    const r = await as('u_hist', 'bindSchoolSelf', { schoolId: 'sch_b' })
    assert('历史文档直绑成功（不再报 用户档案不存在）', r && r.ok === true, r)
    const h = (store.users || []).find(u => u._id === 'U_HIST')
    assert('历史文档 schoolId 已切换', h && h.schoolId === 'sch_b', h && h.schoolId)
  }

  console.log('\n============================')
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  if (fail) { console.log('失败项：' + failures.join(' / ')); process.exit(1) }
}

run().catch(e => { console.error(e); process.exit(1) })
