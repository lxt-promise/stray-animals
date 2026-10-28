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

/**
 * 候选列表最多几条（2026-10-25 由 5 改成 2）。
 *
 * 必须与服务端 `config.TOP_N` 同值 —— 两边各写一个数字的后果是：
 * 服务端返回 2 条、本地降级路径返回 5 条，界面上候选数量随引擎状态跳变，
 * 排查时根本看不出是「库里猫多」还是「口径不一致」。
 * 这里用注释锁定同源关系，改动时两边一起改。
 *
 * 为什么是 2 而不是 5：
 *  - 候选是让用户**二选一**的。第 3 名往后的展示分基本是个位数（余弦已贴着
 *    MIN_SIM 匹配线），「3% 的可能是它」对用户没有任何决策价值。
 *  - 候选越多，Top1 越被稀释：领先幅度（lead）被低分候选拉平，
 *    「为什么分这么低」反而更难诊断。
 *  - 少了两条候选，每轮轮询的报文也小一点（候选要带 name/avatar/rawSim 等字段）。
 */
const TOP_N = 2
/**
 * 低于该分数视为低置信，只提示「可能是」，不硬判。
 *
 * 必须与服务端 `config.IDENTIFY_MIN` 同口径（同一把尺子量出来的分数）。
 * 2026-10-24 校准改动后两者都定在 45：老的 55 配上老的线性窗口，
 * 等价于「余弦 ≥ 0.83 才算认出来」，而现场同一只猫的另一张照片只有 0.763 ——
 * 结果是**排序对了、分数 9%、还判定「没认出来」**（见服务端 SIM_MID 的推导）。
 */
const LOW_CONF = 45
/**
 * 每只猫参与建库的**最大视图数**（8 张）= 档案照 + 人工确认样本合并去重后的总上限。
 *
 * 为什么要把相册里的照片全用上：代表向量是「多张取 medoid + 内点平均」，同一只猫的
 * 正面/侧面/不同光线会被抹平一部分。只用 1~2 张时，一张糊图或一张背影就足以决定
 * 这只猫的全部特征 —— 表现就是「档案里明明有 5 张，识别却总匹配不上」。
 *
 * 为什么是 8 而不是 5 / 20：
 *  - 收益曲线是明显递减的。1→3 张提升最大（覆盖正脸/侧脸/逆光三种常态）；
 *    3→8 张继续小幅提升（补上少见角度）；>8 张基本不再涨。
 *  - 服务端 `rep_vector` 只保留 ceil(n*0.7) 条内点：n=8 时取 6 条，已经足够让
 *    medoid 稳定；再多也只是把同样的内点多平均几遍。
 *  - 成本是线性的：每张图要下载 + 编码（实测 400~600ms），8 张 ≈ 4s/只。
 *    建库是离线动作，但这直接决定一次云函数调用能建几只猫。
 *  - 数量再多还有副作用：相册里混进「拍糊了 / 拍的是旁边另一只」的概率随张数上升，
 *    medoid 能扛住 1~2 张离群点，扛不住一堆。
 *
 * 8 是「收益 / 耗时 / 污染风险」的折中。改这里只影响建库，不影响检索协议。
 */
const INDEX_PHOTOS = 8
/**
 * 建档 / 改档后**自动**入库的视图数（5 张）。
 *
 * 为什么比 INDEX_PHOTOS 小：那条路径挂在「保存档案」的主流程上，
 * 云函数超时上限 2.2s、且必须永不抛错。8 张 × 500ms 必然超时，
 * 而超时 = 本次一只都没建成（服务端没机会写盘），反而不如少带几张先落库，
 * 剩下的交给后台「用确认样本建库」或每天凌晨的全量任务补齐。
 */
const INDEX_PHOTOS_AUTO = 5
/** photosPerCat 的硬上限（防管理端传进离谱的值把建库拖死） */
const INDEX_PHOTOS_MAX = 12
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
 * 从云存储临时链接**反推 cloud fileID**（2026-10-24 重建特征库遇 403 的解法）。
 *
 * 现场：重建特征库时部分猫下载 403 —— 档案库里存的不是 `cloud://` fileID，
 * 而是某个历史版本写进去的 https 临时链接（`?sign=...&t=...`，有效期若干小时）。
 * 建库时 attachTempUrls 只对 `cloud://` 换链，这类链接被原样透传给服务端，
 * 于是「当时存进去能看，几小时后全部 403」，而且**再也换不回来**。
 *
 * 好在临时链接保留了存储路径：
 *   https://<bucket>.tcb.qcloud.la/cats/123.jpg?sign=...
 *   其中 fileID 形如 cloud://<env>.<bucket>/cats/123.jpg
 * 而 `<env>.<bucket>` 这一段可以直接从**同批数据里任何一个合法 fileID** 学到，
 * 不需要读环境变量（也就不会因换环境而失效）。
 *
 * @param {string[]} authorities 形如 '<env>.<bucket>' 的候选（见 collectAuthorities）
 */
