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
 *  - getSchool 的新返回值落进 data.school / globalData.school；
 *  - 地图中心 / 地图范围只在超管后台维护，个人页不再出现任何坐标/缩放控件；
 *  - getSchool 失败被局部 catch 吞掉，不影响打卡/图鉴/工作台，且不弹 toast；
 *  - listSightings 失败仍走外层 catch 弹 toast（保留「不再静默吞错」的行为）；
 *  - 非管理员不发起工作台 4 个请求。
 *
 * 运行：node scripts/test_mine_parallel.js
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
  admin: true,
  gated: true,            // true=请求挂起等放行（证明并行用）；false=立即返回
  failActions: [],        // 这些 action 直接 reject
  replies: {},            // action -> 返回值或 fn(data)
  calls: [],              // 调用顺序
  pending: [],            // 挂起中的 resolve
  toasts: [],
  navs: []                // 跳转记录（navigateTo / switchTab 的 url）
}

const HOUR = 3600000
const FRESH_SCHOOL = { _id: 's1', name: '新学校名', scale: 17, center: { lat: 30.5, lng: 114.3 } }

const FAKE_APP = {
  globalData: {
    ready: true,
    user: {
      _id: 'u1', nickName: '测试用户', points: 42, sightingCount: 7,
      // 已绑定学校：不再去查「我的建校申请」（未绑定时才需要）
      schoolId: 's1',
      catSeen: ['c1', 'c3'], isSuper: false
    },
    // 缓存里的旧学校（scale 15，name 旧）—— 用来验证「以云端为准」
    school: { _id: 's1', name: '旧学校名', scale: 15, center: { lat: 30.5, lng: 114.3 } }
  },
  isMember: () => true,
  isAdmin: () => env.admin,
  isSuper: () => false,
  // 页面改用 app.setSchool() 写全局学校（换校要作废首页概览缓存）。
  // stub 必须实现同名方法：缺方法会被 job 的 catch 吞掉，表现为
  // 「globalData.school 没更新」这种看起来像业务 bug 的假失败。
  setSchool(school) {
    const prev = (this.globalData.school && this.globalData.school._id) || ''
    const next = (school && school._id) || ''
    this.globalData.school = school || null
    if (prev !== next) this.globalData.homeOverview = null
    return this.globalData.school
  },
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
  navigateTo: o => env.navs.push(o.url),
  switchTab: o => env.navs.push(o.url),
  stopPullDownRefresh: () => {},
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
    // 真实 setData 支持 'a.b.c' 路径写法（mine.js 用它只更新 stats 的某个字段，
    // 避免整体覆盖 stats 与并发请求打架）。mock 必须同样支持，否则测试会假失败。
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

function reset(o) {
  o = o || {}
  env.navs = []
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
    // 双货币拆分后，页面额外拉一次账户概览（积分/猫粮/等级）。
    // 页面只取 raw 数据（peakPoints / points / food），等级由 utils/level.js 本地算 ——
    // 所以这里刻意**不**给 level 派生字段，用来证明「云端不下发 level 也能渲染正确」。
    pointsSummary: () => ({
      points: 42, peakPoints: 120, food: 68,
      today: { point: 10, pointCap: 150, food: 5, foodCap: 50 },
      recognize: { used: 0, limit: 10, left: 10, cost: 20, free: true }
    }),
    listSightings: (d) => d && d.pending
      ? { list: [{ _id: 'p1' }, { _id: 'p2' }] }                                   // 工作台：待建档
      : { list: [{ _id: 'sg1', createdAt: new Date(Date.now() - 2 * HOUR).toISOString() }] },
    // 图鉴摘要：brief 模式只回计数（不拉清单）。这里刻意让 total(4) ≠ 已有猫数(2)，
    // 用来证明页面用的是云端给出的 total，而不是「这一页有几只」。
    listDex: () => ({ brief: true, needSchool: false, schoolId: 's1', seen: 2, total: 4, percent: 50, list: [] }),
    listSchools: () => [
      { _id: 's1', name: '新学校名', campus: '仙林校区' },
      { _id: 's2', name: '另一所学校', campus: '' }
    ],
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
  assert('管理员路径 9 个请求全部已发起', env.calls.length === 9, env.calls)
  assert('发起了 getSchool', env.calls.indexOf('getSchool') >= 0)
  assert('发起了 listSightings（我的打卡）', env.calls.indexOf('listSightings') >= 0)
  assert('发起了 listDex（图鉴摘要，本校口径）', env.calls.indexOf('listDex') >= 0)
  assert('不再调用 listCats 自己算图鉴（那是分页列表，没有 total）',
    env.calls.indexOf('listCats') < 0, env.calls)
  assert('发起了 listSchools（选校下拉的数据源）', env.calls.indexOf('listSchools') >= 0)
  assert('发起了 pointsSummary（双货币账户概览）', env.calls.indexOf('pointsSummary') >= 0)
  assert('发起了 listTnr/listTasks/listFunds（工作台）',
    env.calls.indexOf('listTnr') >= 0 && env.calls.indexOf('listTasks') >= 0 && env.calls.indexOf('listFunds') >= 0)

  // 放行全部挂起请求，等 load 收尾
  env.pending.splice(0).forEach(fn => fn())
  await done1

  assert('data.school 用上云端新值', p1.data.school && p1.data.school.name === '新学校名', p1.data.school && p1.data.school.name)
  assert('globalData.school 被同步刷新', FAKE_APP.globalData.school.name === '新学校名')
  // 地图中心/范围已迁到超管后台：个人页不再持有任何 scale 选择器状态
  assert('个人页不再维护地图范围状态（不出现 scale 字段）',
    p1.data.scaleOptions === undefined && p1.data.schoolScale === undefined && p1.data.scaleIndex === undefined,
    Object.keys(p1.data).filter(k => /scale|center/i.test(k)))
  assert('打卡列表带 timeText', p1.data.mySightings.length === 1 && !!p1.data.mySightings[0].timeText,
    p1.data.mySightings)
  // 猫粮来自 pointsSummary（实时），打卡次数来自 user，图鉴数来自 listDex（本校口径）——
  // 三路并发写入，谁后到谁生效的写法会闪旧值。
  assert('统计来自 pointsSummary + user + listDex（68/7/2）',
    p1.data.stats.food === 68 &&
    p1.data.stats.sightingCount === 7 && p1.data.stats.catSeen === 2,
    p1.data.stats)
  assert('等级文案由 JS 预计算（WXML 不做字符串拼接）',
    p1.data.wallet.levelText === 'Lv.2 爱猫人士' && p1.data.wallet.food === 68,
    p1.data.wallet)
  // 图鉴进度已挪到 pages/dex：这里只留一个入口文案
  assert('图鉴入口显示「已收集 / 本校总数」', p1.data.dexSummary.text === '2 / 4', p1.data.dexSummary)
  assert('选校下拉 label 已预拼好（name · campus）',
    p1.data.schoolOptions.length === 2 && p1.data.schoolOptions[0].label === '新学校名 · 仙林校区',
    p1.data.schoolOptions)
  assert('下拉右侧文案由 JS 预拼（WXML 里字符串相加会被吃掉）',
    p1.data.schoolPickSide === '共 2 所', p1.data.schoolPickSide)
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
  assert('换校副文案按「已绑定」处境给出', /换校后/.test(p2.data.schoolPickHint || ''), p2.data.schoolPickHint)
  assert('打卡/图鉴摘要照常出', p2.data.mySightings.length === 1 && p2.data.dexSummary.text === '2 / 4',
    p2.data.dexSummary)
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
  assert('普通用户数据完整', p4.data.mySightings.length === 1 && p4.data.dexSummary.seen === 2,
    p4.data.dexSummary)

  /* ==================== 5. 三格统计可点 ==================== */
  console.log('\n--- 5. 三格统计的点击跳转 ---')
  {
    const wxml = fs.readFileSync(path.join(MP, 'pages/mine/mine.wxml'), 'utf8')
    assert('猫粮值格绑定 goFoodDetail', /class="stat-card" bindtap="goFoodDetail"/.test(wxml))
    assert('打卡次数格绑定 goCatsSighting', /class="stat-card" bindtap="goCatsSighting"/.test(wxml))
    assert('图鉴数格绑定 goDex', /class="stat-card" bindtap="goDex"/.test(wxml))
    assert('三格都有「可点」箭头提示', (wxml.match(/class="stat-go"/g) || []).length === 3,
      (wxml.match(/class="stat-go"/g) || []).length)

    // 图鉴数要显示「已收集 / 本校总数」（3/4）：只给「3」看不出还差几只。
    // 模板里必须把分母拆成独立 <text>（WXML 不支持字符串拼接，{{a+'/'+b}} 会被静默吃掉）
    assert('图鉴数格带分母（seen/total）',
      wxml.indexOf('{{stats.catSeen}}<text class="num-sub">/{{dexSummary.total}}</text>') > 0)
    // total 为 0（未绑定学校 / 本校暂无档案）时不能摆出「0/0」
    assert('无分母时退化为「—」', /class="num dim" wx:else>—</.test(wxml))
    const wxss = fs.readFileSync(path.join(MP, 'pages/mine/mine.wxss'), 'utf8')
    assert('分母有小字号样式', /\.stat-card \.num-sub\s*\{/.test(wxss))

    // 版式：图标在左、标签与数值在右（横排）。锁住"图标是第一个子元素、数值在 stat-body 内"，
    // 否则下次改样式很容易又退回竖排——三格并排在竖排下要么很矮要么数字被压小。
    const cardBlocks = wxml.split('<view class="stat-card"').slice(1)
    assert('三格统计都是横排且结构一致（图标在左，标签/数值在右）',
      cardBlocks.length === 3 && cardBlocks.every(b => {
        const iIco = b.indexOf('class="stat-ico"')
        const iBody = b.indexOf('class="stat-body"')
        return iIco >= 0 && iBody > iIco &&
          b.indexOf('class="lbl"') > iBody && b.indexOf('class="num') > iBody
      }), cardBlocks.map(b => b.slice(0, 70)))
    assert('横排样式：卡片 display:flex + 文本区 min-width:0（否则长标签撑破卡）',
      /\.stat-card \{[^}]*display:\s*flex/.test(wxss) &&
      /\.stat-body \{[^}]*min-width:\s*0/.test(wxss))

    reset({ admin: false, gated: false })
    const p5 = freshPage()
    p5.goFoodDetail()
    assert('点猫粮值 → 猫粮明细（type=food）',
      env.navs[0] === '/pages/points/points?type=food', env.navs)
    env.navs = []
    p5.goCatsSighting()
    assert('点打卡次数 → 猫谱打卡记录 tab', env.navs[0] === '/pages/cats/cats', env.navs)
    assert('切 tab 前写入 catsTab=sighting', FAKE_APP.globalData.catsTab === 'sighting',
      FAKE_APP.globalData.catsTab)
    FAKE_APP.globalData.catsTab = ''
    env.navs = []
    p5.goDex()
    assert('点图鉴数 → 图鉴收集页', env.navs[0] === '/pages/dex/dex', env.navs)
  }

  /* ==================== 6. 打卡次数不为负 ==================== */
  console.log('\n--- 6. 打卡次数展示兜底 ---')
  {
    reset({ admin: false, gated: false })
    const old = FAKE_APP.globalData.user
    // 云端历史脏数据（后台删他人记录误减）可能是负数，页面不能把它直接显示出来
    FAKE_APP.globalData.user = Object.assign({}, old, { sightingCount: -2 })
    const p6 = freshPage()
    await p6.load()
    assert('sightingCount = -2 时展示为 0', p6.data.stats.sightingCount === 0,
      p6.data.stats.sightingCount)
    FAKE_APP.globalData.user = old
  }

  /* ==================== 7. 学校配置的归属 ==================== */
  console.log('\n--- 7. 地图中心/范围只在超管后台配置 ---')
  {
    const mineWxml = fs.readFileSync(path.join(MP, 'pages/mine/mine.wxml'), 'utf8')
    const mineJs = fs.readFileSync(path.join(MP, 'pages/mine/mine.js'), 'utf8')
    // 个人页重新出现这几个绑定 = 基础设施配置又漏回个人页了
    // （只查绑定/数据源，不查文案 —— 注释里解释"已迁走"是正常的）
    assert('个人页没有地图中心/范围控件',
      mineWxml.indexOf('setSchoolCenter') < 0 && mineWxml.indexOf('saveScale') < 0 &&
      mineWxml.indexOf('bindchange="onScaleChange"') < 0 &&
      mineWxml.indexOf('range="{{scaleOptions}}"') < 0,
      (mineWxml.match(/bindchange="[^"]*"/g) || []))
    assert('个人页不再调用 chooseLocation / updateSchool',
      mineJs.indexOf('chooseLocation') < 0 && mineJs.indexOf('updateSchool') < 0)
    assert('个人页也没有残留的 scale 选择器逻辑',
      mineJs.indexOf('scaleOptions') < 0 && mineJs.indexOf('onScaleChange') < 0)

    const admWxml = fs.readFileSync(path.join(MP, 'pages/admin/admin.wxml'), 'utf8')
    assert('后台提供「选中心点 + 缩放级别」两件配置',
      /bindtap="chooseSchoolCenter"/.test(admWxml) && /bindchange="onSchoolScaleChange"/.test(admWxml))
    // 学校卡仍要能换校（去掉配置不等于去掉选校）
    assert('个人页保留换校入口',
      /bindchange="onPickSchool"/.test(mineWxml) && /schoolPickHint/.test(mineWxml))
  }

  /* ==================== 结果 ==================== */
  console.log('\n=== 结果 ===')
  console.log('PASS ' + pass + ' / FAIL ' + fail)
  if (fail) { console.log('失败项：\n  ' + failures.join('\n  ')) }
  process.exit(fail ? 1 : 0)
})
