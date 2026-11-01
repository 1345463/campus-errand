/**
 * 图片本地缓存（R65）
 *
 * 之前每次读图都写一个「时间戳 + 随机数」的新文件：
 * 同一张图每进一次页面就重新拉一遍 base64（最大约 920KB）再写一份，
 * USER_DATA_PATH 里的老文件永不清理。订单详情来回看几遍、大厅反复刷，
 * 磁盘和流量都在白烧。
 *
 * 现在按「图 id + 账号尾号」缓存。这里用假 wx + 假 tcb 真跑：
 *   · 同一张图第二次读，不再产生 RPC
 *   · 并发读同一张图只下载一次
 *   · 换账号不命中上一个人的缓存
 *   · 退出登录清掉本账号的缓存文件
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const UPLOAD_PATH = require.resolve(path.join(__dirname, '..', 'utils', 'upload.js'))
const TCB_PATH = require.resolve(path.join(__dirname, '..', 'utils', 'tcb.js'))

const USER_DIR = 'wxfile://usr'

/**
 * 造一套最小的本地文件系统 + 可计数的 tcb。
 * 必须在 require upload 之前塞进 require.cache，upload 顶层就会引 tcb。
 */
function makeEnv(uid) {
  const files = new Map()
  const state = { rpcCalls: 0, delay: 0 }

  const manager = {
    accessSync: function (p) {
      if (!files.has(p)) throw new Error('no such file: ' + p)
    },
    writeFileSync: function (p, data) {
      files.set(p, data)
    },
    readdirSync: function () {
      return Array.from(files.keys()).map(function (p) {
        return p.slice(USER_DIR.length + 1)
      })
    },
    statSync: function (p) {
      if (!files.has(p)) throw new Error('no such file: ' + p)
      return { lastModifiedTime: Math.floor(Date.now() / 1000) }
    },
    unlinkSync: function (p) {
      files.delete(p)
    },
  }

  global.wx = {
    env: { USER_DATA_PATH: USER_DIR },
    getFileSystemManager: function () {
      return manager
    },
  }

  const tcbStub = {
    rpc: function (fn, args) {
      state.rpcCalls += 1
      const run = function () {
        return { data: [{ mime: 'image/png', data: 'QUJD' }], error: null }
      }
      if (!state.delay) return Promise.resolve(run())
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve(run())
        }, state.delay)
      })
    },
    readSession: function () {
      return uid ? { uid: uid, token: 't' } : null
    },
  }
  require.cache[TCB_PATH] = {
    id: TCB_PATH,
    filename: TCB_PATH,
    loaded: true,
    exports: tcbStub,
  }

  delete require.cache[UPLOAD_PATH]
  const upload = require(UPLOAD_PATH)
  return { upload: upload, files: files, state: state }
}

test('同一张图第二次读不再产生 RPC（命中缓存）', async () => {
  const env = makeEnv('wx:userA')
  const first = await env.upload.assetToLocalFile('asset:12')
  const second = await env.upload.assetToLocalFile('asset:12')

  assert.equal(first, second, '两次应该拿到同一个本地路径')
  assert.equal(env.state.rpcCalls, 1, '第二次必须走缓存，不再下载')
  assert.ok(first.indexOf('asset_12_') >= 0, '文件名要能看出是哪张图')
  await env.upload.assetToLocalFile('asset:13')
  assert.equal(env.state.rpcCalls, 2, '不同的图当然要各下各的')
})

test('并发读同一张图只下载一次', async () => {
  const env = makeEnv('wx:userA')
  env.state.delay = 30
  const results = await Promise.all([
    env.upload.assetToLocalFile('asset:7'),
    env.upload.assetToLocalFile('asset:7'),
    env.upload.assetToLocalFile('asset:7'),
  ])
  assert.equal(env.state.rpcCalls, 1, '三个并发请求应该共用一个下载')
  assert.equal(new Set(results).size, 1, '路径要一致')
})

test('换账号不会命中上一个人的缓存（文件名带账号尾号）', async () => {
  const envA = makeEnv('wx:userA')
  const pathA = await envA.upload.assetToLocalFile('asset:5')
  assert.equal(envA.state.rpcCalls, 1)

  // 同一台设备、同一张图，但换了账号
  const envB = makeEnv('wx:userB')
  envB.files.set(pathA, 'base64') // 上一个人的文件还在磁盘上
  const pathB = await envB.upload.assetToLocalFile('asset:5')

  assert.notEqual(pathA, pathB, '不同账号要各自一份')
  assert.equal(envB.state.rpcCalls, 1, '不能拿上一个人的文件充数')
})

test('退出登录只清本账号的图片缓存', async () => {
  const env = makeEnv('wx:userA')
  const mine = await env.upload.assetToLocalFile('asset:21')
  assert.ok(env.files.has(mine))

  env.upload.clearAssetCache('wx:userA')
  assert.equal(env.files.has(mine), false, '本账号的缓存应被删掉')
})

test('文件被系统清掉后能自动重下（不会一直返回坏路径）', async () => {
  const env = makeEnv('wx:userA')
  const first = await env.upload.assetToLocalFile('asset:30')
  env.files.delete(first) // 模拟微信清理本地文件
  const again = await env.upload.assetToLocalFile('asset:30')
  assert.equal(env.state.rpcCalls, 2, '本地没了就该重新下载')
  assert.ok(env.files.has(again))
})
