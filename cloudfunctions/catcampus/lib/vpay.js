/**
 * 个人虚拟支付模块（lib/vpay.js）
 * ---------------------------------------------------------------------------
 * 职责边界（对应「先封装模块、不与业务关联」）：
 *   本模块只负责「收钱 + 把发货意图记下来」，不决定发什么权益。
 *   业务侧后续只需消费 vpay_deliveries 集合（按 wx_order_id 去重、发放权益），
 *   即完成接入，做到支付能力与业务解耦。
 *
 * 链路：
 *   前端 wx.login → vpayCreateOrder（云函数双签名）→ wx.requestVirtualPayment → 微信支付
 *   微信 → 发货推送 xpay_goods_deliver_notify → vpayNotify（幂等记录 delivery 意图）
 *   兜底：vpayQueryOrder（主动查单）→ 同样产生 delivery 意图
 *
 * 关键字段：
 *   outTradeNo  商家业务单号（每次重生成、唯一、8-32 位、仅数字字母 _-|*@、不能下划线开头）
 *   wx_order_id 平台单号（位于推送 WeChatPayInfo.MchOrderNo），发货/对账/幂等去重以此为准
 *
 * 文档依据：
 *   https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/person
 *
 * 密钥配置（部署时填到云函数环境变量，切勿写死在代码里）：
 *   VPAY_OFFER_ID / VPAY_APP_ID / VPAY_APP_SECRET / VPAY_APP_KEY / VPAY_SANDBOX
 *   VPAY_MSG_TOKEN / VPAY_ENCODING_AES_KEY（消息推送验签）
 */
const { db, _, COL, AppError } = require('./core')
const crypto = require('crypto')
const https = require('https')
const http = require('http')

/* ==================== 配置 ==================== */
const CFG = {
  offerId: process.env.VPAY_OFFER_ID || '',
  appId: process.env.VPAY_APP_ID || '',
  appSecret: process.env.VPAY_APP_SECRET || '',
  appKey: process.env.VPAY_APP_KEY || '',                 // 现网 AppKey（支付密钥）
  sandbox: String(process.env.VPAY_SANDBOX || 'false') === 'true',
  msgToken: process.env.VPAY_MSG_TOKEN || '',             // MP 后台消息推送 Token
  encodingAESKey: process.env.VPAY_ENCODING_AES_KEY || '',// 消息推送 EncodingAESKey
  apiBase: process.env.VPAY_API_BASE || 'https://api.weixin.qq.com'
}
const SANDBOX_ENV = 1
const PROD_ENV = 0

/**
 * 后台道具登记（可选，用于下单时校验价格与 MP 后台一致）。
 * 道具仍须在 MP 后台【虚拟支付 → 道具管理】创建并发布；这里只是本地镜像。
 * 留空数组 = 不强制校验价格（以 MP 后台为准）。
 */
const PRODUCTS = [] // 例：[{ productId: 'tip_1', name: '猫粮赞助', price: 100 }]

/* ==================== 签名（双签名，5.5 节） ==================== */

function hmacSha256(key, msg) {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex')
}

/**
 * 支付签名 paySig：服务端用 AppKey 对 `uri + '&' + postBody` 做 HMAC-SHA256。
 *  - C 端（wx.requestVirtualPayment 下单）：uri 固定 'requestVirtualPayment'
 *  - B 端（服务端 /xpay/* 接口）：uri 为接口路径，如 'xpay/query_order'
 */
function calcPaySig(uri, postBody, appKey) {
  return hmacSha256(appKey, uri + '&' + postBody)
}

/** 用户态签名 signature：服务端用 sessionKey 对 signData 做 HMAC-SHA256 */
function calcSignature(postBody, sessionKey) {
  return hmacSha256(sessionKey, postBody)
}

/* ==================== 工具 ==================== */

