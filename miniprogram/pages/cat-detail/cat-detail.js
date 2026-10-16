const app = getApp()
const { C, itemOf, labelOf, fromNow, rarityOf, shareBehavior } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')

Page(Object.assign({
  data: {
    id: '',
    cat: null,
    sightings: [],
    tnr: [],
    canEdit: false,
    loading: true,
    statusLabel: '',
    sterLabel: '',
    healthLabel: '',
    rarityItem: null,
    patternLabel: '',
    photoCount: 0,
    // 最近投喂（云端在「本人投喂」打卡时写入 lastFedAt/lastFedBy）
    lastFedText: ''
  },

  onLoad(options) {
    this.setData({ id: options.id || '' })
    this.load()
  },

  onShow() {
    if (this.data.cat) this.load(true)
  },

  async load(silent) {
    if (!silent) this.setData({ loading: true })
    try {
      await app.ensureReady()
      const res = await app.callApi('getCat', { id: this.data.id })
      const cat = res.cat
      const rarity = rarityOf(cat.pattern)
      // 标准照数量：与云端「特征库取图」口径保持一致 ——
      //   photos 有值就用 photos，否则退回 avatar（封面照）。
      // 建档时若只设了封面照而没加相册照，photos 会是空数组，
      // 导致明明有一只猫的照片却显示「已入库 0 张标准照」（现场 bug）。
      // 云端 vision.attachTempUrls / pickPendingIndexCats 就是 `photos.length ? photos : [avatar]`，
      // 这里必须同口径，否则前端计数与真实入库照片数对不上。
      const photoCount = (cat.photos && cat.photos.length)
        ? cat.photos.length
        : (cat.avatar ? 1 : 0)
      // 照片一律先换 https 再渲染（hydrateCatsAsync 内部先批量预取再映射）：
      // cloud:// fileID 交给渲染层时，开发者工具会把它当相对路径交给本地
      // pageframe 加载，报 Failed to load image http://127.0.0.1:xxxx/__pageframe__/...；
      // 分享卡片/previewImage 同样不认 fileID。首屏多等一次换链（毫秒级），
      // 换来「不报错、不闪空、预览与分享都能用」。
      this._rawCat = cat
      const sightRaw = res.sightings.map(s => Object.assign({}, s, { timeText: fromNow(s.createdAt) }))
      this._rawSightings = sightRaw
      const [catView] = await photo.hydrateCatsAsync([cat], { px: 600, photoPx: 480, full: true })
      const sightView = await photo.hydrateCatsAsync(sightRaw, { photoPx: 320, full: true })
      if (this._rawCat !== cat) return   // 期间来了更新的数据，丢弃这次渲染
      this.setData({
        cat: catView,
        photoCount,
        sightings: sightView,
        tnr: res.tnr,
        canEdit: res.canEdit,
        statusLabel: itemOf(C.CAT_STATUS, cat.status).label,
        sterLabel: itemOf(C.STERILIZED, cat.sterilized).label,
        healthLabel: itemOf(C.HEALTH, cat.health).label,
        patternLabel: itemOf(C.PATTERN, cat.pattern).label,
        rarityItem: itemOf(C.RARITY, rarity),
        lastFedText: cat.lastFedAt ? fromNow(cat.lastFedAt) : '',
        loading: false
      })
      wx.setNavigationBarTitle({ title: cat.name || '猫咪档案' })
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: e.message || '加载失败', icon: 'none' })
    }
  },

  goEdit() {
    wx.navigateTo({ url: '/pages/cat-edit/cat-edit?id=' + this.data.id })
  },

  goSighting() {
    wx.navigateTo({ url: '/pages/sighting-post/sighting-post?catId=' + this.data.id })
  },

  previewPhoto(e) {
    wx.previewImage({ current: e.currentTarget.dataset.url, urls: e.currentTarget.dataset.urls })
  },

  viewOnMap() {
    const c = this.data.cat
    if (!c.location || !c.location.lat) return wx.showToast({ title: '该猫暂无点位', icon: 'none' })
    wx.openLocation({
      latitude: c.location.lat,
      longitude: c.location.lng,
      name: c.name,
      address: c.location.name || ''
    })
  },

  charLabel(v) {
    return labelOf(C.CHARACTER, v)
  },

  /** 封面图加载失败三级兜底：① 去缩略参数重试 ② 换 getTempFileURL 临时链接
   *  ③ 藏起来退占位背景。绝不触发页面重载（「失败→重载→再失败」死循环在列表页踩过）。 */
  async onHeroError() {
    const a = (this.data.cat && this.data.cat.avatar) || ''
    if (photo.hasProcess(a)) { this.setData({ 'cat.avatar': photo.stripProcess(a) }); return }
    if (photo.isFileId(a) || (this._rawCat && photo.isFileId(this._rawCat.avatar))) {
      const u = await photo.resolve((this._rawCat && this._rawCat.avatar) || a)
      if (u) { this.setData({ 'cat.avatar': photo.thumb(u, 600) }); return }
    }
    if (a) this.setData({ 'cat.avatar': '' })
  },

  /** 相册图加载失败：去参数重试 → 换临时链接 → 隐藏（与该猫的原始 photos 对齐取 fileID） */
  async onAlbumErr(e) {
    const i = Number((e.currentTarget.dataset || {}).i || 0)
    const cur = (this.data.cat && this.data.cat.photosSmall || [])[i]
    if (!cur) return
    if (photo.hasProcess(cur)) {
      this.setData({ ['cat.photosSmall[' + i + ']']: photo.stripProcess(cur) })
      return
    }
    const rid = ((this._rawCat && this._rawCat.photos) || [])[i]
    if (photo.isFileId(rid)) {
      const u = await photo.resolve(rid)
      if (u) { this.setData({ ['cat.photosSmall[' + i + ']']: photo.thumb(u, 480) }); return }
    }
    this.setData({ ['cat.photosSmall[' + i + ']']: '' })
  },

  /** 目击图加载失败：同上，先按目击序号再按照片序号定位 */
  async onSightErr(e) {
    const ds = e.currentTarget.dataset || {}
    const si = Number(ds.i || 0)
    const pi = Number(ds.j || 0)
    const key = 'sightings[' + si + '].photosSmall[' + pi + ']'
    const cur = ((this.data.sightings || [])[si] || {}).photosSmall
    const url = (cur || [])[pi]
    if (!url) return
    if (photo.hasProcess(url)) { this.setData({ [key]: photo.stripProcess(url) }); return }
    const rid = (((this._rawSightings || [])[si] || {}).photos || [])[pi]
    if (photo.isFileId(rid)) {
      const u = await photo.resolve(rid)
      if (u) { this.setData({ [key]: photo.thumb(u, 320) }); return }
    }
    this.setData({ [key]: '' })
  },
// ↓ 单只猫的分享：这是最有传播价值的一条路径，标题带猫名、卡片图用它的照片。
//   imageUrl 必须是可直连的 https 地址 —— 云存储的 cloud:// fileID 不能用于分享卡片，
//   这里优先取云端换好的临时/直链字段，没有就让微信自动截页面。
}, shareBehavior(function () {
  const cat = this.data.cat
  const id = this.data.id
  const name = cat ? (cat.name || '一只猫') : '一只猫'
  const pattern = cat ? labelOf(C.PATTERN, cat.pattern) : ''
  const spot = cat && cat.location && cat.location.name ? ('在' + cat.location.name) : ''
  // 分享卡片封面必须是可直连的 https：cloud:// fileID 在这里无效，
  // 字段不对就让微信自动截页面，别把卡片搞成灰底。
  // photosFull / avatar 已由 photo.js 换成 https（预取完成后生效），
  // 比直接用 cat.photos 的 fileID 高得多的命中率。
  const cover = cat
    ? (((cat.photosFull && cat.photosFull[0]) || '') || cat.avatar ||
       (cat.photos && cat.photos[0]) || '')
    : ''
  const httpsCover = /^https?:\/\//.test(cover) ? cover : ''
  return {
    title: spot
      ? ('来认识' + name + '｜' + (pattern || '校园猫') + '，常驻' + spot)
      : ('来认识' + name + '｜' + (pattern || '校园猫')),
    path: id ? ('/pages/cat-detail/cat-detail?id=' + id) : '/pages/cats/cats',
    imageUrl: httpsCover,
    query: id ? ('id=' + id) : ''
  }
})))
