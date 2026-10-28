const app = getApp()
const { C, labelOf, showBusy, hideBusy, fromNow, sightTagText } = require('../../utils/util.js')

/**
 * 一条疑似重复档案的副文案：「2 小时前 · 3 张照片 · 5 次打卡」。
 *
 * 之所以在 JS 里拼：WXML 的 mustache 只做取值，`a + ' 张照片'` 这类拼接
 * 会被**静默忽略**（渲染成空白、控制台无报错）。项目里已踩过多次。
 */
function dupMetaText(it) {
  const bits = [fromNow(it && it.createdAt) || '时间未知']
  const n = Number(it && it.photoCount) || 0
  bits.push(n ? (n + ' 张照片') : '无照片')
  const s = Number(it && it.sightingCount) || 0
  if (s) bits.push(s + ' 次打卡')
  if (it && it.hasAvatar) bits.push('有头像')
  return bits.join(' · ')
}

/**
 * 引擎体检的三个展示行，全部在这里算好。
 *
 * 为什么不写在 WXML 里：WXML 的 mustache 只认白名单表达式，`a + ' 只'`、
 * `a < 0 ? ... : ...` 这类容易被**静默忽略**（整段退化成空字符串），
 * 表现是「界面一块空白、控制台没有任何报错」。项目里已经踩过这个坑。
 */
function engineRowsOf(e) {
  const src = e.attrSource
  return [
    {
      key: 'detect',
      name: '猫体检测',
      ok: !!e.detector,
      value: e.detector ? '已启用' : '未启用',
      hint: e.detector ? (e.detectModel || '权重未知') : '整图提特征，背景会干扰'
    },
    {
      key: 'attrs',
      name: '花色识别',
      ok: !!src,
      value: src === 'clip' ? 'CLIP' : (src === 'api' ? '远程接口' : (src ? '本地色域' : '未启用')),
      hint: src === 'clip' ? '语义分类，最准'
        : (src === 'api' ? '走远程属性接口' : '数像素推算，够用')
    },
    {
      key: 'index',
      name: '特征库',
      ok: Number(e.indexed) > 0,
      value: Number(e.indexed) < 0 ? '不可用' : (Number(e.indexed) + ' 只'),
      // 口径必须可解释：这里现在按本校统计（与下方花色比对卡一致）。
      // 全库比本校大时注明差值 —— 那些是其它学校的向量 + 已删档案的残留，
      // 识别按校隔离读不到它们，但一个来历不明的 11 会把管理员吓到
      //（2026-10-25 现场：档案 6 只、界面 11 只）。
      hint: (e.indexBackend || '') +
        (Number(e.indexedTotal) > Number(e.indexed)
          ? ' · 全库 ' + e.indexedTotal + ' 条'
          : '')
    }
  ]
}

/**
 * 把建库失败的结构化原因翻成一句人话。
 *
 * 为什么不在 WXML 里拼：mustache 只认白名单表达式，字符串拼接会被**静默忽略**，
 * 表现是 toast 空白、控制台无报错。所有文案必须在 JS 里算好。
 *
 * 原因词表（云端 vision.buildIndex 前置判定 + 服务端 /v1/index/build 的 reasons）：
 *   noPhoto              档案里没有照片
 *   photoUrl:N           N 张照片一个临时链接都没换出来（文件多半已不存在）
 *   downloadFailed:a/b   服务端下载 a/b 张全失败
 *   noVector:a/b         下载成功但没产出向量
 *   embedFailed:xxx      编码抛错
 */
function indexFailText(r, id) {
  const rs = (r && r.reasons) || {}
  const reason = String(rs[id] || '')
  const [code, detail] = reason.split(':')
  if (code === 'noPhoto') return '这只猫没有可用照片'
  if (code === 'photoUrl') {
    return (Number(detail) || 0) + ' 张照片都没换出链接，可能已被删除'
  }
  if (code === 'downloadFailed') {
    return '服务端下载照片失败（' + (detail || '') + ' 张），链接可能已过期'
  }
  if (code === 'noVector') {
    return '照片下载成功但没算出特征，请换张更清楚的'
  }
  if (code === 'embedFailed') {
    return '特征编码失败：' + String(detail || '').slice(0, 40)
  }
  // 没有原因（老版本服务端）：如实说明，不再假装「稍后重试」一定会好
  return Number(r && r.scanned) > 0
    ? '服务端未生成特征，点「刷新」看是否有变化'
    : '没有可提交的照片'
}

/**
 * 校园地图范围的可选缩放级别。
 *
 * 这里是**唯一**的地图范围配置入口（「我的」页已不再提供，个人页不该出现
 * 学校级的基础设施配置）。改的是 schools.scale，与 schools.center 一起
 * 由云端 normalizeSchoolGeo 推出 bounds，地图页只展示这块区域内的点位。
 */
const SCHOOL_SCALES = [
  { value: 14, label: '14 · 整个校区' },
  { value: 15, label: '15 · 较大范围' },
  { value: 16, label: '16 · 推荐' },
  { value: 17, label: '17 · 局部区域' },
  { value: 18, label: '18 · 单栋楼附近' }
]
const SCHOOL_SCALE_LABELS = SCHOOL_SCALES.map(o => o.label)

/**
 * 坐标是否可用。
 *
 * 必须同时要求「有限数字」：只判 typeof 的话 NaN 会一路带进 bounds，
 * 算出来的矩形全是 NaN，地图页的点位过滤静默失效 —— 表现为「范围怎么改都不生效」。
 * （2026-10-24 起地图不再用 setBoundary 锁镜头，bounds 只用于筛选本校点位。）
 */
function centerOk(c) {
  return !!(c && typeof c.lat === 'number' && typeof c.lng === 'number' &&
    isFinite(c.lat) && isFinite(c.lng))
}

