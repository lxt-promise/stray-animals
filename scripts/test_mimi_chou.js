/**
 * 咪咪筹（医疗 / 绝育筹款）行为级测试
 *
 * 覆盖的核心意图（不是实现细节）：
 *  1. 普通用户能发起，但必须进待审；管理员发起直接通过
 *  2. 筹款必须绑定真实猫档案、同校、且同一只猫不能同时有两条进行中的筹款
 *  3. 未通过的筹款对第三方不可见；材料可按条设「仅审核可见」
 *  4. 审核 / 结束 / 支出 / 举报的权限边界
 *  5. 捐助的前置校验（未审核、自己的筹款、跨校）
 *  6. 源码约束：不允许出现支付宝/第三方收款码这类违规引导
 *
 * 运行：node scripts/test_mimi_chou.js
 */
const path = require('path')
const fs = require('fs')
const Module = require('module')
const ROOT = path.resolve(__dirname, '..')
const CF = path.join(ROOT, 'cloudfunctions', 'catcampus')

let pass = 0, fail = 0
const failures = []
const assert = (name, cond, extra) => {
  if (cond) { pass++; return }
  fail++
  failures.push(name)
  console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))
}

/* ==================== 云环境桩 ==================== */
const SCHOOL_A = 'sch_a'
const SCHOOL_B = 'sch_b'
let store = {}
let seq = 0
const op = (name, v) => ({ __op: name, v })

function matchCond(doc, cond) {
  if (cond && cond.__op === 'or') return (cond.v || []).some(sub => matchCond(doc, sub))
  return Object.keys(cond).every(k => doc[k] === cond[k])
}

function makeQuery(col) {
  const list = () => (store[col] = store[col] || [])
  const q = {
    _filters: [], _order: null, _limit: 1e9, _skip: 0, _id: null,
    where(c) { q._filters.push(c); return q },
    orderBy(f, d) { q._order = { f, d }; return q },
    limit(n) { q._limit = n; return q },
    skip(n) { q._skip = n; return q },
    field() { return q },
    doc(id) { q._id = id; return q },
    async get() {
      if (q._id) {
        const d = list().find(x => x._id === q._id)
        return { data: d ? JSON.parse(JSON.stringify(d)) : null }
      }
      let rows = list().filter(d => q._filters.every(f => matchCond(d, f)))
      if (q._order) {
        const { f, d } = q._order
        rows = rows.slice().sort((a, b) => (d === 'desc' ? (b[f] > a[f] ? 1 : -1) : (a[f] > b[f] ? 1 : -1)))
      }
      rows = rows.slice(q._skip, q._skip + q._limit)
      return { data: JSON.parse(JSON.stringify(rows)) }
    },
    async count() {
      return { total: list().filter(d => q._filters.every(f => matchCond(d, f))).length }
    },
    async add({ data }) {
      const rows = Array.isArray(data) ? data : [data]
      const ids = []
      rows.forEach(r => {
        const _id = r._id || (col + '_' + (++seq))
        list().push(Object.assign({}, r, { _id }))
        ids.push(_id)
      })
      return Array.isArray(data) ? { _ids: ids } : { _id: ids[0] }
    },
    async update({ data }) {
      const d = list().find(x => x._id === q._id)
      if (!d) throw new Error('document does not exist')
      Object.keys(data).forEach(k => {
        const v = data[k]
        if (v && v.__op === 'inc') d[k] = (Number(d[k]) || 0) + v.v
        else if (v && v.__op === 'push') d[k] = (d[k] || []).concat([v.v])
        else d[k] = v
      })
      return { stats: { updated: 1 } }
    }
  }
  return q
}

