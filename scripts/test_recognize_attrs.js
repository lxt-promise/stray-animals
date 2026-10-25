/**
 * 识别结果「花色」契约测试（2026-10-17）
 *
 * 背景：识别服务现在会返回品种 / 毛色 / 花纹（CLIP 没装也走本地色域分析）。
 * 云函数要把这些字段**原样透传**给前端，前端才有东西可展示。
 * 这里锁死三件事：
 *   1. normalizeFeatures 透传 breed / attrSource，且不伪造属性；
 *   2. identifiedFlag 的判定口径（服务端优先、老服务端按 LOW_CONF 兜底）；
 *   3. 识别页模板用的是预计算字段，不含 mustache 白名单之外的表达式
 *      （`map/join/String()` 会被静默忽略、整段退化成 false）。
 *
 * 运行：node scripts/test_recognize_attrs.js
 */
const Module = require('module')
const path = require('path')
const fs = require('fs')

/* ============ 最小桩：vision.js 加载期只 require 这三个 ============ */
const coreStub = {
  cloud: {},
  db: {},
  _: {
    in: v => v, nin: v => v, gte: v => v, lte: v => v, lt: v => v, gt: v => v,
    neq: v => v, or: v => v, inc: v => v, push: v => v
  },
  COL: { CATS: 'cats', AI_TASKS: 'ai_tasks' },
  AppError: class AppError extends Error {
    constructor(msg, code) { super(msg); this.code = code || 500 }
  },
  distanceM: () => 0,
  cosine: () => 0,
  warmCollection: () => {}
}

const origLoad = Module._load
Module._load = function (req, parent, isMain) {
  if (req === './core') return coreStub
  if (req === './security') return { checkMedia: async () => ({ pass: true }) }
  if (req === './points') return { addPoints: async () => {} }
  return origLoad.apply(this, arguments)
}

const ROOT = path.resolve(__dirname, '..')
const vision = require(path.join(ROOT, 'cloudfunctions/catcampus/lib/vision.js'))

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) } else {
    fail++
    console.log('  FAIL  ' + name)
    if (extra !== undefined) console.log('        ' + JSON.stringify(extra))
  }
}

/* ============ 1. 属性透传 ============ */
console.log('\n--- 1. normalizeFeatures 透传花色字段 ---')
{
  const f = vision.normalizeFeatures({
    color: 'orange',
    pattern: 'tabby',
    breed: '橘狸花',
    attrSource: 'heuristic',
    confidence: 0.78,
    tags: [{ k: '品种', v: '橘狸花' }, { k: '毛色', v: '橘猫' }, { k: '花纹', v: '虎斑条纹' }]
  })
  ok('breed 透传', f.breed === '橘狸花', f)
  ok('attrSource 透传', f.attrSource === 'heuristic', f)
  ok('color/pattern 原样保留', f.color === 'orange' && f.pattern === 'tabby', f)
  ok('tags 不被覆盖', f.tags.length === 3 && f.tags[0].v === '橘狸花', f.tags)
  ok('confidence 保留', f.confidence === 0.78, f.confidence)
}

/* ============ 2. 缺字段不伪造 ============ */
console.log('\n--- 2. 缺字段不伪造 ---')
{
  const f = vision.normalizeFeatures({ color: '', pattern: '', tags: [] })
  ok('breed 缺失给空串而不是 undefined', f.breed === '', f)
  ok('attrSource 缺失给空串', f.attrSource === '', f)
  ok('没有属性就不补「未知」标签', f.tags.length === 0, f.tags)

  const none = vision.normalizeFeatures(null)
  ok('null 输入不炸', none && none.tags.length === 0, none)
}

/* ============ 3. 老第三方：有 color 无 tags 时补标签 ============ */
console.log('\n--- 3. 老第三方兼容 ---')
{
  const f = vision.normalizeFeatures({ color: 'orange', pattern: 'tabby' })
  ok('没有 tags 但有属性 → 补两条', f.tags.length === 2, f.tags)
  ok('补的标签用原值（枚举，不是中文）', f.tags[0].v === 'orange', f.tags)
}

/* ============ 4. embedding 透传 ============ */
console.log('\n--- 4. embedding ---')
{
  const f = vision.normalizeFeatures({ embedding: [0.1, 0.2] })
  ok('数组透传', Array.isArray(f.embedding) && f.embedding.length === 2, f)
  const g = vision.normalizeFeatures({ embedding: [] })
  ok('空数组不写进结果', g.embedding === undefined, g)
}

