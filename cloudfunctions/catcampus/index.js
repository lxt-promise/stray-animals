/**
 * 喵园 CatCampus —— 后端云函数入口
 *
 * 架构原则：
 *  1. 所有数据库集合权限设为「仅管理端可读写」，客户端一律通过本函数访问，避免越权。
 *  2. 数据按 schoolId 隔离 —— 这是「先校园、后向外拓展」的架构支点。
 *  3. 权限三档：visitor（只读公开）/ member（社团写）/ admin（成员与角色管理），
 *     在 ACTIONS 表里声明，由统一入口 requireRole 校验，不再散落各处。
 *  4. 第一个注册的用户自动成为 admin，便于冷启动。
 *  5. 涉及猫只精确坐标的数据，对非社团成员做模糊化 —— 吸取街猫
 *     「直播暴露猫位置被虐猫者利用」的教训。
 *
 * 单函数 action 分发的工程治理（难点 3）：
 *  - ACTIONS 表驱动：每个 action 声明 handler + 所需角色，新增接口只改这张表；
 *  - 公共机制抽到 lib/（core / security / points / tnr / vision / map），
 *    本文件只放业务编排，便于将来按业务域拆成多个云函数时直接复用；
 *  - 统一超时保护与错误封装，AppError 携带语义码。
 */
const core = require('./lib/core')
const sec = require('./lib/security')
const points = require('./lib/points')
const level = require('./lib/level')
const tnr = require('./lib/tnr')
const vision = require('./lib/vision')
const maplib = require('./lib/map')
const vpay = require('./lib/vpay')
const donation = require('./lib/donation')
const notify = require('./lib/notify')
const crypto = require('crypto')

const {
  cloud, db, _, COL, AppError,
  isMember, isAdmin, requireRole, isSuper, requireSuper,
  resolveSchoolId, assertSchool,
  sanitizeCat, sanitizeSighting, normalizeEnum, escapeReg, pageOf, dayKey,
  ensureCollection, ensureAllCollections, isCollectionMissing
} = core

// 募捐模块：把虚拟支付「发货意图」接到捐助自动入账（支付成功即记 funds + 累加已筹）。
// fire-and-forget，失败只记日志，不影响微信推送 ack。
vpay.setDeliverHook(donation.applyDelivery)

/* ==================== action 注册表 ====================
 * role: public | user | member | admin
 */
const ACTIONS = {
  /* 用户 & 学校 */
  'login':          { role: 'public', handler: login },
  'registerAccount':{ role: 'user',   handler: registerAccount },
  'loginWithPassword':{ role: 'public', handler: loginWithPassword },
  // 预热：不做任何业务，只为了让云函数实例提前起来。
  // 背景（2026-10-24）：第一次点「保存档案」必报 -504003、点第二遍才成功 ——
  // 典型的冷启动（1~1.5s）叠加业务耗时顶破客户端 3s 预算。
  // 进入建档 / 打卡等重页面时先 ping 一下，把冷启动挪到用户填表的那几十秒里。
  'ping':           { role: 'public', handler: () => ({ pong: true, at: Date.now() }) },
  'updateProfile':  { role: 'user',   handler: updateProfile },
  // 启动聚合：一次调用拿齐 user + school + 首页概览。
  // 原来是 login → getSchool → getOverview 三次**串行**云调用，冷启动首页统计要等三轮。
  'homeInit':       { role: 'public', handler: homeInit },
  // 一键建齐所有集合（幂等）。部署后调一次，避免漏建集合导致的 -502005。
  'initCollections':{ role: 'admin',  handler: () => initCollections() },
  'createSchool':   { role: 'admin',  handler: createSchool },
  'updateSchool':   { role: 'admin',  handler: updateSchool },
  'listSchools':    { role: 'public', handler: listSchools },
  'getSchool':      { role: 'public', handler: getSchool },
  // 选校 / 新建学校。**是否需要审核由服务端环境变量 `SCHOOL_REVIEW` 决定**（见 applySchool）：
  //  - 推广期（默认 off）：普通用户选中即绑定、填完校名即建校，零摩擦；
  //  - 推广期后（on）：走待审申请，超管通过后才建校 / 绑定。
  // 两种模式下 reason 的必填校验都在服务端，前端只是按 policy 决定弹不弹理由框。
  'applySchool':    { role: 'user',   handler: applySchool },
  'mySchoolApply':  { role: 'user',   handler: mySchoolApply },
  // 撤回自己的待审申请：待审期间入口是锁死的，没有撤回通道就成了死局
  'withdrawSchoolApply': { role: 'user', handler: withdrawSchoolApply },
  // 管理员自助绑校 / 换校（免审）：role 由服务端校验，普通用户调不通
  'bindSchoolSelf': { role: 'admin',  handler: bindSchoolSelf },
  // 学校去重键维护（超管）：给历史学校补 schoolKey / 列出已建重的学校
  'backfillSchoolKeys':   { role: 'admin', handler: backfillSchoolKeys },
  'findDuplicateSchools': { role: 'admin', handler: findDuplicateSchools },
  /* 通知：申请提交后推给超管的站内通知（订阅消息是可配增强，见 lib/notify.js） */
  'listNotices':      { role: 'user',   handler: (u, e) => notify.listNotices(u, e) },
  'markNoticesRead':  { role: 'user',   handler: (u, e) => notify.markNoticesRead(u, e) },
  // 通知能力配置：模板没配时不该让管理员点「开启通知」（点了也收不到）
  'notifyConfig':     { role: 'public', handler: () => notify.notifyConfig() },
  'listSchoolApplies':  { role: 'admin', handler: listSchoolApplies },
  'handleSchoolApply':  { role: 'admin', handler: handleSchoolApply },
  // 校园管理（超管）：列表带档案数/成员数，便于判断哪所校区是空壳、哪所可以直接改
  'listSchoolsAdmin':   { role: 'admin', handler: listSchoolsAdmin },
  // 重复档案检测（超管）：同校同名的疑似重复建档，用于清理「超时重试」造成的历史脏数据
  'findDuplicateCats':  { role: 'admin', handler: findDuplicateCats },

  /* 图鉴收集（按本校统计） */
  'listDex':        { role: 'user',   handler: listDex },

  /* 概览 */
  'getOverview':    { role: 'public', handler: getOverview },

  /* 猫档案：建档 / 改档属「管理员以上」权限（社团成员只能打卡、认领，不能改档案） */
  'listCats':       { role: 'public', handler: listCats },
  // 只读诊断：猫谱筛选失效时用它区分「没写花色 / 值域外 / 查询报错 / 真没有」
  'diagnoseCatFilters': { role: 'admin', handler: diagnoseCatFilters },
  'getCat':         { role: 'public', handler: getCat },
  'saveCat':        { role: 'admin',  handler: saveCat },
  'removeCat':      { role: 'admin',  handler: removeCat },

  /* AI 猫脸识别 */
  'recognize':          { role: 'user',   handler: (u, e, ctx) => vision.runSync(u, e, ctx) },
  'recognizeStart':     { role: 'user',   handler: (u, e, ctx) => vision.start(u, e, ctx) },
  'recognizePoll':      { role: 'user',   handler: (u, e, ctx) => vision.poll(u, e, ctx) },
  // 历史识别记录回看：按 taskId 取回当初上传的素材（只读，仅本人可读）
  'recognizeTaskPhoto': { role: 'user',   handler: (u, e) => vision.taskPhoto(u, e) },
  'confirmRecognize':   { role: 'user',   handler: (u, e) => vision.confirm(u, e) },
  'buildAiIndex':       { role: 'member', handler: (u, e) => vision.buildIndex(u, e) },
  // 建档 / 改档后自动入库（只建这一只，永不抛错，失败由 A/B 兜底）
  'autoIndexCat':       { role: 'admin',  handler: (u, e) => vision.buildIndexAuto(u, e) },
  // 全量建库（所有校区）。role=admin：跨校区动作，且会跑满云函数预算，权限收紧。
  'buildAiIndexAll':    { role: 'admin',  handler: (u, e) => vision.buildIndexAll(e || {}) },
  // 特征库体检：档案总数 / 已录入 / 未录入清单（查识别服务的真实 id 列表，不信 aiIndexAt 记账）
  'indexStatus':        { role: 'admin',  handler: (u, e) => vision.indexStatus(u, e) },
  // 校园管理板块用：一次性拉回每所学校的特征库数量（total/indexed/missing/bankTotal）。
  // role=admin：跨校区统计，且每只学校都要查识别服务，权限收紧到超管。
  'indexStatusBySchool':{ role: 'admin',  handler: (u, e) => vision.indexStatusBySchool(e || {}) },
  // 单校重建：把指定学校的全部档案照重新提交识别服务算特征（force=true，无视记账）。
  // 与「全部重建」的区别：只动这一所，用于某校区单独补库 / 排查，不波及其它校区。
  // role=admin：跨校区动作，且会跑满建库预算，权限收紧。
  // 回包带 finishedAt（云端真正返回时的时刻）—— 管理端靠它显示「最近重建」时间。
  'indexRebuildSchool': { role: 'admin',  handler: (u, e) => vision.buildIndexSchool(u, e || {}) },
  // 手动录入单只：force 重算 + 8s 超时（用户点「录入」就是要确保它进库）
  'indexOneCat':        { role: 'admin',  handler: (u, e) => vision.indexOneCat(u, e) },
  // 识别引擎体检（检测模型是否生效 / 花色链路 / 特征库只数）。
  // 与 indexStatus 分开：失败互不连累，且 indexStatus 要扫 500 条档案，不该被它拖慢。
  'engineHealth':       { role: 'admin',  handler: (u, e) => vision.engineHealth(u, e) },
  // 确认样本库：用户「识别 → 点确认」留下的样本。后台查看 / 排除 / 改判归属 / 手动并入特征库。
  // 建库只在后台手动触发 —— 自动并入会把「认错猫的确认」灌进特征库，必须有人把关。
  'listSamples':            { role: 'admin', handler: (u, e) => vision.listSamples(u, e) },
  'updateSample':           { role: 'admin', handler: (u, e) => vision.updateSample(u, e) },
  'deleteSample':           { role: 'admin', handler: (u, e) => vision.deleteSample(u, e) },
  'buildIndexFromSamples':  { role: 'admin', handler: (u, e) => vision.buildIndexFromSamples(u, e) },

  /* 目击打卡 */
  'addSighting':    { role: 'user',   handler: addSighting },
  'listSightings':  { role: 'public', handler: listSightings },
  'updateSighting': { role: 'user',   handler: updateSighting },
  'deleteSighting': { role: 'user',   handler: deleteSighting },
  // 打卡可见性策略（仅超级管理员可改；默认 false = 全部仅内部可见）
  'setSightingVisibilityPolicy': { role: 'admin', handler: setSightingVisibilityPolicy },

  /* TNR */
  'listTnr':        { role: 'member', handler: listTnr },
  'saveTnr':        { role: 'member', handler: saveTnr },
  'getTnrFlow':     { role: 'member', handler: () => ({ flow: tnr.flowMeta() }) },

  /* 任务排班 */
  'listTasks':      { role: 'public', handler: listTasks },
  'saveTask':       { role: 'member', handler: saveTask },
  'claimTask':      { role: 'user',   handler: claimTask },

  /* 资金 */
  'listFunds':      { role: 'member', handler: listFunds },
  'addFund':        { role: 'member', handler: addFund },

  /* 成员 & 申请 */
  'listMembers':    { role: 'member', handler: listMembers },
  'setRole':        { role: 'admin',  handler: setRole },
  // 全站用户管理（超管）：跨校区列用户 + 配角色。与 listMembers / setRole（本校区成员）
  // 刻意分开 —— 一个是「管本社团的人」，一个是「管全站权限」，
  // 复用同一个接口会把 schoolId 一起改掉（等于把人的数据搬了家）。
  'listUsersAdmin': { role: 'admin',  handler: listUsersAdmin },
  'setUserRole':    { role: 'admin',  handler: setUserRole },
  // 测试账号（仅超管，内部还有 requireSuper 兜一层）：
  // 配 3 个槽位（管理员 / 社团成员 / 普通用户），切过去后服务端以该账号解析身份。
  // 配 置写在超管自己的 user 文档 testAccounts 字段，不新建集合。
  'testAccounts':   { role: 'admin',  handler: getTestAccounts },
  'setTestAccounts':{ role: 'admin',  handler: setTestAccounts },
  'applyJoin':      { role: 'user',   handler: applyJoin },
  'myApply':        { role: 'user',   handler: myApply },
  'listApplies':    { role: 'admin',  handler: listApplies },
  'handleApply':    { role: 'admin',  handler: handleApply },

  /* 地图 & 积分 */
  'listMapPoints':  { role: 'public', handler: (u, e) => maplib.mapPoints(u, e) },
  // 排查「某只猫为什么没上图」：逐只给出点位来源与缺失原因（仅超管）
  'diagnoseMapPoints': { role: 'admin', handler: (u, e) => { requireSuper(u); return maplib.diagnoseMapPoints(u, e) } },
  'pointsSummary':  { role: 'user',   handler: (u, e) => points.summary(u) },
  'listPoints':     { role: 'user',   handler: (me, e) => points.history(me.openid, e) },
  // 一次性迁移：把 users.points 的历史余额补记进 points 流水（幂等，可重复调用）
  'backfillPoints': { role: 'admin',  handler: backfillPointsLedger },
  // 一次性回填：给 schoolId 为空的历史打卡记录补归属（幂等、分片，仅超管）
  'backfillSightingSchool': { role: 'admin', handler: backfillSightingSchoolId },
  // 一键生成「游客体验数据」：给审核员看到非空页面（幂等，仅超管）
  'seedDemoData':   { role: 'admin',  handler: seedDemoData },
  // 排查用：列出猫档案的原始 avatar/photos 值 + 每个 fileID 的官方换链结果。
  // 「某只猫头像空白」时调它，一眼看出是「字段为空 / 本地临时路径 / 文件已不存在」。
  // 事件：{ action: 'debugCatMedia', name: '小灰灰' }（name 可省略 = 全校区）
  'debugCatMedia':  { role: 'admin',  handler: debugCatMedia },

  /* 个人虚拟支付（仅封装「收钱 + 发货意图」，权益发放由业务侧消费 vpay_deliveries 完成） */
  'vpayConfig':          { role: 'public', handler: () => vpay.payConfig() },
  'vpayCreateOrder':     { role: 'user',   handler: (u, e) => vpay.createOrder(u, e) },
  'vpayQueryOrder':      { role: 'user',   handler: (u, e) => vpay.queryOrder(u, e) },
  'vpayRefund':          { role: 'admin',  handler: (u, e) => vpay.refundOrder(u, e) },
  'vpayListOrders':      { role: 'user',   handler: (u, e) => vpay.listOrders(u, e) },
  'vpayListDeliveries':  { role: 'admin',  handler: (u, e) => vpay.listDeliveries(u, e) },
  'vpayCompleteDelivery':{ role: 'admin',  handler: (u, e) => vpay.completeDelivery(u, e) },
  'vpayNotify':          { role: 'public', handler: (u, e) => vpay.handleNotify(u, e) },

  /* 咪咪筹（参考水滴筹；真实收款走个人虚拟支付 vpay）
   * 发起对所有人开放（role:'user'），普通用户提交后进待审；管理员发起直接通过。
   * 审核/支出仍锁管理员；进展由发起人或管理员发。 */
  'createCampaign':      { role: 'user',   handler: (u, e) => donation.createCampaign(u, e) },
  'listCampaigns':       { role: 'public', handler: (u, e) => donation.listCampaigns(u, e) },
  'getCampaign':         { role: 'public', handler: (u, e) => donation.getCampaign(u, e) },
  'donateToCampaign':    { role: 'user',   handler: (u, e) => donation.donateToCampaign(u, e) },
  'reviewCampaign':      { role: 'admin',  handler: (u, e) => donation.reviewCampaign(u, e) },
  'closeCampaign':       { role: 'user',   handler: (u, e) => donation.closeCampaign(u, e) },
  'reportCampaign':      { role: 'user',   handler: (u, e) => donation.reportCampaign(u, e) },
  'addCampaignUpdate':   { role: 'user',   handler: (u, e) => donation.addCampaignUpdate(u, e) },
  'addCampaignExpense':  { role: 'admin',  handler: (u, e) => donation.addCampaignExpense(u, e) },
  'listCampaignDonations':{ role: 'user',  handler: (u, e) => donation.listCampaignDonations(u, e) },
  'listMyDonations':     { role: 'user',   handler: (u, e) => donation.listMyDonations(u, e) }
}

/** 单次 action 处理超时保护（云函数上限 20s，AI 可放宽到 60s） */
const TIMEOUT_MS = Number(process.env.ACTION_TIMEOUT_MS) || 15000

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AppError('处理超时，请稍后重试', 504)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

exports.main = async (event, context) => {
  // ⚠️ 调用入口时间戳：客户端对云函数有约 3s 的硬预算（-504003），
  // 而这个预算是**从调用进入算起**的 —— 云函数冷启动 + getMe() 的 DB 往返都发生在
  // handler 之前。识别链路的预算必须由这里起算，否则「handler 内 2.4s」+「前置开销」
  // 必然顶穿 3s（现场表现：每次轮询都 -504003，识别永远不结束）。
  const startedAt = Date.now()
  const action = (event && event.action) || ''
  const wxCtx = cloud.getWXContext()
  const openid = wxCtx.OPENID

  // 微信消息推送（虚拟支付发货/退款等）：以 HTTP 形式到达，无 action 字段，
  // 直接交给 vpay 处理，并把 XML 作为响应体原样返回给微信（决定平台是否重试）。
  if (!action && event && (event.body || event.httpMethod || event.xml)) {
    try {
      return await vpay.handleNotify(null, event)
    } catch (e) {
      console.error('[vpay notify]', e && (e.message || e))
      // 错误分类决定微信是否重试：
      //   解析/参数类错误（AppError code=400，如「空的回调数据」）→ 回 0，重试也没用；
      //   DB/网络类临时故障 → 回**非 0**让微信重试。
      // 早期一律回 0：vpay_deliveries 漏建导致 add 抛 -502005 时，
      // 微信认为推送成功不再重试，用户付了钱却没有任何 delivery 记录（资损）。
      const isParseError = e instanceof AppError && Number(e.code) === 400
      if (isParseError) {
        return '<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>'
      }
      return '<xml><ErrCode>1</ErrCode><ErrMsg><![CDATA[internal error, will retry]]></ErrMsg></xml>'
    }
  }

  const ok = data => ({ ok: true, data: data === undefined ? null : data })
  const fail = (msg, code) => ({ ok: false, msg, code: code || 400 })

  // 定时触发器（云开发 timer，在 config.json 里声明）：
  //   event = { Type: 'Timer', TriggerName: 'aiIndexDaily', Time: '...' }
  // 由平台调度发起，没有 WX 上下文（OPENID 为空），走独立白名单分发。
  if (event && (event.Type === 'Timer' || event.type === 'Timer')) {
    return runTimer(event.TriggerName || event.triggerName || '', event)
  }

  const def = ACTIONS[action]
  if (!def) return fail('未知的 action: ' + action, 404)

  try {
    let me = await getMe(openid)
    // 身份主键统一为自建的普通字段 openid（改名/重名都不影响）；
    // 旧文档缺 openid 时即时用微信上下文里的真实 openid 兜底，保证 requireSuper 等判断准确。
    if (me && !me.openid) me.openid = openid
    // 测试身份（仅超管）：event.actAs 指定「以谁的身份浏览」。解析失败直接 403/404，
    // 前端收到就清掉本地缓存、回到真实身份 —— 绝不在身份不明时放行业务逻辑。
    const realMe = me
    const actAsId = String((event && event.actAs) || '').trim()
    let acting = false
    if (actAsId) {
      me = await resolveActingUser(realMe, actAsId)
      acting = true
      if (ACTING_BLOCKED.indexOf(action) >= 0) {
        throw new AppError('测试身份下不能修改账号信息，请先退出切换', 403)
      }
      // 改密码 / 换绑账号也一并挡掉：updateProfile 里这几个字段等于改凭据
      if (action === 'updateProfile' && (event.password || event.account)) {
        throw new AppError('测试身份下不能修改账号或密码，请先退出切换', 403)
      }
      // 登录两条路在测试身份下走**只读**分支：不许合并真实档案、不许发礼包
      if (action === 'login') {
        return ok(sanitizeUser(Object.assign({}, me, { isSuper: false })))
      }
      if (action === 'homeInit') {
        return ok(await homeInitAsActing(me, event))
      }
    }
    requireRole(me, def.role)
    const ctx = { openid, wxCtx, action, startedAt, acting, realUser: realMe }
    // 统一签名：handler(me, event, ctx)
    const data = await withTimeout(Promise.resolve(def.handler(me, event || {}, ctx)), TIMEOUT_MS)
    return ok(data)
  } catch (e) {
    const raw = (e && e.message) || String(e || '')
    // 基础设施级报错（数据库/网络/超时）不把原始串吐给用户：
    // 像 `document.get:fail document with _id undefined does not exist` 这类原始 DB 报错
    // 会被前端直接 showToast 弹给用户，既吓人又暴露实现细节，统一换中性文案。
    // 同时把 action + 关键入参打到日志里，方便定位到底是哪一处拿到了 undefined。
    const infra = /:fail|database|_id|timeout|ETIMEDOUT|ECONNRESET|ESOCKETTIMEDOUT/i.test(raw)
    console.error(
      '[catcampus] action=' + action,
      '| err:', raw,
      '| id=' + (event && event.id),
      'catId=' + (event && event.catId),
      'sightingId=' + (event && event.sightingId),
      'schoolId=' + (event && event.schoolId),
      'taskId=' + (event && event.taskId)
    )
    if (e instanceof AppError) return fail(e.message, e.code)
    if (infra) return fail('数据读取失败，请稍后重试', 500)
    return fail(raw || '服务异常', 500)
  }
}

/* ==================== 定时触发器 ==================== */

/**
 * 定时任务分发。
 *
 * 两条硬规矩：
 *  1. **白名单制**：只放行表内 TriggerName，未知的直接 404 —— 定时器 event 由平台
 *     构造，但也防有人用测试调用手工塞一个 Type:'Timer' 的 event 来触发管理端动作。
 *  2. **不复用 ACTIONS 的 requireRole**：定时触发没有 OPENID，getMe 必然返回 null，
 *     走角色校验只会 401；而它本来就是系统调度，天然具备最高执行权。
 *
 * ⚠️ 预算：定时触发的调用不受客户端约 3s 的限制，但受**云函数自身超时**限制
 * （控制台配置，常见默认 20s，最高 60s）。所以每个任务都必须自带 deadline 分片推进，
 * 且要求幂等 —— 这次没跑完，下一次接着跑。
 */