function fileIdFromTempUrl(url, authorities) {
  const m = String(url || '').match(/^https?:\/\/([a-z0-9-]+)\.tcb\.qcloud\.la\/([^?#]+)/i)
  if (!m || !authorities || !authorities.length) return ''
  const host = m[1]
  const path = m[2]
  // 精确匹配 authority 的 bucket 段，避免跨环境串上去 —— 猜错也无害，
  // 后面 getTempFileURL 会替我们验证（status !== 0 就当没修好，退回原值）。
  const hit = authorities.filter(a => a.split('.')[1] === host)
  if (!hit.length) return ''
  return 'cloud://' + hit[0] + '/' + path
}

/** 从一批媒体值里收集所有合法的 '<env>.<bucket>' authority */
function collectAuthorities(values) {
  const set = Object.create(null)
  const out = []
  ;(values || []).forEach(v => {
    const m = String(v || '').match(/^cloud:\/\/([^/]+)\//)
    if (m && !set[m[1]]) { set[m[1]] = 1; out.push(m[1]) }
  })
  return out
}

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
  // 陈旧临时链接 → 反推出的 fileID。查换代成功后用这条映射取新链接。
  const recovered = Object.create(null)

  // authority 必须**先扫一遍全表**再决定：能反推的前提是这批数据里有至少一个
  // 合法 fileID 当样本（同环境共用同一个 authority，只要有猫是干净的就够）。
  const allMedia = []
  list.forEach(item => {
    const arr = ((item.photos && item.photos.length ? item.photos : (item.avatar ? [item.avatar] : [])) || [])
    arr.forEach(p => { if (p) allMedia.push(String(p)) })
  })
  const authorities = collectAuthorities(allMedia)

  list.forEach(item => {
    const arr = ((item.photos && item.photos.length ? item.photos : (item.avatar ? [item.avatar] : [])) || []).slice(0, limit)
    arr.forEach(p => {
      const s = String(p || '')
      if (s.indexOf('cloud://') === 0) { cloudIds.push(s); return }
      const fid = fileIdFromTempUrl(s, authorities)
      if (fid) { recovered[s] = fid; cloudIds.push(fid); return }
      // 剩下的外部 http 图床链接保持原样透传（外链可能本来就可用）
    })
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
  // 初次换出+N Rescue 统计：修不好要留痕，否则「403 到底是过期还是文件没了」永远查不清
  let ok = 0
  let rescued = 0
  let staleUnfixed = []
  list.forEach(item => {
    const arr = (item.photos && item.photos.length ? item.photos : (item.avatar ? [item.avatar] : [])) || []
    item.photosUrl = arr.slice(0, limit).map(raw => {
      const p = String(raw || '')
      const fresh = map[p] || map[recovered[p] || '']
      if (fresh) {
        ok++
        if (recovered[p]) rescued++
        return fresh
      }
      // 反推过却仍然换不出链接 = 文件已被删除或没权限，这种只能让用户重传
      if (recovered[p]) staleUnfixed.push(p.slice(0, 90))
      return p.indexOf('http') === 0 ? p : ''
    }).filter(Boolean)
    item.photoUrl = item.photosUrl[0] || ''
  })
  if (rescued) {
    console.warn('[vision] 修复陈旧链接 %d 张（档案里存的是过期的临时链接，已反推回 fileID 重新换链）。' +
      '建议顺手在档案里重新保存一次，把真正的 fileID 写回数据库', rescued)
  }
  if (staleUnfixed.length) {
    console.error('[vision] 有 %d 张照片反推出 fileID 但换链失败（文件已删除/无权限），这些猫建库必然失败：%s',
      staleUnfixed.length, staleUnfixed.slice(0, 5).join(' , '))
  }
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
 * 反向记账：把「被标记为已入库、但服务端特征库里其实没有」的猫打回待入库。
 *
 * 这是对历史脏数据的**自愈**。旧版 markIndexed 只要识别接口返回成功就无条件
 * 把所有 pendingPhotos 标成已入库，而服务端 ensure_index 可能一只都没建成
 * （照片下载失败 / 维度不符 / COS 写失败）。被误标的猫从此不再送照片，
 * 向量永久缺失 —— 线上表现就是「档案里有 4 只猫，识别永远只认得其中 1 只」。
 *
 * 现在每轮识别都拿服务端的 indexedIds 对一遍：标了但库里没有的，清空标记，
 * 下一轮 pickPendingIndexCats 就会重新带上它们的照片。存量脏数据无需人工修。
 *
 * 一次最多重置 100 只（云数据库 `in` 的上限），剩下的下一轮继续 —— 自愈会收敛。
 */
function resetIndexFlags(ids) {
  if (!ids || !ids.length) return
  const batch = ids.slice(0, 100)
  db.collection(COL.cat)
    .where({ _id: _.in(batch) })
    .update({ data: { aiIndexAt: null } })
    .catch(e => console.warn('[vision] 重置入库标记失败', e && e.message))
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

/**
 * 候选行子文案：把「原始相似度」「展示分」「领先幅度」三个口径讲清楚。
 *
 * 为什么需要：识别服务的 `reason` 只有一句「特征相似度 76.3%」——那是**原始余弦**；
 * 而列表右侧那个大数字是**展示分**：余弦经 logistic 校准后的「把握」（详见服务端
 * config.SIM_MID）。两者本来就不是同一个数，中间的差值必须解释，否则用户只会
 * 看到「原始 76.3% 配 9%」，以为是算错了（2026-10-24 就是这样被反馈上来的）。
 * 端点处尤其明显：
 *   原始 1.000 → 展示分封顶 99（只可能是同一张图，那次识别没有信息量）
 *   原始低于匹配线 → 展示分 0
 * 中段两者单调一致，只在 Top1 上补一句「领先次名」——
 * 它回答的是另一个问题：**排第一说明什么**。领先 6.5% 时虽然只有 55 分，
 * 但排序是清楚的；领先 0.5% 时两只猫在模型眼里就是同一只。
 *
 * @param {number} score   展示分（0~99）
 * @param {number} rawSim  原始余弦相似度（0~1；老服务端没有这个字段）
 * @param {string} reason  服务端原文
 * @param {number} lead    Top1 领先次名的余弦差（仅 Top1 有；老服务端没有）
 */
function candidateReason(score, rawSim, reason, lead) {
  const text = String(reason || '')
  const raw = Number(rawSim)
  // 没有 rawSim（老服务端）、或这行文案本来就不是相似度（本地兜底会拼「花纹一致」）→ 原样返回
  if (!Number.isFinite(raw) || raw <= 0 || !/相似度/.test(text)) return text
  const pct = (raw * 100).toFixed(1) + '%'
  const s = Number(score) || 0
  if (s >= 99) return '原始相似度 ' + pct + ' · 展示分封顶 99'
  if (s <= 0) return '原始相似度 ' + pct + ' · 低于匹配线'
  const gap = Number(lead)
  // 只在「确实拉开了」时才说：0 或缺失（老服务端）一律不提，避免给假信息
  if (Number.isFinite(gap) && gap > 0) {
    return '原始相似度 ' + pct + ' · 领先次名 ' + (gap * 100).toFixed(1) + '%'
  }
  return '原始相似度 ' + pct
}

/* ==================== 特征提取 ==================== */

/**
 * 本地兜底特征：**绝不伪造属性**。
 *
 * 历史版本按 fileId 哈希随机 pick 出毛色 / 花纹 / 体型 / 置信度，
 * 返回的 tags 是「毛色 橘色 / 花纹 white / 体型 健壮 / 置信度 65%」这种
 * 看起来完全像真结果的东西，界面上和真模型输出**长得一模一样**。
 *
 * 实测后果（2026-10-17）：用户上传一只被暖光染成黄色的白猫，
 * 本地引擎随机到 pattern='white'，恰好撞上档案里「小白」的 pattern，
 * 于是展示「匹配候选 小白 56%」。这不是识别，是随机数 + 文本匹配，
 * 但用户没有任何线索能看出来 —— 比「识别失败」恶劣得多。
 *
 * 现在属性一律留空，用 degraded=true 让上层 UI 明说「识别服务不可用」。
 * 也**不再生成 embedding**：伪向量会让 scoreCat 走余弦分支算出假相似度，
 * 而且和真实向量同维不同义，混进任何比较都是污染。
 */
function localFeatures(fileId, type) {
  return {
    tags: [],
    pattern: '',
    color: '',
    size: '',
    confidence: 0,
    degraded: true
  }
}

/**
 * 把识别服务的原始候选整形成前端列表。
 *
 * 两道过滤（2026-10-24）：
 * ① byId 里查不到的 catId 直接丢 —— 特征库是**按 catId 存向量**的，删除档案时
 *   特征文件不跟着删（服务端也没有删除接口），被删的猫会以「幽灵候选」继续出现：
 *   名字兜成「未知」、头像空。用户看到的就是「候选里有一只未知的猫」，
 *   实际那是特征库残留（彻底清掉要靠管理端「重建特征库」，过滤后残留已无害）。
 * ② 展示分 ≤0 的丢 —— 校准映射把匹配线以下压成 0 并标注「低于匹配线」，
 *   这种行对用户没有任何信息量（0% 的「可能是它」不是答案），不进列表。
 *
 * @param {Array} raw  服务端返回的 candidates（可能缺字段/含幽灵 id）
 * @param {Object} byId  本校猫档案 id → 猫（sanitizeCat 之后）
 * @returns {Array} 最多 TOP_N 条，按分数降序
 */
function shapeCandidates(raw, byId) {
  return (Array.isArray(raw) ? raw : [])
    .filter(c => c && c.catId && byId[c.catId])
    .map(c => {
      const cat = byId[c.catId] || {}
      const score = Math.max(0, Math.min(99, Math.round(Number(c.score) || 0)))
      return {
        catId: c.catId,
        name: c.name || cat.name || '未知',
        avatar: c.avatar || cat.photo || '',
        score,
        // 原始余弦值一并下发：前端子行要靠它解释「为什么 100% 配 99%」，
        // 排查「识别不准」时也不用去翻日志。
        rawSim: Number(c.rawSim) || 0,
        // Top1 领先次名的余弦差（服务端只给 Top1；老服务端没有就留 0）
        lead: Number(c.lead) || 0,
        reason: candidateReason(score, c.rawSim, c.reason, c.lead)
      }
    })
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N)
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
    // 花色类型（民间说的"品种"，如「橘狸花」「三花猫」）。服务端算好中文，
    // 云函数不重复推断 —— 两份实现必然漂移。
    breed: f.breed || '',
    // 属性来源：clip / api / heuristic。排查「为什么判成灰色」时要能回答
    // "这是模型判的还是数像素算的"。
    attrSource: f.attrSource || '',
    size: f.size || '',
    confidence: Number(f.confidence) || 0.8
  }
  if (Array.isArray(f.embedding) && f.embedding.length) out.embedding = f.embedding
  // 只在**确实有属性**时补标签。历史写法无条件补「毛色 未知 / 花纹 未知」，
  // 属性识别未启用（CLIP 关掉）时界面上会多出两个「未知」占位，
  // 看起来像识别失败，实际是根本没开这个能力 —— 前端改用 attrsReady 说明。
  // ⚠️ 这段只在**老服务端 / 第三方**不返回 tags 时生效，此时 color/pattern
  // 是枚举值（orange/tabby），不是给人看的中文 —— 只作兜底，不要指望它好看。
  if (!out.tags.length && (color || pattern)) {
    out.tags = [
      { k: '毛色', v: color || '未知' },
      { k: '花纹', v: pattern || '未知' }
    ]
  }
  return out
}

/**
 * 身份是否认得出来。
 *
 * 服务端返回 `meta.identified`（Top1 分数 ≥ identifyMin，与服务端 config.IDENTIFY_MIN
 * 同一把尺子，默认 45）；
 * 老服务端没有这个字段时按 LOW_CONF 兜底 —— 两者语义一致，都是
 * 「这个候选能不能当结论读」。
 *
 * 为 false 时前端把文案从"这是某某"改成"没认出是哪只，但看起来是……"，
 * 花色属性照常展示。**不要用 candidates.length 判断**：低分候选也是候选，
 * 把它当结论正是"上传白猫返回小黑"的用户体验来源。
 */
function identifiedFlag(meta, candidates) {
  if (meta && typeof meta.identified === 'boolean') return meta.identified
  return !!(candidates && candidates.length && candidates[0].score >= LOW_CONF)
}

/**
 * 管理端「特征库体检」：档案总数 / 已录入 / 未录入清单。
 *
 * **以识别服务的特征库为准，不信云库的 `aiIndexAt`。**
 * `aiIndexAt` 只是云函数侧的乐观记账：旧版只要接口返回 200 就全标，
 * 服务端实际没建成的猫也会带着「已入库」标记，管理页照它显示就会骗自己
 * （现场表现：档案 4 只、界面显示全已入库、实际只认得 1 只）。
 *
 * 特征库查不到时降级为记账口径，并在 `source` 里标出来，让管理页明确提示
 * 「这是记账推测，未核实」—— 不给结论装成结论。
 */
async function indexStatus(user, event) {
  const e = event || {}
  const schoolId = e.schoolId || (user && user.schoolId) || ''
  const where = {}
  if (schoolId) where.schoolId = schoolId

  // 500 是云开发服务端单次 limit 的安全值（上限 1000，但一次拉太多会挤爆响应体）
  //
  // ⚠️ 读取失败**必须与「没有档案」区分开**：旧写法把异常吞成 `{data: []}`，
  // 管理页于是显示「档案 0 / 还没有猫咪档案」—— 管理员看到的是「库里真没猫」，
  // 实际上是查询挂了。两者需要的处置完全不同，所以错误要原样带回去。
  let catError = ''
  let res = { data: [] }
  try {
    res = await db.collection(COL.cat).where(where).limit(500).get()
  } catch (err) {
    catError = (err && (err.errMsg || err.message)) || '档案读取失败'
    console.error('[vision] 读取档案失败', catError)
  }
  const cats = (res.data || []).filter(c => c && c._id)
  const nameById = {}
  cats.forEach(c => { nameById[c._id] = c.name || '' })

  // 「档案 0」有三种成因，界面上要能分清：
  //   a) 云库真没有档案；
  //   b) 有档案，但 `schoolId` 与当前绑定学校对不上（多校隔离上线前的老数据没有这个字段）
  //      → 按学校过滤就是 0 条，而特征库里的向量还在；
  //   c) 查询本身报错（见 catError）。
  // 只在过滤结果为空时补一次 count()，正常情况零额外开销。
  let dbTotal = null
  if (!cats.length && schoolId && !catError) {
    try {
      const c = await db.collection(COL.cat).count()
      dbTotal = Number(c && c.total) || 0
    } catch (err) {
      /* 统计失败不影响主流程，dbTotal 保持 null（界面显示「未知」而非 0） */
    }
  }

  let bankIds = null
  let bankTotal = 0
  let bankError = ''
  try {
    const r = await fetchIndexIds(schoolId)
    bankIds = r.ids
    bankTotal = r.total
  } catch (err) {
    bankError = (err && err.message) || '特征库查询失败'
    console.warn('[vision] 特征库 id 列表查询失败，降级为记账口径：', bankError)
  }

  const inBank = bankIds ? new Set(bankIds) : null
  const list = cats.map(c => {
    const photoCount = (Array.isArray(c.photos) && c.photos.length)
      ? c.photos.length
      : (c.avatar ? 1 : 0)
    const ledger = !!c.aiIndexAt
    return {
      id: c._id,
      name: c.name || '未命名',
      pattern: c.pattern || '',
      photoCount,
      // indexed：真正在特征库里；source='ledger' 时只能用记账推测
      indexed: inBank ? inBank.has(c._id) : ledger,
      ledger
    }
  })

  const missing = list.filter(x => !x.indexed)
  // 未录入的排前面，让管理员一眼看到要处理的；同组内里照片多的优先（更好建库）
  missing.sort((a, b) => b.photoCount - a.photoCount)
  const indexedList = list.filter(x => x.indexed)

  // 幽灵向量：特征库里**本校**有、但云库档案里已经没有的。
  // 成因是删档案不删向量（服务端没有删除接口）。识别时 shapeCandidates 会把
  // 它们过滤成「未知候选」，不影响正确性，但 bankTotal 会比「已录入」多出几条，
  // 管理员对不上账就会来问「为什么库里有 11 只」（2026-10-25 现场问题之一）。
  // 彻底清掉靠管理端「全部重建」（clear 后按现存档案重刷）。
  const ghostCount = inBank
    ? bankIds.filter(id => !nameById[id]).length
    : 0

  return {
    ok: true,
    schoolId,
    scoped: !!schoolId,                   // 是否按学校过滤（未绑定时统计全环境）
    source: inBank ? 'bank' : 'ledger',   // bank=特征库实况 / ledger=记账推测
    bankError,
    catError,                             // 非空 = 档案查询本身失败，不是「没档案」
    dbTotal,                              // 仅在「按校过滤查到 0 条」时统计全库猫数，否则 null
    total: list.length,
    indexed: indexedList.length,
    missing: missing.length,
    bankTotal,                            // 特征库里的向量总数（可能含已删档案的残留）
    ghostCount,                           // 本校范围内对不上档案的向量条数
    cats: missing,                        // 只回未录入的，省流量
    // 记账与实况不一致的数量：>0 说明有历史误标，云函数会在下次识别时自愈
    ledgerDrift: inBank ? list.filter(x => !x.indexed && x.ledger).length : 0
  }
}

/**
 * 管理端「识别引擎体检」：检测模型有没有生效、花色走哪条路、特征库有多少只。
 *
 * 与 `indexStatus` 分开两个 action 的理由：
 *   ① 失败互不连累 —— 健康检查挂掉不该让「未录入清单」也空着；
 *   ② 各自一份超时预算，塞进一个调用里两头都紧；
 *   ③ `indexStatus` 要扫 500 条档案，`engineHealth` 只发一个 GET，前台可以并行发。
 *
 * **失败必须显性**：识别服务连不上时返回 ok:false + error，不返回一份「看起来正常」
 * 的默认值 —— 后台最怕的就是"绿灯但没生效"。
 */
async function engineHealth(user, event) {
  const e = event || {}
  const schoolId = e.schoolId || (user && user.schoolId) || ''
  const out = {
    ok: false,
    schoolId,
    provider: '',
    detector: false,
    detectModel: '',
    attrSource: '',
    indexed: -1,
    indexedTotal: -1,
    indexedScoped: true,
    indexBackend: '',
    framesMax: 0,
    error: ''
  }
  try {
    const h = await fetchEngineHealth(3000, schoolId)
    const num = v => (typeof v === 'number' && isFinite(v)) ? v : -1
    return Object.assign(out, {
      ok: !!h.ok,
      provider: h.provider || '',
      detector: !!h.detector,
      detectModel: h.detectModel || '',
      detectConf: num(h.detectConf),
      detectPad: num(h.detectPad),
      attrSource: h.attrSource || '',
      indexed: num(h.indexed),
      // 全库条数（含其它学校 + 已删档案残留）。> indexed 时后台会注明差值，
      // 「本校 7 / 全库 11」比一个来历不明的 11 可解释得多。
      indexedTotal: num(h.indexedTotal),
      indexedScoped: h.indexedScoped !== false,
      indexBackend: h.indexBackend || '',
      framesMax: num(h.framesMax),
      error: h.ok ? '' : '识别服务返回 ok=false'
    })
  } catch (err) {
    out.error = (err && err.message) || String(err)
    return out
  }
}

/**
 * 管理端手动录入**一只**猫。
 *
 * 与建档时的 `buildIndexAuto` 区别：
 *   - force=true：服务端已有也重算。用户点「录入」的意图就是「确保它进库」，
 *     被 onlyMissing 静默跳过会让人以为按钮没生效。
 *   - 超时放宽到 8s：云函数超时配 20s 后，3 张照片下载 + 推理跑得完；
 *     建档路径必须压在 2.2s（会连累保存），手动点击可以等。
 */
async function indexOneCat(user, event) {
  const e = event || {}
  const ids = (Array.isArray(e.catIds) ? e.catIds : []).filter(Boolean).slice(0, 1)
  if (!ids.length) return { ok: false, msg: '未指定猫' }
  try {
    const r = await buildIndex(user, {
      schoolId: e.schoolId,
      catIds: ids,
      photosPerCat: Math.max(1, Math.min(INDEX_PHOTOS, Number(e.photosPerCat) || INDEX_PHOTOS)),
      onlyMissing: false,
      force: true,
      timeoutMs: Math.max(2000, Math.min(9000, Number(e.timeoutMs) || 8000))
    })
    return Object.assign({ ok: true }, r)
  } catch (err) {
    console.error('[vision] 手动录入失败', err && err.message)
    return { ok: false, msg: (err && err.message) || '录入失败' }
  }
}

/**
 * 把 AI_ENDPOINT 拆成 origin，拼出需要的 path。
 *
 * AI_ENDPOINT 形如 `https://host/v1/recognize`，这里只换 path，保留 host 与协议。
 * 未配置 / 地址非法一律抛错（调用方据此降级），**不返回空结果冒充「一切正常」**。
 */
function apiUrl(pathname, query) {
  const ep = process.env.AI_ENDPOINT
  if (!ep) throw new Error('未配置识别服务地址')
  let u
  try { u = new URL(ep) } catch (err) { throw new Error('AI_ENDPOINT 非法') }
  let url = u.protocol + '//' + u.host + pathname
  if (query) url += (url.indexOf('?') >= 0 ? '&' : '?') + query
  return url
}

/**
 * GET + JSON。非 2xx 一律抛错，`label` 只影响错误文案
 * （排障时要能一眼看出是「特征库接口」还是「健康检查」挂了）。
 */
function getJson(url, timeoutMs, label) {
  const https = require('https')
  const http = require('http')
  let u
  try { u = new URL(url) } catch (err) { return Promise.reject(new Error('AI_ENDPOINT 非法')) }
  const lib = u.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: process.env.AI_TOKEN ? { Authorization: 'Bearer ' + process.env.AI_TOKEN } : {},
      timeout: Number(timeoutMs) || 3500
    }, res => {
      let data = ''
      res.on('data', d => { data += d })
      res.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(data) } catch (err) {
          return reject(new Error(label + '返回非 JSON (HTTP ' + res.statusCode + ')'))
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error((parsed && parsed.detail) || (label + ' HTTP ' + res.statusCode)))
        }
        resolve(parsed || {})
      })
    })
    req.on('timeout', () => { req.destroy(new Error(label + '超时')) })
    req.on('error', reject)
    req.end()
  })
}

