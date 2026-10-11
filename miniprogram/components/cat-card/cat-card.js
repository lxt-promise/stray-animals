const { C, itemOf, rarityOf } = require('../../utils/util.js')

/** 渲染层能不能加载这个地址：http(s) 或本地 /images/。
 *  `cloud://` fileID 由逻辑层 SDK 解析，渲染层的 <image> 不认 —— 要么报 CORS、要么加载失败，
 *  所以直接当没有头像处理，退回 emoji，避免一张坏图把整个列表刷满报错。 */
function canRenderImage(src) {
  const s = src || ''
  return /^https?:\/\//.test(s) || s.indexOf('/images/') === 0
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
    /** 头像加载失败 → 退回 emoji。只标一次，绝不触发任何重载，避免「失败→重载→再失败」死循环。 */
    onAvatarError() {
      if (this.data.avatarFailed) return
      this.setData({ avatarFailed: true, avatar: '' })
    }
  }
})
