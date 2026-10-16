/**
 * 图片加载加速工具（2026-10-15）
 *
 * 解决两类问题：
 *  1. 列表头像/缩略图直接渲染几 MB 的手机原图 → 首屏文字先出、图片后到。
 *     修法：云开发存储的下载地址/临时链接官方支持拼接 imageMogr2 参数
 *     （docs.cloudbase.net/storage/extension，已有 sign 参数时用 & 拼接），
 *     按展示尺寸请求缩略图，几 MB → 几十 KB。
 *  2. cloud:// fileID 每张图都要 <image> 组件各自解析一次（一次额外往返）。
 *     修法：批量 getTempFileURL 预取 + 内存缓存（临时链接官方 2h 有效，
 *     缓存 90 分钟留安全余量），命中后直接用 https 链接 + 缩略参数。
 *
 * 兜底链（任何一级失败都不至于白屏）：
 *   带参数图挂了 → binderror 里用 stripProcess 去参数重试一次
 *   → 还挂（fileID 场景）→ 换 getTempFileURL 临时链接 → 再不行退 emoji/占位
 *
 * 2026-10-15 二修：cloud:// 一律不进 <image src>。
 *   开发者工具（platform==='devtools'）不解析 cloud://，会把它当相对路径交给本地
 *   pageframe 加载，报 Failed to load image http://127.0.0.1:xxxx/__pageframe__/...
 *   该环境下一律先换 https 再渲染（首屏短暂占位，预取回来即补上）；
 *   真机上 <image> 原生支持 cloud://，保留原样直出，预取完成后再升级为缩略链接。
 */

const TMP_TTL_MS = 90 * 60 * 1000   // 临时链接官方约 2h 有效，缓存 90min
const _cache = Object.create(null)  // fileID -> { url, at }

