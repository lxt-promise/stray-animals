/**
 * 猫粮值 / 积分值 —— 双货币账本（规则 V1.0）
 *
 * 两套账户，**不能用一个字段**：
 *
 * |          | 积分值 (point)        | 猫粮值 (food)              |
 * |----------|----------------------|---------------------------|
 * | 定位      | 经验 / 等级            | 流通货币                    |
 * | 变动      | 只增不减               | 可增可减（下限 0）           |
 * | 每日上限   | 150                   | 50（礼包/升级奖励不占）       |
 * | 用途      | 判等级                 | 识别服务等消费               |
 *
 * 为什么必须拆开：早期只有一个 `users.points`，前端叫「猫粮值」。
 * 一旦识别要扣费，这个数字就会**减少**，而它同时又是等级依据 ——
 * 用户花猫粮 = 掉等级，这是规则明确否定的（「消费不影响积分和等级」）。
 *
 * 并发安全：所有读写都在事务里「读 → 算额度 → 原子自增」，与旧版一致。
 * 事务不可用时降级为普通自增（宁可极小概率超发，也不能让打卡整体失败）。
 */
const { db, _, COL, dayKey, isSuper, AppError } = require('./core')
const level = require('./level')

const CURRENCY = { POINT: 'point', FOOD: 'food' }

/** 积分奖励表（只增不减）。键即流水 kind */
const POINT_AWARD = {
  daily: 5,          // 每日打卡
  feedDry: 2,        // 投喂干粮
  feedSnack: 3,      // 投喂零食 / 猫条
  feedWet: 4,        // 投喂罐头 / 湿粮
  feedHomemade: 5,   // 投喂自制餐
  dexNew: 10,        // 图鉴点亮新品种（每品种一次）
  confirm: 2         // 人工确认识别（人机协同，规则未列，作为小额补充）
}

/** 猫粮值奖励表（可增可减） */
const FOOD_AWARD = {
  daily: 5,             // 每日打卡（与积分同步领取）
  catCreate: 15,        // 建立档案（无照片）
  catCreatePhoto: 20,   // 建立档案（含照片，用于特征库）
  tnrHelp: 50,          // 参与 TNR
  gift: 50,             // 新手礼包（一次性）
  upgrade: level.REWARD_PER_LEVEL   // 升级奖励（每级）
}

/** 每日上限：两套货币各自独立计数 */
const POINT_CAP = 150
const FOOD_CAP = 50

/** 不受日上限约束：新手礼包与升级奖励是一次性/里程碑性质 */
const UNCAPPED = ['gift', 'upgrade']

/** 识别服务计费 */
const RECOGNIZE_COST = 20
const RECOGNIZE_DAILY = 10

/** 流水文案（同一 kind 在两个币种下含义可能不同，这里分开写） */
const REASON = {
  daily: '每日打卡',
  feedDry: '投喂干粮',
  feedSnack: '投喂零食',
  feedWet: '投喂罐头',
  feedHomemade: '投喂自制餐',
  dexNew: '图鉴点亮新品种',
  catCreate: '建立猫咪档案',
  catCreatePhoto: '建立猫咪档案（含照片）',
  tnrHelp: '参与 TNR',
  confirm: '人工确认识别',
  gift: '新手礼包',
  upgrade: '升级奖励',
  recognize: '猫咪识别服务',
  recognizeFree: '首次识别（免费）',
  revoke: '删除记录退回',
  adminGift: '超级管理员礼遇'
}

/** 超级管理员礼遇：一次性把账户置为满级账户 */
const ADMIN_FOOD = 500

const EMPTY = { gained: 0, today: 0, cap: 0, capped: false, levelUp: 0, foodGained: 0 }

function _tableOf(currency) {
  return currency === CURRENCY.POINT ? POINT_AWARD : FOOD_AWARD
}

function _caps(currency) {
  return currency === CURRENCY.POINT
    ? { cap: POINT_CAP, dayField: 'pointsDay', todayField: 'pointsToday', balanceField: 'points' }
    : { cap: FOOD_CAP, dayField: 'foodDay', todayField: 'foodToday', balanceField: 'food' }
}

function _ledger(txOrDb, row) {
  return txOrDb.collection(COL.point).add({
    data: Object.assign({
      currency: CURRENCY.POINT,
      refType: '',
      refId: '',
      createdAt: new Date()
    }, row)
  })
}

