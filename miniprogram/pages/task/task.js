const app = getApp()
const { C, itemOf, requireMember, toast } = require('../../utils/util.js')

Page({
  data: {
    list: [],
    filter: 'open',
    isMember: false,
    loading: true,
    showForm: false,
    typeIndex: 0,
    typeOptions: C.TASK_TYPE,
    form: { title: '', type: 'feed', date: '', spot: '', note: '', contact: '' }
  },

  onLoad() {
    this.setData({ isMember: app.isMember() })
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
      const res = await app.callApi('listTasks', {})
      const list = res.map(t => Object.assign({}, t, {
        statusItem: itemOf(C.TASK_STATUS, t.status),
        typeLabel: itemOf(C.TASK_TYPE, t.type).label
      }))
      const filtered = this.data.filter ? list.filter(t => t.status === this.data.filter) : list
      this.setData({ list: filtered, allList: list, loading: false })
    } catch (e) {
      this.setData({ loading: false })
      toast(e.message)
    }
  },

  onFilter(e) {
    const v = e.currentTarget.dataset.value
    const all = this.data.allList || []
    this.setData({ filter: v, list: v ? all.filter(t => t.status === v) : all })
  },

  toggleForm() {
    if (!this.data.isMember) {
      return wx.showToast({ title: '仅社团成员可发布任务', icon: 'none' })
    }
    this.setData({ showForm: !this.data.showForm })
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ ['form.' + key]: e.detail.value })
  },

  onTypePick(e) {
    const i = Number(e.detail.value)
    this.setData({ typeIndex: i, 'form.type': C.TASK_TYPE[i].value })
  },

  onDate(e) {
    this.setData({ 'form.date': e.detail.value })
  },

  async submit() {
    const f = this.data.form
    if (!f.title.trim()) return toast('请填写任务标题')
    wx.showLoading({ title: '发布中' })
    try {
      await app.callApi('saveTask', { data: f })
      this.setData({ showForm: false, form: { title: '', type: 'feed', date: '', spot: '', note: '', contact: '' } })
      wx.hideLoading()
      wx.showToast({ title: '已发布', icon: 'success' })
      this.load()
    } catch (e) {
      wx.hideLoading()
      toast(e.message)
    }
  },

  async claim(e) {
    const { id, cancel } = e.currentTarget.dataset
    wx.showLoading({ title: '处理中' })
    try {
      await app.callApi('claimTask', { id, cancel: !!cancel })
      wx.hideLoading()
      this.load()
    } catch (err) {
      wx.hideLoading()
      toast(err.message)
    }
  },

  async markDone(e) {
    const { id } = e.currentTarget.dataset
    const task = (this.data.allList || []).filter(t => t._id === id)[0]
    if (!task) return
    wx.showLoading({ title: '处理中' })
    try {
      await app.callApi('saveTask', {
        data: Object.assign({}, task, { status: 'done' })
      })
      wx.hideLoading()
      this.load()
    } catch (err) {
      wx.hideLoading()
      toast(err.message)
    }
  }
})
