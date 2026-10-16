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
 *
 * ⚠️⚠️ 分步续跑的铁律（2026-10-13 一次「改成全超时」的回归换来的）：
 *   客户端 `cloud.callFunction` 的预算只有**约 3 秒**（超时 -504003）。
 *   现场证据：27 轮轮询全部 -504003、任务始终不结束 —— 因为每一步都贴着/越过 3s，
 *   步骤字段又没能落库，每轮轮询都在从头重跑同一个阶段，永远收敛不了。
 *   由此定下四条规矩，改这个文件前先读：
 *   1) **每一次调用都必须在约 2.4s 内返回**（POLL_BUDGET_MS），不假设「超时后云函数还会干活」。
 *      poll 路径带硬截止：每步开工前看余量，不够就 { deferred:true } 收工下轮再来。
 *   2) **partial 只存小字段**（url/videoUrl 这类字符串）。档案（含 embedding）用时现读，
 *      绝不整库塞进 partial —— 单文档体积越过云数据库上限后 update 会静默失败，
 *      step 永远停在原地，就是上面那场事故的直接病根。
 *   3) **写不进去必须吼**：patchTask 返回 stats，关键步骤写未效应当即抛错重试，
 *      不允许「catch 掉只打 warn」——静默失败比报错难查一万倍。
 *   4) **同步路径（run/runSync）没有 3s 限制**，AI 可以等满 AI_TIMEOUT_MS；
 *      客户端 `recognize` 同步调用超时会转轮询接管，已落库的分步产物不丢。
 */
const { cloud, db, _, COL, AppError, distanceM, cosine, warmCollection } = require('./core')
const sec = require('./security')
const points = require('./points')

const TOP_N = 5
/** 低于该分数视为低置信，只提示「可能是」，不硬判 */
const LOW_CONF = 55
/** 任务租约时长：超过则允许被其他轮询请求接管（防云函数被杀导致任务卡死） */
const LEASE_MS = 10000
/** 同步路径（runSync）的租约：一次调用要跑完整链路，给足但别太长 */
const LEASE_SYNC_MS = 12000
const MAX_FRAMES = 8

/* ==================== 分步执行的预算参数 ==================== */
/**
 * poll 单次调用的总预算（客户端约 3s，留余量给响应序列化 + 网络 + SDK 开销）。
 *
 * ⚠️ 为什么是 2400 而不是更小（2026-10-15 复盘）：
 *   现场出现 `-504003 Invoking task timed out after 3 seconds` 时，第一反应是
 *   「预算贴太紧，调到 2000」。但这条路是死的 —— 固定开销吃不消：
 *     入口(getMe) 200ms + 读任务 180ms + 抢租约 180ms ≈ 560ms，
 *   而第一步（内容安全）自己要 SEC_RESERVE_MS=1500ms 的余量。
 *   预算 2000 时留给第一步只剩 1440ms < 1500 → 每轮都 deferred →
 *   进度永远停在 40，**比原来还糟**（回归台 S1/S4 当场全红）。
 *   根因不在预算，而在同步快路径「不知道自己被 3s 掐」—— 见 run()/runSync() 的
 *   syncCtx 预算与「defer 即交还」策略。所以这里保持 2400 不动。
 */
const POLL_BUDGET_MS = 2400
/** 基础往返（getMe + 读任务）就超过这个数，直接回 pending 下轮再来，不抢租约不干活 */
const BASE_RESERVE_MS = 900
/** 步骤① 内容安全的余量：downloadFile + imgSecCheck 合计的现实上限 */
const SEC_RESERVE_MS = 1500
/** 同步安全检测连续这么多轮都没能把步骤落库 → 降级异步送检，保证收敛 */
const SEC_SYNC_TRIES = 2
/** 步骤② 换临时链接的余量：toTempUrl ×1~2 + 一次写入 */
const URL_RESERVE_MS = 1000
/** 步骤③ 里给 AI 之外收尾工作留的余量（读档案 + 写结果） */
const AI_RESERVE_MS = 500
// 补库之后至少要给 AI 留这么大的窗口，否则这轮不补库（见 attachPendingPhotos）
const AI_MIN_WINDOW_MS = 600
/** poll 路径 AI 调用的硬封顶（环境变量可调低，调高也会被它压住） */
const AI_POLL_CAP_MS = 1800
/** feat 连续「明确错误」这么多次后降级本地引擎，保证终局有结果 */
const FEAT_FALLBACK_ATTEMPTS = 6
/**
 * 识别热路径里「顺手补库」的猫数量上限。
 *
 * 背景：为了让单次识别压进客户端约 3s 预算，识别报文不再带档案照，
 * 服务端 ensure_index 因此失去了冷启动补库的素材 —— 新建档的猫不会自动进特征库。
 * 解法是在识别时只给「档案里标记未入库」的猫附照片，由服务端 ensure_index 补上。
 *
 * 为什么限量：换临时链接 + 服务端下载都要时间，一次带 200 只必超预算。
 * 超过上限说明是批量建档，交给定时任务分片去建，热路径只保证「零星新猫即时可用」。
 */
const PENDING_INDEX_MAX = 6
/** 补库时每只猫最多带几张照片（1 张够算代表向量，2 张更稳，再多就是浪费预算） */
const PENDING_PHOTOS_PER_CAT = 2
/** 补库前至少要剩这么多预算，否则跳过（补库是优化，不能挤压识别本身） */
const PENDING_URL_RESERVE_MS = 800
/** AI 总尝试上限（超时不计入降级阈值，但总次数要有界，否则慢服务能拖到天荒地老） */
const MAX_AI_ATTEMPTS = 12


/* ==================== 档案库 ==================== */

/**
 * 批量把云存储 fileId 换成临时 https 链接。
 * 自建识别服务在外网，拿不到 cloud:// 协议的 fileId —— 必须先用临时链接喂给它。
 * 官方接口单次上限 50 个，这里自动分批**并行**发起（早期版本串行等 24 批 ≈ 7s，能把调用拖爆）。
 */
