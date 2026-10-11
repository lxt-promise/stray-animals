// custom-tab-bar/index.js —— 自定义底部导航
// 说明：「工作台」已迁移到「我的」页内（仅超管可见），不再占用 tab 位。
// 这里保留自定义 tabBar 与按身份过滤的能力，方便后续再加条件性 tab。
const ALL = [
  { pagePath: 'pages/index/index', text: '首页', icon: 'home' },
  { pagePath: 'pages/cats/cats', text: '猫谱', icon: 'cat' },
  { pagePath: 'pages/map/map', text: '地图', icon: 'map' },
  { pagePath: 'pages/mine/mine', text: '我的', icon: 'mine' }
]

Component({
  data: {
    selected: 0,
    list: []
  },

  pageLifetimes: {
    show() {
      this.refresh()
    }
  },

  lifetimes: {
    attached() {
      this.refresh()
    }
  },

  methods: {
    refresh() {
      const app = getApp()
      const isSuper = !!(app && app.isSuper && app.isSuper())
      const list = ALL
        .filter(i => isSuper || !i.superOnly)
        .map(i => ({
          pagePath: '/' + i.pagePath,
          text: i.text,
          icon: '/images/tab/' + i.icon + '.png',
          iconOn: '/images/tab/' + i.icon + '_on.png'
        }))
      const pages = getCurrentPages()
      const cur = pages.length ? '/' + pages[pages.length - 1].route : ''
      let selected = -1
      list.forEach((item, idx) => {
        if (item.pagePath === cur) selected = idx
      })
      this.setData({ list, selected })
    },

    switchTab(e) {
      const url = e.currentTarget.dataset.url
      if (!url) return
      wx.switchTab({ url })
    }
  }
})
