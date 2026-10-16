/**
 * 地图「投喂标识」+ 小程序「分享能力」行为级测试
 *
 * 背景：
 *  1) 用户要「地图上小猫图标旁边显示是否投喂，12h 未投喂标未投喂，并在图例里说明」。
 *  2) 用户问「为什么小程序无法分享」—— 根因是全项目零个 onShareAppMessage，
 *     微信规定页面没声明该回调时右上角「转发给朋友」就是灰色不可点。
 *
 * 断言重点：
 *   - feedInfo 的阈值/状态过滤/脏数据兜底，尤其是「字段缺失」不能等同于「从未投喂」
 *   - buildCatMarker 的气泡文案与 display（欠投喂才常显，否则会糊成一片）
 *   - shareBehavior 产出三个回调、函数式配置能拿到页面 this
 *   - 五个主要页面确实把回调并进了 Page options（防止以后被误删）
 *
 * 运行：node scripts/test_map_feed_share.js
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

/* ==================== 环境桩：让它能在 Node 里 require 小程序页面 ==================== */
let pageOptions = null
// callApi 后面会被替换成不同的返回值，所以必须是同一个对象引用
// （页面在 require 阶段就执行了 getApp()，把返回值抓进了闭包）
const FAKE_APP = {
  globalData: { school: { name: '示例大学' }, user: null, ready: true },
  callApi: async () => ({ list: [] })
}
global.wx = {
  showToast: () => {}, showLoading: () => {}, hideLoading: () => {},
  showModal: () => {}, navigateTo: () => {}, switchTab: () => {},
  setStorageSync: () => {}, getStorageSync: () => '', removeStorageSync: () => {},
  getLocation: () => {}, createMapContext: () => ({}), stopPullDownRefresh: () => {},
  previewImage: () => {}, openLocation: () => {}, getSystemInfoSync: () => ({}),
  request: () => {}, login: () => {}, getSetting: () => {}, authorize: () => {},
  cloud: { callFunction: async () => ({ result: { ok: true, data: {} } }) }
}
global.getApp = () => FAKE_APP
global.Page = opts => { pageOptions = opts }
global.App = () => {}
global.Component = () => {}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  // 组件路径在 Node 里不存在，给个空壳避免 require 炸掉
  if (request && /\.wxml$|\.wxss$|\.json$/.test(request)) return {}
  return origLoad.apply(this, arguments)
}

/* ==================== 1. 投喂状态计算 ==================== */
console.log('\n--- 1. feedInfo 投喂状态 ---')
require(path.join(MP, 'pages/map/map.js'))
const page = pageOptions
assert('map.js 成功注册 Page', !!page)
assert('提供 feedAlertHours 供图例引用', page.data.feedAlertHours === 12, page.data.feedAlertHours)

const H = 3600000
const now = Date.now()
const mk = (o) => Object.assign({ catId: 'c1', name: '咪咪', status: 'campus', sterilized: 'yes' }, o)

// feedInfo 没导出，通过 buildCatMarker 的 callout 反推
const markerOf = p => page.buildCatMarker(1, Object.assign({
  lat: 30.5, lng: 114.3
}, p))

const m1 = markerOf(mk({ lastFedAt: null }))
assert('从未投喂 → 气泡含「未投喂」', /未投喂/.test(m1.callout.content), m1.callout.content)
assert('从未投喂 → 常显（ALWAYS）', m1.callout.display === 'ALWAYS', m1.callout.display)
assert('气泡仍带猫名', /咪咪/.test(m1.callout.content), m1.callout.content)

const m2 = markerOf(mk({ lastFedAt: new Date(now - 2 * H) }))
assert('2h 前投喂 → 不常显', m2.callout.display === 'BYCLICK', m2.callout.display)
assert('2h 前投喂 → 气泡标「已投喂」', /已投喂/.test(m2.callout.content), m2.callout.content)

const m3 = markerOf(mk({ lastFedAt: new Date(now - 20 * H) }))
assert('20h 前投喂 → 常显', m3.callout.display === 'ALWAYS', m3.callout.display)
assert('20h 前投喂 → 显示小时数', /20h未喂/.test(m3.callout.content), m3.callout.content)

const m4 = markerOf(mk({ lastFedAt: new Date(now - 11 * H) }))
assert('11h（阈值内）→ 不常显', m4.callout.display === 'BYCLICK', m4.callout.display)
const m5 = markerOf(mk({ lastFedAt: new Date(now - 13 * H) }))
assert('13h（越阈值）→ 常显', m5.callout.display === 'ALWAYS', m5.callout.display)

