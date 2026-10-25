/**
 * 陈旧临时链接自愈回归（2026-10-24 重建特征库遇 403）
 *
 * 现场：重建特征库时部分猫下载 403。日志里失败那条
 *   https://xxx.tcb.qcloud.la/cats/1791901198303-18.jpg?sign=...&t=1792841226
 * 的 t 明显比同期换出来的链接老一大截 —— 说明档案里存的不是 `cloud://` fileID，
 * 而是历史版本写进去的**临时链接**（带 sign/t，若干小时即失效）。
 * 建库链路 attachTempUrls 只认 cloud://，这类链接被原样透传给服务端 → 必然 403。
 *
 * 断言打在**意图**上：
 *  ① 反推能识别陈旧的 tcb 临时链接并还原出 fileID；
 *  ② 还原出的 fileID 会重新换链，拿到的必须是**新**链接而不是原值；
 *  ③ 外部图床链接（非 tcb 域名）不被误伤，原样透传；
 *  ④ 文件已被删除的情况（getTempFileURL status≠0）要留痕而不是静默。
 *
 * 运行：node scripts/test_stale_url_recovery.js
 */
const Module = require('module')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

/* ============ wx-server-sdk 桩 ============ */
// 用真实报警日志里的域名形态做样本，保证 fixtures 与线上一致
const ENV = 'cloud1-d5goanqd3a600dc8f'
const BUCKET = '636c-cloud1-d5goanqd3a600dc8f-1497425603'
const HOST = BUCKET + '.tcb.qcloud.la'

/** 已自动化的 getTempFileURL：只对「存在」的 fileID 返回新链接 */
let requested = []
const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test',
  init() {},
  database() { return {} },
  async getTempFileURL({ fileList }) {
    requested = requested.concat(fileList)
    return {
      fileList: fileList.map(f => {
        if (/cats\/missing-/.test(f)) {
          return { fileID: f, tempFileURL: '', status: -1, errMsg: '文件不存在' }
        }
        return { fileID: f, tempFileURL: 'https://' + HOST + '/signed' + encodeURI(f), status: 0 }
      })
    }
  }
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return fakeCloud
  return origLoad.apply(this, arguments)
}

const V = require(path.join(ROOT, 'cloudfunctions', 'catcampus', 'lib', 'vision.js'))
const { attachTempUrls, collectAuthorities, fileIdFromTempUrl } = V

/* ============ 断言 ============ */
let pass = 0, fail = 0
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

const STALE = 'https://' + HOST + '/cats/1791901198303-18.jpg?sign=5a6355d437af2be237c41467dbda8272&t=1792841226'
const WANT_ID = 'cloud://' + ENV + '.' + BUCKET + '/cats/1791901198303-18.jpg'

console.log('\n=== 1. 反推 fileID ===')
{
  const auths = collectAuthorities(['cloud://' + ENV + '.' + BUCKET + '/cats/healthy.jpg'])
  assert('从合法 fileID 学到 authority', auths.length === 1 && auths[0] === ENV + '.' + BUCKET, auths)
  assert('陈旧链接还原出 fileID', fileIdFromTempUrl(STALE, auths) === WANT_ID,
    fileIdFromTempUrl(STALE, auths))
  assert('path 里的 sign/t 被剥离', !/sign|&t=|t=/.test(fileIdFromTempUrl(STALE, auths) || ''))
  assert('外部图床不被误判', fileIdFromTempUrl('https://cdn.example.com/a.jpg', auths) === '')
  assert('本地临时路径不被误判', fileIdFromTempUrl('wxfile://tmp/abc.jpg', auths) === '')
  assert('没有样本 authority 时不硬猜', fileIdFromTempUrl(STALE, []) === '')
  assert('跨 bucket 不串環境', fileIdFromTempUrl(
    'https://other-bucket.tcb.qcloud.la/cats/1.jpg', auths) === '')
}

console.log('\n=== 2. attachTempUrls 端到端自愈 ===')
async function main() {
  requested = []
  // 猫 A 干净（提供 authority 样本）；猫 B 全是陈旧链接；猫 C 用了外部图床
  const cats = [
    { id: 'A', photos: ['cloud://' + ENV + '.' + BUCKET + '/cats/healthy.jpg'] },
    { id: 'B', photos: [STALE] },
    { id: 'C', photos: ['https://cdn.example.com/ext.jpg'] },
    { id: 'D', photos: ['https://' + HOST + '/cats/missing-999.jpg?sign=x&t=1'] }
  ]
  await attachTempUrls(cats, 6)

  assert('干净档案照常换链', /\/signed/.test(cats[0].photosUrl[0] || ''), cats[0].photosUrl)
  assert('陈旧链接被替换成新链接（不再是原值）',
    cats[1].photosUrl.length === 1 && cats[1].photosUrl[0] !== STALE, cats[1].photosUrl)
  assert('替换后确实是本次换出来的签名链接',
    /\/signed/.test(cats[1].photosUrl[0] || ''), cats[1].photosUrl)
  assert('反推时向 getTempFileURL 请求了还原出的 fileID',
    requested.indexOf(WANT_ID) >= 0, requested)
  assert('外部图床原样透传（不误伤）',
    cats[2].photosUrl[0] === 'https://cdn.example.com/ext.jpg', cats[2].photosUrl)
  assert('文件已删除的不能凭空变出链接（保留原值供服务端报错）',
    cats[3].photosUrl.length === 1 && cats[3].photosUrl[0].indexOf('missing-999') > 0,
    cats[3].photosUrl)
  assert('photoUrl 取首图', cats[1].photoUrl === cats[1].photosUrl[0])

  console.log('\n=== 3. avatar 兜底路径 ===')
  requested = []
  const two = [
    { id: 'A2', photos: [], avatar: 'cloud://' + ENV + '.' + BUCKET + '/cats/av.jpg' },
    { id: 'B2', avatar: STALE }
  ]
  await attachTempUrls(two, 6)
  assert('avatar 陈旧链接同样被自愈',
    /\/signed/.test(two[1].photoUrl || '') && two[1].photoUrl !== STALE, two[1].photoUrl)

  console.log('\n=== 4. 边界 ===')
  const empty = []
  await attachTempUrls(empty, 6)
  assert('空列表不炸', empty.length === 0)
  const none = [{ id: 'X', photos: ['wxfile://tmp/x.jpg'] }]
  await attachTempUrls(none, 6)
  assert('本地临时路径不会产生链接', (none[0].photosUrl || []).length === 0, none[0].photosUrl)

  console.log('\nPASS ' + pass + ' / FAIL ' + fail)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
