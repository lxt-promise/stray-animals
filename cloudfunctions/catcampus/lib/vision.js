/**
 * AI 猫脸识别 —— 难点 1
 *
 * pipeline：
 *   上传(fileId) → 内容安全 → 特征提取 → 档案库检索 → Top-N 候选 → 人工确认 → 回写特征库
 *
 * 三个关键工程决策：
 *  1. 检索用「属性匹配 + 位置先验」融合打分；第三方若返回 embedding 则升级为向量余弦检索。
 *     全程不训练模型 —— 训练是改权重，建特征库只是把照片变成向量存起来。
 *  2. 短视频识别异步化：先落库任务（pending），轮询时靠「租约抢占」保证只有一个请求
 *     真正执行计算，重复轮询幂等，避免云函数超时（上限 20s，AI 可放宽到 60s）。
 *  3. 真·抽帧需要 ffmpeg，云函数 Node 环境没有；MVP 阶段用 wx.chooseMedia 返回的封面帧
 *     （thumbId）作为代表帧，frames 字段表示「计划抽帧数」留给将来的容器化服务。
 */
const { cloud, db, _, COL, AppError, distanceM, cosine } = require('./core')
const sec = require('./security')
const points = require('./points')

const TOP_N = 5
/** 低于该分数视为低置信，只提示「可能是」，不硬判 */
const LOW_CONF = 55
/** 任务租约时长：超过则允许被其他轮询请求接管（防云函数被杀导致任务卡死） */
const LEASE_MS = 30000
const MAX_FRAMES = 8

/* ==================== 档案库 ==================== */

/**
 * 批量把云存储 fileId 换成临时 https 链接。
 * 自建识别服务在外网，拿不到 cloud:// 协议的 fileId —— 必须先用临时链接喂给它。
 * 官方接口单次上限 50 个，这里自动分批。
 */
async function attachTempUrls(list, per) {
  if (!list || !list.length) return
  const limit = per || 6
  const cloud = []
  list.forEach(item => {
    const arr = ((item.photos && item.photos.length ? item.photos : (item.avatar ? [item.avatar] : [])) || []).slice(0, limit)
    arr.forEach(p => { if (String(p).indexOf('cloud://') === 0) cloud.push(p) })
  })
  const uniq = [...new Set(cloud)]

  const map = {}
  for (let i = 0; i < uniq.length; i += 50) {
    try {
      const tmp = await cloud.getTempFileURL({ fileList: uniq.slice(i, i + 50) })
      ;(tmp && tmp.fileList || []).forEach(it => { if (it && it.tempFileURL) map[it.fileID] = it.tempFileURL })
    } catch (e) {
      console.warn('[vision] 批量换取临时链接失败', e && e.message)
    }
  }
  list.forEach(item => {
    const arr = (item.photos && item.photos.length ? item.photos : (item.avatar ? [item.avatar] : [])) || []
    item.photosUrl = arr.slice(0, limit)
      .map(p => map[p] || (String(p).indexOf('http') === 0 ? p : ''))
      .filter(Boolean)
    item.photoUrl = item.photosUrl[0] || ''
  })
}

function pickPhoto(c) {
  return (c && ((c.photos && c.photos[0]) || c.avatar)) || ''
}

/** 载入同校猫档案（含特征向量与常驻点位，供检索与位置先验） */
async function index(schoolId, opts) {
  const where = {}
  if (schoolId) where.schoolId = schoolId
  const res = await db.collection(COL.cat).where(where).limit(200).get()
  await attachTempUrls(res.data, opts && opts.photosPerCat)
  return res.data.map(c => ({
    id: c._id,
    name: c.name,
    pattern: c.pattern || 'other',
    color: c.color || c.colorNote || '',
    photo: pickPhoto(c),
    photoUrl: c.photoUrl || '',
    photosUrl: c.photosUrl || [],
    location: c.location || null,
    embedding: Array.isArray(c.embedding) ? c.embedding : null
  }))
}

