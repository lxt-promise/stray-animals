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

console.log('\nPASS ' + pass + ' / FAIL ' + fail)
process.exit(fail ? 1 : 0)
