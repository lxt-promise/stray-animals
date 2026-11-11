const app = getApp()
const { showBusy, hideBusy } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')

/**
 * 「完善资料」弹窗组件。
 *
 * 用户管理界面里大量用户都叫「爱猫同学」，根本分不清谁是谁 —— 根因是注册时
 * 服务端兜底了一个默认昵称，前端又从没引导过用户填。这个组件在「我的 / 地图」
 * 进入时检查：昵称为空或仍是默认值时弹出，引导用户用微信原生能力一次性取好
 * 昵称 + 头像（chooseAvatar 取真实头像、type=nickname 取真实微信昵称），
 * 点「确定」后落库。
 *
 * 组件自己负责上传头像 + 调 updateProfile，完成后 trigger `complete` 事件把
 * 最终值回传给父页面（父页面据此刷新 globalData，避免下次进页又弹一次）。
 */
Component({
  properties: {
    visible: { type: Boolean, value: false },
    nickName: { type: String, value: '' },
    avatarUrl: { type: String, value: '' }
  },

  data: {
    nick: '',
    avatarView: '',
    avatarChanged: false,
    saving: false
  },

  observers: {
    visible(v) {
      if (v) {
        // 每次打开重置：用父页面当前值回填，用户改一半关掉再开不会丢
        this.setData({
          nick: this.data.nickName || '',
          avatarView: photo.display(this.data.avatarUrl, 200),
          avatarChanged: false
        })
      }
    }
  },

  methods: {
    noop() {},

    /** 微信头像：chooseAvatar 返回临时路径，先展示、确认时再上传云存储 */
    onChooseAvatar(e) {
      const url = e.detail && e.detail.avatarUrl
      if (!url) return
      this.setData({ avatarView: url, avatarChanged: true })
    },

    /**
     * 微信昵称：type=nickname 会在用户点输入框时弹「使用微信昵称」，
     * 回到的就是这个真实昵称。兜底值「微信用户」没有区分度，仍让用户自己改。
     */
    onNickReview(e) {
      const n = ((e.detail && e.detail.nickname) || '').trim()
      if (n && n !== '微信用户') this.setData({ nick: n })
    },

    onNickInput(e) {
      this.setData({ nick: (e.detail.value || '').trim() })
    },

    /** 关闭但不保存（已设置过的人也允许跳过，不再打扰） */
    onSkip() {
      this.triggerEvent('complete', { skipped: true })
    },

    async onConfirm() {
      if (this.data.saving) return
      const nick = this.data.nick
      if (!nick) {
        wx.showToast({ title: '请先设置昵称', icon: 'none' })
        return
      }
      this.setData({ saving: true })
      showBusy({ title: '保存中' })
      try {
        const patch = { nickName: nick }
        if (this.data.avatarChanged && this.data.avatarView) {
          // chooseAvatar 给的是本地临时路径，必须上传云存储拿到 fileID 才能入库
          const filePath = this.data.avatarView
          const cloudPath = 'avatar/' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.png'
          const up = await wx.cloud.uploadFile({ cloudPath, filePath })
          patch.avatarUrl = up.fileID
        }
        await app.callApi('updateProfile', patch)
        this.triggerEvent('complete', {
          nickName: nick,
          avatarUrl: patch.avatarUrl || this.data.avatarUrl
        })
      } catch (err) {
        wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' })
      } finally {
        this.setData({ saving: false })
        hideBusy()
      }
    }
  }
})