const fakeDb = {
  async createCollection() { return { ok: true } },
  collection: name => makeQuery(name),
  serverDate: () => new Date(),
  command: {
    or: arr => op('or', arr), and: arr => op('and', arr),
    in: arr => op('in', arr), nin: arr => op('nin', arr),
    eq: v => op('eq', v), neq: v => op('neq', v),
    gt: v => op('gt', v), gte: v => op('gte', v),
    lt: v => op('lt', v), lte: v => op('lte', v),
    exists: v => op('exists', v), inc: v => op('inc', v),
    push: v => op('push', v), remove: () => op('remove')
  },
  RegExp: ({ regexp, options }) => ({ __regexp: regexp, __options: options || '' })
}
let currentOpenid = ''
const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test',
  init() {},
  database: () => fakeDb,
  getWXContext: () => ({ OPENID: currentOpenid }),
  async getTempFileURL({ fileList }) {
    return { fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://x/' + encodeURIComponent(f), status: 0 })) }
  }
}
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return fakeCloud
  return origLoad.apply(this, arguments)
}

process.env.SUPER_ADMIN_OPENIDS = process.env.SUPER_ADMIN_OPENIDS || 'u_super'
const { main } = require(path.join(CF, 'index.js'))
const donationSrc = fs.readFileSync(path.join(CF, 'lib', 'donation.js'), 'utf8')
const indexSrc = fs.readFileSync(path.join(CF, 'index.js'), 'utf8')
const detailWxml = fs.readFileSync(path.join(ROOT, 'miniprogram', 'pages', 'campaign-detail', 'campaign-detail.wxml'), 'utf8')
const editWxml = fs.readFileSync(path.join(ROOT, 'miniprogram', 'pages', 'campaign-edit', 'campaign-edit.wxml'), 'utf8')
const campaignWxml = fs.readFileSync(path.join(ROOT, 'miniprogram', 'pages', 'campaign', 'campaign.wxml'), 'utf8')

const as = async (u, action, event) => {
  currentOpenid = u || ''
  const r = await main(Object.assign({ action }, event || {}))
  return r && r.ok === false ? r : (r && r.data)
}

const cat = (id, schoolId, extra) => Object.assign({
  _id: id, name: '猫-' + id, schoolId, status: 'campus',
  sterilized: 'unknown', pattern: 'other', photos: [], avatar: '',
  updatedAt: new Date(2026, 10, 1)
}, extra || {})

async function seed() {
  store = {
    cats: [
      cat('ca1', SCHOOL_A, { name: '橘座' }),
      cat('ca2', SCHOOL_A, { name: '小奶牛' }),
      cat('ca3', SCHOOL_A, { name: '三花' }),
      cat('cb1', SCHOOL_B, { name: '他校猫' }),
      cat('cdead', SCHOOL_A, { name: '已去喵星', status: 'rainbow' })
    ],
    users: [
      { _id: 'u_stu', openid: 'u_stu', schoolId: SCHOOL_A, role: 'visitor', nickName: '小同学' },
      { _id: 'u_stu2', openid: 'u_stu2', schoolId: SCHOOL_A, role: 'visitor', nickName: '路人甲' },
      { _id: 'u_admin', openid: 'u_admin', schoolId: SCHOOL_A, role: 'admin', nickName: '管理员' },
      { _id: 'u_super', openid: 'u_super', schoolId: SCHOOL_A, role: 'admin', nickName: '超管' },
      { _id: 'u_free', openid: 'u_free', schoolId: '', role: 'visitor', nickName: '无校' }
    ],
    schools: [{ _id: SCHOOL_A, name: '东南大学' }, { _id: SCHOOL_B, name: '隔壁大学' }],
    medical_campaigns: [],
    funds: [],
    notices: []
  }
}

const baseForm = (catId, extra) => ({
  data: Object.assign({
    catId,
    kind: 'medical',
    title: '橘座骨折急需手术费',
    reason: '在梅园发现它右后腿受伤，送到医院拍片确认骨折，需要内固定手术。',
    goalAmount: 3000,
    hospital: 'XX 宠物医院',
    contact: '13800000000',
    materials: [
      { type: 'diagnosis', fileID: 'cloud://a/diagnosis.jpg', public: true },
      { type: 'invoice', fileID: 'cloud://a/bill.jpg', public: false },
      { type: 'other', fileID: 'http://evil/x.jpg', public: true }   // 非云存储，必须被丢弃
    ]
  }, extra || {})
})