/* ============ 5. identifiedFlag 判定口径 ============ */
console.log('\n--- 5. identifiedFlag ---')
{
  ok('服务端说 true 就是 true', vision.identifiedFlag({ identified: true }, []) === true)
  ok('服务端说 false 就是 false（哪怕有高分候选）',
    vision.identifiedFlag({ identified: false }, [{ score: 90 }]) === false)
  ok('老服务端无该字段 → 分数 ≥ LOW_CONF 视为认出',
    vision.identifiedFlag({}, [{ score: vision.LOW_CONF }]) === true)
  ok('老服务端无该字段 → 低分视为没认出',
    vision.identifiedFlag({}, [{ score: vision.LOW_CONF - 1 }]) === false)
  ok('无候选视为没认出', vision.identifiedFlag({}, []) === false)
  ok('meta 为空也不炸', vision.identifiedFlag(null, [{ score: 99 }]) === true)
}

/* ============ 6. 前端模板契约 ============ */
console.log('\n--- 6. 识别页模板 ---')
{
  const wxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/recognize/recognize.wxml'), 'utf8')
  const js = fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/recognize/recognize.js'), 'utf8')

  ok('模板用预计算的 attrHint', /\{\{result\.attrHint\}\}/.test(wxml))
  ok('模板用预计算的 guessTitle', /\{\{result\.guessTitle\}\}/.test(wxml))
  ok('模板用预计算的 attrText', /\{\{result\.attrText\}\}/.test(wxml))
  ok('不再有「本次未启用毛色」的过时说明', !/本次未启用毛色/.test(wxml))

  // mustache 白名单：这些写法会被编译期静默忽略
  const mustaches = wxml.match(/\{\{[^}]*\}\}/g) || []
  const bad = mustaches.filter(m => /\.(map|filter|join|indexOf|includes)\(/.test(m))
  ok('模板里没有 map/join/indexOf 这类表达式', bad.length === 0, bad)

  ok('JS 定义了 decorate()', /decorate\s*\(\s*result\s*\)/.test(js))
  ok('withPhotoUrls 会合并 decorate 的结果', /this\.decorate\(result\)/.test(js))
  // 模板直接遍历 result.features.tags 是安全的（服务端已给出中文）
  ok('特征卡仍遍历 tags', /result\.features\.tags/.test(wxml))
}

/* ============ 7. 候选子行的两个分数口径 ============ */
// 现场：候选行右侧是 99%，下面写着「特征相似度 100.0%」，看起来像算错了。
// 其实是两个刻度：99 是展示分（余弦按 0.75~0.90 拉伸到 0~99 并封顶），
// 100.0% 是原始余弦。端点必须显式说明，否则用户会怀疑结果。
console.log('\n--- 7. candidateReason 口径 ---')
{
  ok('原始 1.0（展示分封顶）→ 明确写出封顶',
    vision.candidateReason(99, 1.0, '特征相似度 100.0%') === '原始相似度 100.0% · 展示分封顶 99',
    vision.candidateReason(99, 1.0, '特征相似度 100.0%'))
  ok('原始 0.74（低于匹配线）→ 说明为什么是 0',
    vision.candidateReason(0, 0.74, '特征相似度 74.0%') === '原始相似度 74.0% · 低于匹配线',
    vision.candidateReason(0, 0.74, '特征相似度 74.0%'))
  ok('中间段只留原始值（不啰嗦）',
    vision.candidateReason(67, 0.85, '特征相似度 85.0%') === '原始相似度 85.0%',
    vision.candidateReason(67, 0.85, '特征相似度 85.0%'))
  ok('老服务端没 rawSim → 原样返回，不伪造 0%',
    vision.candidateReason(67, undefined, '特征相似度 85.0%') === '特征相似度 85.0%')
  ok('本地兜底的理由（花纹一致）不被改写',
    vision.candidateReason(70, 0.9, '花纹一致·毛色吻合') === '花纹一致·毛色吻合')
  ok('rawSim 为 0 / NaN 一律原样返回',
    vision.candidateReason(0, 0, '特征相似度 0%') === '特征相似度 0%' &&
    vision.candidateReason(0, NaN, '特征相似度 0%') === '特征相似度 0%')
  // 2026-10-24：校准换成 logistic 后，同猫换照片典型只有 55~70 分。
  // 光有「原始 76.3%」用户会问「那为什么只给 55」——Top1 必须补一句领先幅度，
  // 它回答的是另一个问题：排第一说明什么。
  ok('Top1 带领先幅度 → 补一句「领先次名」',
    vision.candidateReason(55, 0.763, '特征相似度 76.3%', 0.065)
      === '原始相似度 76.3% · 领先次名 6.5%',
    vision.candidateReason(55, 0.763, '特征相似度 76.3%', 0.065))
  ok('没有 lead（老服务端 / 无次名）→ 不多嘴',
    vision.candidateReason(55, 0.763, '特征相似度 76.3%') === '原始相似度 76.3%' &&
    vision.candidateReason(55, 0.763, '特征相似度 76.3%', 0) === '原始相似度 76.3%')
  // 阈值必须与服务端 identifyMin 同口径：两边不同值会出「服务端说认出来了、
  // 云函数说低置信」这种自相矛盾的界面。
  ok('LOW_CONF 与服务端 identifyMin 同为 45', vision.LOW_CONF === 45, vision.LOW_CONF)
  ok('文案里不出现「AI」字样（合规）', !/AI/.test(vision.candidateReason(99, 1, '特征相似度 100%')))
}

