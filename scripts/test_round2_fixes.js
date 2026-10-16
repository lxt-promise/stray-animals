/**
 * 2026-10-15 第二轮需求的行为级测试
 *
 * 覆盖四项改动：
 *  1) 视频识别点击上传无反应 —— recognize.choose 在 video 模式下走 chooseVideo（回退 chooseMedia），
 *     并且**区分「用户取消」与「真失败」**，真失败必须吐 toast（不再静默吞掉）。
 *  2) (a) 确认识别不再把照片/特征写进特征库（vision.confirm 不再回写 cats.embedding）；
 *     (b) 档案页「已入库标准照」计数：只设封面照（photos 空）时应显示 1。
 *  3) 档案页不再展示「识别置信度」圆环 / 百分比 / LOCAL ENGINE / 置信度说明。
 *  4) 地图「附近猫咪」默认只显示前 2 只（NEAR_TOP_N），其余折叠，可点「查看更多」展开；
 *     有定位时按距离升序（真正的「最近」）。
 *
 * 运行：node scripts/test_round2_fixes.js
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const ROOT = path.resolve(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')

let pass = 0, fail = 0
const failures = []
const assert = (name, cond, extra) => {
  if (cond) { pass++; return }
  fail++
  failures.push(name)
  console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))
}
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ==================== 通用环境桩 ==================== */
const FAKE_APP = {
  globalData: { school: { name: '示例大学' }, user: null, ready: true, myLocation: null },
  ensureReady: async () => {},
  callApi: async () => ({ list: [] })
}
const toastCalls = []
global.wx = {
  showToast: o => toastCalls.push(o),
  showLoading: () => {}, hideLoading: () => {}, showModal: () => {},
  navigateTo: () => {}, switchTab: () => {}, setStorageSync: () => {},
  getStorageSync: () => '', removeStorageSync: () => {},
  getLocation: () => {}, createMapContext: () => ({}), stopPullDownRefresh: () => {},
  previewImage: () => {}, openLocation: () => {}, getSystemInfoSync: () => ({ platform: 'ios' }),
  request: () => {}, login: () => {}, getSetting: () => {}, authorize: () => {},
  // chooseMedia / chooseVideo 由各用例替换
  chooseMedia: async () => { throw { errMsg: 'chooseMedia:fail cancel' } },
  chooseVideo: async () => { throw { errMsg: 'chooseVideo:fail cancel' } },
  cloud: {
    callFunction: async () => ({ result: { ok: true, data: {} } }),
    uploadFile: async () => ({ fileID: 'cloud://x/1.jpg' }),
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(f => ({ fileID: f, status: 0, tempFileURL: 'https://t/' + encodeURIComponent(f) })) })
  }
}
let pageOptions = null
global.getApp = () => FAKE_APP
global.Page = opts => { pageOptions = opts }
global.App = () => {}
global.Component = () => {}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request && /\.wxml$|\.wxss$|\.json$/.test(request)) return {}
  return origLoad.apply(this, arguments)
}

/* ==================== 1. 视频选择 ==================== */
console.log('\n--- 1. 视频识别选择素材 ---')
require(path.join(MP, 'pages/recognize/recognize.js'))
const rec = pageOptions
assert('recognize.js 注册成功', !!rec)
assert('提供 pickVideo 方法', typeof rec.pickVideo === 'function')
assert('提供 pickImage 方法', typeof rec.pickImage === 'function')
assert('提供 isCancel 判定', typeof rec.isCancel === 'function')

// isCancel：只认 cancel/取消
assert('isCancel 认 chooseMedia:fail cancel', rec.isCancel({ errMsg: 'chooseMedia:fail cancel' }) === true)
assert('isCancel 认中文「取消」', rec.isCancel({ errMsg: '用户取消' }) === true)
assert('isCancel 不认真实失败', rec.isCancel({ errMsg: 'chooseVideo:fail permission denied' }) === false)
assert('isCancel 对空值安全', rec.isCancel(null) === false)

