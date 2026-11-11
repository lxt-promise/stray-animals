const app = getApp()

/**
 * 工作台（管理员 + 超级管理员可见）。
 *
 * 这是管理侧的「首页」：把原本散落在「我的」页里的管理卡片抽出来单独成页，
 * 并分板块组织（数据概览 / 快捷入口）。两类人都能进：
 *  - 管理员：本校区日常运营（成员、募捐、TNR、排班…）；
 *  - 超级管理员：在管理员的基础上，多一个「超级管理员后台」入口，
 *    那是**只给超管**的深度配置页（校园编辑、全站用户、识别与特征库、样本库、重复档案…）。
 *
 * 超级管理员后台（pages/admin）保持超管专属，且已改为手风琴分板块，不再是一长条。
 */
Page({
  data: {
    isAdmin: false,
    isSuper: false,
    loading: true,
    noticeUnread: 0,
    wb: { pendingSighting: 0, todoTnr: 0, openTask: 0, pendingApply: 0, balance: '0.00' },
    // 快捷入口：全员可见；超管额外多一个「超级管理员后台」
    entries: []
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().refresh()
    this.init()
  },

  async init() {
    this.setData({ loading: true })
    try {
      await app.ensureReady()
      const u = app.globalData.user || {}
      const isSuper = !!u.isSuper
      const isAdmin = app.isAdmin() || isSuper
      this.setData({ isSuper, isAdmin })
      this.buildEntries()
      await this.loadOverview()
      if (isSuper) await this.loadNotices()
    } catch (e) {
      console.error(e)
    } finally {
      this.setData({ loading: false })
    }
  },

  /** 按角色组装快捷入口（全员 + 超管专属） */
  buildEntries() {
    const E = [
      { ico: '🐱', txt: '新建猫档案', desc: '手动录入 · 建档', url: '/pages/cat-edit/cat-edit' },
      { ico: '✂️', txt: 'TNR 台账', desc: '抓捕 / 绝育 / 放归', url: '/pages/tnr/tnr' },
      { ico: '📅', txt: '喂猫排班', desc: '任务发布与认领', url: '/pages/task/task' },
      { ico: '💰', txt: '资金公示', desc: '收支公开透明', url: '/pages/fund/fund' },
      { ico: '🐾', txt: '咪咪筹', desc: '筹款审核 · 进展', url: '/pages/campaign/campaign' },
      { ico: '👥', txt: '成员管理', desc: '角色与入社审核', url: '/pages/member/member' },
      { ico: '📷', txt: '目击建档', desc: '认领 / 建档', tab: 'cats' }
    ]
    if (this.data.isSuper) {
      E.push({
        ico: '🛠️', txt: '超级管理员后台', desc: '校园/用户/识别深度配置',
        url: '/pages/admin/admin', super: true
      })
    }
    this.setData({ entries: E })
  },

  /** 概览：待建档 / 待抓捕 / 待认领 / 待审申请 / 资金结余 */
  async loadOverview() {
    try {
      const [pending, tnr, tasks, funds, applies] = await Promise.all([
        app.callApi('listSightings', { pending: true, size: 1 }).catch(() => ({ list: [] })),
        app.callApi('listTnr', {}).catch(() => ({ list: [] })),
        app.callApi('listTasks', {}).catch(() => []),
        app.callApi('listFunds', {}).catch(() => null),
        app.callApi('listSchoolApplies', { status: 'pending' }).catch(() => [])
      ])
      const bal = (funds && funds.summary)
        ? ((funds.summary.income - funds.summary.expense) || 0).toFixed(2)
        : '0.00'
      this.setData({
        wb: {
          pendingSighting: (pending.list || []).length,
          todoTnr: ((tnr && tnr.list) || [])
            .filter(t => t.status === 'todo' || t.status === 'trapping').length,
          openTask: (tasks || []).filter(t => t.status === 'open').length,
          pendingApply: (applies || []).length,
          balance: bal
        }
      })
    } catch (e) {
      console.warn('[workbench] 概览加载失败', e)
    }
  },

  async loadNotices() {
    try {
      const r = await app.callApi('listNotices', { size: 20 })
      this.setData({ noticeUnread: Number(r.unread) || 0 })
    } catch (e) { /* 增强项，失败不影响主体 */ }
  },

  /** 快捷入口跳转（支持 tabBar 页与 tab 参数） */
  goEntry(e) {
    const ds = e.currentTarget.dataset
    if (ds.tab === 'cats') { this.goCatsSighting(); return }
    this.go({ currentTarget: { dataset: { url: ds.url } } })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    const TAB = ['/pages/index/index', '/pages/cats/cats', '/pages/map/map', '/pages/mine/mine']
    if (TAB.indexOf(url) >= 0) { wx.switchTab({ url }); return }
    wx.navigateTo({ url })
  },

  goCatsSighting() {
    app.globalData.catsTab = 'sighting'
    wx.switchTab({ url: '/pages/cats/cats' })
  },

  /** 开启申请通知（一次性订阅，超管专属） */
  async enableApplyNotify() {
    let tmplId = ''
    try {
      const cfg = await app.callApi('notifyConfig', {})
      tmplId = (cfg && cfg.templateId) || ''
    } catch (e) { tmplId = '' }
    if (!tmplId) { wx.showToast({ title: '服务端未配置消息模板', icon: 'none' }); return }
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success: res => {
        const st = res && res[tmplId]
        if (st === 'accept') wx.showToast({ title: '已开启，有申请将通知你', icon: 'none' })
        else wx.showToast({ title: '未授权，收不到通知', icon: 'none' })
      },
      fail: () => wx.showToast({ title: '授权未完成', icon: 'none' })
    })
  }
})