/**
 * 发放一种货币。
 *
 * @param {Object} user   用户档案（需含 _id）
 * @param {string} currency 'point' | 'food'
 * @param {string} kind   奖励表里的键
 * @param {number} [amount] 覆盖默认额度
 * @param {{refType?:string, refId?:string}} [ref]
 */
async function _grant(user, currency, kind, amount, ref) {
  const table = _tableOf(currency)
  const want = Math.floor(Number(amount != null ? amount : table[kind] || 0))
  if (!user || !user._id || !(want > 0)) return Object.assign({}, EMPTY)

  const today = dayKey()
  const { cap, dayField, todayField, balanceField } = _caps(currency)
  const uncapped = UNCAPPED.indexOf(kind) >= 0 || isSuper(user)
  const openid = user.openid || user._openid || ''

  const apply = async tx => {
    const doc = await tx.collection(COL.user).doc(user._id).get()
    const cur = doc.data || {}
    const used = cur[dayField] === today ? (Number(cur[todayField]) || 0) : 0
    const room = uncapped ? want : Math.max(0, cap - used)
    const gained = Math.min(want, room)
    if (gained <= 0) {
      return { gained: 0, today: used, cap, capped: true, levelUp: 0, foodGained: 0, currency }
    }

    const patch = {}
    const balance = (Number(cur[balanceField]) || 0) + gained
    let upFood = 0
    let levelUp = 0
    let foodLeft = Number(cur.food) || 0

    patch[balanceField] = _.inc(gained)
    patch[dayField] = today
    patch[todayField] = cur[dayField] === today ? _.inc(gained) : gained

    if (currency === CURRENCY.POINT) {
      // 等级按**历史最高积分**判，只升不降（见 lib/level.js 顶部说明）
      const peak = Math.max(Number(cur.peakPoints) || 0, balance)
      const oldLv = Number(cur.level) || level.levelOf(Number(cur.points) || 0).lv
      const newLv = level.levelOf(peak).lv
      patch.peakPoints = peak
      if (newLv !== Number(cur.level)) patch.level = newLv
      upFood = level.upgradeReward(oldLv, newLv)
      if (upFood > 0) {
        levelUp = newLv
        foodLeft += upFood
        patch.food = _.inc(upFood)
      }
    }

    await tx.collection(COL.user).doc(user._id).update({ data: patch })

    await _ledger(tx, {
      openid,
      userId: user._id,
      currency,
      kind,
      reason: REASON[kind] || kind,
      delta: gained,
      balance,
      refType: (ref && ref.refType) || '',
      refId: (ref && ref.refId) || ''
    })

    // 升级奖励单独记一条流水：它不属于本次发放的 kind，
    // 混进同一条会让「这条 +50 到底是打卡还是升级」无从区分。
    if (upFood > 0) {
      await _ledger(tx, {
        openid,
        userId: user._id,
        currency: CURRENCY.FOOD,
        kind: 'upgrade',
        reason: REASON.upgrade,
        delta: upFood,
        balance: foodLeft,
        refType: 'level',
        refId: String(levelUp)
      })
    }

    return {
      gained, today: used + gained, cap, capped: gained < want,
      levelUp, foodGained: upFood, currency
    }
  }

  try {
    return await db.runTransaction(apply)
  } catch (e) {
    console.warn('[points] 事务失败，降级为普通自增', e && e.message)
    // 降级路径不能拿到事务对象，直接对 db 执行同一套逻辑
    const doc = await db.collection(COL.user).doc(user._id).get()
    const cur = doc.data || {}
    const used = cur[dayField] === today ? (Number(cur[todayField]) || 0) : 0
    const room = uncapped ? want : Math.max(0, cap - used)
    const gained = Math.min(want, room)
    if (gained <= 0) return Object.assign({}, EMPTY, { today: used, cap, capped: true, currency, degraded: true })

    const patch = {}
    const balance = (Number(cur[balanceField]) || 0) + gained
    let upFood = 0
    let levelUp = 0
    let foodLeft = Number(cur.food) || 0
    patch[balanceField] = _.inc(gained)
    patch[dayField] = today
    patch[todayField] = cur[dayField] === today ? _.inc(gained) : gained
    if (currency === CURRENCY.POINT) {
      const peak = Math.max(Number(cur.peakPoints) || 0, balance)
      const oldLv = Number(cur.level) || level.levelOf(Number(cur.points) || 0).lv
      const newLv = level.levelOf(peak).lv
      patch.peakPoints = peak
      if (newLv !== Number(cur.level)) patch.level = newLv
      upFood = level.upgradeReward(oldLv, newLv)
      if (upFood > 0) {
        levelUp = newLv
        foodLeft += upFood
        patch.food = _.inc(upFood)
      }
    }
    await db.collection(COL.user).doc(user._id).update({ data: patch })
    await _ledger(db, {
      openid, userId: user._id, currency, kind,
      reason: REASON[kind] || kind, delta: gained, balance,
      refType: (ref && ref.refType) || '', refId: (ref && ref.refId) || ''
    })
    if (upFood > 0) {
      await _ledger(db, {
        openid, userId: user._id, currency: CURRENCY.FOOD, kind: 'upgrade',
        reason: REASON.upgrade, delta: upFood, balance: foodLeft,
        refType: 'level', refId: String(levelUp)
      })
    }
    return {
      gained, today: used + gained, cap, capped: gained < want,
      levelUp, foodGained: upFood, currency, degraded: true
    }
  }
}