function isFileId(s) { return /^cloud:\/\//.test(s || '') }
function isHttp(s) { return /^https?:\/\//.test(s || '') }

/** 是否开发者工具（一次性判定并缓存，避免每次渲染都调系统接口） */
let _devtools
function isDevtools() {
  if (_devtools === undefined) {
    try {
      const si = (typeof wx !== 'undefined' && wx.getSystemInfoSync) ? wx.getSystemInfoSync() : {}
      _devtools = si.platform === 'devtools'
    } catch (e) { _devtools = false }
  }
  return _devtools
}

/** 是否已带 imageMogr2 处理参数 */
function hasProcess(url) {
  return /[?&]imageMogr2\//.test(url || '')
}

/** 给云存储 http(s) 地址拼缩略参数（限定最大宽度 px，高度等比）。
 *  fileID / 非云存储域名 / 已带参数的地址原样返回——
 *  只认 *.tcb.qcloud.la（云开发分配域名），绝不给第三方图床乱拼参数。 */
function thumb(url, px) {
  const u = String(url || '')
  if (!isHttp(u) || hasProcess(u)) return u
  if (!/\.tcb\.qcloud\.la\//.test(u)) return u
  return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'imageMogr2/thumbnail/' + (px | 0) + 'x'
}

/** 去掉 imageMogr2 参数（加载失败时回退原图地址重试一次） */
function stripProcess(url) {
  return String(url || '')
    .replace(/([?&])imageMogr2\/[^&]*/g, '$1')
    .replace(/[?&]+$/, '')
}

/** 缓存命中的临时链接（未过期），否则 '' */
function cachedUrl(fileId) {
  const it = _cache[fileId]
  return (it && Date.now() - it.at < TMP_TTL_MS) ? it.url : ''
}

/** 批量预取 fileID → 临时链接（官方单次上限 50）。
 *  返回 Promise<本次**成功入缓存**的 fileID 数组>（失败的静默跳过，
 *  <image> 还能走 fileID 渲染与 binderror 兜底）。调用方据返回值判断
 *  「有没有新东西可刷」，全失败时不做无谓的二次 setData。 */
function warm(fileIds) {
  const ids = []
  const seen = Object.create(null)
  ;(fileIds || []).forEach(id => {
    if (isFileId(id) && !cachedUrl(id) && !seen[id]) { seen[id] = 1; ids.push(id) }
  })
  if (!ids.length || typeof wx === 'undefined' || !wx.cloud) return Promise.resolve([])
  const warmed = []
  const batches = []
  for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50))
  return Promise.all(batches.map(batch =>
    wx.cloud.getTempFileURL({ fileList: batch }).then(res => {
      ;((res && res.fileList) || []).forEach(it => {
        // status!==0（文件不存在/无权限等）不缓存，让 <image> 的 fileID 渲染与 binderror 兜底接管
        if (it && it.fileID && it.tempFileURL && it.status === 0) {
          _cache[it.fileID] = { url: it.tempFileURL, at: Date.now() }
          warmed.push(it.fileID)
        }
      })
    }).catch(() => {})
  )).then(() => warmed)
}

/** 单个地址 → 立即可渲染的展示地址（同步，无副作用除了 pending 收集）。
 *  fileID：命中缓存 → 临时链接+缩略；未命中 →
 *    · 开发者工具：返回 ''（绝不把 cloud:// 交给渲染层，否则本地 pageframe 报加载失败），
 *      由调用方预取后补渲染；
 *    · 真机：原样返回（<image> 原生支持 cloud://），预取后自动升级为缩略链接。
 *  两种情况都会把 id 收进 pending，由调用方决定何时预取。 */
function display(src, px, pending) {
  const s = String(src || '')
  if (!s) return s
  if (isFileId(s)) {
    const u = cachedUrl(s)
    if (u) return thumb(u, px)
    if (pending) pending.push(s)
    return isDevtools() ? '' : s
  }
  return thumb(s, px)
}

/** 单个 fileID → 换好（或换不出来）的 https 临时链接。
 *  给 binderror 兜底用：临时链接换不到就返回 ''，调用方据此退占位。 */
function resolve(fileId) {
  if (!isFileId(fileId)) return Promise.resolve(isHttp(fileId) ? fileId : '')
  const hit = cachedUrl(fileId)
  if (hit) return Promise.resolve(hit)
  return warm([fileId]).then(() => cachedUrl(fileId) || '')
}

/**
 * 强制重新换链（**忽略缓存**），用于「临时链接本身失效」的兜底。
 *
 * 为什么需要它（2026-10-15 现场）：
 *   渲染层报 Failed to load image https://.../cats/xxx.jpg?sign=...&imageMogr2/thumbnail/200x，
 *   而**同一条链接去掉 imageMogr2 后也照样报错** —— 说明失败根因不是参数拼接，
 *   而是「这条临时链接本身已经不可用」（签名过期 / 文件被覆盖 / 环境侧变更）。
 *   此时缓存里存的还是那条坏链接，resolve() 命中缓存直接返回它，
 *   兜底链就退化成「用同一个坏地址重试」→ 必然再挂。
 *   所以这条兜底必须是 refresh：丢掉缓存、重新 getTempFileURL 拿新签名。
 *
 * 换不到返回 ''（调用方据此退占位）；非 fileID 原样返回，不发请求。
 * 注意：刻意**不复用 warm**（warm 见缓存即跳过），这里必须真发请求。
 */
function refresh(fileId) {
  const id = String(fileId || '')
  if (!isFileId(id)) return Promise.resolve(isHttp(id) ? id : '')
  if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.getTempFileURL) return Promise.resolve('')
  return wx.cloud.getTempFileURL({ fileList: [id] }).then(res => {
    const it = res && res.fileList && res.fileList[0]
    if (!it || it.status !== 0 || !it.tempFileURL) return ''
    _cache[id] = { url: it.tempFileURL, at: Date.now() }
    return it.tempFileURL
  }).catch(() => '')
}

