const app = getApp()
const { C, toast } = require('../../utils/util.js')

Page({
  data: {
    catId: '',
    catNames: [],
    catIds: [],
    catIndex: 0,
    isNewCat: false,
    newCatName: '',
    photos: [],
    locationName: '',
    location: null,
    healthIndex: 7,
    healthOptions: C.HEALTH,
    note: '',
    count: 1,
    locating: false,
    submitting: false
  },

  onLoad(options) {
    // 支持从 AI 识别页带参跳转：photo（已上传云存储的图片 fileId）+ catId
    const patch = {}
    if (options.catId) patch.catId = options.catId
    if (options.photo) patch.photos = [options.photo]
    if (Object.keys(patch).length) this.setData(patch)
    this.loadCats()
    this.locate()
  },

  async loadCats() {
    try {
      await app.ensureReady()
      const res = await app.callApi('listCats', { size: 100 })
      const list = res.list.filter(c => c.status !== 'rainbow')
      const names = ['（不指定 / 新发现的猫）'].concat(list.map(c => c.name))
      const ids = [''].concat(list.map(c => c._id))
      let idx = 0
      if (this.data.catId) {
        const i = ids.indexOf(this.data.catId)
        if (i > 0) idx = i
      }
      this.setData({ catNames: names, catIds: ids, catIndex: idx })
    } catch (e) {
      console.error(e)
    }
  },

  async locate() {
    this.setData({ locating: true })
    try {
      const res = await new Promise((resolve, reject) => {
        wx.getLocation({ type: 'gcj02', success: resolve, fail: reject })
      })
      this.setData({ location: { lat: res.latitude, lng: res.longitude } })
    } catch (e) {
      // 未授权则留空，允许手动选点
    } finally {
      this.setData({ locating: false })
    }
  },

  onCatPick(e) {
    const i = Number(e.detail.value)
    this.setData({ catIndex: i, catId: this.data.catIds[i], isNewCat: i === 0 })
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ [key]: e.detail.value })
  },

  onHealthPick(e) {
    this.setData({ healthIndex: Number(e.detail.value) })
  },

  changeCount(e) {
    this.setData({ count: Number(e.detail.value) || 1 })
  },

  async choosePhotos() {
    const res = await wx.chooseMedia({ count: 6, mediaType: ['image'], sizeType: ['compressed'] }).catch(() => null)
    if (!res) return
    wx.showLoading({ title: '上传中' })
    try {
      const files = res.tempFiles || []
      for (const f of files) {
        const up = await wx.cloud.uploadFile({
          cloudPath: 'sightings/' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '.jpg',
          filePath: f.tempFilePath
        })
        this.setData({ photos: this.data.photos.concat(up.fileID) })
      }
    } catch (e) {
      toast('上传失败')
    } finally {
      wx.hideLoading()
    }
  },

  removePhoto(e) {
    const i = e.currentTarget.dataset.index
    const p = this.data.photos.slice()
    p.splice(i, 1)
    this.setData({ photos: p })
  },

  async chooseLocation() {
    const res = await wx.chooseLocation({}).catch(() => null)
    if (!res || !res.latitude) return
    this.setData({
      location: { lat: res.latitude, lng: res.longitude },
      locationName: res.name || res.address || ''
    })
  },

  async submit() {
    if (this.data.submitting) return
    if (!this.data.catId && !this.data.newCatName.trim() && !this.data.photos.length) {
      return toast('请至少选择猫或上传一张照片')
    }
    this.setData({ submitting: true })
    wx.showLoading({ title: '提交中' })
    try {
      const data = {
        catId: this.data.catId,
        catName: this.data.catId ? '' : (this.data.newCatName.trim() || '未认领的新猫'),
        photos: this.data.photos,
        location: this.data.location,
        locationName: this.data.locationName,
        health: this.data.healthOptions[this.data.healthIndex].value,
        note: this.data.note,
        count: this.data.count
      }
      const res = await app.callApi('addSighting', { data })
      wx.hideLoading()
      wx.showModal({
        title: '打卡成功',
        content: '获得猫粮值 +' + res.pointsGained + (this.data.catId ? '' : '，社团会核实后为它建档'),
        showCancel: false,
        success: () => {
          if (this.data.catId) {
            wx.redirectTo({ url: '/pages/cat-detail/cat-detail?id=' + this.data.catId })
          } else {
            wx.switchTab({ url: '/pages/cats/cats' })
          }
        }
      })
    } catch (e) {
      wx.hideLoading()
      toast(e.message || '提交失败')
    } finally {
      this.setData({ submitting: false })
    }
  }
})