async function attachTempUrls(list, per) {
  if (!list || !list.length) return
  const limit = per || 6
  // ⚠️ 局部数组绝不能叫 cloud——会遮蔽模块顶部解构出的 wx cloud 对象，
  // 导致下面 cloud.getTempFileURL 抛 TypeError 又被 catch 吞掉、静默全空。
  const cloudIds = []
  list.forEach(item => {
    const arr = ((item.photos && item.photos.length ? item.photos : (item.avatar ? [item.avatar] : [])) || []).slice(0, limit)
    arr.forEach(p => { if (String(p).indexOf('cloud://') === 0) cloudIds.push(p) })
  })
  const uniq = [...new Set(cloudIds)]

  const map = {}
  let failCount = 0
  const batches = []
  for (let i = 0; i < uniq.length; i += 50) batches.push(uniq.slice(i, i + 50))
  await Promise.all(batches.map(batch =>
    cloud.getTempFileURL({ fileList: batch }).then(tmp => {
      ;(tmp && tmp.fileList || []).forEach(it => { if (it && it.tempFileURL) map[it.fileID] = it.tempFileURL })
    }).catch(e => {
      failCount += batch.length
      console.warn('[vision] 批量换取临时链接失败', e && e.message)
    })
  ))
  // 静默全空比报错更难查：全部失败时用 error 级别吼一声
  if (failCount && failCount >= uniq.length) {
    console.error('[vision] 临时链接全部换取失败（共 ' + uniq.length + ' 个），特征库照片将不可用')
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

/**
 * 载入同校猫档案（含特征向量与常驻点位，供检索与位置先验）
 *
 * @param {Object} opts { photosPerCat, catIds }
 *   catIds —— 只取这几只猫（建档后自动建库走这条窄路）。
 *   不给就扫全校：几百只猫要换成千上万个临时链接，那是定时任务/手动全量才承受得起的代价。
 */
async function index(schoolId, opts) {
  const o = opts || {}
  const where = {}
  if (schoolId) where.schoolId = schoolId
  if (Array.isArray(o.catIds) && o.catIds.length) where._id = _.in(o.catIds)
  const res = await db.collection(COL.cat).where(where).limit(200).get()
  await attachTempUrls(res.data, o.photosPerCat)
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

/**
 * 识别热路径专用：轻量读一次档案（字段投影，不换临时链接、不拿 embedding）。
 * 用途：远程候选回表补 name/avatar；本地兜底匹配的属性来源。
 * 为什么不复用 index()：它每次都 attachTempUrls（几百个 fileID 的批量换取），
 * 而识别轮询的单次预算只有约 2.4s，等不起。
 */
async function loadCatsLite(schoolId) {
  const where = {}
  if (schoolId) where.schoolId = schoolId
  let q = db.collection(COL.cat).where(where).limit(200)
  if (typeof q.field === 'function') {
    q = q.field({
      name: true, pattern: true, color: true, colorNote: true,
      photos: true, avatar: true, location: true,
      aiIndexAt: true, updatedAt: true
    })
  }
  const res = await q.get()
  return (res.data || []).map(c => ({
    id: c._id,
    name: c.name || '',
    pattern: c.pattern || 'other',
    color: c.color || c.colorNote || '',
    photo: pickPhoto(c),
    location: c.location || null,
    embedding: null,
    // 服务端特征库是否已收录（云函数侧的乐观记录，定时任务会兜底校正）
    aiIndexAt: c.aiIndexAt || null
  }))
}

/**
 * 挑出「还没进服务端特征库」且有照片的猫 —— 识别时顺手带上它们的照片，
 * 服务端 ensure_index 就会补算向量，本次检索即可命中。
 *
 * 新猫建档 → 第一次有人识别就自动入库并可被匹配，无需管理员手动点「建库」。
 */
function pickPendingIndexCats(catsLite) {
  return (catsLite || [])
    .filter(c => c && c.id && !c.aiIndexAt && c.photo)
    .slice(0, PENDING_INDEX_MAX)
}

/**
 * 乐观标记「已送服务端入库」（fire-and-forget，不 await）。
 *
 * 目的只是避免每次识别都重复携带同一批照片链接；写入失败无害 ——
 * 下轮会再带一次，而服务端 ensure_index 本身幂等（已有向量直接跳过）。
 */
function markIndexed(ids) {
  if (!ids || !ids.length) return
  const now = new Date()
  // ⚠️ 必须一次批量更新：逐只 doc().update() 会按猫数放大 DB 往返，
  // 而识别轮询全程都在跟 3s 预算赛跑（往返红线 ≤ 7）。
  // 不写 updatedAt —— 那是档案的业务字段，不该被记账动作污染。
  db.collection(COL.cat)
    .where({ _id: _.in(ids) })
    .update({ data: { aiIndexAt: now } })
    .catch(e => console.warn('[vision] 标记入库状态失败', e && e.message))
}

/**
 * 给「未入库」的猫附上可直接下载的临时照片链接 —— 服务端 ensure_index
 * 会在检索前把它们算进特征库，于是新猫建档后第一次识别就能被匹配。
 *
 * 失败一律静默返回空：补库是「让新猫更快可用」的优化，识别本身不依赖它。
 * @param {Array} catsLite loadCatsLite 的结果（会被就地挂上 pendingPhotos）
 * @param {Object} ctx 含 deadline 的执行上下文（同步路径不传，视为预算无限）
 * @returns {Promise<string[]>} 成功附上照片的猫 id 列表（供调用方记账）
 */
async function attachPendingPhotos(catsLite, ctx) {
  const deadline = (ctx && ctx.deadline) ? ctx.deadline : Infinity
  const picked = pickPendingIndexCats(catsLite)
  if (!picked.length) return {}
  // 预算纪律：补库是「让新猫更快可用」的优化，**识别优先**。
  // 判据不是「还剩多少」，而是「换完链接之后 AI 还剩多少」——
  // 早期版本只判 PENDING_URL_RESERVE_MS，于是 200~300ms 的换链接把 AI 窗口
  // 从 ~1060ms 挤到 ~860ms：一个 900ms 的识别服务就变成每次轮询都超时，
  // 12 次重试后降级本地引擎（识别质量断崖，用户还要干等 40 轮）。
  // 同步路径 deadline=Infinity，永远补（新猫入库主要靠它）。
  if (deadline - Date.now() - PENDING_URL_RESERVE_MS < AI_RESERVE_MS + AI_MIN_WINDOW_MS) return {}

  // catsLite 为了轻量只带了一个 photo 字符串，而 attachTempUrls 认的是 photos 数组 ——
  // 这里造一批只含待补库猫的影子对象去换链接，不污染 catsLite 本体
  const shadows = picked.map(c => ({ id: c.id, photos: [c.photo] }))
  try {
    await attachTempUrls(shadows, PENDING_PHOTOS_PER_CAT)
  } catch (e) {
    console.warn('[vision] 补库照片链接换取失败，本次跳过', e && e.message)
    return {}
  }

  const map = {}
  shadows.forEach(s => {
    if (s.photosUrl && s.photosUrl.length) map[s.id] = s.photosUrl
  })
  return map
}

/** 本地兜底匹配专用：读全量（含 embedding 向量）。只在 AI 路径失败后才走，贵但罕见 */
async function loadCatsFull(schoolId) {
  const where = {}
  if (schoolId) where.schoolId = schoolId
  const res = await db.collection(COL.cat).where(where).limit(200).get()
  return (res.data || []).map(c => ({
    id: c._id,
    name: c.name || '',
    pattern: c.pattern || 'other',
    color: c.color || c.colorNote || '',
    photo: pickPhoto(c),
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
    if (cat.color && f.color && String(cat.color).indexOf(String(f.color)) >= 0) {
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

/**
 * 调用第三方视觉接口。
 * @param timeoutMs 单次调用超时。**poll 路径必须传封顶值**（随剩余预算收缩）——
 *   客户端 callFunction 预算只有约 3s，沿用 AI_TIMEOUT_MS（可能配成 20s）必炸。
 *   同步路径（buildIndex/runSync）不传，用 AI_TIMEOUT_MS。
 */
function callVisionApi(endpoint, payload, timeoutMs) {
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
      timeout: Number(timeoutMs) || Number(process.env.AI_TIMEOUT_MS) || 8000
    }, res => {
      let data = ''
      res.on('data', d => { data += d })
      res.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(data) } catch (e) {
          return reject(new Error('识别接口返回非 JSON (HTTP ' + res.statusCode + ')'))
        }
        // ⚠️ 非 2xx 一律按失败抛 —— 401/503 的响应体（{"detail":...}）也是合法 JSON，
        // 静默 resolve 会让鉴权故障被包装成「建成 0 只」这种假成功（线上实测踩过：
        // token 不匹配 → 全部 401 → 管理页却显示「已建 0 只」，看起来像没猫可建）。
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = (parsed && (parsed.detail || parsed.error || parsed.message))
            || ('HTTP ' + res.statusCode)
          return reject(new Error('识别接口 HTTP ' + res.statusCode + ': ' + String(msg).slice(0, 120)))
        }
        resolve(parsed)
      })
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('识别接口超时')) })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/* ==================== 执行识别（分步可续跑） ==================== */

/**
 * 任务字段局部更新。
 * ⚠️ 必须返回 update 结果且失败要吼：早期版本把失败咽进 catch 只打 warn，
 * 步骤字段写不进去时 step 永远停在原地，每轮轮询从头重跑同一步，
 * 现场表现就是「每次轮询都超 3s、识别永远不结束」——静默失败比报错难查一万倍。
 */
async function patchTask(t, data) {
  const payload = Object.assign({ updatedAt: new Date() }, data)
  const res = await db.collection(COL.aiTask).doc(t._id).update({ data: payload })
  const updated = res && res.stats && res.stats.updated
  if (updated !== 1) {
    let size = 0
    try { size = JSON.stringify(payload).length } catch (e) {}
    console.error('[vision] 任务字段更新未生效', t._id, 'step=' + (t.step || ''),
      'payload=' + size + 'B', 'stats=' + JSON.stringify(res && res.stats))
  }
  return res
}

/** 关键步骤的写入校验：没写进去就抛，让 poll 释放租约下轮重试，绝不当成功继续往下走 */
function assertWrote(res, what) {
  const updated = res && res.stats && res.stats.updated
  if (updated !== 1) throw new AppError('任务进度写入未生效(' + what + ')', 500)
}

/** 释放租约：把任务退回 pending，让下一轮轮询（或下一个请求）接着干 */
async function releaseLease(t, err) {
  const data = { status: 'pending', leaseUntil: null, updatedAt: new Date() }
  if (err) data.lastError = err.message || ''
  await patchTask(t, data)
}

/** 视频的「计划抽帧数」；真抽帧在容器化服务端做，云函数只传参 */
function frameCount(t) {
  return (t.type === 'video')
    ? Math.max(1, Math.min(MAX_FRAMES, Math.ceil((Number(t.duration) || 8) / 2)))
    : 1
}

/**
 * 推进一个步骤。返回 { finished, result?, deferred?, progress }。
 *
 * 步骤（task.step）：
 *   ''     待做内容安全（downloadFile + imgSecCheck，最慢的一步）
 *   'sec'  安全已过，待换临时链接（url/videoUrl）
 *   'cats' 待提特征 + 检索 + 组装结果（AI 或本地降级）
 *
 * ctx = { deadline }：poll 路径必须传。剩余预算不够完成本步就返回 { deferred: true }，
 *   由 poll 释放租约并返回 pending，下一轮轮询继续 —— 已落库的产物不丢。
 *   不传 ctx（run/runSync 同步路径）则不受 3s 预算约束，AI 可等满 AI_TIMEOUT_MS。
 */
async function advance(user, t, ctx) {
  const deadline = (ctx && ctx.deadline) ? ctx.deadline : Infinity
  const left = () => deadline - Date.now()
  const step = t.step || ''
  const partial = t.partial || {}
  const type = t.type || 'image'
  const schoolId = t.schoolId || ''
  // 视频优先用封面帧；真抽帧需容器化 ffmpeg，此处保留计划帧数
  const mediaId = (type === 'video' && t.thumbId) ? t.thumbId : t.fileId
  const frames = frameCount(t)

  // ① 内容安全（最慢的一步：downloadFile 下载整图 + imgSecCheck 往返）
  if (step === '') {
    // 余量不足就别开工：checkImage 内部不可中断，硬做只会整次调用被 3s 预算打断，
    // 这一步白干、下轮从头再来（27 轮全超时就是这么来的）。
    if (left() < SEC_RESERVE_MS) return { deferred: true }
    const secTries = Number(partial.secTries) || 0
    let imgOk
    if (secTries >= SEC_SYNC_TRIES) {
      // 同步检测连续几轮都没能把步骤落库（大图下载慢/接口抖动）：
      // 降级成异步送检（提交即放行），保证这一步一定能收敛 —— 识别可以等，不能无限重跑。
      console.warn('[vision] 同步安全检测连续未完成，降级异步送检', mediaId)
      await sec.checkMediaAsync(mediaId, type === 'video' ? 'video' : 'image')
      imgOk = true
    } else {
      imgOk = await sec.checkImage(mediaId)
    }
    if (!imgOk) throw new AppError('素材未通过安全检测', 400)
    if (type === 'video') await sec.checkMediaAsync(t.fileId, 'video')
    const r = await patchTask(t, {
      step: 'sec',
      progress: 30,
      partial: Object.assign({}, partial, { sec: true, secTries: secTries + 1 })
    })
    assertWrote(r, 'sec-check')
    return { finished: false, progress: 30 }
  }

  // ② 换临时链接（toTempUrl ×1~2 + 一次写入，轻）
  //    ⚠️ partial 只存 url/videoUrl 这类小字段。早期版本把整库 catsLite
  //    （200 只猫各带一条 embedding，轻松上 MB）塞进 partial 一起 update：
  //    单文档体积越过云数据库上限后 update 静默失败 → step 永远停在 'sec'，
  //    每轮轮询重跑「拉全库 + 换一堆临时链接 + 写大文档」，必然超 3s 且永不收敛。
  //    档案改为用时现读（loadCatsLite / loadCatsFull），partial 保持轻量。
  if (step === 'sec') {
    if (left() < URL_RESERVE_MS) return { deferred: true }
    const url = await toTempUrl(mediaId)
    // 视频本体链接交给自建服务做真抽帧（云函数内没有 ffmpeg，做不了）
    const videoUrl = type === 'video' ? await toTempUrl(t.fileId) : ''
    const r = await patchTask(t, {
      step: 'cats',
      progress: 55,
      partial: Object.assign({}, partial, { url, videoUrl })
    })
    assertWrote(r, 'temp-urls')
    return { finished: false, progress: 55 }
  }

  // ③ 特征提取 + 检索 + 组装：优先第三方识别服务；失败可重试，达上限才降级本地引擎
  if (step === 'cats') {
    // 轻量读一次档案：远程候选靠它回表补 name/avatar，本地兜底匹配也用它
    const catsLite = await loadCatsLite(schoolId)
    const byId = {}
    catsLite.forEach(c => { byId[c.id] = c })

    // 增量补库：给「档案里标记未入库」的猫附上照片链接，
    // 服务端 ensure_index 会在本次检索前把它们算进特征库 —— 新猫建档后无需手动建库。
    // 预算不足 / 换链接失败都静默跳过：这是优化，绝不能拖累本次识别。
    const pendingPhotos = await attachPendingPhotos(catsLite, ctx)

    let features = null
    let remoteCandidates = null
    let provider = 'local'
    const endpoint = process.env.AI_ENDPOINT
    const featFails = Number(partial.featFails) || 0
    const aiAttempts = Number(partial.aiAttempts) || 0
    const pollPath = !!(ctx && ctx.deadline)
    if (endpoint && featFails < FEAT_FALLBACK_ATTEMPTS && aiAttempts < MAX_AI_ATTEMPTS) {
      // poll 路径：AI 超时单独封顶，且随剩余预算收缩 —— 整次调用必须在 3s 内返回。
      // 同步路径没有 3s 限制，可以用满 AI_TIMEOUT_MS（慢服务靠它出真实匹配）。
      const aiCap = pollPath
        ? Math.min(Number(process.env.AI_POLL_TIMEOUT_MS) || AI_POLL_CAP_MS, AI_POLL_CAP_MS)
        : (Number(process.env.AI_TIMEOUT_MS) || 8000)
      const aiTimeout = pollPath
        ? Math.max(300, Math.min(aiCap, left() - AI_RESERVE_MS))
        : aiCap
      if (aiTimeout < 500) return { deferred: true }
      try {
        const raw = await callVisionApi(endpoint, {
          url: partial.url, videoUrl: partial.videoUrl, fileId: mediaId,
          type, frames, schoolId,
          // 服务端 search() 用请求里的 cats 补 name/avatar。
          // ⚠️ 默认只送轻量字段：带照片链接会让服务端 ensure_index 去下载，
          // 200 只猫时必然拖过 3s 预算（一场「全轮询超时」事故的帮凶）。
          // 唯一的例外是 pendingPhotos —— 只给极少量未入库的新猫带（见 attachPendingPhotos）。
          cats: catsLite.map(c => ({
            id: c.id, name: c.name, pattern: c.pattern, color: c.color,
            photos: pendingPhotos[c.id] || []
          }))
        }, aiTimeout)
        if (raw && raw.features) {
          features = normalizeFeatures(raw.features)
          if (Array.isArray(raw.candidates)) remoteCandidates = raw.candidates
          provider = 'custom'
          // 服务端已在检索前完成 ensure_index，这里乐观记账，避免下轮重复携带
          markIndexed(Object.keys(pendingPhotos))
        }
      } catch (e) {
        const isTimeout = !!(e && e.message === '识别接口超时')
        const attempts = aiAttempts + 1
        const fails = isTimeout ? featFails : featFails + 1
        console.error('[vision] 识别接口第 ' + attempts + ' 次失败' +
          (isTimeout ? '（超时，下轮重试）' : '（明确错误）'), e && e.message)
        const giveUp = attempts >= MAX_AI_ATTEMPTS || (!isTimeout && fails >= FEAT_FALLBACK_ATTEMPTS)
        const r = await patchTask(t, {
          partial: Object.assign({}, partial, { aiAttempts: attempts, featFails: fails })
        })
        assertWrote(r, 'ai-fail')
        if (giveUp) {
          console.error('[vision] 识别接口不可用，下轮转本地引擎')
          // 不在本轮流降级：预算已经花在 AI 上了，下轮轻装走本地兜底
          return { finished: false, progress: 55 }
        }
        // 可重试：抛给 poll 退回 pending，下次轮询再试（url 等产物已在 partial，不重跑前面步骤）
        throw e
      }
    }
    if (!features) features = localFeatures(mediaId, type)

    // ④ 检索 + 组装：远程候选优先，否则本地兜底匹配
    let list
    if (remoteCandidates && remoteCandidates.length) {
      list = remoteCandidates
    } else {
      // 兜底路径才读全量（含 embedding）—— 平时不读，省一次 DB 往返和流量
      const full = await loadCatsFull(schoolId)
      list = match(features, full, t.location)
      full.forEach(c => { if (!byId[c.id]) byId[c.id] = c })
    }
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

    const result = {
      requestId: 'rc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      provider,
      type,
      frames,
      // 分步执行后单步耗时没意义了，记「建任务 → 出结果」的总耗时
      latency: t.createdAt ? Math.max(0, Date.now() - new Date(t.createdAt).getTime()) : 0,
      features,
      candidates,
      threshold: LOW_CONF,
      lowConfidence: !candidates.length || candidates[0].score < LOW_CONF,
      // 合规：不再下发内部实现说明（旧文案含 AI_ENDPOINT 等字样）。
      // 低置信提示统一由前端在「匹配候选」卡里按 lowConfidence 渲染。
      notice: provider !== 'local' && candidates.length && candidates[0].score < LOW_CONF
        ? '匹配置信度偏低，请人工确认或新建档案。'
        : ''
    }
    const r = await patchTask(t, { status: 'done', step: 'done', progress: 100, result, finishedAt: new Date() })
    assertWrote(r, 'done')
    return { finished: true, result }
  }

  throw new AppError('未知任务步骤: ' + step, 500)
}

/**
 * 兼容出口：同步跑完所有步骤（runSync / 管理调试用）。
 * 生产路径是「start + poll 分步推进」或「recognize 同步一把梭」；
 * 这里循环 advance 直到收敛，单次云函数调用内完成。
 *
 * @param {Object} [ctx] { deadline } —— 同步快路径传入「云函数自己的截止时间」
 *   （符号见 runSync 的函数头：它不是客户端的 3s，而是 SYNC_BUDGET_MS）。
 *   作用只有两个，都为了「客户端 3s 放弃后，轮询能少干活」：
 *     1) AI 单次超时随剩余预算收缩，别拿着 AI_TIMEOUT_MS（8~20s）一头撞上 action 超时；
 *     2) 预算真的见底时（defer / 已过 deadline）主动交还，而不是被平台掐断 ——
 *        掐断会让**这一步**白干，主动交还则保证已完成步骤全部落库。
 *   不传 ctx（管理端 / 老调用方）→ 预算无限，行为与历史完全一致。
 */
async function run(user, t, ctx) {
  const deadline = (ctx && ctx.deadline) ? ctx.deadline : Infinity
  const syncCtx = (ctx && ctx.deadline) ? { deadline } : undefined
  let guard = 0
  while (guard++ < 10) {
    const cur = (await db.collection(COL.aiTask).doc(t._id).get()).data
    if (!cur) throw new AppError('任务不存在', 404)
    if (cur.status === 'done') return cur.result
    if (cur.status === 'failed') throw new AppError(cur.error || '识别失败')
    const r = await advance(user, cur, syncCtx)
    if (r.finished) return r.result
    // 步骤之间也看一眼：上一步刚收尾、剩余预算已被它吃光时才 defer，
    // 下一轮 while 里的 get 会白花一次往返（还可能把响应顶穿）。
    if (r.deferred || (syncCtx && Date.now() > deadline)) {
      throw new AppError('识别同步路径预算不足，已转轮询接管', 409)
    }
  }
  throw new AppError('识别步骤未收敛', 500)
}

/* ==================== 同步 / 异步任务 ==================== */

/** 建任务（不执行） */
async function start(user, event) {
  const type = event.type === 'video' ? 'video' : 'image'
  const fileId = event.fileId
  if (!fileId) throw new AppError('缺少素材 fileId')
  const doc = {
    openid: user.openid,
    _openid: user.openid,
    schoolId: event.schoolId || user.schoolId || '',
    type,
    fileId,
    thumbId: event.thumbId || '',
    duration: Number(event.duration) || 0,
    location: event.location || null,
    status: 'pending',
    step: '',           // 分步续跑进度：'' → 'sec' → 'cats' → 'done'
    partial: {},        // 各阶段产物（只放 url/videoUrl 这类小字段 + 重试计数）
    progress: 0,
    attempts: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  }
  // 集合自愈：ai_tasks 是后期新增的集合，控制台漏建时首次识别就会
  // 报 `-502005 database collection not exists`。
  // ⚠️ 必须 warm（后台发起、不 await）——这是识别热路径，
  // await 一次建表往返（300~500ms）会直接把 recognize 顶穿客户端 3s 调用预算。
  // 根治办法是部署后调一次 `initCollections`，这里只是兜底。
  warmCollection(COL.aiTask)
  const add = await db.collection(COL.aiTask).add({ data: doc })
  return { taskId: add._id, status: 'pending', type }
}

/**
 * 同步执行（客户端 `recognize` action；兼容无 taskId 的旧调用方）。
 *
 * 两种用法：
 *  a) 传 taskId（生产路径）：复用 recognizeStart 已建好的任务，抢到租约就开跑。
 *      整条链路约 2~3s（服务温热时）能直接出结果，不用轮询 —— 这就是改动前的体验。
 *  b) 不传 taskId（兼容旧调用方）：自己建任务再跑。
 *
 * 超时由客户端兜底：本调用超过约 3s 预算会报 -504003，客户端转轮询接管 ——
 * 每一步的产物都已落库（task.step / task.partial），轮询从断点继续，不重跑前面步骤。
 *
 * ⚠️ 失败分类：只有「素材未通过安全检测」这类明确业务错误（400）才置 failed；
 * 网络抖动/AI 超时一律不置 failed —— 任务保持 running，租约到期后由轮询接续跑。
 * （早期版本在这里一律置 failed，一次抖动就把任务判死，轮询只能返回失败。）
 *
 * @param {Object} [ctx] { startedAt, deadline } —— 客户端同步快路径必须传。
 *
 * 【同步路径的预算该怎么定】（2026-10-15 定案）
 *   先想清楚客户端的行为：`wx.cloud.callFunction` 约 3s 硬预算，超时抛 -504003，
 *   而 recognize.js 收到 -504003 后会**转轮询接管**（这是设计好的，不是故障）。
 *   所以同步路径的正确目标不是「抢在 3s 前交还」，而是：
 *
 *     「尽量在 3s 内一把出结果；来不及就让它超时，但**已完成的步骤必须全部落库**，
 *       好让轮询从断点接续、不重跑前面。」
 *
 *   于是预算不能沿用 poll 的 POLL_BUDGET_MS=2400 —— 那是为「一次调用只推进一步」定的。
 *   同步路径要串完三步，固定开销实测就 ≈2.4~2.6s（三次读任务 + 内容安全下载/送检 +
 *   换链 + 读档案 + 三次写库）。用 2400 卡它，结果是每一步刚开工就被 defer 掉、
 *   白花几十毫秒的往返后直接 409，**连第一步都做不完**（回归台 S1/S4 当场全红）。
 *
 *   所以同步路径用 SYNC_BUDGET_MS（默认远大于 3s），语义是「云函数自己能跑多久」，
 *   而不是「客户端愿等多久」。客户端 3s 放弃时任务仍在 running，轮询接着干 ——
 *   这正是改动前就有的行为，也是「超时不是失败」注释里写的设计。
 *   唯一要防的是**被平台按 action 超时掐断**（默认 15s），故留 PLATFORM_RESERVE_MS 余量。
 */
const SYNC_BUDGET_MS = 12000
/** 同步路径给平台收尾留的余量（响应序列化 + SDK 上传），别贴着 action 超时跑 */
const PLATFORM_RESERVE_MS = 1500

async function runSync(user, event, ctx) {
  let taskId = event.taskId
  if (taskId) {
    const own = await db.collection(COL.aiTask).doc(taskId).get()
    const cur = own && own.data
    if (!cur) throw new AppError('任务不存在', 404)
    if ((cur.openid || cur._openid) !== user.openid) throw new AppError('无权访问该任务', 403)
    if (cur.status === 'done') return Object.assign({}, cur.result, { taskId })
    if (cur.status === 'failed') throw new AppError(cur.error || '识别失败')
  } else {
    const started = await start(user, event)
    taskId = started.taskId
  }

  // 条件抢租约：只有 pending 的任务能被我拿走，避免和轮询请求撞车
  const up = await db.collection(COL.aiTask)
    .where({ _id: taskId, status: 'pending' })
    .update({
      data: {
        status: 'running',
        leaseUntil: new Date(Date.now() + LEASE_SYNC_MS),
        attempts: _.inc(1),
        updatedAt: new Date()
      }
    })
  const got = up && up.stats && up.stats.updated > 0
  if (!got) {
    // 租约在别人手里（理论上只有轮询会先拿到）：让客户端转轮询
    const cur = (await db.collection(COL.aiTask).doc(taskId).get()).data || {}
    if (cur.status === 'done') return Object.assign({}, cur.result, { taskId })
    if (cur.status === 'failed') throw new AppError(cur.error || '识别失败')
    throw new AppError('任务正在处理中', 409)
  }

  try {
    const t = (await db.collection(COL.aiTask).doc(taskId).get()).data
    // 同步快路径的预算 = 「云函数自己能跑多久」，不是「客户端愿等多久」（见函数头注释）。
    // startedAt 由云函数入口传入（含冷启动 + getMe 的前置开销），据此算截止。
    // 客户端会在约 3s 处放弃并转 -504003 → 轮询接管，
    // 而这里继续把每一步跑完并落库，让轮询从断点接续（而不是从零重跑）。
    const syncCtx = (ctx && ctx.startedAt)
      ? { deadline: ctx.startedAt + SYNC_BUDGET_MS - PLATFORM_RESERVE_MS }
      : undefined
    const result = await run(user, t, syncCtx)
    await db.collection(COL.aiTask).doc(taskId).update({
      data: { status: 'done', progress: 100, result, finishedAt: new Date(), updatedAt: new Date() }
    }).catch(() => {})
    return Object.assign({}, result, { taskId })
  } catch (e) {
    const isFinal = e instanceof AppError && Number(e.code) === 400
    if (isFinal) {
      await db.collection(COL.aiTask).doc(taskId).update({
        data: { status: 'failed', progress: 100, error: e.message || '识别失败', finishedAt: new Date(), updatedAt: new Date() }
      }).catch(() => {})
    } else {
      // 可重试错误：不置 failed，留着 running + 租约，轮询到期后接续
      await db.collection(COL.aiTask).doc(taskId).update({
        data: { lastError: e.message || '', updatedAt: new Date() }
      }).catch(() => {})
    }
    throw e
  }
}

/**
 * 轮询（分步推进版）
 * 租约机制：只有把 pending 改成 running 的那个请求才推进一个步骤，
 * 其它并发轮询直接返回「处理中」，避免重复调用第三方接口烧钱。
 *
 * 预算纪律（本函数的生存线）：整次调用必须在 POLL_BUDGET_MS 内返回。
 *  - 基础往返太慢 → 直接回 pending，不抢租约不干活；
 *  - 步骤余量不足 → advance 返回 deferred，释放租约下轮再来；
 *  - 每一步成功即落库，被打断也不丢；写未生效会抛错重试，绝不静默。
 */
async function poll(user, event, ctx) {
  const taskId = event.taskId
  if (!taskId) throw new AppError('缺少 taskId')
  // ⚠️ 预算必须从「调用入口」（ctx.startedAt）起算，而不是从本函数起算：
  // 云函数冷启动（加载 node_modules）和 getMe() 的 DB 往返都发生在 poll() 之前，
  // 从 handler 内部起算的 2.4s 加上这些前置开销就顶穿了客户端约 3s 的硬预算。
  // 用入口时间起算后：前置慢 → 剩余预算自然变小 → 早退 pending，不再硬干活。
  const t0 = (ctx && ctx.startedAt) || Date.now()
  const deadline = t0 + POLL_BUDGET_MS
  const res = await db.collection(COL.aiTask).doc(taskId).get()
  const t = res.data
  if (!t) throw new AppError('任务不存在', 404)
  if ((t.openid || t._openid) !== user.openid) throw new AppError('无权访问该任务', 403)

  if (t.status === 'done' || t.status === 'failed') {
    return { taskId, status: t.status, progress: 100, result: t.result || null, error: t.error || '' }
  }

  // 基础往返（getMe + 读任务）就花掉大半预算：直接回 pending 下轮再来。
  // 慢雾/冷启动环境下保命用 —— 正常情况下这永远不会触发。
  if (Date.now() - t0 > BASE_RESERVE_MS) {
    return { taskId, status: t.status, progress: t.progress || 40, result: t.result || null }
  }

  // 回收过期租约（上一个执行者被 3s 预算打断的情况）。
  // ⚠️ 只在内存态确有过期租约时才发这次更新 —— 无脑发一遍是白扔一次 DB 往返，
  // 而识别轮询全程都在跟 3s 预算赛跑。
  const leaseUntil = t.leaseUntil ? new Date(t.leaseUntil).getTime() : 0
  if (t.status === 'running' && leaseUntil && leaseUntil < Date.now()) {
    await db.collection(COL.aiTask)
      .where({ _id: taskId, status: 'running', leaseUntil: _.lt(new Date()) })
      .update({ data: { status: 'pending', updatedAt: new Date() } })
      .catch(() => {})
  }

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
    // 租约在别的调用手里：它的状态可能已经前进，必须重读一次再回
    const cur = (await db.collection(COL.aiTask).doc(taskId).get()).data || {}
    return { taskId, status: cur.status, progress: cur.progress || 40, result: cur.result || null }
  }

  // 租约已到手：任务的其余字段不会被别人改（每步只在本调用里跑），
  // 直接在内存里拼 fresh，省掉一次 get 往返。
  const fresh = Object.assign({}, t, {
    status: 'running',
    leaseUntil: new Date(Date.now() + LEASE_MS),
    attempts: (Number(t.attempts) || 0) + 1
  })

  try {
    const r = await advance(user, fresh, { deadline })
    if (r.deferred) {
      // 预算不够做完这一步：释放租约下轮再来，已完成阶段的产物不丢
      await releaseLease(fresh)
      return { taskId, status: 'pending', progress: fresh.progress || 40 }
    }
    if (r.finished) {
      return { taskId, status: 'done', progress: 100, result: r.result }
    }
    // 本步骤完成、还有下一步：退回 pending 等下轮。进度取本步写入值，无需再读一次库
    await releaseLease(fresh)
    return { taskId, status: 'pending', progress: r.progress != null ? r.progress : (fresh.progress || 40) }
  } catch (e) {
    // 终局错误（如素材未过安全检测）才置 failed；其余一律可重试
    const isFinal = e instanceof AppError && Number(e.code) === 400
    if (isFinal) {
      await patchTask(fresh, { status: 'failed', progress: 100, error: e.message || '识别失败', finishedAt: new Date() })
      return { taskId, status: 'failed', progress: 100, error: e.message || '识别失败' }
    }
    console.warn('[vision] 步骤失败，退回 pending 等待重试', e && e.message)
    await releaseLease(fresh, e)
    return { taskId, status: 'pending', progress: fresh.progress || 40, error: e && e.message }
  }
}

/**
 * 人工确认 —— 人机协同闭环
 * 每次确认 = 一条标注样本（写入 ai_samples，用于后续攒训练集）。
 *
 * ⚠️ 2026-10-15 调整：**确认时不再把本次识别特征写进该猫特征库**。
 *   旧实现在 correct && catId 时把 result.features.embedding 回写进 cats.embedding
 *   （即「建特征库」），前端会提示「已计入特征库」。但识别照片来自用户随手拍，
 *   质量/角度不可控，直接当标准照入库会污染特征库、拉低后续识别准确率。
 *   现在只留标注样本（ai_samples）+ 图鉴解锁，特征库仍只由建档照片（及管理员手动建库）产生。
 *   返回字段保留 embeddingWritten（恒 false），兼容老客户端文案判断。
 */
async function confirm(user, event) {
  const { taskId, catId, correct } = event
  if (!taskId) throw new AppError('缺少 taskId')
  const res = await db.collection(COL.aiTask).doc(taskId).get()
  const task = res.data
  if (!task) throw new AppError('任务不存在', 404)
  if ((task.openid || task._openid) !== user.openid) throw new AppError('无权操作该任务', 403)
  // 幂等：一个任务只确认一次。客户端 cloud.callFunction 约 3s 预算，超时重试、
  // 或对「不是这只猫」反复点，都会重复调本 action —— 不拦的话每次都白赚 5 分。
  if (task.confirmed) {
    return { ok: true, pointsGained: 0, duplicated: true }
  }

  const result = task.result || {}
  const topCatId = (result.candidates && result.candidates[0] && result.candidates[0].catId) || ''

  warmCollection(COL.aiSample)   // 同 ai_tasks：只后台发起，不阻塞确认请求
  await db.collection(COL.aiSample).add({
    data: {
      openid: user.openid,
      _openid: user.openid,
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

  // 不再回写特征库（见函数头注释）。embeddingWritten 恒 false，仅作老客户端兼容。
  const embeddingWritten = false
  if (correct && catId) {
    // 仍解锁图鉴：确认过 = 见过这只猫（与特征库无关，属用户侧收藏）
    const seen = user.catSeen || []
    if (seen.indexOf(catId) < 0) {
      await db.collection(COL.user).doc(user._id).update({ data: { catSeen: _.push([catId]) } })
    }
  }

  const g = await points.grant(user, 'confirm', null, { refType: 'ai_task', refId: taskId })
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
 * 为什么要单独做这一步：识别热路径只带极少量新猫的照片（预算所限），
 * 批量建档、或识别服务曾经不可用时，用它一次性补齐。
 *
 * 幂等设计：默认只补「服务端特征库里没有」的猫（onlyMissing=true），
 * 已入库的连照片都不下载，所以每天跑一次的成本 ≈ 只建当天新增的猫。
 * 需要整体重建（改名 / 换照片 / 清库后）时显式传 force=true。
 *
 * ⚠️ 这是管理端重活（换几百个临时链接 + 服务端算向量），别在识别轮询里等它；
 * 客户端手动调用同样受约 3s 预算限制，超时属正常 —— 定时任务才是它的主场。
 */
async function buildIndex(user, event) {
  const endpoint = process.env.AI_ENDPOINT
  if (!endpoint) throw new AppError('未配置 AI_ENDPOINT', 400)

  const schoolId = event.schoolId || user.schoolId || ''
  const photosPerCat = Math.max(1, Math.min(10, Number(event.photosPerCat) || 6))
  // force 优先：整体重建时忽略「已入库」判断
  // 老版本 build_index.py 脚本不带这两个字段，默认行为是全量重算（与历史一致）
  const onlyMissing = event.force !== true && event.onlyMissing === true
  // 建库是重活，服务端要下载并编码几百张图；默认超时比识别长得多。
  // 定时任务会把「本次剩余预算」直接传进来，尽量一次多建几只。
  const buildTimeout = Math.max(3000, Number(event.timeoutMs)
    || Number(process.env.AI_INDEX_TIMEOUT_MS) || 20000)
  // catIds：只建指定的猫（建档后自动建库）。不传 = 全校扫描（定时任务 / 手动全量）
  const cats = await index(schoolId, { photosPerCat, catIds: event.catIds })

  const buildUrl = String(endpoint).replace(/\/v1\/recognize\/?$/, '/v1/index/build')
  if (buildUrl === String(endpoint)) {
    throw new AppError('AI_ENDPOINT 需以 /v1/recognize 结尾，才能推导建库地址', 400)
  }

  const res = await callVisionApi(buildUrl, {
    schoolId,
    photosPerCat,
    onlyMissing,
    force: event.force === true,
    cats: cats.map(c => ({
      id: c.id, name: c.name, pattern: c.pattern, color: c.color, photos: c.photosUrl
    }))
  }, buildTimeout)

  // 记账：除服务端明确失败的猫外，其余都视为已入库 —— 下轮识别不再重复携带照片。
  // 失败的猫保持未记账，定时任务（全量 + onlyMissing）会持续重试直到成功。
  const failed = (res && res.failed) || []
  markIndexed(cats.map(c => c.id).filter(id => failed.indexOf(id) < 0))

  return {
    ok: true,
    schoolId,
    scanned: cats.length,
    built: res && res.built,
    failed,
    skipped: (res && res.skipped) || 0,
    indexed: res && res.total
  }
}

/**
 * 建档 / 改档后的「自动入库」：只建这一只猫，且**绝不抛错**。
 *
 * 为什么不直接复用 buildIndex：建档是主流程，识别服务没配、挂了、慢了，
 * 都绝不能连累「档案保存成功」这件事 —— 这是本函数存在的唯一理由。
 *
 * 失败就保持 aiIndexAt 为空，兜底有两条：
 *   A 识别热路径（pickPendingIndexCats）会在第一次识别时顺手补；
 *   B 每天 03:00 定时全量（aiIndexDaily）会持续重试直到成功。
 *
 * ⚠️ 预算：只带 1 只猫 ≤3 张照片，服务端下载 + 编码通常 1~2s，
 * 超时上限硬压在 2.2s —— 客户端 callFunction 只有约 3s，不能赌。
 */
async function buildIndexAuto(user, event) {
  const e = event || {}
  const ids = (Array.isArray(e.catIds) ? e.catIds : []).filter(Boolean)
  if (!ids.length) return { ok: true, deferred: true, msg: '未指定猫' }
  try {
    return await buildIndex(user, {
      schoolId: e.schoolId,
      catIds: ids.slice(0, 3),
      photosPerCat: Math.max(1, Math.min(3, Number(e.photosPerCat) || 2)),
      onlyMissing: true,
      timeoutMs: Math.max(800, Math.min(2200, Number(e.timeoutMs) || 2000))
    })
  } catch (err) {
    // 静默降级：让建档照常成功，未入库的猫交给 A/B 兜底
    console.warn('[vision] 建档后自动入库未当场完成，交给定时任务兜底', err && err.message)
    return { ok: false, deferred: true, msg: (err && err.message) || '入库延后' }
  }
}

/**
 * 全量建库：遍历所有校区逐个建库（定时触发器 / 管理员手动）。
 *
 * 为什么分片推进：一个校区几百只猫要换成百上千个临时链接，服务端还要逐张下载算向量，
 * 一次性做完必然越过云函数超时。这里带总 deadline，处理到哪算哪 ——
 * 下次触发接着建，服务端 onlyMissing 保证已完成的不重算，最终会收敛。
 *
 * 单校失败不影响其他校区（try/catch 逐校兜底）。
 *
 * @param {Object} opts { budgetMs, photosPerCat, maxSchools }
 */
async function buildIndexAll(opts) {
  const o = opts || {}
  const started = Date.now()
  // 默认 15s：云函数控制台超时常见默认值是 20s，留足收尾余量。
  // 把云函数超时调到 60s 后，可配 AI_INDEX_TIME_BUDGET_MS=45000 一次建更多。
  const budget = Math.max(2000, Number(o.budgetMs)
    || Number(process.env.AI_INDEX_TIME_BUDGET_MS) || 15000)
  const deadline = started + budget
  const photosPerCat = Math.max(1, Math.min(10, Number(o.photosPerCat) || 6))
  const maxSchools = Math.max(1, Number(o.maxSchools) || 200)
  // force=true → 忽略「服务端已有」判断，全部重算（特征库被清空后的恢复手段）。
  // 增量模式下若服务端特征库丢失，云函数侧的 aiIndexAt 仍会让这些猫被跳过，
  // 所以「全部重算」这个后门必须存在。
  const force = o.force === true

  const sres = await db.collection(COL.school).limit(maxSchools).get()
    .catch(e => {
      console.error('[vision] 读取校区列表失败', e && e.message)
      return { data: [] }
    })
  const schools = (sres.data || []).filter(s => s && s._id)

  // 系统身份：定时触发器没有 OPENID，建库是管理端动作，直接用 admin 语义执行
  const sysUser = { openid: '__system__', role: 'admin', schoolId: '' }

  const results = []
  let built = 0
  let skipped = 0
  let timedOut = false

  for (let i = 0; i < schools.length; i++) {
    // 预留 1.5s 收尾：宁可少建一个校区，也不要整次调用被平台掐断
    if (Date.now() > deadline - 1500) { timedOut = true; break }
    const sid = schools[i]._id
    try {
      const r = await buildIndex(sysUser, {
        schoolId: sid, photosPerCat,
        onlyMissing: !force,
        force,
        // 把本次剩余预算交给建库请求：默认 20s 可能超过云函数自身超时，
        // 这里按实际剩余时间收敛，保证不会因单次建库超时而整批失败
        timeoutMs: Math.max(3000, deadline - 1500 - Date.now())
      })
      built += r.built || 0
      skipped += r.skipped || 0
      results.push({
        schoolId: sid, ok: true,
        scanned: r.scanned, built: r.built, skipped: r.skipped, indexed: r.indexed,
        // 失败明细透传给管理页：failed = 照片下载/算向量失败的猫（下轮会重试）。
        // 不透传的话「建成0只」分不清是没猫、没照片还是全失败（线上排查踩过）。
        failedCount: (r.failed || []).length,
        failedSample: (r.failed || []).slice(0, 3)
      })
    } catch (e) {
      const msg = (e && e.message) || '建库失败'
      console.error('[vision] 校区建库失败', sid, msg)
      results.push({ schoolId: sid, ok: false, error: msg })
    }
  }

  return {
    startedAt: new Date(started),
    elapsed: Date.now() - started,
    schools: schools.length,
    processed: results.length,
    built,
    skipped,
    timedOut,
    // 本次预算耗尽时留下「还没轮到」的校区，便于运维判断是否需要加大预算
    pendingSchools: timedOut ? schools.slice(results.length).map(s => s._id) : [],
    results
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
    return ((t + (t >>> 14)) >>> 0) / 4294967296
  }
}

module.exports = {
  runSync, start, poll, confirm, run, index, buildIndex, buildIndexAuto, buildIndexAll,
  scoreCat, match, TOP_N, LOW_CONF,
  pickPendingIndexCats, PENDING_INDEX_MAX
}
