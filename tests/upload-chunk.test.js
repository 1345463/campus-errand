/**
 * 图片上传的分片通道（R53）
 *
 * 要防的回归：接单员传身份证时弹 EXCEED_MAX_PAYLOAD_SIZE。
 *
 * 根因是 **CloudBase HTTP 访问服务的请求体上限 100KB（102400 字节）**，
 * 超了网关直接回 HTTP 413 {"code":"EXCEED_MAX_PAYLOAD_SIZE"}，
 * 客户端会把这个 code 原样弹出来 —— 用户看到的就是这行英文。
 * 之前按「1MB」设计分片、片大小定成 400KB，等于每片必挂，修了等于没修。
 *
 * 这里把「什么时候分片、片怎么切、切完能不能拼回去」钉死，
 * 免得以后有人改了体积阈值又把它踩回来。
 * 注意读写上限**不对称**：写要切 ≤80KB 的片，读可以一次拿回近 1MB。
 */
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const root = path.resolve(__dirname, '..')

// 在 vm 里加载 utils/upload.js，wx / tcb / ui / config 全部用假的
function loadUpload(options) {
  const opts = options || {}
  const files = opts.files || {}
  const calls = []
  const compressCalls = []

  const wx = {
    env: { USER_DATA_PATH: '/tmp' },
    getFileSystemManager: function () {
      return {
        statSync: function (p) {
          return { size: (files[p] && files[p].size) || 0 }
        },
        readFile: function (arg) {
          arg.success({ data: (files[arg.filePath] && files[arg.filePath].data) || '' })
        },
      }
    },
    // 默认不真的压缩（产物与源同路径、体积不变，好让分片逻辑按原始体积走）；
    // 要测压缩阶梯时用 opts.shrinkTo 指定「压完的体积」
    compressImage: function (arg) {
      compressCalls.push(arg.quality)
      const src = files[arg.src]
      if (opts.shrinkTo && src && src.size > opts.shrinkTo) {
        // 模拟「压缩见效」：产物是另一个路径，体积变小，内容沿用
        const small = arg.src + '@' + arg.quality
        files[small] = { size: opts.shrinkTo, data: src.data }
        arg.success({ tempFilePath: small })
        return
      }
      arg.success({ tempFilePath: arg.src })
    },
  }

  const tcb = {
    rpc: function (fn, args) {
      calls.push({ fn: fn, args: args })
      if (fn === 'save_media_asset') {
        if (opts.rejectWhole) {
          const error = new Error('EXCEED_MAX_PAYLOAD_SIZE')
          error.payloadTooLarge = true
          return Promise.resolve({ data: null, error: error })
        }
        return Promise.resolve({ data: 42, error: null })
      }
      if (fn === 'begin_media_upload') return Promise.resolve({ data: [{ upload_id: 7 }], error: null })
      if (fn === 'push_media_part') return Promise.resolve({ data: [{ got: 1 }], error: null })
      if (fn === 'finish_media_upload') return Promise.resolve({ data: [{ asset_id: 42 }], error: null })
      return Promise.resolve({ data: null, error: new Error('未知函数 ' + fn) })
    },
  }

  const ctx = {
    console: console,
    wx: wx,
    require: function (name) {
      const key = name.split('/').pop()
      if (key === 'config') return { endpoint: '', publishableKey: '' }
      if (key === 'tcb') return tcb
      if (key === 'ui') return { loading: function () {}, hideLoading: function () {} }
      return {}
    },
    module: { exports: {} },
  }
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(path.join(root, 'utils/upload.js'), 'utf8'), ctx, {
    filename: 'utils/upload.js',
  })

  return {
    calls: calls,
    compressCalls: compressCalls,
    mod: ctx.module.exports,
    upload: function (filePath) {
      return ctx.module.exports.uploadImage(filePath, 'certs', 'wx:oTEST')
    },
  }
}

function fns(calls) {
  return calls.map(function (c) {
    return c.fn
  })
}

test('小图一次调用存库，不启分片', async () => {
  const h = loadUpload({
    files: { '/a.jpg': { size: 100 * 1024, data: 'a'.repeat(1000) } },
  })
  assert.equal(await h.upload('/a.jpg'), 'asset:42')
  assert.deepEqual(fns(h.calls), ['save_media_asset'])
})

