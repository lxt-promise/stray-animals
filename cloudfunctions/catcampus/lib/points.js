/**
 * 猫粮值（积分）发放 —— 难点 4「并发超发」
 *
 * 关键设计：
 *  1. 每日上限不再靠「先查打卡次数再算」——那是典型的 read-modify-write 竞态；
 *  2. 改为在用户档案上维护 pointsDay / pointsToday 两个字段，
 *     放进数据库事务里「读用户 → 算额度 → 原子自增」，并发下不会超发；
 *  3. 事务不可用时降级为普通原子自增（_.inc 本身是原子的，
 *     仅日上限在极端并发下可能略超，业务可接受）。
 */
const { db, _, COL, dayKey } = require('./core')

/** 单次奖励额度 */
const AWARD = {
  sighting: 10,      // 目击打卡
  newCat: 30,        // 上报新猫
  firstMeet: 20,     // 首次遇见某只猫（图鉴解锁）
  tnrHelp: 50,       // 参与 TNR
  confirm: 5         // 人工确认一次识别结果（人机协同）
}

/** 每日积分上限 */
const DAILY_CAP = 60

/** 不受日上限约束的类型：TNR 是重投入行为，不该被打卡上限挤掉 */
const UNCAPPED = ['tnrHelp']

/**
 * 发放积分
 * @param {Object} user  用户档案（必须含 _id）
 * @param {string} kind  AWARD 的键
 * @param {number} [amount] 覆盖默认额度
 * @returns {Promise<{gained:number, today:number, capped:boolean}>}
 */
async function grant(user, kind, amount) {
  const want = Number(amount != null ? amount : AWARD[kind] || 0)
  if (!user || !user._id || want <= 0) return { gained: 0, today: 0, capped: false }

  const today = dayKey()
  const uncapped = UNCAPPED.indexOf(kind) >= 0

  try {
    return await db.runTransaction(async tx => {
      // 事务内要求：所有读操作先于写操作
      const doc = await tx.collection(COL.user).doc(user._id).get()
      const cur = doc.data || {}
      const used = cur.pointsDay === today ? (Number(cur.pointsToday) || 0) : 0
      const room = uncapped ? want : Math.max(0, DAILY_CAP - used)
      const gained = Math.min(want, room)
      await tx.collection(COL.user).doc(user._id).update({
        data: {
          points: _.inc(gained),
          pointsDay: today,
          pointsToday: cur.pointsDay === today ? _.inc(gained) : gained
        }
      })
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
    await db.collection(COL.user).doc(user._id).update({
      data: {
        points: _.inc(gained),
        pointsDay: today,
        pointsToday: cur.pointsDay === today ? _.inc(gained) : gained
      }
    })
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

module.exports = { grant, summary, AWARD, DAILY_CAP }
