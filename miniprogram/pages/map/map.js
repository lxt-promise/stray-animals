const app = getApp()
const { distance, distanceText } = require('../../utils/util.js')

/** 默认中心（无学校时的兜底）：南京·东南大学四牌楼校区 */
const DEFAULT_CENTER = { lat: 32.0585, lng: 118.7965 }

/** marker 图标：一律用本地图片，绝不使用远程地址（渲染层加载远程图会被 CORS 拦）。
 *  已绝育 / 未绝育用两张不同色系的本地爪印区分，猫咪身份靠 callout 名字气泡。 */
const CAT_ICON = '/images/marker-cat.png'
const CAT_ICON_DONE = '/images/marker-cat-done.png'

Page({
  data: {
    center: DEFAULT_CENTER,
    scale: 16,
    /** 校园可视范围 { sw:{lat,lng}, ne:{lat,lng} }；有它才做「只展示这块区域」的约束 */
    bounds: null,
    markers: [],
    cats: [],
    clusters: 0,
    loading: true,
    showList: true,
    activeId: '',
    myLocation: null,
    school: null,
    schools: [],
    showLegend: false,
    scope: 'public',
    /** 越界（不在本校范围内）的猫数量，用于给用户一个解释 */
    outsideCount: 0
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
        if (school.center && typeof school.center.lat === 'number') patch.center = school.center
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
        markers.push(this.buildCatMarker(mid, p))
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
        cats.push({
          _id: p.catId,
          name: p.name,
          avatar: p.avatar,
          sterilized: p.sterilized,
          spot: p.spot || '',
          dist: this.distText(p.lat, p.lng)
        })
      }
      inPoints.forEach(pushCat)
      clusters.forEach(c => { if (keep(c)) (c.cats || []).forEach(pushCat) })

      this.setData({
        cats, markers, loading: false,
        clusters: clusters.length,
        outsideCount: outside,
        scope: res.scope || 'public'
      })
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
   *  ⚠️ iconPath **一律用本地图片**，绝不使用猫咪头像的远程地址。
   *  原因：`<map>` 的 marker.iconPath 由渲染层（WebView）加载，云存储直链
   *  （tcb.qcloud.la）不回 Access-Control-Allow-Origin，一旦塞进去就必然刷
   *  「Access to image ... blocked by CORS policy」+「Image加载失败，改为用默认marker」。
   *  头像只在底部列表（<image> 组件，走逻辑层，能正常解析 fileID / 临时链接）里展示。
   *
   *  猫咪之间的区分交给 callout 气泡：✅=已绝育、🐾=未绝育 + 名字。
   */
  buildCatMarker(id, p) {
    const done = p.sterilized === 'yes'
    return {
      id,
      latitude: p.lat,
      longitude: p.lng,
      title: p.name,
      width: 36,
      height: 36,
      iconPath: done ? CAT_ICON_DONE : CAT_ICON,
      callout: {
        content: (done ? '✅ ' : '🐾 ') + (p.name || '猫咪'),
        display: 'BYCLICK',
        padding: 8,
        borderRadius: 14,
        borderWidth: 2,
        borderColor: done ? '#2FA36B' : '#F97316',
        bgColor: '#FFFFFF',
        color: done ? '#2FA36B' : '#C2410C',
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
      if (!c.location || !c.location.lat) return false
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
      markers.push(this.buildCatMarker(id, {
        catId: c._id,
        name: c.name,
        avatar: (c.photos && c.photos[0]) || c.avatar || '',
        sterilized: c.sterilized
      }))
    })
    this.setData({
      cats: list.map(c => ({
        _id: c._id,
        name: c.name,
        avatar: (c.photos && c.photos[0]) || c.avatar || '',
        sterilized: c.sterilized,
        spot: (c.location && c.location.name) || '',
        dist: this.distText(c.location.lat, c.location.lng)
      })),
      markers,
      loading: false,
      clusters: 0
    })
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
    console.warn('[map] marker 本地图标缺失，请检查 miniprogram/images/marker-cat.png ' +
      '与 marker-cat-done.png 是否已加入项目：', e && e.currentTarget && e.currentTarget.dataset)
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
    if (p) {
      const c = { lat: p.latitude, lng: p.longitude }
      this.setData({ center: c }, () => this.scheduleReassert(c, this.data.scale))
    }
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

  toggleLegend() {
    this.setData({ showLegend: !this.data.showLegend })
  },

  goSighting() {
    wx.navigateTo({ url: '/pages/sighting-post/sighting-post' })
  }
})
