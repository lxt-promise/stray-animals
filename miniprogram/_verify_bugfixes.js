/**
 * 小程序侧 Bug 修复行为验证（模拟微信环境真实加载页面代码）
 */
const fs = require('fs')
const path = require('path')
const ROOT = __dirname

let pass = 0, fail = 0
const check = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n) } else { fail++; console.log('  ✗ ' + n) } }

// ==================== 1. app.js ensureReady 并发不卡死 ====================
console.log('【修复点 A】app.ensureReady 多等待者回调覆盖')
{
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')
  let appCfg = null
  const App = (cfg) => { appCfg = cfg }
  ;(new Function('App', 'wx', 'getApp', src))(App, { cloud: { init() {} }, showModal() {}, showToast() {} }, () => ({}))
  const inst = Object.assign({}, appCfg)
  inst.globalData = JSON.parse(JSON.stringify(appCfg.globalData))

  // 冷启动：两个页面并发 await（修复前第二次调用覆盖回调，第一个永远 pending）
  const p1 = inst.ensureReady()
  const p2 = inst.ensureReady()
  let r1done = false, r2done = false
  p1.then(() => { r1done = true })
  p2.then(() => { r2done = true })
  // 模拟 _boot 完成
  inst.globalData.user = { _id: 'u1', role: 'member' }
  inst.globalData.ready = true
  inst._flushReady()
  setTimeout(() => {
    check('并发两个 ensureReady 都 resolve（修复前第一个永久 pending）', r1done && r2done)
    let r3 = false
    inst.ensureReady().then(() => { r3 = true })
    setTimeout(() => {
      check('ready 之后的调用同步 resolve', r3)
      runMap()
    }, 10)
  }, 20)
}

// ==================== 2. map.js keep / buildCatMarker isFinite + 弹窗序号 ====================
function runMap() {
  console.log('【修复点 B】map 坐标 isFinite + 弹窗连点序号')
  const src = fs.readFileSync(path.join(ROOT, 'pages/map/map.js'), 'utf8')
  let cfg = null
  const appMock = {
    globalData: { myLocation: null, school: null },
    isMember: () => true, isAdmin: () => false, isSuper: () => false,
    ensureReady: async () => ({}),
    callApi: async () => ({ points: [], clusters: [] }),
    refreshUser: async () => ({})
  }
  const wxMock = {
    setNavigationBarTitle() {}, showToast() {}, showLoading() {}, hideLoading() {},
    getLocation(o) { o.success({ latitude: 32.05, longitude: 118.79 }) },
    openLocation() {}, onLocationChange() {}
  }
  ;(new Function('getApp', 'Page', 'wx', 'require', src))(
    () => appMock, (c) => { cfg = c }, wxMock,
    (p) => {
      if (p.endsWith('util.js')) return require(path.join(ROOT, 'utils/util.js'))
      if (p.endsWith('const.js')) return require(path.join(ROOT, 'utils/const.js'))
      // 页面普遍通过 photo.js 把 cloud:// 换成 https 缩略图（2026-10-15 起）。
      // 白名单漏了它，脚本会在 eval 里抛「unexpected require」，看起来像回归。
      if (p.endsWith('photo.js')) return require(path.join(ROOT, 'utils/photo.js'))
      throw new Error('unexpected require ' + p)
    }
  )
  const mk = () => {
    const p = Object.assign({}, cfg)
    p.data = JSON.parse(JSON.stringify(cfg.data))
    for (const k of Object.keys(cfg)) if (typeof cfg[k] === 'function') p[k] = cfg[k].bind(p)
    p.setData = function (patch) {
      for (const k in patch) {
        if (k.indexOf('.') >= 0) { const s = k.split('.'); let o = p.data; for (let i = 0; i < s.length - 1; i++) o = o[s[i]]; o[s[s.length - 1]] = patch[k] }
        else p.data[k] = patch[k]
      }
    }
    return p
  }

  const page = mk()
  const mNaN = cfg.buildCatMarker.call(page, 1, { catId: 'c1', name: '幽灵猫', lat: NaN, lng: 118.5, sterilized: 'no', pattern: 'tabby' })
  check('buildCatMarker(NaN 坐标) 返回 null（不进 marker）', mNaN === null)
  const mInf = cfg.buildCatMarker.call(page, 1, { catId: 'c2', name: '无穷猫', lat: Infinity, lng: 118.5, sterilized: 'no', pattern: 'tabby' })
  check('buildCatMarker(Infinity 坐标) 返回 null', mInf === null)
  const mOk = cfg.buildCatMarker.call(page, 1, { catId: 'c3', name: '橘子', lat: 32.05, lng: 118.5, sterilized: 'yes', pattern: 'orange' })
  check('buildCatMarker(正常坐标) 返回 marker 且选橙色 done 图', !!mOk && mOk.iconPath.indexOf('marker-cartoon-orange-done') >= 0)

  // 弹窗连点竞态：第一次 getCat 慢、第二次快，最终展示应是第二次的
  let callN = 0
  appMock.callApi = async (action, payload) => {
    if (action !== 'getCat') return {}
    callN++
    const isFirst = callN === 1
    await new Promise(r => setTimeout(r, isFirst ? 60 : 5))
    return {
      cat: { _id: payload.id, name: isFirst ? '先点的猫A' : '后点的猫B', sex: 'male', sterilized: 'yes', status: 'campus', pattern: 'orange', location: { name: '地点' }, sightingCount: 3 },
      sightings: []
    }
  }
  const p2 = mk()
  Promise.all([
    cfg.openCatPopup.call(p2, 'catA', { lat: 32.01, lng: 118.1 }),
    cfg.openCatPopup.call(p2, 'catB', { lat: 32.02, lng: 118.2 })
  ]).then(() => {
    check('连点两个 marker：最终展示后点的猫B（过期响应被丢弃）', p2.data.popupCat && p2.data.popupCat.name === '后点的猫B')
    check('popupLatLng 是后点坐标（与档案配套，不会张冠李戴）', p2.data.popupLatLng && p2.data.popupLatLng.lat === 32.02)
    runCats()
  })
}

