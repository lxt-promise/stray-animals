const app = getApp()
const { C, requireMember, itemOf, toast, shareBehavior } = require('../../utils/util.js')

const STATUS_FILTERS = [
  { value: '', label: '全部' },
  { value: 'todo', label: '待抓捕' },
  { value: 'trapping', label: '诱捕中' },
  { value: 'surgery', label: '手术/住院' },
  { value: 'released', label: '已放归' },
  { value: 'adopted', label: '转领养' }
]

Page(Object.assign({
  data: {
    list: [],
    filter: '',
    filters: STATUS_FILTERS,
    loading: true,
    isMember: false,
    summary: { total: 0, done: 0, cost: 0 }
  },

  onLoad() {
    if (!requireMember(app)) return
    this.setData({ isMember: true })
    this.load()
  },

  onShow() {
    if (this.data.isMember && this.data.list.length) this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  async load() {
    this.setData({ loading: true })
    try {
      const res = await app.callApi('listTnr', {})
      // 云函数 listTnr 返回 { list, flow }，不是数组
      const list = (res.list || []).map(t => Object.assign({}, t, {
        statusItem: itemOf(C.TNR_STATUS, t.status)
      }))
      const done = list.filter(t => t.status === 'released' || t.status === 'adopted').length
      const cost = list.reduce((a, b) => a + (Number(b.cost) || 0), 0)
      const filtered = this.data.filter ? list.filter(t => t.status === this.data.filter) : list
      this.setData({
        list: filtered,
        allList: list,
        summary: { total: list.length, done, cost: cost.toFixed(0) },
        loading: false
      })
    } catch (e) {
      this.setData({ loading: false })
      toast(e.message)
    }
  },

  onFilter(e) {
    const v = e.currentTarget.dataset.value
    const all = this.data.allList || []
    this.setData({
      filter: v,
      list: v ? all.filter(t => t.status === v) : all
    })
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/tnr-edit/tnr-edit' })
  },

  goEdit(e) {
    wx.navigateTo({ url: '/pages/tnr-edit/tnr-edit?id=' + e.currentTarget.dataset.id })
  }
// ↓ TNR 记录是公益成果展示（绝育了多少只），适合对外传播。
}, shareBehavior(function () {
  const s = this.data.summary || {}
  const done = Number(s.done) || 0
  const s0 = app.globalData.school
  const who = s0 && s0.name ? s0.name : '校园'
  return {
    title: done ? (who + '已为 ' + done + ' 只猫完成 TNR 🏥') : (who + '流浪猫 TNR 记录 · 喵园'),
    path: '/pages/tnr/tnr'
  }
})))
