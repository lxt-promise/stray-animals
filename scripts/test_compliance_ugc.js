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
assert('打卡页无任何 input（含数字/短文本）', !/<input/.test(sightWxml),
  '还有 input —— 即便限长也仍是"用户创作文字"（数量这类数字输入已改选择器）')
assert('打卡页无诱导性创作 placeholder', !/它在做什么？精神状态如何？/.test(sightWxml),
  '还有引导用户写描述的 placeholder')
assert('打卡页改用结构化标签多选', /tag-picker/.test(sightWxml) && /behaviorOptions/.test(sightWxml))
assert('打卡页有外观特征多选', /featureOptions/.test(sightWxml) && /toggleFeature/.test(sightWxml))
assert('标签选中态由 JS 预计算 item.on 驱动', /\{\{item\.on \? 'on' : ''\}\}/.test(sightWxml))
// WXML mustache 编译期白名单：不支持方法调用，否则整段静默退化为 false
assert('标签显隐未用 mustache 方法调用', !/\{\{[^}]*\w+\s*\([^}]*\}\}/.test(sightWxml))
// 旧的「20 字补充」input 也必须移除 —— 限长只是缓解，本质仍是用户创作文字
assert('已移除「20 字补充」自由文本入口', !/maxlength="20"/.test(sightWxml),
  '还有 maxlength=20 的补充框 —— 本次合规要求是**彻底无自由文字**，不是限长')
assert('打卡页 JS 不再有 onInput 文本回调', !/onInput/.test(sightJs),
  '还有 onInput —— 说明某处仍绑定了文本输入')
