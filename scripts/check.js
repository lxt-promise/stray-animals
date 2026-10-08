/**
 * 静态校验：JS 语法 + JSON 格式 + 小程序页面/云函数路由一致性
 * 用法：node scripts/check.js
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '..')
const errors = []
const notes = []

/* ---------- 1. HTML 内联脚本语法 ---------- */
const htmlPath = path.join(ROOT, 'preview', 'index.html')
if (fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, 'utf8')
  const m = html.match(/<script>([\s\S]*?)<\/script>/)
  if (m) {
    try {
      new vm.Script(m[1], { filename: 'preview/inline.js' })
      notes.push('preview/index.html inline script: OK')
    } catch (e) {
      errors.push('preview/index.html script: ' + e.message)
    }
    // 标签配对粗检
    const open = (html.match(/<div/g) || []).length
    const close = (html.match(/<\/div>/g) || []).length
    if (open !== close) errors.push(`preview/index.html div 不匹配: open=${open} close=${close}`)
    else notes.push(`preview/index.html div 配对: OK (${open})`)
  }
}

/* ---------- 2. 小程序 JS 语法 ---------- */
function walk(dir, ext, skip = []) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) out.push(...walk(p, ext, skip))
    else if (ext.includes(path.extname(f).replace('.', '')) && !skip.some(s => p.includes(s))) out.push(p)
  }
  return out
}

for (const dirName of ['miniprogram', 'cloudfunctions']) {
  for (const f of walk(path.join(ROOT, dirName), ['js'], ['node_modules'])) {
    try {
      new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f })
    } catch (e) {
      errors.push(`${path.relative(ROOT, f)}: ${e.message}`)
    }
  }
}
notes.push('miniprogram + cloudfunctions js: checked')

/* ---------- 3. JSON 格式 ---------- */
for (const f of walk(path.join(ROOT, 'miniprogram'), ['json'])) {
  try { JSON.parse(fs.readFileSync(f, 'utf8')) }
  catch (e) { errors.push(`${path.relative(ROOT, f)}: ${e.message}`) }
}

/* ---------- 4. 页面注册一致性 ---------- */
const appJsonPath = path.join(ROOT, 'miniprogram', 'app.json')
if (fs.existsSync(appJsonPath)) {
  const app = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'))
  let bad = 0
  for (const p of app.pages) {
    for (const ext of ['js', 'wxml', 'wxss', 'json']) {
      const fp = path.join(ROOT, 'miniprogram', p + '.' + ext)
      if (!fs.existsSync(fp)) { errors.push(`页面缺文件: ${p}.${ext}`); bad++ }
    }
  }
  // tabBar 图标
  for (const it of app.tabBar.list) {
    for (const k of ['iconPath', 'selectedIconPath']) {
      const fp = path.join(ROOT, 'miniprogram', it[k])
      if (!fs.existsSync(fp)) { errors.push(`tabBar 图标缺失: ${it[k]}`); bad++ }
    }
  }
  notes.push(`页面注册检查: ${app.pages.length} 页, 缺失 ${bad}`)
}

/* ---------- 5. 云函数 action 覆盖 ---------- */
const cfDir = path.join(ROOT, 'cloudfunctions', 'catcampus')
const cfPath = path.join(cfDir, 'index.js')
if (fs.existsSync(cfPath)) {
  const src = fs.readFileSync(cfPath, 'utf8')

  // 表驱动注册表：'actionName': { role: 'xxx', handler: ... }
  const declared = [...src.matchAll(/^\s*'([a-zA-Z][a-zA-Z0-9]*)':\s*\{\s*role:/gm)].map(m => m[1])
  // 具名 handler 函数
  const fns = [...src.matchAll(/(?:async\s+)?function ([a-zA-Z][a-zA-Z0-9]*)\s*\(/g)].map(m => m[1])
  // 具名 handler 若引用了未定义的函数则报错
  const named = [...src.matchAll(/handler:\s*([a-zA-Z][a-zA-Z0-9]*)\s*,?\s*$/gm)].map(m => m[1])
  const missing = named.filter(n => !fns.includes(n))
  if (missing.length) errors.push('云函数缺少实现: ' + missing.join(', '))

  // lib 模块存在性
  for (const m of [...src.matchAll(/require\('\.\/lib\/([a-z]+)'\)/g)].map(x => x[1])) {
    const p = path.join(cfDir, 'lib', m + '.js')
    if (!fs.existsSync(p)) errors.push('云函数 lib 缺失: lib/' + m + '.js')
  }

  // 前端调用到的 action 是否都已注册
  const calls = new Set()
  for (const f of walk(path.join(ROOT, 'miniprogram'), ['js'])) {
    const s = fs.readFileSync(f, 'utf8')
    for (const m of s.matchAll(/callApi\(\s*'([a-zA-Z][a-zA-Z0-9]*)'/g)) calls.add(m[1])
  }
  const unknown = [...calls].filter(c => !declared.includes(c))
  if (unknown.length) errors.push('前端调用了未注册的 action: ' + unknown.join(', '))

  notes.push(`云函数 action: ${declared.length} 个 (${declared.join(', ')})`)
  notes.push(`前端调用 action: ${[...calls].length} 个, 未注册 ${unknown.length}`)
}

console.log('--- NOTES ---')
console.log(notes.join('\n'))
console.log('--- ERRORS ---')
console.log(errors.length ? errors.join('\n') : 'none')
process.exit(errors.length ? 1 : 0)