async function runTimer(name, event) {
  // 运维手工触发（云开发控制台 → 云函数 → 云端测试）时可在 event 里覆盖预算，
  // 不必去改环境变量 —— 定时任务自身不带这些字段，走默认值。
  const budget = Number(event && event.budgetMs) || Number(process.env.AI_INDEX_TIME_BUDGET_MS) || 15000
  const TABLE = {
    // 每天一次：把所有校区档案猫补进服务端特征库（只补缺失的，幂等）
    aiIndexDaily: () => vision.buildIndexAll({ budgetMs: budget }),

    // 整体重建：忽略云库里的 aiIndexAt 记账，全部重新计算（force=true）。
    //
    // 为什么必须有它：换存储介质 / 清空对象存储 / 迁移服务之后，服务端特征库是空的，
    // 但云库里每只猫的 aiIndexAt 还记着「已入库」—— 增量模式的 aiIndexDaily 会把它们
    // **全部跳过**（built=0，桶依然是空的）。只有 force 能打破这个死锁。
    //
    // 只挂在定时器白名单里（需要运维在控制台手工触发），不进 ACTIONS ——
    // 全量重算是重活，不该由小程序端一个按钮就发起。
    aiIndexRebuild: () => {
      const o = { budgetMs: budget, force: true }
      const pc = Number(event && event.photosPerCat)
      // 不传就用全局视图上限（vision.INDEX_PHOTOS）。
      // 这里曾经写死 5：于是「定时全量重建」和「后台手动录入」两个入口用了两套张数，
      // 调阈值时只改常量，定时任务这边纹丝不动 —— 两边口径必须同源。
      if (pc > 0) o.photosPerCat = pc
      return vision.buildIndexAll(o)
    }
  }

  const fn = TABLE[name]
  if (!fn) {
    console.warn('[timer] 未知的 TriggerName:', name)
    return { ok: false, msg: '未知的定时任务: ' + name, code: 404 }
  }

  try {
    const data = await fn()
    console.log('[timer] ' + name + ' 完成', JSON.stringify({
      processed: data.processed, built: data.built,
      skipped: data.skipped, timedOut: data.timedOut
    }))
    return { ok: true, data }
  } catch (e) {
    console.error('[timer]', name, e && (e.message || e))
    return { ok: false, msg: (e && e.message) || '定时任务执行失败', code: 500 }
  }
}

/* ==================== 基础 ==================== */

/**
 * 一键建齐所有集合（幂等）。
 * 云开发的集合必须在控制台手工创建，漏一个就会在第一次用到时抛
 * `-502005 database collection not exists`（例如 ai_tasks 只在识别时才碰到）。
 * 部署后调一次这个 action 即可全部建好；重复调用不会报错。
 */
async function initCollections() {
  const names = await ensureAllCollections()
  return { collections: names, count: names.length }
}

async function getMe(openid) {
  if (!openid) return null
  // 优先用自建 openid 字段；兼容历史文档（曾用系统 _openid）做兜底；
  // 也按 linkedOpenids 命中「账号密码登录」绑定的多设备 openid —— 换设备自动登录仍是同一人。
  const res = await db.collection(COL.user)
    .where(_.or([{ openid: openid }, { _openid: openid }, { linkedOpenids: openid }]))
    .limit(1).get()
  return res.data[0] || null
}

/* ==================== 测试身份（仅超管，用于自测其他角色的界面） ====================
 * 问题：超管只有一个微信身份，看不到「普通用户 / 社团成员」眼里的界面和数据
 * （位置脱敏、权限按钮、建档入口、工作台入口全都不一样）。让别人帮忙点一遍既不现实，
 * 也没法复现「某个按钮点了会怎样」。
 *
 * 做法是**服务端代理解析身份**（view-as），不是去改库里的 role：
 *   1) 客户端每次调用带 `actAs=<用户 _id>`（存在本机缓存，退出即清）；
 *   2) 服务端先按**真实 openid** 找到调用者，只认 openid 白名单里的超管；
 *   3) actAs 必须命中该超管自己配置的 3 个测试账号之一，且目标不是超管、不是自己；
 *   4) 之后所有 handler 拿到的 me 就是那个账号 —— 权限校验、数据脱敏、积分记账
 *      全部按被切换账号生效，和真的用那个微信登录进来几乎一致。
 *
 * 三条硬边界：
 *   - 只有超管能配、能切；配置写在超管自己的 user 文档 `testAccounts` 字段里（不新建集合）；
 *   - 测试身份下禁止改账号/密码，也不许「登录其他账号」—— 那会把别人的 openid
 *     并进目标账号，一次测试就把凭据搞乱；
 *   - **不动真实超管档案**：login / homeInit 在测试身份下走只读分支，不再合并重复档案、
 *     不再发礼包/超管礼遇，避免「切换一下把自己积分搞乱」。
 */
const TEST_SLOTS = [
  { key: 'admin', label: '管理员测试账号' },
  { key: 'member', label: '社团成员测试账号' },
  { key: 'normal', label: '普通用户测试账号' }
]
const TEST_SLOT_KEYS = TEST_SLOTS.map(s => s.key)
// 测试身份下直接拒绝的 action：都会改「账号凭据」本身
const ACTING_BLOCKED = ['loginWithPassword', 'registerAccount']

const TEST_ROLE_TEXT = { admin: '管理员', member: '社团成员', visitor: '普通用户' }
/** 角色文案：老数据的 role:'user' 等同访客 */
function testRoleText(role) {
  const k = role === 'user' ? 'visitor' : (role || 'visitor')
  return TEST_ROLE_TEXT[k] || TEST_ROLE_TEXT.visitor
}

/**
 * 解析「正在以谁的身份浏览」。
 * 任何一步不满足都直接抛 403/404 —— 前端据此清掉本地 actAs 并回到真实身份。
 */
async function resolveActingUser(realMe, userId) {
  if (!realMe || !isSuper(realMe)) throw new AppError('仅超级管理员可切换测试账号', 403)
  // 先判「切自己」：否则会被下面的白名单判成「不在测试账号列表中」，看不出真正原因
  if (userId === realMe._id) throw new AppError('不能切换到自己', 400)
  const cfg = realMe.testAccounts || {}
  const allowed = TEST_SLOT_KEYS.map(k => cfg[k]).filter(Boolean)
  if (allowed.indexOf(userId) < 0) throw new AppError('该账号不在测试账号列表中', 403)
  const res = await db.collection(COL.user).doc(userId).get().catch(() => null)
  const u = res && res.data
  if (!u) throw new AppError('测试账号不存在或已被删除', 404)
  const openid = u.openid || u._openid || ''
  // 缺 openid 的历史脏数据不能当测试账号：切过去后 me.openid 为空，
  // 打卡/积分等写入会挂在一个空身份上，比切不过去更糟。
  if (!openid) throw new AppError('该账号缺少身份标识，无法切换', 400)
  // 再挡一次：绝不允许「以另一个超管身份」浏览（等于把超管权限借出去）
  if (isSuper({ openid })) throw new AppError('不能切换到超级管理员账号', 403)
  return Object.assign({}, u, { openid })
}

/** 测试身份下的 homeInit：只读，不合并档案、不发礼包，避免污染任何真实档案 */
async function homeInitAsActing(user, event) {
  const withOpenid = Object.assign({}, user)
  const schoolId = withOpenid.schoolId || ''
  const [school, overview] = await Promise.all([
    schoolId
      ? getSchool({ schoolId }).catch(e => {
          console.warn('[homeInit:acting] 学校拉取失败', e && e.message)
          return null
        })
      : Promise.resolve(null),
    getOverview(withOpenid, Object.assign({}, event, { schoolId, actAs: '' })).catch(e => {
      console.warn('[homeInit:acting] 概览拉取失败', e && e.message)
      return null
    })
  ])
  if (overview) {
    overview.me = {
      role: withOpenid.role,
      points: withOpenid.points || 0,
      peakPoints: Math.max(Number(withOpenid.peakPoints) || 0, Number(withOpenid.points) || 0),
      level: Number(withOpenid.level) || level.levelOf(Number(withOpenid.points) || 0).lv,
      food: withOpenid.food || 0,
      sightingCount: withOpenid.sightingCount || 0,
      nickName: withOpenid.nickName
    }
  }
  return {
    user: sanitizeUser(Object.assign({}, withOpenid, { isSuper: false })),
    school,
    overview,
    // 前端据此显示「正在以某某身份浏览」的横幅
    acting: true
  }
}

/** 读取三个测试账号槽位（仅超管） */
async function getTestAccounts(me) {
  requireSuper(me)
  const cfg = me.testAccounts || {}
  const ids = TEST_SLOT_KEYS.map(k => cfg[k]).filter(Boolean)
  let map = {}
  if (ids.length) {
    const res = await db.collection(COL.user).where({ _id: _.in(ids) }).limit(10).get()
      .catch(() => null)
    ;((res && res.data) || []).forEach(u => { map[u._id] = u })
  }
  const slots = TEST_SLOTS.map(s => {
    const u = map[cfg[s.key]]
    return {
      key: s.key,
      label: s.label,
      user: u ? {
        _id: u._id,
        nickName: u.nickName || '未命名',
        roleLabel: testRoleText(u.role),
        accountMask: u.account ? maskContact(u.account) : '',
        isSuper: isSuper({ openid: u.openid || u._openid })
      } : null
    }
  })
  return { slots }
}

/** 绑定 / 解绑某个槽位的测试账号（仅超管）。userId 传空串表示解绑 */
async function setTestAccounts(me, event) {
  requireSuper(me)
  const slot = String((event && event.slot) || '')
  const userId = String((event && event.userId) || '')
  if (TEST_SLOT_KEYS.indexOf(slot) < 0) throw new AppError('未知的测试角色', 400)
  const next = Object.assign({}, me.testAccounts || {})
  if (!userId) {
    delete next[slot]
  } else {
    if (userId === me._id) throw new AppError('不能把超管自己设为测试账号', 400)
    const res = await db.collection(COL.user).doc(userId).get().catch(() => null)
    const u = res && res.data
    if (!u) throw new AppError('该用户不存在（可能还没登录过小程序）', 404)
    if (isSuper({ openid: u.openid || u._openid })) {
      throw new AppError('不能使用超级管理员账号做测试账号', 403)
    }
    if (!(u.openid || u._openid)) throw new AppError('该用户缺少身份标识，换一个账号试试', 400)
    next[slot] = userId
  }
  await db.collection(COL.user).doc(me._id).update({ data: { testAccounts: next } })
  return getTestAccounts(Object.assign({}, me, { testAccounts: next }))
}

/* ==================== 账号密码（个人主体下可用的真·身份，替代官方 getPhoneNumber） ==================== */

// 密码加盐哈希：scrypt(密码, 随机盐) → "salt:hash"，绝不存明文。
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex')
  return salt + ':' + hash
}
function verifyPassword(pw, stored) {
  if (!stored || stored.indexOf(':') < 0) return false
  const idx = stored.indexOf(':')
  const salt = stored.slice(0, idx)
  const hash = stored.slice(idx + 1)
  const calc = crypto.scryptSync(String(pw), salt, 32).toString('hex')
  return calc === hash
}
const isPhoneLike = s => /^1\d{10}$/.test(s)
// 邮箱只做「像邮箱」的形状校验（本地@域名.后缀），不追求 RFC 全覆盖 ——
// 账号只是登录标识，太严会误伤正常邮箱，太松会放过 "a@b"。
const isEmailLike = s => /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s)

/**
 * 账号格式白名单：**只允许手机号或邮箱**（2026-10-30 收紧）。
 *
 * 原来允许自由「用户名」，问题是：用户名不可验证也不可找回，用户拿「张三」当账号，
 * 换设备登录时既想不起来当初填的什么，也和别人的账号撞车（昵称本来就允许重名）。
 * 手机号 / 邮箱是**唯一且可验证**的标识，账号体系才有意义；
 * 顺带手机号账号会自动同步到 `phone`，绑校前的软引导就不必再问一遍。
 */
function assertAccountFormat(account) {
  const v = String(account || '').trim()
  if (!isPhoneLike(v) && !isEmailLike(v)) {
    throw new AppError('账号需为 11 位手机号或邮箱', 400)
  }
  return v
}

// 返回给客户端前脱敏：绝不下发密码哈希（含 salt）。
function sanitizeUser(u) {
  if (!u) return u
  const { password, ...rest } = u
  return rest
}

/** 后台列表用的脱敏：中段打码，不下发完整手机号 / 邮箱（后台也不需要看到） */
function maskContact(v) {
  const s = String(v || '')
  if (!s) return ''
  if (isPhoneLike(s)) return s.slice(0, 3) + '****' + s.slice(7)
  const at = s.indexOf('@')
  if (at > 0) {
    const local = s.slice(0, at)
    const keep = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2)
    return keep + '****' + s.slice(at)
  }
  return s.length <= 4 ? s : s.slice(0, 2) + '****' + s.slice(-2)
}

/**
 * 首次设置「账号 + 密码」。账号**只能是手机号或邮箱**（唯一）。
 * 已 openid 登录（role:user）才能调；设置后该 openid 进入 linkedOpenids，
 * 后续用账号密码登录即可在多设备间复用同一份档案。
 */
async function registerAccount(me, event) {
  if (!me) throw new AppError('请先登录', 401)
  if (me.account) throw new AppError('已设置账号，如需修改请在「账号安全」中操作', 409)
  const account = assertAccountFormat(event && event.account)
  const password = String((event && event.password) || '')
  if (password.length < 6) throw new AppError('密码至少 6 位')
  const dup = await db.collection(COL.user).where({ account }).limit(1).get()
  if (dup.data && dup.data.length) throw new AppError('该账号已被使用', 409)
  const patch = {
    account,
    password: hashPassword(password),
    linkedOpenids: ((me.linkedOpenids || []).concat(me.openid || [])).filter((v, i, a) => a.indexOf(v) === i),
    updatedAt: new Date()
  }
  if (isPhoneLike(account)) patch.phone = account  // 账号即手机号时同步补全 phone
  await db.collection(COL.user).doc(me._id).update({ data: patch })
  return sanitizeUser(Object.assign({}, me, patch))
}

/**
 * 账号密码登录（public）。校验通过后把「当前设备 openid」并入该账号的 linkedOpenids，
 * 实现「一个用户可在多设备登录同一账号」——换设备后自动登录(openid)仍解析到同一档案。
 */
async function loginWithPassword(me, event, ctx) {
  const account = String((event && event.account) || '').trim()
  const password = String((event && event.password) || '')
  if (!account || !password) throw new AppError('请输入账号和密码', 400)
  // 账号只允许手机号 / 邮箱，格式不对就不必查库。
  // ⚠️ 这里报「账号或密码错误」而不是「格式不对」：透露格式规则等于帮撞库者缩小范围。
  if (!isPhoneLike(account) && !isEmailLike(account)) throw new AppError('账号或密码错误', 401)
  const res = await db.collection(COL.user).where({ account }).limit(1).get()
  const user = res.data && res.data[0]
  if (!user || !verifyPassword(password, user.password)) {
    throw new AppError('账号或密码错误', 401)
  }
  const openid = (ctx && ctx.openid) || ''
  if (openid) {
    const cur = user.linkedOpenids || []
    if (cur.indexOf(openid) < 0) {
      await db.collection(COL.user).doc(user._id).update({
        data: { linkedOpenids: cur.concat(openid), updatedAt: new Date() }
      }).catch(e => console.warn('[loginWithPassword] 合并 openid 失败，已忽略', e && e.message))
    }
  }
  return sanitizeUser(user)
}

/* ==================== 用户 & 学校 ==================== */

/**
 * 登录后的账户初始化：新手礼包 + 超级管理员礼遇。
 *
 * 两步都是「发钱」而不是「读数据」，因此单独抽出来给三条登录路径共用 ——
 * 否则以后再加权益时必然漏掉某条分支（「从打卡记录重建档案」那条最容易漏，
 * 而它恰好是新用户/数据被清理后最常走到的路径）。
 * 任何一步失败都降级为「没发」，绝不阻断登录。
 */
async function bootAccount(user) {
  const gift = await points.claimGift(user)
    .catch(e => {
      console.warn('[login] 新手礼包发放失败，已忽略', e && e.message)
      return { gained: 0 }
    })
  const boost = await points.grantAdminPrivilege(user)
    .catch(e => {
      console.warn('[login] 超管礼遇发放失败，已忽略', e && e.message)
      return { applied: false }
    })
  const basePoints = Number(user.points) || 0
  const baseFood = Number(user.food) || 0
  return {
    giftGained: gift.gained || 0,
    // 礼遇返回的是「发放后的绝对值」（内部已按 max 合并原有余额），直接采用；
    // 没触发礼遇时，登录快照 + 刚发的礼包就是当前余额。
    points: boost.applied ? boost.points : basePoints,
    food: boost.applied ? boost.food : baseFood + (gift.gained || 0),
    level: boost.applied ? boost.level : (Number(user.level) || level.levelOf(basePoints).lv),
    peakPoints: boost.applied
      ? Math.max(boost.points, Number(user.peakPoints) || 0)
      : Math.max(Number(user.peakPoints) || 0, basePoints)
  }
}

/**
 * 打卡次数自愈：**只在已经为负时**触发一次 count() 重算。
 *
 * 成因：早期 deleteSighting 无条件给「操作者」`_.inc(-1)`。超管在后台
 * 删掉两条别人的打卡记录后，自己的次数就变成 -2（本机实测数据）。
 * 计数是派生值，重算比「+2 补回来」可靠 —— 后者要求你知道少减了几次。
 */
async function repairSightingCount(user) {
  const cur = Number(user.sightingCount) || 0
  if (cur >= 0) return cur
  const openid = user.openid
  if (!openid) return 0
  const c = await db.collection(COL.sighting).where({ reporter: openid }).count()
    .catch(e => {
      console.warn('[login] 打卡次数重算失败，沿用旧值', e && e.message)
      return null
    })
  if (!c) return cur
  const real = c.total || 0
  await db.collection(COL.user).doc(user._id)
    .update({ data: { sightingCount: real } })
    .catch(() => {})
  console.log('[login] 打卡次数为负，已重算', openid, cur, '→', real)
  return real
}

/**
 * 登录第一段：确定「这个人是谁」——回填 openid / 合并重复档 / 从打卡重建 / 新建档案。
 * 只产出带 openid 的原始档案，**不发权益**。homeInit 拿到它就能开工查学校与概览，
 * 把第二段的礼包/礼遇挪到与概览并行 —— 首页统计不再等那几次 DB 往返。
 */
async function loginResolve(me, event, ctx) {
  const openid = ctx && ctx.openid
  if (!openid) throw new AppError('无法获取用户身份', 401)
  const now = new Date()
  if (me) {
    // 旧文档缺 openid 字段时回填，保证后续以 openid 为稳定主键。
    // 关键：回填失败绝不能中断登录 —— 否则整个 login 拒绝，前端拿不到 user，
    // 表现为「变成爱猫同学 + 数据像全没了」，且 openid 永远补不回去。
    if (!me.openid) {
      await db.collection(COL.user).doc(me._id)
        .update({ data: { openid } })
        .catch(e => console.warn('[login] openid 回填失败，已忽略', e && e.message))
    }
    // 自愈：历史版本可能为同一 openid 产生过多个档案文档，
    // 登录时自动合并（积分/打卡数求和、图鉴并集、角色取最高），避免“数据清零”假象。
    // 同样不能因合并失败阻断登录，失败时退回当前档案。
    const merged = await mergeDuplicateUsers(openid)
      .catch(e => {
        console.warn('[login] 合并重复档案失败，已忽略', e && e.message)
        return null
      })
    const cur = merged || me
    // 显式带上 openid：老档案缺这个字段时，isSuper 判不出来会导致超管礼遇延后一次登录才发。
    return { kind: 'existing', user: Object.assign({}, cur, { openid }) }
  }
  // 没找到档案：先尝试从历史打卡记录重建（防误清档案导致“数据全丢”假象）
  const rebuilt = await rebuildUserFromRecords(openid, now)
    .catch(e => {
      console.warn('[login] 从打卡记录重建失败，已忽略', e && e.message)
      return null
    })
  if (rebuilt) return { kind: 'rebuilt', user: rebuilt }
  // 首个用户或超级管理员自动成为 admin，便于冷启动与超管权限
  const total = await db.collection(COL.user).count()
  const isFirst = total.total === 0
  const superHere = isSuper({ openid })
  const doc = {
    openid,
    _openid: openid,
    nickName: event.nickName || '爱猫同学',
    avatarUrl: event.avatarUrl || '',
    role: (isFirst || superHere) ? 'admin' : 'visitor',
    schoolId: event.schoolId || '',
    // 积分值：只增不减，判等级的依据（peakPoints 记历史最高）
    points: 0,
    pointsDay: '',
    pointsToday: 0,
    peakPoints: 0,
    level: 1,
    // 猫粮值：可增可减的流通货币，下限 0
    food: 0,
    foodDay: '',
    foodToday: 0,
    // 识别计费计数（每日重置）
    recognizeDay: '',
    recognizeToday: 0,
    // ⚠️ 不写 giftAt：claimGift 用 `giftAt 不存在` 判断「还没领过」，
    // 写了 null 会让条件更新永远匹配不上，礼包静默发不出去。
    sightingCount: 0,
    catSeen: [],
    createdAt: now,
    lastSeenAt: now
  }
  const add = await db.collection(COL.user).add({ data: doc })
  const created = Object.assign({}, doc, { _id: add._id, openid, isSuper: superHere })
  return { kind: 'created', user: created }
}

/**
 * 登录第二段：发权益（新手礼包 + 超管礼遇，见 bootAccount）+ 计数自愈 + 组装返回。
 * 礼包/礼遇见都是「一次性」：claimGift 用 giftAt、礼遇用 adminGrantAt 做条件更新抢占，
 * 并发登录不会重复发。三条分支的返回字段保持重构前的口径，逐条对应原 login 的返回值。
 */
async function loginFinalize(r) {
  const cur = r.user
  const acc = await bootAccount(cur)
  if (r.kind === 'existing') {
    // 打卡次数是派生值，历史上被误减成过负数（见 repairSightingCount）。
    // 只在负数时重算，正常用户不多付一次 count。
    const sightingCount = await repairSightingCount(cur)
    return sanitizeUser(Object.assign({}, cur, {
      isSuper: isSuper({ openid: cur.openid }),
      points: acc.points,
      // 老文档没有这些字段，补上算好的值，避免前端直接读 undefined
      peakPoints: acc.peakPoints,
      level: acc.level,
      food: acc.food,
      sightingCount,
      giftGained: acc.giftGained,
      pointsToday: cur.pointsDay === dayKey() ? (cur.pointsToday || 0) : 0
    }))
  }
  if (r.kind === 'rebuilt') {
    return sanitizeUser(Object.assign({}, cur, {
      points: acc.points,
      peakPoints: acc.peakPoints,
      level: acc.level,
      food: acc.food,
      giftGained: acc.giftGained,
      pointsToday: cur.pointsDay === dayKey() ? (cur.pointsToday || 0) : 0
    }))
  }
  return sanitizeUser(Object.assign({}, cur, {
    points: acc.points,
    peakPoints: acc.peakPoints,
    level: acc.level,
    food: acc.food,
    giftGained: acc.giftGained
  }))
}

