/**
 * 地图点位「最近打卡」行为级测试
 *
 * 背景（用户反馈）：地图里「附近猫咪」有问题，**最近几个目击没有显示在地图上**。
 *
 * 本文件先**复现**三个缺陷，再断言修好后的行为。断言打在意图上：
 *   A. 最新打卡落在校园范围外时，猫不能整只消失（应回退档案常驻位置）
 *   B. 学校没存显式 bounds 时，不能用一个「视野大小」的小框去杀点位
 *   C. 打卡表查询失败（缺索引 / 超时）必须**可见**，不能静默降级
 *
 * 运行：node scripts/test_map_sighting_points.js
 */
const fs = require('fs')
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
 * 只桩掉 ./core（云 SDK 入口），lib/map.js 本体用真实源码跑。 */
const SCHOOL = 'sch_1'
/** 打卡表：可控让它抛错，用来模拟「缺索引导致查询失败」 */
let SIGHTINGS = []
let SIGHTINGS_ERROR = null        // 整表查询都失败
let SIGHTINGS_ORDER_ERROR = null  // 仅「带 orderBy」的查询失败（缺索引的典型表现）
let CATS = []
let SCHOOLS = [{ _id: SCHOOL, name: '东南大学' }]

const CORE = {
  cloud: {
    getTempFileURL: async ({ fileList }) => ({
      fileList: (fileList || []).map(f => ({ fileID: f, tempFileURL: 'https://x/' + encodeURIComponent(f), status: 0 }))
    })
  },
  db: {
    collection(name) {
      const q = {
        _w: null, _order: null, _limit: 1000,
        where(w) { q._w = w; return q },
        field() { return q },
        orderBy(f, o) { q._order = { f, o }; return q },
        limit(n) { q._limit = n; return q },
        doc(id) {
          return {
            async get() {
              if (name === 'schools') {
                const s = SCHOOLS.find(x => x._id === id)
                return { data: s || null }
              }
              return { data: null }
            }
          }
        },
        async get() {
          if (name === 'sightings') {
            if (q._order && SIGHTINGS_ORDER_ERROR) throw new Error(SIGHTINGS_ORDER_ERROR)
            if (SIGHTINGS_ERROR) throw new Error(SIGHTINGS_ERROR)
            return { data: applyQuery(SIGHTINGS.slice(), q) }
          }
          if (name === 'cats') return { data: applyQuery(CATS.slice(), q) }
          return { data: [] }
        }
      }
      return q
    }
  },
  _: {
    neq: v => ({ __op: 'neq', v }),
    nin: v => ({ __op: 'nin', v }),
    push: v => ({ __op: 'push', v }),
    inc: v => ({ __op: 'inc', v }),
    gt: v => ({ __op: 'gt', v })
  },
  COL: { cat: 'cats', sighting: 'sightings', school: 'schools', user: 'users' },
  isMember: u => !!(u && u.role === 'member'),
  blurLocation: loc => Object.assign({}, loc, { blurred: true }),
  needBlur: () => false
}

function applyQuery(docs, q) {
  let out = docs
  if (q._w) {
    out = out.filter(d => Object.keys(q._w).every(k => {
      const cond = q._w[k]
      const got = d[k]
      if (cond && cond.__op === 'neq') return !(got === null || got === undefined)
      return got === cond
    }))
  }
  if (q._order) {
    const { f, o } = q._order
    out = out.slice().sort((a, b) => {
      const va = a[f] instanceof Date ? a[f].getTime() : a[f]
      const vb = b[f] instanceof Date ? b[f].getTime() : b[f]
      if (va === vb) return 0
      return (o === 'desc' ? (va > vb ? -1 : 1) : (va < vb ? -1 : 1))
    })
  }
  return out.slice(0, q._limit)
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === './core') return CORE
  if (request === '../lib/core') return CORE
  return origLoad.apply(this, arguments)
}

const maplib = require(path.join(CF, 'lib', 'map.js'))
const cfSrc = fs.readFileSync(path.join(CF, 'index.js'), 'utf8')
const mpSrc = fs.readFileSync(path.join(ROOT, 'miniprogram', 'pages', 'map', 'map.js'), 'utf8')

/* ==================== 素材 ====================
 * 东南大学四牌楼附近。校园范围取 ±0.006°（≈±660m）。 */
