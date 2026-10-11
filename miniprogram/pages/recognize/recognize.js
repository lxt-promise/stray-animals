const app = getApp()
const { showBusy, hideBusy, formatTime } = require('../../utils/util.js')

// 历史识别记录：本地缓存 key，只保留最新 5 条
const HISTORY_KEY = 'recognize_history'
const HISTORY_MAX = 5

// 分析阶段文案（与真实请求并行，接口先返回则直接跳到 done）
const STAGES = [
  { p: 20, text: '上传素材到云存储…' },
  { p: 45, text: '检测画面中的猫脸区域…' },
  { p: 70, text: '提取毛色 / 花纹特征向量…' },
  { p: 90, text: '在校园档案库中比对…' },
  { p: 100, text: '生成匹配结果' }
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

Page({
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
    history: []             // 历史识别记录（最新 5 条）
  },

  onLoad(options) {
    if (options.mode === 'video') this.setData({ mode: 'video' })
    this.loadHistory()
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

  // 点击某条历史 → 回看该次识别结果
  tapHistory(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const item = this.data.history[idx]
    if (!item || !item.result) return
    this.setData({
      stage: 'done',
      error: '',
      result: item.result,
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
  async choose() {
    const mode = this.data.mode
    try {
      const res = await wx.chooseMedia({
        count: 1,
        mediaType: [mode],
        sourceType: ['album', 'camera'],
        maxDuration: 15,
        camera: 'back'
      })
      const f = res.tempFiles && res.tempFiles[0]
      if (!f) return
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
    } catch (e) {
      // 用户取消
      console.log('[recognize] 选择取消', e)
    }
  },

  switchMode(e) {
    const m = e.currentTarget.dataset.mode
    if (m === this.data.mode) return
    this.setData({
      mode: m, localPath: '', thumbPath: '', fileId: '', result: null,
      stage: 'idle', progress: 0, taskId: '', confirmedId: '', error: ''
    })
  },

  // 上传 + 识别
  async analyze(tempPath) {
    this.setData({ stage: 'working', progress: 8, stageText: '准备中…' })

    // 阶段动画（与真实请求并行，接口先返回则直接跳 100）
    let i = 0
    const timer = setInterval(() => {
      if (i < STAGES.length) {
        this.setData({ progress: STAGES[i].p, stageText: STAGES[i].text })
        i++
      }
    }, 420)

    try {
      await app.ensureReady()

      const type = this.data.mode === 'video' ? 'video' : 'image'

      // 1) 上传到云存储
      const ext = (tempPath.split('.').pop() || 'jpg').toLowerCase()
      const stamp = Date.now() + '-' + Math.random().toString(36).slice(2)
      const cloudPath = `recognize/${stamp}.${ext}`
      const up = await wx.cloud.uploadFile({ cloudPath, filePath: tempPath })

      // 视频额外上传封面帧：云函数没有 ffmpeg，用封面帧作为代表帧（省一次解码）
      let thumbId = ''
      if (type === 'video' && this.data.thumbPath) {
        const tup = await wx.cloud.uploadFile({
          cloudPath: `recognize/${stamp}-thumb.jpg`,
          filePath: this.data.thumbPath
        })
        thumbId = tup.fileID
      }

      const loc = app.globalData.myLocation || null

      // 2) 识别：统一走「异步任务 + 轮询」。
      //
      // 为什么不按模式分叉：
      //  单次 recognize 同步链路要串起「安全检测 → 拉档案库 → 换图链 → 特征提取」，
      //  实测约 2.4~2.9s，正好压在客户端 cloud.callFunction 约 3s 的调用预算上，
      //  现场表现就是 `-504003 Invoking task timed out after 3 seconds`。
      //  只有拆成「建任务(轻) + 轮询(每次只做一段工作)」才能在预算内稳定跑完，
      //  视频和图片因此共用同一条路径。
      const started = await app.callApi('recognizeStart', {
        fileId: up.fileID,
        thumbId: type === 'video' ? thumbId : '',
        type,
        duration: this.data.duration,
        location: loc
      })
      this.setData({ taskId: started.taskId })
      const polled = await this.pollResult(started.taskId)
      const result = polled.result
      if (!result) throw new Error('识别未返回结果，请重试')

      clearInterval(timer)
      // 成功即入历史（最新 5 条），供之后在首页回看
      this.saveHistory(result, started.taskId)
      this.setData({ fileId: up.fileID, result, progress: 100, stageText: '完成', stage: 'done' })
    } catch (e) {
      clearInterval(timer)
      console.error('[recognize]', e)
      this.setData({ stage: 'done', error: e.message || '识别失败，请重试', progress: 100 })
    }
  },

  // 轮询异步识别结果（幂等：重复轮询不会重复计算）
  //
  // 容错要点：云函数单次调用本身可能因冷启动/网络抖动偶发超时（-504003），
  // 这类失败是**可重试**的 —— 任务已经落库、租约机制保证只算一次，
  // 所以这里不把单次失败当终局，而是继续下一轮；只有明确 failed 才终止。
  async pollResult(taskId) {
    const max = 25
    let transient = 0
    for (let n = 0; n < max; n++) {
      let r
      try {
        r = await app.callApi('recognizePoll', { taskId })
      } catch (e) {
        transient++
        console.warn('[recognize] 第 ' + (n + 1) + ' 次轮询失败，将重试', e && e.message)
        // 连续 5 次都失败才认为是真故障，避免无限空转
        if (transient >= 5) throw new Error('识别服务暂不可用，请稍后重试')
        await sleep(1200)
        continue
      }
      transient = 0
      if (r.status === 'done') return r
      if (r.status === 'failed') throw new Error(r.error || '识别失败')
      this.setData({ progress: Math.min(92, 30 + (r.progress || 0) * 0.6) })
      await sleep(1200)
    }
    throw new Error('识别超时，请稍后重试')
  },

  goCat(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/cat-detail/cat-detail?id=' + id })
  },

  // 人工确认：把本次特征写进该猫档案，系统越用越准
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
      wx.showToast({
        title: r && r.embeddingWritten ? '已记入特征库 +5' : '已确认 +5',
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
    this.setData({
      stage: 'idle', localPath: '', thumbPath: '', fileId: '', result: null,
      progress: 0, stageText: '', error: '', duration: 0,
      taskId: '', confirmedId: ''
    })
    this.loadHistory()   // 从回看状态返回首页时，刷新历史列表
  }
})
