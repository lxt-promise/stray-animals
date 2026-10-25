const app = getApp()
const { C, requireAdmin, toast, showBusy, hideBusy, toastErr, isTimeoutErr } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')

/**
 * 相册上限 5 张。
 *
 * 为什么是硬上限：这 5 张**全部**会送去建这只猫的特征库（云端 `INDEX_PHOTOS=5`，
 * 服务端把每张裁出猫体后各算一个向量再取平均）。照片越多代表向量越稳，但也意味着
 * 每次建库要下载/编码更多图 —— 5 张是「稳定性」与「3s 客户端预算」的平衡点。
 * 改这个数必须同时改 cloudfunctions/catcampus/lib/vision.js 的 INDEX_PHOTOS。
 */
const MAX_ALBUM = 5

/**
 * 表单字段 → picker「当前选中下标」变量名。
 *
 * 为什么不直接用 `field + 'Index'` 拼：WXML 里绝育状态的 picker 绑的是
 * `sterIndex`（历史命名），拼出来是 `sterilizedIndex` —— 写进一个不存在的
 * data 字段，界面完全不动。这里显式列出全部映射，新增 picker 时照抄一行，
 * 比隐式约定更难写错。
 */
const INDEX_KEY = {
  sex: 'sexIndex',
  pattern: 'patternIndex',
  sterilized: 'sterIndex',
  status: 'statusIndex',
  health: 'healthIndex'
}

/**
 * 表单里的媒体字段必须是 **fileID**，不能是临时链接。
 *
 * 云端 `getCat` 会把 `avatar` / `photos` 换成 https 临时链接下发（渲染要用），
 * 编辑页如果把表单原样提交回去，数据库里的 fileID 就被**永久覆盖成两小时后失效的
 * 临时链接** —— 之后相册打不开、预览黑屏、建库下载失败，而且不可逆。
 * 优先用云端额外下发的 `photoIds` / `avatarId`，没有就从临时链接反推 fileID。
 */
/**
 * 预热云函数（`ping` action，见 cloudfunctions/catcampus/index.js）。
 *
 * 只发不等：目的纯粹是让云函数实例 + 数据库连接提前建立，
 * 把冷启动那 1~1.5s 挪到用户填表的时间里去。失败完全无所谓。
 *
 * ⚠️ 刻意写成**模块级函数**而不是 Page 的方法：
 * 微信开发者工具的「热重载」会重跑本文件的顶层代码、但复用旧的 Page 实例，
 * 于是新加的 `this.warmCloud` 在旧实例上根本不存在 —— 直接
 * `TypeError: this.warmCloud is not a function`，而且 onLoad 整个中断（页面白屏）。
 * 不依赖 `this` 就没有这个坑。同理，任何「后加的、与页面状态无关」的调用都走函数。
 */
function warmCloud() {
  app.callApi('ping', {}).catch(() => {})
}

/**
 * 提交保存，超时自动重发一次（同样刻意写成模块级函数，理由见 warmCloud）。
 *
 * 单独抽出来是为了「超时自动重试」：客户端 callFunction 有约 3s 硬预算，
 * 超时报 -504003 时**云端其实还在跑**，档案很可能已经写进库了。
 * 这时让用户手点第二遍就会多建一只同名的猫 —— 现场反馈正是
 * 「每次都是点第二遍才保存成功」。现在改成：检测到超时就自动重发一次，
 * 且两次带**同一个 saveToken**，云端据此认出「这是同一发」，
 * 上一发已写库则直接返回原 _id，不会重复建档。
 *
 * @returns {Promise<Object>} 云端返回（含 _id）
 */
async function callSave(payload, newPhotoIds, saveToken) {
  let attempt = 0
  const send = () => {
    attempt++
    return app.callApi('saveCat', {
      data: Object.assign({}, payload, { saveToken }),
      newPhotoIds,
      // 告诉云端「这是第几次尝试」：只有重试才需要按 token 查重（少一次查询 = 少 180ms）
      attempt
    })
  }
  try {
    return await send()
  } catch (e) {
    if (!isTimeoutErr(e)) throw e
    console.warn('[cat-edit] 保存超时，自动重发一次', e && (e.errMsg || e.message))
    return await send()
  }
}

function toFileId(v, hint) {
  if (!v) return ''
  if (photo.isFileId(v)) return v
  if (hint && photo.isFileId(hint)) return hint
  const envId = (app.globalData && app.globalData.envId) || ''
  // 反推不出来就原样保留：写入的是历史直链，至少不比现状更差
  return photo.fileIdFromUrl(v, envId) || v
}