const C = { lat: 32.0585, lng: 118.7965 }
// 云端/前端同一公式：scale 16 → half = 0.048 / 2^(16-12) = 0.003
const HALF = 0.003
const BOUNDS = {
  sw: { lat: C.lat - HALF, lng: C.lng - HALF },
  ne: { lat: C.lat + HALF, lng: C.lng + HALF }
}
const OUTSIDE = { lat: C.lat + 0.010, lng: C.lng + 0.010 }   // 约 1.1km 外，明显出框

const T0 = new Date('2026-10-20T10:00:00Z').getTime()
const cat = (id, loc, extra) => Object.assign({
  _id: id, name: id, schoolId: SCHOOL, status: 'campus',
  sterilized: 'yes', pattern: 'tabby', photos: [], avatar: '', location: loc
}, extra || {})
const sight = (catId, loc, at, schoolId) => ({
  catId, location: loc, createdAt: new Date(at),
  schoolId: schoolId === undefined ? SCHOOL : schoolId
})

async function run(bounds, sightings, cats) {
  SIGHTINGS = sightings
  SIGHTINGS_ERROR = null
  SIGHTINGS_ORDER_ERROR = null
  CATS = cats
  return maplib.mapPoints({ openid: 'u1', role: 'member', schoolId: SCHOOL }, {
    schoolId: SCHOOL, zoom: 16, bounds: bounds || null
  })
}

