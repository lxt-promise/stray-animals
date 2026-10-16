const { C, itemOf, rarityOf } = require('../../utils/util.js')
const photo = require('../../utils/photo.js')

/** 渲染层能不能加载这个地址：http(s) 临时链接、本地 /images/、或 `cloud://` fileID。
 *  注意：<image> 组件走逻辑层 SDK，**能**解析 cloud://（真正的重灾区是 <map> 的
 *  marker.iconPath —— 那是渲染层、不认 cloud://，两者别混淆）。
 *  加载失败还有 onAvatarError 单次兜底退 emoji，不会刷屏。 */
function canRenderImage(src) {
  const s = src || ''
  return /^https?:\/\//.test(s) || /^cloud:\/\//.test(s) || s.indexOf('/images/') === 0
}

Component({
  properties: {
    cat: { type: Object, value: null },
    showSpot: { type: Boolean, value: true }
  },
  data: {
    avatar: '',
    avatarFailed: false
  },
  observers: {
    'cat': function (cat) {
      if (!cat) return
      const statusItem = itemOf(C.CAT_STATUS, cat.status)
      const sterItem = itemOf(C.STERILIZED, cat.sterilized)
      const rarity = rarityOf(cat.pattern)
      const rarityItem = itemOf(C.RARITY, rarity)
      const a = cat.avatar || ''
      this._triedRaw = false
      this.setData({
        statusItem,
        sterItem,
        rarityItem,
        patternLabel: itemOf(C.PATTERN, cat.pattern).label,
        // 换猫（或换头像）时重置失败标记，否则上一只的失败会一直粘着
        avatar: canRenderImage(a) ? a : '',
        avatarFailed: !canRenderImage(a)
      })
    }
  },
  methods: {
    onTap() {
      this.triggerEvent('tap', { id: this.data.cat._id })
    },
    /** 头像加载失败的两级兜底（绝不触发任何重载，避免「失败→重载→再失败」死循环）：
     *  1. 带缩略参数的图挂了 → 去掉 imageMogr2 参数用原图重试一次（参数不被支持时自救）；
     *  2. 再挂 → 退 emoji，只标一次。 */
    onAvatarError() {
      const a = this.data.avatar || ''
      if (!this._triedRaw && photo.hasProcess(a)) {
        this._triedRaw = true
        this.setData({ avatar: photo.stripProcess(a) })
        return
      }
      if (this.data.avatarFailed) return
      this.setData({ avatarFailed: true, avatar: '' })
    }
  }
})
