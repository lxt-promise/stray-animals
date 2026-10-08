/** 一次性收尾：把预览里「卡片类」容器改成白底，并修掉浅底上不可见的白色元素。 */
const fs = require('fs')
const FILE = 'E:\\Agent\\stray-animals\\preview\\index.html'
const lines = fs.readFileSync(FILE, 'utf8').split('\n')

const WHITE_GRAD = '  background:linear-gradient(180deg,#FFFFFF,#FFFBF6);'
const byLine = {
  83: WHITE_GRAD, 170: WHITE_GRAD, 179: WHITE_GRAD,
  209: WHITE_GRAD, 256: WHITE_GRAD, 296: WHITE_GRAD
}
let s = lines.join('\n')

for (const [ln, val] of Object.entries(byLine)) {
  const i = Number(ln) - 1
  if (!/background:linear-gradient\(180deg,rgba\(146, 88, 32/.test(lines[i])) {
    console.log('WARN 行内容不符，跳过', ln, lines[i].trim())
    continue
  }
  lines[i] = val
}
s = lines.join('\n')

const strRules = [
  ['background:rgba(146, 88, 32, .05);border:1px solid var(--line);border-radius:20px',
   'background:#FFFFFF;border:1px solid var(--line);border-radius:20px'],
  ['border-radius:var(--radius);background:rgba(146, 88, 32, .05);border:1px solid var(--line)',
   'border-radius:var(--radius);background:#FFFFFF;border:1px solid var(--line)'],
  ['border-radius:16px;background:rgba(146, 88, 32, .05);',
   'border-radius:16px;background:#FFFFFF;'],
  ['border:1.5px solid rgba(255,255,255,.5)', 'border:1.5px solid rgba(67,20,7,.35)'],
  ['background:rgba(255,255,255,.5);border-radius:0 2px 2px 0', 'background:rgba(67,20,7,.35);border-radius:0 2px 2px 0'],
  ['border:1px solid rgba(255,255,255,.16);color:var(--text)', 'border:1px solid rgba(67,20,7,.16);color:var(--text)']
]
let cnt = 0
for (const [a, b] of strRules) {
  const before = s
  s = s.split(a).join(b)
  if (s !== before) cnt++
}
fs.writeFileSync(FILE, s, 'utf8')
console.log('line fixes:', Object.keys(byLine).length, 'string fixes applied:', cnt)
