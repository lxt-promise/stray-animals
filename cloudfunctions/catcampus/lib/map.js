/**
 * 校园猫地图点位 —— 难点 6
 *
 * 两个要点：
 *  1. 点位聚合：附近多只猫重叠时自己实现网格聚合即可，不必引入 mapbox。
 *     网格边长随 zoom 变化，同格内的猫合并成一个 cluster，前端渲染成数字气泡。
 *  2. 两级可见：非社团成员拿不到私有点位（spotPrivate），其余点位坐标做模糊化。
 *     过滤与模糊都在服务端完成 —— 客户端拿不到的数据才是安全的。
 */
const { cloud, db, _, COL, isMember, blurLocation, needBlur } = require('./core')

/** 网格边长（度）：zoom 越大格子越小 */
function gridSize(zoom) {
  const z = Math.max(10, Math.min(20, Number(zoom) || 16))
  return 0.01 / Math.pow(2, z - 12)
}

function cellKey(loc, g) {
  return Math.floor(loc.lat / g) + ':' + Math.floor(loc.lng / g)
}

function inBounds(loc, b) {
  if (!b || !b.sw || !b.ne) return true
  return loc.lat >= b.sw.lat && loc.lat <= b.ne.lat && loc.lng >= b.sw.lng && loc.lng <= b.ne.lng
}

/**
 * 判断一个地址是不是「渲染层能直接加载」的图标地址。
 *  `cloud://` fileID 由逻辑层云开发 SDK 解析，渲染层的 <map marker> 不认；
 *  即便被换成 tcb.qcloud.la 直链，该域名不回 Access-Control-Allow-Origin，仍会被 CORS 拦。
 *  所以只认 https/http 与本地 /images/ 路径。
 */
function isRenderableUrl(u) {
  const s = String(u || '')
  return /^https?:\/\//i.test(s) || s.indexOf('/images/') === 0
}

/**
 * 把 marker 的头像地址统一换成「渲染层能加载」的 https 临时链接。
 *
 * 三步走，最后一步是「无论如何都不报错」的保险：
 *  1. 已经是 https/http 的（说明前端或小程序运行时已经换过一次）→ 直接沿用，
 *     不再往返一次 getTempFileURL，省掉一次网络调用；
 *  2. `cloud://` fileID → 批量 getTempFileURL 换成官方临时链接；
 *  3. **兜底**：任何仍然不是 http(s) 的地址（换失败 / 缺权限 / 云存储未开通）一律置空，
 *     让上层退化成 emoji 爪印 marker。
 *     —— 宁可不好看，也绝不让一个坏地址流到渲染层去刷 CORS 报错。
 *
 * ⚠️ 第 3 步是这套方案的成败关键：只要有一个非 http 地址漏下去，
 *    渲染层的 <map> 就会自己把这些 tcb.qcloud.la 直链当成 marker 图标去加载，
 *    于是「Access to image ... blocked by CORS policy」+「改为用默认marker」继续刷屏。
 */
async function attachMarkerUrls(list) {
  if (!list || !list.length) return

  const needFetch = []
  list.forEach(p => {
    if (!p) return
    const a = String(p.avatar || '')
    if (a && a.indexOf('cloud://') === 0) needFetch.push(a)
  })
  const uniq = [...new Set(needFetch)]

  const map = {}
  for (let i = 0; i < uniq.length; i += 50) {   // 官方接口单次上限 50
    try {
      const tmp = await cloud.getTempFileURL({ fileList: uniq.slice(i, i + 50) })
      ;(tmp && tmp.fileList || []).forEach(it => {
        if (it && it.fileID && it.tempFileURL) map[it.fileID] = it.tempFileURL
      })
    } catch (e) {
      console.warn('[map] 批量换取 marker 临时链接失败', e && e.message)
    }
  }

  let dropped = 0
  list.forEach(p => {
    if (!p) return
    const a = String(p.avatar || '')
    if (!a) return
    if (a.indexOf('cloud://') === 0) {
      // 换不到（文件不存在/无权限/批量接口故障）时**保留 fileID 原样返回**——
      // 底部列表与弹窗用 <image> 组件渲染，走逻辑层 SDK，能直接解析 cloud://
      // （猫谱页同款路径，实测可用）。置空会让猫白白退化成占位图，
      // 「档案明明有照片、列表却不显示」就是这里置空造成的。
      p.avatar = map[a] || a
      if (!map[a]) dropped++
    } else if (!isRenderableUrl(a)) {
      p.avatar = ''                      // 未知协议：直接丢弃，绝不外泄
      dropped++
    }
    // 已是 http(s) 的原样保留
  })
  if (dropped) console.warn('[map] 有 ' + dropped + ' 个头像未能换取临时链接，已保留 fileID 由前端 <image> 直接渲染')
}

