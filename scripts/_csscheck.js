/** 精确定位 preview/index.html 中 <style> 块内括号不平衡的位置（输出 HTML 真实行号） */
const fs = require('fs')
const file = 'E:\\Agent\\stray-animals\\preview\\index.html'
const html = fs.readFileSync(file, 'utf8')

const re = /<style>([\s\S]*?)<\/style>/g
let m
let idx = 0
while ((m = re.exec(html)) !== null) {
  idx++
  const css = m[1]
  const startLine = html.slice(0, m.index).split('\n').length // <style> 所在行
  let depth = 0
  let line = startLine
  const stack = []
  const bad = []
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (ch === '\n') { line++; continue }
    if (ch === '{') { depth++; stack.push(line) }
    if (ch === '}') {
      depth--
      if (depth < 0) { bad.push(`多余 } 于第 ${line} 行`); depth = 0; stack.length = 0 }
      else stack.pop()
    }
  }
  console.log(`--- style 块 #${idx} (起始 HTML 行 ${startLine}) ---`)
  console.log(`final depth = ${depth}`)
  if (bad.length) console.log(bad.join('\n'))
  if (depth > 0) {
    console.log(`未闭合的 { 位于第 ${stack.slice(-depth).join(', ')} 行`)
    stack.slice(-depth).forEach(ln => {
      const l = html.split('\n')[ln - 1]
      console.log(`  L${ln}: ${l.trim().slice(0, 120)}`)
    })
  } else {
    console.log('平衡 ✓')
  }
}
