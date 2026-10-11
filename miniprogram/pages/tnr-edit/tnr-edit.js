const app = getApp()
const { C, requireMember, toast, showBusy, hideBusy } = require('../../utils/util.js')

Page({
  data: {
    id: '',
    catNames: [],
    catIds: [],
    catIndex: 0,
    statusIndex: 0,
    statusOptions: C.TNR_STATUS,
    flow: [],          // 后端返回的状态机白名单
    form: {
      catId: '',
      catName: '',
      status: 'todo',
      trapDate: '',
      surgeryDate: '',
      releaseDate: '',
      hospital: '',
      vet: '',
      cost: '',
      earMark: '',
      operator: '',
      note: ''
    },
    saving: false
  },

  onLoad(options) {
    if (!requireMember(app)) return
    if (options.id) {
      this.setData({ id: options.id })
      wx.setNavigationBarTitle({ title: '编辑 TNR 记录' })
    }
    this.loadCats(options)
  },

  async loadCats(options) {
    try {
      // 状态机白名单：只允许流转到合法后继状态，非法项直接不出现在选择器里
      try {
        const flowRes = await app.callApi('getTnrFlow', {})
        if (flowRes && flowRes.flow && flowRes.flow.length) {
          this.setData({ flow: flowRes.flow }, () => this.refreshStatusOptions())
        }
      } catch (e) { /* 拿不到就用全量，后端仍会校验 */ }

      const res = await app.callApi('listCats', { size: 100 })
      const list = res.list
      const names = ['（手动填写）'].concat(list.map(c => c.name))
      const ids = [''].concat(list.map(c => c._id))
      this.setData({ catNames: names, catIds: ids })
      if (options.id) await this.loadRecord(options.id)
      else if (options.catId) {
        const i = ids.indexOf(options.catId)
        if (i > 0) this.setData({ catIndex: i, 'form.catId': options.catId })
      }
    } catch (e) {
      toast(e.message)
    }
  },

  async loadRecord(id) {
    const res = await app.callApi('listTnr', {})
    // 云函数 listTnr 返回 { list, flow }，不是数组
    const rec = ((res && res.list) || []).filter(t => t._id === id)[0]
    if (!rec) return toast('记录不存在')
    const idx = Math.max(0, this.data.catIds.indexOf(rec.catId))
    this.setData({
      catIndex: idx,
      form: Object.assign({}, this.data.form, {
        _id: rec._id,
        catId: rec.catId || '',
        catName: rec.catName || '',
        status: rec.status,
        trapDate: rec.trapDate || '',
        surgeryDate: rec.surgeryDate || '',
        releaseDate: rec.releaseDate || '',
        hospital: rec.hospital || '',
        vet: rec.vet || '',
        cost: rec.cost ? String(rec.cost) : '',
        earMark: rec.earMark || '',
        operator: rec.operator || '',
        note: rec.note || ''
      })
    }, () => this.refreshStatusOptions())
  },

  /**
   * 按状态机白名单重算可选状态：
   * 只能选「当前状态」+ 它允许的下一状态，避免「已放归 → 待抓捕」这类非法流转。
   */
  refreshStatusOptions() {
    const flow = this.data.flow
    if (!flow.length) return
    const cur = this.data.form.status || 'todo'
    const node = flow.filter(f => f.value === cur)[0]
    const allowed = [cur].concat((node && node.next) || [])
    const opts = C.TNR_STATUS.filter(s => allowed.indexOf(s.value) >= 0)
    if (!opts.length) return
    const sIdx = Math.max(0, opts.map(o => o.value).indexOf(cur))
    this.setData({ statusOptions: opts, statusIndex: sIdx })
  },

  onCatPick(e) {
    const i = Number(e.detail.value)
    this.setData({ catIndex: i, 'form.catId': this.data.catIds[i] })
  },

  onStatusPick(e) {
    const i = Number(e.detail.value)
    const opts = this.data.statusOptions
    if (!opts[i]) return
    this.setData({ statusIndex: i, 'form.status': opts[i].value })
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ ['form.' + key]: e.detail.value })
  },

  onDate(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ ['form.' + key]: e.detail.value })
  },

  async save() {
    const f = this.data.form
    if (!f.catId && !f.catName.trim()) return toast('请选择或填写猫咪')
    this.setData({ saving: true })
    showBusy({ title: '保存中' })
    try {
      await app.callApi('saveTnr', { data: f })
      hideBusy()
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 900)
    } catch (e) {
      hideBusy()
      toast(e.message || '保存失败')
    } finally {
      this.setData({ saving: false })
    }
  }
})
