const app = getApp()
const { C, toast, showBusy, hideBusy } = require('../../utils/util.js')

/**
 * 目击打卡页。
 *
 * ⚠️ 合规约束（2026-10-16 审核驳回「社交-笔记」类目）——改动本页前必读：
 *   审核认定「用户自行生成内容（文字、图片）的记录、分享」属社交-笔记，
 *   个人主体小程序**未开放该类目**。因此本页有两条硬约束：
 *
 *   ① **不得有任何自由文字输入**（无 input / textarea 用于创作）。
 *      所有用户输入一律是**预设枚举**：多选标签、单选 picker。
 *      想加维度 → 往 utils/const.js 加枚举项，**不要加回输入框**。
 *      （连「20 字补充」这种带 maxlength 的也不行 —— 本质仍是用户创作文字。）
 *
 *   ② **不提供公开发布入口**。可见性由超级管理员在控制台按校区统一配置
 *      （`setSightingVisibilityPolicy`），打卡者无法选择公开 —— 本页连开关都不放。
 *      记录落库时云端按该校策略写 `visibility`。
 *
 *   这两条已被 scripts/test_compliance_ugc.js 锁死，改坏会红。
 */
Page({
  data: {
    catId: '',
    catNames: [],
    catIds: [],
    catIndex: 0,
    isNewCat: false,
    // 新猫特征：用结构化枚举描述（不提供自由命名）
    patternOptions: C.PATTERN,
    patternIndex: 0,
    photos: [],
    locationName: '',
    location: null,
    healthIndex: 7,
    healthOptions: C.HEALTH,
    // 投喂状态：路过 / 本人投喂 / 已被其他人投喂
    feedIndex: 0,
    feedOptions: C.FEED_STATUS,
    feedValue: 'passed',
    // 食物类型：仅「本人投喂」时出现，决定积分档位（+2 ~ +5）
    foodIndex: 0,
    foodOptions: C.FOOD_TYPE,
    foodValue: 'dry',
    // 行为标签：结构化多选（替代原自由文本「描述」，合规要求见 const.js SIGHT_BEHAVIOR 注释）
    behaviorOptions: C.SIGHT_BEHAVIOR.map(b => ({ value: b.value, label: b.label, on: false })),
    behaviors: [],
    // 外观特征：结构化多选（替代原「补充」自由文本）
    featureOptions: C.SIGHT_FEATURE.map(f => ({ value: f.value, label: f.label, on: false })),
    features: [],
    // 数量：用选择器而非数字输入框（合规：本页不得有任何 input）
    countOptions: ['1', '2', '3', '4', '5', '6 及以上'],
    countIndex: 0,
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

  onPatternPick(e) {
    this.setData({ patternIndex: Number(e.detail.value) })
  },

  onHealthPick(e) {
    this.setData({ healthIndex: Number(e.detail.value) })
  },

  // 投喂状态选择：同步 value 供 WXML 判断提示文案（不依赖表达式里的下标访问）
  onFeedPick(e) {
    const i = Number(e.detail.value)
    this.setData({ feedIndex: i, feedValue: this.data.feedOptions[i].value })
  },

  // 食物类型：同样存 value，提交时直接给云端（云端还有一层白名单）
  onFoodPick(e) {
    const i = Number(e.detail.value)
    this.setData({ foodIndex: i, foodValue: this.data.foodOptions[i].value })
  },

  // 数量选择：末档「6 及以上」按 6 记录（云端只用于展示排序，不参与积分）
  onCountPick(e) {
    const i = Number(e.detail.value)
    this.setData({ countIndex: i, count: i + 1 })
  },

  /**
   * 标签多选切换的通用实现（行为标签 / 外观特征共用）。
   * ⚠️ 选中态必须在 JS 层预计算成 item.on —— WXML 的 mustache 是编译期白名单，
   *    `indexOf()/includes()` 这类方法调用会被静默忽略、整段退化为 false
   *    （本项目踩过的坑，见 MEMORY.md）。所以不写 `{{behaviors.indexOf(item.value)>=0}}`。
   *
   * @param {string} listKey  options 数组的字段名（behaviorOptions / featureOptions）
   * @param {string} pickKey  已选值数组的字段名（behaviors / features）
   * @param {string} value    本次点击的值
   */
  _toggleTag(listKey, pickKey, value) {
    if (!value) return
    const opts = (this.data[listKey] || []).map(o =>
      o.value === value ? Object.assign({}, o, { on: !o.on }) : o
    )
    this.setData({
      [listKey]: opts,
      [pickKey]: opts.filter(o => o.on).map(o => o.value)
    })
  },

  toggleBehavior(e) {
    this._toggleTag('behaviorOptions', 'behaviors', e.currentTarget.dataset.value)
  },

  toggleFeature(e) {
    this._toggleTag('featureOptions', 'features', e.currentTarget.dataset.value)
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
    // 新猫场景不再有「临时名字」自由文本；改为要求选一个花纹特征（保证有一定描述度）
    if (!this.data.catId && !this.data.photos.length) {
      return toast('请选择猫咪，或上传一张照片')
    }
    this.setData({ submitting: true })
    showBusy({ title: '提交中' })
    try {
      const data = {
        catId: this.data.catId,
        // 未建档的猫：名字由服务端按特征生成占位名（如「未命名·橘猫」），不接受用户自定义文字
        pattern: this.data.catId ? '' : this.data.patternOptions[this.data.patternIndex].value,
        photos: this.data.photos,
        location: this.data.location,
        locationName: this.data.locationName,
        health: this.data.healthOptions[this.data.healthIndex].value,
        feedStatus: this.data.feedValue,
        // 食物类型只影响积分档位；云端会再做一次白名单过滤
        foodType: this.data.foodValue,
        // 结构化标签（合规：替代自由文本「描述」与「补充」）
        behaviors: this.data.behaviors,
        features: this.data.features,
        // ⚠️ 不传 public：可见性由超管在控制台按校区统一配置，打卡者无权决定
        count: this.data.count
      }
      const res = await app.callApi('addSighting', { data })
      // 打卡积分写在云端用户档案上，必须立刻刷新全局 user，
      // 否则「我的」页猫粮值/打卡次数一直停留在登录时的旧值
      await app.refreshUser().catch(() => {})
      hideBusy()
      // 明细：数额全部取自云端 pointsDetail / foodDetail
      // （前端不重复配置规则，改奖励只改云端 lib/points.js）
      const det = res.pointsDetail || {}
      const parts = []
      if (det.daily) parts.push('打卡 +' + det.daily)
      if (det.feed) parts.push('投喂 +' + det.feed)
      if (det.dexNew) parts.push('图鉴新品种 +' + det.dexNew)
      const detail = parts.length ? '\n' + parts.join(' · ') : ''

      // 两套货币分别汇报：用户必须能分清「积分涨了（算等级）」和「猫粮涨了（能花）」
      const p = Number(res.pointsGained) || 0
      const f = Number(res.foodGained) || 0
      const gains = []
      if (p > 0) gains.push('积分 +' + p)
      if (f > 0) gains.push('猫粮 +' + f)
      const gainText = gains.length ? gains.join(' · ') : '本次未获得（已达今日上限）'
      // 升级是里程碑事件，单独一行强调；奖励额度写在文案里，与 points.js 的 REWARD_PER_LEVEL 一致
      const lvUp = res.levelUp ? '\n🎉 升级到 Lv.' + res.levelUp + '，额外奖励猫粮 +50' : ''
      const capped = res.dailyCapped && !p && !f

      wx.showModal({
        title: '打卡成功',
        content: capped
          ? '今日积分与猫粮已达上限，明天再来～打卡本身已记录成功'
          : '获得 ' + gainText + detail + lvUp +
            (this.data.catId ? '' : '\n社团会核实后为它建档') +
            '\n记录仅你与社团成员可见',
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
