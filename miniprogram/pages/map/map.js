const app = getApp()
const { itemOf, distanceText } = require('../../utils/util.js')

Page({
  data: {
    center: { lat: 39.98, lng: 116.30 },   // 默认：可在学校配置中覆盖
    scale: 16,
    markers: [],
    cats: [],
    clusters: 0,
    loading: true,
    showList: true,
    activeId: '',
    myLocation: null,
    school: null,
    showLegend: false,
    scope: 'public'
  },

  onLoad() {
    this.load()
  },

  onShow() {
    if (this.data.cats.length) this.load()
  },

  /**
   * 点位来自云端的网格聚合接口 listMapPoints：
   *  - 相邻猫自动聚成一个数字气泡，避免近距离点位互相压盖
   *  - 非社团成员拿到的数据已在服务端过滤私有点位并模糊化坐标
   */
  async load() {
    this.setData({ loading: true })
    try {
      await app.ensureReady()
      const school = app.globalData.school
      if (school && school.center) {
        this.setData({ center: school.center, scale: school.scale || 16, school })
      }

      const res = await app.callApi('listMapPoints', { zoom: this.data.scale })
      const points = res.points || []
      const clusters = res.clusters || []

      const markers = []
      const markerMap = {}
      let mid = 0

      points.forEach(p => {
        mid++
        markerMap[mid] = { type: 'cat', catId: p.catId }
        markers.push({
          id: mid,
          latitude: p.lat,
          longitude: p.lng,
          title: p.name,
          callout: {
            content: p.name + (p.sterilized === 'yes' ? ' · 已绝育' : ' · 未绝育'),
            display: 'BYCLICK',
            padding: 8,
            borderRadius: 8,
            bgColor: '#ffffff',
            color: p.sterilized === 'yes' ? '#3BA776' : '#E4694E'
          }
        })
      })

      // 聚合簇：用 label 显示数量气泡
      clusters.forEach(c => {
        mid++
        markerMap[mid] = { type: 'cluster', lat: c.lat, lng: c.lng }
        markers.push({
          id: mid,
          latitude: c.lat,
          longitude: c.lng,
          title: c.count + ' 只猫',
          label: {
            content: String(c.count),
            color: '#ffffff',
            fontSize: 12,
            bgColor: '#F97316',
            borderRadius: 20,
            padding: 6,
            textAlign: 'center'
          }
        })
      })

      // 底部列表：单点 + 簇内猫去重
      const seen = {}
      const cats = []
      const pushCat = p => {
        if (!p || seen[p.catId]) return
        seen[p.catId] = 1
        cats.push({
          _id: p.catId,
          name: p.name,
          avatar: p.avatar,
          sterilized: p.sterilized,
          spot: p.spot || ''
        })
      }
      points.forEach(pushCat)
      clusters.forEach(c => (c.cats || []).forEach(pushCat))

      this.setData({
        cats, markers, loading: false,
        clusters: clusters.length,
        scope: res.scope || 'public'
      })
      this._markerMap = markerMap
    } catch (e) {
      // 聚合接口不可用时退化为猫谱直读，保证页面不白屏
      try {
        await this.loadFallback()
      } catch (e2) {
        this.setData({ loading: false })
        wx.showToast({ title: e.message || '加载失败', icon: 'none' })
      }
    }
  },

  async loadFallback() {
    const res = await app.callApi('listCats', { size: 50 })
    const list = (res.list || []).filter(c => c.location && c.location.lat)
    const markers = []
    const markerMap = {}
    list.forEach((c, i) => {
      const id = i + 1
      markerMap[id] = { type: 'cat', catId: c._id }
      markers.push({
        id,
        latitude: c.location.lat,
        longitude: c.location.lng,
        title: c.name,
        callout: {
          content: c.name + (c.sterilized === 'yes' ? ' · 已绝育' : ' · 未绝育'),
          display: 'BYCLICK',
          padding: 8,
          borderRadius: 8,
          bgColor: '#ffffff',
          color: c.sterilized === 'yes' ? '#3BA776' : '#E4694E'
        }
      })
    })
    this.setData({
      cats: list.map(c => ({
        _id: c._id,
        name: c.name,
        avatar: (c.photos && c.photos[0]) || c.avatar || '',
        sterilized: c.sterilized,
        spot: (c.location && c.location.name) || ''
      })),
      markers,
      loading: false,
      clusters: 0
    })
    this._markerMap = markerMap
  },

  onMarkerTap(e) {
    const id = e.detail.markerId || e.markerId
    const m = (this._markerMap || {})[id]
    if (!m) return
    if (m.type === 'cluster') {
      // 点聚合气泡 → 放大一级，展开成单点
      this.setData({
        center: { lat: m.lat, lng: m.lng },
        scale: Math.min(20, this.data.scale + 2)
      }, () => this.load())
      return
    }
    this.setData({ activeId: m.catId })
    const cat = this.data.cats.filter(c => c._id === m.catId)[0]
    if (cat) {
      const p = (this.data.markers || []).filter(x => x.id === id)[0]
      if (p) this.setData({ center: { lat: p.latitude, lng: p.longitude } })
    }
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/cat-detail/cat-detail?id=' + e.currentTarget.dataset.id })
  },

  locateMe() {
    wx.getLocation({
      type: 'gcj02',
      success: res => {
        const my = { lat: res.latitude, lng: res.longitude }
        app.globalData.myLocation = my
        this.setData({ myLocation: my, center: my })
      },
      fail: () => wx.showToast({ title: '需要授权位置权限', icon: 'none' })
    })
  },

  toggleList() {
    this.setData({ showList: !this.data.showList })
  },

  toggleLegend() {
    this.setData({ showLegend: !this.data.showLegend })
  },

  goSighting() {
    wx.navigateTo({ url: '/pages/sighting-post/sighting-post' })
  }
})
