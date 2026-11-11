const app = getApp()
const { showBusy, hideBusy, maskAccount, isValidAccount } = require('../../utils/util.js')

// 账号与安全：个人主体下用「手机号 / 邮箱 + 密码」替代官方 getPhoneNumber。
//
// 两条 2026-10-30 的规则变化：
//  1. 账号**只允许手机号或邮箱**（不再接受自由用户名）：用户名不可验证、不可找回，
//     还会和别人的账号撞车；手机号账号顺带就是联系方式，所以下半部分的
//     「手机号」卡片也一并删掉 —— 同一个号码在页面里出现两次纯属噪音。
//  2. 设置完账号密码后**表单默认收起**，只留「修改账号 / 修改密码 / 登录其他账号」
//     三个入口，点了才展开：一进页就摊着三行输入框，看起来像「还没设置成功」。

const EMPTY_FORM = { account: '', password: '', password2: '', oldPassword: '' }
const MODE_LABEL = { account: '修改账号', pwd: '修改密码', login: '登录其他账号' }

Page({
  data: {
    acct: { hasAccount: false, accountMask: '' },
    // '' = 表单收起（已设置账号时的默认态）；set / account / pwd / login = 展开对应表单
    acctMode: 'set',
    acctModeLabel: '',
    acctForm: Object.assign({}, EMPTY_FORM),
    submitting: false,
    // 测试身份（仅超管）：三个槽位 + 当前是否正在以测试账号浏览。
    // show=false 时整张卡片不渲染（普通用户、测试身份下都不显示切换面板）。
    testSw: { show: false, acting: false, actingName: '', slots: [], hint: '' }
  },

  onShow() {
    // 返回本页（如从他处切回）时刷新状态，确保与全局 user 同步
    this.load()
  },

  async load() {
    try {
      await app.ensureReady()
      const u = app.globalData.user
      const has = !!(u && u.account)
      this.setData({
        acct: { hasAccount: has, accountMask: has ? maskAccount(u.account) : '' },
        // 没设账号就没什么好收起的，直接把「设置」表单摊开；
        // 设过了则收起，露出三个入口按钮。
        acctMode: has ? '' : 'set',
        acctModeLabel: '',
        acctForm: Object.assign({}, EMPTY_FORM)
      })
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' })
    }
    // 测试身份面板独立加载：拉全站用户 + 三个槽位配置，失败不影响上面的账号卡片
    this.loadTestSwitch()
  },

  /* ==================== 测试账号切换（仅超管） ====================
   * 超管只有一个微信身份，看不到普通用户 / 社团成员眼里的界面。
   * 这里把「以谁的身份浏览」交给服务端解析（actAs），切换后权限、数据脱敏、
   * 入口显隐全部按那个账号生效，等于预览真实用户看到的东西。
   * 只有 openid 白名单里的超管能配、能切，普通账号连这个卡片都看不到。
   */
  roleText(role) {
    if (role === 'admin') return '管理员'
    if (role === 'member') return '社团成员'
    return '普通用户'
  },

  async loadTestSwitch() {
    const acting = !!app.globalData.actAs
    if (!app.isRealSuper()) {
      this.setData({ testSw: { show: false, acting: false, actingName: '', slots: [], hint: '' } })
      return
    }
    const base = { show: true, acting: acting, actingName: app.globalData.actAsLabel || '测试账号' }
    if (acting) {
      this.setData({ testSw: Object.assign(base, { slots: [], hint: '' }) })
      return
    }
    try {
      // 候选账号 = 全站用户里排除「自己」和「其他超管」——超管之间不能互相顶替
      const pack = await app.callApi('listUsersAdmin', { size: 100 })
      const me = app.globalData.user || {}
      const cands = ((pack && pack.list) || []).filter(u => u && u._id && !u.isSuper && u._id !== me._id)
      const names = cands.map(u => (u.nickName || '未命名') + '（' + this.roleText(u.role) + '）')
      const ids = cands.map(u => u._id)
      const res = await app.callApi('testAccounts', {})
      const slots = ((res && res.slots) || []).map(s => this.slotRow(s, names, ids))
      this.setData({
        testSw: Object.assign(base, {
          slots,
          hint: cands.length ? '' : '目前没有可用的其他账号：先用另一个微信登录一次小程序，再回来绑定。'
        })
      })
    } catch (e) {
      this.setData({
        testSw: Object.assign(base, { slots: [], hint: (e && e.message) || '读取测试账号失败' })
      })
    }
  },

  /** 一行槽位的展示数据（WXML 不做拼接/比较，全部在这里算好） */
  slotRow(s, names, ids) {
    const u = s && s.user
    const idx = u ? (ids || []).indexOf(u._id) : -1
    return {
      key: (s && s.key) || '',
      label: (s && s.label) || '',
      hasUser: !!u,
      userId: u ? u._id : '',
      userName: u ? (u.nickName || '') : '',
      // picker 打开时高亮当前绑定的那个（-1 会落到第一项，故用 0 兜底）
      pickIndex: idx >= 0 ? idx : 0,
      // 绑定后连角色一起显示：槽位名只是用途，真正生效的是账号本身的角色
      userText: u
        ? ((u.nickName || '未命名') + ' · ' + (u.roleLabel || '普通用户') + (u.accountMask ? ' · ' + u.accountMask : ''))
        : '未设置',
      names: names,
      ids: ids
    }
  },

  /** picker 选人 → 绑定到该槽位（保存到超管自己的档案里） */
  async onPickTestUser(e) {
    const slot = e.currentTarget.dataset.slot
    const idx = Number(e.detail.value)
    const row = (this.data.testSw.slots || []).filter(x => x.key === slot)[0]
    if (!row || !row.ids || !row.ids[idx]) return
    try {
      await app.callApi('setTestAccounts', { slot: slot, userId: row.ids[idx] })
      wx.showToast({ title: '已绑定', icon: 'success' })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '绑定失败', icon: 'none' })
    }
    this.loadTestSwitch()
  },

  /** 切换到某个已绑定的测试账号 */
  async switchToTest(e) {
    const ds = e.currentTarget.dataset || {}
    if (!ds.id) return
    const name = ds.name || '测试账号'
    const go = await new Promise(resolve => {
      wx.showModal({
        title: '切换测试身份',
        content: '将以「' + name + '」的身份浏览：界面、权限与数据都按该账号生效，随时可在本页退出。',
        confirmText: '切换',
        success: resolve
      })
    })
    if (!go.confirm) return
    showBusy({ title: '切换中' })
    try {
      await app.switchTestAccount({ id: ds.id, nickName: name })
      // 服务端会二次校验配置；校验失败时 app 会自动清掉缓存退回真实身份，
      // 这里必须识别出来，否则会「提示切换成功、界面还是超管」。
      if (!app.globalData.actAs) throw new Error('测试身份未生效，请重新绑定该账号')
      hideBusy()
      // 必须整页重载：各页面的缓存数据、tabBar 选中态、权限入口都按旧身份算过
      wx.reLaunch({ url: '/pages/mine/mine' })
    } catch (err) {
      hideBusy()
      wx.showToast({ title: (err && err.message) || '切换失败', icon: 'none' })
    }
  },

  /** 退出测试身份，回到真实超管账号 */
  async exitActing() {
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

  /** 未设置账号时切 set / login（两者都不收起：这一步总得做完） */
  switchAcctMode(e) {
    const mode = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.mode) || 'set'
    this.setData({ acctMode: mode, acctForm: Object.assign({}, EMPTY_FORM) })
  },

  /** 已设置账号时：点同一个入口 = 收起（再点一次关掉，不用专门找「取消」） */
  toggleAcctMode(e) {
    const mode = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.mode) || ''
    const next = this.data.acctMode === mode ? '' : mode
    this.setData({
      acctMode: next,
      acctModeLabel: MODE_LABEL[next] || '',
      acctForm: Object.assign({}, EMPTY_FORM)
    })
  },

  closeAcctForm() {
    this.setData({ acctMode: '', acctModeLabel: '', acctForm: Object.assign({}, EMPTY_FORM) })
  },

  onAcctAccount(e) { this.setData({ 'acctForm.account': (e.detail || {}).value || '' }) },
  onAcctPwd(e) { this.setData({ 'acctForm.password': (e.detail || {}).value || '' }) },
  onAcctPwd2(e) { this.setData({ 'acctForm.password2': (e.detail || {}).value || '' }) },
  onAcctOldPwd(e) { this.setData({ 'acctForm.oldPassword': (e.detail || {}).value || '' }) },

  async submitAcct() {
    if (this.data.submitting) return
    const f = this.data.acctForm
    const mode = this.data.acctMode
    try {
      if (mode === 'set') {
        if (!isValidAccount(f.account)) return wx.showToast({ title: '账号需为 11 位手机号或邮箱', icon: 'none' })
        if (f.password.length < 6) return wx.showToast({ title: '密码至少 6 位', icon: 'none' })
        if (f.password !== f.password2) return wx.showToast({ title: '两次密码不一致', icon: 'none' })
        this.setData({ submitting: true })
        showBusy({ title: '设置中' })
        try {
          await app.callApi('registerAccount', { account: f.account.trim(), password: f.password })
        } catch (e2) {
          // 账号已存在 → 引导用密码登录（多设备复用同一账号）
          if (e2 && e2.code === 409) {
            this.setData({ acctMode: 'login', acctModeLabel: MODE_LABEL.login })
            wx.showToast({ title: '该账号已存在，请输入密码登录', icon: 'none' })
            return
          }
          throw e2
        }
        wx.showToast({ title: '已设置账号密码', icon: 'success' })
      } else if (mode === 'account') {
        if (!isValidAccount(f.account)) return wx.showToast({ title: '账号需为 11 位手机号或邮箱', icon: 'none' })
        if (!f.oldPassword) return wx.showToast({ title: '请输入当前密码', icon: 'none' })
        this.setData({ submitting: true })
        showBusy({ title: '修改中' })
        await app.callApi('updateProfile', { account: f.account.trim(), oldPassword: f.oldPassword })
        wx.showToast({ title: '账号已修改', icon: 'success' })
      } else if (mode === 'pwd') {
        if (!f.oldPassword) return wx.showToast({ title: '请输入原密码', icon: 'none' })
        if (f.password.length < 6) return wx.showToast({ title: '新密码至少 6 位', icon: 'none' })
        if (f.password !== f.password2) return wx.showToast({ title: '两次密码不一致', icon: 'none' })
        this.setData({ submitting: true })
        showBusy({ title: '修改中' })
        await app.callApi('updateProfile', { password: f.password, oldPassword: f.oldPassword })
        wx.showToast({ title: '密码已修改', icon: 'success' })
      } else {
        // login：用账号密码登录到已有账号（多设备合并同一份档案）
        if (!isValidAccount(f.account)) return wx.showToast({ title: '账号需为 11 位手机号或邮箱', icon: 'none' })
        if (f.password.length < 6) return wx.showToast({ title: '密码至少 6 位', icon: 'none' })
        this.setData({ submitting: true })
        showBusy({ title: '登录中' })
        await app.callApi('loginWithPassword', { account: f.account.trim(), password: f.password })
        wx.showToast({ title: '已登录到该账号', icon: 'success' })
      }
      await this.refresh()
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '操作失败', icon: 'none' })
    } finally {
      hideBusy()
      this.setData({ submitting: false })
    }
  },

  /** 设置 / 改密 / 换绑 / 登录后刷新全局 user 与本地展示 */
  async refresh() {
    try {
      const u = await app.refreshUser()
      const has = !!(u && u.account)
      this.setData({
        acct: { hasAccount: has, accountMask: has ? maskAccount(u.account) : '' },
        // 做完就收起表单：留着输入框会让人以为刚才那一步没生效
        acctMode: '',
        acctModeLabel: '',
        acctForm: Object.assign({}, EMPTY_FORM)
      })
      // refreshUser 内部已经处理了「学校被换掉 → 作废 globalData.school」，
      // 这里不再重复判定（两处判定迟早不一致，项目踩过这个坑）。
    } catch (e) { /* 忽略刷新失败 */ }
  }
})
