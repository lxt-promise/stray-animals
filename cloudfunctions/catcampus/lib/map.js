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

/** 每只猫最多保留几个候选打卡点位（新 → 旧）。
 *  >1 是为了「最新一次打卡跑到校园范围外」时能退到次新那条 ——
 *  只留 1 条的话，一次校外打卡就会让这只猫从地图上凭空消失。 */
const SIGHTING_LOC_CANDIDATES = 3

/**
 * 取每只猫「最近几次打卡」的点位。
 *
 * 为什么需要：地图点位原来只读猫档案的常驻位置（cats.location）——
 * 没填常驻位置的猫永远不上图；用户在新地点打卡后，图标也还停在老位置。
 * 现在按 sightings.createdAt 倒序扫描最近 N 条，每只猫留最多 3 条（新→旧），
 * 由 mapPoints 结合校园范围挑选；档案常驻位置退居最后兜底。
 *
 * 两个约束：
 *  1. **只认档案里的猫**：catId 为空的打卡是「未认领的新猫」（pending），没有档案，
 *     不上图（等社团核实建档后自然会出现）。
 *  2. 字段投影只取 3 个字段 —— photos/note 等大字段不拉，响应包体积直接决定云函数耗时。
 *
 * ⚠️ 两条查询路径，且**失败原因必须交回上层**（return { locs:{}, error }）：
 * 「最近几个目击没上图」最常见的根因就是这条查询挂了（缺索引 / 超时），
 * 而旧写法在 catch 里直接 return {} —— 静默降级成档案常驻位置，
 * 日志外无人知晓，现场只能看到「点位不对」，排查无从下手。
 *
 *  ① 首选：`orderBy('createdAt','desc')`（需要 createdAt 索引）
 *  ② 降级：不带 orderBy（无索引也能跑），多拉一些后**内存排序**。
 *     拿到的不一定严格是最新 N 条，但比「整条查询失败、只能退回档案位置」强得多。
 *
 * 关于归属：先按 `schoolId` 过滤（省得把别校记录拉回来挤占 500 条窗口），
 * 再在**内存里按 catId 复核**一遍 —— 只保留本校猫的打卡。
 * 双保险的原因：打卡记录的 schoolId 是写入时从用户档案快照来的，历史上出现过
 * 用户还没绑校就打卡的情况（那时会写成空串，按校过滤就查不到）。
 * 这种情况由 addSighting 的「猫档案反推」兜底 + `backfillSightingSchool` 回填处理，
 * 这里再按 catId 复核一次，确保别校的猫永远不会串进来。
 *
 * 同理不要把 `location: _.neq(null)` 塞进 where —— 不等值条件会让索引需求复杂化，
 * 在控制台没建索引时直接失败；而它完全可以在内存里过滤。
 */
async function lastSightingLocations(schoolId, catIds) {
  const proj = { catId: true, location: true, createdAt: true }
  // 本校一只猫都没有时不用查了 —— 查回来也会被下面的集合过滤光
  if (!catIds || !catIds.size) return { locs: {}, error: null }
  const where = schoolId ? { schoolId } : {}

  // 500 而不是 400：坐标过滤挪到内存后，无坐标的打卡也会占窗口，
  // 稍微放宽一点，保证「每只猫都能拿到自己最近那几次打卡」。
  try {
    const res = await db.collection(COL.sighting)
      .where(where).field(proj).orderBy('createdAt', 'desc').limit(500).get()
    return { locs: collectSightingLocs(res.data, catIds), error: null }
  } catch (e) {
    console.warn('[map] 打卡点位排序查询失败，尝试降级（多半是缺索引）', (e && e.message) || e)
  }

  try {
    const res = await db.collection(COL.sighting)
      .where(where).field(proj).limit(800).get()
    const rows = (res.data || []).slice().sort(byCreatedAtDesc)
    const locs = collectSightingLocs(rows, catIds)
    return {
      locs,
      error: null,
      degraded: true,
      note: '打卡点位未按索引排序，已降级为内存排序（建议为 sightings 建 (schoolId ASC, createdAt DESC) 索引）'
    }
  } catch (e) {
    const msg = (e && e.message) || String(e)
    // 两条路都挂了才真正放弃：回退「只用档案常驻位置」，并把原因交回上层
    console.warn('[map] 拉取最近打卡点位失败，回退档案常驻位置', msg)
    return { locs: {}, error: msg }
  }
}

