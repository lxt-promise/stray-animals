const C = require('./const.js')

/** 取枚举的 label */
function labelOf(list, value) {
  const hit = list.filter(i => i.value === value)[0]
  return hit ? hit.label : '未知'
}
/** 取枚举的完整项 */
function itemOf(list, value) {
  return list.filter(i => i.value === value)[0] || { label: '未知', tag: 'gray' }
}

/** 把任意来源的时间值安全转成 Date（无效返回 null）。
 *  兼容：Date / 时间戳 / ISO 字符串（云开发序列化后的 "2026-10-11T01:26:00.000Z"）/
 *  本地格式 "2026-09-22 20:30" / "2026/09/22 20:30"。
 *  注意：必须先按 ISO 原样解析，不能先把 "-" 换成 "/" —— 否则 ISO 串被破坏成
 *  "2026/10/11T...Z"，解析得到 Invalid Date，页面就会显示 NaN/NaN/NaN。 */
function toDate(v) {
  if (!v) return null
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v
  if (typeof v === 'number') {
    const d = new Date(v)
    return isNaN(d.getTime()) ? null : d
  }
  if (typeof v === 'string') {
    let d = new Date(v)
    if (!isNaN(d.getTime())) return d
    d = new Date(v.replace(/-/g, '/'))
    return isNaN(d.getTime()) ? null : d
  }
  if (typeof v === 'object' && v.$date) return toDate(v.$date)
  return null
}

/** 时间格式化：2026/09/22 20:30 */
function formatTime(date) {
  const d = toDate(date)
  if (!d) return ''
  const p = n => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 相对时间：1 小时内「xx 分钟前」，超过 1 小时直接给具体时间点（2026/10/13 18:40）。
 *  为什么超过 1 小时就不用「x 小时前」：跨天后「3 小时前」有歧义（是今天 3 小时前还是昨天？），
 *  打卡/巡护记录需要可核对的具体时刻，直接给时间点最稳妥。 */
function fromNow(date) {
  const d = toDate(date)
  if (!d) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + '分钟前'
  return formatTime(d)
}

/** 日期：09-22 */
function shortDate(date) {
  const d = toDate(date)
  if (!d) return ''
  const p = n => (n < 10 ? '0' + n : '' + n)
  return p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/** 两点间距离（米），Haversine。
 *  校验用 Number.isFinite：isNaN 不挡 Infinity（距离会算成 Infinity 显示 "Infinitykm"） */
function distance(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => !Number.isFinite(v))) return null
  const R = 6371000
  const rad = d => d * Math.PI / 180
  const dLat = rad(lat2 - lat1)
  const dLng = rad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(a)))
}

function distanceText(m) {
  if (m === null) return ''
  if (m < 1000) return m + 'm'
  return (m / 1000).toFixed(1) + 'km'
}

/** 金额：12.50 */
function money(n) {
  const v = Number(n) || 0
  return v.toFixed(2)
}

/** 毛色 → 稀有度（游戏化：三花/玳瑁/纯白更稀有） */
function rarityOf(pattern) {
  const map = {
    orange: 'common', tabby: 'common', cow: 'uncommon', tuxedo: 'uncommon',
    black: 'uncommon', gray: 'uncommon', siamese: 'rare',
    calico: 'epic', tortoiseshell: 'epic', white: 'rare', other: 'common'
  }
  return map[pattern] || 'common'
}

/** 生成猫的默认头像占位（按名字首字） */
function initialOf(name) {
  return (name || '?').trim().slice(0, 1)
}

function toast(title, icon) {
  wx.showToast({ title: String(title).slice(0, 20), icon: icon || 'none', duration: 1800 })
}

/**
 * 报错专用提示：短的说 toast，长的弹窗。
 *
 * `toast` 会 `slice(0, 20)` —— 数据库错误 `document.update:fail -502001 database request fail`
 * 被截成正好 20 个字符的 `document.update:fail`，真正的原因整段丢失，
 * 用户和开发者都看不出为什么失败。错误信息一律走这里，别再被截断。
 */
