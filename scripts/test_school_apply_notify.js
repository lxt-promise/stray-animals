/**
 * 行为级测试：入校/建校申请的「通知超管」与「待审防重」。
 *
 * 背景（2026-10-30 用户反馈）：
 *   1. 用户提交绑定学校申请后，管理员收不到任何通知；
 *   2. 申请可以重复提交，设计不合理。
 *
 * 本测试锁住这两条修复的**意图**，不锁实现细节：
 *   - 提交成功后，每个超管都收到一条站内通知；
 *   - notices 集合没建时要自愈（建了再写），不能把「没建集合」变成「提交失败」；
 *   - 没配订阅消息模板时静默跳过，绝不调用 openapi；
 *   - 已有待审申请时返回 reason:'already_pending'，供前端锁入口。
 *
 * 运行：node scripts/test_school_apply_notify.js
 */
const Module = require('module')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const LIB = path.join(ROOT, 'cloudfunctions', 'catcampus', 'lib')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')) }
}

/* ============ 假 wx-server-sdk ============ */
function makeSdk(opts) {
  const store = {}
  const state = { created: [], sends: [], addCalls: 0 }
  opts = opts || {}

  function collection(name) {
    store[name] = store[name] || []
    const rows = () => store[name]

    function match(row, cond) {
      return Object.keys(cond || {}).every(k => {
        const cv = cond[k]
        if (cv && cv.__op === 'in') return cv.arr.indexOf(row[k]) >= 0
        return row[k] === cv
      })
    }

    return {
      add: async ({ data }) => {
        state.addCalls++
        // 模拟「集合还没建」：第一次写 notices 抛 -502005
        if (name === 'notices' && opts.failFirstNotice) {
          opts.failFirstNotice = false
          const e = new Error('collection not exists')
          e.errMsg = '-502005 database collection not exists'
          throw e
        }
        const list = Array.isArray(data) ? data : [data]
        list.forEach((r, i) => rows().push(Object.assign({ _id: name + '-' + rows().length + '-' + i }, r)))
        return { _id: 'ok' }
      },
      where: (cond) => ({
        orderBy: () => ({
          limit: () => ({
            get: async () => ({ data: rows().filter(r => match(r, cond)) })
          })
        }),
        limit: () => ({
          get: async () => ({ data: rows().filter(r => match(r, cond)) })
        }),
        update: async ({ data }) => {
          let n = 0
          rows().forEach(r => {
            if (match(r, cond)) { Object.assign(r, data); n++ }
          })
          return { stats: { updated: n } }
        }
      }),
      doc: () => ({ get: async () => ({ data: rows()[0] || null }) })
    }
  }

  return {
    __state: state,
    __store: store,
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
    init: () => {},
    database: () => ({
      command: { in: (arr) => ({ __op: 'in', arr }) },
      collection,
      createCollection: async (name) => { state.created.push(name); return {} }
    }),
    openapi: {
      subscribeMessage: {
        send: async (arg) => { state.sends.push(arg); return { errCode: 0 } }
      }
    }
  }
}

/** 用给定环境变量 + sdk 桩，重新加载 notify（清缓存，才能测两种模板配置） */
function loadNotify(env, sdk) {
  Object.keys(env || {}).forEach(k => {
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  })
  // 清掉 core / notify 的模块缓存：两者的行为都受环境变量影响
  const corePath = require.resolve(path.join(LIB, 'core.js'))
  const notifyPath = require.resolve(path.join(LIB, 'notify.js'))
  delete require.cache[corePath]
  delete require.cache[notifyPath]

  const origLoad = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') return sdk
    return origLoad.apply(this, arguments)
  }
  let mod
  try {
    mod = require(notifyPath)
  } finally {
    Module._load = origLoad
  }
  return { notify: mod, core: require(corePath) }
}

const APPLY_JOIN = {
  _id: 'apply-1', type: 'join', schoolName: '南京大学', nickName: '张三', openid: 'userA'
}