/* ============ 8. shapeCandidates：幽灵档案与低于匹配线的候选 ============ */
// 现场反馈：候选里出现一只「未知」的猫（名字空、头像空）。
// 根因：删除档案后特征库向量残留（index/<catId>.bin 不跟着删），
// 服务端检索把幽灵 id 返回来，byId 查不到 → 名字兜成「未知」。
console.log('\n--- 8. shapeCandidates 过滤 ---')
{
  const byId = {
    cow1: { id: 'cow1', name: '奶牛猫', photo: 'p1.jpg' },
    milk: { id: 'milk', name: '小奶牛', photo: 'p2.jpg' }
  }
  const raw = [
    { catId: 'cow1', score: 55, rawSim: 0.833, reason: '特征相似度 83.3%' },
    { catId: 'ghost_deleted', score: 4, rawSim: 0.755, reason: '特征相似度 75.5%' },  // 幽灵
    { catId: 'milk', score: 4, rawSim: 0.755, reason: '特征相似度 75.5%' },
    { catId: 'cow1', score: 0, rawSim: 0.62, reason: '特征相似度 62.0%' }             // 低于匹配线
  ]
  const out = vision.shapeCandidates(raw, byId)
  ok('幽灵候选（档案已删）不进列表', !out.some(c => c.catId === 'ghost_deleted'), out.map(c => c.catId))
  ok('展示分 ≤0（低于匹配线）不进列表', out.every(c => c.score > 0), out.map(c => c.score))
  ok('正常候选保留且名字来自档案', out.some(c => c.catId === 'milk' && c.name === '小奶牛'), out)
  ok('排序按分数降序', out[0].catId === 'cow1' && out[0].score === 55, out[0])
  ok('截断到 TOP_N', vision.shapeCandidates(
    Array.from({ length: 12 }, (_, i) => ({ catId: 'cow1', score: 50 + i })),
    byId).length <= vision.TOP_N)

  // 候选最多 2 条（2026-10-25）：第 3 名往后展示分是个位数，对用户没有决策价值。
  // 必须与服务端 config.TOP_N 同值 —— 两边各写一个数字会让候选数量随引擎状态跳变。
  ok('TOP_N 为 2', vision.TOP_N === 2, vision.TOP_N)
  {
    // 5 只真实候选全部过匹配线：界面上只该出现前 2 只
    const many = Array.from({ length: 5 }, (_, i) => ({
      catId: 'cow1', score: 90 - i * 5, rawSim: 0.9 - i * 0.02, reason: ''
    }))
    const cut = vision.shapeCandidates(many, byId)
    ok('5 条候选只留 2 条', cut.length === 2, cut.length)
    ok('留下的是分数最高的两条', cut[0].score === 90 && cut[1].score === 85, cut.map(c => c.score))
  }

  ok('raw 为空 / 非数组 → 空列表不炸',
    vision.shapeCandidates(null, byId).length === 0 && vision.shapeCandidates('x', byId).length === 0)
  // 入参只信 byId：即使服务端塞了 name，幽灵也进不来
  const ghost2 = vision.shapeCandidates([{ catId: 'nope', name: '伪装', score: 80 }], byId)
  ok('带名字的幽灵同样被拒', ghost2.length === 0, ghost2)
}

console.log('\n=== 结果 ===')
console.log('PASS ' + pass + ' / FAIL ' + fail)
process.exit(fail ? 1 : 0)
