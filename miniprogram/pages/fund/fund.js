const app = getApp()
const { C, itemOf, requireMember, toast, money } = require('../../utils/util.js')

Page({
  data: {
    list: [],
    summary: { income: '0.00', expense: '0.00', balance: '0.00' },
    loading: true,
    showForm: false,
    typeIndex: 0,
    catIndex: 0,
    typeOptions: [
      { value: 'income', label: '收入' },
      { value: 'expense', label: '支出' }
    ],
    categories: C.FUND_CATEGORY,
    categoryIndex: 6,
    form: { type: 'income', category: 'other', amount: '', title: '', date: '' }
  },

  onLoad() {
    if (!requireMember(app)) return
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  async load() {
    this.setData({ loading: true })
    try {
      const res = await app.callApi('listFunds', {})
      const s = res.summary
      this.setData({
        list: res.list,
        summary: {
          income: s.income.toFixed(2),
          expense: s.expense.toFixed(2),
          balance: (s.income - s.expense).toFixed(2)
        },
        loading: false
      })
    } catch (e) {
      this.setData({ loading: false })
      toast(e.message)
    }
  },

  toggleForm() {
    this.setData({ showForm: !this.data.showForm })
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ ['form.' + key]: e.detail.value })
  },

  onTypePick(e) {
    const i = Number(e.detail.value)
    this.setData({ typeIndex: i, 'form.type': this.data.typeOptions[i].value })
  },

  onCategoryPick(e) {
    const i = Number(e.detail.value)
    this.setData({ categoryIndex: i, 'form.category': C.FUND_CATEGORY[i].value })
  },

  onDate(e) {
    this.setData({ 'form.date': e.detail.value })
  },

  async submit() {
    const f = this.data.form
    if (!Number(f.amount)) return toast('请填写金额')
    wx.showLoading({ title: '提交中' })
    try {
      await app.callApi('addFund', { data: f })
      this.setData({ showForm: false, form: { type: 'income', category: 'other', amount: '', title: '', date: '' } })
      wx.hideLoading()
      wx.showToast({ title: '已记录', icon: 'success' })
      this.load()
    } catch (e) {
      wx.hideLoading()
      toast(e.message)
    }
  }
})
