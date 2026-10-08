const app = getApp()
const { C, fromNow, itemOf } = require('../../utils/util.js')

Page({
  data: {
    tab: 'cat',          // cat | sighting
    keyword: '',
    filters: {
      status: '',
      sterilized: '',
      pattern: ''
    },
    statusOptions: C.CAT_STATUS,
    sterOptions: C.STERILIZED,
    patternOptions: C.PATTERN,
    list: [],
    sightings: [],
    loading: true,
    hasMore: false,
    page: 1,
    isMember: false
  },

  onLoad(options) {
    if (options.tab === 'sighting') this.setData({ tab: 'sighting' })
    this.reload()
  },

  onShow() {
    if (this.data.list.length || this.data.sightings.length) this.reload()
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadMore()
  },

  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh())
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.tab) return
    this.setData({ tab }, () => this.reload())
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value }, () => this.reload())
  },

  onFilter(e) {
    const { key, value } = e.currentTarget.dataset
    const filters = Object.assign({}, this.data.filters)
    filters[key] = filters[key] === value ? '' : value
    this.setData({ filters }, () => this.reload())
  },

  async reload() {
    this.setData({ loading: true, page: 1, list: [], sightings: [] })
    await app.ensureReady()
    this.setData({ isMember: app.isMember() })
    await this.fetch(1)
  },

  async loadMore() {
    await this.fetch(this.data.page + 1)
  },

  async fetch(page) {
    try {
      if (this.data.tab === 'cat') {
        const res = await app.callApi('listCats', Object.assign({
          page, size: 20, keyword: this.data.keyword
        }, this.data.filters))
        this.setData({
          list: page === 1 ? res.list : this.data.list.concat(res.list),
          hasMore: res.hasMore,
          page,
          loading: false
        })
      } else {
        const res = await app.callApi('listSightings', { page, size: 20 })
        const list = res.list.map(s => Object.assign({}, s, { timeText: fromNow(s.createdAt) }))
        this.setData({
          sightings: page === 1 ? list : this.data.sightings.concat(list),
          hasMore: res.hasMore,
          page,
          loading: false
        })
      }
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: e.message || '加载失败', icon: 'none' })
    }
  },

  goDetail(e) {
    const id = e.detail.id || e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/cat-detail/cat-detail?id=' + id })
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/cat-edit/cat-edit' })
  },

  goSighting() {
    wx.navigateTo({ url: '/pages/sighting-post/sighting-post' })
  },

  previewPhoto(e) {
    const { url, urls } = e.currentTarget.dataset
    wx.previewImage({ current: url, urls })
  }
})
