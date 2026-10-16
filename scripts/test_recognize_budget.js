#!/usr/bin/env node
/**
 * 识别链路 3s 预算 + 图片缩略降级 行为级测试（2026-10-15 ④）
 *
 * 现场（用户上传「另一只猫」，没匹配上）：
 *   ① -504003 Invoking task timed out after 3 seconds —— 同步快路径超时
 *   ② [渲染层网络层错误] Failed to load image
 *      https://.../cats/1792074374248-539.jpg?sign=...&imageMogr2/thumbnail/200x
 *   ② 的 URL 里出现 cats/ 而识别上传路径是 recognize/ —— 说明这张图来自
 *      候选猫头像（别人的档案照），不是本次上传的素材。
 *
 * 本测试台只覆盖两块**纯逻辑**（不依赖云环境）：
 *
 *  A. recognize.js pollResult 的收敛保护
 *     旧写法：单次 -504003 抛错 → transient++（最多重试 8 次）→ 8×2s=16s 后直接判死。
 *     但 -504003 对轮询**根本不是失败**：任务已落库、分步续跑、租约到期下轮接管，
 *     只要继续轮询终局一定会到。把「后台还在干活」当故障，就是干等 16 秒然后报错。
 *     新写法：连败不再直接抛错，而是走「慢速长尾」——降低频率 + 拉长总时长 + 带重启兜底。
 *
 *  B. photo.js 缩略参数在「带签名的临时链接」上的降级
 *     现场证据：不带 imageMogr2 的那条也被报 Failed to load image，
 *     说明失败根因不在参数拼接，而在「这条临时链接本身不可用/已过期」。
 *     所以必须补一条：临时链接失效 → 用 fileID 重新换链 → 换到新的再重试。
 *
 * 跑法：node scripts/test_recognize_budget.js
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
let passed = 0
const skipped = []

function ok(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name) })
    .catch(e => { console.error('  ✗ ' + name + '\n    ' + (e && e.message)); process.exitCode = 1 })
}

/* ==================================================================
 *  A. pollResult：-504003 不再被判死
 * ================================================================== */

/**
 * 加载 recognize.js 的 Page 定义。
 * 用 stub 替换 app / util / photo —— 只测轮询编排逻辑，不起真的 setData。
 */
function loadRecognizePage(opts) {
  const o = opts || {}
  const p = path.join(ROOT, 'miniprogram/pages/recognize/recognize.js')
  delete require.cache[require.resolve(p)]

  const origLoad = require('module')._load
  const stubUtil = path.join(ROOT, 'miniprogram/utils/util.js')
  const stubPhoto = path.join(ROOT, 'miniprogram/utils/photo.js')
  const origUtil = require.cache[require.resolve(stubUtil)]
  const origPhoto = require.cache[require.resolve(stubPhoto)]

  let pageDef = null
  // Page 是全局函数：截获定义
  // eslint-disable-next-line no-undef
  global.Page = def => { pageDef = def }
  global.getApp = () => ({
    callApi: (action, payload) => o.callApi(action, payload),
    globalData: { myLocation: null },
    ensureReady: () => Promise.resolve()
  })
  // util.js / photo.js 直接给最小实现（本测试不关心它们）
  // ⚠️ shareBehavior 必须提供：recognize.js 用 `Page(Object.assign({...}, shareBehavior(...)))`，
  //    缺了会在加载期直接抛 "shareBehavior is not a function"，把整个页面定义打挂。
  require.cache[require.resolve(stubUtil)] = { id: stubUtil, filename: stubUtil, loaded: true,
    exports: { showBusy() {}, hideBusy() {}, formatTime: () => 't', shareBehavior: () => ({}) } }
  require.cache[require.resolve(stubPhoto)] = { id: stubPhoto, filename: stubPhoto, loaded: true,
    exports: { hydrateCats: l => l, thumb: u => u, resolve: (x) => Promise.resolve(x) } }
  try {
    require(p)
  } finally {
    delete global.Page
    delete global.getApp
    if (origUtil) require.cache[require.resolve(stubUtil)] = origUtil
    else delete require.cache[require.resolve(stubUtil)]
    if (origPhoto) require.cache[require.resolve(stubPhoto)] = origPhoto
    else delete require.cache[require.resolve(stubPhoto)]
    void origLoad
  }
  if (!pageDef) throw new Error('未能加载 recognize.js 的 Page 定义')
  // 造一个假页面实例：只有 setData / data 就够 pollResult 用
  const inst = Object.assign({}, pageDef)
  inst.data = Object.assign({}, pageDef.data)
  inst.setData = function (patch) {
    Object.keys(patch || {}).forEach(k => {
      // 只支持本次用到的「直接键」写法
      if (k.indexOf('.') < 0) this.data[k] = patch[k]
    })
  }
  return inst
}

