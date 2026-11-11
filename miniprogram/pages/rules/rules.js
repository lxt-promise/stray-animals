const { C } = require('../../utils/util.js')

/**
 * 规则说明（独立页面）
 *
 * 原实现：在「我的」页底部常驻，后来收进菜单项点击就地展开。
 * 现在按需求独立成页：菜单项点击 → navigateTo 到这里。
 * 文案仍来自 const.RULES（与「等级」页共用同一份，改数值只改一处）。
 */
Page({
  data: {
    rules: C.RULES
  }
})