async function login(me, event, ctx) {
  return loginFinalize(await loginResolve(me, event, ctx))
}

const ROLE_RANK = { visitor: 0, member: 1, admin: 2 }

/**
 * 按 openid 找用户档案。
 * 主键是自建的 `openid`（云函数里 `_openid` 不可靠），但仍用 `_.or` 兜底老档案 ——
 * 只会写 `_openid` 的那批文档若匹配不上，删除记录时就找不到作者、计数回退会落空。
 */
async function findUserByOpenid(openid) {
  if (!openid) return null
  const res = await db.collection(COL.user)
    .where(_.or([{ openid }, { _openid: openid }]))
    .limit(1).get()
    .catch(() => null)
  return (res && res.data && res.data[0]) || null
}

/** 合并同一 openid 的重复用户档案：保留最早的文档为主档，删掉其余 */
async function mergeDuplicateUsers(openid) {
  const res = await db.collection(COL.user)
    .where(_.or([{ openid }, { _openid: openid }]))
    .limit(10).get()
  const docs = res.data || []
  if (docs.length <= 1) return docs[0] || null

  const sorted = docs.slice().sort((a, b) =>
    new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
  const keep = sorted[0]
  let points = 0, food = 0, sightingCount = 0, peakPoints = 0, lv = 1
  let role = 'visitor', schoolId = '', nickName = '', avatarUrl = ''
  let giftAt = null
  const seen = new Set()
  for (const d of sorted) {
    points += Number(d.points) || 0
    food += Number(d.food) || 0
    sightingCount += Number(d.sightingCount) || 0
    // 等级按历史最高：取各档 peakPoints 与 points 的最大值，绝不因合并而掉级
    peakPoints = Math.max(peakPoints, Number(d.peakPoints) || 0, Number(d.points) || 0)
    lv = Math.max(lv, Number(d.level) || 0)
    if (d.giftAt && (!giftAt || new Date(d.giftAt) < new Date(giftAt))) giftAt = d.giftAt
    if ((ROLE_RANK[d.role] || 0) > (ROLE_RANK[role] || 0)) role = d.role
    ;(d.catSeen || []).forEach(id => seen.add(id))
    if (!schoolId && d.schoolId) schoolId = d.schoolId
    if (!nickName && d.nickName) nickName = d.nickName
    if (!avatarUrl && d.avatarUrl) avatarUrl = d.avatarUrl
  }
  const mergedDoc = {
    openid,
    points,
    food,
    peakPoints,
    level: lv,
    sightingCount,
    role,
    schoolId,
    nickName,
    avatarUrl,
    catSeen: Array.from(seen),
    lastSeenAt: new Date()
  }
  // 只在真有领取时间时写：写 null 会让 claimGift 的
  // `giftAt 不存在` 条件永远不匹配，礼包就再也发不出来了
  if (giftAt) mergedDoc.giftAt = giftAt
  await db.collection(COL.user).doc(keep._id).update({ data: mergedDoc })
  for (const d of sorted) {
    if (d._id !== keep._id) {
      await db.collection(COL.user).doc(d._id).remove().catch(() => {})
    }
  }
  return Object.assign({}, keep, mergedDoc)
}

/** 用户档案丢失时，从其历史打卡记录重建档案（积分按打卡单回加，图鉴按遇见重建） */
async function rebuildUserFromRecords(openid, now) {
  const res = await db.collection(COL.sighting)
    .where({ reporter: openid }).limit(1000).get()
  const list = res.data || []
  if (!list.length) return null
  const seen = new Set()
  let points = 0
  list.forEach(s => {
    if (s.catId) seen.add(s.catId)
    points += Number(s.points) || 0
  })
  const doc = {
    openid,
    _openid: openid,
    nickName: list[0].reporterName || ('猫友' + openid.slice(-4)),
    avatarUrl: '',
    role: isSuper({ openid }) ? 'admin' : 'member',
    schoolId: '',
    // 历史打卡记录里的 points 是旧口径（单货币），一律并入积分值：
    // 它只增不减，作为等级依据是安全的；猫粮从 0 起算，由登录礼包补 50。
    points,
    pointsDay: '',
    pointsToday: 0,
    peakPoints: points,
    level: level.levelOf(points).lv,
    food: 0,
    foodDay: '',
    foodToday: 0,
    recognizeDay: '',
    recognizeToday: 0,
    sightingCount: list.length,
    catSeen: Array.from(seen),
    createdAt: now,
    lastSeenAt: now,
    recoveredAt: now
  }
  const add = await db.collection(COL.user).add({ data: doc })
  return Object.assign({}, doc, { _id: add._id, openid, isSuper: isSuper({ openid }) })
}

async function updateProfile(me, event) {
  const patch = {}
  if (event.nickName) {
    const okText = await sec.checkText(event.nickName)
    if (!okText) throw new AppError('昵称未通过安全检测', 400)
    patch.nickName = event.nickName
  }
  if (event.avatarUrl) {
    const okImg = await sec.checkImage(event.avatarUrl)
    if (!okImg) throw new AppError('头像未通过安全检测', 400)
    patch.avatarUrl = event.avatarUrl
  }
  // 手机号软补全（不强制）：用于识别/打卡/绑校前的软引导，仅作联系与防刷用途
  if (event.phone !== undefined && event.phone !== null) {
    const phone = String(event.phone).trim()
    if (phone && !isPhoneLike(phone)) throw new AppError('手机号格式不正确', 400)
    patch.phone = phone
  }
  /**
   * 修改账号（手机号 / 邮箱）。
   *
   * 账号是「多设备登录同一份档案」的唯一凭据，改它必须：
   *  1. **验当前密码** —— 谁能改账号谁就能接管这份档案（改完用新账号登录，
   *     linkedOpenids 一合并，两份档案就并到一起了）。不验密码等于把账号
   *     暴露成「任何人拿到会话都能改」；
   *  2. **查重** —— 撞到别人的账号，两个人下次登录会被并成同一份档案。
   * 账号填手机号时顺手同步 `phone`：手机号账号本身就是联系方式，
   * 让用户再单独补一遍手机号没有意义（页面上的手机号卡片就是为此去掉的）。
   */
  if (event.account !== undefined && event.account !== null) {
    const account = assertAccountFormat(event.account)
    if (me.account && account === me.account) throw new AppError('新账号与当前账号相同', 400)
    if (me.password && !verifyPassword(String(event.oldPassword || ''), me.password)) {
      throw new AppError('当前密码不正确', 401)
    }
    const dup = await db.collection(COL.user).where({ account }).limit(1).get()
    if (dup.data && dup.data.length) throw new AppError('该账号已被使用', 409)
    patch.account = account
    if (isPhoneLike(account)) patch.phone = account
  }
  // 修改密码（需先已设置密码 + 原密码校验）
  if (event.password) {
    if (!me.password) throw new AppError('尚未设置密码，请先设置账号密码', 400)
    if (!verifyPassword(event.oldPassword || '', me.password)) throw new AppError('原密码错误', 401)
    if (String(event.password).length < 6) throw new AppError('密码至少 6 位', 400)
    patch.password = hashPassword(event.password)
  }
  patch.updatedAt = new Date()
  await db.collection(COL.user).doc(me._id).update({ data: patch })
  return sanitizeUser(Object.assign({}, me, patch))
}

/* ==================== 学校：去重键 + 推广期免审开关 ==================== */

/**
 * 学校「绑定 / 建校」是否需要管理员审核（**推广期开关**）。
 *
 * 推广期要的是零摩擦：用户选到自己的学校就该立刻能进，
 * 等管理员审核等于把新用户挡在门口（审核延迟 / 管理员不在线 → 直接流失）。
 *
 * 配云函数环境变量 `SCHOOL_REVIEW`（不配 = `off`）：
 *  - `off`    ：绑定和建校都**立即生效**（推广期默认）
 *  - `on`     ：两者都走管理员审核（推广期结束后改回这个，**不用改代码**）
 *  - `bind`   ：只放开「绑定已有学校」，新建学校仍需审核
 *  - `create` ：只放开「新建学校」，绑定已有学校仍需审核
 *
 * ⚠️ 开关只在服务端读，前端传什么都不算数；前端通过 `mySchoolApply.policy`
 * 拿到结果，只用来决定界面（要不要弹理由框），真正的判定全在服务端。
 *
 * ⚠️ 显式判空而不是 `process.env.X || 'off'`：空字符串（`''`）也是「配了」，
 * 用 `||` 兜底会把配错的值悄悄吞成默认值 —— 项目里「改了不生效」的头号元凶。
 */
const SCHOOL_REVIEW_ENV = process.env.SCHOOL_REVIEW
const SCHOOL_REVIEW_MODE = (SCHOOL_REVIEW_ENV !== undefined && SCHOOL_REVIEW_ENV !== null &&
  String(SCHOOL_REVIEW_ENV).trim() !== '')
  ? String(SCHOOL_REVIEW_ENV).trim().toLowerCase()
  : 'off'

/** @param {'bind'|'create'} kind true = 需要管理员审核 */
function schoolReviewRequired(kind) {
  return !(SCHOOL_REVIEW_MODE === 'off' || SCHOOL_REVIEW_MODE === kind)
}

/**
 * 是否允许**新建学校** —— 只有管理员（超管 / 社团管理员）。
 *
 * 推广期免审放开的是「绑定已有学校」（换拉新零摩擦），**建校不能跟着放开**：
 *  - 人人能建校 → 列表被「测试」「asdf」「xx大学」刷满，用户在下拉里选不到
 *    自己的学校，只能自己再建一份，于是同一所学校被切成十几摊；
 *  - 学校是数据隔离的支点（猫档案 / 打卡 / 统计全按 schoolId 切），
 *    每建一所就等于开一个新的数据域，垃圾校区会一直占着统计和地图范围；
 *  - 建校内容会展示给全校，本来就该有人把关。
 *
 * 所以现在的规则是：**绑定 = 人人可选、选中即生效；建校 = 管理员专属**，
 * 管理员自己建校也立刻生效（不必审自己）。
 *
 * ⚠️ 判定必须在服务端：前端隐藏入口只是 UI，接口不挡的话改个参数就能建。
 */
function canCreateSchool(me) {
  return isSuper(me) || isAdmin(me)
}

/**
 * 学校去重键：`校名 | 校区`。
 *
 * 「东南大学 · 九龙湖校区」和「东南大学 · 四牌楼校区」是**两所独立档案**：
 * 各自有自己的 `_id`、自己的猫档案 / 打卡 / 地图范围（两个校区隔着几十公里，
 * 猫群和志愿者根本不是同一批，合成一条的话地图和统计都没法看）。
 *
 * 所以去重键必须把 `campus` 算进去 —— 只按校名判重的话，
 * 第二个校区会被误判成「重复」而建不出来。
 * 反过来，校名+校区都相同才算重复：空格 / 大小写 / 标点 / 末尾的「校区」后缀
 * 全部吃掉，避免「九龙湖校区」和「九龙湖」被当成两所学校建两份。
 */
function schoolKeyOf(name, campus) {
  const norm = s => String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-—_·．.、,，;；:：\/\\()（）【】\[\]"'’”]/g, '')
    .replace(/(校区|校园|校院|campus)$/g, '')
  return norm(name) + '|' + norm(campus)
}

/**
 * 查「同名同校区」的学校。
 * - 快路径：新落库的学校都带 `schoolKey`，一次 where 命中；
 * - 兜底：`schoolKey` 是这次才加的字段，**历史学校没有它**，where 查不到，
 *   只能全量比对（学校是几十所的量级，一次 limit(200) 扫描比维护索引划算）。
 */
async function findSameSchool(name, campus) {
  const key = schoolKeyOf(name, campus)
  if (!key || key === '|') return null
  let hit = []
  try {
    const r = await db.collection(COL.school).where({ schoolKey: key }).limit(1).get()
    hit = r.data || []
  } catch (e) { hit = [] }
  if (hit.length) return hit[0]
  let all = []
  try {
    const r = await db.collection(COL.school).limit(200).get()
    all = r.data || []
  } catch (e) { all = [] }
  return all.find(s => (s.schoolKey || schoolKeyOf(s.name, s.campus)) === key) || null
}

/**
 * 撤掉本人待审申请（**尽力而为**）。
 * 已经换好学校的人，超管的待审列表里不该还挂着一条申请 —— 审完又把他绑回去。
 */
async function withdrawOwnPending(me, handler) {
  try {
    await db.collection(COL.schoolApply)
      .where({ openid: me.openid, status: 'pending' })
      .update({ data: { status: 'withdrawn', handledAt: new Date(), handler } })
  } catch (e) {
    // 集合可能还没建（没跑过 initCollections）—— 那本来就没有待审，忽略
    if (!isCollectionMissing(e)) console.warn('[school] 撤回待审失败', e && e.message)
  }
}

/**
 * 把用户绑到学校 —— **全项目唯一写绑定关系的地方**。
 * 免审直绑 / 管理员自助 / 审核通过都走这里，避免「同一件事三份实现、
 * 其中一份漏了撤回待审」这类不一致。
 */
async function bindUserToSchool(me, schoolId) {
  // 🔴 用 me._id 直接更新：me 是 getMe 解析出来的当前用户文档（已带 _id）。
  // 早期写法 `where({ openid: me.openid })` 会漏掉「只存了系统字段 _openid、
  // 没存自建 openid」的历史档案 —— 表现就是「切换学校报 用户档案不存在」。
  // me._id 是文档主键，永远可靠，绕开这个坑。
  if (!me || !me._id) throw new AppError('用户档案不存在', 404)
  const s = isSuper(me)
    ? ((await db.collection(COL.school).doc(schoolId).get()).data)
    : await assertSchoolBindable(me, schoolId)
  if (!s) throw new AppError('学校不存在', 404)

  // 只写 schoolId：user 文档没有 schoolName 字段，校名一律由 getSchool 现取，
  // 多写一个字段等于埋一份会和云端不一致的冗余副本。
  await db.collection(COL.user).doc(me._id).update({ data: { schoolId } })
  await withdrawOwnPending(me, 'self-bound')
  return { ok: true, schoolId, school: s }
}

/**
 * 免审新建学校（**仅管理员**，见 canCreateSchool）：**先查重，再决定建不建**。
 *
 * 不查重的话「东南大学」会被建出 5 份，下拉里五个同名学校，
 * 用户根本不知道选哪个，数据也被切成五摊。
 * 撞上已有的同名同校区 → 直接把用户绑到那所（`reused:true`），不建副本。
 */
async function createSchoolDirect(me, event) {
  // 入口守卫：applySchool 已经挡过一道，这里再挡一次是因为它也可能被别处直接调用
  // （权限判定散在调用方的话，加新调用方时必然漏掉一次）。
  if (!canCreateSchool(me)) throw new AppError('仅管理员可创建学校', 403)
  const name = String(event.name || '').trim()
  if (!name) throw new AppError('请填写学校名称')
  const campus = String(event.campus || '').trim()
  const city = String(event.city || '').trim()
  const intro = String(event.intro || '').trim()
  // 建校内容会展示给全校看，安全检测不能因为「免审」就省掉
  const okText = await sec.checkText([name, campus, city, intro].filter(Boolean).join(' '))
  if (!okText) throw new AppError('内容未通过安全检测')

  const same = await findSameSchool(name, campus)
  if (same) {
    const r = await bindUserToSchool(me, same._id)
    return { status: 'bound', ok: true, schoolId: same._id, school: r.school, reused: true }
  }

  const geo = normalizeSchoolGeo({
    center: event.center, scale: event.scale, bounds: event.bounds
  })
  const doc = {
    name,
    campus,
    city,
    intro,
    schoolKey: schoolKeyOf(name, campus),
    center: geo.center,     // { lat, lng } 地图默认中心
    bounds: geo.bounds,     // { sw, ne } 校园可视范围
    scale: geo.scale,
    hidden: false,          // 用户自己建的学校必须立刻可选；隐藏只能由超管在后台设
    createdBy: me.openid,
    source: 'direct',       // 免审直建（区别于超管后台建的 / 审核通过的）
    createdAt: new Date()
  }
  const add = await db.collection(COL.school).add({ data: doc })
  await bindUserToSchool(me, add._id)
  return {
    status: 'bound', ok: true, schoolId: add._id,
    school: Object.assign({}, doc, { _id: add._id }), created: true
  }
}

async function createSchool(me, event) {
  // 仅超级管理员可创建学校
  requireSuper(me)
  if (!event.name) throw new AppError('缺少学校名称')
  const textOk = await sec.checkText([event.name, event.campus, event.intro].filter(Boolean).join(' '))
  if (!textOk) throw new AppError('内容未通过安全检测')
  // 查重：超管在后台建校也会手滑（同一校区建两次），
  // 建重了表现为下拉里两个一模一样的选项，用户选错校区数据就落在隔壁校区。
  const same = await findSameSchool(event.name, event.campus)
  if (same) {
    throw new AppError('已存在「' + (same.campus ? same.name + ' · ' + same.campus : same.name) + '」', 409)
  }
  const geo = normalizeSchoolGeo(event)
  const doc = {
    name: event.name,
    campus: event.campus || '',
    city: event.city || '',
    schoolKey: schoolKeyOf(event.name, event.campus),
    center: geo.center,     // { lat, lng } 地图默认中心
    bounds: geo.bounds,     // { sw:{lat,lng}, ne:{lat,lng} } 校园可视范围（地图只展示这块）
    scale: geo.scale,       // 进入地图时的缩放级别
    intro: event.intro || '',
    // 显式传 hidden 就以入参为准（建测试校园时直接勾上，别等它出现在用户下拉里才发现）
    hidden: event.hidden === undefined || event.hidden === null ? false : !!event.hidden,
    createdBy: me.openid,
    createdAt: new Date()
  }
  const add = await db.collection(COL.school).add({ data: doc })
  await db.collection(COL.user).doc(me._id).update({ data: { schoolId: add._id } })
  return Object.assign({}, doc, { _id: add._id })
}

/** 仅超管：更新学校信息（名称/简介/地图中心与范围） */
async function updateSchool(me, event) {
  requireSuper(me)
  if (!event.schoolId) throw new AppError('缺少学校 ID')
  const prev = await db.collection(COL.school).doc(event.schoolId).get()
  if (!prev.data) throw new AppError('学校不存在', 404)

  const patch = { updatedAt: new Date() }
  if (typeof event.name === 'string' && event.name.trim()) patch.name = event.name.trim()
  if (typeof event.campus === 'string') patch.campus = event.campus
  if (typeof event.city === 'string') patch.city = event.city
  if (typeof event.intro === 'string') patch.intro = event.intro

  // 改名 / 改校区必须同步去重键：否则查重还在拿旧 key 比新名字，
  // 表现为「改完名后同名学校查不出来」，又能建出一份重复的。
  // ⚠️ 显式 `undefined` 判断（campus 允许被改成空字符串 = 不带校区名）。
  if (patch.name !== undefined || patch.campus !== undefined) {
    const nextName = patch.name || prev.data.name
    const nextCampus = (patch.campus !== undefined && patch.campus !== null)
      ? patch.campus : (prev.data.campus || '')
    patch.schoolKey = schoolKeyOf(nextName, nextCampus)
    const same = await findSameSchool(nextName, nextCampus)
    if (same && same._id !== event.schoolId) {
      throw new AppError('已存在「' + (same.campus ? same.name + ' · ' + same.campus : same.name) + '」', 409)
    }
  }

  // 是否对普通用户隐藏（测试校园 / 未开放校区）。
  // ⚠️ 必须显式 `undefined` 判断：`event.hidden || false` 会把 `hidden: false`
  // （超管想**取消**隐藏）当成「没传」，字段永远改不回可见。
  if (event.hidden !== undefined && event.hidden !== null) patch.hidden = !!event.hidden

  // ⚠️ 必须用 `!== undefined` 判断，不能只用真值判断。
  // 客户端把 `center` / `scale` 以 undefined 传进来时（例如只调了 getSchool 没带 center），
  // `event.center || prev.data.center` 会走「未改」分支、进而继承旧 bounds ——
  // 但调用方其实是想「按新中心重算范围」，结果 bounds 一直停在老位置，
  // 表现出来就是「地图范围修改后不生效，还是默认值」。
  const hasCenter = event.center !== undefined && event.center !== null
  const hasScale = event.scale !== undefined && event.scale !== null
  const hasBounds = event.bounds !== undefined && event.bounds !== null

  if (hasCenter || hasScale || hasBounds) {
    const geo = normalizeSchoolGeo({
      center: hasCenter ? event.center : prev.data.center,
      scale: hasScale ? event.scale : prev.data.scale,
      // 只有「明确只改 bounds」时才继承旧值；改中心/缩放一律按新值重算
      bounds: hasBounds ? event.bounds : (!hasCenter && !hasScale ? prev.data.bounds : null)
    })
    patch.center = geo.center
    patch.bounds = geo.bounds
    patch.scale = geo.scale

    // 把「写进入参」和「最终落库值」一起打出来：
    // 排查「改了不生效」时，一眼就能分清是「参数没传进来」还是「落库被覆盖了」。
    console.log('[updateSchool] schoolId=', event.schoolId,
      'in.center=', JSON.stringify(event.center), 'in.scale=', event.scale,
      '=> out.center=', JSON.stringify(geo.center),
      'out.scale=', geo.scale, 'out.bounds=', JSON.stringify(geo.bounds))
  } else {
    console.log('[updateSchool] schoolId=', event.schoolId, '仅更新文字字段，地理信息未变')
  }

  // 安全检测：刻意包一层「失败即放行」的降级。
  // 学校名/简介属于后台运维文本，不是用户 UGC —— 若因 msgSecCheck 未开通、
  // 配额用尽或网络抖动而抛错，绝不能连累 地图范围（center/bounds/scale）也一起写不进去。
  // 这正是「改了范围却像没生效」的隐藏杀手之一。
  try {
    const textOk = await sec.checkText([patch.name, patch.campus, patch.intro].filter(Boolean).join(' '))
    if (!textOk) throw new AppError('内容未通过安全检测')
  } catch (e) {
    if (e instanceof AppError) throw e
    console.warn('[updateSchool] 文本安全检测异常，已降级放行', e && (e.message || e))
  }

  await db.collection(COL.school).doc(event.schoolId).update({ data: patch })
  return Object.assign({}, prev.data, patch, { _id: event.schoolId })
}

/**
 * 归一化学校地理信息。
 *  - center：无则用默认值（南京·东南大学四牌楼校区，README 里的示例学校）
 *  - scale：收敛到 12~18，越大越近
 *  - bounds：显式给了就用；否则按 center + scale 推一个「校园可视矩形」，
 *    地图端据此限制可视范围 —— 这样「选了某校就只展示这块区域」无需手工画框。
 */
function normalizeSchoolGeo(src) {
  const s = src || {}
  const DEFAULT_CENTER = { lat: 32.0585, lng: 118.7965 }   // 东南大学四牌楼校区
  // 必须同时是有限数字 —— 只判 typeof 的话，NaN 会一路带到 bounds，
  // 算出来的矩形全是 NaN，地图范围就「怎么改都不生效」。
  const cIn = s.center
  const cOk = cIn && typeof cIn.lat === 'number' && typeof cIn.lng === 'number' &&
    isFinite(cIn.lat) && isFinite(cIn.lng)
  const center = cOk ? { lat: Number(cIn.lat), lng: Number(cIn.lng) } : DEFAULT_CENTER
  const scale = Math.max(12, Math.min(18, Number(s.scale) || 16))

  let bounds = null
  if (s.bounds && s.bounds.sw && s.bounds.ne) {
    bounds = {
      sw: { lat: Number(s.bounds.sw.lat), lng: Number(s.bounds.sw.lng) },
      ne: { lat: Number(s.bounds.ne.lat), lng: Number(s.bounds.ne.lng) }
    }
    // 传进来的矩形若含非法坐标（NaN / 缺失），一律丢弃并按中心点重算，
    // 不能把一个坏矩形写进库 —— 那会让地图端 setBoundary 静默失效。
    const finite = v => v && isFinite(v.lat) && isFinite(v.lng)
    if (!finite(bounds.sw) || !finite(bounds.ne) ||
        bounds.sw.lat >= bounds.ne.lat || bounds.sw.lng >= bounds.ne.lng) {
      console.warn('[normalizeSchoolGeo] 传入 bounds 非法，改用中心点推算', JSON.stringify(s.bounds))
      bounds = null
    }
  }
  if (!bounds) {
    // 每级缩放约对应 1/2 的跨度：scale 16 → 约 ±0.006°（≈±660m）
    const half = 0.048 / Math.pow(2, scale - 12)
    const dLng = half / Math.max(0.2, Math.cos((center.lat * Math.PI) / 180))
    bounds = {
      sw: { lat: center.lat - half, lng: center.lng - dLng },
      ne: { lat: center.lat + half, lng: center.lng + dLng }
    }
  }
  return { center, bounds, scale }
}

/**
 * 学校是否对**普通用户**隐藏（超管永远看得见）。
 *
 * 两条判定，显式字段优先：
 *  1. `hidden === true` → 隐藏（超管在后台开关里设置，精确控制）
 *  2. 没设 hidden 但校名含「测试」→ 隐藏（兜底）
 *
 * 为什么要有第 2 条兜底：测试校园是超管自己建的，建的时候没人会记得先去勾
 * 「隐藏」，等到它出现在全校学生的选校下拉里才发现 —— 而此时已经有人绑上去了。
 * 名字兜底让「叫测试的校园」从建好那一刻起就不进用户视野，不需要任何数据迁移。
 *
 * 为什么显式 `hidden: false` 能**取消**名字兜底：兜底是启发式，必须给超管最终
 * 决定权，否则将来真出现一所名字带「测试」的正式校区就永远翻不了案。
 */
const SCHOOL_HIDDEN_NAME_RE = /测试|test/i
function isSchoolHidden(s) {
  if (!s) return false
  if (s.hidden !== undefined && s.hidden !== null) return !!s.hidden
  return SCHOOL_HIDDEN_NAME_RE.test(String(s.name || ''))
}

/**
 * 两点的球面距离（米）。任一端点缺合法经纬度 → 返回 null（不参与「附近」筛选）。
 * Haversine，足够 25km 这种城市级精度；学校 center 是 gcj02，和 gcj02 定位同基准，
 * 25km 量级下偏移误差可忽略。
 */
function geoDistanceM(a, b) {
  if (!a || !b) return null
  const raw = [a.lat, a.lng, b.lat, b.lng]
  if (raw.some(v => v === null || v === undefined)) return null
  const la1 = Number(a.lat), lo1 = Number(a.lng), la2 = Number(b.lat), lo2 = Number(b.lng)
  if (![la1, lo1, la2, lo2].every(isFinite)) return null
  const R = 6371000
  const rad = x => (x * Math.PI) / 180
  const dLat = rad(la2 - la1), dLng = rad(lo2 - lo1)
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * 用户选校列表（公开接口）。
 *
 * ⚠️ 这里是**唯一**的「普通用户能看见哪些学校」出口 —— 选校下拉、换校都走它。
 * 测试校园必须在这里被滤掉：一旦让它进下拉，用户绑上去之后首页/地图/图鉴
 * 全都指向测试数据，再想摘干净要动用户表。
 *
 * 超管不过滤：后台要能看到并编辑它（否则隐藏的学校就成了改不了的僵尸数据）。
 *
 * 2026-10-26 改：默认只回「用户当前位置 25km 内」的学校。
 *  - 内存 Haversine 算距离后过滤（项目铁律：geo where 缺索引直接失败，坐标过滤统一挪内存）；
 *  - 当前已绑定学校即使超出半径也常驻（用户不能因「离得远」就看不见自己学校，
 *    否则换了远校的人连「切回」都做不到）；
 *  - 拿不到定位（授权拒绝 / 设备不支持）→ 回退「全部学校」，不把用户锁死在空列表；
 *  - 超管不受半径限制。
 */
async function listSchools(me, event) {
  const showAll = isSuper(me)
  const res = await db.collection(COL.school).orderBy('createdAt', 'asc').limit(50).get()
  let list = res.data || []
  if (!showAll) list = list.filter(s => !isSchoolHidden(s))

  const lat = Number(event && event.lat)
  const lng = Number(event && event.lng)
  const haveLoc = isFinite(lat) && isFinite(lng)
  const radiusKm = Number(event && event.radiusKm) || 25
  const maxM = radiusKm * 1000
  const currentId = (event && event.currentSchoolId) || null

  // 拿不到定位：回退全部（已过滤隐藏），不锁死用户
  if (!haveLoc) return list

  const nearby = []
  let current = null
  for (const s of list) {
    const d = geoDistanceM({ lat, lng }, s.center)
    if (d === null) continue            // 没坐标的学校不参与「附近」筛选
    const item = Object.assign({}, s, { distanceM: d })
    if (s._id === currentId) { current = item; continue }
    if (d <= maxM) nearby.push(item)
  }
  // 当前绑定学校即使超半径也常驻（排最后），避免「看不见自己学校 / 切不回去」
  if (current) nearby.push(current)
  nearby.sort((a, b) => a.distanceM - b.distanceM)
  return nearby
}

/**
 * 超管：校园列表（含每所校区的档案数与绑定用户数）。
 *
 * 为什么不复用 listSchools：那是用户选校用的**公开**接口，只回校名/校区；
 * 后台还需要「这所学校到底有没有数据」—— 只回一行校名的话，管理员看到
 * 五所学校也不能判断哪所是空壳、哪所可以动手改。
 *
 * 为什么要 count 而不是把 cats/users 拉回来数：count 只回一个数字，
 * 几万条档案和零条档案的耗时一样；拉回来在函数里筛，等于把数据全搬进内存，
 * 还要吃客户端约 3s 的预算。
 *
 * `-1` = 该计数读取失败（集合不存在 / 权限 / 超时），前端显示「—」而不是「0」。
 * 「0 只猫」和「数不出来」在后台是两件事，混在一起会让管理员以为档案丢了。
 */
async function listSchoolsAdmin(me) {
  requireSuper(me)
  const res = await db.collection(COL.school).orderBy('createdAt', 'asc').limit(50).get()
  const list = res.data || []
  if (!list.length) return []

  // 并行发 2N 个 count：串行会是 2N 次往返，5 所学校就要 10 个来回。
  // 单校 count 失败只影响那一格，不能连累整张表（一所学校的集合异常不该让后台空白）。
  const stats = await Promise.all(list.map(async s => {
    const [catRes, userRes] = await Promise.all([
      db.collection(COL.cat).where({ schoolId: s._id }).count().catch(() => null),
      db.collection(COL.user).where({ schoolId: s._id }).count().catch(() => null)
    ])
    return {
      catCount: catRes && Number.isFinite(Number(catRes.total)) ? Number(catRes.total) : -1,
      userCount: userRes && Number.isFinite(Number(userRes.total)) ? Number(userRes.total) : -1
    }
  }))

  // 后台**不做隐藏过滤** —— 超管要能看见并编辑被隐藏的校区，
  // 否则一所隐藏学校就成了改不动的僵尸数据。只额外回一个算好的 hidden 供 UI 打标。
  return list.map((s, i) => Object.assign({}, s, stats[i], { hidden: isSchoolHidden(s) }))
}

/**
 * 读学校。带 self-heal：
 * 历史学校档可能「有 center 但没 bounds」（甚至 center 为空），
 * 直接返回就会让地图端拿不到可视范围 —— 这也是「范围不生效」的常见来源。
 * 这里在读取时补算 bounds 并把校档修正回库（仅超管能改的字段，补算不改变用户意图）。
 */
/**
 * 启动聚合：一次云函数调用拿齐「用户 + 学校 + 首页概览」。
 *
 * 为什么要它：启动链路原本是 login → getSchool → getOverview **三次串行**云调用。
 * `wx.cloud.callFunction` 每次都有固定开销（网络往返 + 实例调度），
 * 串行三次等于把这部分成本乘 3 —— 首页统计卡要等第三轮才渲染。
 * 合并成一次调用后，学校与概览在**同一次实例内并行**取，只付一次固定成本。
 *
 * ⚠️ 失败隔离：概览拉不到（比如学校刚删）不能连累登录 ——
 * 否则整个启动挂掉，前端 user/school 全空，表现为「变成爱猫同学 + 数据像全没了」。
 * 所以学校与概览各自 try/catch，登录本身抛错则让前端走旧路径回落。
 */
async function homeInit(me, event, ctx) {
  // 定身份（合并/重建/新建）必须先完成 —— schoolId 与角色都从这份档案来；
  // 之后的「发权益 / 拉学校 / 拉概览」三路互不依赖，全部并行。
  // 原来是 login() 整体串行：首页统计要等礼包检查那几次 DB 往返走完才开始查。
  const r = await loginResolve(me, event, ctx)
  const withOpenid = r.user
  const schoolId = withOpenid.schoolId || ''

  const finalizeP = loginFinalize(r)

  const schoolP = schoolId
    ? getSchool({ schoolId }).catch(e => {
        console.warn('[homeInit] 学校拉取失败，降级为未绑定', e && e.message)
        return null
      })
    : Promise.resolve(null)

  const overviewP = getOverview(withOpenid, Object.assign({}, event, { schoolId }))
    .catch(e => {
      // 概览是增强信息，失败就降级成 null：首页会自己走「无学校引导 / 单独重试」
      console.warn('[homeInit] 概览拉取失败，稍后由页面单独重试', e && e.message)
      return null
    })

  const [user, school, overview] = await Promise.all([finalizeP, schoolP, overviewP])
  // 概览里的 me 回声（猫粮值/积分卡的数值来源）必须用发完权益的最终档案覆盖，
  // 否则新用户首屏礼包在首页「看不见」，要等下一次刷新才出现。
  if (overview && user) {
    overview.me = {
      role: user.role,
      points: user.points || 0,
      peakPoints: Math.max(Number(user.peakPoints) || 0, Number(user.points) || 0),
      level: Number(user.level) || level.levelOf(Number(user.points) || 0).lv,
      food: user.food || 0,
      sightingCount: user.sightingCount || 0,
      nickName: user.nickName
    }
  }
  if (ctx && ctx.startedAt) console.log('[homeInit] 耗时', Date.now() - ctx.startedAt, 'ms')
  return { user, school, overview }
}

async function getSchool(event) {
  if (!event.schoolId) return null
  const res = await db.collection(COL.school).doc(event.schoolId).get()
  const s = res.data
  if (!s) return null
  if (!needsGeoRepair(s)) return s
  const geo = normalizeSchoolGeo(s)
  const patch = {}
  if (!geoCenterValid(s.center)) patch.center = geo.center
  if (!geoScaleValid(s.scale)) patch.scale = geo.scale
  if (!(s.bounds && s.bounds.sw && s.bounds.ne)) patch.bounds = geo.bounds
  if (!Object.keys(patch).length) return s
  try {
    await db.collection(COL.school).doc(event.schoolId).update({ data: patch })
    console.log('[getSchool] 已补齐学校地理信息', event.schoolId, JSON.stringify(patch))
  } catch (e) {
    console.warn('[getSchool] 补齐回库失败，仅返回补算结果', e && (e.message || e))
  }
  return Object.assign({}, s, patch)
}

function geoCenterValid(c) {
  return !!(c && typeof c.lat === 'number' && typeof c.lng === 'number' && !isNaN(c.lat) && !isNaN(c.lng))
}
function geoScaleValid(v) {
  return Number(v) >= 12 && Number(v) <= 18
}
/** 是否需要补算地理信息（缺 center / 缺 bounds / scale 非法） */
function needsGeoRepair(s) {
  if (!s) return false
  return !geoCenterValid(s.center) || !geoScaleValid(s.scale) || !(s.bounds && s.bounds.sw && s.bounds.ne)
}

/**
 * 绑定学校前的准入校验：存在性 + 是否对普通用户可见。
 *
 * 可见性这一条不能只做在 listSchools 里 —— 那是「下拉里看不见」，
 * 而 applySchool 是**按 id 申请**，知道 id 就能绕过下拉提交申请。
 * 只挡 UI 不挡接口的话，隐藏形同虚设（用户拿到 id 照样能申请进测试校园）。
 */
async function assertSchoolBindable(me, schoolId) {
  const s = await db.collection(COL.school).doc(schoolId).get()
  if (!s.data) throw new AppError('学校不存在', 404)
  if (!isSuper(me) && isSchoolHidden(s.data)) {
    throw new AppError('该校园未开放', 403)
  }
  return s.data
}

/**
 * 选校 / 建校（2026-10-30 定稿的两条规则）：
 *
 * 【绑定已有学校 · 传 `schoolId`】**人人可绑**，是否立即生效由 `SCHOOL_REVIEW` 决定：
 *  - 免审（推广期默认 `off`）：直接 `bindUserToSchool`，选中即生效；
 *  - 审核（`on`）：落一条 `type:'join'` 待审，超管通过后才绑定。
 *    必须填 **reason（申请理由）** 且过文本安全检测 —— 理由会出现在管理员审核界面，
 *    是判断「这人是不是本校的」的主要依据。
 *
 * 【新建学校 · 传 `name`】**仅管理员（超管 / 社团管理员），且一律立即生效**：
 *  - 普通用户传 name → 403，请他从已有列表里选学校；
 *  - 管理员建校**不看 `SCHOOL_REVIEW`**：他是各校数据的维护者，
 *    让他给自己提一条建校申请再等超管审一遍没有意义（与 bindSchoolSelf 同理由）。
 *  校名 / 校区 / 简介**仍过安全检测**（建校内容会展示给全校），
 *  并先查重：撞上同名同校区就绑到已有的那所（`reused:true`），不建副本。
 *
 * ⚠️ 为什么审核模式不能「选中即绑定」：知道 schoolId 就能挤进任意学校的数据。
 * 免审模式是**推广期**的主动取舍（换拉新零摩擦），推广结束把开关改回 `on` 即可，
 * 代码与前端都按 policy 自适应，不需要再改一遍。
 *
 * ⚠️ 同一用户只保留一条待审：连点/反复提交会把审核列表刷满，
 * 管理员处理掉一条又冒出三条，最后没人愿意审。
 */
/**
 * 申请落库后通知超管（站内通知 + 订阅消息）。
 *
 * 这里用 **await 而不是 fire-and-forget**：通知是这次提交的关键产物，
 * fire-and-forget 在实例被回收时会丢失，申请就会一直挂着没人审 ——
 * 正是本次要修的问题（管理员压根不知道有人申请）。
 * 超管是 openid 白名单、人数极少，一次批量写入的耗时可控。
 *
 * 但异常必须吞掉：通知失败时申请其实已经落库，若把错误抛给用户，
 * 他会再点一次，然后撞上 already_pending，体验更差。
 */
async function notifyAdminOfApply(apply) {
  try {
    await notify.schoolApplySubmitted(apply)
  } catch (e) {
    console.warn('[applySchool] 通知超管失败（申请已落库，忽略）', e && (e.message || e))
  }
}

async function applySchool(me, event) {
  const isJoin = !!event.schoolId

  // 🔴 建校：**仅管理员，且管理员建校免审**（见 canCreateSchool）。
  // 免审的理由和 bindSchoolSelf 一样 —— 管理员本身就是各校数据的维护者，
  // 让他给自己提一条建校申请、再等超管审一遍，既无安全收益又纯添堵。
  // ⚠️ 这段必须放在开关判断**之前**：免审开关本意只放开「绑定已有学校」，
  // 放在后面的话 `SCHOOL_REVIEW=off` 时普通用户照样能建校。
  if (!isJoin) {
    if (!canCreateSchool(me)) {
      throw new AppError('仅管理员可创建学校，请从列表中选择你的学校', 403)
    }
    return createSchoolDirect(me, event)
  }

  // 绑定已有学校：推广期免审（选中即生效），
  // 后期恢复审核只需把环境变量改回 `SCHOOL_REVIEW=on`，代码不用动。
  if (!schoolReviewRequired('bind')) {
    const r = await bindUserToSchool(me, String(event.schoolId).trim())
    return { status: 'bound', ok: true, schoolId: r.schoolId, school: r.school }
  }

  // 同一用户只保留一条待审：连点/反复提交会把审核列表刷满。
  // ⚠️ 这是**写**路径：集合没建的话必须现建再写，否则用户点「提交申请」
  // 只会收到一句「提交失败」，而他自己什么也做不了。所以这里 await，
  // 代价只发生在「集合确实不存在」这一次（进程内缓存命中后零开销）。
  let dup
  try {
    dup = await db.collection(COL.schoolApply)
      .where({ openid: me.openid, status: 'pending' }).limit(1).get()
  } catch (e) {
    if (!isCollectionMissing(e)) throw e
    await ensureCollection(COL.schoolApply)
    dup = await db.collection(COL.schoolApply)
      .where({ openid: me.openid, status: 'pending' }).limit(1).get()
  }
  // 待审期间禁止再提交：给前端一个明确 reason，前端据此把选校/新建入口置灰。
  // 只返回 status:'pending' 的话前端分不清「刚提交成功」和「早先就有待审」，
  // 用户就能一直点，审核列表也会被刷屏。
  if (dup.data.length) {
    return { status: 'pending', reason: 'already_pending', apply: dup.data[0] }
  }

  // 走到这里只剩一种情况：**审核模式 + 加入已有学校**。
  // （建校那条路已经在函数开头返回了 —— create 是管理员专属且免审，
  // 所以 `school_applies` 里不会再出现 type:'create'。）
  const s = await assertSchoolBindable(me, event.schoolId)
  const reason = String(event.reason || '').trim()
  if (!reason) throw new AppError('请填写申请理由')
  const okText = await sec.checkText(reason)
  if (!okText) throw new AppError('申请理由未通过安全检测')
  const doc = {
    openid: me.openid,
    _openid: me.openid,
    nickName: me.nickName || '',
    type: 'join',
    schoolId: event.schoolId,
    schoolName: s.name || '',
    reason,
    status: 'pending',
    createdAt: new Date()
  }
  const add = await db.collection(COL.schoolApply).add({ data: doc })
  const apply = Object.assign({}, doc, { _id: add._id })
  await notifyAdminOfApply(apply)
  return { status: 'submitted', apply }
}

/**
 * 管理员自助绑校 / 换校（**免审**）。
 *
 * 为什么管理员要豁免：2026-10-26 把「选中即绑定」的后门关掉、全部走待审，
 * 是因为**任何人**知道 schoolId 就能挤进任意学校的数据（审核类目红线）。
 * 但管理员本身就是各校数据的维护者，让他给自己提申请、再由超管审一遍，
 * 既无安全收益又纯添堵（用户反馈「管理员选校还要申请不合理」）。
 *
 * ⚠️ 豁免的边界必须收在服务端：`role` 由 `requireRole` 校验，
 * 前端传什么都不算数，普通用户调这个接口会被拦在 role:'admin' 之外。
 *
 * ⚠️ 普通管理员（admin）仍然过 `assertSchoolBindable`：隐藏校（测试校园）
 * 只对超管可见，admin 不能靠直绑绕进去。
 *
 * 直绑成功后把该用户自己的 pending 申请置为 `withdrawn` —— 否则他已经换好学校了，
 * 超管的待审列表里还挂着一条「申请加入 A 校」，审完又把他绑回 A 校。
 */
async function bindSchoolSelf(me, event) {
  const schoolId = String((event && event.schoolId) || '').trim()
  if (!schoolId) throw new AppError('缺少学校 ID', 400)
  return bindUserToSchool(me, schoolId)
}

/**
 * 超管：给历史学校补 `schoolKey`（去重键）。
 *
 * `schoolKey` 是这次才加的字段，老学校没有它 —— 查重会退化成全量比对（能work但慢）。
 * 部署后跑一次这个 action 补上，查重就回到一次 where 命中。
 *
 * 并行 Promise.all 而不是串行 await 循环：串行是 N 次往返，
 * 几十所学校能把云函数的 3s 预算吃穿（项目云函数预算红线）。
 */
async function backfillSchoolKeys(me) {
  requireSuper(me)
  const res = await db.collection(COL.school).limit(200).get()
  const list = res.data || []
  const todo = []
  for (const s of list) {
    const key = schoolKeyOf(s.name, s.campus)
    if (!key || s.schoolKey === key) continue
    todo.push({ id: s._id, key })
  }
  await Promise.all(todo.map(x =>
    db.collection(COL.school).doc(x.id).update({ data: { schoolKey: x.key } })))
  return { total: list.length, updated: todo.length }
}

/**
 * 超管：列出**已经建重**的学校（同校名 + 同校区出现了 2 份以上）。
 *
 * 查重是这次才加的，历史上很可能已经存在重复（比如「东南大学」建了两次）。
 * 只加查重不清理存量，用户下拉里照样有两个一模一样的选项。
 * 这个 action 只读不改：合并校区要动猫档案 / 打卡 / 任务，必须人工确认后再做。
 */
async function findDuplicateSchools(me) {
  requireSuper(me)
  const res = await db.collection(COL.school).limit(200).get()
  const list = res.data || []
  const groups = {}
  for (const s of list) {
    const key = s.schoolKey || schoolKeyOf(s.name, s.campus)
    if (!key || key === '|') continue
    ;(groups[key] = groups[key] || []).push({
      _id: s._id,
      name: s.name || '',
      campus: s.campus || '',
      city: s.city || '',
      createdBy: s.createdBy || '',
      createdAt: s.createdAt || null,
      missingKey: !s.schoolKey
    })
  }
  return Object.keys(groups)
    .filter(k => groups[k].length > 1)
    .map(k => ({ key: k, count: groups[k].length, schools: groups[k] }))
}

/**
 * 撤回自己的待审申请。
 *
 * 待审期间前端会把选校 / 新建入口全部置灰（防刷审核列表），
 * 但**没有撤回通道的话就成了一个死局**：管理员迟迟不审、用户又撤销不了申请，
 * 只能干等，想改主意换一所学校也不行（用户反馈「申请后还有问题」）。
 *
 * 用条件更新（status='pending' 才写）防并发：管理员刚好点通过的同时撤回，
 * 只会有一个成功，另一个拿到 updated=0。
 */
async function withdrawSchoolApply(me, event) {
  const id = String((event && event.id) || '').trim()
  if (!id) throw new AppError('缺少申请 ID', 400)
  let r
  try {
    r = await db.collection(COL.schoolApply)
      .where({ _id: id, openid: me.openid, status: 'pending' })
      .update({ data: { status: 'withdrawn', handledAt: new Date(), handler: 'self' } })
  } catch (e) {
    if (!isCollectionMissing(e)) throw e
    throw new AppError('没有可撤回的申请', 404)
  }
  if (!r.stats || !r.stats.updated) throw new AppError('该申请已处理，无法撤回', 409)
  return { ok: true }
}

/**
 * 我最近一条学校申请（前端用它显示「审核中 / 被驳回 / 已通过」状态）。
 *
 * 返回对象附 `label`（join 取 schoolName，create 取 name）与 `type`，
 * 前端据此显示「入校申请 / 建校申请」，同时保留原始 `name` 字段以兼容老客户端。
 */
async function mySchoolApply(me) {
  // 集合没建（没跑过 initCollections）=「还没有任何申请」，不是故障。
  // 直接返回空 + 后台把集合建出来（下次就正常），别把 -502005 抛给前端 ——
  // 这个接口每个用户每次进「我的」页都会调一次。
  let list = []
  try {
    const res = await db.collection(COL.schoolApply)
      .where({ openid: me.openid }).orderBy('createdAt', 'desc').limit(5).get()
    list = res.data || []
  } catch (e) {
    if (!isCollectionMissing(e)) throw e
    ensureCollection(COL.schoolApply)      // 后台副作用，不 await（见 core.js 性能红线）
  }
  const applyLabel = a => (a && a.type === 'join')
    ? (a.schoolName || '该校')
    : ((a && a.name) || '该校')
  const decorate = a => a ? Object.assign({ label: applyLabel(a) }, a) : null
  const pick = st => list.filter(a => a.status === st)[0] || null
  return {
    pending: decorate(pick('pending')),
    rejected: decorate(pick('rejected')),
    approved: decorate(pick('approved')),
    schoolId: me.schoolId || '',
    // 审核开关（推广期免审）：前端只用它决定界面（要不要弹理由框、文案怎么写），
    // 真正的判定在服务端 —— 前端传什么都不影响 `applySchool` 走不走审核。
    // `reviewBind` / `reviewCreate`：true = **需要**管理员审核（字段名带 review 前缀，
    // 避免前端把 `policy.bind` 误读成「可以绑定」—— 两个方向都会写错一次）
    policy: {
      mode: SCHOOL_REVIEW_MODE,
      reviewBind: schoolReviewRequired('bind'),
      reviewCreate: schoolReviewRequired('create'),
      // 建校是管理员专属（与免审开关无关，见 canCreateSchool）。
      // 前端据此决定要不要显示「没有我的学校？创建」入口 —— 显示了点下去也是 403。
      canCreate: canCreateSchool(me)
    }
  }
}

/** 待审的建校申请（仅超管） */
async function listSchoolApplies(me, event) {
  requireSuper(me)
  // 集合没建 = 没有待审申请（后台顺手建出来），别让超管后台整页报红
  try {
    const res = await db.collection(COL.schoolApply)
      .where({ status: (event && event.status) || 'pending' })
      .orderBy('createdAt', 'desc').limit(50).get()
    return res.data || []
  } catch (e) {
    if (!isCollectionMissing(e)) throw e
    ensureCollection(COL.schoolApply)
    return []
  }
}

/**
 * 审核建校申请（仅超管）。
 *
 * 并发安全：两个管理员同时点「通过」时，用**条件更新**抢占（status='pending' 才写），
 * 只有一份能把状态推进到 approving，另一份拿到 updated=0 直接报「已处理」。
 * 否则会给同一条申请建出两所学校，其中一所没有任何人绑定。
 *
 * 建校失败要把状态退回 pending：卡在 approving 的申请既不在待审列表、
 * 也不能再被通过，等于永久丢失（用户会一直看到「审核中」）。
 */
async function handleSchoolApply(me, event) {
  requireSuper(me)
  if (!event.id) throw new AppError('缺少申请 ID')
  const now = new Date()
  const handler = me.nickName || ''

  if (!event.approve) {
    const r = await db.collection(COL.schoolApply)
      .where({ _id: event.id, status: 'pending' })
      .update({ data: { status: 'rejected', handler, handledAt: now } })
    if (!r.stats || !r.stats.updated) throw new AppError('该申请已处理', 409)
    return { status: 'rejected' }
  }

  const claim = await db.collection(COL.schoolApply)
    .where({ _id: event.id, status: 'pending' })
    .update({ data: { status: 'approving', handler, handledAt: now } })
  if (!claim.stats || !claim.stats.updated) throw new AppError('该申请已处理', 409)

  const apply = (await db.collection(COL.schoolApply).doc(event.id).get()).data
  try {
    // 加入已有学校：审核通过 = 把申请人绑到该校（不新建学校）。
    if (apply.type === 'join') {
      // 学校可能已被删 / 设为隐藏：再核一次，避免把用户绑到一个查不到数据的 dangling id。
      await assertSchoolBindable(me, apply.schoolId)
      // 申请人可能只有历史 _openid 文档：用 findUserByOpenid 兜底（同样的 _or 查法），
      // 否则 `where({ openid })` 查不到 → 通过审核了却没把人绑上。
      const u = await findUserByOpenid(apply.openid)
      if (u) {
        await db.collection(COL.user).doc(u._id)
          .update({ data: { schoolId: apply.schoolId } })
      }
      await db.collection(COL.schoolApply).doc(event.id).update({
        data: { status: 'approved', schoolId: apply.schoolId, handledAt: new Date() }
      })
      return { status: 'approved', schoolId: apply.schoolId }
    }

    // 新建学校：审核通过 = 建校 + 绑定申请人（type==='create' 或旧记录无 type → 兼容）
    // 审核时再检一次：管理员可能直接点通过没细看名字，用户填的学校名会展示给全校
    const okText = await sec.checkText([apply.name, apply.campus, apply.city, apply.intro]
      .filter(Boolean).join(' '))
    if (!okText) throw new AppError('申请内容未通过安全检测')

    // 审核期间这所学校可能已经被建出来了（别人免审直建 / 另一条申请先通过）。
    // 不查重就会在同一校名下建出两份，下拉里两个一模一样的选项，数据也被切成两摊。
    const same = await findSameSchool(apply.name, apply.campus)
    if (same) {
      const u = await findUserByOpenid(apply.openid)
      if (u) {
        await db.collection(COL.user).doc(u._id)
          .update({ data: { schoolId: same._id } })
      }
      await db.collection(COL.schoolApply).doc(event.id).update({
        data: { status: 'approved', schoolId: same._id, handledAt: new Date() }
      })
      return { status: 'approved', schoolId: same._id, reused: true, school: same }
    }

    const geo = normalizeSchoolGeo({})
    const schoolDoc = {
      name: apply.name,
      campus: apply.campus || '',
      city: apply.city || '',
      intro: apply.intro || '',
      schoolKey: schoolKeyOf(apply.name, apply.campus),
      center: geo.center,
      bounds: geo.bounds,
      scale: geo.scale,
      createdBy: apply.openid,
      fromApplyId: event.id,
      createdAt: now
    }
    const add = await db.collection(COL.school).add({ data: schoolDoc })
    // 绑定申请人（listSchools 里可能还没出现过这所学校，但申请人自己要有归属）
    const u = await findUserByOpenid(apply.openid)
    if (u) {
      await db.collection(COL.user).doc(u._id)
        .update({ data: { schoolId: add._id } })
    }
    await db.collection(COL.schoolApply).doc(event.id).update({
      data: { status: 'approved', schoolId: add._id, handledAt: new Date() }
    })
    return { status: 'approved', schoolId: add._id, school: Object.assign({}, schoolDoc, { _id: add._id }) }
  } catch (e) {
    // 退回待审：卡在 approving 等于永久丢失（待审列表看不到、也不能再通过）
    await db.collection(COL.schoolApply).doc(event.id)
      .update({ data: { status: 'pending', handler: '', handledAt: null } })
      .catch(() => {})
    throw e
  }
}

/* ==================== 概览统计 ==================== */

async function getOverview(me, event) {
  const schoolId = resolveSchoolId(me, event)
  assertSchool(me, schoolId)
  const where = schoolId ? { schoolId } : {}
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)

  // 首页已不再展示「待办任务 / 本月 TNR / TNR 进展」，这两次 count 一并去掉：
  // 概览是打开小程序就要跑的接口，少两次 DB 往返就少一份顶穿预算的风险。
  // 社团运营数据在「工作台」按需拉，不该压在首页首屏上。
  const [catAll, catOnCampus, sterilized, sightingMonth, funds, recent] = await Promise.all([
    db.collection(COL.cat).where(Object.assign({}, where, { status: _.nin(['rainbow', 'adopted']) })).count(),
    db.collection(COL.cat).where(Object.assign({}, where, { status: 'campus' })).count(),
    db.collection(COL.cat).where(Object.assign({}, where, { sterilized: 'yes', status: _.nin(['rainbow', 'adopted']) })).count(),
    db.collection(COL.sighting).where(Object.assign({}, where, { createdAt: _.gte(monthStart) })).count(),
    isMember(me) ? listFundSummary(schoolId) : Promise.resolve({ income: 0, expense: 0 }),
    // 最近目击与上面的统计是**互不依赖**的，必须一起并行：
    // 早先它单独 await 排在 7 个 count 后面，白多一次串行 DB 往返。
    db.collection(COL.sighting).where(where).orderBy('createdAt', 'desc').limit(5).get()
  ])

  const recentData = (recent && recent.data) || []
  const catIds = [...new Set(recentData.map(s => s.catId).filter(Boolean))]
  let catMap = {}
  if (catIds.length) {
    const cats = await db.collection(COL.cat).where({ _id: _.in(catIds) }).get()
    cats.data.forEach(c => { catMap[c._id] = { name: c.name, avatar: c.avatar, status: c.status } })
  }

  // 首页「最新目击」缩略图换 https（同 listSightings，客户端读不到他人私有文件）
  // 可见性：非公开记录不下发（同 listSightings 口径，避免私有记录从首页漏出）
  const recentOut = recentData
    .filter(s => isMember(me) || s.visibility === 'public' || (me && s.reporter === me.openid))
    .map(s => Object.assign({}, s, { cat: catMap[s.catId] || null }))
  // 首页每条只展示首图（photosSmall[0]）：只换 1 张的临时链接并把其余裁掉。
  // getTempFileURL 是概览链路上最贵的一次外网调用，原来每条换 3 张纯属浪费 ——
  // 多换的图首页不渲染，客户端也没法拿它们做任何事（他人私有文件）。
  await maplib.attachSightingMediaUrls(recentOut, { maxPhotos: 1 })
  recentOut.forEach(s => {
    if (Array.isArray(s.photos) && s.photos.length > 1) s.photos = s.photos.slice(0, 1)
  })

  const alive = catAll.total || 0
  return {
    catCount: alive,
    onCampus: catOnCampus.total || 0,
    sterilized: sterilized.total || 0,
    sterilizedRate: alive ? Math.round((sterilized.total / alive) * 100) : 0,
    sightingMonth: sightingMonth.total || 0,
    fund: funds,
    recent: recentOut,
    // food 是首页那张「我的猫粮值」卡的数值来源；积分（points）在「我的」页看
    me: me ? {
      role: me.role,
      points: me.points || 0,
      peakPoints: Math.max(Number(me.peakPoints) || 0, Number(me.points) || 0),
      level: Number(me.level) || level.levelOf(Number(me.points) || 0).lv,
      food: me.food || 0,
      sightingCount: me.sightingCount || 0,
      nickName: me.nickName
    } : null
  }
}

/**
 * 经费汇总（只算收入/支出总额）。
 *
 * 用聚合在服务端求和：原先两次 get() 把整年流水搬回函数内加总 ——
 * 记录变多后首页启动被它拖慢；且 get() 单批上限 100 条，超出会**少算**。
 * 聚合一来一回只返两个数字，不随流水规模膨胀。
 */
async function listFundSummary(schoolId) {
  const where = schoolId ? { schoolId } : {}
  const $ = db.command.aggregate
  const res = await db.collection(COL.fund).aggregate()
    .match(where)
    .group({ _id: '$type', total: $.sum('$amount') })
    .end()
  const list = (res && res.list) || []
  const pick = t => {
    const hit = list.find(r => r._id === t)
    return hit ? (Number(hit.total) || 0) : 0
  }
  return { income: pick('income'), expense: pick('expense') }
}

/* ==================== 猫档案 ==================== */

/**
 * 猫档案列表。
 *
 * ⚠️ **未绑定学校时返回空**（2026-10-25 修）：原来 `where` 里没有 schoolId，
 * 查询就退化成「全环境所有猫」—— 一个刚注册、还没选学校的用户打开猫谱，
 * 能看到所有学校的全部档案。猫档案是按校运营的内容，跨校可见既不合规也不合理。
 *
 * 与 listDex 保持同一口径：回 `needSchool:true` + 空列表，让前端能明确提示
 * 「绑定学校后可见」，而不是给一个空列表让人以为「本校一只猫都没有」。
 *
 * 管理端不受影响：超管显式传 `schoolId` 时 assertSchool 放行，后台照常可查。
 */
async function listCats(me, event) {
  const schoolId = resolveSchoolId(me, event)
  assertSchool(me, schoolId)
  if (!schoolId) return { needSchool: true, list: [], hasMore: false, page: 1 }

  const where = { schoolId }
  if (event.status) where.status = event.status
  if (event.sterilized) where.sterilized = event.sterilized
  if (event.pattern) where.pattern = event.pattern

  let q = db.collection(COL.cat).where(where)
  if (event.keyword) {
    q = q.where({ name: db.RegExp({ regexp: escapeReg(event.keyword), options: 'i' }) })
  }
  const { page, size, skip } = pageOf(event, 20, 50)
  const res = await q.orderBy('updatedAt', 'desc').skip(skip).limit(size).get()

  const list = res.data.map(c => sanitizeCat(c, me))
  // 头像换 https 临时链接（管理端权限，能读环境内所有文件）：
  // 客户端读不到「别人上传的」私有文件，服务端不换就会出现
  // 「自己传的猫有头像、别人传的空白」。列表只要头像，不换 photos（省一次批量调用）。
  await maplib.attachCatMediaUrls(list, { photos: false })

  return {
    list,
    hasMore: res.data.length === size,
    page
  }
}

/**
 * 猫谱筛选诊断（超管）。
 *
 * 现象：「选橘猫显示没查到」。可能的原因有四种，界面上长得一模一样：
 *  ① 档案压根没写 pattern（建档时没动花色选择器 → 默认 other）
 *  ② 写的是值域外的值（AI 回传/历史脏数据对不上前端 PATTERN）
 *  ③ 查询本身挂了（where + orderBy 缺复合索引 → 云开发直接报错，前端落空态）
 *  ④ 真的没有这个花色的猫
 * 只给「查不到」这个结果没法区分，所以这里把分布、脏值、查询是否报错全摊开。
 *
 * 只读、不写库。查三次：分布一次、带排序探针一次、不带排序对照一次。
 */
async function diagnoseCatFilters(me, event) {
  const schoolId = event.schoolId || (me && me.schoolId) || ''
  if (!schoolId) return { needSchool: true, schoolId: '' }

  let schoolName = ''
  try {
    const s = await db.collection(COL.school).doc(schoolId).get()
    schoolName = (s.data && s.data.name) || ''
  } catch (e) { schoolName = '' }

  const proj = { _id: true, name: true, pattern: true, status: true, sterilized: true, updatedAt: true }
  let rows = []
  try {
    const r = await db.collection(COL.cat).where({ schoolId }).field(proj).limit(300).get()
    rows = r.data || []
  } catch (e) {
    return { schoolId, schoolName, error: '读取猫档案失败：' + ((e && e.message) || e) }
  }

  const known = Object.keys(PATTERN_LABELS)
  const tally = (key) => {
    const m = {}
    rows.forEach(c => {
      // 空串也要归到「(空)」：建档时花色选择器没动过往往落的是空串，
      // 它和缺字段一样「筛选永远选不中」，混在真实值里看不出来
      const raw = c[key]
      const v = (raw === undefined || raw === null || raw === '') ? '(空)' : String(raw)
      m[v] = (m[v] || 0) + 1
    })
    return m
  }
  // 值域外的 pattern：筛选一定选不中它们，且界面上看不出来
  const dirty = rows
    .filter(c => !c.pattern || known.indexOf(String(c.pattern)) < 0)
    .map(c => ({ catId: c._id, name: c.name || '', pattern: c.pattern === undefined ? null : c.pattern }))
  const missingUpdatedAt = rows.filter(c => !c.updatedAt).length
  // pattern='other' 往往是「建档时花色选择器没动过」，而不是真的「其他」。
  // 「选橘猫查不到」最常见的真相就是橘猫被存成了 other —— 单独列出来，
  // 和真·脏值区分开（脏值是值域外，这个在值域内但几乎等于没标）。
  const otherCats = rows
    .filter(c => c.pattern === 'other')
    .map(c => ({ catId: c._id, name: c.name || '' }))

  // 探针：用「数量最多且非 other」的花色实跑一次正式链路同款查询，看是不是查询本身报错
  const byPattern = tally('pattern')
  const probeValue = Object.keys(byPattern)
    .filter(v => v !== 'other' && v !== '(空)')
    .sort((a, b) => byPattern[b] - byPattern[a])[0] || ''

  let probe = null
  if (probeValue) {
    probe = { value: probeValue, expected: byPattern[probeValue] }
    try {
      const r = await db.collection(COL.cat)
        .where({ schoolId, pattern: probeValue })
        .orderBy('updatedAt', 'desc').limit(50).get()
      probe.count = (r.data || []).length
      probe.error = ''
    } catch (e) {
      probe.count = -1
      probe.error = (e && e.message) || String(e)
      // 不带排序再跑一次对照：能返回 = 缺 (schoolId, pattern, updatedAt) 复合索引
      try {
        const r2 = await db.collection(COL.cat)
          .where({ schoolId, pattern: probeValue }).limit(50).get()
        probe.countNoOrder = (r2.data || []).length
      } catch (e2) {
        probe.countNoOrder = -1
      }
    }
  }

  return {
    schoolId, schoolName,
    cats: rows.length,
    byPattern, byStatus: tally('status'), bySterilized: tally('sterilized'),
    dirtyPatternCount: dirty.length,
    dirtyPattern: dirty.slice(0, 10),
    // 未标注花色（pattern=other）：筛选选不中它们，界面上也看不出来
    otherPatternCount: otherCats.length,
    otherPattern: otherCats,
    missingUpdatedAt,
    probe
  }
}

/** 图鉴一次最多取多少只（云函数里单次 get 上限 1000，这里留足余量给换链） */
const DEX_MAX = 200

/**
 * 图鉴收集：**按用户当前绑定的学校**统计。
 *
 * 为什么不能继续用「我的」页那套 listCats：
 *  1. 未绑定学校时 listCats 的 where 是空的 → 返回**全环境**的猫，
 *     新用户看到「0 / 4」，其实是别校的猫，凭空给他一个进度条；
 *  2. 已收集数按全局 `catSeen` 算，用户换过学校后会出现「已收集 7 / 总数 4」——
 *     旧学校拍到的猫被算进了新学校的图鉴。
 *
 * 所以这里必须两件事一起做：按 schoolId 取猫、按「本校猫 id ∩ catSeen」算已收集。
 *
 * `brief=true` 只回计数（「我的」页只需要 4/12 这个数），走 `.field({_id:true})`
 * 不取头像、也不换临时链接 —— 少一次 getTempFileURL 批量调用。
 */
async function listDex(me, event) {
  const schoolId = resolveSchoolId(me, event)
  if (!schoolId) {
    return { needSchool: true, schoolId: '', total: 0, seen: 0, percent: 0, list: [] }
  }
  const brief = !!(event && event.brief)
  const where = { schoolId }

  const [cnt, res] = await Promise.all([
    db.collection(COL.cat).where(where).count(),
    (brief
      ? db.collection(COL.cat).where(where).field({ _id: true })
      : db.collection(COL.cat).where(where).orderBy('createdAt', 'desc').limit(DEX_MAX)
    ).get()
  ])

  const userSeen = new Set(Array.isArray(me && me.catSeen) ? me.catSeen : [])
  const rows = res.data || []
  const total = Number(cnt.total) || 0
  const percent = (n) => (total ? Math.min(100, Math.round(n / total * 100)) : 0)

  if (brief) {
    const seen = rows.filter(r => userSeen.has(r._id)).length
    return { brief: true, needSchool: false, schoolId, total, seen, percent: percent(seen), list: [] }
  }

  // 头像口径与 listCats 一致：没设 avatar 就用 photos[0] 顶（否则档案有图、图鉴空白）
  const list = rows.map(c => ({
    id: c._id,
    name: c.name || '未命名',
    pattern: c.pattern || '',
    avatar: c.avatar || (Array.isArray(c.photos) && c.photos[0]) || '',
    unlocked: userSeen.has(c._id)
  }))
  // 原始 fileID 另存一份：换链后的 https 过期时，前端还能凭它重新换（临时链接 ≠ 拼接错）
  list.forEach(it => { it.avatarId = it.avatar })
  await maplib.attachCatMediaUrls(list, { photos: false })

  const seen = list.filter(it => it.unlocked).length
  return {
    brief: false,
    needSchool: false,
    schoolId,
    total,
    seen,
    percent: percent(seen),
    // 超过 DEX_MAX 时如实告知，而不是让前端以为「本校只有 200 只」
    truncated: total > rows.length,
    list
  }
}

async function getCat(me, event) {
  if (!event.id) throw new AppError('缺少猫 ID')
  // doc.get 对「不存在的 _id」会直接抛原始 DB 错误（document with _id xxx does not exist），
  // 上一轮的中性兜底会把它吞成「数据读取失败」——但这里其实是可判定、可说人话的场景：
  // 最常见是列表还是旧数据、点进来时这只猫已经被删了（30s 节流窗口内的过期列表）。
  // 主动 catch 一次，转成明确的 404 业务文案，前端 toast 直接展示。
  let cat = null
  try {
    const res = await db.collection(COL.cat).doc(event.id).get()
    cat = res.data
  } catch (e) {
    console.warn('[getCat] 档案读取失败 id=' + event.id, (e && e.errMsg) || (e && e.message) || e)
    throw new AppError('这只猫咪不存在或已被删除', 404)
  }
  if (!cat) throw new AppError('这只猫咪不存在或已被删除', 404)

  // 目击 / TNR 是详情页的次要数据：它们查挂了不应该连累整页档案打不开
  // （典型如 tnr_records 集合还没建、或查询瞬时抖动 —— 以前会整页报「数据读取失败」）。
  const [sightings, tnrList] = await Promise.all([
    db.collection(COL.sighting).where({ catId: cat._id }).orderBy('createdAt', 'desc').limit(10).get()
      .catch(e => { console.warn('[getCat] 目击读取降级', (e && e.message) || e); return { data: [] } }),
    isMember(me)
      ? db.collection(COL.tnr).where({ catId: cat._id }).orderBy('createdAt', 'desc').limit(5).get()
          .catch(e => { console.warn('[getCat] TNR 读取降级', (e && e.message) || e); return { data: [] } })
      : Promise.resolve({ data: [] })
  ])
  const catOut = sanitizeCat(cat, me)
  // 可见性过滤：非公开记录对外不可见（sanitizeSighting 返回 null → 剔除）
  const sightOut = sightings.data.map(s => sanitizeSighting(s, me)).filter(Boolean)
  // 档案详情：头像 + 相册 + 目击照片一并换 https（详情页照片多，上限内一次批量够用）
  // ids:true → 额外带一份原始 fileID（photoIds），供前端预览时重新换链 / 云下载
  await maplib.attachCatMediaUrls([catOut], { ids: true })
  await maplib.attachSightingMediaUrls(sightOut)
  return {
    cat: catOut,
    sightings: sightOut,
    tnr: tnrList.data,
    // 能否编辑档案 = 管理员及以上（超管在 login 时已被授予 admin 角色）
    canEdit: isAdmin(me)
  }
}

/** 错误文本：云开发的 errMsg 往往带错误码与原因，比 message 有用 */
function errText(e) {
  if (!e) return ''
  if (typeof e === 'string') return e
  return String(e.errMsg || e.message || e)
}

/**
 * 更新档案文档：把真实错误带出来，并对瞬时故障重试一次。
 *
 * 现场（2026-10-24「新增照片后保存报 document.update:fail」）：客户端 toast
 * 会 `slice(0, 20)` —— `document.update:fail` 正好 20 个字，后面的
 * `-502001 database request fail` 之类的真原因全被切掉，只能靠猜。
 *
 * 这里做三件事：
 *  ① 失败时把完整 errMsg + 字段清单打进日志（含旧档案快照，便于对比哪个字段变了）；
 *  ② 隔 300ms 重试一次 —— -502001 多为云开发侧瞬时抖动，重试几乎必成；
 *  ③ 仍失败就把原因原样抛给前端（前端用弹窗展示，不再被截断）。
 */
async function updateCatDoc(id, payload, existing) {
  const write = () => db.collection(COL.cat).doc(id).update({ data: payload })
  try {
    await write()
    return
  } catch (e) {
    const msg = errText(e)
    console.error('[saveCat] 更新失败', msg,
      '| 字段:', Object.keys(payload).join(','),
      '| 照片:', (payload.photos || []).length,
      '| 头像:', String(payload.avatar || '').slice(0, 60))
    if (existing) {
      console.error('[saveCat] 旧档案快照',
        'photos=', (existing.photos || []).length,
        'avatar=', String(existing.avatar || '').slice(0, 60))
    }
    await new Promise(r => setTimeout(r, 300))
    try {
      await write()
      console.warn('[saveCat] 重试后更新成功（首次为瞬时故障）:', msg)
    } catch (e2) {
      throw new AppError('保存失败：' + (errText(e2) || msg || '数据库拒绝写入'), 500)
    }
  }
}

/**
 * 保存档案时，图片安全检测最多花多久（毫秒）。
 *
 * 客户端 `callFunction` 有约 3s 硬预算（-504003），而这一路上还要
 * getMe + 文本检测 + 写库 + 发猫粮。图片检测（下载原图 + 同步送检）是唯一
 * 耗时不可控的一步，给它 1000ms 上限；超了就转「异步媒体检测」放行，
 * 保证「点一次就保存成功」而不是「点第二遍才成功」。
 */
const SAVE_IMG_BUDGET_MS = 1000

async function saveCat(me, event) {
  const t0 = Date.now()
  const d = event.data || {}
  if (!d.name) throw new AppError('请填写猫咪名字')

  // ① 文本检测**先发出去**：它与「读旧档案 / 图片检测」互不依赖。
  //    旧写法全程串行（文本 → 读档案 → 下载图 → 同步送检 → 写库 → 发猫粮），
  //    实测 2.5~3.5s；冷启动再加 1s 就必然撞上客户端 3s 硬预算（-504003）。
  //    现场症状正是「点第一遍超时、点第二遍成功」——第二遍容器已经热了。
  const textP = sec.checkText(
    [d.name, d.alias, d.note, d.internalNote, d.colorNote].filter(Boolean).join(' '))

  const photos = (d.photos || []).slice(0, 9)
  // 已存在的档案先读一次：既用来判断「哪些照片是新加的」，也能在更新失败时打出对照。
  let existing = null
  if (d._id) {
    existing = (await db.collection(COL.cat).doc(d._id).get().catch(() => ({ data: null }))).data
    // 档案被删（或 id 传错）时 update 只会静默返回 updated:0，
    // 用户看到的是「保存成功但其实什么都没保存」——比报错更糟。直接拦住。
    if (!existing) throw new AppError('这只猫的档案不存在（可能已被删除），请返回列表重试', 404)
  }

  // ② 挑出需要过图片检测的新图（老图入库时已检过），检测同样先发出去
  let imgP = null
  if (photos.length) {
    const oldPhotos = (existing && Array.isArray(existing.photos)) ? existing.photos : null
    // 候选 = 「客户端说是新传的」∪「库里原来没有的」。
    // 取并集而不是只听一方的：客户端可能漏报（旧版本），也可能瞎报（想跳过检测）；
    // 两边都算的坏处只是多检一张，好处是「新增图片一定过检测」。
    const hinted = Array.isArray(event.newPhotoIds) ? event.newPhotoIds : []
    const cand = photos.filter(p => hinted.indexOf(p) >= 0 ||
      (oldPhotos && oldPhotos.indexOf(p) < 0))
    // 新建档案（没有历史可比）→ 检第一张
    const fresh = cand.length ? cand : (oldPhotos ? [] : photos.slice(0, 1))
    if (fresh.length) {
      // 只检一张 + 自带预算：超时转异步检测，绝不把保存拖过 3s
      imgP = sec.checkImage(fresh[0], { budgetMs: SAVE_IMG_BUDGET_MS })
    }
  }

  // ③ 两道检测一起收口（并行已在上面铺好）
  if (!(await textP)) throw new AppError('文字内容未通过安全检测，请修改后重试')
  if (imgP && !(await imgP)) throw new AppError('图片未通过安全检测')

  const schoolId = d.schoolId || me.schoolId
  assertSchool(me, schoolId)
  const now = new Date()
  const payload = {
    name: d.name,
    alias: d.alias || '',
    sex: d.sex || 'unknown',
    pattern: d.pattern || 'other',
    colorNote: d.colorNote || '',
    sterilized: d.sterilized || 'unknown',
    earMark: d.earMark || '',
    status: d.status || 'campus',
    health: d.health || 'unknown',    characters: d.characters || [],
    location: d.location || null,
    spotPrivate: !!d.spotPrivate,
    avatar: d.avatar || '',
    photos,
    birthday: d.birthday || '',
    relations: d.relations || [],
    note: d.note || '',
    internalNote: d.internalNote || '',
    medicalNote: d.medicalNote || '',
    schoolId: schoolId || '',
    // ⚠️ 这里**不写 aiIndexAt**：建档时字段不存在（`_.exists(false)` 才查得到），
    // 改档时用 `_.remove()` 把它删掉。旧写法写 null，而 null 字段对
    // `where({ aiIndexAt: _.exists(false) })` 来说「存在」，于是换过照片的猫
    // 再也不会被自动补库 —— 「改了图但特征库没更新」的隐形成因。
    updatedBy: me.openid,
    updatedAt: now
  }
  // 已下线的枚举在这里也归一一次：旧版客户端缓存 / AI 识别结果仍可能回传
  // 休学(suspend)、灰蓝(gray)、暹罗(siamese)，别让它们再写回库里。
  normalizeEnum(payload)

  if (d._id) {
    // 清空「已入库」标记：建档或改档（尤其是换照片）后，服务端特征库需要重新收录。
    // 之后的第一次识别会顺带把这只猫的照片带给服务端补算（见 lib/vision.js 的
    // pickPendingIndexCats），所以管理员不必手动点「建库」。
    payload.aiIndexAt = _.remove()
    // 没有点位就**删字段**而不是写 null：null 与「不存在」在查询里是两种东西，
    // 且 update 里塞 null 是历史踩过的坑（giftAt）。能删就别写 null。
    if (!payload.location) delete payload.location
    await updateCatDoc(d._id, payload, existing)
    console.log('[saveCat] 更新完成', d._id, Date.now() - t0, 'ms')
    return { _id: d._id }
  }

  // ④ 幂等闸：客户端超时重试会带同一个 saveToken + attempt>1。
  //    -504003 只是「客户端不等了」，云函数其实还在跑、很可能已经把档案写进库；
  //    用户手点第二遍就会多建一只同名的猫。这里按 token 查一次，
  //    查到就返回原 _id —— 对客户端来说就是「保存成功」，且不会重复建档。
  //    只在「重试」时才查：首发多一次查询等于白花 180ms 预算。
  const token = String(d.saveToken || '').slice(0, 64)
  const isRetry = Number(event.attempt) > 1
  if (token && isRetry) {
    const dup = await db.collection(COL.cat).where({ saveToken: token }).limit(1)
      .get().catch(() => ({ data: [] }))
    const hit = (dup.data || [])[0]
    if (hit) {
      console.warn('[saveCat] 命中重复提交（客户端超时重试），返回已有档案', hit._id)
      return { _id: hit._id, deduped: true }
    }
  }

  payload.createdAt = now
  payload.createdBy = me.openid
  payload.sightingCount = 0
  if (token) payload.saveToken = token
  const add = await db.collection(COL.cat).add({ data: payload })
  // 规则：建立档案 +15 ~ +20 猫粮值。有照片给满档 ——
  // 照片是这只猫能进特征库、后续被识别出来的前提，值得多 5 点。
  // 发放失败不能影响建档本身（档案是主业务，奖励是附加权益）。
  const kind = photos.length ? 'catCreatePhoto' : 'catCreate'
  const g = await points.grantFood(me, kind, null, { refType: 'cat', refId: add._id })
    .catch(e => {
      console.warn('[saveCat] 建档猫粮发放失败，已忽略', e && e.message)
      return { gained: 0 }
    })
  console.log('[saveCat] 建档完成', add._id, Date.now() - t0, 'ms',
    '| 图片检测:', imgP ? '有' : '无', '| token:', token ? '有' : '无')
  return { _id: add._id, foodGained: g.gained || 0 }
}

/**
 * 删除猫档案（**仅超级管理员**，2026-10-24 收紧）。
 *
 * 原来的实现只有 `doc(id).remove()`，没有任何权限与存在性校验：ACTIONS 里写的是
 * role:'admin'，也就是**任何一个校园管理员**都能删本环境任意档案，删不存在的 id 也静默成功。
 * 删除档案是不可恢复的破坏性操作，按「超管才能删」收紧（后台的「重复档案」清理也是超管页）。
 *
 * 刻意**不连带删除**的东西（删了比留着更糟）：
 *  - 打卡记录 sightings：那是别人真实发生过的记录，删猫顺手删记录等于抹掉他人贡献，
 *    还会把记录作者的 sightingCount 扣掉。保留后列表页显示「未知」（cat 字段为 null 已有兜底）。
 *  - 特征库残留（识别服务侧 index/<catId>.bin）：match 只对**库里存在的猫**打分，
 *    残留不会变成幽灵候选；服务端没有删除接口，为清几百字节再加一次网络调用不划算。
 *  - 图鉴 catSeen：listDex 用「本校猫 id ∩ catSeen」计数，已删的 id 自然落选，不用回写。
 */
async function removeCat(me, event) {
  requireSuper(me)
  const id = String((event && event.id) || '').trim()
  if (!id) throw new AppError('缺少档案 ID')
  // 先查再删：超时重发时第二次会走到这里，给「已被删除」比静默成功更清楚
  const cur = await db.collection(COL.cat).doc(id).get().catch(() => null)
  const cat = (cur && cur.data) || null
  if (!cat) throw new AppError('档案不存在或已被删除')
  await db.collection(COL.cat).doc(id).remove()
  // 名字回给前端做提示（trim 掉建档时可能带进来的首尾空格，免得提示文案里多出空格）
  const name = String(cat.name || '').trim()
  console.log('[removeCat] 超管删除档案', id, name)
  // 同步清理识别服务侧的特征向量 —— 不删就成幽灵残留：
  //   检索仍会返回它（靠云函数 byId 过滤），且管理页「N 条向量」比对档案数多几条。
  //   best-effort：删档已成功，清理失败只记日志，靠后台「全部重建」兜底。
  const cleaned = await vision.deleteIndexEntry(id, cat.schoolId || '')
  console.log('[removeCat] 特征库清理', cleaned ? '已删' : '跳过/失败')
  // 不改任何关联表的计数（见上面的说明）
  return { _id: id, name }
}

/**
 * 重复档案检测（超管）。
 *
 * 为什么需要：客户端 `callFunction` 有约 3s 硬预算，超时后既会自动重发、用户也会手点
 * 第二遍 —— 历史上真的建出过「同名同校的两只猫」（2026-10-24 现场：录入一只，猫谱里两条一样）。
 * 而小程序端此前**没有任何删除入口**（`removeCat` 一直没被前端调用过），用户只能看着。
 *
 * 判重口径：**同校 + 同名**（去首尾空格、忽略大小写）。
 * 刻意不按照片/特征相似度判：同一只猫的照片本来就可以有好几张，用相似度会把两只真猫
 * 误判成重复，合并错了无法复原；宁可漏报（用户自己删）也不要误报。
 *
 * 建议保留哪条：**照片最多的**（特征库最全），照片数并列则**最早创建的**（先来的是正本）。
 * 这只是建议，前端仍然允许删任意一条 —— 现场可能恰好是「后建的那条才带照片」。
 */
async function findDuplicateCats(me, event) {
  requireSuper(me)
  const schoolId = resolveSchoolId(me, event)
  const where = schoolId ? { schoolId } : {}
  // 200 条覆盖一个校区的全部档案绰绰有余；真到这个量级，重复建档反而不会发生了
  const res = await db.collection(COL.cat).where(where)
    .orderBy('createdAt', 'asc').limit(200).get()
  const rows = res.data || []

  const buckets = {}
  rows.forEach(c => {
    const key = String(c.name || '').trim().toLowerCase() + '|' + (c.schoolId || '')
    if (!buckets[key]) buckets[key] = []
    buckets[key].push(c)
  })

  const groups = []
  Object.keys(buckets).forEach(key => {
    const arr = buckets[key]
    if (arr.length < 2) return
    const photoCount = c => (Array.isArray(c.photos) ? c.photos.length : 0)
    let keep = arr[0]
    arr.forEach(c => { if (photoCount(c) > photoCount(keep)) keep = c })
    groups.push({
      key,
      name: String(arr[0].name || '').trim(),
      keepId: keep._id,
      items: arr.map(c => ({
        _id: c._id,
        createdAt: c.createdAt || null,
        photoCount: photoCount(c),
        hasAvatar: !!c.avatar,
        sightingCount: Number(c.sightingCount) || 0,
        keep: c._id === keep._id
      }))
    })
  })

  return { scanned: rows.length, groups }
}

/**
 * 一键生成「游客体验数据」（仅超管，幂等）。
 *
 * 目的：审核员以游客身份进入小程序，猫谱/地图/首页若全是空页，
 * 极易被判「页面功能不完整」而拒审。这里把演示数据造齐。
 *
 * 规则（安全阀）：
 *  - 已绑定学校则直接用；没绑定才创建示范学校，并把自己绑上去
 *  - 本校已有猫档案则整体跳过 —— 绝不往真实数据里混演示猫
 *  - 演示猫不带照片（猫卡显示首字母占位），坐标按学校中心做百米级偏移
 *  - 直接落库、不走 secCheck：内容是代码里写死的受控文案，且不烧检测配额
 * 审核通过后如需清理：管理员在猫谱页对演示猫逐个「删除」即可。
 */
/**
 * 头像/照片「为什么空白」的现场取证。
 *
 * 判读方法（rows[].media 每项的 kind）：
 *  - cloud   ：云存储 fileID。看 status —— 0=文件正常（换链成功）；
 *              非 0 = 文件已不存在或无权限，这就是空白根因，重新上传一张即可。
 *  - http    ：外部 http(s) 地址。若指向 127.0.0.1/localhost 这类本机地址，
 *              换设备必然加载不出来。
 *  - local   ：wxfile:// / http://tmp 之类的**本机临时路径**——
 *              说明建档时没上传成功就把本地路径存进了库，必须重新上传。
 *  - empty   ：字段本身为空，即这只猫压根没设头像（占位图是正常表现）。
 */
async function debugCatMedia(me, event) {
  requireRole(me, 'admin')
  const schoolId = resolveSchoolId(me, event)
  const where = schoolId ? { schoolId } : {}
  let q = db.collection(COL.cat).where(where)
  if (event.name) q = q.where({ name: event.name })
  const res = await q.limit(50).get()

  const rows = res.data.map(c => {
    const media = []
    if (c.avatar) media.push(c.avatar)
    ;(Array.isArray(c.photos) ? c.photos : []).forEach(p => media.push(p))
    return {
      _id: c._id,
      name: c.name,
      schoolId: c.schoolId || '',
      avatar: c.avatar || '',
      photoCount: (Array.isArray(c.photos) ? c.photos : []).length,
      aiIndexAt: c.aiIndexAt || null,
      media: media.map(m => ({
        value: m,
        kind: /^cloud:\/\//.test(m) ? 'cloud'
          : (/^https?:\/\//.test(m) ? (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(m) ? 'local-http' : 'http') : 'local')
      }))
    }
  })
  const probes = await maplib.probeTempUrls(rows.reduce((a, r) => a.concat(r.media.map(m => m.value)), []))
  const pmap = {}
  probes.forEach(p => { pmap[p.fileID] = p })
  rows.forEach(r => {
    r.media.forEach(m => {
      if (m.kind === 'cloud') {
        const p = pmap[m.value] || {}
        m.urlOk = !!p.hasUrl
        m.status = p.status
        m.errMsg = p.errMsg
      }
    })
    if (!r.avatar) r.hint = (r.photoCount ? 'avatar 为空但有相册（已由服务端回退用 photos[0]）' : '没有任何照片，占位图是正常表现')
  })
  return { schoolId, total: rows.length, rows }
}

async function seedDemoData(me, event) {
  requireSuper(me)
  let schoolId = me.schoolId || ''
  let school = null
  if (schoolId) {
    const s = await db.collection(COL.school).doc(schoolId).get().catch(() => null)
    school = s && s.data
  }
  if (!school) {
    const geo = normalizeSchoolGeo({ center: { lat: 32.0585, lng: 118.7965 }, scale: 16 })
    school = {
      name: '喵园示范校区', campus: '', city: '南京市',
      center: geo.center, bounds: geo.bounds, scale: geo.scale,
      intro: '校园流浪猫救助与信息查询示范点',
      createdBy: me.openid, createdAt: new Date()
    }
    const add = await db.collection(COL.school).add({ data: school })
    schoolId = add._id
    await db.collection(COL.user).doc(me._id).update({ data: { schoolId } }).catch(() => {})
  }

  const exist = await db.collection(COL.cat).where({ schoolId }).count()
  if (exist.total > 0) {
    return { schoolId, skipped: true, reason: '本校已有猫档案，不混入演示数据', total: exist.total }
  }

  const c = (school.center && isFinite(school.center.lat)) ? school.center : { lat: 32.0585, lng: 118.7965 }
  // ⚠️ 演示数据也走合规口径（2026-10-16 二审）：
  //   ① `note` 是**自由文本**，审核在测试账号里能看到 —— 已全部删除；
  //   ② 猫况改用**结构化标签**（health / characters / earMark / behaviors），
  //      与打卡页同一套枚举，形态是"档案登记"而非"图文笔记"。
  //   ③ colorNote / earMark 是短结构化描述（如「橘白爪，圆脸」），保留；
  //      **不再写任何成句的叙述性文字**（"饭点准时出现，亲人可摸"这类一律去掉）。
  const demo = [
    { name: '大橘', pattern: 'orange', sex: 'male', sterilized: 'yes', health: 'good',
      characters: ['friendly', 'foodie'], colorNote: '橘白爪，圆脸', earMark: '左耳缺口',
      behaviors: ['eating', 'resting'],
      locationName: '一食堂后门花坛', location: { lat: c.lat + 0.0012, lng: c.lng + 0.0008 } },
    { name: '狸花', pattern: 'tabby', sex: 'female', sterilized: 'no', health: 'good',
      characters: ['shy'], colorNote: '标准狸花条纹', earMark: '',
      behaviors: ['hiding', 'alert'],
      locationName: '图书馆东侧草坪', location: { lat: c.lat - 0.0015, lng: c.lng + 0.0010 } },
    { name: '奶牛', pattern: 'cow', sex: 'male', sterilized: 'yes', health: 'good',
      characters: ['playful', 'foodie'], colorNote: '黑白块分明', earMark: '右耳缺口',
      behaviors: ['playing', 'moving'],
      locationName: '宿舍区3栋楼下', location: { lat: c.lat + 0.0006, lng: c.lng - 0.0012 } },
    { name: '小白', pattern: 'white', sex: 'unknown', sterilized: 'yes', health: 'good',
      characters: ['quiet', 'shy'], colorNote: '纯白，蓝眼睛', earMark: '',
      behaviors: ['hiding'],
      locationName: '操场看台下方', location: { lat: c.lat - 0.0008, lng: c.lng - 0.0015 } },
    { name: '三花', pattern: 'calico', sex: 'female', sterilized: 'unknown', health: 'good',
      characters: ['friendly'], colorNote: '三花，尾尖白', earMark: '',
      behaviors: ['resting'],
      locationName: '教学楼A栋南侧', location: { lat: c.lat + 0.0018, lng: c.lng - 0.0006 } }
  ]
  const now = new Date()
  let created = 0
  for (const d of demo) {
    await db.collection(COL.cat).add({
      data: Object.assign({}, d, {
        status: 'campus',
        spotPrivate: false,
        avatar: '', photos: [],
        birthday: '', relations: [],
        // 演示档案不留任何自由文本备注（note / internalNote / medicalNote 全空）
        note: '', internalNote: '', medicalNote: '',
        schoolId, sightingCount: 0,
        createdBy: me.openid, updatedBy: me.openid,
        createdAt: now, updatedAt: now
      })
    })
    created++
  }
  return { schoolId, schoolName: school.name, created }
}

/* ==================== 积分流水迁移 ==================== */

/**
 * 一次性迁移：把 users.points 里的历史余额补记进 points 流水表。
 *
 * 背景：points（猫粮流水）是后期才加的记录表 —— 之前发放积分只更新 users.points，
 * 不写流水，所以新表是空的、历史猫粮值「看不见」。余额本身没有丢（users.points
 * 一直在），只是缺流水记录。
 *
 * 设计要点：
 *  - 幂等：只在用户**还没有任何流水**时补一条 kind='migrate' 的期初行；
 *    已有流水的用户一律跳过 —— 重复调用不会产生重复记录、不会重复加分。
 *  - 不改 users.points（余额不动，只补记录）。
 *  - 期初行的 balance 直接取当前 users.points，delta 等于 balance（作为「期初建账」）。
 */
async function backfillPointsLedger(me, event) {
  const pageSize = 100
  let skip = 0
  let migrated = 0
  let skipped = 0
  const details = []

  while (true) {
    const res = await db.collection(COL.user)
      .orderBy('createdAt', 'asc').skip(skip).limit(pageSize).get()
    const users = res.data || []
    if (!users.length) break

    for (const u of users) {
      const balance = Number(u.points) || 0
      // 没有余额的不需要迁移
      if (balance <= 0) { skipped++; continue }
      // 已有流水（无论多少）→ 说明已经迁移过或正常发放过，跳过
      const existed = await db.collection(COL.point)
        .where({ userId: u._id }).limit(1).count()
      if (existed.total > 0) { skipped++; continue }

      await db.collection(COL.point).add({
        data: {
          openid: u.openid || u._openid || '',
          userId: u._id,
          // 双货币拆分（2026-10-18）后，users.points 的语义是**积分值**（只增不减、判等级），
          // 所以这批历史余额按积分归档。显式写 currency：靠读时兜底也能对，
          // 但新建账就该写清楚，别让后来的人以为漏字段。
          currency: 'point',
          kind: 'migrate',
          reason: '历史积分迁入（期初建账）',
          delta: balance,
          balance,
          refType: 'migrate',
          refId: '',
          createdAt: (u.createdAt) || new Date()
        }
      })
      migrated++
      if (details.length < 20) details.push({ userId: u._id, nickName: u.nickName || '', balance })
    }

    skip += users.length
    if (users.length < pageSize) break
  }

  console.log('[backfillPoints] 迁移', migrated, '人，跳过', skipped, '人（无余额或已有流水）')
  return { migrated, skipped, sample: details }
}

/**
 * 一次性回填：把 sightings 里 schoolId 为空的记录补上归属（仅超管，幂等，分片）。
 *
 * 为什么会有一批空值（2026-10-25 实测）：打卡时 `schoolId = d.schoolId || me.schoolId || ''`，
 * 用户档案当时还没绑学校 → 写入空串。这些记录在所有按校过滤的查询里都查不到。
 *
 * 归属怎么定（优先级从高到低）：
 *  1. catId → 猫档案的 schoolId（最可靠：猫必然属于某校，且打卡与猫强相关）
 *  2. reporter → 上报人档案的 schoolId（无 catId 的「未认领新猫」记录走这条）
 *  3. 都拿不到 → 跳过（留空，等用户绑校后再跑一次）
 *
 * 幂等：只处理 schoolId 为空（或字段不存在）的记录，已填的一律不动。
 * 分片：每次最多处理 size 条（默认 100），返回 remaining，重复调用直到为 0 即可。
 */
async function backfillSightingSchoolId(me, event) {
  requireSuper(me)
  const size = Math.max(1, Math.min(200, Number(event && event.size) || 100))
  const missing = _.or([{ schoolId: '' }, { schoolId: _.exists(false) }])

  const res = await db.collection(COL.sighting)
    .where(missing).field({ catId: true, reporter: true }).limit(size).get()
  const rows = res.data || []
  if (!rows.length) return { scanned: 0, updated: 0, skipped: 0, remaining: 0, done: true }

  // 批量取猫档案的 schoolId
  const catIds = [...new Set(rows.map(r => r.catId).filter(Boolean))]
  const catSchool = {}
  for (let i = 0; i < catIds.length; i += 20) {
    const batch = catIds.slice(i, i + 20)
    const cs = await db.collection(COL.cat)
      .where({ _id: _.in(batch) }).field({ schoolId: true }).limit(batch.length).get()
      .catch(() => ({ data: [] }))
    ;(cs.data || []).forEach(c => { if (c && c.schoolId) catSchool[c._id] = c.schoolId })
  }

  // 无 catId 的记录：按上报人的 openid 找用户档案
  const openids = [...new Set(rows.filter(r => !r.catId).map(r => r.reporter).filter(Boolean))]
  const userSchool = {}
  for (let i = 0; i < openids.length; i += 20) {
    const batch = openids.slice(i, i + 20)
    const us = await db.collection(COL.user)
      .where({ openid: _.in(batch) }).field({ schoolId: true }).limit(batch.length).get()
      .catch(() => ({ data: [] }))
    ;(us.data || []).forEach(u => { if (u && u.schoolId) userSchool[u.openid] = u.schoolId })
  }

  let updated = 0, skipped = 0
  for (const r of rows) {
    const sid = (r.catId && catSchool[r.catId]) || (!r.catId && r.reporter && userSchool[r.reporter]) || ''
    if (!sid) { skipped++; continue }
    await db.collection(COL.sighting).doc(r._id)
      .update({ data: { schoolId: sid } })
      .catch(e => console.warn('[backfillSightingSchool] 更新失败', r._id, e && e.message))
    updated++
  }

  const left = await db.collection(COL.sighting).where(missing).count().catch(() => ({ total: 0 }))
  console.log('[backfillSightingSchool] 扫描', rows.length, '更新', updated, '跳过', skipped, '剩余', left.total)
  return {
    scanned: rows.length, updated, skipped,
    remaining: Math.max(0, Number(left.total) || 0),
    done: !left.total
  }
}

/* ==================== 目击打卡 ==================== */

/** 投喂状态白名单（与小程序 utils/const.js 的 FEED_STATUS 保持一致，前后端各维护一份） */
const FEED_STATUS_VALUES = ['passed', 'fed', 'fedByOther']

/**
 * 食物类型白名单 → 积分档位（规则：「喂食按食物类型 +2 ~ +5」）。
 *
 * 规则文档只给了区间，没给具体分档，这里按「投喂成本 / 用心程度」排：
 *   干粮 2 < 零食 3 < 罐头 4 < 自制 5。
 * 用**表格映射**而不是在代码里写 if：以后调分档只改这一行，
 * 且前端 const.js 的 FOOD_TYPE 里同名列着分值，两边能直接对照。
 * 老客户端不传 foodType → 默认干粮（最常见的投喂方式）。
 */
const FOOD_TYPE_VALUES = ['dry', 'snack', 'wet', 'homemade']
const FOOD_TYPE_KIND = {
  dry: 'feedDry',
  snack: 'feedSnack',
  wet: 'feedWet',
  homemade: 'feedHomemade'
}

/** 健康观察白名单 —— 必须与小程序 utils/const.js 的 C.HEALTH 逐值对齐。
 *  曾出现后端用 ['unknown','healthy','sick','injured','suspected']、前端用
 *  good/cold/ringworm/stomatitis/eye/injured/severe/unknown 的口径不一致：
 *  用户在打卡页选「感冒/猫藓/口炎」编辑保存时被后端静默丢弃，只有 injured/unknown 能改。 */
const HEALTH_VALUES = ['good', 'cold', 'ringworm', 'stomatitis', 'eye', 'injured', 'severe', 'unknown']

/** 目击行为标签白名单 —— 与小程序 utils/const.js 的 C.SIGHT_BEHAVIOR 逐值对齐。
 *  ⚠️ 合规背景（2026-10-16 审核驳回「社交-笔记」）：
 *    原打卡页有自由文本 textarea「它在做什么？」，审核认定「用户自行生成文字 + 图片 + 公开可见」
 *    属社交-笔记（个人主体未开放类目）。改为**预设标签多选**后形态变为「登记猫况」。
 *    白名单服务端必须再过滤一次：客户端可被篡改，不能信任任意字符串。
 *    新增项只写**客观状态**，不要加主观评价/情绪类词汇（否则又回到"创作"形态）。 */
const SIGHT_BEHAVIOR_VALUES = [
  'resting', 'eating', 'moving', 'playing', 'hiding', 'alert', 'withOthers', 'unusual'
]

/** 外观特征标签白名单 —— 与小程序 utils/const.js 的 C.SIGHT_FEATURE 逐值对齐。
 *  替代原「补充（20 字）」自由文本输入。同 SIGHT_BEHAVIOR，服务端必须再过滤一次。 */
const SIGHT_FEATURE_VALUES = [
  'earNotch', 'thin', 'fat', 'belly', 'limping',
  'eyeIssue', 'noseDry', 'furLoss', 'collar', 'pregnant'
]

/** 打卡记录可见性。默认 private（合规：「不公开」才不构成内容发布/传播）。 */
const SIGHTING_VIS_PRIVATE = 'private'
const SIGHTING_VIS_PUBLIC = 'public'

/** 新猫占位名：按毛色/花纹生成，**不接受用户自定义文字**（合规要求）。
 *  正式名字由社团核实后统一分配（cat-entry / cat-edit 走管理员权限）。 */
const PATTERN_LABELS = {
  tabby: '狸花', orange: '橘猫', cow: '奶牛', tuxedo: '燕尾服', calico: '三花',
  tortoiseshell: '玳瑁', white: '纯白', black: '纯黑', gray: '灰蓝', siamese: '暹罗', other: ''
}

/**
 * 打卡可见性**策略**（合规 2026-10-16 二审）。
 *
 * ⚠️ 与上一版的区别：可见性**不再由普通用户按条选择**，改为**超级管理员在控制台统一配置**。
 *   原因：审核关注的是「功能是否提供公开发布能力」。把开关放在用户侧，等于产品**提供**了
 *   "一键公开到校园"的发布能力；放在管理端且**默认关闭**，产品形态就是
 *   「社团内部登记 + 管理员决定是否公示」—— 用户端没有任何"发布"入口。
 *
 *   策略存 schools 文档：`sightingPublic`（布尔，默认 false = 全部仅社团内部可见）。
 *   打卡记录落库时读取该校策略作为 `visibility`，用户无法自行覆盖。
 *
 *   历史数据：改造前用户自选的 visibility 保留原样（不追溯改写），
 *   新记录一律按策略生成。
 */
async function setSightingVisibilityPolicy(me, event) {
  requireSuper(me)
  const d = event.data || {}
  if (d.public === undefined || d.public === null) {
    // 查询当前策略
    const schoolId = resolveSchoolId(me, event)
    const s = schoolId ? await db.collection(COL.school).doc(schoolId).get().catch(() => null) : null
    return { ok: true, public: !!(s && s.data && s.data.sightingPublic) }
  }
  const schoolId = resolveSchoolId(me, event)
  if (!schoolId) throw new AppError('请先绑定校区')
  const next = d.public === true
  await db.collection(COL.school).doc(schoolId).update({
    data: { sightingPublic: next, updatedAt: new Date() }
  })
  return { ok: true, public: next }
}

/** 读取某校区的打卡可见性策略（无配置 / 读失败一律 false = 最保守） */
async function sightingPolicyPublic(schoolId) {
  if (!schoolId) return false
  try {
    const s = await db.collection(COL.school).doc(schoolId).get()
    return !!(s && s.data && s.data.sightingPublic === true)
  } catch (e) {
    return false
  }
}

async function addSighting(me, event) {
  const d = event.data || {}
  await sec.assertSightingSafe(d)

  const now = new Date()
  const photos = (d.photos || []).slice(0, 6)
  let schoolId = d.schoolId || me.schoolId || ''
  // 兜底：用户档案还没绑学校时，从**猫档案**反推归属。
  // 为什么必须补这一步（2026-10-25 实测）：sightings.schoolId 为空的记录，
  // 在所有按校过滤的查询里都会消失 —— 打卡列表、本月统计、地图点位全查不到它。
  // 打卡必然对应一只猫（或至少一位上报人），猫一定属于某所学校，
  // 所以这个归属是可靠的；拿不到才留空。
  if (!schoolId && d.catId) {
    const c = await db.collection(COL.cat).doc(d.catId).get().catch(() => null)
    if (c && c.data && c.data.schoolId) schoolId = c.data.schoolId
  }
  assertSchool(me, schoolId)

  // 首次遇见（图鉴解锁）判定：必须用「条件更新 catSeen」原子完成。
  // 旧写法读的是请求开始时的用户快照（me.catSeen）——两条并发打卡同猫都读不到
  // 对方刚 push 的 catId，会双双判定 firstMeet 各发 20 分（日上限只削峰值不防重复）。
  // 现在把标记提到发奖之前：updated===1 表示本次调用真正把它加进了图鉴，
  // 并发下只有一个请求能更新成功，天然幂等。
  let firstMeet = false
  if (d.catId) {
    const mark = await db.collection(COL.user)
      .where({ _id: me._id, catSeen: _.nin([d.catId]) })
      .update({ data: { catSeen: _.push([d.catId]) } })
    firstMeet = !!(mark && mark.stats && mark.stats.updated)
  }
  // 投喂状态：白名单校验，非法值 / 老客户端不传 → 回落「路过」
  const feedStatus = FEED_STATUS_VALUES.indexOf(d.feedStatus) >= 0 ? d.feedStatus : 'passed'
  const isFedByMe = feedStatus === 'fed'
  // 食物类型只影响**积分档位**（+2 ~ +5），不影响猫粮。
  // 白名单过滤而非直接取值：这是客户端可伪造的字段，不校验就能刷高积分。
  const foodType = FOOD_TYPE_VALUES.indexOf(d.foodType) >= 0 ? d.foodType : 'dry'

  // 行为标签：白名单过滤（合规改造，替代原自由文本「描述」）。
  // 只接受预设枚举内的值 —— 客户端若被篡改塞入任意字符串，这里直接丢掉。
  // 老客户端仍可能只传 note（自由文本），下面 note 统一截断到 20 字兜底。
  const behaviors = Array.isArray(d.behaviors)
    ? d.behaviors.filter(b => SIGHT_BEHAVIOR_VALUES.indexOf(b) >= 0).slice(0, 8)
    : []

  // 外观特征标签：同上白名单过滤（替代原自由文本「补充」）
  const features = Array.isArray(d.features)
    ? d.features.filter(f => SIGHT_FEATURE_VALUES.indexOf(f) >= 0).slice(0, 10)
    : []

  // 可见性：由**超级管理员在控制台配置的校区策略**决定，用户无法自行覆盖（合规二审）。
  // 默认 false = 全部记录仅社团内部可见；管理员打开后才公开到校园猫谱。
  // 老客户端若传 d.public 一律忽略 —— 公开与否不由打卡者决定。
  const visibility = (await sightingPolicyPublic(schoolId))
    ? SIGHTING_VIS_PUBLIC
    : SIGHTING_VIS_PRIVATE

  const doc = {
    catId: d.catId || '',
    // 新猫占位名由服务端按毛色生成（如「未命名·橘猫」）——不再接受 d.catName 自由文字。
    // 合规：用户无法通过"起名字"这条路径生成文字内容。
    catName: d.catId ? '' : '未命名' + (PATTERN_LABELS[d.pattern] ? '·' + PATTERN_LABELS[d.pattern] : '的新猫'),
    pending: !d.catId,
    location: d.location || null,
    locationName: d.locationName || '',
    photos,
    health: HEALTH_VALUES.indexOf(d.health) >= 0 ? d.health : 'unknown',
    feedStatus,
    // 仅「本人投喂」时有意义；其余状态统一记空，避免展示层出现无来源的食物类型
    foodType: isFedByMe ? foodType : '',
    behaviors,
    features,
    // 可见性：private = 仅本人 + 管理员可见；public = 公开到校园猫谱
    visibility,
    count: Number(d.count) || 1,
    schoolId,
    reporter: me.openid,
    reporterName: me.nickName || '',
    createdAt: now
  }

  // 先落库拿到 id，再发积分并挂上关联（流水记录表与 users 解耦）
  const add = await db.collection(COL.sighting).add({ data: doc })
  // ---- 发放（规则 V1.0：积分与猫粮是两套账，日上限各自独立）----
  // 每日打卡：两个币种各 +5
  const gDailyPoint = await points.grantPoint(me, 'daily', null, { refType: 'sighting', refId: add._id })
  const gDailyFood = await points.grantFood(me, 'daily', null, { refType: 'sighting', refId: add._id })
  // 投喂：按食物类型给积分 +2 ~ +5（仅「本人投喂」发放）
  const gFeed = isFedByMe
    ? await points.grantPoint(me, FOOD_TYPE_KIND[foodType], null, { refType: 'sighting', refId: add._id })
    : { gained: 0, capped: false }
  // 图鉴点亮新品种：每品种一次，+10 积分（旧版的 firstMeet）
  const gDex = firstMeet
    ? await points.grantPoint(me, 'dexNew', null, { refType: 'cat', refId: d.catId })
    : { gained: 0, capped: false }

  // 「上报新猫」不再单独发奖：规则里的激励口径是「建立档案」，
  // 而打卡上报只落一条 pending 记录，还没产生档案。真正的建档奖励在 saveCat。
  const pointTotal = (gDailyPoint.gained || 0) + (gFeed.gained || 0) + (gDex.gained || 0)
  // ⚠️ 升级奖励**不计入本条记录**。它是等级里程碑给的，不是这次打卡的产物；
  // 若计入，删掉打卡就会把这笔退掉，等于用「删记录」反复刷升级奖励。
  const foodTotal = gDailyFood.gained || 0

  await db.collection(COL.sighting).doc(add._id)
    .update({ data: { points: pointTotal, food: foodTotal } })
  doc.points = pointTotal
  doc.food = foodTotal

  // 图鉴标记已在发奖前条件更新完成，这里只累加打卡次数
  await db.collection(COL.user).doc(me._id).update({ data: { sightingCount: _.inc(1) } })

  if (d.catId) {
    const catPatch = { sightingCount: _.inc(1), lastSeenAt: now, lastSeenBy: me.nickName || '' }
    // 本人投喂：同步「最近投喂」，避免多人重复投喂同一处
    if (isFedByMe) {
      catPatch.lastFedAt = now
      catPatch.lastFedBy = me.nickName || ''
    }
    await db.collection(COL.cat).doc(d.catId).update({ data: catPatch }).catch(() => {})
  }

  return Object.assign({}, doc, {
    _id: add._id,
    pointsGained: pointTotal,
    foodGained: foodTotal,
    // 本次打卡让用户升了级（跨级时是最终等级），前端据此弹「升级啦」提示
    levelUp: gDailyPoint.levelUp || 0,
    firstMeet,
    feedStatus,
    foodType: isFedByMe ? foodType : '',
    feedGained: gFeed.gained || 0,
    // 明细以云端为准，前端不再自己算 —— 两边各写一套必然会算错
    pointsDetail: {
      daily: gDailyPoint.gained || 0,
      feed: gFeed.gained || 0,
      dexNew: gDex.gained || 0
    },
    foodDetail: {
      daily: gDailyFood.gained || 0
    },
    dailyCapped: !!(gDailyPoint.capped || gFeed.capped || gDex.capped || gDailyFood.capped),
    // 两套货币各自的当日累计，前端提示「今日还可获得 N」用
    pointsToday: gDailyPoint.today || 0,
    foodToday: gDailyFood.today || 0
  })
}

async function listSightings(me, event) {
  const schoolId = resolveSchoolId(me, event)
  assertSchool(me, schoolId)
  const where = {}
  if (schoolId) where.schoolId = schoolId
  if (event.catId) where.catId = event.catId
  if (event.pending) where.pending = true

  // 可见性过滤（合规 2026-10-16）：private 记录只有本人与管理员能看。
  //  - mine=true  → 只看自己的（不管可见性），用于「我的打卡」列表
  //  - 管理员/成员 → 全量可见（需要核实存档）
  //  - 其余访客   → 只看 visibility==='public' 的
  // 老数据没有 visibility 字段（改造前写入的）→ 视为 private，不对外可见。
  if (event.mine && me) {
    where.reporter = me.openid
  } else if (!isMember(me)) {
    where.visibility = SIGHTING_VIS_PUBLIC
  }

  const { page, size, skip } = pageOf(event, 20, 50)
  const res = await db.collection(COL.sighting)
    .where(where).orderBy('createdAt', 'desc').skip(skip).limit(size).get()

  const catIds = [...new Set(res.data.map(s => s.catId).filter(Boolean))]
  let catMap = {}
  if (catIds.length) {
    const cats = await db.collection(COL.cat).where({ _id: _.in(catIds) }).get()
    cats.data.forEach(c => { catMap[c._id] = { name: c.name, avatar: c.avatar } })
  }
  const list = res.data
    .map(s => sanitizeSighting(s, me))
    .filter(Boolean)
    .map(s => Object.assign(s, { cat: catMap[s.catId] || null }))
  // 目击照片换 https 临时链接：客户端读不到「别人上传的」私有文件，
  // 不换就会「自己发的图能看、别人发的图空白」。
  await maplib.attachSightingMediaUrls(list)
  return {
    list,
    hasMore: res.data.length === size,
    page
  }
}

/* ==================== 目击记录管理（修改/删除上传记录） ==================== */

// 超管可改/删任意记录；本人可改/删自己发布的记录
function assertSightingOwner(me, s) {
  if (!s) throw new AppError('记录不存在', 404)
  if (isSuper(me) || s.reporter === me.openid) return true
  throw new AppError('无权操作该记录', 403)
}

async function updateSighting(me, event) {
  if (!event.id) throw new AppError('缺少记录 ID')
  const res = await db.collection(COL.sighting).doc(event.id).get()
  assertSightingOwner(me, res.data)
  const d = event.data || {}
  const patch = { updatedAt: new Date(), updatedBy: me.openid }
  // ⚠️ 合规：**不接受任何自由文本**（原 d.note 分支已移除）。
  //    打卡页已无文字输入；这里若还开放 note 写入，等于给 UGC 文字留了一条后门。
  //    只允许结构化字段。
  if (d.health && HEALTH_VALUES.indexOf(d.health) >= 0) patch.health = d.health
  if (d.behaviors !== undefined) {
    patch.behaviors = Array.isArray(d.behaviors)
      ? d.behaviors.filter(b => SIGHT_BEHAVIOR_VALUES.indexOf(b) >= 0).slice(0, 8)
      : []
  }
  if (d.features !== undefined) {
    patch.features = Array.isArray(d.features)
      ? d.features.filter(f => SIGHT_FEATURE_VALUES.indexOf(f) >= 0).slice(0, 10)
      : []
  }
  // ⚠️ 可见性**不可由记录所有者修改**（合规二审）：公开与否由超管在控制台按校区统一配置，
  //    这里只接受超管显式改单条（应急下架/上架），普通用户传 d.public 一律忽略。
  if (d.public !== undefined && isSuper(me)) {
    patch.visibility = d.public === true ? SIGHTING_VIS_PUBLIC : SIGHTING_VIS_PRIVATE
  }
  if (typeof d.locationName === 'string') patch.locationName = d.locationName
  if (Number(d.count) > 0) patch.count = Number(d.count)
  await db.collection(COL.sighting).doc(event.id).update({ data: patch })
  return { ok: true }
}

async function deleteSighting(me, event) {
  if (!event.id) throw new AppError('缺少记录 ID')
  const res = await db.collection(COL.sighting).doc(event.id).get()
  assertSightingOwner(me, res.data)
  const s = res.data || {}
  // 删除记录**不退积分**（规则：积分只增不减）。
  // 早期实现会把这条记录发过的积分扣回去，等价于「删了重发就掉级」——
  // 用户为保等级只能留着错记录，反而让脏数据不敢删。
  // 改为只退猫粮：猫粮是可增减的流通货币，退回它既能让账实相符，又不触碰等级。
  // 老记录没有 food 字段（双货币拆分之前），猫粮部分自然跳过，计数照常回退。
  if (Number(s.food) > 0) {
    await points.refundFood(me, 'revoke', Number(s.food), { refType: 'sighting', refId: event.id })
      .catch(e => console.warn('[deleteSighting] 退回猫粮失败，已忽略', e && e.message))
  }
  // 打卡次数的回退对象是**记录作者**，不是操作者。
  // 原实现无条件给 `me` 减 1 —— 超管在后台删别人的记录时，扣的是超管自己的数，
  // 删两条就出现「打卡次数 -2」。只有作者确实是本人时才减本人。
  // 另外用 `sightingCount > 0` 做条件更新：并发/脏数据下永远减不到负数。
  const authorOpenid = s.reporter || ''
  if (authorOpenid) {
    let targetId = authorOpenid === me.openid ? me._id : ''
    if (!targetId) {
      const author = await findUserByOpenid(authorOpenid)
      // 找不到作者档案：这条记录本来就没计入任何人的数（历史/种子数据），谁都不减
      targetId = author ? author._id : ''
    }
    if (targetId) {
      await db.collection(COL.user)
        .where({ _id: targetId, sightingCount: _.gt(0) })
        .update({ data: { sightingCount: _.inc(-1) } })
        .catch(e => console.warn('[deleteSighting] 打卡次数回退失败，已忽略', e && e.message))
    }
  }
  await db.collection(COL.sighting).doc(event.id).remove()
  return { ok: true }
}

/* ==================== TNR 台账 ==================== */

async function listTnr(me, event) {
  const schoolId = resolveSchoolId(me, event)
  assertSchool(me, schoolId)
  const where = schoolId ? { schoolId } : {}
  if (event.status) where.status = event.status
  if (event.catId) where.catId = event.catId
  const res = await db.collection(COL.tnr)
    .where(where).orderBy('createdAt', 'desc').limit(100).get()

  const catIds = [...new Set(res.data.map(t => t.catId).filter(Boolean))]
  let catMap = {}
  if (catIds.length) {
    const cats = await db.collection(COL.cat).where({ _id: _.in(catIds) }).get()
    cats.data.forEach(c => { catMap[c._id] = { name: c.name, avatar: c.avatar, sterilized: c.sterilized } })
  }
  return {
    list: res.data.map(t => Object.assign({}, t, { cat: catMap[t.catId] || null })),
    flow: tnr.flowMeta()
  }
}

async function saveTnr(me, event) {
  const d = event.data || {}
  if (!d.catId && !(d.catName || '').trim()) throw new AppError('请选择或填写猫咪')

  const now = new Date()
  const to = d.status || 'todo'
  let from = ''

  if (d._id) {
    const prev = await db.collection(COL.tnr).doc(d._id).get()
    if (!prev.data) throw new AppError('记录不存在', 404)
    from = prev.data.status || 'todo'
  }
  // 状态机：非法流转直接拒绝（含「已放归 → 待抓捕」这类回跳）
  tnr.assertTransition(from, to)

  if (d.note) {
    const okText = await sec.checkText(d.note)
    if (!okText) throw new AppError('备注未通过安全检测')
  }

  const schoolId = d.schoolId || me.schoolId || ''
  assertSchool(me, schoolId)

  const payload = {
    catId: d.catId || '',
    catName: (d.catName || '').trim(),
    status: to,
    trapDate: d.trapDate || '',
    surgeryDate: d.surgeryDate || '',
    releaseDate: d.releaseDate || '',
    hospital: d.hospital || '',
    vet: d.vet || '',
    cost: Number(d.cost) || 0,
    earMark: d.earMark || '',
    operator: d.operator || me.nickName || '',
    note: d.note || '',
    schoolId,
    updatedBy: me.openid,
    updatedAt: now
  }
  tnr.autoDates(payload, from, to, now)

  const catPatch = tnr.catSyncPatch(to, payload.earMark)
  const isCreate = !d._id
  if (isCreate) {
    payload.createdAt = now
    payload.createdBy = me.openid
  }

  // 记录与猫档案在同一个事务里写，保证状态一致
  try {
    await db.runTransaction(async tx => {
      if (isCreate) {
        await tx.collection(COL.tnr).add({ data: payload })
      } else {
        await tx.collection(COL.tnr).doc(d._id).update({ data: payload })
      }
      if (payload.catId && catPatch) {
        await tx.collection(COL.cat).doc(payload.catId).update({ data: catPatch })
      }
    })
  } catch (e) {
    console.warn('[saveTnr] 事务失败，降级为分步写入', e && e.message)
    if (isCreate) {
      await db.collection(COL.tnr).add({ data: payload })
    } else {
      await db.collection(COL.tnr).doc(d._id).update({ data: payload })
    }
    if (payload.catId && catPatch) {
      await db.collection(COL.cat).doc(payload.catId).update({ data: catPatch }).catch(() => {})
    }
  }

  // TNR 是重投入行为（带猫去医院、术后护理），规则文档未列，沿用旧额度改为发猫粮：
  // 它更像「值得消费的服务额度」而不是经验值；且计入猫粮日上限，避免无限刷。
  if (isCreate) await points.grantFood(me, 'tnrHelp', null, { refType: 'tnr', refId: d._id || '' })

  return { ok: true, _id: d._id || '', status: to, catSynced: !!(payload.catId && catPatch) }
}

/* ==================== 任务排班 ==================== */

async function listTasks(me, event) {
  const schoolId = resolveSchoolId(me, event)
  assertSchool(me, schoolId)
  const where = schoolId ? { schoolId } : {}
  if (event.status) where.status = event.status
  if (event.mine && me) where.assignee = me.openid
  const res = await db.collection(COL.task)
    .where(where).orderBy('date', 'asc').limit(100).get()

  // 任务对所有人可见（便于认领），但联系方式仅成员可见
  return res.data.map(t => {
    const o = Object.assign({}, t)
    if (!isMember(me)) delete o.contact
    return o
  })
}

async function saveTask(me, event) {
  const d = event.data || {}
  if (!d.title) throw new AppError('请填写任务标题')
  const textOk = await sec.checkText([d.title, d.spot, d.note].filter(Boolean).join(' '))
  if (!textOk) throw new AppError('内容未通过安全检测')

  const now = new Date()
  const schoolId = d.schoolId || me.schoolId || ''
  assertSchool(me, schoolId)
  const payload = {
    title: d.title,
    type: d.type || 'feed',
    date: d.date || '',
    spot: d.spot || '',
    location: d.location || null,
    assignee: d.assignee || '',
    assigneeName: d.assigneeName || '',
    status: d.status || 'open',
    note: d.note || '',
    contact: d.contact || '',
    schoolId,
    updatedBy: me.openid,
    updatedAt: now
  }
  if (d._id) {
    await db.collection(COL.task).doc(d._id).update({ data: payload })
  } else {
    payload.createdAt = now
    payload.createdBy = me.openid
    await db.collection(COL.task).add({ data: payload })
  }
  return { ok: true, _id: d._id || '' }
}

async function claimTask(me, event) {
  if (!event.id) throw new AppError('缺少任务 ID')
  // 并发抢单防护：check-then-update 之间另一个用户的认领会落库、后写者静默覆盖。
  // 必须用「带条件的更新」——stats.updated === 0 说明条件已不满足（被抢/非本人）。
  const where = event.cancel
    ? { _id: event.id, assignee: me.openid }
    : { _id: event.id, status: 'open' }
  const upd = await db.collection(COL.task).where(where).update({
    data: {
      status: event.cancel ? 'open' : 'claimed',
      assignee: event.cancel ? '' : me.openid,
      assigneeName: event.cancel ? '' : (me.nickName || ''),
      updatedAt: new Date()
    }
  })
  if (!upd || !upd.stats || !upd.stats.updated) {
    throw new AppError(event.cancel ? '只能取消自己认领的任务' : '该任务已被认领', event.cancel ? 403 : 409)
  }
  return { ok: true }
}

/* ==================== 资金 ==================== */

async function listFunds(me, event) {
  const schoolId = resolveSchoolId(me, event)
  assertSchool(me, schoolId)
  const where = schoolId ? { schoolId } : {}
  if (event.type) where.type = event.type
  const res = await db.collection(COL.fund)
    .where(where).orderBy('date', 'desc').limit(200).get()
  const summary = await listFundSummary(schoolId)
  return { list: res.data, summary }
}

async function addFund(me, event) {
  const d = event.data || {}
  const amount = Number(d.amount)
  if (!amount) throw new AppError('请填写金额')
  if (!['income', 'expense'].includes(d.type)) throw new AppError('类型错误')
  const textOk = await sec.checkText(d.title || '')
  if (!textOk) throw new AppError('内容未通过安全检测')

  const schoolId = d.schoolId || me.schoolId || ''
  assertSchool(me, schoolId)
  const doc = {
    type: d.type,
    amount: Math.abs(amount),
    category: d.category || 'other',
    title: d.title || (d.type === 'income' ? '捐赠' : '支出'),
    date: d.date || new Date(),
    catId: d.catId || '',
    proof: d.proof || [],
    operator: me.nickName || '',
    schoolId,
    createdBy: me.openid,
    createdAt: new Date()
  }
  await db.collection(COL.fund).add({ data: doc })
  return { ok: true }
}

/* ==================== 成员 & 申请 ==================== */

async function listMembers(me, event) {
  const schoolId = resolveSchoolId(me, event)
  assertSchool(me, schoolId)
  const where = schoolId ? { schoolId } : {}
  const res = await db.collection(COL.user)
    .where(where).orderBy('createdAt', 'desc').limit(200).get()
  const list = res.data.map(u => ({
    _id: u._id,
    nickName: u.nickName,
    avatarUrl: u.avatarUrl,
    role: u.role,
    isSuper: isSuper({ openid: u.openid || u._openid }),
    points: u.points || 0,
    // 派生计数可能因历史 bug 为负（见 repairSightingCount），展示层一律夹到 ≥0
    sightingCount: Math.max(0, Number(u.sightingCount) || 0),
    lastSeenAt: u.lastSeenAt || null
  }))
  // 成员头像换 https：客户端读不到「别人上传的」私有文件，
  // 不换就会「自己的头像正常、其他成员都是一片空白」。
  const avatarIds = list.map(u => u.avatarUrl)
    .filter(v => typeof v === 'string' && v.indexOf('cloud://') === 0)
  const avatarMap = avatarIds.length ? await maplib.fetchTempUrls(avatarIds) : {}
  list.forEach(u => { if (avatarMap[u.avatarUrl]) u.avatarUrl = avatarMap[u.avatarUrl] })
  return list
}

async function setRole(me, event) {
  requireSuper(me)
  if (!['visitor', 'member', 'admin'].includes(event.role)) throw new AppError('角色非法')
  if (event.userId === me._id && event.role !== 'admin') {
    throw new AppError('不能降级自己（避免失去管理权限）')
  }
  // 禁止改动超级管理员身份（超管由 openid 决定，改名/改角色均无效）
  const target = await db.collection(COL.user).doc(event.userId).get()
  if (target.data && isSuper({ openid: target.data.openid || target.data._openid })) {
    throw new AppError('超级管理员身份不可更改', 403)
  }
  await db.collection(COL.user).doc(event.userId).update({
    data: { role: event.role, updatedAt: new Date(), schoolId: me.schoolId || '' }
  })
  return { ok: true }
}

/* ==================== 用户管理（超级管理员 · 全站） ==================== */

/**
 * 全站用户列表（**跨校区**，仅超管）。
 *
 * 与 `listMembers` 的区别必须说清楚，否则很容易被当成同一个接口乱用：
 *  - `listMembers`：**本校区**成员，普通管理员也能用（管理自己社团的人）；
 *  - `listUsersAdmin`：**全站**用户，只有超管能进。
 * 学校是数据隔离的支点，跨校区改角色若不收在超管手里，
 * A 校管理员就能把 B 校的人提成管理员，隔离直接失效。
 *
 * 搜索：昵称 / 账号 / 手机号前缀匹配（`db.RegExp`），量级几千也够用，不用全文索引。
 * 排序：先试 `orderBy`，失败（缺索引）就退化成内存排序 —— 云开发在 where + orderBy
 * 组合上没有复合索引时会直接报错，而用户列表是后台页面，不该因为索引缺失整个打不开。
 *
 * ⚠️ 全部脱敏下发：账号 / 手机号中段打码，绝不带 openid 与密码哈希。
 * 后台是为了「找人 + 配权限」，不是给超管一份完整通讯录。
 */
async function listUsersAdmin(me, event) {
  requireSuper(me)
  const kw = String((event && event.keyword) || '').trim()
  const role = String((event && event.role) || '').trim()
  const schoolId = String((event && event.schoolId) || '').trim()
  const size = Math.min(100, Math.max(1, Number((event && event.size)) || 50))

  // 条件拼装：多个条件用 _.and 组合，单个条件直接传对象（云开发不支持「对象 + 指令」混写）
  const parts = []
  if (role && ['visitor', 'member', 'admin'].indexOf(role) >= 0) {
    // 老数据把访客存成 role:'user'，筛「访客」时两种写法都得算上
    parts.push(role === 'visitor' ? _.or([{ role: 'visitor' }, { role: 'user' }]) : { role })
  }
  if (schoolId) parts.push({ schoolId })
  if (kw) {
    // ⚠️ 必须 escapeReg：昵称里带 `.` `(` `*` 时，不转义会让整条查询直接报错。
    const re = db.RegExp({ regexp: '^' + escapeReg(kw), options: 'i' })
    parts.push(_.or([{ nickName: re }, { account: re }, { phone: re }]))
  }
  const cond = parts.length === 0 ? {} : (parts.length === 1 ? parts[0] : _.and(parts))

  let list = []
  try {
    const res = await db.collection(COL.user)
      .where(cond).orderBy('createdAt', 'desc').limit(size).get()
    list = res.data || []
  } catch (e) {
    // 缺复合索引：去掉排序再查一次，改在内存里排（结果一样，只是多搬一次数据）
    const res = await db.collection(COL.user).where(cond).limit(size).get()
    list = (res.data || []).slice().sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return tb - ta
    })
  }

  // 校名：用户文档里只有 schoolId，展示「哪所学校的」要现查一次学校表。
  // 学校是几十所的量级，一次 limit(200) 建映射比逐条 get 划算（云函数 3s 预算红线）。
  const schoolIds = Array.from(new Set(list.map(u => u.schoolId).filter(Boolean)))
  let schoolMap = {}
  if (schoolIds.length) {
    try {
      const sr = await db.collection(COL.school).limit(200).get()
      ;(sr.data || []).forEach(s => {
        schoolMap[s._id] = s.campus ? (s.name + ' · ' + s.campus) : s.name
      })
    } catch (e) { schoolMap = {} }
  }

  // 历史数据里 role 可能是早期口径的 'user'（不是三档之一），统一归一到 visitor ——
  // 不归一的话这批人在「访客」筛选项里既看不见也改不了，后台会以为人丢了。
  const normRole = r => (r === 'user' ? 'visitor' : (r || 'visitor'))

  const users = list.map(u => {
    const sup = isSuper({ openid: u.openid || u._openid })
    return {
      _id: u._id,
      nickName: u.nickName || '',
      avatarUrl: u.avatarUrl || '',
      // 脱敏：账号 / 手机号只给中段打码后的样子
      accountMask: u.account ? maskContact(u.account) : '',
      phoneMask: u.phone ? maskContact(u.phone) : '',
      // 是否设置了账号密码 —— 后台要知道「这人能不能换设备登录」
      hasAccount: !!u.account,
      role: normRole(u.role),
      isSuper: sup,
      schoolId: u.schoolId || '',
      schoolName: schoolMap[u.schoolId] || '',
      points: Math.max(0, Number(u.points) || 0),
      sightingCount: Math.max(0, Number(u.sightingCount) || 0),
      createdAt: u.createdAt || null,
      lastSeenAt: u.lastSeenAt || null
    }
  })

  // 角色统计放在服务端算：WXML 里不能对数组做 filter/length。
  const roleCount = { admin: 0, member: 0, visitor: 0, super: 0 }
  users.forEach(u => {
    if (u.isSuper) roleCount.super += 1
    else if (roleCount[u.role] !== undefined) roleCount[u.role] += 1
  })

  return { list: users, total: users.length, roleCount, keyword: kw, role }
}

