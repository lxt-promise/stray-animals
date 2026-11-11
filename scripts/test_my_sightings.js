/**
 * 新页面行为级测试：pages/my-sightings（我的打卡）与 pages/rules（规则说明）
 *
 * 背景：原本「我的打卡」与「规则说明」都是在「我的」页里菜单项点击就地展开。
 * 按需求拆成两个独立页面，菜单项点击 → navigateTo。
 * 这里验证：
 *  - my-sightings：load() 从 listSightings(mine) 拉数据并渲染（timeText / 计数 / 缩略图），
 *    列表请求失败仍走外层 catch 弹 toast（保留「不再静默吞错」），loading 收尾；
 *  - rules：data.rules 直接来自 const.RULES（与等级页共用一份）。
 *
 * 运行：node scripts/test_my_sightings.js
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
const env = {
  calls: [], toasts: [], navs: [],
  failActions: [], replies: {}
}
const HOUR = 3600000
const FAKE_APP = {
  globalData: {
    ready: true,
    user: { _id: 'u1', nickName: '测试用户', sightingCount: 7, schoolId: 's1' }
  },
  isMember: () => true, isAdmin: () => false, isSuper: () => false,
  setSchool() {},
  ensureReady: async () => {},
  callApi(action, data) {
    env.calls.push(action)
    if (env.failActions.indexOf(action) >= 0) return Promise.reject(new Error(action + ' failed'))
    const r = env.replies[action]
    return Promise.resolve(typeof r === 'function' ? r(data) : (r === undefined ? {} : r))
  }
}
global.getApp = () => FAKE_APP
global.wx = {
  showToast: o => env.toasts.push((o && o.title) || ''),
  showLoading: () => {}, hideLoading: () => {},
  navigateTo: o => env.navs.push(o.url),
  stopPullDownRefresh: () => {},
  cloud: { callFunction: async () => ({ result: {} }), getTempFileURL: async () => ({ fileList: [] }) }
}
let captured = null
global.Page = opts => { captured = opts }
global.App = () => {}
global.Component = () => {}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request && /\.wxml$|\.wxss$|\.json$/.test(request)) return {}
  return origLoad.apply(this, arguments)
}

require(path.join(MP, 'pages/my-sightings/my-sightings.js'))
const RULES_PAGE = captured
assert('my-sightings.js 成功注册 Page', !!RULES_PAGE)
require(path.join(MP, 'pages/rules/rules.js'))
const RULES_PAGE_OPTS = captured
assert('rules.js 成功注册 Page', !!RULES_PAGE_OPTS)

function freshMySightings() {
  return Object.assign({}, RULES_PAGE, {
    data: JSON.parse(JSON.stringify(RULES_PAGE.data)),
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
  env.calls = []; env.toasts = []; env.navs = []
  env.failActions = o.failActions || []
  env.replies = {
    listSightings: () => ({
      list: [{
        _id: 'sg1',
        createdAt: new Date(Date.now() - 2 * HOUR).toISOString(),
        catId: 'c1', cat: { _id: 'c1', name: '小橘' },
        feedStatus: 'fed',
        photos: ['cloud://env.bucket/cats/sg1.jpg']
      }]
    })
  }
}

async function main() {
  /* ==================== my-sightings ==================== */
  console.log('\n--- A. my-sightings 加载与渲染 ---')
  reset()
  {
    const p = freshMySightings()
    await p.load()
    assert('从 listSightings(mine) 拉到记录', p.data.list.length === 1, p.data.list.length)
    assert('每条记录带 timeText', !!p.data.list[0].timeText, p.data.list[0])
    assert('计数来自 user.sightingCount（7）', p.data.count === 7, p.data.count)
    assert('打卡照片映射出展示地址', Array.isArray(p.data.list[0].photosSmall) && p.data.list[0].photosSmall.length === 1, p.data.list[0].photosSmall)
    assert('loading 收尾', p.data.loading === false)
    assert('成功路径不弹 toast', env.toasts.length === 0, env.toasts)
  }

  console.log('\n--- B. my-sightings 列表失败仍弹 toast ---')
  reset({ failActions: ['listSightings'] })
  {
    const p = freshMySightings()
    await p.load()
    assert('弹 toast 且带原因', env.toasts.length === 1 && /listSightings/.test(env.toasts[0]), env.toasts)
    assert('loading 仍然收尾', p.data.loading === false)
    assert('失败列表为空', p.data.list.length === 0, p.data.list.length)
  }

  console.log('\n--- C. my-sightings 点击猫名跳详情 ---')
  {
    const p = freshMySightings()
    p.goCat({ currentTarget: { dataset: { id: 'c1' } } })
    assert('navigateTo 到 cat-detail', env.navs.indexOf('/pages/cat-detail/cat-detail?id=c1') >= 0, env.navs)
  }

  /* ==================== rules ==================== */
  console.log('\n--- D. rules 文案来自 const.RULES ---')
  {
    const constMod = require(path.join(MP, 'utils/const.js'))
    assert('data.rules 等于 const.RULES', RULES_PAGE_OPTS.data.rules === constMod.RULES, RULES_PAGE_OPTS.data.rules)
    assert('共 3 个规则块', RULES_PAGE_OPTS.data.rules.length === 3, RULES_PAGE_OPTS.data.rules.length)
    assert('首块标题含猫粮', /猫粮/.test(RULES_PAGE_OPTS.data.rules[0].title), RULES_PAGE_OPTS.data.rules[0].title)
  }

  console.log('\n===== test_my_sightings: ' + pass + ' 通过 / ' + fail + ' 失败 =====')
  if (fail) {
    console.log('失败项：')
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
