/**
 * 通知：站内通知（必定可用）+ 微信订阅消息（需配置，未配置静默跳过）。
 *
 * 背景（2026-10-30 用户反馈）：用户提交入校/建校申请后，管理员**收不到任何通知** ——
 * 审核入口虽然在超管后台，但没有任何提示，管理员只有主动进去翻才知道有人申请，
 * 于是申请就一直挂着。本项目此前完全没有通知通道。
 *
 * 两条路，缺一不可：
 *  1. **站内通知（notices 集合）**：零外部依赖，部署即可用。
 *     管理员打开小程序就能看到未读红点与待审入口。缺点是必须主动打开才看得到。
 *  2. **订阅消息**：真·推送到微信聊天列表，是「通知」的完整形态。
 *     但要先在 MP 后台申请模板、且管理员需点一次授权（一次性订阅）。
 *     所以做成**可选增强**：没配模板 ID 就静默跳过，绝不能因为没配就让提交失败。
 *
 * ⚠️ 通知是**附属动作**：写入/发送失败一律只记日志，不能影响主业务（用户提交申请）。
 */

const {
  cloud, db, _, COL, SUPER_ADMIN_OPENIDS, isCollectionMissing, ensureCollection
} = require('./core')

/**
 * 订阅消息模板 ID（云函数环境变量）。
 * 没配 = 功能关闭，`sendSubscribe` 直接返回 0，不报错。
 */
const TMPL = {
  schoolApply: (process.env.SUBSCRIBE_TMPL_SCHOOL_APPLY || '').trim()
}

/** 时间格式化为微信订阅消息要求的 `YYYY-MM-DD HH:mm` */
function fmtTime(d) {
  const x = d instanceof Date ? d : new Date(d)
  if (isNaN(x.getTime())) return ''
  const p = n => (n < 10 ? '0' + n : '' + n)
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate())
    + ' ' + p(x.getHours()) + ':' + p(x.getMinutes())
}

/**
 * 给所有超管批量落一条站内通知。
 *
 * 收件人取 `SUPER_ADMIN_OPENIDS`（超管是 openid 白名单，不是 role）——
 * 审核权限就是 `requireSuper`，发给普通 admin 他点进去也审不了，只会造成误导。
 *
 * 一次批量 add（云开发支持数组），不是循环 await：循环会把耗时线性叠加，
 * 云函数 3s 预算下这是最容易踩的坑。
 */
async function pushToSuperAdmins(doc) {
  if (!SUPER_ADMIN_OPENIDS.length) return 0
  const now = new Date()
  const rows = SUPER_ADMIN_OPENIDS.map(openid => Object.assign({}, doc, {
    openid,
    _openid: openid,   // 与 schoolApply 一致：显式写，权限规则「仅创建者可读写」才命中
    read: false,
    createdAt: now
  }))
  try {
    await db.collection(COL.notice).add({ data: rows })
  } catch (e) {
    // 集合没建（没跑 initCollections）→ 建了再写一次
    if (!isCollectionMissing(e)) throw e
    await ensureCollection(COL.notice)
    await db.collection(COL.notice).add({ data: rows })
  }
  return rows.length
}

/**
 * 发微信订阅消息（云调用，无需 access_token）。
 *
 * @returns {Promise<number>} 成功发出的人数
 *
 * 未授权（43101）是预期内的：一次性订阅要管理员先点授权，没授权就收不到。
 * 这类错误不刷错误日志，否则控制台会被「用户没授权」刷满，掩盖真问题。
 */
async function sendSubscribe(openids, templateId, payload) {
  if (!templateId || !openids.length) return 0
  const jobs = openids.map(touser =>
    cloud.openapi.subscribeMessage.send(Object.assign({
      touser,
      templateId,
      miniprogramState: 'formal'
    }, payload))
      .then(() => 1)
      .catch(e => {
        const msg = String((e && (e.errMsg || e.errCode || e.message)) || '')
        if (!/43101|refuse|not subscribe/i.test(msg)) {
          console.warn('[notify] 订阅消息发送失败', touser, msg)
        }
        return 0
      })
  )
  const rs = await Promise.all(jobs)
  return rs.filter(Boolean).length
}

