/**
 * 超管「测试账号切换」行为级测试
 *
 * 需求（2026-11-08）：超管只有一个微信身份，看不到普通用户 / 社团成员眼里的界面，
 * 需要能在账号页切到三类测试账号（管理员 / 社团成员 / 普通用户）。
 *
 * 这是**权限相关**功能，必须锁死三件事：
 *  1. 只有 openid 白名单里的超管能配、能切；普通用户 / 管理员都不行；
 *  2. actAs 只能命中自己配置的 3 个槽位，不能切自己、不能切另一个超管、不能乱传 id；
 *  3. 切过去之后，服务端所有权限判断按被切换账号生效（测试身份调后台接口必须 403）。
 *
 * 运行：node scripts/test_test_actas.js
 */
const path = require('path')
const Module = require('module')
const fs = require('fs')
const ROOT = path.resolve(__dirname, '..')
const CF = path.join(ROOT, 'cloudfunctions', 'catcampus')

let pass = 0, fail = 0
const failures = []
const assert = (name, cond, extra) => {
  if (cond) { pass++; return }
  fail++
  failures.push(name)
  console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))
}

/* ==================== 云环境桩 ==================== */
let store = {}

const matchCond = (doc, cond) => {
  if (!cond) return true
  if (cond.__op === 'or') return (cond.v || []).some(s => matchCond(doc, s))
  if (cond.__op === 'and') return (cond.v || []).every(s => matchCond(doc, s))
  return Object.keys(cond).every(k => {
    const c = cond[k]
    if (c && c.__op === 'in') return (c.v || []).indexOf(doc[k]) >= 0
    if (c && c.__op === 'neq') return doc[k] !== c.v
    return doc[k] === c
  })
}