/**
 * 取每只猫「最后一次打卡」的点位。
 *
 * 为什么需要：地图点位原来只读猫档案的常驻位置（cats.location）——
 * 没填常驻位置的猫永远不上图；用户在新地点打卡后，图标也还停在老位置。
 * 现在按 sightings.createdAt 倒序扫描最近 N 条，同一 catId 只保留第一条（即最新），
 * 作为该猫的首选点位；档案常驻位置退居兜底。
 *
 * 两个约束：
 *  1. **只认档案里的猫**：catId 为空的打卡是「未认领的新猫」（pending），没有档案，
 *     不上图（等社团核实建档后自然会出现）。
 *  2. 字段投影只取 4 个字段 —— photos/note 等大字段不拉，响应包体积直接决定云函数耗时。
 */
async function lastSightingLocations(schoolId) {
  const where = { location: _.neq(null) }
  if (schoolId) where.schoolId = schoolId
  let res = { data: [] }
  try {
    res = await db.collection(COL.sighting)
      .where(where)
      .field({ catId: true, location: true, createdAt: true })
      .orderBy('createdAt', 'desc')
      .limit(400)
      .get()
  } catch (e) {
    // 打卡表查询失败不能拖垮整个地图：回退「只用档案常驻位置」的老行为
    console.warn('[map] 拉取最近打卡点位失败，回退档案常驻位置', e && e.message)
    return {}
  }
  const last = {}
  ;(res.data || []).forEach(s => {
    if (!s || !s.catId) return        // 未认领的新猫：无档案，不上图
    if (last[s.catId]) return         // 倒序扫描，先到者即最新
    const loc = s.location
    if (loc && isFinite(loc.lat) && isFinite(loc.lng)) last[s.catId] = loc
  })
  return last
}

/**
 * 取地图点位（含聚合）
 * @param {Object} user
 * @param {Object} event { schoolId, zoom, bounds }
 */
