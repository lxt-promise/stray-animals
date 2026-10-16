#!/usr/bin/env node
/**
 * 图片加速与头像兜底 行为级测试（2026-10-15）
 *
 * 覆盖两块：
 *  A. miniprogram/utils/photo.js —— 缩略参数拼接 / fileID 批量预取缓存 /
 *     hydrateCats 渐进增强（断言打在输出数据上，不打源码形状）
 *  B. cloudfunctions/catcampus/lib/map.js attachMarkerUrls —— 临时链接换取失败时
 *     保留 fileID 兜底（「小灰灰没头像」的修复），未知协议照旧丢弃
 *
 * 跑法：node scripts/test_photo_perf.js
 */
const assert = require('assert')
const Module = require('module')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

/* ====================  A. utils/photo.js  ==================== */

// stub wx.cloud.getTempFileURL：ok 开头/fileID- 前缀的能换，其余报「文件不存在」
let gtfuCalls = []
function resetWx() {
  gtfuCalls = []
  global.wx = {
    cloud: {
      getTempFileURL({ fileList }) {
        gtfuCalls.push(fileList.slice())
        return Promise.resolve({
          fileList: fileList.map(id => /^cloud:\/\/ok/.test(id)
            ? { fileID: id, tempFileURL: 'https://' + id.slice(8) + '.tcb.qcloud.la/f.jpg?sign=s&t=123', status: 0 }
            : { fileID: id, tempFileURL: '', status: -1, errMsg: '文件不存在' })
        })
      }
    }
  }
}

const photo = require(path.join(ROOT, 'miniprogram/utils/photo.js'))
let passed = 0
function ok(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name) })
    .catch(e => { console.error('  ✗ ' + name + '\n    ' + (e && e.message)); process.exitCode = 1 })
}

