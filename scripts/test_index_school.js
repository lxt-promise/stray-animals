/**
 * 首页顶部学校名 / 换校联动 行为级测试
 *
 * 背景：首页的 `school` 只在 onLoad 读一次 globalData，onShow 只刷概览。
 * 于是在「我的」页绑定或切换学校后回到首页，校名还是旧的，统计也还是
 * 上一所学校的数字。
 *
 * 顶部标题口径（最新）：校名严格跟随绑定学校；未绑定时显示品牌名「喵园」，
 * 不显示任何校名占位，副标题回落「校园流浪猫守护计划」。文案由
 * index.js 的 syncIdentity 预计算成 schoolTitle / schoolSub，模板不做三元。
 *
 * 断言（全部打在页面输出数据上，不匹配源码形状）：
 *  - 未绑定：data.school 为 null，schoolTitle 为「喵园」，schoolSub 为品牌副标题；
 *  - 已绑定：校名/校区来自 globalData.school；
 *  - onShow 同校 → 走后台刷新，不清空 overview；
 *  - onShow 换校 / 解绑 → 旧概览作废、重新拉取、校名跟着变；
 *  - 下拉刷新必须真的发请求（原来会命中 homeOverview 缓存，等于没刷）；
 *  - 首屏 onLoad + onShow 不会重复发请求；
 *  - app.setSchool / refreshUser 在换校时作废按学校统计的概览缓存。
 *
 * 运行：node scripts/test_index_school.js
 */
const fs = require('fs')
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
  calls: [],          // [action, data]
  replies: {},        // action -> 值 / fn(data)
  loginUser: null,    // refreshUser 用的返回
  toasts: [],
  pulled: false
}

global.wx = {
  cloud: {
    callFunction: async ({ data }) => {
      const action = data && data.action
      if (action === 'login') {
        if (!env.loginUser) return { result: { ok: false, msg: 'no login stub' } }
        return { result: { ok: true, data: env.loginUser } }
      }
      env.calls.push([action, data])
      const r = env.replies[action]
      const value = typeof r === 'function' ? r(data) : (r === undefined ? {} : r)
      if (value instanceof Error) return { result: { ok: false, msg: value.message } }
      return { result: { ok: true, data: value } }
    }
  },
  showToast: o => env.toasts.push((o && o.title) || ''),
  showLoading: () => {}, hideLoading: () => {}, showModal: () => {},
  navigateTo: () => {}, switchTab: () => {}, stopPullDownRefresh: () => { env.pulled = true }
}

let appOptions = null
let pageOptions = null
global.App = o => { appOptions = o }
global.Page = o => { pageOptions = o }
global.Component = () => {}

const origLoad = Module._load
Module._load = function (request) {
  if (request && /\.wxml$|\.wxss$|\.json$/.test(request)) return {}
  return origLoad.apply(this, arguments)
}

require(path.join(MP, 'app.js'))
assert('app.js 成功注册 App', !!appOptions)
const app = appOptions
app.globalData = {
  envId: 'test', openid: '', user: null, school: null,
  homeOverview: null, catsTab: '', mineAction: '', ready: true
}
global.getApp = () => app

require(path.join(MP, 'pages/index/index.js'))
assert('index.js 成功注册 Page', !!pageOptions)

const tick = (n) => new Promise(r => setTimeout(r, n || 5))
const flush = async () => { for (let i = 0; i < 8; i++) await tick(2) }
const reset = () => { env.calls = []; env.toasts = []; env.pulled = false }

