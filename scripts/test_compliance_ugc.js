/**
 * 合规改造行为级测试（2026-10-16 审核驳回「社交-笔记」类目）
 *
 * 驳回原文：「涉及用户自行生成内容（文字、图片、音/视频）的记录、分享，
 *          属社交-笔记范畴，为个人主体小程序未开放类目。」
 *
 * 本项目选定的应对路线（见 docs/审核驳回应对方案.md）：
 *   把「用户写笔记」改造成「用户登记结构化的猫况记录」——
 *   同样是记录，但形态从"创作/发布"变成"登记/查询"，与「工具-信息查询」类目相符。
 *
 * 本测试锁死三条防线，防止后续迭代把社交特征又加回来：
 *  ① 打卡页**不得有自由文本创作入口**（textarea + 诱导性 placeholder）
 *  ② 对外（非社团成员）**不得下发用户生成内容**（note / photos / 上报人）
 *  ③ 行为标签是**白名单枚举**，前后端两份必须逐值对齐
 *
 * 运行：node scripts/test_compliance_ugc.js
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
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const sightWxml = read('miniprogram/pages/sighting-post/sighting-post.wxml')
const sightJs = read('miniprogram/pages/sighting-post/sighting-post.js')
const constJs = read('miniprogram/utils/const.js')
const cfIndex = read('cloudfunctions/catcampus/index.js')
const coreJs = read('cloudfunctions/catcampus/lib/core.js')

/* ==================== ① 打卡页：无自由文本创作入口 ==================== */
console.log('\n--- 1. 打卡页不含自由文本创作入口 ---')

assert('打卡页已移除 textarea（自由长文）', !/<textarea/.test(sightWxml),
  '还有 textarea —— 用户可自由创作长文，构成"笔记"形态')
assert('打卡页无诱导性创作 placeholder', !/它在做什么？精神状态如何？/.test(sightWxml),
  '还有引导用户写描述的 placeholder')
assert('打卡页改用结构化标签多选', /tag-picker/.test(sightWxml) && /behaviorOptions/.test(sightWxml))
assert('标签选中态由 JS 预计算 item.on 驱动', /\{\{item\.on \? 'on' : ''\}\}/.test(sightWxml))
// WXML mustache 编译期白名单：不支持方法调用，否则整段静默退化为 false
assert('标签显隐未用 mustache 方法调用', !/\{\{[^}]*\w+\s*\([^}]*\}\}/.test(sightWxml))
assert('补充输入限制在 20 字以内', /maxlength="20"/.test(sightWxml),
  '补充框没有 maxlength 限制 —— 等于又开了长文入口')
assert('补充输入用 input 而非 textarea', /补充/.test(sightWxml) && !/补充[\s\S]{0,200}<textarea/.test(sightWxml))

/* ==================== ② 对外不下发用户生成内容 ==================== */
console.log('\n--- 2. 对外脱敏：不下发 UGC ---')

assert('sanitizeSighting 存在', /function sanitizeSighting/.test(coreJs))
// 非成员分支必须删掉这四类字段
const sanFn = coreJs.slice(coreJs.indexOf('function sanitizeSighting'), coreJs.indexOf('function sanitizeSighting') + 1400)
assert('对外删除 note（用户文字）', /delete out\.note/.test(sanFn))
assert('对外删除 photos（用户图片）', /delete out\.photos/.test(sanFn))
assert('对外删除 reporter（身份）', /delete out\.reporter\b/.test(sanFn))
assert('对外删除 reporterName', /delete out\.reporterName/.test(sanFn))
assert('对外仍保留 health/feedStatus（结构化聚合信息）',
  !/delete out\.health/.test(sanFn) && !/delete out\.feedStatus/.test(sanFn))
assert('成员仍可见全字段（成员分支提前返回）',
  /if \(isMember\(user\)\) return s/.test(sanFn))
assert('对外仍做点位模糊', /blurLocation/.test(sanFn))

/* ==================== ③ 行为标签白名单前后端对齐 ==================== */
console.log('\n--- 3. 行为标签白名单一致性 ---')

