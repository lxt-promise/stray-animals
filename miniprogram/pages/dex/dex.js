const app = getApp()
const { C } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')

/** 花色标签：未知值不显示「未知」，图鉴里显示「待发现」更像收集类游戏 */
function patternLabel(v) {
  const hit = C.PATTERN.filter(p => p.value === v)[0]
  return hit ? hit.label : '待发现'
}

/**
 * 图鉴收集（本校）
 *
 * 数据只有一个来源：云端 `listDex`。它在服务端做了两件事，
 * 这两件正是旧版「我的」页做错的：
 *  1. 按**用户绑定的学校**取猫（未绑定学校时直接回 needSchool，不给 0 / 4 这种假进度）；
 *  2. 已收集 = 本校猫 id ∩ user.catSeen（换过学校后不会出现「已收集 7 / 总数 4」）。
 *
 * 前端不查 listCats 自己拼：listCats 是分页列表，`total` 字段并不存在，
 * 旧的 `res.total || list.length` 拿的是「这一页有几只」，不是「本校有几只」。
 */
Page({
  data: {
    loading: true,
    needSchool: false,
    schoolName: '',
    seen: 0,
    total: 0,
    percent: 0,
    truncated: false,
    dex: [],
    emptyText: ''
  },

  onLoad() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  async load() {
    this.setData({ loading: true })
    try {
      await app.ensureReady()
      const r = await app.callApi('listDex', {})
      if (r.needSchool) {
        this.setData({ loading: false, needSchool: true, dex: [], seen: 0, total: 0, percent: 0 })
        return
      }
      const school = app.globalData.school || {}
      const list = (r.list || []).map(c => {
        const unlocked = !!c.unlocked
        return {
          id: c.id,
          unlocked,
          // 未解锁不渲染头像：灰格里的「?」才是收集感，也省掉没必要的图片请求
          avatar: unlocked ? (c.avatar || '') : '',
          // 文案全部在这里定好（WXML 的 mustache 只认白名单表达式，
          // 三元里再拼字符串容易被编译期静默忽略，界面表现为一块空白）
          nameText: unlocked ? (c.name || '未命名') : '未解锁',
          hintText: patternLabel(c.pattern)
        }
      })
      const total = Number(r.total) || 0
      this.setData({
        loading: false,
        needSchool: false,
        schoolName: school.name || '',
        seen: Number(r.seen) || 0,
        total,
        percent: Number(r.percent) || 0,
        truncated: !!r.truncated,
        dex: list,
        emptyText: total ? '' : '本校还没有猫档案，等管理员建档后就会出现在这里'
      })
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' })
    }
  },

  goCat(e) {
    const ds = e.currentTarget.dataset || {}
    // 未解锁的格子点进去没有任何意义（猫名还没揭示），也不该借此看到档案
    if (String(ds.locked) === '1') {
      wx.showToast({ title: '还没遇到过这只猫', icon: 'none' })
      return
    }
    if (!ds.id) return
    wx.navigateTo({ url: '/pages/cat-detail/cat-detail?id=' + ds.id })
  },

  /**
   * 去绑定学校。
   * mine 是 tabBar 页，switchTab **不支持 query**，所以先把意图写进 globalData，
   * 由 mine 的 onShow 消费（与首页「我的打卡」、cats 的 tab 切换同一模式）。
   */
  goBindSchool() {
    app.globalData.mineAction = 'school'
    wx.switchTab({ url: '/pages/mine/mine' })
  },

  /**
   * 头像加载失败：先去掉图片处理参数重试，再置空退 🐱 占位。
   * 绝不能 setData 之后再整页 load() —— 坏图会让页面无限重载、手机发烫（踩过）。
   */
  onAvatarErr(e) {
    const i = Number((e.currentTarget.dataset || {}).i || 0)
    const item = (this.data.dex || [])[i]
    if (!item || !item.avatar) return
    const key = 'dex[' + i + '].avatar'
    if (photo.hasProcess(item.avatar)) this.setData({ [key]: photo.stripProcess(item.avatar) })
    else this.setData({ [key]: '' })
  }
})
