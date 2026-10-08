const app = getApp()
const { C, toast } = require('../../utils/util.js')

Page({
  data: {
    tab: 'member',
    isMember: false,
    isAdmin: false,
    members: [],
    applies: [],
    loading: true,
    applyForm: { nickName: '', contact: '', reason: '', experience: '' },
    applied: false
  },

  onLoad(options) {
    if (options.tab === 'apply') this.setData({ tab: 'apply' })
    this.init()
  },

  onShow() {
    if (app.globalData.ready) this.init()
  },

  async init() {
    this.setData({ loading: true })
    try {
      await app.ensureReady()
      const isMember = app.isMember()
      const isAdmin = app.isAdmin()
      this.setData({ isMember, isAdmin })
      if (!isMember) {
        this.setData({ tab: 'apply', loading: false })
        return
      }
      if (this.data.tab === 'member') {
        const members = await app.callApi('listMembers', {})
        this.setData({ members, loading: false })
      } else {
        const applies = await app.callApi('listApplies', {})
        this.setData({ applies, loading: false })
      }
    } catch (e) {
      this.setData({ loading: false })
      toast(e.message)
    }
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.tab) return
    this.setData({ tab }, () => this.init())
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ ['applyForm.' + key]: e.detail.value })
  },

  async submitApply() {
    const f = this.data.applyForm
    if (!f.reason.trim()) return toast('请简单说明你的动机')
    wx.showLoading({ title: '提交中' })
    try {
      const res = await app.callApi('applyJoin', f)
      wx.hideLoading()
      if (res.status === 'already') return toast('你已是社团成员')
      this.setData({ applied: true })
      wx.showModal({
        title: '已提交',
        content: '社团管理员会尽快审核，通过后你将获得编辑权限。',
        showCancel: false
      })
    } catch (e) {
      wx.hideLoading()
      toast(e.message)
    }
  },

  async changeRole(e) {
    const { id } = e.currentTarget.dataset
    const member = this.data.members.filter(m => m._id === id)[0]
    if (!member) return
    const roles = C.ROLE
    wx.showActionSheet({
      itemList: roles.map(r => r.label),
      success: async res => {
        const role = roles[res.tapIndex].value
        wx.showLoading({ title: '处理中' })
        try {
          await app.callApi('setRole', { userId: id, role })
          wx.hideLoading()
          this.init()
        } catch (err) {
          wx.hideLoading()
          toast(err.message)
        }
      }
    })
  },

  async handleApply(e) {
    const { id, approve } = e.currentTarget.dataset
    wx.showLoading({ title: '处理中' })
    try {
      await app.callApi('handleApply', { id, approve: !!approve })
      wx.hideLoading()
      wx.showToast({ title: approve ? '已通过' : '已拒绝', icon: 'success' })
      this.init()
    } catch (err) {
      wx.hideLoading()
      toast(err.message)
    }
  }
})