/** 发积分（只增不减，日上限 150） */
function grantPoint(user, kind, amount, ref) {
  return _grant(user, CURRENCY.POINT, kind, amount, ref)
}

/** 发猫粮值（日上限 50，礼包/升级奖励不受限） */
function grantFood(user, kind, amount, ref) {
  return _grant(user, CURRENCY.FOOD, kind, amount, ref)
}

/**
 * 超管豁免记账：**余额一分不动**，只留一条 delta=0 的流水。
 *
 * 为什么不干脆连流水都不写：猫粮值是审计信息，超管哪天用了什么功能应该查得到；
 * delta=0 既如实（没花钱）又不污染余额，也不会占任何日上限。
 *
 * 为什么不复用 spendFood 的扣减路径：那条路径在余额不足时抛 402，
 * 而豁免的意义正是「余额 0 也能用」—— 校验必须放在扣减之前。
 *
 * 余额以**重新读一次用户档案**为准：入参里的 user.food 是登录时的快照，
 * 直接写进流水的 balance 字段会让账本对不上。
 */
async function _waiveFood(user, kind, ref) {
  const openid = user.openid || user._openid || ''
  let balance = Number(user.food) || 0
  try {
    const doc = await db.collection(COL.user).doc(user._id).get()
    balance = Number((doc.data || {}).food) || 0
  } catch (e) {
    console.warn('[points] 豁免记账时读取余额失败，流水用快照值', e && e.message)
  }
  await _ledger(db, {
    openid, userId: user._id, currency: CURRENCY.FOOD, kind,
    reason: (REASON[kind] || kind) + '·超管免消耗',
    delta: 0, balance,
    refType: (ref && ref.refType) || '', refId: (ref && ref.refId) || ''
  }).catch(e => console.warn('[points] 超管豁免流水写入失败', e && e.message))
  return balance
}

/**
 * 扣猫粮值。
 *
 * 余额不足**抛错而不是扣成负数**：规则要求下限 0。
 * 前端应先用 summary 判断按钮是否置灰，这里是最后一道防线
 * （并发下两个人同时花掉最后一笔时只有一笔能成功）。
 *
 * **超管不消耗猫粮**（2026-10-24 用户需求）：豁免判断必须放在余额校验**之前**，
 * 否则「余额不足」照样把超管拦下，「任何功能都不消耗」就成了空话。
 */
async function spendFood(user, kind, amount, ref) {
  const want = Math.floor(Number(amount) || 0)
  if (!user || !user._id || !(want > 0)) return { spent: 0, balance: Number(user && user.food) || 0 }
  if (isSuper(user)) {
    const balance = await _waiveFood(user, kind, ref)
    return { spent: 0, waived: true, balance }
  }
  const openid = user.openid || user._openid || ''

  return db.runTransaction(async tx => {
    const doc = await tx.collection(COL.user).doc(user._id).get()
    const cur = doc.data || {}
    const food = Number(cur.food) || 0
    if (food < want) {
      throw new AppError('猫粮值不足（需要 ' + want + '，当前 ' + food + '）', 402)
    }
    const next = food - want
    await tx.collection(COL.user).doc(user._id).update({ data: { food: next } })
    await _ledger(tx, {
      openid, userId: user._id, currency: CURRENCY.FOOD, kind,
      reason: REASON[kind] || kind, delta: -want, balance: next,
      refType: (ref && ref.refType) || '', refId: (ref && ref.refId) || ''
    })
    return { spent: want, balance: next }
  })
}