/**
 * 校园列表每一行的展示文案，全部在这里算好。
 *
 * WXML 的 mustache 只认白名单表达式：`'档案 ' + n + ' 只'`、`n >= 0 ? n : '—'`
 * 这类要么被静默忽略、要么渲染成空 —— 后台会变成一片「看起来没数据」的空白，
 * 且控制台不报错。所以文案一律在 JS 里拼。
 *
 * `count < 0` 表示该计数读取失败（云端给的是 -1）。「0 只猫」和「数不出来」
 * 在后台是两件事：混在一起会让管理员以为档案丢了。
 */
function schoolRowOf(s, currentId) {
  const sub = [s.campus, s.city].filter(Boolean).join(' · ')
  const cats = Number(s.catCount)
  const users = Number(s.userCount)
  const scale = Math.max(12, Math.min(18, Number(s.scale) || 16))
  const hidden = !!s.hidden
  return Object.assign({}, s, {
    isCurrent: !!currentId && s._id === currentId,
    isHidden: hidden,
    subText: sub || '未填写校区 / 城市',
    statText: '档案 ' + (cats >= 0 ? cats : '—') + ' 只 · 绑定用户 ' + (users >= 0 ? users : '—') + ' 人',
    geoText: centerOk(s.center) ? ('地图范围已设置（缩放 ' + scale + '）') : '地图范围未设置',
    visText: s.sightingPublic ? '打卡记录公开' : '打卡仅内部可见',
    // 隐藏态必须**显示在列表行上**：只在编辑面板里有开关的话，
    // 超管看到一排校区名根本分不清哪所是用户看不见的。
    hiddenText: hidden ? '仅超管可见' : '对用户可见'
  })
}

/**
 * 超级管理后台
 *  - 成员管理：更改管理员 / 成员 / 访客身份
 *  - 上传记录管理：查看并删除任意目击打卡
 *  - 校园管理：预览所有校区（含档案数/成员数）并就地修改校名、校区、简介与地图范围
 *  - 特征库体检：档案总数 / 已录入 / 未录入清单（未录入的猫识别时永远匹配不到）
 *  - 引擎体检：检测模型有没有生效（没开和没加载上在用户侧表现完全一样）
 * 仅超级管理员可见（入口在「我的」页，且云端每个 action 都再校验一次）。
 */
