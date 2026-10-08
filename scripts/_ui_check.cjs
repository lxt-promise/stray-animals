// 校验：WXML 标签闭合 / WXSS 括号平衡
const fs = require('fs')
const path = require('path')

const PAGES = 'E:/Agent/project/stray-animals/miniprogram/pages'

function walk(dir, ext, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, ext, out)
    else if (name.endsWith(ext)) out.push(p)
  }
  return out
}

function checkWxml(p) {
  const src = fs.readFileSync(p, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g
  const stack = []
  let m
  while ((m = re.exec(src))) {
    const closing = m[1] === '/'
    const name = m[2]
    const selfClose = m[4] === '/'
    if (selfClose) continue
    if (closing) {
      if (stack[stack.length - 1] !== name) {
        return `标签不匹配: </${name}>，栈顶为 <${stack[stack.length - 1] || '空'}>`
      }
      stack.pop()
    } else {
      stack.push(name)
    }
  }
  if (stack.length) return `未闭合标签: ${stack.join(' > ')}`
  return null
}

function checkWxss(p) {
  const s = fs.readFileSync(p, 'utf8')
  let d = 0
  let line = 1
  for (const ch of s) {
    if (ch === '\n') line++
    if (ch === '{') d++
    if (ch === '}') {
      d--
      if (d < 0) return `多余的 } 在第 ${line} 行`
    }
  }
  if (d !== 0) return `括号未平衡，末尾缺 ${d} 个 }`
  return null
}

let bad = 0
for (const f of walk(PAGES, '.wxml')) {
  const e = checkWxml(f)
  if (e) { bad++; console.log('[WXML] ' + path.basename(f) + ' -> ' + e) }
}
for (const f of walk(PAGES, '.wxss')) {
  const e = checkWxss(f)
  if (e) { bad++; console.log('[WXSS] ' + path.basename(f) + ' -> ' + e) }
}
const g = 'E:/Agent/project/stray-animals/miniprogram/app.wxss'
const ge = checkWxss(g)
if (ge) { bad++; console.log('[WXSS] app.wxss -> ' + ge) }

console.log(bad === 0 ? 'ALL_OK 全部页面结构与样式括号平衡' : `发现 ${bad} 处问题`)