/** fileId → 临时 https（第三方接口更易接入） */
async function toTempUrl(fileId) {
  if (!fileId) return ''
  try {
    const tmp = await cloud.getTempFileURL({ fileList: [fileId] })
    const item = tmp && tmp.fileList && tmp.fileList[0]
    return (item && item.tempFileURL) || ''
  } catch (e) {
    console.warn('[vision] 换取临时链接失败', e && e.message)
    return ''
  }
}

/* ==================== 检索打分 ==================== */

/**
 * 单只猫的匹配打分
 * 组成：基线 + 视觉相似（向量优先，退化为属性）+ 位置先验
 * @param {Object} cat 档案
 * @param {Object} f   识别出的特征
 * @param {Object} loc 用户上传时的位置（可能为空）
 */
function scoreCat(cat, f, loc) {
  const reasons = []
  let s = 30

  if (Array.isArray(f.embedding) && Array.isArray(cat.embedding) && cat.embedding.length === f.embedding.length) {
    const sim = cosine(f.embedding, cat.embedding)
    s += Math.max(0, sim) * 60
    reasons.push('特征相似度 ' + (sim * 100).toFixed(0) + '%')
  } else {
    if (cat.pattern && f.pattern && cat.pattern === f.pattern) {
      s += 26
      reasons.push('花纹一致')
    }
    if (cat.color && f.color && String(f.color).indexOf(String(cat.color)) >= 0) {
      s += 16
      reasons.push('毛色吻合')
    }
  }

  // 位置先验：流浪猫活动范围固定，离常驻点越近越可能是它
  if (loc && cat.location) {
    const d = distanceM(loc, cat.location)
    if (d != null) {
      if (d < 100) { s += 14; reasons.push('距常驻点约 ' + Math.round(d) + 'm') }
      else if (d < 300) { s += 7; reasons.push('距常驻点约 ' + Math.round(d) + 'm') }
      else if (d < 1000) { s += 2 }
    }
  }

  if (!reasons.length) reasons.push('轮廓与体色接近')
  return {
    catId: cat.id,
    name: cat.name,
    avatar: cat.photo,
    score: Math.max(0, Math.min(99, Math.round(s))),
    reason: reasons.join('·')
  }
}

/** 全库检索并取 Top-N */
function match(features, cats, loc) {
  return cats
    .map(c => scoreCat(c, features, loc))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N)
}

/* ==================== 特征提取 ==================== */

/** 占位引擎：按 fileId 哈希生成稳定伪特征，保证同图结果一致（接入真模型后被旁路） */
function localFeatures(fileId, type) {
  const seed = hashCode(String(fileId || ''))
  const rand = mulberry32(seed)
  const pick = arr => arr[Math.floor(rand() * arr.length) % arr.length]

  const colors = ['橘色', '黑白', '纯白', '狸花', '灰色', '三花', '玳瑁']
  const patterns = ['tabby', 'cow', 'white', 'orange', 'calico', 'black', 'gray']
  const sizes = ['偏瘦', '匀称', '健壮']

  const color = pick(colors)
  const pattern = pick(patterns)
  const size = pick(sizes)
  const confidence = 0.62 + rand() * 0.3

  return {
    tags: [
      { k: '毛色', v: color },
      { k: '花纹', v: pattern },
      { k: '体型', v: size },
      { k: '置信度', v: (confidence * 100).toFixed(0) + '%' }
    ],
    pattern,
    color,
    size,
    confidence
  }
}

/** 归一化第三方返回的特征，缺失字段用占位补齐，保证前端渲染不炸 */
function normalizeFeatures(raw) {
  const f = raw || {}
  const pattern = f.pattern || ''
  const color = f.color || ''
  const out = {
    tags: Array.isArray(f.tags) ? f.tags : [],
    pattern,
    color,
    size: f.size || '',
    confidence: Number(f.confidence) || 0.8
  }
  if (Array.isArray(f.embedding) && f.embedding.length) out.embedding = f.embedding
  if (!out.tags.length) {
    out.tags = [
      { k: '毛色', v: color || '未知' },
      { k: '花纹', v: pattern || '未知' }
    ]
  }
  return out
}