function byCreatedAtDesc(a, b) {
  const ta = a && a.createdAt instanceof Date ? a.createdAt.getTime() : Number(a && a.createdAt) || 0
  const tb = b && b.createdAt instanceof Date ? b.createdAt.getTime() : Number(b && b.createdAt) || 0
  return tb - ta
}

/** 打卡记录 → 每只猫的候选点位列表（新 → 旧，最多 SIGHTING_LOC_CANDIDATES 条）。
 *  catIds：本校猫的 id 集合，不在其中的一律丢掉（跨校隔离在内存里做）。 */
function collectSightingLocs(rows, catIds) {
  const locs = {}
  ;(rows || []).forEach(s => {
    if (!s || !s.catId) return        // 未认领的新猫：无档案，不上图
    if (catIds && !catIds.has(s.catId)) return   // 别的学校的猫
    const loc = s.location
    // 无坐标的打卡在这里被丢掉（替代原来的 where location _.neq(null)）
    if (!loc || !isFinite(loc.lat) || !isFinite(loc.lng)) return
    const arr = locs[s.catId] || (locs[s.catId] = [])
    if (arr.length < SIGHTING_LOC_CANDIDATES) arr.push(loc)   // 已按时间倒序，先到者更新
  })
  return locs
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
  // 本校猫的 id 集合 —— 打卡记录的归属判定用它（sightings.schoolId 可能是空的）
  const catIds = new Set((res.data || []).map(c => c._id))

  const member = isMember(user)
  const zoom = Number(event.zoom) || 16
  const g = gridSize(zoom)
  const bounds = event.bounds || null

  // 每只猫最近几次打卡的点位（查询失败时 locs 为空，下面自然回退档案位置）
  const last = await lastSightingLocations(schoolId, catIds)
  const lastLoc = last.locs || {}

  /**
   * 点位裁决：**优先落在校园范围内**的那条候选，而不是无条件用最新打卡。
   *
   * 为什么不能无条件用最新打卡（2026-10-25 修）：
   *  客户端拿到点位后还要按校园 bounds 过滤一次，而打卡坐标是用户手机 GPS，
   *  一次「在校外/校园边缘」的打卡会让这只猫的唯一坐标跑到框外 → 被整只丢掉。
   *  现场表现就是「最近几个目击都没有显示在地图上」——越打越不见。
   *
   * 候选顺序（新 → 旧，最后是档案常驻位置）：
   *  1. 取第一个落在 bounds 内的候选（bounds 为空时即取最新打卡）
   *  2. 全都落在框外 → 仍用最新打卡，**标记 outside 而不丢弃**：
   *     宁可多显示一只，也不能让猫凭空消失（越界由前端给出提示）
   */
  const pickLoc = c => {
    const cands = (lastLoc[c._id] || []).map(loc => ({ loc, from: 'sighting' }))
    if (c.location && isFinite(c.location.lat) && isFinite(c.location.lng)) {
      cands.push({ loc: c.location, from: 'profile' })
    }
    if (!cands.length) return null
    for (const cd of cands) {
      if (!bounds || inBounds(cd.loc, bounds)) {
        return { loc: cd.loc, from: cd.from, outside: false }
      }
    }
    return { loc: cands[0].loc, from: cands[0].from, outside: !!bounds }
  }

  // 两级可见：非成员直接剔除私有点位；其余按需模糊化
  // 坐标过滤必须 isFinite：typeof 检查放 NaN 通过，会产出 NaN:NaN 幽灵点位
  const list = res.data
    .map(c => ({ cat: c, picked: pickLoc(c) }))
    .filter(x => x.picked)
    .filter(x => member || !x.cat.spotPrivate)
    .map(x => {
      const c = x.cat
      const loc = (!member && needBlur(c)) ? blurLocation(x.picked.loc) : x.picked.loc
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
        // 供前端/排查区分点位来源（true = 点位来自某次打卡）
        fromSighting: x.picked.from === 'sighting',
        // 所有候选都落在校园范围外 —— 仍然上图，只打标（丢弃会让猫凭空消失）
        outside: x.picked.outside
      }
    })

  const outsideCount = list.filter(p => p.outside).length

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
    // 越界（所有候选点位都在校园范围外）的点位数量，前端据此给提示
    outside: outsideCount,
    // 打卡表查询的异常说明（正常为空）。留空串而不是不返回字段，
    // 便于前端/后台直接读 —— 「静默降级」是这类问题最难排查的地方。
    warn: last.error
      ? ('最近打卡点位查询失败，已回退档案常驻位置：' + last.error +
         '（建议为 sightings 建 (schoolId ASC, createdAt DESC) 索引）')
      : (last.note || ''),
    clusters,
    // points.avatar 已由 attachMarkerUrls 换成 https 临时链接：
    //  - marker.iconPath **不用它**（前端 buildCatMarker 一律用本地图标，从源头绕开 CORS）
    //  - 底部猫列表的 <image> 组件用它展示真实头像（<image> 走逻辑层，能正常加载）
    points,
    scope: member ? 'member' : 'public',
    notice: member ? '' : '幼猫、病猫与私有点位已隐藏或模糊处理，保护猫咪安全。'
  }
}

