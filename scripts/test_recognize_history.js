/**
 * 识别页 · 历史记录回看测试
 *
 * 2026-11-10 现场：历史记录点进去，取景区没有照片、候选头像全是空的。
 * 根因两条，都是「把会过期的地址存进了缓存」：
 *   ① 查询图存的是 chooseMedia 的 tempPath（重启即失效）；
 *   ② 候选头像存的是当时换出来的 https 临时链接（2h 后 403），
 *      而 hydrateCats 又用这条过期链接覆盖了 avatarId，连重换链的原料都没了。
 *
 * 这里锁住修复后的契约：
 *   A. 快照只存 fileID（avatarId / photoId），不存 tempPath、不存临时链接；
 *   B. 回看时用 photoId 还原取景区，拿不到就置 photoExpired（模板给说明，不留空白）；
 *   C. 旧记录（只有过期 https）能按 catId 回源取档案头像；
 *   D. 快照丢掉 embedding 这类纯排查用的大字段。
 *
 * 运行：node scripts/test_recognize_history.js
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const ROOT = path.resolve(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')

let pass = 0, fail = 0
const failures = []
const assert = (name, cond, extra) => {
  if (cond) { pass++; return }
  fail++
  failures.push(name)
  console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))
}

/* ==================== 环境桩 ==================== */
const ENV_ID = 'catcampus-test'
const storage = Object.create(null)
const cloudCalls = []

