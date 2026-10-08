const app = getApp()

Page({
  data: {
    loading: true,
    isMember: false,
    isAdmin: false,
    user: null,
    stats: {
      pendingSighting: 0,
      todoTnr: 0,
      openTask: 0,
      balance: 0
    }
  },

  onLoad() {
    this.load()
  },

  onShow() {
    if (app.globalData.ready) this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  async load() {
    this.setData({ loading: true })
    try {
      await app.ensureReady()
      const isMember = app.isMember()
      const isAdmin = app.isAdmin()
      this.setData({ isMember, isAdmin, user: app.globalData.user })
      if (!isMember) {
        this.setData({ loading: false })
        return
      }
      const [pending, tnr, tasks, funds] = await Promise.all([
        app.callApi('listSightings', { pending: true, size: 50 }),
        app.callApi('listTnr', {}),
        app.callApi('listTasks', {}),
        app.callApi('listFunds', {})
      ])
      this.setData({
        stats: {
          pendingSighting: pending.list.length,
          todoTnr: tnr.filter(t => t.status === 'todo' || t.status === 'trapping').length,
          openTask: tasks.filter(t => t.status === 'open').length,
          balance: (funds.summary.income - funds.summary.expense).toFixed(2)
        },
        loading: false
      })
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: e.message || '加载失败', icon: 'none' })
    }
  },

  go(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url })
  },

  goApply() {
    wx.navigateTo({ url: '/pages/member/member?tab=apply' })
  }
})