/**
 * 设置用户角色（**仅超管**）。与管理页面上的 `setRole`（本校区成员管理）分开，
 * 因为这是全站视角：只改 role，**绝不动 schoolId**。
 *
 * 为什么不能复用 setRole：它会把用户挪到「超管当前的学校」，
 * 在成员管理里那是对的（把人拉进本社团），在全站用户列表里就是顺手把人整份数据搬了家
 * —— 他原来学校的猫档案和打卡会一起看不见，而超管只是想给他换个权限。
 */
async function setUserRole(me, event) {
  requireSuper(me)
  const role = String((event && event.role) || '')
  if (['visitor', 'member', 'admin'].indexOf(role) < 0) throw new AppError('角色非法', 400)
  const userId = String((event && event.userId) || '').trim()
  if (!userId) throw new AppError('缺少用户 ID', 400)
  const target = await db.collection(COL.user).doc(userId).get()
  if (!target.data) throw new AppError('用户不存在', 404)
  if (isSuper({ openid: target.data.openid || target.data._openid })) {
    throw new AppError('超级管理员身份不可更改', 403)
  }
  if (userId === me._id && role !== 'admin') {
    throw new AppError('不能降级自己（避免失去管理权限）', 400)
  }
  await db.collection(COL.user).doc(userId).update({
    data: { role, updatedAt: new Date() }
  })
  return { ok: true, userId, role }
}

