/**
 * 测试校园对普通用户隐藏（2026-10-25）
 *
 * 需求：东南大学-测试这类校园**不给普通用户显示**，只有超级管理员能看见。
 *
 * 断言打在**意图**上，分三层：
 *  ① 纯函数 `isSchoolHidden`：显式 hidden 优先，名字兜底，显式 false 能翻案；
 *  ② 云函数接线：listSchools 过滤 / 后台不过滤 / 按 id 绑定也挡 / hidden 用 `!== undefined`；
 *  ③ 后台 UI：列表行打标 + 编辑面板有开关 + 保存时真的下发 hidden。
 *
 * 运行：node scripts/test_school_hidden.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const CF = read('cloudfunctions/catcampus/index.js')
const ADMIN_JS = read('miniprogram/pages/admin/admin.js')
const ADMIN_WXML = read('miniprogram/pages/admin/admin.wxml')
const ADMIN_WXSS = read('miniprogram/pages/admin/admin.wxss')

let pass = 0, fail = 0
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

/** 切出单个函数的函数体（跨函数正则会误伤，必须按大括号配平切） */
function sliceFn(src, header) {
  const at = src.indexOf(header)
  if (at < 0) return ''
  let i = src.indexOf('{', at)
  if (i < 0) return ''
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(at, j + 1) }
  }
  return ''
}

console.log('\n=== 1. 纯函数 isSchoolHidden（把源码里的函数体切出来真跑）===')
{
  const re = (CF.match(/const SCHOOL_HIDDEN_NAME_RE = [^\n]+/) || [''])[0]
  const fn = sliceFn(CF, 'function isSchoolHidden(')
  assert('存在隐藏判定函数与名字兜底正则', !!re && !!fn, { re, fnLen: fn.length })
  const isSchoolHidden = new Function(re + '\n' + fn + '\nreturn isSchoolHidden')()

  assert('显式 hidden:true → 隐藏', isSchoolHidden({ name: '东南大学', hidden: true }) === true)
  assert('显式 hidden:false → 可见（即使名字带「测试」）',
    isSchoolHidden({ name: '东南大学-测试', hidden: false }) === false)
  assert('未设 hidden + 名字带「测试」→ 隐藏（兜底，部署即生效）',
    isSchoolHidden({ name: '东南大学-测试' }) === true)
  assert('未设 hidden + 名字不带测试 → 可见',
    isSchoolHidden({ name: '南京大学' }) === false)
  assert('hidden:undefined 走兜底而不是被 undefined 顶掉',
    isSchoolHidden({ name: 'XX测试校区', hidden: undefined }) === true)
  assert('空对象不抛错', isSchoolHidden({}) === false)
  assert('null 不抛错', isSchoolHidden(null) === false)
}

