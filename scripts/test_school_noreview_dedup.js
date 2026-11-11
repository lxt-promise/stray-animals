/**
 * 行为级测试：推广期「选校免审」+ 学校去重（同一学校不同校区）。
 *
 * 背景（2026-10-30 用户反馈）：
 *   1. 推广阶段先暂时注掉绑定学校审核，用户选择后**立刻生效**切换绑定学校（后期可以再开）；
 *   2. 同一学校的不同校区（东南大学-九龙湖校区 / 四牌楼校区）要按不同 ID 区分，
 *      并且**不能建重**。
 *
 * 本测试锁住的是**意图**，不是实现细节：
 *   - 免审模式（默认）：普通用户选校立即绑定，不落待审、不等审核；
 *   - **建校是管理员专属**（2026-10-30 定稿）：普通用户传 name 一律 403，
 *     管理员建校「查重 → 建（或复用）→ 立即绑定」且**不看审核开关**；
 *   - 免审不等于放弃边界：隐藏校照样进不去，安全检测照样跑，权限照样服务端判定；
 *   - 去重键是「校名 + 校区」：不同校区 = 两所独立档案（各自 _id），
 *     同名同校区（含空格/大小写/「校区」后缀差异）= 同一所，绝不建第二份；
 *   - 开关可回退：`SCHOOL_REVIEW=on` 立刻回到「全部走审核」，不用改代码；
 *   - 存量清理：超管能补 schoolKey、能列出已经建重的学校。
 *
 * 运行：node scripts/test_school_noreview_dedup.js
 */
'use strict'
const Module = require('module')
const path = require('path')
const fs = require('fs')

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
 * 只桩掉 wx-server-sdk（core.js 的入口），index.js 与 lib/* 全部用真实源码跑。 */
let store = {}