function makePage() {
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

const SCHOOL_A = { _id: 's1', name: '甲大学', campus: '东校区' }
const SCHOOL_B = { _id: 's2', name: '乙学院', campus: '南校区' }
const ovOf = (name) => ({ catCount: name === '乙学院' ? 7 : 3, recent: [], schoolName: name })

async function main() {

/* ==================== 1. 模板：标题由 JS 预计算 ==================== */
console.log('\n--- 1. 首页模板 ---')
{
  const wxml = fs.readFileSync(path.join(MP, 'pages/index/index.wxml'), 'utf8')
  // 只看「真正会被渲染的部分」：注释里会提到 school.name / 喵园 等字样（说明性文字），
  // 直接匹配全文会把注释当成实现误报，所以先剥掉 <!-- --> 再断言。
  const plain = wxml.replace(/<!--[\s\S]*?-->/g, '')
  const head = plain.slice(0, plain.indexOf('hero-right'))
  assert('标题块恒定渲染（未绑定也一样，只是换成品牌名）',
    /<view class="hero-left">/.test(head), head.slice(0, 200))
  assert('标题/副标题都来自预计算字段',
    /\{\{schoolTitle\}\}/.test(head) && /\{\{schoolSub\}\}/.test(head), head.slice(0, 200))
  assert('模板里不再写 school.name 三元兜底',
    !/school\.name\s*:/.test(head) && !/school\?\.name/.test(head), head.slice(0, 200))
  assert('模板里不硬编码「喵园」/品牌副标题（真源只有 JS）',
    !/喵园/.test(plain) && !/校园流浪猫守护计划/.test(plain))
  assert('副标题为空时整行收起', /wx:if="\{\{schoolSub\}\}"/.test(head), head.slice(0, 200))
  assert('不再需要 no-school 右对齐兜底', !/no-school/.test(plain))
}

/* ==================== 1b. 首页卡片口径 ==================== */
// 「待办任务 / 本月 TNR / TNR 进展」已从首页移除：社团运营数据属于工作台，
// 压首屏只会让首页变慢、变吵。识别卡底部的「档案库 N 只 / 平均响应 / 本地特征比对」
// 与统计卡的「我的猫粮值」随后也去掉了 —— 三张统计卡刚好铺满一行，排版才稳。
// 这里锁住「不要再长回来」。
console.log('\n--- 1b. 首页卡片口径 ---')
{
  const wxml = fs.readFileSync(path.join(MP, 'pages/index/index.wxml'), 'utf8')
  const plain = wxml.replace(/<!--[\s\S]*?-->/g, '')
  assert('首页不再显示「待办任务」/「本月 TNR」',
    !/待办任务/.test(plain) && !/本月 TNR/.test(plain))
  assert('首页不再显示「TNR 进展」进度模块', !/TNR 进展/.test(plain))
  assert('识别卡底部不再挂技术参数（档案库 N 只 / 平均响应 / 本地特征比对）',
    !/平均响应/.test(plain) && !/本地特征比对/.test(plain) && !/档案库 \{\{/.test(plain))
  assert('首页不再有「我的猫粮值」（余额去「我的」页看）', !/我的猫粮值/.test(plain))

  // 真实统计网格 / 骨架网格要分开数：骨架卡也是 <view class="item">，
  // 混在一起会把「3 张真卡 + 3 张骨架」数成 6。
  const iReal = plain.indexOf('stat-grid')
  const iSkel = plain.indexOf('stat-grid', iReal + 1)
  const real = plain.slice(iReal, iSkel)
  const skelPart = plain.slice(iSkel, plain.indexOf('quick-row'))
  const items = (real.match(/<view class="item">/g) || []).length
  assert('统计卡 3 张（在册/绝育率/本月目击），刚好一行铺满', items === 3, items)
  // 骨架卡数量必须与真实卡片一致，否则数据到达时会「多一张再收回去」，跳一下
  const skel = (skelPart.match(/stat-card skeleton/g) || []).length
  assert('骨架卡也是 3 张', skel === 3, skel)

  assert('首页打卡入口文案为「打卡记录」（与猫谱 tab 一致，不再叫「我的打卡」）',
    /打卡记录/.test(plain) && !/我的打卡/.test(plain))
}

/* ==================== 2. 未绑定：school 为 null ==================== */
console.log('\n--- 2. 未绑定学校 ---')
{
  reset()
  app.globalData.user = { _id: 'u1', role: 'member', schoolId: '' }
  app.globalData.school = null
  app.globalData.homeOverview = null
  env.replies.getOverview = () => ({ catCount: 0, recent: [], needSchool: true })

  const p = makePage()
  await p.onLoad()
  await flush()

  assert('未绑定 → data.school 为 null', p.data.school === null, p.data.school)
  assert('未绑定 → 标题回落品牌名「喵园」', p.data.schoolTitle === '喵园', p.data.schoolTitle)
  assert('未绑定 → 副标题是品牌副标题',
    p.data.schoolSub === '校园流浪猫守护计划', p.data.schoolSub)
  assert('未绑定 → 仍拉概览（用于显示引导卡）',
    env.calls.some(c => c[0] === 'getOverview'), env.calls.map(c => c[0]))
  assert('未绑定 → 不发 getSchool', !env.calls.some(c => c[0] === 'getSchool'))
}

/* ==================== 3. 已绑定：校名来自 school ==================== */
console.log('\n--- 3. 已绑定学校 ---')
{
  reset()
  app.globalData.user = { _id: 'u1', role: 'member', schoolId: 's1' }
  app.globalData.school = SCHOOL_A
  app.globalData.homeOverview = null
  env.replies.getOverview = () => ovOf('甲大学')

  const p = makePage()
  await p.onLoad()
  await flush()

  assert('已绑定 → data.school 是该校', p.data.school && p.data.school._id === 's1', p.data.school)
  assert('已绑定 → 校名正确', p.data.school.name === '甲大学', p.data.school)
  assert('已绑定 → 标题就是校名', p.data.schoolTitle === '甲大学', p.data.schoolTitle)
  assert('已绑定 → 副标题是校区', p.data.schoolSub === '东校区', p.data.schoolSub)
  assert('已绑定 → 概览来自云端', p.data.overview && p.data.overview.catCount === 3, p.data.overview)
  assert('已绑定 → 首屏不额外拉 getSchool', !env.calls.some(c => c[0] === 'getSchool'),
    env.calls.map(c => c[0]))
}

/* ==================== 4. 首屏 onLoad + onShow 不重复请求 ==================== */
console.log('\n--- 4. 首屏不重复请求 ---')
{
  reset()
  app.globalData.school = SCHOOL_A
  app.globalData.homeOverview = null
  env.replies.getOverview = () => ovOf('甲大学')

  const p = makePage()
  p.onLoad()          // 不 await：模拟 onLoad → onShow 的时序
  p.onShow()
  await flush()

  const n = env.calls.filter(c => c[0] === 'getOverview').length
  assert('首屏只发 1 次 getOverview', n === 1, env.calls.map(c => c[0]))
}

/* ==================== 5. 同校回到首页：后台刷新、不清空 ==================== */
console.log('\n--- 5. 同校 onShow ---')
{
  reset()
  app.globalData.school = SCHOOL_A
  app.globalData.homeOverview = null
  env.replies.getOverview = () => ovOf('甲大学')

  const p = makePage()
  await p.onLoad()
  await flush()
  reset()

  env.replies.getOverview = () => Object.assign(ovOf('甲大学'), { catCount: 9 })
  p.onShow()
  await flush()

  assert('同校 onShow 触发一次 getOverview',
    env.calls.filter(c => c[0] === 'getOverview').length === 1, env.calls.map(c => c[0]))
  assert('同校 onShow 期间不清空概览（不白屏）', p.data.loading === false, p.data.loading)
  assert('同校 onShow 拿到新数据', p.data.overview.catCount === 9, p.data.overview.catCount)
}

/* ==================== 6. 换校：校名与统计一起换 ==================== */
console.log('\n--- 6. 换校 onShow ---')
{
  reset()
  app.globalData.school = SCHOOL_A
  app.globalData.homeOverview = null
  env.replies.getOverview = () => ovOf('甲大学')

  const p = makePage()
  await p.onLoad()
  await flush()
  assert('换校前校名是甲大学', p.data.school.name === '甲大学')

  // 在「我的」页切到乙学院：走 app.setSchool，缓存应被作废
  app.setSchool(SCHOOL_B)
  assert('setSchool 换校 → 概览缓存作废', app.globalData.homeOverview === null,
    app.globalData.homeOverview)

  reset()
  env.replies.getOverview = () => ovOf('乙学院')
  p.onShow()
  await flush()

  assert('换校后校名变成乙学院', p.data.school && p.data.school.name === '乙学院', p.data.school)
  assert('换校后标题跟着换', p.data.schoolTitle === '乙学院', p.data.schoolTitle)
  assert('换校后副标题跟着换', p.data.schoolSub === '南校区', p.data.schoolSub)
  assert('换校后重新拉概览',
    env.calls.filter(c => c[0] === 'getOverview').length === 1, env.calls.map(c => c[0]))
  assert('换校后统计换成新学校', p.data.overview.catCount === 7, p.data.overview.catCount)
}

/* ==================== 7. 解绑：校名消失 ==================== */
console.log('\n--- 7. 解绑 onShow ---')
{
  reset()
  app.globalData.user = { _id: 'u1', role: 'member', schoolId: 's1' }
  app.globalData.school = SCHOOL_A
  app.globalData.homeOverview = null
  env.replies.getOverview = () => ovOf('甲大学')

  const p = makePage()
  await p.onLoad()
  await flush()

  // 解绑：refreshUser 发现 schoolId 变了 → 清掉 school 与概览缓存
  env.loginUser = { _id: 'u1', role: 'member', schoolId: '' }
  await app.refreshUser()
  assert('refreshUser 发现解绑 → school 清空', app.globalData.school === null, app.globalData.school)
  assert('refreshUser 发现解绑 → 概览缓存作废', app.globalData.homeOverview === null)

  reset()
  env.replies.getOverview = () => ({ catCount: 0, recent: [], needSchool: true })
  p.onShow()
  await flush()

  assert('解绑后 data.school 为 null（无校名）', p.data.school === null, p.data.school)
  assert('解绑后标题回到品牌名', p.data.schoolTitle === '喵园', p.data.schoolTitle)
  assert('解绑后副标题回到品牌副标题',
    p.data.schoolSub === '校园流浪猫守护计划', p.data.schoolSub)
  assert('解绑后统计清空', !p.data.overview || !p.data.overview.catCount, p.data.overview)
}

/* ==================== 8. 下拉刷新必须真的发请求 ==================== */
console.log('\n--- 8. 下拉刷新 ---')
{
  reset()
  app.globalData.user = { _id: 'u1', role: 'member', schoolId: 's1' }
  app.globalData.school = SCHOOL_A
  app.globalData.homeOverview = null
  env.replies.getOverview = () => ovOf('甲大学')

  const p = makePage()
  await p.onLoad()
  await flush()

  // 模拟「缓存里已有概览」——旧实现会直接读缓存，一个请求都不发
  app.globalData.homeOverview = ovOf('甲大学')
  reset()
  p.onPullDownRefresh()
  await flush()

  assert('下拉刷新绕过缓存，真的发了 getOverview',
    env.calls.filter(c => c[0] === 'getOverview').length === 1, env.calls.map(c => c[0]))
  assert('下拉刷新后停止下拉动画', env.pulled === true)
}

/* ==================== 9. 自愈：schoolId 有值但 school 丢了 ==================== */
console.log('\n--- 9. 学校对象缺失自愈 ---')
{
  reset()
  app.globalData.user = { _id: 'u1', role: 'member', schoolId: 's2' }
  app.globalData.school = null            // 换校后没接着拉
  app.globalData.homeOverview = null
  env.replies.getSchool = () => SCHOOL_B
  env.replies.getOverview = () => ovOf('乙学院')

  const p = makePage()
  await p.onLoad()
  await flush()

  assert('按 user.schoolId 补拉学校', env.calls.some(c => c[0] === 'getSchool'), env.calls.map(c => c[0]))
  assert('补拉后校名正常显示', p.data.school && p.data.school.name === '乙学院', p.data.school)
  assert('补拉后标题不是品牌名（没退回「喵园」）', p.data.schoolTitle === '乙学院', p.data.schoolTitle)
}

/* ==================== 结果 ==================== */
console.log('\n' + '='.repeat(52))
if (fail) {
  console.log('FAILED ' + fail + ' 项 / PASS ' + pass)
  console.log('失败清单：\n  - ' + failures.join('\n  - '))
  process.exit(1)
}
console.log('PASS ' + pass + ' / FAIL 0  —— 首页学校名联动全部通过')
}

main()
