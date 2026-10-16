const app = getApp()
const { C, itemOf, requireMember, toast, showBusy, hideBusy, shareBehavior } = require('../../utils/util.js')

Page(Object.assign({
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
    showBusy({ title: '发布中' })
    try {
      await app.callApi('saveTask', { data: f })
      this.setData({ showForm: false, form: { title: '', type: 'feed', date: '', spot: '', note: '', contact: '' } })
      hideBusy()
      wx.showToast({ title: '已发布', icon: 'success' })
      this.load()
    } catch (e) {
      hideBusy()
      toast(e.message)
    }
  },

  async claim(e) {
    const { id, cancel } = e.currentTarget.dataset
    showBusy({ title: '处理中' })
    try {
      await app.callApi('claimTask', { id, cancel: !!cancel })
      hideBusy()
      this.load()
    } catch (err) {
      hideBusy()
      toast(err.message)
    }
  },

  async markDone(e) {
    const { id } = e.currentTarget.dataset
    const task = (this.data.allList || []).filter(t => t._id === id)[0]
    if (!task) return
    showBusy({ title: '处理中' })
    try {
      await app.callApi('saveTask', {
        data: Object.assign({}, task, { status: 'done' })
      })
      hideBusy()
      this.load()
    } catch (err) {
      hideBusy()
      toast(err.message)
    }
  }
// ↓ 任务页是**招募**入口：分享目标是「喊人来认领任务」，落地页回任务页。
}, shareBehavior(function () {
  const open = (this.data.list || []).filter(t => t.status === 'open').length
  return {
    title: open ? ('喵园有 ' + open + ' 个任务等人认领 🐾') : '喵园 · 校园猫互助任务',
    path: '/pages/task/task'
  }
})))