/**
 * 入校 / 建校申请提交后的通知（站内 + 订阅消息）。
 *
 * @param {Object} apply 已落库的申请（含 _id / type / schoolName / name / nickName）
 */
async function schoolApplySubmitted(apply) {
  const isJoin = apply.type === 'join'
  const label = isJoin ? (apply.schoolName || '该校') : (apply.name || '该校')
  const kind = isJoin ? '入校申请' : '建校申请'
  const title = '新的' + kind + '待审'
  const who = String(apply.nickName || '有用户').slice(0, 10)
  const content = who + (isJoin ? ' 申请加入「' : ' 申请新建「') + label + '」'

  // 站内通知：失败只记日志（不能让用户「提交失败」）
  let pushed = 0
  try {
    pushed = await pushToSuperAdmins({
      type: 'school_apply',
      refType: 'schoolApply',
      refId: apply._id || '',
      title,
      content
    })
  } catch (e) {
    console.warn('[notify] 站内通知写入失败', e && (e.message || e))
  }

  // 订阅消息：配了模板才发，失败同样不影响主流程
  if (TMPL.schoolApply) {
    sendSubscribe(SUPER_ADMIN_OPENIDS, TMPL.schoolApply, {
      page: 'pages/admin/admin',
      data: {
        // ⚠️ 模板字段约定（MP 后台选模板时须带这三个关键词，否则微信拒发）：
        //   thing1 标题 / thing2 内容 / time3 时间
        thing1: { value: (who + ' 的' + kind).slice(0, 20) },
        thing2: { value: content.slice(0, 20) },
        time3: { value: fmtTime(new Date()) }
      }
    }).catch(() => {})
  }

  return pushed
}

/**
 * 我的通知（含未读数）。集合没建 = 「没有通知」，不是故障。
 * 这个接口每次进「我的」页都可能调，必须轻且绝不因为集合缺失就抛错。
 */
async function listNotices(me, event) {
  const size = Math.min(Math.max(Number((event && event.size) || 20), 1), 50)
  try {
    const res = await db.collection(COL.notice)
      .where({ openid: me.openid })
      .orderBy('createdAt', 'desc')
      .limit(size)
      .get()
    const list = res.data || []
    return { list, unread: list.filter(n => !n.read).length }
  } catch (e) {
    if (!isCollectionMissing(e)) throw e
    ensureCollection(COL.notice)      // 后台副作用，不 await（见 core.js 性能红线）
    return { list: [], unread: 0 }
  }
}

/** 标记已读：不传 ids = 我的全部置为已读 */
async function markNoticesRead(me, event) {
  const ids = (event && event.ids) || []
  try {
    if (ids.length) {
      await db.collection(COL.notice)
        .where({ openid: me.openid, _id: _.in(ids) })
        .update({ data: { read: true, readAt: new Date() } })
    } else {
      await db.collection(COL.notice)
        .where({ openid: me.openid, read: false })
        .update({ data: { read: true, readAt: new Date() } })
    }
  } catch (e) {
    if (!isCollectionMissing(e)) throw e
    return { ok: false, reason: 'collection_missing' }
  }
  return { ok: true }
}

/**
 * 前端据此决定是否显示「开启申请通知」入口：
 * 模板 ID 没配时，让管理员点授权是没有意义的（点了也收不到）。
 */
function notifyConfig() {
  // templateId 要下发：前端 wx.requestSubscribeMessage 必须拿它去请求授权，
  // 而模板 ID 只存在云函数环境变量里，前端无从得知。
  return { subscribeEnabled: !!TMPL.schoolApply, templateId: TMPL.schoolApply }
}

module.exports = {
  schoolApplySubmitted, listNotices, markNoticesRead, notifyConfig,
  pushToSuperAdmins, sendSubscribe
}
