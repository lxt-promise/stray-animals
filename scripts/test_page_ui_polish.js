/**
 * 首页 / 猫谱 · 交互接线测试
 *
 * 这轮是纯视觉重排，但有两处**行为**改动必须锁住，否则下次改样式时容易悄悄丢掉：
 *  1. 首页三格统计改成可点（在册/绝育率 → 猫谱，本月目击 → 打卡记录）。
 *     cats 是 tabBar 页，必须 switchTab —— 用 navigateTo 会被微信静默拒绝，
 *     表现就是「点了没反应」（本项目在「我的打卡」上踩过一次）。
 *  2. 猫谱搜索新增「清空」按钮：清空时要**先撤掉挂起的防抖定时器**再 reload，
 *     否则 400ms 后 onSearch 的回调会带着旧关键词再刷一次 —— 界面表现为
 *     「刚清空又跳回搜索结果」，同时白烧一次云函数调用。
 *
 * 断言打在调用结果上（wx.switchTab 的 url、reload 次数、定时器是否真的被撤销），
 * 不匹配源码形状。
 *
 * 运行：node scripts/test_page_ui_polish.js
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
const env = { navs: [], toasts: [] }

global.wx = {
  switchTab(o) { env.navs.push({ type: 'switchTab', url: o.url }); o.success && o.success() },
  navigateTo(o) { env.navs.push({ type: 'navigateTo', url: o.url }); o.success && o.success() },
  showToast(o) { env.toasts.push(o.title) },
  showModal(o) { env.toasts.push(o.title) },
  stopPullDownRefresh() {},
  getStorageSync() { return '' },
  setStorageSync() {}
}

const FAKE_APP = {
  globalData: { ready: true, user: { _id: 'u1' }, school: null, homeOverview: null, catsTab: '' },
  isMember: () => true,
  isAdmin: () => true,
  isSuper: () => false,
  ensureReady: async () => {},
  callApi: async () => ({}),
  setSchool() {},
  refreshUser: async () => {}
}
global.getApp = () => FAKE_APP

// wxml/wxss/json 不参与逻辑，拦掉避免 require 报错
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request && /\.wxml$|\.wxss$|\.json$/.test(request)) return {}
  return origLoad.apply(this, arguments)
}

let indexOpts = null
global.Page = opts => { indexOpts = opts }
require(path.join(MP, 'pages/index/index.js'))

let catsOpts = null
global.Page = opts => { catsOpts = opts }
require(path.join(MP, 'pages/cats/cats.js'))

assert('index.js 注册 Page', !!indexOpts)
assert('cats.js 注册 Page', !!catsOpts)

/** 造一个最小页面实例：data 深拷贝 + 支持 'a.b' 路径写法的 setData */
function mkPage(opts, extra) {
  return Object.assign({}, opts, {
    data: JSON.parse(JSON.stringify(opts.data)),
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
  }, extra || {})
}

