/**
 * 等级体系（规则 V1.0）
 *
 * 要点：
 *  1. **按历史最高积分**判定，只升不降 —— 唯一依据是 `users.peakPoints`。
 *     为什么不能直接用 `users.points`：积分虽然设计成只增不减，但删除打卡、
 *     管理员调账这类路径仍可能让它下降；用当前值判级会出现「掉级」，
 *     而规则明确写了不掉级，所以把「历史最高」单独记一个字段。
 *  2. 区间取 **左闭右开** `[min, 下一档 min)`。规则表里 0–100 与 100–500 共享 100，
 *     若按闭区间判，100 分同时属于 Lv.1 和 Lv.2 —— 取靠后的那档更符合直觉
 *     （刚到 100 就升 Lv.2）。
 *  3. 满级（Lv.6）之后进度条恒满，不再显示「还差 N 分」。
 */

/** 等级表，顺序即等级顺序。改这里就等于改规则，前端 const.js 的 LEVELS 需同步 */
const LEVELS = [
  { lv: 1, name: '猫语新手', min: 0 },
  { lv: 2, name: '爱猫人士', min: 100 },
  { lv: 3, name: '猫界达人', min: 500 },
  { lv: 4, name: '资深铲屎官', min: 1000 },
  { lv: 5, name: '喵星守护者', min: 3000 },
  { lv: 6, name: '传奇喵侠', min: 5000 }
]

/** 每升一级发多少猫粮值（规则：+50/级，不占每日上限） */
const REWARD_PER_LEVEL = 50

/**
 * 按积分算等级详情。
 * @param {number} points 积分（判级时请传 peakPoints）
 * @returns {{lv:number,name:string,min:number,nextLv:number,nextName:string,
 *            nextMin:number,toNext:number,progress:number,maxed:boolean}}
 */
function levelOf(points) {
  const p = Math.max(0, Number(points) || 0)
  let idx = 0
  for (let i = 0; i < LEVELS.length; i++) {
    if (p >= LEVELS[i].min) idx = i
  }
  const cur = LEVELS[idx]
  const nxt = LEVELS[idx + 1] || null
  const maxed = !nxt
  // 进度按「本档到下一档」的跨度算。满级时恒 100，避免除零。
  const span = maxed ? 1 : Math.max(1, nxt.min - cur.min)
  const progress = maxed
    ? 100
    : Math.max(0, Math.min(100, Math.round(((p - cur.min) / span) * 100)))
  return {
    lv: cur.lv,
    name: cur.name,
    min: cur.min,
    nextLv: nxt ? nxt.lv : cur.lv,
    nextName: nxt ? nxt.name : cur.name,
    nextMin: nxt ? nxt.min : cur.min,
    toNext: maxed ? 0 : Math.max(0, nxt.min - p),
    progress,
    maxed
  }
}

/**
 * 两次等级之间该发多少升级奖励。
 *
 * 为什么按「级差」而不是「一次 50」：单次赠送的积分可能跨级（例如补录历史
 * 积分一次从 Lv.1 冲到 Lv.3），规则是「每升一级发放」，那就得按跨过的级数给。
 * 等级回退（to <= from）一律 0，不做倒扣。
 */
function upgradeReward(fromLv, toLv) {
  const a = Math.max(1, Number(fromLv) || 1)
  const b = Math.max(1, Number(toLv) || 1)
  if (b <= a) return 0
  return (b - a) * REWARD_PER_LEVEL
}

/** 下发给客户端的等级表（含每档门槛），用于展示与自查 */
function table() {
  return LEVELS.map((x, i) => ({
    lv: x.lv,
    name: x.name,
    min: x.min,
    nextMin: LEVELS[i + 1] ? LEVELS[i + 1].min : null
  }))
}

module.exports = { LEVELS, REWARD_PER_LEVEL, levelOf, upgradeReward, table }
