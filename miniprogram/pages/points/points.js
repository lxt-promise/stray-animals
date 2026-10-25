const app = getApp()
const { C, fromNow, shareBehavior } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')
const level = require('../../utils/level.js')

/**
 * 两个入口、两种页面形态：
 *
 *   · 「我的」→「猫粮明细」      → type=food  猫粮值流水（可增可减，看得到每笔收支）
 *   · 「我的」→ 点等级标签        → type=point 等级页：只显示积分总值 + 等级进度，
 *                                               **不查流水**（少一次读、少一段渲染）
 *
 * 为什么积分侧不展示明细：
 *   积分只增不减、唯一用途是判等级，用户能用的信息就是「我现在多少分、离下一档差多少」。
 *   明细列表既增加读请求，也会让人误以为积分可以被消费掉；而猫粮才是要记账的那本。
 *
 * 为什么两种货币不能混在一个列表：
 *   一条 `-20`（识别扣费）混在积分流水里，用户第一反应是「我的等级被扣了」。
 */
const MODES = {
  food: {
    title: '猫粮明细',
    label: '猫粮值',
    sub: '识别 20/次 · 首次免费',
    empty: '还没有猫粮记录',
    tipTitle: '猫粮值（可增可减）',
    tip: '新手礼包 +50 · 每日打卡 +5 · 建立档案 +15~+20 · 升级 +50。每日上限 50，礼包与升级奖励不计入。',
    tip2: '识别服务 20 猫粮值/次，首次免费，每天最多 10 次。余额不足时无法发起识别。'
  },
  point: {
    title: '等级与积分',
    label: '积分值',
    sub: '',
    empty: '还没有积分记录',
    tipTitle: '积分值（只增不减）',
    tip: '每日打卡 +5 · 投喂 +2~+5（按食物类型）· 图鉴点亮新品种 +10。每日上限 150。',
    tip2: '积分只涨不降，决定等级称号；花猫粮不影响积分和等级。'
  }
}

Page(Object.assign({
  data: {
    list: [],
    type: 'food',            // food | point
    isPoint: false,
    title: '猫粮明细',
    // 顶部余额卡（仅猫粮模式）：数字/标签/副标题全部预计算，WXML 只做插值
    head: { num: 0, label: '猫粮值', sub: '识别 20/次 · 首次免费' },
    wallet: { food: 0, foodToday: 0, foodCap: 50 },
    // 等级视图（仅积分模式）：全部由 utils/level.js 按积分算好，
    // 不依赖云端下发的派生字段 —— 少一个字段也不会渲染成 undefined
    view: {
      levelText: 'Lv.1 猫语新手',
      peak: 0,
      progress: 0,
      nextText: '',
      maxed: false,
      steps: []
    },
    user: { nickName: '', avatarView: '' },
    rules: C.RULES,        // 规则说明与「我的」页共用一份文案
    rulesOpen: false,
    emptyText: '还没有猫粮记录',
    tipTitle: '',
    tipText: '',
    tipText2: '',
    loading: true
  },

  onLoad(options) {
    // 老入口（无 type 参数）一律当猫粮明细：这是菜单里「猫粮明细」那一项
    const type = (options && options.type === 'point') ? 'point' : 'food'
    const m = MODES[type]
    this.setData({
      type,
      isPoint: type === 'point',
      title: m.title,
      emptyText: m.empty,
      tipTitle: m.tipTitle,
      tipText: m.tip,
      tipText2: m.tip2,
      head: { num: 0, label: m.label, sub: m.sub }
    })
    wx.setNavigationBarTitle({ title: m.title })
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  async load() {
    const type = this.data.type
    this.setData({ loading: true })
    try {
      await app.ensureReady()
      const summary = (await app.callApi('pointsSummary', {})) || {}
      // 判级依据是历史最高积分（积分只增不减，但异常调账/合并仍可能让它下降，
      // 用当前值判会出现「掉级」，与规则冲突）。展示也用同一个数，
      // 否则会出现「进度条差 50 分却已经升级」这种自相矛盾。
      const peak = Math.max(Number(summary.peakPoints) || 0, Number(summary.points) || 0)

      if (type === 'point') {
        // 积分侧到此为止：不查流水，一次请求即可渲染完整页面
        const u = (app.globalData && app.globalData.user) || {}
        this.setData({
          view: Object.assign(level.levelOf(peak), { peak, steps: level.ladder(peak) }),
          user: {
            nickName: u.nickName || '爱猫同学',
            avatarView: photo.display(u.avatarUrl, 120)
          },
          loading: false
        })
        return
      }

      // currency 交给后端过滤：前端过滤只能筛「已拉到的 50 条」，
      // 遇到「今天全是积分、翻不到猫粮记录」时会误导成「没有记录」
      const rows = await app.callApi('listPoints', { size: 50, currency: 'food' })
      const today = summary.today || {}
      const food = Number(summary.food) || 0
      this.setData({
        head: { num: food, label: MODES.food.label, sub: MODES.food.sub },
        wallet: {
          food,
          foodToday: today.food || 0,
          foodCap: today.foodCap || 50
        },
        list: (rows || []).map(r => ({
          _id: r._id,
          kind: r.kind,
          reason: r.reason || r.kind,
          timeText: fromNow(r.createdAt),
          // 正负号在 JS 里拼好：WXML 的 mustache 不做字符串运算
          deltaText: (r.delta > 0 ? '+' : '') + r.delta,
          minus: Number(r.delta) < 0
        })),
        loading: false
      })
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' })
    }
  },

  /** 规则说明：页面右上角点击展开/收起 */
  toggleRules() {
    this.setData({ rulesOpen: !this.data.rulesOpen })
  }
// ↓ 明细是志愿者的「成绩单」，转发带余额最有荣誉感。
//   数据属个人信息，落地页统一回落首页，避免把明细页丢给别人看空列表。
}, shareBehavior(function () {
  const w = this.data
  return {
    title: w.type === 'point'
      ? ('我在喵园已经升到 ' + w.view.levelText + ' 啦 🐱')
      : (w.wallet.food > 0 ? ('我在喵园攒了 ' + w.wallet.food + ' 猫粮值 🍚') : '喵园 · 一起照顾校园里的流浪猫'),
    path: '/pages/index/index'
  }
})))
