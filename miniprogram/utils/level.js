/**
 * 等级表（前端镜像）—— 必须与 cloudfunctions/catcampus/lib/level.js 逐值一致。
 *
 * 为什么前端要自己算，而不是直接用云端下发的 level 对象：
 *
 *   旧实现把所有展示文案拼在前端、把数字全部寄希望于云端字段：
 *     '距 Lv.' + lv.nextLv + ' ' + lv.nextName + ' 还差 ' + lv.toNext + ' 分'
 *   云端只要少给一个字段（云函数还是旧版本、字段改名、对象被裁剪），
 *   界面就会原样渲染出：
 *     「距 Lv.undefined undefined 还差 undefined 分」「0 / undefined 分」
 *   —— 不报错、不白屏，只是数字全变成 undefined，最难被发现。
 *
 *   现在改成分工：云端只负责数据（points / peakPoints / food），
 *   等级、进度、下一档距离全部由这里按积分算。云端返回什么形状都不影响展示。
 *
 * 改了等级门槛：`LEVELS` 与云端 `lib/level.js` 必须一起改，
 * scripts/test_points_level.js 会逐值比对两张表并锁死 12 个边界点。
 *
 * 判级规则（与云端同一份语义）：
 *   1. 入参传 **历史最高积分**（peakPoints），不是当前积分 —— 只升不降。
 *   2. 区间左闭右开 [min, 下一档 min)：100 分属于 Lv.2，不同时属于 Lv.1。
 *   3. 满级后进度恒 100，不再显示「再得 N 分」。
 */
const LEVELS = [
  { lv: 1, name: '猫语新手', min: 0 },
  { lv: 2, name: '爱猫人士', min: 100 },
  { lv: 3, name: '猫界达人', min: 500 },
  { lv: 4, name: '资深铲屎官', min: 1000 },
  { lv: 5, name: '喵星守护者', min: 3000 },
  { lv: 6, name: '传奇喵侠', min: 5000 }
]

/**
 * 按积分算等级详情（纯函数，不碰 wx/网络，方便单测）。
 * @param {number} points 积分（判级请传 peakPoints）
 * @returns {{lv:number,name:string,min:number,nextLv:number,nextName:string,
 *            nextMin:number,toNext:number,progress:number,maxed:boolean,
 *            levelText:string,nextText:string}}
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
  // 满级时跨度取 1，避免除零；进度恒 100
  const span = maxed ? 1 : Math.max(1, nxt.min - cur.min)
  const progress = maxed
    ? 100
    : Math.max(0, Math.min(100, Math.round(((p - cur.min) / span) * 100)))
  const toNext = maxed ? 0 : Math.max(0, nxt.min - p)
  return {
    lv: cur.lv,
    name: cur.name,
    min: cur.min,
    nextLv: nxt ? nxt.lv : cur.lv,
    nextName: nxt ? nxt.name : cur.name,
    nextMin: nxt ? nxt.min : cur.min,
    toNext,
    progress,
    maxed,
    // 文案在这里拼好：WXML 的 mustache 不做字符串运算，
    // 数字也全部来自本地，任何一个 undefined 都渗不进界面。
    levelText: 'Lv.' + cur.lv + ' ' + cur.name,
    nextText: maxed ? '已达最高等级' : ('再得 ' + toNext + ' 积分可升级')
  }
}

/**
 * 等级阶梯（等级页底部那排点）。
 * done = 已经走过的档位，on = 当前所在档位。选中态在 JS 预计算：
 * WXML 里写 `item.lv === lv` 这类比较在部分基础库会被静默忽略。
 */
function ladder(points) {
  const cur = levelOf(points)
  return LEVELS.map(x => ({
    lv: x.lv,
    label: 'Lv.' + x.lv,
    done: x.lv < cur.lv,
    on: x.lv === cur.lv
  }))
}

module.exports = { LEVELS, levelOf, ladder }