/* ==================== A. 校外打卡不能让猫整只消失 ==================== */
console.log('\n--- A. 最新打卡落在范围外 ---')
;(async () => {
  // A1：档案位置在框内，最新打卡跑到框外 → 修复前这只猫彻底不上图
  let r = await run(BOUNDS,
    [sight('c1', OUTSIDE, T0 + 1000)],
    [cat('c1', { lat: C.lat, lng: C.lng })])
  const p1 = (r.points || []).find(p => p.catId === 'c1')
  assert('A1 打卡在范围外时回退档案位置，猫仍在图上', !!p1,
    { points: (r.points || []).map(p => p.catId), outside: r.outside })
  if (p1) {
    assert('A1 回退后用的是档案常驻坐标', Math.abs(p1.lat - C.lat) < 1e-6 && Math.abs(p1.lng - C.lng) < 1e-6,
      { lat: p1.lat, lng: p1.lng })
    assert('A1 回退的点位不应再标记 fromSighting', p1.fromSighting === false, p1.fromSighting)
  }

  // A2：档案和打卡都在框外 → 仍要上图（超管要能看到，只是标记越界）
  r = await run(BOUNDS,
    [sight('c2', OUTSIDE, T0 + 1000)],
    [cat('c2', OUTSIDE)])
  const p2 = (r.points || []).find(p => p.catId === 'c2')
  assert('A2 档案与打卡都在框外时猫仍上图（宁可多显示，不可凭空消失）', !!p2,
    { points: (r.points || []).map(p => p.catId) })
  if (p2) assert('A2 越界点位被标记出来', p2.outside === true, p2.outside)
  assert('A2 outside 计数正确', (r.outside || 0) === 1, r.outside)

  // A3：打卡在框内 → 必须用打卡位置（不能退回档案）
  r = await run(BOUNDS,
    [sight('c3', { lat: C.lat + 0.001, lng: C.lng + 0.001 }, T0 + 1000)],
    [cat('c3', { lat: C.lat, lng: C.lng })])
  const p3 = (r.points || []).find(p => p.catId === 'c3')
  assert('A3 打卡在框内时以打卡位置为准', !!p3 && p3.fromSighting === true, p3)
  if (p3) assert('A3 坐标就是打卡坐标', Math.abs(p3.lat - (C.lat + 0.001)) < 1e-6, p3.lat)

  // A4：同一只猫多次打卡，取**最新那条**在框内的（不是第一条）
  r = await run(BOUNDS,
    [sight('c4', OUTSIDE, T0 + 3000), sight('c4', { lat: C.lat + 0.002, lng: C.lng }, T0 + 2000)],
    [cat('c4', { lat: C.lat, lng: C.lng })])
  const p4 = (r.points || []).find(p => p.catId === 'c4')
  assert('A4 最新打卡越界时，退而用次新的框内打卡', !!p4 && Math.abs(p4.lat - (C.lat + 0.002)) < 1e-6,
    p4 && { lat: p4.lat, lng: p4.lng })

  /* ==================== B. 没有显式 bounds 时不得用小框误杀 ==================== */
  console.log('\n--- B. 学校未存 bounds 时的兜底 ---')
  // B1：学校只有 center+scale，猫在 800m 外打卡 —— 这在真实校园里完全正常
  const far = { lat: C.lat + 0.0072, lng: C.lng + 0.0072 }   // ≈800m
  r = await run(null, [sight('c5', far, T0 + 1000)], [cat('c5', { lat: C.lat, lng: C.lng })])
  const p5 = (r.points || []).find(p => p.catId === 'c5')
  assert('B1 未传 bounds 时点位不被过滤', !!p5, { points: (r.points || []).map(p => p.catId) })
  assert('B1 未传 bounds 时 outside 为 0', (r.outside || 0) === 0, r.outside)

  // B2：同样 800m 外的打卡，但学校存了 bounds —— 档案位置在框内，应回退成功。
  // 这正是修复的价值所在：旧行为下这只猫会被整只丢掉，现在它好好地待在档案点上。
  r = await run(BOUNDS, [sight('c6', far, T0 + 1000)], [cat('c6', { lat: C.lat, lng: C.lng })])
  const p6 = (r.points || []).find(p => p.catId === 'c6')
  assert('B2 有档案位置可回退时猫仍在图上', !!p6, { points: (r.points || []).map(p => p.catId) })
  if (p6) assert('B2 回退成功所以不再算越界', p6.outside === false, p6.outside)
  assert('B2 回退成功后 outside 计数为 0', (r.outside || 0) === 0, r.outside)

  /* ==================== C. 打卡查询失败必须可见 ==================== */
  console.log('\n--- C. 打卡表查询失败不再静默 ---')
  SIGHTINGS_ERROR = 'database query failed: index not exist'
  CATS = [cat('c7', { lat: C.lat, lng: C.lng })]
  r = await maplib.mapPoints({ openid: 'u1', role: 'member', schoolId: SCHOOL },
    { schoolId: SCHOOL, zoom: 16, bounds: null }).catch(e => ({ __err: e }))
  assert('C1 打卡查询失败时地图仍能出图（不抛错）', !r.__err && Array.isArray(r.points), r.__err && String(r.__err))
  assert('C2 失败原因回传给了调用方（可排查，不再静默）',
    !!(r && r.warn && /打卡/.test(r.warn)), r && r.warn)
  SIGHTINGS_ERROR = null

  // C3：仅「带 orderBy」的查询失败（缺索引的典型表现）→ 应走降级路径拿到点位
  SIGHTINGS_ORDER_ERROR = 'database query failed: index not exist'
  SIGHTINGS = [sight('c8', { lat: C.lat + 0.001, lng: C.lng + 0.001 }, T0 + 1000),
               sight('c8', { lat: C.lat - 0.001, lng: C.lng - 0.001 }, T0 + 500)]
  CATS = [cat('c8', { lat: C.lat, lng: C.lng })]
  r = await maplib.mapPoints({ openid: 'u1', role: 'member', schoolId: SCHOOL },
    { schoolId: SCHOOL, zoom: 16, bounds: null })
  const p8 = (r.points || []).find(p => p.catId === 'c8')
  assert('C3 排序查询失败时仍能通过降级拿到打卡点位', !!p8 && p8.fromSighting === true, p8)
  if (p8) {
    assert('C3 降级拿到的是**最新**那条打卡（内存排序正确）',
      Math.abs(p8.lat - (C.lat + 0.001)) < 1e-6, { lat: p8.lat, want: C.lat + 0.001 })
  }
  assert('C3 降级状态对外可见（提示里说明缺索引）',
    !!(r && r.warn && /降级/.test(r.warn) && /索引/.test(r.warn)), r && r.warn)
  SIGHTINGS_ORDER_ERROR = null

  /* ==================== D. 接线：前端必须把 bounds 传给云端 ==================== */
  console.log('\n--- D. 前端接线 ---')
  const call = mpSrc.match(/callApi\(\s*'listMapPoints'\s*,\s*\{([\s\S]{0,300}?)\}\s*\)/)
  assert('D1 前端调用了 listMapPoints', !!call)
  if (call) {
    assert('D2 请求里带上了 bounds（否则服务端拿不到校园范围）',
      /\bbounds\b/.test(call[1]), call[1].trim())
  }
  // 前端不再自己做「区域聚焦」过滤（已在服务端完成，避免两侧口径打架）
  const keepBlock = mpSrc.match(/const keep = p => \{([\s\S]{0,900}?)\n      \}/)
  assert('D3 前端保留坐标 isFinite 校验（NaN 会让渲染层崩）',
    /Number\.isFinite/.test(mpSrc))
  if (keepBlock) {
    assert('D4 前端不再按 bounds 二次过滤点位（交给服务端统一裁决）',
      !/outside\+\+/.test(keepBlock[1]), keepBlock[1].trim().slice(0, 120))
  }

  /* ==================== F. sightings.schoolId 为空也要能上图 ==================== */
  console.log('\n--- F. 跨校隔离 ---')
  // F1：本校猫的正常打卡 → 用打卡坐标上图
  r = await run(BOUNDS,
    [sight('c9', { lat: C.lat + 0.0015, lng: C.lng + 0.0015 }, T0 + 1000)],
    [cat('c9', { lat: C.lat, lng: C.lng })])
  const p9 = (r.points || []).find(p => p.catId === 'c9')
  assert('F1 本校猫的打卡能上图', !!p9, { points: (r.points || []).map(p => p.catId) })
  if (p9) {
    assert('F1 用的是打卡坐标而不是档案位置',
      p9.fromSighting === true && Math.abs(p9.lat - (C.lat + 0.0015)) < 1e-6,
      { lat: p9.lat, from: p9.fromSighting })
  }

  // F2：归属按 catId 复核 —— 即使打卡记录的 schoolId 写错/为空，
  // 他校猫的打卡也绝不能串进本校地图（cats.schoolId 才是准的）
  r = await run(BOUNDS,
    [sight('cX', { lat: C.lat, lng: C.lng }, T0 + 1000, SCHOOL)],   // 冒用本校 schoolId
    [cat('c9', { lat: C.lat, lng: C.lng })])
  assert('F2 他校猫的打卡不会串进本校点位（按 catId 复核）',
    !(r.points || []).some(p => p.catId === 'cX'),
    (r.points || []).map(p => p.catId))

  /* ==================== G. 诊断接口：逐只说清为什么没上图 ==================== */
  console.log('\n--- G. diagnoseMapPoints ---')
  const diag = async (sightings, cats) => {
    SIGHTINGS = sightings
    SIGHTINGS_ERROR = null
    SIGHTINGS_ORDER_ERROR = null
    CATS = cats
    return maplib.diagnoseMapPoints({ openid: 'u1', role: 'admin', schoolId: SCHOOL },
      { schoolId: SCHOOL, bounds: BOUNDS })
  }
  const find = (d, id) => (d.cats || []).find(x => x.catId === id) || {}

  // G1：有打卡 + 档案位置 → 用打卡
  let d = await diag([sight('d1', { lat: C.lat + 0.001, lng: C.lng }, T0 + 1000)],
    [cat('d1', { lat: C.lat, lng: C.lng })])
  assert('G1 有带坐标打卡时来源记为打卡', find(d, 'd1').source === 'sighting', find(d, 'd1'))

  // G2：完全没打卡、只有档案位置 → 用档案
  d = await diag([], [cat('d2', { lat: C.lat, lng: C.lng })])
  assert('G2 无打卡时用档案位置', find(d, 'd2').source === 'profile', find(d, 'd2'))
  assert('G2 说明「没有带 catId 的打卡」', /没有带 catId 的打卡/.test(find(d, 'd2').reason),
    find(d, 'd2').reason)

  // G3：打卡了但没坐标（未授权定位）→ 不上图，且说清楚是缺坐标
  d = await diag([{ catId: 'd3', location: null, createdAt: new Date(T0), schoolId: SCHOOL }],
    [cat('d3', null)])
  assert('G3 打卡无坐标时不上图', find(d, 'd3').source === 'none', find(d, 'd3'))
  assert('G3 明确指出「打卡没有坐标」', /没有坐标/.test(find(d, 'd3').reason), find(d, 'd3').reason)

  // G4：既没档案位置也没打卡 → 不上图
  d = await diag([], [cat('d4', null)])
  assert('G4 既无位置也无打卡时不上图', find(d, 'd4').source === 'none', find(d, 'd4'))
  assert('G4 原因写清「不会上图」', /不会上图/.test(find(d, 'd4').reason), find(d, 'd4').reason)

  // G5：catId 为空的打卡（未认领新猫）单独统计 —— 这是「明明打了卡却看不到」的常见真相
  d = await diag([{ catId: '', location: { lat: C.lat, lng: C.lng }, createdAt: new Date(T0), schoolId: SCHOOL }],
    [cat('d5', { lat: C.lat, lng: C.lng })])
  assert('G5 未认领（catId 为空）的打卡单独统计', d.pendingWithLoc === 1, d.pendingWithLoc)
  assert('G5 它不会算作任何猫的点位', find(d, 'd5').source === 'profile', find(d, 'd5'))

  // G6：汇总数量对得上
  assert('G6 汇总「上图/缺失」数量正确',
    d.summary && d.summary.cats === 1 && d.summary.onMap === 1 && d.summary.missing === 0, d.summary)

  /* ==================== H. 跨校错配证据 ====================
   * 现场现象「本校只扫到 3 条，但我明明打了十几次卡」：只报本校数据是看不出来的，
   * 必须给出全库分布做对照，否则排查会卡在「到底是没打上卡还是打卡没匹配上」。 */
  console.log('\n--- H. 跨校错配证据 ---')

  // H1：全在本校时，不该报错配（避免误报把人带偏）
  d = await diag([sight('h1', { lat: C.lat, lng: C.lng }, T0 + 1000)],
    [cat('h1', { lat: C.lat, lng: C.lng })])
  assert('H1 打卡全在本校时不报错配', !d.mismatchHint, d.mismatchHint)
  assert('H1 全库数与本校数一致', d.sightingsAll === 1 && d.sightingRowsScanned === 1, d)

  // H2：打卡记在别校 —— 本校扫不到，但全库看得到
  d = await diag([
    sight('h2', { lat: C.lat, lng: C.lng }, T0 + 1000),          // 本校
    sight('h2', { lat: C.lat, lng: C.lng }, T0 + 2000, 'sch_9'), // 别校
    sight('h2', { lat: C.lat, lng: C.lng }, T0 + 3000, 'sch_9')  // 别校
  ], [cat('h2', { lat: C.lat, lng: C.lng })])
  assert('H2 别校打卡被计入全库总数', d.sightingsAll === 3, d.sightingsAll)
  assert('H2 本校只匹配到自己的那几条', d.sightingRowsScanned === 1, d.sightingRowsScanned)
  assert('H2 给出别校分布', d.sightingsBySchool && d.sightingsBySchool['sch_9'] === 2,
    d.sightingsBySchool)
  assert('H2 明确提示「记在别校或 schoolId 为空」',
    /别校/.test(d.mismatchHint || ''), d.mismatchHint)

  // H3：schoolId 为空串的打卡要单独归到「(空)」—— 空值是最难自己在控制台看出来的
  d = await diag([
    sight('h3', { lat: C.lat, lng: C.lng }, T0 + 1000, '')
  ], [cat('h3', { lat: C.lat, lng: C.lng })])
  assert('H3 schoolId 为空的打卡归入「(空)」',
    d.sightingsBySchool && d.sightingsBySchool['(空)'] === 1, d.sightingsBySchool)
  assert('H3 空 schoolId 也算错配（本校查不到）', d.sightingRowsScanned === 0 && !!d.mismatchHint, d)

  // H4：新猫档案建在别校 —— 它压根不进本校 cats，界面上表现为「新猫全不上图」
  d = await diag([], [cat('h4', { lat: C.lat, lng: C.lng }, { schoolId: 'sch_9' })])
  assert('H4 本校猫数与全库猫数分开报（能看出档案建在别校）',
    d.catsInSchool === 0 && d.catsAll === 1, { inSchool: d.catsInSchool, all: d.catsAll })

  // H5：学校名一并返回，避免拿着 id 还得去库里对
  assert('H5 返回当前学校名（便于确认看的是哪个学校）',
    d.schoolName === '东南大学', d.schoolName)

  /* ==================== E. 兜底 bounds 的口径 ==================== */
  console.log('\n--- E. 兜底 bounds 不再误杀 ---')
  assert('E1 前端未存 bounds 时不再自己推导小框去过滤',
    !/boundsFromCenter\(next\.center/.test(mpSrc) || /bounds\s*=\s*b\s*;?\s*\/\/[^]*?不做过滤/.test(mpSrc),
    (mpSrc.match(/const b = school\.bounds[\s\S]{0,200}/) || [''])[0])

  /* ==================== 汇总 ==================== */
  console.log('\n============================')
  console.log('通过 ' + pass + ' / 失败 ' + fail)
  if (fail) {
    console.log('失败项：')
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log('全部通过 ✅')
})()