async function runA() {
  console.log('—— A. pollResult 收敛保护 ——')

  await ok('-504003 连败不再 8 次判死：达到旧阈值后仍继续轮询直到 done', async () => {
    let calls = 0
    const page = loadRecognizePage({
      callApi: () => {
        calls++
        // 前 12 次全部是客户端超时（旧代码在第 8 次就抛「识别服务暂不可用」）
        if (calls <= 12) return Promise.reject(new Error('errCode: -504003 Invoking task timed out after 3 seconds'))
        return Promise.resolve({ status: 'done', result: { candidates: [] } })
      }
    })
    // 把 sleep 压到 0：测试不真的等 2s×N
    const origSetTimeout = global.setTimeout
    global.setTimeout = (fn) => origSetTimeout(fn, 0)
    let r
    try {
      r = await page.pollResult('task_1')
    } finally {
      global.setTimeout = origSetTimeout
    }
    assert.ok(r && r.status === 'done', '应轮询到终局，实际 ' + JSON.stringify(r))
    assert.ok(calls > 12, '连败 12 次后仍要继续（旧逻辑 8 次即判死），实际轮次 ' + calls)
  })

  await ok('明确 failed 立即终止，不做无谓重试', async () => {
    let calls = 0
    const page = loadRecognizePage({
      callApi: () => { calls++; return Promise.resolve({ status: 'failed', error: '素材未通过安全检测' }) }
    })
    await assert.rejects(() => page.pollResult('t'), /未通过安全检测/)
    assert.strictEqual(calls, 1, 'failed 只应请求一次，实际 ' + calls)
  })

  await ok('非超时类硬错误（无权访问）快速失败，不空转到超时', async () => {
    let calls = 0
    const page = loadRecognizePage({
      callApi: () => { calls++; return Promise.reject(new Error('无权访问该任务')) }
    })
    const origSetTimeout = global.setTimeout
    global.setTimeout = (fn) => origSetTimeout(fn, 0)
    try {
      await assert.rejects(() => page.pollResult('t'), /无权访问该任务|识别服务暂不可用/)
    } finally {
      global.setTimeout = origSetTimeout
    }
    assert.ok(calls <= 4, '硬错误应尽快失败，实际轮次 ' + calls)
  })

  await ok('正常推进（pending → done）不受影响', async () => {
    const seq = [
      { status: 'pending', progress: 30 },
      { status: 'pending', progress: 55 },
      { status: 'done', result: { candidates: [{ catId: 'c1' }] } }
    ]
    let i = 0
    const page = loadRecognizePage({ callApi: () => Promise.resolve(seq[i++]) })
    const origSetTimeout = global.setTimeout
    global.setTimeout = (fn) => origSetTimeout(fn, 0)
    let r
    try { r = await page.pollResult('t') } finally { global.setTimeout = origSetTimeout }
    assert.ok(r.status === 'done' && r.result.candidates.length === 1)
    assert.strictEqual(i, 3)
  })
}

/* ==================================================================
 *  B. photo.js：临时链接失效 → 重新换链
 * ================================================================== */

function resetWx(handler) {
  global.wx = handler
}

