const app = getApp()
const { C, requireMember, toast } = require('../../utils/util.js')

Page({
  data: {
    id: '',
    isNew: true,
    form: {
      name: '',
      alias: '',
      sex: 'unknown',
      pattern: 'other',
      colorNote: '',
      sterilized: 'unknown',
      earMark: '',
      status: 'campus',
      health: 'unknown',
      characters: [],
      location: null,
      locationName: '',
      spotPrivate: false,
      avatar: '',
      photos: [],
      note: '',
      internalNote: '',
      medicalNote: ''
    },
    sexIndex: 2,
    patternIndex: 10,
    sterIndex: 2,
    statusIndex: 0,
    healthIndex: 7,
    sexOptions: C.SEX,
    patternOptions: C.PATTERN,
    sterOptions: C.STERILIZED,
    statusOptions: C.CAT_STATUS,
    healthOptions: C.HEALTH,
    charOptions: C.CHARACTER,
    saving: false
  },

  onLoad(options) {
    if (!requireMember(app)) {
      setTimeout(() => wx.navigateBack(), 800)
      return
    }
    // 支持从 AI 识别页带参新建：photo / pattern / color
    const f = Object.assign({}, this.data.form)
    let touched = false
    if (options.photo) { f.avatar = options.photo; f.photos = [options.photo]; touched = true }
    if (options.pattern) {
      const pi = C.PATTERN.map(p => p.value).indexOf(options.pattern)
      if (pi >= 0) { this.setData({ patternIndex: pi }); f.pattern = options.pattern; touched = true }
    }
    if (options.color) { f.colorNote = options.color; touched = true }
    if (touched) this.setData({ form: f })

    if (options.id) {
      this.setData({ id: options.id, isNew: false })
      wx.setNavigationBarTitle({ title: '编辑档案' })
      this.loadCat(options.id)
    }
  },

  async loadCat(id) {
    try {
      const res = await app.callApi('getCat', { id })
      const c = res.cat
      const form = Object.assign({}, this.data.form, {
        _id: c._id,
        name: c.name,
        alias: c.alias || '',
        sex: c.sex,
        pattern: c.pattern,
        colorNote: c.colorNote || '',
        sterilized: c.sterilized,
        earMark: c.earMark || '',
        status: c.status,
        health: c.health,
        characters: c.characters || [],
        location: c.location || null,
        locationName: (c.location && c.location.name) || '',
        spotPrivate: !!c.spotPrivate,
        avatar: c.avatar || '',
        photos: c.photos || [],
        note: c.note || '',
        internalNote: c.internalNote || '',
        medicalNote: c.medicalNote || ''
      })
      const idx = (arr, v) => Math.max(0, arr.map(i => i.value).indexOf(v))
      this.setData({
        form,
        sexIndex: idx(C.SEX, c.sex),
        patternIndex: idx(C.PATTERN, c.pattern),
        sterIndex: idx(C.STERILIZED, c.sterilized),
        statusIndex: idx(C.CAT_STATUS, c.status),
        healthIndex: idx(C.HEALTH, c.health)
      })
    } catch (e) {
      toast(e.message)
    }
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ ['form.' + key]: e.detail.value })
  },

  onPick(e) {
    const { key, field } = e.currentTarget.dataset
    const options = this.data[key]
    const value = options[e.detail.value].value
    this.setData({
      ['form.' + field]: value,
      [field + 'Index']: Number(e.detail.value)
    })
  },

  toggleChar(e) {
    const v = e.currentTarget.dataset.value
    const chars = this.data.form.characters.slice()
    const i = chars.indexOf(v)
    if (i >= 0) chars.splice(i, 1)
    else chars.push(v)
    this.setData({ 'form.characters': chars })
  },

  togglePrivate(e) {
    this.setData({ 'form.spotPrivate': e.detail.value })
  },

  async chooseAvatar() {
    const res = await wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'] }).catch(() => null)
    if (!res) return
    wx.showLoading({ title: '上传中' })
    try {
      const file = res.tempFiles[0]
      const up = await wx.cloud.uploadFile({
        cloudPath: 'cats/' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '.jpg',
        filePath: file.tempFilePath
      })
      this.setData({ 'form.avatar': up.fileID })
    } catch (e) {
      toast('上传失败')
    } finally {
      wx.hideLoading()
    }
  },

  async choosePhotos() {
    const res = await wx.chooseMedia({ count: 6, mediaType: ['image'], sizeType: ['compressed'] }).catch(() => null)
    if (!res) return
    wx.showLoading({ title: '上传中' })
    try {
      const files = res.tempFiles || []
      const ids = []
      for (const f of files) {
        const up = await wx.cloud.uploadFile({
          cloudPath: 'cats/' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '.jpg',
          filePath: f.tempFilePath
        })
        ids.push(up.fileID)
      }
      this.setData({ 'form.photos': this.data.form.photos.concat(ids) })
    } catch (e) {
      toast('上传失败')
    } finally {
      wx.hideLoading()
    }
  },

  removePhoto(e) {
    const i = e.currentTarget.dataset.index
    const photos = this.data.form.photos.slice()
    photos.splice(i, 1)
    this.setData({ 'form.photos': photos })
  },

  async chooseLocation() {
    const res = await wx.chooseLocation({}).catch(() => null)
    if (!res || !res.latitude) return
    this.setData({
      'form.location': { lat: res.latitude, lng: res.longitude },
      'form.locationName': res.name || res.address || ''
    })
  },

  async save() {
    const f = this.data.form
    if (!f.name.trim()) return toast('请填写名字')
    if (this.data.saving) return
    this.setData({ saving: true })
    wx.showLoading({ title: '保存中' })
    try {
      const payload = Object.assign({}, f)
      if (payload.location && !payload.location.name) {
        payload.location.name = payload.locationName || ''
      }
      await app.callApi('saveCat', { data: payload })
      wx.hideLoading()
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 900)
    } catch (e) {
      wx.hideLoading()
      toast(e.message || '保存失败')
    } finally {
      this.setData({ saving: false })
    }
  }
})