async function run() {
  await seed()

  /* ==================== A. 发起 ==================== */
  console.log('\n--- A. 发起筹款 ---')

  let r = await as('u_stu', 'createCampaign', baseForm('ca1'))
  assert('A1 普通用户能发起', r && r._id, r)
  assert('A2 普通用户发起的筹款进待审', r.reviewStatus === 'pending' && r.needReview === true, r)
  assert('A3 非云存储材料被丢弃（只认 fileID）', r.materialCount === 2, r.materialCount)
  const c1 = r._id

  r = await as('u_stu', 'createCampaign', baseForm('ca1', { title: '短' }))
  assert('A4 标题过短被拒', r && r.ok === false && /4~40|标题/.test(r.msg || ''), r)

  r = await as('u_stu', 'createCampaign', baseForm('ca1', { goalAmount: 50 }))
  assert('A5 目标金额低于下限被拒', r && r.ok === false && /目标金额/.test(r.msg || ''), r)

  r = await as('u_stu', 'createCampaign', baseForm('ca1', { goalAmount: 900000 }))
  assert('A6 目标金额超上限被拒', r && r.ok === false && /目标金额/.test(r.msg || ''), r)

  const far = new Date(Date.now() + 120 * 86400000).toISOString()
  r = await as('u_stu', 'createCampaign', baseForm('ca1', { endDate: far }))
  assert('A7 截止日期超过 90 天被拒', r && r.ok === false && /90/.test(r.msg || ''), r)

  r = await as('u_stu', 'createCampaign', baseForm('cb1'))
  assert('A8 不能为他校的猫发起', r && r.ok === false && /其他学校/.test(r.msg || ''), r)

  r = await as('u_stu', 'createCampaign', baseForm('cdead'))
  assert('A9 去喵星的猫不能再发起', r && r.ok === false && /喵星/.test(r.msg || ''), r)

  r = await as('u_stu', 'createCampaign', baseForm('not_exist'))
  assert('A10 档案不存在时拒绝', r && r.ok === false && /档案不存在/.test(r.msg || ''), r)

  // 同一个人第 2 条待审可以，第 3 条应被限流
  r = await as('u_stu', 'createCampaign', baseForm('ca2'))
  assert('A11 第二条待审允许（上限 2）', r && r._id, r)
  const c2 = r._id

  r = await as('u_stu', 'createCampaign', baseForm('ca1'))
  assert('A12 第三条待审被限流', r && r.ok === false && /审核中/.test(r.msg || ''), r)

  /* ==================== B. 管理员发起 ==================== */
  console.log('\n--- B. 管理员发起 ---')

  r = await as('u_admin', 'createCampaign', baseForm('ca3'))
  assert('B1 管理员发起直接通过', r && r.reviewStatus === 'approved' && r.needReview === false, r)
  const cAdmin = r._id

  r = await as('u_stu2', 'createCampaign', baseForm('ca3'))
  assert('B2 同一只猫已有进行中的筹款时拒绝新发起',
    r && r.ok === false && /进行中的筹款/.test(r.msg || ''), r)

  /* ==================== C. 可见性 ==================== */
  console.log('\n--- C. 可见性与材料 ---')

  r = await as('u_stu2', 'getCampaign', { id: c1 })
  assert('C1 待审筹款对第三方不可见', r && r.ok === false && /审核中/.test(r.msg || ''), r)

  r = await as('u_stu', 'getCampaign', { id: c1 })
  assert('C2 发起人能看到自己的待审筹款', r && r.campaign && r.campaign._id === c1, r)
  assert('C3 发起人 isMine=true', r.isMine === true, r.isMine)
  assert('C4 发起人能看到自己的全部材料', (r.campaign.materials || []).length === 2, r.campaign.materials)

  r = await as('u_admin', 'getCampaign', { id: c1 })
  assert('C5 管理员能看到待审详情', r && r.campaign && r.campaign._id === c1, r)
  assert('C6 联系方式只下发给管理员', r.campaign.contact === '13800000000', r.campaign.contact)

  r = await as('u_stu2', 'getCampaign', { id: cAdmin })
  const mats = (r.campaign && r.campaign.materials) || []
  assert('C7 第三方看不到「仅审核可见」的材料', mats.length === 1, mats)
  assert('C8 隐藏材料数量如实告知', r.campaign.hiddenMaterialCount === 1, r.campaign)
  assert('C9 第三方拿不到联系方式', !r.campaign.contact, r.campaign.contact)

  /* ==================== D. 审核 ==================== */
  console.log('\n--- D. 审核 ---')

  r = await as('u_stu', 'reviewCampaign', { id: c1, approve: true })
  assert('D1 普通用户不能审核', r && r.ok === false && /权限/.test(r.msg || ''), r)

  r = await as('u_admin', 'reviewCampaign', { id: c1, approve: false })
  assert('D2 驳回必须写原因', r && r.ok === false && /原因/.test(r.msg || ''), r)

  r = await as('u_admin', 'reviewCampaign', { id: c1, approve: true })
  assert('D3 管理员可以通过审核', r && r.reviewStatus === 'approved', r)

  const c1Doc = store.medical_campaigns.find(x => x._id === c1)
  assert('D4 通过后 reviewStatus 落库', c1Doc && c1Doc.reviewStatus === 'approved', c1Doc && c1Doc.reviewStatus)
  assert('D5 通过后给发起人发通知',
    store.notices.some(n => n.openid === 'u_stu' && n.type === 'campaign_review_result'), store.notices)

  r = await as('u_stu2', 'getCampaign', { id: c1 })
  assert('D6 通过后第三方可见', r && r.campaign && r.campaign._id === c1, r)

  // 同一只猫（ca2）上存在两条待审：谁先被通过，另一条就不能再通过
  r = await as('u_stu2', 'createCampaign', baseForm('ca2'))
  assert('D7a 同猫可存在两条待审', r && r._id, r)
  const c4 = r._id

  r = await as('u_admin', 'reviewCampaign', { id: c2, approve: true })
  assert('D7b 先通过的那条生效', r && r.reviewStatus === 'approved', r)

  r = await as('u_admin', 'reviewCampaign', { id: c4, approve: true })
  assert('D7 同猫已有进行中筹款时，另一条不能再通过',
    r && r.ok === false && /进行中的筹款/.test(r.msg || ''), r)

  /* ==================== E. 捐助前置校验 ==================== */
  console.log('\n--- E. 捐助 ---')

  r = await as('u_stu2', 'donateToCampaign', { campaignId: c4, amount: 10 })
  assert('E1 未通过审核的筹款不能捐助', r && r.ok === false && /审核/.test(r.msg || ''), r)

  r = await as('u_admin', 'donateToCampaign', { campaignId: cAdmin, amount: 10 })
  assert('E2 不能给自己的筹款捐助', r && r.ok === false && /自己/.test(r.msg || ''), r)

  store.medical_campaigns.find(x => x._id === cAdmin).schoolId = SCHOOL_B
  r = await as('u_stu2', 'donateToCampaign', { campaignId: cAdmin, amount: 10 })
  assert('E3 不能跨校捐助', r && r.ok === false && /其他学校/.test(r.msg || ''), r)
  store.medical_campaigns.find(x => x._id === cAdmin).schoolId = SCHOOL_A

  /* ==================== F. 结束 / 支出 ==================== */
  console.log('\n--- F. 结束与支出 ---')

  r = await as('u_stu2', 'closeCampaign', { id: c1, reason: '测试' })
  assert('F1 无关用户不能结束他人的筹款', r && r.ok === false && /发起人/.test(r.msg || ''), r)

  r = await as('u_admin', 'addCampaignExpense', { id: c1, title: '手术费', amount: 500, proof: ['cloud://a/p.jpg'] })
  assert('F2 管理员登记支出成功', r && r.ok === true, r)

  // 手动把已筹金额抬高，验证「花完自动结项」
  const doc1 = store.medical_campaigns.find(x => x._id === c1)
  doc1.raisedAmount = 3000
  doc1.expenseTotal = 0
  r = await as('u_admin', 'addCampaignExpense', { id: c1, title: '剩余费用', amount: 3000 })
  assert('F3 支出达到已筹金额时自动结项',
    r && r.ok === true && doc1.status === 'fulfilled', { status: doc1.status, r })

  r = await as('u_stu', 'closeCampaign', { id: c2, reason: '已治好' })
  assert('F4 发起人可以结束自己的筹款', r && r.ok === true, r)
  assert('F5 结束状态落库', store.medical_campaigns.find(x => x._id === c2).status === 'closed')

  /* ==================== G. 列表 ==================== */
  console.log('\n--- G. 列表 ---')

  r = await as('u_stu2', 'listCampaigns', {})
  assert('G1 公开列表只含已通过的筹款',
    (r.list || []).every(c => c.reviewStatus === 'approved'), r.list)
  assert('G2 公开列表按学校隔离（本校 3 条）', (r.list || []).length === 3, (r.list || []).length)
  assert('G3 已结束的筹款也在列表里（可查账）',
    (r.list || []).some(c => c.status === 'closed' || c.status === 'fulfilled'), r.list)

  r = await as('u_stu2', 'listCampaigns', { scope: 'review' })
  assert('G4 非管理员不能看待审列表', r && r.ok === false && /权限/.test(r.msg || ''), r)

  r = await as('u_admin', 'listCampaigns', { scope: 'review' })
  assert('G5 管理员能看到待审列表', Array.isArray(r.list), r)

  r = await as('u_stu', 'listCampaigns', { scope: 'mine' })
  assert('G6 我能看到自己发起的（含待审/被驳回）', (r.list || []).length === 2, r.list)

  r = await as('u_stu2', 'listCampaigns', { scope: 'mine' })
  assert('G6b 别人只看到自己的那一条', (r.list || []).length === 1, r.list)

  r = await as('u_free', 'listCampaigns', {})
  assert('G7 未绑定学校返回空列表', (r.list || []).length === 0, r.list)

  /* ==================== H. 举报 ==================== */
  console.log('\n--- H. 举报 ---')

  r = await as('u_stu2', 'reportCampaign', { id: c1, reason: '金额可疑' })
  assert('H1 举报能提交', r && r.ok === true, r)
  assert('H2 举报落到超管通知',
    store.notices.some(n => n.openid === 'u_super' && n.type === 'campaign_report'), store.notices)

  /* ==================== I. 源码约束 ==================== */
  console.log('\n--- I. 支付合规约束 ---')

  assert('I1 createCampaign 对普通用户开放（role: user）',
    /'createCampaign':\s*\{\s*role:\s*'user'/.test(indexSrc))
  assert('I2 审核仍锁管理员',
    /'reviewCampaign':\s*\{\s*role:\s*'admin'/.test(indexSrc))
  assert('I3 不接入支付宝 SDK（无 alipay 调用）',
    !/alipay|AlipaySDK/i.test(donationSrc + indexSrc))
  assert('I4 用户端不出现支付宝 / 收款码引导',
    !/支付宝|收款码|qrCode/.test(detailWxml + editWxml + campaignWxml))
  assert('I5 支付说明明确走微信支付', /微信支付/.test(detailWxml))
  assert('I6 发起页有承诺勾选（信息真实 / 款项用途）',
    /同意以上承诺/.test(editWxml) && /我已阅读/.test(editWxml))
  assert('I7 材料可设为仅审核可见（隐私口子）', /材料公开展示/.test(editWxml))

  /* ==================== 汇总 ==================== */
  console.log('\n' + '='.repeat(48))
  console.log('通过 ' + pass + ' / 失败 ' + fail)
  if (fail) {
    console.log('失败用例：')
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
}

run().catch(e => {
  console.error('测试运行异常', e)
  process.exit(1)
})
