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
    loading: true
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

  goCat(e) {
    wx.navigateTo({ url: '/pages/cat-detail/cat-detail?id=' + e.currentTarget.dataset.id })
  },

  previewPhoto(e) {
    wx.previewImage({ current: e.currentTarget.dataset.url, urls: e.currentTarget.dataset.urls })
  }
})