function toastErr(e, fallback) {
  const raw = (e && (e.message || e.errMsg)) || fallback || '操作失败'
  const msg = String(raw)
  if (msg.length > 12) {
    wx.showModal({ title: '操作失败', content: msg.slice(0, 300), showCancel: false })
    return
  }
  wx.showToast({ title: msg, icon: 'none', duration: 1800 })
}

/**
 * 是否是「云函数调用超时」（-504003 Invoking task timed out）。
 *
 * 这类失败和普通业务错误有本质区别：**请求已经送到云端了**，云端此时还在
 * 继续执行（客户端只是不等了）。所以建档这种写操作超时后，档案很可能已经写进库，
 * 用户直接重试就会建出重复档案 —— 必须给出不同的提示。
 */
function isTimeoutErr(e) {
  const s = String((e && (e.errMsg || e.message)) || '')
  return s.indexOf('-504003') >= 0 || s.indexOf('timed out after') >= 0 ||
    s.indexOf('TIME_LIMIT_EXCEEDED') >= 0
}

/** 需要社团权限才继续，否则提示并跳转 */
function requireMember(app) {
  return requireRole(app, 'member')
}

/** 需要管理员及以上（社团成员不够）才继续，否则提示并跳转 */
function requireAdmin(app) {
  return requireRole(app, 'admin')
}

/**
 * 统一的身份门槛：管理员及以上（含超级管理员）可过。
 * 超级管理员在登录时已被授予 admin 角色，这里再兜一层 isSuper()，
 * 避免「超管角色写入失败」时被误拦在门外。
 */
function isAdminPlus(app) {
  return !!app && (app.isAdmin() || app.isSuper())
}

/** 通用权限门槛：app / 所需角色 / 提示文案 */
function requireRole(app, need, opts) {
  const o = opts || {}
  const isAdminNeed = need === 'admin'
  if (isAdminNeed ? isAdminPlus(app) : app.isMember()) return true
  const title = o.title || (isAdminNeed ? '需要管理员权限' : '需要社团身份')
  const content = o.content || (isAdminNeed
    ? '建档 / 改档属管理员功能。如需录入猫咪，可在「我的」中申请加入社团并联系管理员开通。'
    : '编辑猫档案、TNR 台账等属于社团协作功能。可在「我的」中申请加入社团。')
  wx.showModal({
    title,
    content,
    confirmText: '去申请',
    success: r => { if (r.confirm) wx.switchTab({ url: o.url || '/pages/mine/mine' }) }
  })
  return false
}

/** 安全加载封装：用计数器保证 wx.showLoading / wx.hideLoading 严格配对。
 *  避免「显示了却没隐藏」导致蒙层卡死、界面像“没登录”一样点不动，
 *  也避免「重复隐藏」触发微信的 `showLoading 与 hideLoading 必须配对使用` 告警。
 *  支持嵌套/连续调用：只有最后一次 hideBusy 才真正关闭 loading。 */
let _loadingCount = 0
function showBusy(title) {
  let t = '加载中'
  if (typeof title === 'string') t = title
  else if (title && title.title) t = title.title
  if (_loadingCount === 0) wx.showLoading({ title: t, mask: true })
  _loadingCount++
}
function hideBusy() {
  _loadingCount = Math.max(0, _loadingCount - 1)
  if (_loadingCount === 0) wx.hideLoading()
}

/**
 * 分享能力 mixin。
 *
 * ⚠️ **微信小程序默认是不能分享的**：页面里没定义 `onShareAppMessage` 时，
 * 右上角「···」菜单里的「转发给朋友」是灰色不可点状态。这是框架约定而非 bug ——
 * 每个希望被转发的页面都必须显式声明，没有全局开关。
 * 「分享到朋友圈」（`onShareTimeline`）更进一步，**必须先有 onShareAppMessage** 才生效。
 *
 * 用法：
 *   Page(Object.assign({}, shareBehavior({ title, path }), { data: {...}, ... }))
 *
 * @param {Object|Function} opt 配置；传函数则以 this 为上下文、拿 Wes 回调入参动态生成
 * @param {string} [opt.title] 卡片标题
 * @param {string} [opt.path]  打开路径，必须 /pages/... 开头并带齐参数
 * @param {string} [opt.imageUrl] 卡片图（建议 5:4）
 * @param {string} [opt.query] 朋友圈的参数串（不带 ?）
 * @param {boolean} [opt.timeline=true] 是否允许分享到朋友圈
 * @returns {Object} 可直接并进 Page options 的对象
 */
