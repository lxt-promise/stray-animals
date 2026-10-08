const app = getApp()
const { C, itemOf, labelOf, fromNow, rarityOf } = require('../../utils/util.js')

Page({
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
    confidence: 0,
    ringTurn: 0,
    confText: ''
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
      // AI 识别置信度：由入库标准照数量推导，与预览的「识别置信度」口径一致
      const photoCount = (cat.photos || []).length
      const confidence = photoCount === 0 ? 38 : Math.min(92, 58 + photoCount * 8)
      const confText = confidence >= 80
        ? '特征向量稳定，下次被拍到时系统可直接点名识别。'
        : (confidence >= 60
          ? '标准照偏少，再补几张正脸照可明显提升识别率。'
          : '标准照不足，AI 暂不能稳定识别它，建议补充正脸照。')
      this.setData({
        cat,
        photoCount,
        confidence,
        ringTurn: confidence / 100,
        confText,
        sightings: res.sightings.map(s => Object.assign({}, s, { timeText: fromNow(s.createdAt) })),
        tnr: res.tnr,
        canEdit: res.canEdit,
        statusLabel: itemOf(C.CAT_STATUS, cat.status).label,
        sterLabel: itemOf(C.STERILIZED, cat.sterilized).label,
        healthLabel: itemOf(C.HEALTH, cat.health).label,
        patternLabel: itemOf(C.PATTERN, cat.pattern).label,
        rarityItem: itemOf(C.RARITY, rarity),
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
  }
})