async function runB() {
  console.log('—— B. 临时链接失效后的重换链 ——')

  const photo = require(path.join(ROOT, 'miniprogram/utils/photo.js'))

  await ok('refresh 跳过缓存，强制重新 getTempFileURL 并覆盖缓存', async () => {
    let n = 0
    resetWx({
      platform: 'ios',
      cloud: {
        getTempFileURL({ fileList }) {
          n++
          return Promise.resolve({
            fileList: fileList.map(id => ({
              fileID: id, status: 0,
              tempFileURL: 'https://' + id.slice(8) + '.tcb.qcloud.la/f.jpg?sign=v' + n + '&t=' + n
            }))
          })
        }
      }
    })
    const { refresh } = require(path.join(ROOT, 'miniprogram/utils/photo.js'))
    assert.strictEqual(typeof refresh, 'function', 'photo.js 应导出 refresh')
    // 先走正常 warm 建立缓存
    const p = path.join(ROOT, 'miniprogram/utils/photo.js')
    delete require.cache[require.resolve(p)]
    const fresh = require(p)
    await fresh.warm(['cloud://ok-refresh'])
    const v1 = fresh.cachedUrl('cloud://ok-refresh')
    assert.ok(/sign=v1/.test(v1), '首次换链应写缓存，实际 ' + v1)
    // warm 再调：命中缓存不发请求
    const before = n
    await fresh.warm(['cloud://ok-refresh'])
    assert.strictEqual(n, before, 'warm 命中缓存不应再请求')
    // refresh：必须强制重发
    const v2 = await fresh.refresh('cloud://ok-refresh')
    assert.ok(n > before, 'refresh 必须真的重发请求')
    assert.ok(/sign=v2/.test(v2), 'refresh 应拿到新链接，实际 ' + v2)
    assert.strictEqual(fresh.cachedUrl('cloud://ok-refresh'), v2, 'refresh 应覆盖缓存')
  })

  await ok('refresh 对非 fileID 原样返回，不误发请求', async () => {
    let n = 0
    resetWx({ platform: 'ios', cloud: { getTempFileURL() { n++; return Promise.resolve({ fileList: [] }) } } })
    const p = path.join(ROOT, 'miniprogram/utils/photo.js')
    delete require.cache[require.resolve(p)]
    const fresh = require(p)
    assert.strictEqual(await fresh.refresh('https://x.tcb.qcloud.la/a.jpg'), 'https://x.tcb.qcloud.la/a.jpg')
    assert.strictEqual(n, 0, 'http 地址不应触发换链')
    assert.strictEqual(await fresh.refresh(''), '')
  })

  await ok('refresh 换不到时返回空串（调用方据此退占位）', async () => {
    resetWx({
      platform: 'ios',
      cloud: { getTempFileURL({ fileList }) {
        return Promise.resolve({ fileList: fileList.map(id => ({ fileID: id, status: -1, tempFileURL: '', errMsg: '文件不存在' })) })
      } }
    })
    const p = path.join(ROOT, 'miniprogram/utils/photo.js')
    delete require.cache[require.resolve(p)]
    const fresh = require(p)
    assert.strictEqual(await fresh.refresh('cloud://bad-x'), '')
  })

  await ok('thumb 断言：sign 在前、imageMogr2 在后（与官方文档一致）', () => {
    const u = photo.thumb('https://x.tcb.qcloud.la/a.jpg?sign=s&t=1', 200)
    assert.strictEqual(u, 'https://x.tcb.qcloud.la/a.jpg?sign=s&t=1&imageMogr2/thumbnail/200x')
    // 现场那条坏链：stripProcess 后应回到纯净的签名地址
    const bad = 'https://c.tcb.qcloud.la/cats/1.jpg?sign=f8f8&t=1792074376&imageMogr2/thumbnail/200x'
    assert.strictEqual(photo.stripProcess(bad), 'https://c.tcb.qcloud.la/cats/1.jpg?sign=f8f8&t=1792074376')
  })
}

/* ==================================================================
 *  C. 候选头像的 binderror 降级链（源码级契约）
 * ================================================================== */

