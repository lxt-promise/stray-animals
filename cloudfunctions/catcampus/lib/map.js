/**
 * 校园猫地图点位 —— 难点 6
 *
 * 两个要点：
 *  1. 点位聚合：附近多只猫重叠时自己实现网格聚合即可，不必引入 mapbox。
 *     网格边长随 zoom 变化，同格内的猫合并成一个 cluster，前端渲染成数字气泡。
 *  2. 两级可见：非社团成员拿不到私有点位（spotPrivate），其余点位坐标做模糊化。
 *     过滤与模糊都在服务端完成 —— 客户端拿不到的数据才是安全的。
 */
const { db, COL, isMember, blurLocation, needBlur } = require('./core')

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

  return {
    zoom,
    grid: g,
    total: list.length,
    clusters,
    points,
    scope: member ? 'member' : 'public',
    notice: member ? '' : '幼猫、病猫与私有点位已隐藏或模糊处理，保护猫咪安全。'
  }
}

module.exports = { mapPoints, gridSize }
