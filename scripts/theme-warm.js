/**
 * 主题改版脚本 ②：深空科技风 → 暖阳柑橘（浅暖底 + 橙主色 + 黄辅色）
 * 只做确定性颜色替换，不动布局。幂等，可重复执行。
 * 用法：node scripts/theme-warm.js
 *
 * 注意：app.wxss 的设计变量已手工改好，此脚本跳过它，只处理页面与组件。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', 'miniprogram')

const RULES = [
  // —— 主色：青绿 → 橙 ——
  [/rgba\(\s*46,\s*230,\s*197,\s*(\.?\d+)\s*\)/g, (m, a) => `rgba(249, 115, 22, ${a})`],
  [/#2EE6C5/g, '#F97316'],
  [/#12C9A9/g, '#C2410C'],
  [/#35A7FF/g, '#FB923C'],

  // —— 辅色：紫 → 黄 ——
  [/rgba\(\s*124,\s*140,\s*255,\s*(\.?\d+)\s*\)/g, (m, a) => `rgba(251, 191, 36, ${a})`],
  [/#7C8CFF/g, '#FBBF24'],
  [/rgba\(\s*199,\s*125,\s*255,\s*(\.?\d+)\s*\)/g, (m, a) => `rgba(234, 179, 8, ${a})`],
  [/#C77DFF/g, '#EAB308'],
  [/#A9B4FF/g, '#B45309'],

  // —— 中性：暗底 → 白，浅字 → 深棕 ——
  [/#070B14/g, '#FFF7ED'],
  [/#0B111E/g, '#FFFFFF'],
  [/#101827/g, '#FFFFFF'],
  [/#E9EEF9/g, '#431407'],
  [/rgba\(\s*233,\s*238,\s*249,\s*(\.?\d+)\s*\)/g, (m, a) => `rgba(67, 20, 7, ${a})`],
  [/#8A94AD/g, '#8C6A55'],
  [/#57607A/g, '#B9A08C'],
  [/#04121A/g, '#FFFFFF'],

  // —— 白色半透明（暗底上的玻璃层）→ 暖棕半透明（浅底上可见） ——
  [/rgba\(\s*255,\s*255,\s*255,\s*(\.?\d+)\s*\)/g, (m, a) => `rgba(146, 88, 32, ${a})`],

  // —— 状态色：冷色拉暖 ——
  [/#34D399/g, '#2FA36B'],
  [/rgba\(\s*52,\s*211,\s*153,\s*(\.?\d+)\s*\)/g, (m, a) => `rgba(47, 163, 107, ${a})`],
  [/#FF7A6B/g, '#E0483C'],
  [/rgba\(\s*255,\s*122,\s*107,\s*(\.?\d+)\s*\)/g, (m, a) => `rgba(224, 72, 60, ${a})`],
  [/#60A5FA/g, '#2F86D6'],
  [/rgba\(\s*96,\s*165,\s*250,\s*(\.?\d+)\s*\)/g, (m, a) => `rgba(47, 134, 214, ${a})`],
  [/#A78BFA/g, '#A855F7'],
  [/rgba\(\s*167,\s*139,\s*250,\s*(\.?\d+)\s*\)/g, (m, a) => `rgba(168, 85, 247, ${a})`],
  [/#FFC46B/g, '#EAB308'],
  [/rgba\(\s*255,\s*196,\s*107,\s*(\.?\d+)\s*\)/g, (m, a) => `rgba(234, 179, 8, ${a})`],

  // —— 中性阴影：黑阴影 → 暖棕柔阴影 ——
  [/rgba\(\s*0,\s*0,\s*0,\s*\.(\d+)\s*\)/g, (m, a) => `rgba(146, 88, 32, .${Number(a) > 5 ? 18 : 8})`]
]

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (f.endsWith('.wxss') && path.basename(p) !== 'app.wxss') out.push(p)
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
    out = out.replace(re, (...args) => {
      const before = args[0]
      const after = typeof to === 'function' ? to(...args) : to
      if (before !== after) n++
      return after
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
