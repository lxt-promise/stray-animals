/**
 * TNR 状态机 —— 难点 5
 *
 * 「抓捕 → 绝育 → 放归」是一条单向流程，难点有二：
 *  1. 状态流转合法性：不能从「已放归」跳回「待抓捕」，也不能跳级；
 *  2. 联动一致性：绝育完成后必须同步猫档案的 sterilized / earMark / status，
 *     且要和 TNR 记录写入在同一个事务里，避免出现「记录说绝育了、档案说没有」。
 */
const { db, _, COL, AppError } = require('./core')

/**
 * 状态定义与允许的后继状态（白名单表）
 * 取值与小程序端 utils/const.js 的 TNR_STATUS 保持一致，避免前后端状态对不上。
 */
const FLOW = {
  todo:      { label: '待抓捕',     next: ['trapping', 'trapped', 'surgery', 'failed'] },
  trapping:  { label: '诱捕中',     next: ['trapped', 'failed', 'todo'] },
  trapped:   { label: '已捕获',     next: ['surgery', 'released', 'failed'] },
  surgery:   { label: '手术中/住院', next: ['released', 'failed'] },
  released:  { label: '已放归',     next: ['adopted'] },
  adopted:   { label: '转领养',     next: [] },                 // 终态
  failed:    { label: '失败/逃脱',  next: ['todo'] }
}

const ORDER = ['todo', 'trapping', 'trapped', 'surgery', 'released', 'adopted', 'failed']

/**
 * 校验流转是否合法
 * @param {string} from 原状态（新建时为空）
 * @param {string} to   目标状态
 */
function assertTransition(from, to) {
  if (!to || !FLOW[to]) throw new AppError('未知的 TNR 状态：' + to, 400)
  if (!from || from === to) return true
  const allow = (FLOW[from] && FLOW[from].next) || []
  if (allow.indexOf(to) < 0) {
    const fromLabel = (FLOW[from] && FLOW[from].label) || from
    const toLabel = FLOW[to].label
    throw new AppError(
      '不允许从「' + fromLabel + '」变更为「' + toLabel + '」，允许变更为：' +
      (allow.length ? allow.map(s => FLOW[s].label).join('、') : '（终态，不可变更）'),
      400
    )
  }
  return true
}

/** 根据流转自动回填阶段日期（未填写时才补，避免覆盖人工修正） */
function autoDates(payload, from, to, now) {
  const d = now || new Date()
  const iso = x => {
    const t = x || d
    return t.getFullYear() + '-' +
      String(t.getMonth() + 1).padStart(2, '0') + '-' +
      String(t.getDate()).padStart(2, '0')
  }
  if ((to === 'trapped' || to === 'surgery') && !payload.trapDate) payload.trapDate = iso()
  if ((to === 'surgery' || to === 'released' || to === 'adopted')) {
    if (!payload.surgeryDate) payload.surgeryDate = iso()
    if (!payload.trapDate) payload.trapDate = iso()
  }
  if ((to === 'released' || to === 'adopted') && !payload.releaseDate) payload.releaseDate = iso()
  return payload
}

/**
 * 同步猫档案（绝育状态 / 耳标 / 在校状态）
 * @param {Object} collection 事务句柄 tx.collection(...) 或 db.collection(...)
 */
function catSyncPatch(status, earMark) {
  if (status === 'surgery' || status === 'released') {
    // 绝育完成：同步档案的绝育状态与耳标，回到「在校」
    const patch = { sterilized: 'yes', status: 'campus', tnrInProgress: false, updatedAt: new Date() }
    if (earMark) patch.earMark = earMark
    return patch
  }
  if (status === 'adopted') {
    const patch = { sterilized: 'yes', status: 'adopted', tnrInProgress: false, updatedAt: new Date() }
    if (earMark) patch.earMark = earMark
    return patch
  }
  if (status === 'trapping' || status === 'trapped') {
    // 抓捕中：档案标记为「诱捕中」，避免他人重复排班
    return { tnrInProgress: true, updatedAt: new Date() }
  }
  if (status === 'failed' || status === 'todo') {
    return { tnrInProgress: false, updatedAt: new Date() }
  }
  return null
}

/** 供前端渲染状态选择器：返回每个状态可选的下一状态 */
function flowMeta() {
  return ORDER.map(k => ({
    value: k,
    label: FLOW[k].label,
    next: FLOW[k].next,
    terminal: FLOW[k].next.length === 0
  }))
}

module.exports = { FLOW, ORDER, assertTransition, autoDates, catSyncPatch, flowMeta }