/**
 * 调识别服务 `/v1/index/ids` —— 特征库里真实存在的猫 id。
 *
 * 为什么要这个接口：云库的 `aiIndexAt` 是**乐观记账**，旧版「接口 200 就全标」，
 * 服务端补库失败时猫被永久误标、不再送照片。管理端必须问服务端「你到底有哪几只」。
 */
function fetchIndexIds(schoolId, timeoutMs) {
  let url
  try {
    url = apiUrl('/v1/index/ids', schoolId ? 'schoolId=' + encodeURIComponent(schoolId) : '')
  } catch (err) {
    return Promise.reject(err)
  }
  return getJson(url, timeoutMs || 3500, '特征库接口').then(parsed => {
    const ids = Array.isArray(parsed.ids) ? parsed.ids : []
    return { ids, total: Number(parsed.total) || ids.length, backend: parsed.backend || '' }
  })
}

/**
 * 调识别服务 `/health` —— 引擎体检（检测模型 / 属性链路 / 特征库）。
 *
 * 为什么管理端需要它：「YOLO 到底有没有生效」在界面上完全看不出来 ——
 * 检测模型加载失败只会打一条 warning，识别照常返回（整图提特征），
 * 结果就是「代码改了、也部署了、准确率没变」。把这三个开关摆到后台，
 * 运维不用翻日志、不用 SSH 上去 curl。
 */