/**
 * 识别服务计费：首次免费 → 之后 20 猫粮/次，每日最多 10 次。
 *
 * 顺序上有意「先判次数、再判余额」：次数用完时提示「今天次数用完」，
 * 比提示「猫粮不足」更贴近用户实际处境（他可能有很多猫粮但刷到上限了）。
 *
 * **超管既不计费也不计次**：次数上限存在的唯一意义是防刷猫粮，
 * 超管已经不消耗猫粮，再用它拦住超管只会让验收/演示反复卡住。
 * 豁免要在两个校验之前返回。
 */
async function chargeRecognize(user, ref) {
  const today = dayKey()
  const openid = user.openid || user._openid || ''

  if (isSuper(user)) {
    const balance = await _waiveFood(user, 'recognizeFree', ref)
    return {
      cost: 0, free: true, waived: true, balance,
      used: 0, left: RECOGNIZE_DAILY, limit: RECOGNIZE_DAILY
    }
  }

  return db.runTransaction(async tx => {
    const doc = await tx.collection(COL.user).doc(user._id).get()
    const cur = doc.data || {}
    const used = cur.recognizeDay === today ? (Number(cur.recognizeToday) || 0) : 0

    if (used >= RECOGNIZE_DAILY) {
      throw new AppError('今天已经识别 ' + RECOGNIZE_DAILY + ' 次，明天再来吧', 429)
    }

    const free = !cur.freeRecognizeAt
    const cost = free ? 0 : RECOGNIZE_COST
    const food = Number(cur.food) || 0
    if (cost > food) {
      throw new AppError('猫粮值不足（识别需 ' + cost + '，当前 ' + food + '）', 402)
    }

    const next = food - cost
    const patch = { food: next, recognizeDay: today, recognizeToday: used + 1 }
    if (free) patch.freeRecognizeAt = new Date()

    await tx.collection(COL.user).doc(user._id).update({ data: patch })
    await _ledger(tx, {
      openid, userId: user._id, currency: CURRENCY.FOOD,
      kind: free ? 'recognizeFree' : 'recognize',
      reason: REASON[free ? 'recognizeFree' : 'recognize'],
      // 免费时写 0 而不是 -0：`-0` 在 JSON 里会被序列化成 0，
      // 但在内存比较（以及某些统计脚本）里 `-0 !== 0`，是个没必要的坑。
      delta: free ? 0 : -cost, balance: next,
      refType: (ref && ref.refType) || 'ai_task', refId: (ref && ref.refId) || ''
    })

    return {
      cost, free, balance: next,
      used: used + 1, left: RECOGNIZE_DAILY - used - 1, limit: RECOGNIZE_DAILY
    }
  })
}

/**
 * 撤销一笔猫粮（删除打卡时退钱）。
 *
 * 两条与普通发放不同的规则：
 *  ① **只退猫粮、不退积分**。规则写明「积分只增不减」，若删记录也扣积分，
 *     用户会因为「发现记错了想删掉重发」而掉级，与规则直接冲突。
 *  ② **不占每日上限**。这笔额度在当初获得时就已经计入过当日额度了，
 *     若退回时再算一次「获取」，会出现「删了记录反而把当天额度吃满」的荒谬结果。
 */
async function refundFood(user, kind, amount, ref) {
  const want = Math.floor(Number(amount) || 0)
  if (!user || !user._id || !(want > 0)) return { gained: 0, balance: Number(user && user.food) || 0 }
  const openid = user.openid || user._openid || ''

  return db.runTransaction(async tx => {
    const doc = await tx.collection(COL.user).doc(user._id).get()
    const cur = doc.data || {}
    const next = (Number(cur.food) || 0) + want
    await tx.collection(COL.user).doc(user._id).update({ data: { food: next } })
    await _ledger(tx, {
      openid, userId: user._id, currency: CURRENCY.FOOD, kind,
      reason: REASON[kind] || kind, delta: want, balance: next,
      refType: (ref && ref.refType) || '', refId: (ref && ref.refId) || ''
    })
    return { gained: want, balance: next }
  })
}

