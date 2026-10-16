const app = getApp()
const { C, itemOf, fromNow, distance, distanceText, shareBehavior } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')

/** 默认中心（无学校时的兜底）：南京·东南大学四牌楼校区 */
const DEFAULT_CENTER = { lat: 32.0585, lng: 118.7965 }

/** 卡通猫头像 marker（白底圆角气泡 + 猫脸 + 茎 + 状态圆点）。
 *  iconPath 一律用本地图片，绝不使用远程地址（渲染层加载远程图会被 CORS 拦）。
 *  花色 → 图标映射：11 种档案花色归并到 8 张卡通脸（三花系/暹罗/其他 分别归并）。 */
const CARTOON_ICON_MAP = {
  tabby: 'tabby', orange: 'orange', cow: 'cow', tuxedo: 'tuxedo',
  calico: 'calico', tortoiseshell: 'calico', siamese: 'gray',
  white: 'white', black: 'black', gray: 'gray', other: 'tabby'
}
/** marker 尺寸：96x132 等比缩小（40 宽 → 55 高） */
const MARKER_W = 40
const MARKER_H = 55

/** 投喂提醒阈值：超过这么多小时没投喂，就在地图上常显「未投喂」气泡 */
const FEED_ALERT_HOURS = 12
const FEED_ALERT_MS = FEED_ALERT_HOURS * 60 * 60 * 1000

/** 哪些状态的猫不需要催投喂（寄养有家庭照顾，休学/毕业/失踪/离世都不在校园里） */
const NO_FEED_STATUS = ['foster', 'suspend', 'adopted', 'missing', 'rainbow']

/**
 * 算一只猫的投喂状态。
 *
 * @returns {{ pending:boolean, label:string, hours:number|null }}
 *   pending=true 表示需要在地图上常显提醒；hours 为距今小时数，从未投喂为 null
 */
function feedInfo(p) {
  if (!p) return { pending: false, label: '', hours: null }
  // 点位数据里没有投喂字段（比如 listCats 兜底路径没带上）时不做判断，
  // 否则「未知」会被当成「从未投喂」，整张地图全是未投喂气泡。
  if (!('lastFedAt' in p)) return { pending: false, label: '', hours: null }
  // 不在校园状态的猫不参与投喂提醒
  if (NO_FEED_STATUS.indexOf(p.status) >= 0) return { pending: false, label: '', hours: null }

  if (!p.lastFedAt) return { pending: true, label: '未投喂', hours: null }
  const t = new Date(p.lastFedAt).getTime()
  // 脏数据（比如手填的非法日期）不能让整张地图崩，按「未投喂」处理更符合直觉
  if (!Number.isFinite(t)) return { pending: true, label: '未投喂', hours: null }

  const diff = Date.now() - t
  if (diff >= FEED_ALERT_MS) {
    const h = Math.floor(diff / 3600000)
    return { pending: true, label: h >= 48 ? Math.floor(h / 24) + '天未喂' : h + 'h未喂', hours: h }
  }
  return { pending: false, label: '已投喂', hours: Math.floor(diff / 3600000) }
}

