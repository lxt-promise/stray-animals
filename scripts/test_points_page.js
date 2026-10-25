/**
 * 「猫粮明细 / 等级与积分」页行为级测试
 *
 * 覆盖的都是「不报错、但界面明显不对」的问题：
 *   · 积分模式必须**只发一个请求**（pointsSummary）—— 积分只增不减，
 *     没有流水可看，多拉一次 listPoints 纯属浪费；
 *   · 页面任何字段都不能渲染成 undefined（线上出现过「0 / undefined 分」
 *     「距 Lv.undefined undefined 还差 undefined 分」）；
 *   · 云端只给 points 不给 peakPoints、甚至返回空对象时也要能正常渲染
 *     （云函数未更新 / 字段改名都不该让用户看到裸 undefined）；
 *   · 猫粮模式的流水正负号与颜色标记在 JS 里预计算（WXML 不做字符串运算）。
 *
 * 运行：node scripts/test_points_page.js
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
const env = { replies: {}, calls: [], toasts: [], titles: [] }

const FAKE_APP = {
  globalData: {
    ready: true,
    user: { _id: 'u1', nickName: '测试同学', avatarUrl: '', points: 42 }
  },
  ensureReady: async () => {},
  async callApi(action, data) {
    env.calls.push(action)
    const r = env.replies[action]
    if (typeof r === 'function') return r(data)
    return r === undefined ? {} : r
  }
}
global.getApp = () => FAKE_APP
global.wx = {
  showToast: o => env.toasts.push((o && o.title) || ''),
  setNavigationBarTitle: o => env.titles.push(o && o.title),
  showLoading: () => {}, hideLoading: () => {}, showModal: () => {},
  stopPullDownRefresh: () => {},
  getSystemInfoSync: () => ({ platform: 'devtools' })
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

require(path.join(MP, 'pages/points/points.js'))
assert('points.js 成功注册 Page', !!pageOptions)

function freshPage(options) {
  const page = Object.assign({}, pageOptions, {
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
  if (page.onLoad) page.onLoad(options || {})
  return page
}

/** 递归找字符串里的 undefined/NaN（JSON.stringify 会丢掉 undefined 键，不能只靠它） */
function badText(obj, trail) {
  const hit = []
  const walk = (v, p) => {
    if (typeof v === 'string') {
      if (/undefined|NaN/.test(v)) hit.push(p + '=' + v)
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, p + '[' + i + ']'))
    } else if (v && typeof v === 'object') {
      Object.keys(v).forEach(k => walk(v[k], p + '.' + k))
    }
  }
  walk(obj, trail || 'data')
  return hit
}

const SUMMARY = {
  points: 120, peakPoints: 120, food: 68,
  // 刻意只给 raw 数据：云端不再需要下发 nextMin/nextLv/toNext 之类的派生字段
  today: { point: 10, pointCap: 150, food: 5, foodCap: 50 },
  recognize: { used: 1, limit: 10, left: 9, cost: 20, free: false }
}

function reset(replies) {
  env.replies = replies || {}
  env.calls = []
  env.toasts = []
  env.titles = []
}