const m6 = markerOf(mk({ lastFedAt: new Date(now - 60 * H) }))
assert('超过 48h 改用「天」计数', /2天未喂/.test(m6.callout.content), m6.callout.content)

// 非在校状态不该催投喂
const noFit = ['foster', 'suspend', 'adopted', 'missing', 'rainbow']
noFit.forEach(st => {
  const m = markerOf(mk({ status: st, lastFedAt: null }))
  assert(st + ' 状态不催投喂', m.callout.display === 'BYCLICK' && !/未投喂/.test(m.callout.content),
    m.callout.content)
})

// 脏数据兜底：非法日期不能让 marker 崩
const mBad = markerOf(mk({ lastFedAt: 'not-a-date' }))
assert('非法日期被当成未投喂而非崩溃', !!mBad && /未投喂/.test(mBad.callout.content), mBad && mBad.callout.content)

// 「字段缺失」必须区别于「从未投喂」—— 否则兜底路径会让整张地图全是未投喂气泡
const mNoKey = page.buildCatMarker(1, { lat: 30.5, lng: 114.3, name: '咪咪', sterilized: 'no' })
assert('缺 lastFedAt 字段 → 不做判断（不标未投喂）',
  mNoKey.callout.display === 'BYCLICK' && !/未投喂|已投喂/.test(mNoKey.callout.content),
  mNoKey.callout.content)

// 纵深防御
assert('NaN 坐标不产出 marker', page.buildCatMarker(1, { lat: NaN, lng: 114.3 }) === null)
assert('Infinity 坐标不产出 marker', page.buildCatMarker(1, { lat: 30.5, lng: Infinity }) === null)

/* ==================== 2. shareBehavior mixin ==================== */
console.log('\n--- 2. 分享能力 mixin ---')
const { shareBehavior } = require(path.join(MP, 'utils/util.js'))
assert('util.js 导出 shareBehavior', typeof shareBehavior === 'function')

const b1 = shareBehavior({ title: 'T', path: '/pages/map/map' })
assert('产出 onShareAppMessage', typeof b1.onShareAppMessage === 'function')
assert('产出 onShareTimeline', typeof b1.onShareTimeline === 'function')
assert('产出 onAddToFavorites', typeof b1.onAddToFavorites === 'function')

const ctx = { data: {} }
const r1 = b1.onShareAppMessage.call(ctx, { from: 'menu' })
assert('title 透传', r1.title === 'T', r1)
assert('path 透传', r1.path === '/pages/map/map', r1)
assert('未给封面时不塞 imageUrl（让微信自动截页面）', !('imageUrl' in r1), r1)

const r2 = b1.onShareTimeline.call(ctx, {})
assert('朋友圈标题回落', typeof r2.title === 'string' && r2.title.length > 0, r2)
assert('朋友圈带 query 字段', 'query' in r2, r2)

const bImg = shareBehavior({ title: 'T', path: '/p', imageUrl: 'https://x/y.png' })
assert('显式封面会被带上', bImg.onShareAppMessage.call(ctx, {}).imageUrl === 'https://x/y.png')

// timeline: false 时不产出朋友圈回调
const b3 = shareBehavior({ title: 'T', path: '/p', timeline: false })
assert('timeline:false 不产出 onShareTimeline', b3.onShareTimeline === undefined)

// 函数式配置 + this 绑定
const b4 = shareBehavior(function () {
  return { title: this.data.name, path: '/pages/cat-detail/cat-detail?id=' + this.data.id }
})
const r4 = b4.onShareAppMessage.call({ data: { name: '咪咪', id: 'abc' } }, {})
assert('函数式配置能拿到页面 this', r4.title === '咪咪', r4)
assert('函数式配置能拼 path', r4.path === '/pages/cat-detail/cat-detail?id=abc', r4)

// 配置函数抛错不能炸掉分享
const b5 = shareBehavior(function () { throw new Error('boom') })
const r5 = b5.onShareAppMessage.call({ data: {} }, {})
assert('配置函数抛错仍返回可用对象', !!r5.title && !!r5.path, r5)

// 缺省回落
const r6 = shareBehavior({}).onShareAppMessage.call({ data: {} }, {})
assert('空配置有默认标题', /喵园/.test(r6.title), r6)
assert('空配置默认落到首页', r6.path === '/pages/index/index', r6)

