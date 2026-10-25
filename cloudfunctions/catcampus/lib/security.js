/**
 * 内容安全模块（难点 1 pipeline 第 2 步）
 *
 * 微信要求 UGC 内容必须过安全检测，否则小程序审核会被拒。
 * 设计原则：
 *  1. 文本 / 图片优先**同步**检测，但每步都有硬预算（见下方 IMG_* / TEXT_*）：
 *     超预算就转 mediaCheckAsync 异步检测并放行 —— 客户端 callFunction 只有约 3s，
 *     为了「多等 200ms 可能检得更严」把整次保存拖死是不可接受的；
 *  2. 短视频用异步 mediaCheckAsync —— 同步接口对视频体积有限制；
 *  3. 检测接口本身出错时「降级放行」而不是阻断业务，但会写日志，
 *     避免微信安全接口抖动导致整个打卡功能不可用；
 *  4. 命中 87014（内容违规）才真正拦截；超时降级**不影响**违规判定。
 */
const { cloud, db, _, COL } = require('./core')

/** 违规码：内容含有违规信息 */
const RISKY = 87014

/**
 * 图片同步检测的预算（毫秒）。
 *
 * 背景（2026-10-24 现场）：新建档案点保存必报
 * `-504003 Invoking task timed out after 3 seconds`，**点第二遍就成功**。
 * 典型冷启动叠加：图片检测要「下载原图 + 同步送检」两步网络 IO，一张手机拍的
 * 猫照 1~3MB，两步加起来 1.5~3s 完全正常 —— 冷启动时必然顶穿客户端 3s 预算。
 *
 * 所以这里改成**带 deadline 的尽力而为**：
 *   下载 → 送检 每步都有自己的截止时间，超出就转 `mediaCheckAsync`（提交即放行、
 *   结果异步可查），绝不为了「多等 200ms 可能检得更严」把整次保存拖死。
 * 命中 87014 依然照常拦截 —— 降级只影响「等不等得到结果」，不影响判定。
 */
const IMG_BUDGET_MS = 1000
/** 下载上限（不含送检） */
const IMG_DL_MS = 600
/** 同步送检上限 */
const IMG_SEC_MS = 450
/** 转异步检测（getTempFileURL + mediaCheckAsync）的等待上限 */
const IMG_ASYNC_MS = 400
/** 文本同步检测上限 */
const TEXT_BUDGET_MS = 1200

/** 超时标记：与「业务错误」区分开，超时要降级，业务错误不能吞 */
const TIMEOUT = Symbol('sec.timeout')

/** 超时就当「拿不到内容」返回 null（下载这类场景） */
function withTimeout(p, ms) {
  let timer = null
  return Promise.race([
    Promise.resolve(p).catch(() => null),
    new Promise(resolve => { timer = setTimeout(() => resolve(null), ms) })
  ]).then(v => { if (timer) clearTimeout(timer); return v })
}

/**
 * 超时抛 TIMEOUT、其余错误原样抛出。
 *
 * ⚠️ 不能用上面的 withTimeout 包 imgSecCheck：它会把「命中违规 87014」也一起
 * 变成 null，等于把违规图放行。检测类调用必须能看到真实错误。
 */
function withDeadline(p, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(TIMEOUT), Math.max(1, ms))
    Promise.resolve(p).then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) }
    )
  })
}

/** 总开关：本地调试可关（环境变量 SEC_OFF=1） */
function off() {
  return process.env.SEC_OFF === '1'
}

/**
 * 文本安全检测
 *
 * ⚠️ 必须有截止时间：msgSecCheck 抖动时（实测偶发 2s+）会把「点保存」整段吃掉，
 * 表现为「点第一遍超时、点第二遍成功」（第二遍微信侧已缓存/服务已预热）。
 *
 * @param {string} text
 * @param {Object} [opts]
 * @param {number} [opts.budgetMs]
 * @returns {Promise<boolean>} true=通过
 */
async function checkText(text, opts) {
  if (!text) return true
  if (off()) return true
  const budget = Math.max(300, Number(opts && opts.budgetMs) || TEXT_BUDGET_MS)
  try {
    await withDeadline(cloud.openapi.security.msgSecCheck({ content: String(text).slice(0, 2500) }), budget)
    return true
  } catch (e) {
    if (e === TIMEOUT) {
      console.warn('[sec.text] 检测超时（' + budget + 'ms），降级放行')
      return true
    }
    if (e && e.errCode === RISKY) {
      console.warn('[sec.text] 命中违规', String(text).slice(0, 40))
      return false
    }
    console.warn('[sec.text] 检测异常，降级放行', e && (e.errCode || e.errMsg))
    return true
  }
}

/**
 * 图片安全检测（同步优先，超预算转异步）
 *
 * @param {string} fileID 云存储 fileID
 * @param {Object} [opts]
 * @param {number} [opts.budgetMs] 本次检测最多占用多久（默认 IMG_BUDGET_MS）
 * @returns {Promise<boolean>} true=通过（含「超时降级放行」），false=命中违规
 */
