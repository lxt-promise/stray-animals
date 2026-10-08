const app = getApp()
const { C, fromNow } = require('../../utils/util.js')

Page({
  data: {
    user: null,
    school: null,
    isMember: false,
    isAdmin: false,
    mySightings: [],
    stats: { points: 0, sightingCount: 0, catSeen: 0 },
    dex: [],
    dexTotal: 0,
    dexPercent: 0,
    showSchoolForm: false,
    schoolForm: { name: '', campus: '', city: '', intro: '' },
    schools: [],
    loading: true
  },

  onLoad(options) {
    if (options.action === 'school') {
      this.setData({ showSchoolForm: true })
      this.loadSchools()
    }
    this.load()
  },

  onShow() {
    if (app.globalData.ready) this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  async load() {
    this.setData({ loading: true })
    try {
      await app.ensureReady()
      const user = app.globalData.user
      this.setData({
        user,
        school: app.globalData.school,
        isMember: app.isMember(),
        isAdmin: app.isAdmin()
      })
      if (user) {
        const res = await app.callApi('listSightings', { mine: true, size: 20 })
        const seenIds = user.catSeen || []
        this.setData({
          mySightings: res.list.map(s => Object.assign({}, s, { timeText: fromNow(s.createdAt) })),
          stats: {
            points: user.points || 0,
            sightingCount: user.sightingCount || 0,
            catSeen: seenIds.length
          }
        })
        await this.loadDex(seenIds)
      }
    } catch (e) {
      console.error(e)
    } finally {
      this.setData({ loading: false })
    }
  },

  async loadSchools() {
    try {
      const schools = await app.callApi('listSchools', {})
      this.setData({ schools })
    } catch (e) {}
  },

  onInput(e) {
    const { key } = e.currentTarget.dataset
    this.setData({ ['schoolForm.' + key]: e.detail.value })
  },

  async createSchool() {
    const f = this.data.schoolForm
    if (!f.name) return wx.showToast({ title: '请填写学校名称', icon: 'none' })
    wx.showLoading({ title: '创建中' })
    try {
      // 学校中心点：取当前定位（也可手工填写经纬度）
      let center = null
      try {
        const loc = await new Promise((resolve, reject) => {
          wx.getLocation({ type: 'gcj02', success: resolve, fail: reject })
        })
        center = { lat: loc.latitude, lng: loc.longitude }
      } catch (e) {}
      await app.callApi('createSchool', Object.assign({}, f, { center }))
      await app.refreshUser()
      const school = await app.callApi('getSchool', { schoolId: app.globalData.user.schoolId })
      app.globalData.school = school
      this.setData({ showSchoolForm: false, school })
      wx.showToast({ title: '创建成功', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: e.message || '创建失败', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  bindSchool(e) {
    const id = e.currentTarget.dataset.id
    app.callApi('bindSchool', { schoolId: id })
      .then(() => app.refreshUser())
      .then(() => {
        wx.showToast({ title: '已切换学校', icon: 'success' })
        this.load()
      })
      .catch(err => wx.showToast({ title: err.message, icon: 'none' }))
  },

  toggleSchoolForm() {
    const next = !this.data.showSchoolForm
    this.setData({ showSchoolForm: next })
    if (next) this.loadSchools()
  },

  go(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url })
  },

  goCat(e) {
    wx.navigateTo({ url: '/pages/cat-detail/cat-detail?id=' + e.currentTarget.dataset.id })
  },

  // 图鉴墙：取本校猫档案，已解锁（出现在 catSeen 里）亮显，未解锁灰显
  async loadDex(seenIds) {
    try {
      const res = await app.callApi('listCats', { size: 8 })
      const list = res.list || []
      const dexTotal = res.total || list.length
      const dex = list.slice(0, 8).map(c => ({
        id: c._id,
        name: c.name,
        avatar: c.avatar,
        unlocked: seenIds.indexOf(c._id) >= 0
      }))
      this.setData({
        dex,
        dexTotal,
        dexPercent: dexTotal ? Math.round(seenIds.length / dexTotal * 100) : 0
      })
    } catch (e) {}
  },

  goCats() {
    wx.switchTab({ url: '/pages/cats/cats' })
  },

  previewPhoto(e) {
    wx.previewImage({ current: e.currentTarget.dataset.url, urls: e.currentTarget.dataset.urls })
  },

  // 选择头像（微信 chooseAvatar，返回临时路径 → 上传云存储拿 fileID 入库）
  async onChooseAvatar(e) {
    const { avatarUrl } = e.detail
    if (!avatarUrl) return
    wx.showLoading({ title: '上传中' })
    try {
      const cloudPath = `avatar/${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`
      const up = await wx.cloud.uploadFile({ cloudPath, filePath: avatarUrl })
      const fileID = up.fileID
      this.setData({ 'user.avatarUrl': fileID })
      await app.callApi('updateProfile', { avatarUrl: fileID })
      if (app.globalData.user) app.globalData.user.avatarUrl = fileID
      wx.showToast({ title: '头像已更新', icon: 'success' })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '上传失败', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  // 昵称（input type=nickname，失焦/确认即存）
  onNickName(e) {
    const nickName = (e.detail.value || '').trim()
    if (!nickName) return
    this.setData({ 'user.nickName': nickName })
    app.callApi('updateProfile', { nickName })
      .then(() => { if (app.globalData.user) app.globalData.user.nickName = nickName })
      .catch(err => wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' }))
  }
})
