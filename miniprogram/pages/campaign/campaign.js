const app = getApp()
const { toast, shareBehavior } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')

/**
 * 咪咪筹列表
 * tab: active 进行中 / done 已结束 / mine 我发起的 / review 待审核（仅管理员）
 * 服务端 public 口径一次下发本校全部「已通过」筹款，前端按状态分 tab，
 * 避免切 tab 反复请求；mine / review 是不同查询，单独拉一次后缓存。
 */
Page(Object.assign({
  data: {
    tab: 'active',
    list: [],
    loading: true,
    isAdmin: false,
    isEmpty: false,
    emptyText: '本校暂无进行中的筹款'
  },

  onLoad(e) {
    const tab = (e && e.tab) || 'active'
    this.setData({
      isAdmin: app.isAdmin() || app.isSuper(),
      // 后台「咪咪筹审核」直接跳到这里并定位到待审 tab；
      // 非管理员即便带了 tab=review 也没关系，服务端会 403。
      tab: (tab === 'review' && (app.isAdmin() || app.isSuper())) ? 'review' : (tab === 'mine' ? 'mine' : 'active')
    })
    this._cache = {}
  },
  onShow() {
    // 从详情/发起页返回要看到最新金额，缓存一律作废
    this._cache = {}
    this.load()
  },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()) },

  onTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.tab) return
    this.setData({ tab })
    this.load()
  },

  async load() {
    const tab = this.data.tab
    this.setData({ loading: true })
    try {
      let rows
      if (tab === 'mine') {
        if (!this._cache.mine) {
          const res = await app.callApi('listCampaigns', { scope: 'mine' })
          this._cache.mine = res.list || []
        }
        rows = this._cache.mine
      } else if (tab === 'review') {
        if (!this._cache.review) {
          const res = await app.callApi('listCampaigns', { scope: 'review' })
          this._cache.review = res.list || []
        }
        rows = this._cache.review
      } else {
        if (!this._cache.pub) {
          const res = await app.callApi('listCampaigns', {})
          this._cache.pub = res.list || []
        }
        rows = this._cache.pub.filter(c => tab === 'active'
          ? c.status === 'active'
          : c.status !== 'active')
      }

      const ids = []
      const list = rows.map(c => this.decorate(c, ids))
      this.setData({
        list,
        loading: false,
        isEmpty: !list.length,
        emptyText: this.emptyTextOf(tab)
      })
      if (ids.length) {
        photo.warm(ids).then(() => {
          this.setData({
            list: this.data.list.map(c => Object.assign({}, c, {
              avatar: c.catAvatar ? photo.display(c.catAvatar, 200) : ''
            }))
          })
        })
      }
    } catch (e) {
      this.setData({ loading: false, list: [], isEmpty: true, emptyText: e.message || '加载失败' })
      toast(e.message)
    }
  },

  emptyTextOf(tab) {
    if (tab === 'mine') return '你还没有发起过筹款'
    if (tab === 'review') return '没有待审核的筹款'
    if (tab === 'done') return '还没有已结束的筹款'
    return '本校暂无进行中的筹款'
  },

  decorate(c, ids) {
    const raised = Number(c.raisedAmount) || 0
    const goal = Number(c.goalAmount) || 0
    const percent = goal > 0 ? Math.min(100, Math.round(raised / goal * 100)) : 0
    const avatar = c.catAvatar ? photo.display(c.catAvatar, 200, ids) : ''
    let daysText = ''
    if (c.status === 'active') {
      if (c.daysLeft === null || c.daysLeft === undefined) daysText = '不限期'
      else if (c.daysLeft <= 0) daysText = '今天截止'
      else daysText = '剩 ' + c.daysLeft + ' 天'
    }
    return Object.assign({}, c, {
      avatar,
      percent,
      daysText,
      raisedText: raised.toFixed(2),
      goalText: goal.toFixed(2),
      statusText: c.status === 'active' ? '进行中'
        : (c.status === 'fulfilled' ? '已完成' : '已结束'),
      reviewText: c.reviewStatus === 'pending' ? '审核中'
        : (c.reviewStatus === 'rejected' ? '未通过' : '')
    })
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id
    // 组件事件曾出现 id 为空导致白页，这里守一道
    if (!id || id === 'undefined' || id === 'null') return
    wx.navigateTo({ url: '/pages/campaign-detail/campaign-detail?id=' + id })
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/campaign-edit/campaign-edit' })
  }
}, shareBehavior({ title: '咪咪筹 · 帮校园里的猫咪一把', path: '/pages/campaign/campaign' })))
