const app = getApp()
const { toast, showBusy, hideBusy, shareBehavior, formatTime } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')
const { CHOU_KIND } = require('../../utils/const.js')

/**
 * 咪咪筹详情
 *
 * 信息层级（参考水滴筹）：
 *   头图 → 标题/状态 → 进度 → 故事 → 猫咪与医院 → 材料公示 → 进展 → 支出 → 发起人
 * 底部固定操作条：捐助 / 分享；发起人本人看到「更新进展」。
 * 管理员额外看到审核、记进展、记支出、名单、结束。
 *
 * 材料与联系方式都由服务端做可见性过滤，前端不再二次判断（前端判断可被绕过）。
 */
Page(Object.assign({
  data: {
    id: '',
    campaign: null,
    materials: [],
    updates: [],
    expenses: [],
    recentDonors: [],
    donationCount: 0,
    isAdmin: false,
    isMine: false,
    loading: true,
    notFound: false,

    // 捐助
    showDonate: false,
    amount: '',
    donating: false,

    // 名单
    showDonors: false,
    donors: [],

    // 审核
    showReview: false,
    reviewNote: '',
    reviewing: false,

    // 举报
    showReport: false,
    reportReason: ''
  },

  onLoad(e) {
    const id = e.id || ''
    if (!id || id === 'undefined' || id === 'null') {
      this.setData({ loading: false, notFound: true })
      return
    }
    this.setData({ id, isAdmin: app.isAdmin() || app.isSuper() })
    this.load()
  },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()) },

  async load() {
    this.setData({ loading: true })
    try {
      const res = await app.callApi('getCampaign', { id: this.data.id })
      const c = res.campaign
      const raised = Number(c.raisedAmount) || 0
      const goal = Number(c.goalAmount) || 0
      const percent = goal > 0 ? Math.min(100, Math.round(raised / goal * 100)) : 0

      const ids = []
      const avatar = c.catAvatar ? photo.display(c.catAvatar, 600, ids) : ''
      const materials = (c.materials || []).map(m => Object.assign({}, m, {
        src: photo.display(m.fileID, 400, ids)
      }))

      let daysText = ''
      if (c.status === 'active') {
        if (c.daysLeft === null || c.daysLeft === undefined) daysText = '长期有效'
        else if (c.daysLeft <= 0) daysText = '今天截止'
        else daysText = '剩余 ' + c.daysLeft + ' 天'
      }

      const kindMeta = (CHOU_KIND || []).filter(k => k.value === c.kind)[0] || {}
      this.setData({
        campaign: Object.assign({}, c, {
          avatar,
          percent,
          daysText,
          kindIco: kindMeta.ico || '🏥',
          raisedText: raised.toFixed(2),
          goalText: goal.toFixed(2),
          expenseText: (Number(c.expenseTotal) || 0).toFixed(2),
          goalReached: raised >= goal && goal > 0,
          createdText: formatTime(c.createdAt)
        }),
        materials,
        expenses: (res.expenses || []).map(x => Object.assign({}, x, {
          dateText: formatTime(x.date),
          amountText: (Number(x.amount) || 0).toFixed(2),
          proofSrc: (x.proof || []).map(p => photo.display(p, 300, ids))
        })),
        updates: (c.updates || []).map(u => Object.assign({}, u, {
          createdAtText: formatTime(u.createdAt),
          imageSrc: (u.images || []).map(p => photo.display(p, 400, ids))
        })),
        recentDonors: (res.recentDonors || []).map(d => Object.assign({}, d, {
          amountText: (Number(d.amount) || 0).toFixed(2)
        })),
        donationCount: res.donationCount || 0,
        isAdmin: !!res.isAdmin,
        isMine: !!res.isMine,
        loading: false,
        notFound: false
      })

      if (ids.length) {
        photo.warm(ids).then(() => {
          // 临时链接就绪后把 cloud:// 换成 https，开发者工具下也能正常显示
          this.setData({
            'campaign.avatar': c.catAvatar ? photo.display(c.catAvatar, 600) : '',
            materials: (this.data.materials || []).map(m => Object.assign({}, m, {
              src: photo.display(m.fileID, 400)
            })),
            'expenses': this.data.expenses.map(x => Object.assign({}, x, {
              proofSrc: (x.proof || []).map(p => photo.display(p, 300)),
              _rawProof: x.proof
            }))
          })
        })
      }
    } catch (e) {
      this.setData({ loading: false, notFound: true })
      toast(e.message)
    }
  },

  /* ==================== 捐助 ==================== */

  openDonate() { this.setData({ showDonate: true, amount: '' }) },
  closeDonate() { if (!this.data.donating) this.setData({ showDonate: false }) },
  onAmount(e) { this.setData({ amount: e.detail.value }) },
  onQuick(e) { this.setData({ amount: e.currentTarget.dataset.v }) },
  noop() {},

  _loginCode() {
    return new Promise((resolve, reject) => {
      wx.login({
        success: r => r.code ? resolve(r.code) : reject(new Error('登录码获取失败')),
        fail: reject
      })
    })
  },
  _requestVirtualPayment(payData) {
    return new Promise((resolve, reject) => {
      wx.requestVirtualPayment({
        signData: payData.signData,
        paySig: payData.paySig,
        signature: payData.signature,
        mode: payData.mode,
        success: resolve,
        fail: err => reject(new Error((err && (err.errMsg || err.message)) || '支付已取消'))
      })
    })
  },

  async doDonate() {
    const amount = Number(this.data.amount)
    if (!amount || amount <= 0) { toast('请输入有效金额'); return }
    if (this.data.donating) return
    this.setData({ donating: true })
    showBusy('发起支付')
    try {
      const loginCode = await this._loginCode()
      const order = await app.callApi('donateToCampaign', {
        campaignId: this.data.id,
        amount,
        donorName: (app.globalData.user && app.globalData.user.nickName) || '爱心网友',
        loginCode
      })
      await this._requestVirtualPayment(order.payData)
      // 支付成功由微信推送异步入账；乐观提示并稍后刷新（期间可能尚未落账）
      hideBusy()
      this.setData({ donating: false, showDonate: false })
      toast('谢谢你的帮助！')
      setTimeout(() => this.load(), 2000)
    } catch (e) {
      hideBusy()
      this.setData({ donating: false })
      toast(e.message)
    }
  },

  /* ==================== 材料 / 图片 ==================== */

  previewMaterial(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    const urls = (this.data.materials || []).map(m => m.src || m.fileID).filter(Boolean)
    wx.previewImage({ urls, current: url })
  },

  previewProof(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.previewImage({ urls: [url], current: url })
  },

  previewUpdate(e) {
    const url = e.currentTarget.dataset.url
    if (url) wx.previewImage({ urls: [url], current: url })
  },

  /* ==================== 审核（管理员） ==================== */

  openReview() { this.setData({ showReview: true, reviewNote: '' }) },
  closeReview() { if (!this.data.reviewing) this.setData({ showReview: false }) },
  onReviewNote(e) { this.setData({ reviewNote: e.detail.value }) },

  async doReview(e) {
    const pass = e.currentTarget.dataset.pass === '1'
    if (!pass && !this.data.reviewNote.trim()) { toast('驳回请填写原因'); return }
    if (this.data.reviewing) return
    this.setData({ reviewing: true })
    try {
      await app.callApi('reviewCampaign', {
        id: this.data.id, approve: pass, note: this.data.reviewNote.trim()
      })
      this.setData({ reviewing: false, showReview: false })
      toast(pass ? '已通过' : '已驳回')
      this.load()
    } catch (err) {
      this.setData({ reviewing: false })
      toast(err.message)
    }
  },

  /* ==================== 结束 / 举报 ==================== */

  closeCampaign() {
    if (!this.data.isAdmin && !this.data.isMine) return
    wx.showModal({
      title: '结束筹款',
      content: '结束后不再接受捐助，已筹款项仍按公示使用。确定结束吗？',
      confirmColor: '#E0483C',
      success: async (r) => {
        if (!r.confirm) return
        try {
          await app.callApi('closeCampaign', { id: this.data.id, reason: '发起人/管理员结束' })
          toast('已结束')
          this.load()
        } catch (e) { toast(e.message) }
      }
    })
  },

  openReport() { this.setData({ showReport: true, reportReason: '' }) },
  closeReport() { this.setData({ showReport: false }) },
  onReportReason(e) { this.setData({ reportReason: e.detail.value }) },
  async doReport() {
    try {
      await app.callApi('reportCampaign', { id: this.data.id, reason: this.data.reportReason.trim() })
      this.setData({ showReport: false })
      toast('已提交，管理员会核实')
    } catch (e) { toast(e.message) }
  },

  /* ==================== 管理端 ==================== */

  goUpdate() { wx.navigateTo({ url: '/pages/campaign-edit/campaign-edit?mode=update&id=' + this.data.id }) },
  goExpense() { wx.navigateTo({ url: '/pages/campaign-edit/campaign-edit?mode=expense&id=' + this.data.id }) },
  goCat() {
    const catId = this.data.campaign && this.data.campaign.catId
    if (!catId) return
    wx.navigateTo({ url: '/pages/cat-detail/cat-detail?id=' + catId })
  },

  async loadDonors() {
    try {
      const res = await app.callApi('listCampaignDonations', { id: this.data.id })
      this.setData({
        showDonors: true,
        donors: (res.list || []).map(d => Object.assign({}, d, {
          amountText: (Number(d.amount) || 0).toFixed(2),
          dateText: formatTime(d.date)
        }))
      })
    } catch (e) { toast(e.message) }
  },
  closeDonors() { this.setData({ showDonors: false }) },

  onShareTap() {
    // 页面已开启分享；这里只是给个显式入口（部分机型右上角菜单不明显）
    wx.showToast({ title: '点右上角「···」分享给同学', icon: 'none' })
  },

  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/fund/fund' })
  }
}, shareBehavior({
  title: function () { return (this.data.campaign && this.data.campaign.title) || '帮校园里的猫咪一把' },
  path: function () { return '/pages/campaign-detail/campaign-detail?id=' + this.data.id }
})))