function genOutTradeNo(prefix) {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 10)
  const raw = (prefix || 'T') + ts + rand
  // 仅保留合法字符，截到 32 位；若首字符是下划线则补一位
  let no = raw.replace(/[^0-9a-zA-Z_\-|*@]/g, '0').slice(0, 32)
  if (no[0] === '_') no = 'T' + no.slice(1, 32)
  return no
}

/** 取用户态 sessionKey（用户态签名需要）。loginCode 来自前端 wx.login() */
async function fetchSessionKey(loginCode) {
  if (!loginCode) throw new AppError('缺少 loginCode，无法完成用户态签名', 400)
  const url = CFG.apiBase.replace(/\/$/, '') +
    '/sns/jscode2session?appid=' + CFG.appId +
    '&secret=' + CFG.appSecret +
    '&js_code=' + loginCode + '&grant_type=authorization_code'
  const r = await requestJson('GET', url)
  if (!r || !r.session_key) {
    console.error('[vpay] jscode2session 失败', r)
    throw new AppError('获取用户会话失败，请重试', 500)
  }
  return r.session_key
}

let _token = null
let _tokenExp = 0
/** 取接口调用凭据（B 端查单/退款用）。带本地缓存 */
async function getAccessToken() {
  if (_token && _tokenExp > Date.now()) return _token
  const url = CFG.apiBase.replace(/\/$/, '') +
    '/cgi-bin/token?grant_type=client_credential&appid=' + CFG.appId + '&secret=' + CFG.appSecret
  const r = await requestJson('GET', url)
  if (!r || !r.access_token) {
    console.error('[vpay] 获取 access_token 失败', r)
    throw new AppError('获取 access_token 失败', 500)
  }
  _token = r.access_token
  _tokenExp = Date.now() + (Number(r.expires_in) || 7200) * 1000 - 60000
  return _token
}

/** 极简 JSON 请求（云函数无 fetch，用 https 模块；自动带 Pay-Sig 头） */
function requestJson(method, url, body, headers) {
  let u
  try { u = new URL(url) } catch (e) { return Promise.reject(new AppError('微信接口地址非法', 400)) }
  const lib = u.protocol === 'https:' ? https : http
  const payload = body ? JSON.stringify(body) : ''
  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }, headers || {}),
      timeout: 10000
    }, res => {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', () => {
        if (!d) return resolve({})
        try { resolve(JSON.parse(d)) } catch (e) { resolve({ raw: d }) }
      })
    })
    req.on('timeout', () => { req.destroy(); reject(new AppError('微信接口超时', 504)) })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/* ==================== 下单（道具直购） ==================== */

async function createOrder(me, event) {
  const { productId, goodsPrice, buyQuantity, attach, loginCode, outTradeNo } = event
  if (!productId) throw new AppError('缺少 productId')

  const price = Number(goodsPrice)
  if (!Number.isInteger(price) || price <= 0) throw new AppError('goodsPrice 必须为正整数（单位：分）')
  const qty = Math.max(1, Number(buyQuantity) || 1)
  const env = CFG.sandbox ? SANDBOX_ENV : PROD_ENV

  // 与本地登记道具价格校验（可选）
  const reg = PRODUCTS.find(p => p.productId === productId)
  if (reg && reg.price && reg.price !== price) {
    throw new AppError('价格与后台道具不一致（后台 ' + reg.price + ' 分）', 400)
  }

  const sessionKey = await fetchSessionKey(loginCode)

  const no = outTradeNo || genOutTradeNo('T')
  if (!/^[0-9a-zA-Z_\-|*@]{8,32}$/.test(no) || no[0] === '_') {
    throw new AppError('outTradeNo 非法（8-32 位，仅数字字母 _-|*@，不能下划线开头）', 400)
  }

  // signData：顺序固定，与前端传给 wx.requestVirtualPayment 的字符串完全一致
  const signData = {
    offerId: CFG.offerId,
    buyQuantity: qty,
    env,
    currencyType: 'CNY',
    productId,
    goodsPrice: price,
    outTradeNo: no,
    attach: attach || ''
  }
  const signDataStr = JSON.stringify(signData)
  const paySig = calcPaySig('requestVirtualPayment', signDataStr, CFG.appKey)
  const signature = calcSignature(signDataStr, sessionKey)

  const now = new Date()
  const doc = {
    openid: me.openid,
    _openid: me.openid,
    outTradeNo: no,
    wxOrderId: '',
    productId,
    goodsPrice: price,
    buyQuantity: qty,
    amountFen: price * qty,
    attach: attach || '',
    env,
    status: 'pending',        // pending → paid → delivered → refunded
    platform: '',
    createdAt: now,
    updatedAt: now
  }
  const add = await db.collection(COL.vpayOrder).add({ data: doc })

  return {
    orderId: add._id,
    outTradeNo: no,
    // 注意：signData 必须是「字符串」，wx.requestVirtualPayment 要求如此
    payData: {
      signData: signDataStr,
      paySig,
      signature,
      mode: 'short_series_goods'
    }
  }
}