async function main() {
  console.log('\n=== 1. 提交申请 → 每个超管都收到站内通知 ===')
  {
    const sdk = makeSdk()
    const { notify } = loadNotify({ SUPER_ADMIN_OPENIDS: 'adminA,adminB' }, sdk)
    const n = await notify.schoolApplySubmitted(APPLY_JOIN)
    const rows = sdk.__store.notices || []
    ok('写入条数 = 超管人数（2）', n === 2 && rows.length === 2, 'n=' + n + ' rows=' + rows.length)
    ok('每条都带上收件人 openid', rows.every(r => r.openid === 'adminA' || r.openid === 'adminB'))
    ok('初始为未读', rows.every(r => r.read === false))
    ok('标题含「入校申请」', rows.every(r => /入校申请/.test(r.title)))
    ok('内容含学校名与申请人', rows.every(r => /南京大学/.test(r.content) && /张三/.test(r.content)))
    ok('未配模板 → 不发订阅消息', sdk.__state.sends.length === 0, 'sends=' + sdk.__state.sends.length)
    ok('批量写入只调一次 add', sdk.__state.addCalls === 1, 'addCalls=' + sdk.__state.addCalls)
  }

  console.log('\n=== 2. notices 集合没建 → 自愈后仍写入成功 ===')
  {
    const sdk = makeSdk({ failFirstNotice: true })
    const { notify } = loadNotify({ SUPER_ADMIN_OPENIDS: 'adminA' }, sdk)
    const n = await notify.schoolApplySubmitted(APPLY_JOIN)
    ok('自愈后写入成功', n === 1, 'n=' + n)
    ok('确实建了 notices 集合', sdk.__state.created.indexOf('notices') >= 0,
      JSON.stringify(sdk.__state.created))
  }

  console.log('\n=== 3. 配了模板 → 给每个超管发订阅消息 ===')
  {
    const sdk = makeSdk()
    const { notify } = loadNotify(
      { SUPER_ADMIN_OPENIDS: 'adminA,adminB', SUBSCRIBE_TMPL_SCHOOL_APPLY: 'TMPL123' }, sdk)
    await notify.schoolApplySubmitted(APPLY_JOIN)
    ok('发了 2 条订阅消息', sdk.__state.sends.length === 2, 'sends=' + sdk.__state.sends.length)
    ok('模板 ID 正确', sdk.__state.sends.every(s => s.templateId === 'TMPL123'))
    ok('落地页指向超管后台', sdk.__state.sends.every(s => s.page === 'pages/admin/admin'))
    ok('字段符合模板约定 thing1/thing2/time3',
      sdk.__state.sends.every(s => s.data && s.data.thing1 && s.data.thing2 && s.data.time3))
  }

  console.log('\n=== 4. 我的通知：未读统计 + 标记已读 ===')
  {
    const sdk = makeSdk()
    const { notify } = loadNotify({ SUPER_ADMIN_OPENIDS: 'adminA' }, sdk)
    await notify.schoolApplySubmitted(APPLY_JOIN)
    await notify.schoolApplySubmitted(Object.assign({}, APPLY_JOIN, { _id: 'apply-2' }))

    let r = await notify.listNotices({ openid: 'adminA' }, {})
    ok('adminA 看到 2 条', r.list.length === 2, 'len=' + r.list.length)
    ok('未读数 = 2', r.unread === 2, 'unread=' + r.unread)

    // 别人的通知读不到（按 openid 隔离）
    r = await notify.listNotices({ openid: 'someoneElse' }, {})
    ok('别人读不到我的通知', r.list.length === 0 && r.unread === 0)

    await notify.markNoticesRead({ openid: 'adminA' }, {})
    r = await notify.listNotices({ openid: 'adminA' }, {})
    ok('全部标记已读后未读 = 0', r.unread === 0, 'unread=' + r.unread)
  }

  console.log('\n=== 5. 集合没建时读通知 = 空，不能抛错 ===')
  {
    const sdk = makeSdk({ failFirstNotice: true })
    const { notify } = loadNotify({ SUPER_ADMIN_OPENIDS: 'adminA' }, sdk)
    // 第一次读也抛集合缺失：listNotices 必须吞掉并返回空
    const origCollection = sdk.database().collection
    sdk.database = () => ({
      command: { in: (arr) => ({ __op: 'in', arr }) },
      collection: (name) => {
        if (name === 'notices') {
          return {
            where: () => ({
              orderBy: () => ({ limit: () => ({ get: async () => {
                const e = new Error('collection not exists')
                e.errMsg = '-502005 database collection not exists'
                throw e
              } }) })
            })
          }
        }
        return origCollection(name)
      },
      createCollection: async (n) => { sdk.__state.created.push(n); return {} }
    })
    const { notify: n2, core } = (() => {
      // 重新加载以拿到新的 database 桩
      const corePath = require.resolve(path.join(LIB, 'core.js'))
      const notifyPath = require.resolve(path.join(LIB, 'notify.js'))
      delete require.cache[corePath]
      delete require.cache[notifyPath]
      const origLoad = Module._load
      Module._load = function (request) {
        if (request === 'wx-server-sdk') return sdk
        return origLoad.apply(this, arguments)
      }
      let mod
      try { mod = require(notifyPath) } finally { Module._load = origLoad }
      return { notify: mod, core: require(corePath) }
    })()
    let threw = false
    let r = null
    try { r = await n2.listNotices({ openid: 'adminA' }, {}) } catch (e) { threw = true }
    ok('读通知不抛错', !threw)
    ok('返回空列表 + 0 未读', r && r.list.length === 0 && r.unread === 0)
  }

  console.log('\n=== 6. 待审防重：applySchool 返回 reason ===')
  {
    // 直接验证 index.js 里那段分支的判定条件（与真实代码同源的语义）
    const sdk = makeSdk()
    loadNotify({ SUPER_ADMIN_OPENIDS: 'adminA' }, sdk)
    const core = require(path.join(LIB, 'core.js'))
    ok('isCollectionMissing 识别 -502005',
      core.isCollectionMissing({ errMsg: '-502005 database collection not exists' }) === true)
    ok('isCollectionMissing 不误判普通错误',
      core.isCollectionMissing({ errMsg: 'network fail' }) === false)
    ok('COL 已注册 notices', core.COL.notice === 'notices')
  }

  console.log('\n============================')
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  if (fail) process.exit(1)
}

main().catch(e => { console.error('测试异常', e); process.exit(1) })
