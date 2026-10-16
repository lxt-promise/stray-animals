const app = getApp()
const { C, toast, showBusy, hideBusy, shareBehavior } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')

Page(Object.assign({
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
        // 成员头像都是别人上传的私有文件，cloud:// 直接进 <image> 解析不出来
        //（开发者工具会报 pageframe 加载失败），统一先换 https 再渲染
        const view = await photo.hydrateCatsAsync(
          members.map(m => Object.assign({}, m, { avatar: m.avatarUrl || '' })), { px: 120 })
        this.setData({ members: view, loading: false })
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
    showBusy({ title: '提交中' })
    try {
      const res = await app.callApi('applyJoin', f)
      hideBusy()
      if (res.status === 'already') return toast('你已是社团成员')
      this.setData({ applied: true })
      wx.showModal({
        title: '已提交',
        content: '社团管理员会尽快审核，通过后你将获得编辑权限。',
        showCancel: false
      })
    } catch (e) {
      hideBusy()
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
        showBusy({ title: '处理中' })
        try {
          await app.callApi('setRole', { userId: id, role })
          hideBusy()
          this.init()
        } catch (err) {
          hideBusy()
          toast(err.message)
        }
      }
    })
  },

  async handleApply(e) {
    const { id, approve } = e.currentTarget.dataset
    showBusy({ title: '处理中' })
    try {
      await app.callApi('handleApply', { id, approve: !!approve })
      hideBusy()
      wx.showToast({ title: approve ? '已通过' : '已拒绝', icon: 'success' })
      this.init()
    } catch (err) {
      hideBusy()
      toast(err.message)
    }
  }
// ↓ 成员/志愿者页：招人向分享。带上学名更有本地归属感，落地页回落首页。
}, shareBehavior(function () {
  const s = app.globalData.school
  const who = s && s.name ? s.name : '校园'
  const n = (this.data.members || []).length
  return {
    title: n ? (who + '已有 ' + n + ' 位铲屎官加入 · 喵园') : ('加入喵园，一起照顾' + who + '的流浪猫'),
    path: '/pages/index/index'
  }
})))