test('超过单次安全线的图切成 80KB 分片，服务端拼回原串', async () => {
  const big = 'B'.repeat(900 * 1024)
  const h = loadUpload({ files: { '/b.jpg': { size: 600 * 1024, data: big } } })
  assert.equal(await h.upload('/b.jpg'), 'asset:42')

  const list = fns(h.calls)
  assert.equal(list[0], 'begin_media_upload')
  assert.equal(list[list.length - 1], 'finish_media_upload')
  assert.equal(list.filter((f) => f === 'push_media_part').length, 12) // ceil(900KB / 80KB)

  // 片序与内容都要对得上：按序号拼回去必须与原串逐字符一致
  const joined = h.calls
    .filter((c) => c.fn === 'push_media_part')
    .sort((a, b) => a.args.p_idx - b.args.p_idx)
    .map((c) => c.args.p_data)
    .join('')
  assert.equal(joined, big)

  const begin = h.calls.find((c) => c.fn === 'begin_media_upload')
  assert.equal(begin.args.p_total, 12)
  assert.equal(begin.args.p_scope, 'certs')
})

test('中等体积的图直接走分片，不再先试整包', async () => {
  // 500KB base64 远超 64KB 的整包安全线，应该一次整包都不试
  const mid = 'C'.repeat(500 * 1024)
  const h = loadUpload({
    rejectWhole: true,
    files: { '/c.jpg': { size: 400 * 1024, data: mid } },
  })
  assert.equal(await h.upload('/c.jpg'), 'asset:42')

  const list = fns(h.calls)
  assert.equal(list.filter((f) => f === 'save_media_asset').length, 0) // 没试整包
  assert.equal(list[0], 'begin_media_upload')
  assert.equal(list.filter((f) => f === 'push_media_part').length, 7) // ceil(500KB / 80KB)
})

test('整包被通道拒绝时自动改用 48KB 分片重来', async () => {
  // 40KB base64 在整包安全线内 → 先试整包；被拒后才退回更小的分片
  const small = 'G'.repeat(40 * 1024)
  const h = loadUpload({
    rejectWhole: true,
    files: { '/g.jpg': { size: 30 * 1024, data: small } },
  })
  assert.equal(await h.upload('/g.jpg'), 'asset:42')

  const list = fns(h.calls)
  assert.equal(list[0], 'save_media_asset') // 先试了整包
  const parts = h.calls.filter((c) => c.fn === 'push_media_part')
  assert.equal(parts.length, 1) // 40KB < 48KB，一片搞定
  assert.equal(parts[0].args.p_data.length, 40 * 1024)
})

test('压缩后仍超过服务端上限的图直接报错，不硬传', async () => {
  const h = loadUpload({
    files: { '/d.jpg': { size: 2.4 * 1024 * 1024, data: 'D'.repeat(30 * 1024) } },
  })
  await assert.rejects(() => h.upload('/d.jpg'), /超过 690KB/)
})

// 微信的 sizeType:'compressed' 只对部分拍照场景生效，相册选的图基本原样返回，
// 所以压缩**必须由我们自己无条件做**，不能看来源下菜碟。
test('相册大图同样走压缩阶梯，压到通道线就停', async () => {
  const h = loadUpload({
    shrinkTo: 200 * 1024,
    files: { '/e.jpg': { size: 3.2 * 1024 * 1024, data: 'E'.repeat(200 * 1024) } },
  })
  assert.equal(await h.upload('/e.jpg'), 'asset:42')

  // 关键：相册来源的图也压了（没有「拍照才压」的分支）
  // 第一档 70 就压到 200KB（< 420KB 通道线），到此为止 —— 不会为了压而压
  assert.deepEqual(h.compressCalls, [70])
  // 200KB base64 超过 64KB 整包线 → 走分片，3 片
  const list = fns(h.calls)
  assert.equal(list[0], 'begin_media_upload')
  assert.equal(list.filter((f) => f === 'push_media_part').length, 3)
})

test('压了跟没压一样时提前收手，不白转六档', async () => {
  const h = loadUpload({
    files: { '/f.jpg': { size: 3.2 * 1024 * 1024, data: 'F'.repeat(300 * 1024) } },
  })
  await assert.rejects(() => h.upload('/f.jpg'), /超过 690KB/)
  assert.deepEqual(h.compressCalls, [70]) // 一档无效就停
})