async function runA() {
  console.log('—— A. photo.js ——')

  await ok('thumb: 有 sign 的临时链接用 & 拼接', () => {
    const u = photo.thumb('https://x.tcb.qcloud.la/a.jpg?sign=abc&t=1', 300)
    assert.strictEqual(u, 'https://x.tcb.qcloud.la/a.jpg?sign=abc&t=1&imageMogr2/thumbnail/300x')
  })

  await ok('thumb: 无查询串用 ? 拼接', () => {
    assert.strictEqual(
      photo.thumb('https://x.tcb.qcloud.la/a.jpg', 480),
      'https://x.tcb.qcloud.la/a.jpg?imageMogr2/thumbnail/480x')
  })

  await ok('thumb: 非云存储域名/fileID/已带参数 原样返回', () => {
    assert.strictEqual(photo.thumb('https://img.example.com/a.jpg', 300), 'https://img.example.com/a.jpg')
    assert.strictEqual(photo.thumb('cloud://xxx', 300), 'cloud://xxx')
    const withP = 'https://x.tcb.qcloud.la/a.jpg?sign=s&imageMogr2/thumbnail/100x'
    assert.strictEqual(photo.thumb(withP, 300), withP)
    assert.strictEqual(photo.thumb('', 300), '')
  })

  await ok('stripProcess: 去掉参数后地址可直接回退', () => {
    assert.strictEqual(photo.stripProcess('https://x.tcb.qcloud.la/a.jpg?sign=s&imageMogr2/thumbnail/300x'),
      'https://x.tcb.qcloud.la/a.jpg?sign=s')
    assert.strictEqual(photo.stripProcess('https://x.tcb.qcloud.la/a.jpg?imageMogr2/thumbnail/300x'),
      'https://x.tcb.qcloud.la/a.jpg')
    assert.strictEqual(photo.hasProcess(photo.thumb('https://x.tcb.qcloud.la/a.jpg', 100)), true)
  })

  await ok('warm: 批量预取按 50 分批，仅 status=0 入缓存', async () => {
    resetWx()
    const ids = []
    for (let i = 0; i < 75; i++) ids.push('cloud://ok' + i)
    ids.push('cloud://bad1')
    await photo.warm(ids)
    assert.strictEqual(gtfuCalls.length, 2, '应分 2 批，实际 ' + gtfuCalls.length)
    assert.strictEqual(gtfuCalls[0].length, 50)
    assert.strictEqual(gtfuCalls[1].length, 26)
    assert.ok(photo.cachedUrl('cloud://ok0').indexOf('.tcb.qcloud.la/') > 0, 'ok0 应有缓存')
    assert.strictEqual(photo.cachedUrl('cloud://bad1'), '', '失败的不应入缓存')
  })

  await ok('warm: 已缓存/非 fileID 不再发请求', async () => {
    resetWx()
    await photo.warm(['cloud://ok-dup'])
    const calls = gtfuCalls.length
    await photo.warm(['cloud://ok-dup', 'https://x.tcb.qcloud.la/a.jpg'])
    assert.strictEqual(gtfuCalls.length, calls, '重复预取不应再发请求')
  })

  await ok('warm: 云接口整体失败时静默，不抛错', async () => {
    global.wx = { cloud: { getTempFileURL() { return Promise.reject(new Error('net down')) } } }
    await photo.warm(['cloud://ok-x'])   // 不应抛
  })

  await ok('cachedUrl: 过 90 分钟 TTL 后失效', async () => {
    resetWx()
    await photo.warm(['cloud://ok-ttl'])
    assert.ok(photo.cachedUrl('cloud://ok-ttl'))
    const realNow = Date.now
    Date.now = () => realNow() + 91 * 60 * 1000
    try { assert.strictEqual(photo.cachedUrl('cloud://ok-ttl'), '', '过期应返回空') }
    finally { Date.now = realNow }
  })

  await ok('display: fileID 未命中 → 原样返回并收集 pending；命中 → 缩略链接', async () => {
    resetWx()
    const pending = []
    assert.strictEqual(photo.display('cloud://ok-z', 300, pending), 'cloud://ok-z')
    assert.deepStrictEqual(pending, ['cloud://ok-z'])
    await photo.warm(pending)
    const u = photo.display('cloud://ok-z', 300)
    assert.ok(/&imageMogr2\/thumbnail\/300x$/.test(u), '命中后应返回缩略链接，实际 ' + u)
  })

  await ok('hydrateCats: 首轮渐进渲染 + 预取后 apply 升级为缩略链接，且不循环', async () => {
    resetWx()
    const raw = [
      { _id: 'a', avatar: 'cloud://ok-a', photos: ['cloud://ok-a2'] },
      { _id: 'b', avatar: 'https://x.tcb.qcloud.la/b.jpg?sign=s' },
      { _id: 'c' }   // 没头像
    ]
    let applyCount = 0
    const view1 = photo.hydrateCats(raw, { px: 300 }, view => {
      applyCount++
      assert.strictEqual(view[0].avatar.indexOf('https://'), 0, '升级后 avatar 应是临时链接')
      assert.ok(/imageMogr2\/thumbnail\/300x$/.test(view[0].avatar), '应带缩略参数')
      assert.ok(/imageMogr2\/thumbnail\/480x$/.test(view[0].photosSmall[0]), 'photos 缩略用 photoPx')
      assert.strictEqual(view[1].avatar, 'https://x.tcb.qcloud.la/b.jpg?sign=s&imageMogr2/thumbnail/300x')
      assert.strictEqual(view[2].avatar, undefined, '没头像的猫不应造出 avatar 字段')
    })
    // 首轮：fileID 原样、https 拼参数、photosSmall 已生成
    assert.strictEqual(view1[0].avatar, 'cloud://ok-a')
    assert.ok(view1[0].photosSmall.length === 1 && view1[1].photosSmall === undefined)
    assert.ok(/imageMogr2\/thumbnail\/300x/.test(view1[1].avatar))
    await new Promise(r => setTimeout(r, 20))   // 等 apply 回调
    assert.strictEqual(applyCount, 1, 'apply 应恰好回调一次（第二次全命中不再回调）')
    // 原数组不被改动
    assert.strictEqual(raw[0].avatar, 'cloud://ok-a')
    assert.strictEqual(raw[0].photosSmall, undefined)
  })

  await ok('hydrateCats: 空 photos 不造 photosSmall；预取失败不回调也不崩', async () => {
    global.wx = { cloud: { getTempFileURL() { return Promise.reject(new Error('down')) } } }
    const raw = [{ _id: 'x', avatar: 'cloud://ok-nope' }]
    const view = photo.hydrateCats(raw, {}, () => { throw new Error('失败时不应回调') })
    assert.strictEqual(view[0].avatar, 'cloud://ok-nope')
    await new Promise(r => setTimeout(r, 20))
    assert.strictEqual(view[0].photosSmall, undefined, '无 photos 不应造 photosSmall')
  })
}

/* ====================  B. cloud lib/map.js attachMarkerUrls  ==================== */

