/**
 * 行为级测试：账号只收手机号/邮箱 + 超管用户管理（2026-10-30 两项改动）。
 *
 * 【账号】原来允许自由「用户名」，问题是用户名不可验证、不可找回、还容易重名撞车，
 *   所以两端一起收紧成**手机号或邮箱**：
 *   - 设置 / 改绑账号都过同一套格式校验，非法格式 400（并说明「手机号或邮箱」）；
 *   - 账号填手机号时自动同步 `phone`（手机号账号本身就是联系方式），
 *     账号页下半部分的「手机号」卡片因此被删掉 —— 同一个号码出现两次纯属噪音；
 *   - 改账号要验当前密码、要查重（撞到别人的账号，两个人的档案会在登录时被并到一起）。
 *
 * 【用户管理】超级管理员后台新增「用户管理（全站）」：
 *   - `listUsersAdmin` 只有超管能调，跨校区列人，结果**脱敏**（不下发 openid / 密码哈希 /
 *     完整手机号），支持昵称 / 账号 / 手机号前缀搜索与角色筛选；
 *   - `setUserRole` **只改 role，绝不动 schoolId** —— 全站视角下把 schoolId 一起改掉，
 *     等于顺手把用户的整份数据搬了家（这是它与本校区 `setRole` 的关键区别）；
 *   - 边界：不能降级自己、不能改超管、非法角色被拒、非超管调不通。
 *
 * 运行：node scripts/test_account_and_users.js
 */
'use strict'
const Module = require('module')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

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
 * 只桩 wx-server-sdk（core.js 的入口），index.js 与 lib/* 全部跑真实源码。 */
let store = {}

const matchCond = (doc, cond) => {
  if (!cond) return true
  if (cond.__op === 'or') return (cond.v || []).some(sub => matchCond(doc, sub))
  if (cond.__op === 'and') return (cond.v || []).every(sub => matchCond(doc, sub))
  return Object.keys(cond).every(k => {
    const cv = cond[k]
    if (cv && cv.__op === 'in') return (cv.v || []).indexOf(doc[k]) >= 0
    // db.RegExp：昵称里带 . ( ) 时也必须能查（真实环境不转义会直接报错）
    if (cv && cv.__regexp !== undefined) {
      const flags = (cv.__options || '').indexOf('i') >= 0 ? 'i' : ''
      return new RegExp(cv.__regexp, flags).test(String(doc[k] || ''))
    }
    return doc[k] === cv
  })
}

let globalId = 0
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
    async add({ data }) {
      const id = 'NEW_' + (++globalId) + '_' + col
      list().push(Object.assign({ _id: id }, data))
      return { _id: id }
    },
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
const main = require(path.join(CF, 'index.js')).main

/** 与 hashPassword 同算法：salt + ':' + scrypt(pw, salt) */
const hp = pw => 'aa:' + crypto.scryptSync(String(pw), 'aa', 32).toString('hex')

function seed() {
  store = {
    users: [
      { _id: 'U1', openid: 'u1', role: 'user', nickName: '张三', schoolId: 'sch_a', createdAt: '2026-10-01 10:00' },
      {
        _id: 'U2', openid: 'u2', role: 'admin', nickName: '李四', schoolId: 'sch_a',
        account: '13800138000', password: hp('pwd123456'), phone: '13800138000', createdAt: '2026-10-02 10:00'
      },
      {
        _id: 'U3', openid: 'u3', role: 'member', nickName: '王五', schoolId: 'sch_b',
        account: 'wang@school.edu.cn', password: hp('mail123456'), createdAt: '2026-10-03 10:00'
      },
      { _id: 'US', openid: 'u_super', role: 'admin', nickName: '超管', schoolId: 'sch_a', createdAt: '2026-09-30 10:00' }
    ],
    schools: [
      { _id: 'sch_a', name: '南京大学', campus: '仙林校区' },
      { _id: 'sch_b', name: '东南大学', campus: '九龙湖校区' }
    ]
  }
}
const u = id => (store.users || []).find(x => x.openid === id)

const as = async (openid, action, event) => {
  currentOpenid = openid || ''
  const r = await main(Object.assign({ action }, event || {}))
  return r && r.ok === false ? r : (r && r.data)
}