/**
 * 诊断：逐只猫回答「为什么它没出现在地图上」（仅超管）。
 *
 * 现场最常见的一句话是「新打卡的猫没上图」，可能的原因有五六种，
 * 光看界面分不清。这个接口把每只猫的判定依据摊开：
 *   - 档案有没有常驻位置
 *   - 有没有带 catId 的打卡
 *   - 那些打卡里有没有坐标（打卡时没授权定位就没坐标）
 *   - 最终点位来自哪条、是否落在校园 bounds 内
 *   - 打卡查询本身是不是挂了（缺索引 / 超时）
 * 另外单独统计「catId 为空」的打卡 —— 那是未认领的新猫，按设计不上图，
 * 数量一多往往就是「明明打了卡却看不到」的真相。
 */
async function diagnoseMapPoints(user, event) {
  const schoolId = event.schoolId || (user && user.schoolId) || ''
  const where = schoolId ? { schoolId } : {}
  const bounds = (event.bounds && event.bounds.sw && event.bounds.ne) ? event.bounds : null

  const res = await db.collection(COL.cat).where(where).limit(300).get()
  const cats = res.data || []

  // 打卡查询：和正式链路同一条语句，失败原因如实报出来
  let queryError = null
  let rows = []
  try {
    const r = await db.collection(COL.sighting)
      .where(where)
      .field({ catId: true, location: true, createdAt: true })
      .orderBy('createdAt', 'desc').limit(500).get()
    rows = r.data || []
  } catch (e) {
    queryError = (e && e.message) || String(e)
    // 诊断场景下退一步也要给结论：不带排序再试一次
    try {
      const r2 = await db.collection(COL.sighting)
        .where(where)
        .field({ catId: true, location: true, createdAt: true })
        .limit(500).get()
      rows = (r2.data || []).slice().sort(byCreatedAtDesc)
      queryError = queryError + '（已用不带排序的查询兜底，建议建 (schoolId ASC, createdAt DESC) 索引）'
    } catch (e2) {
      queryError = queryError + '（兜底查询也失败：' + ((e2 && e2.message) || e2) + '）'
    }
  }

  const hasLoc = s => s && s.location && isFinite(s.location.lat) && isFinite(s.location.lng)
  const pendingRows = rows.filter(s => s && !s.catId && hasLoc(s)).length
  const pendingNoLoc = rows.filter(s => s && !s.catId && !hasLoc(s)).length

  // ---- 跨校错配排查 ----
  // 「本校只扫到 3 条，但我明明打了十几次卡」——最常见的原因是打卡记录落在
  // 别的校园下（在测试校园做的打卡、或打卡时用户档案还没绑校导致 schoolId 为空串）。
  // 只报本校数据是看不出这点的，必须同时给出全库分布做对照。
  let schoolName = ''
  if (schoolId) {
    try {
      const s = await db.collection(COL.school).doc(schoolId).get()
      schoolName = (s.data && s.data.name) || ''
    } catch (e) {
      schoolName = ''    // 学校名拿不到不影响结论，不让它盖掉后面的证据
    }
  }
  let allRows = []
  try {
    const r = await db.collection(COL.sighting)
      .field({ catId: true, schoolId: true, location: true })
      .limit(500).get()
    allRows = r.data || []
  } catch (e) {
    allRows = []
  }
  const bySchool = {}
  allRows.forEach(s => {
    if (!s) return
    const k = s.schoolId || '(空)'
    bySchool[k] = (bySchool[k] || 0) + 1
  })
  const pendingAll = allRows.filter(s => s && !s.catId && hasLoc(s)).length
  const otherCount = allRows.length - rows.length
  // 明确的判定句，省得拿到 JSON 还要自己算
  let mismatchHint = ''
  if (otherCount > 0) {
    mismatchHint = '全库共 ' + allRows.length + ' 条打卡，本校只匹配到 ' + rows.length +
      ' 条，另有 ' + otherCount + ' 条记在别校或 schoolId 为空 —— 这些不会上图'
  } else if (!rows.length && allRows.length) {
    mismatchHint = '全库有 ' + allRows.length + ' 条打卡，但没有一条属于本校'
  }

  const out = cats.map(c => {
    const own = rows.filter(s => s && s.catId === c._id)
    const withLoc = own.filter(hasLoc)
    const profLoc = (c.location && isFinite(c.location.lat) && isFinite(c.location.lng)) ? c.location : null
    const cands = withLoc.slice(0, SIGHTING_LOC_CANDIDATES).map(s => s.location)
    if (profLoc) cands.push(profLoc)

    let source = 'none', reason = '', lat = null, lng = null, outside = false
    if (cands.length) {
      let hit = null
      for (const loc of cands) {
        if (!bounds || inBounds(loc, bounds)) { hit = loc; break }
      }
      const picked = hit || cands[0]
      outside = !hit && !!bounds
      source = withLoc.length ? 'sighting' : 'profile'
      lat = picked.lat; lng = picked.lng
      // 用档案位置时必须说清「为什么不是打卡点位」，否则排查时看不出打卡链路没生效
      if (outside) reason = '所有候选点位都落在校园范围外'
      else if (!withLoc.length) reason = '没有带 catId 的打卡，用档案常驻位置'
    } else if (own.length) {
      reason = '有 ' + own.length + ' 条打卡，但都没有坐标（打卡时未授权定位/未选点）'
    } else if (profLoc) {
      source = 'profile'; lat = profLoc.lat; lng = profLoc.lng
      reason = '没有带 catId 的打卡，用档案常驻位置'
    } else {
      reason = '既无常驻位置、也没有带坐标的打卡 —— 不会上图'
    }

    return {
      catId: c._id, name: c.name || '',
      status: c.status || 'campus',
      spotPrivate: !!c.spotPrivate,
      hasProfileLoc: !!profLoc,
      sightings: own.length,
      sightingsWithLoc: withLoc.length,
      source, lat, lng, outside, reason
    }
  })

  const onMap = out.filter(x => x.source !== 'none').length

  // 全库猫档案数（不带学校过滤）：本校 cats 数明显偏少 = 新猫档案建在别的校园下了
  let catsAll = -1
  try {
    const rc = await db.collection(COL.cat).limit(300).get()
    catsAll = (rc.data || []).length
  } catch (e) {
    catsAll = -1
  }

  return {
    schoolId,
    schoolName,
    boundsUsed: !!bounds,
    sightingQueryError: queryError || '',
    sightingRowsScanned: rows.length,
    // catId 为空的打卡：未认领的新猫，按设计不上图
    pendingWithLoc: pendingRows,
    pendingNoLoc,
    // ---- 跨校错配证据 ----
    sightingsAll: allRows.length,
    sightingsBySchool: bySchool,
    pendingAll,
    catsInSchool: cats.length,
    catsAll,
    mismatchHint,
    summary: { cats: cats.length, onMap, missing: cats.length - onMap },
    cats: out
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
  // ids=true：额外下发一份**原始 fileID**（photoIds / avatarId，与 photos 同下标）。
  // 为什么需要：下面会把 photos 原地替换成临时链接，签名过期后客户端手里就再也
  // 没有「能重新换链」的东西了 —— 详情页点相册预览黑屏、且无法自愈。
  // 只在详情页（getCat）开启，列表接口不多传这份冗余字段。
  const keepIds = !!(opts && opts.ids)
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
    if (keepIds && withPhotos) {
      c.avatarId = isCloudFileId(c.avatar) ? c.avatar : ''
      c.photoIds = (Array.isArray(c.photos) ? c.photos : []).map(p => (isCloudFileId(p) ? p : ''))
    }
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
  mapPoints, gridSize, attachMarkerUrls, diagnoseMapPoints,
  attachCatMediaUrls, attachSightingMediaUrls, fetchTempUrls, probeTempUrls
}
