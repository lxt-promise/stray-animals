const app = getApp()
const { fromNow } = require('../../utils/util.js')

/**
 * 猫粮明细 —— 展示独立 points（流水）记录表
 * 与 users.points 余额缓存解耦，这里只读取本人的发放记录。
 */
Page({
  data: {
    list: [],
    balance: 0,
    loading: true
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  async load() {
    this.setData({ loading: true })
    try {
      await app.ensureReady()
      const [rows, summary] = await Promise.all([
        app.callApi('listPoints', { size: 50 }),
        app.callApi('pointsSummary', {})
      ])
      this.setData({
        balance: (summary && summary.points) || (app.globalData.user && app.globalData.user.points) || 0,
        list: (rows || []).map(r => Object.assign({}, r, {
          timeText: fromNow(r.createdAt),
          deltaText: '+' + r.delta
        })),
        loading: false
      })
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' })
    }
  }
})