assert('打卡页 JS 不再有 note 字段', !/\bnote\b/.test(sightJs.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')),
  'JS 仍在提交 note —— 自由文本通道没关干净')
assert('打卡页 JS 不再有 newCatName/catName 自由命名', !/newCatName/.test(sightJs),
  '还有"临时名字"输入 —— 用户可借起名生成文字')

/* ==================== ①b 可见性：控制台统一配置（超管专属） ==================== */
console.log('\n--- 1b. 可见性由控制台配置（打卡页无发布入口）---')

const adminWxml = read('miniprogram/pages/admin/admin.wxml')
const adminJs = read('miniprogram/pages/admin/admin.js')
const adminWxss = read('miniprogram/pages/admin/admin.wxss')

// 打卡页**不得**有可见性开关（否则等于产品提供了"一键公开"的发布能力）
assert('打卡页已移除可见性开关', !/vis-row/.test(sightWxml) && !/togglePublic/.test(sightJs),
  '打卡页还留着「谁可以看到」开关 —— 等于给用户提供了公开发布入口')
assert('打卡页无 sightingPublic 状态', !/sightingPublic/.test(sightJs))
assert('打卡页不传 public 字段', !/public:\s*this\.data\./.test(sightJs))
assert('打卡页仍告知可见性（不可选）', /仅你自己与社团成员可见|仅社/.test(sightWxml))
assert('打卡页可见性样式已清理', !/\.vis-row|\.switch\b/.test(read('miniprogram/pages/sighting-post/sighting-post.wxss')))

// 开关移到了控制台
assert('控制台有可见性策略卡片', /打卡记录可见性/.test(adminWxml))
assert('控制台有策略开关', /vis-row/.test(adminWxml) && /bindtap="togglePolicy"/.test(adminWxml))
assert('控制台开关样式存在', /\.switch\b/.test(adminWxss) && /\.knob/.test(adminWxss))
assert('控制台提供 togglePolicy 方法', /async togglePolicy\s*\(/.test(adminJs))
assert('控制台调 setSightingVisibilityPolicy', /setSightingVisibilityPolicy/.test(adminJs))
assert('控制台入口本身限超管', /app\.isSuper\(\)/.test(adminJs))
assert('开启公开前有风险提示', /确定开启/.test(adminJs) && /社交类目/.test(adminJs))

// 控制台不再展示提交人身份（连后台也不需要暴露 UGC 作者）
assert('控制台列表不展示上报人身份', !/上报人：/.test(adminWxml),
  '后台列表还显示"上报人" —— UGC 作者身份不该出现在界面里')

/* ==================== ①c 打卡入口文案：如实描述本人的打卡 ==================== */
console.log('\n--- 1c. 打卡入口文案 ---')
const indexWxml = read('miniprogram/pages/index/index.wxml')
const catsWxml = read('miniprogram/pages/cats/cats.wxml')

// 合规配套：可见性默认私有后，首页/猫谱的「动态」入口实际是"我自己的打卡"，
// 文案必须如实 —— 叫「最新动态」会让用户以为是公开广场（也是在暗示社交属性）。
// 2026-10-24：首页入口文案统一为「打卡记录」，与猫谱 tab 同名（原名「我的打卡」）。
assert('首页快捷入口文案为「打卡记录」', /打卡记录/.test(indexWxml))
assert('首页不再出现「我的打卡」旧文案', !/我的打卡/.test(indexWxml))
assert('首页不再出现「最新动态」', !/最新动态/.test(indexWxml))
assert('猫谱 tab 文案为「打卡记录」', /打卡记录/.test(catsWxml))
assert('猫谱不再出现「目击动态」', !/目击动态/.test(catsWxml))
// tab 语义要与文案一致：切换到 sighting tab 时必须带 mine:true
assert('「打卡记录」tab 按本人过滤（mine:true）',
  /listSightings',\s*\{\s*page,\s*size:\s*20,\s*mine:\s*true\s*\}/.test(read('miniprogram/pages/cats/cats.js')),
  'tab 叫「打卡记录」却没按本人过滤 —— 会展示别人的记录（且默认 private 下本也看不到）')

/* ==================== ② 对外不下发用户生成内容 ==================== */
console.log('\n--- 2. 对外脱敏：不下发 UGC ---')

assert('sanitizeSighting 存在', /function sanitizeSighting/.test(coreJs))
// 非成员分支必须删掉这几类字段
const sanFn = coreJs.slice(coreJs.indexOf('function sanitizeSighting'), coreJs.indexOf('function sanitizeSighting') + 2200)
assert('对外删除 photos（用户图片）', /delete out\.photos/.test(sanFn))
assert('对外删除 reporter（身份）', /delete out\.reporter\b/.test(sanFn))
assert('对外删除 reporterName', /delete out\.reporterName/.test(sanFn))
assert('对外仍保留 health/feedStatus（结构化聚合信息）',
  !/delete out\.health/.test(sanFn) && !/delete out\.feedStatus/.test(sanFn))
assert('成员仍可见全字段（成员分支提前返回）',
  /if \(isMember\(user\)\) return s/.test(sanFn))
assert('对外仍做点位模糊', /blurLocation/.test(sanFn))
// 可见性第二道防线：非公开记录对外返回 null
assert('非公开记录对外不可见（返回 null）', /if \(s\.visibility !== 'public'\) return null/.test(sanFn),
  'sanitizeSighting 没拦非公开记录 —— 私有记录会漏给访客')
assert('本人可见自己的记录（含私有）', /s\.reporter === user\.openid/.test(sanFn))

/* ==================== ③ 行为标签白名单前后端对齐 ==================== */
console.log('\n--- 3. 行为/特征标签白名单一致性 ---')

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

// 外观特征：同样前后端逐值对齐
const fm = constJs.match(/SIGHT_FEATURE:\s*\[([\s\S]*?)\n\s*\]/)
assert('const.js 定义了 SIGHT_FEATURE', !!fm)
const feFeat = fm ? [...fm[1].matchAll(/value:\s*'([a-zA-Z]+)'/g)].map(x => x[1]) : []
assert('前端外观特征非空', feFeat.length >= 6, feFeat.length)
const cfm = cfIndex.match(/SIGHT_FEATURE_VALUES\s*=\s*\[([\s\S]*?)\]/)
assert('云端定义 SIGHT_FEATURE_VALUES', !!cfm)
const beFeat = cfm ? [...cfm[1].matchAll(/'([a-zA-Z]+)'/g)].map(x => x[1]) : []
assert('前后端外观特征逐值一致', JSON.stringify(feFeat) === JSON.stringify(beFeat),
  { 前端: feFeat, 后端: beFeat })
assert('云端对 features 做白名单过滤', /features\s*=\s*Array\.isArray\(d\.features\)[\s\S]{0,160}indexOf\(f\)\s*>=\s*0/.test(cfIndex))
assert('云端对 features 数量封顶', /\.slice\(0,\s*10\)/.test(cfIndex))
assert('云端仍存 features 字段', /features,/.test(cfIndex))

// 标签文案不得含主观评价/情绪词（否则又回到"创作"形态）
const SUBJECTIVE = ['可爱', '漂亮', '好看', '萌', '治愈', '温暖', '想念', '心疼', '舍不得']
const labelTexts = [m, fm].filter(Boolean).flatMap(x => [...x[1].matchAll(/label:\s*'([^']+)'/g)].map(y => y[1]))
const subjective = labelTexts.filter(t => SUBJECTIVE.some(w => t.includes(w)))
assert('行为/特征标签无主观/情绪化词汇', subjective.length === 0, subjective)

/* ==================== ④ 云端：无自由文本 + 可见性 + 新猫占位名 ==================== */
console.log('\n--- 4. 云端字段约束 ---')
assert('云端 addSighting 不再接受自由文本 note', !/^\s*note:\s*String\(d\.note/m.test(cfIndex),
  '云端还在存 d.note —— 老客户端可绕过前端限制继续发布文字')
assert('云端 updateSighting 不接受自由文本 note', !/patch\.note\s*=/.test(cfIndex),
  'updateSighting 还开放 note 写入 —— UGC 文字留了后门')
assert('云端仍存 behaviors 字段', /behaviors,/.test(cfIndex))
assert('云端落库 visibility 字段', /visibility,/.test(cfIndex))
assert('默认可见性为 private', /d\.public === true \? SIGHTING_VIS_PUBLIC : SIGHTING_VIS_PRIVATE/.test(cfIndex),
  '可见性判定没落保守分支 —— 老客户端不传该字段时可能被当成公开')
assert('新猫占位名由服务端按 pattern 生成（不接受 catName）',
  /'未命名'/.test(cfIndex) && /PATTERN_LABELS/.test(cfIndex),
  '新猫名仍取自用户输入 —— "起名字"就是生成文字')
assert('listSightings 对非成员按可见性过滤', /where\.visibility = SIGHTING_VIS_PUBLIC/.test(cfIndex))
assert('listSightings 自己的记录不受可见性限制', /where\.reporter = me\.openid/.test(cfIndex))
assert('首页最近目击也不漏私有记录',
  /\.filter\(s => isMember\(me\) \|\| s\.visibility === 'public'/.test(cfIndex))
assert('sanitizeSighting 返回 null 时调用方已过滤',
  (cfIndex.match(/\.filter\(Boolean\)/g) || []).length >= 2,
  'sanitizeSighting 可能返回 null，调用方必须 filter(Boolean) 剔除，否则前端拿到 null 崩')
assert('注册 setSightingVisibilityPolicy action（role=admin）',
  /'setSightingVisibilityPolicy':\s*\{\s*role:\s*'admin'/.test(cfIndex),
  '可见性策略必须由管理员配置，不能开放给普通用户')
assert('策略写入 schools 文档（非 user 偏好）', /sightingPublic:\s*next/.test(cfIndex) && /COL\.school/.test(cfIndex))
assert('策略写入前 requireSuper 校验', /async function setSightingVisibilityPolicy[\s\S]{0,200}requireSuper\(me\)/.test(cfIndex))
assert('addSighting 读取校区策略作为可见性', /await sightingPolicyPublic\(schoolId\)/.test(cfIndex),
  'addSighting 没读策略 —— 可见性就还是用户可控的')
// 只在 addSighting 函数体内断言：不得再按请求体里的 d.public 决定可见性
const addFn = cfIndex.slice(cfIndex.indexOf('async function addSighting'),
  cfIndex.indexOf('async function listSightings'))
assert('addSighting 不再按请求体 public 判定可见性',
  !/const visibility = d\.public/.test(addFn),
  '打卡者仍可自行公开')
assert('策略读取失败时回落最保守（private）', /catch \(e\) \{\s*return false/.test(cfIndex))
assert('普通用户不能靠 updateSighting 改可见性', /d\.public !== undefined && isSuper\(me\)/.test(cfIndex))

/* ==================== ④b 演示/测试数据不得含自由文本 ==================== */
console.log('\n--- 4b. 演示数据合规（审核能在测试账号里看到）---')
const seedFn = cfIndex.slice(cfIndex.indexOf('async function seedDemoData'),
  cfIndex.indexOf('async function seedDemoData') + 4000)
assert('演示猫档案不含叙述性 note 文案',
  !/note:\s*'[^']{6,}'/.test(seedFn),
  '演示数据里还有成句的 note（如"饭点准时出现，亲人可摸"）—— 审核看到的自由文本')
assert('演示猫档案改为结构化 behaviors 标签', /behaviors:\s*\[/.test(seedFn))
assert('演示档案落库时 note 置空', /note:\s*''/.test(seedFn))
assert('演示档案 internalNote/medicalNote 置空',
  /internalNote:\s*''/.test(seedFn) && /medicalNote:\s*''/.test(seedFn))

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
