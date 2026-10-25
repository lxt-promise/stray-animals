const app = getApp()
const { C, fromNow, itemOf, isAdminPlus, shareBehavior, sightTagText } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')

Page(Object.assign({
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
    // 未绑定学校：猫档案按校运营，没学校就什么都看不到（云端已不再返回全环境档案）
    needSchool: false,
    // 空结果时的筛选回显（区分「真没有」与「筛错了」）
    filterDesc: '',
    hasFilter: false,
    hasMore: false,
    page: 1,
    isMember: false,
    // 建档按钮只在管理员及以上出现（与云端 saveCat 的 admin 门槛对齐）
    canAdd: false
  },

  onLoad(options) {
    if (options.tab === 'sighting') this.setData({ tab: 'sighting' })
    this.consumePendingTab()
    this.reload()
  },

  onShow() {
    // tabBar 选中态兜底（见 index.js onShow 注释）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().refresh()
    // 首页「我的打卡」用 switchTab 过来（switchTab 不支持带 query），
    // 通过 globalData.catsTab 传递要切换的目标 tab。
    const changed = this.consumePendingTab()
    if (changed) { this.reload(); return }
    // ⚠️ 云函数按「调用次数」计费，onShow 无条件 reload 会让每次切 tab
    // 都烧一次调用（开发时来回切，一天就是几百次）。
    // 这里做 30s 节流：刚刷过就不重复刷，下拉刷新与筛选不受限。
    const now = Date.now()
    if (now - (this._lastReloadAt || 0) < 30000) return
    if (this.data.list.length || this.data.sightings.length) this.reload()
  },

  // 消费一次性的 tab 跳转请求；返回是否发生了切换
  consumePendingTab() {
    const want = app.globalData.catsTab
    if (!want) return false
    app.globalData.catsTab = ''
    if (want === this.data.tab) return false
    this.setData({ tab: want })
    return true
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadMore()
  },

  // 防抖定时器必须清理：400ms 内离开页面仍会触发 reload()，
  // 对已卸载页面 setData（告警）+ 白烧一次云函数调用（计费）
  onUnload() {
    if (this._searchTimer) {
      clearTimeout(this._searchTimer)
      this._searchTimer = null
    }
  },

  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh())
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.tab) return
    this.setData({ tab }, () => this.reload())
  },

  // 搜索防抖：输入框每敲一个字都会触发 onSearch，若直接 reload，
  // 打 5 个字就烧 5 次云函数调用。停顿 400ms 才真正发起请求。
  onSearch(e) {
    const keyword = e.detail.value
    this.setData({ keyword })
    if (this._searchTimer) clearTimeout(this._searchTimer)
    this._searchTimer = setTimeout(() => this.reload(), 400)
  },

  /**
   * 清空搜索词。
   *
   * 直接 reload、不走 400ms 防抖：清空是一次明确点击，用户期望立刻看到全量。
   * 但必须先清掉挂起的定时器 —— 否则 400ms 后 onSearch 的回调还会带着旧关键词再刷一次，
   * 表现为「刚清空又跳回搜索结果」。
   */
  clearKeyword() {
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null }
    this.setData({ keyword: '' })
    this.reload()
  },

  onFilter(e) {
    const { key, value } = e.currentTarget.dataset
    const filters = Object.assign({}, this.data.filters)
    filters[key] = filters[key] === value ? '' : value
    this.setData({ filters }, () => this.reload())
  },

  /**
   * 把当前筛选条件翻译成一句人话。
   *
   * 为什么需要：筛完 0 条时界面只显示「没有符合条件的猫咪」，
   * 用户无法区分「本校真没有橘猫」和「筛选坏了 / 花色没标」。
   * 现场就发生过：选橘猫查不到，实测是库里压根没有 pattern=orange 的档案。
   * 把筛选条件回显出来 + 给一个「清除筛选」按钮，用户自己就能判断。
   */
  describeFilters() {
    const f = this.data.filters || {}
    const labelOf = (opts, v) => {
      const hit = (opts || []).find(o => o.value === v)
      return hit ? hit.label : v
    }
    const parts = []
    if (f.status) parts.push('状态：' + labelOf(C.CAT_STATUS, f.status))
    if (f.sterilized) parts.push('绝育：' + labelOf(C.STERILIZED, f.sterilized))
    if (f.pattern) parts.push('花色：' + labelOf(C.PATTERN, f.pattern))
    if (this.data.keyword) parts.push('关键词：「' + this.data.keyword + '」')
    return parts.join(' · ')
  },

  clearFilters() {
    if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null }
    this.setData({
      keyword: '',
      filters: { status: '', sterilized: '', pattern: '' }
    }, () => this.reload())
  },

  async reload() {
    this._lastReloadAt = Date.now()   // 供 onShow 的 30s 节流判断
    this.setData({ loading: true, page: 1, list: [], sightings: [], needSchool: false })
    await app.ensureReady()
    this.setData({ isMember: app.isMember(), canAdd: isAdminPlus(app) })
    await this.fetch(1)
  },

  goBindSchool() {
    app.globalData.mineAction = 'school'
    wx.switchTab({ url: '/pages/mine/mine' })
  },

  async loadMore() {
    await this.fetch(this.data.page + 1)
  },

  async fetch(page) {
    // 请求序号：reload/loadMore 可并发（上拉未回时下拉刷新/改筛选），
    // 后到的旧响应用 concat 读旧 state 会造出重复项、页码回退。
    // 只认最新序号，过期响应直接丢弃。
    const seq = (this._fetchSeq = (this._fetchSeq || 0) + 1)
    try {
      if (this.data.tab === 'cat') {
        const res = await app.callApi('listCats', Object.assign({
          page, size: 20, keyword: this.data.keyword
        }, this.data.filters))
        if (seq !== this._fetchSeq) return
        // 未绑定学校：不给空列表（会被当成「本校一只猫都没有」），明确提示去绑定
        if (res && res.needSchool) {
          this.setData({ needSchool: true, list: [], hasMore: false, loading: false })
          return
        }
        const raw = page === 1 ? res.list : this.data.list.concat(res.list)
        this._rawCats = raw
        // 头像渐进增强：先原样渲染（fileID <image> 能直接解析），fileID → 临时链接
        // 批量预取完成后 apply 再刷一遍，全部换成缩略链接（原图几 MB → 几十 KB）。
        // apply 里校验 _rawCats 引用：loadMore 已换新数组时丢弃过期刷新。
        const apply = view => { if (this._rawCats === raw) this.setData({ list: view }) }
        this.setData({
          list: photo.hydrateCats(raw, { px: 300 }, apply),
          // 空结果时回显筛选条件：让人能自己判断是「真没有」还是「筛错了」
          filterDesc: this.describeFilters(),
          hasFilter: !!(this.data.keyword ||
            (this.data.filters || {}).status ||
            (this.data.filters || {}).sterilized ||
            (this.data.filters || {}).pattern),
          hasMore: res.hasMore,
          page,
          loading: false
        })
      } else {
        // 「打卡记录」：只看自己的记录（mine:true）。
        // 合规配套：打卡记录默认 private，别人的记录本来也不对外；
        // 这里显式加 mine 让 tab 语义与标题一致（本人可见自己全部记录，不受可见性限制）。
        const res = await app.callApi('listSightings', { page, size: 20, mine: true })
        if (seq !== this._fetchSeq) return
        const raw = res.list.map(s => Object.assign({}, s, {
          timeText: fromNow(s.createdAt),
          // 结构化标签文案（替代原自由文本 note；合规改造后 note 已不再写入）
          tagText: sightTagText(s)
        }))
        if (page === 1) this._rawSightings = raw
        else this._rawSightings = (this._rawSightings || []).concat(raw)
        const base = page === 1 ? raw : this.data.sightings.concat(raw)
        const rawRef = this._rawSightings
        const apply = view => { if (this._rawSightings === rawRef) this.setData({ sightings: view }) }
        this.setData({
          sightings: photo.hydrateCats(base, { photoPx: 480, full: true }, apply),
          hasMore: res.hasMore,
          page,
          loading: false
        })
      }
    } catch (e) {
      if (seq !== this._fetchSeq) return
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

  // FAB 统一入口：按当前 tab 分叉（WXML bindtap 只支持静态方法名）
  onFabTap() {
    if (this.data.tab === 'cat') this.goAdd()
    else this.goSighting()
  },

  /**
   * 预览目击照片。
   *
   * 与档案相册同源问题：`previewImage` 吃的是完整原图（1~8 MB），
   * 而格子里是 480px 缩略图 —— 移动网络下点开就是黑屏转圈。
   * 这里统一限宽到 1440px，并监听 fail 把真实原因说出来（黑屏无提示最难查）。
   */
  previewPhoto(e) {
    const ds = e.currentTarget.dataset || {}
    const urls = (ds.urls || []).map(u => photo.thumb(u, 1440)).filter(Boolean)
    if (!urls.length) return
    const cur = photo.thumb(ds.url, 1440)
    wx.previewImage({
      current: urls.indexOf(cur) >= 0 ? cur : urls[0],
      urls: urls,
      fail: err => {
        const msg = (err && (err.errMsg || err.message)) || '未知错误'
        wx.showModal({ title: '照片打不开', content: msg + '（请稍后重试）', showCancel: false })
      }
    })
  },

  /** 目击缩略图加载失败：去参数重试 → 换临时链接 → 隐藏（不触发整页重载） */
  async onSightPhotoErr(e) {
    const ds = e.currentTarget.dataset || {}
    const i = Number(ds.i || 0)
    const j = Number(ds.j || 0)
    const key = 'sightings[' + i + '].photosSmall[' + j + ']'
    const cur = (((this.data.sightings || [])[i] || {}).photosSmall || [])[j]
    if (!cur) return
    if (photo.hasProcess(cur)) { this.setData({ [key]: photo.stripProcess(cur) }); return }
    const rid = (((this._rawSightings || [])[i] || {}).photos || [])[j]
    if (photo.isFileId(rid)) {
      const u = await photo.resolve(rid)
      if (u) { this.setData({ [key]: photo.thumb(u, 480) }); return }
    }
    this.setData({ [key]: '' })
  }
}, shareBehavior(function () {
  const s = app.globalData.school
  const who = s && s.name ? s.name : '校园'
  const n = (this.data.list || []).length
  return {
    title: n ? (who + '有 ' + n + ' 只猫在册 · 喵园猫谱') : '喵园 · 校园流浪猫档案',
    path: '/pages/cats/cats'
  }
})))