async function mapPoints(user, event) {
  const schoolId = event.schoolId || (user && user.schoolId) || ''
  const where = schoolId ? { schoolId } : {}
  const res = await db.collection(COL.cat).where(where).limit(300).get()

  const member = isMember(user)
  const zoom = Number(event.zoom) || 16
  const g = gridSize(zoom)
  const bounds = event.bounds || null

  // 每只猫的最后一次打卡点位（缺失/查询失败时为空对象，下面自然回退档案位置）
  const lastLoc = await lastSightingLocations(schoolId)

  // 两级可见：非成员直接剔除私有点位；其余按需模糊化
  // 坐标过滤必须 isFinite：typeof 检查放 NaN 通过，会产出 NaN:NaN 幽灵点位
  // 点位优先级：最后一次打卡位置 > 档案常驻位置（用户要求：以最后一次打卡位置为准上图）
  const list = res.data
    .map(c => ({ cat: c, loc: lastLoc[c._id] || c.location || null }))
    .filter(x => x.loc && isFinite(x.loc.lat) && isFinite(x.loc.lng))
    .filter(x => member || !x.cat.spotPrivate)
    .map(x => {
      const c = x.cat
      const loc = (!member && needBlur(c)) ? blurLocation(x.loc) : x.loc
      return {
        catId: c._id,
        name: c.name,
        avatar: (c.photos && c.photos[0]) || c.avatar || '',
        // 原始 fileID（avatar 可能被 attachMarkerUrls 换成临时链接）：
        // 前端在临时链接加载失败时回退用它走 <image> 的 fileID 渲染
        avatarId: (c.photos && c.photos[0]) || c.avatar || '',
        status: c.status || 'campus',
        sterilized: c.sterilized || 'unknown',
        pattern: c.pattern || 'other',
        sex: c.sex || 'unknown',
        // 最近一次「本人投喂」的时间（addSighting 里 isFedByMe 时才写）。
        // 前端据此在地图上标「未投喂」；寄养/休学/毕业/失踪/离世的猫不应催投喂，那里另行判断。
        lastFedAt: c.lastFedAt || null,
        // 位置名：打卡点位不带名称，优先用档案常驻点的地名
        spot: (c.location && c.location.name) || '',
        lat: loc.lat,
        lng: loc.lng,
        blurred: !!loc.blurred,
        // 供前端/排查区分点位来源（true = 来自最近一次打卡）
        fromSighting: !!lastLoc[c._id]
      }
    })
    .filter(p => inBounds({ lat: p.lat, lng: p.lng }, bounds))

  // 网格聚合
  const cells = new Map()
  list.forEach(p => {
    const key = cellKey({ lat: p.lat, lng: p.lng }, g)
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key).push(p)
  })

  const clusters = []
  const points = []
  cells.forEach(arr => {
    if (arr.length === 1) {
      points.push(arr[0])
      return
    }
    const lat = arr.reduce((a, b) => a + b.lat, 0) / arr.length
    const lng = arr.reduce((a, b) => a + b.lng, 0) / arr.length
    clusters.push({
      id: 'c_' + arr.map(p => p.catId).join('_').slice(0, 40),
      lat,
      lng,
      count: arr.length,
      sterilized: arr.filter(p => p.sterilized === 'yes').length,
      cats: arr.slice(0, 6).map(p => ({
        catId: p.catId, name: p.name, avatar: p.avatar, avatarId: p.avatarId,
        sterilized: p.sterilized, spot: p.spot, lat: p.lat, lng: p.lng,
        fromSighting: p.fromSighting
      }))
    })
  })

  // 单点与簇内猫的头像都换成 https 临时链接（marker.iconPath 由渲染层加载，不认 cloud://）
  await attachMarkerUrls(points)
  await attachMarkerUrls(clusters.reduce((acc, c) => acc.concat(c.cats || []), []))

  return {
    zoom,
    grid: g,
    total: list.length,
    clusters,
    // points.avatar 已由 attachMarkerUrls 换成 https 临时链接：
    //  - marker.iconPath **不用它**（前端 buildCatMarker 一律用本地图标，从源头绕开 CORS）
    //  - 底部猫列表的 <image> 组件用它展示真实头像（<image> 走逻辑层，能正常加载）
    points,
    scope: member ? 'member' : 'public',
    notice: member ? '' : '幼猫、病猫与私有点位已隐藏或模糊处理，保护猫咪安全。'
  }
}

/* ==================== 猫档案媒体地址统一换链 ====================
 * 为什么必须在服务端做（2026-10-15）：
 *   云存储的下载权限默认是「仅创建者可读写」。客户端 <image> 拿 cloud:// 或
 *   getTempFileURL 都只能读**自己上传**的文件 —— 于是「别人上传的照片我看不到」，
 *   现场表现就是「小橘（自己传的）有头像，小白/小灰灰（别人传的）空白」。
 *   云函数是管理端，getTempFileURL 能读环境内**所有**存在的文件，一次批量换链
 *   就能把所有猫的头像/照片统一成 https。mapPoints 早就这么干了（所以地图上
 *   小白的头像正常），这次把同款处理补到猫档案相关的 action 上。
 */

/** 批量换取 fileID → 官方临时链接（单次上限 50）。换不到的**保留原 fileID**，
 *  由前端 photo.js 走 <image> 兜底，绝不置空（置空 = 明明有照片却显示占位）。 */
async function fetchTempUrls(ids) {
  const uniq = [...new Set((ids || []).filter(isCloudFileId))]
  const map = {}
  for (let i = 0; i < uniq.length; i += 50) {
    try {
      const tmp = await cloud.getTempFileURL({ fileList: uniq.slice(i, i + 50) })
      ;(tmp && tmp.fileList || []).forEach(it => {
        // status !== 0 一律当失败（文件不存在/无权限），不写入 map
        if (it && it.fileID && it.tempFileURL && it.status === 0) map[it.fileID] = it.tempFileURL
      })
    } catch (e) {
      console.warn('[media] 批量换取临时链接失败', e && e.message)
    }
  }
  // 换不到的 fileID 逐个再试一次并打印原因：这是「头像空白」的**唯一**现场证据，
  // 云函数日志里能看到到底是文件不存在（-1）还是无权限。
  const missing = uniq.filter(id => !map[id])
  if (missing.length) {
    try {
      const again = await cloud.getTempFileURL({ fileList: missing })
      ;(again && again.fileList || []).forEach(it => {
        if (it && it.status === 0 && it.tempFileURL) map[it.fileID] = it.tempFileURL
        else console.warn('[media] 文件换链失败 fileID=' + (it && it.fileID) +
          ' status=' + (it && it.status) + ' err=' + (it && it.errMsg))
      })
    } catch (e) { /* 忽略：上面已 warn */ }
  }
  return map
}

