const app = getApp()
const { C, itemOf, labelOf, fromNow, rarityOf, shareBehavior, sightTagText, toastErr } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')

// 全屏查看的最大边长：手机上 1440px 已超过屏幕物理分辨率，再大只是徒增下载量。
// 相册格子是 480px 缩略图，直接拿原图（1~8 MB）就是「黑屏转圈」的根源。
const VIEWER_PX = 1440
// 单张云下载的等待上限：超时就退回「限宽临时链接」，不让查看器无限期卡住
const VIEWER_DL_MS = 4000

/** 超时即返回 ''：预览是「点一下就要有反应」的交互，宁可降级也不能干等 */
function raceTimeout(p, ms) {
  let timer = null
  return Promise.race([
    Promise.resolve(p).catch(() => ''),
    new Promise(resolve => { timer = setTimeout(() => resolve(''), ms) })
  ]).then(v => { if (timer) clearTimeout(timer); return v })
}

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
    // 全屏查看器（替代 wx.previewImage，见 showViewer 上方的注释）
    viewer: { on: false, index: 0, no: 1, total: 0, cur: '', bad: false },
    // 最近投喂（云端在「本人投喂」打卡时写入 lastFedAt/lastFedBy）
    lastFedText: '',
    // 超管才有「删除档案」入口（云端 removeCat 也做了 requireSuper，这里只管显示）
    isSuper: false,
    removing: false
  },

  onLoad(options) {
    this.setData({ id: options.id || '' })
    this.load()
  },

  onShow() {
    // 刚删完档案：这里已经没有数据可读了，再 load 只会拿到「档案不存在」的报错
    if (this._gone) return
    if (this.data.cat) this.load(true)
  },

  async load(silent) {
    if (!silent) this.setData({ loading: true })
    try {
      await app.ensureReady()
      const res = await app.callApi('getCat', { id: this.data.id })
      const cat = res.cat
      const rarity = rarityOf(cat.pattern)
      // 照片一律先换 https 再渲染（hydrateCatsAsync 内部先批量预取再映射）：
      // cloud:// fileID 交给渲染层时，开发者工具会把它当相对路径交给本地
      // pageframe 加载，报 Failed to load image http://127.0.0.1:xxxx/__pageframe__/...；
      // 分享卡片/previewImage 同样不认 fileID。首屏多等一次换链（毫秒级），
      // 换来「不报错、不闪空、预览与分享都能用」。
      this._rawCat = cat
      // 刷新一次数据就重新给每张图的兜底计数清零，否则重进页面后失效图不再重试
      this._albumTried = {}
      const sightRaw = res.sightings.map(s => Object.assign({}, s, {
        timeText: fromNow(s.createdAt),
        tagText: sightTagText(s)   // 结构化标签（替代原自由文本 note）
      }))
      this._rawSightings = sightRaw
      const [catView] = await photo.hydrateCatsAsync([cat], { px: 600, photoPx: 480, full: true })
      const sightView = await photo.hydrateCatsAsync(sightRaw, { photoPx: 320, full: true })
      if (this._rawCat !== cat) return   // 期间来了更新的数据，丢弃这次渲染
      this.setData({
        cat: catView,
        sightings: sightView,
        tnr: res.tnr,
        canEdit: res.canEdit,
        statusLabel: itemOf(C.CAT_STATUS, cat.status).label,
        sterLabel: itemOf(C.STERILIZED, cat.sterilized).label,
        healthLabel: itemOf(C.HEALTH, cat.health).label,
        patternLabel: itemOf(C.PATTERN, cat.pattern).label,
        rarityItem: itemOf(C.RARITY, rarity),
        lastFedText: cat.lastFedAt ? fromNow(cat.lastFedAt) : '',
        // 防御式调用：测试桩 / 旧版 app 可能没有 isSuper，缺方法不能让整页 load 中断
        isSuper: !!(typeof app.isSuper === 'function' && app.isSuper()),
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

  /**
   * 删除档案（仅超管，云端 removeCat 里还有一道 requireSuper）。
   *
   * 二次确认的文案必须写清「什么会永久消失、什么会保留」——
   * 只问「确定删除吗」的确认框，用户点确认时其实不知道自己删掉了什么。
   * 删完直接退回上一页：详情页的数据源已经不存在了，留在原地只会显示一份幽灵档案。
   */
  async removeCat() {
    const cat = this.data.cat || {}
    if (this.data.removing) return
    const ok = await new Promise(resolve => {
      wx.showModal({
        title: '删除这份档案',
        content: '「' + (cat.name || '这只猫') + '」的档案、照片与识别特征会一并删除，且无法恢复。已有的目击记录会保留为历史。',
        confirmText: '永久删除',
        confirmColor: '#C2410C',
        success: r => resolve(!!(r && r.confirm)),
        fail: () => resolve(false)
      })
    })
    if (!ok) return

    this.setData({ removing: true })
    wx.showLoading({ title: '删除中', mask: true })
    try {
      await app.callApi('removeCat', { id: this.data.id })
      wx.hideLoading()
      wx.showToast({ title: '已删除', icon: 'success' })
      this._gone = true
      // 留 600ms 让 toast 被看见；猫谱是 tabBar 页，回去时自己会刷新列表
      setTimeout(() => {
        const pages = getCurrentPages()
        if (pages.length > 1) wx.navigateBack()
        else wx.switchTab({ url: '/pages/cats/cats' })
      }, 600)
    } catch (e) {
      wx.hideLoading()
      toastErr(e, '删除失败')
    } finally {
      this.setData({ removing: false })
    }
  },

  // ======================= 照片全屏查看 =======================
  //
  // 为什么不用 wx.previewImage（2026-10-24 三修，现场「点了还是黑屏」）：
  //  ① previewImage 是**独立原生页**，图片加载失败时只给你一片黑，连 fail 都不回调
  //     （fail 只覆盖「调不起来」，不覆盖「图加载不出来」）；
  //  ② 它吃完整原图（1~8 MB × N 张），走下载链路，受合法域名与签名有效期双重约束。
  //  而相册格子（<image> + imageMogr2/thumbnail/480x）明明是能显示的 ——
  //  于是出现「格子里有图、点开全黑」这种最让人抓狂的分裂。
  //
  // 结论：**别绕开渲染层**。查看器就是一个铺满屏幕的 <image mode="aspectFit">，
  // 与相册格子走同一条渲染链路、同一类地址，格子能显示它就能显示；
  // 万一也失败，binderror 还能兜底换本地文件，最后一定会给出「打不开」的明确文案。

  /** 相册素材：小图（格子正在用的，保证能显示）+ 大图 + 原始 fileID，三者同下标 */
  albumItems() {
    const raw = this._rawCat || {}
    const view = this.data.cat || {}
    const ids = raw.photoIds || []
    const raws = raw.photos || []
    const small = view.photosSmall || []
    const full = view.photosFull || []
    const n = Math.max(ids.length, raws.length, small.length, full.length)
    const out = []
    for (let k = 0; k < n; k++) {
      out.push({ small: small[k] || '', full: full[k] || '', fid: ids[k] || '' })
    }
    return out
  },

  /** 某张的大图地址：优先 https 限宽（快），没有 https 才走云下载（本地文件） */
  async viewerSource(k) {
    const it = (this._viewerItems || [])[k] || {}
    const envId = (app.globalData && app.globalData.envId) || ''
    const url = photo.isHttp(it.full) ? it.full : (photo.isHttp(it.small) ? it.small : '')
    const fid = String(it.fid || '') || photo.fileIdFromUrl(url, envId)
    // 历史档案被「把临时链接写回数据库」污染过：photoIds 是空的，只剩一条过期链接，
    // 从链接反推 fileID 才救得回来（文件本身没删）。
    if (url) return photo.thumb(url, VIEWER_PX)
    if (!photo.isFileId(fid)) return ''
    const local = await raceTimeout(photo.download(fid), VIEWER_DL_MS)
    if (local) return local
    const fresh = (await raceTimeout(photo.refresh(fid), VIEWER_DL_MS)) || ''
    return fresh ? photo.thumb(fresh, VIEWER_PX) : ''
  },

  /**
   * 打开第 idx 张。
   *
   * **先把格子里那张小图放上去**（它一定显示得出来），再异步换成大图 ——
   * 这样点开瞬间就有内容，永远不会出现「先黑一片再慢慢加载」。
   */
  async showViewer(idx) {
    const list = this._viewerItems || []
    if (!list.length) return
    const i = Math.min(Math.max(0, Number(idx) || 0), list.length - 1)
    this._viewerTried = false
    const first = list[i].small || ''
    this.setData({
      viewer: { on: true, index: i, no: i + 1, total: list.length, cur: first, bad: false }
    })
    const big = await this.viewerSource(i)
    const v = this.data.viewer || {}
    if (!v.on || v.index !== i) return   // 已关闭或已切到别的图，丢弃这次结果
    if (big) this.setData({ 'viewer.cur': big })
    else if (!first) this.setData({ 'viewer.bad': true })
  },

  /** 猫相册：点哪张看哪张 */
  async previewPhoto(e) {
    const i = Number((e.currentTarget.dataset || {}).i || 0)
    this._viewerItems = this.albumItems()
    await this.showViewer(i)
  },

  /**
   * 打卡照片。
   *
   * 与相册是**两套素材源**（旧实现靠 WXML 传 data-url/data-urls 兼管两者，
   * 一旦相册侧独立处理，打卡照片就会串到猫的相册上）。目击照片云端不下发
   * photoIds，所以只能靠临时链接 + 从链接反推 fileID。
   */
  async previewSightPhoto(e) {
    const ds = e.currentTarget.dataset || {}
    const si = Number(ds.i || 0)
    const pi = Number(ds.j || 0)   // 与 onSightErr 同一套 dataset 词表
    const raw = (this._rawSightings || [])[si] || {}
    const view = (this.data.sightings || [])[si] || {}
    const raws = raw.photos || []
    const small = view.photosSmall || []
    const full = view.photosFull || []
    const n = Math.max(raws.length, small.length, full.length)
    const items = []
    for (let k = 0; k < n; k++) items.push({ small: small[k] || '', full: full[k] || '', fid: '' })
    this._viewerItems = items
    await this.showViewer(pi)
  },

  closeViewer() { this.setData({ 'viewer.on': false }) },

  /** 点图片本身不关闭（阻止冒泡到遮罩） */
  noop() {},

  onViewerTouchStart(e) {
    const t = (e.touches || [])[0] || {}
    this._vt = { x: Number(t.clientX) || 0, y: Number(t.clientY) || 0 }
  },

  /** 左右滑切换上一张 / 下一张（遮罩上也生效，配合 catchtap 关闭） */
  onViewerTouchEnd(e) {
    const s = this._vt
    this._vt = null
    if (!s) return
    const t = (e.changedTouches || [])[0] || {}
    const dx = (Number(t.clientX) || 0) - s.x
    const dy = (Number(t.clientY) || 0) - s.y
    if (Math.abs(dx) < 45 || Math.abs(dx) <= Math.abs(dy)) return
    this.viewerStep(dx < 0 ? 1 : -1)
  },

  viewerStep(d) {
    const v = this.data.viewer || {}
    if (!v.on) return Promise.resolve()
    const next = v.index + d
    if (next < 0 || next >= (this._viewerItems || []).length) return Promise.resolve()
    return this.showViewer(next)
  },

  /**
   * 查看器里的图也加载失败 → 再兜一层：换成本地文件（云下载）。
   * 还是不行就把「打不开」明确写出来 —— 黑屏无提示是最难查的形态。
   */
  async onViewerErr() {
    const v = this.data.viewer || {}
    if (!v.on) return
    const it = (this._viewerItems || [])[v.index] || {}
    if (!this._viewerTried) {
      this._viewerTried = true
      const envId = (app.globalData && app.globalData.envId) || ''
      const fid = String(it.fid || '') || photo.fileIdFromUrl(it.full || it.small, envId)
      if (photo.isFileId(fid)) {
        const local = await raceTimeout(photo.download(fid), VIEWER_DL_MS)
        const v2 = this.data.viewer || {}
        if (local && v2.on && v2.index === v.index) { this.setData({ 'viewer.cur': local }); return }
      }
      // 大图挂了但格子里那张小图是好的 → 退回小图，比黑屏强
      const v3 = this.data.viewer || {}
      if (it.small && v3.cur !== it.small) { this.setData({ 'viewer.cur': it.small }); return }
    }
    this.setData({ 'viewer.bad': true })
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
    // 云端把 avatar 也换成了临时链接，原始 fileID 只留在 avatarId 里
    const fid = (this._rawCat && (this._rawCat.avatarId || this._rawCat.avatar)) || a
    if (photo.isFileId(fid)) {
      // 必须 refresh（忽略缓存）：缓存里存的就是那条已经失效的链接，
      // 用 resolve 等于「拿同一个坏地址再试一次」，兜底必然再挂。
      const u = (await photo.refresh(fid)) || (await photo.resolve(fid))
      if (u) { this.setData({ 'cat.avatar': photo.thumb(u, 600) }); return }
    }
    if (a) this.setData({ 'cat.avatar': '' })
  },

  /**
   * 相册图加载失败：去缩略参数 → 反推 fileID 换新链 → 云下载本地文件 → 标记失效。
   *
   * ⚠️ 最后一档**不能只是把 src 清空**：清空后格子就是个空白框，用户看到的是
   * 「相册里少了一张」，而不是「这张坏了、需要重传」—— 2026-10-24 现场就是这样
   * 把「第一张已失效」误读成「相册只显示第二张」的。现在会显示「照片失效」占位。
   *
   * 每一档都记次数（_albumTried），避免 refresh 拿到同一条坏链后无限重试。
   */
  async onAlbumErr(e) {
    const i = Number((e.currentTarget.dataset || {}).i || 0)
    const cur = (this.data.cat && this.data.cat.photosSmall || [])[i]
    if (!cur) return
    if (photo.hasProcess(cur)) {
      this.setData({ ['cat.photosSmall[' + i + ']']: photo.stripProcess(cur) })
      return
    }
    const raw = this._rawCat || {}
    // 原始 fileID 在 photoIds 里（云端已把 photos 换成临时链接）
    const rid = (raw.photoIds || [])[i] || (raw.photos || [])[i] || ''
    const envId = (app.globalData && app.globalData.envId) || ''
    // 老档案只剩一条过期临时链接 → 从链接反推 fileID（文件没删就能救回来）
    const fid = photo.isFileId(rid) ? rid : photo.fileIdFromUrl(rid || cur, envId)
    this._albumTried = this._albumTried || {}
    const tried = this._albumTried[i] || 0
    if (photo.isFileId(fid) && tried < 2) {
      this._albumTried[i] = tried + 1
      if (tried === 0) {
        // 必须 refresh（忽略缓存）：缓存里存的就是那条已经失效的链接
        const u = (await photo.refresh(fid)) || (await photo.resolve(fid))
        if (u) { this.setData({ ['cat.photosSmall[' + i + ']']: photo.thumb(u, 480) }); return }
      } else {
        // 换链也救不回来（签名/域名问题）→ 走云通道下载到本地，<image> 直接读本地文件
        const local = await raceTimeout(photo.download(fid), 2500)
        if (local) { this.setData({ ['cat.photosSmall[' + i + ']']: local }); return }
      }
    }
    this.setData({ ['cat.photosSmall[' + i + ']']: '' })
  },

  /**
   * 长按「相册」标题 → 弹一张照片体检表（不对外宣传，排查用）。
   *
   * 现场反馈「相册只显示一张」时，先看这里：如果显示 two 张但 #1 是「失效」，
   * 说明那张的云存储文件已经没了（或被写成了过期链接），需要在编辑页重传；
   * 如果是「共 1 张」，那才是数据本身只有一张。
   */
  albumDebug() {
    const raw = this._rawCat || {}
    const view = this.data.cat || {}
    const ids = raw.photoIds || []
    const raws = raw.photos || []
    const small = view.photosSmall || []
    const n = Math.max(ids.length, raws.length, small.length)
    const lines = []
    for (let k = 0; k < n; k++) {
      const kind = photo.isFileId(raws[k]) ? '文件ID'
        : (photo.isHttp(raws[k]) ? '临时链接' : '空')
      const state = !small[k] ? '失效'
        : (photo.isFileId(small[k]) ? '未换链' : '可显示')
      lines.push('#' + (k + 1) + '（' + kind + '／' + state + '）')
    }
    wx.showModal({
      title: '相册体检',
      content: '共 ' + n + ' 张，可用的图片ID ' + ids.filter(Boolean).length + ' 个\n' + lines.join(' '),
      showCancel: false
    })
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
      // 必须 refresh（忽略缓存）：缓存里存的就是那条已经失效的链接，
      // 用 resolve 等于「拿同一个坏地址再试一次」，兜底必然再挂。
      const u = (await photo.refresh(rid)) || (await photo.resolve(rid))
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