// 前端枚举
const m = constJs.match(/SIGHT_BEHAVIOR:\s*\[([\s\S]*?)\n\s*\]/)
assert('const.js 定义了 SIGHT_BEHAVIOR', !!m)
const feVals = m ? [...m[1].matchAll(/value:\s*'([a-zA-Z]+)'/g)].map(x => x[1]) : []
assert('前端行为标签非空', feVals.length >= 6, feVals.length)

// 云端白名单
const cm = cfIndex.match(/SIGHT_BEHAVIOR_VALUES\s*=\s*\[([\s\S]*?)\]/)
assert('云端定义 SIGHT_BEHAVIOR_VALUES', !!cm)
const beVals = cm ? [...cm[1].matchAll(/'([a-zA-Z]+)'/g)].map(x => x[1]) : []

assert('前后端行为标签逐值一致', JSON.stringify(feVals) === JSON.stringify(beVals),
  { 前端: feVals, 后端: beVals })
assert('云端对 behaviors 做白名单过滤', /behaviors\s*=\s*Array\.isArray\(d\.behaviors\)[\s\S]{0,160}indexOf\(b\)\s*>=\s*0/.test(cfIndex),
  '直接存 d.behaviors —— 客户端可篡改塞入任意字符串')
assert('云端对 behaviors 数量封顶', /\.slice\(0,\s*8\)/.test(cfIndex))

// 标签文案不得含主观评价/情绪词（否则又回到"创作"形态）
const SUBJECTIVE = ['可爱', '漂亮', '好看', '萌', '治愈', '温暖', '想念', '心疼', '舍不得']
const labelTexts = m ? [...m[1].matchAll(/label:\s*'([^']+)'/g)].map(x => x[1]) : []
const subjective = labelTexts.filter(t => SUBJECTIVE.some(w => t.includes(w)))
assert('行为标签无主观/情绪化词汇', subjective.length === 0, subjective)

/* ==================== ④ 云端 note 长度兜底 ==================== */
console.log('\n--- 4. 云端字段长度兜底 ---')
assert('云端 note 截断到 20 字', /note:\s*String\(d\.note \|\| ''\)\.slice\(0,\s*20\)/.test(cfIndex),
  '云端未截断 —— 老客户端仍可传长文本绕过前端限制')
assert('云端仍存 behaviors 字段', /behaviors,/.test(cfIndex))

/* ==================== ⑤ 合规说明文档存在 ==================== */
console.log('\n--- 5. UGC 页面不得具备分享能力 ---')
// 「分享」是让「用户生成内容」升级为「公开发布传播」的最后一块拼图 ——
// 审核文案里的「记录、**分享**」正是这条。UGC 承载页一律不接分享。
const UGC_PAGES = ['sighting-post/sighting-post', 'cat-edit/cat-edit', 'tnr-edit/tnr-edit']
UGC_PAGES.forEach(p => {
  const src = read('miniprogram/pages/' + p + '.js')
  assert('UGC 页 ' + p + ' 未接分享（避免构成传播）', !/shareBehavior/.test(src),
    'UGC 承载页接了分享 —— 直接把"用户内容"变成"公开发布传播"')
})

// 反例护栏：官方信息页保留分享是合规的（分享的是官方维护的数据，不是用户生成内容）
const OFFICIAL_PAGES = ['index/index', 'cats/cats', 'map/map', 'cat-detail/cat-detail']
OFFICIAL_PAGES.forEach(p => {
  const src = read('miniprogram/pages/' + p + '.js')
  assert('官方信息页 ' + p + ' 保留分享', /shareBehavior/.test(src))
})

/* ==================== ⑥ 合规说明文档存在 ==================== */
console.log('\n--- 6. 应对方案文档 ---')
assert('存在《审核驳回应对方案》文档', fs.existsSync(path.join(ROOT, 'docs/审核驳回应对方案.md')))
const doc = read('docs/审核驳回应对方案.md')
assert('文档识别出驳回不是误判', /不是误判/.test(doc))
assert('文档给出三条路线（改形态/删功能/换主体）',
  /路线 A/.test(doc) && /路线 B/.test(doc) && /路线 C/.test(doc))