global.wx = {
  getStorageSync(k) { return storage[k] === undefined ? '' : storage[k] },
  setStorageSync(k, v) { storage[k] = JSON.parse(JSON.stringify(v)) },
  removeStorageSync(k) { delete storage[k] },
  getSystemInfoSync() { return { platform: 'ios' } },   // 真机口径：cloud:// 直出
  getFileSystemManager() { return { accessSync() { throw new Error('no') } } },
  showToast() {},
  showModal() {},
  navigateTo() {},
  switchTab() {},
  previewImage() {},
  cloud: {
    getTempFileURL({ fileList }) {
      cloudCalls.push(fileList.slice())
      return Promise.resolve({
        fileList: fileList.map(f => ({
          fileID: f,
          status: 0,
          tempFileURL: 'https://' + ENV_ID + '.tcb.qcloud.la/' +
            String(f).replace(/^cloud:\/\/[^/]+\//, '') + '?sign=stub'
        }))
      })
    },
    downloadFile() { return Promise.resolve({ tempFilePath: '' }) },
    uploadFile() { return Promise.resolve({ fileID: '' }) }
  }
}

const FAKE_APP = {
  globalData: { ready: true, user: { _id: 'u1' }, school: null },
  isMember: () => true,
  isAdmin: () => false,
  isSuper: () => false,
  ensureReady: async () => {},
  callApi: async () => ({}),
  setSchool() {}
}
global.getApp = () => FAKE_APP

const origLoad = Module._load
Module._load = function (request) {
  if (request && /\.wxml$|\.wxss$|\.json$/.test(request)) return {}
  return origLoad.apply(this, arguments)
}

let pageOpts = null
global.Page = opts => { pageOpts = opts }
require(path.join(MP, 'pages/recognize/recognize.js'))

const photo = require(path.join(MP, 'utils/photo.js'))

function mkPage(opts) {
  const p = Object.assign({}, opts, {
    data: JSON.parse(JSON.stringify(opts.data)),
    setData(patch) {
      Object.keys(patch).forEach(k => {
        // 兼容 'result.candidates[0].avatar' 这种带下标的路径（页面里大量使用）
        const parts = k.replace(/\[(\d+)\]/g, '.$1').split('.')
        if (parts.length === 1) { this.data[k] = patch[k]; return }
        let o = this.data
        for (let i = 0; i < parts.length - 1; i++) {
          if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {}
          o = o[parts[i]]
        }
        o[parts[parts.length - 1]] = patch[k]
      })
    }
  })
  return p
}

const flush = () => new Promise(r => setTimeout(r, 0))
const run = (p, fn, arg) => p[fn](arg)

/* 造一份云端返回的原始结果（形状与 lib/vision.js 的 result 一致） */
function rawResult() {
  return {
    requestId: 'rc_1',
    provider: 'custom',
    type: 'image',
    frames: 1,
    latency: 2100,
    features: {
      tags: [{ k: '品种', v: '橘狸花' }, { k: '毛色', v: '橘色' }],
      pattern: 'tabby',
      color: 'orange',
      breed: '橘狸花',
      embedding: new Array(768).fill(0.01)     // 快照必须丢掉
    },
    candidates: [
      {
        catId: 'cat1',
        name: '胖橘',
        avatar: 'cloud://' + ENV_ID + '.bucket/cats/1.jpg',   // 原始 fileID
        score: 83,
        rawSim: 0.71,
        lead: 0.12,
        reason: '花纹与体型高度接近'
      },
      {
        catId: 'cat2',
        name: '小灰',
        avatar: 'cloud://' + ENV_ID + '.bucket/cats/2.jpg',
        score: 51,
        rawSim: 0.42,
        lead: 0,
        reason: '毛色接近，脸部略不同'
      }
    ],
    threshold: 62,
    degraded: false,
    indexedTotal: 8,
    attrsReady: true,
    identified: true,
    attrReason: '',
    qualityOk: true,
    qualityReason: '',
    lightMeanV: 180,
    lowConfidence: false,
    notice: ''
  }
}

async function main() {
  assert('recognize.js 注册了 Page', !!pageOpts)

  console.log('\n--- A. 快照只存 fileID ---')
  {
    const p = mkPage(pageOpts)
    p.data.mode = 'image'
    p.saveHistory(rawResult(), 'task_1', 'cloud://' + ENV_ID + '.bucket/recognize/1.jpg')
    const list = wx.getStorageSync('recognize_history')
    assert('写入 1 条历史', list.length === 1, list.length)
    const it = list[0]
    assert('历史带 photoId（回看还原查询图的唯一依据）',
      it.photoId === 'cloud://' + ENV_ID + '.bucket/recognize/1.jpg', it.photoId)
    assert('候选头像存的是 fileID（不是 https 临时链接）',
      it.result.candidates[0].avatarId === 'cloud://' + ENV_ID + '.bucket/cats/1.jpg' &&
      it.result.candidates[0].avatar === undefined,
      it.result.candidates[0])
    assert('快照没有 embedding（768 维白占缓存额度）',
      it.result.features.embedding === undefined)
    assert('快照保留展示字段', it.result.features.breed === '橘狸花' &&
      it.result.candidates[0].name === '胖橘' && it.result.indexedTotal === 8)
  }

  console.log('\n--- B. 回看还原查询图 ---')
  {
    const p = mkPage(pageOpts)
    p.loadHistory()
    const before = cloudCalls.length
    await run(p, 'tapHistory', { currentTarget: { dataset: { index: 0 } } })
    assert('进入 done 态', p.data.stage === 'done')
    assert('标记为历史回看', p.data.isHistory === true)
    assert('不重放人工确认（taskId 清空，避免重复写标注样本）', p.data.taskId === '')
    await flush()
    assert('查询图由 fileID 换链得到', /^https?:\/\//.test(p.data.localPath), p.data.localPath)
    assert('换链确实调了 getTempFileURL', cloudCalls.length > before)
    assert('没有误报「照片过期」', p.data.photoExpired === false)
    const c = p.data.result.candidates
    assert('候选头像可渲染', c.length === 2 && !!c[0].avatar && !!c[1].avatar, c)
    assert('候选保留名字与分数', c[0].name === '胖橘' && c[0].score === 83, c[0])
  }

  console.log('\n--- C. 旧记录（只存了过期 https，没有 fileID）---')
  {
    storage['recognize_history'] = [{
      ts: Date.now(),
      timeText: '11-09 20:00',
      mode: 'image',
      taskId: 'task_old',
      // 旧版本：avatar 是临时链接、没有 avatarId、也没有 photoId
      result: {
        features: { tags: [], pattern: '', color: '', breed: '' },
        candidates: [{
          catId: 'cat9',
          name: '老档案猫',
          avatar: 'https://' + ENV_ID + '.tcb.qcloud.la/cats/9.jpg?sign=expired',
          score: 70,
          reason: ''
        }],
        degraded: false,
        indexedTotal: 8,
        qualityOk: true,
        lowConfidence: false
      }
    }]
    FAKE_APP.callApi = async (action, data) => {
      if (action === 'recognizeTaskPhoto') return { fileId: '' }   // 老任务已被清理
      if (action !== 'getCat') throw new Error('unexpected ' + action)
      assert('回源用的是当前这只猫的 id', data.id === 'cat9', data)
      return {
        cat: {
          _id: 'cat9',
          name: '老档案猫',
          avatar: 'https://' + ENV_ID + '.tcb.qcloud.la/cats/9.jpg?sign=fresh',
          photoIds: ['cloud://' + ENV_ID + '.bucket/cats/9.jpg']
        }
      }
    }
    const p = mkPage(pageOpts)
    p.loadHistory()
    await run(p, 'tapHistory', { currentTarget: { dataset: { index: 0 } } })
    await flush(); await flush(); await flush()
    assert('旧记录先按原样渲染（不预判失败、不白打 getCat）',
      /sign=expired/.test(p.data.result.candidates[0].avatar || ''),
      p.data.result.candidates[0].avatar)
    // 临时链接 403 → <image> binderror → 兜底链：先去缩略参数重试，再回源取档案头像
    await run(p, 'onCandAvatarErr', { currentTarget: { dataset: { i: 0 } } })
    assert('第一次失败先去掉 imageMogr2 参数重试',
      !/imageMogr2/.test(p.data.result.candidates[0].avatar || ''),
      p.data.result.candidates[0].avatar)
    await run(p, 'onCandAvatarErr', { currentTarget: { dataset: { i: 0 } } })
    await flush(); await flush(); await flush()
    const c = p.data.result.candidates[0]
    assert('旧记录的候选头像能回源补上（不再永久 🐱）',
      /^https?:\/\//.test(c.avatar || '') && !/sign=expired/.test(c.avatar || ''), c)
    assert('没有 photoId 时明确标记照片过期（模板据此给说明）', p.data.photoExpired === true)
  }

  console.log('\n--- C2. 老记录没有 photoId，但任务还在 → 认领回查询图 ---')
  {
    storage['recognize_history'] = [{
      ts: Date.now(),
      timeText: '11-09 21:00',
      mode: 'image',
      taskId: 'task_keep',
      // 最老的版本：连 result.candidates 都没有多余字段，只有 taskId
      result: {
        features: { tags: [], pattern: '', color: '', breed: '' },
        candidates: [],
        degraded: false,
        indexedTotal: 8,
        qualityOk: true,
        lowConfidence: false
      }
    }]
    const asked = []
    FAKE_APP.callApi = async (action, data) => {
      asked.push(action)
      if (action === 'recognizeTaskPhoto') {
        assert('按 taskId 认领素材', data.taskId === 'task_keep', data)
        return { fileId: 'cloud://' + ENV_ID + '.bucket/recognize/keep.jpg', thumbId: '', type: 'image' }
      }
      return {}
    }
    const p = mkPage(pageOpts)
    p.loadHistory()
    await run(p, 'tapHistory', { currentTarget: { dataset: { index: 0 } } })
    await flush(); await flush(); await flush()
    assert('确实回云端认领了素材', asked.indexOf('recognizeTaskPhoto') >= 0, asked)
    assert('查询图从任务素材还原', /^https?:\/\//.test(p.data.localPath || ''), p.data.localPath)
    assert('还原成功时不报「照片过期」', p.data.photoExpired === false)
    FAKE_APP.callApi = async () => ({})
  }

  console.log('\n--- D. 模板契约 ---')
  {
    const wxml = fs.readFileSync(path.join(MP, 'pages/recognize/recognize.wxml'), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
    assert('取景区有「没有图」的说明块', /vp-missing/.test(wxml))
    assert('说明文案区分「已不在本机」', /已不在本机/.test(wxml))
    assert('回看时有「历史记录」标识', /vp-hist-tag/.test(wxml))
    // <image> 不该在 localPath 为空时硬渲染
    assert('<image> 加了 localPath 条件', /wx:if="\{\{localPath\}\}"[^>]*class="vp-media"|class="vp-media"[^>]*wx:if="\{\{localPath\}\}"/.test(wxml))
    const wxss = fs.readFileSync(path.join(MP, 'pages/recognize/recognize.wxss'), 'utf8')
    assert('占位块有样式', /\.vp-missing\s*\{/.test(wxss) && /\.vpm-txt\s*\{/.test(wxss))
  }

  console.log('\n--- E. hydrateCats 不毁原始 fileID ---')
  {
    // 二次 hydrate：avatar 已经是过期 https，avatarId 才是真 fileID
    const list = [{
      catId: 'cat1',
      avatar: 'https://x.tcb.qcloud.la/a.jpg?sign=dead',
      avatarId: 'cloud://' + ENV_ID + '.bucket/a.jpg'
    }]
    const out = photo.hydrateCats(list, { px: 200 })
    assert('二次 hydrate 保留原始 fileID', out[0].avatarId === 'cloud://' + ENV_ID + '.bucket/a.jpg',
      out[0].avatarId)
    // 只有 avatarId、没有 avatar 的快照也能出图
    const out2 = photo.hydrateCats([{ catId: 'c', avatarId: 'cloud://' + ENV_ID + '.bucket/b.jpg' }], { px: 200 })
    assert('只有 avatarId 时也能渲染头像', !!out2[0].avatar, out2[0])
  }

  console.log('\n' + (fail ? ('失败 ' + fail + ' 项 / ') : '') + '通过 ' + pass + ' 项')
  if (fail) {
    console.log('失败用例：\n  - ' + failures.join('\n  - '))
    process.exit(1)
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
