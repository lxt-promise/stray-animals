// app.js —— 全局入口
// 云开发环境 ID（微信开发者工具 → 云开发 → 环境 ID）
const ENV_ID = 'cloud1-d5goanqd3a600dc8f'

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
    // 还没填真实环境 ID 时，给一句人话提示，避免抛出底层 -501000 Env Not Exists
    if (/x{4,}/.test(ENV_ID)) {
      wx.showModal({
        title: '缺少云环境 ID',
        content: '请把 miniprogram/app.js 顶部的 ENV_ID 替换成微信开发者工具「云开发」里复制的真实环境 ID，再重新编译。',
        showCancel: false
      })
      // 仍放行页面渲染（否则 ensureReady 永远 pending，整页按钮都会“没反应”）；
      // 云调用会明确抛错并 toast，方便定位，而不是静默卡死。
      this.globalData.ready = true
      if (this._readyCallback) this._readyCallback()
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
      wx.showToast({ title: '登录失败：' + (e.message || '未知错误'), icon: 'none' })
    } finally {
      // 必须保证 ready 一定被置位：否则 ensureReady() 永远 pending，
      // 各页面 await 卡死、user 拿不到，表现为「变成爱猫同学 + 数据像全没了」。
      // 因此这里不再调用任何可抛错的副作用（tabBar 由 custom-tab-bar 自行同步）。
      this.globalData.ready = true
      if (this._readyCallback) this._readyCallback()
    }
  },

  // 登录：拿 openid + upsert 用户档案
  async login() {
    const res = await wx.cloud.callFunction({ name: 'catcampus', data: { action: 'login' } })
    if (res && res.errMsg && res.errMsg.indexOf('fail') >= 0) {
      throw new Error('云函数调用失败：' + res.errMsg)
    }
    const r = res.result
    if (!r) throw new Error('云函数无返回（很可能 catcampus 还没部署到当前环境）')
    if (!r.ok) throw new Error((r && r.msg) || '登录失败')
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

  isSuper() {
    const u = this.globalData.user
    return !!(u && u.isSuper)
  },

  refreshUser() {
    return this.login().then(u => {
      this.globalData.user = u
      return u
    })
  }
})