function makeQuery(col) {
  const list = () => (store[col] = store[col] || [])
  const q = {
    _filters: [], _limit: 1e9, _id: null,
    where(c) { q._filters.push(c); return q },
    orderBy() { return q },
    limit(n) { q._limit = n; return q },
    skip() { return q },
    field() { return q },
    doc(id) { q._id = id; return q },
    async get() {
      if (q._id) {
        const d = list().find(x => x._id === q._id)
        return { data: d ? JSON.parse(JSON.stringify(d)) : null }
      }
      const rows = list().filter(d => q._filters.every(f => matchCond(d, f))).slice(0, q._limit)
      return { data: JSON.parse(JSON.stringify(rows)) }
    },
    async update({ data }) {
      if (q._id) {
        const d = list().find(x => x._id === q._id)
        if (d) Object.assign(d, JSON.parse(JSON.stringify(data)))
        return { stats: { updated: d ? 1 : 0 } }
      }
      const rows = list().filter(d => q._filters.every(f => matchCond(d, f)))
      rows.forEach(d => Object.assign(d, JSON.parse(JSON.stringify(data))))
      return { stats: { updated: rows.length } }
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
    in: arr => op('in', arr), nin: arr => ({ __op: 'nin', v: arr }),
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
const appSrc = fs.readFileSync(path.join(ROOT, 'miniprogram', 'app.js'), 'utf8')
const accountSrc = fs.readFileSync(path.join(ROOT, 'miniprogram', 'pages', 'account', 'account.js'), 'utf8')
const accountWxml = fs.readFileSync(path.join(ROOT, 'miniprogram', 'pages', 'account', 'account.wxml'), 'utf8')

/** 调 action：成功返回 data，失败返回错误体（便于断言 code/msg） */
const as = async (u, action, event) => {
  currentOpenid = u || ''
  const r = await main(Object.assign({ action }, event || {}))
  return r && r.ok === false ? r : (r && r.data)
}

const user = (id, role, extra) => Object.assign({
  _id: id, openid: id, role, nickName: '昵称-' + id, schoolId: '', points: 0, food: 0
}, extra || {})

async function seed() {
  store = {
    users: [
      user('u_super', 'admin', { nickName: '超管' }),
      user('u_super2', 'admin', { nickName: '另一个超管' }),
      user('u_m2', 'member', { nickName: '成员号' }),
      user('u_norm', 'visitor', { nickName: '普通号', schoolId: 'sch_a', points: 30 }),
      user('u_free', 'visitor', { nickName: '路人' }),
      // 历史脏数据：只有 _id 没有 openid
      { _id: 'u_ghost', role: 'visitor', nickName: '无身份' }
    ],
    schools: [{ _id: 'sch_a', name: '东南大学' }]
  }
}

async function run() {
  await seed()

  /* ==================== A. 只有超管能配 ==================== */
  console.log('\n--- A. 配置权限 ---')

  // 普通用户 / 管理员都不能读写配置
  let r = await as('u_norm', 'testAccounts', {})
  assert('A1 普通用户读配置被拒', r && r.ok === false && r.code === 403, r)
  r = await as('u_norm', 'setTestAccounts', { slot: 'normal', userId: 'u_free' })
  assert('A2 普通用户写配置被拒', r && r.ok === false && r.code === 403, r)
  // 角色是 admin 但不是 openid 白名单里的超管 → 仍拒（requireSuper 而非 requireRole）
  r = await as('u_m2', 'setTestAccounts', { slot: 'normal', userId: 'u_free' })
  assert('A3 非白名单的管理员也写不了配置', r && r.ok === false && r.code === 403, r)

  // 超管正常绑定三个槽位
  const binds = { admin: 'u_m2', member: 'u_m2', normal: 'u_norm' }
  for (const slot of Object.keys(binds)) {
    r = await as('u_super', 'setTestAccounts', { slot, userId: binds[slot] })
    assert('A4 超管可绑定槽位 ' + slot, r && r.slots && r.slots.some(s => s.key === slot && s.user), r)
  }
  r = await as('u_super', 'testAccounts', {})
  assert('A5 配置读回：三个槽位都有账号',
    r && r.slots.length === 3 && r.slots.every(s => s.user && s.user._id), r)
  assert('A5 槽位带角色文案（管理员的号标管理员）',
    r && r.slots.filter(s => s.key === 'admin')[0].user.roleLabel === '社团成员',
    r && r.slots)

  /* ==================== B. 非法目标一律拒绝 ==================== */
  console.log('\n--- B. 非法 actAs 拒绝 ---')

  r = await as('u_super', 'login', { actAs: 'u_free' })
  assert('B1 未绑定的账号不能切', r && r.ok === false && r.code === 403, r)
  r = await as('u_super', 'login', { actAs: 'u_super' })
  assert('B2 不能切自己', r && r.ok === false && r.code === 400, r)
  r = await as('u_super', 'login', { actAs: 'u_super2' })
  assert('B3 不能切到另一个超管', r && r.ok === false && (r.code === 403 || r.code === 400), r)
  r = await as('u_super', 'login', { actAs: 'no_such_user' })
  assert('B4 不存在的 id 被拒', r && r.ok === false && r.code === 403, r)
  // 缺 openid 的历史脏数据不能当测试账号：切过去后写入会挂在空身份上
  r = await as('u_super', 'setTestAccounts', { slot: 'normal', userId: 'u_ghost' })
  assert('B4b 缺 openid 的账号不能绑定为测试账号', r && r.ok === false && r.code === 400, r)
  // 普通用户自己带上 actAs 也没用：不满足「真实 openid 是超管」，直接拒绝。
  // 客户端拿到 403 会在启动时清掉本地 actAs（见 app.js 的 _boot），不会卡死。
  r = await as('u_norm', 'login', { actAs: 'u_free' })
  assert('B5 普通用户伪造 actAs 被拒（不按别人解析）',
    r && r.ok === false && r.code === 403 && /超级管理员/.test(r.msg || ''), r)

  /* ==================== C. 切换后身份真的变了 ==================== */
  console.log('\n--- C. 身份解析 ---')

  r = await as('u_super', 'login', { actAs: 'u_norm' })
  assert('C1 切到普通用户：昵称/角色按对方', r && r.nickName === '普通号' && r.role === 'visitor', r)
  assert('C1 切过去后 isSuper 必须为 false', r && !r.isSuper, r)
  assert('C1 不下发密码之外的敏感字段（这里确认没有 testAccounts 串味）',
    r && r.testAccounts === undefined, r)

  r = await as('u_super', 'login', { actAs: 'u_m2' })
  assert('C2 切到社团成员：角色是 member', r && r.role === 'member', r)

  // 测试身份下权限按对方算：后台接口必须 403
  r = await as('u_super', 'listUsersAdmin', { actAs: 'u_norm' })
  assert('C3 以普通用户身份调后台接口被拒', r && r.ok === false && r.code === 403, r)
  r = await as('u_super', 'listUsersAdmin', { actAs: 'u_m2' })
  assert('C4 以社团成员身份调后台接口被拒', r && r.ok === false && r.code === 403, r)

  // 但在测试身份下，被切换账号自己的接口照常可用（否则「测试」没法进行）
  r = await as('u_super', 'ping', { actAs: 'u_norm' })
  assert('C5 测试身份下普通接口正常', r && r.pong === true, r)

  /* ==================== D. 测试身份下不许改凭据 ==================== */
  console.log('\n--- D. 凭据保护 ---')

  r = await as('u_super', 'registerAccount', { actAs: 'u_norm', account: 'a@b.com', password: '123456' })
  assert('D1 测试身份下不能设置账号密码', r && r.ok === false && /测试身份/.test(r.msg || ''), r)
  r = await as('u_super', 'loginWithPassword', { actAs: 'u_norm', account: 'a@b.com', password: '123456' })
  assert('D2 测试身份下不能「登录其他账号」', r && r.ok === false && /测试身份/.test(r.msg || ''), r)
  r = await as('u_super', 'updateProfile', { actAs: 'u_norm', password: '123456', oldPassword: 'x' })
  assert('D3 测试身份下不能改密码', r && r.ok === false && /测试身份/.test(r.msg || ''), r)
  // 改昵称/头像是正常业务，测试新用户首开流程要用，必须放行
  r = await as('u_super', 'updateProfile', { actAs: 'u_norm', nickName: '测试改名' })
  assert('D4 测试身份下改昵称仍可用（新用户流程要测）', !(r && r.ok === false), r)

  /* ==================== E. 解绑 ==================== */
  console.log('\n--- E. 解绑 ---')
  r = await as('u_super', 'setTestAccounts', { slot: 'normal', userId: '' })
  const slots = (r && r.slots) || []
  assert('E1 传空 userId 即解绑', slots.filter(s => s.key === 'normal')[0].user === null, r)
  r = await as('u_super', 'login', { actAs: 'u_norm' })
  assert('E2 解绑后再切直接 403', r && r.ok === false && r.code === 403, r)

  /* ==================== F. 前端接线 ==================== */
  console.log('\n--- F. 前端 ---')
  assert('F1 callApi 会带上 actAs', /data\.actAs = this\.globalData\.actAs/.test(appSrc))
  assert('F2 测试身份下 isSuper() 返回 false', /if \(this\.globalData\.actAs\) return false/.test(appSrc))
  assert('F3 切换后清空 user/school/overview 缓存', /switchTestAccount/.test(appSrc) && /homeOverview = null/.test(appSrc))
  assert('F4 测试身份失效（403）自动退出切换',
    /e\.code === 403/.test(appSrc) && /_clearActAs/.test(appSrc))
  assert('F5 账号页只在真实超管时显示切换面板', /isRealSuper\(\)/.test(accountSrc))
  assert('F6 账号页有三个槽位 + 退出入口',
    /testSw\.slots/.test(accountWxml) && /exitActing/.test(accountWxml))

  /* ==================== 汇总 ==================== */
  console.log('\n============================')
  console.log('通过 ' + pass + ' / 失败 ' + fail)
  if (fail) {
    console.log('失败项：\n- ' + failures.join('\n- '))
    process.exit(1)
  }
  console.log('全部通过 ✅')
}

run().catch(e => {
  console.error('测试崩溃：', e)
  process.exit(1)
})
