/**
 * 识别测试台页面渲染验证（无头 Chrome）。
 * 1) 打开 /vision，等 Vue 挂载
 * 2) 断言关键元素渲染出来（不是白屏 / 不是报错页）
 * 3) 断言健康检查自动跑通，状态徽标显示「识别服务在线」
 * 4) 截图存档
 * 5) 收集控制台错误与页面异常
 */
const path = require('path')
const fs = require('fs')

// playwright-core 不在项目里，从 WorkBuddy 工作区加载（路径可能随环境变化，故多候选）
const CANDIDATES = [
  process.env.PW_CORE,
  'E:/Agent/WorkBuddy/2026-09-22-20-57-37/node_modules/playwright-core',
  'E:/Agent/WorkBuddy/binaries/node/workspace/node_modules/playwright-core',
].filter(Boolean)

let chromium = null
for (const c of CANDIDATES) {
  try { chromium = require(c).chromium; break } catch (e) { /* 换下一个 */ }
}
if (!chromium) {
  console.error('未找到 playwright-core，可用 PW_CORE 环境变量指定路径')
  process.exit(1)
}

const URL = process.env.URL || 'http://127.0.0.1:5173/vision'
const OUT = process.env.OUT || 'E:/Agent/project/stray-animals/web/_vision_page.png'

let PASS = 0, FAIL = 0
const check = (name, cond, detail = '') => {
  if (cond) { PASS++; console.log(`  PASS  ${name}`) }
  else { FAIL++; console.log(`  FAIL  ${name}   ${detail}`) }
}

