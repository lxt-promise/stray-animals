// app.js —— 全局入口
// 云开发环境 ID 需替换为你自己的（微信开发者工具 → 云开发 → 环境 ID）
const ENV_ID = 'catcampus-1gxxxxxxxxxx'

App({
  globalData: {
    envId: ENV_ID,
    openid: '',
    user: null,       // { _id, role, schoolId, nickName, avatarUrl, points, catCount }
    school: null,     // { _id, name, campus, center: {lat,lng}, bounds }
    ready: false
  },

  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({ title: '环境不支持', content: '请将微信基础库升级到 2.2.3 以上', showCancel: false })
      return
    }
    wx.cloud.init({ env: ENV_ID, traceUser: true })
    this._boot()
  },

  async _boot() {
    try {
      const user = await this.login()
      this.globalData.user = user
      this.globalData.openid = user.openid
      if (user.schoolId) {
        const school = await this.callApi('getSchool', { schoolId: user.schoolId })
        this.globalData.school = school
      }
    } catch (e) {
      console.error('[boot] 初始化失败', e)
    } finally {
      this.globalData.ready = true
      if (this._readyCallback) this._readyCallback()
    }
  },

  // 登录：拿 openid + upsert 用户档案
  async login() {
    const res = await wx.cloud.callFunction({ name: 'catcampus', data: { action: 'login' } })
    const r = res.result
    if (!r || !r.ok) throw new Error((r && r.msg) || '登录失败')
    return r.data
  },

  // 统一云函数调用
  async callApi(action, payload = {}) {
    const res = await wx.cloud.callFunction({
      name: 'catcampus',
      data: Object.assign({ action }, payload)
    })
    const r = res.result
    if (!r || !r.ok) {
      const err = new Error((r && r.msg) || '请求失败')
      err.code = r && r.code
      throw err
    }
    return r.data
  },

  // 等待全局初始化完成（页面 onLoad 里 await）
  ensureReady() {
    if (this.globalData.ready) return Promise.resolve(this.globalData.user)
    return new Promise(resolve => { this._readyCallback = () => resolve(this.globalData.user) })
  },

  isMember() {
    const u = this.globalData.user
    return !!u && (u.role === 'member' || u.role === 'admin')
  },

  isAdmin() {
    const u = this.globalData.user
    return !!u && u.role === 'admin'
  },

  refreshUser() {
    return this.login().then(u => {
      this.globalData.user = u
      return u
    })
  }
})