/** 账户概览（「我的」页 / 识别页都用它） */
async function summary(user) {
  const today = dayKey()
  // 超管免消耗标记：前端拿它决定「要不要按余额/次数拦人」。
  // 必须由云端下发，前端无从判断（isSuper 依赖环境变量里的 openid 白名单）。
  const waived = isSuper(user)
  if (!user || !user._id) {
    return {
      points: 0, food: 0, level: level.levelOf(0),
      today: { point: 0, pointCap: POINT_CAP, food: 0, foodCap: FOOD_CAP },
      recognize: {
        used: 0, limit: RECOGNIZE_DAILY, left: RECOGNIZE_DAILY,
        cost: RECOGNIZE_COST, free: true, waived: false
      },
      waived: false,
      cap: POINT_CAP, giftClaimed: false
    }
  }
  const doc = await db.collection(COL.user).doc(user._id).get()
  const cur = doc.data || {}
  const points = Number(cur.points) || 0
  const peak = Math.max(Number(cur.peakPoints) || 0, points)
  const pointToday = cur.pointsDay === today ? (Number(cur.pointsToday) || 0) : 0
  const foodToday = cur.foodDay === today ? (Number(cur.foodToday) || 0) : 0
  const recUsed = cur.recognizeDay === today ? (Number(cur.recognizeToday) || 0) : 0

  return {
    points,
    peakPoints: peak,
    food: Number(cur.food) || 0,
    waived,
    level: level.levelOf(peak),
    today: {
      point: pointToday, pointCap: POINT_CAP,
      food: foodToday, foodCap: FOOD_CAP
    },
    recognize: {
      used: recUsed,
      limit: RECOGNIZE_DAILY,
      left: Math.max(0, RECOGNIZE_DAILY - recUsed),
      cost: RECOGNIZE_COST,
      free: waived || !cur.freeRecognizeAt,
      waived
    },
    // 兼容旧前端字段（老版本「我的」页读 points/today/cap）
    cap: POINT_CAP,
    giftClaimed: !!cur.giftAt
  }
}

/** 流水，按时间倒序；可按 kind / currency 过滤 */
async function history(openid, event) {
  // size 可能为负/0/NaN：Number(-5) || 20 会保留 -5（truthy），
  // Math.min(-5, 100) = -5 直接进 limit() 抛错——必须双向夹紧
  const size = Math.max(1, Math.min(Number(event && event.size) || 30, 100))
  const where = {}
  if (openid) where.openid = openid
  if (event && event.kind) where.kind = event.kind
  if (event && (event.currency === CURRENCY.POINT || event.currency === CURRENCY.FOOD)) {
    where.currency = event.currency
  }
  const res = await db.collection(COL.point)
    .where(where).orderBy('createdAt', 'desc').limit(size).get()
  // 老流水没有 currency 字段（双货币拆分之前只有一套），按积分归档，
  // 否则前端拿到 undefined 会渲染成空白标签。
  return (res.data || []).map(r => Object.assign({}, r, { currency: r.currency || CURRENCY.POINT }))
}

/** 新手礼包：一次性，登录时若未领过则补发 */
async function claimGift(user) {
  if (!user || !user._id) return { gained: 0, food: 0, claimed: false }
  const doc = await db.collection(COL.user).doc(user._id).get()
  const cur = doc.data || {}
  if (cur.giftAt) return { gained: 0, food: Number(cur.food) || 0, claimed: false }
  // 条件更新抢占：只在「还没领过」时写 giftAt，避免并发登录重复发礼包。
  // 条件同时接受「字段不存在」和「字段为 null」—— 早期版本可能写过 null，
  // 只判 exists(false) 会让这批用户的礼包永远发不出去（静默失败）。
  const up = await db.collection(COL.user)
    .where(_.or([
      { _id: user._id, giftAt: _.exists(false) },
      { _id: user._id, giftAt: null }
    ]))
    .update({ data: { giftAt: new Date() } })
  const won = up && up.stats && up.stats.updated > 0
  if (!won) return { gained: 0, food: Number(cur.food) || 0, claimed: false }
  const g = await grantFood(user, 'gift', null, { refType: 'gift', refId: 'newbie' })
  return { gained: g.gained, food: (Number(cur.food) || 0) + g.gained, claimed: g.gained > 0 }
}

