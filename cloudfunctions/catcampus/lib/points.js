/**
 * 猫粮值（积分）发放 —— 难点 4「并发超发」
 *
 * 设计：
 *  1. 每日上限在数据库事务里「读用户 → 算额度 → 原子自增」，并发下不会超发；
 *  2. 每次发放同时写入独立的 points（猫粮流水）集合，作为可追溯的记录表，
 *     与 users 表解耦；users.points 仅保留为展示用的余额缓存（同事务内更新）。
 */
const { db, _, COL, dayKey, isSuper } = require('./core')

/** 单次奖励额度 */
const AWARD = {
  sighting: 10,      // 目击打卡
  newCat: 30,        // 上报新猫
  firstMeet: 20,     // 首次遇见某只猫（图鉴解锁）
  tnrHelp: 50,       // 参与 TNR
  feed: 10,          // 本人投喂（打卡时选择了「本人投喂」）
  feedPhoto: 15,     // 本人投喂且上传照片（照片是投喂佐证，防刷）
  confirm: 5         // 人工确认一次识别结果（人机协同）
}

/** 每日积分上限 */
const DAILY_CAP = 60

/** 不受日上限约束的类型：TNR 是重投入行为，不该被打卡上限挤掉 */
const UNCAPPED = ['tnrHelp']

/** 奖励文案（流水里展示用） */
const REASON = {
  sighting: '目击打卡',
  newCat: '上报新猫',
  firstMeet: '首次遇见（图鉴解锁）',
  tnrHelp: '参与 TNR',
  feed: '本人投喂',
  feedPhoto: '投喂照片记录',
  confirm: '人工确认识别',
  revoke: '删除目击记录退回'
}

/**
 * 发放积分
 * @param {Object} user  用户档案（必须含 _id）
 * @param {string} kind  AWARD 的键
 * @param {number} [amount] 覆盖默认额度
 * @param {{refType?:string, refId?:string}} [ref] 关联业务（打卡/TNR/识别任务等）
 * @returns {Promise<{gained:number, today:number, capped:boolean}>}
 */
async function grant(user, kind, amount, ref) {
  const want = Number(amount != null ? amount : AWARD[kind] || 0)
  if (!user || !user._id || want <= 0) return { gained: 0, today: 0, capped: false }

  const today = dayKey()
  // 超级管理员不受日上限约束（便于测试与运营）；TNR 是重投入行为也不受限
  const uncapped = UNCAPPED.indexOf(kind) >= 0 || isSuper(user)
  const openid = user.openid || user._openid || ''

  const writeLedger = (txOrDb, cur, gained) => {
    const balance = (Number(cur.points) || 0) + gained
    const row = {
      openid,
      userId: user._id,
      kind,
      reason: REASON[kind] || kind,
      delta: gained,
      balance,
      refType: (ref && ref.refType) || '',
      refId: (ref && ref.refId) || '',
      createdAt: new Date()
    }
    return txOrDb.collection(COL.point).add({ data: row })
  }

  try {
    return await db.runTransaction(async tx => {
      // 事务内要求：所有读操作先于写操作
      const doc = await tx.collection(COL.user).doc(user._id).get()
      const cur = doc.data || {}
      const used = cur.pointsDay === today ? (Number(cur.pointsToday) || 0) : 0
      const room = uncapped ? want : Math.max(0, DAILY_CAP - used)
      const gained = Math.min(want, room)
      if (gained > 0) {
        await tx.collection(COL.user).doc(user._id).update({
          data: {
            points: _.inc(gained),
            pointsDay: today,
            pointsToday: cur.pointsDay === today ? _.inc(gained) : gained
          }
        })
        await writeLedger(tx, cur, gained)
      }
      return { gained, today: used + gained, capped: gained < want }
    })
  } catch (e) {
    console.warn('[points] 事务失败，降级为普通自增', e && e.message)
    // 降级：至少保证 points 自增是原子的
    const doc = await db.collection(COL.user).doc(user._id).get()
    const cur = doc.data || {}
    const used = cur.pointsDay === today ? (Number(cur.pointsToday) || 0) : 0
    const room = uncapped ? want : Math.max(0, DAILY_CAP - used)
    const gained = Math.min(want, room)
    if (gained > 0) {
      await db.collection(COL.user).doc(user._id).update({
        data: {
          points: _.inc(gained),
          pointsDay: today,
          pointsToday: cur.pointsDay === today ? _.inc(gained) : gained
        }
      })
      await writeLedger(db, cur, gained)
    }
    return { gained, today: used + gained, capped: gained < want, degraded: true }
  }
}

/** 用户当前积分概览（供「我的」页展示，含今日进度） */
async function summary(user) {
  if (!user || !user._id) return { points: 0, today: 0, cap: DAILY_CAP }
  const today = dayKey()
  const doc = await db.collection(COL.user).doc(user._id).get()
  const cur = doc.data || {}
  return {
    points: Number(cur.points) || 0,
    today: cur.pointsDay === today ? (Number(cur.pointsToday) || 0) : 0,
    cap: DAILY_CAP
  }
}

/** 猫粮流水（记录表），按时间倒序；可按 kind 过滤 */
async function history(openid, event) {
  // size 可能为负/0/NaN：Number(-5) || 20 会保留 -5（truthy），
  // Math.min(-5, 100) = -5 直接进 limit() 抛错——必须双向夹紧
  const size = Math.max(1, Math.min(Number(event && event.size) || 20, 100))
  const where = {}
  if (openid) where.openid = openid
  if (event && event.kind) where.kind = event.kind
  const res = await db.collection(COL.point)
    .where(where).orderBy('createdAt', 'desc').limit(size).get()
  return res.data
}

module.exports = { grant, summary, history, AWARD, DAILY_CAP }
