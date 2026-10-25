const app = getApp()
const { C, itemOf, fromNow, distance, distanceText, shareBehavior, sightTagText } = require('../../utils/util.js')
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
/** marker 尺寸：96x132 等比缩小（32 宽 → 44 高）。
 *  再大就会和相邻猫的气泡糊在一起 —— 校园里猫点常常只隔几十米，
 *  缩放到 16 级时 40x55 的图钉 + 常显气泡会互相压住（真机截图反馈）。 */
const MARKER_W = 32
const MARKER_H = 44

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
    this.cancelReassert()
  },
  onHide() {
    this.cancelReassert()
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
            app.setSchool(fresh)
          }
        } catch (e) { /* 拉取失败则用缓存 */ }
      }
      let bounds = this.data.bounds
      // 注意：这里必须先把 center/scale/bounds 一次性 setData 落定，
      // 再做后续「取点位」的调用 —— 否则会出现「改了中心点但地图没动」的错觉。
      const patch = {}
      if (school) {
        // 学校档里带来的「理想视角」。注意它不一定会落到 patch 上：
        // 用户已经拖过图时不覆盖（见下方注释），所以先攒在一个临时对象里。
        const next = {}
        // 中心点必须 isFinite：typeof 检查放 NaN 通过，会把 NaN center 带进
        // bounds 让矩形全变 NaN、点位过滤静默失效（「范围怎么改都不生效」）
        if (school.center && Number.isFinite(school.center.lat) && Number.isFinite(school.center.lng)) next.center = school.center
        if (school.scale) next.scale = school.scale
        patch.school = school
        // ⚠️ 只在学校档**显式存了 bounds** 时才做范围筛选，绝不本地按 center+scale 推导。
        // 旧写法会补一个「视野大小」的矩形（scale 16 → ±0.003° ≈ ±330m），而真实校园
        // 动辄一两公里 —— 于是在稍远处打的卡整只猫被判越界丢掉，
        // 现场就是「最近几个目击都没显示在地图上」。
        // 没存 bounds 时不过滤也安全：点位查询已经 where({schoolId}) 限定本校，
        // 不会串到别的学校去。
        const b = (school.bounds && school.bounds.sw && school.bounds.ne) ? school.bounds : null
        bounds = b
        patch.bounds = b
        this._schoolApplied = true   // 已拿到真实学校数据，onReady 之后才允许补居中
        // 学校换了（或首次进入）才复位「用户拖过图」的标记：
        // 同校 onShow 刷新不能复位 —— 否则切个 tab 回来，地图被拽回中心。
        const pc = this._appliedCenter
        if (next.center && (!pc || pc.lat !== next.center.lat || pc.lng !== next.center.lng)) {
          this._userPanned = false
          this._appliedCenter = next.center
        }
        // 用户已经自己拖过图时，**连 center/scale 数据都不写回学校默认值**。
        // 只让 _userPanned 挡住 moveMapTo 是不够的：部分基础库下 `<map>` 的
        // latitude/longitude 属性变更自己就会重新定位，于是「拖到别处 →
        // 切个 tab 回来 → 视角又跳回校园中心」。点位范围照常更新，
        // 只把镜头控制权留给用户。
        if (!this._userPanned) {
          if (next.center) patch.center = next.center
          if (next.scale) patch.scale = next.scale
        }
        this.setData(patch)
      }

      // bounds 必须传给云端：点位裁决（打卡位置 vs 档案位置、是否越界）在服务端完成。
      // 前端再过滤一次会和云端口径打架，且前端拿不到「档案位置」这个回退项。
      const res = await app.callApi('listMapPoints', {
        zoom: patch.scale || this.data.scale,
        bounds: bounds || null
      })
      const points = res.points || []
      const clusters = res.clusters || []

      const markers = []
      const markerMap = {}
      let mid = 0

      // ⚠️ 这里**不再**按 bounds 过滤点位 —— 旧写法会在本地丢掉越界点位，
      // 而「最新一次打卡在校外」时它已经是这只猫唯一的坐标，丢了猫就整只消失。
      // 裁决移到服务端（有档案常驻位置可回退），这里只做渲染层安全校验：
      // 坐标必须 isFinite —— typeof 检查放 NaN 通过，NaN 塞进 marker 会让整片点位消失。
      const keep = p => Number.isFinite(p.lat) && Number.isFinite(p.lng)
      // 越界数量由云端统计（它才知道有没有回退成功）
      const outside = Number(res.outside) || 0
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
          // 聚合簇跟着猫头 marker 一起缩小（46 → 38），否则多点叠放时簇比猫还大
          width: 38,
          height: 38,
          label: {
            content: '🐾' + c.count,
            color: '#FFFFFF',
            fontSize: 11,
            bgColor: '#F97316',
            borderColor: '#FFFFFF',
            borderWidth: 1,
            borderRadius: 19,
            padding: 5,
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
      // 打卡表查询失败时云端会回原因（缺索引 / 超时），别再让它只躺在云函数日志里
      if (res.warn) console.warn('[map] ' + res.warn)
      // 点位来源统计：排查「位置不对 / 某只猫没上图」时先看这一行 ——
      // 它能直接区分「压根没拿到打卡」和「拿到了但被判越界」。
      const allCats = inPoints.concat(
        clusters.filter(c => keep(c)).reduce((acc, c) => acc.concat(c.cats || []), []))
      const fromSight = allCats.filter(p => p.fromSighting).length
      console.log('[map] 点位 单点' + inPoints.length + ' / 簇' + clusters.length +
        ' · 猫共' + allCats.length + ' 只（打卡位置 ' + fromSight +
        ' · 档案位置 ' + (allCats.length - fromSight) + '）· 越界 ' + outside +
        ' · 云端总数 ' + (res.total || 0) + (res.warn ? ' · ⚠ ' + res.warn : ''))
      this.setData(Object.assign({
        markers, loading: false,
        clusters: clusters.length,
        outsideCount: outside,
        scope: res.scope || 'public'
      }, this.nearListFields(nearView)))
      this._markerMap = markerMap
      console.log('[map] 本校范围=', JSON.stringify(patch.bounds || this.data.bounds),
        '（只用于筛选点位，不再限制镜头拖动）')
      if (!patch.bounds && !this.data.bounds) {
        console.warn('[map] 学校缺少 bounds（云端未回补），点位不做区域筛选。' +
          '若「范围怎么改都不生效」，先看这条：学校档里 center/bounds 是否为空。')
      }
      // 用户已拖过图就彻底不动镜头（含不再重定位）；
      // 否则显式把地图挪到目标中心（属性绑定不保证重新定位）。
      if (!this._userPanned) {
        const c = patch.center || (this._schoolApplied ? this.data.center : null)
        if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
          this.scheduleReassert(c, patch.scale || this.data.scale)
        }
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
   * 把地图居中到目标点。
   *
   * 为什么要显式调用而不是只靠属性绑定：
   *   `<map>` 的 latitude/longitude 属性变更在部分基础库下不会自动重新定位。
   *   （反过来说，在另一些版本里属性变更又会触发重新定位 —— 所以 load() 里
   *    用户拖过图之后连 center/scale 都不写回，避免两个机制互相打架。）
   *
   * 分两条路径（重要）：
   *  - 真机：moveToLocation 可用，直接把中心挪过去。
   *  - 开发者工具：moveToLocation **不支持调试**，会抛
   *    `moveToMapLocation:fail 开发者工具暂时不支持此 API 调试，请使用真机进行开发`。
   *    所以工具里改用 includePoints（工具支持），把中心点当作唯一待包含点，
   *    padding 给足够大的边距 —— 效果等价于「居中」，且不会报错。
   *
   * 另：MapContext 没有 setScale（只有 getScale），缩放只能靠 scale 属性。
   *     setBoundary 已于 2026-10-24 移除（它会禁止把边缘点位拖到屏幕中心）。
   */
  moveMapTo(center, scale) {
    try {
      if (!this._mapCtx) this._mapCtx = wx.createMapContext('catMap', this)
      if (!this._mapCtx) {
        console.warn('[map] 地图上下文未就绪，本次居中跳过')
        return
      }

      // ⚠️ 这里曾经用 setBoundary 把可视范围锁在校园矩形（外扩 60%）里。
      // 2026-10-24 用户反馈「拖不到拐角」后**彻底移除**：只要设置了边界，
      // 无论外扩多少，拖到边缘总会被拉回，屏幕角落的点位就永远无法居中 ——
      // 而「把某个 marker 拖到屏幕中心看仔细」是地图最基本的操作。
      // 校园范围约束保留在**数据层**（只展示本校点位，见 load 里的 keep），
      // 不再约束镜头 —— 展示范围 ≠ 可视范围，这两件事必须分开。

      // 居中到目标点
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
    // 用户已经自己拖过地图就别再抢了：数据晚到时把地图从用户手里拽回中心，
    // 体感就是「地图拖不动」。
    if (this._userPanned) return
    this.moveMapTo(center, scale)
    if (this._reassertTimer) clearTimeout(this._reassertTimer)
    this._reassertTimer = setTimeout(() => {
      if (this._userPanned) return
      this.moveMapTo(center, scale)
      this._reassertTail = setTimeout(() => {
        if (!this._userPanned) this.moveMapTo(center, scale)
      }, 1250)
    }, 250)
  },

  /** 作废所有未执行的入场重定位（用户开始拖动时调用） */
  cancelReassert() {
    if (this._reassertTimer) { clearTimeout(this._reassertTimer); this._reassertTimer = null }
    if (this._reassertTail) { clearTimeout(this._reassertTail); this._reassertTail = null }
  },

  /**
   * 视野变化：只认「用户手势」这一种。
   * includePoints / moveToLocation / setBoundary 触发的变化 causedBy 是
   * 'update' / 'scale'，不能当成用户拖动，否则入场定位会被自己打断。
   */
  onRegionChange(e) {
    if (e && e.type === 'begin' && e.causedBy === 'drag') {
      this._userPanned = true
      this.cancelReassert()
    }
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
      // 分隔符不留空格：气泡宽度直接决定相邻两点会不会互相覆盖，
      // 「小灰灰·未投喂」比「小灰灰 · 未投喂」窄十来个像素，读起来一样。
      content = (feed.pending ? '🍚 ' : '✅ ') + (p.name || '猫咪') + '·' + feed.label
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
        // 尺寸整体紧一档（原来是 padding 8 / 字号 12 / 圆角 14 / 边框 2）：
        // 常显气泡在两点相邻时会互相覆盖，字号 11 + 内边距 5 约窄 25%，
        // 气泡高度也矮了 6px，上下相邻的两个才不容易叠在一起。
        padding: 5,
        borderRadius: 10,
        borderWidth: 1,
        borderColor,
        bgColor: '#FFFFFF',
        color,
        fontSize: 11,
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
    // 点 marker / 点定位都属于用户主动操作，镜头控制权暂时交回页面 ——
    // 不清这个标记的话，load() 与 scheduleReassert 会因为「用户拖过图」
    // 连 center 都不写，点谁都没反应。
    this._userPanned = false
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
        tagText: sightTagText(s),
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
    // 用户显式点了「回本校」，这里必须复位 panned 标记：
    // 否则 load/scheduleReassert 会因为「用户拖过图」直接跳过定位，点按钮毫无反应。
    this._userPanned = false
    // 先 setData 落定，再显式挪地图（属性绑定不保证重新定位）
    this.setData({ center, scale }, () => this.scheduleReassert(center, scale))
  },

  locateMe() {
    wx.getLocation({
      type: 'gcj02',
      success: res => {
        const my = { lat: res.latitude, lng: res.longitude }
        app.globalData.myLocation = my
        // 同理：定位是用户主动操作，镜头要让给他
        this._userPanned = false
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
