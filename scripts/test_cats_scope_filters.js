/**
 * 猫谱「按校可见」+「筛选诊断」行为级测试
 *
 * 用户反馈（2026-10-25）：
 *  1. 没绑定学校的用户能查看**所有**猫咪档案 —— 不合理，应该什么都看不到。
 *     根因：listCats 的 where 在没有 schoolId 时是空对象 → 查询退化成全环境扫描。
 *  2. 猫谱筛选部分失效，例如选「橘猫」显示没查到。
 *     可能原因有四种，界面上长得一模一样（空列表），必须靠数据区分：
 *       ① 档案没写 pattern（建档没动花色选择器 → 默认 other）
 *       ② 写的是值域外的值（AI 回传 / 历史脏数据）
 *       ③ 查询本身报错（where + orderBy 缺复合索引）
 *       ④ 真的没有这个花色的猫
 *     所以加了 diagnoseCatFilters 把分布 / 脏值 / 探针报错全摊开。
 *
 * 断言打在**意图**上，不打实现细节。
 * 运行：node scripts/test_cats_scope_filters.js
 */
const path = require('path')
const Module = require('module')
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

/* ==================== 云环境桩 ====================
 * 只桩掉 wx-server-sdk（core.js 的入口），index.js 与 lib/* 全部用真实源码跑。 */
const SCHOOL_A = 'sch_a'
const SCHOOL_B = 'sch_b'

/** 内存库：{ 集合名: [doc] } */
let store = {}
/** 让某条查询抛错，用来模拟「缺索引导致 where+orderBy 直接失败」 */
let CATS_ORDER_ERROR = null

// getMe 用的是 _.or([{openid}, {_openid}])，桩必须支持 or，否则一律「请先登录」
const matchCond = (doc, cond) => {
  if (cond && cond.__op === 'or') return (cond.v || []).some(sub => matchCond(doc, sub))
  return Object.keys(cond).every(k => doc[k] === cond[k])
}

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
      if (col === 'cats' && q._order && CATS_ORDER_ERROR) throw new Error(CATS_ORDER_ERROR)
      let rows = list().filter(d => q._filters.every(f => matchCond(d, f)))
      if (q._order) {
        const { f, d } = q._order
        rows = rows.slice().sort((a, b) => (d === 'desc' ? (b[f] > a[f] ? 1 : -1) : (a[f] > b[f] ? 1 : -1)))
      }
      rows = rows.slice(q._skip, q._skip + q._limit)
      if (q._field) {
        rows = rows.map(d => {
          const o = { _id: d._id }
          Object.keys(q._field).forEach(k => { if (q._field[k] && k !== '_id') o[k] = d[k] })
          return o
        })
      }
      return { data: JSON.parse(JSON.stringify(rows)) }
    },
    async count() { return { total: list().filter(d => q._filters.every(f => matchCond(d, f))).length } }
  }
  return q
}

const op = (name, v) => ({ __op: name, v })
const fakeDb = {
  collection: name => makeQuery(name),
  serverDate: () => new Date(),
  // core.js 在模块加载时就取 db.command（_.or / _.in / _.neq …），缺了会
  // 在运行时报「Cannot read properties of undefined (reading 'or')」
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
    return {
      fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://x/' + encodeURIComponent(f), status: 0 }))
    }
  }
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return fakeCloud
  return origLoad.apply(this, arguments)
}

process.env.SUPER_ADMIN_OPENIDS = process.env.SUPER_ADMIN_OPENIDS || 'u_admin'
const { main } = require(path.join(CF, 'index.js'))
const catsSrc = require('fs').readFileSync(path.join(ROOT, 'miniprogram', 'pages', 'cats', 'cats.js'), 'utf8')
const wxmlSrc = require('fs').readFileSync(path.join(ROOT, 'miniprogram', 'pages', 'cats', 'cats.wxml'), 'utf8')
const cfSrc = require('fs').readFileSync(path.join(CF, 'index.js'), 'utf8')

/** 调用一个 action；ok 时返回业务数据，失败时返回错误体（便于断言 msg/code） */
const as = async (u, action, event) => {
  currentOpenid = u || ''
  const r = await main(Object.assign({ action }, event || {}))
  return r && r.ok === false ? r : (r && r.data)
}

/* ==================== 素材 ==================== */
const cat = (id, schoolId, extra) => Object.assign({
  _id: id, name: '猫-' + id, schoolId, status: 'campus', sterilized: 'unknown',
  pattern: 'other', photos: [], avatar: '', updatedAt: new Date(2026, 9, 1)
}, extra || {})