Page(Object.assign({
  data: {
    center: DEFAULT_CENTER,
    scale: 16,
    /** 校园可视范围 { sw:{lat,lng}, ne:{lat,lng} }；有它才做「只展示这块区域」的约束 */
    bounds: null,
    markers: [],
    cats: [],
    /** 「附近猫咪」列表默认只展示最近的前 N 只，其余折叠；点「查看更多」展开 */
    listExpanded: false,
    NEAR_TOP_N: 2,
    clusters: 0,
    loading: true,
    showList: true,
    activeId: '',
    myLocation: null,
    school: null,
    schools: [],
    showLegend: false,
    scope: 'public',
    /** 投喂提醒阈值（小时），图例文案直接引用，避免出现写死的第二份数字 */
    feedAlertHours: FEED_ALERT_HOURS,
    /** 越界（不在本校范围内）的猫数量，用于给用户一个解释 */
    outsideCount: 0,
    /** 猫咪信息弹窗（点 marker 头像弹出） */
    popupOpen: false,
    popupLoading: false,
    popupCat: null,
    popupRecords: [],
    popupTotal: 0,
    popupLatLng: null,
    popupError: ''
  },

  onLoad() {
    this._loaded = true
    this.load()
  },

  // 地图组件就绪后再套用一次中心与范围。
  // ⚠️ 关键：onReady 紧跟在 onLoad 之后触发，此时 load() 的异步请求还没回来，
  // this.data.center 仍是默认值（DEFAULT_CENTER）。如果在这里无条件 moveMapTo，
  // 就会把地图挪到默认中心，并且和 load() 稍后的 moveMapTo 抢先/打架 ——
  // 表现就是「改了范围不生效，又变回原来的值」。
  // 所以：只有拿到真实学校数据（_schoolApplied）后才补一次居中。
  onReady() {
    this._mapReady = true
    if (this._schoolApplied) {
      const c = this.data.center
      if (c && typeof c.lat === 'number') this.moveMapTo(c, this.data.scale)
    }
  },

  onUnload() {
    if (this._reassertTimer) { clearTimeout(this._reassertTimer); this._reassertTimer = null }
  },
  onHide() {
    if (this._reassertTimer) { clearTimeout(this._reassertTimer); this._reassertTimer = null }
  },

  onShow() {
    // tabBar 选中态兜底（见 index.js onShow 注释）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().refresh()
    // 关键：tab 切换回来时必须无条件刷新。
    // 原来写成 `if (this.data.cats.length) this.load()` —— 本校没有点位时 cats 为空，
    // 从「我的」页改完地图中心再切回来就不会重新加载，仍用旧 center/bounds，
    // 表现为「选了中心点不生效」。改为离开页面再回来一律重载。
    if (this._loaded) this.load()
  },

  /**
   * 点位来自云端的网格聚合接口 listMapPoints：
   *  - 相邻猫自动聚成一个数字气泡，避免近距离点位互相压盖
   *  - 非社团成员拿到的数据已在服务端过滤私有点位并模糊化坐标
   *  - 前端再按学校 bounds 做一次「区域聚焦」过滤：只展示选定校园内的点位
   */
  async load() {
    this.setData({ loading: true })
    try {
      await app.ensureReady()
      let school = app.globalData.school
      // 学校信息（含 bounds/center/scale）可能在「我的」页被超管改过，
      // 这里按 id 拉一次最新，避免 globalData 里的缓存过期导致范围约束失效。
      if (school && school._id) {
        try {
          const fresh = await app.callApi('getSchool', { schoolId: school._id })
          if (fresh) {
            school = fresh
            app.globalData.school = fresh
          }
        } catch (e) { /* 拉取失败则用缓存 */ }
      }
      let bounds = this.data.bounds
      // 注意：这里必须先把 center/scale/bounds 一次性 setData 落定，
      // 再做后续「取点位」的调用 —— 否则会出现「改了中心点但地图没动」的错觉。
      const patch = {}
      if (school) {
        // 中心点必须 isFinite：typeof 检查放 NaN 通过，会把 NaN center 带进
        // bounds 让矩形全变 NaN、setBoundary 静默失效（「范围怎么改都不生效」）
        if (school.center && Number.isFinite(school.center.lat) && Number.isFinite(school.center.lng)) patch.center = school.center
        if (school.scale) patch.scale = school.scale
        patch.school = school
        // 少数历史学校档只有 center、没有 bounds —— 本地按 scale 补出可视矩形，
        // 保证「区域聚焦」在云端数据补齐前也能生效，不会退化成全国范围。
        const b = school.bounds && school.bounds.sw && school.bounds.ne
          ? school.bounds
          : (patch.center ? this.boundsFromCenter(patch.center, patch.scale || 16) : null)
        bounds = b
        patch.bounds = b
        this._schoolApplied = true   // 已拿到真实学校数据，onReady 之后才允许补居中
        this.setData(patch)
      }

      const res = await app.callApi('listMapPoints', { zoom: patch.scale || this.data.scale })
      const points = res.points || []
      const clusters = res.clusters || []

      const markers = []
      const markerMap = {}
      let mid = 0

      // 区域聚焦：丢弃明确落在校园范围外的点位（服务端 bounds 为空时不过滤）
      let outside = 0
      const keep = p => {
        // 坐标必须 isFinite：typeof 检查放 NaN 通过，无 bounds 时更是直接放行，
        // NaN  latitude 塞进 marker 会导致地图渲染异常/点位消失
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return false
        if (!bounds || !bounds.sw || !bounds.ne) return true
        const ok = p.lat >= bounds.sw.lat && p.lat <= bounds.ne.lat &&
                   p.lng >= bounds.sw.lng && p.lng <= bounds.ne.lng
        if (!ok) outside++
        return ok
      }
      const inPoints = points.filter(keep)

      inPoints.forEach(p => {
        mid++
        markerMap[mid] = { type: 'cat', catId: p.catId }
        const m = this.buildCatMarker(mid, p)
        if (m) markers.push(m)
        else mid--   // 建不出 marker 时把序号还回去，避免 markerMap 出现空洞
      })

      // 聚合簇：用卡通猫爪气泡显示数量
      clusters.forEach(c => {
        if (!keep(c)) return
        mid++
        markerMap[mid] = { type: 'cluster', lat: c.lat, lng: c.lng }
        markers.push({
          id: mid,
          latitude: c.lat,
          longitude: c.lng,
          title: c.count + ' 只猫',
          width: 46,
          height: 46,
          label: {
            content: '🐾' + c.count,
            color: '#FFFFFF',
            fontSize: 12,
            bgColor: '#F97316',
            borderColor: '#FFFFFF',
            borderWidth: 2,
            borderRadius: 24,
            padding: 7,
            textAlign: 'center',
            anchorX: 0,
            anchorY: 0
          }
        })
      })

      // 底部列表：单点 + 簇内猫去重
      const seen = {}
      const cats = []
      const pushCat = p => {
        if (!p || seen[p.catId]) return
        seen[p.catId] = 1
        // 投喂标签在 JS 层算好：WXML mustache 不支持方法调用（编译期白名单）
        const feed = feedInfo(p)
        cats.push({
          _id: p.catId,
          name: p.name,
          avatar: p.avatar,
          avatarId: p.avatarId || '',
          sterilized: p.sterilized,
          spot: p.spot || '',
          dist: this.distText(p.lat, p.lng),
          // 保留原始坐标：nearListFields 用它按距离排序（WXML 不展示）
          lat: p.lat, lng: p.lng,
          feedLabel: feed.label,
          feedPending: feed.pending
        })
      }
      inPoints.forEach(pushCat)
      clusters.forEach(c => { if (keep(c)) (c.cats || []).forEach(pushCat) })

      this._rawNear = cats
      const applyNear = view => { if (this._rawNear === cats) this.setData(this.nearListFields(view)) }
      // 头像渐进增强：fileID 先原样渲染（<image> 能解析），临时链接批量预取完成后
      // applyNear 换成缩略链接。avatarId（原始 fileID）保留在列表项上，
      // 供 onSheetAvatarErr 在临时链接挂掉时回退渲染。
      const nearView = photo.hydrateCats(cats, { px: 240 }, applyNear)
      this.setData(Object.assign({
        markers, loading: false,
        clusters: clusters.length,
        outsideCount: outside,
        scope: res.scope || 'public'
      }, this.nearListFields(nearView)))
      this._markerMap = markerMap
      // 显式把地图挪到目标中心并套用范围限制（属性绑定不保证重新定位）。
      // 用 patch.center 而不是 this.data.center：data 可能在 setData 回调里还没看到最新值。
      const c = patch.center || (this._schoolApplied ? this.data.center : null)
      console.log('[map] 应用校园范围 → center=', JSON.stringify(c),
        'scale=', patch.scale || this.data.scale,
        'bounds=', JSON.stringify(patch.bounds || this.data.bounds))
      if (!patch.bounds && !this.data.bounds) {
        console.warn('[map] 学校缺少 bounds（云端未回补），当前不做区域约束。' +
          '若「范围怎么改都不生效」，先看这条：学校档里 center/bounds 是否为空。')
      }
      if (c && typeof c.lat === 'number') {
        this.scheduleReassert(c, patch.scale || this.data.scale)
      }
    } catch (e) {
      // 聚合接口不可用时退化为猫谱直读，保证页面不白屏
      try {
        await this.loadFallback()
      } catch (e2) {
        this.setData({ loading: false })
        wx.showToast({ title: e.message || '加载失败', icon: 'none' })
      }
    }
  },

  /** 由中心点 + 缩放推导可视矩形（与云函数 normalizeSchoolGeo 同一公式，保持一致） */
  boundsFromCenter(center, scale) {
    const s = Math.max(12, Math.min(18, Number(scale) || 16))
    const half = 0.048 / Math.pow(2, s - 12)
    const dLng = half / Math.max(0.2, Math.cos((center.lat * Math.PI) / 180))
    return {
      sw: { lat: center.lat - half, lng: center.lng - dLng },
      ne: { lat: center.lat + half, lng: center.lng + dLng }
    }
  },

  /**
   * 把地图定位到目标中心 + 套用范围限制。
   *
   * 为什么要显式调用而不是只靠属性绑定：
   *   `<map>` 的 latitude/longitude 属性变更在部分基础库下不会自动重新定位。
   *
   * 分两条路径（重要）：
   *  - 真机：moveToLocation 可用，直接把中心挪过去。
   *  - 开发者工具：moveToLocation **不支持调试**，会抛
   *    `moveToMapLocation:fail 开发者工具暂时不支持此 API 调试，请使用真机进行开发`。
   *    所以工具里改用 includePoints（工具支持），把中心点当作唯一待包含点，
   *    padding 给足够大的边距 —— 效果等价于「居中」，且不会报错。
   *
   * 另：MapContext 没有 setScale（只有 getScale），缩放只能靠 scale 属性。
   *     setBoundary 能从地图层面限制显示范围，正好实现「只展示这块校园」。
   */
  moveMapTo(center, scale) {
    try {
      if (!this._mapCtx) this._mapCtx = wx.createMapContext('catMap', this)
      if (!this._mapCtx) {
        console.warn('[map] 地图上下文未就绪，本次居中跳过')
        return
      }

      // 1) 限制可视范围（可选能力，老基础库或地图未就绪时静默跳过）
      const b = this.data.bounds
      if (this._mapReady && b && b.sw && b.ne && this._mapCtx.setBoundary) {
        try {
          this._mapCtx.setBoundary({
            southwest: { latitude: b.sw.lat, longitude: b.sw.lng },
            northeast: { latitude: b.ne.lat, longitude: b.ne.lng },
            success: () => {},
            fail: err => console.warn('[map] setBoundary 失败（可忽略）', err && err.errMsg)
          })
        } catch (e) {
          console.warn('[map] setBoundary 抛错（可忽略）', e && e.message)
        }
      }

      // 2) 居中到目标点
      const pt = [{ latitude: center.lat, longitude: center.lng }]
      if (this._isDevtools()) {
        // 工具：用 includePoints 居中（工具支持），两个相同点 + 大 padding ≈ 单纯平移不缩放
        if (this._mapCtx.includePoints) {
          try {
            this._mapCtx.includePoints({
              points: pt,
              padding: [120, 120, 120, 120],
              success: () => {},
              fail: () => {}
            })
          } catch (e) {}
        }
        return
      }
      // 真机：moveToLocation 直接挪中心。必须给回调，否则失败会走全局 errorReport 刷屏。
      if (!this._mapCtx.moveToLocation) return
      this._mapCtx.moveToLocation({
        latitude: center.lat,
        longitude: center.lng,
        success: () => {},
        fail: () => {}
      })
    } catch (e) {
      // 老基础库无该能力时忽略，属性绑定仍然有效
    }
  },

  /**
   * 延迟再套用一次中心 + 范围。
   *
   * 为什么需要：进入地图页时，「地图组件挂载完成」与「云端 getSchool / listMapPoints 返回」
   * 是两条独立的时间线，谁先谁后不确定。只调一次 moveMapTo，可能撞在组件还没就绪的时刻，
   * 结果就是「范围看着像没生效、还是默认值」。
   * 这里在数据落定后再补两次（250ms / 1500ms），用同一份 patch 数据重放，幂等且不影响用户操作
   * （期间用户若自己拖了地图，最多在 1.5s 内被拉回校园范围，属于预期行为）。
   */
  scheduleReassert(center, scale) {
    this.moveMapTo(center, scale)
    if (this._reassertTimer) clearTimeout(this._reassertTimer)
    this._reassertTimer = setTimeout(() => {
      this.moveMapTo(center, scale)
      setTimeout(() => this.moveMapTo(center, scale), 1250)
    }, 250)
  },

  /** 是否运行在「微信开发者工具」中（真机返回 false） */
  _isDevtools() {
    try {
      const info = wx.getDeviceInfo
        ? wx.getDeviceInfo()
        : (wx.getSystemInfoSync ? wx.getSystemInfoSync() : null)
      if (!info) return false
      // 工具里 platform 为 'devtools'；部分版本为 'windows'/'mac' + model='devtools'
      return info.platform === 'devtools' || info.model === 'devtools'
    } catch (e) {
      return false
    }
  },

  /** 构造一只猫的 marker。
   *
   *  ⚠️ iconPath **一律用本地卡通头像图片**，绝不使用猫咪头像的远程地址。
   *  原因：`<map>` 的 marker.iconPath 由渲染层（WebView）加载，云存储直链
   *  （tcb.qcloud.la）不回 Access-Control-Allow-Origin，一旦塞进去就必然刷
   *  「Access to image ... blocked by CORS policy」+「Image加载失败，改为用默认marker」。
   *  头像只在弹窗（image 组件，走逻辑层，能正常解析 fileID / 临时链接）里展示。
   *
   *  卡通脸按档案花色选图；绝育状态用底部圆点颜色区分（绿=已绝育 / 橙=未绝育），
   *  默认锚点在图标底边中点（圆点处），符合图钉直觉。
   */
  buildCatMarker(id, p) {
    // 纵深防御：NaN/Infinity 坐标绝不能进 marker（渲染异常/点位消失）
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return null
    const done = p.sterilized === 'yes'
    const icon = CARTOON_ICON_MAP[p.pattern] || 'tabby'
    const feed = feedInfo(p)

    // 气泡文案优先承载「投喂状态」：绝育状态已经画在 icon 上（done/todo 两张图），
    // 不必在文字里再重复一遍，省出来的位置给更需要被看见的投喂提醒。
    let content = (done ? '✅ ' : '🐾 ') + (p.name || '猫咪')
    let color = done ? '#2FA36B' : '#C2410C'
    let borderColor = done ? '#2FA36B' : '#F97316'
    if (feed.label) {
      content = (feed.pending ? '🍚 ' : '✅ ') + (p.name || '猫咪') + ' · ' + feed.label
      if (feed.pending) { color = '#B45309'; borderColor = '#F59E0B' }
      else { color = '#15803D'; borderColor = '#22C55E' }
    }

    return {
      id,
      latitude: p.lat,
      longitude: p.lng,
      title: p.name,
      width: MARKER_W,
      height: MARKER_H,
      iconPath: '/images/marker-cartoon-' + icon + '-' + (done ? 'done' : 'todo') + '.png',
      callout: {
        content,
        // ⚠️ 只有「欠投喂」的猫常显气泡 —— 全部 ALWAYS 会在猫密集处糊成一片，
        // 反而看不清谁没喂。已投喂的保持点击才出，不抢视觉。
        display: feed.pending ? 'ALWAYS' : 'BYCLICK',
        padding: 8,
        borderRadius: 14,
        borderWidth: 2,
        borderColor,
        bgColor: '#FFFFFF',
        color,
        fontSize: 12,
        textAlign: 'center'
      }
    }
  },

  distText(lat, lng) {
    const my = this.data.myLocation || app.globalData.myLocation
    if (!my) return ''
    const m = distance(my.lat, my.lng, lat, lng)
    return m === null ? '' : distanceText(m)
  },

  async loadFallback() {
    const res = await app.callApi('listCats', { size: 50 })
    const bounds = this.data.bounds
    const list = (res.list || []).filter(c => {
      // isFinite 而非真值判断：!c.location.lat 会误杀 lat=0，且放过 Infinity
      if (!c.location || !Number.isFinite(c.location.lat) || !Number.isFinite(c.location.lng)) return false
      if (!bounds || !bounds.sw || !bounds.ne) return true
      const { lat, lng } = c.location
      return lat >= bounds.sw.lat && lat <= bounds.ne.lat &&
             lng >= bounds.sw.lng && lng <= bounds.ne.lng
    })
    const markers = []
    const markerMap = {}
    list.forEach((c, i) => {
      const id = i + 1
      markerMap[id] = { type: 'cat', catId: c._id }
      const m = this.buildCatMarker(id, {
        catId: c._id,
        name: c.name,
        avatar: (c.photos && c.photos[0]) || c.avatar || '',
        sterilized: c.sterilized,
        pattern: c.pattern || 'other',
        // ⚠️ 经纬度必须传：buildCatMarker 开头就做 isFinite 防御，
        // 少了这两个字段 marker 一律返回 null —— 兜底路径会变成「有列表没点位」的白屏。
        // （上面 filter 已经保证这些都是有限数）
        lat: c.location.lat,
        lng: c.location.lng,
        status: c.status || 'campus',
        lastFedAt: c.lastFedAt || null
      })
      if (m) markers.push(m)
    })
    const fallbackFeed = c => feedInfo({ lastFedAt: c.lastFedAt, status: c.status || 'campus' })
    const near = list.map(c => {
      const feed = fallbackFeed(c)
        return {
          _id: c._id,
          name: c.name,
          avatar: (c.photos && c.photos[0]) || c.avatar || '',
          avatarId: (c.photos && c.photos[0]) || c.avatar || '',
          sterilized: c.sterilized,
          spot: (c.location && c.location.name) || '',
          dist: this.distText(c.location.lat, c.location.lng),
          lat: c.location.lat, lng: c.location.lng,
          feedLabel: feed.label,
          feedPending: feed.pending
        }
    })
    this._rawNear = near
    const applyNear = view => { if (this._rawNear === near) this.setData(this.nearListFields(view)) }
    const nearView = photo.hydrateCats(near, { px: 240 }, applyNear)
    this.setData(Object.assign({
      markers,
      loading: false,
      clusters: 0
    }, this.nearListFields(nearView)))
    this._markerMap = markerMap
  },

  /**
   * marker 图标加载失败。
   *
   * 现在 iconPath 一律是本地 /images/ 图片，正常情况下**不可能失败**；
   * 一旦这里被触发，说明本地图标缺失（资源没打包进去）。
   * 因此只报一次日志提醒去补图片，**绝不 setData、绝不 reload** ——
   * 老代码写的是 `setData(..., () => this.load())`，一只猫失败就整页重载，
   * 重载后同一张坏图再失败、再重载，形成无限循环，日志刷屏且手机发烫。
   */
  onMarkerImageError(e) {
    if (this._markerIconWarned) return
    this._markerIconWarned = true
    console.warn('[map] marker 本地卡通图标缺失，请检查 miniprogram/images/marker-cartoon-*.png ' +
      '是否已加入项目（可用 scripts/gen_marker_icons.py 重新生成）：',
      e && e.currentTarget && e.currentTarget.dataset)
  },

  onMarkerTap(e) {
    const id = e.detail.markerId || e.markerId
    const m = (this._markerMap || {})[id]
    if (!m) return
    if (m.type === 'cluster') {
      // 点聚合气泡 → 放大一级，展开成单点
      this.setData({
        center: { lat: m.lat, lng: m.lng },
        scale: Math.min(20, this.data.scale + 2)
      }, () => this.load())
      return
    }
    this.setData({ activeId: m.catId })
    const p = (this.data.markers || []).filter(x => x.id === id)[0]
    const latLng = p ? { lat: p.latitude, lng: p.longitude } : null
    if (latLng) {
      this.setData({ center: latLng }, () => this.scheduleReassert(latLng, this.data.scale))
    }
    // 点猫头像 → 弹出信息卡（档案 + 最近巡护/投喂记录）
    this.openCatPopup(m.catId, latLng)
  },

  /**
   * 底部列表头像加载失败的兜底链（绝不重载页面，防死循环）：
   *  1. 带缩略参数的图挂了 → 去参数用原图地址重试一次；
   *  2. 还挂 → 拿原始 fileID（avatarId）重新换一次临时链接
   *     （临时链接过期/被撤时这条路恢复）；
   *  3. 都不行 → 置空退 🐱。
   *  ⚠️ 第 2 步**不能**把 fileID 直接塞回 src：开发者工具会把 cloud:// 当相对路径
   *     交给本地 pageframe 加载，报 "Failed to load image ... __pageframe__/..."。
   */
  async onSheetAvatarErr(e) {
    const i = Number((e.currentTarget.dataset || {}).i || 0)
    const cat = (this.data.cats || [])[i]
    if (!cat) return
    const key = 'cats[' + i + '].avatar'
    if (photo.hasProcess(cat.avatar)) { this.setData({ [key]: photo.stripProcess(cat.avatar) }); return }
    if (photo.isFileId(cat.avatarId)) {
      const u = await photo.resolve(cat.avatarId)
      if (u) { this.setData({ [key]: photo.thumb(u, 240) }); return }
    }
    if (cat.avatar) this.setData({ [key]: '' })
  },

  /** 弹窗头像同款兜底链 */
  async onPopupAvatarErr() {
    const pc = this.data.popupCat
    if (!pc) return
    if (photo.hasProcess(pc.avatar)) { this.setData({ 'popupCat.avatar': photo.stripProcess(pc.avatar) }); return }
    if (photo.isFileId(pc.avatarId)) {
      const u = await photo.resolve(pc.avatarId)
      if (u) { this.setData({ 'popupCat.avatar': photo.thumb(u, 400) }); return }
    }
    if (pc.avatar) this.setData({ 'popupCat.avatar': '' })
  },

  /**
   * 打开猫咪信息弹窗：拉 getCat（档案 + 最近目击记录）后组装展示数据。
   * 一次云调用拿全数据，避免弹窗内二次请求造成卡顿。
   */
  async openCatPopup(catId, latLng) {
    // 连点竞态防护：连点两个 marker 时两次 getCat 并发，先点的响应后到会
    // 覆盖后点的 popupCat/popupRecords（而 popupLatLng 是后点的）——
    // 「导航到这儿」就会用 B 点坐标配 A 的档案。序号机制丢弃过期响应。
    const seq = (this._popupSeq = (this._popupSeq || 0) + 1)
    this.setData({
      popupOpen: true,
      popupLoading: true,
      popupCat: null,
      popupRecords: [],
      popupTotal: 0,
      popupError: '',
      popupLatLng: latLng || null
    })
    try {
      const res = await app.callApi('getCat', { id: catId })
      if (seq !== this._popupSeq) return
      const cat = res.cat || {}
      // 投喂状态标签：历史数据（功能上线前的打卡）没有 feedStatus 字段，
      // 与云端 addSighting 的写入默认保持一致 —— 缺失/非法一律按「路过」展示，
      // 否则 itemOf 查不到值会回落成「未知」，整列标签全 unknown。
      const FEED_VALUES = C.FEED_STATUS.map(x => x.value)
      const feedOf = v => itemOf(C.FEED_STATUS, FEED_VALUES.indexOf(v) >= 0 ? v : 'passed')
      const records = (res.sightings || []).slice(0, 6).map(s => ({
        _id: s._id,
        timeText: fromNow(s.createdAt),
        feedLabel: feedOf(s.feedStatus).label,
        feedTag: feedOf(s.feedStatus).tag,
        note: s.note || '',
        photo: photo.display((s.photos && s.photos[0]) || '', 320),
        reporterName: s.reporterName || '匿名'
      }))
      // 头像：命中缓存直接用缩略链接；fileID 未命中则原样渲染（<image> 能解析），
      // 同时后台预取，下次打开秒出
      photo.warm([cat.avatar])
      this.setData({
        popupLoading: false,
        popupCat: {
          _id: cat._id || catId,
          name: cat.name || '猫咪',
          avatar: photo.display(cat.avatar || (cat.photos && cat.photos[0]) || '', 400),
          avatarId: (cat.photos && cat.photos[0]) || cat.avatar || '',
          sex: cat.sex || 'unknown',
          sterLabel: itemOf(C.STERILIZED, cat.sterilized).label,
          sterTag: itemOf(C.STERILIZED, cat.sterilized).tag,
          statusLabel: itemOf(C.CAT_STATUS, cat.status).label,
          statusTag: itemOf(C.CAT_STATUS, cat.status).tag,
          patternLabel: itemOf(C.PATTERN, cat.pattern).label,
          charLabels: (cat.characters || []).map(v => itemOf(C.CHARACTER, v).label),
          spot: (cat.location && cat.location.name) || '',
          sightingCount: cat.sightingCount || 0,
          lastFedText: cat.lastFedAt ? fromNow(cat.lastFedAt) : '',
          lastFedBy: cat.lastFedBy || ''
        },
        popupRecords: records,
        popupTotal: (res.sightings || []).length
      })
    } catch (e) {
      if (seq !== this._popupSeq) return
      this.setData({ popupLoading: false, popupError: e.message || '档案加载失败' })
    }
  },

  closePopup() {
    this.setData({ popupOpen: false })
  },

  /** 弹窗卡片本体拦截冒泡（点卡片不关闭，只有遮罩/把手关闭） */
  noop() {},

  /** 弹窗内「导航到这儿」：拉起微信内置地图（无需任何接口权限） */
  goNavFromPopup() {
    const c = this.data.popupLatLng
    const cat = this.data.popupCat
    if (!c) {
      wx.showToast({ title: '该点位未记录坐标', icon: 'none' })
      return
    }
    wx.openLocation({
      latitude: c.lat,
      longitude: c.lng,
      name: (cat && cat.name ? cat.name + '的常驻点' : '猫咪常驻点'),
      address: (cat && cat.spot) || '校园内',
      scale: 18,
      fail: () => wx.showToast({ title: '打开导航失败', icon: 'none' })
    })
  },

  /** 弹窗内「查看档案」→ 猫详情页 */
  goDetailFromPopup() {
    const cat = this.data.popupCat
    if (!cat) return
    this.closePopup()
    wx.navigateTo({ url: '/pages/cat-detail/cat-detail?id=' + cat._id })
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/cat-detail/cat-detail?id=' + e.currentTarget.dataset.id })
  },

  /** 回到本校地图范围中心 */
  resetView() {
    const school = this.data.school
    const center = (school && school.center && typeof school.center.lat === 'number')
      ? school.center : DEFAULT_CENTER
    const scale = (school && school.scale) || 16
    // 先 setData 落定，再显式挪地图（属性绑定不保证重新定位）
    this.setData({ center, scale }, () => this.scheduleReassert(center, scale))
  },

  locateMe() {
    wx.getLocation({
      type: 'gcj02',
      success: res => {
        const my = { lat: res.latitude, lng: res.longitude }
        app.globalData.myLocation = my
        this.setData({ myLocation: my, center: my }, () => this.load())
      },
      fail: () => wx.showToast({ title: '需要授权位置权限', icon: 'none' })
    })
  },

  toggleList() {
    this.setData({ showList: !this.data.showList })
  },

  /**
   * 算出「附近猫咪」列表字段（不直接 setData），返回可并入 setData 的对象。
   *
   * 需求（2026-10-15）：默认只展示**最近的前 2 只**，其余折叠；点「查看更多」展开。
   * 「最近」= 按与当前定位的距离升序（无定位时保持原有顺序）。
   * 折叠靠 WXML 的 `index < NEAR_TOP_N || listExpanded` 控制显隐 ——
   * 不在 WXML 里 slice（mustache 编译期白名单不支持方法调用，会被静默忽略）。
   * 列表仍一次性全部下发，展开时无需再次请求。
   *
   * 调用方**一次 setData 写全**（拆成两次会让「单次 setData 快照」类测试与
   * 页面批渲染约定失效）。
   *
   * @param {Array} list 已 hydrate（avatar 换链）的完整列表
   */
  nearListFields(list) {
    const arr = list || []
    let out = arr
    const my = this.data.myLocation || app.globalData.myLocation
    if (my && arr.length > 1) {
      // 按距离升序；距不到（distance 返回 null）的排最后。
      // 复制一份再排，避免就地改动调用方传进来的数组（apply 回调可能还在用它做引用比对）。
      out = arr.slice().sort((a, b) => {
        const da = (a.lat != null && a.lng != null) ? distance(my.lat, my.lng, a.lat, a.lng) : null
        const db = (b.lat != null && b.lng != null) ? distance(my.lat, my.lng, b.lat, b.lng) : null
        const va = da == null ? Infinity : da
        const vb = db == null ? Infinity : db
        return va - vb
      })
    }
    return { cats: out }
  },

  /** 展开 / 收起「附近猫咪」的其余部分 */
  toggleExpandNear() {
    this.setData({ listExpanded: !this.data.listExpanded })
  },

  toggleLegend() {
    this.setData({ showLegend: !this.data.showLegend })
  },

  goSighting() {
    wx.navigateTo({ url: '/pages/sighting-post/sighting-post' })
  }
}, shareBehavior(function () {
  const s = app.globalData.school
  const who = s && s.name ? s.name : '校园'
  const n = (this.data.cats || []).length
  const hungry = (this.data.cats || []).filter(c => c.feedPending).length
  const tail = hungry ? ('，' + hungry + ' 只等着投喂 🍚') : (n ? ('，' + n + ' 只猫在册') : '')
  return {
    title: who + '猫咪地图' + tail,
    path: '/pages/map/map'
  }
})))
