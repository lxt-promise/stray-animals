/* 问题1/2/4 前端改动验证 */
const fs = require('fs')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')

let pass = 0, fail = 0
const assert = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

/* ---------- 1. feedOf 回落逻辑（复刻 map.js openCatPopup 的实现） ---------- */
const C = require(path.join(ROOT, 'miniprogram/utils/const.js'))
const utilSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/util.js'), 'utf8')
// itemOf 是 util.js 内部函数，按源码语义复刻
const itemOf = (list, value) => list.filter(i => i.value === value)[0] || { label: '未知', tag: 'gray' }
assert('util.js 仍保留 itemOf 未知回落（语义基准）', /label: '未知'/.test(utilSrc))

const FEED_VALUES = C.FEED_STATUS.map(x => x.value)
const feedOf = v => itemOf(C.FEED_STATUS, FEED_VALUES.indexOf(v) >= 0 ? v : 'passed')
assert('历史记录（无 feedStatus）显示路过', feedOf(undefined).label === '路过', feedOf(undefined))
assert('历史记录（null）显示路过', feedOf(null).label === '路过')
assert('非法值显示路过', feedOf('garbage').label === '路过')
assert('fed 显示本人投喂', feedOf('fed').label === '本人投喂')
assert('passed 显示路过', feedOf('passed').label === '路过')
assert('fedByOther 显示已被其他人投喂', feedOf('fedByOther').label === '已被其他人投喂')
assert('不再出现未知标签', ['undefined 场景'].every(() => feedOf(undefined).label !== '未知'))

// map.js 里确实用了带回落的写法
const mapSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/map/map.js'), 'utf8')
assert('map.js 使用白名单回落而非裸 itemOf',
  /FEED_VALUES\.indexOf\(v\) >= 0 \? v : 'passed'/.test(mapSrc))

/* ---------- 2. WXML 标签配平（剔除注释后统计） ---------- */
function balance(file, label) {
  const raw = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const noComment = raw.replace(/<!--[\s\S]*?-->/g, '')
  const tags = {}
  const re = /<(\/?)([a-z-]+)((?:\s[^>]*?)?)(\/?)>/g
  let m
  while ((m = re.exec(noComment))) {
    const closing = m[1] === '/'
    const selfClose = m[4] === '/'
    const name = m[2]
    // 自闭合（<x ... />）或 void 标签不计入配平
    if (selfClose || name === 'image' || name === 'input' || name === 'br' || name === 'video') continue
    tags[name] = tags[name] || { open: 0, close: 0 }
    if (closing) tags[name].close++
    else tags[name].open++
  }
  const bad = Object.keys(tags).filter(k => tags[k].open !== tags[k].close)
  assert(label + ' 标签配平', bad.length === 0, bad.map(k => k + ':' + JSON.stringify(tags[k])))
}
balance('miniprogram/pages/map/map.wxml', 'map.wxml')
balance('miniprogram/pages/recognize/recognize.wxml', 'recognize.wxml')