// ==================== 3. cats.js fetch 序号 ====================
function runCats() {
  console.log('【修复点 C】cats fetch 过期响应丢弃')
  const catsSrc = fs.readFileSync(path.join(ROOT, 'pages/cats/cats.js'), 'utf8')
  let catsCfg = null
  let apiSeq = 0
  const appMock = {
    globalData: {},
    isMember: () => true, isAdmin: () => false, isSuper: () => false,
    ensureReady: async () => ({}),
    callApi: async (action) => {
      apiSeq++
      const n = apiSeq
      await new Promise(r => setTimeout(r, n === 1 ? 60 : 5))   // 第 1 个慢、第 2 个快
      if (action === 'listCats') return { list: [{ _id: 'cat' + n, name: '猫' + n }], hasMore: true }
      return { list: [], hasMore: false }
    },
    refreshUser: async () => ({})
  }
  ;(new Function('getApp', 'Page', 'wx', 'require', catsSrc))(
    () => appMock, (c) => { catsCfg = c }, { showToast() {}, stopPullDownRefresh() {} },
    (p) => {
      if (p.endsWith('util.js')) return require(path.join(ROOT, 'utils/util.js'))
      if (p.endsWith('const.js')) return require(path.join(ROOT, 'utils/const.js'))
      // 页面普遍通过 photo.js 把 cloud:// 换成 https 缩略图（2026-10-15 起）。
      // 白名单漏了它，脚本会在 eval 里抛「unexpected require」，看起来像回归。
      if (p.endsWith('photo.js')) return require(path.join(ROOT, 'utils/photo.js'))
      throw new Error('unexpected require ' + p)
    }
  )
  const cp = Object.assign({}, catsCfg)
  cp.data = JSON.parse(JSON.stringify(catsCfg.data))
  for (const k of Object.keys(catsCfg)) if (typeof catsCfg[k] === 'function') cp[k] = catsCfg[k].bind(cp)
  cp.setData = function (patch) { for (const k in patch) cp.data[k] = patch[k] }
  cp.setData({ tab: 'cat', page: 1, list: [{ _id: 'cat0', name: '旧数据' }], hasMore: true, loading: false })

  Promise.all([
    catsCfg.loadMore.call(cp),   // fetch(2) 慢（先发）
    catsCfg.reload.call(cp)      // fetch(1) 快（后发）
  ]).then(() => {
    check('过期 loadMore 响应被丢弃（list 不含旧数据与重复项）',
      cp.data.list.length === 1 && cp.data.list[0]._id === 'cat2')
    check('page 停在最新请求的 1', cp.data.page === 1)
    runMine()
  })
}

