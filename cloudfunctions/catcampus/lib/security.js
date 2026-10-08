/**
 * 内容安全模块（难点 1 pipeline 第 2 步）
 *
 * 微信要求 UGC 内容必须过安全检测，否则小程序审核会被拒。
 * 设计原则：
 *  1. 文本同步检测，图片同步检测（小图足够快）；
 *  2. 短视频用异步 mediaCheckAsync —— 同步接口对视频体积有限制；
 *  3. 检测接口本身出错时「降级放行」而不是阻断业务，但会写日志，
 *     避免微信安全接口抖动导致整个打卡功能不可用；
 *  4. 命中 87014（内容违规）才真正拦截。
 */
const { cloud, db, _, COL } = require('./core')

/** 违规码：内容含有违规信息 */
const RISKY = 87014

/** 总开关：本地调试可关（环境变量 SEC_OFF=1） */
function off() {
  return process.env.SEC_OFF === '1'
}

/**
 * 文本安全检测
 * @returns {Promise<boolean>} true=通过
 */
async function checkText(text) {
  if (!text) return true
  if (off()) return true
  try {
    await cloud.openapi.security.msgSecCheck({ content: String(text).slice(0, 2500) })
    return true
  } catch (e) {
    if (e && e.errCode === RISKY) {
      console.warn('[sec.text] 命中违规', String(text).slice(0, 40))
      return false
    }
    console.warn('[sec.text] 检测异常，降级放行', e && (e.errCode || e.errMsg))
    return true
  }
}

/**
 * 图片安全检测（同步）
 * @param {string} fileID 云存储 fileID
 */
async function checkImage(fileID) {
  if (!fileID) return true
  if (off()) return true
  try {
    const f = await cloud.downloadFile({ fileID })
    if (!f || !f.fileContent) return true
    const size = f.fileContent.length
    // 微信 imgSecCheck 限制 1MB，超出则改用异步媒体检测
    if (size > 1024 * 1024) return await checkMediaAsync(fileID, 'image')
    await cloud.openapi.security.imgSecCheck({
      media: { contentType: 'image/jpeg', value: f.fileContent }
    })
    return true
  } catch (e) {
    if (e && e.errCode === RISKY) {
      console.warn('[sec.img] 命中违规', fileID)
      return false
    }
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

/** 组合校验：文本 + 首图，任一不通过即抛错 */
async function assertSightingSafe(data) {
  const textOk = await checkText(data.note)
  if (!textOk) throw new Error('描述内容未通过安全检测')
  const photos = (data.photos || []).slice(0, 6)
  if (photos.length) {
    const imgOk = await checkImage(photos[0])
    if (!imgOk) throw new Error('图片未通过安全检测')
  }
  return true
}

/** 记录一条安全审计（可选，便于管理员追溯） */
async function audit(openid, kind, fileID, note) {
  try {
    await db.collection(COL.apply).add({
      data: {
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