const acctJs = fs.readFileSync(path.join(MP, 'pages', 'account', 'account.js'), 'utf8')
const acctWxml = fs.readFileSync(path.join(MP, 'pages', 'account', 'account.wxml'), 'utf8')
const adminJs = fs.readFileSync(path.join(MP, 'pages', 'admin', 'admin.js'), 'utf8')
const adminWxml = fs.readFileSync(path.join(MP, 'pages', 'admin', 'admin.wxml'), 'utf8')
const utilJs = fs.readFileSync(path.join(MP, 'utils', 'util.js'), 'utf8')
const cfSrc = fs.readFileSync(path.join(CF, 'index.js'), 'utf8')

async function run() {

  /* ==================== 1. 账号格式：只收手机号 / 邮箱 ==================== */
  console.log('\n=== 1. 设置账号：用户名被拒，手机号 / 邮箱放行 ===')
  {
    seed()
    const bad = await as('u1', 'registerAccount', { account: 'zhangsan', password: 'pwd123456' })
    assert('用户名当账号被拒（400）', bad && bad.ok === false && bad.code === 400, bad)
    assert('提示里说明「手机号或邮箱」', bad && /手机号或邮箱/.test(bad.msg || ''), bad && bad.msg)
    assert('被拒时不写库', u('u1').account === undefined)

    const bad2 = await as('u1', 'registerAccount', { account: '1380013800', password: 'pwd123456' })
    assert('10 位号码不算手机号', bad2 && bad2.ok === false && bad2.code === 400, bad2)
    const bad3 = await as('u1', 'registerAccount', { account: 'a@b', password: 'pwd123456' })
    assert('「a@b」不算邮箱', bad3 && bad3.ok === false && bad3.code === 400, bad3)

    const okPhone = await as('u1', 'registerAccount', { account: '13900139000', password: 'pwd123456' })
    assert('手机号可注册', okPhone && okPhone.ok !== false && okPhone.account === '13900139000', okPhone)
    assert('手机号注册自动同步 phone', u('u1').phone === '13900139000', u('u1').phone)
    assert('密码是加盐哈希，不落明文',
      typeof u('u1').password === 'string' && u('u1').password.indexOf('pwd123456') < 0
      && u('u1').password.indexOf(':') > 0, u('u1').password)
    assert('返回体不下发密码哈希', okPhone && okPhone.password === undefined, okPhone && Object.keys(okPhone))
    assert('openid 进入 linkedOpenids（多设备登录靠它）',
      (u('u1').linkedOpenids || []).indexOf('u1') >= 0, u('u1').linkedOpenids)
  }

  /* ==================== 2. 邮箱账号 + 唯一性 ==================== */
  console.log('\n=== 2. 邮箱账号可用；账号唯一 ===')
  {
    seed()
    const okMail = await as('u1', 'registerAccount', { account: 'Zhang.San+cat@example.com', password: 'pwd123456' })
    assert('邮箱可注册', okMail && okMail.ok !== false && /example\.com$/.test(okMail.account), okMail)
    assert('邮箱注册不会污染 phone', !u('u1').phone, u('u1').phone)

    seed()
    const dup = await as('u1', 'registerAccount', { account: '13800138000', password: 'pwd123456' })
    assert('撞上别人的账号（409）', dup && dup.ok === false && dup.code === 409, dup)

    const again = await as('u2', 'registerAccount', { account: '13911139111', password: 'pwd123456' })
    assert('已设过账号不能再注册（409）', again && again.ok === false && again.code === 409, again)
  }

  /* ==================== 3. 登录：格式不对直接 401，不查库 ==================== */
  console.log('\n=== 3. 账号密码登录 ===')
  {
    seed()
    const bad = await as('u1', 'loginWithPassword', { account: 'zhangsan', password: 'pwd123456' })
    assert('非法格式 → 401（不透露格式规则，只说密码错误）',
      bad && bad.ok === false && bad.code === 401, bad)

    const ok = await as('u1', 'loginWithPassword', { account: '13800138000', password: 'pwd123456' })
    assert('正确账号密码可登录', ok && ok.ok !== false && ok._id === 'U2', ok && ok._id)
    assert('登录返回体不含密码哈希', ok && ok.password === undefined, ok && Object.keys(ok))

    const wrong = await as('u1', 'loginWithPassword', { account: '13800138000', password: 'wrong123' })
    assert('密码错误 → 401', wrong && wrong.ok === false && wrong.code === 401, wrong)

    // 多设备：本次设备 openid 并入该账号
    const u2 = store.users.find(x => x._id === 'U2')
    assert('登录把当前设备 openid 并入 linkedOpenids（换设备仍是同一人）',
      (u2.linkedOpenids || []).indexOf('u1') >= 0, u2.linkedOpenids)
  }

  /* ==================== 4. 改账号：验密码 + 查重 + 同步 phone ==================== */
  console.log('\n=== 4. 修改账号（updateProfile.account） ===')
  {
    seed()
    // 前端「修改账号」表单发的是 oldPassword（与改密码复用同一个字段）
    const noPwd = await as('u2', 'updateProfile', { account: '15000150000' })
    assert('不验密码不给改（401）', noPwd && noPwd.ok === false && noPwd.code === 401, noPwd)

    const wrongPwd = await as('u2', 'updateProfile', { account: '15000150000', oldPassword: 'nope123456' })
    assert('密码不对不给改（401）', wrongPwd && wrongPwd.ok === false && wrongPwd.code === 401, wrongPwd)
    assert('失败时账号没被改', u('u2').account === '13800138000', u('u2').account)

    const dup = await as('u2', 'updateProfile', { account: 'wang@school.edu.cn', oldPassword: 'pwd123456' })
    assert('改成别人的账号 → 409', dup && dup.ok === false && dup.code === 409, dup)

    const bad = await as('u2', 'updateProfile', { account: '昵称当账号', oldPassword: 'pwd123456' })
    assert('改成非法格式 → 400', bad && bad.ok === false && bad.code === 400, bad)

    const ok = await as('u2', 'updateProfile', { account: '15000150000', oldPassword: 'pwd123456' })
    assert('正确密码可换绑手机号', ok && ok.ok !== false && ok.account === '15000150000', ok)
    assert('换绑成手机号时 phone 跟着更新', u('u2').phone === '15000150000', u('u2').phone)

    const toMail = await as('u2', 'updateProfile', { account: 'li@school.edu.cn', oldPassword: 'pwd123456' })
    assert('可换绑成邮箱', toMail && toMail.ok !== false && u('u2').account === 'li@school.edu.cn', u('u2').account)
    assert('换成邮箱不会清掉已有 phone（静默删数据更糟）',
      u('u2').phone === '15000150000', u('u2').phone)
  }

  /* ==================== 5. 用户列表：只有超管能调，且结果脱敏 ==================== */
  console.log('\n=== 5. listUsersAdmin：权限 + 脱敏 ===')
  {
    seed()
    const byUser = await as('u1', 'listUsersAdmin', {})
    assert('普通用户调不通（403）', byUser && byUser.ok === false && byUser.code === 403, byUser)
    const byAdmin = await as('u2', 'listUsersAdmin', {})
    assert('社团管理员也调不通（全站视角只给超管）',
      byAdmin && byAdmin.ok === false && byAdmin.code === 403, byAdmin)

    const r = await as('u_super', 'listUsersAdmin', {})
    assert('超管拿到列表', r && r.ok !== false && Array.isArray(r.list) && r.list.length === 4, r && r.list)
    const li = r.list.find(x => x._id === 'U2')
    assert('账号脱敏（不下发完整手机号）',
      li.accountMask === '138****8000', li.accountMask)
    assert('手机号脱敏', li.phoneMask === '138****8000', li.phoneMask)
    assert('不下发 openid', li.openid === undefined, Object.keys(li))
    assert('不下发密码哈希', li.password === undefined, Object.keys(li))
    assert('带出校名（用户文档里只有 schoolId）', li.schoolName === '南京大学 · 仙林校区', li.schoolName)
    assert('给出 role / 是否超管', li.role === 'admin' && li.isSuper === false, li)
    const sup = r.list.find(x => x._id === 'US')
    assert('超管本人被标出来', sup && sup.isSuper === true, sup)
    // 超管单独计数，不重复算进 admin（他就是 admin 角色，但权限来源不同）
    assert('角色统计由服务端算好（前端不能对数组 filter）',
      r.roleCount && r.roleCount.admin === 1 && r.roleCount.member === 1
      && r.roleCount.visitor === 1 && r.roleCount.super === 1,
      r.roleCount)
  }

  /* ==================== 6. 搜索与角色筛选 ==================== */
  console.log('\n=== 6. 列表搜索（昵称 / 手机号 / 邮箱）与角色筛选 ===')
  {
    seed()
    const byName = await as('u_super', 'listUsersAdmin', { keyword: '王' })
    assert('按昵称搜到 1 人', byName && byName.list.length === 1 && byName.list[0].nickName === '王五', byName && byName.list)

    const byPhone = await as('u_super', 'listUsersAdmin', { keyword: '138' })
    assert('按手机号前缀搜到李四', byPhone && byPhone.list.length === 1 && byPhone.list[0]._id === 'U2', byPhone && byPhone.list)

    const byMail = await as('u_super', 'listUsersAdmin', { keyword: 'wang@' })
    assert('按邮箱前缀搜到王五', byMail && byMail.list.length === 1 && byMail.list[0]._id === 'U3', byMail && byMail.list)

    const none = await as('u_super', 'listUsersAdmin', { keyword: '不存在的人' })
    assert('搜不到就返回空列表（不是报错）', none && none.list.length === 0, none)

    const only = await as('u_super', 'listUsersAdmin', { role: 'member' })
    assert('按角色筛出成员', only && only.list.length === 1 && only.list[0]._id === 'U3', only && only.list)

    // 老数据把访客存成 role:'user'：筛「访客」时既要看得到，也要能归一改角色
    const legacy = await as('u_super', 'listUsersAdmin', { role: 'visitor' })
    assert('历史 role:user 也能被「访客」筛到',
      legacy && legacy.list.length === 1 && legacy.list[0]._id === 'U1', legacy && legacy.list)
    assert('并归一显示为 visitor', legacy && legacy.list[0].role === 'visitor', legacy && legacy.list[0])

    // 特殊字符：昵称里带 . ( 时不能把查询搞崩
    seed()
    store.users.push({ _id: 'U4', openid: 'u4', role: 'visitor', nickName: 'a.(b)*[c', schoolId: '' })
    const esc = await as('u_super', 'listUsersAdmin', { keyword: 'a.(b' })
    assert('昵称含正则元字符也能搜（做了转义）',
      esc && esc.list.length === 1 && esc.list[0]._id === 'U4', esc && esc.list)
  }

  /* ==================== 7. setUserRole：只改 role，绝不动学校 ==================== */
  console.log('\n=== 7. setUserRole：只改权限，不搬数据 ===')
  {
    seed()
    const r = await as('u_super', 'setUserRole', { userId: 'U1', role: 'admin' })
    assert('提管理员成功', r && r.ok === true && u('u1').role === 'admin', r)
    assert('🔴 schoolId 没被改（全站视角不能顺手搬数据）',
      u('u1').schoolId === 'sch_a', u('u1').schoolId)

    const demote = await as('u_super', 'setUserRole', { userId: 'U1', role: 'visitor' })
    assert('可再降级为访客', demote && demote.ok === true && u('u1').role === 'visitor', demote)
    assert('降级也没动 schoolId', u('u1').schoolId === 'sch_a', u('u1').schoolId)

    const bad = await as('u_super', 'setUserRole', { userId: 'U1', role: 'super' })
    assert('非法角色被拒（400）', bad && bad.ok === false && bad.code === 400, bad)

    const noId = await as('u_super', 'setUserRole', { role: 'admin' })
    assert('缺 userId 被拒（400）', noId && noId.ok === false && noId.code === 400, noId)

    const sup = await as('u_super', 'setUserRole', { userId: 'US', role: 'visitor' })
    assert('超管身份不可更改（403）', sup && sup.ok === false && sup.code === 403, sup)

    const self = await as('u_super', 'setUserRole', { userId: 'US', role: 'admin' })
    assert('超管改自己为 admin 也不行（身份由 openid 决定）',
      self && self.ok === false && self.code === 403, self)

    const byUser = await as('u1', 'setUserRole', { userId: 'U3', role: 'admin' })
    assert('普通用户调不通（403）', byUser && byUser.ok === false && byUser.code === 403, byUser)
    assert('被越权调用后角色没变', u('u3').role === 'member', u('u3').role)
  }

  /* ==================== 8. 账号页：手机号卡片已删 + 表单默认收起 ==================== */
  console.log('\n=== 8. 账号与安全页：去掉重复手机号 + 设置后收起表单 ===')
  {
    assert('不再有「当前手机号」一行', acctWxml.indexOf('当前手机号') < 0)
    assert('不再有「保存手机号」按钮', acctWxml.indexOf('保存手机号') < 0)
    assert('不再有「手机号」卡片标题', !/card-title">手机号/.test(acctWxml))
    assert('账号输入框提示改成「手机号或邮箱」',
      /placeholder="手机号或邮箱"/.test(acctWxml))
    assert('提交前用 isValidAccount 校验格式', /isValidAccount\(/.test(acctJs))
    assert('有「修改账号」入口', /修改账号/.test(acctWxml) && /data-mode="account"/.test(acctWxml))
    assert('有「修改密码」入口', /data-mode="pwd"/.test(acctWxml))
    assert('已设置账号时默认收起（acctMode 空串）', /acctMode: has \? '' : 'set'/.test(acctJs))
    assert('点同一个入口可收起（toggle）', /toggleAcctMode/.test(acctJs) && /toggleAcctMode/.test(acctWxml))
    assert('有独立「收起」按钮', /closeAcctForm/.test(acctJs) && /closeAcctForm/.test(acctWxml))
    assert('改账号要验当前密码', /oldPassword/.test(acctJs) && /当前密码/.test(acctWxml))
    assert('改账号走 updateProfile.account + oldPassword（服务端凭它验证身份）',
      /updateProfile',\s*\{\s*account:[^}]*oldPassword/.test(acctJs))
    assert('util 导出 isValidAccount', /isValidAccount/.test(utilJs))
    assert('maskAccount 对邮箱打码（保留域名便于辨认）', /indexOf\('@'\)/.test(utilJs))
  }

  /* ==================== 9. 后台接线：用户管理卡片 ==================== */
  console.log('\n=== 9. 超级管理员后台：用户管理卡片已接线 ===')
  {
    assert('admin.js 调 listUsersAdmin', /listUsersAdmin/.test(adminJs))
    assert('admin.js 调 setUserRole', /setUserRole/.test(adminJs))
    assert('admin.wxml 有用户列表渲染', /uaList/.test(adminWxml))
    assert('admin.wxml 有角色筛选入口', /pickUserRole/.test(adminWxml))
    assert('admin.wxml 有搜索框', /ua-input/.test(adminWxml) && /onUserKeyword/.test(adminWxml))
    assert('副文案在 JS 预算（WXML 不做字符串拼接）', /subText/.test(adminJs))
    assert('提管理员有二次确认', /设为管理员/.test(adminJs) && /showModal/.test(adminJs))
    assert('列表失败不拖垮整页（独立 try/catch）', /uaError/.test(adminJs))
    assert('ACTION 已注册 listUsersAdmin', /'listUsersAdmin':/.test(cfSrc))
    assert('ACTION 已注册 setUserRole', /'setUserRole':/.test(cfSrc))
    assert('listUsersAdmin 内部再校验一次超管', /async function listUsersAdmin[\s\S]{0,200}requireSuper/.test(cfSrc))
    assert('setUserRole 注释写明「只改 role，不动 schoolId」（与 setRole 的区别）',
      /全站视角：只改 role/.test(cfSrc) && /绝不动 schoolId/.test(cfSrc))
  }

  console.log('\n============================')
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  if (fail) { console.log('失败项：' + failures.join(' / ')); process.exit(1) }
}

run().catch(e => { console.error(e); process.exit(1) })
