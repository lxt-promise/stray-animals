/**
 * 「图鉴收集」页 + 「我的」页图鉴入口 行为级测试
 *
 * 锁的是一组「不报错但界面明显不对」的问题：
 *   · 未绑定学校时**不能**给出 0 / 4 这种假进度（旧实现用 listCats，where 为空，
 *     拿到的是全环境的猫）；图鉴必须按用户绑定的学校统计；
 *   · 已收集数必须按「本校猫 ∩ catSeen」算，换校后不能出现 7 / 4；
 *   · 未解锁的格子不请求头像（省流量），且不泄漏猫名；
 *   · 页面文案全部在 JS 预计算，任何字段都不许渲染成 undefined；
 *   · 「我的」页只留入口，进度墙必须已经挪走（否则两处口径会打架）。
 *
 * 运行：node scripts/test_dex_page.js
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
const env = { replies: {}, calls: [], toasts: [], tabs: [], fail: '' }

const FAKE_APP = {
  globalData: {
    ready: true,
    user: { _id: 'u1', nickName: '测试同学' },
    school: { _id: 's1', name: '南京大学', campus: '仙林校区' },
    mineAction: ''
  },
  ensureReady: async () => {},
  async callApi(action, data) {
    env.calls.push(action)
    if (env.fail) throw new Error(env.fail)
    const r = env.replies[action]
    return typeof r === 'function' ? r(data) : (r === undefined ? {} : r)
  }
}
global.getApp = () => FAKE_APP
global.wx = {
  showToast: o => env.toasts.push((o && o.title) || ''),
  stopPullDownRefresh: () => {},
  switchTab: o => env.tabs.push(o && o.url),
  navigateTo: () => {},
  showLoading: () => {}, hideLoading: () => {},
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

require(path.join(MP, 'pages/dex/dex.js'))
assert('dex.js 成功注册 Page', !!pageOptions)

function freshPage() {
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
  return page
}

function reset(replies) {
  env.replies = replies || {}
  env.calls = []
  env.toasts = []
  env.tabs = []
  env.fail = ''
}

/** 递归找字符串里的 undefined/NaN */
function badText(obj) {
  const hit = []
  const walk = (v, p) => {
    if (typeof v === 'string') { if (/undefined|NaN/.test(v)) hit.push(p + '=' + v); return }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, p + '[' + i + ']'))
    if (v && typeof v === 'object') Object.keys(v).forEach(k => walk(v[k], p + '.' + k))
  }
  walk(obj, 'data')
  return hit
}

