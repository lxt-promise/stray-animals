/**
 * 猫粮值 / 积分值 / 等级 规则回归（规则 V1.0）
 *
 * 这一套**不连云环境**：用一个内存版云数据库 mock 替换 lib/core，
 * 这样可以精确构造「日上限刚好用满」「余额只剩 10」这类边界，
 * 而这些场景在真实环境里要么造不出来、要么造出来就污染数据。
 *
 * 覆盖的都是「错了不会报错、只会让用户觉得规则不对」的点：
 *   · 积分与猫粮的日上限必须各自独立（共用一个计数就会互相挤占）
 *   · 等级按历史最高积分判，只升不降
 *   · 升级奖励 50 猫粮，且不占当日 50 的上限
 *   · 猫粮扣不成负数
 *   · 识别首次免费、第二次起 20/次、每日 10 次
 *   · 前后端食物类型枚举必须逐值对齐（错一个就静默回落干粮 +2）
 */
const path = require('path')
const Module = require('module')
const assert = require('assert')

const LIB = path.join(__dirname, '..', 'cloudfunctions', 'catcampus', 'lib')

/* ==================== 内存版云数据库（只实现本模块用到的 API） ==================== */

let TODAY = '2026-10-18'
const store = { users: new Map(), points: [] }
let seq = 0
const nextId = () => 'id' + (++seq)

const _ = {
  inc: n => ({ __op: 'inc', n }),
  exists: v => ({ __op: 'exists', v }),
  nin: arr => ({ __op: 'nin', arr }),
  in: arr => ({ __op: 'in', arr }),
  push: arr => ({ __op: 'push', arr }),
  or: conds => ({ __logic: 'or', conds })
}

function match(doc, cond) {
  if (!cond) return true
  if (cond.__logic === 'or') return cond.conds.some(c => match(doc, c))
  return Object.keys(cond).every(k => {
    const c = cond[k]
    const v = doc[k]
    if (c && c.__op === 'exists') return c.v ? v !== undefined : v === undefined
    if (c && c.__op === 'nin') return c.arr.indexOf(v) < 0
    if (c && c.__op === 'in') return c.arr.indexOf(v) >= 0
    return v === c
  })
}

function applyPatch(doc, patch) {
  Object.keys(patch).forEach(k => {
    const v = patch[k]
    if (v && v.__op === 'inc') doc[k] = (Number(doc[k]) || 0) + v.n
    else if (v && v.__op === 'push') {
      const a = Array.isArray(doc[k]) ? doc[k] : []
      v.arr.forEach(x => a.push(x))
      doc[k] = a
    } else doc[k] = v
  })
}

function collection(name) {
  const isUser = name === 'users'
  const rowsOf = () => (isUser ? Array.from(store.users.values()) : store.points)
  return {
    doc(id) {
      return {
        async get() {
          if (isUser) return { data: store.users.get(id) || null }
          const row = store.points.find(p => p._id === id)
          return { data: row || null }
        },
        async update({ data }) {
          if (isUser) {
            const d = store.users.get(id)
            if (!d) return { stats: { updated: 0 } }
            applyPatch(d, data)
            return { stats: { updated: 1 } }
          }
          const row = store.points.find(p => p._id === id)
          if (row) applyPatch(row, data)
          return { stats: { updated: row ? 1 : 0 } }
        },
        async remove() {
          if (isUser) store.users.delete(id)
          return { stats: { removed: 1 } }
        }
      }
    },
    async add({ data }) {
      const id = nextId()
      const row = Object.assign({ _id: id }, data)
      if (isUser) store.users.set(id, row)
      else store.points.push(row)
      return { _id: id }
    },
    where(cond) {
      let order = null
      let cap = Infinity
      const q = {
        orderBy(field, dir) { order = { field, dir }; return q },
        limit(n) { cap = Number(n) || Infinity; return q },
        async get() {
          let rows = rowsOf().filter(d => match(d, cond))
          if (order) {
            const { field, dir } = order
            rows = rows.slice().sort((a, b) => {
              const av = new Date(a[field] || 0).getTime()
              const bv = new Date(b[field] || 0).getTime()
              return dir === 'desc' ? bv - av : av - bv
            })
          }
          return { data: rows.slice(0, cap === Infinity ? undefined : cap) }
        },
        async update({ data }) {
          let n = 0
          rowsOf().forEach(d => {
            if (match(d, cond)) { applyPatch(d, data); n++ }
          })
          return { stats: { updated: n } }
        },
        async count() {
          return { total: rowsOf().filter(d => match(d, cond)).length }
        }
      }
      return q
    }
  }
}

