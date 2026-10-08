/**
 * 主题改版脚本：把浅色「奶油+橙」主题批量改为深空科技风。
 * 只做确定性替换，不改动布局结构。可重复执行（幂等）。
 * 用法：node scripts/theme-dark.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', 'miniprogram')

const RULES = [
  // 面板背景：纯白 -> 变量面板色
  [/background:\s*#fff(fff)?\s*;/g, 'background: var(--card);'],
  [/background-color:\s*#fff(fff)?\s*;/g, 'background-color: var(--card);'],
  // 白色描边（头像稀有度圆点等）
  [/border:\s*(\d+)rpx solid\s*#fff(fff)?\s*;/g, 'border: $1rpx solid rgba(255, 255, 255, .12);'],
  // 浅灰底（徽章、chip 未选中）
  [/background:\s*#F2F2F2\s*;/g, 'background: rgba(255, 255, 255, .06);'],
  [/background:\s*#F5F5F5\s*;/g, 'background: rgba(255, 255, 255, .05);'],
  // 毛玻璃浮层（搜索条、地图面板）
  [/background:\s*rgba\(255,\s*255,\s*255,\s*\.9\d?\)/g, 'background: rgba(11, 17, 30, .92)'],
  // 品牌橙阴影 -> 青绿霓虹
  [/rgba\(255,\s*138,\s*61,/g, 'rgba(46, 230, 197,'],
  // 暖棕阴影 -> 中性暗阴影
  [/rgba\(120,\s*80,\s*40,\s*\.0\d\)/g, 'rgba(0, 0, 0, .35)'],
  // 浅色系的浅底块（tag 底色等遗留）
  [/background:\s*#F7F7F7\s*;/g, 'background: rgba(255, 255, 255, .05);']
]

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (f.endsWith('.wxss') && !p.endsWith('app.wxss')) out.push(p)
  }
  return out
}

let total = 0
const changed = []
for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8')
  let out = src
  let n = 0
  for (const [re, to] of RULES) {
    out = out.replace(re, (m, ...rest) => {
      n++
      return typeof to === 'string' ? to.replace(/\$1/g, rest[0]) : to
    })
  }
  if (n > 0) {
    fs.writeFileSync(file, out, 'utf8')
    changed.push(`${path.relative(ROOT, file)}: ${n}`)
    total += n
  }
}

console.log('files changed:', changed.length)
console.log(changed.join('\n'))
console.log('total replacements:', total)