async function runB() {
  console.log('—— B. attachMarkerUrls（云函数） ——')

  // stub wx-server-sdk + core 依赖链：只真实跑 attachMarkerUrls 的映射逻辑
  // （core.js require 时会 cloud.init，fake 得提供 init/DYNAMIC_CURRENT_ENV/database）
  const cloudStub = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    database: () => ({}),
    getWXContext: () => ({ OPENID: 'test' }),
    getTempFileURL({ fileList }) {
      return Promise.resolve({
        fileList: fileList.map(id => id === 'cloud://good'
          ? { fileID: id, tempFileURL: 'https://tmp.example/f.jpg?sign=s', status: 0 }
          : { fileID: id, tempFileURL: '', status: -1, errMsg: '文件不存在' })
      })
    }
  }
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk') return cloudStub
    return origLoad.apply(this, arguments)
  }
  let maplib
  try { maplib = require(path.join(ROOT, 'cloudfunctions/catcampus/lib/map.js')) }
  finally { Module._load = origLoad }

  await ok('换链成功 → https；换链失败 → 保留 fileID（不再置空）', async () => {
    const list = [
      { avatar: 'cloud://good' },
      { avatar: 'cloud://missing' }
    ]
    await maplib.attachMarkerUrls(list)
    assert.strictEqual(list[0].avatar, 'https://tmp.example/f.jpg?sign=s')
    assert.strictEqual(list[1].avatar, 'cloud://missing',
      '换不到临时链接时应保留 fileID 交给 <image> 直接渲染')
  })

  await ok('http(s) 与本地 /images/ 保留，未知协议丢弃', async () => {
    const list = [
      { avatar: 'https://x.tcb.qcloud.la/a.jpg?sign=s' },
      { avatar: '/images/marker-cat.png' },
      { avatar: 'wxfile://tmp/x.jpg' },
      { avatar: '' }
    ]
    await maplib.attachMarkerUrls(list)
    assert.strictEqual(list[0].avatar, 'https://x.tcb.qcloud.la/a.jpg?sign=s')
    assert.strictEqual(list[1].avatar, '/images/marker-cat.png')
    assert.strictEqual(list[2].avatar, '', 'wxfile 私有路径必须丢弃')
    assert.strictEqual(list[3].avatar, '')
  })

  await ok('空列表 / null 项不炸', async () => {
    await maplib.attachMarkerUrls([])
    await maplib.attachMarkerUrls([null])
  })
}

/* ====================  C. photosFull（预览/分享用的原尺寸 https）  ==================== */

