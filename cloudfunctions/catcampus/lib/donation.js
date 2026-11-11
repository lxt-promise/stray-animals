/**
 * 咪咪筹（MimiChou）—— 校园猫咪医疗 / 绝育筹款模块（lib/donation.js）
 * ---------------------------------------------------------------------------
 * 参考水滴筹的信息结构，但按校园流浪猫场景做了裁剪：
 *   1. 筹款必须绑定**已有猫档案**（catId），不接受"凭空发起一只猫"，
 *      这样每一笔钱都能落到具体某只猫的档案与治疗记录上，事后可查。
 *   2. 类型只有两种：medical（生病/受伤治疗）、tnr（绝育手术）。
 *   3. 任何人都能发起（在校学生捡到病猫也能筹），但**普通用户发起必须审核**；
 *      管理员/超管发起直接通过（他们本来就在替社团管钱）。
 *   4. 材料（诊断证明、费用清单、患处照片、医院单据）随发起一起上传，
 *      存在 campaign.materials；默认公开展示，发起人可逐条设为"仅审核可见"
 *      （病历上往往有主人姓名/电话，隐私要留口子）。
 *   5. 收款：微信虚拟支付（lib/vpay.js）。⚠️ 不要接支付宝/个人收款码，
 *      微信小程序运营规范禁止引导站外支付，详见 docs/业务规则/咪咪筹模块.md。
 *
 * 资金口径（与既有「收支公示」对齐）：
 *   - 捐助成功 → funds 写一条 income/category='donation'，同时原子累加 raisedAmount
 *   - 管理员上传票据 → funds 写一条 expense/category='medical'，累加 expenseTotal
 *   - 筹款活动本身不持有资金，只是 funds 上的一个维度（campaignId）
 *
 * 合规红线：
 *   - 端上不出现「AI」措辞（本模块不涉及，但文案统一走中性表达）
 *   - 不展示内部审核权重/风控规则，审核驳回只给中性文案 + 可申诉提示
 */
const { db, _, COL, AppError, warmCollection } = require('./core')
const sec = require('./security')
const vpay = require('./vpay')

/** 虚拟支付道具 ID（必须在 MP 后台「虚拟支付 → 道具管理」创建同名道具） */
const DONATE_PRODUCT_ID = process.env.VPAY_DONATE_PRODUCT_ID || 'donate_1'

/** 筹款类型 */
const KIND_LABEL = {
  medical: '医疗救助',
  tnr: '绝育救助'
}

/** 材料类型（前端 utils/const.js 保持同口径） */
const MATERIAL_LABEL = {
  diagnosis: '诊断证明',
  invoice: '费用清单',
  photo: '患处 / 术前照片',
  hospital: '医院单据',
  other: '其他材料'
}

/** 审核状态 */
const REVIEW_LABEL = {
  pending: '审核中',
  approved: '已通过',
  rejected: '未通过'
}

const MAX_GOAL = 200000        // 目标金额上限（元），与单笔捐助上限一致
const MIN_GOAL = 100
const MAX_MATERIALS = 9
const MAX_DAYS = 90            // 单次筹款最长 90 天
const MAX_PENDING_PER_USER = 2 // 同一个人同时最多 2 条待审，防刷

/* ==================== 工具 ==================== */

function yuan(n) {
  const v = Math.round(Number(n) * 100) / 100
  return isFinite(v) ? v : 0
}

function isAdminRole(me) {
  return !!(me && (me.role === 'admin' || me.role === 'super'))
}

/** 捐助人昵称脱敏：张三 → 张* ；爱心网友保持 */
function maskDonor(name) {
  if (!name) return '爱心网友'
  const s = String(name).trim()
  if (s.length <= 1) return s + '**'
  if (s.length === 2) return s[0] + '*'
  return s[0] + '*'.repeat(Math.min(s.length - 2, 6)) + s[s.length - 1]
}