assert('文档提醒个人主体开不了微信支付', /微信支付/.test(doc) && /个人主体/.test(doc))
assert('文档提供提审备注模板', /功能说明/.test(doc))
assert('文档不建议点「存在误判」申诉', /不建议点这个|不建议/.test(doc))

/* ==================== ⑦ 运行时：toggleBehavior 行为 ==================== */
console.log('\n--- 7. toggleBehavior 行为 ---')
const origLoad = Module._load
let pageOpts = null
global.Page = o => { pageOpts = o }
global.getApp = () => ({ globalData: {}, ensureReady: async () => {}, callApi: async () => ({ list: [] }) })
global.wx = {
  showToast: () => {}, showLoading: () => {}, hideLoading: () => {}, showModal: () => {},
  chooseMedia: async () => ({ tempFiles: [] }), getLocation: () => {},
  cloud: { uploadFile: async () => ({ fileID: 'x' }) }
}
Module._load = function (req, p, i) {
  if (req && /\.wxml$|\.wxss$|\.json$/.test(req)) return {}
  return origLoad.apply(this, arguments)
}
try {
  require(path.join(MP, 'pages/sighting-post/sighting-post.js'))
} finally {
  Module._load = origLoad
  delete global.Page
}
assert('sighting-post.js 注册成功', !!pageOpts)
assert('提供 toggleBehavior 方法', pageOpts && typeof pageOpts.toggleBehavior === 'function')

if (pageOpts && typeof pageOpts.toggleBehavior === 'function') {
  const { C } = require(path.join(MP, 'utils/const.js'))
  const inst = Object.assign({}, pageOpts)
  inst.data = Object.assign({}, pageOpts.data)
  inst.setData = d => Object.assign(inst.data, d)
  // 初始全部未选中
  assert('初始无选中标签', inst.data.behaviors.length === 0, inst.data.behaviors)
  assert('behaviorOptions 每项带 on 字段',
    inst.data.behaviorOptions.every(o => 'on' in o), inst.data.behaviorOptions[0])

  // 选中第一个
  inst.toggleBehavior({ currentTarget: { dataset: { value: 'resting' } } })
  assert('选中后 behaviors 含该值', inst.data.behaviors.indexOf('resting') >= 0, inst.data.behaviors)
  assert('选中后该项 on=true',
    inst.data.behaviorOptions.find(o => o.value === 'resting').on === true)

  // 再点一次取消
  inst.toggleBehavior({ currentTarget: { dataset: { value: 'resting' } } })
  assert('再次点击取消选中', inst.data.behaviors.indexOf('resting') < 0, inst.data.behaviors)

  // 多选
  inst.toggleBehavior({ currentTarget: { dataset: { value: 'resting' } } })
  inst.toggleBehavior({ currentTarget: { dataset: { value: 'eating' } } })
  assert('支持多选', inst.data.behaviors.length === 2, inst.data.behaviors)
  assert('多选顺序稳定（按 options 顺序）',
    JSON.stringify(inst.data.behaviors) === JSON.stringify(['resting', 'eating']), inst.data.behaviors)

  // 非法值不炸
  inst.toggleBehavior({ currentTarget: { dataset: {} } })
  assert('无 value 时不炸且不改动', inst.data.behaviors.length === 2)

  // 不就地改原 data（避免引用比对失效）
  assert('toggleBehavior 产出新数组（不就地改）',
    inst.data.behaviors !== pageOpts.data.behaviors)

  // 选项值必须都在白名单内
  assert('前端选项值均属 SIGHT_BEHAVIOR', inst.data.behaviorOptions.every(o => feVals.indexOf(o.value) >= 0))
}

console.log('\n=== 结果 ===')
console.log('PASS ' + pass + ' / FAIL ' + fail)
if (failures.length) { console.log('\n失败项：'); failures.forEach(f => console.log('  - ' + f)) }
process.exit(fail ? 1 : 0)
