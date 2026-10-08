const app = getApp()

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
    error: ''
  },

  onLoad(options) {
    if (options.mode === 'video') this.setData({ mode: 'video' })
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

      // 1) 上传到云存储
      const ext = (tempPath.split('.').pop() || 'jpg').toLowerCase()
      const stamp = Date.now() + '-' + Math.random().toString(36).slice(2)
      const cloudPath = `recognize/${stamp}.${ext}`
      const up = await wx.cloud.uploadFile({ cloudPath, filePath: tempPath })

      // 视频额外上传封面帧：云函数没有 ffmpeg，用封面帧作为代表帧（省一次解码）
      let thumbId = ''
      if (this.data.mode === 'video' && this.data.thumbPath) {
        const tup = await wx.cloud.uploadFile({
          cloudPath: `recognize/${stamp}-thumb.jpg`,
          filePath: this.data.thumbPath
        })
        thumbId = tup.fileID
      }

      const loc = app.globalData.myLocation || null

      // 2) 识别：图片走同步；视频走异步任务 + 轮询（避免云函数超时）
      let result
      if (this.data.mode === 'video') {
        const started = await app.callApi('recognizeStart', {
          fileId: up.fileID,
          thumbId,
          type: 'video',
          duration: this.data.duration,
          location: loc
        })
        const polled = await this.pollResult(started.taskId)
        result = polled.result
        this.setData({ taskId: started.taskId })
      } else {
        const r = await app.callApi('recognize', {
          fileId: up.fileID,
          type: 'image',
          location: loc
        })
        result = r
        this.setData({ taskId: r.taskId || '' })
      }

      clearInterval(timer)
      this.setData({ fileId: up.fileID, result, progress: 100, stageText: '完成', stage: 'done' })
    } catch (e) {
      clearInterval(timer)
      console.error('[recognize]', e)
      this.setData({ stage: 'done', error: e.message || '识别失败，请重试', progress: 100 })
    }
  },

  // 轮询异步识别结果（幂等：重复轮询不会重复计算）
  async pollResult(taskId) {
    const max = 20
    for (let n = 0; n < max; n++) {
      const r = await app.callApi('recognizePoll', { taskId })
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
    wx.showLoading({ title: '提交中' })
    try {
      const r = await app.callApi('confirmRecognize', {
        taskId: this.data.taskId,
        catId,
        correct: true
      })
      wx.hideLoading()
      this.setData({ confirmedId: catId })
      wx.showToast({
        title: r && r.embeddingWritten ? '已记入特征库 +5' : '已确认 +5',
        icon: 'none'
      })
    } catch (err) {
      wx.hideLoading()
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
  }
})