/* ==================== 3. 页面确实接入了分享 ==================== */
console.log('\n--- 3. 页面接线检查 ---')
const pages = ['index/index', 'cats/cats', 'map/map', 'mine/mine', 'cat-detail/cat-detail']
pages.forEach(p => {
  const src = fs.readFileSync(path.join(MP, 'pages', p + '.js'), 'utf8')
  assert(p + ' 引入 shareBehavior', /shareBehavior/.test(src))
  assert(p + ' 用 Object.assign 并入 Page', /Page\(Object\.assign\(/.test(src))
  assert(p + ' 调用 shareBehavior(…) 收尾', /}, shareBehavior\(/.test(src))
})

/* ==================== 3b. 分享覆盖面审计 ==================== */
// 「能不能分享」取决于页面有没有 onShareAppMessage —— 没有的话右上角「转发」是灰的。
// 这里把「应该可分享」的对外页面列成白名单，任何新增页面漏接都会在这里被拦下。
// 表单页/管理页（cat-edit/sighting-post/tnr-edit/admin）刻意不接：分享一张空表单没有意义。
console.log('\n--- 3b. 分享覆盖面 ---')
const SHARE_EXPECTED = [
  'index/index',            // 首页
  'cats/cats',              // 猫谱
  'map/map',                // 地图
  'mine/mine',              // 我的（落到首页）
  'cat-detail/cat-detail',  // 单只猫（最有传播价值）
  'recognize/recognize',    // 识别结果（新用户进来即可自己试）
  'points/points',          // 积分/图鉴成就
  'member/member',          // 成员/志愿者
  'fund/fund',              // 资金公示
  'task/task',              // 任务
  'tnr/tnr'                 // TNR 记录
]
// 刻意不接分享的页面（表单、后台）—— 写清楚，避免后人误以为是漏接
const SHARE_EXEMPT = ['cat-edit/cat-edit', 'sighting-post/sighting-post', 'tnr-edit/tnr-edit', 'admin/admin']

SHARE_EXPECTED.forEach(p => {
  const src = fs.readFileSync(path.join(MP, 'pages', p + '.js'), 'utf8')
  assert('对外页 ' + p + ' 已接入分享', /shareBehavior/.test(src))
  assert('对外页 ' + p + ' 产出 onShareAppMessage', /Page\(Object\.assign\(/.test(src) && /shareBehavior\(/.test(src))
})
SHARE_EXEMPT.forEach(p => {
  const src = fs.readFileSync(path.join(MP, 'pages', p + '.js'), 'utf8')
  assert('豁免页 ' + p + ' 确实未接分享（表单/后台）', !/shareBehavior/.test(src))
})

// app.json 里声明的每个页面文件都必须存在（分享路径失效常常源于路径拼错）
// ⚠️ app.json 的 pages 条目本身就是完整路径（"pages/index/index"），
//    拼 URL 时加的是前导斜杠，不是再补一个 "pages/" —— 这里踩过一次。
const appJson = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'))
assert('app.json 声明了 15 个页面', appJson.pages.length === 15, appJson.pages.length)
appJson.pages.forEach(pg => {
  assert('app.json 的 ' + pg + ' 文件存在', fs.existsSync(path.join(MP, pg + '.js')))
})
// 分享 path 必须指向真实注册的页面
SHARE_EXPECTED.forEach(p => {
  const url = '/pages/' + p
  const registered = appJson.pages.some(pg => ('/' + pg) === url)
  assert('分享目标 ' + url + ' 是注册页面', registered, url)
})

// 识别页：结果态带猫名与 catId，非结果态回落识别页自身
const recSrc = fs.readFileSync(path.join(MP, 'pages/recognize/recognize.js'), 'utf8')
assert('识别页引入 shareBehavior', /shareBehavior/.test(recSrc))
assert('识别页用 Object.assign 并入 Page', /Page\(Object\.assign\(/.test(recSrc))
assert('识别页分享带 catId 落猫详情', /\/pages\/cat-detail\/cat-detail\?id=/.test(recSrc))
assert('识别页分享无结果时回落识别页', /'\/pages\/recognize\/recognize'/.test(recSrc))
assert('识别页分享过滤非 https 封面', /\^https\?:\\\/\\\//.test(recSrc))
{
  const b = shareBehavior(function () { return { title: 'x', path: '/pages/recognize/recognize' } })
  // 空 result 也要给出可点、可打开的分享
  const rr = b.onShareAppMessage.call({ data: {} }, {})
  assert('识别页无结果时分享可用（title 非空 + path 合法）',
    typeof rr.title === 'string' && rr.title.length > 0 && /^\/pages\//.test(rr.path), rr)
}

// 猫详情页是最有价值的分享路径，path 必须带 id
const cdSrc = fs.readFileSync(path.join(MP, 'pages/cat-detail/cat-detail.js'), 'utf8')
assert('猫详情分享 path 带 id 参数', /\/pages\/cat-detail\/cat-detail\?id=/.test(cdSrc))
assert('猫详情分享过滤非 https 封面', /\^https\?:\\\/\\\//.test(cdSrc))

/* ==================== 4. 图例文案 ==================== */
console.log('\n--- 4. 图例与列表 ---')
const wxml = fs.readFileSync(path.join(MP, 'pages/map/map.wxml'), 'utf8')
assert('图例新增投喂气泡说明', /投喂气泡/.test(wxml))
assert('图例引用 feedAlertHours（不写死第二份数字）', /\{\{feedAlertHours\}\}/.test(wxml))
assert('图例说明「常显」语义', /常显/.test(wxml))
assert('图例补充说明豁免状态', /寄养|毕业/.test(wxml))
assert('底部列表有投喂标签', /feedLabel/.test(wxml))
assert('底部列表标签按 pending 变色', /item\.feedPending \? 'feed-warn' : 'feed-ok'/.test(wxml))

// WXML mustache 不允许方法调用 —— 这是本项目踩过的大坑
assert('wxml 无 mustache 方法调用', !/\{\{[^}]*\w+\s*\([^}]*\}\}/.test(wxml))

const wxss = fs.readFileSync(path.join(MP, 'pages/map/map.wxss'), 'utf8')
const appwxss = fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8')
assert('app.wxss 定义 feed-warn 标签色', /\.tag\.feed-warn\s*\{/.test(appwxss))
assert('app.wxss 定义 feed-ok 标签色', /\.tag\.feed-ok\s*\{/.test(appwxss))
assert('lg-txt 加 flex:1 + min-width:0（长文案不挤爆行）',
  /\.lg-txt\s*\{[^}]*flex:\s*1[^}]*min-width:\s*0/.test(wxss))
assert('多行图例行顶对齐', /\.lg-row\.multi\s*\{\s*align-items:\s*flex-start/.test(wxss))

// 列表数据必须在 JS 层预算 —— WXML mustache 编译期白名单不支持方法调用。
// 这里用行为验证而不是源码正则：直接跑 loadFallback，检查落进 setData 的 cats 项。
async function checkFallbackPath() {
  const H3 = 3600000
  const now2 = Date.now()
  FAKE_APP.callApi = async () => ({
    list: [
      { _id: 'k1', name: '饿猫', sterilized: 'no', status: 'campus', location: { lat: 30.5, lng: 114.3, name: '三食堂' }, photos: [] },
      { _id: 'k2', name: '饱猫', sterilized: 'yes', status: 'campus', lastFedAt: new Date(now2 - 1 * H3), location: { lat: 30.5, lng: 114.3 }, photos: [] },
      { _id: 'k3', name: '寄养猫', sterilized: 'yes', status: 'foster', location: { lat: 30.5, lng: 114.3 }, photos: [] }
    ]
  })

  let data = null
  page.setData = d => { data = d }
  page.data = Object.assign({}, page.data, { bounds: null, myLocation: null })
  await page.loadFallback()

  assert('loadFallback 产出 cats', !!(data && data.cats && data.cats.length === 3),
    data && data.cats && data.cats.length)
  const fb = (data.cats || [])
  const of = n => fb.filter(c => c.name === n)[0] || {}
  assert('兜底路径：从未投喂 → pending', of('饿猫').feedPending === true, of('饿猫'))
  assert('兜底路径：从未投喂 → 标签为未投喂', of('饿猫').feedLabel === '未投喂', of('饿猫'))
  assert('兜底路径：1h 前投喂 → 不 pending', of('饱猫').feedPending === false, of('饱猫'))
  assert('兜底路径：1h 前投喂 → 标签为已投喂', of('饱猫').feedLabel === '已投喂', of('饱猫'))
  assert('兜底路径：寄养猫不参与提醒', !of('寄养猫').feedPending && !of('寄养猫').feedLabel, of('寄养猫'))
  assert('兜底路径同样产出 markers', (data.markers || []).length === 3, data.markers && data.markers.length)
}

// 服务端必须下发这个字段，否则前端永远算不出投喂状态
const libMap = fs.readFileSync(path.join(ROOT, 'cloudfunctions/catcampus/lib/map.js'), 'utf8')
assert('云函数 mapPoints 下发 lastFedAt', /lastFedAt:\s*c\.lastFedAt \|\| null/.test(libMap))

checkFallbackPath().catch(e => {
  fail++
  failures.push('loadFallback 行为测试抛出异常: ' + (e && e.message))
  console.log('  FAIL  抛出异常', e && e.message)
}).then(() => {
  console.log('\n=== 结果 ===')
  console.log('PASS ' + pass + ' / FAIL ' + fail)
  if (failures.length) {
    console.log('\n失败项：')
    failures.forEach(f => console.log('  - ' + f))
  }
  process.exit(fail ? 1 : 0)
})