Page({
  data: {
    id: '',
    isNew: true,
    form: {
      name: '',
      alias: '',
      sex: 'unknown',
      pattern: 'other',
      colorNote: '',
      sterilized: 'unknown',
      earMark: '',
      status: 'campus',
      health: 'unknown',
      characters: [],
      location: null,
      locationName: '',
      spotPrivate: false,
      avatar: '',
      photos: [],
      note: '',
      internalNote: '',
      medicalNote: ''
    },
    sexIndex: 2,
    patternIndex: 10,
    sterIndex: 2,
    statusIndex: 0,
    healthIndex: 7,
    sexOptions: C.SEX,
    patternOptions: C.PATTERN,
    sterOptions: C.STERILIZED,
    statusOptions: C.CAT_STATUS,
    healthOptions: C.HEALTH,
    charOptions: C.CHARACTER,
    charChips: [],
    saving: false
  },

  onLoad(options) {
    // 建档 / 改档：管理员及以上（含超级管理员）可手动录入
    if (!requireAdmin(app)) {
      setTimeout(() => wx.navigateBack(), 1500)
      return
    }
    // 支持从 AI 识别页带参新建：photo / pattern / color
    const f = Object.assign({}, this.data.form)
    let touched = false
    if (options.photo) { f.avatar = options.photo; f.photos = [options.photo]; touched = true }
    if (options.pattern) {
      const pi = C.PATTERN.map(p => p.value).indexOf(options.pattern)
      if (pi >= 0) { this.setData({ patternIndex: pi }); f.pattern = options.pattern; touched = true }
    }
    if (options.color) { f.colorNote = options.color; touched = true }
    if (touched) { this.setData({ form: f }); this.syncPhotoViews() }

    // 性格标签选中态必须在 JS 层预计算（见 buildCharChips 注释），先渲染初始态
    this.buildCharChips()

    if (options.id) {
      this.setData({ id: options.id, isNew: false })
      wx.setNavigationBarTitle({ title: '编辑档案' })
      this.loadCat(options.id)
    } else {
      wx.setNavigationBarTitle({ title: '录入新猫档案' })
    }

    // 预热云函数：用户填表要几十秒，冷启动（1~1.5s）这段时间足以完成，
    // 别把它留到点「保存」的那一刻 —— 那会直接顶破客户端 3s 预算。
    // ⚠️ 放在 onLoad **最后**并包 try/catch：预热只是性能优化，任何异常都不该
    // 让 onLoad 中断（中断 = 页面白屏、连表单都打不开）。这条纪律适用于页面里
    // 一切「非必需」的调用。
    try {
      warmCloud()
    } catch (e) {
      console.warn('[cat-edit] 预热失败，忽略', e && e.message)
    }
  },

  async loadCat(id) {
    try {
      const res = await app.callApi('getCat', { id })
      const c = res.cat
      // 照片回填 fileID（不是临时链接）—— 见 toFileId 的注释，这一步做错会毁掉档案数据
      const photoIds = (c.photos || []).map((p, k) => toFileId(p, (c.photoIds || [])[k]))
      const form = Object.assign({}, this.data.form, {
        _id: c._id,
        name: c.name,
        alias: c.alias || '',
        sex: c.sex,
        pattern: c.pattern,
        colorNote: c.colorNote || '',
        sterilized: c.sterilized,
        earMark: c.earMark || '',
        status: c.status,
        health: c.health,
        characters: c.characters || [],
        location: c.location || null,
        locationName: (c.location && c.location.name) || '',
        spotPrivate: !!c.spotPrivate,
        avatar: toFileId(c.avatar, c.avatarId),
        photos: photoIds,
        note: c.note || '',
        internalNote: c.internalNote || '',
        medicalNote: c.medicalNote || ''
      })
      // 记下「进来时已有的照片」：保存时据此算出哪些是新加的，
      // 云端只对**新图**做安全检测（重复下载校验同一张图既慢又没必要）
      this._origPhotos = photoIds.slice()
      const idx = (arr, v) => Math.max(0, arr.map(i => i.value).indexOf(v))
      this.setData({
        form,
        sexIndex: idx(C.SEX, c.sex),
        patternIndex: idx(C.PATTERN, c.pattern),
        sterIndex: idx(C.STERILIZED, c.sterilized),
        statusIndex: idx(C.CAT_STATUS, c.status),
        healthIndex: idx(C.HEALTH, c.health)
      })
      this.syncPhotoViews()
      // 档案回填后重建标签选中态
      this.buildCharChips()
    } catch (e) {
      toast(e.message)
    }
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ ['form.' + key]: e.detail.value })
  },

  onPick(e) {
    const { key, field } = e.currentTarget.dataset
    const options = this.data[key] || []
    const i = Number(e.detail.value)
    const opt = options[i]
    // 越界（picker 传了不存在的下标）宁可不改，也不能把 undefined 写进表单
    if (!opt) return
    // picker 的「当前选中下标」变量名并不都是 field + 'Index'：
    // 绝育绑定的是 sterIndex（不是 sterilizedIndex）。旧实现按 field + 'Index' 拼键，
    // 值写进了根本不存在的 data 字段 —— form.sterilized 确实变了，
    // 但 picker 显示的是 {{sterOptions[sterIndex].label}}，下标没动，
    // 于是「点了绝育状态，界面还停在未知」，看起来像不生效。
    const idxKey = INDEX_KEY[field] || (field + 'Index')
    this.setData({
      ['form.' + field]: opt.value,
      [idxKey]: i
    })
  },

  /** 构建性格标签列表（含选中态 on）。
   *  选中态必须在 JS 层算，不能写在 WXML class 里：
   *  WXML mustache 表达式编译期白名单校验，只支持简单运算和属性访问，
   *  indexOf() 等方法调用会被静默忽略、整段表达式退化为 false ——
   *  表现为「点击有回调但选中态永远不显示」（2026-10-12 建档页实际踩坑）。 */
  buildCharChips() {
    const chars = this.data.form.characters || []
    this.setData({
      charChips: C.CHARACTER.map(c => ({
        value: c.value,
        label: c.label,
        on: chars.indexOf(c.value) >= 0
      }))
    })
  },

  toggleChar(e) {
    const v = e.currentTarget.dataset.value
    const chars = this.data.form.characters.slice()
    const i = chars.indexOf(v)
    if (i >= 0) chars.splice(i, 1)
    else chars.push(v)
    this.setData({ 'form.characters': chars })
    this.buildCharChips()
  },

  togglePrivate(e) {
    this.setData({ 'form.spotPrivate': e.detail.value })
  },

  /** 表单里存的是原始 fileID（提交要用的），展示另开 avatarView / photosView：
   *  cloud:// 直接进 <image src> 在开发者工具会报 pageframe 加载失败，
   *  这里先批量换临时链接再渲染（本地新选的图是临时路径，原样直出）。 */
  async syncPhotoViews() {
    const f = this.data.form || {}
    const ids = [].concat(f.avatar ? [f.avatar] : []).concat(f.photos || [])
      .filter(id => photo.isFileId(id))
    if (ids.length) await photo.warm(ids)
    const g = this.data.form || {}
    this.setData({
      avatarView: photo.display(g.avatar || '', 300),
      photosView: (g.photos || []).map(p => photo.display(p, 300))
    })
  },

  async chooseAvatar() {
    const res = await wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'] }).catch(() => null)
    if (!res) return
    showBusy({ title: '上传中' })
    try {
      const file = res.tempFiles[0]
      const up = await wx.cloud.uploadFile({
        cloudPath: 'cats/' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '.jpg',
        filePath: file.tempFilePath
      })
      this.setData({ 'form.avatar': up.fileID })
      this.syncPhotoViews()
      // 上传刚结束，这是让云函数保持「热」的最好时机
      warmCloud()
    } catch (e) {
      toast('上传失败')
    } finally {
      hideBusy()
    }
  },

  async choosePhotos() {
    // 已满 5 张就别再拉起相册（拉起来也只能全传上去再被裁掉，白耗流量）
    const remain = MAX_ALBUM - (this.data.form.photos || []).length
    if (remain <= 0) return toast('相册最多 ' + MAX_ALBUM + ' 张，先删一张再添加')
    const res = await wx.chooseMedia({ count: remain, mediaType: ['image'], sizeType: ['compressed'] }).catch(() => null)
    if (!res) return
    showBusy({ title: '上传中' })
    const ids = []
    try {
      const files = res.tempFiles || []
      for (const f of files) {
        const up = await wx.cloud.uploadFile({
          cloudPath: 'cats/' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '.jpg',
          filePath: f.tempFilePath
        })
        ids.push(up.fileID)
      }
    } catch (e) {
      // 中途失败不能整体丢弃：前几张已经传成功的 fileID 要保留下来
      // （否则云存储留孤儿文件，用户还以为一张都没传）
      if (ids.length) {
        // 兜底再夹一次上限：chooseMedia 的 count 只是建议，部分机型/旧基础库会多给
        this.setData({ 'form.photos': this.data.form.photos.concat(ids).slice(0, MAX_ALBUM) })
        this.syncPhotoViews()
        toast('部分照片上传失败，已保留 ' + ids.length + ' 张')
        return
      }
      toast('上传失败')
      return
    } finally {
      hideBusy()
    }
    this.setData({ 'form.photos': this.data.form.photos.concat(ids).slice(0, MAX_ALBUM) })
    this.syncPhotoViews()
    // 上传刚结束，这是让云函数保持「热」的最好时机
    warmCloud()
  },

  removePhoto(e) {
    const i = e.currentTarget.dataset.index
    const photos = this.data.form.photos.slice()
    photos.splice(i, 1)
    this.setData({ 'form.photos': photos })
    this.syncPhotoViews()
  },

  async chooseLocation() {
    const res = await wx.chooseLocation({}).catch(() => null)
    if (!res || !res.latitude) return
    this.setData({
      'form.location': { lat: res.latitude, lng: res.longitude },
      'form.locationName': res.name || res.address || ''
    })
  },

  /**
   * 保存成功后自动把这只猫送进服务端特征库（花色比对）。
   *
   * 单独一次云函数调用，不塞进 saveCat —— 客户端单次 callFunction 只有约 3s 预算，
   * 建档本身已经有文字/图片安全检测，再叠建库必然顶爆。拆开就各有各的预算。
   *
   * @returns {Promise<boolean>} 是否当场入库成功（false 不代表失败，只是延后）
   */
  async autoIndexCat (catId, schoolId) {
    if (!catId) return false
    try {
      const r = await app.callApi('autoIndexCat', {
        catIds: [catId], schoolId: schoolId || '', photosPerCat: 5
      })
      return !!(r && r.ok)
    } catch (e) {
      // 静默：建档已经成功，入库交给识别热路径 / 定时任务兜底
      console.warn('[cat-edit] 自动入库未当场完成', e && e.message)
      return false
    }
  },

  async save() {
    const f = this.data.form
    if (!f.name.trim()) return toast('请填写名字')
    if (this.data.saving) return
    this.setData({ saving: true })
    showBusy({ title: '保存中' })
    // 幂等 token：一次「保存」的两次尝试必须用同一个值；保存成功（或离开页面）后作废，
    // 否则下次再建一只猫会被云端当成重复提交。
    if (!this._saveToken) {
      this._saveToken = 'sv' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    }
    try {
      const payload = Object.assign({}, f)
      if (payload.location && !payload.location.name) {
        payload.location.name = payload.locationName || ''
      }
      // 提交前再归一一次：表单里理应全是 fileID，但历史档案可能残留 https 临时链接
      // （一旦写回数据库就再也换不回来了）。这里做最后一道闸。
      // filter(Boolean) 顺手清掉历史留下的空串占位 —— 那种条目在详情页就是个
      // 打不开的空白格子，留着只会让人以为「相册少了一张」。
      payload.avatar = toFileId(payload.avatar)
      payload.photos = (payload.photos || [])
        .map(p => toFileId(p))
        .filter(Boolean)
        .slice(0, MAX_ALBUM)
      // 只把**本轮新加的照片**告诉云端：已有照片在入库时已经过安全检测，
      // 每次保存都重新下载 + 送检一遍既慢（一张图几 MB）又容易顶穿 3s 客户端预算。
      const orig = this._origPhotos || []
      const newPhotoIds = (payload.photos || []).filter(p => orig.indexOf(p) < 0)
      const r = await callSave(payload, newPhotoIds, this._saveToken)
      this._saveToken = ''
      hideBusy()
      // 建档 / 改档后立刻自动入库：只建这一只，失败不影响「保存成功」。
      // 用 await 是为了给准反馈；超时也无所谓 —— 识别热路径和每天 3 点定时会兜底。
      const me = app.globalData.user || {}
      const indexed = await this.autoIndexCat(r && r._id, payload.schoolId || me.schoolId)
      const base = this.data.isNew ? '档案已建立' : '已保存'
      wx.showToast({ title: indexed ? (base + '，已加入比对') : base, icon: 'success' })
      setTimeout(() => wx.navigateBack(), 900)
    } catch (e) {
      hideBusy()
      if (isTimeoutErr(e)) {
        // 两次尝试都超时：请求肯定已经发出去了，档案很可能建好了。
        // 这时最危险的动作就是「再点一次保存」—— 会多出一只重复的猫。
        wx.showModal({
          title: '云端响应超时',
          content: '保存请求已发出，云端很可能已经建档成功。请返回猫谱刷新确认，不要立刻重复提交。',
          showCancel: false
        })
        return
      }
      // 用 toastErr：数据库错误往往上百字符，toast 会截到 20 字，等于没提示
      toastErr(e, '保存失败')
    } finally {
      this.setData({ saving: false })
    }
  }
})
