const app = getApp()
const { C, toast, showBusy, hideBusy } = require('../../utils/util.js')

Page({
  data: {
    catId: '',
    catNames: [],
    catIds: [],
    catIndex: 0,
    isNewCat: false,
    newCatName: '',
    photos: [],
    locationName: '',
    location: null,
    healthIndex: 7,
    healthOptions: C.HEALTH,
    // 投喂状态：路过 / 本人投喂 / 已被其他人投喂（选中「本人投喂」且有照片可获额外猫粮值）
    feedIndex: 0,
    feedOptions: C.FEED_STATUS,
    feedValue: 'passed',
    // 行为标签：结构化多选（替代原自由文本「描述」，合规要求见 const.js SIGHT_BEHAVIOR 注释）
    behaviorOptions: C.SIGHT_BEHAVIOR.map(b => ({ value: b.value, label: b.label, on: false })),
    behaviors: [],
    note: '',      // 极短补充（≤20 字），非创作型文本
    count: 1,
    locating: false,
    submitting: false
  },

  onLoad(options) {
    // 支持从 AI 识别页带参跳转：photo（已上传云存储的图片 fileId）+ catId
    const patch = {}
    if (options.catId) patch.catId = options.catId
    if (options.photo) patch.photos = [options.photo]
    if (Object.keys(patch).length) this.setData(patch)
    this.loadCats()
    this.locate()
  },

  async loadCats() {
    try {
      await app.ensureReady()
      const res = await app.callApi('listCats', { size: 100 })
      const list = res.list.filter(c => c.status !== 'rainbow')
      const names = ['（不指定 / 新发现的猫）'].concat(list.map(c => c.name))
      const ids = [''].concat(list.map(c => c._id))
      let idx = 0
      if (this.data.catId) {
        const i = ids.indexOf(this.data.catId)
        if (i > 0) idx = i
      }
      this.setData({ catNames: names, catIds: ids, catIndex: idx })
    } catch (e) {
      console.error(e)
    }
  },

  async locate() {
    this.setData({ locating: true })
    try {
      const res = await new Promise((resolve, reject) => {
        wx.getLocation({ type: 'gcj02', success: resolve, fail: reject })
      })
      // 定位竞态防护：GPS 慢返回（冷启动/首次授权可能数秒）时，用户可能已经
      // 用「选择位置」手选了点位 —— 后到的 GPS 结果不能覆盖手选值
      if (this._manualLoc) return
      this.setData({ location: { lat: res.latitude, lng: res.longitude } })
    } catch (e) {
      // 未授权则留空，允许手动选点
    } finally {
      this.setData({ locating: false })
    }
  },

  onCatPick(e) {
    const i = Number(e.detail.value)
    this.setData({ catIndex: i, catId: this.data.catIds[i], isNewCat: i === 0 })
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ [key]: e.detail.value })
  },

  onHealthPick(e) {
    this.setData({ healthIndex: Number(e.detail.value) })
  },

  // 投喂状态选择：同步 value 供 WXML 判断提示文案（不依赖表达式里的下标访问）
  onFeedPick(e) {
    const i = Number(e.detail.value)
    this.setData({ feedIndex: i, feedValue: this.data.feedOptions[i].value })
  },

  changeCount(e) {
    this.setData({ count: Number(e.detail.value) || 1 })
  },

  /**
   * 行为标签多选切换（结构化，替代原自由文本「描述」）。
   * ⚠️ 选中态必须在 JS 层预计算成 item.on —— WXML 的 mustache 是编译期白名单，
   *    `indexOf()/includes()` 这类方法调用会被静默忽略、整段退化为 false
   *    （本项目踩过的坑，见 MEMORY.md）。所以这里不写 `{{behaviors.indexOf(item.value)>=0}}`。
   */
  toggleBehavior(e) {
    const v = e.currentTarget.dataset.value
    if (!v) return
    const opts = (this.data.behaviorOptions || []).map(o =>
      o.value === v ? Object.assign({}, o, { on: !o.on }) : o
    )
    this.setData({
      behaviorOptions: opts,
      behaviors: opts.filter(o => o.on).map(o => o.value)
    })
  },

  async choosePhotos() {
    const res = await wx.chooseMedia({ count: 6, mediaType: ['image'], sizeType: ['compressed'] }).catch(() => null)
    if (!res) return
    showBusy({ title: '上传中' })
    try {
      const files = res.tempFiles || []
      for (const f of files) {
        const up = await wx.cloud.uploadFile({
          cloudPath: 'sightings/' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '.jpg',
          filePath: f.tempFilePath
        })
        this.setData({ photos: this.data.photos.concat(up.fileID) })
      }
    } catch (e) {
      console.error('[upload] 失败', e)
      toast('上传失败：' + ((e && e.errMsg) || e.message || '未知错误'))
    } finally {
      hideBusy()
    }
  },

  removePhoto(e) {
    const i = e.currentTarget.dataset.index
    const p = this.data.photos.slice()
    p.splice(i, 1)
    this.setData({ photos: p })
  },

  async chooseLocation() {
    const res = await wx.chooseLocation({}).catch(() => null)
    if (!res || !res.latitude) return
    // 标记为手选：后续 locate() 的 GPS 慢回调不再覆盖（见 locate 里的 _manualLoc）
    this._manualLoc = true
    this.setData({
      location: { lat: res.latitude, lng: res.longitude },
      locationName: res.name || res.address || ''
    })
  },

  async submit() {
    if (this.data.submitting) return
    if (!this.data.catId && !this.data.newCatName.trim() && !this.data.photos.length) {
      return toast('请至少选择猫或上传一张照片')
    }
    this.setData({ submitting: true })
    showBusy({ title: '提交中' })
    try {
      const data = {
        catId: this.data.catId,
        catName: this.data.catId ? '' : (this.data.newCatName.trim() || '未认领的新猫'),
        photos: this.data.photos,
        location: this.data.location,
        locationName: this.data.locationName,
        health: this.data.healthOptions[this.data.healthIndex].value,
        feedStatus: this.data.feedValue,
        // 结构化行为标签（合规：替代原自由文本描述）
        behaviors: this.data.behaviors,
        // 补充限 20 字（模板已 maxlength 限制，这里再兜一层）
        note: String(this.data.note || '').slice(0, 20),
        count: this.data.count
      }
      const res = await app.callApi('addSighting', { data })
      // 打卡积分写在云端用户档案上，必须立刻刷新全局 user，
      // 否则「我的」页猫粮值/打卡次数一直停留在登录时的旧值
      await app.refreshUser().catch(() => {})
      hideBusy()
      // 积分明细：数额全部取自云端 pointsDetail（前端不重复配置规则，改奖励只改云端）
      const det = res.pointsDetail || {}
      const parts = []
      if (det.base) parts.push('打卡 +' + det.base)
      if (det.firstMeet) parts.push('首次遇见 +' + det.firstMeet)
      if (det.newCat) parts.push('上报新猫 +' + det.newCat)
      if (det.feed) parts.push('本人投喂 +' + det.feed)
      if (det.feedPhoto) parts.push('照片佐证 +' + det.feedPhoto)
      const detail = parts.length ? '\n' + parts.join(' · ') : ''
      // +0 时给出原因：每日猫粮上限（60）已用完，而非静默的 0
      const capped = res.dailyCapped && !res.pointsGained
      wx.showModal({
        title: '打卡成功',
        content: capped
          ? '今日猫粮已达上限（60），明天再来赚～打卡本身已记录成功'
          : '获得猫粮值 +' + res.pointsGained + detail + (this.data.catId ? '' : '\n社团会核实后为它建档'),
        showCancel: false,
        success: () => {
          if (this.data.catId) {
            wx.redirectTo({ url: '/pages/cat-detail/cat-detail?id=' + this.data.catId })
          } else {
            wx.switchTab({ url: '/pages/cats/cats' })
          }
        }
      })
    } catch (e) {
      hideBusy()
      toast(e.message || '提交失败')
    } finally {
      this.setData({ submitting: false })
    }
  }
})