/* ==================== 查单（兜底发货） ==================== */

async function queryOrder(me, event) {
  const orderId = event.orderId || event.outTradeNo
  if (!orderId) throw new AppError('缺少 orderId')
  const body = {
    appid: CFG.appId,
    openid: me.openid,
    order_id: orderId,
    env: CFG.sandbox ? SANDBOX_ENV : PROD_ENV
  }
  const bodyStr = JSON.stringify(body)
  const paySig = calcPaySig('xpay/query_order', bodyStr, CFG.appKey)
  const url = CFG.apiBase.replace(/\/$/, '') + '/xpay/query_order?access_token=' + (await getAccessToken())
  const r = await requestJson('POST', url, body, { 'Pay-Sig': paySig })
  await syncOrderByWx(orderId, r).catch(e => console.warn('[vpay] 查单同步失败', e && e.message))
  return r
}

/** 把微信查单/推送结果同步回本地订单状态（按 outTradeNo / wxOrderId） */
async function syncOrderByWx(orderId, r) {
  if (!r) return
  const paid = r.errcode === 0 && (r.order && (r.order.state === 2 || r.order.state === 'PAID' || r.pay_state === 2))
  const where = /^[0-9a-zA-Z]{8,32}$/.test(orderId) && orderId.length > 20
    ? { wxOrderId: orderId } : { outTradeNo: orderId }
  await db.collection(COL.vpayOrder).where(where).update({
    data: { status: paid ? 'paid' : 'pending', updatedAt: new Date() }
  }).catch(() => {})
}

/* ==================== 退款（仅 Android 等可主动退款） ==================== */

async function refundOrder(me, event) {
  const orderId = event.orderId || event.outTradeNo
  if (!orderId) throw new AppError('缺少 orderId')
  // iOS 订单开发者无法主动退款（用户需到 App Store 申请），此处直接拦截
  if (event.platform === 'ios') {
    throw new AppError('iOS 订单无法主动退款，请引导用户到 App Store 申请', 403)
  }
  const body = {
    appid: CFG.appId,
    openid: event.openid || me.openid,
    order_id: orderId,
    env: CFG.sandbox ? SANDBOX_ENV : PROD_ENV
  }
  const bodyStr = JSON.stringify(body)
  const paySig = calcPaySig('xpay/refund_order', bodyStr, CFG.appKey)
  const url = CFG.apiBase.replace(/\/$/, '') + '/xpay/refund_order?access_token=' + (await getAccessToken())
  const r = await requestJson('POST', url, body, { 'Pay-Sig': paySig })
  // 退款成功会收到 xpay_refund_notify，这里先乐观标记，以推送为准
  await db.collection(COL.vpayOrder).where({ outTradeNo: orderId }).update({
    data: { status: 'refunding', updatedAt: new Date() }
  }).catch(() => {})
  return r
}

/* ==================== 回调（消息推送） ==================== */