function fetchEngineHealth(timeoutMs, schoolId) {
  let url
  try {
    // schoolId：/health 的 indexed 默认是**全库**（含其它学校 + 已删档案残留），
    // 管理后台要的是本校口径 —— 不传的话，「档案 6 只、特征库 11 只」这种
    // 口径错位会把管理员吓到（2026-10-25 现场就是这个）。
    url = apiUrl('/health', schoolId ? 'schoolId=' + encodeURIComponent(schoolId) : '')
  } catch (err) { return Promise.reject(err) }
  return getJson(url, timeoutMs || 3000, '健康检查')
}

/**
 * 删掉识别服务特征库里某只猫的向量。
 *
 * 为什么必须主动删：特征库按 `cat_id` 存对象，而**删除猫档案不会碰特征文件**
 * （服务端以前根本没有删除接口）。残留的向量会：
 *   ① 继续参与检索并被返回，靠云函数 `shapeCandidates` 按 byId 过滤掉（无害但浪费）；
 *   ② 让管理页「特征库已有 N 条向量」比档案数多几条，管理员对不上账。
 *
 * 失败**不能连累删档**：删档案已经成功了，清理只是顺手。
 * 真漏了还有后台「全部重建」兜底（clear 后按现存档案重刷）。
 */
function deleteIndexEntry(catId, schoolId, timeoutMs) {
  let url
  try {
    const q = 'catId=' + encodeURIComponent(String(catId || ''))
      + (schoolId ? '&schoolId=' + encodeURIComponent(String(schoolId)) : '')
    url = apiUrl('/v1/index', q)
  } catch (err) {
    return Promise.resolve(false)
  }
  const https = require('https')
  const http = require('http')
  let u
  try { u = new URL(url) } catch (err) { return Promise.resolve(false) }
  const lib = u.protocol === 'https:' ? https : http
  return new Promise(resolve => {
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'DELETE',
      headers: process.env.AI_TOKEN ? { Authorization: 'Bearer ' + process.env.AI_TOKEN } : {},
      timeout: Number(timeoutMs) || 2000
    }, res => {
      res.on('data', () => {})
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300))
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
    req.end()
  })
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
    let remoteMeta = null
    let provider = 'local'
    const endpoint = process.env.AI_ENDPOINT
    const featFails = Number(partial.featFails) || 0
    const aiAttempts = Number(partial.aiAttempts) || 0
    const pollPath = !!(ctx && ctx.deadline)
    if (endpoint && featFails < FEAT_FALLBACK_ATTEMPTS && aiAttempts < MAX_AI_ATTEMPTS) {
      // 两条路径都要按剩余预算裁剪 AI 超时 —— 早期只有 poll 裁剪，同步路径固定
      // 用满 AI_TIMEOUT_MS(8s)。后果：冷启动/换链吃掉几秒后，AI 那 8s 已经没有
      // 对应的预算，云函数被平台在 3s 处掐断（FUNCTIONS_TIME_LIMIT_EXCEEDED），
      // 客户端看到 -504003。任务虽然安全（状态已落库、轮询可续），但白等一场。
      // 裁剪后：预算不够就提前 defer，让轮询轻装去跑，而不是硬撑到被掐。
      const aiCap = pollPath
        ? Math.min(Number(process.env.AI_POLL_TIMEOUT_MS) || AI_POLL_CAP_MS, AI_POLL_CAP_MS)
        : (Number(process.env.AI_TIMEOUT_MS) || 8000)
      const aiTimeout = Number.isFinite(left())
        ? Math.max(300, Math.min(aiCap, left() - AI_RESERVE_MS))
        : aiCap
      if (aiTimeout < 500) return { deferred: true }
      try {
        const raw = await callVisionApi(endpoint, {
          url: partial.url, videoUrl: partial.videoUrl, fileId: mediaId,
          type, frames, schoolId,
          // 排队耐心：同一个素材若已有一次计算在跑（上一轮被我超时放弃的那次），
          // 本次就等它算完，而不是再开一遍。留 300ms 给响应回程与自身收尾。
          // 少了它，poll 每轮都触发一次完整计算，视频（3.5s）永远收敛不了。
          waitMs: Math.max(0, aiTimeout - 300),
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
          remoteMeta = (raw.meta && typeof raw.meta === 'object') ? raw.meta : {}
          // 入库记账必须是**服务端确认**的，不能乐观标记。
          //
          // 历史写法 `markIndexed(Object.keys(pendingPhotos))` 只要接口成功就把
          // 全部待补库的猫打上 aiIndexAt，而服务端补库可能因照片下载失败、
          // 维度不符、COS 写失败而一只都没建成 —— 这些猫从此再也不会送照片，
          // 向量永久缺失。线上表现就是「档案 4 只猫，识别永远只认得其中 1 只」
          // （那只恰好是手动 build 成功的）。宁可每轮多带一次照片链接，
          // 也不能把没入库的猫标成已入库。
          const confirmed = Array.isArray(remoteMeta.indexedIds) ? remoteMeta.indexedIds : null
          if (confirmed) {
            const inBank = {}
            confirmed.forEach(id => { inBank[id] = true })
            // ① 只标记确认入库的
            markIndexed(Object.keys(pendingPhotos).filter(id => inBank[id]))
            // ② 自愈：标了「已入库」但服务端其实没有 → 打回待入库，下轮重新送照片
            const stale = catsLite
              .filter(c => c.aiIndexAt && !inBank[c.id])
              .map(c => c.id)
            if (stale.length) {
              console.warn('[vision] 特征库缺 ' + stale.length + ' 只已标记入库的猫，重置标记触发补库')
              resetIndexFlags(stale)
            }
          } else if (remoteMeta.indexed === undefined) {
            // 旧版服务端（无 meta.indexedIds 也无 indexed）才退回乐观记账，
            // 否则「服务端说库里有几只=0」会和「接口调用成功」混为一谈
            markIndexed(Object.keys(pendingPhotos))
          }
        }
      } catch (e) {
        const msg = (e && e.message) || ''
        // 「排队中」= 前一次计算还没完，本次等不起。性质上等同超时：
        // 素材和前一次的进度都还在，下轮再来即可，**不能**算作明确错误
        // （FEAT_FALLBACK_ATTEMPTS 只有 6 次，视频场景第二轮就会排队，
        //  记成明确错误会在真正拿到结果前就降级本地引擎）。
        const isTimeout = msg === '识别接口超时' || /排队中/.test(msg)
        const attempts = aiAttempts + 1
        const fails = isTimeout ? featFails : featFails + 1
        console.error('[vision] 识别接口第 ' + attempts + ' 次失败' +
          (isTimeout ? '（超时/排队，下轮重试）' : '（明确错误）'), msg)
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

    // ④ 组装候选：**只信远程候选**。
    //
    // 历史写法：远程没给候选就落到本地 `match()`，用属性/位置给全库猫打分排序。
    // 问题是本地兜底时 features 是空的（或更糟：随机属性），
    // 所有猫都拿同一个基线 30 分，排序实际由「离常驻点多近」决定 ——
    // 界面上却工工整整写着「匹配候选 共 4 只」，用户会当结论读。
    // 现在：没有可信特征就**不给候选**，由前端明说「这次没识别出来」。
    // 整形 + 两道过滤（幽灵档案 / 低于匹配线）收在 shapeCandidates 里，可单测。
    const candidates = shapeCandidates(remoteCandidates, byId)

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
      // degraded：本次**没有**可信的识别特征，features 与 candidates 都不可当结论。
      // 前端必须据此换一张卡片，而不是把空特征当成「属性识别结果为空」。
      degraded: provider === 'local',
      // 特征库规模：库里只有 1~2 只猫时，任何"匹配"都不可信，前端要明说。
      // 旧服务端不返回 meta.indexed 时给 -1（未知），不冒充 0。
      indexedTotal: (remoteMeta && Number.isFinite(Number(remoteMeta.indexed)))
        ? Number(remoteMeta.indexed) : (provider === 'local' ? 0 : -1),
      // 属性识别（毛色/花纹）是否可用 —— 不可用时特征是只有检测/帧数两张卡，
      // 用户会以为界面渲染缺了东西，需要一句解释。
      attrsReady: !!(remoteMeta && remoteMeta.attrs),
      // 身份是否认得出来。服务端判断优先，老服务端按 LOW_CONF 兜底。
      identified: identifiedFlag(remoteMeta, candidates),
      // 属性判不出来时的原因（"画面里猫体区域不足 12%"），用于排查和引导重拍
      attrReason: (remoteMeta && remoteMeta.attrReason) || '',
      // 查询图质量门控（2026-10-26）：false 时**候选为空是设计如此**，
      // 不是特征库空了。qualityReason 是给用户看的操作指引
      // （"猫在画面里只占 5%，距离太远…"），必须原样透出。
      qualityOk: !remoteMeta || remoteMeta.qualityOk !== false,
      qualityReason: (remoteMeta && remoteMeta.qualityReason) || '',
      // 猫体平均亮度（低光门控输入，2026-10-26 深夜加）：排查「夜里被拦」先看它，
      // 夜间实测 105/113、白天 ≥178。老服务端不回该字段 → null（未知，不冒充 0）。
      lightMeanV: (remoteMeta && Number.isFinite(Number(remoteMeta.lightMeanV)))
        ? Number(remoteMeta.lightMeanV) : null,
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

  // ---- 计费（规则 V1.0：首次免费 → 20 猫粮/次，每日最多 10 次）----
  // 放在建任务**之后**：任务 id 正好当流水的幂等键，事后能对上「哪次识别扣的钱」。
  // 扣费失败（余额不足 / 次数用完）必须把任务删掉 —— 否则会留下一条
  // 不花钱的 pending 任务，被轮询捡起来白跑一次识别。
  let billing = null
  try {
    billing = await points.chargeRecognize(user, { refType: 'ai_task', refId: add._id })
  } catch (e) {
    await db.collection(COL.aiTask).doc(add._id).remove().catch(() => {})
    throw e
  }

  return {
    taskId: add._id,
    status: 'pending',
    type,
    // 前端据此展示「本次免费 / 扣了 20，余 68，今日还剩 7 次」
    billing
  }
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
  const top = (result.candidates && result.candidates[0]) || null
  const topCatId = (top && top.catId) || ''

  warmCollection(COL.aiSample)   // 同 ai_tasks：只后台发起，不阻塞确认请求
  // ⚠️ 必须把**本次的匹配分**一起存下来（2026-10-24 新增）。
  //   样本要拿去建特征库（见 buildIndexFromSamples），而「用户点了确认」并不等于
  //   「这张照片可信」：低于匹配线的确认很可能是认错猫。没有分数就只能一律放行，
  //   结果是用户随手一确认，就把别的猫的照片灌进了这只猫的特征库。
  //   老样本没有这两个字段（score 缺失）→ 计划阶段按 score=0 处理，需管理员指定后才可用。
  const topScore = Number(top && top.score) || 0
  const topRaw = Number(top && top.rawSim) || 0
  await db.collection(COL.aiSample).add({
    data: {
      openid: user.openid,
      _openid: user.openid,
      schoolId: task.schoolId || '',
      fileId: task.fileId,
      // 视频任务的封面：建库只认图片，视频文件服务端解不了
      thumbId: task.thumbId || '',
      type: task.type,
      features: result.features || null,
      predictedCatId: topCatId,
      confirmedCatId: correct ? (catId || topCatId) : '',
      correct: !!correct,
      score: topScore,
      rawSim: topRaw,
      provider: result.provider || 'local',
      // 生命周期：new（待用）→ used（已并入特征库）/ ignored（管理员排除）
      state: 'new',
      createdAt: new Date()
    }
  })

  // 不再回写特征库（见函数头注释）。embeddingWritten 恒 false，仅作老客户端兼容。
  const embeddingWritten = false
  let dexGained = 0
  if (correct && catId) {
    // 仍解锁图鉴：确认过 = 见过这只猫（与特征库无关，属用户侧收藏）
    const seen = user.catSeen || []
    if (seen.indexOf(catId) < 0) {
      // 条件更新抢占：并发确认（超时重试）时只有一个能真正解锁，
      // 否则会重复发「图鉴点亮」积分。`_.nin` 与打卡里的 firstMeet 同一写法。
      const mark = await db.collection(COL.user)
        .where({ _id: user._id, catSeen: _.nin([catId]) })
        .update({ data: { catSeen: _.push([catId]) } })
      if (mark && mark.stats && mark.stats.updated) {
        // 图鉴点亮新品种 +10 积分 —— 与打卡里首次遇见同一口径，按 catSeen 去重，
        // 所以同一只猫「识别确认」与「打卡遇见」加起来只发一次。
        const dg = await points.grantPoint(user, 'dexNew', null, { refType: 'cat', refId: catId })
        dexGained = dg.gained || 0
      }
    }
  }

  const g = await points.grantPoint(user, 'confirm', null, { refType: 'ai_task', refId: taskId })
  await db.collection(COL.aiTask).doc(taskId).update({
    data: {
      confirmedCatId: correct ? (catId || topCatId) : '',
      confirmed: true,
      confirmedAt: new Date()
    }
  }).catch(() => {})

  return { ok: true, pointsGained: (g.gained || 0) + dexGained, dexGained, embeddingWritten }
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
  const photosPerCat = Math.max(1, Math.min(INDEX_PHOTOS_MAX, Number(event.photosPerCat) || INDEX_PHOTOS))
  // force 优先：整体重建时忽略「已入库」判断
  // 老版本 build_index.py 脚本不带这两个字段，默认行为是全量重算（与历史一致）
  const onlyMissing = event.force !== true && event.onlyMissing === true
  // 建库是重活，服务端要下载并编码几百张图；默认超时比识别长得多。
  // 定时任务会把「本次剩余预算」直接传进来，尽量一次多建几只。
  const buildTimeout = Math.max(3000, Number(event.timeoutMs)
    || Number(process.env.AI_INDEX_TIMEOUT_MS) || 20000)
  // catIds：只建指定的猫（建档后自动建库）。不传 = 全校扫描（定时任务 / 手动全量）
  const cats = await index(schoolId, { photosPerCat, catIds: event.catIds })

  // 前置拦截：临时链接一张都没换出来的猫，发过去服务端也只能回 failed，
  // 白白占掉一次下载超时。更要紧的是**原因要说清** —— 现场「点录入 → 已录入没变」
  // 十有八九就是这一条：档案里的照片文件已不存在 / 换链被拒。
  const reasons = {}
  const sendable = []
  cats.forEach(c => {
    if (c.photosUrl && c.photosUrl.length) { sendable.push(c); return }
    const n = (c.photos && c.photos.length) || 0
    reasons[c.id] = n
      ? 'photoUrl:' + n
      : 'noPhoto'
  })

  const buildUrl = String(endpoint).replace(/\/v1\/recognize\/?$/, '/v1/index/build')
  if (buildUrl === String(endpoint)) {
    throw new AppError('AI_ENDPOINT 需以 /v1/recognize 结尾，才能推导建库地址', 400)
  }

  // 全都换不出链接就没必要发请求了（也避免「请求成功、built=0」这种含糊结果）
  if (!sendable.length) {
    if (cats.length) {
      console.error('[vision] 建库前置失败：所有猫的照片都没换出临时链接', JSON.stringify(reasons))
    }
    return {
      ok: true, schoolId, scanned: cats.length, built: 0,
      failed: cats.map(c => c.id), skipped: 0, reasons, indexed: null
    }
  }

  const res = await callVisionApi(buildUrl, {
    schoolId,
    photosPerCat,
    onlyMissing,
    force: event.force === true,
    cats: sendable.map(c => ({
      id: c.id, name: c.name, pattern: c.pattern, color: c.color, photos: c.photosUrl
    }))
  }, buildTimeout)

  // 服务端逐只给的失败原因（noPhoto / downloadFailed:3/5 / embedFailed:xxx）
  const remote = (res && res.reasons) || {}
  Object.keys(remote).forEach(id => { reasons[id] = String(remote[id] || '') })

  // 记账：**只标真的建成的猫**。旧写法在 res 缺字段时会把全部猫标成已入库，
  // 一旦接口返回异常体，这些猫再也不会被送照片，向量永久缺失。
  const failed = Array.isArray(res && res.failed) ? res.failed : null
  let builtIds = []
  if (failed) builtIds = sendable.map(c => c.id).filter(id => failed.indexOf(id) < 0)
  else if (Number(res && res.built) >= sendable.length) builtIds = sendable.map(c => c.id)
  if (builtIds.length) markIndexed(builtIds)

  return {
    ok: true,
    schoolId,
    scanned: cats.length,
    built: Number(res && res.built) || 0,
    failed: failed || sendable.map(c => c.id),
    skipped: (res && res.skipped) || 0,
    reasons,
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
 * ⚠️ 预算：只带 1 只猫 ≤5 张照片，服务端下载 + 编码通常 1~2s，
 * 超时上限硬压在 2.2s —— 客户端 callFunction 只有约 3s，不能赌。
 * 带不动的张数交给后台「用确认样本建库」补齐（那条路径是手动的，能等）。
 */
async function buildIndexAuto(user, event) {
  const e = event || {}
  const ids = (Array.isArray(e.catIds) ? e.catIds : []).filter(Boolean)
  if (!ids.length) return { ok: true, deferred: true, msg: '未指定猫' }
  try {
    return await buildIndex(user, {
      schoolId: e.schoolId,
      catIds: ids.slice(0, 3),
      // 自动入库走 INDEX_PHOTOS_AUTO（5）—— 这条路径的硬预算是 2.2s，
      // 带 8 张必然超时，而超时等于一只都没建成（见该常量的注释）。
      photosPerCat: Math.max(1, Math.min(INDEX_PHOTOS_AUTO, Number(e.photosPerCat) || INDEX_PHOTOS_AUTO)),
      onlyMissing: true,
      timeoutMs: Math.max(800, Math.min(2400, Number(e.timeoutMs) || 2200))
    })
  } catch (err) {
    // 静默降级：让建档照常成功，未入库的猫交给 A/B 兜底
    console.warn('[vision] 建档后自动入库未当场完成，交给定时任务兜底', err && err.message)
    return { ok: false, deferred: true, msg: (err && err.message) || '入库延后' }
  }
}

/* ==================== 确认样本库（人工确认 → 特征库） ==================== */
/**
 * 用户「识别 → 点确认」的样本，过去只写进 `ai_samples` 攒训练集，
 * 从不参与建库（2026-10-15 的决定，当时理由是识别照质量不可控）。
 *
 * 现在反过来：这批照片的**分布**恰恰是档案照补不上的 ——
 * 档案照是管理员精心摆拍的正脸，而用户识别时拍的是「远处 / 侧身 / 逆光 / 猫在草丛里」。
 * 查询照片和档案照不同分布，才是「明明细看是同一只，相似度只有 68%」的主因。
 * 所以把确认过的样本并入特征库，是提升准确率最对症的一味药。
 *
 * 但「用户点了确认」≠「这张照片可信」，所以入库前有三道闸：
 *   ① 必须由**管理员在后台**手动触发（不在识别热路径上自动做）；
 *   ② 分数门槛 SAMPLE_MIN_SCORE（低于匹配线的确认不予采信）；
 *   ③ 每只猫最多并入 SAMPLE_PHOTOS_PER_CAT 张，且管理员可逐条排除 / 删除 / 改判归属。
 * 再叠加服务端 rep_vector 的 medoid 离群剔除，一张误确认的照片影响有限。
 */

/** 每只猫最多并入几张确认样本（样本是补充，主体仍应是档案照） */
const SAMPLE_PHOTOS_PER_CAT = 3
/**
 * 样本门槛分（= LOW_CONF = 匹配线）。
 * 低于匹配线意味着服务端自己都判「没认出来」，此时用户点确认很可能是认错猫
 * —— 把别的猫的照片写进这只猫的特征库，比不建库更糟。
 */
const SAMPLE_MIN_SCORE = LOW_CONF
/** 单次调用最多建几只猫（3 × 8 张 × 约 500ms ≈ 12s，必须留在云函数 20s 超时内） */
const SAMPLE_BUILD_CATS = 3
/** 建库超时上限（含下载 + 编码；云函数超时需配到 20s 以上） */
const SAMPLE_BUILD_TIMEOUT_MS = 12000

/** 样本可用于建库的图片 id：视频任务只有封面能用（服务端建库只认图片） */
function sampleMediaId(s) {
  if (!s) return ''
  if (s.type === 'video') return s.thumbId || ''
  return s.fileId || ''
}

/**
 * 纯函数：按规则筛出「本次要并入特征库」的样本。
 *
 * 抽出来是为了让 `listSamples`（后台展示「哪些可用 / 为什么不可用」）和
 * `buildIndexFromSamples`（真正建库）**共用同一套判定** ——
 * 两边各写一遍的后果就是界面显示「3 条可用」、点下去只建了 1 只。
 *
 * @param {Object[]} samples ai_samples 原始文档
 * @param {Object} opts { samplePerCat, minScore, catIds, sampleIds, allowIgnored, skipUsed }
 *   skipUsed —— 跳过「已入库」的样本。整批建库**必须**开：否则每一轮都从同一批
 *   猫开始（已入库的样本照样合格），remaining 永远不会收敛到 0，按钮点了白点。
 *   单只重算 / 显式 includeUsed 时关掉。
 * @returns {{picked:Object[], excluded:Object[], catIds:string[], reasons:Object}}
 */
function planSampleBuild(samples, opts) {
  const o = opts || {}
  const perCat = Math.max(1, Math.min(6, Number(o.samplePerCat) || SAMPLE_PHOTOS_PER_CAT))
  const minScore = (o.minScore === undefined || o.minScore === null)
    ? SAMPLE_MIN_SCORE : Number(o.minScore)
  const allowIgnored = o.allowIgnored === true
  const skipUsed = o.skipUsed === true
  const onlyCats = (Array.isArray(o.catIds) && o.catIds.length) ? o.catIds : null
  const onlyIds = (Array.isArray(o.sampleIds) && o.sampleIds.length) ? o.sampleIds : null

  const picked = []
  const excluded = []
  const reasons = Object.create(null)
  const usedByCat = Object.create(null)
  const seenKey = Object.create(null)

  // 分数高的优先：同为「这只猫」的确认，越像的那张越值得占用名额
  const ordered = (samples || []).slice().sort((a, b) => {
    const d = (Number(b && b.score) || 0) - (Number(a && a.score) || 0)
    if (d) return d
    return new Date((b && b.createdAt) || 0).getTime() - new Date((a && a.createdAt) || 0).getTime()
  })

  ordered.forEach(s => {
    if (!s || !s._id) return
    if (onlyIds && onlyIds.indexOf(s._id) < 0) return
    const catId = s.confirmedCatId || ''
    const score = Number(s.score) || 0
    const provider = s.provider || ''
    let why = ''
    if ((s.state || 'new') === 'ignored' && !allowIgnored) why = 'ignored'
    else if ((s.state || 'new') === 'used' && skipUsed) why = 'alreadyUsed'
    // 本地降级时分数是假的，认不认得出来都没依据 —— 一律不采信
    else if (provider === 'local') why = 'degraded'
    else if (!catId) why = 'unassigned'
    else if (!sampleMediaId(s)) why = 'noMedia'
    else if (score < minScore) why = 'lowScore'
    else if (onlyCats && onlyCats.indexOf(catId) < 0) why = 'otherCat'
    else if ((usedByCat[catId] || 0) >= perCat) why = 'quota'

    if (!why) {
      // 同一张照片被同一个人确认两次（或同猫重复确认同一素材）只算一次
      const key = catId + '|' + sampleMediaId(s)
      if (seenKey[key]) why = 'dup'
      else seenKey[key] = 1
    }

    if (why) {
      excluded.push({ id: s._id, reason: why })
      reasons[s._id] = why
      return
    }
    usedByCat[catId] = (usedByCat[catId] || 0) + 1
    picked.push({
      id: s._id, catId: catId, fileId: sampleMediaId(s), score: score,
      alreadyUsed: (s.state || 'new') === 'used'
    })
  })

  return {
    picked, excluded, reasons,
    catIds: Object.keys(usedByCat),
    fresh: picked.filter(p => !p.alreadyUsed).length
  }
}

/**
 * 后台：列确认样本（含「能不能用于建库」的判定与原因）。
 *
 * 只回本校数据。样本量按学校规模增长，所以硬上限 200 条再在内存里筛 ——
 * 云数据库的 `where` 里没法表达「state/score/归属」这套组合条件。
 */
async function listSamples(user, event) {
  const e = event || {}
  const schoolId = e.schoolId || (user && user.schoolId) || ''
  const limit = Math.max(1, Math.min(200, Number(e.limit) || 60))
  const where = {}
  if (schoolId) where.schoolId = schoolId

  let raw = []
  try {
    const q = db.collection(COL.aiSample).where(where).orderBy('createdAt', 'desc').limit(200)
    const res = await q.get()
    raw = res.data || []
  } catch (err) {
    // orderBy 在个别环境下会报「索引不存在」，退回不带排序的查询
    console.warn('[vision] 样本查询降级（去掉排序）', err && err.message)
    const res = await db.collection(COL.aiSample).where(where).limit(200).get()
    raw = res.data || []
  }

  // 猫名（确认的 / 系统判的都查一遍，用来显示「判成了谁」）
  const ids = []
  raw.forEach(s => {
    if (s.confirmedCatId) ids.push(s.confirmedCatId)
    if (s.predictedCatId) ids.push(s.predictedCatId)
  })
  const uniq = [...new Set(ids)]
  const nameOf = Object.create(null)
  if (uniq.length) {
    for (let i = 0; i < uniq.length; i += 100) {
      const part = uniq.slice(i, i + 100)
      // 单条读失败不能让整页空掉：档案已删的猫只是名字显示不出来
      const res = await db.collection(COL.cat).where({ _id: _.in(part) }).limit(100).get()
        .catch(() => ({ data: [] }))
      ;(res.data || []).forEach(c => { nameOf[c._id] = c.name || '' })
    }
  }

  // 两套计划：展示用「所有合格样本」（含已入库的，界面要显示它的状态），
  // 整批建库用「只看没入库的」—— 否则每一轮都从同一批猫开始，永远收敛不了。
  const plan = planSampleBuild(raw, {})
  const planFresh = planSampleBuild(raw, { skipUsed: true })
  // 缩略图：样本原图存的是 fileId，前台要看图必须换临时链接
  const thumbs = raw.slice(0, limit).map(s => ({ _id: s._id, photos: [sampleMediaId(s)] }))
  await attachTempUrls(thumbs, 1)
  const thumbOf = Object.create(null)
  thumbs.forEach(t => { thumbOf[t._id] = (t.photosUrl && t.photosUrl[0]) || '' })

  const items = raw.slice(0, limit).map(s => {
    const why = plan.reasons[s._id] || ''
    const st = s.state || 'new'
    const score = Number(s.score) || 0
    const name = s.confirmedCatId ? (nameOf[s.confirmedCatId] || '') : ''
    return {
      id: s._id,
      catId: s.confirmedCatId || '',
      catName: name || (s.confirmedCatId ? '（档案已删除）' : ''),
      catMissing: !!(s.confirmedCatId && !nameOf[s.confirmedCatId]),
      predictedName: s.predictedCatId ? (nameOf[s.predictedCatId] || '（档案已删除）') : '',
      // 文案一律在这里拼好：WXML 的 mustache 不做字符串拼接，会被静默忽略
      scoreText: score ? (score + ' 分') : '无分数',
      rawText: Number(s.rawSim) ? (Math.round(Number(s.rawSim) * 1000) / 10 + '%') : '',
      typeText: s.type === 'video' ? '视频' : '照片',
      stateText: st === 'used' ? '已入库' : (st === 'ignored' ? '已排除' : '待用'),
      state: st,
      thumb: thumbOf[s._id] || '',
      usable: !why,
      blockText: BLOCK_TEXT[why] || '',
      blockReason: why,
      createdAt: s.createdAt
    }
  })

  // 按猫聚合（后台要看的是「哪只猫攒了几条」）
  const groupMap = Object.create(null)
  items.forEach(it => {
    const key = it.catId || '__none__'
    if (!groupMap[key]) {
      groupMap[key] = {
        // wx:key 需要非空且唯一：未归属组的 catId 是空串，直接拿它当 key 会撞重复警告
        key: key,
        catId: it.catId,
        catName: it.catId ? (it.catName || '未知档案') : '未归属',
        items: []
      }
    }
    groupMap[key].items.push(it)
  })
  const groups = Object.keys(groupMap).map(k => groupMap[k])
  // 每组补上可建库标记（后台模板里不做过滤/比较，会被静默忽略）
  groups.forEach(g => {
    const usable = g.items.filter(i => i.usable).length
    g.countText = g.items.length + ' 条 · 可用 ' + usable + ' 条'
    g.canBuild = usable > 0 && !!g.catId
  })

  return {
    ok: true, schoolId,
    total: raw.length,
    shown: items.length,
    usable: plan.picked.length,
    fresh: planFresh.picked.length,
    cats: planFresh.catIds.length,
    perCat: SAMPLE_PHOTOS_PER_CAT,
    minScore: SAMPLE_MIN_SCORE,
    viewCap: INDEX_PHOTOS,
    // 未出现在列表里的（超过 200 条上限）如实告知，别让管理员以为全看到了
    truncated: raw.length > limit,
    groups: groups
  }
}

/** 排除原因 → 人话。后台直接渲染，不自己拼字符串。 */
const BLOCK_TEXT = {
  ignored: '已排除',
  degraded: '本次识别降级，分数不可信',
  unassigned: '未归属到某只猫',
  noMedia: '没有可用图片（视频缺封面）',
  lowScore: '低于匹配线，未采信',
  otherCat: '不在本次范围内',
  quota: '该猫样本已满',
  dup: '与已选中的重复',
  alreadyUsed: '已入库'
}

/**
 * 后台：改一条样本。
 *   ignore  排除（永不入库）  restore 恢复待用   assign  指定归属猫
 */
async function updateSample(user, event) {
  const e = event || {}
  const id = e.id
  const act = String(e.act || '')
  if (!id) throw new AppError('缺少样本 id', 400)
  const res = await db.collection(COL.aiSample).doc(id).get().catch(() => ({ data: null }))
  if (!res.data) throw new AppError('样本不存在', 404)

  const patch = {}
  if (act === 'ignore') patch.state = 'ignored'
  else if (act === 'restore') patch.state = 'new'
  else if (act === 'assign') {
    const catId = String(e.catId || '')
    if (!catId) throw new AppError('缺少目标猫 id', 400)
    const cat = await db.collection(COL.cat).doc(catId).get().catch(() => ({ data: null }))
    if (!cat.data) throw new AppError('目标档案不存在', 404)
    // 归属一改，correct 必须同步为真 —— 否则这条在计划阶段仍会被判「未归属」
    patch.confirmedCatId = catId
    patch.correct = true
    patch.state = 'new'
    patch.assignedBy = (user && user.openid) || ''
    patch.assignedAt = new Date()
  } else {
    throw new AppError('未知操作：' + act, 400)
  }

  await db.collection(COL.aiSample).doc(id).update({ data: patch })
  return { ok: true, id, state: patch.state || '' }
}

/** 后台：物理删除一条样本（用户误传、涉隐私、拍的根本不是猫） */
async function deleteSample(user, event) {
  const id = (event && event.id) || ''
  if (!id) throw new AppError('缺少样本 id', 400)
  await db.collection(COL.aiSample).doc(id).remove()
  return { ok: true, id }
}

/**
 * 后台：把确认样本并入特征库。
 *
 * 做法不是「只拿样本建库」，而是**档案照 + 样本合并去重**后整只重算：
 * 只送样本会把原本由档案照撑起来的正脸特征整块丢掉，反而更差。
 * 合并后仍受 INDEX_PHOTOS（8）总上限约束，多出来的样本进不去。
 *
 * 为什么必须 force=true：代表向量是从这一批图整体算出来的，
 * 视图集合变了就得重算；onlyMissing 会让它被静默跳过（「点了没反应」）。
 *
 * 分批：一次最多 SAMPLE_BUILD_CATS 只猫（3 × 8 张 ≈ 12s），
 * 返回 remaining 让前台接着点 —— 一次性建完必然撞云函数超时，
 * 而撞超时是「一只都没建成」，比分批糟得多。
 */
async function buildIndexFromSamples(user, event) {
  const e = event || {}
  const endpoint = process.env.AI_ENDPOINT
  if (!endpoint) throw new AppError('未配置 AI_ENDPOINT', 400)
  const schoolId = e.schoolId || (user && user.schoolId) || ''
  const viewCap = Math.max(1, Math.min(INDEX_PHOTOS_MAX, Number(e.photosPerCat) || INDEX_PHOTOS))
  const timeoutMs = Math.max(3000, Math.min(16000, Number(e.timeoutMs) || SAMPLE_BUILD_TIMEOUT_MS))
  const perCat = Math.max(1, Math.min(6, Number(e.samplePerCat) || SAMPLE_PHOTOS_PER_CAT))
  const minScore = (e.minScore === undefined || e.minScore === null)
    ? SAMPLE_MIN_SCORE : Number(e.minScore)

  const where = {}
  if (schoolId) where.schoolId = schoolId
  const res = await db.collection(COL.aiSample).where(where).limit(200).get()
  // 手动指定某只猫时把「已入库」的样本也算上（管理员点它就是要重算）；
  // 整批推进时只算没入库的，否则每轮都从头开始、remaining 永不归零。
  const manual = Array.isArray(e.catIds) && e.catIds.length
  const includeUsed = manual || e.includeUsed === true
  const plan = planSampleBuild(res.data || [], {
    samplePerCat: perCat, minScore: minScore,
    catIds: e.catIds, sampleIds: e.sampleIds,
    skipUsed: !includeUsed
  })
  if (!plan.picked.length) {
    return {
      ok: true, built: 0, scanned: 0, remaining: 0, cats: 0,
      reasons: {}, msg: '没有可用样本（可能都被排除、未归属，或低于 ' + minScore + ' 分门槛）'
    }
  }

  // 样本多的猫优先：同样一次调用，先覆盖收益最大的
  const countByCat = Object.create(null)
  plan.picked.forEach(p => { countByCat[p.catId] = (countByCat[p.catId] || 0) + 1 })
  const allCats = plan.catIds.slice().sort((a, b) => countByCat[b] - countByCat[a])
  // 手动指定时（catIds）不排队 —— 管理员点哪只就建哪只
  const todoCats = (manual ? allCats : allCats.slice(0, SAMPLE_BUILD_CATS))
  const restCats = allCats.slice(todoCats.length)

  const cats = await index(schoolId, { photosPerCat: viewCap, catIds: todoCats })
  const catById = Object.create(null)
  cats.forEach(c => { catById[c.id] = c })

  // 样本换临时链接（复用 attachTempUrls：顺带享受「陈旧链接反推」的自愈）
  const thumbs = plan.picked
    .filter(p => todoCats.indexOf(p.catId) >= 0)
    .map(p => ({ _id: p.id, photos: [p.fileId] }))
  await attachTempUrls(thumbs, 1)
  const urlOf = Object.create(null)
  thumbs.forEach(t => { urlOf[t._id] = (t.photosUrl && t.photosUrl[0]) || '' })

  const reasons = Object.create(null)
  const sendable = []
  todoCats.forEach(id => {
    const c = catById[id]
    if (!c) { reasons[id] = 'catMissing'; return }
    const arr = ((c.photosUrl || []).slice(0, viewCap)).slice()
    plan.picked.forEach(p => {
      if (p.catId !== id) return
      const u = urlOf[p.id]
      // 去重：同一张图既在档案里又被确认过，只算一次
      if (u && arr.indexOf(u) < 0) arr.push(u)
    })
    const views = arr.slice(0, viewCap)
    if (!views.length) { reasons[id] = 'noPhoto'; return }
    sendable.push({ id: c.id, name: c.name, pattern: c.pattern, color: c.color, photos: views })
  })

  if (!sendable.length) {
    return {
      ok: true, built: 0, scanned: todoCats.length, remaining: restCats.length,
      cats: plan.catIds.length, reasons, msg: '这些猫没有可用照片'
    }
  }

  const buildUrl = String(endpoint).replace(/\/v1\/recognize\/?$/, '/v1/index/build')
  if (buildUrl === String(endpoint)) {
    throw new AppError('AI_ENDPOINT 需以 /v1/recognize 结尾，才能推导建库地址', 400)
  }
  const out = await callVisionApi(buildUrl, {
    schoolId,
    photosPerCat: viewCap,
    // force：视图集合变了必须重算，否则服务端「已有向量」直接跳过
    onlyMissing: false,
    force: true,
    cats: sendable
  }, timeoutMs)

  const remote = (out && out.reasons) || {}
  Object.keys(remote).forEach(id => { reasons[id] = String(remote[id] || '') })
  const failed = Array.isArray(out && out.failed) ? out.failed : null
  const builtIds = failed
    ? sendable.map(c => c.id).filter(id => failed.indexOf(id) < 0)
    : (Number(out && out.built) >= sendable.length ? sendable.map(c => c.id) : [])

  if (builtIds.length) {
    markIndexed(builtIds)
    // 只把「真的建成的猫」的样本标成已用：建失败的下一轮还会再带上
    const usedIds = plan.picked
      .filter(p => builtIds.indexOf(p.catId) >= 0)
      .map(p => p.id)
      .slice(0, 100)
    if (usedIds.length) {
      db.collection(COL.aiSample)
        .where({ _id: _.in(usedIds) })
        .update({ data: { state: 'used', usedAt: new Date() } })
        .catch(err => console.warn('[vision] 标记样本已用失败', err && err.message))
    }
  }

  return {
    ok: true,
    built: Number(out && out.built) || 0,
    scanned: sendable.length,
    failed: failed || [],
    reasons,
    // 还有没建的猫：前台据此提示「再点一次继续」
    remaining: restCats.length,
    cats: plan.catIds.length,
    indexed: out && out.total,
    msg: ''
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
  const photosPerCat = Math.max(1, Math.min(INDEX_PHOTOS_MAX, Number(o.photosPerCat) || INDEX_PHOTOS))
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
  indexStatus, indexOneCat, engineHealth,
  fetchIndexIds, fetchEngineHealth, deleteIndexEntry,
  scoreCat, match, TOP_N, LOW_CONF,
  candidateReason, shapeCandidates,
  normalizeFeatures, identifiedFlag,
  pickPendingIndexCats, PENDING_INDEX_MAX,
  // 确认样本库（人工确认 → 特征库）：后台管理 + 手动建库
  listSamples, updateSample, deleteSample, buildIndexFromSamples,
  // 纯函数与阈值常量，供回归脚本直接断言（不依赖云环境）
  planSampleBuild, sampleMediaId, BLOCK_TEXT,
  INDEX_PHOTOS, INDEX_PHOTOS_AUTO, SAMPLE_PHOTOS_PER_CAT, SAMPLE_MIN_SCORE, SAMPLE_BUILD_CATS,
  // 供回归脚本测「陈旧临时链接自愈」（attachTempUrls 本身不改数据，导出无害）
  attachTempUrls, collectAuthorities, fileIdFromTempUrl
}
