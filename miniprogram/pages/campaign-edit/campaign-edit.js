const app = getApp()
const { toast, showBusy, hideBusy, requireAdmin } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')
const { CHOU_KIND, CHOU_MATERIAL } = require('../../utils/const.js')

/**
 * 咪咪筹 - 发起 / 记进展 / 记支出
 *
 * 材料上传走 wx.cloud.uploadFile，只接收 fileID（cloud://）。
 * 上传的三个坑（见 recognize.js 注释）在这里同样存在：
 *   ① uploadFile 失败抛的是普通对象而非 Error
 *   ② 偶尔 resolve 但没有 fileID
 *   ③ 多张图要串行，并发容易触发限流
 * 所以统一走 _pickAndUpload()，一张一张传、每张校验 fileID。
 */
const MAX_MATERIALS = 9
const KIND_OPTIONS = CHOU_KIND || []
const MATERIAL_OPTIONS = CHOU_MATERIAL || []

Page(Object.assign({
  data: {
    mode: 'create',                 // create | update | expense
    id: '',

    // 选猫
    cats: [],
    catKeyword: '',
    showCatPicker: false,
    cat: null,

    // 表单
    kinds: KIND_OPTIONS,
    kind: 'medical',
    form: {
      title: '',
      reason: '',
      goalAmount: '',
      hospital: '',
      contact: '',
      endDate: ''
    },
    minDate: '',

    // 材料
    materialTypes: MATERIAL_OPTIONS,
    materialType: 'diagnosis',
    materials: [],
    materialsPublic: true,
    uploading: false,

    // 进展 / 支出
    updateText: '',
    updateImages: [],
    expenseTitle: '',
    expenseAmount: '',
    proof: [],

    agree: false,
    submitting: false
  },

  onLoad(e) {
    const mode = e.mode || 'create'
    // 记支出是管理动作；发起与记进展所有用户都能做（服务端还会再校验身份）
    if (mode === 'expense' && !requireAdmin(app)) return

    const today = new Date()
    const minDate = today.getFullYear() + '-' +
      String(today.getMonth() + 1).padStart(2, '0') + '-' +
      String(today.getDate()).padStart(2, '0')

    this.setData({ mode, id: e.id || '', minDate })
    wx.setNavigationBarTitle({
      title: mode === 'create' ? '发起咪咪筹' : (mode === 'update' ? '更新进展' : '登记支出')
    })
    if (mode === 'create') this.loadCats()
  },

  /* ==================== 选猫 ==================== */

  async loadCats(keyword) {
    try {
      const res = await app.callApi('listCats', { size: 50, keyword: keyword || undefined })
      const ids = []
      const cats = (res.list || []).map(c => Object.assign({}, c, {
        avatar: c.avatar ? photo.display(c.avatar, 120, ids) : '',
        statusText: c.status === 'rainbow' ? '去喵星' : (c.status === 'adopted' ? '已领养' : '')
      }))
      this.setData({ cats })
      if (ids.length) photo.warm(ids)
    } catch (e) { toast(e.message) }
  },

  openCatPicker() { this.setData({ showCatPicker: true }) },
  closeCatPicker() { this.setData({ showCatPicker: false }) },
  noop() {},

  onCatKeyword(e) {
    const kw = e.detail.value
    this.setData({ catKeyword: kw })
    // 简单防抖：输入停顿 300ms 再查，避免每敲一个字打一次云函数
    clearTimeout(this._kwTimer)
    this._kwTimer = setTimeout(() => this.loadCats(kw), 300)
  },

  pickCat(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const cat = this.data.cats.filter(c => c._id === id)[0]
    if (!cat) return
    if (cat.status === 'rainbow') { toast('去喵星的猫咪不再发起筹款'); return }
    this.setData({ cat, showCatPicker: false })
  },

  /* ==================== 表单 ==================== */

  pickKind(e) {
    const kind = e.currentTarget.dataset.kind
    if (kind) this.setData({ kind })
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value })
  },

  onEndDate(e) { this.setData({ 'form.endDate': e.detail.value }) },
  clearEndDate() { this.setData({ 'form.endDate': '' }) },

  pickMaterialType(e) {
    this.setData({ materialType: e.currentTarget.dataset.type })
  },

  toggleMaterialsPublic(e) {
    this.setData({ materialsPublic: !!e.detail.value })
  },

  toggleAgree(e) { this.setData({ agree: !!e.detail.value }) },

  /* ==================== 图片上传 ==================== */

  /** 选图并逐张上传，返回 fileID 数组。任一失败抛错，已成功的仍返回给调用方处理。 */
  async _pickAndUpload(count, dir) {
    if (count <= 0) return []
    let chosen
    try {
      chosen = await new Promise((resolve, reject) => {
        wx.chooseMedia({
          count,
          mediaType: ['image'],
          sizeType: ['compressed'],
          sourceType: ['album', 'camera'],
          success: resolve,
          fail: reject
        })
      })
    } catch (err) {
      // 用户取消选图不算错误
      const msg = String((err && (err.errMsg || err.message)) || '')
      if (/cancel/i.test(msg)) return []
      throw new Error('选择图片失败')
    }
    const picked = (chosen && chosen.tempFiles) || []
    if (!picked.length) return []

    this.setData({ uploading: true })
    showBusy('上传材料')
    const out = []
    try {
      for (let i = 0; i < picked.length; i++) {
        const f = picked[i]
        const cloudPath = 'campaign/' + (dir || 'm') + '/' + Date.now() + '-' +
          Math.random().toString(36).slice(2, 8) + '.jpg'
        let up
        try {
          up = await wx.cloud.uploadFile({ cloudPath, filePath: f.tempFilePath })
        } catch (err) {
          const msg = String((err && (err.errMsg || err.message)) || '')
          throw new Error('图片上传失败' + (msg ? '：' + msg.replace(/^uploadFile:fail\s*/i, '') : ''))
        }
        if (!up || !up.fileID) throw new Error('图片上传失败，请重试')
        out.push(up.fileID)
      }
    } finally {
      hideBusy()
      this.setData({ uploading: false })
    }
    return out
  },

  /** 添加筹款材料 */
  async addMaterial() {
    const left = MAX_MATERIALS - this.data.materials.length
    if (left <= 0) { toast('材料最多 ' + MAX_MATERIALS + ' 份'); return }
    let ids = []
    try {
      ids = await this._pickAndUpload(left, 'material')
    } catch (e) { toast(e.message); return }
    if (!ids.length) return
    const type = this.data.materialType
    const label = (MATERIAL_OPTIONS.filter(x => x.value === type)[0] || {}).label || '其他材料'
    const add = ids.map(fileID => ({
      type, typeLabel: label, fileID, preview: fileID, public: this.data.materialsPublic
    }))
    this.setData({ materials: this.data.materials.concat(add) })
  },

  removeMaterial(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const list = this.data.materials.slice()
    list.splice(idx, 1)
    this.setData({ materials: list })
  },

  previewMaterial(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    const urls = this.data.materials.map(m => m.fileID)
    wx.previewImage({ urls, current: url })
  },

  /** 进展配图 */
  async addUpdateImage() {
    let ids = []
    try {
      ids = await this._pickAndUpload(9 - this.data.updateImages.length, 'update')
    } catch (e) { toast(e.message); return }
    if (!ids.length) return
    this.setData({ updateImages: this.data.updateImages.concat(ids) })
  },

  removeUpdateImage(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const list = this.data.updateImages.slice()
    list.splice(idx, 1)
    this.setData({ updateImages: list })
  },

  /** 支出票据 */
  async addProof() {
    let ids = []
    try {
      ids = await this._pickAndUpload(9 - this.data.proof.length, 'proof')
    } catch (e) { toast(e.message); return }
    if (!ids.length) return
    this.setData({ proof: this.data.proof.concat(ids) })
  },

  removeProof(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const list = this.data.proof.slice()
    list.splice(idx, 1)
    this.setData({ proof: list })
  },

  previewOne(e) {
    const url = e.currentTarget.dataset.url
    if (url) wx.previewImage({ urls: [url], current: url })
  },

  /* ==================== 提交 ==================== */

  async submit() {
    if (this.data.submitting || this.data.uploading) return
    const mode = this.data.mode
    this.setData({ submitting: true })

    try {
      if (mode === 'create') await this._submitCreate()
      else if (mode === 'update') await this._submitUpdate()
      else await this._submitExpense()
    } catch (e) {
      toast(e.message)
    } finally {
      this.setData({ submitting: false })
    }
  },

  async _submitCreate() {
    const f = this.data.form
    const cat = this.data.cat
    if (!cat) throw new Error('请先选择筹款的猫咪档案')
    if (!f.title.trim() || f.title.trim().length < 4) throw new Error('标题至少 4 个字')
    if (f.reason.trim().length < 10) throw new Error('情况说明至少 10 个字，方便别人判断')
    if (!f.goalAmount || Number(f.goalAmount) <= 0) throw new Error('请填写目标金额')
    if (!this.data.agree) throw new Error('请先勾选承诺')

    showBusy('提交中')
    try {
      const res = await app.callApi('createCampaign', {
        data: {
          catId: cat._id,
          kind: this.data.kind,
          title: f.title.trim(),
          reason: f.reason.trim(),
          goalAmount: Number(f.goalAmount),
          endDate: f.endDate || '',
          hospital: f.hospital,
          contact: f.contact,
          materials: this.data.materials.map(m => ({
            type: m.type, fileID: m.fileID, public: m.public
          }))
        }
      })
      hideBusy()
      if (res && res.needReview) {
        wx.showModal({
          title: '已提交审核',
          content: '管理员会核对猫咪档案与材料，通过后其他同学就能看到并捐助了。结果会通过站内通知告知你。',
          showCancel: false,
          success: () => wx.navigateBack()
        })
      } else {
        toast('筹款已发起')
        setTimeout(() => wx.navigateBack(), 700)
      }
    } catch (e) {
      hideBusy()
      throw e
    }
  },

  async _submitUpdate() {
    const text = this.data.updateText.trim()
    if (!text) throw new Error('请填写进展内容')
    showBusy('提交中')
    try {
      await app.callApi('addCampaignUpdate', {
        id: this.data.id, text, images: this.data.updateImages
      })
      hideBusy()
      toast('进展已更新')
      setTimeout(() => wx.navigateBack(), 600)
    } catch (e) {
      hideBusy()
      throw e
    }
  },

  async _submitExpense() {
    if (!this.data.expenseTitle.trim()) throw new Error('请填写支出说明')
    if (!this.data.expenseAmount || Number(this.data.expenseAmount) <= 0) {
      throw new Error('请填写有效金额')
    }
    showBusy('提交中')
    try {
      await app.callApi('addCampaignExpense', {
        id: this.data.id,
        title: this.data.expenseTitle.trim(),
        amount: Number(this.data.expenseAmount),
        proof: this.data.proof
      })
      hideBusy()
      toast('支出已公示')
      setTimeout(() => wx.navigateBack(), 600)
    } catch (e) {
      hideBusy()
      throw e
    }
  }
}, {}))
