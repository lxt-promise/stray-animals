/**
 * 回归：「同一个素材被反复识别」—— 2026-10-25 现场。
 *
 * 现象（服务端日志）：
 *   一段 6 秒视频在 1 分钟内被请求 **10 次**，每次服务端都完整重跑
 *   （下载 → 抽 3 帧 → 检测 → 逐帧推理 ≈ 3.5s），最后一次都没用上；
 *   前端先卡在 92% 很久，最后弹「识别服务暂时不可用」。
 *
 * 机制：
 *   云函数 poll 路径的 AI 窗口 AI_POLL_CAP_MS = 1800ms（客户端 callFunction
 *   只有约 3s 预算，窗口放大不了），而视频识别服务端需要 ~3500ms。
 *   于是**每轮必然超时**：云函数 1.8s 放弃 → 服务端继续跑完 3.5s →
 *   结果被丢弃 → 下一轮又从头算。aiAttempts 耗尽后降级本地引擎。
 *
 * 修法不是放大窗口（做不到），而是让第二次调用拿到第一次的结果：
 *   服务端加结果缓存 + per-key 计算锁（app/recocache.py），
 *   云函数按 AI 窗口下发 waitMs 让后来者排队而不是各算各的。
 *
 * 本文件锁的是这条链路的**契约**：任何一环被改回去，视频会重新变成「必失败」。
 * 真刀真枪的并发/排队语义由服务端 tests/test_recocache.py 覆盖。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 220) : '')) }
}

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const visionSrc = read('cloudfunctions/catcampus/lib/vision.js')
const recoJs = read('miniprogram/pages/recognize/recognize.js')
const mainPy = read('server/app/main.py')
const cfgPy = read('server/app/config.py')
const cachePy = read('server/app/recocache.py')

console.log('\n--- 1. 服务端：结果缓存真的接进识别入口 ---')
{
  ok('config 定义 RECO_CACHE_TTL 且默认 >0', /RECO_CACHE_TTL\s*=\s*_i\(\s*"RECO_CACHE_TTL"\s*,\s*[1-9]/.test(cfgPy))
  ok('config 定义 RECO_CACHE_MAX（容量上限，防内存无限涨）', /RECO_CACHE_MAX\s*=\s*_i\(/.test(cfgPy))
  ok('main 导入 recocache 模块', /from \. import config, index_store, media, recocache/.test(mainPy))
  ok('recognize 走 get_or_compute', /recocache\.get_or_compute\(/.test(mainPy))
  ok('缓存 key 含 schoolId（两校档案不同，结果不能串）',
    /cache_key\([\s\S]{0,120}req\.schoolId/.test(mainPy))
  ok('缓存 key 含 frames（抽帧数不同结果不同）', /cache_key\([\s\S]{0,120}n_frames/.test(mainPy))
  ok('TTL<=0 时直接跳过缓存（保留关闭逃生口）', /if config\.RECO_CACHE_TTL <= 0:/.test(mainPy))
  ok('缓存命中不污染共享对象（拷贝后再补 cached/waitMs）',
    /result = dict\(result\)[\s\S]{0,160}meta\["cached"\] = True/.test(mainPy))
  ok('排队超时返回 503 而不是空结果（空结果会被当真结论）',
    /status_code=503[\s\S]{0,60}识别排队中/.test(mainPy))
  ok('meta 下发 cached，便于验证缓存是否生效', /"cached": bool\(cached\)/.test(mainPy))
  ok('/health 暴露缓存统计（排查重复识别的第一手证据）', /\*\*recocache\.stats\(\)/.test(mainPy))
}

console.log('\n--- 2. 缓存模块语义 ---')
{
  ok('per-key 计算锁存在（否则并发各算各的，CPU 翻倍且永不收敛）',
    /owner = True|owner = False/.test(cachePy) && /entry\.done\.wait\(/.test(cachePy))
  ok('计算失败不缓存（一次网络抖动不能被记住整个 TTL）', /失败不缓存|entry\.error = str\(e\)/.test(cachePy))
  ok('容量淘汰在插入前执行（写成 >cap 会差一，上限形同虚设）',
    /while cap > 0 and len\(_CACHE\) >= cap/.test(cachePy))
  ok('等待者拿不到结果时返回 (None, False) 由调用方重试',
    /return None, False/.test(cachePy))
  ok('全局锁只保护容器、不覆盖计算（否则所有识别被串行化）',
    /with _GUARD:/.test(cachePy) && !/with _GUARD:[\s\S]{0,200}compute\(\)/.test(cachePy))
}

console.log('\n--- 3. 云函数：waitMs 随 AI 窗口下发 ---')
{
  const seg = visionSrc.slice(visionSrc.indexOf('waitMs:'), visionSrc.indexOf('waitMs:') + 400)
  ok('请求体带 waitMs', /waitMs:/.test(visionSrc))
  ok('waitMs 由 aiTimeout 收缩（留回程余量，不能写死）',
    /waitMs:\s*Math\.max\(0,\s*aiTimeout\s*-\s*300\)/.test(seg), seg.slice(0, 120))
}

console.log('\n--- 4. 云函数：「排队中」按超时处理，不计入明确失败 ---')
{
  ok('排队中被视为可重试的超时', /排队中'?.test\(msg\)|排队中\/test\(msg\)|排队中/.test(visionSrc))
  const seg = visionSrc.slice(visionSrc.indexOf('const isTimeout ='), visionSrc.indexOf('const isTimeout =') + 160)
  ok('isTimeout 包含排队中（不然后 6 次就降级本地引擎）', /排队中/.test(seg), seg)
  // 关键：排队不能走 featFails（FEAT_FALLBACK_ATTEMPTS 只有 6 次）
  ok('排队不计入 featFails', /const fails = isTimeout \? featFails : featFails \+ 1/.test(visionSrc))
}

console.log('\n--- 5. 前端：等待预期与轮询节奏 ---')
{
  ok('视频模式开局就说明耗时（进度条会在 92% 停十几秒）',
    /视频处理中，约需 10~20 秒/.test(recoJs))
  ok('轮询文案区分视频（逐帧提取）', /正在逐帧提取特征并比对/.test(recoJs))
  ok('轮询文案带视频耗时提示', /视频约需 10~20 秒/.test(recoJs))
  ok('有独立的 pollGap 函数', /pollGap\(n\)/.test(recoJs))
  ok('前三轮 1.2s（固定 2s 等于每次白加 2.4s）', /n < 3 \? 1200 : 2000/.test(recoJs))
  ok('慢段仍为 3s（长尾降频）', /if \(n >= 20\) return 3000/.test(recoJs))
  ok('两处 sleep 都改用 pollGap（漏一处就前后不一致）',
    (recoJs.match(/await sleep\(this\.pollGap\(n\)\)/g) || []).length === 2)
}

console.log('\n=== 结果 ===')
console.log('PASS ' + pass + ' / FAIL ' + fail)
process.exit(fail ? 1 : 0)
