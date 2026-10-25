const app = getApp()
const { C, fromNow, shareBehavior, sightTagText } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')

// 顶部标题栏的品牌兜底：未绑定学校时显示「喵园」，**不**显示任何校名占位。
const BRAND = '喵园'
const BRAND_SUB = '校园流浪猫守护计划'

Page(Object.assign({
  data: {
    loading: true,
    overview: null,
    school: null,
    user: null,
    isMember: false,
    // 首屏渲染前（JS 还没跑）也得有个像样的标题，别先空一下再跳出来
    schoolTitle: BRAND,
    schoolSub: BRAND_SUB
  },

  onLoad() {
    // 先同步一次标题：load() 里要 await 登录/概览，等它回来才设校名的话，
    // 已绑定学校的用户会先看到一眼品牌名「喵园」再跳成校名（闪一下）。
    // 这里只读 globalData，不发请求；load() 拿到新数据后会再同步一次。
    this.syncIdentity()
    this.load()
  },

  onShow() {
    // 自定义 tabBar 选中态兜底：部分基础库上组件的 pageLifetimes.show
    // 在 switchTab 时不触发或早于路由更新，导致高亮停在旧 tab。
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().refresh()

    // 先把全局身份（user / school）同步进来：学校可能在「我的」页刚被绑定或切换。
    const r = this.syncIdentity()
    if (r.first) return   // 首屏由 onLoad 的 load() 负责，别重复发请求

    if (r.changed) {
      // 换校 / 解绑：上一所学校的统计不能留着（数字会张冠李戴），
      // 旧概览缓存一并作废，整页重新拉一次。
      app.globalData.homeOverview = null
      this.setData({ overview: null, loading: true })
      this.load(true, true)
      return
    }
    // 同校：走**后台刷新**，旧数据先留着，拿到新的再静默替换，
    // 不再整页进 loading 态（原来每次切回首页都白一下，体感很慢）。
    if (this.data.overview) this.refreshInBackground()
  },

  onPullDownRefresh() {
    // 下拉是用户主动要最新数据：必须**绕过** globalData.homeOverview 缓存。
    // 原来只把 data.overview 清空，而 load() 仍读缓存 → 下拉刷新其实什么都没刷。
    this.setData({ overview: null })
    this.load(true, true).then(() => wx.stopPullDownRefresh())
  },

  /**
   * 把全局身份同步到页面，并判断「学校是否变了」。
   *
   * 校名与统计都跟着 `user.schoolId` 走：在「我的」页绑定/切换学校后回到首页
   * 必须立刻反映。原来 school 只在 onLoad 读一次、onShow 只刷概览，于是首页
   * 一直顶着旧校名，统计也还是上一所学校的数字。
   *
   * 返回 { first, changed }：
   *   first   —— 首屏还没跑完（_schoolId 未记录），交给 load() 处理
   *   changed —— 学校 id 变了（含未绑定 ↔ 已绑定）
   */
  syncIdentity() {
    const prevId = this._schoolId            // undefined = 首屏尚未落定
    const school = app.globalData.school || null
    this.setData({
      school,
      user: app.globalData.user || null,
      isMember: app.isMember(),
      // 顶部标题：绑定学校 → 校名；未绑定 → 品牌名「喵园」。
      // 副标题：有校区 → 校区；未绑定 → 品牌副标题；已绑定但没填校区 → 不显示
      //（留空比编一个校区安全，`wx:if="{{schoolSub}}"` 会把整行收起来）。
      schoolTitle: (school && school.name) || BRAND,
      schoolSub: (school && school.campus) || (school ? '' : BRAND_SUB)
    })
    this._schoolId = (school && school._id) || ''
    return { first: prevId === undefined, changed: prevId !== undefined && prevId !== this._schoolId }
  },

  /** 把概览灌进 data；recent 的相对时间在这里统一算好（WXML 不支持方法调用） */
  applyOverview(ov) {
    if (!ov) return
    const data = Object.assign({}, ov)
    const recent = (data.recent || []).map(s =>
      Object.assign({}, s, {
        createdAtText: fromNow(s.createdAt),
        tagText: sightTagText(s)   // 结构化标签文案（替代原自由文本 note）
      })
    )
    // 目击缩略图走 photo.js：原图几 MB 太慢，且 cloud:// 在开发者工具里
    // 会被当成相对路径交给本地 pageframe 加载而报错。预取完成后自动升级为 https 缩略。
    const token = (this._ovToken = (this._ovToken || 0) + 1)
    data.recent = photo.hydrateCats(recent, { photoPx: 240 }, view => {
      if (this._ovToken === token) this.setData({ 'overview.recent': view })
    })
    this.setData({ overview: data, loading: false })
  },

  /** 最新目击缩略图加载失败：去参数重试 → 换临时链接 → 隐藏（不触发整页重载） */
  async onPhotoErr(e) {
    const i = Number((e.currentTarget.dataset || {}).i || 0)
    const key = 'overview.recent[' + i + '].photosSmall[0]'
    const item = (this.data.overview && this.data.overview.recent || [])[i]
    const url = (item && item.photosSmall || [])[0]
    if (!url) return
    if (photo.hasProcess(url)) { this.setData({ [key]: photo.stripProcess(url) }); return }
    const rid = ((item && item.photos) || [])[0]
    if (photo.isFileId(rid)) {
      const u = await photo.resolve(rid)
      if (u) { this.setData({ [key]: photo.thumb(u, 240) }); return }
    }
    this.setData({ [key]: '' })
  },

  async load(silent, force) {
    // 冷启动时启动流程（homeInit）已经把概览带回来了 —— 这种情况不该显示骨架，
    // 否则「上半部分秒出、统计卡转圈」正是用户抱怨的那个观感。
    // force=true（下拉刷新 / 换校）时必须忽略这份缓存，否则等于没刷新。
    const hasCache = !force && !!app.globalData.homeOverview
    if (!silent && !hasCache) this.setData({ loading: true })
    try {
      await app.ensureReady()
      // 兜底自愈：user.schoolId 有值但 school 对象丢了（换校时 refreshUser 会把
      // 旧对象清掉，页面若没接着拉就会一直显示「未绑定」）→ 补一次 getSchool。
      const u = app.globalData.user
      if (u && u.schoolId && !app.globalData.school) {
        try {
          const fresh = await app.callApi('getSchool', { schoolId: u.schoolId })
          if (fresh) app.setSchool(fresh)
        } catch (e) {
          console.warn('[index] 学校信息补拉失败，按未绑定展示', e && e.message)
        }
      }
      // 学校以全局为准（可能刚在「我的」页绑定/切换）；syncIdentity 会记下
      // 本页当前渲染的学校 id，onShow 靠它判断要不要重拉。
      this.syncIdentity()

      if (hasCache) {
        // 启动数据直接用：首页因此**零额外请求**就能出统计
        this.applyOverview(app.globalData.homeOverview)
        return
      }
      // 启动时没拿到（旧版云函数回落路径 / 概览拉取失败）→ 自己补一次
      const ov = await app.callApi('getOverview', {})
      app.globalData.homeOverview = ov
      this.applyOverview(ov)
    } catch (e) {
      console.error(e)
      if (!silent) wx.showToast({ title: e.message || '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  /** 后台刷新：不打扰当前界面，失败就保留上一次的数据 */
  async refreshInBackground() {
    if (this._refreshing) return
    this._refreshing = true
    try {
      const ov = await app.callApi('getOverview', {})
      // 顺手更新全局缓存：下次冷启动/切回首页都能直接消费
      app.globalData.homeOverview = ov
      this.applyOverview(ov)
    } catch (e) {
      // 静默：界面上已经有数据了，刷不到只是稍旧一点，不该弹错
      console.warn('[index] 后台刷新失败，保留上一次数据', e && e.message)
    } finally {
      this._refreshing = false
    }
  },

  goRecognize(e) {
    const mode = e.currentTarget.dataset.mode || 'image'
    wx.navigateTo({ url: '/pages/recognize/recognize?mode=' + mode })
  },

  goSighting() {
    wx.navigateTo({ url: '/pages/sighting-post/sighting-post' })
  },

  /** 统计卡拉到「猫谱」：catCount / 绝育率点击后都是去看本校的猫档案 */
  goCats() {
    wx.switchTab({ url: '/pages/cats/cats' })
  },

  goCat(e) {
    wx.navigateTo({ url: '/pages/cat-detail/cat-detail?id=' + e.currentTarget.dataset.id })
  },

  // 注意：cats / mine 都是 tabBar 页面，必须用 switchTab；
  // 用 navigateTo 会被微信静默拒绝（can not navigateTo a tabbar page），表现为「点了没反应」。
  // 「打卡记录」要带 tab=sighting，switchTab 不支持 query，
  // 故先写入全局，由 cats 页在 onShow 时读取并切到「打卡记录」tab。
  goSightingList() {
    app.globalData.catsTab = 'sighting'
    wx.switchTab({ url: '/pages/cats/cats' })
  },

  goCreateSchool() {
    wx.switchTab({ url: '/pages/mine/mine' })
  },

  formatTime(t) {
    return fromNow(t)
  }
// ↓ mpaas share mixin：没有 onShareAppMessage 时右上角「转发」是不可点的
}, shareBehavior({
  title: () => {
    const s = app.globalData.school
    return s && s.name ? (s.name + '的校园猫 · 喵园') : '喵园 · 校园流浪猫档案'
  },
  path: '/pages/index/index'
})))
