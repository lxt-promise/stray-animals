// app.js —— 全局入口
// 云开发环境 ID（微信开发者工具 → 云开发 → 环境 ID）
const ENV_ID = 'cloud1-d5goanqd3a600dc8f'

App({
  globalData: {
    envId: ENV_ID,
    openid: '',
    user: null,       // { _id, role, schoolId, nickName, avatarUrl, points, catCount }
    school: null,     // { _id, name, campus, center: {lat,lng}, bounds }
    /** 启动时由 homeInit 一并带回来的首页概览；首页直接消费，省掉一次云调用 */
    homeOverview: null,
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
      this._flushReady()
      return
    }
    wx.cloud.init({ env: ENV_ID, traceUser: true })
    this._boot()
  },

  async _boot() {
    try {
      // 快路径：一次云调用拿齐 user + school + 首页概览。
      // 旧链路是 login → getSchool → getOverview 三次串行，冷启动首页统计要等三轮。
      const pack = await this.callApi('homeInit', {})
      this.globalData.user = pack.user
      this.globalData.openid = (pack.user && pack.user.openid) || ''
      this.globalData.school = pack.school
      this.globalData.homeOverview = pack.overview
    } catch (e) {
      // 回落：老链路逐项拉。homeInit 是新接口，线上云函数还没部署时走这里，
      // 不至于因为「后端没更新」就登录不上。
      console.warn('[boot] homeInit 失败，回落逐项登录', e && e.message)
      try {
        const user = await this.login()
        this.globalData.user = user
        this.globalData.openid = user.openid
        if (user.schoolId) {
          const school = await this.callApi('getSchool', { schoolId: user.schoolId })
          this.globalData.school = school
        }
      } catch (e2) {
        console.error('[boot] 初始化失败', e2)
        wx.showToast({ title: '登录失败：' + ((e2 && e2.message) || '未知错误'), icon: 'none' })
      }
    } finally {
      // 必须保证 ready 一定被置位：否则 ensureReady() 永远 pending，
      // 各页面 await 卡死、user 拿不到，表现为「变成爱猫同学 + 数据像全没了」。
      // 因此这里不再调用任何可抛错的副作用（tabBar 由 custom-tab-bar 自行同步）。
      this.globalData.ready = true
      this._flushReady()
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
  // ⚠️ 必须用回调数组：早期写法 `this._readyCallback = cb` 是覆盖语义——
  // 冷启动时两个页面并发 await（首页 onLoad + 用户 1~2 秒内切到猫谱/地图），
  // 第二次调用会覆盖第一次的回调，先 await 的那个 promise 永远 pending，
  // 页面卡在加载态直到手动下拉刷新。慢网络下必现。
  ensureReady() {
    if (this.globalData.ready) return Promise.resolve(this.globalData.user)
    return new Promise(resolve => {
      if (!this._readyCbs) this._readyCbs = []
      this._readyCbs.push(resolve)
    })
  },

  _flushReady() {
    const cbs = this._readyCbs || []
    this._readyCbs = []
    cbs.forEach(cb => cb(this.globalData.user))
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
