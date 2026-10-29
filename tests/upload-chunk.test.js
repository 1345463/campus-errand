/**
 * 图片上传的分片通道（R53）
 *
 * 要防的回归：接单员传身份证时弹 EXCEED_MAX_PAYLOAD_SIZE。
 * 根因是 wx.cloud.callFunction 单次入参约 1MB，而 base64 图片轻易超过。
 * 这里把「什么时候分片、片怎么切、切完能不能拼回去」钉死，
 * 免得以后有人改了体积阈值又把它踩回来。
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

test('超过单次安全线的图切成 400KB 分片，服务端拼回原串', async () => {
  const big = 'B'.repeat(900 * 1024)
  const h = loadUpload({ files: { '/b.jpg': { size: 700 * 1024, data: big } } })
  assert.equal(await h.upload('/b.jpg'), 'asset:42')

  const list = fns(h.calls)
  assert.equal(list[0], 'begin_media_upload')
  assert.equal(list[list.length - 1], 'finish_media_upload')
  assert.equal(list.filter((f) => f === 'push_media_part').length, 3) // ceil(900KB / 400KB)

  // 片序与内容都要对得上：按序号拼回去必须与原串逐字符一致
  const joined = h.calls
    .filter((c) => c.fn === 'push_media_part')
    .sort((a, b) => a.args.p_idx - b.args.p_idx)
    .map((c) => c.args.p_data)
    .join('')
  assert.equal(joined, big)

  const begin = h.calls.find((c) => c.fn === 'begin_media_upload')
  assert.equal(begin.args.p_total, 3)
  assert.equal(begin.args.p_scope, 'certs')
})

test('单次被通道以「太大」拒绝时，自动改用 200KB 分片重来', async () => {
  // 500KB base64 仍在「单次安全线」内，所以会先试整包；被拒后才退回分片
  const mid = 'C'.repeat(500 * 1024)
  const h = loadUpload({
    rejectWhole: true,
    files: { '/c.jpg': { size: 400 * 1024, data: mid } },
  })
  assert.equal(await h.upload('/c.jpg'), 'asset:42')

  const list = fns(h.calls)
  assert.equal(list[0], 'save_media_asset') // 先试了整包
  assert.equal(list.filter((f) => f === 'push_media_part').length, 3) // 失败后按 200KB 切

  const first = h.calls.find((c) => c.fn === 'push_media_part')
  assert.equal(first.args.p_data.length, 200 * 1024)
})

test('压缩后仍超过服务端上限的图直接报错，不硬传', async () => {
  const h = loadUpload({
    files: { '/d.jpg': { size: 2.4 * 1024 * 1024, data: 'D'.repeat(30 * 1024) } },
  })
  await assert.rejects(() => h.upload('/d.jpg'), /超过 700KB/)
})

// 微信的 sizeType:'compressed' 只对部分拍照场景生效，相册选的图基本原样返回，
// 所以压缩**必须由我们自己无条件做**，不能看来源下菜碟。
test('相册大图同样走压缩阶梯，压到通道线就停', async () => {
  const h = loadUpload({
    shrinkTo: 200 * 1024,
    files: { '/e.jpg': { size: 3.2 * 1024 * 1024, data: 'E'.repeat(200 * 1024) } },
  })
  assert.equal(await h.upload('/e.jpg'), 'asset:42')

  // 第一档 70 就压到 200KB（< 420KB 通道线），到此为止 —— 不会为了压而压
  assert.deepEqual(h.compressCalls, [70])
  assert.deepEqual(fns(h.calls), ['save_media_asset'])
})

test('压了跟没压一样时提前收手，不白转六档', async () => {
  const h = loadUpload({
    files: { '/f.jpg': { size: 3.2 * 1024 * 1024, data: 'F'.repeat(300 * 1024) } },
  })
  await assert.rejects(() => h.upload('/f.jpg'), /超过 700KB/)
  assert.deepEqual(h.compressCalls, [70]) // 一档无效就停
})