async function seed() {
  store = {
    cats: [
      cat('a1', SCHOOL_A, { name: '大橘', pattern: 'orange', updatedAt: new Date(2026, 9, 20) }),
      cat('a2', SCHOOL_A, { name: '狸花', pattern: 'tabby', updatedAt: new Date(2026, 9, 19) }),
      cat('a3', SCHOOL_A, { name: '奶牛', pattern: 'cow' }),
      // 建档时花色选择器没动过 → 落默认 other，筛选永远选不中它
      cat('a6', SCHOOL_A, { name: '未标注', pattern: 'other' }),
      cat('b1', SCHOOL_B, { name: '他校猫', pattern: 'orange' })
    ],
    users: [
      { _id: 'u_bound', openid: 'u_bound', schoolId: SCHOOL_A, role: 'visitor', nickName: 'n' },
      { _id: 'u_free', openid: 'u_free', schoolId: '', role: 'visitor', nickName: 'n' },
      { _id: 'u_admin', openid: 'u_admin', schoolId: '', role: 'admin', nickName: 'admin' }
    ],
    schools: [{ _id: SCHOOL_A, name: '东南大学' }, { _id: SCHOOL_B, name: '隔壁大学' }]
  }
  CATS_ORDER_ERROR = null
}

async function run() {
  await seed()

  /* ==================== A. 未绑定学校不该看到任何档案 ==================== */
  console.log('\n--- A. 未绑定学校：什么都看不到 ---')

  // A1：核心回归 —— 旧行为是 where 为空 → 返回全环境 4 只猫（含他校）
  let r = await as('u_free', 'listCats', {})
  assert('A1 未绑定学校时不返回任何猫档案', (r.list || []).length === 0, r.list)
  assert('A1 回 needSchool 让前端能明确提示', r.needSchool === true, r)
  assert('A1 hasMore 必须为 false（否则前端会一直上拉）', r.hasMore === false, r)

  // A2：已绑定学校的用户只看本校
  r = await as('u_bound', 'listCats', {})
  assert('A2 已绑定学校时只返回本校的猫', (r.list || []).length === 4, (r.list || []).map(c => c.name))
  assert('A2 不含他校的猫', !(r.list || []).some(c => c._id === 'b1'), r.list)

  // A3：越权防范仍在 —— 手传别校 id 不能绕过（AppError 由统一入口转成错误体）
  r = await as('u_bound', 'listCats', { schoolId: SCHOOL_B })
  assert('A3 手传他校 schoolId 仍被拒',
    r && r.ok === false && /其他学校/.test(r.msg || ''), r)

  // A4：超管显式传学校仍能查（后台管理不能被这条规则卡死）
  r = await as('u_admin', 'listCats', { schoolId: SCHOOL_A })
  assert('A4 超管显式传 schoolId 仍可查询', (r.list || []).length === 4, r.list)

  // A5：源码层面不留「where 为空」的口子
  assert('A5 listCats 的 where 必带 schoolId（不再有空查询兜底）',
    /const where = \{ schoolId \}/.test(cfSrc) &&
    /if \(!schoolId\) return \{ needSchool: true/.test(cfSrc))

  /* ==================== B. 前端空态 ==================== */
  console.log('\n--- B. 前端：未绑定学校的空态 ---')
  assert('B1 前端读 needSchool 并进入空态', /res\.needSchool/.test(catsSrc) && /needSchool: true/.test(catsSrc))
  assert('B2 空态给出「去绑定学校」入口', /goBindSchool/.test(catsSrc) && /goBindSchool/.test(wxmlSrc))
  assert('B3 空态文案说明是按校划分（不是「本校没有猫」）',
    /猫谱按学校划分/.test(wxmlSrc), (wxmlSrc.match(/还没有绑定[\s\S]{0,80}/) || [''])[0])
  assert('B4 未绑校时不渲染列表（避免空列表被误读）',
    /wx:if="\{\{needSchool\}\}"/.test(wxmlSrc) && /wx:else/.test(wxmlSrc))

  /* ==================== C. 筛选诊断接口 ==================== */
  console.log('\n--- C. diagnoseCatFilters ---')

  // C1：正常分布
  r = await as('u_admin', 'diagnoseCatFilters', { schoolId: SCHOOL_A })
  assert('C1 返回本校猫总数', r.cats === 4, r)
  assert('C1 按花色给出分布', r.byPattern && r.byPattern.orange === 1 && r.byPattern.tabby === 1, r.byPattern)
  assert('C1 同时给状态/绝育分布（筛选失效时一并排查）',
    r.byStatus && r.bySterilized && Object.keys(r.bySterilized).length > 0, r)
  assert('C1 探针实跑了一个真实花色', r.probe && r.probe.value, r.probe)
  assert('C1 探针命中数与分布一致', r.probe && r.probe.count === 1, r.probe)
  assert('C1 正常时无脏值', r.dirtyPatternCount === 0, r)

  // C1b：未标注花色（pattern=other）单独列出 —— 「选橘猫查不到」最常见的真相
  //      是橘猫被存成了 other，它在值域内、不算脏值，但等于没标
  assert('C1b 未标注花色的猫单独列出', r.otherPatternCount === 1 && r.otherPattern[0].name === '未标注', r.otherPattern)

  // C2：脏值识别 —— 这是「选橘猫查不到」最常见的原因
  store.cats.push(cat('a4', SCHOOL_A, { name: '脏值猫', pattern: '橘猫' }))
  store.cats.push(cat('a5', SCHOOL_A, { name: '空花色', pattern: '' }))
  r = await as('u_admin', 'diagnoseCatFilters', { schoolId: SCHOOL_A })
  assert('C2 值域外的花色被识别为脏值', r.dirtyPatternCount === 2, r.dirtyPatternCount)
  assert('C2 脏值带出猫名方便定位',
    (r.dirtyPattern || []).some(d => d.name === '脏值猫'), r.dirtyPattern)
  assert('C2 脏值不会混进可选花色（分布里单独成项）',
    r.byPattern && r.byPattern['橘猫'] === 1 && r.byPattern['(空)'] === 1, r.byPattern)

  // C3：查询报错（缺索引）必须显性 —— 否则只会看到「查不到」
  CATS_ORDER_ERROR = 'The query is not supported by any index'
  r = await as('u_admin', 'diagnoseCatFilters', { schoolId: SCHOOL_A })
  assert('C3 带排序查询失败时如实报错', r.probe && /index/.test(r.probe.error), r.probe)
  assert('C3 同时给出不带排序的对照结果（判断是否缺复合索引）',
    r.probe && r.probe.countNoOrder === 1, r.probe)
  CATS_ORDER_ERROR = null

  // C4：未绑定学校时诊断也给结论，不能抛错也不能泄漏别校分布
  r = await as('u_admin', 'diagnoseCatFilters', {})
  assert('C4 未绑定学校时返回 needSchool 而不是报错', r.needSchool === true, r)
  assert('C4 未绑定学校时不返回任何分布（避免跨校泄漏）', !r.byPattern, r)

  // C5：他校数据不能污染诊断
  r = await as('u_admin', 'diagnoseCatFilters', { schoolId: SCHOOL_A })
  assert('C5 诊断只统计本校（不含他校的橘猫）',
    r.byPattern.orange === 1 && r.cats === 6, { by: r.byPattern, cats: r.cats })

  /* ==================== D. 真实筛选链路仍可用 ==================== */
  console.log('\n--- D. 筛选本身 ---')
  r = await as('u_bound', 'listCats', { pattern: 'orange' })
  assert('D1 按花色筛选能命中', (r.list || []).length === 1 && r.list[0].name === '大橘', r.list)
  r = await as('u_bound', 'listCats', { pattern: 'siamese' })
  assert('D2 没有该花色时返回空列表（真·没有，不是报错）', (r.list || []).length === 0, r.list)

  /* ==================== E. 空结果要能自解释 ====================
   * 现场：选「橘猫」查不到，实测库里 byPattern 根本没有 orange（真·没有），
   * 但界面只说「没有符合条件的猫咪」，用户只能当成功能坏了。 */
  console.log('\n--- E. 空结果自解释 ---')
  assert('E1 空态回显当前筛选条件', /filterDesc/.test(catsSrc) && /filterDesc/.test(wxmlSrc))
  assert('E2 筛选条件翻译成中文标签（不是原始 value）',
    /labelOf\(C\.PATTERN/.test(catsSrc) && /labelOf\(C\.CAT_STATUS/.test(catsSrc))
  assert('E3 关键词也计入筛选回显', /关键词/.test(catsSrc), (catsSrc.match(/关键词[\s\S]{0,40}/) || [''])[0])
  assert('E4 有筛选时才显示「清除筛选条件」',
    /wx:if="\{\{hasFilter\}\}"/.test(wxmlSrc) && /clearFilters/.test(wxmlSrc))
  assert('E5 清除筛选要同时清掉搜索词（否则清空后又跳回结果）',
    /clearFilters[\s\S]{0,200}?keyword: ''/.test(catsSrc),
    (catsSrc.match(/clearFilters\(\)[\s\S]{0,220}/) || [''])[0])
  assert('E6 无筛选时的空态换成「本校还没有档案」（不是「不符合条件」）',
    /本校还没有猫咪档案/.test(wxmlSrc))

  /* ==================== 汇总 ==================== */
  console.log('\n============================')
  console.log('通过 ' + pass + ' / 失败 ' + fail)
  if (fail) { console.log('失败项：'); failures.forEach(f => console.log('  - ' + f)); process.exit(1) }
  console.log('全部通过 ✅')
}

run().catch(e => { console.error(e); process.exit(1) })
