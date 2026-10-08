const { chromium } = require('E:\\Agent\\WorkBuddy\\2026-09-22-20-57-37\\node_modules\\playwright-core')
const FILE = 'file:///E:/Agent/project/stray-animals/preview/index.html'

;(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true
  })
  const page = await browser.newPage({ viewport: { width: 900, height: 940 }, deviceScaleFactor: 2 })
  page.on('pageerror', e => console.log('PAGEERROR:', e.message))
  await page.goto(FILE, { waitUntil: 'networkidle' })

  const info = await page.evaluate(() => {
    S.page = 'rec'; S.recStage = 'done'; render()
    const f = document.querySelector('.feats')
    const c = document.querySelector('.cand')
    const av = document.querySelector('.cand .av')
    const vp = document.querySelector('.viewport')
    return {
      featCount: document.querySelectorAll('.feat').length,
      candCount: document.querySelectorAll('.cand').length,
      featsDisplay: f ? getComputedStyle(f).display : 'NO ELEMENT',
      featsCols: f ? getComputedStyle(f).gridTemplateColumns : '',
      candDisplay: c ? getComputedStyle(c).display : 'NO ELEMENT',
      viewportH: vp ? getComputedStyle(vp).height : 'NO ELEMENT'
    }
  })
  console.log(JSON.stringify(info, null, 2))
  await page.screenshot({ path: 'E:\\Agent\\project\\stray-animals\\_shot2.png' })

  // 猫谱页
  await page.evaluate(() => { S.page = 'cats'; render() })
  await page.waitForTimeout(600)
  await page.screenshot({ path: 'E:\\Agent\\project\\stray-animals\\_shot3.png' })

  await browser.close()
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
