const app = getApp()
const { fromNow, sightTagText } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')

/**
 * 我的打卡（独立页面）
 *
 * 原实现：在「我的」页里作为一个菜单项点击就地展开记录卡片。
 * 现在按需求独立成页：菜单项点击 → navigateTo 到这里。
 * 逻辑从 mine.js 整体迁移过来，渲染口径完全一致（结构化标签 / 缩略图 / 预览）。
 */
Page({
  data: {
    list: [],
    count: 0,
    loading: true
  },

  onLoad() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  async load() {
    this.setData({ loading: true })
    try {
      await app.ensureReady()
      const user = app.globalData.user
      // 打卡次数（云端派生值，历史上可能为负，展示层夹到 ≥0）
      this.setData({ count: Math.max(0, Number(user && user.sightingCount) || 0) })
      const res = await app.callApi('listSightings', { mine: true, size: 20 })
      const raw = (res.list || []).map(s => Object.assign({}, s, {
        timeText: fromNow(s.createdAt),
        tagText: sightTagText(s)   // 结构化标签（替代原自由文本 note）
      }))
      this.setData({
        // 打卡照片同样走 https 缩略（原图慢 + cloud:// 在开发者工具里解析不了）
        list: photo.hydrateCats(raw, { photoPx: 320, full: true },
          view => this.setData({ list: view }))
      })
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  goCat(e) {
    // 打卡记录里的猫可能已被删（catId 为空）：不跳，避免 ?id=undefined 白屏
    const id = e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id
    if (!id || id === 'undefined' || id === 'null') return
    wx.navigateTo({ url: '/pages/cat-detail/cat-detail?id=' + id })
  },

  previewPhoto(e) {
    wx.previewImage({ current: e.currentTarget.dataset.url, urls: e.currentTarget.dataset.urls })
  },

  /** 打卡缩略图加载失败：去参数重试 → 换临时链接 → 隐藏（不触发整页重载） */
  async onPhotoErr(e) {
    const ds = e.currentTarget.dataset || {}
    const i = Number(ds.i || 0)
    const j = Number(ds.j || 0)
    const key = 'list[' + i + '].photosSmall[' + j + ']'
    const item = (this.data.list || [])[i]
    const cur = ((item && item.photosSmall) || [])[j]
    if (!cur) return
    if (photo.hasProcess(cur)) { this.setData({ [key]: photo.stripProcess(cur) }); return }
    const rid = ((item && item.photos) || [])[j]
    if (photo.isFileId(rid)) {
      const u = await photo.resolve(rid)
      if (u) { this.setData({ [key]: photo.thumb(u, 320) }); return }
    }
    this.setData({ [key]: '' })
  }
})
