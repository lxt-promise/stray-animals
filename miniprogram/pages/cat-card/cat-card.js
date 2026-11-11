const app = getApp()
const { C, itemOf, toDate, fromNow, rarityOf, initialOf, shareBehavior } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')

/**
 * 只取日期：2026/10/13
 * 名片要的是「第一次被记录下来的那天」，时分没有意义，留着只会把卡片挤窄。
 */
function dateOnly(v) {
  const d = toDate(v)
  if (!d) return ''
  const p = n => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate())
}

/**
 * 猫名片 / 可分享卡。
 *
 * 对标 CatchCat 的「collectible card」：把一只猫浓缩成一张能拿出去晒的卡。
 * 但取值全部来自真实档案 —— 花色/稀有度按现有 rarityOf 口径，打卡数是真实目击次数，
 * 救助状态是档案里的 status / sterilized / health，**不生成任何随机虚拟属性**。
 *
 * 数据完全复用现有 getCat（含 sanitizeCat 脱敏：非成员看不到 medicalNote/联系方式），
 * 所以后端不用改、云函数不用重传。
 */
Page(Object.assign({
  data: {
    id: '',
    cat: null,
    loading: true,
    // ↓ 以下全是 WXML 不能直接算的展示字段（mustache 不能调函数/拼串），先在 JS 预算好
    name: '',
    initial: '',
    avatar: '',
    patternLabel: '',
    rarityLabel: '',
    rarityColor: '#B0B0B0',
    firstSeenText: '',
    sightingCount: 0,
    lastSeenText: '',
    statusLabel: '', statusTag: 'gray',
    sterLabel: '', sterTag: 'gray',
    healthLabel: '', healthTag: 'gray',
    schoolName: '',
    // 分享封面：必须是 https（cloud:// 在分享卡片里不认），没有照片就让微信自动截屏
    shareImage: ''
  },

  onLoad(options) {
    this.setData({ id: (options && options.id) || '' })
    this.load()
  },

  async load() {
    if (!this.data.id) {
      this.setData({ loading: false })
      wx.showToast({ title: '缺少猫咪 ID', icon: 'none' })
      return
    }
    try {
      await app.ensureReady()
      const res = await app.callApi('getCat', { id: this.data.id })
      const cat = res.cat
      // 照片换 https：cloud:// fileID 交给分享卡片 / previewImage 都不认，
      // 不换链就是「分享出去封面是空白」。
      const [view] = await photo.hydrateCatsAsync([cat], { px: 800, photoPx: 480, full: true })
      const v = view || cat
      const rItem = itemOf(C.RARITY, rarityOf(v.pattern))
      const stItem = itemOf(C.CAT_STATUS, v.status)
      const sterItem = itemOf(C.STERILIZED, v.sterilized)
      const hlItem = itemOf(C.HEALTH, v.health)
      const g = app.globalData || {}
      this.setData({
        cat: v,
        name: v.name || '无名小猫',
        initial: initialOf(v.name),
        avatar: v.avatar || '',
        patternLabel: itemOf(C.PATTERN, v.pattern).label,
        rarityLabel: rItem.label,
        rarityColor: rItem.color || '#B0B0B0',
        firstSeenText: dateOnly(v.createdAt),
        sightingCount: Number(v.sightingCount) || 0,
        lastSeenText: v.lastSeenAt ? fromNow(v.lastSeenAt) : '',
        statusLabel: stItem.label, statusTag: stItem.tag || 'gray',
        sterLabel: sterItem.label, sterTag: sterItem.tag || 'gray',
        healthLabel: hlItem.label, healthTag: hlItem.tag || 'gray',
        schoolName: (g.school && g.school.name) || '',
        shareImage: v.avatar || '',
        loading: false
      })
      wx.setNavigationBarTitle({ title: (v.name || '猫咪') + ' · 名片' })
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' })
    }
  },

  /** 名片 → 完整档案（redirectTo：名片通常是分享进来的，返回不该再回到一张孤立的卡） */
  goDetail() {
    const id = this.data.id
    // 'undefined' 这类伪 id 也拦掉：跳过去只会白屏
    if (!id || id === 'undefined' || id === 'null') return
    wx.redirectTo({ url: '/pages/cat-detail/cat-detail?id=' + id })
  },

  preview() {
    if (!this.data.avatar) return
    wx.previewImage({ urls: [this.data.avatar], current: this.data.avatar })
  }
}, shareBehavior(function () {
  const d = this.data
  // 分享卡片：标题带猫名 + 花色，封面用标准照，路径带 id 让别人点开直达这张名片
  return {
    title: (d.name ? d.name + ' · ' : '') + (d.patternLabel || '校园猫') + '｜喵园猫咪名片',
    path: '/pages/cat-card/cat-card?id=' + d.id,
    imageUrl: d.shareImage || '',
    query: 'id=' + d.id
  }
})))