function withTimeout(p, ms) {
  if (!ms) return p
  return Promise.race([p, new Promise(r => setTimeout(r, ms))])
}

/** 收集列表里所有待换链的 fileID（avatar + photos） */
function collectIds(list) {
  const ids = []
  const seen = Object.create(null)
  ;(list || []).forEach(c => {
    if (!c) return
    const arr = (c.avatar === undefined ? [] : [c.avatar])
      .concat(Array.isArray(c.photos) ? c.photos : [])
    arr.forEach(v => {
      if (isFileId(v) && !cachedUrl(v) && !seen[v]) { seen[v] = 1; ids.push(v) }
    })
  })
  return ids
}

/** 先把整列表的 fileID 预取完，再一次性映射 —— 产出的列表**全是 https**，
 *  首屏不再出现 cloud://（开发者工具不会报 pageframe 加载失败，也不闪空）。
 *  @param {number} [timeoutMs=3000] 预取超时保护：换链卡住也不能拖死整页渲染 */
async function hydrateCatsAsync(list, opts, timeoutMs) {
  const ids = collectIds(list)
  if (ids.length) await withTimeout(warm(ids), timeoutMs === undefined ? 3000 : timeoutMs)
  return hydrateCats(list, opts)   // 不传 apply：已预取完，映射一次即可
}

/**
 * 把猫列表的 avatar / photos 换成展示地址（渐进增强）。
 *
 * @param {Array} list 原始列表（不改原数组）
 * @param {Object} opts { px: 头像缩略宽度(默认300), photoPx: photos 缩略宽度(默认480) }
 * @param {Function} [apply] 有 fileID 未命中缓存时，预取完成后以**重新映射的完整列表**
 *   回调一次（页面用它再 setData 即完成从 fileID 到缩略链接的升级）；
 *   第二次进入时全部命中缓存，不再回调，天然无循环。
 * @returns {Array} 映射后的新列表（avatar / photosSmall 字段已就绪）
 */
function hydrateCats(list, opts, apply) {
  opts = opts || {}
  const px = opts.px || 300
  const photoPx = opts.photoPx || 480
  const pending = []
  const mapped = (list || []).map(c => {
    const out = Object.assign({}, c)
    if (c.avatar !== undefined || (c.photos && c.photos.length)) {
      // 头像口径与云端 attachCatMediaUrls 保持一致：没设 avatar 就用 photos[0] 顶，
      // 否则「档案有照片、列表却是占位图」（小灰灰那类）
      const src = c.avatar || (Array.isArray(c.photos) && c.photos[0]) || ''
      // 记下**原始 fileID**：头像被换成临时链接后，src 已不含 cloud://，
      // binderror 兜底就没法重新换链了（临时链接过期时只能干等着失败）。
      // 渲染字段用 avatar，兜底字段用 avatarId —— 与云端 mapPoints 的 avatarId 同口径。
      if (src) out.avatarId = src
      out.avatar = display(src, px, pending)
    }
    if (Array.isArray(c.photos)) {
      // 预览用原图（previewImage），展示用缩略图——两者分开，互不影响
      out.photosSmall = c.photos.map(p => display(p, photoPx, pending))
      // opts.full=true 时额外产出「原尺寸 https 原图地址」：
      // 部分场景（开发者工具的 pageframe 渲染、分享卡片、wx.previewImage）
      // 拿 cloud:// fileID 会解析失败，必须给 https 直连地址
      if (opts.full) {
        out.photosFull = c.photos.map(p =>
          isFileId(p) ? (cachedUrl(p) || p) : p)
      }
    }
    return out
  })
  if (pending.length && typeof apply === 'function') {
    warm(pending).then(ids => {
      if (ids.length) apply(hydrateCats(list, opts))
    })
  }
  return mapped
}

module.exports = {
  thumb, stripProcess, hasProcess, display, warm, resolve, refresh,
  hydrateCats, hydrateCatsAsync, cachedUrl, isFileId, isDevtools
}
