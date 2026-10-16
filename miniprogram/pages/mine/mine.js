const app = getApp()
const { C, fromNow, showBusy, hideBusy, isAdminPlus, shareBehavior } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')

Page(Object.assign({
  data: {
    user: null,
    school: null,
    isMember: false,
    isAdmin: false,
    isSuper: false,
    // 管理员及以上（含超管）：显示工作台、建档入口等
    isAdminPlus: false,
    mySightings: [],
    stats: { points: 0, sightingCount: 0, catSeen: 0 },
    dex: [],
    dexTotal: 0,
    dexPercent: 0,
    showSchoolForm: false,
    schoolForm: { name: '', campus: '', city: '', intro: '' },
    schools: [],
    // 工作台（仅超管）：从底部 tab 迁移到「我的」页
    wbOpen: false,
    // 我的打卡：从独立卡片迁移为菜单项，点击菜单项后才展开记录（默认收起）
    myCheckinOpen: false,
    wb: { pendingSighting: 0, todoTnr: 0, openTask: 0, balance: '0.00' },
    // 地图范围：缩放级别（越大越近，校园可视范围越小）
    schoolScale: 16,
    scaleOptions: [
      { value: 14, label: '14 · 整个校区' },
      { value: 15, label: '15 · 较大范围' },
      { value: 16, label: '16 · 推荐' },
      { value: 17, label: '17 · 局部区域' },
      { value: 18, label: '18 · 单栋楼附近' }
    ],
    scaleIndex: 2,
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
    // tabBar 选中态兜底（见 index.js onShow 注释）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().refresh()
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
      let school = app.globalData.school
      this.setData({
        user,
        school,
        isMember: app.isMember(),
        isAdmin: app.isAdmin(),
        isSuper: !!(user && user.isSuper),
        isAdminPlus: isAdminPlus(app)
      })
      this.syncUserAvatar()
      // 学校信息以云端为准：globalData 只在启动/创建/绑定时更新，
      // 可能落后于「刚在别处（或本端）改过的地图范围」。这里按 id 拉最新，
      // 避免 picker 显示旧 scale、地图页读到旧 bounds 造成「改了又变回去」。
      //
      // 下面四件事互不依赖（listDex 只用 user.catSeen，同步可取），一次性并行：
      // 原来是 getSchool → listSightings → loadDex → loadWorkbench 四次串行往返，
      // 「我的」页要等 3~4 个 RTT 才出全；并行后约等于单次 RTT。
      const jobs = []
      if (school && school._id) {
        jobs.push(
          app.callApi('getSchool', { schoolId: school._id })
            .then(fresh => {
              if (fresh) {
                school = fresh
                app.globalData.school = fresh
              }
            })
            .catch(() => { /* 拉取失败则用缓存 */ })
        )
      }
      if (user) {
        const seenIds = user.catSeen || []
        jobs.push(
          app.callApi('listSightings', { mine: true, size: 20 }).then(res => {
            const raw = res.list.map(s => Object.assign({}, s, { timeText: fromNow(s.createdAt) }))
            this.setData({
              // 打卡照片同样走 https 缩略（原图慢 + cloud:// 在开发者工具里解析不了）
              mySightings: photo.hydrateCats(raw, { photoPx: 320, full: true },
                view => this.setData({ mySightings: view })),
              stats: {
                points: user.points || 0,
                sightingCount: user.sightingCount || 0,
                catSeen: seenIds.length
              }
            })
          })
        )
        jobs.push(this.loadDex(seenIds))
        // 管理员及以上才拉工作台概览；失败不影响页面主体
        if (isAdminPlus(app)) jobs.push(this.loadWorkbench())
      }
      await Promise.all(jobs)
      // getSchool 可能带回更新的学校信息（含范围/缩放），与 picker 一起同步
      const patch = {}
      if (school !== this.data.school) patch.school = school
      if (school && school.scale) {
        const idx = this.data.scaleOptions.map(o => o.value).indexOf(school.scale)
        patch.schoolScale = school.scale
        patch.scaleIndex = idx >= 0 ? idx : 2
      }
      if (Object.keys(patch).length) this.setData(patch)
    } catch (e) {
      console.error(e)
      // 不再静默吞错：数据加载失败要让用户看到原因，否则表现为“数据全没了”
      wx.showToast({ title: e.message || '数据加载失败', icon: 'none' })
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

  // 工作台概览（仅超管调用）：待建档目击 / 待抓捕 TNR / 待认领任务 / 资金结余
  async loadWorkbench() {
    try {
      const [pending, tnr, tasks, funds] = await Promise.all([
        app.callApi('listSightings', { pending: true, size: 50 }),
        app.callApi('listTnr', {}),
        app.callApi('listTasks', {}),
        app.callApi('listFunds', {})
      ])
      this.setData({
        wb: {
          pendingSighting: (pending.list || []).length,
          // listTnr 返回 { list, flow }；listTasks 直接是数组
          todoTnr: ((tnr && tnr.list) || []).filter(t => t.status === 'todo' || t.status === 'trapping').length,
          openTask: (tasks || []).filter(t => t.status === 'open').length,
          balance: ((funds.summary.income - funds.summary.expense) || 0).toFixed(2)
        }
      })
    } catch (e) {
      console.warn('[workbench] 概览加载失败', e)
    }
  },

  toggleWb() {
    this.setData({ wbOpen: !this.data.wbOpen })
  },

  // 我的打卡：菜单项点击 → 展开/收起记录卡片（数据在 load() 时已拉好，展开无延迟）
  toggleMyCheckin() {
    this.setData({ myCheckinOpen: !this.data.myCheckinOpen })
  },

  onInput(e) {
    const { key } = e.currentTarget.dataset
    this.setData({ ['schoolForm.' + key]: e.detail.value })
  },

  onScaleChange(e) {
    const idx = Number(e.detail.value) || 0
    this.setData({ scaleIndex: idx, schoolScale: this.data.scaleOptions[idx].value })
  },

  /**
   * 只改「地图范围（缩放级别）」：
   * 原来只改 picker 不落库，用户以为改了、其实云端没动，再进地图还是老范围。
   * 这里显式带上当前中心点调用 updateSchool，改完立即反映到地图页。
   */
  async saveScale() {
    const school = this.data.school
    if (!school || !school._id) return wx.showToast({ title: '请先创建 / 绑定学校', icon: 'none' })
    if (!this._centerValid(school.center)) {
      // 没有中心点时只写 scale 会被云端拒（缺中心无法推算范围），明确引导而不是静默失败
      return wx.showToast({ title: '请先「选择地图中心点」', icon: 'none' })
    }
    showBusy({ title: '保存中' })
    try {
      const updated = await app.callApi('updateSchool', {
        schoolId: school._id,
        // 显式带上中心点：只要带中心，云端就会按「新中心 + 新缩放」重算范围
        center: { lat: school.center.lat, lng: school.center.lng },
        scale: this.data.schoolScale || 16
      })
      const merged = Object.assign({}, school, updated || {}, { _id: school._id })
      app.globalData.school = merged
      this.setData({ school: merged })
      wx.showToast({ title: '范围已更新', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' })
    } finally {
      hideBusy()
    }
  },

  /** 判断一个坐标是否可用（有限数字才算，NaN 会把 bounds 全算坏） */
  _centerValid(c) {
    return !!(c && typeof c.lat === 'number' && typeof c.lng === 'number' &&
      isFinite(c.lat) && isFinite(c.lng))
  },

  /** 超管：设置当前学校的地图中心与缩放（地图只展示这块区域） */
  async setSchoolCenter() {
    const school = this.data.school
    if (!school) return wx.showToast({ title: '请先创建 / 绑定学校', icon: 'none' })
    if (!school._id) {
      // 历史数据可能没有 _id（不应发生），明确报错而不是静默失败
      return wx.showToast({ title: '学校数据异常，缺少 ID', icon: 'none' })
    }
    // 起选点地图时优先落在「已保存的中心」，没有才退到默认值。
    // ⚠️ 以前这里写的是 (school.center.lat) || 32.0585 —— 一旦 school.center 为
    // undefined 就会直接抛 TypeError，setSchoolCenter 整个中断、连提示都没有，
    // 用户看到的就是「点了没反应 / 改了不生效」。
    const startC = this._centerValid(school.center) ? school.center : { lat: 32.0585, lng: 118.7965 }
    let loc
    try {
      loc = await new Promise((resolve, reject) => {
        wx.chooseLocation({
          latitude: startC.lat,
          longitude: startC.lng,
          success: resolve,
          fail: reject
        })
      })
    } catch (e) {
      console.warn('[setSchoolCenter] 取消或失败', e)
      // 区分「用户主动取消」与「真失败」，避免用户以为点了没反应
      const msg = (e && (e.errMsg || e.message)) || ''
      if (msg && msg.indexOf('cancel') < 0 && msg.indexOf('取消') < 0) {
        wx.showToast({ title: '打开地图失败：' + msg, icon: 'none' })
      }
      return
    }
    // chooseLocation 返回 latitude/longitude，缺失时明确提示
    if (!loc || !this._centerValid({ lat: loc.latitude, lng: loc.longitude })) {
      return wx.showToast({ title: '未取到坐标，请重选', icon: 'none' })
    }
    // ⚠️ 关键修复：原来这里写了 `center: {...} || { lat: loc.latitude, ... }` 兜底，
    // 而左侧永远是真值 —— 用户明明选了新中心点，实际提交的却是兜底常量，
    // 于是「选了中心点却始终是默认值」。
    // 现在直接提交 chooseLocation 返回的真实坐标，不再有任何兜底覆盖。
    const center = { lat: Number(loc.latitude), lng: Number(loc.longitude) }
    showBusy({ title: '保存中' })
    try {
      const updated = await app.callApi('updateSchool', {
        schoolId: school._id,
        center,
        // 选择器的缩放决定可视跨度：默认 16，可按校园大小微调
        scale: this.data.schoolScale || 16
      })
      const merged = Object.assign({}, school, updated || {}, { _id: school._id })
      app.globalData.school = merged
      this.setData({ school: merged })
      console.log('[setSchoolCenter] 已保存 center=', JSON.stringify(merged.center),
        'bounds=', JSON.stringify(merged.bounds), 'scale=', merged.scale)
      wx.showToast({ title: '地图范围已更新', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' })
    } finally {
      hideBusy()
    }
  },

  async createSchool() {
    const f = this.data.schoolForm
    if (!f.name) return wx.showToast({ title: '请填写学校名称', icon: 'none' })
    showBusy({ title: '创建中' })
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
      hideBusy()
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
    const url = e.currentTarget.dataset.url
    // 纵深防御：tabBar 页（index/cats/map/mine）用 navigateTo 会被微信静默拒绝，
    // 表现为「点了没反应」。命中 tabBar 页自动改走 switchTab。
    const TAB_PAGES = ['/pages/index/index', '/pages/cats/cats', '/pages/map/map', '/pages/mine/mine']
    const bare = (url || '').split('?')[0]
    if (TAB_PAGES.indexOf(bare) >= 0) {
      wx.switchTab({ url: bare })
      return
    }
    wx.navigateTo({ url })
  },

  // 目击建档入口：cats 是 tabBar 页，且要带 tab 参数 —— switchTab 不支持 query，
  // 与首页「最新动态」同一模式：先写 globalData，由 cats 页 onShow 消费
  goCatsSighting() {
    app.globalData.catsTab = 'sighting'
    wx.switchTab({ url: '/pages/cats/cats' })
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
      // 图鉴头像必须先换 https 再渲染：直接把 cloud:// fileID 塞进 <image>，
      // 开发者工具会报 pageframe 加载失败、他人上传的私有文件也读不出来
      //（表现：同一排里自己的猫有图、别人的猫是空框）。
      const raw = list.slice(0, 8).map(c => ({
        id: c._id,
        name: c.name,
        avatar: c.avatar,
        unlocked: seenIds.indexOf(c._id) >= 0
      }))
      const view = await photo.hydrateCatsAsync(raw, { px: 200 })
      const dex = view.map(v => ({
        id: v.id,
        name: v.name,
        avatar: v.avatar || '',
        unlocked: v.unlocked
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

  /** 我的头像：user.avatarUrl 是 cloud:// fileID（提交/回滚都要用原始值，
   *  所以另开 avatarView 只作展示）。直接塞进 <image> 在开发者工具会报
   *  pageframe 加载失败，先换 https 再渲染。 */
  async syncUserAvatar() {
    const raw = ((this.data.user || {}).avatarUrl) || ''
    if (photo.isFileId(raw)) await photo.warm([raw])
    this.setData({ avatarView: photo.display(raw, 200) })
  },

  /** 图鉴头像加载失败：去参数重试 → 置空退 🐱 占位（不触发整页重载） */
  onDexAvatarErr(e) {
    const i = Number((e.currentTarget.dataset || {}).i || 0)
    const item = (this.data.dex || [])[i]
    if (!item || !item.avatar) return
    const key = 'dex[' + i + '].avatar'
    if (photo.hasProcess(item.avatar)) this.setData({ [key]: photo.stripProcess(item.avatar) })
    else this.setData({ [key]: '' })
  },

  /** 打卡缩略图加载失败：去参数重试 → 换临时链接 → 隐藏（不触发整页重载） */
  async onMyPhotoErr(e) {
    const ds = e.currentTarget.dataset || {}
    const i = Number(ds.i || 0)
    const j = Number(ds.j || 0)
    const key = 'mySightings[' + i + '].photosSmall[' + j + ']'
    const item = (this.data.mySightings || [])[i]
    const cur = ((item && item.photosSmall) || [])[j]
    if (!cur) return
    if (photo.hasProcess(cur)) { this.setData({ [key]: photo.stripProcess(cur) }); return }
    const rid = ((item && item.photos) || [])[j]
    if (photo.isFileId(rid)) {
      const u = await photo.resolve(rid)
      if (u) { this.setData({ [key]: photo.thumb(u, 320) }); return }
    }
    this.setData({ [key]: '' })
  },

  // 选择头像（微信 chooseAvatar，返回临时路径 → 上传云存储拿 fileID 入库）
  async onChooseAvatar(e) {
    const { avatarUrl } = e.detail
    if (!avatarUrl) return
    // 先落库再 setData：早期写法先 setData 后调用，失败时界面已是新头像、
    // 云端还是旧的，toast 报失败但用户看到的是成功态（账实不符）
    const prev = this.data.user.avatarUrl
    showBusy({ title: '上传中' })
    try {
      const cloudPath = `avatar/${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`
      const up = await wx.cloud.uploadFile({ cloudPath, filePath: avatarUrl })
      const fileID = up.fileID
      await app.callApi('updateProfile', { avatarUrl: fileID })
      this.setData({ 'user.avatarUrl': fileID })
      if (app.globalData.user) app.globalData.user.avatarUrl = fileID
      this.syncUserAvatar()
      wx.showToast({ title: '头像已更新', icon: 'success' })
    } catch (err) {
      this.setData({ 'user.avatarUrl': prev })   // 回滚到云端现值
      this.syncUserAvatar()
      wx.showToast({ title: (err && err.message) || '上传失败', icon: 'none' })
    } finally {
      hideBusy()
    }
  },

  // 昵称（input type=nickname，失焦/确认即存）
  onNickName(e) {
    const nickName = (e.detail.value || '').trim()
    if (!nickName) return
    const prev = this.data.user.nickName
    app.callApi('updateProfile', { nickName })
      .then(() => {
        this.setData({ 'user.nickName': nickName })
        if (app.globalData.user) app.globalData.user.nickName = nickName
      })
      .catch(err => {
        this.setData({ 'user.nickName': prev })   // 保存失败不改变界面
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' })
      })
  }
// 「我的」页本身没什么可看，转发统一落到首页：既不失分享能力，也避免把
// 个人信息页丢给别人打开后被登录态拦下的尴尬。
}, shareBehavior({
  title: '喵园 · 一起照顾校园里的流浪猫',
  path: '/pages/index/index'
})))