async function main() {
  console.log('\n=== S1 积分模式：一次请求、只显示总值 ===')
  reset({ pointsSummary: SUMMARY })
  {
    const p = freshPage({ type: 'point' })
    assert('导航标题为「等级与积分」', env.titles[0] === '等级与积分', env.titles)
    assert('isPoint 标记正确', p.data.isPoint === true && p.data.type === 'point')
    await p.load()
    assert('只发 pointsSummary 一个请求（不查流水）',
      env.calls.length === 1 && env.calls[0] === 'pointsSummary', env.calls)
    assert('流水列表为空', Array.isArray(p.data.list) && p.data.list.length === 0, p.data.list)
    assert('积分总值 = peakPoints（120）', p.data.view.peak === 120, p.data.view.peak)
    assert('等级文案 Lv.2 爱猫人士', p.data.view.levelText === 'Lv.2 爱猫人士', p.data.view.levelText)
    assert('进度 (120-100)/(500-100) → 5%', p.data.view.progress === 5, p.data.view.progress)
    assert('下一档文案「再得 380 积分可升级」', p.data.view.nextText === '再得 380 积分可升级', p.data.view.nextText)
    assert('阶梯 6 档且当前档唯一', p.data.view.steps.length === 6 &&
      p.data.view.steps.filter(s => s.on).length === 1 &&
      p.data.view.steps.filter(s => s.on)[0].lv === 2, p.data.view.steps)
    assert('昵称来自登录态', p.data.user.nickName === '测试同学', p.data.user)
    assert('规则说明有文案（与「我的」页共用 RULES）', (p.data.rules || []).length === 3)
    assert('页面无 undefined / NaN', badText(p.data).length === 0, badText(p.data))
  }

  console.log('\n=== S2 猫粮模式：余额 + 流水，正负号预计算 ===')
  reset({
    pointsSummary: SUMMARY,
    listPoints: () => ([
      { _id: 'l1', kind: 'daily', delta: 5, reason: '每日打卡', createdAt: '2026-10-18T10:00:00Z' },
      { _id: 'l2', kind: 'recognize', delta: -20, reason: '猫咪识别服务', createdAt: '2026-10-18T09:00:00Z' }
    ])
  })
  {
    const p = freshPage({})
    assert('无 type 参数时默认猫粮明细', p.data.isPoint === false && p.data.title === '猫粮明细', p.data.title)
    assert('导航标题为「猫粮明细」', env.titles[0] === '猫粮明细', env.titles)
    await p.load()
    assert('发起 pointsSummary + listPoints（且 currency=food）',
      env.calls.length === 2 && env.calls[1] === 'listPoints', env.calls)
    assert('余额卡显示猫粮 68', p.data.head.num === 68 && p.data.head.label === '猫粮值', p.data.head)
    assert('今日额度 5/50', p.data.wallet.foodToday === 5 && p.data.wallet.foodCap === 50, p.data.wallet)
    assert('正数带 + 号、负数不带且标红', p.data.list[0].deltaText === '+5' && p.data.list[1].deltaText === '-20' &&
      p.data.list[0].minus === false && p.data.list[1].minus === true, p.data.list)
    assert('时间文案已格式化（不是 undefined）', !!p.data.list[0].timeText, p.data.list[0])
    assert('页面无 undefined / NaN', badText(p.data).length === 0, badText(p.data))
  }

  console.log('\n=== S3 云端字段缺失：不许渲染 undefined ===')
  // 云函数还是旧版本：只有 points / food，没有 peakPoints、没有 level 派生字段
  reset({
    pointsSummary: { points: 620, food: 12, today: {}, recognize: {} },
    listPoints: () => []
  })
  {
    const p = freshPage({ type: 'point' })
    await p.load()
    assert('peakPoints 缺失时用 points 兜底（620 → Lv.3）',
      p.data.view.peak === 620 && p.data.view.levelText === 'Lv.3 猫界达人', p.data.view)
    assert('today 缺失时额度用默认值', p.data.wallet.foodToday === 0 && p.data.wallet.foodCap === 50, p.data.wallet)
    assert('无 undefined / NaN', badText(p.data).length === 0, badText(p.data))
  }
  reset({ pointsSummary: {} , listPoints: () => [] })
  {
    const p = freshPage({ type: 'point' })
    await p.load()
    assert('接口返回空对象时渲染 Lv.1，不崩', p.data.view.levelText === 'Lv.1 猫语新手', p.data.view)
    assert('下一步文案完整', p.data.view.nextText === '再得 100 积分可升级', p.data.view.nextText)
    assert('无 undefined / NaN', badText(p.data).length === 0, badText(p.data))
  }

  console.log('\n=== S4 请求失败：提示 + 结束 loading ===')
  reset({})
  FAKE_APP.callApi = async action => { throw new Error(action + ' boom') }
  {
    const p = freshPage({ type: 'point' })
    await p.load()
    assert('弹出失败提示', env.toasts.length === 1 && /boom/.test(env.toasts[0]), env.toasts)
    assert('loading 已结束', p.data.loading === false)
    assert('保留默认等级文案（不是 undefined）', p.data.view.levelText === 'Lv.1 猫语新手', p.data.view)
  }

  console.log('\n' + '='.repeat(52))
  if (fail) {
    console.log('失败 ' + fail + ' 项 / 通过 ' + pass + ' 项')
    failures.forEach(f => console.log('  ✗ ' + f))
    process.exit(1)
  }
  console.log('全部通过：' + pass + ' 项')
}

main().catch(e => {
  console.error('测试脚本异常：', e)
  process.exit(1)
})
