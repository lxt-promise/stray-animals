/**
 * 确认样本库回归（2026-10-24「用人工确认的数据建特征库」）
 *
 * 背景：用户「识别 → 点确认」的样本过去只写进 ai_samples 攒训练集，从不参与建库。
 * 现在要在管理后台把它们并入特征库 —— 因为样本的分布（远处 / 侧身 / 逆光）
 * 正是档案照补不上的那一半，而查询照恰恰是这个分布。
 *
 * 断言打在**意图**上，不锁实现细节：
 *   ① 阈值：总视图上限 8、自动路径 5（省预算）、每猫样本 3、门槛 = 匹配线 45；
 *   ② 三道闸：低于匹配线 / 降级（provider=local）/ 未归属 / 视频无封面 / 已排除，一律不采信；
 *   ③ 名额与去重：每猫最多 3 张、同猫同图只算一次、高分优先占位；
 *   ④ 建库是「档案照 + 样本合并去重」而不是只送样本（只送样本会把正脸特征整块丢掉）；
 *   ⑤ 分批：一次最多 3 只猫并返回 remaining（撞云函数超时 = 一只都没建成）；
 *   ⑥ 记账：只把**真的建成**的猫的样本标 used（建失败的下一轮还会带上）。
 *
 * 运行：node scripts/test_sample_index.js
 */
const Module = require('module')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

/* ==================== 内存数据库桩 ==================== */
const store = {}
let autoId = 0
const nextId = () => 'doc_' + (++autoId)

const op = (kind, v) => ({ __op: kind, v })
const _cmd = {
  inc: n => op('inc', n),
  push: arr => op('push', arr),
  remove: () => op('remove'),
  exists: v => op('exists', v),
  nin: arr => op('nin', arr),
  in: arr => op('in', arr),
  gt: v => op('gt', v),
  or: arr => op('or', arr)
}

function matchCond(doc, cond) {
  if (cond && cond.__op === 'or') return (cond.v || []).some(sub => matchCond(doc, sub))
  return Object.keys(cond).every(k => {
    const want = cond[k]
    const got = doc[k]
    if (want && want.__op) {
      switch (want.__op) {
        case 'in': return (want.v || []).includes(got)
        case 'nin': return !(want.v || []).includes(got)
        case 'gt': return got > want.v
        case 'exists': return want.v ? got !== undefined : got === undefined
        default: return true
      }
    }
    if (k === '_id') return got === want
    return got === want
  })
}

function applyUpdate(doc, data) {
  Object.keys(data).forEach(k => {
    const v = data[k]
    if (v && v.__op === 'push') doc[k] = (doc[k] || []).concat(v.v)
    else doc[k] = v
  })
}

function makeQuery(col) {
  const list = () => (store[col] = store[col] || [])
  const q = {
    _filters: [], _order: null, _limit: 1e9, _skip: 0,
    where(c) { this._filters.push(c); return this },
    orderBy(f, d) { this._order = { f, d }; return this },
    limit(n) { this._limit = n; return this },
    skip(n) { this._skip = n; return this },
    field() { return this },
    async get() {
      let rows = list().filter(d => this._filters.every(f => matchCond(d, f)))
      if (this._order) {
        const { f, d } = this._order
        rows.sort((a, b) => (d === 'desc' ? (b[f] > a[f] ? 1 : -1) : (a[f] > b[f] ? 1 : -1)))
      }
      return { data: JSON.parse(JSON.stringify(rows.slice(this._skip, this._skip + this._limit))) }
    },
    async count() { return { total: list().filter(d => this._filters.every(f => matchCond(d, f))).length } },
    async update({ data }) {
      const rows = list().filter(d => this._filters.every(f => matchCond(d, f)))
      rows.forEach(d => applyUpdate(d, data))
      return { stats: { updated: rows.length } }
    },
    async remove() {
      const rows = list().filter(d => this._filters.every(f => matchCond(d, f)))
      store[col] = list().filter(d => rows.indexOf(d) < 0)
      return { stats: { removed: rows.length } }
    },
    doc(id) { return makeDoc(col, id) },
    async add({ data }) {
      const doc = Object.assign({}, data)
      if (!doc._id) doc._id = nextId()
      list().push(doc)
      return { _id: doc._id }
    }
  }
  return q
}

