const app = getApp()
const { C, fromNow } = require('../../utils/util.js')

Page({
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
    // 打卡/编辑返回后刷新
    if (this.data.overview) this.load(true)
  },

  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh())
  },

  async load(silent) {
    if (!silent) this.setData({ loading: true })
    try {
      await app.ensureReady()
      const user = app.globalData.user
      const overview = await app.callApi('getOverview', {})
      overview.recent = (overview.recent || []).map(s =>
        Object.assign({}, s, { createdAtText: fromNow(s.createdAt) })
      )
      this.setData({
        overview,
        user,
        school: app.globalData.school,
        isMember: app.isMember()
      })
    } catch (e) {
      console.error(e)
      if (!silent) wx.showToast({ title: e.message || '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
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
})
