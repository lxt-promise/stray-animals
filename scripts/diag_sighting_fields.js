/**
 * 诊断：sightings 里 schoolId / nickName 到底写进去了什么
 *
 * 用户报：sightings 集合里 schoolId 都是空，nickName 都是「爱猫同学」。
 * 本脚本**真跑** addSighting（用内存库桩替代 wx-server-sdk），把落库文档整个打出来，
 * 用事实回答「是代码没写，还是数据本身没有」。
 *
 * 运行：node scripts/diag_sighting_fields.js
 */
const Module = require('module')
const path = require('path')

/* ============ 内存数据库桩（与 _cf_test.cjs 同款，精简版） ============ */
const store = {}
let autoId = 0
const nextId = () => 'doc_' + (++autoId)
const op = (kind, v) => ({ __op: kind, v })
const _cmd = {
  inc: n => op('inc', n), push: a => op('push', a), remove: () => op('remove'),
  exists: v => op('exists', v), nin: a => op('nin', a), in: a => op('in', a),
  gte: v => op('gte', v), lte: v => op('lte', v), lt: v => op('lt', v),
  gt: v => op('gt', v), neq: v => op('neq', v), or: a => op('or', a)
}

function matchCond(doc, cond) {
  if (cond && cond.__op === 'or') return (cond.v || []).some(s => matchCond(doc, s))
  return Object.keys(cond).every(k => {
    const want = cond[k], got = doc[k]
    if (want && want.__op) {
      switch (want.__op) {
        case 'nin': return !(want.v || []).includes(got)
        case 'in': return (want.v || []).includes(got)
        case 'gte': return got >= want.v
        case 'lte': return got <= want.v
        case 'lt': return got < want.v
        case 'gt': return got > want.v
        case 'neq': return got !== undefined && got !== want.v
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
    if (v && v.__op === 'inc') doc[k] = (Number(doc[k]) || 0) + v.v
    else if (v && v.__op === 'push') doc[k] = (doc[k] || []).concat(v.v)
    else if (v && v.__op === 'remove') delete doc[k]
    else doc[k] = v
  })
}
function makeQuery(col) {
  const list = () => (store[col] = store[col] || [])
  const q = {
    _filters: [], _order: null, _limit: 1e9, _skip: 0, _field: null,
    where(c) { this._filters.push(c); return this },
    orderBy(f, d) { this._order = { f, d }; return this },
    limit(n) { this._limit = n; return this },
    skip(n) { this._skip = n; return this },
    field(p) { this._field = p; return this },
    _matched() {
      let rows = list().filter(d => this._filters.every(f => matchCond(d, f)))
      if (this._order) {
        const { f, d } = this._order
        rows.sort((a, b) => {
          const va = a[f] instanceof Date ? a[f].getTime() : a[f]
          const vb = b[f] instanceof Date ? b[f].getTime() : b[f]
          return d === 'desc' ? (vb > va ? 1 : -1) : (va > vb ? 1 : -1)
        })
      }
      return rows.slice(this._skip, this._skip + this._limit)
    },
    async get() {
      let rows = this._matched()
      if (this._field) {
        rows = rows.map(d => {
          const o = { _id: d._id }
          Object.keys(this._field).forEach(k => { if (this._field[k]) o[k] = d[k] })
          return o
        })
      }
      return { data: rows }
    },
    async count() { return { total: this._matched().length } },
    async add({ data }) { const d = Object.assign({}, data, { _id: nextId() }); list().push(d); return { _id: d._id } },
    async update({ data }) { this._matched().forEach(d => applyUpdate(d, data)); return { stats: { updated: this._matched().length } } },
    async remove() { const rows = this._matched(); rows.forEach(d => { const i = list().indexOf(d); if (i >= 0) list().splice(i, 1) }); return { stats: { removed: rows.length } } },
    doc(id) {
      const self = this
      return {
        async get() { return { data: list().find(d => d._id === id) || null } },
        async set({ data }) { const i = list().findIndex(d => d._id === id); if (i >= 0) list()[i] = Object.assign({ _id: id }, data); return { stats: { updated: 1 } } },
        async update({ data }) { const d = list().find(x => x._id === id); if (d) applyUpdate(d, data); return { stats: { updated: d ? 1 : 0 } } },
        async remove() { const i = list().findIndex(d => d._id === id); if (i >= 0) list().splice(i, 1); return { stats: { removed: 1 } } },
        where() { return self.where.apply(self, arguments) }
      }
    }
  }
  return q
}
const fakeDb = {
  collection: name => makeQuery(name),
  serverDate: () => new Date(),
  command: _cmd,
  async createCollection(name) { store[name] = store[name] || []; return true }
}
let currentOpenid = ''
const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'test',
  init() {},
  database: () => fakeDb,
  getWXContext: () => ({ OPENID: currentOpenid }),
  openapi: { security: {
    async msgSecCheck() { return { errCode: 0 } },
    async imgSecCheck() { return { errCode: 0 } },
    async mediaCheckAsync() { return { traceId: 't' } }
  } },
  async downloadFile() { return { fileContent: Buffer.from([1]) } },
  async getTempFileURL({ fileList }) {
    return { fileList: fileList.map(f => ({ fileID: f, tempFileURL: 'https://x/' + encodeURIComponent(f), status: 0 })) }
  }
}
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return fakeCloud
  return origLoad.apply(this, arguments)
}