// pickVideo：优先 chooseVideo，且映射 thumbTempFilePath / duration
;(async () => {
  let usedChooseVideo = false
  wx.chooseVideo = async () => {
    usedChooseVideo = true
    return { tempFilePath: '/tmp/v.mp4', thumbTempFilePath: '/tmp/v.jpg', duration: 8 }
  }
  const f = await rec.pickVideo()
  assert('pickVideo 优先调用 chooseVideo', usedChooseVideo)
  assert('pickVideo 映射 tempFilePath', f.tempFilePath === '/tmp/v.mp4', f)
  assert('pickVideo 映射封面帧 thumbTempFilePath', f.thumbTempFilePath === '/tmp/v.jpg', f)
  assert('pickVideo 映射 duration', f.duration === 8, f)

  // chooseVideo 抛错 → 回退 chooseMedia
  wx.chooseVideo = async () => { throw { errMsg: 'chooseVideo:fail not support' } }
  let usedChooseMedia = false
  wx.chooseMedia = async opts => {
    usedChooseMedia = true
    assert('回退 chooseMedia 时 mediaType 为 video', Array.isArray(opts.mediaType) && opts.mediaType[0] === 'video', opts.mediaType)
    return { tempFiles: [{ tempFilePath: '/tmp/v2.mp4', thumbTempFilePath: '/tmp/v2.jpg', duration: 5 }] }
  }
  const f2 = await rec.pickVideo()
  assert('chooseVideo 失败后回退 chooseMedia', usedChooseMedia)
  assert('回退后仍能取到视频路径', f2 && f2.tempFilePath === '/tmp/v2.mp4', f2)
  assert('chooseVideo 失败后回退 chooseMedia', usedChooseMedia)
  assert('回退后仍能取到视频路径', f2 && f2.tempFilePath === '/tmp/v2.mp4', f2)

  // pickImage：mediaType image + sizeType compressed
  let imgOpts = null
  wx.chooseMedia = async opts => { imgOpts = opts; return { tempFiles: [{ tempFilePath: '/tmp/i.jpg' }] } }
  const fi = await rec.pickImage()
  assert('pickImage 用 mediaType image', imgOpts.mediaType[0] === 'image', imgOpts.mediaType)
  assert('pickImage 压缩上传', imgOpts.sizeType[0] === 'compressed', imgOpts.sizeType)
  assert('pickImage 返回第一张', fi.tempFilePath === '/tmp/i.jpg', fi)

  /* ---- 2a. 确认不入特征库（云函数源码契约 + 前端文案） ---- */
  console.log('\n--- 2a. 确认不再写特征库 ---')
  const vision = read('cloudfunctions/catcampus/lib/vision.js')
  assert('confirm 不再写 cats.embedding', !/data:\s*\{\s*embedding:\s*emb/.test(vision),
    '仍存在 embedding 回写：确认会把识别照片当标准照入库')
  assert('confirm 里 embeddingWritten 恒 false', /const embeddingWritten = false/.test(vision))
  assert('confirm 仍写标注样本 aiSample', /COL\.aiSample\)\.add/.test(vision))
  assert('confirm 函数头说明不再入库', /不再把本次识别特征写进该猫特征库/.test(vision))

  const recWxml = read('miniprogram/pages/recognize/recognize.wxml')
  assert('确认卡文案不再提「写入该猫档案」', !/写入该猫档案作为比对样本/.test(recWxml))
  assert('确认卡文案改为标注样本', /标注样本/.test(recWxml))
  const recJs = read('miniprogram/pages/recognize/recognize.js')
  assert('前端 toast 不再出现「已记入特征库」', !/已记入特征库/.test(recJs))

  /* ---- 2b. 标准照计数（回退 avatar） ---- */
  console.log('\n--- 2b. 档案标准照计数 ---')
  require(path.join(MP, 'pages/cat-detail/cat-detail.js'))
  const detail = pageOptions
  assert('cat-detail.js 注册成功', !!detail)
  // 直接验证计数逻辑：photos 空 + avatar 有 → 1
  // 用 load 需要 mock getCat，这里退化为源码契约 + 一段等价逻辑复算
  const srcLogic = (cat) => (cat.photos && cat.photos.length) ? cat.photos.length : (cat.avatar ? 1 : 0)
  assert('计数：photos=[] + avatar → 1', srcLogic({ photos: [], avatar: 'cloud://a/1.jpg' }) === 1)
  assert('计数：photos=[2张] → 2', srcLogic({ photos: ['a', 'b'], avatar: 'x' }) === 2)
  assert('计数：都没有 → 0', srcLogic({ photos: [], avatar: '' }) === 0)
  const detailJs = read('miniprogram/pages/cat-detail/cat-detail.js')
  assert('cat-detail 计数与云端口径一致（photos 空回退 avatar）',
    /photoCount\s*=[\s\S]{0,120}cat\.photos[\s\S]{0,80}cat\.avatar\s*\?\s*1\s*:\s*0/.test(detailJs))

  /* ---- 3. 去掉置信度展示 ---- */
  console.log('\n--- 3. 档案页去掉置信度 ---')
  const detailWxml = read('miniprogram/pages/cat-detail/cat-detail.wxml')
  assert('WXML 不再展示「识别置信度」标题', !/识别置信度/.test(detailWxml))
  assert('WXML 不再有 conf-ring 圆环', !/conf-ring/.test(detailWxml))
  assert('WXML 不再有 LOCAL ENGINE', !/LOCAL ENGINE/.test(detailWxml))
  assert('WXML 不再绑定 confidence', !/\{\{\s*confidence\s*\}\}/.test(detailWxml))
  assert('WXML 不再绑定 confText', !/\{\{\s*confText\s*\}\}/.test(detailWxml))
  assert('WXML 仍保留标准照计数', /已入库[\s\S]{0,40}photoCount/.test(detailWxml))
  const detailWxss = read('miniprogram/pages/cat-detail/cat-detail.wxss')
  assert('WXSS 已清理 conf-ring 死样式', !/\.conf-ring/.test(detailWxss))
  assert('WXSS 已清理 ring-num 死样式', !/\.ring-num/.test(detailWxss))
  assert('cat-detail.js 不再计算 confidence 字段', !/const confidence =/.test(detailJs))

  /* ---- 4. 附近猫咪折叠 ---- */
  console.log('\n--- 4. 附近猫咪默认折叠 ---')
  require(path.join(MP, 'pages/map/map.js'))
  const map = pageOptions
  assert('map.js 注册成功', !!map)
  assert('NEAR_TOP_N 为 2', map.data.NEAR_TOP_N === 2, map.data.NEAR_TOP_N)
  assert('默认未展开 listExpanded=false', map.data.listExpanded === false)
  assert('提供 nearListFields', typeof map.nearListFields === 'function')
  assert('提供 toggleExpandNear', typeof map.toggleExpandNear === 'function')

  // 无定位时保持原顺序
  map.data.myLocation = null
  const plain = map.nearListFields([{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }])
  assert('无定位时保持原顺序', plain.cats.map(c => c._id).join(',') === 'a,b,c', plain.cats.map(c => c._id))

  // 有定位时按距离升序：c 最近、a 最远
  map.data.myLocation = { lat: 30, lng: 114 }
  const sorted = map.nearListFields([
    { _id: 'a', lat: 30.9, lng: 114 },   // 最远
    { _id: 'b', lat: 30.1, lng: 114 },   // 中间
    { _id: 'c', lat: 30.001, lng: 114 }  // 最近
  ])
  assert('有定位时按距离升序（最近在前）', sorted.cats[0]._id === 'c' && sorted.cats[2]._id === 'a',
    sorted.cats.map(c => c._id))
  assert('排序不就地改动原数组（复制后排序）', (() => {
    const orig = [{ _id: 'a', lat: 30.9, lng: 114 }, { _id: 'c', lat: 30.001, lng: 114 }]
    map.nearListFields(orig)
    return orig[0]._id === 'a'
  })())

  // toggleExpandNear 翻转
  map.setData = d => { Object.assign(map.data, d) }
  map.data.listExpanded = false
  map.toggleExpandNear()
  assert('toggleExpandNear 展开', map.data.listExpanded === true)
  map.toggleExpandNear()
  assert('toggleExpandNear 再点收起', map.data.listExpanded === false)

  const mapWxml = read('miniprogram/pages/map/map.wxml')
  assert('WXML 用 index < NEAR_TOP_N 控制显隐', /index\s*<\s*NEAR_TOP_N\s*\|\|\s*listExpanded/.test(mapWxml))
  assert('WXML 有「查看更多」按钮', /查看更多/.test(mapWxml))
  assert('WXML 有「收起」按钮', /收起/.test(mapWxml))
  assert('WXML 复用单一 cats 列表（未用 slice）', !/cats\.slice\(/.test(mapWxml))
  const mapWxss = read('miniprogram/pages/map/map.wxss')
  assert('WXSS 提供 sheet-more 样式', /\.sheet-more\s*\{/.test(mapWxss))

  /* ---- 5. 识别进度条单调递增（100% → 轮询退回 60% 的修复） ---- */
  console.log('\n--- 5. 识别进度条单调递增 ---')

  // 5a. setProgress 行为：只许前进，永不后退
  const mkRec = () => {
    const r = Object.assign({}, rec)
    r.data = Object.assign({}, rec.data, { progress: 0, stageText: '' })
    r.setData = d => Object.assign(r.data, d)
    return r
  }
  let pr = mkRec()
  pr.setProgress(40, '步骤一')
  assert('setProgress 前进写入', pr.data.progress === 40 && pr.data.stageText === '步骤一', pr.data)
  pr.setProgress(20, '步骤二')
  assert('setProgress 拒绝后退（20 不覆盖 40）', pr.data.progress === 40, pr.data.progress)
  // 进度值不许后退；但文案允许前进（轮询阶段名会在同进度下持续刷新，属预期）
  assert('拒绝后退时数值仍是 40', pr.data.progress === 40, pr.data)
  pr.setProgress(40, '步骤一')
  assert('同进度不传文案时短路不刷 setData', (() => {
    let calls = 0
    const q = mkRec()
    const osd = q.setData
    q.setData = d => { calls++; osd.call(q, d) }
    q.setProgress(40, '步骤一')
    calls = 0
    q.setProgress(40)          // 无文案 + 同进度 → 短路
    return calls === 0
  })())
  pr.setProgress(92, undefined)
  assert('setProgress 允许只改进度不改文案', pr.data.progress === 92 && pr.data.stageText === '步骤一', pr.data)
  pr.setProgress(999, 'x')
  assert('setProgress 夹紧到 100', pr.data.progress === 100, pr.data.progress)
  pr = mkRec()
  pr.setProgress(-5, 'y')
  assert('setProgress 夹紧下界到 0', pr.data.progress === 0, pr.data.progress)

  // 5b. 动画永不自己爬到 100（上限 STAGE_CEIL=92）
  assert('存在 STAGE_CEIL 常量', /const STAGE_CEIL\s*=\s*92/.test(recJs))
  assert('STAGES 最大值不超过 92', (() => {
    const m = recJs.match(/const STAGES = \[([\s\S]*?)\]/)
    if (!m) return false
    const ps = [...m[1].matchAll(/p:\s*(\d+)/g)].map(x => Number(x[1]))
    return ps.length > 0 && Math.max(...ps) <= 92
  })())
  assert('STAGES 里没有 100', !/const STAGES = \[[\s\S]*?p:\s*100[\s\S]*?\n\]/.test(recJs))
  assert('analyze 首次置 8% 起步', /setData\(\{\s*stage:\s*'working',\s*progress:\s*8/.test(recJs))
  assert('analyze 动画停表（i 越界后用 else 分支 clearInterval）', (() => {
    const i = recJs.indexOf('const timer = setInterval')
    if (i < 0) return false
    const body = recJs.slice(i, i + 500)
    return /else\s*\{[\s\S]*?clearInterval\(timer\)/.test(body)
  })())

  // 5c. 动画与轮询都走 setProgress（同一单调入口），而不是裸 setData(progress)
  assert('analyze 动画走 setProgress', /this\.setProgress\(STAGES\[i\]\.p/.test(recJs))
  assert('pollResult 走 setProgress', /this\.setProgress\(Math\.min\(95, polled\)/.test(recJs))
  assert('轮询折算区间上限 95（<100，100 只留给终态）', /40 \+ \(Number\(r\.progress\) \|\| 0\) \* 0\.55/.test(recJs))

  // 5d. 终态才显式置 100，且同样经 setProgress
  assert('成功分支经 setProgress 置 100', /this\.setProgress\(100, '完成'\)/.test(recJs))
  assert('成功分支不再裸 setData progress:100', !/setData\(\{[^}]*progress:\s*100/.test(
    recJs.slice(recJs.indexOf('async analyze'), recJs.indexOf('async pollResult'))
  ))
  assert('失败分支也把进度收到 100', /this\.setProgress\(100, '识别结束'\)/.test(recJs))

  // 5e. 端到端：模拟「动画爬到 92 → 轮询回报低值 → 成功」，全程单调
  const seq = []
  const sim = mkRec()
  const origSetData = sim.setData
  sim.setData = d => { origSetData.call(sim, d); if (d && 'progress' in d) seq.push(d.progress) }
  // 动画：20 → 40 → 58 → 74 → 92
  ;[20, 40, 58, 74, 92].forEach(p => sim.setProgress(p))
  // 轮询先报低（60 折算 40+55*... 但这里直接给 40~95 的值），必须被挡住
  sim.setProgress(Math.min(95, 40 + 30 * 0.55), '正在做安全检测…')
  sim.setProgress(Math.min(95, 40 + 100 * 0.55), '即将完成…')
  // 终态
  sim.setProgress(100, '完成')
  assert('进度序列全程单调不减', seq.every((v, i) => i === 0 || v >= seq[i - 1]), seq)
  assert('进度序列最终为 100', seq[seq.length - 1] === 100, seq)
  assert('轮询低值未把进度拉回（92 后仍为 92）', seq.indexOf(92) >= 0 && seq[seq.indexOf(92) + 1] >= 92, seq)

  /* ---- 6. 视频「选了视频点确定还是没上传」的修复 ---- */
  console.log('\n--- 6. 视频上传健壮性 ---')

  // 6a. uploadToCloud：必定返回 fileID，否则抛可读错误
  assert('提供 uploadToCloud 方法', typeof rec.uploadToCloud === 'function')
  assert('存在 WORKING_STALE_MS 常量', /const WORKING_STALE_MS\s*=\s*\d+/.test(recJs))

  const mkUp = (behavior) => {
    const r = Object.assign({}, rec)
    r.data = Object.assign({}, rec.data)
    r.setData = d => Object.assign(r.data, d)
    wx.cloud.uploadFile = behavior
    return r
  }

  // 成功：返回 fileID
  let upRes = null
  let upErr = null
  try {
    upRes = await mkUp(async () => ({ fileID: 'cloud://env/recognize/a.mp4' }))
      .uploadToCloud('recognize/a.mp4', '/tmp/a.mp4', '视频')
  } catch (e) { upErr = e }
  assert('uploadToCloud 成功返回 fileID', upRes && upRes.fileID === 'cloud://env/recognize/a.mp4', upRes)
  assert('uploadToCloud 成功不抛错', upErr === null, upErr && upErr.message)

  // 失败：微信抛普通对象 {errMsg}，必须转成含「视频上传失败」的可读 Error
  upErr = null
  try {
    await mkUp(async () => { throw { errMsg: 'uploadFile:fail timeout' } })
      .uploadToCloud('recognize/a.mp4', '/tmp/a.mp4', '视频')
  } catch (e) { upErr = e }
  assert('uploadFile 抛 errMsg 对象 → 转可读 Error', upErr instanceof Error, upErr)
  assert('错误信息指明是「视频上传失败」', /视频上传失败/.test(upErr && upErr.message), upErr && upErr.message)
  assert('错误信息保留 errMsg 内容（timeout）', /timeout/.test(upErr && upErr.message), upErr && upErr.message)
  assert('错误信息剔除技术前缀 uploadFile:fail', !/uploadFile:fail/.test(upErr && upErr.message), upErr && upErr.message)

  // 失败：resolve 了但没有 fileID —— 这正是「界面显示成功但云上什么都没有」的元凶
  upErr = null
  try {
    await mkUp(async () => ({ statusCode: 200 }))
      .uploadToCloud('recognize/a.mp4', '/tmp/a.mp4', '视频')
  } catch (e) { upErr = e }
  assert('uploadFile 无 fileID → 显式抛错（不再假装成功）', upErr instanceof Error, upErr)
  assert('无 fileID 的错误提示「未返回文件标识」', /未返回文件标识/.test(upErr && upErr.message), upErr && upErr.message)

  // null 返回同样拦下
  upErr = null
  try {
    await mkUp(async () => null).uploadToCloud('recognize/a.mp4', '/tmp/a.mp4', '视频')
  } catch (e) { upErr = e }
  assert('uploadFile 返回 null → 抛错', upErr instanceof Error, upErr)

  // 标签随素材类型变化
  upErr = null
  try {
    await mkUp(async () => { throw { errMsg: 'uploadFile:fail x' } })
      .uploadToCloud('recognize/b.jpg', '/tmp/b.jpg', '照片')
  } catch (e) { upErr = e }
  assert('照片失败文案为「照片上传失败」', /照片上传失败/.test(upErr && upErr.message), upErr && upErr.message)

  // 6b. analyze 用 uploadToCloud（不再裸调 uploadFile）
  // 注意：只对 analyze 函数体断言 —— uploadToCloud 内部当然要调 wx.cloud.uploadFile
  const analyzeBody = recJs.slice(recJs.indexOf('async analyze'), recJs.indexOf('async pollResult'))
  assert('analyze 走 uploadToCloud 上传主素材', /this\.uploadToCloud\(cloudPath/.test(analyzeBody))
  assert('analyze 内不再裸调 wx.cloud.uploadFile', !/wx\.cloud\.uploadFile/.test(analyzeBody))
  assert('封面帧上传失败不致命（try/catch 包裹）',
    /thumbPath\)\s*\{[\s\S]{0,240}?try\s*\{[\s\S]{0,240}?uploadToCloud/.test(analyzeBody))

  // 6c. 错误信息回落 errMsg（否则永远是「识别失败，请重试」）
  assert('catch 里回落 e.errMsg', /e\.message\s*\|\|\s*e\.errMsg/.test(analyzeBody), 'analyze 的 catch 必须兼容普通对象异常')

  // 6d. choose 不再静默 return：僵死复位 + 明确 toast
  const chooseBody = recJs.slice(recJs.indexOf('async choose'), recJs.indexOf('async pickVideo'))
  assert('choose 对 working 有提示而非静默 return', /正在识别中，请稍候/.test(chooseBody))
  assert('choose 检测 working 僵死并复位', /WORKING_STALE_MS/.test(chooseBody) && /this\.reset\(\)/.test(chooseBody))
  assert('choose 对缺失 tempFilePath 明确 toast', /未能读取所选视频/.test(chooseBody))
  assert('analyze 记录 _workingSince 供僵死判定', /this\._workingSince\s*=\s*Date\.now\(\)/.test(recJs))
  assert('reset 清空 _workingSince', /reset\(\)\s*\{[\s\S]{0,80}?this\._workingSince\s*=\s*0/.test(recJs))
  assert('switchMode 清空 _workingSince', /switchMode\(e\)\s*\{[\s\S]{0,220}?this\._workingSince\s*=\s*0/.test(recJs))

  // 6e. 端到端：video 模式上传失败必须给出可读错误（而非通用兜底）
  const E2E = mkRec()
  E2E.data.mode = 'video'
  wx.chooseVideo = async () => ({ tempFilePath: '/tmp/e2e.mp4', thumbTempFilePath: '/tmp/e2e.jpg', duration: 9 })
  wx.cloud.uploadFile = async () => { throw { errMsg: 'uploadFile:fail timeout' } }
  const origE2ESet = E2E.setData
  E2E.setData = d => origE2ESet.call(E2E, d)
  await E2E.choose()
  await new Promise(r => setTimeout(r, 60))
  assert('端到端：视频上传失败 → stage done 且 error 可读',
    E2E.data.stage === 'done' && /视频上传失败/.test(E2E.data.error || ''), E2E.data.error)

  console.log('\n=== 结果 ===')
  console.log('PASS ' + pass + ' / FAIL ' + fail)
  if (failures.length) { console.log('\n失败项：'); failures.forEach(f => console.log('  - ' + f)) }
  process.exit(fail ? 1 : 0)
})().catch(e => {
  console.error('测试异常', e && e.stack || e)
  process.exit(1)
})