async function applyJoin(me, event) {
  if (isMember(me)) return { status: 'already' }
  const exist = await db.collection(COL.apply)
    .where({ openid: me.openid, status: 'pending' }).limit(1).get()
  if (exist.data.length) return { status: 'pending' }

  const textOk = await sec.checkText([event.reason, event.experience, event.contact].filter(Boolean).join(' '))
  if (!textOk) throw new AppError('内容未通过安全检测')

  await db.collection(COL.apply).add({
    data: {
      openid: me.openid,
      _openid: me.openid,
      nickName: event.nickName || me.nickName || '',
      contact: event.contact || '',
      reason: event.reason || '',
      experience: event.experience || '',
      schoolId: event.schoolId || me.schoolId || '',
      status: 'pending',
      createdAt: new Date()
    }
  })
  return { status: 'submitted' }
}

async function myApply(me, event) {
  // 非成员也能查到自己的入社申请：用于「成员与身份」页展示申请记录与状态，
  // 而不是每次都显示空白申请表单。返回本人最新一条（按创建时间倒序），没有则 null。
  const res = await db.collection(COL.apply)
    .where({ openid: me.openid })
    .orderBy('createdAt', 'desc').limit(1).get()
  return res.data[0] || null
}

async function listApplies(me, event) {
  const schoolId = resolveSchoolId(me, event)
  assertSchool(me, schoolId)
  const where = { status: event.status || 'pending' }
  if (schoolId) where.schoolId = schoolId
  const res = await db.collection(COL.apply)
    .where(where).orderBy('createdAt', 'desc').limit(100).get()
  return res.data
}

async function handleApply(me, event) {
  const apply = await db.collection(COL.apply).doc(event.id).get()
  if (!apply.data) throw new AppError('申请不存在', 404)
  const now = new Date()
  await db.collection(COL.apply).doc(event.id).update({
    data: { status: event.approve ? 'approved' : 'rejected', handler: me.nickName, handledAt: now }
  })
  if (event.approve) {
    const u = await findUserByOpenid(apply.data.openid)
    if (u) {
      await db.collection(COL.user).doc(u._id).update({
        data: { role: 'member', schoolId: apply.data.schoolId || me.schoolId || '' }
      })
    }
  }
  return { ok: true }
}