async function runC() {
  console.log('—— C. photosFull ——')

  await ok('full=true 时产出原尺寸 https 原图地址，供 previewImage/分享使用', async () => {
    resetWx()
    const raw = [{ _id: 'd', photos: ['cloud://ok-d1', 'https://x.tcb.qcloud.la/d2.jpg'] }]
    const v1 = photo.hydrateCats(raw, { photoPx: 480, full: true })[0]
    // 缓存未命中：原图地址还是 fileID（不阻塞首屏），缩略字段已生成
    assert.deepStrictEqual(v1.photosFull, ['cloud://ok-d1', 'https://x.tcb.qcloud.la/d2.jpg'])
    assert.ok(/imageMogr2\/thumbnail\/480x/.test(v1.photosSmall[1]))
    await photo.warm(['cloud://ok-d1'])
    const v2 = photo.hydrateCats(raw, { photoPx: 480, full: true })[0]
    assert.ok(/^https:\/\//.test(v2.photosFull[0]), '预取后应是 https')
    assert.strictEqual(photo.hasProcess(v2.photosFull[0]), false, '原图地址不应带缩略参数')
    assert.ok(/imageMogr2\/thumbnail\/480x/.test(v2.photosSmall[0]), '展示地址仍带缩略参数')
  })

  await ok('未开 full 时不产出 photosFull（保持旧行为）', () => {
    const v = photo.hydrateCats([{ photos: ['cloud://x'] }], {})[0]
    assert.strictEqual(v.photosFull, undefined)
  })
}

/* ============  D. cloud:// 绝不进渲染层（2026-10-15 二修）  ============ */

async function runD() {
  console.log('—— D. cloud:// 不进 <image src> ——')

  await ok('真机：fileID 未命中仍原样直出（原生支持 cloud://），并收进 pending', () => {
    resetWx()
    const pending = []
    assert.strictEqual(photo.display('cloud://ok-m1', 300, pending), 'cloud://ok-m1')
    assert.deepStrictEqual(pending, ['cloud://ok-m1'])
  })

  await ok('开发者工具：fileID 未命中返回空串（不给 pageframe 喂 cloud://）', () => {
    // 重新加载模块，让 isDevtools() 在 devtools 环境下首次求值
    const p = path.join(ROOT, 'miniprogram/utils/photo.js')
    delete require.cache[require.resolve(p)]
    global.wx = {
      platform: 'devtools',
      getSystemInfoSync: () => ({ platform: 'devtools' }),
      cloud: {
        getTempFileURL({ fileList }) {
          return Promise.resolve({
            fileList: fileList.map(id => ({ fileID: id, status: 0,
              tempFileURL: 'https://' + id.slice(8) + '.tcb.qcloud.la/f.jpg?sign=s' }))
          })
        }
      }
    }
    const photoDev = require(p)
    const pending = []
    assert.strictEqual(photoDev.isDevtools(), true, '应识别为开发者工具')
    assert.strictEqual(photoDev.display('cloud://ok-dt', 300, pending), '',
      'devtools 下未命中缓存必须返回空串')
    assert.deepStrictEqual(pending, ['cloud://ok-dt'], '仍要收进 pending 以便预取')
    // 命中缓存后照常返回 https 缩略
    return photoDev.warm(['cloud://ok-dt']).then(() => {
      const u = photoDev.display('cloud://ok-dt', 300)
      assert.ok(/^https:\/\//.test(u) && /imageMogr2\/thumbnail\/300x$/.test(u), '实际 ' + u)
      delete require.cache[require.resolve(p)]
    })
  })

  await ok('hydrateCatsAsync：先预取再映射，产出全 https 且不包含 cloud://', async () => {
    resetWx()
    const raw = [
      { _id: 'a', avatar: 'cloud://ok-async-a', photos: ['cloud://ok-async-a2'] },
      { _id: 'b', avatar: 'https://x.tcb.qcloud.la/b.jpg?sign=s' }
    ]
    const view = await photo.hydrateCatsAsync(raw, { px: 300, photoPx: 480, full: true })
    // 渲染字段（avatar / photosSmall / photosFull）一个 cloud:// 都不能有；
    // 原始 photos 有意保留 fileID —— binderror 兜底要靠它换链接
    const rendered = JSON.stringify({
      avatar: view[0].avatar, small: view[0].photosSmall, full: view[0].photosFull
    })
    assert.strictEqual(/cloud:\/\//.test(rendered), false, '渲染字段不应残留 cloud://，实际 ' + rendered)
    assert.ok(/^https:\/\//.test(view[0].avatar))
    assert.ok(/imageMogr2\/thumbnail\/300x$/.test(view[0].avatar))
    assert.ok(/imageMogr2\/thumbnail\/480x$/.test(view[0].photosSmall[0]))
    assert.ok(/^https:\/\//.test(view[0].photosFull[0]), '预览地址也应是 https')
    assert.strictEqual(photo.hasProcess(view[0].photosFull[0]), false, '预览地址不带缩略参数')
  })

  await ok('hydrateCatsAsync：换链接口卡死也不拖死渲染（超时保护）', async () => {
    global.wx = { cloud: { getTempFileURL: () => new Promise(() => {}) } }  // 永不 resolve
    const raw = [{ _id: 't', avatar: 'cloud://ok-hang' }]
    const t0 = Date.now()
    const view = await photo.hydrateCatsAsync(raw, { px: 300 }, 120)
    assert.ok(Date.now() - t0 < 1000, '应在超时内返回')
    assert.strictEqual(view[0].avatar, 'cloud://ok-hang', '非 devtools 环境仍直出 fileID')
  })

  await ok('avatar 为空但有相册 → 用 photos[0] 顶（与云端 attachCatMediaUrls 同口径）', () => {
    resetWx()
    const view = photo.hydrateCats([
      { _id: 'na', photos: ['https://x.tcb.qcloud.la/only.jpg', 'https://x.tcb.qcloud.la/2.jpg'] },
      { _id: 'none' }
    ], { px: 200 })
    assert.ok(/^https:\/\/x\.tcb\.qcloud\.la\/only\.jpg/.test(view[0].avatar),
      '应拿 photos[0] 当头像，实际 ' + view[0].avatar)
    assert.strictEqual(view[1].avatar, undefined, '什么都没有的猫仍不造 avatar 字段')
  })

  await ok('resolve：单图换链，换不到返回空（供 binderror 退占位）', async () => {
    resetWx()
    const good = await photo.resolve('cloud://ok-r1')
    assert.ok(/^https:\/\//.test(good), '应换出临时链接')
    const bad = await photo.resolve('cloud://bad-r2')
    assert.strictEqual(bad, '', '换不到应返回空串')
    const http = await photo.resolve('https://x.tcb.qcloud.la/a.jpg')
    assert.strictEqual(http, 'https://x.tcb.qcloud.la/a.jpg', '本来就是 http 的原样返回')
  })
}

;(async () => {
  await runA()
  await runB()
  await runC()
  await runD()
  console.log('\n通过 ' + passed + ' 项' + (process.exitCode ? '（有失败）' : '，0 失败'))
})()