function shareBehavior(opt) {
  const DEF_TITLE = '喵园 · 校园流浪猫档案'

  // opt 允许传函数：需要拿 this.data 拼标题/路径时用（比如猫详情页要带上猫名）
  function cfgOf(ctx) {
    let o = {}
    if (typeof opt === 'function') {
      // 用 call 绑定页面实例，opt 里就能直接 this.data.xxx
      try { o = opt.call(ctx) || {} } catch (e) { o = {} }
    } else {
      o = opt || {}
    }
    return o
  }
  // 函数式取值：this 绑定到页面实例，入参是微信给的分享回调对象，
  // 于是 title: function() { return this.data.cat.name } 这类写法可用
  function value(v, arg, ctx) {
    if (typeof v === 'function') {
      try { return v.call(ctx, arg) } catch (e) { return '' }
    }
    return v
  }

  const behavior = {
    onShareAppMessage(res) {
      const page = this
      const o = cfgOf(page)
      const out = {
        title: value(o.title, res, page) || DEF_TITLE,
        path: value(o.path, res, page) || '/pages/index/index'
      }
      // 不传 imageUrl 时微信自动截页面当封面；这里只在页面显式给了才覆盖
      const img = value(o.imageUrl, res, page)
      if (img) out.imageUrl = img
      return out
    }
  }

  const cfg0 = typeof opt === 'function' ? {} : (opt || {})
  if (cfg0.timeline !== false) {
    behavior.onShareTimeline = function () {
      const page = this
      const o = cfgOf(page)
      // 朋友圈不支持自定义 path，只能往「当前页路径」上追加 query
      return {
        title: value(o.timelineTitle || o.title, null, page) || DEF_TITLE,
        query: value(o.query, null, page) || ''
      }
    }
  }
  // 收藏（基础库 2.19+）；老版本自动忽略
  behavior.onAddToFavorites = function () {
    const page = this
    const o = cfgOf(page)
    return {
      title: value(o.title, null, page) || DEF_TITLE,
      query: value(o.query, null, page) || ''
    }
  }
  return behavior
}

/**
 * 目击记录的**结构化标签文案**（合规改造：替代原自由文本 note 的展示位）。
 *
 * 打卡页已无自由文字；列表要"有信息量"就靠这些枚举标签拼串。
 * 顺序：健康 → 行为 → 特征 → 数量（有异常的在最前，方便一眼扫到）。
 * 返回 string[]，调用方自行决定怎么渲染（拼串 / 单个 tag）。
 */
function sightTags(s) {
  if (!s) return []
  const out = []
  if (s.health && s.health !== 'unknown') out.push(labelOf(C.HEALTH, s.health))
  ;(s.behaviors || []).forEach(v => {
    const hit = C.SIGHT_BEHAVIOR.filter(i => i.value === v)[0]
    if (hit) out.push(hit.label)
  })
  ;(s.features || []).forEach(v => {
    const hit = C.SIGHT_FEATURE.filter(i => i.value === v)[0]
    if (hit) out.push(hit.label)
  })
  if (Number(s.count) > 1) out.push('共 ' + Number(s.count) + ' 只')
  return out
}

/** 目击标签拼成一行短文案（列表副标题用，超长自动截断由 WXSS 处理） */
function sightTagText(s, sep) {
  return sightTags(s).join(sep || ' · ')
}

module.exports = {
  C, labelOf, itemOf, toDate, formatTime, fromNow, shortDate,
  distance, distanceText, money, rarityOf, initialOf, toast, toastErr, isTimeoutErr,
  requireMember, requireAdmin, requireRole, isAdminPlus,
  showBusy, hideBusy, shareBehavior,
  sightTags, sightTagText
}