async function main() {
  /* ==================== 1. 首页三格统计可点 ==================== */
  console.log('\n--- 1. 首页统计卡跳转 ---')
  {
    env.navs = []
    const p = mkPage(indexOpts)
    assert('首页有 goCats 方法', typeof p.goCats === 'function')
    p.goCats()
    assert('goCats 走 switchTab（tabBar 页 navigateTo 会被静默拒绝）',
      env.navs.length === 1 && env.navs[0].type === 'switchTab', env.navs)
    assert('goCats 目标为猫谱', env.navs[0] && env.navs[0].url === '/pages/cats/cats', env.navs)

    env.navs = []
    p.goSightingList()
    assert('goSightingList 先写 catsTab 再 switchTab',
      FAKE_APP.globalData.catsTab === 'sighting' &&
      env.navs[0] && env.navs[0].type === 'switchTab' && env.navs[0].url === '/pages/cats/cats',
      { catsTab: FAKE_APP.globalData.catsTab, navs: env.navs })
    FAKE_APP.globalData.catsTab = ''

    // 模板契约：三格都要绑定事件，且只能绑静态方法名（三元会被编译期忽略）
    const wxml = fs.readFileSync(path.join(MP, 'pages/index/index.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    const cards = wxml.match(/<view class="stat-card"[^>]*>/g) || []
    const real = cards.filter(s => s.indexOf('skeleton') < 0)
    assert('统计卡共 3 张且都绑定了点击', real.length === 3 && real.every(s => /bindtap="\w+"/.test(s)),
      real)
    assert('统计卡没有动态 bindtap（编译期不求值）', !/bindtap="\{\{/.test(wxml))
    assert('在册/绝育率指向 goCats', (wxml.match(/bindtap="goCats"/g) || []).length === 2,
      (wxml.match(/bindtap="goCats"/g) || []).length)
    assert('本月目击指向 goSightingList', /bindtap="goSightingList"/.test(wxml))

    // 版式：图标在左、标签与数值在右（横排）。三格并排且竖排时数字只能压到很小，
    // 横排把图标挪到左边，右侧腾出的宽度够 4 字标签 + 3 位数。
    const blocks = wxml.split('<view class="item">').slice(1, 4)
    assert('三格统计都是横排且结构一致（图标在左，标签/数值在右）',
      blocks.length === 3 && blocks.every(b => {
        const iIco = b.indexOf('class="stat-ico"')
        const iBody = b.indexOf('class="stat-body"')
        return iIco >= 0 && iBody > iIco &&
          b.indexOf('class="lbl"') > iBody && b.indexOf('class="num') > iBody
      }), blocks.map(b => b.slice(0, 70)))
    // 骨架卡也要同结构：骨架与真卡高度不等时，数据到达会把下方内容顶一下
    const skeletons = wxml.match(/stat-card skeleton[\s\S]*?(?=<\/view><\/view><\/view>)/g) || []
    assert('骨架卡也是横排结构（带 stat-body）',
      skeletons.length === 3 && skeletons.every(s => s.indexOf('class="stat-body"') > 0),
      skeletons.length)
    const wxss = fs.readFileSync(path.join(MP, 'pages/index/index.wxss'), 'utf8')
    assert('横排样式：卡片 display:flex + 文本区 min-width:0（否则长标签撑破卡）',
      /\.stat-card \{[^}]*display:\s*flex/.test(wxss) &&
      /\.stat-body \{[^}]*min-width:\s*0/.test(wxss))
  }

  /* ==================== 2. 猫谱清空搜索 ==================== */
  console.log('\n--- 2. 猫谱清空搜索 ---')
  {
    let reloads = 0
    let timerFired = false
    const p = mkPage(catsOpts, {
      reload: async () => { reloads++ },
      // 模拟用户刚敲完字、防抖还没落地
      _searchTimer: null
    })
    p.data.keyword = '小灰'
    p._searchTimer = setTimeout(() => { timerFired = true }, 40)

    p.clearKeyword()
    assert('清空后 keyword 为空', p.data.keyword === '', p.data.keyword)
    assert('清空立即触发一次 reload', reloads === 1, reloads)
    assert('挂起的定时器被撤销（句柄置空）', p._searchTimer === null, p._searchTimer)

    await new Promise(r => setTimeout(r, 90))
    assert('旧防抖回调没有迟到触发（否则会带着旧词再刷一次）',
      timerFired === false && reloads === 1, { timerFired, reloads })

    // 模板契约：有输入才出现清除键
    const wxml = fs.readFileSync(path.join(MP, 'pages/cats/cats.wxml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    assert('清除键绑定 clearKeyword', /bindtap="clearKeyword"/.test(wxml))
    assert('清除键受 keyword 控制显示', /wx:if="\{\{keyword\}\}"/.test(wxml))
    assert('搜索与筛选合并在一个面板里',
      /class="filter-panel"/.test(wxml) && /class="search-row"/.test(wxml) &&
      (wxml.match(/class="filter-scroll"/g) || []).length === 2)
  }

  /* ==================== 3. 猫卡片：可点区域与箭头 ==================== */
  console.log('\n--- 3. 猫谱卡片 ---')
  {
    const cardWxml = fs.readFileSync(path.join(MP, 'components/cat-card/cat-card.wxml'), 'utf8')
    assert('整卡可点（bindtap=onTap）', /class="cat-card[^"]*"[^>]*bindtap="onTap"/.test(cardWxml))
    assert('保留头像失败兜底 binderror', /binderror="onAvatarError"/.test(cardWxml))
    assert('卡片带右侧箭头（暗示可点开）', /class="go"/.test(cardWxml))
  }

  console.log('\n=== 结果 ===')
  console.log('PASS ' + pass + ' / FAIL ' + fail)
  if (fail) { console.log('失败项：\n  ' + failures.join('\n  ')) }
  process.exit(fail ? 1 : 0)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