// ==================== 4. mine.js go() tabBar 防御 + WXML 静态断言 ====================
function runMine() {
  console.log('【修复点 D】mine go() tabBar 防御 + WXML 静态断言')
  const mineSrc = fs.readFileSync(path.join(ROOT, 'pages/mine/mine.js'), 'utf8')
  let mineCfg = null
  const calls = []
  const wxMock = {
    navigateTo(o) { calls.push(['navigateTo', o.url]) },
    switchTab(o) { calls.push(['switchTab', o.url]) },
    showToast() {}, showModal() {}, stopPullDownRefresh() {}
  }
  const appMock = {
    globalData: { catsTab: '' },
    isMember: () => true, isAdmin: () => true, isSuper: () => false,
    ensureReady: async () => ({}),
    callApi: async () => ({ me: {}, stats: {}, mySightings: [], cats: [] }),
    refreshUser: async () => ({})
  }
  ;(new Function('getApp', 'Page', 'wx', 'require', mineSrc))(
    () => appMock, (c) => { mineCfg = c }, wxMock,
    (p) => {
      if (p.endsWith('util.js')) return require(path.join(ROOT, 'utils/util.js'))
      if (p.endsWith('const.js')) return require(path.join(ROOT, 'utils/const.js'))
      // 页面普遍通过 photo.js 把 cloud:// 换成 https 缩略图（2026-10-15 起）。
      // 白名单漏了它，脚本会在 eval 里抛「unexpected require」，看起来像回归。
      if (p.endsWith('photo.js')) return require(path.join(ROOT, 'utils/photo.js'))
      // 「我的」页用本地等级表算称号（不依赖云端派生字段，见 utils/level.js 注释）
      if (p.endsWith('level.js')) return require(path.join(ROOT, 'utils/level.js'))
      throw new Error('unexpected require ' + p)
    }
  )
  const mp = Object.assign({}, mineCfg)
  mp.data = JSON.parse(JSON.stringify(mineCfg.data))
  for (const k of Object.keys(mineCfg)) if (typeof mineCfg[k] === 'function') mp[k] = mineCfg[k].bind(mp)
  mp.setData = function (patch) { for (const k in patch) mp.data[k] = patch[k] }

  mineCfg.go.call(mp, { currentTarget: { dataset: { url: '/pages/cats/cats?tab=sighting' } } })
  check('go(cats?tab=...) 自动走 switchTab（navigateTo 会被静默拒绝）',
    calls.some(c => c[0] === 'switchTab' && c[1] === '/pages/cats/cats') &&
    !calls.some(c => c[0] === 'navigateTo' && c[1].indexOf('cats') >= 0))
  mineCfg.go.call(mp, { currentTarget: { dataset: { url: '/pages/fund/fund' } } })
  check('go(非 tabBar 页) 仍走 navigateTo', calls.some(c => c[0] === 'navigateTo' && c[1] === '/pages/fund/fund'))
  mineCfg.goCatsSighting.call(mp)
  check('goCatsSighting 写 globalData.catsTab 并 switchTab',
    appMock.globalData.catsTab === 'sighting' && calls[calls.length - 1][0] === 'switchTab')

  console.log('【修复点 E】WXML 静态断言')
  const catsWxml = fs.readFileSync(path.join(ROOT, 'pages/cats/cats.wxml'), 'utf8')
  check('cats.wxml 无动态 bindtap（三元表达式）', !/bindtap="\{\{/.test(catsWxml))
  check('cats.wxml FAB 用静态 onFabTap', /bindtap="onFabTap"/.test(catsWxml))
  const mineWxml = fs.readFileSync(path.join(ROOT, 'pages/mine/mine.wxml'), 'utf8')
  check('mine.wxml 无指向 cats 的 data-url（已改 goCatsSighting）', !/data-url="\/pages\/cats\/cats/.test(mineWxml))
  check('mine.wxml 含 goCatsSighting 入口', /bindtap="goCatsSighting"/.test(mineWxml))
  const pointsJs = fs.readFileSync(path.join(ROOT, 'pages/points/points.js'), 'utf8')
  check('points 明细 delta 支持负号（删除退回流水）', /r\.delta > 0 \? '\+' : ''/.test(pointsJs))

  // WXML 标签配平（两个改动文件）
  for (const f of ['pages/cats/cats.wxml', 'pages/mine/mine.wxml', 'pages/points/points.wxml']) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    const stack = []
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
    let m, bad = false
    while ((m = re.exec(s))) {
      const [, close, tag, , self] = m
      if (self) continue
      if (!close) stack.push(tag)
      else { const t = stack.pop(); if (t !== tag) { console.log('    ' + f + ' 不配对 </' + tag + '> 栈顶 <' + t + '>'); bad = true } }
    }
    if (stack.length) { console.log('    ' + f + ' 未闭合 ' + stack.join(',')); bad = true }
    check(f + ' 标签配平', !bad)
  }

  console.log('')
  console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败')
  process.exit(fail ? 1 : 0)
}