console.log('\n=== 2. 云函数接线 ===')
{
  assert('listSchools 接收 me + event（按身份过滤 + 带定位/半径参数）',
    /async function listSchools\s*\(\s*me\s*,\s*event\s*\)/.test(CF))
  const ls = sliceFn(CF, 'async function listSchools(')
  assert('listSchools 超管看全量、普通用户过滤',
    /isSuper\(\s*me\s*\)/.test(ls) && /isSchoolHidden/.test(ls) && /filter/.test(ls), ls)

  const lsa = sliceFn(CF, 'async function listSchoolsAdmin(')
  assert('后台校园列表**不**做隐藏过滤（否则隐藏校区成了改不动的僵尸数据）',
    !/filter\(\s*s\s*=>\s*!isSchoolHidden/.test(lsa))
  assert('后台回一个算好的 hidden 供 UI 打标', /hidden:\s*isSchoolHidden\(s\)/.test(lsa), lsa)

  assert('存在绑定准入校验函数', /async function assertSchoolBindable\s*\(/.test(CF))
  const asb = sliceFn(CF, 'async function assertSchoolBindable(')
  assert('非超管不能绑定隐藏校园（挡「知道 id 就绕过下拉」）',
    /isSuper\(\s*me\s*\)/.test(asb) && /isSchoolHidden/.test(asb) && /403/.test(asb), asb)
  const apply = sliceFn(CF, 'async function applySchool(')
  assert('applySchool 加入已有学校也走准入校验（按 id 申请，不能绕过隐藏校园）',
    /assertSchoolBindable\(me, event\.schoolId\)/.test(apply), apply)
  assert('applySchool 不再提供即选即绑：必须带 reason 且落待审',
    /throw new AppError\('请填写申请理由'\)/.test(apply) && /status:\s*'pending'/.test(apply), apply)

  // 项目铁律：不能用 `x || 兜底`，会把 hidden:false 顶成「没传」，永远改不回可见
  assert('updateSchool 用 `!== undefined` 判 hidden（or 兜底会让取消隐藏失效）',
    /event\.hidden !== undefined && event\.hidden !== null/.test(CF))
  assert('createSchool 也支持建校即隐藏', /hidden:\s*event\.hidden === undefined/.test(CF))
}

console.log('\n=== 2c. school_applies 集合缺失自愈（2026-10-26 深夜，控制台刷 -502005）===')
{
  // 现象：没跑过 initCollections 的环境里，每个用户每次进「我的」页都读到
  // school_applies，控制台刷「-502005 database collection not exists」。
  // 集合没建 =「还没有任何申请」，不是故障，必须和真读失败区分开。
  assert('有集合缺失判定函数 isCollectionMissing',
    /function isCollectionMissing\(/.test(CF))
  assert('判定认 -502005 / collection not exists',
    /-502005/.test(CF) && /collection not exists/.test(CF))
  const msa = sliceFn(CF, 'async function mySchoolApply(')
  assert('mySchoolApply 集合缺失时返回空、不抛给前端（读路径）',
    /isCollectionMissing\(e\)/.test(msa) && /ensureCollection/.test(msa), msa)
  const ap = sliceFn(CF, 'async function applySchool(')
  assert('applySchool 写路径：集合缺失时先建再写（否则用户提交必失败）',
    /isCollectionMissing\(e\)/.test(ap) && /await ensureCollection/.test(ap), ap)
  const lsa2 = sliceFn(CF, 'async function listSchoolApplies(')
  assert('超管待审列表集合缺失时回空数组（不整页报红）',
    /isCollectionMissing\(e\)/.test(lsa2), lsa2)
  assert('ensureCollection 已从 core 显式导入',
    /ensureCollection, ensureAllCollections/.test(CF))
}

console.log('\n=== 2b. 选校默认 25km 半径过滤（2026-10-26）===')
{
  const ls = sliceFn(CF, 'async function listSchools(')
  assert('listSchools 按半径过滤（radiusKm / maxM / 默认 25）',
    /radiusKm/.test(ls) && /maxM/.test(ls) && /25/.test(ls), ls)
  assert('listSchools 给每项带 distanceM（供前端展示/排序）',
    /distanceM/.test(ls), ls)
  assert('当前绑定学校即使超半径也常驻（currentId 分支）',
    /currentId/.test(ls), ls)
  assert('拿不到定位回退全部（!haveLoc → 直接返回 list）',
    /haveLoc/.test(ls), ls)
  assert('没坐标的学校跳过、不参与「附近」筛选',
    /geoDistanceM/.test(ls) && /d === null/.test(ls), ls)

  // 纯函数 geoDistanceM 真跑：同点≈0、1°纬度≈111km、缺坐标→null
  assert('存在 Haversine 距离函数 geoDistanceM', /function geoDistanceM/.test(CF))
  const gd = sliceFn(CF, 'function geoDistanceM(')
  const geoDistanceM = new Function(gd + '\nreturn geoDistanceM')()
  assert('同点距离≈0', Math.abs(geoDistanceM({ lat: 32, lng: 118 }, { lat: 32, lng: 118 })) < 1)
  const d1 = geoDistanceM({ lat: 32, lng: 118 }, { lat: 33, lng: 118 })
  assert('1° 纬度≈111km（110~112km）', d1 > 110000 && d1 < 112000, d1)
  assert('缺坐标（lat:null）返回 null', geoDistanceM({ lat: 32, lng: 118 }, { lat: null, lng: 118 }) === null)
  assert('整点缺 center 返回 null', geoDistanceM({ lat: 32, lng: 118 }, undefined) === null)
}

console.log('\n=== 3. 后台 UI（超管要看得见、能切换）===')
{
  assert('schoolRowOf 暴露 isHidden（列表行打标用）',
    /isHidden:\s*hidden/.test(ADMIN_JS) && /const hidden = !!s\.hidden/.test(ADMIN_JS))
  assert('隐藏态文案区分「仅超管可见 / 对用户可见」',
    /hiddenText:\s*hidden \? '仅超管可见' : '对用户可见'/.test(ADMIN_JS))
  assert('编辑面板初始化 hidden（否则打开面板状态是空的）',
    /hidden:\s*!!s\.hidden/.test(ADMIN_JS))
  assert('切换开关写布尔值', /'schoolForm\.hidden':\s*!this\.data\.schoolForm\.hidden/.test(ADMIN_JS))
  assert('保存时下发 hidden: !!f.hidden', /hidden:\s*!!f\.hidden/.test(ADMIN_JS))
  assert('WXML 有隐藏标记', /wx:if="\{\{item\.isHidden\}\}"/.test(ADMIN_WXML))
  assert('WXML 有切换入口（可点击元素）',
    /bindtap="onToggleSchoolHidden"/.test(ADMIN_WXML))
  assert('WXML 不用 <text> 承接点击（Android X5 下 bindtap 失效）',
    !/<text[^>]*bindtap="onToggleSchoolHidden"/.test(ADMIN_WXML))
  assert('WXSS 让隐藏态文案跳出来', /\.school-main \.small\.warn/.test(ADMIN_WXSS))
}

console.log('\n' + (fail ? 'FAIL' : 'OK') + '  pass=' + pass + ' fail=' + fail)
process.exit(fail ? 1 : 0)