const CF = path.resolve(__dirname, '..', 'cloudfunctions', 'catcampus', 'index.js')
process.env.SUPER_ADMIN_OPENIDS = 'u_admin'
const { main } = require(CF)
const as = (u, action, event) => { currentOpenid = u || ''; return main(Object.assign({ action }, event || {})) }

const show = (label, doc) => {
  console.log('\n' + label)
  Object.keys(doc).sort().forEach(k => {
    const v = doc[k]
    const s = v instanceof Date ? v.toISOString() : JSON.stringify(v)
    console.log('   ' + k.padEnd(16) + ' = ' + (s === undefined ? 'undefined' : s))
  })
}

async function run() {
  /* ---------- 场景 1：超管建校（自动绑定 schoolId）后打卡 ---------- */
  console.log('\n########## 场景 1：已绑定学校的用户打卡 ##########')
  let r = await as('u_admin', 'login', { nickName: '管理员' })
  console.log('login → nickName=' + JSON.stringify(r.data.nickName) + ' schoolId=' + JSON.stringify(r.data.schoolId))

  r = await as('u_admin', 'createSchool', { name: '东南大学', center: { lat: 32.0585, lng: 118.7965 } })
  const schoolId = r.data._id
  console.log('createSchool → ' + schoolId + '（建校会自动把创建者绑上去）')

  r = await as('u_admin', 'saveCat', {
    data: { name: '大橘', pattern: 'orange', schoolId, location: { lat: 32.0585, lng: 118.7965 } }
  })
  const catId = r.data._id

  await as('u_admin', 'addSighting', {
    data: { catId, location: { lat: 32.0590, lng: 118.7970 }, health: 'good', feedStatus: 'fed' }
  })
  const rows = store['sightings'] || []
  show('落库的 sighting 文档（用户已绑学校）:', rows[rows.length - 1])
  console.log('\n  >>> schoolId = ' + JSON.stringify(rows[rows.length - 1].schoolId))
  console.log('  >>> reporterName = ' + JSON.stringify(rows[rows.length - 1].reporterName))
  console.log('  >>> 有没有 nickName 字段? ' + ('nickName' in rows[rows.length - 1]))

  /* ---------- 场景 2：没绑定学校的用户打卡 ---------- */
  console.log('\n########## 场景 2：未绑定学校的用户打卡 ##########')
  await as('u_guest', 'login', {})
  console.log('login（不传 nickName）→ nickName=' + JSON.stringify((store['users'] || []).slice(-1)[0].nickName))
  await as('u_guest', 'addSighting', {
    data: { catId, location: { lat: 32.0595, lng: 118.7975 }, health: 'good', feedStatus: 'passed' }
  })
  const g = store['sightings'].slice(-1)[0]
  console.log('\n  >>> schoolId = ' + JSON.stringify(g.schoolId) + '   （用户档案 schoolId 为空时空着）')
  console.log('  >>> reporterName = ' + JSON.stringify(g.reporterName))

  /* ---------- 场景 3：新猫打卡（无 catId） ---------- */
  console.log('\n########## 场景 3：未认领的新猫打卡（无 catId） ##########')
  await as('u_admin', 'addSighting', {
    data: { pattern: 'orange', location: { lat: 32.0600, lng: 118.7980 }, health: 'good', feedStatus: 'passed' }
  })
  const p = store['sightings'].slice(-1)[0]
  console.log('  >>> schoolId = ' + JSON.stringify(p.schoolId))
  console.log('  >>> catId = ' + JSON.stringify(p.catId) + '  catName = ' + JSON.stringify(p.catName))

  console.log('\n########## 结论 ##########')
  console.log('逐条比对上面的落库值：若「已绑学校」那条的 schoolId 正常，')
  console.log('说明代码没问题 —— 库里为空是因为**打卡时用户档案的 schoolId 本来就是空**')
  console.log('（历史数据、或该用户从未完成绑定）。')
}
run().catch(e => { console.error(e); process.exit(1) })