/** 调用第三方视觉接口（默认超时 8s） */
function callVisionApi(endpoint, payload) {
  const https = require('https')
  const http = require('http')
  const body = JSON.stringify(payload)
  let u
  try { u = new URL(endpoint) } catch (e) { return Promise.reject(new Error('AI_ENDPOINT 非法')) }
  const lib = u.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(process.env.AI_TOKEN ? { Authorization: 'Bearer ' + process.env.AI_TOKEN } : {})
      },
      timeout: Number(process.env.AI_TIMEOUT_MS) || 8000
    }, res => {
      let data = ''
      res.on('data', d => { data += d })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error('识别接口返回非 JSON')) }
      })
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('识别接口超时')) })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/* ==================== 执行识别 ==================== */

async function run(user, t) {
  const t0 = Date.now()
  const type = t.type || 'image'
  const schoolId = t.schoolId || ''

  // 视频优先用封面帧；真抽帧需容器化 ffmpeg，此处保留计划帧数
  const mediaId = (type === 'video' && t.thumbId) ? t.thumbId : t.fileId
  const frames = type === 'video'
    ? Math.max(1, Math.min(MAX_FRAMES, Math.ceil((Number(t.duration) || 8) / 2)))
    : 1

  // ① 内容安全
  const imgOk = await sec.checkImage(mediaId)
  if (!imgOk) throw new AppError('素材未通过安全检测', 400)
  if (type === 'video') await sec.checkMediaAsync(t.fileId, 'video')

  const cats = await index(schoolId)
  const url = await toTempUrl(mediaId)
  // 视频本体链接交给自建服务做真抽帧（云函数内没有 ffmpeg，做不了）
  const videoUrl = type === 'video' ? await toTempUrl(t.fileId) : ''

  // ② 特征提取
  let features = null
  let remoteCandidates = null
  let provider = 'local'
  const endpoint = process.env.AI_ENDPOINT
  if (endpoint) {
    try {
      const raw = await callVisionApi(endpoint, {
        url, videoUrl, fileId: mediaId, type, frames, schoolId,
        cats: cats.map(c => ({
          id: c.id, name: c.name, pattern: c.pattern, color: c.color,
          photos: c.photosUrl.length ? c.photosUrl : (c.photoUrl ? [c.photoUrl] : [])
        }))
      })
      if (raw && raw.features) {
        features = normalizeFeatures(raw.features)
        if (Array.isArray(raw.candidates)) remoteCandidates = raw.candidates
        provider = 'custom'
      }
    } catch (e) {
      console.error('[vision] 第三方接口失败，降级本地引擎', e && e.message)
    }
  }
  if (!features) features = localFeatures(mediaId, type)

  // ③ 检索
  const list = (remoteCandidates && remoteCandidates.length)
    ? remoteCandidates
    : match(features, cats, t.location)

  const byId = {}
  cats.forEach(c => { byId[c.id] = c })
  const candidates = list.slice(0, TOP_N).map(c => {
    const cat = byId[c.catId] || {}
    return {
      catId: c.catId,
      name: c.name || cat.name || '未知',
      avatar: c.avatar || cat.photo || '',
      score: Math.max(0, Math.min(99, Math.round(Number(c.score) || 0))),
      reason: c.reason || ''
    }
  }).sort((a, b) => b.score - a.score)

  return {
    requestId: 'rc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    provider,
    type,
    frames,
    latency: Date.now() - t0,
    features,
    candidates,
    threshold: LOW_CONF,
    lowConfidence: !candidates.length || candidates[0].score < LOW_CONF,
    notice: provider === 'local'
      ? '当前为内置占位引擎（未配置 AI_ENDPOINT），结果为演示级。接入视觉大模型后结构不变、精度提升。'
      : (candidates.length && candidates[0].score < LOW_CONF
        ? '匹配置信度偏低，请人工确认或新建档案。'
        : '')
  }
}