async function checkImage(fileID, opts) {
  if (!fileID) return true
  if (off()) return true
  const budget = Math.max(300, Number(opts && opts.budgetMs) || IMG_BUDGET_MS)
  const t0 = Date.now()
  const left = () => budget - (Date.now() - t0)

  /** 转异步检测：提交完就放行。等待也设上限 —— 它本身也是两次网络调用 */
  const fallbackAsync = async why => {
    const ms = Math.min(IMG_ASYNC_MS, Math.max(150, left()))
    await withTimeout(checkMediaAsync(fileID, 'image'), ms)
    console.warn('[sec.img] 同步检测未完成（' + why + '），已转异步检测', fileID)
    return true
  }

  try {
    // ① 下载：拿不到内容（超时 / 无权限）就别再等同步送检了
    const f = await withTimeout(cloud.downloadFile({ fileID }), Math.min(IMG_DL_MS, left()))
    if (!f || !f.fileContent) return await fallbackAsync('下载超时或无内容')

    const size = f.fileContent.length
    // 微信 imgSecCheck 限制 1MB，超出只能走异步媒体检测
    if (size > 1024 * 1024) return await fallbackAsync('超过 1MB')

    // ② 同步送检：预算见底就干脆不赌，直接转异步
    const ms = Math.min(IMG_SEC_MS, left())
    if (ms < 150) return await fallbackAsync('预算已用尽')
    await withDeadline(cloud.openapi.security.imgSecCheck({
      media: { contentType: 'image/jpeg', value: f.fileContent }
    }), ms)
    return true
  } catch (e) {
    if (e === TIMEOUT) return await fallbackAsync('同步送检超时')
    if (e && e.errCode === RISKY) {
      console.warn('[sec.img] 命中违规', fileID)
      return false
    }
    // 接口本身报错（配额、权限、网络）也不能阻断业务：降级放行并留日志
    console.warn('[sec.img] 检测异常，降级放行', fileID, e && (e.errCode || e.errMsg))
    return true
  }
}

/**
 * 异步媒体检测（音视频 / 大图）
 * 微信异步检测需要 2.x 以上基础库，结果通过消息推送或轮询获取；
 * 这里做「尽力而为」：提交成功即放行，提交失败也放行（仅记录 traceId 便于追溯）。
 * @returns {Promise<{pass:boolean, traceId:string}>}
 */
async function checkMediaAsync(fileID, type) {
  if (!fileID) return { pass: true, traceId: '' }
  if (off()) return { pass: true, traceId: '' }
  try {
    const urlRes = await cloud.getTempFileURL({ fileList: [fileID] })
    const item = urlRes && urlRes.fileList && urlRes.fileList[0]
    if (!item || !item.tempFileURL) return { pass: true, traceId: '' }
    const res = await cloud.openapi.security.mediaCheckAsync({
      mediaUrl: item.tempFileURL,
      mediaType: type === 'video' ? 2 : 1
    })
    return { pass: true, traceId: (res && res.traceId) || '' }
  } catch (e) {
    console.warn('[sec.media] 异步检测异常，降级放行', fileID, e && (e.errCode || e.errMsg))
    return { pass: true, traceId: '' }
  }
}

/**
 * 组合校验：结构化字段 + 首图，任一不通过即抛错。
 *
 * ⚠️ 2026-10-16 合规改造后，打卡请求里**已无自由文本**（note 已下线）：
 *   用户输入全部是枚举值（behaviors / features / health / feedStatus），由 index.js
 *   的白名单过滤，安全检测在这里没有可用文本。
 *   仍保留对标签值拼接串的检测 —— 万一某天枚举项被写成含敏感词的字面量，
 *   或是老客户端偷偷传了 note，这里能兜住。
 */
async function assertSightingSafe(data) {
  const d = data || {}
  // 老客户端可能仍传 note（自由文本）；只要带了就必须过检测，不能绕过
  const legacyText = [d.note, d.catName, d.locationName].filter(Boolean).join(' ')
  const photos = (d.photos || []).slice(0, 6)
  // 文本与图片**并行**检测：两者互不依赖，串行等于把两次网络往返相加，
  // 打卡保存同样受客户端 3s 预算约束（现场「点第一遍超时、点第二遍成功」）。
  const textP = legacyText ? checkText(legacyText) : Promise.resolve(true)
  const imgP = photos.length ? checkImage(photos[0]) : Promise.resolve(true)
  if (!(await textP)) throw new Error('内容未通过安全检测')
  if (!(await imgP)) throw new Error('图片未通过安全检测')
  return true
}

/** 记录一条安全审计（可选，便于管理员追溯） */
async function audit(openid, kind, fileID, note) {
  try {
    await db.collection(COL.apply).add({
      data: {
        openid: openid,
        _openid: openid,
        kind: 'sec_audit:' + kind,
        fileID: fileID || '',
        note: note || '',
        status: 'archived',
        createdAt: new Date()
      }
    })
  } catch (e) {
    // 审计失败不影响主流程
  }
}

module.exports = { checkText, checkImage, checkMediaAsync, assertSightingSafe, audit }