const fakeCore = {
  db: {
    collection,
    runTransaction: fn => fn({ collection })
  },
  _,
  COL: { user: 'users', point: 'points' },
  dayKey: () => TODAY,
  // 真实实现按 openid 白名单判定；测试用档案上的标记位，语义等价且不用碰环境变量
  isSuper: u => !!(u && u.__super),
  AppError: class AppError extends Error {
    constructor(msg, code) { super(msg); this.code = code || 400 }
  }
}

// 拦截 points.js 对 './core' 的引用；其余模块照常加载
const origLoad = Module._load
Module._load = function (request, parent) {
  if (request === './core' && parent && parent.filename === path.join(LIB, 'points.js')) {
    return fakeCore
  }
  return origLoad.apply(this, arguments)
}

const points = require(path.join(LIB, 'points.js'))
const level = require(path.join(LIB, 'level.js'))
const C = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'const.js'))
// 前端等级视图（本地算等级，不依赖云端派生字段）
const clientLevel = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'level.js'))

/* ==================== 测试脚手架 ==================== */

let passed = 0
const failures = []

function ok(name, fn) {
  try {
    fn()
    passed++
    console.log('  ✓ ' + name)
  } catch (e) {
    failures.push({ name, err: e })
    console.log('  ✗ ' + name + ' —— ' + e.message)
  }
}

async function okAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log('  ✓ ' + name)
  } catch (e) {
    failures.push({ name, err: e })
    console.log('  ✗ ' + name + ' —— ' + e.message)
  }
}

function reset() {
  store.users.clear()
  store.points.length = 0
  seq = 0
  TODAY = '2026-10-18'
}

/** 造一个用户：默认 0 分 0 猫粮，未领礼包 */
function newUser(extra) {
  const id = nextId()
  const doc = Object.assign({
    _id: id,
    openid: 'o_' + id,
    nickName: '测试',
    points: 0, pointsDay: '', pointsToday: 0,
    peakPoints: 0, level: 1,
    food: 0, foodDay: '', foodToday: 0,
    recognizeDay: '', recognizeToday: 0,
    catSeen: []
  }, extra || {})
  store.users.set(id, doc)
  return doc
}

const userOf = u => store.users.get(u._id)

/* ==================== 用例 ==================== */

