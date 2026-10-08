/**
 * 个人虚拟支付 —— 前端模块（与业务解耦）
 * ---------------------------------------------------------------------------
 * 本模块只封装「调用云函数下单 → 拉起 wx.requestVirtualPayment → 查单/列表」。
 * 不决定买了之后发什么权益（权益发放由云函数 vpay_deliveries 消费逻辑完成）。
 *
 * 用法（页面里）：
 *   const vpay = require('../../utils/virtualpay')
 *   // 拉起支付（productId/goodsPrice 来自 MP 后台已发布的道具）
 *   await vpay.pay({ productId: 'tip_1', goodsPrice: 100, buyQuantity: 1, attach: '赞助猫粮' })
 */
function gApp() {
  return getApp()
}

/** 取登录 code（用户态签名需要），交给云函数换 sessionKey */
function loginCode() {
  return new Promise((resolve, reject) => {
    wx.login({ success: r => resolve(r.code), fail: reject })
  })
}

/**
 * iOS 版本校验：iOS 端需微信客户端 >= 8.0.68 才支持虚拟支付
 * @returns {boolean} true=可支付
 */
function checkIosVersion() {
  const sys = wx.getSystemInfoSync()
  if (sys.platform !== 'ios') return true
  const cur = (sys.version || '0.0.0').split('.').map(Number)
  const base = [8, 0, 68]
  for (let i = 0; i < 3; i++) {
    if ((cur[i] || 0) > base[i]) return true
    if ((cur[i] || 0) < base[i]) return false
  }
  return true
}

/**
 * 发起一笔道具直购。
 * @param {Object} opts
 *   productId   道具 ID（MP 后台创建并发布）
 *   goodsPrice  道具单价（分，正整数）
 *   buyQuantity 购买数量（默认 1）
 *   attach      透传数据（发货时原样回传，建议带上业务上下文，如 userId/场景）
 * @returns {Promise<{outTradeNo:string}>} 支付成功时 resolve（注意：成功回调可能丢失，发货以推送为准）
 */
async function pay(opts) {
  if (!checkIosVersion()) {
    wx.showModal({ title: '提示', content: '请将微信更新至最新版后再进行支付', showCancel: false })
    throw new Error('iOS 需微信 8.0.68 以上')
  }
  const code = await loginCode()
  const data = await gApp().callApi('vpayCreateOrder', {
    productId: opts.productId,
    goodsPrice: opts.goodsPrice,
    buyQuantity: opts.buyQuantity || 1,
    attach: opts.attach || '',
    loginCode: code
  })
  const payData = data.payData
  return new Promise((resolve, reject) => {
    wx.requestVirtualPayment(Object.assign({}, payData, {
      success: res => resolve({ outTradeNo: data.outTradeNo, errMsg: res.errMsg }),
      fail: err => reject(err)
    }))
  })
}

/** 查单（兜底）：按 outTradeNo / 平台单号查微信侧状态 */
function queryOrder(orderId) {
  return gApp().callApi('vpayQueryOrder', { orderId })
}

/** 我的订单 */
function listOrders() {
  return gApp().callApi('vpayListOrders', {})
}

/** 公开支付配置（offerId / 沙箱标志 / 道具列表） */
function getConfig() {
  return gApp().callApi('vpayConfig', {})
}

module.exports = { pay, checkIosVersion, queryOrder, listOrders, getConfig, loginCode }
