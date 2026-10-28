const app = getApp()
const { showBusy, hideBusy, formatTime, shareBehavior } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')

// 历史识别记录：本地缓存 key，只保留最新 5 条
const HISTORY_KEY = 'recognize_history'
const HISTORY_MAX = 5

// 分析阶段文案（与真实请求并行，接口先返回则直接跳到完成）
//
// ⚠️ 进度上限刻意停在 92%（不是 100）：
//   这几步只是「氛围动画」，和真实进度无关。若动画先爬到 100，而真实识别还没结束
//   （同步超时 → 转轮询），轮询回报的进度（60%~95%）就会把进度条**从 100 退回去**，
//   用户看到「满格后又掉到 60 再慢慢涨」的诡异现象。
//   所以动画最高只到 92%，剩下的 92→100 只由「真正出结果」那一下点亮。
//   再配合 setProgress 的单调递增，进度条永不后退。
const STAGES = [
  { p: 20, text: '上传素材到云存储…' },
  { p: 40, text: '检测画面中的猫脸区域…' },
  { p: 58, text: '提取毛色 / 花纹特征向量…' },
  { p: 74, text: '在校园档案库中比对…' },
  { p: 92, text: '生成匹配结果' }
]
/** 动画能到的最高进度；100 只留给「真的完成」 */
const STAGE_CEIL = 92

/**
 * 「识别中」状态的最长存活时间。超过它仍停在 working，就判定为异常残留
 * （定时器泄漏 / 某次 await 永不 resolve），允许用户重新选择 ——
 * 否则 viewport 会永久失效，表现为「怎么点都没反应」。
 * 取 150s：轮询终局上限约 130s（20×2s + 30×3s），留足余量不误杀正常长尾。
 */
const WORKING_STALE_MS = 150000

const sleep = ms => new Promise(r => setTimeout(r, ms))