function makeDoc(col, id) {
  const list = () => (store[col] = store[col] || [])
  return {
    async get() {
      const d = list().find(x => x._id === id)
      return { data: d ? JSON.parse(JSON.stringify(d)) : null }
    },
    async update({ data }) {
      const d = list().find(x => x._id === id)
      if (!d) throw new Error('doc not found: ' + id)
      applyUpdate(d, data)
      return { stats: { updated: 1 } }
    },
    async remove() {
      store[col] = list().filter(x => x._id !== id)
      return { stats: { removed: 1 } }
    }
  }
}

const fakeDb = {
  collection: col => makeQuery(col),
  command: _cmd,
  RegExp: ({ regexp, options }) => ({ __regexp: regexp, __options: options }),
  async createCollection(name) { store[name] = store[name] || []; return true }
}

/* ==================== 云存储 / HTTP 桩 ==================== */
const HOST = 'bucket.tcb.qcloud.la'
const tempOf = fid => 'https://' + HOST + '/signed?f=' + encodeURIComponent(fid)

const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test',
  init() {},
  database: () => fakeDb,
  getWXContext: () => ({ OPENID: 'u1' }),
  async getTempFileURL({ fileList }) {
    return {
      fileList: fileList.map(f => (/__gone__/.test(f)
        ? { fileID: f, tempFileURL: '', status: -1 }
        : { fileID: f, tempFileURL: tempOf(f), status: 0 }))
    }
  }
}

// 记录每一次发给识别服务的建库请求，用于断言「发了什么」
let httpCalls = []
let httpReply = () => ({ ok: true, built: 0, failed: [], skipped: 0, reasons: {}, total: 0 })
const fakeHttp = {
  request(opts, cb) {
    const rec = { url: opts.hostname + opts.path, body: '' }
    httpCalls.push(rec)
    const req = {
      on() { return this },
      write(c) { rec.body += c },
      setTimeout() {},
      destroy() {},
      end() {
        const payload = JSON.stringify(httpReply(JSON.parse(rec.body)))
        const res = {
          statusCode: 200,
          on(ev, fn) {
            if (ev === 'data') fn(payload)
            if (ev === 'end') fn()
          }
        }
        cb(res)
      }
    }
    return req
  }
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return fakeCloud
  if (request === 'https' || request === 'http') return fakeHttp
  // 积分与本测试无关，桩掉即可（只需保证 grantPoint 不抛）
  if (request === './points') {
    return { grantPoint: async () => ({ gained: 0 }), grantFood: async () => ({ gained: 0 }) }
  }
  return origLoad.apply(this, arguments)
}

// 建库要推导 endpoint（必须是以 /v1/recognize 结尾的地址，见 buildIndexFromSamples）
process.env.AI_ENDPOINT = 'https://vision.example.com/v1/recognize'

const V = require(path.join(ROOT, 'cloudfunctions', 'catcampus', 'lib', 'vision.js'))
const {
  planSampleBuild, sampleMediaId, listSamples, updateSample, deleteSample,
  buildIndexFromSamples, confirm,
  INDEX_PHOTOS, INDEX_PHOTOS_AUTO, SAMPLE_PHOTOS_PER_CAT, SAMPLE_MIN_SCORE,
  SAMPLE_BUILD_CATS, LOW_CONF, BLOCK_TEXT
} = V

/* ==================== 断言 ==================== */
let pass = 0
let fail = 0
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')) }
}

const CAT_A = 'cat_a'
const CAT_B = 'cat_b'
const fid = n => 'cloud://env.bucket/samples/' + n + '.jpg'
const ADMIN = { openid: 'u1', _id: 'u1', schoolId: 'sch1' }

let seq = 0
function sample(o) {
  seq++
  return Object.assign({
    _id: 's' + seq, schoolId: 'sch1', type: 'image', fileId: fid('x' + seq),
    confirmedCatId: '', predictedCatId: '', score: 80, rawSim: 0.76,
    provider: 'onnx', state: 'new', correct: true, createdAt: new Date()
  }, o)
}

function reset() {
  store['ai_samples'] = []
  store['cats'] = []
  store['ai_tasks'] = []
  httpCalls = []
  httpReply = () => ({ ok: true, built: 0, failed: [], skipped: 0, reasons: {}, total: 0 })
}

