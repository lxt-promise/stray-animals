const app = getApp()
const { C, fromNow, shareBehavior } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')

Page(Object.assign({
  data: {
    loading: true,
    overview: null,
    school: null,
    user: null,
    isMember: false
  },

  onLoad() {
    this.load()
  },

  onShow() {
    // 自定义 tabBar 选中态兜底：部分基础库上组件的 pageLifetimes.show
    // 在 switchTab 时不触发或早于路由更新，导致高亮停在旧 tab。
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().refresh()
    // 打卡/编辑返回后刷新 —— 走**后台刷新**：旧数据先留着，拿到新的再静默替换，
    // 不再整页进 loading 态（原来每次切回首页都白一下，体感很慢）。
    if (this.data.overview) this.refreshInBackground()
  },

  onPullDownRefresh() {
    // 下拉是用户主动要最新数据，强制走一次完整请求
    this.setData({ overview: null })
    this.load(true).then(() => wx.stopPullDownRefresh())
  },

  /** 把概览灌进 data；recent 的相对时间在这里统一算好（WXML 不支持方法调用） */
  applyOverview(ov) {
    if (!ov) return
    const data = Object.assign({}, ov)
    const recent = (data.recent || []).map(s =>
      Object.assign({}, s, { createdAtText: fromNow(s.createdAt) })
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

  async load(silent) {
    // 冷启动时启动流程（homeInit）已经把概览带回来了 —— 这种情况不该显示骨架，
    // 否则「上半部分秒出、统计卡转圈」正是用户抱怨的那个观感。
    const hasCache = !!app.globalData.homeOverview
    if (!silent && !hasCache) this.setData({ loading: true })
    try {
      await app.ensureReady()
      this.setData({
        user: app.globalData.user,
        school: app.globalData.school,
        isMember: app.isMember()
      })

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

  goCat(e) {
    wx.navigateTo({ url: '/pages/cat-detail/cat-detail?id=' + e.currentTarget.dataset.id })
  },

  // 注意：cats / mine 都是 tabBar 页面，必须用 switchTab；
  // 用 navigateTo 会被微信静默拒绝（can not navigateTo a tabbar page），表现为「点了没反应」。
  // 「最新动态」要带 tab=sighting，switchTab 不支持 query，
  // 故先写入全局，由 cats 页在 onShow 时读取并切到「目击」tab。
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
