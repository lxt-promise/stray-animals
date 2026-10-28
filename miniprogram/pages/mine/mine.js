const app = getApp()
const { C, fromNow, showBusy, hideBusy, isAdminPlus, shareBehavior, sightTagText } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')
const level = require('../../utils/level.js')

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
    stats: { food: 0, sightingCount: 0, catSeen: 0 },
    // 等级称号（由 pointsSummary 回填）。这一页只放称号，不放积分/进度 ——
    // 等级页在 points?type=point（点等级标签进入）。WXML 里不做任何运算/拼接，
    // 全部在这里算好 —— mustache 里的 `a + ' 只'` 会被编译期静默忽略。
    wallet: {
      food: 0, lv: 1, levelName: '猫语新手',
      levelText: 'Lv.1 猫语新手',
      foodToday: 0, foodCap: 50
    },
    // 规则说明：原来常驻页底，改为菜单项点击展开。
    // 文案来自 const.RULES，与「等级」页共用一份 —— 改数值只改一处。
    rules: C.RULES,
    rulesOpen: false,
    // 图鉴收集：只留「已收集/总数」这一个数（进度墙已挪到 pages/dex）。
    // 未绑定学校时这里是空的，界面显示「未绑定学校」而不是 0 / 4。
    dexSummary: { seen: 0, total: 0, text: '未绑定学校' },
    showSchoolForm: false,
    schoolForm: { name: '', campus: '', city: '', intro: '', reason: '' },
    schools: [],
    // picker 用的选项（label 必须预拼好：WXML 的 range-key 只认字段，不做字符串拼接）
    schoolOptions: [],
    // picker 右侧文案（同样在这里拼：mustache 里的字符串相加会被静默忽略）
    schoolPickSide: '加载中',
    // 切换到「附近 25km 内无学校」时为真（附近空列表 → 引导去新建）
    nearbyEmpty: false,
    // 下拉条副文案：也在 JS 里拼好（WXML 不做字符串拼接）
    schoolPickHint: '选中后提交申请，管理员审核通过才绑定',
    // 加入已有学校：选完学校在弹窗里填理由 → 提交申请（不再即选即绑）
    showJoinForm: false,
    joinSchoolId: '',
    joinLabel: '',
    joinReason: '',
    // 我的学校申请状态（pending / rejected），用于显示「审核中 / 被驳回」；
    // 内含 label（join 取 schoolName，create 取 name）与 type
    schoolApply: { pending: null, rejected: null },
    // 工作台（仅超管）：从底部 tab 迁移到「我的」页
    wbOpen: false,
    // 我的打卡：从独立卡片迁移为菜单项，点击菜单项后才展开记录（默认收起）
    myCheckinOpen: false,
    wb: { pendingSighting: 0, todoTnr: 0, openTask: 0, balance: '0.00' },
    loading: true
  },

  onLoad(options) {
    if (options.action === 'school') {
      this.setData({ showSchoolForm: true })
      this.getMyLoc().then(loc => this.loadSchools(false, loc))
    }
    this.load()
  },

  onShow() {
    // tabBar 选中态兜底（见 index.js onShow 注释）
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().refresh()
    // 图鉴页「去绑定学校」：mine 是 tabBar 页，switchTab 不能带 query，
    // 因此由对方先写 globalData，这里消费（与首页「我的打卡」同一模式）
    if (app.globalData.mineAction === 'school') {
      app.globalData.mineAction = ''
      this.openSchoolPicker()
    }
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
        isAdminPlus: isAdminPlus(app),
        // 换校条副文案跟着「有没有绑定」走：不能等 listSchools 回来才正确，
        // 学校列表请求是静默失败的（下拉为空即可），失败时文案会一直停在初始值。
        schoolPickHint: school ? '换校需管理员审核通过后才生效' : '选中后提交申请，管理员审核通过才绑定'
      })
      this.syncUserAvatar()
      // 学校信息以云端为准：globalData 只在启动/创建/绑定时更新，
      // 可能落后于「刚在后台改过的校名/简介」。这里按 id 拉最新，
      // 避免这一页显示旧校名（地图范围由后台配置，本页不再参与）。
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
                app.setSchool(fresh)
              }
            })
            .catch(() => { /* 拉取失败则用缓存 */ })
        )
      }
      if (user) {
        jobs.push(
          app.callApi('listSightings', { mine: true, size: 20 }).then(res => {
            const raw = res.list.map(s => Object.assign({}, s, {
              timeText: fromNow(s.createdAt),
              tagText: sightTagText(s)   // 结构化标签（替代原自由文本 note）
            }))
            this.setData({
              // 打卡照片同样走 https 缩略（原图慢 + cloud:// 在开发者工具里解析不了）
              mySightings: photo.hydrateCats(raw, { photoPx: 320, full: true },
                view => this.setData({ mySightings: view })),
              // 用路径写法只更新这两个字段：food 由 loadWallet() 填、catSeen 由 loadDex() 填，
              // 若这里整体覆盖 stats，几个并发请求谁后到谁生效，会闪一下旧值。
              // 打卡次数是云端派生值，历史上可能为负（后台删他人记录误减），展示层夹到 ≥0。
              'stats.sightingCount': Math.max(0, Number(user.sightingCount) || 0)
            })
          })
        )
        jobs.push(this.loadWallet())
        // 图鉴数只认 listDex 的「本校已收集」——user.catSeen 是跨校累计的，
        // 直接取长度会在换校后大于总数（7 / 4）。
        jobs.push(this.loadDex())
        // 无论是否已绑定都拉一次申请状态：已绑定用户提交「换校」申请后，
        // 也要能看到「审核中」的横幅（否则刷新后以为没提交成功反复提交）。
        jobs.push(this.loadSchoolApply())
        // 管理员及以上才拉工作台概览；失败不影响页面主体
        if (isAdminPlus(app)) jobs.push(this.loadWorkbench())
      }
      // 学校下拉数据随页面一起拉：picker 是原生组件，点开时没法再"先请求后展开"，
      // 必须提前把 range 准备好，否则下拉是空的（用户会以为没有学校可选）。
      // 默认按用户定位过滤到附近 25km（拿不到定位则回退全部）。
      // 定位只决定「是否按 25km 过滤」，是增强项：拿不到就回退全部学校。
      // ⚠️ 必须自己吃掉异常 —— 直接 await 的话一旦取定位抛错，
      // 整个 load() 的 try 会中断，连学校列表都不拉了（下拉变空）。
      let loc = null
      try { loc = await this.getMyLoc() } catch (e) { loc = null }
      jobs.push(this.loadSchools(true, loc))
      await Promise.all(jobs)
      // getSchool 可能带回更新的学校信息（校名/简介在后台被改过），以云端为准
      if (school !== this.data.school) this.setData({ school })
    } catch (e) {
      console.error(e)
      // 不再静默吞错：数据加载失败要让用户看到原因，否则表现为“数据全没了”
      wx.showToast({ title: e.message || '数据加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  /**
   * 账户概览：只取「猫粮值 + 等级称号」。
   *
   * 积分值刻意不在这一页展示 —— 它是等级的依据，点等级标签进等级页看总值。
   * 一页里同时摆余额、等级进度、两套账流水，信息密度过高且和「我的」这个
   * 个人主页的定位不符（用户要的是「我攒了多少猫粮、打了多少次卡」）。
   *
   * ⚠️ 等级文案不再读云端的 level 派生字段（nextMin/nextLv/…）：
   * 云端少下发一个字段，界面就会渲染出「0 / undefined 分」。
   * 现在只取 raw 数据（peakPoints / points / food），等级在 utils/level.js 本地算。
   */
  async loadWallet() {
    try {
      const s = await app.callApi('pointsSummary', {})
      const today = s.today || {}
      const peak = Math.max(Number(s.peakPoints) || 0, Number(s.points) || 0)
      const v = level.levelOf(peak)
      this.setData({
        wallet: {
          food: Number(s.food) || 0,
          lv: v.lv,
          levelName: v.name,
          levelText: v.levelText,
          foodToday: today.food || 0,
          foodCap: today.foodCap || 50
        },
        'stats.food': Number(s.food) || 0
      })
    } catch (e) {
      // 读失败不弹 toast：这是附加信息，页面主体（打卡记录/图鉴）已经加载好了
      console.warn('[mine] 账户概览读取失败', e && e.message)
    }
  },

  /** 点等级标签 → 等级页（points 页的 point 模式）：只显示积分总值与等级进度 */
  goLevelPoints() {
    wx.navigateTo({ url: '/pages/points/points?type=point' })
  },

  /**
   * 点「猫粮值」→ 猫粮流水（points 页的 food 模式）。
   * 三个统计卡各自对应一本账：猫粮 → 流水、打卡 → 猫谱的打卡记录 tab、
   * 图鉴 → 图鉴收集页。都是「点了就有下一个页面」，不能点了没反应。
   */
  goFoodDetail() {
    wx.navigateTo({ url: '/pages/points/points?type=food' })
  },

  /** 规则说明：菜单项点击展开/收起 */
  toggleRules() {
    this.setData({ rulesOpen: !this.data.rulesOpen })
  },

  /**
   * 可选学校列表（下拉框数据源）。
   * label 在这里拼好：WXML 的 picker 只认 range-key 指向的字段，
   * 写 `{{item.name + ' · ' + item.campus}}` 会被编译期静默忽略（项目里踩过）。
   *
   * @param {boolean} silent  随页面静默加载时不弹 toast，用户主动操作再报错
   * @param {object|null} loc  用户定位 {lat,lng}（gcj02）；为空则后端回退全部学校
   *   默认只显示定位 25km 内的学校（后端按内存距离过滤）。
   */
  async loadSchools(silent, loc) {
    try {
      const coords = loc || this._loc || null
      const payload = { currentSchoolId: (this.data.school && this.data.school._id) || '' }
      if (coords) { payload.lat = coords.lat; payload.lng = coords.lng }
      const schools = await app.callApi('listSchools', payload)
      const list = Array.isArray(schools) ? schools : []
      this.setData({
        schools: list,
        schoolOptions: list.map(s => ({
          _id: s._id,
          label: s.campus ? (s.name + ' · ' + s.campus) : s.name
        })),
        // 右侧计数：带定位时强调「附近」，否则回退「共 N 所」
        schoolPickSide: list.length ? (coords ? ('附近 ' + list.length + ' 所') : ('共 ' + list.length + ' 所')) : '暂无学校',
        // 附近（带定位且被半径过滤后）空列表 → 引导去新建
        nearbyEmpty: !!coords && list.length === 0,
        // 副文案按「已绑定 / 未绑定」两种处境给预期说明，带定位时补「仅显示附近 25km 内」
        schoolPickHint: this.pickHint(!!coords)
      })
    } catch (e) {
      // 随页面一起加载时静默失败（下拉为空即可），用户主动操作时再报错
      if (!silent) wx.showToast({ title: '学校列表加载失败', icon: 'none' })
    }
  },

  /** 选校副文案：绑定/未绑定两种处境 + 是否按 25km 过滤 */
  pickHint(byLoc) {
    const base = this.data.school
      ? '换校需管理员审核通过后才生效'
      : '选中后提交申请，管理员审核通过才绑定'
    return byLoc ? (base + '（仅显示附近 25km 内）') : base
  },

  /** 取用户定位并缓存（gcj02）。授权拒绝 / 不支持 → 返回 null，由后端回退全部学校 */
  async getMyLoc() {
    if (this._loc !== undefined) return this._loc
    try {
      const loc = await new Promise((resolve, reject) => {
        wx.getLocation({ type: 'gcj02', success: resolve, fail: reject })
      })
      this._loc = { lat: loc.latitude, lng: loc.longitude }
    } catch (e) {
      this._loc = null
    }
    return this._loc
  },

  /** 打开选校下拉（先按定位刷新列表：别的管理员可能刚建了新学校） */
  async openSchoolPicker() {
    const loc = await this.getMyLoc()
    await this.loadSchools(false, loc)
    if (!this.data.schoolOptions.length) {
      // 附近 25km 内没有学校（或完全没学校）时不弹空下拉，直接引导到「申请新建」
      this.setData({ showSchoolForm: true })
      wx.showToast({ title: loc ? '附近 25km 内暂无学校，可申请新建' : '还没有学校，请申请新建', icon: 'none' })
    }
  },

  /** 选校：打开理由弹窗（学校已存在，但绑定需管理员审核，不再即选即绑） */
  onPickSchool(e) {
    const idx = Number(e.detail.value)
    const opt = (this.data.schoolOptions || [])[idx]
    if (!opt || !opt._id) return
    if (this.data.school && this.data.school._id === opt._id) return
    this.setData({
      showJoinForm: true,
      joinSchoolId: opt._id,
      joinLabel: opt.label,
      joinReason: ''
    })
  },

  /** 理由输入（弹窗里的 textarea 用独立的字段，避免和新建学校表单混在一起） */
  onJoinReason(e) {
    this.setData({ joinReason: (e.detail || {}).value || '' })
  },

  /** 弹窗遮罩内点击不冒泡（避免点到 sheet 关闭弹窗） */
  noop() {},

  /** 取消加入申请 */
  cancelJoinForm() {
    this.setData({ showJoinForm: false, joinSchoolId: '', joinLabel: '', joinReason: '' })
  },

  /** 提交「加入已有学校」申请：填理由 → 落待审 → 显示审核中（不再即选即绑） */
  async submitJoinApply() {
    const schoolId = this.data.joinSchoolId
    const label = this.data.joinLabel
    const reason = (this.data.joinReason || '').trim()
    if (!schoolId) return
    if (!reason) {
      wx.showToast({ title: '请填写申请理由', icon: 'none' })
      return
    }
    showBusy({ title: '提交中' })
    try {
      const r = await app.callApi('applySchool', { schoolId, reason })
      this.setData({ showJoinForm: false, joinReason: '' })
      if (r.status === 'pending') {
        // 已有待审申请（可能是另一条），直接刷新状态
        await this.loadSchoolApply()
        wx.showToast({ title: '已有待审申请，请等待管理员处理', icon: 'none' })
      } else {
        await this.loadSchoolApply()
        wx.showToast({ title: '已提交，等待管理员审核', icon: 'none' })
      }
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '提交失败', icon: 'none' })
    } finally {
      hideBusy()
    }
  },

  /** 我提交学校申请：显示「审核中 / 被驳回」（含 label 与 type） */
  async loadSchoolApply() {
    try {
      const r = await app.callApi('mySchoolApply', {})
      this.setData({
        schoolApply: {
          pending: r.pending || null,
          rejected: r.pending ? null : (r.rejected || null)
        }
      })
    } catch (e) {
      console.warn('[mine] 学校申请状态读取失败', e && e.message)
    }
  },

  /**
   * 提交「新建学校」申请。
   *
   * 普通用户走到这里是**申请**（落 school_applies 等超管审），
   * 超管则直接建校 —— 让超管也排队审核自己的申请没有意义。
   */
  async submitSchoolApply() {
    const f = this.data.schoolForm
    const name = (f.name || '').trim()
    if (!name) return wx.showToast({ title: '请填写学校名称', icon: 'none' })
    const reason = (f.reason || '').trim()
    if (!reason) return wx.showToast({ title: '请填写申请理由', icon: 'none' })
    if (this.data.isSuper) return this.createSchool()

    showBusy({ title: '提交中' })
    try {
      const r = await app.callApi('applySchool', {
        name, campus: f.campus, city: f.city, intro: f.intro, reason
      })
      if (r.status === 'pending') {
        this.setData({ schoolApply: { pending: r.apply || this.data.schoolApply.pending, rejected: null } })
        wx.showToast({ title: '已有待审申请，请等待管理员处理', icon: 'none' })
      } else {
        this.setData({
          showSchoolForm: false,
          schoolApply: { pending: r.apply || { name }, rejected: null }
        })
        wx.showToast({ title: '已提交，等待管理员审核', icon: 'none' })
      }
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '提交失败', icon: 'none' })
    } finally {
      hideBusy()
    }
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

  async createSchool() {
    const f = this.data.schoolForm
    if (!f.name) return wx.showToast({ title: '请填写学校名称', icon: 'none' })
    showBusy({ title: '创建中' })
    try {
      // 建校时只取一次当前定位作为初始中心，避免新学校没有坐标、地图一片空白。
      // 精确的校园范围（中心 + 缩放）由超管在「超级管理后台 → 校园管理」里调。
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
      app.setSchool(school)
      this.setData({ showSchoolForm: false, school, schoolApply: { pending: null, rejected: null } })
      wx.showToast({ title: '创建成功', icon: 'success' })
      this.load()
    } catch (e) {
      wx.showToast({ title: e.message || '创建失败', icon: 'none' })
    } finally {
      hideBusy()
    }
  },

  toggleSchoolForm() {
    const next = !this.data.showSchoolForm
    this.setData({ showSchoolForm: next })
    const f = this.data.schoolForm
    // 驳回过的申请：重新打开表单时把上次填的带到输入框（用户不必再敲一遍）
    if (next && !f.name && this.data.schoolApply.rejected) {
      const r = this.data.schoolApply.rejected
      this.setData({
        schoolForm: {
          name: r.name || '', campus: r.campus || '', city: r.city || '',
          intro: r.intro || '', reason: r.reason || ''
        }
      })
    }
    if (next) this.loadSchools(false, this._loc)
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
  // 与首页「我的打卡」同一模式：先写 globalData，由 cats 页 onShow 消费
  goCatsSighting() {
    app.globalData.catsTab = 'sighting'
    wx.switchTab({ url: '/pages/cats/cats' })
  },

  goCat(e) {
    wx.navigateTo({ url: '/pages/cat-detail/cat-detail?id=' + e.currentTarget.dataset.id })
  },

  /**
   * 图鉴收集摘要（只取计数，不拉清单）。
   *
   * 为什么不在这一页铺开图鉴墙：「我的」页要的是「我有什么」，
   * 而图鉴墙是一屏要滑的内容，塞在这里会把打卡/菜单挤到很下面。
   * 现在只留一个入口（图鉴收集），点进去看完整进度与解锁墙。
   *
   * 口径以云端 listDex 为准：**按本校统计**。
   * 之前这里取的是 user.catSeen.length（跨校累计），新用户没绑学校时
   * 还会用 listCats 拉到别校的猫，于是显示「0 / 4」—— 既不是他的图鉴，
   * 也根本不该有进度条。
   */
  async loadDex() {
    try {
      const r = await app.callApi('listDex', { brief: true })
      const seen = Number(r.seen) || 0
      const total = Number(r.total) || 0
      let text = '未绑定学校'
      if (!r.needSchool) text = total ? (seen + ' / ' + total) : '本校暂无档案'
      this.setData({
        dexSummary: { seen, total, text },
        // 三格统计里的「图鉴数」也用本校口径，和入口上的数字保持一致
        'stats.catSeen': seen
      })
    } catch (e) {
      // 附加信息，失败不影响页面主体（打卡记录 / 菜单）
      console.warn('[mine] 图鉴摘要读取失败', e && e.message)
    }
  },

  /** 图鉴收集页 */
  goDex() {
    wx.navigateTo({ url: '/pages/dex/dex' })
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