async function runC() {
  console.log('—— C. 候选头像兜底链（源码契约） ——')

  await ok('recognize.js 的 onCandAvatarErr 在去参数失败后要重新换链', () => {
    const src = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/recognize/recognize.js'), 'utf8')
    const m = src.match(/onCandAvatarErr[\s\S]{0,1600}/)
    assert.ok(m, '找不到 onCandAvatarErr')
    const body = m[0]
    assert.ok(/photo\.resolve|refresh/.test(body), '兜底链必须包含「重新换链」这一步')
    assert.ok(!/setData\(\{[\s\S]{0,80}\.avatar['"\]]?\s*:\s*fileID/.test(body),
      '绝不能把裸 fileID 写回 src')
  })

  await ok('onCandAvatarErr 使用「重换链」而不是「回 fileID」', () => {
    const src = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/recognize/recognize.js'), 'utf8')
    const body = (src.match(/onCandAvatarErr[\s\S]{0,1600}/) || [''])[0]
    assert.ok(/c\.avatarId/.test(body) || /photo\.refresh/.test(body),
      '应能拿到原始 fileID 来重换链（avatarId 或 refresh）')
  })
}

/* ==================================================================
 *  D. 云函数：-504003 的预算纪律（源码级契约 + 数值）
 * ================================================================== */

async function runD() {
  console.log('—— D. 云函数识别预算 ——')

  const v = fs.readFileSync(path.join(ROOT, 'cloudfunctions/catcampus/lib/vision.js'), 'utf8')

  await ok('POLL_BUDGET_MS 必须明显小于客户端 3s 预算', () => {
    const m = v.match(/const POLL_BUDGET_MS\s*=\s*(\d+)/)
    assert.ok(m, '找不到 POLL_BUDGET_MS')
    const ms = Number(m[1])
    assert.ok(ms <= 2500, 'POLL_BUDGET_MS=' + ms + ' 太贴着 3000，冷启动必超')
    assert.ok(ms >= 1800, 'POLL_BUDGET_MS=' + ms + ' 太小，单步做不完会空转')
  })

  await ok('poll 的预算从 ctx.startedAt 起算（含冷启动与 getMe）', () => {
    assert.ok(/ctx\.startedAt/.test(v), '预算必须从调用入口起算')
  })

  await ok('同步路径 recognize 不含 deadline，可用满 AI_TIMEOUT_MS', () => {
    // 不传 ctx（管理端调试 / 老调用方）时，run() 应给 advance 传 undefined，
    // 也就是「预算无限」—— 与历史行为一致。
    assert.ok(/\(ctx && ctx\.deadline\)\s*\?\s*\{ deadline \}\s*:\s*undefined/.test(v),
      '未传 ctx 时 run() 必须给 advance 传 undefined（预算无限），保持管理端行为不变')
  })

  await ok('同步路径 run() 见底时主动抛「转轮询接管」，而不是被平台掐断', () => {
    const m = v.match(/async function run\(user, t, ctx\)[\s\S]{0,1400}/)
    assert.ok(m, '找不到 run(user, t, ctx)')
    const body = m[0]
    // 判据只有一个：advance 自己 defer 了（或已过 deadline）就交还。
    // 早期版本还拍了个 RUN_BAIL_MS 一刀切阈值 —— 那是错的：
    // 各步余量要求不同（①要 1500、③只要 600），一刀切既误杀能做完的收尾、
    // 又拦不住注定开不了工的。所以现在只依赖 advance 的 deferred。
    assert.ok(!/RUN_BAIL_MS/.test(body),
      'run() 不应再有 RUN_BAIL_MS 一刀切阈值（判据交给 advance 的 deferred）')
    assert.ok(/r\.deferred/.test(body), 'run() 必须依据 advance 返回的 deferred 决定交还')
    assert.ok(/转轮询接管/.test(body), '提前退出要给客户端明确的「转轮询」语义')
    assert.ok(/advance\(user, cur, syncCtx\)/.test(body), '预算上下文要透传给 advance')
  })

  await ok('runSync 从 ctx.startedAt 起算同步预算，用 SYNC_BUDGET_MS 而非 POLL_BUDGET_MS', () => {
    const m = v.match(/async function runSync\(user, event, ctx\)[\s\S]*?const result = await run\(/)
    assert.ok(m, '找不到 runSync 的预算装配')
    // 同步路径要串完三步，固定开销 ≈2.4~2.6s；复用 POLL_BUDGET_MS(2400)
    // 会让每一步刚开工就被 defer、连第一步都做不完（回归台 S1/S4 当场全红）。
    // 正确做法是 SYNC_BUDGET_MS（语义＝云函数自己能跑多久），并留平台收尾余量。
    assert.ok(/ctx\.startedAt/.test(m[0]), '同步预算必须从函数入口起算')
    assert.ok(/SYNC_BUDGET_MS/.test(m[0]), '同步路径预算应使用 SYNC_BUDGET_MS')
    assert.ok(/PLATFORM_RESERVE_MS/.test(m[0]), '必须给平台收尾留余量，别贴着 action 超时跑')
    assert.ok(!/POLL_BUDGET_MS/.test(m[0]), '同步路径不应复用 POLL_BUDGET_MS（那是轮询的单步预算）')
  })

  await ok('index.js 把 ctx 透传给 recognize（否则预算无从起算）', () => {
    const idx = fs.readFileSync(path.join(ROOT, 'cloudfunctions/catcampus/index.js'), 'utf8')
    assert.ok(/'recognize':\s*\{[^}]*vision\.runSync\(u, e, ctx\)/.test(idx),
      "recognize 必须传 ctx，否则 runSync 拿不到 startedAt")
  })

  await ok('attachPendingPhotos 保证补库不吃掉 AI 最小窗口', () => {
    const m = v.match(/function pickPendingIndexCats[\s\S]*?AI_MIN_WINDOW_MS/)
    assert.ok(m, '找不到补库预算守卫')
    assert.ok(/AI_MIN_WINDOW_MS/.test(m[0]), '补库前必须留出 AI 最小窗口')
  })

  console.log('  · 跳过（需真实云环境）：' + skipped.join(' / '))
}

;(async () => {
  await runA()
  await runB()
  await runC()
  await runD()
  console.log('\n通过 ' + passed + ' 项' + (process.exitCode ? '（有失败）' : '，0 失败'))
})()
