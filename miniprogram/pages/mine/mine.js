const app = getApp()
const { C, fromNow, showBusy, hideBusy, isAdminPlus, shareBehavior, maskAccount } = require('../../utils/util.js')
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
    stats: { food: 0, sightingCount: 0, catSeen: 0 },
    // 等级称号（由 pointsSummary 回填）。这一页只放称号，不放积分/进度 ——
    // 等级页在 points?type=point（点等级标签进入）。WXML 里不做任何运算/拼接，
    // 全部在这里算好 —— mustache 里的 `a + ' 只'` 会被编译期静默忽略。
    wallet: {
      food: 0, lv: 1, levelName: '猫语新手',
      levelText: 'Lv.1 猫语新手',
      foodToday: 0, foodCap: 50
    },
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
    // 附近无学校时为真（附近空列表 → 引导去新建）
    nearbyEmpty: false,
    // 下拉条副文案：也在 JS 里拼好（WXML 不做字符串拼接）。
    // 初始留空：审核模式 / 免审模式的文案要等 `mySchoolApply.policy` 回来才能定，
    // 先写死一句「需审核」的话，免审部署的用户会先看到一条错误预期。
    schoolPickHint: '',
    // 加入已有学校：选完学校在弹窗里填理由 → 提交申请（不再即选即绑）
    showJoinForm: false,
    joinSchoolId: '',
    joinLabel: '',
    joinReason: '',
    // 我的学校申请状态（pending / rejected），用于显示「审核中 / 被驳回」；
    // 内含 label（join 取 schoolName，create 取 name）与 type
    schoolApply: { pending: null, rejected: null },
    loading: true,
    // 学校申请防重：已有一条待审申请时锁住「选校 / 新建」入口。
    // 待审期间保持原绑定，允许重复提交只会把审核列表刷满（用户反馈「可以点多次不合理」）。
    applyLocked: false,
    // 绑校 / 建校是否需要管理员审核（**服务端开关**，推广期默认免审）。
    // 由 `mySchoolApply.policy` 下发，这里只是界面依据 —— 真正的判定在云端，
    // 前端改这个值也绕不过服务端的 `SCHOOL_REVIEW`。
    // 默认值取「需要审核」：万一 policy 拉取失败，界面退化成审核模式
    // （多填一个理由）也好过退化成免审（服务端要求理由 → 用户直接卡死）。
    // canCreate：**建校权限**（仅管理员）。与「免不免审」是两件事 ——
    // 推广期免审放开的是「绑定已有学校」，建校始终只有管理员能建
    // （人人能建校会把下拉刷满，用户反而选不到自己的学校）。
    schoolPolicy: { reviewBind: true, reviewCreate: true, canCreate: false, mode: '' },
    // 提交中标志：防连点（按钮 disabled + 函数入口二次判断，双保险）
    submitting: false,
    // 未读通知数（超管）：有人提交入校/建校申请时给红点
    noticeUnread: 0,
    // 账号安全：仅作「我的」页账号信息展示；设置/修改入口在独立页面 /pages/account/account
    acct: { hasAccount: false, accountMask: '', phone: '' },
    // 完善资料弹窗（昵称 + 头像）：进入「我的」时若昵称为空或仍是默认值，引导设置一次
    pg: { visible: false, nickName: '', avatarUrl: '' },
    // 测试身份横幅（超管专用）：非空表示正以该账号身份浏览。
    // 放在最上面，避免「切到测试账号后忘了」，把对方的数据误当成自己的丢了。
    actingName: ''
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
        acct: {
          hasAccount: !!(user && user.account),
          accountMask: user && user.account ? maskAccount(user.account) : '',
          phone: (user && user.phone) || ''
        },
        // 换校条副文案：默认空。内部规则（免审/审核机制）不对普通用户展示，一律中性话术
        schoolPickHint: '',
        // 测试身份：非空就显示顶部横幅 + 退出入口
        actingName: app.globalData.actAs ? (app.globalData.actAsLabel || '测试账号') : ''
      })
      this.syncUserAvatar()
      // 进入「我的」：昵称还是默认值 / 空的，弹一次「完善资料」引导设置（区分用户用）
      this.maybeProfileGate()
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
        // 打卡次数（云端派生值，历史上可能为负，展示层夹到 ≥0）。
        // 「我的打卡记录」已迁到独立页面 pages/my-sightings，这里只保留三格统计与
        // 菜单项上的「共 N 次」计数；不再由「我的」页拉取整份打卡列表（避免每次进页多一次请求）。
        this.setData({ 'stats.sightingCount': Math.max(0, Number(user.sightingCount) || 0) })
        jobs.push(this.loadWallet())
        // 图鉴数只认 listDex 的「本校已收集」——user.catSeen 是跨校累计的，
        // 直接取长度会在换校后大于总数（7 / 4）。
        jobs.push(this.loadDex())
        // 无论是否已绑定都拉一次申请状态：已绑定用户提交「换校」申请后，
        // 也要能看到「审核中」的横幅（否则刷新后以为没提交成功反复提交）。
        jobs.push(this.loadSchoolApply())
        // 未读通知只推给超管，普通用户拉也是空，不必多花这一次云调用；
        // 红点用于「工作台」菜单项的待审申请提示
        if (user && user.isSuper) jobs.push(this.loadNotices())
      }
      // 学校下拉数据随页面一起拉：picker 是原生组件，点开时没法再"先请求后展开"，
      // 必须提前把 range 准备好，否则下拉是空的（用户会以为没有学校可选）。
      // 默认按用户定位过滤到附近（半径由服务端定，界面不再展示具体数字）。
      // 定位只决定「是否按距离过滤」，是增强项：拿不到就回退全部学校。
      // ⚠️ 必须自己吃掉异常 —— 直接 await 的话一旦取定位抛错，
      // 整个 load() 的 try 会中断，连学校列表都不拉了（下拉变空）。
      let loc = null
      try { loc = await this.getMyLoc() } catch (e) { loc = null }
      jobs.push(this.loadSchools(true, loc))
      await Promise.all(jobs)
      // getSchool 可能带回更新的学校信息（校名/简介在后台被改过），以云端为准
      if (school !== this.data.school) this.setData({ school })
      // 待审锁的收口：loadSchoolApply 与 loadSchools 是并行的，谁先返回不确定。
      // 若 loadSchools 后返回，它会把侧边文案盖回「共 N 所」，锁就白设了。
      if (this.data.applyLocked) this.setData({ schoolPickSide: '待审中' })
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

  /**
   * 可选学校列表（下拉框数据源）。
   * label 在这里拼好：WXML 的 picker 只认 range-key 指向的字段，
   * 写 `{{item.name + ' · ' + item.campus}}` 会被编译期静默忽略（项目里踩过）。
   *
   * @param {boolean} silent  随页面静默加载时不弹 toast，用户主动操作再报错
   * @param {object|null} loc  用户定位 {lat,lng}（gcj02）；为空则后端回退全部学校
   *   默认只显示附近的学校（后端按内存距离过滤，半径由服务端定）。
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
        nearbyEmpty: !!coords && list.length === 0
      })
    } catch (e) {
      // 随页面一起加载时静默失败（下拉为空即可），用户主动操作时再报错
      if (!silent) wx.showToast({ title: '学校列表加载失败', icon: 'none' })
    }
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
    // 已有一条待审申请：直接挡住，不再进入选校流程。
    // 否则用户能一直提交，超管的审核列表会被同一批人刷满（用户反馈「可以点多次不合理」）。
    if (this.data.applyLocked) {
      wx.showToast({ title: '已有待审申请，请等待处理', icon: 'none' })
      return
    }
    // 绑校软引导：未补全手机号时弹一次非拦截提示（不阻断选择）
    if (app.maybeGuidePhone) app.maybeGuidePhone()
    const loc = await this.getMyLoc()
    await this.loadSchools(false, loc)
    if (!this.data.schoolOptions.length) {
      // 附近没有学校（或完全没学校）时不弹空下拉，直接引导到「新建」。
      // ⚠️ 建校是管理员专属：普通人不该被推进一个填完就 403 的表单。
      const canCreate = this.data.schoolPolicy.canCreate
      if (canCreate) this.setData({ showSchoolForm: true })
      wx.showToast({
        title: canCreate
          ? (loc ? '附近暂无学校，可创建本校' : '还没有学校，请创建本校')
          : '附近暂无学校，请联系管理员添加',
        icon: 'none'
      })
    }
  },

  /**
   * 选中学校后的分流：
   *  - 管理员：直接绑定（免审）——管理员本就是各校数据维护者，让他给自己提申请没意义
   *  - 普通用户 + 推广期免审（`policy.reviewBind === false`）：直接绑定，立即生效
   *  - 普通用户 + 审核模式：打开理由弹窗，落待审申请，超管通过后才绑定
   *
   * 免不免审由服务端的 `SCHOOL_REVIEW` 决定（经 `mySchoolApply.policy` 下发），
   * 前端只据此决定弹不弹理由框 —— 改前端的 policy 也绕不过服务端判定。
   */
  onPickSchool(e) {
    const idx = Number(e.detail.value)
    const opt = (this.data.schoolOptions || [])[idx]
    if (!opt || !opt._id) return
    if (this.data.school && this.data.school._id === opt._id) {
      wx.showToast({ title: '已经在这所学校了', icon: 'none' })
      return
    }
    if (this.data.isAdminPlus || !this.data.schoolPolicy.reviewBind) return this.bindSchoolDirect(opt)
    this.setData({
      showJoinForm: true,
      joinSchoolId: opt._id,
      joinLabel: opt.label,
      joinReason: ''
    })
  },

  /**
   * 直绑 / 换校（免审）。
   *
   * 走哪个接口按身份分流：
   *  - 管理员 → `bindSchoolSelf`（`role:'admin'`，由服务端校验，普通用户调不通）；
   *  - 普通用户 → `applySchool`（服务端按 `SCHOOL_REVIEW` 判定，免审则立即绑定）。
   *
   * 换校会切换整页数据口径（图鉴/打卡/地图都按学校统计），所以先确认一次；
   * 绑定后必须 `refreshUser` + `setSchool`，否则 globalData 里还是旧校，
   * 首页/地图会继续按老学校拉数据，表现为「换了学校但什么都没变」。
   */
  async bindSchoolDirect(opt) {
    if (this.data.submitting) return
    const ok = await new Promise(resolve => {
      wx.showModal({
        title: '切换学校',
        content: '切换到「' + opt.label + '」？切换后立即生效。',
        confirmText: '切换',
        success: r => resolve(!!r.confirm),
        fail: () => resolve(false)
      })
    })
    if (!ok) return
    this.setData({ submitting: true })
    showBusy({ title: '切换中' })
    try {
      const action = this.data.isAdminPlus ? 'bindSchoolSelf' : 'applySchool'
      const r = await app.callApi(action, { schoolId: opt._id })
      // 服务端其实还在审核模式（policy 是旧的 / 运营刚把开关改回 on）：
      // 拿到的是「已提交待审」而不是「已绑定」，这时绝不能当切换成功 ——
      // 用户会以为换好了，实际还挂着一条没人审的申请。
      if (r && r.status && r.status !== 'bound') {
        await this.loadSchoolApply()
        wx.showToast({ title: '已提交，等待管理员审核', icon: 'none' })
        return
      }
      await this.afterSchoolBound(opt._id, opt.label)
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '切换失败', icon: 'none' })
    } finally {
      hideBusy()
      this.setData({ submitting: false })
    }
  },

  /**
   * 绑定生效后的统一收尾：刷新全局用户 + 全局学校 + 整页重拉。
   *
   * 三处入口（管理员直绑 / 免审选校 / 免审建校）都必须走这里 ——
   * 分开写迟早有一份漏掉 `setSchool`，表现为「学校换成功了但数据没换」。
   */
  async afterSchoolBound(schoolId, label, toastText) {
    await app.refreshUser()
    const school = await app.callApi('getSchool', { schoolId })
    app.setSchool(school)
    const full = school
      ? (school.campus ? school.name + ' · ' + school.campus : school.name)
      : label
    this.setData({
      school,
      // 直绑会把本人待审一并撤回，横幅要立刻消失，不能等下次进页面
      schoolApply: { pending: null, rejected: null },
      applyLocked: false
    })
    wx.showToast({ title: toastText || ('已切换到「' + full + '」'), icon: 'none' })
    // 换校后整页数据口径变了：图鉴/打卡/工作台全部重拉
    this.load()
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
    // 防连点：showBusy 只是遮罩，按钮不 disabled 的话快速点两下会发出两个请求
    if (this.data.submitting) return
    const schoolId = this.data.joinSchoolId
    const reason = (this.data.joinReason || '').trim()
    if (!schoolId) return
    if (!reason) {
      wx.showToast({ title: '请填写申请理由', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    showBusy({ title: '提交中' })
    try {
      const r = await app.callApi('applySchool', { schoolId, reason })
      this.setData({ showJoinForm: false, joinReason: '' })
      if (r.status === 'pending') {
        // 后端已有一条待审（reason 区分「刚提交」与「早有待审」）
        await this.loadSchoolApply()
        wx.showToast({ title: '已有待审申请，请等待管理员处理', icon: 'none' })
      } else {
        // 锁不锁一律由 loadSchoolApply 判定（管理员免审 → 不锁）。
        // 这里再单独 setData 一次就是第二套判定源，两处迟早不一致。
        await this.loadSchoolApply()
        wx.showToast({ title: '已提交，等待管理员审核', icon: 'none' })
      }
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '提交失败', icon: 'none' })
    } finally {
      hideBusy()
      this.setData({ submitting: false })
    }
  },

  /** 我提交学校申请：显示「审核中 / 被驳回」（含 label 与 type） */
  async loadSchoolApply() {
    try {
      const r = await app.callApi('mySchoolApply', {})
      const pending = r.pending || null

      // 审核开关由服务端下发（推广期免审）。显式 `=== true`：`policy` 字段缺省时
      // 保持「需要审核」的保守值，不能因为 undefined 被当成免审。
      const p = (r && r.policy && typeof r.policy === 'object') ? r.policy : null
      const reviewBind = p ? p.reviewBind === true : this.data.schoolPolicy.reviewBind
      const reviewCreate = p ? p.reviewCreate === true : this.data.schoolPolicy.reviewCreate
      // 建校权限：服务端下发。**老版本云函数没有 canCreate 字段**，此时按本地身份推断
      // （管理员本来就该能建），否则一次接口升级就会让管理员的建校入口凭空消失。
      const canCreate = p
        ? p.canCreate === true
        : (this.data.schoolPolicy.canCreate || isAdminPlus(app))

      const patch = {
        schoolApply: {
          pending,
          rejected: pending ? null : (r.rejected || null)
        },
        schoolPolicy: { reviewBind, reviewCreate, canCreate, mode: (p && p.mode) || '' },
        // 有待审 = 锁住选校 / 新建入口（待审期间保持原绑定，不能再提交）。
        // 管理员不锁：他可以免审直绑，锁住反而让他换不了学校，只能干等自己那条申请。
        // 全免审模式下待审已经不会产生，旧 pending 也不该再把人锁死在外面。
        applyLocked: !!pending && !isAdminPlus(app) && (reviewBind || reviewCreate)
      }
      // 免审时给一句预期说明（管理员有自己的文案，别覆盖）
      if (!isAdminPlus(app) && !reviewBind) patch.schoolPickHint = '选择后立即生效，可随时切换'
      this.setData(patch)
      // 审核通过要立刻生效：handleSchoolApply 只改了云端 user.schoolId，
      // 本端 globalData 还是旧校，用户会看到「申请已通过」但整页数据仍是老学校，
      // 表现为「审核通过了却什么都没变」。这里补一次同步。
      // 用「上次同步过的 schoolId」而不是布尔位做去重：同一条申请只同步一次，
      // 但用户之后再申请、再被通过换到另一所学校时还能生效。
      const approved = r.approved || null
      if (!pending && approved && approved.schoolId && this._syncedSchoolId !== approved.schoolId) {
        const cur = (this.data.school && this.data.school._id) || ''
        if (cur !== approved.schoolId) {
          this._syncedSchoolId = approved.schoolId
          await app.refreshUser()
          const school = await app.callApi('getSchool', { schoolId: approved.schoolId })
          app.setSchool(school)
          this.setData({ school })
          this.load()
        }
      }
    } catch (e) {
      console.warn('[mine] 学校申请状态读取失败', e && e.message)
    }
  },

  /**
   * 撤回待审申请。
   *
   * 这是「待审期间锁入口」的另一半：只锁不给撤销，用户改主意或管理员长期不审时
   * 就彻底卡死（既不能换校也不能重建）。撤回只改自己状态为 pending 的那条，
   * 已被通过的申请撤不回来（服务端条件更新会返回 409）。
   */
  async withdrawApply() {
    const p = this.data.schoolApply && this.data.schoolApply.pending
    if (!p || !p._id) return
    const ok = await new Promise(resolve => {
      wx.showModal({
        title: '撤回申请',
        content: '撤回「' + (p.label || '该校') + '」的申请？撤回后可以重新选择其他学校。',
        confirmText: '撤回',
        success: r => resolve(!!r.confirm),
        fail: () => resolve(false)
      })
    })
    if (!ok) return
    showBusy({ title: '撤回中' })
    try {
      await app.callApi('withdrawSchoolApply', { id: p._id })
      this.setData({
        schoolApply: { pending: null, rejected: null },
        applyLocked: false
      })
      wx.showToast({ title: '已撤回，可重新选择', icon: 'none' })
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '撤回失败', icon: 'none' })
      // 服务端说「已处理」= 管理员刚好审掉了，本地状态不可信，重拉一次
      await this.loadSchoolApply()
    } finally {
      hideBusy()
    }
  },

  /** 未读通知数（仅超管）：有人提交入校/建校申请时给红点 */
  async loadNotices() {
    try {
      const r = await app.callApi('listNotices', { size: 20 })
      this.setData({ noticeUnread: Number(r.unread) || 0 })
    } catch (e) {
      // 通知是增强项：读失败绝不能影响「我的」页主体
      console.warn('[mine] 通知读取失败', e && e.message)
    }
  },

  /**
   * 超管开启申请通知（订阅消息授权）。
   *
   * 一次性订阅：授权一次只换一条推送额度，所以这个入口允许反复点（每次补一次）。
   * 模板 ID 只存在云函数环境变量里，前端无从得知，必须向服务端要。
   */
  async enableApplyNotify() {
    let tmplId = ''
    try {
      const cfg = await app.callApi('notifyConfig', {})
      tmplId = (cfg && cfg.templateId) || ''
    } catch (e) {
      // 老版本云函数没有 notifyConfig：按「未配置」处理，
      // 不能让按钮点了没反应还不给解释
      tmplId = ''
    }
    if (!tmplId) {
      wx.showToast({ title: '服务端未配置消息模板', icon: 'none' })
      return
    }
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success: res => {
        const st = res && res[tmplId]
        if (st === 'accept') wx.showToast({ title: '已开启，有申请将通知你', icon: 'none' })
        else wx.showToast({ title: '未授权，收不到通知', icon: 'none' })
      },
      fail: () => wx.showToast({ title: '授权未完成', icon: 'none' })
    })
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
    // 建校是管理员专属（云端 applySchool 同样会 403）：这里提前挡住并说清原因，
    // 而不是让用户填完四行才收到一句「提交失败」。
    if (!this.data.isSuper && !this.data.schoolPolicy.canCreate) {
      return wx.showToast({ title: '仅管理员可创建学校，请联系管理员', icon: 'none' })
    }
    const reason = (f.reason || '').trim()
    const noReview = !this.data.schoolPolicy.reviewCreate
    // 理由只在审核模式必填（免审模式下服务端也不要求，这里跟着 policy 走）。
    // 反过来，免审模式若还硬要理由，用户会卡在一个服务端根本不看的字段上。
    if (!noReview && !reason) return wx.showToast({ title: '请填写申请理由', icon: 'none' })
    // 超管直接建校（让他排队审自己的申请没有意义），不受待审锁限制
    if (this.data.isSuper) return this.createSchool()
    if (this.data.submitting) return

    const campus = (f.campus || '').trim()
    const label = campus ? (name + ' · ' + campus) : name

    this.setData({ submitting: true })
    showBusy({ title: noReview ? '创建中' : '提交中' })
    try {
      const r = await app.callApi('applySchool', {
        name, campus, city: (f.city || '').trim(), intro: (f.intro || '').trim(), reason
      })
      if (r.status === 'bound') {
        // 免审：学校已建好（或撞上同名同校区、直接复用那所）并已绑定
        this.setData({
          showSchoolForm: false,
          schoolForm: { name: '', campus: '', city: '', intro: '', reason: '' }
        })
        // 撞上同名同校区时不能默默绑过去 —— 用户以为自己新建了一所学校，
        // 得明说「已存在，已切过去」，否则他会再建一次。
        await this.afterSchoolBound(r.schoolId, label,
          r.reused ? '「' + label + '」已存在，已为你切换过去'
            : '已创建「' + label + '」并切换')
        return
      }
      if (r.status === 'pending') {
        this.setData({
          schoolApply: { pending: r.apply || this.data.schoolApply.pending, rejected: null }
        })
        await this.loadSchoolApply()
        wx.showToast({ title: '已有待审申请，请等待管理员处理', icon: 'none' })
      } else {
        this.setData({
          showSchoolForm: false,
          schoolApply: { pending: r.apply || { name }, rejected: null }
        })
        // 锁不锁一律由 loadSchoolApply 判定（两处判定迟早不一致，项目踩过）
        await this.loadSchoolApply()
        wx.showToast({ title: '已提交，等待管理员审核', icon: 'none' })
      }
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '提交失败', icon: 'none' })
    } finally {
      hideBusy()
      this.setData({ submitting: false })
    }
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
    // 建校是管理员专属（2026-10-30）：普通人点开表单、填完提交只会收到 403，
    // 不如一开始就告诉他「联系管理员」。云端 applySchool 也挡一道（双保险）。
    if (!this.data.showSchoolForm && !this.data.isSuper && !this.data.schoolPolicy.canCreate) {
      wx.showToast({ title: '仅管理员可创建学校，请联系管理员', icon: 'none' })
      return
    }
    // 与选校同理：已有待审申请时不给展开新建表单（否则又落一条待审）
    if (!this.data.showSchoolForm && this.data.applyLocked) {
      wx.showToast({ title: '已有待审申请，请等待处理', icon: 'none' })
      return
    }
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

  /**
   * 退出测试身份（超管专用）：从「我的」页顶部横幅直接退，不必绕去账号页。
   * 退出后整页 reLaunch —— 权限入口、积分/档案、tabBar 都按旧身份渲染过，
   * 只 setData 一部分会留下「已经退出但还看得见后台入口」的残影。
   */
  async exitActing() {
    const go = await new Promise(resolve => {
      wx.showModal({
        title: '退出测试身份',
        content: '将回到你自己的超管账号。',
        confirmText: '退出',
        success: resolve
      })
    })
    if (!go.confirm) return
    showBusy({ title: '退出中' })
    try {
      await app.exitTestAccount()
      hideBusy()
      wx.reLaunch({ url: '/pages/mine/mine' })
    } catch (e) {
      hideBusy()
      wx.showToast({ title: (e && e.message) || '退出失败', icon: 'none' })
    }
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

  /**
   * 完善资料引导：昵称为空或仍是服务端默认值「爱猫同学」时弹出一次。
   * 用户管理界面里大量用户都叫「爱猫同学」、分不清谁是谁，根因就是注册时
   * 兜底了默认昵称却从不引导修改 —— 这里在进「我的」时补一次引导。
   * 已设置过真实昵称的人不会再来打扰。
   */
  maybeProfileGate() {
    const u = this.data.user
    if (!u) return
    const nick = (u.nickName || '').trim()
    if (!nick || nick === '爱猫同学') {
      this.setData({
        pg: { visible: true, nickName: nick, avatarUrl: u.avatarUrl || '' }
      })
    }
  },

  /** 完善资料弹窗完成：刷新全局用户 + 本页头像/昵称，并关弹窗 */
  onProfileDone(e) {
    const d = (e && e.detail) || {}
    if (d.skipped) {
      this.setData({ 'pg.visible': false })
      return
    }
    const u = app.globalData.user || {}
    if (d.nickName) u.nickName = d.nickName
    if (d.avatarUrl) u.avatarUrl = d.avatarUrl
    if (app.globalData.user) app.globalData.user = u
    this.setData({
      'user.nickName': d.nickName || this.data.user.nickName,
      'user.avatarUrl': d.avatarUrl || this.data.user.avatarUrl,
      'pg.visible': false
    })
    this.syncUserAvatar()
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

  /** 我的头像：user.avatarUrl 是 cloud:// fileID（提交/回滚都要用原始值，
   *  所以另开 avatarView 只作展示）。直接塞进 <image> 在开发者工具会报
   *  pageframe 加载失败，先换 https 再渲染。 */
  async syncUserAvatar() {
    const raw = ((this.data.user || {}).avatarUrl) || ''
    if (photo.isFileId(raw)) await photo.warm([raw])
    this.setData({ avatarView: photo.display(raw, 200) })
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