;(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME ||
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args: ['--no-sandbox']
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))

  console.log('=== 识别测试台 页面渲染验证 ===\n')
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(2500)   // 等 onMounted 的健康检查回来

  const text = await page.innerText('body')
  check('页面非白屏', text.trim().length > 50, `len=${text.trim().length}`)
  check('标题渲染', text.includes('识别测试台'))
  check('上传区渲染', text.includes('点击选择') || text.includes('猫'))
  check('结果区渲染', text.includes('识别结果'))
  check('说明区渲染', text.includes('这个页面在验证什么'))

  const badge = await page.locator('.tag').first().innerText().catch(() => '')
  console.log(`      状态徽标：${badge.trim()}`)
  check('健康检查自动执行并显示服务状态', /识别服务/.test(badge), badge)

  // 引擎信息四宫格
  const miniNums = await page.locator('.mini .num').allInnerTexts().catch(() => [])
  console.log(`      引擎信息：${JSON.stringify(miniNums)}`)
  check('显示推理后端 = onnx', miniNums.includes('onnx'), JSON.stringify(miniNums))

  const providerOk = miniNums.includes('onnx')
  check('显示特征维度 768', miniNums.includes('768'), JSON.stringify(miniNums))

  // 提示：占位引擎时才出现
  const hintText = await page.locator('.hint').first().innerText().catch(() => '')
  if (!providerOk) console.log(`      提示条：${hintText.slice(0, 80)}`)

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  await page.screenshot({ path: OUT, fullPage: true })
  console.log(`\n  截图：${OUT}  (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`)

  // ---- 完整交互：上传一张猫照 → 点识别 → 断言结果渲染 ----
  // 注意必须用「单只猫」的照片。用四格拼图当查询图时，图像里根本没有单只猫，
  // 分数自然偏低（实测 Top1 只有 62），那是正确行为不是 bug。
  let IMG = process.env.TEST_IMAGE
  if (!IMG) {
    const probe = 'E:/Agent/project/stray-animals/server/data/_test_cat1.jpg'
    const grid = 'E:/Agent/project/stray-animals/server/data/_cats.jpeg'
    if (fs.existsSync(probe)) {
      IMG = probe
    } else if (fs.existsSync(grid)) {
      // 从四格拼图裁左上角那只猫，作为单猫查询图
      try {
        const { execFileSync } = require('child_process')
        execFileSync('E:/Agent/project/stray-animals/env/Scripts/python.exe', ['-c', `
from PIL import Image
im = Image.open(r'${grid}').convert('RGB')
w, h = im.size
im.crop((0, 0, w//2, h//2)).save(r'${probe}', quality=92)
print('ok')
`], { stdio: 'ignore' })
        IMG = probe
      } catch (e) {
        IMG = grid
      }
    }
  }
  if (fs.existsSync(IMG)) {
    console.log('\n--- 上传识别全流程 ---')
    // 后端 /api/upload 需要登录态；这里先注册/登录一个测试账号
    await page.evaluate(async () => {
      const r = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'visiontester', password: 'test123456',
          nickName: '识别测试', schoolName: '测试大学'
        })
      }).then(r => r.json()).catch(() => null)
      if (r && r.code === 0 && r.data && r.data.token) {
        localStorage.setItem('catcampus_token', r.data.token)
        return
      }
      const l = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'visiontester', password: 'test123456' })
      }).then(r => r.json()).catch(() => null)
      if (l && l.code === 0 && l.data && l.data.token) {
        localStorage.setItem('catcampus_token', l.data.token)
      }
    })
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(1200)

    await page.setInputFiles('input[type=file]', IMG)
    await page.waitForTimeout(800)
    check('选了图后出现预览', await page.locator('img.preview').count() > 0)

    const runBtn = page.locator('button:has-text("开始识别")')
    check('出现「开始识别」按钮', await runBtn.count() > 0)
    await runBtn.click()

    // 等候选卡片出现（真实模型约 300~600ms，给足余量）
    await page.waitForSelector('.cand', { timeout: 90000 }).catch(() => {})
    await page.waitForTimeout(1500)

    const cCount = await page.locator('.cand').count()
    console.log(`      渲染候选卡片 ${cCount} 张`)
    check('识别结果渲染出候选', cCount > 0, `count=${cCount}`)

    if (cCount > 0) {
      const scores = (await page.locator('.cand .score').allInnerTexts()).map(s => Number(s.trim()))
      console.log(`      候选分数：${JSON.stringify(scores)}`)
      check('分数非空且为数字', scores.every(s => Number.isFinite(s)), JSON.stringify(scores))
      check('分数在 0~99 区间', scores.every(s => s >= 0 && s <= 99), JSON.stringify(scores))
      // 单猫查询图应命中档案库并拿高分（实测 99）；拼图等整图则分数自然低
      const isSingleCat = /_test_cat1/.test(IMG)
      if (isSingleCat) {
        check('单猫图 Top1 高分 (>= 85)', scores[0] >= 85, `top=${scores[0]}`)
        check('与次名拉开差距', scores.length === 1 || scores[0] - scores[1] >= 20,
              JSON.stringify(scores))
      }

      const tags = await page.locator('.tag').allInnerTexts()
      console.log(`      属性标签：${JSON.stringify(tags.slice(0, 6))}`)
    }

    const metaTxt = await page.locator('.meta').innerText().catch(() => '')
    console.log(`      元信息：${metaTxt.replace(/\s+/g, ' ').trim()}`)
    check('显示耗时与库内数量', /耗时/.test(metaTxt) && /库内/.test(metaTxt), metaTxt)

    await page.screenshot({ path: OUT.replace('.png', '_result.png'), fullPage: true })
    console.log(`  截图：${OUT.replace('.png', '_result.png')}`)
  } else {
    console.log(`\n  [跳过] 测试图片不存在：${IMG}`)
  }

  const realErrors = errors.filter(e => !/favicon|DevTools/i.test(e))
  check('无 JS 控制台错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  console.log(`\n=== PASS ${PASS} / FAIL ${FAIL} ===`)
  await browser.close()
  process.exit(FAIL === 0 ? 0 : 1)
})().catch(e => { console.error('运行失败:', e.message); process.exit(1) })
