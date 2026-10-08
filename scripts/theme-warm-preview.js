/**
 * 主题改版脚本 ③：把 preview/index.html 的 <style> 从深空科技风改为暖阳柑橘。
 * 只处理 <style> 区块 —— <script> 里的猫咪毛色数据（hue 渐变）保持不变，
 * 否则黑白猫会被染成橘猫。
 * 用法：node scripts/theme-warm-preview.js
 */
const fs = require('fs')
const path = require('path')

const FILE = path.resolve(__dirname, '..', 'preview', 'index.html')
const html = fs.readFileSync(FILE, 'utf8')
const m = html.match(/<style>([\s\S]*?)<\/style>/)
if (!m) { console.error('未找到 <style> 区块'); process.exit(1) }

let css = m[1]
let n = 0
const rep = (re, to) => {
  css = css.replace(re, (...a) => {
    const before = a[0]
    const after = typeof to === 'function' ? to(...a) : to
    if (before !== after) n++
    return after
  })
}

// —— 浮层：暗底玻璃 → 白玻璃（先转白，避免被后面的「白→棕」规则误伤）——
rep(/rgba\(\s*11,\s*17,\s*30,\s*(\.?\d+)\s*\)/g, (x, a) => `rgba(255, 255, 255, ${a})`)
rep(/rgba\(\s*16,\s*24,\s*39,\s*(\.?\d+)\s*\)/g, (x, a) => `rgba(255, 255, 255, ${a})`)
rep(/rgba\(\s*5,\s*7,\s*13,\s*(\.?\d+)\s*\)/g, (x, a) => `rgba(67, 20, 7, ${a})`)

// —— 主色：青绿 → 橙 ——
rep(/rgba\(\s*46,\s*230,\s*197,\s*(\.?\d+)\s*\)/g, (x, a) => `rgba(249, 115, 22, ${a})`)
rep(/#2EE6C5/g, '#F97316')
rep(/#12C9A9/g, '#C2410C')
rep(/#35A7FF/g, '#FB923C')

// —— 辅色：紫 → 黄 ——
rep(/rgba\(\s*124,\s*140,\s*255,\s*(\.?\d+)\s*\)/g, (x, a) => `rgba(251, 191, 36, ${a})`)
rep(/#7C8CFF/g, '#FBBF24')
rep(/rgba\(\s*199,\s*125,\s*255,\s*(\.?\d+)\s*\)/g, (x, a) => `rgba(234, 179, 8, ${a})`)
rep(/#C77DFF/g, '#EAB308')
rep(/#A9B4FF/g, '#B45309')

// —— 中性：暗底 → 白/浅暖，浅字 → 深棕 ——
rep(/#05070D/g, '#FDF6EC')
rep(/#070B14/g, '#FFF7ED')
rep(/#0B111E/g, '#FFFFFF')
rep(/#101827/g, '#FFFFFF')
rep(/#0A1018/g, '#FFF6EA')
rep(/#0E1420/g, '#FFFFFF')
rep(/#E9EEF9/g, '#431407')
rep(/rgba\(\s*233,\s*238,\s*249,\s*(\.?\d+)\s*\)/g, (x, a) => `rgba(67, 20, 7, ${a})`)
rep(/#8A94AD/g, '#8C6A55')
rep(/#57607A/g, '#B9A08C')
rep(/#04121A/g, '#FFFFFF')

// —— 猫图占位底：深蓝 → 暖沙 ——
rep(/#1B2436/g, '#F1E4D3')
rep(/#131B2A/g, '#E8D8C4')
rep(/#141B2A/g, '#E8D8C4')

// —— 黑色阴影/蒙版 → 暖棕 ——
rep(/rgba\(\s*0,\s*0,\s*0,\s*\.(\d+)\s*\)/g, (x, a) => `rgba(146, 88, 32, .${Number(a) >= 3 ? 12 : 8})`)

// —— 状态色：冷色拉暖 ——
rep(/#34D399/g, '#2FA36B')
rep(/rgba\(\s*52,\s*211,\s*153,\s*(\.?\d+)\s*\)/g, (x, a) => `rgba(47, 163, 107, ${a})`)
rep(/#FF7A6B/g, '#E0483C')
rep(/rgba\(\s*255,\s*122,\s*107,\s*(\.?\d+)\s*\)/g, (x, a) => `rgba(224, 72, 60, ${a})`)
rep(/#60A5FA/g, '#2F86D6')
rep(/rgba\(\s*96,\s*165,\s*250,\s*(\.?\d+)\s*\)/g, (x, a) => `rgba(47, 134, 214, ${a})`)
rep(/#A78BFA/g, '#A855F7')
rep(/rgba\(\s*167,\s*139,\s*250,\s*(\.?\d+)\s*\)/g, (x, a) => `rgba(168, 85, 247, ${a})`)
rep(/#FFC46B/g, '#EAB308')
rep(/rgba\(\s*255,\s*196,\s*107,\s*(\.?\d+)\s*\)/g, (x, a) => `rgba(234, 179, 8, ${a})`)

// —— 最后：暗底上遗留的白色玻璃层 → 暖棕微底（只处理 .0X，放过 .9x 浮层）——
rep(/rgba\(\s*255,\s*255,\s*255,\s*\.0(\d+)\s*\)/g, (x, a) => `rgba(146, 88, 32, .0${a})`)

fs.writeFileSync(FILE, html.replace(m[1], css), 'utf8')
console.log('preview/index.html style replacements:', n)