/**
 * 超级管理员礼遇：积分直接给到最高等级，猫粮值一次性补到 500。
 *
 * 为什么用「一次性 + 标记位」而不是每次登录都刷成 500：
 *  ① 每次登录都刷 = 花掉的猫粮下次进来又满，账本与流水对不上，
 *     而且「识别 10 次/天」的限制对超管形同虚设，测试时反而看不出真实体验；
 *  ② 一次性写 `adminGrantAt` 后，这笔钱和普通猫粮一样会被消费掉，行为可预期；
 *  ③ 标记位同时是并发锁（条件更新抢占），两个端同时登录只会有一次生效。
 *
 * 只在 `points` 上「取 max」而不是直接覆盖：超管自己打卡攒的分不该被抹掉。
 * 失败一律返回 `applied:false` 而不是抛错 —— 这是登录链路上的附加权益，
 * 发不出去最多是下次登录再补，登录失败才是灾难。
 *
 * @param {Object} user 用户档案（需含 _id 与 openid）
 * @returns {Promise<{applied:boolean, points?:number, food?:number, level?:number}>}
 */
async function grantAdminPrivilege(user) {
  if (!user || !user._id || !isSuper(user)) return { applied: false }
  const top = level.LEVELS[level.LEVELS.length - 1]
  try {
    const doc = await db.collection(COL.user).doc(user._id).get()
    const cur = doc.data || {}
    const curPoints = Number(cur.points) || 0
    const curFood = Number(cur.food) || 0
    if (cur.adminGrantAt) {
      return { applied: false, points: curPoints, food: curFood, level: Number(cur.level) || top.lv }
    }

    const nextPoints = Math.max(curPoints, top.min)
    const nextFood = Math.max(curFood, ADMIN_FOOD)

    // 条件更新抢占：`adminGrantAt` 不存在（或历史脏数据写成 null）才算「没领过」。
    // 只判 exists(false) 会让写过 null 的账号永远领不到 —— 与 claimGift 同一个坑。
    const up = await db.collection(COL.user)
      .where(_.or([
        { _id: user._id, adminGrantAt: _.exists(false) },
        { _id: user._id, adminGrantAt: null }
      ]))
      .update({
        data: {
          adminGrantAt: new Date(),
          points: nextPoints,
          peakPoints: Math.max(Number(cur.peakPoints) || 0, nextPoints),
          level: top.lv,
          food: nextFood
        }
      })
    const won = up && up.stats && up.stats.updated > 0
    if (!won) return { applied: false, points: curPoints, food: curFood }

    // 流水是「审计信息」，写失败不影响账户已经到位的权益
    const openid = user.openid || user._openid || ''
    if (nextPoints > curPoints) {
      await _ledger(db, {
        openid, userId: user._id, currency: CURRENCY.POINT, kind: 'adminGift',
        reason: REASON.adminGift, delta: nextPoints - curPoints, balance: nextPoints,
        refType: 'admin', refId: 'bootstrap'
      }).catch(e => console.warn('[points] 超管礼遇积分流水写入失败', e && e.message))
    }
    if (nextFood > curFood) {
      await _ledger(db, {
        openid, userId: user._id, currency: CURRENCY.FOOD, kind: 'adminGift',
        reason: REASON.adminGift, delta: nextFood - curFood, balance: nextFood,
        refType: 'admin', refId: 'bootstrap'
      }).catch(e => console.warn('[points] 超管礼遇猫粮流水写入失败', e && e.message))
    }
    return { applied: true, points: nextPoints, food: nextFood, level: top.lv }
  } catch (e) {
    console.warn('[points] 超管礼遇发放失败，已忽略', e && e.message)
    return { applied: false }
  }
}

module.exports = {
  CURRENCY, POINT_AWARD, FOOD_AWARD, POINT_CAP, FOOD_CAP,
  RECOGNIZE_COST, RECOGNIZE_DAILY, REASON, ADMIN_FOOD,
  grantPoint, grantFood, spendFood, chargeRecognize, refundFood,
  summary, history, claimGift, grantAdminPrivilege
}