Page(Object.assign({
  data: {
    mode: 'image',          // image | video
    stage: 'idle',          // idle | working | done
    localPath: '',
    thumbPath: '',          // 视频封面帧（wx.chooseMedia 返回，用作代表帧）
    fileId: '',
    taskId: '',             // AI 任务 ID，用于人工确认
    progress: 0,
    stageText: '',
    result: null,
    duration: 0,
    confirmedId: '',        // 已人工确认的猫
    confirming: false,
    error: '',
    // 识别计费（规则：首次免费 → 20 猫粮/次，每天最多 10 次）。
    // 必须在**选素材之前**就让用户看到要花多少 —— 选完图才发现付不起，
    // 白等一次上传，且「点了没反应」的体感极差。
    wallet: {
      food: 0, cost: 20, free: true, waived: false, left: 10, limit: 10,
      // 默认中性文案：pointsSummary 失败时不能写成「首次识别免费」——
      // 那会给出一个未经核实的结论，用户按它去识别却可能被扣费。
      hint: '识别 20 猫粮值/次 · 每天 10 次'
    },
    history: []             // 历史识别记录（最新 5 条）
  },

  onLoad(options) {
    // 巡检护栏：working 计时器归零（页面每次进入都是干净的 idle）
    this._workingSince = 0
    if (options.mode === 'video') this.setData({ mode: 'video' })
    this.loadHistory()
  },

  onShow() {
    // 每次回到本页都刷新余额：用户可能刚从「我的」页赚了猫粮再回来
    this.loadWallet()
  },

  /** 拉识别计费信息：余额 / 本次价格 / 今日剩余次数 */
  async loadWallet() {
    try {
      const s = await app.callApi('pointsSummary', {})
      const rec = s.recognize || {}
      const free = !!rec.free
      // 超管免消耗由云端下发（前端无从判断超管身份：那要看环境变量里的 openid 白名单）
      const waived = !!rec.waived
      const cost = waived ? 0 : (Number(rec.cost) || 20)
      const left = rec.left == null ? 10 : Number(rec.left)
      const food = Number(s.food) || 0
      // 文案在这里拼好：WXML 的 mustache 不做字符串拼接
      const hint = waived
        ? '超级管理员免消耗 · 不限次数'
        : (free
          ? '首次识别免费'
          : '本次消耗 ' + cost + ' 猫粮值 · 今日还剩 ' + left + ' 次')
      this.setData({ wallet: { food, cost, free, waived, left, limit: Number(rec.limit) || 10, hint } })
    } catch (e) {
      // 读失败保持默认值（free:true）——真到扣费那一步云端还会再校验，
      // 这里不该因为「余额查询失败」就拦住用户
      console.warn('[recognize] 计费信息读取失败', e && e.message)
    }
  },

  /**
   * 识别前的前置校验。
   *
   * 只用本地已有信息做一次「明显付不起」的拦截，**不代替云端校验**：
   * 并发下单靠云端事务保证，这里只是省掉「传完图才报错」的坏体验。
   *
   * 超管直接放行：云端既不扣猫粮也不计次，本地再拦一次只会让验收卡死。
   */
  ensureBillable() {
    const w = this.data.wallet || {}
    if (w.waived) return true
    if (Number(w.left) <= 0) {
      wx.showModal({
        title: '今日次数已用完',
        content: '每天最多识别 ' + (w.limit || 10) + ' 次，明天再来～',
        showCancel: false
      })
      return false
    }
    if (!w.free && Number(w.food) < Number(w.cost)) {
      wx.showModal({
        title: '猫粮值不足',
        content: '本次识别需要 ' + w.cost + ' 猫粮值，当前 ' + w.food + '。\n做打卡、建档案都能赚猫粮值。',
        confirmText: '去赚猫粮',
        success: r => {
          if (r.confirm) wx.switchTab({ url: '/pages/mine/mine' })
        }
      })
      return false
    }
    return true
  },

  /* ==================== 历史识别记录 ====================
   * 只存本地（wx.storage），每条 = { ts, timeText, mode, result, taskId }。
   * 上限 5 条：新的进来，最老的挤掉 —— 存储不膨胀，列表也不至于滚不到头。
   * 点击某条 = 把当时的结果原样放回页面（stage:'done'），
   * 图片本体的 tempPath 已随缓存过期失效，但候选头像走的是云端临时链接，仍可展示。
   */
  loadHistory() {
    let list = []
    try { list = wx.getStorageSync(HISTORY_KEY) || [] } catch (e) { list = [] }
    this.setData({ history: Array.isArray(list) ? list.slice(0, HISTORY_MAX) : [] })
  },

  saveHistory(result, taskId) {
    try {
      const list = wx.getStorageSync(HISTORY_KEY) || []
      list.unshift({
        ts: Date.now(),
        timeText: formatTime(new Date()),
        mode: this.data.mode,
        result,
        taskId: taskId || ''
      })
      wx.setStorageSync(HISTORY_KEY, list.slice(0, HISTORY_MAX))
    } catch (e) {
      console.warn('[recognize] 历史记录写入失败', e)
    }
    this.loadHistory()
  },

  /**
   * 候选头像换成 https：cloud:// fileID 在开发者工具里会被当成相对路径
   * 交给本地 pageframe 加载（报 Failed to load image http://127.0.0.1:port/__pageframe__/...），
   * 分享卡片同样不认；顺带把原图换成小尺寸缩略，候选列表加载更快。
   * 预取完成后自动把地址升级为 https，不改变 result 其余字段。
   *
   * hydrateCats 会额外产出 avatarId（原始 fileID）——
   * 渲染用 avatar（https 缩略），兜底重换链用 avatarId。
   */
  /**
   * 预计算展示字段。
   *
   * WXML 的 mustache 是**编译期白名单**，`map / join / indexOf` 会被静默忽略、
   * 整段退化成 false（"点击有回调但界面没反应"的经典病根）。所以属性摘要
   * 必须在 JS 里拼好，模板只做取值。
   *
   * 为什么单独摘出属性：毛色/花纹/品种是用户唯一能自己校验的信息 ——
   * 身份没认出来时，它是这次识别**唯一有价值的产出**，必须显眼地给出来。
   */
  decorate(result) {
    const f = (result && result.features) || {}
    const tags = Array.isArray(f.tags) ? f.tags : []
    const ATTR_KEYS = { '品种': 1, '毛色': 1, '花纹': 1 }
    const vals = []
    tags.forEach(t => {
      if (t && ATTR_KEYS[t.k] && t.v) vals.push(String(t.v))
    })
    const attrText = vals.join(' · ')
    const hasAttr = !!attrText
    // 摘要把「品种」放第一位（服务端保证顺序），它是最像"结论"的那个词
    const head = hasAttr ? attrText.split(' · ')[0] : ''
    // 质量门控（2026-10-26）：服务端判定「猫在画面里占比太小」时**不会返回候选**，
    // 花色也一并弃权。这时界面只有一句解释 + 一个重拍引导，绝不能表现成
    // "没有匹配到猫咪"—— 那是认不认识的问题，而这里是照片看不清的问题，
    // 用户该做的动作完全不同（重拍 vs 新建档案）。
    const qualityBlocked = !!(result && result.qualityOk === false)
    return {
      attrText,
      hasAttr,
      qualityBlocked,
      qualityReason: (result && result.qualityReason) || '',
      // 判不出属性时给一句人话原因。服务端 meta.attrReason 里带着具体数字
      //（"画面里猫体区域不足 12%"），比笼统的"识别失败"有用得多。
      attrHint: hasAttr ? ''
        : (result.attrReason || '这次没能判断出毛色和花纹，换一张更清楚的正面照再试。'),
      // 没认出是哪只、但看出了花色 → 标题直接说花色，比「档案库里没有它」信息量高
      guessTitle: hasAttr ? ('看起来是「' + head + '」') : '档案库里没有它'
    }
  },

  withPhotoUrls(result) {
    if (!result || !Array.isArray(result.candidates)) return result
    const apply = cands => this.setData({ 'result.candidates': cands })
    return Object.assign({}, result, this.decorate(result), {
      candidates: photo.hydrateCats(result.candidates, { px: 200 }, apply)
    })
  },

  /**
   * 候选头像加载失败：三级兜底，任何一级成功即止；全失败退 🐱 占位。
   *
   *  ① 去缩略参数：`?sign=...&imageMogr2/thumbnail/200x` → `?sign=...`
   *     （参数不被支持 / 被边缘节点拒时自救）
   *  ② 重新换链：丢掉缓存、对原始 fileID 重新 getTempFileURL 拿**新签名**
   *  ③ 置空 → 模板渲染 🐱
   *
   * 为什么必须有 ②（2026-10-15 现场）：
   *   渲染层报 Failed to load image .../cats/1792074374248-539.jpg?sign=...&imageMogr2/thumbnail/200x，
   *   而**同一条链接去掉 imageMogr2 后也照样报错** —— 根因不是参数，是这条临时链接
   *   本身已经不可用（签名过期 / 文件被覆盖）。旧兜底链到 ① 就结束了，
   *   结果只是拿同一个坏地址再试一次，必然再失败。
   */
  onCandAvatarErr(e) {
    const i = e.currentTarget.dataset.i
    const c = (this.data.result && this.data.result.candidates || [])[i]
    if (!c || !c.avatar) return

    // ① 去参数
    if (photo.hasProcess(c.avatar)) {
      this.setData({ ['result.candidates[' + i + '].avatar']: photo.stripProcess(c.avatar) })
      return
    }

    // ② 重新换链（只有原始值是真 fileID 时才有意义）
    const fileId = c.avatarId || (photo.isFileId(c.avatar) ? c.avatar : '')
    if (fileId && !c._relinked) {
      this.setData({ ['result.candidates[' + i + ']._relinked']: true })
      photo.refresh(fileId).then(url => {
        const item = (this.data.result && this.data.result.candidates || [])[i]
        if (!item) return
        this.setData({ ['result.candidates[' + i + '].avatar']: url || '' })
      }).catch(() => {
        this.setData({ ['result.candidates[' + i + '].avatar']: '' })
      })
      return
    }

    // ③ 退占位
    this.setData({ ['result.candidates[' + i + '].avatar']: '' })
  },

  // 点击某条历史 → 回看该次识别结果
  tapHistory(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const item = this.data.history[idx]
    if (!item || !item.result) return
    this.setData({
      stage: 'done',
      error: '',
      result: this.withPhotoUrls(item.result),
      taskId: item.taskId || '',
      confirmedId: '',       // 回看只是展示，不重放确认动作
      progress: 100,
      stageText: '完成'
    })
  },

  clearHistory() {
    wx.showModal({
      title: '清空识别记录',
      content: '将删除本机保存的全部识别历史，确定吗？',
      confirmText: '清空',
      confirmColor: '#F97316',
      success: res => {
        if (!res.confirm) return
        try { wx.removeStorageSync(HISTORY_KEY) } catch (e) {}
        this.loadHistory()
        wx.showToast({ title: '已清空', icon: 'none' })
      }
    })
  },

  // 选择素材：拍照 / 相册 / 拍视频
  //
  // ⚠️ 2026-10-15 现场：切到「视频识别」后点取景区**毫无反应**，图片模式正常。
  //   根因有两层：
  //     ① 视频走 `wx.chooseMedia({ mediaType:['video'], sourceType:['album','camera'] })`，
  //        在部分基础库/机型上这个组合会直接 fail（返回 errMsg 而非抛错），
  //        而旧代码的 catch 把一切失败都当成「用户取消」静默吞掉 → 用户眼里就是「点了没反应」。
  //     ② 即便不 fail，`chooseMedia` 选视频时 `thumbTempFilePath`（封面帧）并非稳定返回，
  //        后续若无封面帧会退化；`wx.chooseVideo` 才是视频场景的规范接口，返回
  //        `tempFilePath` + `thumbTempFilePath`（封面）最稳。
  //   修法：视频模式优先 `wx.chooseVideo`，失败再回退 `wx.chooseMedia`；
  //        并且**区分「真取消」与「真失败」** —— 只有 errMsg 含 cancel/取消 才算取消，
  //        其余一律 toast 出来，不再让失败无声无息。
  async choose() {
    // 重入保护：识别进行中（stage==='working'）viewport 仍可点，
    // 再选素材会起第二路上传+轮询，两路 setData 互相覆盖、两个定时器并存。
    //
    // ⚠️ 但不能「无条件静默 return」—— 现场出现过 stage 因异常残留在 working，
    //    此后**每次点击都被永远吞掉**，用户看到的就是「点了完全没反应」（连 toast 都没有），
    //    比失败还难排查。所以加两道保险：
    //      ① 超过 WORKING_STALE_MS 仍停在 working（异常残留 / 定时器泄漏）→ 视为僵死，自动复位后可重选；
    //      ② 未僵死但确实在跑 → 给一句轻提示，让用户知道「点了，只是正在忙」。
    if (this.data.stage === 'working') {
      const stale = Date.now() - (this._workingSince || this._watchdogStarted || 0) > WORKING_STALE_MS
      if (!stale) {
        wx.showToast({ title: '正在识别中，请稍候', icon: 'none' })
        return
      }
      console.warn('[recognize] 识别状态疑似僵死，自动复位后重新选择')
      this.reset()
    }
    // 计费前置校验：放在选素材**之前**。选完才发现付不起，等于白等一次上传。
    if (!this.ensureBillable()) return
    const mode = this.data.mode
    let f = null
    try {
      f = mode === 'video' ? await this.pickVideo() : await this.pickImage()
    } catch (e) {
      if (this.isCancel(e)) {
        console.log('[recognize] 选择取消')
      } else {
        // 真失败必须让用户知道，否则「点了没反应」。
        // 同样注意 errMsg 才是微信 API 的载体（普通对象，不是 Error）。
        console.error('[recognize] 选择素材失败', e)
        const msg = (e && (e.errMsg || e.message)) || '打开相册失败'
        wx.showToast({ title: msg, icon: 'none' })
      }
      return
    }
    if (!f || !f.tempFilePath) {
      // 选择器返回了但拿不到可用路径（部分机型视频返回结构差异）：
      // 静默 return 会再次变成「点了没反应」，必须明确告知。
      console.warn('[recognize] 选择结果缺少 tempFilePath', f)
      wx.showToast({ title: mode === 'video' ? '未能读取所选视频，请重试' : '未能读取所选照片，请重试', icon: 'none' })
      return
    }
    this.setData({
      localPath: f.tempFilePath,
      thumbPath: f.thumbTempFilePath || '',
      duration: f.duration || 0,
      result: null,
      confirmedId: '',
      taskId: '',
      error: ''
    })
    this.analyze(f.tempFilePath)
  },

  /** 是否「用户主动取消」（而非真实失败）。chooseMedia/chooseVideo 的 errMsg 均形如：
   *  "chooseMedia:fail cancel" / "chooseVideo:fail cancel" */
  isCancel(e) {
    const msg = String((e && (e.errMsg || e.message)) || '')
    return /cancel|取消/i.test(msg)
  },

  /** 选图片：chooseMedia 单图，压缩后上传 */
  async pickImage() {
    const res = await wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      camera: 'back'
    })
    return res.tempFiles && res.tempFiles[0]
  },

  /** 选视频：优先 chooseVideo（视频场景规范接口，封面帧稳定返回），
   *  失败（含不支持 / 权限 / 真错误；用户取消也走这里）再回退 chooseMedia。
   *  两者都失败才向上抛，由 choose 统一提示。 */
  async pickVideo() {
    if (typeof wx.chooseVideo === 'function') {
      try {
        const r = await wx.chooseVideo({
          sourceType: ['album', 'camera'],
          maxDuration: 15,
          camera: 'back',
          compressed: true
        })
        // chooseVideo 返回 { tempFilePath, duration, thumbTempFilePath, size, height, width }
        if (r && r.tempFilePath) {
          return {
            tempFilePath: r.tempFilePath,
            thumbTempFilePath: r.thumbTempFilePath || '',
            duration: r.duration || 0
          }
        }
      } catch (e) {
        // 用户主动取消：不再回退（否则会立刻又弹一次选择器，体验很怪），直接向上抛
        if (this.isCancel(e)) throw e
        console.warn('[recognize] chooseVideo 失败，回退 chooseMedia', e && (e.errMsg || e.message))
      }
    }
    const res = await wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['album', 'camera'],
      maxDuration: 15,
      camera: 'back'
    })
    return res.tempFiles && res.tempFiles[0]
  },

  switchMode(e) {
    const m = e.currentTarget.dataset.mode
    if (m === this.data.mode) return
    // 切模式即作废上一次的 working 计时（视频↔图片互切时不该继承僵死判定）
    this._workingSince = 0
    this.setData({
      mode: m, localPath: '', thumbPath: '', fileId: '', result: null,
      stage: 'idle', progress: 0, taskId: '', confirmedId: '', error: ''
    })
  },

  /**
   * 单调递增的进度写入 —— **进度条只许前进，永不后退**。
   *
   * 为什么需要它（2026-10-15 现场）：
   *   氛围动画（analyze 里的 setInterval）与轮询回报（pollResult）是两条独立来源，
   *   各自算各自的进度。动画若先爬到 100，轮询再报 60 就会把进度条**拽回去**，
   *   用户看到「满格→掉到 60→又慢慢涨」。统一走这里，取两者的最大值即天然单调。
   *   完成时才显式置 100（见 analyze 成功分支），不再由动画代劳。
   *
   * @param {number} p 目标进度
   * @param {string} [text] 可选的阶段文案
   */
  setProgress(p, text) {
    const next = Math.max(this.data.progress || 0, Math.max(0, Math.min(100, p | 0)))
    if (next === this.data.progress && text === undefined) return
    const patch = { progress: next }
    if (text !== undefined) patch.stageText = text
    this.setData(patch)
  },

  /**
   * 上传一个本地临时文件到云存储，**必定返回带 fileID 的结果**，否则抛可读错误。
   *
   * 为什么不能直接 `const up = await wx.cloud.uploadFile(...)`：
   *  ① `uploadFile` 失败时抛的是**普通对象** `{ errMsg: 'uploadFile:fail timeout' }` 而非 Error，
   *     外层 `e.message` 取到 undefined → 用户只看到兜底文案「识别失败，请重试」，
   *     完全不知道是**上传**这一步挂了（视频体积大、上传最容易超时，现场就是这么被误导的）。
   *  ② 更隐蔽的：某些情况下 uploadFile 会「成功 resolve 但没有 fileID」
   *     （返回体被中间层改写 / statusCode 非 200 却不 reject）。旧代码不校验，
   *     于是 `up.fileID` 是 undefined 也一路往下走 —— 表现正是「选了视频点确定，没上传」：
   *     界面甚至显示识别完成，但云上什么都没有。
   *
   * 这里统一：解析 errMsg → 人话；缺 fileID → 显式抛错。宁可在上传这步就明确失败。
   *
   * @param {string} cloudPath 云端路径
   * @param {string} filePath  本地临时路径
   * @param {string} label     给用户看的素材名（照片 / 视频 / 视频封面）
   */
  async uploadToCloud(cloudPath, filePath, label) {
    let res
    try {
      res = await wx.cloud.uploadFile({ cloudPath, filePath })
    } catch (e) {
      // uploadFile 抛 errMsg；也可能抛真 Error。两种都取出可读信息。
      const msg = String((e && (e.errMsg || e.message)) || '').trim()
      throw new Error(label + '上传失败' + (msg ? '：' + msg.replace(/^uploadFile:fail\s*/i, '') : '，请检查网络后重试'))
    }
    if (!res || !res.fileID) {
      // 关键护栏：没有 fileID 就没有真正上传，绝不能让流程继续假装成功
      console.error('[recognize] uploadFile 未返回 fileID', res)
      throw new Error(label + '上传失败：云端未返回文件标识，请重试')
    }
    return res
  },

  // 上传 + 识别
  async analyze(tempPath) {
    // 重入保护（与 choose 双保险）：working 中重复 analyze 直接忽略
    if (this.data.stage === 'working') return
    // 记下开始时刻，供 choose 的僵死判定（见 WORKING_STALE_MS）
    this._workingSince = Date.now()
    // 视频要下载 + 抽帧 + 逐帧推理（服务端约 3.5s，是图片的 3 倍），
    // 且几乎必然走「同步超时 → 轮询接手」这条路。先把预期说清楚，
    // 否则用户看到进度条停在 92% 不动，只会以为卡死了。
    const isVideo = this.data.mode === 'video'
    this.setData({
      stage: 'working',
      progress: 8,
      stageText: isVideo ? '视频处理中，约需 10~20 秒…' : '准备中…'
    })

    // 阶段动画（与真实请求并行，接口先返回则直接跳出）。
    // 走 setProgress 保持单调；且最高只到 STAGE_CEIL(92)，绝不自己爬到 100 ——
    // 否则同步超时转轮询时，轮询回报的更小进度会把进度条往回拽。
    let i = 0
    const timer = setInterval(() => {
      if (i < STAGES.length) {
        this.setProgress(STAGES[i].p, STAGES[i].text)
        i++
      } else {
        // 动画放完了活还没干完（转轮询中）：停住别再涨，
        // 由 pollResult 的 setProgress 慢慢把它往 95 推。
        clearInterval(timer)
      }
    }, 420)

    try {
      await app.ensureReady()

      const type = this.data.mode === 'video' ? 'video' : 'image'

      // 1) 上传到云存储
      const ext = (tempPath.split('.').pop() || 'jpg').toLowerCase()
      const stamp = Date.now() + '-' + Math.random().toString(36).slice(2)
      const cloudPath = `recognize/${stamp}.${ext}`
      const up = await this.uploadToCloud(cloudPath, tempPath, type === 'video' ? '视频' : '照片')

      // 视频额外上传封面帧：云函数没有 ffmpeg，用封面帧作为代表帧（省一次解码）
      // ⚠️ 封面帧失败**不算致命**：没有 thumb 时云端会退回用视频本体（mediaId 取 fileId），
      //    只是多一次下载；但绝不能因为封面帧失败就让整条识别失败（视频场景最易踩）。
      let thumbId = ''
      if (type === 'video' && this.data.thumbPath) {
        try {
          const tup = await this.uploadToCloud(
            `recognize/${stamp}-thumb.jpg`, this.data.thumbPath, '视频封面'
          )
          thumbId = tup.fileID
        } catch (te) {
          console.warn('[recognize] 封面帧上传失败，云端将退回视频本体', te)
        }
      }

      const loc = app.globalData.myLocation || null

      // 2) 识别：先建任务（轻），再「同步一把梭」，超时/失败转轮询接管。
      //
      // 为什么保留同步尝试：完整链路在服务温热、照片不大时约 2~3s，
      // 能一把出结果就不用轮询 —— 这就是改动前的体验。
      // 同步调用超过客户端约 3s 预算会报 -504003，这**不是失败**：
      // 云函数侧会继续把活干完（每一步的产物都已落库），此时转轮询从断点接管。
      // 只有拆成「建任务(轻) + 同步跑(带断点续跑) + 轮询兜底」才能在预算内稳定跑完，
      // 视频和图片因此共用同一条路径。
      const started = await app.callApi('recognizeStart', {
        fileId: up.fileID,
        thumbId: type === 'video' ? thumbId : '',
        type,
        duration: this.data.duration,
        location: loc
      })
      this.setData({ taskId: started.taskId })

      let result = null
      try {
        // 同步快路径：服务温热时一把出结果（内部已按 taskId 复用，不会重复建任务）
        const direct = await app.callApi('recognize', { taskId: started.taskId })
        result = direct || null
      } catch (syncErr) {
        // 超时(-504003)/被抢占/可重试错误 → 轮询接管（任务已落库，续跑安全）
        console.warn('[recognize] 同步识别未直接返回，转轮询接管', syncErr && syncErr.message)
        const polled = await this.pollResult(started.taskId)
        result = polled.result
      }
      if (!result) throw new Error('识别未返回结果，请重试')

      clearInterval(timer)
      // 扣费在云端已发生（首次免费也记了一笔流水），立刻刷新余额与剩余次数。
      // 不 await：余额显示晚一拍不影响出结果，阻塞反而让"结果出现"更慢。
      this.loadWallet()
      // 成功即入历史（最新 5 条），供之后在首页回看
      this.saveHistory(result, started.taskId)
      // 真正的终态才把进度点到 100（走 setProgress 保证与前面的单调序列衔接）
      this.setProgress(100, '完成')
      this.setData({ fileId: up.fileID, result: this.withPhotoUrls(result), stage: 'done' })
    } catch (e) {
      clearInterval(timer)
      console.error('[recognize]', e)
      // ⚠️ 微信 API 抛的是普通对象（{errMsg}）而非 Error，e.message 会是 undefined，
      //    这里必须回落到 errMsg，否则所有上传/接口失败都退化成同一句「识别失败，请重试」，
      //    用户根本无从判断是哪一步挂的（视频上传超时被误认成「点了没反应」的主因之一）。
      const msg = (e && (e.message || e.errMsg)) || ''
      // 终态：进度也置 100（失败态由 error 文案表达，进度条不该停在半路）
      this.setProgress(100, '识别结束')
      this.setData({ stage: 'done', error: msg || '识别失败，请重试' })
    }
  },

  // 轮询异步识别结果（幂等：重复轮询不会重复计算）
  //
  // 容错要点：云函数单次调用本身可能因冷启动/网络抖动偶发超时（-504003），
  // 这类失败是**可重试**的 —— 任务已经落库、分步续跑 + 租约机制保证只算一段。
  //
  // ⚠️ 2026-10-15 修正（现场：上传「另一只猫」没匹配上，控制台刷 -504003 后直接报失败）：
  //   旧写法把 -504003 归进「transient」并规定「连续 8 次就判死」——
  //   8 × 2s = 16 秒后抛「识别服务暂不可用」。但 -504003 对轮询**根本不是故障**：
  //   它是「这次调用没能在 3s 内返回」，而云函数侧的活还在继续干（或下轮租约到期被接管）。
  //   任务在库、步骤可续，只要继续轮询终局一定会到 —— 把「后台还在干活」判死，
  //   就是用户看到的「干等十几秒然后失败」。
  //   同时它也不是「每次都超时」：冷启动那一两次最慢，实例热起来后就正常返回了。
  //   现在的策略分两段：
  //     常规段（前 20 轮，2s/次）：偶发失败继续重试；一旦出现**明确业务错误**立即失败
  //     长尾段（其后每 3s，最多 30 次）：降低频率接着等，直到某个轮次成功返回
  //       一个终局状态（done/failed）—— 那才是有信息量的信号。
  //
  //   另外：轮次改按「分步续跑」设计 —— ''(安全检测) → 'sec'(换链接) → 'cats'(提特征+匹配)，
  //   每步一次 poll。终局上限（约 130s）比旧版 80s 更宽，
  //   因为冷启动 + AI 实例唤醒 + 补库在慢环境下确实会吃满一分钟。
  async pollResult(taskId) {
    const FAST_ROUNDS = 20          // 常规段：2s 一次
    const SLOW_ROUNDS = 30          // 长尾段：3s 一次
    let transient = 0
    let lastErr = null
    for (let n = 0; n < FAST_ROUNDS + SLOW_ROUNDS; n++) {
      const slow = n >= FAST_ROUNDS
      let r
      try {
        r = await app.callApi('recognizePoll', { taskId })
      } catch (e) {
        transient++
        lastErr = e
        // 明确业务错误（鉴权、任务不存在、素材未过检）重试无意义，立即失败。
        // 只认这些；-504003 与网络类错误一律继续等。
        const msg = (e && e.message) || ''
        if (/无权访问|无权限|任务不存在|未通过安全|参数|invalid/i.test(msg) && !/timed out|-504003/i.test(msg)) {
          throw new Error(msg)
        }
        console.warn('[recognize] 第 ' + (n + 1) + ' 次轮询未返回，继续等待', msg)
        // 连续失败只用来「降频」，不再用来判死（判死的依据只能是任务本身 failed）
        if (transient >= 8 && !slow) {
          console.warn('[recognize] 连续多次未返回，转为慢速轮询等待后台完成')
        }
        await sleep(this.pollGap(n))
        continue
      }
      transient = 0
      lastErr = null
      if (r.status === 'done') return r
      if (r.status === 'failed') throw new Error(r.error || '识别失败')
      // 云端分步进度（step ''=安全检测 → 'sec'=换链 → 'cats'=提特征/匹配）折算到 40~95 区间。
      // 走 setProgress（单调）：即便动画已把它推到 92，这里也不会把它拉回去；
      // 反过来若轮询值更高（如 95），就顺滑地接着涨。100 只由「真出结果」那一下点亮。
      const polled = 40 + (Number(r.progress) || 0) * 0.55
      this.setProgress(Math.min(95, polled), this.pollStageText(r.progress))
      await sleep(this.pollGap(n))
    }
    throw new Error((lastErr && (lastErr.message || '识别超时')) || '识别超时，请稍后重试')
  },

  /**
   * 轮询间隔。
   *
   * 前三轮用 1.2s 而不是 2s：实测一条识别通常在前两三轮询里就出结果，
   * 固定 2s 等于给每次识别白加 2.4 秒。慢段（20 轮之后）保持 3s，
   * 那是长尾，降频省调用、也让后台从容算完。
   */
  pollGap(n) {
    if (n >= 20) return 3000
    return n < 3 ? 1200 : 2000
  },

  /**
   * 轮询阶段文案：把云端 progress 映射成用户能看懂的一句话。
   *
   * 视频要额外说明「慢是正常的」：它走的一定是轮询路径（服务端 3.5s，
   * 超过云函数单次窗口），进度条会在 92% 附近停十几秒。文案里不给预期，
   * 用户只能盯着不动的进度条怀疑是不是卡死了。
   */
  pollStageText(p) {
    const v = Number(p) || 0
    const slow = this.data.mode === 'video'
    const tail = slow ? '（视频约需 10~20 秒）' : ''
    if (v < 30) return '正在做安全检测…' + tail
    if (v < 55) return '正在准备比对素材…' + tail
    if (v < 100) return slow ? '正在逐帧提取特征并比对…' + tail : '正在提取特征并比对…'
    return '即将完成…'
  },

  goCat(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/cat-detail/cat-detail?id=' + id })
  },

  // 人工确认：记一条标注样本（ai_samples）+ 解锁图鉴。
  // ⚠️ 这里**不写特征库**，也别在界面/注释里暗示「确认会让系统变准」——
  // 特征库只从档案照建（见云端 vision.confirm 的注释）。
  async confirmTop(e) {
    const catId = e.currentTarget.dataset.id
    if (!catId || !this.data.taskId || this.data.confirming) return
    this.setData({ confirming: true })
    showBusy({ title: '提交中' })
    try {
      const r = await app.callApi('confirmRecognize', {
        taskId: this.data.taskId,
        catId,
        correct: true
      })
      hideBusy()
      this.setData({ confirmedId: catId })
      // 已不再把识别照片写进特征库（见云端 vision.confirm 注释）；
      // 这里只反馈「已记录 / 图鉴已解锁」，不再提「计入特征库」。
      wx.showToast({
        title: r && r.duplicated ? '已确认' : '已记录 +5',
        icon: 'none'
      })
    } catch (err) {
      hideBusy()
      wx.showToast({ title: err.message || '提交失败', icon: 'none' })
    } finally {
      this.setData({ confirming: false })
    }
  },

  // 候选都不对：记为负样本，帮助后续改进
  async confirmNone() {
    if (!this.data.taskId || this.data.confirming) return
    this.setData({ confirming: true })
    try {
      await app.callApi('confirmRecognize', { taskId: this.data.taskId, catId: '', correct: false })
      this.setData({ confirmedId: 'none' })
      wx.showToast({ title: '已记录，谢谢反馈', icon: 'none' })
    } catch (err) {
      wx.showToast({ title: err.message || '提交失败', icon: 'none' })
    } finally {
      this.setData({ confirming: false })
    }
  },

  // 用这次识别结果去打卡
  goSighting() {
    const r = this.data.result || {}
    const qs = []
    if (this.data.fileId) qs.push('photo=' + encodeURIComponent(this.data.fileId))
    if (r.candidates && r.candidates.length) qs.push('catId=' + r.candidates[0].catId)
    wx.navigateTo({ url: '/pages/sighting-post/sighting-post' + (qs.length ? '?' + qs.join('&') : '') })
  },

  // 没匹配上 → 新建档案，带上识别出的特征
  goCreate() {
    const r = this.data.result || {}
    const f = r.features || {}
    const qs = []
    if (this.data.fileId) qs.push('photo=' + encodeURIComponent(this.data.fileId))
    if (f.pattern) qs.push('pattern=' + f.pattern)
    if (f.color) qs.push('color=' + encodeURIComponent(f.color))
    wx.navigateTo({ url: '/pages/cat-edit/cat-edit' + (qs.length ? '?' + qs.join('&') : '') })
  },

  reset() {
    this._workingSince = 0
    this.setData({
      stage: 'idle', localPath: '', thumbPath: '', fileId: '', result: null,
      progress: 0, stageText: '', error: '', duration: 0,
      taskId: '', confirmedId: ''
    })
    this.loadHistory()   // 从回看状态返回首页时，刷新历史列表
  }
// ↓ 识别页是最有传播价值的一条路径：识别成功后转发，标题直接带猫名/结果，
//   落地页仍是识别页（新用户点进来立刻能自己试一把，转化最顺）。
//   注意分享卡片封面只认可直连的 https —— 候选头像是换过链的 https，直接可用；
//   cloud:// fileID 在这里无效，检测到就交给微信自动截页面。
}, shareBehavior(function () {
  const r = this.data.result
  const top = r && r.candidates && r.candidates[0]
  const cover = (top && /^https?:\/\//.test(top.avatar || '')) ? top.avatar : ''
  const out = {
    title: top
      ? ('我用喵园认出了「' + (top.name || '一只猫') + '」🐱')
      : '你也来认认校园里的猫 · 喵园',
    path: top
      ? ('/pages/cat-detail/cat-detail?id=' + top.catId)
      : '/pages/recognize/recognize'
  }
  if (cover) out.imageUrl = cover
  return out
})))