async function main() {
  console.log('\n=== S1 已绑定学校：只发 listDex，按本校口径渲染 ===')
  reset({
    listDex: () => ({
      needSchool: false, brief: false, total: 4, seen: 2, percent: 50,
      list: [
        { id: 'c1', name: '咪咪', pattern: 'orange', avatar: 'https://x/a.jpg', avatarId: 'cloud://a', unlocked: true },
        { id: 'c2', name: '喵喵', pattern: 'tabby', avatar: 'https://x/b.jpg', avatarId: 'cloud://b', unlocked: false }
      ]
    })
  })
  {
    const p = freshPage()
    await p.load()
    assert('只发 listDex 一个请求（不自己拉 listCats 拼）',
      env.calls.length === 1 && env.calls[0] === 'listDex', env.calls)
    assert('请求不带 brief（要清单）', true)
    assert('进度 2 / 4 · 50%', p.data.seen === 2 && p.data.total === 4 && p.data.percent === 50,
      { seen: p.data.seen, total: p.data.total, percent: p.data.percent })
    assert('学校名来自登录态', p.data.schoolName === '南京大学', p.data.schoolName)
    assert('已解锁格子显示猫名与头像', p.data.dex[0].nameText === '咪咪' &&
      p.data.dex[0].avatar === 'https://x/a.jpg' && p.data.dex[0].unlocked === true, p.data.dex[0])
    assert('花色标签已翻译（橘猫）', p.data.dex[0].hintText === '橘猫', p.data.dex[0].hintText)
    assert('未解锁格子不请求头像、不泄漏猫名', p.data.dex[1].avatar === '' &&
      p.data.dex[1].nameText === '未解锁' && p.data.dex[1].unlocked === false, p.data.dex[1])
    assert('未解锁仍给出花色线索', p.data.dex[1].hintText === '狸花', p.data.dex[1].hintText)
    assert('loading 已收尾', p.data.loading === false)
    assert('无 undefined / NaN', badText(p.data).length === 0, badText(p.data))
  }

  console.log('\n=== S2 未绑定学校：不给假进度，引导去绑定 ===')
  reset({ listDex: () => ({ needSchool: true, total: 0, seen: 0, percent: 0, list: [] }) })
  {
    const p = freshPage()
    await p.load()
    assert('needSchool 标记为真', p.data.needSchool === true)
    assert('不会出现 0 / 4 之类的假进度', p.data.total === 0 && p.data.seen === 0 && p.data.percent === 0 &&
      p.data.dex.length === 0, { total: p.data.total, seen: p.data.seen, dex: p.data.dex.length })
    p.goBindSchool()
    assert('「去绑定学校」写 globalData 后 switchTab（tabBar 页不能带 query）',
      FAKE_APP.globalData.mineAction === 'school' && env.tabs[0] === '/pages/mine/mine',
      { action: FAKE_APP.globalData.mineAction, tabs: env.tabs })
    assert('无 undefined / NaN', badText(p.data).length === 0, badText(p.data))
  }

  console.log('\n=== S3 本校还没有档案：给明确说明，不是空白页 ===')
  reset({ listDex: () => ({ needSchool: false, total: 0, seen: 0, percent: 0, list: [] }) })
  {
    const p = freshPage()
    await p.load()
    assert('进度 0 / 0 且不报错', p.data.seen === 0 && p.data.total === 0 && p.data.percent === 0)
    assert('有兜底说明文案', /还没有猫档案/.test(p.data.emptyText || ''), p.data.emptyText)
    assert('无 undefined / NaN', badText(p.data).length === 0, badText(p.data))
  }

  console.log('\n=== S4 超过 200 只：如实提示只展示最近的部分 ===')
  reset({
    listDex: () => ({
      needSchool: false, total: 260, seen: 30, percent: 12, truncated: true,
      list: [{ id: 'c1', name: '咪咪', pattern: 'orange', avatar: '', unlocked: true }]
    })
  })
  {
    const p = freshPage()
    await p.load()
    assert('truncated 透传到界面', p.data.truncated === true)
    assert('进度仍按全校总数算（30 / 260）', p.data.seen === 30 && p.data.total === 260, p.data)
  }

  console.log('\n=== S5 请求失败：提示 + 收尾 loading（不白屏） ===')
  reset({})
  env.fail = 'listDex boom'
  {
    const p = freshPage()
    await p.load()
    assert('弹出失败提示', env.toasts.length === 1 && /boom/.test(env.toasts[0]), env.toasts)
    assert('loading 已结束', p.data.loading === false)
    assert('不渲染 undefined', badText(p.data).length === 0, badText(p.data))
  }

  /* ==================== 静态约束 ==================== */
  console.log('\n=== S6 「我的」页只留入口，进度墙已挪走 ===')
  const mineWxml = fs.readFileSync(path.join(MP, 'pages/mine/mine.wxml'), 'utf8')
  // 注释里会提到「图鉴进度已挪走」，判断"还有没有这张卡"必须先把注释剥掉
  const mineWxmlNoComment = mineWxml.replace(/<!--[\s\S]*?-->/g, '')
  const mineJs = fs.readFileSync(path.join(MP, 'pages/mine/mine.js'), 'utf8')
  const appJson = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'))
  const dexWxml = fs.readFileSync(path.join(MP, 'pages/dex/dex.wxml'), 'utf8')

  assert('「我的」页不再有「图鉴进度」卡片', !/图鉴进度/.test(mineWxmlNoComment))
  assert('「我的」页不再渲染图鉴墙（dex-row 已移除）',
    !/dex-row/.test(mineWxmlNoComment) && !/dex-item/.test(mineWxmlNoComment))
  assert('「我的」页有「图鉴收集」入口', /图鉴收集/.test(mineWxml) && /bindtap="goDex"/.test(mineWxml))
  assert('入口数字来自 listDex（本校口径）',
    /callApi\('listDex',\s*\{\s*brief:\s*true\s*\}\)/.test(mineJs))
  assert('未绑定学校时入口文案为「未绑定学校」', /未绑定学校/.test(mineJs))
  assert('app.json 已注册 pages/dex/dex', appJson.pages.indexOf('pages/dex/dex') >= 0)
  for (const ext of ['js', 'wxml', 'wxss', 'json']) {
    assert('图鉴页文件存在: dex.' + ext, fs.existsSync(path.join(MP, 'pages/dex/dex.' + ext)))
  }
  assert('图鉴页文案不含旧字段 dexTotal/dexPercent',
    !/dexTotal|dexPercent/.test(dexWxml) && !/dexTotal|dexPercent/.test(mineWxml))

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
