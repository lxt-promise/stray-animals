const app = getApp()
const { showBusy, hideBusy } = require('../../utils/util.js')

/**
 * 超级管理后台
 *  - 成员管理：更改管理员 / 成员 / 访客身份
 *  - 上传记录管理：查看并删除任意目击打卡（修改用在小程序端暂以删除为主，详情编辑可后续扩展）
 * 仅超级管理员可见（入口在「我的」页，且云端每个 action 都再校验一次）。
 */
Page({
  data: {
    members: [],
    sightings: [],
    loading: true,
    building: false,
    indexResult: '',
    indexDetail: ''
  },

  async onShow() {
    await app.ensureReady()
    if (!app.isSuper()) {
      wx.showModal({ title: '无权限', content: '仅超级管理员可进入管理后台', showCancel: false })
      return
    }
    this.load()
  },

  async load() {
    this.setData({ loading: true })
    try {
      await app.ensureReady()
      const [members, sightings] = await Promise.all([
        app.callApi('listMembers', {}),
        app.callApi('listSightings', { size: 50 })
      ])
      this.setData({
        members: (members || []).map(m => Object.assign({}, m, {
          isSuper: !!m.isSuper,
          roleLabel: m.isSuper ? '超级管理员'
            : ({ admin: '管理员', member: '成员', visitor: '访客' }[m.role] || '访客')
        })),
        sightings: (sightings.list || []).map(s => Object.assign({}, s, {
          timeText: (require('../../utils/util.js').fromNow(s.createdAt))
        }))
      })
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  // 更改成员身份
  async setRole(e) {
    const { id, role } = e.currentTarget.dataset
    const map = { admin: '管理员', member: '成员', visitor: '访客' }
    if (!id) return
    showBusy({ title: '设置中' })
    try {
      await app.callApi('setRole', { userId: id, role })
      wx.showToast({ title: '已设为' + (map[role] || role), icon: 'success' })
      await this.load()
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' })
    } finally {
      hideBusy()
    }
  },

  // 删除上传记录（超管可删任意；普通用户仅在自己的记录上可见此按钮）
  async removeSighting(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const r = await new Promise(resolve => {
      wx.showModal({ title: '删除记录', content: '确定删除这条目击打卡？该操作不可恢复。', success: resolve })
    })
    if (!r.confirm) return
    showBusy({ title: '删除中' })
    try {
      await app.callApi('deleteSighting', { id })
      wx.showToast({ title: '已删除', icon: 'success' })
      await this.load()
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' })
    } finally {
      hideBusy()
    }
  },

  /**
   * 特征库重建（应急入口）
   *
   * 日常不需要它：新猫建档后会在下次识别时自动入库，每天凌晨还有定时全量兜底。
   * 这里的用途是「识别服务重启 / 特征库被清空」后的手动补齐。
   *
   * ⚠️ 超时处理：整库重建是重活，单次云函数调用大概率越过客户端约 3s 的
   * callFunction 预算而报 -504003 —— 但**云端仍会继续执行完**（受云函数自身超时约束），
   * 所以这种情况不算失败，如实告知用户「后台处理中」即可，别弹错误吓人。
   * 动作本身幂等（服务端 onlyMissing 跳过已有），重复点击不会重复算。
   */
  async rebuildIndex() {
    if (this.data.building) return
    const go = await new Promise(resolve => {
      wx.showModal({
        title: '重建特征库',
        content: '将把所有猫咪档案照重新提交给识别服务计算特征。建档后通常无需手动执行。是否继续？',
        success: resolve
      })
    })
    if (!go.confirm) return

    const picked = await new Promise(resolve => {
      wx.showActionSheet({
        itemList: ['只补缺失的（推荐）', '全部重新计算（慢）'],
        success: res => resolve(res.tapIndex === 1),
        fail: () => resolve(null)
      })
    })
    if (picked === null) return

    this.setData({ building: true, indexResult: '', indexDetail: '' })
    let built = 0
    let skipped = 0
    let lastErr = ''

    try {
      // 客户端 callFunction 约 3s 就会报 -504003，但**云端仍会跑完**（受云函数自身
      // ACTION_TIMEOUT_MS=15s 约束）。所以这里直接给 10s 预算：一轮能建的量是 2s 的五倍，
      // 客户端那声超时由下面的 catch 如实翻译成「后台处理中」，不是失败。
      const r = await app.callApi('buildAiIndexAll', {
        budgetMs: 10000, photosPerCat: 3, force: picked
      })
      built = r.built || 0
      skipped = r.skipped || 0
      const detail = (r.results || []).map(x =>
          (x.ok
            ? ('扫到' + (x.scanned || 0) + '只：建成' + (x.built || 0) +
               (x.failedCount ? '，失败' + x.failedCount + '只(' + (x.failedSample || []).join(',') + ')' : ''))
            : ('失败：' + (x.error || '')))
        ).join('；')
      this.setData({ indexDetail: detail })
    } catch (e) {
      lastErr = (e && e.message) || ''
    } finally {
      this.setData({ building: false })
    }

    if (!lastErr) {
      this.setData({ indexResult: '已建 ' + built + ' 只，跳过 ' + skipped + ' 只' })
      wx.showToast({ title: '建库完成', icon: 'success' })
      return
    }
    if (/timed out|-504003|超时/.test(lastErr)) {
      this.setData({ indexResult: '已提交，后台处理中（约几分钟生效）' })
      wx.showToast({ title: '后台处理中', icon: 'none' })
      return
    }
    this.setData({ indexResult: '失败：' + lastErr })
    wx.showToast({ title: lastErr.slice(0, 18) || '建库失败', icon: 'none' })
  },

  goCat(e) {
    wx.navigateTo({ url: '/pages/cat-detail/cat-detail?id=' + e.currentTarget.dataset.id })
  },

  previewPhoto(e) {
    wx.previewImage({ current: e.currentTarget.dataset.url, urls: e.currentTarget.dataset.urls })
  }
})