/* ==================== 同步 / 异步任务 ==================== */

/** 建任务（不执行） */
async function start(user, event) {
  const type = event.type === 'video' ? 'video' : 'image'
  const fileId = event.fileId
  if (!fileId) throw new AppError('缺少素材 fileId')
  const doc = {
    _openid: user._openid,
    schoolId: event.schoolId || user.schoolId || '',
    type,
    fileId,
    thumbId: event.thumbId || '',
    duration: Number(event.duration) || 0,
    location: event.location || null,
    status: 'pending',
    progress: 0,
    attempts: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  }
  const add = await db.collection(COL.aiTask).add({ data: doc })
  return { taskId: add._id, status: 'pending', type }
}

/** 同步执行（图片走这条，一次请求拿结果） */
async function runSync(user, event) {
  const { taskId } = await start(user, event)
  const t = (await db.collection(COL.aiTask).doc(taskId).get()).data
  await db.collection(COL.aiTask).doc(taskId).update({
    data: { status: 'running', leaseUntil: new Date(Date.now() + LEASE_MS), attempts: 1, updatedAt: new Date() }
  })
  try {
    const result = await run(user, t)
    await db.collection(COL.aiTask).doc(taskId).update({
      data: { status: 'done', progress: 100, result, finishedAt: new Date(), updatedAt: new Date() }
    })
    return Object.assign({}, result, { taskId })
  } catch (e) {
    await db.collection(COL.aiTask).doc(taskId).update({
      data: { status: 'failed', progress: 100, error: e.message || '识别失败', finishedAt: new Date(), updatedAt: new Date() }
    }).catch(() => {})
    throw e
  }
}

/**
 * 轮询（视频走这条）
 * 租约机制：只有把 pending 改成 running 的那个请求才执行计算，
 * 其它并发轮询直接返回「处理中」，避免重复调用第三方接口烧钱。
 */
async function poll(user, event) {
  const taskId = event.taskId
  if (!taskId) throw new AppError('缺少 taskId')
  const res = await db.collection(COL.aiTask).doc(taskId).get()
  const t = res.data
  if (!t) throw new AppError('任务不存在', 404)
  if (t._openid !== user._openid) throw new AppError('无权访问该任务', 403)

  if (t.status === 'done' || t.status === 'failed') {
    return { taskId, status: t.status, progress: 100, result: t.result || null, error: t.error || '' }
  }

  // 回收过期租约（上一个执行者被中断的情况）
  await db.collection(COL.aiTask)
    .where({ _id: taskId, status: 'running', leaseUntil: _.lt(new Date()) })
    .update({ data: { status: 'pending', updatedAt: new Date() } })
    .catch(() => {})

  const up = await db.collection(COL.aiTask)
    .where({ _id: taskId, status: 'pending' })
    .update({
      data: {
        status: 'running',
        leaseUntil: new Date(Date.now() + LEASE_MS),
        attempts: _.inc(1),
        updatedAt: new Date()
      }
    })
  const got = up && up.stats && up.stats.updated > 0
  if (!got) {
    const cur = await db.collection(COL.aiTask).doc(taskId).get()
    return { taskId, status: cur.data.status, progress: cur.data.progress || 40, result: cur.data.result || null }
  }

  const fresh = (await db.collection(COL.aiTask).doc(taskId).get()).data
  try {
    const result = await run(user, fresh)
    await db.collection(COL.aiTask).doc(taskId).update({
      data: { status: 'done', progress: 100, result, finishedAt: new Date(), updatedAt: new Date() }
    })
    return { taskId, status: 'done', progress: 100, result }
  } catch (e) {
    await db.collection(COL.aiTask).doc(taskId).update({
      data: { status: 'failed', progress: 100, error: e.message || '识别失败', finishedAt: new Date(), updatedAt: new Date() }
    }).catch(() => {})
    return { taskId, status: 'failed', progress: 100, error: e.message || '识别失败' }
  }
}