/** 剩余天数（结束当天算 0） */
function daysLeftOf(endDate) {
  if (!endDate) return null
  const t = new Date(endDate).getTime()
  if (!isFinite(t)) return null
  const d = Math.ceil((t - Date.now()) / 86400000)
  return d > 0 ? d : 0
}

async function getCampaignDoc(id) {
  if (!id) throw new AppError('筹款不存在', 400)
  const r = await db.collection(COL.campaign).doc(id).get().catch(() => null)
  if (!r || !r.data) throw new AppError('这条筹款不存在或已被删除', 404)
  return r.data
}

/** 列表用精简结构（不带材料/进展正文，避免列表包体过大） */
function stripCampaign(c) {
  return {
    _id: c._id,
    catId: c.catId,
    catName: c.catName || '',
    catAvatar: c.catAvatar || '',
    kind: c.kind || 'medical',
    kindLabel: KIND_LABEL[c.kind] || KIND_LABEL.medical,
    title: c.title || '',
    summary: String(c.reason || '').slice(0, 60),
    goalAmount: yuan(c.goalAmount),
    raisedAmount: yuan(c.raisedAmount),
    expenseTotal: yuan(c.expenseTotal),
    status: c.status || 'active',
    reviewStatus: c.reviewStatus || 'approved',
    reviewStatusLabel: REVIEW_LABEL[c.reviewStatus] || '',
    reviewNote: c.reviewStatus === 'rejected' ? (c.reviewNote || '材料不完整') : '',
    applicantName: c.applicantName || '',
    applicantIsAdmin: !!c.applicantIsAdmin,
    materialCount: (c.materials || []).length,
    updateCount: (c.updates || []).length,
    donorCount: c.donorCount || 0,
    endDate: c.endDate || null,
    daysLeft: daysLeftOf(c.endDate),
    closedReason: c.closedReason || '',
    createdAt: c.createdAt
  }
}

/** 写一条给指定用户的站内通知（失败只记日志，绝不阻断主流程） */
async function pushNotice(openid, doc) {
  if (!openid) return
  try {
    await db.collection(COL.notice).add({
      data: Object.assign({}, doc, {
        openid,
        _openid: openid,
        read: false,
        createdAt: new Date()
      })
    })
  } catch (e) {
    console.warn('[donation] 站内通知写入失败', e && e.message)
  }
}

/* ==================== 发起筹款 ==================== */

/**
 * 发起筹款（任何登录用户；普通用户 → 待审核，管理员 → 直接通过）
 *
 * event.data = {
 *   catId, kind: 'medical'|'tnr', title, reason,
 *   goalAmount, endDate, hospital,
 *   materials: [{ type, fileID, note, public }]
 * }
 */
