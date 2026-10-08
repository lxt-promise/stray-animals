const { C, itemOf, rarityOf } = require('../../utils/util.js')

Component({
  properties: {
    cat: { type: Object, value: null },
    showSpot: { type: Boolean, value: true }
  },
  data: {},
  observers: {
    'cat': function (cat) {
      if (!cat) return
      const statusItem = itemOf(C.CAT_STATUS, cat.status)
      const sterItem = itemOf(C.STERILIZED, cat.sterilized)
      const rarity = rarityOf(cat.pattern)
      const rarityItem = itemOf(C.RARITY, rarity)
      this.setData({
        statusItem,
        sterItem,
        rarityItem,
        patternLabel: itemOf(C.PATTERN, cat.pattern).label
      })
    }
  },
  methods: {
    onTap() {
      this.triggerEvent('tap', { id: this.data.cat._id })
    }
  }
})