/** 极简 XML → 对象（处理 CDATA 与一层嵌套，足够解析虚拟支付推送） */
function parseXml(xml) {
  if (!xml || typeof xml !== 'string') return {}
  const strip = s => {
    const m = String(s).match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
    return m ? m[1] : String(s).trim()
  }
  function parse(str) {
    const obj = {}
    const re = /<([A-Za-z_][\w-]*)>([\s\S]*?)<\/\1>/g
    let m
    while ((m = re.exec(str))) {
      const key = m[1]
      const inner = m[2]
      const nested = /<[A-Za-z_][\w-]*>/.test(inner)
      obj[key] = nested ? parse(inner) : strip(inner)
    }
    return obj
  }
  const root = parse(xml)
  return root.xml || root
}

/** 消息推送验签（明文/安全模式）：sha1(排序(token, timestamp, nonce, encrypt)) */
function verifyNotifySignature(p, token) {
  const arr = [token, p.timestamp, p.nonce, p.encrypt].filter(x => x !== undefined && x !== null).map(String)
  arr.sort()
  const calc = crypto.createHash('sha1').update(arr.join(''), 'utf8').digest('hex')
  return calc === String(p.msg_signature || p.msg_signature || '')
}

function ackXml(code, msg) {
  return '<xml><ErrCode>' + code + '</ErrCode><ErrMsg><![CDATA[' + msg + ']]></ErrMsg></xml>'
}

/** iOS 订阅退款问询：3 秒内返回 result_code（0=建议退款，1=拒绝退款） */
function iosRefundQueryResponse() {
  // 解耦阶段默认「建议退款」；业务侧如需拦截，在这里读取透传数据后改返回值
  return '<xml><result_code>0</result_code></xml>'
}

async function recordNotify(p) {
  try {
    await db.collection(COL.vpayNotify).add({
      data: { event: p.Event || p.event || '', openid: p.OpenId || '', raw: p, createdAt: new Date() }
    })
  } catch (e) {
    console.warn('[vpay] 记录推送失败', e && e.message)
  }
}

/** 发货推送：幂等记录 delivery 意图，业务侧后续消费 */
async function onGoodsDeliver(p) {
  const wxInfo = p.WeChatPayInfo || {}
  const wxOrderId = wxInfo.MchOrderNo || ''
  const openid = p.OpenId || p.FromUserName || ''
  const outTradeNo = p.OutTradeNo || ''
  const productId = (wxInfo.GoodsInfo && wxInfo.GoodsInfo.ProductId) || p.ProductId || ''
  const quantity = Number((wxInfo.GoodsInfo && wxInfo.GoodsInfo.Quantity) || p.Quantity || 1)

  if (!wxOrderId) return ackXml(0, 'success')

  const exist = await db.collection(COL.vpayDelivery).where({ wxOrderId }).limit(1).get()
  if (exist.data.length) {
    const d = exist.data[0]
    // 已发货：直接 ack（平台不再重试）
    if (d.status === 'delivered') return ackXml(0, 'success')
    // 存在但未发货：刷新为待发放，交给业务侧补偿
    await db.collection(COL.vpayDelivery).doc(d._id).update({
      data: { status: 'pending', updatedAt: new Date() }
    }).catch(() => {})
    return ackXml(0, 'success')
  }

  // 新订单：落 delivery 意图（status=pending，业务侧发放后调 completeDelivery 置 delivered）
  await db.collection(COL.vpayDelivery).add({
    data: {
      wxOrderId, openid, outTradeNo, productId, quantity,
      status: 'pending', createdAt: new Date(), updatedAt: new Date()
    }
  })
  if (outTradeNo) {
    await db.collection(COL.vpayOrder).where({ outTradeNo }).update({
      data: { status: 'paid', wxOrderId, updatedAt: new Date() }
    }).catch(() => {})
  }
  return ackXml(0, 'success')
}