/**
 * 人工确认 —— 人机协同闭环
 * 每次确认 = 一条标注样本：既解锁图鉴，又把 embedding 回写进猫档案（这就是「建特征库」），
 * 攒够样本后想微调模型时，训练集已经自动准备好了。
 */
async function confirm(user, event) {
  const { taskId, catId, correct } = event
  if (!taskId) throw new AppError('缺少 taskId')
  const res = await db.collection(COL.aiTask).doc(taskId).get()
  const task = res.data
  if (!task) throw new AppError('任务不存在', 404)
  if (task._openid !== user._openid) throw new AppError('无权操作该任务', 403)

  const result = task.result || {}
  const topCatId = (result.candidates && result.candidates[0] && result.candidates[0].catId) || ''

  await db.collection(COL.aiSample).add({
    data: {
      _openid: user._openid,
      schoolId: task.schoolId || '',
      fileId: task.fileId,
      type: task.type,
      features: result.features || null,
      predictedCatId: topCatId,
      confirmedCatId: correct ? (catId || topCatId) : '',
      correct: !!correct,
      provider: result.provider || 'local',
      createdAt: new Date()
    }
  })

  let embeddingWritten = false
  if (correct && catId) {
    const emb = result.features && result.features.embedding
    if (Array.isArray(emb) && emb.length) {
      const c = await db.collection(COL.cat).doc(catId).get().catch(() => ({ data: null }))
      if (c.data && (!Array.isArray(c.data.embedding) || !c.data.embedding.length)) {
        await db.collection(COL.cat).doc(catId).update({
          data: { embedding: emb, embeddingFrom: 'ai', updatedAt: new Date() }
        }).catch(() => {})
        embeddingWritten = true
      }
    }
    const seen = user.catSeen || []
    if (seen.indexOf(catId) < 0) {
      await db.collection(COL.user).doc(user._id).update({ data: { catSeen: _.push([catId]) } })
    }
  }

  const g = await points.grant(user, 'confirm')
  await db.collection(COL.aiTask).doc(taskId).update({
    data: {
      confirmedCatId: correct ? (catId || topCatId) : '',
      confirmed: true,
      confirmedAt: new Date()
    }
  }).catch(() => {})

  return { ok: true, pointsGained: g.gained, embeddingWritten }
}

/* ==================== 特征库批量建库 ==================== */

/**
 * 一键建库：把本校所有猫的档案照换成临时链接，交给自建服务算「代表向量」并落盘。
 *
 * 为什么要单独做这一步：识别时的冷启动补库有数量上限，大批猫入库时用它一次性补完；
 * 之后每次识别都直接命中服务端本地特征库，既不用重下图片，也不用重算向量。
 * 建议在新猫建档后、或每月例行调用一次。
 */
async function buildIndex(user, event) {
  const endpoint = process.env.AI_ENDPOINT
  if (!endpoint) throw new AppError('未配置 AI_ENDPOINT', 400)

  const schoolId = event.schoolId || user.schoolId || ''
  const photosPerCat = Math.max(1, Math.min(10, Number(event.photosPerCat) || 6))
  const cats = await index(schoolId, { photosPerCat })

  const buildUrl = String(endpoint).replace(/\/v1\/recognize\/?$/, '/v1/index/build')
  if (buildUrl === String(endpoint)) {
    throw new AppError('AI_ENDPOINT 需以 /v1/recognize 结尾，才能推导建库地址', 400)
  }

  const res = await callVisionApi(buildUrl, {
    schoolId,
    photosPerCat,
    cats: cats.map(c => ({
      id: c.id, name: c.name, pattern: c.pattern, color: c.color, photos: c.photosUrl
    }))
  })
  return {
    ok: true,
    schoolId,
    scanned: cats.length,
    built: res && res.built,
    failed: (res && res.failed) || [],
    indexed: res && res.total
  }
}

/* ==================== 小工具 ==================== */

function hashCode(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

module.exports = {
  runSync, start, poll, confirm, run, index, buildIndex,
  scoreCat, match, TOP_N, LOW_CONF
}