const matchCond = (doc, cond) => {
  if (!cond) return true
  if (cond.__op === 'or') return (cond.v || []).some(sub => matchCond(doc, sub))
  return Object.keys(cond).every(k => {
    const cv = cond[k]
    if (cv && cv.__op === 'in') return (cv.v || []).indexOf(doc[k]) >= 0
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

/**
 * 按指定的 `SCHOOL_REVIEW` 重新加载云函数。
 * 开关是**模块加载时**求值的常量，所以每个模式必须拿一份新的模块实例，
 * 否则测出来的还是上一个模式（这正是不用 `||` 兜底的原因之一）。
 */
let main = null
function loadCF(mode) {
  if (mode === undefined || mode === null) delete process.env.SCHOOL_REVIEW
  else process.env.SCHOOL_REVIEW = String(mode)
  Object.keys(require.cache).forEach(k => { if (k.indexOf(CF) === 0) delete require.cache[k] })
  main = require(path.join(CF, 'index.js')).main
}

const cfSrc = fs.readFileSync(path.join(CF, 'index.js'), 'utf8')
const mineSrc = fs.readFileSync(path.join(MP, 'pages', 'mine', 'mine.js'), 'utf8')
const mineWxml = fs.readFileSync(path.join(MP, 'pages', 'mine', 'mine.wxml'), 'utf8')

/** 调用一个 action；失败时返回错误体（便于断言 code） */
const as = async (u, action, event) => {
  currentOpenid = u || ''
  const r = await main(Object.assign({ action }, event || {}))
  return r && r.ok === false ? r : (r && r.data)
}

function seed() {
  store = {
    users: [
      { _id: 'U_A', openid: 'u_admin', role: 'admin', schoolId: 'sch_a', nickName: '管理员' },
      { _id: 'U_S', openid: 'u_super', role: 'admin', schoolId: '', nickName: '超管' },
      { _id: 'U_U', openid: 'u_user', role: 'user', schoolId: 'sch_a', nickName: '普通用户' }
    ],
    // 注意：这些是「历史数据」，故意**不带** schoolKey —— 查重必须对老数据也生效
    schools: [
      { _id: 'sch_a', name: '南京大学', campus: '仙林校区' },
      { _id: 'sch_b', name: '东南大学', campus: '九龙湖校区' },
      { _id: 'sch_hidden', name: '测试校园', hidden: true }
    ],
    school_applies: []
  }
}
const user = id => (store.users || []).find(u => u.openid === id)
const schools = () => store.schools || []
const schoolNames = () => schools().map(s => s.name + '|' + (s.campus || ''))

async function run() {
  /* ==================== 1. 免审（默认）：选校立即绑定 ==================== */
  console.log('\n=== 1. 推广期默认免审：普通用户选校立即生效 ===')
  {
    loadCF(null)      // 不配 SCHOOL_REVIEW = 免审
    seed()
    const r = await as('u_user', 'applySchool', { schoolId: 'sch_b' })
    assert('返回 bound（已绑定）', r && r.status === 'bound', r)
    assert('用户 schoolId 已切换', user('u_user').schoolId === 'sch_b', user('u_user').schoolId)
    assert('没有产生待审申请', (store.school_applies || []).length === 0, store.school_applies)
    assert('免审模式下理由不是必填（没传 reason 也成功）', r && r.ok === true)
  }

  /* ==================== 2. 免审：隐藏校仍然进不去 ==================== */
  console.log('\n=== 2. 免审不等于放弃边界：隐藏校照样进不去 ===')
  {
    seed()
    const r = await as('u_user', 'applySchool', { schoolId: 'sch_hidden' })
    assert('普通用户绑隐藏校被拒（403）', r && r.ok === false && r.code === 403, r)
    assert('用户没有被绑进去', user('u_user').schoolId === 'sch_a')
  }

  /* ==================== 3. 建校：管理员立即生效，普通用户 403 ==================== */
  console.log('\n=== 3. 建校是管理员专属：管理员建完即绑定，普通用户 403 ===')
  {
    seed()
    const before = schools().length
    const denied = await as('u_user', 'applySchool', { name: '南京林业大学', campus: '新庄校区', city: '南京' })
    assert('普通用户建校被拒（403）', denied && denied.ok === false && denied.code === 403, denied)
    assert('被拒时没有建出学校', schools().length === before, schoolNames())

    const r = await as('u_admin', 'applySchool', { name: '南京林业大学', campus: '新庄校区', city: '南京' })
    assert('管理员建校返回 bound', r && r.status === 'bound', r)
    assert('学校数 +1', schools().length === before + 1, schools().length)
    assert('管理员已绑到新校', user('u_admin').schoolId === r.schoolId)
    const created = schools().find(s => s._id === r.schoolId)
    assert('新校落了去重键 schoolKey', !!created.schoolKey, created)
    assert('新校默认可见（建出来就得能选到）', created.hidden === false)
  }

  /* ==================== 4. 去重：同名同校区不建第二份 ==================== */
  console.log('\n=== 4. 去重：同名同校区已存在 → 复用，不建副本 ===')
  {
    seed()
    const before = schools().length
    const r = await as('u_admin', 'applySchool', { name: '东南大学', campus: '九龙湖校区' })
    assert('复用已有学校（reused）', r && r.reused === true, r)
    assert('学校数不变', schools().length === before, schools().length)
    assert('绑到已有的那所', r.schoolId === 'sch_b' && user('u_admin').schoolId === 'sch_b')
  }

  /* ==================== 5. 去重：老数据没有 schoolKey 也能查出来 ==================== */
  console.log('\n=== 5. 历史学校没 schoolKey 时查重依然生效 ===')
  {
    seed()
    // sch_a / sch_b 都没有 schoolKey，走的是全量比对分支
    const r = await as('u_admin', 'applySchool', { name: '南京大学', campus: '仙林校区' })
    assert('命中老学校 sch_a', r && r.schoolId === 'sch_a', r)
    assert('学校数仍为 3', schools().length === 3, schoolNames())
  }

  /* ==================== 6. 不同校区 = 两所独立档案 ==================== */
  console.log('\n=== 6. 同一学校不同校区：各自独立 _id，互不干扰 ===')
  {
    seed()
    const r = await as('u_admin', 'applySchool', { name: '东南大学', campus: '四牌楼校区', city: '南京' })
    assert('四牌楼校区被建出来（不被九龙湖判重）', r && r.reused !== true && r.schoolId, r)
    assert('与九龙湖校区是不同的 _id', r.schoolId !== 'sch_b', r.schoolId)
    assert('学校数 +1（现在 4 所）', schools().length === 4, schoolNames())
    assert('管理员绑到四牌楼', user('u_admin').schoolId === r.schoolId)
  }

  /* ==================== 7. 归一：空格 / 大小写 / 「校区」后缀 ==================== */
  console.log('\n=== 7. 写法差异不算两所学校（空格/大小写/校区后缀） ===')
  {
    seed()
    const r1 = await as('u_admin', 'applySchool', { name: '  东南大学 ', campus: '九龙湖' })
    assert('「九龙湖」≈「九龙湖校区」→ 复用', r1 && r1.reused === true && r1.schoolId === 'sch_b', r1)

    seed()
    const r2 = await as('u_admin', 'applySchool', { name: '东南大学', campus: '九龙湖校区（主）' })
    assert('括号后缀不同 → 视为新校区', r2 && r2.reused !== true, r2 && r2.schoolId)
  }

  /* ==================== 8. 审核模式：开关改回 on 即恢复 ==================== */
  console.log('\n=== 8. SCHOOL_REVIEW=on 立刻恢复审核（不用改代码） ===')
  {
    loadCF('on')
    seed()
    const r = await as('u_user', 'applySchool', { schoolId: 'sch_b', reason: '我是本校学生' })
    assert('落的是待审申请而不是绑定', r && r.status === 'submitted', r)
    assert('用户绑定没变', user('u_user').schoolId === 'sch_a')
    assert('school_applies 多了一条 pending',
      (store.school_applies || []).filter(a => a.status === 'pending').length === 1, store.school_applies)

    seed()
    const r2 = await as('u_user', 'applySchool', { schoolId: 'sch_b' })
    assert('审核模式下理由必填（400）', r2 && r2.ok === false && r2.code === 400, r2)

    seed()
    const r3 = await as('u_user', 'applySchool', { name: '南京林业大学', campus: '新庄校区', reason: '本校有猫' })
    assert('审核模式下普通用户仍然建不了校（403）', r3 && r3.ok === false && r3.code === 403, r3)
    assert('没有提前建校', schools().length === 3, schoolNames())

    // 管理员建校**不看审核开关**：他本就是数据维护者，排队审自己的申请没有意义
    seed()
    const r4 = await as('u_admin', 'applySchool', { name: '南京林业大学', campus: '新庄校区' })
    assert('审核模式下管理员建校仍然立即生效', r4 && r4.status === 'bound', r4)
    assert('没落任何待审申请', (store.school_applies || []).length === 0, store.school_applies)
  }

  /* ==================== 9. 只放开绑定（bind 模式） ==================== */
  console.log('\n=== 9. SCHOOL_REVIEW=bind：绑定免审、建校仅管理员（且管理员免审） ===')
  {
    loadCF('bind')
    seed()
    const r1 = await as('u_user', 'applySchool', { schoolId: 'sch_b' })
    assert('绑定立即生效', r1 && r1.status === 'bound', r1)

    seed()
    const r2 = await as('u_user', 'applySchool', { name: '南京林业大学', campus: '新庄校区', reason: '本校有猫' })
    assert('普通用户建校被拒（403，不是走审核）', r2 && r2.ok === false && r2.code === 403, r2)
    assert('建校被拒时不建校', schools().length === 3, schoolNames())

    seed()
    const r3 = await as('u_admin', 'applySchool', { name: '南京林业大学', campus: '新庄校区' })
    assert('管理员建校立即生效（与开关无关）', r3 && r3.status === 'bound', r3)
    assert('学校数 +1', schools().length === 4, schoolNames())
  }

  /* ==================== 10. policy 下发给前端 ==================== */
  console.log('\n=== 10. mySchoolApply 下发审核开关（前端只用它渲染界面） ===')
  {
    loadCF(null)
    seed()
    const r1 = await as('u_user', 'mySchoolApply', {})
    assert('免审模式：reviewBind=false', r1 && r1.policy && r1.policy.reviewBind === false, r1 && r1.policy)
    assert('免审模式：reviewCreate=false', r1 && r1.policy && r1.policy.reviewCreate === false)
    assert('回传模式名', r1 && r1.policy && r1.policy.mode === 'off', r1 && r1.policy)
    // 建校权限与「免不免审」是两件事：免审也不等于人人能建校
    assert('普通用户 canCreate=false（建校是管理员专属）',
      r1 && r1.policy && r1.policy.canCreate === false, r1 && r1.policy)
    const rAdmin = await as('u_admin', 'mySchoolApply', {})
    assert('管理员 canCreate=true', rAdmin && rAdmin.policy && rAdmin.policy.canCreate === true,
      rAdmin && rAdmin.policy)
    const rSuper = await as('u_super', 'mySchoolApply', {})
    assert('超管 canCreate=true', rSuper && rSuper.policy && rSuper.policy.canCreate === true,
      rSuper && rSuper.policy)

    loadCF('on')
    seed()
    const r2 = await as('u_user', 'mySchoolApply', {})
    assert('审核模式：reviewBind=true', r2 && r2.policy && r2.policy.reviewBind === true, r2 && r2.policy)
    assert('审核模式：reviewCreate=true', r2 && r2.policy && r2.policy.reviewCreate === true)
    assert('审核模式下普通用户依然 canCreate=false', r2 && r2.policy && r2.policy.canCreate === false)
  }

  /* ==================== 11. 超管后台建校也查重 ==================== */
  console.log('\n=== 11. 超管后台建校：建重直接 409 ===')
  {
    loadCF(null)
    seed()
    const r1 = await as('u_super', 'createSchool', { name: '东南大学', campus: '九龙湖校区' })
    assert('同名同校区被拒（409）', r1 && r1.ok === false && r1.code === 409, r1)
    assert('没有建出副本', schools().length === 3, schoolNames())

    const r2 = await as('u_super', 'createSchool', { name: '东南大学', campus: '四牌楼校区' })
    assert('不同校区可以建', r2 && r2.ok !== false && r2._id, r2)
    assert('超管建校也带 schoolKey', !!schools().find(s => s._id === r2._id).schoolKey)
  }

  /* ==================== 12. 改名撞车 & 同步去重键 ==================== */
  console.log('\n=== 12. 改校名/校区时同步去重键，撞车则拒绝 ===')
  {
    loadCF(null)
    seed()
    const r1 = await as('u_super', 'updateSchool', { schoolId: 'sch_a', name: '东南大学', campus: '九龙湖校区' })
    assert('改名撞上已有学校 → 409', r1 && r1.ok === false && r1.code === 409, r1)

    const r2 = await as('u_super', 'updateSchool', { schoolId: 'sch_a', name: '南京大学', campus: '鼓楼校区' })
    assert('改成不冲突的名字成功', r2 && r2.ok !== false, r2)
    const updated = schools().find(s => s._id === 'sch_a')
    assert('schoolKey 已跟着改名同步', updated.schoolKey === '南京大学|鼓楼', updated.schoolKey)
  }

  /* ==================== 13. 存量治理：补 key + 列出重复 ==================== */
  console.log('\n=== 13. 存量治理：backfillSchoolKeys / findDuplicateSchools ===')
  {
    loadCF(null)
    seed()
    // 造一份历史重复数据：同名同校区两所
    store.schools.push({ _id: 'sch_dup', name: '东南大学', campus: '九龙湖校区' })
    const rb = await as('u_super', 'backfillSchoolKeys', {})
    assert('补齐了历史学校的 schoolKey', rb && rb.updated >= 3, rb)
    assert('老学校现在都带 key', schools().every(s => !!s.schoolKey), schools().map(s => s.schoolKey))

    const rd = await as('u_super', 'findDuplicateSchools', {})
    assert('查出一组建重', Array.isArray(rd) && rd.length === 1, rd)
    assert('重复组包含 2 所', rd[0] && rd[0].count === 2, rd[0] && rd[0].count)
    assert('重复组给出两所的 _id',
      rd[0] && rd[0].schools.map(x => x._id).sort().join(',') === 'sch_b,sch_dup',
      rd[0] && rd[0].schools.map(x => x._id))

    const rn = await as('u_user', 'findDuplicateSchools', {})
    assert('普通用户调不通治理接口（403）', rn && rn.ok === false && rn.code === 403, rn)
  }

  /* ==================== 14. 前端接线 ==================== */
  console.log('\n=== 14. 前端按 policy 走免审（不是写死免审） ===')
  {
    assert('data 里有 schoolPolicy', /schoolPolicy:\s*\{/.test(mineSrc))
    assert('选校按 policy 分流', /schoolPolicy\.reviewBind/.test(mineSrc))
    assert('免审时给「立即生效」预期文案', /选择后立即生效/.test(mineSrc))
    assert('建校理由框只在审核模式出现',
      /wx:if="\{\{schoolPolicy\.reviewCreate\}\}"/.test(mineWxml))
    assert('建校入口按 canCreate 权限显示（非管理员改文案）',
      /schoolPolicy\.canCreate/.test(mineWxml))
    assert('非管理员点建校入口 / 提交时被挡并说明原因',
      /仅管理员可创建学校/.test(mineSrc))
    assert('拿到非 bound 时不会误报成功',
      /r\.status !== 'bound'/.test(mineSrc))
    assert('绑定收尾统一走 afterSchoolBound', /afterSchoolBound\(/.test(mineSrc))
  }

  /* ==================== 15. 开关判定收在服务端 ==================== */
  console.log('\n=== 15. 开关只读服务端环境变量（前端传什么都没用） ===')
  {
    assert('读的是 process.env.SCHOOL_REVIEW', /process\.env\.SCHOOL_REVIEW/.test(cfSrc))
    assert('显式判空而不是 || 兜底',
      /SCHOOL_REVIEW_ENV !== undefined && SCHOOL_REVIEW_ENV !== null/.test(cfSrc))
    assert('createSchoolDirect 先查重再建', /findSameSchool\(name, campus\)/.test(cfSrc))
    assert('兜底全量比对兼容老数据', /schoolKey \|\| schoolKeyOf\(s\.name, s\.campus\)/.test(cfSrc))
  }

  console.log('\n============================')
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  if (fail) { console.log('失败项：' + failures.join(' / ')); process.exit(1) }
}

run().catch(e => { console.error(e); process.exit(1) })
