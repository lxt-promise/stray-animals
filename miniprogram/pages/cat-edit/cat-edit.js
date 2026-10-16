const app = getApp()
const { C, requireAdmin, toast, showBusy, hideBusy } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')

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
    charChips: [],
    saving: false
  },

  onLoad(options) {
    // 建档 / 改档：管理员及以上（含超级管理员）可手动录入
    if (!requireAdmin(app)) {
      setTimeout(() => wx.navigateBack(), 1500)
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
    if (touched) { this.setData({ form: f }); this.syncPhotoViews() }

    // 性格标签选中态必须在 JS 层预计算（见 buildCharChips 注释），先渲染初始态
    this.buildCharChips()

    if (options.id) {
      this.setData({ id: options.id, isNew: false })
      wx.setNavigationBarTitle({ title: '编辑档案' })
      this.loadCat(options.id)
    } else {
      wx.setNavigationBarTitle({ title: '录入新猫档案' })
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
      this.syncPhotoViews()
      // 档案回填后重建标签选中态
      this.buildCharChips()
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

  /** 构建性格标签列表（含选中态 on）。
   *  选中态必须在 JS 层算，不能写在 WXML class 里：
   *  WXML mustache 表达式编译期白名单校验，只支持简单运算和属性访问，
   *  indexOf() 等方法调用会被静默忽略、整段表达式退化为 false ——
   *  表现为「点击有回调但选中态永远不显示」（2026-10-12 建档页实际踩坑）。 */
  buildCharChips() {
    const chars = this.data.form.characters || []
    this.setData({
      charChips: C.CHARACTER.map(c => ({
        value: c.value,
        label: c.label,
        on: chars.indexOf(c.value) >= 0
      }))
    })
  },

  toggleChar(e) {
    const v = e.currentTarget.dataset.value
    const chars = this.data.form.characters.slice()
    const i = chars.indexOf(v)
    if (i >= 0) chars.splice(i, 1)
    else chars.push(v)
    this.setData({ 'form.characters': chars })
    this.buildCharChips()
  },

  togglePrivate(e) {
    this.setData({ 'form.spotPrivate': e.detail.value })
  },

  /** 表单里存的是原始 fileID（提交要用的），展示另开 avatarView / photosView：
   *  cloud:// 直接进 <image src> 在开发者工具会报 pageframe 加载失败，
   *  这里先批量换临时链接再渲染（本地新选的图是临时路径，原样直出）。 */
  async syncPhotoViews() {
    const f = this.data.form || {}
    const ids = [].concat(f.avatar ? [f.avatar] : []).concat(f.photos || [])
      .filter(id => photo.isFileId(id))
    if (ids.length) await photo.warm(ids)
    const g = this.data.form || {}
    this.setData({
      avatarView: photo.display(g.avatar || '', 300),
      photosView: (g.photos || []).map(p => photo.display(p, 300))
    })
  },

  async chooseAvatar() {
    const res = await wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'] }).catch(() => null)
    if (!res) return
    showBusy({ title: '上传中' })
    try {
      const file = res.tempFiles[0]
      const up = await wx.cloud.uploadFile({
        cloudPath: 'cats/' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '.jpg',
        filePath: file.tempFilePath
      })
      this.setData({ 'form.avatar': up.fileID })
      this.syncPhotoViews()
    } catch (e) {
      toast('上传失败')
    } finally {
      hideBusy()
    }
  },

  async choosePhotos() {
    const res = await wx.chooseMedia({ count: 6, mediaType: ['image'], sizeType: ['compressed'] }).catch(() => null)
    if (!res) return
    showBusy({ title: '上传中' })
    const ids = []
    try {
      const files = res.tempFiles || []
      for (const f of files) {
        const up = await wx.cloud.uploadFile({
          cloudPath: 'cats/' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '.jpg',
          filePath: f.tempFilePath
        })
        ids.push(up.fileID)
      }
    } catch (e) {
      // 中途失败不能整体丢弃：前几张已经传成功的 fileID 要保留下来
      // （否则云存储留孤儿文件，用户还以为一张都没传）
      if (ids.length) {
        this.setData({ 'form.photos': this.data.form.photos.concat(ids) })
        this.syncPhotoViews()
        toast('部分照片上传失败，已保留 ' + ids.length + ' 张')
        return
      }
      toast('上传失败')
      return
    } finally {
      hideBusy()
    }
    this.setData({ 'form.photos': this.data.form.photos.concat(ids) })
    this.syncPhotoViews()
  },

  removePhoto(e) {
    const i = e.currentTarget.dataset.index
    const photos = this.data.form.photos.slice()
    photos.splice(i, 1)
    this.setData({ 'form.photos': photos })
    this.syncPhotoViews()
  },

  async chooseLocation() {
    const res = await wx.chooseLocation({}).catch(() => null)
    if (!res || !res.latitude) return
    this.setData({
      'form.location': { lat: res.latitude, lng: res.longitude },
      'form.locationName': res.name || res.address || ''
    })
  },

  /**
   * 保存成功后自动把这只猫送进服务端特征库（花色比对）。
   *
   * 单独一次云函数调用，不塞进 saveCat —— 客户端单次 callFunction 只有约 3s 预算，
   * 建档本身已经有文字/图片安全检测，再叠建库必然顶爆。拆开就各有各的预算。
   *
   * @returns {Promise<boolean>} 是否当场入库成功（false 不代表失败，只是延后）
   */
  async autoIndexCat (catId, schoolId) {
    if (!catId) return false
    try {
      const r = await app.callApi('autoIndexCat', {
        catIds: [catId], schoolId: schoolId || '', photosPerCat: 3
      })
      return !!(r && r.ok)
    } catch (e) {
      // 静默：建档已经成功，入库交给识别热路径 / 定时任务兜底
      console.warn('[cat-edit] 自动入库未当场完成', e && e.message)
      return false
    }
  },

  async save() {
    const f = this.data.form
    if (!f.name.trim()) return toast('请填写名字')
    if (this.data.saving) return
    this.setData({ saving: true })
    showBusy({ title: '保存中' })
    try {
      const payload = Object.assign({}, f)
      if (payload.location && !payload.location.name) {
        payload.location.name = payload.locationName || ''
      }
      const r = await app.callApi('saveCat', { data: payload })
      hideBusy()
      // 建档 / 改档后立刻自动入库：只建这一只，失败不影响「保存成功」。
      // 用 await 是为了给准反馈；超时也无所谓 —— 识别热路径和每天 3 点定时会兜底。
      const me = app.globalData.user || {}
      const indexed = await this.autoIndexCat(r && r._id, payload.schoolId || me.schoolId)
      const base = this.data.isNew ? '档案已建立' : '已保存'
      wx.showToast({ title: indexed ? (base + '，已加入比对') : base, icon: 'success' })
      setTimeout(() => wx.navigateBack(), 900)
    } catch (e) {
      hideBusy()
      toast(e.message || '保存失败')
    } finally {
      this.setData({ saving: false })
    }
  }
})