Page({
  data: {
    members: [],
    sightings: [],
    loading: true,
    building: false,
    indexResult: '',
    indexDetail: '',
    // 特征库状态（独立异步加载，不拖慢首屏）
    // scopeText / bankText / emptyKind / emptyText 全部在 JS 预拼：
    // WXML 的 mustache 不做字符串拼接与比较运算，「档案 0」的成因说明必须能直接渲染。
    indexStatus: {
      total: 0, indexed: 0, missing: 0, source: '', bankError: '', catError: '',
      ledgerDrift: 0, bankTotal: 0, dbTotal: null, scoped: false,
      scopeText: '', bankText: '', emptyKind: '', emptyText: '', cats: []
    },
    indexLoading: false,
    indexingId: '',
    // 识别引擎体检（独立异步：一个 GET，和特征库体检并行发）
    engine: {
      ok: false, provider: '', detector: false, detectModel: '',
      attrSource: '', indexed: -1, indexBackend: '', error: ''
    },
    engineRows: [],
    engineLoading: false,
    // 打卡可见性策略（超管专属；默认 false = 仅社团内部可见）
    policyPublic: false,
    // 建校申请（用户端的「没有我的学校？申请新建」落到这里）
    schoolApplies: [],
    handlingApplyId: '',
    // 校园管理（超管）：列表 + 就地编辑。表单里只放可改的四个文字字段，
    // 地图中心/缩放在 schoolCenter / schoolScaleIndex 里单独维护（结构不同）。
    schools: [],
    schoolLoading: false,
    schoolsError: '',
    schoolEditing: '',
    schoolSaving: false,
    schoolForm: { name: '', campus: '', city: '', intro: '' },
    schoolCenter: null,
    schoolCenterText: '',
    schoolScaleIndex: 2,
    schoolScaleLabel: SCHOOL_SCALE_LABELS[2],
    // 只有真的动过中心/缩放才提交地理字段：纯文字编辑不该顺手重算一次 bounds
    // （学校若被手工校正过范围，重算会把它悄悄改回「中心 + 缩放」推算值）
    schoolGeoDirty: false,
    scaleLabels: SCHOOL_SCALE_LABELS,
    // 重复档案（超管）：同校 + 同名的疑似重复建档。
    // 成因是「保存超时 → 用户又点一遍」，而小程序端一直没有删除入口，
    // 于是重复的猫只能烂在猫谱里。dupChecked 用来区分「还没扫」与「扫了没有重复」。
    dupChecked: false,
    dupLoading: false,
    dupError: '',
    dupScanned: 0,
    dupGroups: [],
    dupRemovingId: '',
    // 确认样本库：用户「识别 → 点确认」留下的照片，可手动并入特征库。
    // 三个计数在 loadSamples 里算好 —— WXML 里不能做过滤/比较，会静默渲染成空。
    sampleLoading: false,
    sampleError: '',
    sampleStat: {
      total: 0, usable: 0, fresh: 0, used: 0, ignored: 0, unassigned: 0,
      perCat: 3, minScore: 45, viewCap: 8
    },
    sampleGroups: [],
    sampleBuilding: false,
    sampleBuildingId: '',
    sampleResult: '',
    // 「指定猫」下拉的候选项（只在存在未归属样本时才懒加载）
    catOptions: [],
    catNames: []
  },

  async onShow() {
    await app.ensureReady()
    if (!app.isSuper()) {
      wx.showModal({ title: '无权限', content: '仅超级管理员可进入管理后台', showCancel: false })
      return
    }
    this.load()
    // 特征库状态要调识别服务（可能 1~3s），独立跑，不阻塞成员/记录列表。
    // 引擎体检是另一个独立 action，并行发 —— 失败互不连累。
    this.loadIndexStatus()
    this.loadEngineHealth()
    // 确认样本库：独立加载（要换缩略图临时链接，可能 1~2s，不能拖慢首屏）
    this.loadSamples()
    // 校园管理：独立加载（老版本云函数没有 listSchoolsAdmin，不能连累整页）
    this.loadSchools()
  },

  async load() {
    this.setData({ loading: true })
    try {
      await app.ensureReady()
      const [members, sightings, policy, applies] = await Promise.all([
        app.callApi('listMembers', {}),
        app.callApi('listSightings', { size: 50 }),
        // 查询当前策略；失败不阻塞页面（回落 false）
        app.callApi('setSightingVisibilityPolicy', {}).catch(() => null),
        // 建校申请：失败同样不阻塞（老版本云函数没有这个 action，不能连累整页）
        app.callApi('listSchoolApplies', { status: 'pending' }).catch(() => [])
      ])
      this.setData({
        members: (members || []).map(m => Object.assign({}, m, {
          isSuper: !!m.isSuper,
          roleLabel: m.isSuper ? '超级管理员'
            : ({ admin: '管理员', member: '成员', visitor: '访客' }[m.role] || '访客')
        })),
        sightings: (sightings.list || []).map(s => Object.assign({}, s, {
          timeText: fromNow(s.createdAt),
          tagText: sightTagText(s)   // 结构化标签（替代原自由文本 note）
        })),
        // 时间文案在这里拼好：WXML 里不能调 fromNow()
        schoolApplies: (applies || []).map(a => Object.assign({}, a, {
          timeText: fromNow(a.createdAt),
          // 类型标签：join = 加入已有学校，create = 新建学校
          typeLabel: a.type === 'join' ? '入校申请' : '建校申请',
          // 展示名：join 取 schoolName，create 取 name(+campus)
          fullName: a.type === 'join'
            ? (a.schoolName || '该校')
            : (a.campus ? (a.name + ' · ' + a.campus) : (a.name || '新学校')),
          reasonText: a.reason || ''
        })),
        policyPublic: !!(policy && policy.public)
      })
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  /**
   * 切换打卡可见性策略（超管专属）。
   *
   * 合规背景：把「公开/不公开」的决定权从**打卡者**移到**管理员**，
   * 用户端就不存在"发布到校园"的入口 —— 产品形态是「社团登记 + 管理员决定是否公示」。
   * 开启前给一次明确的风险提示（公开会构成用户内容对外发布）。
   */
  async togglePolicy() {
    const next = !this.data.policyPublic
    if (next) {
      const go = await new Promise(resolve => {
        wx.showModal({
          title: '开启公开打卡',
          content: '开启后，新提交的打卡记录将对访客可见（展示猫只、时间与结构化状态）。'
            + '这属于「用户内容的对外发布」，个人主体小程序审核时可能被判定为社交类目。确定开启？',
          confirmText: '确定开启',
          success: resolve
        })
      })
      if (!go.confirm) return
    }
    this.setData({ policyPublic: next })
    showBusy({ title: '保存中' })
    try {
      const r = await app.callApi('setSightingVisibilityPolicy', { data: { public: next } })
      const saved = !!(r && r.public)
      this.setData({ policyPublic: saved })
      wx.showToast({ title: saved ? '已开启公开' : '已设为仅内部可见', icon: 'none' })
    } catch (e) {
      this.setData({ policyPublic: !next })   // 失败回滚
      wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' })
    } finally {
      hideBusy()
    }
  },

  onPullDownRefresh() {
    this.load()
      .then(() => Promise.all([
        this.loadIndexStatus(), this.loadEngineHealth(), this.loadSamples(), this.loadSchools()
      ]))
      .then(() => wx.stopPullDownRefresh())
  },

  /* ==================== 校园管理 ==================== */

  /**
   * 拉校园列表（超管）。
   *
   * `listSchools` 是用户选校用的公开接口，只回校名；后台要判断「哪所校区有数据、
   * 哪所是空壳」，所以走 `listSchoolsAdmin`（多回档案数 / 绑定用户数）。
   * 读取失败**照实显示**，不回落成空列表 —— 「没有校区」和「读不到校区」是两件事。
   */
  async loadSchools() {
    if (this.data.schoolLoading) return
    this.setData({ schoolLoading: true })
    try {
      const list = await app.callApi('listSchoolsAdmin', {})
      const g = app.globalData || {}
      const cur = (g.school && g.school._id) || (g.user && g.user.schoolId) || ''
      this.setData({
        schools: (list || []).map(s => schoolRowOf(s, cur)),
        schoolsError: ''
      })
    } catch (e) {
      console.warn('[admin] 校园列表读取失败', e && e.message)
      this.setData({ schools: [], schoolsError: (e && e.message) || '读取失败' })
    } finally {
      this.setData({ schoolLoading: false })
    }
  },

  /** 展开某所校园的编辑面板（同一时间只编辑一所，避免两份表单互相覆盖） */
  editSchool(e) {
    const id = e.currentTarget.dataset.id
    if (!id || this.data.schoolSaving) return
    // 再点一次同一所 = 收起
    if (this.data.schoolEditing === id) {
      this.setData({ schoolEditing: '' })
      return
    }
    const s = (this.data.schools || []).filter(x => x._id === id)[0] || {}
    const scale = Math.max(12, Math.min(18, Number(s.scale) || 16))
    const idx = SCHOOL_SCALES.map(o => o.value).indexOf(scale)
    const at = idx >= 0 ? idx : 2
    const ok = centerOk(s.center)
    this.setData({
      schoolEditing: id,
      schoolForm: {
        name: s.name || '',
        campus: s.campus || '',
        city: s.city || '',
        intro: s.intro || '',
        // 选中态一律 JS 预计算（WXML mustache 不支持 indexOf/includes）
        hidden: !!s.hidden
      },
      schoolCenter: ok ? { lat: Number(s.center.lat), lng: Number(s.center.lng) } : null,
      schoolCenterText: ok
        ? (Number(s.center.lat).toFixed(5) + ', ' + Number(s.center.lng).toFixed(5))
        : '未设置（地图会用默认坐标）',
      schoolScaleIndex: at,
      schoolScaleLabel: SCHOOL_SCALE_LABELS[at],
      schoolGeoDirty: false
    })
  },

  cancelSchoolEdit() {
    if (this.data.schoolSaving) return
    this.setData({ schoolEditing: '' })
  },

  onSchoolInput(e) {
    const key = (e.currentTarget.dataset || {}).key
    if (!key) return
    this.setData({ ['schoolForm.' + key]: (e.detail || {}).value || '' })
  },

  /**
   * 切换「是否对普通用户可见」。
   *
   * ⚠️ 必须写**布尔值**而不是取反字符串：云端用 `!== undefined` 判断这个字段，
   * 传 `false` 才是「取消隐藏」；传空字符串/0 之类会被 `!!` 兜成别的意思。
   */
  onToggleSchoolHidden() {
    if (this.data.schoolSaving) return
    this.setData({ 'schoolForm.hidden': !this.data.schoolForm.hidden })
  },

  onSchoolScaleChange(e) {
    const idx = Number((e.detail || {}).value) || 0
    const at = Math.max(0, Math.min(SCHOOL_SCALES.length - 1, idx))
    this.setData({
      schoolScaleIndex: at,
      schoolScaleLabel: SCHOOL_SCALE_LABELS[at],
      // 改缩放必须重算范围，标记为「地理字段有改动」
      schoolGeoDirty: true
    })
  },

  /** 选地图中心点（chooseLocation 返回的真实坐标，不做任何兜底覆盖） */
  async chooseSchoolCenter() {
    const start = centerOk(this.data.schoolCenter)
      ? this.data.schoolCenter
      : { lat: 32.0585, lng: 118.7965 }
    let loc
    try {
      loc = await new Promise((resolve, reject) => {
        wx.chooseLocation({
          latitude: start.lat,
          longitude: start.lng,
          success: resolve,
          fail: reject
        })
      })
    } catch (e) {
      // 「用户主动取消」是静默的，只有真失败才提示 —— 否则每次取消都弹一次错
      const msg = (e && (e.errMsg || e.message)) || ''
      if (msg && msg.indexOf('cancel') < 0 && msg.indexOf('取消') < 0) {
        wx.showToast({ title: '打开地图失败：' + msg, icon: 'none' })
      }
      return
    }
    if (!loc || !centerOk({ lat: Number(loc.latitude), lng: Number(loc.longitude) })) {
      wx.showToast({ title: '未取到坐标，请重选', icon: 'none' })
      return
    }
    const center = { lat: Number(loc.latitude), lng: Number(loc.longitude) }
    this.setData({
      schoolCenter: center,
      schoolCenterText: center.lat.toFixed(5) + ', ' + center.lng.toFixed(5),
      schoolGeoDirty: true
    })
  },

  /**
   * 保存校园信息。
   *
   * 只提交**本表单里的字段**，其中地理字段（center/scale）仅在地理信息被改动时提交：
   * 纯改简介也顺手重算一次 bounds 是没必要且有害的（会覆盖手工校正过的范围）。
   *
   * 改的是自己绑定的那所学校时，同步刷新 globalData.school —— 否则返回首页
   * 還顶着旧校名（首页头部读的就是这个对象）。
   */
  async saveSchool() {
    const id = this.data.schoolEditing
    if (!id || this.data.schoolSaving) return
    const f = this.data.schoolForm || {}
    const name = String(f.name || '').trim()
    if (!name) {
      wx.showToast({ title: '学校名称不能为空', icon: 'none' })
      return
    }
    const payload = {
      schoolId: id,
      name: name,
      campus: String(f.campus || '').trim(),
      city: String(f.city || '').trim(),
      intro: String(f.intro || '').trim(),
      // 布尔值原样下发（undefined/空串都不行 —— 云端靠 `!== undefined` 判定是否要改）
      hidden: !!f.hidden
    }
    if (this.data.schoolGeoDirty) {
      // 没有中心点时只写 scale 会被云端按默认坐标重算，等于把范围挪到别处 ——
      // 所以先要求选中心点，而不是静默改了个错的位置。
      if (!centerOk(this.data.schoolCenter)) {
        wx.showToast({ title: '请先「选择地图中心」', icon: 'none' })
        return
      }
      payload.center = this.data.schoolCenter
      payload.scale = SCHOOL_SCALES[this.data.schoolScaleIndex].value
    }

    this.setData({ schoolSaving: true })
    showBusy({ title: '保存中' })
    try {
      const updated = await app.callApi('updateSchool', payload)
      const g = app.globalData || {}
      const curId = (g.school && g.school._id) || (g.user && g.user.schoolId) || ''
      if (curId && curId === id) {
        // 当前学校变了：首页校名、地图范围都读这个对象，必须一起换掉
        app.setSchool(Object.assign({}, g.school || {}, updated || {}, { _id: id }))
      }
      this.setData({ schoolEditing: '' })
      wx.showToast({ title: '已保存', icon: 'success' })
      await this.loadSchools()
    } catch (e) {
      // 云端已把「参数不合法 / 未通过安全检测」区分开，照实显示，别统一成「保存失败」
      const msg = (e && e.message) || '保存失败'
      if (msg.length > 12) {
        wx.showModal({ title: '保存失败', content: msg, showCancel: false, confirmText: '知道了' })
      } else {
        wx.showToast({ title: msg, icon: 'none' })
      }
    } finally {
      this.setData({ schoolSaving: false })
      hideBusy()
    }
  },

  /* ==================== 重复档案（超管） ==================== */

  /**
   * 扫描「同校 + 同名」的疑似重复建档。
   *
   * 只按名字判重：照片/特征相似度判重会把两只真猫误合成一只，且不可复原；
   * 同名误报的代价只是多看一眼照片数 —— 界面上也明确写了要核对。
   */
  async loadDuplicates() {
    if (this.data.dupLoading) return
    this.setData({ dupLoading: true, dupError: '' })
    try {
      const r = await app.callApi('findDuplicateCats', {})
      const raw = (r && r.groups) || []
      const groups = raw.map(g => {
        const items = g.items || []
        return {
          key: g.key,
          name: g.name || '未命名',
          countText: items.length + ' 条',
          items: items.map(it => ({
            _id: it._id,
            keep: !!it.keep,
            // 文案全部在这里拼好：WXML 的 mustache 不做字符串拼接，写
            // `{{it.photoCount + ' 张照片'}}` 会被静默吃成空白
            tagText: it.keep ? '建议保留' : '待清理',
            timeText: fromNow(it.createdAt) || '时间未知',
            metaText: dupMetaText(it)
          }))
        }
      })
      this.setData({
        dupChecked: true,
        dupScanned: Number(r && r.scanned) || 0,
        dupGroups: groups
      })
    } catch (e) {
      console.warn('[admin] 重复档案扫描失败', e && e.message)
      this.setData({
        dupChecked: true,
        dupGroups: [],
        dupError: (e && e.message) || '扫描失败'
      })
    } finally {
      this.setData({ dupLoading: false })
    }
  },

  /**
   * 删除一条重复档案。
   *
   * 硬删除、不可恢复，所以必须二次确认，且确认框里带上这条记录的创建时间 ——
   * 用户要能一眼对上「我要删的是后面那一条」。
   */
  async removeDuplicate(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const id = ds.id
    if (!id || this.data.dupRemovingId) return
    const ok = await new Promise(resolve => {
      wx.showModal({
        title: '删除这条档案',
        content: '「' + (ds.name || '这只猫') + '」' + (ds.time ? '（' + ds.time + ' 创建）' : '') +
          '将被永久删除，无法恢复。同一只猫保留另一条即可。',
        confirmText: '删除',
        confirmColor: '#C2410C',
        success: r => resolve(!!(r && r.confirm)),
        fail: () => resolve(false)
      })
    })
    if (!ok) return
    this.setData({ dupRemovingId: id })
    showBusy({ title: '删除中' })
    try {
      await app.callApi('removeCat', { id })
      hideBusy()
      wx.showToast({ title: '已删除', icon: 'success' })
      // 猫删了，特征库只数 / 本轮统计都跟着变：一起刷，别在界面上留旧数字
      this.loadDuplicates()
      this.load()
      this.loadIndexStatus()
    } catch (err) {
      hideBusy()
      const msg = (err && err.message) || '删除失败'
      if (msg.length > 12) {
        wx.showModal({ title: '删除失败', content: msg, showCancel: false, confirmText: '知道了' })
      } else {
        wx.showToast({ title: msg, icon: 'none' })
      }
    } finally {
      this.setData({ dupRemovingId: '' })
    }
  },

  /**
   * 拉识别引擎体检（检测模型 / 花色链路 / 特征库只数）。
   *
   * 为什么要在后台显示这个：「YOLO 没配」和「配了但没加载上」在用户侧表现完全一样
   * （识别不准），日志里也只是一条 warning。把状态摆到界面上，运维改完配置
   * 点一下刷新就知道生没生效，不用 SSH 上去 curl /health。
   * 连不上识别服务时**照实显示错误**，不显示一份"看起来正常"的默认值。
   */
  async loadEngineHealth() {
    if (this.data.engineLoading) return
    this.setData({ engineLoading: true })
    try {
      const r = await app.callApi('engineHealth', {})
      if (!r || r.ok === false && !r.error) throw new Error('读取失败')
      const engine = Object.assign({}, this.data.engine, r || {})
      this.setData({ engine, engineRows: engineRowsOf(engine) })
    } catch (e) {
      console.warn('[admin] 引擎体检失败', e && e.message)
      const engine = Object.assign({}, this.data.engine, { error: (e && e.message) || '读取失败' })
      this.setData({ engine, engineRows: [] })
    } finally {
      this.setData({ engineLoading: false })
    }
  },

  /**
   * 拉特征库体检结果。
   *
   * 真相来源是识别服务的特征库（`/v1/index/ids`），不是云库的 `aiIndexAt`：
   * 后者只是乐观记账，服务端补库失败的猫照样带着「已入库」标记。
   * 识别服务连不上时云端会降级为记账口径并回 `source='ledger'`，
   * 界面必须把「推测」和「实况」区分开，不能拿推测当结论。
   */
  async loadIndexStatus() {
    if (this.data.indexLoading) return
    this.setData({ indexLoading: true })
    try {
      const r = await app.callApi('indexStatus', {})
      if (!r || r.ok === false) throw new Error((r && r.msg) || '读取失败')

      const total = Number(r.total) || 0
      const bankTotal = Number(r.bankTotal) || 0
      const bankError = r.bankError || ''
      const catError = r.catError || ''
      const dbTotal = (r.dbTotal === undefined || r.dbTotal === null) ? null : Number(r.dbTotal)
      const scoped = !!r.scoped

      // 「档案 0」不是一种情况，是三种 —— 界面上必须说清是哪一种，否则管理员
      // 只会看到「还没有猫咪档案」，然后怀疑「是不是特征库文件丢了」。
      let emptyKind = ''
      let emptyText = ''
      if (!total) {
        if (catError) {
          emptyKind = 'error'
          emptyText = '读取档案失败：' + catError
        } else if (dbTotal > 0) {
          emptyKind = 'school'
          emptyText = '当前学校名下没有档案（全环境共 ' + dbTotal +
            ' 只猫，都不属于这所学校）—— 先核对档案的 schoolId 与当前绑定学校'
        } else {
          emptyKind = 'none'
          emptyText = '还没有猫咪档案'
        }
        // 关键判据：档案查不到，但特征库里还有向量 → 不是特征库丢了，是档案对不上
        if (bankTotal > 0) {
          emptyText += '；但特征库里仍有 ' + bankTotal + ' 条向量，说明特征库没丢，只是查不到对应的云库档案'
        }
      }

      this.setData({
        indexStatus: {
          total: total,
          indexed: Number(r.indexed) || 0,
          missing: Number(r.missing) || 0,
          source: r.source || '',
          bankError: bankError,
          catError: catError,
          ledgerDrift: Number(r.ledgerDrift) || 0,
          bankTotal: bankTotal,
          dbTotal: dbTotal,
          scoped: scoped,
          // 统计口径必须显式：多校隔离后「本校 0 只」和「全库 0 只」是两件事
          scopeText: scoped
            ? '统计范围：本校档案（学校 ' + String(r.schoolId || '').slice(-6) + '）'
            : '统计范围：全部档案（当前账号未绑定学校）',
          bankText: bankError
            ? '特征库读取失败，以下为本地记账推测：' + bankError
            : (bankTotal > 0
              // 幽灵向量单说：bankTotal > 已录入 时管理员一定对不上账
              //（本校 7 条 vs 已录入 6 → 有 1 条是已删档案的残留）。
              // 不解释，下一个「为什么数字对不上」的问题就还是它。
              ? ('特征库已有 ' + bankTotal + ' 条向量' +
                (Number(r.ghostCount) > 0
                  ? '（其中 ' + r.ghostCount + ' 条无对应档案，是已删猫的残留，可用「全部重建」清理）'
                  : ''))
              : '特征库为空'),
          emptyKind: emptyKind,
          emptyText: emptyText,
          cats: (r.cats || []).map(c => Object.assign({}, c, {
            patternLabel: labelOf(C.PATTERN, c.pattern),
            // 没照片的猫建不了库（服务端逐张下载算向量，没有素材直接失败）。
            // 提前标出来，别让管理员对着按钮一直点。
            canIndex: Number(c.photoCount) > 0
          }))
        }
      })
    } catch (e) {
      console.warn('[admin] 特征库状态读取失败', e && e.message)
      // 不弹 toast 打断管理员的其他操作，页面上的「刷新」会重试
      this.setData({ 'indexStatus.source': 'error', 'indexStatus.bankError': (e && e.message) || '' })
    } finally {
      this.setData({ indexLoading: false })
    }
  },

  /**
   * 单只录入：把这只猫的档案照提交给识别服务算代表向量。
   *
   * ⚠️ 结论**只认 indexStatus**，不用本地 `indexed+1`（2026-10-24 现场）：
   *   建库要服务端逐张下载 + 编码（现在最多 5 张），经常跑过客户端 `callFunction`
   *   约 3s 的硬预算 —— 客户端先报 -504003，而云端/识别服务其实还在正常烧 CPU，
   *   几秒后真的建好了。旧实现把这次「超时」当成失败、也不动计数，于是
   *   「点了录入，未录入还是 1」，可实际特征库已经多了一条。
   *   现在：请求回来（无论成败）都等一会儿重拉 indexStatus，以真实结果为准。
   *   顺带解决另一个隐患 —— 本地 +1/-1 只是乐观更新，一旦和服务端口径不同就会一直错着。
   */
  async indexOne(e) {
    const id = e.currentTarget.dataset.id
    if (!id || this.data.indexingId) return
    const cat = this.data.indexStatus.cats.filter(c => c.id === id)[0] || {}
    if ((cat.photoCount || 0) === 0) {
      wx.showToast({ title: '这只猫还没有照片，先去档案里添加', icon: 'none' })
      return
    }
    this.setData({ indexingId: id })
    let hint = ''
    try {
      const r = await app.callApi('indexOneCat', { catIds: [id] })
      if (r && r.ok && Number(r.built) > 0) {
        hint = '已录入'
      } else if (r && r.ok) {
        // 服务端/云端给出的**具体**原因（比以前那句「请稍后重试」有用得多）
        hint = indexFailText(r, id)
      } else {
        hint = (r && r.msg) || '录入失败'
      }
    } catch (err) {
      // -504003：客户端 3s 预算先到，云端可能仍在建库 —— 不当失败，交给复核
      const msg = String((err && err.message) || '')
      hint = /504003|超时|timeout/i.test(msg) ? '' : (msg || '录入失败')
    }
    // 复核最多三轮（每轮等 700ms 再拉状态）：单个任务的建库通常 1~3s 完成
    const indexed = await this.confirmIndexed(id, hint ? 1 : 3)
    this.setData({ indexingId: '' })
    const tip = indexed ? '已录入' : (hint || '已提交，稍后点「刷新」核对')
    // 长文案必须走 modal：toast 只显示 7~14 个字，「服务端下载照片失败（2/2 张）…」
    // 会被截断成「服务端下载照片失…」，等于又回到「看不出原因」。
    if (!indexed && tip.length > 12) {
      wx.showModal({ title: '录入未成功', content: tip, showCancel: false, confirmText: '知道了' })
      return
    }
    wx.showToast({ title: tip, icon: indexed ? 'success' : 'none' })
  },

  /**
   * 复核某只猫是否真的进了特征库：重拉一次 indexStatus，看它还不在「未录入」清单里。
   * @param {string} id 猫 id
   * @param {number} rounds 最多核对几轮（每轮间隔 700ms）
   * @returns {Promise<boolean>}
   */
  async confirmIndexed(id, rounds) {
    for (let i = 0; i < Math.max(1, rounds); i++) {
      if (i) await new Promise(r => setTimeout(r, 700))
      await this.loadIndexStatus()
      const still = (this.data.indexStatus.cats || []).some(c => c.id === id)
      // source=error（读取失败）时不能断定「已录入」，继续下一轮或如实返回 false
      if (!still && this.data.indexStatus.source !== 'error') return true
    }
    return false
  },

  /* ==================== 确认样本库（人工确认 → 特征库） ==================== */
  /**
   * 说明：样本 = 用户识别后点了「确认」的那张照片。
   * 它值得入库，是因为**分布**对得上：档案照是管理员摆拍的正脸，
   * 而用户识别时拍的是远处 / 侧身 / 逆光 —— 查询照和档案照不同分布，
   * 才是「明明是同一只却只有 68%」的主因。
   * 但「用户点了确认」不等于可信，所以入库必须经管理员之手（见云端三道闸）。
   */

  /**
   * 拉样本列表。
   *
   * 云端的 `usable` 判定（低于匹配线 / 未归属 / 已排除 / 降级 / 名额满）
   * 已经在 listSamples 里算好，这里只负责**把文案拼成可直接渲染的字符串**：
   * WXML 的 mustache 不做字符串拼接与比较，写在模板里会被静默忽略。
   */
  async loadSamples() {
    if (this.data.sampleLoading) return
    this.setData({ sampleLoading: true })
    try {
      const r = await app.callApi('listSamples', { limit: 60 })
      if (!r || r.ok === false) throw new Error((r && r.msg) || '读取失败')

      let used = 0
      let ignored = 0
      let unassigned = 0
      const groups = (r.groups || []).map(g => {
        const items = (g.items || []).map(s => {
          if (s.state === 'used') used++
          if (s.state === 'ignored') ignored++
          if (!s.catId) unassigned++
          const bits = [s.scoreText]
          if (s.rawText) bits.push('原始 ' + s.rawText)
          bits.push(s.typeText)
          bits.push(fromNow(s.createdAt) || '时间未知')
          // 判成了谁：只有与最终确认不同才值得显示（否则是废话）
          if (s.predictedName && s.predictedName !== s.catName) {
            bits.push('原判「' + s.predictedName + '」')
          }
          return Object.assign({}, s, {
            metaText: bits.join(' · '),
            // 「为什么这条用不了」优先于状态：管理员要看的是阻碍原因
            noteText: s.usable ? s.stateText : (s.blockText || s.stateText),
            ignoreText: s.state === 'ignored' ? '恢复' : '排除'
          })
        })
        // countText / canBuild 由云端算好（模板里不做过滤与比较）
        return Object.assign({}, g, { items: items })
      })

      this.setData({
        sampleStat: {
          total: Number(r.total) || 0,
          usable: Number(r.usable) || 0,
          fresh: Number(r.fresh) || 0,
          used: used,
          ignored: ignored,
          unassigned: unassigned,
          perCat: Number(r.perCat) || 3,
          minScore: Number(r.minScore) || 45,
          viewCap: Number(r.viewCap) || 8
        },
        sampleGroups: groups,
        sampleError: ''
      })

      // 「指定猫」下拉按需加载：没有未归属样本时不必多打一次接口
      if (unassigned && !this._catOptionsLoaded) this.loadCatOptions()
    } catch (e) {
      console.warn('[admin] 确认样本读取失败', e && e.message)
      this.setData({ sampleGroups: [], sampleError: (e && e.message) || '读取失败' })
    } finally {
      this.setData({ sampleLoading: false })
    }
  },

  /**
   * 拉「指定猫」下拉的候选档案。
   *
   * 失败不提示：这只是给未归属样本兜底的可选能力，
   * 加载不出来就让「指定猫」按钮不可用，不该打断整页。
   */
  async loadCatOptions() {
    this._catOptionsLoaded = true
    try {
      const r = await app.callApi('listCats', { size: 50 })
      const list = (r && r.list) || []
      this.setData({
        catOptions: list.map(c => ({ id: c._id, name: c.name || '未命名' })),
        catNames: list.map(c => c.name || '未命名')
      })
    } catch (e) {
      console.warn('[admin] 猫档案候选读取失败', e && e.message)
    }
  },

  /** 排除 / 恢复一条样本 */
  async toggleSample(e) {
    const id = (e.currentTarget.dataset || {}).id
    if (!id) return
    const row = this.findSample(id)
    const act = row && row.state === 'ignored' ? 'restore' : 'ignore'
    showBusy({ title: '处理中' })
    try {
      await app.callApi('updateSample', { id, act })
      await this.loadSamples()
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' })
    } finally {
      hideBusy()
    }
  },

  /** 删除一条样本（拍的根本不是猫 / 涉及隐私 / 误传） */
  async deleteSample(e) {
    const id = (e.currentTarget.dataset || {}).id
    if (!id) return
    const go = await new Promise(resolve => {
      wx.showModal({
        title: '删除这条样本',
        content: '删除后无法恢复，该照片也不会再参与特征库建设。',
        confirmText: '删除',
        success: resolve
      })
    })
    if (!go.confirm) return
    showBusy({ title: '删除中' })
    try {
      await app.callApi('deleteSample', { id })
      await this.loadSamples()
      wx.showToast({ title: '已删除', icon: 'none' })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '删除失败', icon: 'none' })
    } finally {
      hideBusy()
    }
  },

  /** 给「未归属」的样本指定猫（用户点了「不是这只猫」，但管理员认得出来） */
  async assignSample(e) {
    const ds = e.currentTarget.dataset || {}
    const id = ds.id
    const idx = Number((e.detail || {}).value)
    const opt = this.data.catOptions[idx]
    if (!id || !opt) return
    showBusy({ title: '指定中' })
    try {
      await app.callApi('updateSample', { id, act: 'assign', catId: opt.id })
      await this.loadSamples()
      wx.showToast({ title: '已指定为「' + opt.name + '」', icon: 'none' })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '指定失败', icon: 'none' })
    } finally {
      hideBusy()
    }
  },

  /**
   * 用确认样本建特征库（可整批，也可单只猫）。
   *
   * 分批的原因写在云端 buildIndexFromSamples：一次建完必然撞云函数超时，
   * 而撞超时是「一只都没建成」。这里按 remaining 接着点，最多 8 轮。
   */
  async buildFromSamples(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const catId = ds.catid || ''
    if (this.data.sampleBuilding) return
    const st = this.data.sampleStat || {}
    const group = catId ? (this.data.sampleGroups.filter(g => g.catId === catId)[0] || null) : null
    // 整批只看「没入库过的」（否则每轮都从头开始，永远建不完）；
    // 单只重算时把已入库的也算上 —— 管理员点它就是要重算。
    const n = catId
      ? (group ? group.items.filter(i => i.usable).length : 0)
      : (Number(st.fresh) || Number(st.usable) || 0)
    if (!n) {
      wx.showToast({ title: '没有可用样本', icon: 'none' })
      return
    }
    const includeUsed = !catId && !Number(st.fresh) && Number(st.usable) > 0
    const tip = catId
      ? '将把「' + (group.catName || '该猫') + '」的 ' + n + ' 条确认样本并入其档案照，重新计算代表向量。'
      : '将把 ' + n + ' 条' + (includeUsed ? '（已入库，本次全部重算）' : '新增') +
        '样本并入对应猫的特征库（每只猫最多 ' + st.perCat + ' 张，总计不超过 ' +
        st.viewCap + ' 张视图）。建库过程约需几十秒，请勿离开。'
    const go = await new Promise(resolve => {
      wx.showModal({
        title: includeUsed ? '重新并入全部样本' : '用确认样本建库',
        content: tip, confirmText: '开始建库', success: resolve
      })
    })
    if (!go.confirm) return

    this.setData({ sampleBuilding: true, sampleBuildingId: catId, sampleResult: '' })
    let built = 0
    let rounds = 0
    let msg = ''
    try {
      while (rounds < 8) {
        rounds++
        showBusy({ title: built ? ('已建 ' + built + ' 只…') : '建库中' })
        const payload = catId ? { catIds: [catId] } : {}
        if (includeUsed) payload.includeUsed = true
        const r = await app.callApi('buildIndexFromSamples', payload)
        built += Number(r && r.built) || 0
        const remaining = Number(r && r.remaining) || 0
        if (r && r.msg) msg = r.msg
        hideBusy()
        if (catId || !remaining) break
      }
    } catch (err) {
      hideBusy()
      msg = (err && err.message) || '建库失败'
    }
    this.setData({ sampleBuilding: false, sampleBuildingId: '' })
    // 结论只认服务端真实结果：建完立刻重拉样本与特征库状态
    await Promise.all([this.loadSamples(), this.loadIndexStatus()])
    const tail = built
      ? ('已并入 ' + built + ' 只猫的特征库')
      : (msg || '本次没有建成，可稍后重试')
    this.setData({ sampleResult: tail })
    if (!built) {
      wx.showModal({ title: '建库未成功', content: tail, showCancel: false, confirmText: '知道了' })
    } else {
      wx.showToast({ title: '已建 ' + built + ' 只', icon: 'success' })
    }
  },

  /** 在已加载的分组里找一条样本（dataset 只带得动 id） */
  findSample(id) {
    const groups = this.data.sampleGroups || []
    for (let i = 0; i < groups.length; i++) {
      const hit = (groups[i].items || []).filter(s => s.id === id)[0]
      if (hit) return hit
    }
    return null
  },

  /**
   * 审核建校申请。
   *
   * 通过 = 真的建一所学校（默认地图中心落在系统默认坐标，之后可在「我的 → 学校」调范围），
   * 并把申请人绑上去。所以按钮文案用「通过并建校」，避免管理员以为只是打勾。
   */
  async handleSchoolApply(e) {
    const ds = e.currentTarget.dataset || {}
    const id = ds.id
    // dataset 里拿到的是字符串，'0' 也是真值 —— 必须显式比较，
    // 否则「驳回」会被当成「通过」建出一所学校（这种错误不可回滚）
    const approve = String(ds.approve) === '1'
    if (!id || this.data.handlingApplyId) return
    const row = (this.data.schoolApplies || []).filter(a => a._id === id)[0] || {}
    const isJoin = row.type === 'join'
    const tip = approve
      ? (isJoin
        ? '将通过「' + (row.fullName || '该校') + '」的入校申请，申请人会自动绑定到该校。'
        : '将通过「' + (row.fullName || '该学校') + '」并立即建校，申请人会自动绑定。')
      : '将驳回「' + (row.fullName || '该学校') + '」的申请。'
    const go = await new Promise(resolve => {
      wx.showModal({ title: approve ? '通过申请' : '驳回申请', content: tip, success: resolve })
    })
    if (!go.confirm) return

    this.setData({ handlingApplyId: id })
    showBusy({ title: approve ? (isJoin ? '处理中' : '建校中') : '处理中' })
    try {
      await app.callApi('handleSchoolApply', { id, approve })
      wx.showToast({ title: approve ? (isJoin ? '已通过·已加入' : '已建校') : '已驳回', icon: 'none' })
      await this.load()
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' })
    } finally {
      this.setData({ handlingApplyId: '' })
      hideBusy()
    }
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
        budgetMs: 10000, photosPerCat: 5, force: picked
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
      this.loadIndexStatus()   // 建完立刻刷新「已录入 / 未录入」计数
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