async function createCampaign(me, event) {
  const d = event.data || {}
  const catId = String(d.catId || '')
  if (!catId) throw new AppError('请选择要筹款的猫咪档案')

  // 必须是已存在的档案：钱要落到具体的猫身上，事后能对上治疗记录
  const catRes = await db.collection(COL.cat).doc(catId).get().catch(() => null)
  const cat = catRes && catRes.data
  if (!cat) throw new AppError('这只猫咪的档案不存在，请先建档案')

  const schoolId = cat.schoolId || me.schoolId || ''
  if (!schoolId) throw new AppError('请先绑定学校')
  if (me.schoolId && cat.schoolId && cat.schoolId !== me.schoolId) {
    throw new AppError('不能为其他学校的猫咪发起筹款', 403)
  }
  if (cat.status === 'rainbow') {
    throw new AppError('去喵星的猫咪不再发起筹款')
  }

  const kind = KIND_LABEL[d.kind] ? d.kind : 'medical'
  const title = String(d.title || '').trim()
  const reason = String(d.reason || '').trim()
  if (title.length < 4 || title.length > 40) throw new AppError('标题请填 4~40 个字')
  if (reason.length < 10 || reason.length > 1000) throw new AppError('情况说明请填 10~1000 个字')

  const goal = yuan(d.goalAmount)
  if (!(goal >= MIN_GOAL) || goal > MAX_GOAL) {
    throw new AppError('目标金额需在 ¥' + MIN_GOAL + ' ~ ¥' + MAX_GOAL + ' 之间')
  }

  // 截止日期：可空（不限期），填了就必须在 1~90 天内
  let endDate = null
  if (d.endDate) {
    const t = new Date(d.endDate).getTime()
    if (!isFinite(t)) throw new AppError('截止日期格式不对')
    const diff = t - Date.now()
    if (diff <= 0) throw new AppError('截止日期要晚于今天')
    if (diff > MAX_DAYS * 86400000) throw new AppError('单次筹款最长 ' + MAX_DAYS + ' 天')
    endDate = new Date(t)
  }

  // 材料：只收云存储 fileID（前端 uploadFile 得到），非法的静默丢弃而不是整单失败
  const materials = (Array.isArray(d.materials) ? d.materials : [])
    .filter(m => m && /^cloud:\/\//.test(String(m.fileID || '')))
    .slice(0, MAX_MATERIALS)
    .map(m => ({
      type: MATERIAL_LABEL[m.type] ? m.type : 'other',
      fileID: String(m.fileID),
      note: String(m.note || '').slice(0, 40),
      public: m.public !== false,
      at: new Date()
    }))

  // 并发保护：同一只猫只能有一条「已通过且进行中」的筹款
  const dup = await db.collection(COL.campaign)
    .where({ catId, status: 'active', reviewStatus: 'approved' })
    .limit(1).get().catch(() => ({ data: [] }))
  if (dup.data && dup.data.length) {
    throw new AppError('这只猫已有进行中的筹款，先完成或结束它再发起')
  }

  // 防刷：同一账号同时最多 2 条待审
  if (!isAdminRole(me)) {
    const mine = await db.collection(COL.campaign)
      .where({ applicantOpenid: me.openid, reviewStatus: 'pending' })
      .count().catch(() => ({ total: 0 }))
    if ((mine.total || 0) >= MAX_PENDING_PER_USER) {
      throw new AppError('你还有 ' + (mine.total || 0) + ' 条筹款在审核中，请等审核结果')
    }
  }

  // 内容安全（标题 + 正文），失败直接拦，避免违规内容公开展示
  const safe = await Promise.all([sec.checkText(title), sec.checkText(reason)])
  if (safe.indexOf(false) >= 0) throw new AppError('内容含不合适的信息，请修改后再提交')

  const now = new Date()
  const admin = isAdminRole(me)
  const doc = {
    catId,
    schoolId,
    catName: cat.name || '',
    catAvatar: cat.avatar || (cat.photos && cat.photos[0]) || '',
    kind,
    title,
    // reason 是历史字段名，前端与旧数据都用它承载"情况说明"
    reason,
    hospital: String(d.hospital || '').slice(0, 40),
    goalAmount: goal,
    raisedAmount: 0,
    expenseTotal: 0,
    donorCount: 0,
    materials,
    status: 'active',                                  // active | fulfilled | closed
    reviewStatus: admin ? 'approved' : 'pending',       // pending | approved | rejected
    reviewNote: '',
    reviewedBy: admin ? (me.nickName || '管理员') : '',
    reviewedAt: admin ? now : null,
    applicantOpenid: me.openid,
    applicantName: me.nickName || '爱猫同学',
    applicantIsAdmin: admin,
    // 联系方式只给审核管理员看，公开页不下发（避免骚扰/诈骗引流）
    contact: String(d.contact || '').slice(0, 40),
    endDate,
    updates: [],
    createdBy: me.openid,
    createdAt: now,
    updatedAt: now
  }
  const add = await db.collection(COL.campaign).add({ data: doc })

  if (!admin) {
    // 通知超管来审。失败不影响发起结果。
    try {
      const notify = require('./notify')
      await notify.pushToSuperAdmins({
        type: 'campaign_review',
        refType: 'campaign',
        refId: add._id,
        title: '有新的咪咪筹待审核',
        content: (doc.applicantName + ' 为「' + (doc.catName || '猫咪') + '」发起' +
          KIND_LABEL[kind] + '，目标 ¥' + goal)
      })
    } catch (e) {
      console.warn('[donation] 审核通知失败', e && e.message)
    }
  }

  return Object.assign({}, stripCampaign(doc), { _id: add._id, needReview: !admin })
}

/* ==================== 列表 / 详情 ==================== */

/**
 * 列表
 * scope = public（默认，所有人可见已通过的）| mine（我发起的）| review（管理员待审）
 */
async function listCampaigns(me, event) {
  const scope = (event && event.scope) || 'public'
  const admin = isAdminRole(me)

  if (scope === 'review') {
    if (!admin) throw new AppError('需要管理员权限', 403)
    const res = await db.collection(COL.campaign)
      .where({ reviewStatus: 'pending' })
      .orderBy('createdAt', 'asc').limit(50).get().catch(() => ({ data: [] }))
    return { list: (res.data || []).map(stripCampaign), pendingTotal: (res.data || []).length }
  }

  if (scope === 'mine') {
    if (!me) throw new AppError('请先登录', 401)
    const res = await db.collection(COL.campaign)
      .where({ applicantOpenid: me.openid })
      .orderBy('createdAt', 'desc').limit(50).get().catch(() => ({ data: [] }))
    return { list: (res.data || []).map(c => Object.assign(stripCampaign(c), { isMine: true })) }
  }

  // 公开列表：必须已通过审核；按学校隔离（未绑校返回空，与 listCats 同口径）
  const schoolId = (event && event.schoolId) || (me && me.schoolId) || ''
  if (!schoolId) return { list: [] }
  // 进行中与已结束都下发（前端分 tab 过滤）。
  // 已结束的也展示，是水滴筹式的「公信力」做法：钱花完了、结项了要能查到。
  const where = { schoolId, reviewStatus: 'approved' }
  const res = await db.collection(COL.campaign)
    .where(where).orderBy('createdAt', 'desc').limit(50).get().catch(() => ({ data: [] }))
  return { list: (res.data || []).map(stripCampaign) }
}

async function getCampaign(me, event) {
  const c = await getCampaignDoc(event.id)
  const admin = isAdminRole(me)
  const mine = !!me && (c.applicantOpenid === me.openid || c.createdBy === me.openid)

  if (c.reviewStatus !== 'approved' && !mine && !admin) {
    throw new AppError('这条筹款还在审核中', 403)
  }

  const [exp, cnt, donors] = await Promise.all([
    db.collection(COL.fund).where({ campaignId: c._id, type: 'expense' })
      .orderBy('date', 'desc').limit(50).get().catch(() => ({ data: [] })),
    db.collection(COL.fund).where({ campaignId: c._id, category: 'donation' })
      .count().catch(() => ({ total: 0 })),
    db.collection(COL.fund).where({ campaignId: c._id, category: 'donation' })
      .orderBy('createdAt', 'desc').limit(10).get().catch(() => ({ data: [] }))
  ])

  // 材料可见性：发起人/管理员看全部；其他人只看发起人标为公开的
  const canSeeAll = mine || admin
  const materials = (c.materials || [])
    .filter(m => canSeeAll || m.public !== false)
    .map(m => ({
      type: m.type,
      typeLabel: MATERIAL_LABEL[m.type] || MATERIAL_LABEL.other,
      fileID: m.fileID,
      note: m.note || '',
      public: m.public !== false,
      at: m.at
    }))

  return {
    campaign: Object.assign(stripCampaign(c), {
      reason: c.reason || '',
      hospital: c.hospital || '',
      updates: (c.updates || []).map(u => ({
        text: u.text || '', images: u.images || [], createdAt: u.createdAt
      })),
      materials,
      hiddenMaterialCount: (c.materials || []).length - materials.length,
      // 联系方式只给管理员（审核需要回访），不给发起人自己以外的人
      contact: admin ? (c.contact || '') : ''
    }),
    expenses: (exp.data || []).map(e => ({
      _id: e._id, amount: yuan(e.amount), title: e.title,
      date: e.date, proof: e.proof || [], operator: e.operator
    })),
    donationCount: (cnt && cnt.total) || 0,
    recentDonors: (donors.data || []).map(d => ({
      donorName: d.donorName || '爱心网友',
      amount: yuan(d.amount),
      date: d.date
    })),
    isAdmin: admin,
    isMine: mine
  }
}

/* ==================== 审核 / 结束 / 举报 ==================== */

/** 管理员审核：approve=true 通过，false 驳回（note 为处理说明） */
async function reviewCampaign(me, event) {
  const c = await getCampaignDoc(event.id)
  const pass = event.approve === true
  const note = String(event.note || '').slice(0, 100)
  if (!pass && !note) throw new AppError('驳回时请填写原因，方便发起人修改')

  if (pass) {
    // 通过前再查一次并发（另一条同猫筹款可能刚被通过）
    const dup = await db.collection(COL.campaign)
      .where({ catId: c.catId, status: 'active', reviewStatus: 'approved' })
      .limit(2).get().catch(() => ({ data: [] }))
    const others = (dup.data || []).filter(x => x._id !== c._id)
    if (others.length) throw new AppError('这只猫已有进行中的筹款，请先结束那一条')
  }

  const now = new Date()
  await db.collection(COL.campaign).doc(c._id).update({
    data: {
      reviewStatus: pass ? 'approved' : 'rejected',
      reviewNote: note,
      reviewedBy: me.nickName || '管理员',
      reviewedAt: now,
      // 只改审核态，不动活动状态：已结束/已完成的不能被「通过」重新拉回进行中
      status: c.status || 'active'
    }
  })

  await pushNotice(c.applicantOpenid, {
    type: 'campaign_review_result',
    refType: 'campaign',
    refId: c._id,
    title: pass ? '筹款已通过审核' : '筹款未通过审核',
    content: pass
      ? '「' + c.title + '」已通过审核，现在可以在校园里转发了'
      : '「' + c.title + '」未通过：' + note + '（可修改后重新提交）'
  })

  return { ok: true, reviewStatus: pass ? 'approved' : 'rejected' }
}

/** 结束筹款：发起人本人或管理员 */
async function closeCampaign(me, event) {
  const c = await getCampaignDoc(event.id)
  const mine = c.applicantOpenid === me.openid || c.createdBy === me.openid
  if (!mine && !isAdminRole(me)) throw new AppError('只有发起人或管理员可以结束筹款', 403)
  if (c.status === 'closed') return { ok: true }
  const reason = String(event.reason || '').slice(0, 60) || '已结束'
  await db.collection(COL.campaign).doc(c._id).update({
    data: { status: 'closed', closedReason: reason, updatedAt: new Date() }
  })
  return { ok: true }
}

/** 举报：只落通知给超管，不在前台暴露处理过程 */
async function reportCampaign(me, event) {
  const c = await getCampaignDoc(event.id)
  const reason = String(event.reason || '').slice(0, 80) || '信息可疑'
  try {
    const notify = require('./notify')
    await notify.pushToSuperAdmins({
      type: 'campaign_report',
      refType: 'campaign',
      refId: c._id,
      title: '筹款被举报',
      content: (me.nickName || '有用户') + ' 举报「' + c.title + '」：' + reason
    })
  } catch (e) {
    console.warn('[donation] 举报通知失败', e && e.message)
  }
  return { ok: true }
}

/* ==================== 捐助（走微信虚拟支付） ==================== */

async function donateToCampaign(me, event) {
  const c = await getCampaignDoc(event.campaignId)
  if (c.reviewStatus !== 'approved') throw new AppError('这条筹款还没通过审核，暂时不能捐助')
  if (c.status !== 'active') throw new AppError('这条筹款已结束，感谢关注')
  if (c.applicantOpenid && c.applicantOpenid === me.openid) {
    throw new AppError('不能给自己的筹款捐助')
  }
  if (c.schoolId && me.schoolId && c.schoolId !== me.schoolId) {
    throw new AppError('不可捐助其他学校的筹款', 403)
  }
  const amount = yuan(event.amount)
  if (!amount || amount <= 0) throw new AppError('请输入有效金额')
  if (amount > 200000) throw new AppError('单笔捐助不能超过 20 万元')

  const fen = Math.round(amount * 100)
  const donorName = maskDonor(event.donorName || me.nickName || '爱心网友')
  // attach 透传：支付成功推送时据此把款项记到对应筹款
  const attach = JSON.stringify({
    kind: 'donation',
    campaignId: c._id,
    catId: c.catId,
    donorName,
    note: String(event.note || '').slice(0, 50)
  })

  // loginCode 由前端 wx.login() 取得，用于虚拟支付的用户态签名
  const order = await vpay.createOrder(me, {
    productId: DONATE_PRODUCT_ID,
    goodsPrice: fen,
    buyQuantity: 1,
    attach,
    loginCode: event.loginCode
  })
  return order // { orderId, outTradeNo, payData }
}

/**
 * 支付成功后的入账钩子（由 vpay.onGoodsDeliver 在发货意图落库后 fire-and-forget 调用）。
 * 把这笔虚拟支付订单对应的善款记进 funds，并原子累加筹款已筹金额。
 * 幂等：按 outTradeNo 去重，重复推送不会重复入账。
 */
async function applyDelivery(delivery) {
  try {
    if (!delivery || !delivery.outTradeNo) return
    const orderRes = await db.collection(COL.vpayOrder)
      .where({ outTradeNo: delivery.outTradeNo }).limit(1).get()
    if (!orderRes.data || !orderRes.data.length) return
    const o = orderRes.data[0]
    if (!o.attach) return
    let attach
    try { attach = JSON.parse(o.attach) } catch (e) { return }
    if (!attach || attach.kind !== 'donation') return

    const campaignId = attach.campaignId
    const amount = yuan((Number(o.amountFen) || 0) / 100)
    if (!campaignId || amount <= 0) return

    const camp = await getCampaignDoc(campaignId).catch(() => null)
    const schoolId = camp ? camp.schoolId : ''

    warmCollection(COL.fund)
    warmCollection(COL.campaign)

    // 幂等去重
    const dup = await db.collection(COL.fund)
      .where({ category: 'donation', outTradeNo: o.outTradeNo }).limit(1).get()
    if (dup.data && dup.data.length) return

    const now = new Date()
    await db.collection(COL.fund).add({
      data: {
        type: 'income',
        category: 'donation',
        campaignId,
        catId: attach.catId || '',
        schoolId,
        amount,
        title: '咪咪筹捐助',
        donorOpenid: o.openid,
        donorName: attach.donorName || '爱心网友',
        outTradeNo: o.outTradeNo,
        proof: [],
        verified: true,
        date: now,
        createdBy: o.openid,
        createdAt: now
      }
    })
    // 原子自增已筹 + 人数，避免并发覆盖
    await db.collection(COL.campaign).doc(campaignId).update({
      data: {
        raisedAmount: _.inc(amount),
        donorCount: _.inc(1),
        updatedAt: now
      }
    }).catch(() => {})
  } catch (e) {
    // 钩子失败不能影响微信推送 ack；记录日志，后续可由 listCampaignDonations 对账发现缺口
    console.warn('[donation] applyDelivery 失败', e && e.message)
  }
}

/* ==================== 进展 / 支出 ==================== */

/** 进展：发起人或管理员可发（水滴筹式"报平安"） */
async function addCampaignUpdate(me, event) {
  const c = await getCampaignDoc(event.id)
  const mine = c.applicantOpenid === me.openid || c.createdBy === me.openid
  if (!mine && !isAdminRole(me)) throw new AppError('只有发起人或管理员可以更新进展', 403)
  const text = String(event.text || '').trim()
  if (!text) throw new AppError('请填写进展内容')
  if (!(await sec.checkText(text))) throw new AppError('内容含不合适的信息，请修改')
  const images = (Array.isArray(event.images) ? event.images : [])
    .filter(x => /^cloud:\/\//.test(String(x))).slice(0, 9)
  const update = { text: text.slice(0, 500), images, createdAt: new Date() }
  await db.collection(COL.campaign).doc(c._id).update({
    data: { updates: _.push(update), updatedAt: new Date() }
  })
  return { ok: true }
}

/** 支出：仅管理员登记（发起人自证支出等于既当运动员又当裁判） */
async function addCampaignExpense(me, event) {
  const c = await getCampaignDoc(event.id)
  const amount = yuan(event.amount)
  if (!amount || amount <= 0) throw new AppError('请填写有效支出金额')
  const title = String(event.title || '医疗支出').trim().slice(0, 40)
  if (!(await sec.checkText(title))) throw new AppError('内容含不合适的信息，请修改')
  const proof = (Array.isArray(event.proof) ? event.proof : [])
    .filter(x => /^cloud:\/\//.test(String(x))).slice(0, 9)
  const now = new Date()
  warmCollection(COL.fund)
  await db.collection(COL.fund).add({
    data: {
      type: 'expense',
      category: 'medical',
      campaignId: c._id,
      catId: c.catId,
      schoolId: c.schoolId,
      amount,
      title,
      proof,
      operator: me.nickName || '',
      createdBy: me.openid,
      date: now,
      createdAt: now
    }
  })
  const total = yuan((c.expenseTotal || 0) + amount)
  const patch = { expenseTotal: _.inc(amount), updatedAt: now }
  // 花完了就自动结项，免得一直挂在进行中
  if (c.status === 'active' && c.raisedAmount > 0 && total >= yuan(c.raisedAmount)) {
    patch.status = 'fulfilled'
    patch.closedReason = '善款已全部用于治疗'
  }
  await db.collection(COL.campaign).doc(c._id).update({ data: patch }).catch(() => {})
  return { ok: true }
}

/* ==================== 捐助记录 ==================== */

async function listCampaignDonations(me, event) {
  const c = await getCampaignDoc(event.id)
  const admin = isAdminRole(me)
  const mine = c.applicantOpenid === me.openid || c.createdBy === me.openid
  if (!admin && !mine) throw new AppError('只有发起人或管理员可以查看完整名单', 403)
  const res = await db.collection(COL.fund)
    .where({ campaignId: c._id, category: 'donation' })
    .orderBy('createdAt', 'desc').limit(100).get().catch(() => ({ data: [] }))
  return {
    total: (res.data || []).length,
    raised: yuan(c.raisedAmount),
    list: (res.data || []).map(d => ({
      _id: d._id,
      donorName: d.donorName,
      amount: yuan(d.amount),
      date: d.date,
      outTradeNo: d.outTradeNo
    }))
  }
}

async function listMyDonations(me, event) {
  const res = await db.collection(COL.fund)
    .where({ donorOpenid: me.openid, category: 'donation' })
    .orderBy('createdAt', 'desc').limit(100).get().catch(() => ({ data: [] }))
  return {
    list: (res.data || []).map(d => ({
      _id: d._id,
      campaignId: d.campaignId,
      catId: d.catId,
      amount: yuan(d.amount),
      date: d.date,
      title: d.title
    }))
  }
}

module.exports = {
  KIND_LABEL, MATERIAL_LABEL, REVIEW_LABEL,
  createCampaign, listCampaigns, getCampaign, donateToCampaign,
  reviewCampaign, closeCampaign, reportCampaign,
  addCampaignUpdate, addCampaignExpense,
  listCampaignDonations, listMyDonations,
  applyDelivery
}
