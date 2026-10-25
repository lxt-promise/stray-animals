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
const modalCalls = []
/** 所有提示文本（toast + modal 合并）：短文案走 toast，长文案走 modal（toast 会截断） */
const tipTexts = () => toastCalls.map(t => String(t.title || ''))
  .concat(modalCalls.map(m => String(m.content || '')))
const clearTips = () => { toastCalls.length = 0; modalCalls.length = 0 }
global.wx = {
  showToast: o => toastCalls.push(o),
  showModal: o => { modalCalls.push(o) },
  showLoading: () => {}, hideLoading: () => {},
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
    // 默认失败：单测关心「下载不可用时的降级链」，成功路径在第 7 节单独覆盖
    downloadFile: async () => { throw { errMsg: 'downloadFile:fail network' } },
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

  /* ---- 2b. 档案页不再展示「已入库标准照」 ---- */
  console.log('\n--- 2b. 档案页不展示入库照数量 ---')
  require(path.join(MP, 'pages/cat-detail/cat-detail.js'))
  const detail = pageOptions
  assert('cat-detail.js 注册成功', !!detail)
  // 2026-10-17 用户要求删除「该猫已入库 N 张标准照」。
  // 旧断言（"计数：photos=[] + avatar → 1" 等）锁死的是这段展示逻辑，
  // 一处改文案就全红 —— 而现在这段逻辑本身被删了，断言必须跟着改。
  const detailJs = read('miniprogram/pages/cat-detail/cat-detail.js')
  assert('cat-detail.js 不再计算 photoCount', !/photoCount/.test(detailJs),
    'photoCount 是「入库照数量」的唯一消费者，展示删了它也该删')

  /* ---- 3. 去掉置信度展示 ---- */
  console.log('\n--- 3. 档案页去掉置信度 ---')
  const detailWxml = read('miniprogram/pages/cat-detail/cat-detail.wxml')
  assert('WXML 不再展示「识别置信度」标题', !/识别置信度/.test(detailWxml))
  assert('WXML 不再有 conf-ring 圆环', !/conf-ring/.test(detailWxml))
  assert('WXML 不再有 LOCAL ENGINE', !/LOCAL ENGINE/.test(detailWxml))
  assert('WXML 不再绑定 confidence', !/\{\{\s*confidence\s*\}\}/.test(detailWxml))
  assert('WXML 不再绑定 confText', !/\{\{\s*confText\s*\}\}/.test(detailWxml))
  assert('WXML 不再展示入库标准照数量', !/已入库[\s\S]{0,40}标准照/.test(detailWxml),
    '「已入库 N 张标准照」已按用户要求删除')
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

  /* ---- 7. 照片查看：不再依赖 wx.previewImage（它加载失败只给一片黑） ---- */
  console.log('\n--- 7. 照片查看不再黑屏 ---')

  // 重新 require 一份新的 page options（前面 require 过，缓存里是旧引用）
  const CD_PATH = path.join(MP, 'pages/cat-detail/cat-detail.js')
  delete require.cache[require.resolve(CD_PATH)]
  require(CD_PATH)
  const detail2 = pageOptions
  assert('cat-detail 二次注册成功', !!detail2)

  const photo = require(path.join(MP, 'utils/photo.js'))
  assert('photo 导出 download（云 SDK 本地下载）', typeof photo.download === 'function')

  // 换链：域名必须用 *.tcb.qcloud.la —— photo.thumb 只对云存储域名拼 imageMogr2
  let tmpMode = 'stale'
  let tmpCalls = 0
  wx.cloud.getTempFileURL = async ({ fileList }) => {
    tmpCalls++
    return {
      fileList: fileList.map(f => {
        const bad = /__fail/.test(f)
        return {
          fileID: f,
          status: bad ? -1 : 0,
          tempFileURL: bad ? '' : ('https://' + tmpMode + '.tcb.qcloud.la/' + encodeURIComponent(f))
        }
      })
    }
  }

  // 云下载：默认失败（模拟网络异常），需要时切成成功
  let dlMode = 'fail'
  let dlCalls = 0
  wx.cloud.downloadFile = async ({ fileID }) => {
    dlCalls++
    if (dlMode === 'ok') return { tempFilePath: '/tmp/dl-' + encodeURIComponent(fileID) }
    throw { errMsg: 'downloadFile:fail timeout' }
  }

  // 本页绝不能再调 previewImage —— 它黑屏时连 fail 都不回调，是前两轮修不好的根源
  const previews = []
  wx.previewImage = o => previews.push(o)

  // setData 的路径写法（'viewer.cur' / 'cat.photosSmall[0]'）必须真的生效，
  // 否则断言读到的还是旧值，测试会变成自欺欺人
  const setPath = (obj, p, val) => {
    const parts = String(p).replace(/\[(\d+)\]/g, '.$1').split('.')
    let cur = obj
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i]
      if (cur[k] === null || cur[k] === undefined) cur[k] = /^\d+$/.test(parts[i + 1]) ? [] : {}
      else if (typeof cur[k] === 'object') cur[k] = Array.isArray(cur[k]) ? cur[k].slice() : Object.assign({}, cur[k])
      cur = cur[k]
    }
    cur[parts[parts.length - 1]] = val
  }

  const mkDetail = (photoIds, rawPhotos, small, full) => {
    const p = Object.assign({}, detail2)
    p.data = Object.assign({}, detail2.data, {
      cat: { photosSmall: small || [], photosFull: full || [] },
      viewer: { on: false, index: 0, no: 1, total: 0, cur: '', bad: false }
    })
    p.setData = d => { Object.keys(d || {}).forEach(k => setPath(p.data, k, d[k])) }
    // 与云端 getCat 口径一致：photos 是换好的临时链接，photoIds 才是原始 fileID
    p._rawCat = { photos: rawPhotos || [], photoIds: photoIds || [] }
    return p
  }

  const A1 = 'cloud://env/cats/a.jpg'
  const A2 = 'cloud://env/cats/b.jpg'
  const HOST = 'https://636c-cloud1-test-130000.tcb.qcloud.la'
  const SMALL = [
    HOST + '/cats/a.jpg?sign=x&imageMogr2/thumbnail/480x',
    HOST + '/cats/b.jpg?sign=x&imageMogr2/thumbnail/480x'
  ]

  // 7a. 点第 2 张：**同步**就要有可显示地址（先亮后清），不能先给一片黑
  const p1 = mkDetail([A1, A2], [], SMALL)
  const pending1 = p1.previewPhoto({ currentTarget: { dataset: { i: '1' } } })
  assert('查看器同步打开（不等网络）', p1.data.viewer.on === true, p1.data.viewer)
  assert('打开瞬间就用格子里那张（一定显示得出来）',
    p1.data.viewer.cur === SMALL[1], p1.data.viewer.cur)
  assert('序号正确（2 / 2）', p1.data.viewer.no === 2 && p1.data.viewer.total === 2, p1.data.viewer)
  await pending1

  // 7b. 大图优先：用 https 限宽 1440，而不是几 MB 原图
  const p2 = mkDetail([A1], [], [SMALL[0]], [HOST + '/cats/a.jpg?sign=x'])
  await p2.previewPhoto({ currentTarget: { dataset: { i: '0' } } })
  assert('大图走 https 限宽 1440（原图几 MB 是黑屏主因）',
    /imageMogr2\/thumbnail\/1440x/.test(p2.data.viewer.cur || ''), p2.data.viewer.cur)

  // 7c. 完全没有 https（只剩 fileID）→ 云下载成本地文件，<image> 直接可读
  dlMode = 'ok'
  tmpCalls = 0
  const p3 = mkDetail([A1], [], [])
  await p3.previewPhoto({ currentTarget: { dataset: { i: '0' } } })
  assert('无 https 时走云下载拿本地文件', /^\/tmp\/dl-/.test(p3.data.viewer.cur || ''), p3.data.viewer.cur)
  dlMode = 'fail'

  // 7d. 老档案自救：photos 只剩一条过期临时链接、photoIds 为空 →
  //     查看器里的图加载失败时必须从链接反推 fileID 把文件救回来
  FAKE_APP.globalData.envId = 'cloud1-test'
  const legacy = 'https://old-cloud1-test-130000.tcb.qcloud.la/cats/legacy.jpg?sign=expired'
  dlMode = 'ok'
  const p4 = mkDetail([], [legacy], [legacy])
  await p4.previewPhoto({ currentTarget: { dataset: { i: '0' } } })
  await p4.onViewerErr()   // 模拟 <image> 加载失败
  assert('过期链接 → 反推 fileID → 下载本地文件（可自愈）',
    /^\/tmp\/dl-/.test(p4.data.viewer.cur || ''), p4.data.viewer.cur)
  dlMode = 'fail'

  // 7e. 取不到任何地址时必须给出明确文案，而不是继续黑屏
  const p5 = mkDetail([], [legacy], [legacy])
  await p5.previewPhoto({ currentTarget: { dataset: { i: '0' } } })
  await p5.onViewerErr()   // 第一次：换本地失败
  await p5.onViewerErr()   // 第二次：小图也起不来 → 标记失效
  assert('彻底取不到时显示「无法显示」文案', p5.data.viewer.bad === true, p5.data.viewer)

  // 7f. 多张之间左右滑，且不越界
  const p6 = mkDetail([], [], ['s0', 's1', 's2'])
  await p6.previewPhoto({ currentTarget: { dataset: { i: '0' } } })
  assert('打开第 1 张', p6.data.viewer.index === 0 && p6.data.viewer.total === 3, p6.data.viewer)
  await p6.viewerStep(1)
  assert('往后翻一张', p6.data.viewer.index === 1 && p6.data.viewer.no === 2, p6.data.viewer)
  await p6.viewerStep(1)
  await p6.viewerStep(1)
  assert('末尾不越界', p6.data.viewer.index === 2, p6.data.viewer)
  await p6.viewerStep(-1)
  assert('往前翻一张', p6.data.viewer.index === 1, p6.data.viewer)
  p6.closeViewer()
  assert('可以关闭查看器', p6.data.viewer.on === false, p6.data.viewer)

  // 7g. 相册第一张加载失败：从过期链接反推 fileID 换新链（这就是「只显示第二张」的根因）
  tmpMode = 'fresh'
  tmpCalls = 0
  const p7 = mkDetail([], [legacy], [legacy])
  await p7.onAlbumErr({ currentTarget: { dataset: { i: '0' } } })
  assert('失效的那张能自愈成新鲜链接（不再变成空白洞）',
    /^https:\/\/fresh\.tcb\.qcloud\.la\//.test((p7.data.cat.photosSmall || [])[0] || ''),
    p7.data.cat.photosSmall)
  assert('自愈过程确实发了换链请求', tmpCalls > 0, tmpCalls)

  // 7h. 真的救不回来时保留格子（置空 → 模板显示「照片失效」占位），不删元素
  const p8 = mkDetail([], ['https://cdn.example.com/gone.jpg'], ['https://cdn.example.com/gone.jpg'])
  await p8.onAlbumErr({ currentTarget: { dataset: { i: '0' } } })
  await p8.onAlbumErr({ currentTarget: { dataset: { i: '0' } } })
  assert('救不回来时置空（模板据此显示占位，而不是少一个格子）',
    p8.data.cat.photosSmall[0] === '' && p8.data.cat.photosSmall.length === 1,
    p8.data.cat.photosSmall)

  // 7i. 源码 / 模板契约
  assert('cat-detail 不再调用 wx.previewImage', !/wx\.previewImage\(/.test(detailJs),
    'previewImage 黑屏时连 fail 都不回调，必须用页面内 <image>')
  assert('查看器用 <image mode="aspectFit"> 渲染', /class="viewer-img"[\s\S]{0,80}mode="aspectFit"/.test(detailWxml))
  assert('查看器图片失败有兜底（binderror → 本地文件 → 文案）', /binderror="onViewerErr"/.test(detailWxml))
  assert('点图片不关闭、点遮罩关闭', /catchtap="noop"/.test(detailWxml) && /catchtap="closeViewer"/.test(detailWxml))
  assert('WXML 相册格子仍是 previewPhoto 入口', /bindtap="previewPhoto"/.test(detailWxml))
  assert('失效图有可见占位（不是空白洞）', /class="photo-bad"/.test(detailWxml))
  assert('相册格子按 index 绑 data-i（不能靠 *this 去重）', /wx:for-index="pi"[\s\S]{0,120}data-i="{{pi}}"/.test(detailWxml))
  const errBody = detailJs.slice(detailJs.indexOf('async onAlbumErr'), detailJs.indexOf('albumDebug'))
  assert('onAlbumErr 会用 fileIdFromUrl 反推（老档案自救）', /fileIdFromUrl\(/.test(errBody), errBody)
  assert('onAlbumErr 有重试上限（不许死循环）', /tried < 2/.test(errBody), errBody)
  const viewBody = detailJs.slice(detailJs.indexOf('async viewerSource'), detailJs.indexOf('async showViewer'))
  assert('查看器大图限宽 VIEWER_PX', /photo\.thumb\([^)]*VIEWER_PX\)/.test(viewBody), viewBody)
  assert('查看器无 https 时才云下载', /photo\.download\(/.test(viewBody), viewBody)

  // 7j. 打卡照片仍走同一个查看器，但素材源是 _rawSightings（不能串到猫相册）
  const p9 = mkDetail([], [], [])
  p9._rawSightings = [{ photos: [legacy] }]
  p9.data.sightings = [{ photosSmall: ['sight-0'], photosFull: [] }]
  await p9.previewSightPhoto({ currentTarget: { dataset: { i: '0', j: '0' } } })
  assert('打卡照片读 _rawSightings 且打开查看器',
    p9.data.viewer.on === true && p9.data.viewer.cur === 'sight-0', p9.data.viewer)

  assert('整节未调用过 wx.previewImage', previews.length === 0, previews.length)

  /* ---- 8. 录入后以服务端结果复核，而不是本地乐观 +1 ---- */
  console.log('\n--- 8. 录入后复核计数 ---')

  const ADM_PATH = path.join(MP, 'pages/admin/admin.js')
  delete require.cache[require.resolve(ADM_PATH)]
  require(ADM_PATH)
  const adminOpts = pageOptions
  assert('admin.js 注册成功', !!adminOpts)
  const adminJs = read('miniprogram/pages/admin/admin.js')

  // 8a. 源码契约：不许本地改计数
  assert('indexOne 不再本地 indexed+1',
    !/indexed:\s*[^,\n]*indexStatus\.indexed\s*\+\s*1/.test(adminJs),
    '本地乐观 +1 会和服务端口径长期错着')
  assert('提供 confirmIndexed 复核方法', typeof adminOpts.confirmIndexed === 'function')

  const mkAdmin = (seedCats, statusCatsPerRound, idxRes) => {
    const a = Object.assign({}, adminOpts)
    a.data = JSON.parse(JSON.stringify(adminOpts.data))
    // 面板已经加载过：indexOne 要从 indexStatus.cats 里读 photoCount
    a.data.indexStatus.cats = JSON.parse(JSON.stringify(seedCats || []))
    a.setData = d => {
      Object.keys(d || {}).forEach(k => {
        // 支持 'indexStatus.source' 这类路径写法
        if (k.indexOf('.') > 0) {
          const [p0, p1] = k.split('.')
          a.data[p0] = Object.assign({}, a.data[p0]); a.data[p0][p1] = d[k]
        } else a.data[k] = d[k]
      })
    }
    const rounds = statusCatsPerRound.slice()
    let statusCalls = 0
    a.__calls = []
    FAKE_APP.callApi = async (action, data) => {
      a.__calls.push(action)
      if (action === 'indexOneCat') {
        if (idxRes instanceof Error) throw idxRes
        return idxRes
      }
      if (action === 'indexStatus') {
        // 每轮返回一份「仍未录入的猫」清单；最后一轮固定复用
        const cats = rounds.length > 1 ? rounds.shift() : rounds[0]
        statusCalls++
        return {
          ok: true, total: 1, indexed: cats.length ? 0 : 1,
          missing: cats.length, source: 'engine', scoped: true,
          schoolId: 'df40db4d6acb590d0089581225ab6397',
          bankTotal: 1, dbTotal: 1, cats: cats
        }
      }
      return { list: [] }
    }
    a.__statusCalls = () => statusCalls
    return a
  }

  const CAT1 = [{ id: 'cat1', name: '小灰灰', photoCount: 2 }]

  // 8b. 客户端 -504003 超时：不算失败，复核到建好为止
  clearTips()
  const A_ok = mkAdmin(CAT1, [CAT1, []], new Error('-504003 | time limit exceeded'))
  await A_ok.indexOne({ currentTarget: { dataset: { id: 'cat1' } } })
  assert('-504003 后仍发起复核（重拉 indexStatus）', A_ok.__statusCalls() >= 2, A_ok.__statusCalls())
  assert('-504003 后计数以服务端为准变成已录入', A_ok.data.indexStatus.indexed === 1, A_ok.data.indexStatus)
  assert('-504003 但真建成 → toast 成功', toastCalls.some(t => t.title === '已录入' && t.icon === 'success'), toastCalls)
  assert('indexingId 收尾释放（按钮不会卡死）', A_ok.data.indexingId === '', A_ok.data.indexingId)

  // 8c. 服务端逐只返回失败原因：提示必须是**具体原因**，不能再是「请稍后重试」
  // 注意：长文案走 modal（toast 只有 7~14 个字，会被截断成「服务端下载照片失…」），
  // 所以断言打在「所有提示文本」上，不锁死是 toast 还是 modal。
  clearTips()
  const A_zero = mkAdmin(CAT1, [CAT1], {
    ok: true, built: 0, scanned: 1, reasons: { cat1: 'downloadFailed:2/2' }
  })
  await A_zero.indexOne({ currentTarget: { dataset: { id: 'cat1' } } })
  assert('downloadFailed → 提示下载失败而非「稍后重试」',
    tipTexts().some(t => /下载照片失败/.test(t)), tipTexts())
  assert('长原因走弹窗（toast 会截断成半句）', modalCalls.length === 1, modalCalls)
  assert('built=0 时未把计数改成已录入', A_zero.data.indexStatus.indexed === 0, A_zero.data.indexStatus)

  // 8c2. 换链失败（云端前置拦截给的原因）：说清是几张换不出来
  clearTips()
  const A_link = mkAdmin(CAT1, [CAT1], {
    ok: true, built: 0, scanned: 1, reasons: { cat1: 'photoUrl:3' }
  })
  await A_link.indexOne({ currentTarget: { dataset: { id: 'cat1' } } })
  assert('photoUrl:3 → 提示「3 张都没换出链接」',
    tipTexts().some(t => /3 张照片都没换出链接/.test(t)), tipTexts())

  // 8c3. 档案真没照片
  clearTips()
  const A_np = mkAdmin(CAT1, [CAT1], {
    ok: true, built: 0, scanned: 1, reasons: { cat1: 'noPhoto' }
  })
  await A_np.indexOne({ currentTarget: { dataset: { id: 'cat1' } } })
  assert('noPhoto → 提示没有可用照片',
    tipTexts().some(t => /没有可用照片/.test(t)), tipTexts())

  // 8c4. 服务端没给原因（老版本）：不能假装「稍后重试一定会好」
  clearTips()
  const A_old = mkAdmin(CAT1, [CAT1], { ok: true, built: 0, scanned: 1 })
  await A_old.indexOne({ currentTarget: { dataset: { id: 'cat1' } } })
  assert('无原因时提示去点刷新核对',
    tipTexts().some(t => /刷新/.test(t)), tipTexts())

  // 8d. 没有照片的猫：直接拦下，不发任何请求
  clearTips()
  const CAT2 = [{ id: 'cat2', name: '无照猫', photoCount: 0 }]
  const A_none = mkAdmin(CAT2, [CAT2], { ok: true, built: 1 })
  await A_none.indexOne({ currentTarget: { dataset: { id: 'cat2' } } })
  assert('无照片的猫不发 indexOneCat', A_none.__calls.indexOf('indexOneCat') < 0, A_none.__calls)
  assert('无照片时提示先去档案加照片',
    tipTexts().some(t => /还没有照片/.test(t)), tipTexts())

  /* ---- 9. 建库失败必须能诊断（不再只说「请稍后重试」） ---- */
  console.log('\n--- 9. 建库失败原因可诊断 ---')
  const buildBody = vision.slice(vision.indexOf('async function buildIndex'), vision.indexOf('async function buildIndexAuto'))
  assert('buildIndex 前置拦截：换不出链接的猫不发请求',
    /const sendable = \[\]/.test(buildBody) && /photoUrl:/.test(buildBody), '前置拦截缺失')
  assert('全都没链接时提前返回带 reasons 的结果',
    /if \(!sendable\.length\)/.test(buildBody), buildBody.length)
  assert('服务端 reasons 透传给前端', /res\.reasons/.test(buildBody) && /reasons\[id\]/.test(buildBody))
  assert('记账只标真正建成的猫（接口异常体不误标）',
    /Array\.isArray\(res && res\.failed\) \? res\.failed : null/.test(buildBody),
    '字段缺失时不能把全部猫标成已入库')
  assert('reasons 缺失时不伪造原因', !/reasons\[id\] = '请稍后重试'/.test(buildBody))

  const serverMain = read('server/app/main.py')
  assert('服务端建库返回 reasons 字段', /"reasons": reasons/.test(serverMain))
  assert('服务端区分 noPhoto', /reasons\[c\.id\] = "noPhoto"/.test(serverMain))
  // 格式是 downloadFailed:<原因码>:a/b —— 原因码（http403/http404）是后来加的，
  // 「链接过期」和「文件被删」处置完全不同，不能合成一句含糊的 downloadFailed。
  assert('服务端区分 downloadFailed 比例', /"downloadFailed:%s:%d\/%d"/.test(serverMain))
  assert('单张编码失败不再让整只猫静默失败', /except Exception as ex:[\s\S]{0,200}embed_err/.test(serverMain))

  /* ---- 10. 云端必须把原始 fileID 留给前端（否则预览无法自愈） ---- */
  console.log('\n--- 10. 原始 fileID 不被临时链接吃掉 ---')
  const mapJs = read('cloudfunctions/catcampus/lib/map.js')
  assert('attachCatMediaUrls 支持 ids:true',
    /const keepIds = !!\(opts && opts\.ids\)/.test(mapJs), '没有 photoIds，预览黑屏后无从重换链')
  const keepBlock = mapJs.slice(mapJs.indexOf('if (keepIds && withPhotos)'),
    mapJs.indexOf('c.avatar = normalizeMedia(c.avatar, map)'))
  assert('photoIds 在「photos 被换成临时链接」之前取',
    /c\.photoIds/.test(keepBlock) && /c\.avatarId/.test(keepBlock), keepBlock)
  assert('photoIds 与 photos 同下标（非 fileID 项留空串，不删项防错位）',
    /\.map\(p => \(isCloudFileId\(p\) \? p : ''\)\)/.test(keepBlock), keepBlock)
  const cfMain = read('cloudfunctions/catcampus/index.js')
  assert('getCat 调用时开启 ids（列表接口不传这份冗余字段）',
    /attachCatMediaUrls\(\[catOut\], \{ ids: true \}\)/.test(cfMain))
  const detailJsNow = read('miniprogram/pages/cat-detail/cat-detail.js')
  const albumErrBody = detailJsNow.slice(detailJsNow.indexOf('async onAlbumErr'),
    detailJsNow.indexOf('albumDebug'))
  assert('相册 binderror 兜底也读 photoIds（photos 已是 https，读它等于没兜底）',
    /photoIds/.test(albumErrBody) && /fileIdFromUrl\(/.test(albumErrBody), albumErrBody)
  assert('头像兜底读 avatarId', /avatarId \|\| this\._rawCat\.avatar/.test(detailJsNow))
  assert('兜底链用 refresh 而非纯 resolve（缓存里就是坏链）',
    /photo\.refresh\(fid\)\) \|\| \(await photo\.resolve\(fid\)\)/.test(detailJsNow))

  /* ---- 11. 编辑保存不能把临时链接写回数据库 ---- */
  console.log('\n--- 11. 编辑保存只落 fileID ---')

  // 11a. 临时链接 → fileID 反推（真实云存储域名格式）
  const fidA = photo.fileIdFromUrl(
    'https://636c-cloud1-abc-130000.tcb.qcloud.la/cats/p1.jpg?sign=xx&t=1', 'cloud1-abc')
  // fileID 的第二段是 **bucket**（临时链接域名去掉 .tcb.qcloud.la 的那一段），不是整段域名
  assert('能从临时链接反推 fileID',
    fidA === 'cloud://cloud1-abc.636c-cloud1-abc-130000/cats/p1.jpg', fidA)
  assert('第三方域名不乱反推', photo.fileIdFromUrl('https://cdn.example.com/x.jpg', 'cloud1-abc') === '')
  assert('fileID 原样返回空（无需反推）', photo.fileIdFromUrl('cloud://a.b/c.jpg', 'cloud1-abc') === '')
  assert('缺 envId 时不猜', photo.fileIdFromUrl('https://b.tcb.qcloud.la/a.jpg', '') === '')

  // 11b. 编辑页回填：云端下发的 photos 是 https，表单里必须是 fileID
  const CE_PATH = path.join(MP, 'pages/cat-edit/cat-edit.js')
  delete require.cache[require.resolve(CE_PATH)]
  require(CE_PATH)
  const ceOpts = pageOptions
  const mkCE = () => {
    const p = Object.assign({}, ceOpts)
    p.data = JSON.parse(JSON.stringify(ceOpts.data))
    p.setData = d => {
      Object.keys(d || {}).forEach(k => {
        if (k.indexOf('.') > 0) {
          const [a, b] = k.split('.')
          p.data[a] = Object.assign({}, p.data[a]); p.data[a][b] = d[k]
        } else p.data[k] = d[k]
      })
    }
    return p
  }

  FAKE_APP.globalData.envId = 'cloud1-test'
  const TMP_BASE = 'https://bkt-cloud1-test-130000.tcb.qcloud.la/'
  FAKE_APP.callApi = async action => {
    if (action === 'getCat') {
      return {
        cat: {
          _id: 'cat1', name: '小灰灰', sex: 'unknown', pattern: 'other',
          sterilized: 'unknown', status: 'campus', health: 'unknown',
          avatar: TMP_BASE + 'cats/av.jpg?sign=1',
          avatarId: 'cloud://cloud1-test.bkt-cloud1-test-130000.tcb.qcloud.la/cats/av.jpg',
          photos: [TMP_BASE + 'cats/p1.jpg?sign=2', TMP_BASE + 'cats/p2.jpg?sign=3'],
          // 第二张故意不给 photoIds：验证「反推」这条路也能兜住
          photoIds: ['cloud://cloud1-test.bkt-cloud1-test-130000.tcb.qcloud.la/cats/p1.jpg', '']
        },
        sightings: [], tnr: [], canEdit: true
      }
    }
    return {}
  }
  const ce = mkCE()
  await ce.loadCat('cat1')
  assert('编辑页相册回填的是 fileID（不是临时链接）',
    (ce.data.form.photos || []).every(photo.isFileId), ce.data.form.photos)
  assert('photoIds 缺失的那张靠反推补回 fileID',
    /p2\.jpg$/.test(ce.data.form.photos[1] || ''), ce.data.form.photos[1])
  assert('头像也回填 fileID', photo.isFileId(ce.data.form.avatar), ce.data.form.avatar)

  // 11c. 保存：提交 fileID，且只把新加的照片报给云端送检
  let saved = null
  FAKE_APP.callApi = async (action, data) => {
    if (action === 'saveCat') { saved = data; return { _id: 'cat1' } }
    if (action === 'autoIndexCat') return { ok: true }
    return {}
  }
  const NEW_ID = 'cloud://cloud1-test.bkt-cloud1-test-130000.tcb.qcloud.la/cats/new.jpg'
  ce.setData({ 'form.photos': (ce.data.form.photos || []).concat([NEW_ID]) })
  await ce.save()
  assert('保存提交的 photos 全是 fileID',
    !!saved && (saved.data.photos || []).every(photo.isFileId), saved && saved.data.photos)
  assert('只上报新加的照片送检（老图不重复下载校验）',
    !!saved && saved.newPhotoIds.length === 1 && saved.newPhotoIds[0] === NEW_ID,
    saved && saved.newPhotoIds)

  // 11d. 长错误必须完整暴露（toast 截断到 20 字，正好切掉真原因）
  const util = require(path.join(MP, 'utils/util.js'))
  clearTips()
  util.toastErr(new Error('document.update:fail -502001 database request fail'))
  assert('超长错误走弹窗，不被截断',
    modalCalls.some(m => /-502001/.test(m.content || '')), modalCalls.map(m => m.content))
  clearTips()
  util.toastErr(new Error('保存失败'))
  assert('短错误仍走 toast', toastCalls.some(t => t.title === '保存失败'), toastCalls)

  // 11e. 云端契约：改档只检新图 / 标记用 remove / 失败重试并透出原因
  const cfSrc = read('cloudfunctions/catcampus/index.js')
  assert('改档清标记用 _.remove()（写 null 会让 exists(false) 查不到，永不自动补库）',
    /payload\.aiIndexAt = _\.remove\(\)/.test(cfSrc))
  assert('图片安全检测只针对新加的照片（客户端上报 ∪ 库里没有的）',
    /const cand = photos\.filter\(p => hinted\.indexOf\(p\) >= 0/.test(cfSrc) &&
    /oldPhotos\.indexOf\(p\) < 0/.test(cfSrc), '新增图片必须过检测，老图不重复下载')
  assert('更新有独立函数做重试与错误透出', /async function updateCatDoc/.test(cfSrc))
  assert('重试成功后留痕', /重试后更新成功/.test(cfSrc))
  assert('档案不存在时明确报错（不再静默 updated:0）', /档案不存在/.test(cfSrc))

  // 3s 预算契约（2026-10-24：「每次都是点第二遍才保存成功」）
  assert('文本检测先发出（与读档案/图片检测并行，不再串行等两次网络）',
    /const textP = sec\.checkText\(/.test(cfSrc), 'saveCat 必须是 textP 而不是 await textOk')
  assert('图片检测带硬预算（超时转异步，绝不把保存拖过 3s）',
    /checkImage\(fresh\[0\], \{ budgetMs: SAVE_IMG_BUDGET_MS \}\)/.test(cfSrc))
  assert('建档带幂等 token（超时重发不重复建档）',
    /payload\.saveToken = token/.test(cfSrc) && /isRetry/.test(cfSrc))
  const ceSrc = fs.readFileSync(CE_PATH, 'utf8')
  assert('保存超时自动重发（用户不必点第二遍）',
    /isTimeoutErr\(e\)/.test(ceSrc) && /自动重发一次/.test(ceSrc))
  assert('预热云函数（把冷启动挪到填表期间）',
    /warmCloud\(\)/.test(ceSrc) && /'ping'/.test(ceSrc))
  // 2026-10-24 夜：真机报 `TypeError: this.warmCloud is not a function`（onLoad 直接中断、页面打不开）。
  // 根因是开发者工具「热重载」复用旧 Page 实例 —— 新加的方法在旧实例上不存在。
  // 与页面状态无关的调用一律走模块级函数，不查 this。
  // 只查**调用形态**（后面带括号）：注释里写「TypeError: this.warmCloud is not a function」
  // 是必要的背景说明，断言不该把它也算成违规。
  assert('warmCloud 是模块级函数，不挂在 Page 方法上（防热重载 this 缺方法）',
    /^function warmCloud\(\)/m.test(ceSrc) && !/this\.warmCloud\s*\(/.test(ceSrc))
  assert('callSave 同样是模块级函数，save() 里直接调用',
    /^async function callSave\(/m.test(ceSrc) && /await callSave\(payload, newPhotoIds, this\._saveToken\)/.test(ceSrc) &&
    !/this\.callSave\s*\(/.test(ceSrc))

  /* ---- 11f. picker 选中必须真的生效（全部 5 个下拉，不只是绝育） ---- */
  console.log('\n--- 11f. 下拉选择生效（绝育状态那个 bug 的根因）---')
  {
    // 根因：onPick 用 `field + 'Index'` 拼下标变量名，但绝育的 picker 绑的是 sterIndex
    // → 值写进了不存在的 sterilizedIndex，picker 显示的 sterOptions[sterIndex] 永远不动。
    const ce6 = mkCE()
    const cases = [
      { key: 'sexOptions', field: 'sex', idxKey: 'sexIndex', v: 1 },
      { key: 'patternOptions', field: 'pattern', idxKey: 'patternIndex', v: 3 },
      { key: 'sterOptions', field: 'sterilized', idxKey: 'sterIndex', v: 1 },
      { key: 'statusOptions', field: 'status', idxKey: 'statusIndex', v: 2 },
      { key: 'healthOptions', field: 'health', idxKey: 'healthIndex', v: 2 }
    ]
    cases.forEach(c => {
      ce6.onPick({ currentTarget: { dataset: { key: c.key, field: c.field } }, detail: { value: c.v } })
      const want = ce6.data[c.key][c.v].value
      assert('选「' + c.field + '」后值 + 显示下标都更新',
        ce6.data.form[c.field] === want && ce6.data[c.idxKey] === c.v,
        { got: ce6.data.form[c.field], idx: ce6.data[c.idxKey], want })
    })
    // 越界下标宁可不动，也不能把 undefined 写进表单（会把档案字段清空）
    const before = ce6.data.form.sterilized
    ce6.onPick({ currentTarget: { dataset: { key: 'sterOptions', field: 'sterilized' } }, detail: { value: 99 } })
    assert('越界下标不写表单', ce6.data.form.sterilized === before, ce6.data.form.sterilized)
  }

  /* ---- 11g. 保存超时自动重发（「每次都要点第二遍才成功」） ---- */
  console.log('\n--- 11g. 保存超时自动重发 + 幂等 token ---')
  {
    const TIMEOUT = { errMsg: 'cloud.callFunction:fail Error: errCode: -504003 | errMsg: Invoking task timed out after 3 seconds' }
    const tokens = []
    let calls = 0
    FAKE_APP.callApi = async (action, payload) => {
      if (action === 'ping') return { pong: true }
      if (action === 'saveCat') {
        calls++
        tokens.push(payload && payload.data && payload.data.saveToken)
        if (calls === 1) throw TIMEOUT
        return { _id: 'catRetry' }
      }
      if (action === 'autoIndexCat') return { ok: true }
      return {}
    }
    const ce7 = mkCE()
    ce7.setData({ 'form.name': '超时猫' })
    await ce7.save()
    assert('首次超时后自动重发，不必用户点第二遍', calls === 2, calls)
    assert('两次重发带同一个 saveToken（云端据此不重复建档）',
      !!tokens[0] && tokens[0] === tokens[1], tokens)
    assert('重发成功后不弹「超时」弹窗',
      !modalCalls.some(m => /云端响应超时/.test(m.title || '')), modalCalls.map(m => m.title))

    // 两次都超时：必须明确告知「可能已保存」，而不是让用户再点一遍（会重复建档）
    clearTips()
    let calls2 = 0
    FAKE_APP.callApi = async (action) => {
      if (action === 'ping') return { pong: true }
      if (action === 'saveCat') { calls2++; throw TIMEOUT }
      return {}
    }
    const ce8 = mkCE()
    ce8.setData({ 'form.name': '超时猫2' })
    await ce8.save()
    assert('连续超时只重发一次（不无限重试）', calls2 === 2, calls2)
    assert('连续超时提示「可能已保存，别重复提交」',
      modalCalls.some(m => /云端响应超时/.test(m.title || '') && /不要立刻重复提交/.test(m.content || '')),
      modalCalls.map(m => m.title))
  }

  /* ---- 12. 校园管理：列表预览 + 就地修改 ---- */
  console.log('\n--- 12. 校园管理（超管） ---')

  const cfSrc2 = read('cloudfunctions/catcampus/index.js')
  // 12a. 云端契约
  assert('注册 listSchoolsAdmin（role=admin）',
    /'listSchoolsAdmin':\s*\{\s*role:\s*'admin'/.test(cfSrc2))
  assert('listSchoolsAdmin 内部再校验一次超管（role 只挡到管理员）',
    /async function listSchoolsAdmin\(me\)\s*\{\s*requireSuper\(me\)/.test(cfSrc2))
  assert('用 count 统计而不是把档案拉回来数',
    /collection\(COL\.cat\)\.where\(\{ schoolId: s\._id \}\)\.count\(\)/.test(cfSrc2) &&
    /collection\(COL\.user\)\.where\(\{ schoolId: s\._id \}\)\.count\(\)/.test(cfSrc2))
  assert('单校 count 失败记 -1（「数不出来」不能显示成 0）',
    /catCount:[\s\S]{0,160}?: -1/.test(cfSrc2) && /userCount:[\s\S]{0,160}?: -1/.test(cfSrc2))

  // 12b. 页面实例工厂：列表 / 保存都走同一套 stub
  const mkSchoolAdmin = (schools, opts) => {
    const o = opts || {}
    const a = Object.assign({}, adminOpts)
    a.data = JSON.parse(JSON.stringify(adminOpts.data))
    a.setData = d => {
      Object.keys(d || {}).forEach(k => {
        if (k.indexOf('.') > 0) {
          const [p0, p1] = k.split('.')
          a.data[p0] = Object.assign({}, a.data[p0]); a.data[p0][p1] = d[k]
        } else a.data[k] = d[k]
      })
    }
    // 当前账号绑定 sch1：用来验证「改自己学校要同步全局校名」
    FAKE_APP.globalData = { school: { _id: 'sch1', name: '东南大学' }, user: { schoolId: 'sch1' } }
    FAKE_APP.setSchool = s => { FAKE_APP.globalData.school = s }
    a.__calls = []
    FAKE_APP.callApi = async (action, data) => {
      a.__calls.push({ action, data })
      if (action === 'listSchoolsAdmin') {
        if (o.listError) throw new Error(o.listError)
        return schools
      }
      if (action === 'updateSchool') {
        if (o.saveError) throw new Error(o.saveError)
        return Object.assign({ schoolId: data.schoolId, scale: 16 }, data)
      }
      return {}
    }
    return a
  }

  const SCH1 = {
    _id: 'sch1', name: '东南大学', campus: '四牌楼校区', city: '南京', scale: 16,
    center: { lat: 32.05, lng: 118.79 }, catCount: 3, userCount: 12
  }
  const SCH2 = { _id: 'sch2', name: '空壳学院', catCount: -1, userCount: 0 }

  // 12c. 读取失败要说出来，不能变成「一所学校都没有」
  // ⚠️ 先跑失败态：每个实例都会改写全局 callApi 桩，先建 B 再建 E1 会让 B 用错桩
  const E1 = mkSchoolAdmin([], { listError: '数据库读取超时' })
  await E1.loadSchools()
  assert('读取失败写入 schoolsError',
    /读取超时/.test(E1.data.schoolsError || ''), E1.data.schoolsError)

  // 12d. 列表：文案全部在 JS 里拼好（WXML 不做拼接/比较）
  const B = mkSchoolAdmin([SCH1, SCH2])
  await B.loadSchools()
  assert('校园列表渲染出全部校区', B.data.schools.length === 2, B.data.schools)
  const row1 = B.data.schools[0] || {}
  const row2 = B.data.schools[1] || {}
  assert('统计文案带档案数与绑定用户数',
    row1.statText === '档案 3 只 · 绑定用户 12 人', row1.statText)
  assert('计数读取失败显示「—」而不是 0',
    String(row2.statText).indexOf('—') >= 0, row2.statText)
  assert('当前绑定学校被标记（其余不标）',
    row1.isCurrent === true && row2.isCurrent === false, [row1.isCurrent, row2.isCurrent])
  assert('校区 + 城市拼成副标题', row1.subText === '四牌楼校区 · 南京', row1.subText)
  assert('缺校区城市时有兜底文案', /未填写/.test(row2.subText || ''), row2.subText)
  assert('已设置范围时带缩放级别', /缩放 16/.test(row1.geoText || ''), row1.geoText)
  assert('未设置中心点时如实说明', /未设置/.test(row2.geoText || ''), row2.geoText)

  // 12e. 编辑回填
  B.editSchool({ currentTarget: { dataset: { id: 'sch1' } } })
  assert('编辑回填学校名', B.data.schoolForm.name === '东南大学', B.data.schoolForm)
  assert('编辑回填校区/城市',
    B.data.schoolForm.campus === '四牌楼校区' && B.data.schoolForm.city === '南京', B.data.schoolForm)
  assert('编辑回填地图中心',
    B.data.schoolCenter && B.data.schoolCenter.lat === 32.05, B.data.schoolCenter)
  assert('缩放索引与 school.scale 对齐', B.data.schoolScaleIndex === 2, B.data.schoolScaleIndex)
  assert('刚打开时未标记地理改动', B.data.schoolGeoDirty === false)
  B.editSchool({ currentTarget: { dataset: { id: 'sch1' } } })
  assert('再点同一所收起面板', B.data.schoolEditing === '', B.data.schoolEditing)

  // 12f. 纯文字编辑：只提交文字字段，不顺手重算 bounds
  B.editSchool({ currentTarget: { dataset: { id: 'sch1' } } })
  B.onSchoolInput({ currentTarget: { dataset: { key: 'name' } }, detail: { value: '  东南大学（九龙湖）  ' } })
  clearTips()
  await B.saveSchool()
  const upd = B.__calls.filter(c => c.action === 'updateSchool')[0]
  assert('保存提交了改名（去首尾空格）', upd && upd.data.name === '东南大学（九龙湖）', upd && upd.data)
  assert('纯文字编辑不提交 center/scale',
    upd && upd.data.center === undefined && upd.data.scale === undefined, upd && upd.data)
  assert('保存成功后收起面板', B.data.schoolEditing === '', B.data.schoolEditing)
  assert('保存成功有提示', toastCalls.some(t => t.title === '已保存'), toastCalls)

  // 12g. 学校名称不能为空
  clearTips()
  B.editSchool({ currentTarget: { dataset: { id: 'sch2' } } })
  B.onSchoolInput({ currentTarget: { dataset: { key: 'name' } }, detail: { value: '   ' } })
  const beforeEmpty = B.__calls.length
  await B.saveSchool()
  assert('名称为空时拦下且不发请求',
    B.__calls.length === beforeEmpty && toastCalls.some(t => /名称不能为空/.test(t.title || '')), toastCalls)

  // 12h. 改缩放但没中心点：拦下（否则云端会按默认坐标重算范围）
  clearTips()
  // 上一段把名称清空了，先补回来 —— 否则会先被「名称为空」拦住，测不到地理分支
  B.onSchoolInput({ currentTarget: { dataset: { key: 'name' } }, detail: { value: '空壳学院' } })
  B.onSchoolScaleChange({ detail: { value: '4' } })
  const beforeScale = B.__calls.length
  await B.saveSchool()
  assert('改缩放但无中心点时拦下',
    B.__calls.length === beforeScale && toastCalls.some(t => /选择地图中心/.test(t.title || '')), toastCalls)
  assert('缩放标签跟着选择器更新',
    String(B.data.schoolScaleLabel).indexOf('18') === 0, B.data.schoolScaleLabel)

  // 12i. 改自己绑定的学校：全局 school 必须同步（否则首页还顶旧校名）
  B.editSchool({ currentTarget: { dataset: { id: 'sch1' } } })
  B.onSchoolInput({ currentTarget: { dataset: { key: 'name' } }, detail: { value: '东大' } })
  await B.saveSchool()
  assert('改自己学校时同步刷新全局校名',
    FAKE_APP.globalData.school && FAKE_APP.globalData.school.name === '东大',
    FAKE_APP.globalData.school)

  // 12j. 保存失败的长原因要完整露出（toast 会截断成半句）
  const F1 = mkSchoolAdmin([SCH1], { saveError: '内容未通过安全检测，请修改后再保存' })
  await F1.loadSchools()
  F1.editSchool({ currentTarget: { dataset: { id: 'sch1' } } })
  clearTips()
  await F1.saveSchool()
  assert('保存失败走弹窗且原因完整',
    modalCalls.some(m => /安全检测/.test(m.content || '')), modalCalls.map(m => m.content))

  // 12k. 模板契约：三块 UI 必须存在，且字段文案来自 JS
  const admWxml = read('miniprogram/pages/admin/admin.wxml')
  assert('后台有校园管理卡片', /校园管理/.test(admWxml))
  assert('列表项绑定编辑入口', /bindtap="editSchool"/.test(admWxml))
  assert('提供保存与取消', /bindtap="saveSchool"/.test(admWxml) && /bindtap="cancelSchoolEdit"/.test(admWxml))
  assert('直接渲染 JS 预拼的统计文案', /item\.statText/.test(admWxml))
  assert('地图中心走 chooseLocation', /wx\.chooseLocation/.test(adminJs))
  assert('读取失败有可见提示（不静默变空列表）', /schoolsError/.test(admWxml))

  /* ---- 12l. 重复档案：扫出「同名同校」并删多余（2026-10-24 现场：录入一只，猫谱两条一样） ---- */
  console.log('\n--- 12l. 重复档案清理 ---')
  assert('云端注册 findDuplicateCats（role=admin）',
    /'findDuplicateCats':\s*\{\s*role:\s*'admin'/.test(cfSrc2))
  assert('handler 内再校验超管（role 只挡到管理员）',
    /async function findDuplicateCats\(me, event\)\s*\{\s*requireSuper\(me\)/.test(cfSrc2))
  assert('判重口径 = 同校 + 同名（去空格、忽略大小写）',
    /\.trim\(\)\.toLowerCase\(\) \+ '\|' \+ \(c\.schoolId/.test(cfSrc2))
  assert('建议保留「照片最多」的那条（不是盲删后建的那条）',
    /photoCount\(c\) > photoCount\(keep\)/.test(cfSrc2))

  const mkDup = (groups, opts) => {
    const o = opts || {}
    const a = Object.assign({}, adminOpts)
    a.data = JSON.parse(JSON.stringify(adminOpts.data))
    a.setData = d => {
      Object.keys(d || {}).forEach(k => {
        if (k.indexOf('.') > 0) {
          const [p0, p1] = k.split('.')
          a.data[p0] = Object.assign({}, a.data[p0]); a.data[p0][p1] = d[k]
        } else a.data[k] = d[k]
      })
    }
    a.__calls = []
    FAKE_APP.callApi = async (action, data) => {
      a.__calls.push({ action, data })
      if (action === 'findDuplicateCats') {
        if (o.scanError) throw new Error(o.scanError)
        return { scanned: o.scanned === undefined ? 12 : o.scanned, groups: groups || [] }
      }
      if (action === 'removeCat') {
        if (o.removeError) throw new Error(o.removeError)
        return { _id: data.id }
      }
      return {}
    }
    return a
  }

  const DUP_GROUP = {
    key: '小灰灰|sch1',
    name: '小灰灰',
    keepId: 'c1',
    items: [
      { _id: 'c1', createdAt: new Date(Date.now() - 2 * 3600e3), photoCount: 2, hasAvatar: true, sightingCount: 3, keep: true },
      { _id: 'c2', createdAt: new Date(), photoCount: 0, hasAvatar: false, sightingCount: 0, keep: false }
    ]
  }

  const D1 = mkDup([DUP_GROUP])
  assert('还没扫描时 dupChecked=false（界面不能显示「没有重复」）', D1.data.dupChecked === false)
  await D1.loadDuplicates()
  assert('扫出 1 组重复', D1.data.dupGroups.length === 1, D1.data.dupGroups.map(g => g.name))
  const dg = D1.data.dupGroups[0] || {}
  assert('组标题带条数', dg.countText === '2 条', dg.countText)
  const di0 = (dg.items || [])[0] || {}
  const di1 = (dg.items || [])[1] || {}
  assert('「建议保留」标在照片最多的那条上',
    di0.keep === true && di0.tagText === '建议保留' && di1.tagText === '待清理',
    [di0.tagText, di1.tagText])
  assert('副文案由 JS 预拼：时间 + 照片数 + 打卡数',
    /张照片/.test(di0.metaText) && /次打卡/.test(di0.metaText) &&
    /^\S/.test(di0.metaText) && !/^·/.test(di0.metaText),
    di0.metaText)
  assert('无照片的那条如实写「无照片」', /无照片/.test(di1.metaText || ''), di1.metaText)
  assert('文案里不出现 undefined（WXML 拼接失效的老坑）',
    !/undefined/.test(di0.metaText + di1.metaText), [di0.metaText, di1.metaText])

  // 确认删除：必须真的调 removeCat，且 id 是被点的那条
  const origModal = global.wx.showModal
  global.wx.showModal = o => { if (o && o.success) o.success({ confirm: true }); return null }
  clearTips()
  await D1.removeDuplicate({ currentTarget: { dataset: { id: 'c2', name: '小灰灰', time: '刚刚' } } })
  const rmCall = D1.__calls.filter(c => c.action === 'removeCat')[0]
  assert('确认后调用 removeCat 删掉被点的那条',
    rmCall && rmCall.data.id === 'c2', rmCall && rmCall.data)
  assert('删完有成功提示并重新扫描',
    toastCalls.some(t => t.title === '已删除') && D1.__calls.filter(c => c.action === 'findDuplicateCats').length === 2,
    { toast: toastCalls.map(t => t.title), scans: D1.__calls.filter(c => c.action === 'findDuplicateCats').length })

  // 取消：一条都不能删（硬删除不可恢复，误触代价太大）
  global.wx.showModal = o => { if (o && o.success) o.success({ confirm: false }); return null }
  const D2 = mkDup([DUP_GROUP])
  await D2.loadDuplicates()
  const beforeCancel = D2.__calls.filter(c => c.action === 'removeCat').length
  await D2.removeDuplicate({ currentTarget: { dataset: { id: 'c2', name: '小灰灰' } } })
  assert('取消确认时不发删除请求',
    D2.__calls.filter(c => c.action === 'removeCat').length === beforeCancel, D2.__calls.map(c => c.action))
  global.wx.showModal = origModal

  // 扫描失败要照实说（空列表会被误读成「没有重复」）
  const D3 = mkDup([], { scanError: '数据库读取超时' })
  await D3.loadDuplicates()
  assert('扫描失败写入 dupError 且不显示成「无重复」',
    /读取超时/.test(D3.data.dupError || '') && D3.data.dupGroups.length === 0, D3.data.dupError)
  assert('失败时 dupChecked 仍为 true（否则界面上什么都不显示）', D3.data.dupChecked === true)

  const D4 = mkDup([])
  await D4.loadDuplicates()
  assert('确实没有重复时也要区分「扫过了」', D4.data.dupChecked === true && D4.data.dupGroups.length === 0)

  // 模板契约
  assert('后台有重复档案卡片', /重复档案/.test(admWxml))
  assert('每行有删除入口并带上猫名/时间', /bindtap="removeDuplicate"/.test(admWxml) &&
    /data-name="\{\{g\.name\}\}"/.test(admWxml))
  assert('直接渲染 JS 预拼的副文案', /item\.metaText/.test(admWxml))
  assert('扫描失败有可见提示', /dupError/.test(admWxml))

  /* ---- 12m. 详情页删除档案（仅超管 + 二次确认，2026-10-24） ---- */
  console.log('\n--- 12m. 详情页删除档案 ---')
  {
    const cdWxml3 = read('miniprogram/pages/cat-detail/cat-detail.wxml')
    const cdJs3 = read('miniprogram/pages/cat-detail/cat-detail.js')
    const cfSrc3 = read('cloudfunctions/catcampus/index.js')

    assert('删除入口只在超管可见（wx:if isSuper）',
      /class="card mt danger-zone" wx:if="\{\{isSuper\}\}"/.test(cdWxml3))
    assert('删除按钮绑定 removeCat 且防重复点击',
      /bindtap="removeCat"/.test(cdWxml3) && /disabled="\{\{removing\}\}"/.test(cdWxml3))
    assert('删除入口没塞进底部操作栏（不与日常操作并排）',
      !/footer-bar[\s\S]{0,320}removeCat/.test(cdWxml3))
    // 二次确认必须说清后果：只说「确定删除吗」，用户并不知道自己删掉了什么
    assert('确认文案写明不可恢复', /无法恢复/.test(cdJs3))
    assert('确认文案说明目击记录会保留（不连坐删他人记录）', /目击记录会保留/.test(cdJs3))

    assert('云端 handler 内 requireSuper（ACTIONS 的 role 只挡到校园管理员）',
      /async function removeCat\(me, event\)\s*\{\s*requireSuper\(me\)/.test(cfSrc3))
    assert('云端删除前先校验存在性（超时重发不会静默成功）',
      /档案不存在或已被删除/.test(cfSrc3))

    let delCalls = []
    let modalReply = true
    let backs = 0
    const origModal2 = global.wx.showModal
    const origApi2 = FAKE_APP.callApi
    global.getCurrentPages = () => [{}, {}]
    global.wx.navigateBack = () => { backs++ }
    global.wx.showModal = o => {
      modalCalls.push(o)
      if (o && o.success) o.success({ confirm: modalReply })   // 不回调会让 await 永久挂住
    }

    const mkDel = (opts) => {
      const o = opts || {}
      FAKE_APP.callApi = async (action, data) => {
        delCalls.push({ action, data })
        if (action === 'removeCat' && o.fail) throw new Error('仅超级管理员可执行此操作')
        return { _id: data.id, name: '小灰灰' }
      }
      const p = Object.assign({}, detail2)
      p.data = Object.assign({}, detail2.data, {
        id: 'c9', cat: { name: '小灰灰' }, isSuper: true, removing: false
      })
      p.setData = d => Object.keys(d || {}).forEach(k => setPath(p.data, k, d[k]))
      return p
    }

    clearTips()
    modalReply = false
    const P1 = mkDel()
    await P1.removeCat()
    assert('取消二次确认 → 一条删除请求都不发', delCalls.length === 0, delCalls)
    assert('取消后留在详情页（不返回、不标记已删）', backs === 0 && P1._gone !== true)

    clearTips()
    modalReply = true
    const P2 = mkDel()
    await P2.removeCat()
    assert('确认后调用 removeCat 且 id 正确',
      delCalls.length === 1 && delCalls[0].action === 'removeCat' && delCalls[0].data.id === 'c9',
      delCalls)
    assert('删除成功给「已删除」提示', tipTexts().some(t => /已删除/.test(t)), tipTexts())
    assert('标记 _gone（否则 onShow 会对着已删档案再拉一次）', P2._gone === true)
    await new Promise(r => setTimeout(r, 750))
    assert('删除成功后自动退回上一页', backs === 1, backs)

    clearTips(); delCalls = []; backs = 0
    const P3 = mkDel({ fail: true })
    await P3.removeCat()
    assert('删除失败如实提示原因', tipTexts().some(t => /超级管理员/.test(t)), tipTexts())
    assert('失败不返回、不标记已删', backs === 0 && P3._gone !== true)
    assert('失败后 removing 复位（按钮还能再点）', P3.data.removing === false, P3.data.removing)

    global.wx.showModal = origModal2
    FAKE_APP.callApi = origApi2
  }

  console.log('\n=== 结果 ===')
  console.log('PASS ' + pass + ' / FAIL ' + fail)
  if (failures.length) { console.log('\n失败项：'); failures.forEach(f => console.log('  - ' + f)) }
  process.exit(fail ? 1 : 0)
})().catch(e => {
  console.error('测试异常', e && e.stack || e)
  process.exit(1)
})