/* ---------- 3. 图例定位：入口与卡片都带 above-sheet 且位置不重叠面板 ---------- */
const wxss = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/map/map.wxss'), 'utf8')
assert('图例入口有 above-sheet 上移规则', /\.legend-entry\.above-sheet\s*\{\s*bottom:\s*calc\(752rpx/.test(wxss))
assert('图例卡有 above-sheet 上移规则', /\.legend-card\.above-sheet\s*\{\s*bottom:\s*calc\(752rpx/.test(wxss))
assert('图例卡改为固定窄宽（缩小）', /\.legend-card\s*\{[^}]*width:\s*560rpx/.test(wxss))
assert('图例卡不再通栏（去掉 right:32rpx）', !/\.legend-card\s*\{[^}]*right:\s*32rpx/.test(wxss))
assert('图例卡改为 bottom 锚定（左下角）', /\.legend-card\s*\{[^}]*bottom:\s*calc\(216rpx/.test(wxss))
assert('wxml 入口带 showList 条件类', /class="legend-entry \{\{showList \? 'above-sheet' : ''\}\}"/.test(mapSrc) || /legend-entry \{\{showList/.test(fs.readFileSync(path.join(ROOT, 'miniprogram/pages/map/map.wxml'), 'utf8')))
assert('wxml 卡片带 showList 条件类', /legend-card \{\{showList/.test(fs.readFileSync(path.join(ROOT, 'miniprogram/pages/map/map.wxml'), 'utf8')))

/* ---------- 4. 识别页调试框已彻底移除 ---------- */
const recWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/recognize/recognize.wxml'), 'utf8')
const recWxss = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/recognize/recognize.wxss'), 'utf8')
assert('recognize.wxml 无 stage-log 块', !/stage-log/.test(recWxml))
assert('recognize.wxml 无 [vision] 日志行', !/\[vision\]/.test(recWxml))
assert('recognize.wxss 无 stage-log/log-line 样式', !/\.stage-log|\.log-line/.test(recWxss))
assert('识别进行中卡片仍保留进度与阶段文案', /识别进行中/.test(recWxml) && /stageText/.test(recWxml))

/* ---------- 8. 地图拖拽自由（2026-10-24，二次修正） ---------- */
// 现场第一轮：「上下拖动不了，右上角的猫拖不到中心」→ 归因边界过窄，改成
// setBoundary 外扩 60%。
// 第二轮用户仍反馈「不能拖到拐角」，要求取消限制：结论是**只要设了边界，
// 无论外扩多少，边缘点位都拖不到屏幕中心**。所以取消边界约束本身，
// 校园范围只用于筛选点位（数据层），不再限制镜头（视图层）。
const mapWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/map/map.wxml'), 'utf8')
assert('map 绑定 regionchange', /bindregionchange="onRegionChange"/.test(mapWxml))
assert('map 开启 enable-scroll 与 enable-zoom',
  /enable-scroll/.test(mapWxml) && /enable-zoom/.test(mapWxml))

// 核心：不再调用 setBoundary（外扩多少都不行）
{
  const seg = mapSrc.slice(mapSrc.indexOf('moveMapTo(center, scale)'), mapSrc.indexOf('居中到目标点'))
  assert('moveMapTo 不再调用 setBoundary', !/setBoundary\s*\(/.test(seg), seg.slice(0, 300))
  assert('源码里彻底移除 setBoundary 调用', !/this\._mapCtx\.setBoundary/.test(mapSrc))
}
// 展示范围 ≠ 可视范围：镜头不受限，点位筛选依然生效 —— 但在**服务端**做。
// （2026-10-25 改）旧写法在前端 keep() 里丢掉越界点位，而「最新打卡在校外」时
// 那个坐标已是这只猫唯一的点位，丢了猫就整只消失（「最近几个目击没上图」的真因）。
// 现在前端只做渲染层安全校验（isFinite），裁决与越界回退交给云端。
assert('前端不再按 bounds 丢点位（避免猫整只消失）',
  !/p\.lat >= bounds\.sw\.lat/.test(mapSrc))
assert('前端仍做坐标 isFinite 校验（NaN 会让整片 marker 消失）',
  /keep = p => Number\.isFinite\(p\.lat\)/.test(mapSrc))
assert('前端把 bounds 传给云端做点位裁决',
  /callApi\(\s*'listMapPoints'[\s\S]{0,200}?bounds/.test(mapSrc))

// 手势作废重定位：只认 causedBy 'drag'（'update' 是自己的 includePoints 触发的）
assert('onRegionChange 只认用户手势（causedBy drag）',
  /causedBy === 'drag'/.test(mapSrc) && /_userPanned = true/.test(mapSrc))
assert('scheduleReassert 见 _userPanned 直接返回',
  /scheduleReassert\(center, scale\)\s*\{[\s\S]*?if \(this\._userPanned\) return/.test(mapSrc))
assert('onHide/onUnload 清理重定位定时器',
  /onUnload\(\)\s*\{\s*this\.cancelReassert\(\)/.test(mapSrc) &&
  /onHide\(\)\s*\{\s*this\.cancelReassert\(\)/.test(mapSrc))
assert('同校刷新不复位 _userPanned（比较前后 center）',
  /pc\.lng !== next\.center\.lng/.test(mapSrc))

// 拖过之后连 center/scale 都不写回：部分基础库下 map 属性变更会自己重新定位，
// 光挡住 moveMapTo 不够，切 tab 回来仍会被拽回校园中心。
assert('用户拖过后不写回 center/scale 数据',
  /if \(!this\._userPanned\) \{\s*\n\s*if \(next\.center\) patch\.center = next\.center/.test(mapSrc))
assert('用户拖过后不做入/出场重定位',
  /if \(!this\._userPanned\) \{\s*\n\s*const c = patch\.center \|\|/.test(mapSrc))

// 但用户主动操作（回本校 / 定位 / 点 marker）必须能抢回镜头
const segReset = mapSrc.slice(mapSrc.indexOf('resetView()'), mapSrc.indexOf('locateMe()'))
assert('resetView 复位 _userPanned', /this\._userPanned = false/.test(segReset))
const segLocate = mapSrc.slice(mapSrc.indexOf('locateMe()'), mapSrc.indexOf('toggleList()'))
assert('locateMe 复位 _userPanned', /this\._userPanned = false/.test(segLocate))
const segTap = mapSrc.slice(mapSrc.indexOf('onMarkerTap(e)'), mapSrc.indexOf('cluster 内猫'))
assert('点 marker 复位 _userPanned', /this\._userPanned = false/.test(segTap))

console.log('\nPASS ' + pass + ' / FAIL ' + fail)
process.exit(fail ? 1 : 0)