async function main() {
  console.log('\n=== S1 等级区间（左闭右开，100 分即升 Lv.2）===')
  const bounds = [[0, 1], [99, 1], [100, 2], [499, 2], [500, 3], [999, 3],
    [1000, 4], [2999, 4], [3000, 5], [4999, 5], [5000, 6], [123456, 6]]
  ok('12 个边界点全部落在正确等级', () => {
    bounds.forEach(([p, want]) => {
      assert.strictEqual(level.levelOf(p).lv, want, p + ' 分应为 Lv.' + want)
    })
  })
  ok('满级不再显示「还差 N 分」', () => {
    const r = level.levelOf(6000)
    assert.strictEqual(r.maxed, true)
    assert.strictEqual(r.toNext, 0)
    assert.strictEqual(r.progress, 100)
  })
  ok('刚跨档时进度归零（不是直接给 100）', () => {
    assert.strictEqual(level.levelOf(100).progress, 0)
    assert.strictEqual(level.levelOf(300).progress, 50)
  })

  console.log('\n=== S2 积分只增不减：等级按历史最高积分 ===')
  reset()
  await okAsync('积分从 95 涨到 105，等级升到 Lv.2 并发 50 猫粮', async () => {
    const u = newUser({ points: 95, peakPoints: 95, level: 1 })
    const r = await points.grantPoint(u, 'daily', 10)
    assert.strictEqual(r.gained, 10)
    assert.strictEqual(r.levelUp, 2, '应升到 Lv.2')
    assert.strictEqual(r.foodGained, 50, '升级奖励应为 50 猫粮')
    assert.strictEqual(userOf(u).points, 105)
    assert.strictEqual(userOf(u).level, 2)
    assert.strictEqual(userOf(u).food, 50)
  })
  await okAsync('即使 points 被异常下调，等级也不掉（按 peakPoints）', async () => {
    const u = newUser({ points: 600, peakPoints: 600, level: 3 })
    // 模拟一次异常调账（真实环境里删除/合并可能造成）
    await fakeCore.db.collection('users').doc(u._id).update({ data: { points: 50 } })
    const r = await points.summary(userOf(u))
    assert.strictEqual(r.level.lv, 3, '等级应仍为 Lv.3')
    assert.strictEqual(r.peakPoints, 600)
  })
  await okAsync('跨级一次补发多倍升级奖励（1→3 级 = 100）', async () => {
    const u = newUser({ points: 90, peakPoints: 90, level: 1 })
    const r = await points.grantPoint(u, 'dexNew', 500)
    assert.strictEqual(r.gained, 150, '积分应被日上限截到 150')
    // 90 + 150 = 240 → 只到 Lv.2，不是 Lv.3
    assert.strictEqual(userOf(u).level, 2)
    assert.strictEqual(r.foodGained, 50)
  })

  console.log('\n=== S3 两套货币的日上限各自独立 ===')
  reset()
  await okAsync('积分日上限 150：一次要 200 只给 150', async () => {
    const u = newUser()
    const r = await points.grantPoint(u, 'dexNew', 200)
    assert.strictEqual(r.gained, 150)
    assert.strictEqual(r.capped, true)
    assert.strictEqual(userOf(u).points, 150)
  })
  await okAsync('猫粮日上限 50：发满后继续发只给 0，但不影响积分', async () => {
    const u = newUser()
    const a = await points.grantFood(u, 'catCreatePhoto', 20)
    const b = await points.grantFood(u, 'catCreatePhoto', 20)
    const c = await points.grantFood(u, 'catCreatePhoto', 20)   // 已到 40，只给 10
    assert.strictEqual(a.gained, 20)
    assert.strictEqual(b.gained, 20)
    assert.strictEqual(c.gained, 10)
    assert.strictEqual(userOf(u).food, 50)
    // 积分完全不受影响
    const p = await points.grantPoint(u, 'daily', 5)
    assert.strictEqual(p.gained, 5)
    assert.strictEqual(userOf(u).points, 5)
  })
  await okAsync('积分与猫粮的日计数互不覆盖（各自字段）', async () => {
    const u = newUser()
    await points.grantPoint(u, 'daily', 5)
    await points.grantFood(u, 'daily', 5)
    const doc = userOf(u)
    assert.strictEqual(doc.pointsToday, 5)
    assert.strictEqual(doc.foodToday, 5)
    assert.strictEqual(doc.pointsDay, TODAY)
    assert.strictEqual(doc.foodDay, TODAY)
  })
  await okAsync('跨天后额度重置', async () => {
    const u = newUser({ pointsToday: 150, pointsDay: '2026-10-17' })
    TODAY = '2026-10-19'
    const r = await points.grantPoint(u, 'daily', 5)
    assert.strictEqual(r.gained, 5, '跨天应重新获得额度')
  })

  console.log('\n=== S4 新手礼包与升级奖励不占日上限 ===')
  reset()
  await okAsync('猫粮已发满 50 后，新手礼包仍能发 50', async () => {
    const u = newUser()
    await points.grantFood(u, 'catCreatePhoto', 20)
    await points.grantFood(u, 'catCreatePhoto', 20)
    await points.grantFood(u, 'catCreatePhoto', 20)
    assert.strictEqual(userOf(u).food, 50)
    const g = await points.claimGift(u)
    assert.strictEqual(g.gained, 50, '礼包不受日上限约束')
    assert.strictEqual(userOf(u).food, 100)
  })
  await okAsync('礼包只发一次（重复调用返回 0）', async () => {
    const u = userOf(newUser())
    const first = await points.claimGift(u)
    const second = await points.claimGift(userOf(u))
    assert.strictEqual(first.gained, 50)
    assert.strictEqual(second.gained, 0, '第二次不该再发')
  })
  await okAsync('升级奖励在猫粮日上限已满时照发', async () => {
    const u = newUser({ points: 99, peakPoints: 99, level: 1, food: 0, foodDay: TODAY, foodToday: 50 })
    const r = await points.grantPoint(u, 'daily', 5)
    assert.strictEqual(r.levelUp, 2)
    assert.strictEqual(r.foodGained, 50)
    assert.strictEqual(userOf(u).food, 50, '日上限已满也应拿到升级奖励')
  })

  console.log('\n=== S5 猫粮下限为 0（余额不足必须抛错）===')
  reset()
  await okAsync('余额 10 时扣 20 抛错，且余额不变', async () => {
    const u = newUser({ food: 10 })
    let threw = false
    try {
      await points.spendFood(u, 'recognize', 20)
    } catch (e) {
      threw = true
      assert.ok(e.message.indexOf('猫粮值不足') >= 0, '错误文案应说明余额不足')
    }
    assert.ok(threw, '应当抛错')
    assert.strictEqual(userOf(u).food, 10, '失败不得改动余额')
  })
  await okAsync('余额刚好够时扣到 0，且写入负向流水', async () => {
    const u = newUser({ food: 20 })
    const r = await points.spendFood(u, 'recognize', 20)
    assert.strictEqual(r.balance, 0)
    assert.strictEqual(userOf(u).food, 0)
    const last = store.points[store.points.length - 1]
    assert.strictEqual(last.delta, -20)
    assert.strictEqual(last.currency, 'food')
  })

  console.log('\n=== S6 识别计费：首次免费 → 20/次 → 每日 10 次 ===')
  reset()
  await okAsync('首次不扣费，但记一条免费流水', async () => {
    const u = newUser({ food: 100 })
    const r = await points.chargeRecognize(u, { refId: 't1' })
    assert.strictEqual(r.free, true)
    assert.strictEqual(r.cost, 0)
    assert.strictEqual(userOf(u).food, 100, '首次免费不该扣钱')
    assert.strictEqual(userOf(u).recognizeToday, 1)
    const last = store.points[store.points.length - 1]
    assert.strictEqual(last.kind, 'recognizeFree')
    assert.strictEqual(last.delta, 0)
  })
  await okAsync('第二次扣 20，剩余次数递减', async () => {
    const u = userOf(newUser({ food: 100, freeRecognizeAt: new Date() }))
    const r = await points.chargeRecognize(u, {})
    assert.strictEqual(r.free, false)
    assert.strictEqual(r.cost, 20)
    assert.strictEqual(userOf(u).food, 80)
    assert.strictEqual(r.left, 9, '第 1 次后应剩 9 次')
  })
  await okAsync('第 11 次被拦（每日上限 10）', async () => {
    const u = userOf(newUser({ food: 1000, freeRecognizeAt: new Date(), recognizeToday: 10, recognizeDay: TODAY }))
    let threw = false
    try {
      await points.chargeRecognize(u, {})
    } catch (e) {
      threw = true
      assert.ok(/10 次/.test(e.message), '应提示次数用完')
    }
    assert.ok(threw, '超过上限应抛错')
    assert.strictEqual(userOf(u).food, 1000, '被拦时不应扣钱')
  })
  await okAsync('次数用完优先于余额不足提示', async () => {
    const u = userOf(newUser({ food: 0, recognizeToday: 10, recognizeDay: TODAY }))
    let msg = ''
    try { await points.chargeRecognize(u, {}) } catch (e) { msg = e.message }
    assert.ok(/10 次/.test(msg), '应提示次数，而不是余额')
  })

  console.log('\n=== S7 流水按币种区分 ===')
  reset()
  await okAsync('积分与猫粮各写一条，currency 正确', async () => {
    const u = newUser()
    await points.grantPoint(u, 'daily', 5)
    await points.grantFood(u, 'daily', 5)
    const rows = store.points
    assert.strictEqual(rows.length, 2)
    assert.strictEqual(rows[0].currency, 'point')
    assert.strictEqual(rows[1].currency, 'food')
  })
  await okAsync('历史流水没有 currency 时按积分归档', async () => {
    const u = newUser()
    store.points.push({ _id: 'legacy', openid: u.openid, kind: 'sighting', delta: 10, balance: 10 })
    const list = await points.history(u.openid, { size: 10 })
    const legacy = list.find(x => x._id === 'legacy')
    assert.strictEqual(legacy.currency, 'point')
  })

  console.log('\n=== S8 前后端枚举对齐 ===')
  ok('食物类型 value 与云端白名单逐值一致', () => {
    const idx = require('fs').readFileSync(
      path.join(__dirname, '..', 'cloudfunctions', 'catcampus', 'index.js'), 'utf8')
    const m = idx.match(/const FOOD_TYPE_VALUES = \[([^\]]+)\]/)
    assert.ok(m, '云端应有 FOOD_TYPE_VALUES')
    const cloud = m[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean)
    const client = C.FOOD_TYPE.map(x => x.value)
    assert.deepStrictEqual(client.slice().sort(), cloud.slice().sort(),
      '前端 ' + JSON.stringify(client) + ' 与云端 ' + JSON.stringify(cloud) + ' 不一致')
  })
  ok('每个食物类型都有中文 label 且带分值', () => {
    C.FOOD_TYPE.forEach(x => {
      assert.ok(x.label && /[\u4e00-\u9fa5]/.test(x.label), x.value + ' 缺中文标签')
      assert.ok(/\+[2-5]/.test(x.label), x.value + ' 的标签应带 +2~+5 分值')
    })
  })
  ok('等级表与云端 level.js 一致', () => {
    const cloud = level.table()
    assert.strictEqual(cloud.length, 6)
    assert.deepStrictEqual(cloud.map(x => x.name),
      ['猫语新手', '爱猫人士', '猫界达人', '资深铲屎官', '喵星守护者', '传奇喵侠'])
    assert.deepStrictEqual(cloud.map(x => x.min), [0, 100, 500, 1000, 3000, 5000])
  })

  console.log('\n=== S9 超级管理员礼遇：满级 + 500 猫粮，且只发一次 ===')
  reset()
  await okAsync('超管首次登录被置为 Lv.6，猫粮补到 500', async () => {
    const u = newUser({ __super: true, points: 30, peakPoints: 30, level: 1, food: 10 })
    const r = await points.grantAdminPrivilege(u)
    assert.strictEqual(r.applied, true)
    assert.strictEqual(r.points, 5000, '积分应给到最高档门槛')
    assert.strictEqual(r.food, 500)
    assert.strictEqual(userOf(u).level, 6)
    assert.strictEqual(userOf(u).peakPoints, 5000)
    assert.strictEqual(userOf(u).food, 500)
    const s = await points.summary(userOf(u))
    assert.strictEqual(s.level.lv, 6)
    assert.strictEqual(s.level.maxed, true, '满级后不应再显示「还差 N 分」')
  })
  await okAsync('花掉的猫粮不会被下次登录重新补满', async () => {
    const u = newUser({ __super: true })
    await points.grantAdminPrivilege(u)
    // ⚠️ 2026-10-24：超管已改为「任何功能都不消耗猫粮」（spendFood 豁免），
    // 所以这里不能再用 spendFood 来模拟「花掉」—— 它现在不会扣钱了。
    // 本用例要验的是「礼遇只发一次、花了不会补」，与怎么花的无关，直接改余额即可。
    userOf(u).food -= 200
    assert.strictEqual(userOf(u).food, 300)
    const r = await points.grantAdminPrivilege(userOf(u))
    assert.strictEqual(r.applied, false, '第二次不该再发')
    assert.strictEqual(userOf(u).food, 300)
  })
  await okAsync('非超管完全不受影响', async () => {
    const u = newUser({ points: 10, food: 5 })
    const r = await points.grantAdminPrivilege(u)
    assert.strictEqual(r.applied, false)
    assert.strictEqual(userOf(u).points, 10)
    assert.strictEqual(userOf(u).food, 5)
    assert.strictEqual(userOf(u).adminGrantAt, undefined)
  })
  await okAsync('猫粮已超过 500 时取 max，不倒扣', async () => {
    const u = newUser({ __super: true, food: 800 })
    const r = await points.grantAdminPrivilege(u)
    assert.strictEqual(r.food, 800)
    assert.strictEqual(userOf(u).food, 800)
  })
  await okAsync('礼遇写两条流水（积分 + 猫粮），kind=adminGift', async () => {
    reset()
    const u = newUser({ __super: true })
    await points.grantAdminPrivilege(u)
    const rows = store.points.filter(r => r.kind === 'adminGift')
    assert.strictEqual(rows.length, 2, '应为积分与猫粮各一条')
    const p = rows.find(r => r.currency === 'point')
    const f = rows.find(r => r.currency === 'food')
    assert.ok(p && p.delta === 5000, '积分流水 +5000')
    assert.ok(f && f.delta === 500, '猫粮流水 +500')
  })

  console.log('\n=== S10 前端等级视图：与云端同表，且永不渲染 undefined ===')
  ok('前端 utils/level.js 的等级表与云端逐值一致', () => {
    assert.deepStrictEqual(
      clientLevel.LEVELS.map(x => [x.lv, x.name, x.min]),
      level.LEVELS.map(x => [x.lv, x.name, x.min]),
      '改等级门槛时 miniprogram/utils/level.js 与云端 lib/level.js 必须一起改')
  })
  ok('13 个边界点上前后端判级结果完全一致', () => {
    ;[0, 1, 99, 100, 101, 499, 500, 999, 1000, 2999, 3000, 4999, 5000, 9999].forEach(p => {
      const a = level.levelOf(p)
      const b = clientLevel.levelOf(p)
      assert.strictEqual(b.lv, a.lv, p + ' 分等级不一致')
      assert.strictEqual(b.progress, a.progress, p + ' 分进度不一致')
      assert.strictEqual(b.toNext, a.toNext, p + ' 分差距不一致')
      assert.strictEqual(b.maxed, a.maxed, p + ' 分满级标记不一致')
    })
  })
  // 这条是「0 / undefined 分」「距 Lv.undefined …」的回归哨兵：
  // 旧实现把云端下发的 nextLv/nextName/toNext 直接拼进文案，字段一缺就渲染 undefined。
  ok('等级文案永不出现 undefined / NaN（含脏输入）', () => {
    const inputs = [undefined, null, NaN, '', 'abc', {}, [], -1, 0, 1, 99, 100, 499, 500, 4999, 5000, 9999, 1e9]
    inputs.forEach(p => {
      const v = clientLevel.levelOf(p)
      const text = [v.levelText, v.nextText].join(' ')
      assert.ok(!/undefined|NaN/.test(text), '入参 ' + String(p) + ' 渲染出：' + text)
      assert.ok(/^Lv\.\d+ \S+$/.test(v.levelText), 'levelText 格式异常：' + v.levelText)
      assert.ok(Number.isFinite(v.progress) && v.progress >= 0 && v.progress <= 100, '进度越界：' + v.progress)
    })
  })
  ok('阶梯 6 档：恰好一个 on，done 数量 = 当前等级-1', () => {
    const steps = clientLevel.ladder(600)
    assert.strictEqual(steps.length, 6)
    assert.strictEqual(steps.filter(s => s.on).length, 1)
    assert.strictEqual(steps.filter(s => s.on)[0].lv, 3)
    assert.strictEqual(steps.filter(s => s.done).length, 2)
    assert.deepStrictEqual(steps.map(s => s.label), ['Lv.1', 'Lv.2', 'Lv.3', 'Lv.4', 'Lv.5', 'Lv.6'])
  })
  ok('展示口径：100 分即 Lv.2，文案「再得 400 积分可升级」', () => {
    const v = clientLevel.levelOf(100)
    assert.strictEqual(v.levelText, 'Lv.2 爱猫人士')
    assert.strictEqual(v.nextText, '再得 400 积分可升级')
    assert.strictEqual(v.progress, 0)
  })
  ok('满级文案是「已达最高等级」，不再出现「再得」', () => {
    assert.strictEqual(clientLevel.levelOf(5000).nextText, '已达最高等级')
    assert.strictEqual(clientLevel.levelOf(5000).progress, 100)
  })

  console.log('\n=== S11 超级管理员免消耗：不扣猫粮、不占识别次数 ===')
  await okAsync('超管余额 0 也能识别（豁免必须在余额校验之前）', async () => {
    reset()
    const u = newUser({ __super: true, food: 0 })
    const r = await points.chargeRecognize(u, { refType: 'ai_task', refId: 't1' })
    assert.strictEqual(r.waived, true, '应标记 waived')
    assert.strictEqual(r.cost, 0, '超管计费应为 0')
    assert.strictEqual(userOf(u).food, 0, '余额不能变（更不能变负）')
  })
  await okAsync('超管不占每日识别次数（连刷 15 次都不抛 429）', async () => {
    reset()
    const u = newUser({ __super: true, food: 0 })
    for (let i = 0; i < 15; i++) {
      await points.chargeRecognize(u, { refType: 'ai_task', refId: 't' + i })
    }
    assert.strictEqual(userOf(u).recognizeToday || 0, 0, '不应推进日计数')
    assert.strictEqual(userOf(u).food, 0)
  })
  await okAsync('超管 spendFood 不扣、且余额 0 不抛 402', async () => {
    reset()
    const u = newUser({ __super: true, food: 0 })
    const r = await points.spendFood(u, 'recognize', 20, { refType: 'x', refId: 'y' })
    assert.strictEqual(r.waived, true)
    assert.strictEqual(r.spent, 0)
    assert.strictEqual(userOf(u).food, 0)
  })
  await okAsync('豁免仍写一条 delta=0 的 food 流水（审计留痕）', async () => {
    reset()
    const u = newUser({ __super: true, food: 30 })
    await points.chargeRecognize(u, { refType: 'ai_task', refId: 't9' })
    const rows = store.points.filter(r => r.currency === 'food')
    assert.strictEqual(rows.length, 1, '应有一条猫粮流水')
    assert.strictEqual(rows[0].delta, 0, 'delta 必须是 0（不是 -0、不是 -20）')
    assert.strictEqual(rows[0].balance, 30, '流水余额取真实余额')
    assert.ok(/免消耗/.test(rows[0].reason), '流水原因要能看出是豁免：' + rows[0].reason)
  })
  await okAsync('普通用户完全不受影响：余额不足仍 402、第 11 次仍 429', async () => {
    reset()
    const poor = newUser({ food: 0, freeRecognizeAt: new Date() })
    await assert.rejects(
      () => points.chargeRecognize(poor, {}),
      e => e.code === 402
    )
    const rich = newUser({ food: 1000, freeRecognizeAt: new Date() })
    for (let i = 0; i < 10; i++) await points.chargeRecognize(rich, {})
    await assert.rejects(() => points.chargeRecognize(rich, {}), e => e.code === 429)
    assert.strictEqual(userOf(rich).food, 800, '10 次 ×20 应扣到 800')
  })
  await okAsync('summary 对超管下发 waived，普通用户为 false', async () => {
    reset()
    const su = newUser({ __super: true, points: 0, food: 0 })
    const s1 = await points.summary(su)
    assert.strictEqual(s1.waived, true)
    assert.strictEqual(s1.recognize.waived, true)
    assert.strictEqual(s1.recognize.free, true, '超管一律「免费」')
    const nu = newUser({ points: 0, food: 0 })
    const s2 = await points.summary(nu)
    assert.strictEqual(s2.waived, false)
    assert.strictEqual(s2.recognize.waived, false)
  })

  console.log('\n' + '='.repeat(52))
  if (failures.length) {
    console.log('失败 ' + failures.length + ' 项 / 通过 ' + passed + ' 项')
    failures.forEach(f => {
      console.log('\n✗ ' + f.name)
      console.log(f.err && f.err.stack ? f.err.stack.split('\n').slice(0, 4).join('\n') : f.err)
    })
    process.exit(1)
  }
  console.log('全部通过：' + passed + ' 项')
}

main().catch(e => {
  console.error('测试脚本异常：', e)
  process.exit(1)
})