function isCloudFileId(v) { return typeof v === 'string' && v.indexOf('cloud://') === 0 }

/**
 * 把猫列表的 avatar / photos 换成 https 临时链接（原地改）。
 * - avatar 为空但 photos 有值 → 用 photos[0] 顶上：地图、猫谱、图鉴共用一套口径，
 *   避免「档案有照片、列表却是占位图」。
 * - 已是 http(s) 的原样保留，非 http/cloud 的怪值（wxfile:// 等本地临时路径）清空。
 */
async function attachCatMediaUrls(list, opts) {
  if (!list || !list.length) return list
  const withPhotos = !opts || opts.photos !== false
  const ids = []
  list.forEach(c => {
    if (!c) return
    if (!c.avatar && Array.isArray(c.photos) && c.photos.length) c.avatar = c.photos[0]
    if (isCloudFileId(c.avatar)) ids.push(c.avatar)
    if (!withPhotos) return
    ;(Array.isArray(c.photos) ? c.photos : []).forEach(p => { if (isCloudFileId(p)) ids.push(p) })
  })
  const map = ids.length ? await fetchTempUrls(ids) : {}
  list.forEach(c => {
    if (!c) return
    c.avatar = normalizeMedia(c.avatar, map)
    if (withPhotos && Array.isArray(c.photos)) {
      c.photos = c.photos.map(p => normalizeMedia(p, map))
    }
  })
  return list
}

/** 单个媒体地址归一化：cloud:// → 临时链接（换不到保留原 fileID，交前端兜底）；
 *  http(s) 与其它值原样保留 —— 不在这里删元素，避免下标错位（前端按下标取预览地址）。 */
function normalizeMedia(v, map) {
  const s = typeof v === 'string' ? v : ''
  if (!s || s.indexOf('cloud://') !== 0) return s
  return map[s] || s
}

/** 目击记录的照片换链（列表/详情共用）。
 *  maxPhotos：每条记录最多换几张（默认 3）。列表页一屏 20 条 × 9 张 = 180 个 fileID
 *  ≈ 4 批 getTempFileURL，会把「猫谱-目击」这一次调用拖长几百毫秒；
 *  列表只展示前几张，超出的留给前端 photo.js 懒换。 */
async function attachSightingMediaUrls(list, opts) {
  if (!list || !list.length) return list
  const maxPhotos = (opts && opts.maxPhotos) || 3
  const ids = []
  list.forEach(s => {
    ;(Array.isArray(s && s.photos) ? s.photos : []).slice(0, maxPhotos)
      .forEach(p => { if (isCloudFileId(p)) ids.push(p) })
  })
  const map = ids.length ? await fetchTempUrls(ids) : {}
  list.forEach(s => {
    if (!s || !Array.isArray(s.photos)) return
    s.photos = s.photos.map((p, i) => i < maxPhotos ? normalizeMedia(p, map) : p)
  })
  return list
}

/** 诊断用：把 fileID 逐个交给官方接口，**原样返回 status / errMsg**，
 *  用来判断「头像空白」到底是文件不存在（status≠0）还是权限问题。 */
async function probeTempUrls(ids) {
  const uniq = [...new Set((ids || []).filter(isCloudFileId))]
  const out = []
  for (let i = 0; i < uniq.length; i += 50) {
    try {
      const res = await cloud.getTempFileURL({ fileList: uniq.slice(i, i + 50) })
      ;(res && res.fileList || []).forEach(it => out.push({
        fileID: it && it.fileID,
        status: it && it.status,
        errMsg: it && it.errMsg,
        hasUrl: !!(it && it.tempFileURL)
      }))
    } catch (e) {
      uniq.slice(i, i + 50).forEach(id => out.push({ fileID: id, status: -99, errMsg: e && e.message, hasUrl: false }))
    }
  }
  return out
}

module.exports = {
  mapPoints, gridSize, attachMarkerUrls,
  attachCatMediaUrls, attachSightingMediaUrls, fetchTempUrls, probeTempUrls
}