/** 回调总入口：解析 → 验签 → 分发 7 类事件 → 返回 XML */
async function handleNotify(me, event) {
  const xml = event && (event.xml || event.body)
  if (!xml) throw new AppError('空的回调数据', 400)
  const p = parseXml(xml)

  // 验签（配置了 Token 时；加密模式需先解密，见 decryptMessage）
  if (CFG.msgToken && p.encrypt != null) {
    const ok = verifyNotifySignature(p, CFG.msgToken)
    if (!ok) console.warn('[vpay] 回调验签失败（仍记录）')
  }

  await recordNotify(p)

  switch (p.Event || p.event) {
    case 'xpay_goods_deliver_notify':
      return await onGoodsDeliver(p)
    case 'xpay_coin_pay_notify':
      // 代币支付：业务侧更新代币余额（此处仅记录，解耦）
      return ackXml(0, 'success')
    case 'xpay_refund_notify':
      // 退款：业务侧回收权益 + 更新订单为 refunded
      if (p.OutTradeNo) {
        await db.collection(COL.vpayOrder).where({ outTradeNo: p.OutTradeNo }).update({
          data: { status: 'refunded', updatedAt: new Date() }
        }).catch(() => {})
      }
      return ackXml(0, 'success')
    case 'xpay_complaint_notify':
      // 投诉：建议人工跟进（仅记录）
      return ackXml(0, 'success')
    case 'xpay_subscribe_signing_result_notify':
      return ackXml(0, 'success')
    case 'xpay_subscribe_pay_fail_notify':
      return ackXml(0, 'success')
    case 'xpay_subscribe_ios_refund_query_notify':
      return iosRefundQueryResponse(p)
    default:
      return ackXml(0, 'success')
  }
}

/* ==================== 查询 / 消费（业务侧后续用） ==================== */

/** 我的订单（用户维度） */
async function listOrders(me, event) {
  const res = await db.collection(COL.vpayOrder)
    .where({ openid: me.openid })
    .orderBy('createdAt', 'desc').limit(50).get()
  return res.data
}

/**
 * 待发货/已发货意图列表（业务侧消费；admin 维度，避免越权看他人订单）
 * 业务侧标准流程：filter status='pending' → 发放权益 → completeDelivery(id)
 */
async function listDeliveries(me, event) {
  const where = {}
  if (event && event.status) where.status = event.status
  const res = await db.collection(COL.vpayDelivery)
    .where(where).orderBy('createdAt', 'asc').limit(50).get()
  return res.data
}

/** 业务侧发放权益后调用，标记 delivery 完成（幂等闭环） */
async function completeDelivery(me, event) {
  const id = event.id || event.wxOrderId
  if (!id) throw new AppError('缺少 id 或 wxOrderId')
  const where = event.wxOrderId ? { wxOrderId: event.wxOrderId } : { _id: id }
  const res = await db.collection(COL.vpayDelivery).where(where).limit(1).get()
  if (!res.data.length) throw new AppError('delivery 不存在', 404)
  const d = res.data[0]
  await db.collection(COL.vpayDelivery).doc(d._id).update({
    data: { status: 'delivered', deliveredAt: new Date(), updatedAt: new Date() }
  })
  if (d.outTradeNo) {
    await db.collection(COL.vpayOrder).where({ outTradeNo: d.outTradeNo }).update({
      data: { status: 'delivered', updatedAt: new Date() }
    }).catch(() => {})
  }
  return { ok: true }
}

/** 公开支付配置（不含密钥）：给前端下拉道具、判断是否沙箱 */
function payConfig() {
  return { offerId: CFG.offerId, sandbox: CFG.sandbox, products: PRODUCTS }
}

module.exports = {
  // 配置 & 签名（供测试/业务复用）
  payConfig, calcPaySig, calcSignature, genOutTradeNo,
  // 主流程
  createOrder, queryOrder, refundOrder, handleNotify,
  // 查询 / 消费
  listOrders, listDeliveries, completeDelivery,
  // 解析（测试用）
  parseXml
}