async function main() {
  /* ==================== 1. 阈值 ==================== */
  console.log('\n=== 1. 阈值（单只猫视图上限 / 每猫样本数 / 分数门槛） ===')
  assert('总视图上限 INDEX_PHOTOS = 8', INDEX_PHOTOS === 8, INDEX_PHOTOS)
  assert('自动入库更省（< 总上限，2.2s 预算带不动 8 张）',
    INDEX_PHOTOS_AUTO < INDEX_PHOTOS, [INDEX_PHOTOS_AUTO, INDEX_PHOTOS])
  assert('每猫样本上限 = 3（样本是补充，主体仍是档案照）',
    SAMPLE_PHOTOS_PER_CAT === 3, SAMPLE_PHOTOS_PER_CAT)
  assert('分数门槛 = 匹配线（低于匹配线的确认不予采信）',
    SAMPLE_MIN_SCORE === LOW_CONF && SAMPLE_MIN_SCORE > 0, [SAMPLE_MIN_SCORE, LOW_CONF])
  assert('每只猫 ≤3 张样本时不会突破总视图上限', SAMPLE_PHOTOS_PER_CAT <= INDEX_PHOTOS)

  /* ==================== 2. 三道闸 ==================== */
  console.log('\n=== 2. 不采信的样本（每一类都有原因码 + 人话文案） ===')
  reset()
  {
    const s = [
      sample({ confirmedCatId: CAT_A, score: 44 }),                              // 低于匹配线
      sample({ confirmedCatId: CAT_A, score: 90, provider: 'local' }),           // 降级，分数是假的
      sample({ confirmedCatId: '', score: 90 }),                                 // 未归属
      sample({ confirmedCatId: CAT_A, score: 90, type: 'video', thumbId: '' }),  // 视频无封面
      sample({ confirmedCatId: CAT_A, score: 90, state: 'ignored' }),            // 管理员排除
      sample({ confirmedCatId: CAT_A, score: 90 })                               // 唯一可用
    ]
    const p = planSampleBuild(s, {})
    assert('只有 1 条通过', p.picked.length === 1, p.picked)
    const codes = Object.keys(p.reasons).map(k => p.reasons[k])
    assert('五类原因码齐全', ['degraded', 'ignored', 'lowScore', 'noMedia', 'unassigned']
      .every(c => codes.indexOf(c) >= 0), codes)
    assert('每个原因都有人话文案',
      ['lowScore', 'degraded', 'unassigned', 'noMedia', 'ignored'].every(c => !!BLOCK_TEXT[c]))
    assert('被排除的都带 id（后台要能定位到行）',
      p.excluded.length === 5 && p.excluded.every(e => e.id && e.reason))
  }
  {
    const p = planSampleBuild([sample({ confirmedCatId: CAT_A, score: SAMPLE_MIN_SCORE })], {})
    assert('正好压线（' + SAMPLE_MIN_SCORE + ' 分）予以采信', p.picked.length === 1)
    const v = planSampleBuild([sample({ confirmedCatId: CAT_A, type: 'video', thumbId: fid('cover') })], {})
    assert('视频有封面即可用', v.picked.length === 1 && v.picked[0].fileId === fid('cover'))
    assert('sampleMediaId 对视频只取封面',
      sampleMediaId({ type: 'video', fileId: 'v', thumbId: 't' }) === 't')
  }

  /* ==================== 3. 名额 / 去重 / 排序 ==================== */
  console.log('\n=== 3. 名额、去重与优先级 ===')
  {
    const s = []
    for (let i = 0; i < 6; i++) s.push(sample({ confirmedCatId: CAT_A, score: 50 + i, fileId: fid('a' + i) }))
    const p = planSampleBuild(s, {})
    assert('每猫最多 ' + SAMPLE_PHOTOS_PER_CAT + ' 张', p.picked.length === SAMPLE_PHOTOS_PER_CAT, p.picked.length)
    assert('高分优先占位（取 55/54/53）',
      p.picked.map(x => x.score).join(',') === '55,54,53', p.picked.map(x => x.score))
    assert('超额的记为 quota', p.excluded.filter(e => e.reason === 'quota').length === 3, p.excluded)
    assert('catIds 去重后只剩 1 只', p.catIds.length === 1 && p.catIds[0] === CAT_A)
  }
  {
    const same = fid('dup')
    const p = planSampleBuild([
      sample({ confirmedCatId: CAT_A, fileId: same, score: 80 }),
      sample({ confirmedCatId: CAT_A, fileId: same, score: 78 }),
      sample({ confirmedCatId: CAT_B, fileId: same, score: 79 })
    ], {})
    assert('同猫同图只算一次', p.picked.length === 2, p.picked)
    assert('不同猫不算重复（判给谁是管理员的事）',
      p.picked.filter(x => x.catId === CAT_B).length === 1)
  }
  {
    const p = planSampleBuild([
      sample({ confirmedCatId: CAT_A, state: 'used', score: 80 }),
      sample({ confirmedCatId: CAT_A, score: 70 })
    ], {})
    assert('已入库的样本仍可用（特征库被整体重建后能补回来）', p.picked.length === 2)
    assert('但会区分「新增」条数', p.fresh === 1, p.fresh)
    const ig = planSampleBuild([sample({ confirmedCatId: CAT_A, state: 'ignored' })], { allowIgnored: true })
    assert('管理员显式指定时排除项也能纳入', ig.picked.length === 1)
  }

  /* ==================== 4. confirm 落库字段 ==================== */
  console.log('\n=== 4. 确认时把匹配分一起存下来（没分就没法做门槛） ===')
  reset()
  store['cats'].push({ _id: CAT_A, name: '奶牛', schoolId: 'sch1' })
  store['ai_tasks'].push({
    _id: 'task1', openid: 'u1', schoolId: 'sch1', type: 'image',
    fileId: fid('q'), thumbId: '', confirmed: false,
    result: { provider: 'onnx', candidates: [{ catId: CAT_A, score: 82, rawSim: 0.763 }] }
  })
  await confirm({ openid: 'u1', _id: 'u1', catSeen: [] }, { taskId: 'task1', catId: CAT_A, correct: true })
  {
    const doc = store['ai_samples'][0]
    assert('样本已落库', !!doc)
    assert('存了 score', Number(doc.score) === 82, doc.score)
    assert('存了 rawSim', Number(doc.rawSim) === 0.763, doc.rawSim)
    assert('初始状态 new', doc.state === 'new', doc.state)
    assert('存了 thumbId（视频任务靠它建库）', 'thumbId' in doc)
    assert('归属猫已记录', doc.confirmedCatId === CAT_A)
  }

  /* ==================== 5. 后台列表 ==================== */
  console.log('\n=== 5. 后台列表：按猫分组 + 「为什么用不了」 ===')
  reset()
  store['cats'].push(
    { _id: CAT_A, name: '奶牛', schoolId: 'sch1' },
    { _id: CAT_B, name: '橘猫', schoolId: 'sch1' }
  )
  store['ai_samples'].push(
    sample({ _id: 'sa1', confirmedCatId: CAT_A, score: 82, fileId: fid('p1') }),
    sample({ _id: 'sa2', confirmedCatId: CAT_A, score: 30, fileId: fid('p2') }),
    sample({ _id: 'sa3', confirmedCatId: 'cat_gone', score: 90, fileId: fid('p3') }),
    sample({ _id: 'sa4', confirmedCatId: '', predictedCatId: CAT_A, score: 88, fileId: fid('p4') })
  )
  {
    const r = await listSamples(ADMIN, { limit: 60 })
    assert('返回 4 条', r.shown === 4, r.shown)
    assert('可用 2 条（一条压线、一条档案已删的算可用但会建失败）',
      r.usable === 2, r.usable)
    assert('猫名已联表', r.groups.some(g => g.catName === '奶牛'))
    assert('档案已删的猫标出来（不是直接显示空名）',
      r.groups.some(g => g.catId === 'cat_gone' && g.catName === '（档案已删除）'),
      r.groups.map(g => g.catName))
    assert('未归属单独成组', r.groups.some(g => !g.catId && g.items.length === 1))
    const all = r.groups.reduce((a, g) => a.concat(g.items), [])
    const low = all.filter(x => x.id === 'sa2')[0]
    assert('低于门槛的给了原因文案', low && !low.usable && !!low.blockText, low)
    assert('缩略图已换 https', all.filter(x => x.id === 'sa1')[0].thumb.indexOf('https://') === 0)
    assert('后台拿到了阈值（界面要显示）', r.perCat === 3 && r.minScore === 45 && r.viewCap === 8)
  }

  /* ==================== 6. 管理记录 ==================== */
  console.log('\n=== 6. 管理：排除 / 恢复 / 指定归属 / 删除 ===')
  {
    await updateSample(ADMIN, { id: 'sa1', act: 'ignore' })
    assert('排除生效', store['ai_samples'].filter(s => s._id === 'sa1')[0].state === 'ignored')
    await updateSample(ADMIN, { id: 'sa1', act: 'restore' })
    assert('恢复生效', store['ai_samples'].filter(s => s._id === 'sa1')[0].state === 'new')

    let err = ''
    try { await updateSample(ADMIN, { id: 'sa4', act: 'assign', catId: 'no_such_cat' }) }
    catch (e) { err = e.message }
    assert('指定到不存在的档案要报错', /不存在/.test(err), err)

    await updateSample(ADMIN, { id: 'sa4', act: 'assign', catId: CAT_B })
    const s4 = store['ai_samples'].filter(s => s._id === 'sa4')[0]
    assert('指定归属生效', s4.confirmedCatId === CAT_B)
    assert('指定后 correct 同步为真（否则仍被判未归属）', s4.correct === true)
    assert('指定后回到待用', s4.state === 'new')

    await deleteSample(ADMIN, { id: 'sa2' })
    assert('删除生效', !store['ai_samples'].some(s => s._id === 'sa2'))
  }

  /* ==================== 7. 建库：合并 + 分批 + 记账 ==================== */
  console.log('\n=== 7. 建库：档案照 + 样本合并、分批、只记建成的 ===')
  reset()
  // 奶牛猫：2 张档案照 + 2 条样本
  store['cats'].push({
    _id: CAT_A, name: '奶牛', schoolId: 'sch1', pattern: 'cow', color: 'cow',
    photos: [fid('prof1'), fid('prof2')], avatar: fid('prof1')
  })
  store['ai_samples'].push(
    sample({ _id: 'sb1', confirmedCatId: CAT_A, score: 82, fileId: fid('shot1') }),
    sample({ _id: 'sb2', confirmedCatId: CAT_A, score: 70, fileId: fid('shot2') })
  )
  {
    // 服务端回「全部建成」
    httpReply = req => ({ ok: true, built: req.cats.length, failed: [], skipped: 0, reasons: {}, total: 1 })
    const r = await buildIndexFromSamples(ADMIN, {})
    assert('建成 1 只', r.built === 1, r)
    const sent = JSON.parse(httpCalls[0].body)
    assert('走的是 /v1/index/build', /\/v1\/index\/build$/.test(httpCalls[0].url), httpCalls[0].url)
    assert('force=true（视图集合变了必须重算，否则被静默跳过）', sent.force === true)
    const photos = sent.cats[0].photos
    assert('档案照 + 样本合并后共 4 张', photos.length === 4, photos)
    assert('档案照在前（正脸是主体）',
      photos[0].indexOf('prof1') > 0 && photos[1].indexOf('prof2') > 0, photos)
    assert('样本在后补充', photos[2].indexOf('shot1') > 0 && photos[3].indexOf('shot2') > 0, photos)
    assert('全部是 https（服务端拿不到 cloud://）',
      photos.every(p => p.indexOf('https://') === 0))
    assert('样本已标记 used',
      store['ai_samples'].filter(s => s._id === 'sb1')[0].state === 'used')
    assert('猫已标记入库（记账）', !!store['cats'].filter(c => c._id === CAT_A)[0].aiIndexAt)
  }
  {
    // 重复照片：样本与档案照是同一张 → 不能重复计入
    reset()
    store['cats'].push({
      _id: CAT_A, name: '奶牛', schoolId: 'sch1',
      photos: [fid('same')], avatar: fid('same')
    })
    store['ai_samples'].push(sample({ _id: 'sc1', confirmedCatId: CAT_A, score: 82, fileId: fid('same') }))
    httpReply = req => ({ ok: true, built: req.cats.length, failed: [], skipped: 0, reasons: {}, total: 1 })
    await buildIndexFromSamples(ADMIN, {})
    const sent = JSON.parse(httpCalls[0].body)
    assert('同图只送一次（档案照与样本重复）', sent.cats[0].photos.length === 1, sent.cats[0].photos)
  }
  {
    // 视图上限：10 张档案照 + 3 条样本 → 截断到 8
    reset()
    const many = []
    for (let i = 0; i < 10; i++) many.push(fid('m' + i))
    store['cats'].push({ _id: CAT_A, name: '奶牛', schoolId: 'sch1', photos: many, avatar: many[0] })
    store['ai_samples'].push(sample({ _id: 'sd1', confirmedCatId: CAT_A, score: 82, fileId: fid('s1') }))
    httpReply = req => ({ ok: true, built: req.cats.length, failed: [], skipped: 0, reasons: {}, total: 1 })
    await buildIndexFromSamples(ADMIN, {})
    const sent = JSON.parse(httpCalls[0].body)
    assert('总数截断到 ' + INDEX_PHOTOS + ' 张', sent.cats[0].photos.length === INDEX_PHOTOS,
      sent.cats[0].photos.length)
    assert('photosPerCat 与视图数一致', sent.photosPerCat === INDEX_PHOTOS)
  }
  {
    // 分批：5 只猫 → 一次最多 3 只，返回 remaining
    reset()
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5']
    ids.forEach(id => store['cats'].push({ _id: id, name: id, schoolId: 'sch1', photos: [fid(id)] }))
    store['ai_samples'] = ids.map(id => sample({ confirmedCatId: id, score: 80, fileId: fid('s_' + id) }))
    httpReply = req => ({ ok: true, built: req.cats.length, failed: [], skipped: 0, reasons: {}, total: 5 })
    const r1 = await buildIndexFromSamples(ADMIN, {})
    assert('一次最多建 ' + SAMPLE_BUILD_CATS + ' 只（撞超时等于一只都没建成）',
      r1.built === SAMPLE_BUILD_CATS, r1.built)
    assert('返回 remaining 让前台接着点', r1.remaining === 2, r1.remaining)
    const r2 = await buildIndexFromSamples(ADMIN, {})
    assert('第二轮建完剩下的 2 只', r2.built === 2 && r2.remaining === 0, r2)
    const r3 = await buildIndexFromSamples(ADMIN, {})
    assert('全部完成后不再重复建（已入库的样本默认跳过）', r3.built === 0, r3)
    const r4 = await buildIndexFromSamples(ADMIN, { catIds: ['c1'] })
    assert('手动指定某只猫时把已入库的也算上（点的就是重算）', r4.built === 1, r4)
  }
  {
    // 部分失败：只有真建成的猫的样本被标 used
    reset()
    store['cats'].push({ _id: CAT_A, name: '奶牛', schoolId: 'sch1', photos: [fid('a1')] })
    store['cats'].push({ _id: CAT_B, name: '橘猫', schoolId: 'sch1', photos: [fid('b1')] })
    store['ai_samples'].push(
      sample({ _id: 'se1', confirmedCatId: CAT_A, score: 82, fileId: fid('sa') }),
      sample({ _id: 'se2', confirmedCatId: CAT_B, score: 82, fileId: fid('sb') })
    )
    httpReply = req => ({ ok: true, built: 1, failed: [CAT_B], skipped: 0, reasons: { [CAT_B]: 'noPhoto' }, total: 1 })
    const r = await buildIndexFromSamples(ADMIN, {})
    assert('只报建成 1 只', r.built === 1, r)
    assert('失败猫的原因透传到前台', r.reasons[CAT_B] === 'noPhoto', r.reasons)
    assert('建成猫的样本标 used',
      store['ai_samples'].filter(s => s._id === 'se1')[0].state === 'used')
    assert('失败猫的样本保持 new（下一轮还会带上）',
      store['ai_samples'].filter(s => s._id === 'se2')[0].state === 'new')
  }
  {
    // 没有可用样本时要说清原因，而不是「建了 0 只」
    reset()
    store['ai_samples'].push(sample({ confirmedCatId: CAT_A, score: 10 }))
    const r = await buildIndexFromSamples(ADMIN, {})
    assert('无可用样本时给出解释而不是静默 0', r.built === 0 && /门槛|低于|排除/.test(r.msg || ''), r.msg)
    assert('没有可用样本时不发请求', httpCalls.length === 0)
  }

  console.log('\nPASS ' + pass + ' / FAIL ' + fail)
  process.exit(fail ? 1 : 0)
}

main().catch(e => {
  console.error('\n脚本异常：', e)
  process.exit(1)
})
