/**
 * 校园猫地图点位 —— 难点 6
 *
 * 两个要点：
 *  1. 点位聚合：附近多只猫重叠时自己实现网格聚合即可，不必引入 mapbox。
 *     网格边长随 zoom 变化，同格内的猫合并成一个 cluster，前端渲染成数字气泡。
 *  2. 两级可见：非社团成员拿不到私有点位（spotPrivate），其余点位坐标做模糊化。
 *     过滤与模糊都在服务端完成 —— 客户端拿不到的数据才是安全的。
 */
const { cloud, db, COL, isMember, blurLocation, needBlur } = require('./core')

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
      p.avatar = map[a] || ''            // 换不到就置空 → 前端退 emoji
      if (!p.avatar) dropped++
    } else if (!isRenderableUrl(a)) {
      p.avatar = ''                      // 未知协议：直接丢弃，绝不外泄
      dropped++
    }
    // 已是 http(s) 的原样保留
  })
  if (dropped) console.warn('[map] 有 ' + dropped + ' 个头像无法转为可加载地址，已退化为 emoji marker')
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

  // 两级可见：非成员直接剔除私有点位；其余按需模糊化
  const list = res.data
    .filter(c => c.location && typeof c.location.lat === 'number' && typeof c.location.lng === 'number')
    .filter(c => member || !c.spotPrivate)
    .map(c => {
      const loc = (!member && needBlur(c)) ? blurLocation(c.location) : c.location
      return {
        catId: c._id,
        name: c.name,
        avatar: (c.photos && c.photos[0]) || c.avatar || '',
        status: c.status || 'campus',
        sterilized: c.sterilized || 'unknown',
        spot: (c.location && c.location.name) || '',
        lat: loc.lat,
        lng: loc.lng,
        blurred: !!loc.blurred
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
        catId: p.catId, name: p.name, avatar: p.avatar,
        sterilized: p.sterilized, spot: p.spot, lat: p.lat, lng: p.lng
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

module.exports = { mapPoints, gridSize }
