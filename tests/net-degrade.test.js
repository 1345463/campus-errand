/**
 * 网络层降级策略（R65）
 *
 * 两个真问题：
 *   ① 网关返 5xx（缩容到 0 冷启动 / 滚动发布）时，响应体是 HTML 或空串，
 *      原来会掉到「既不 ok 也没有 code」的 else，报一句「调用失败」且不标
 *      _network —— 于是既不切云函数通道，日志里也看不出是网关挂了。
 *   ② 一次超时就把 gatewayUsable 永久置 false，整场会话都走慢通道。
 *      用户在电梯里丢一次包，后面每次请求都先吃一次云函数的冷启动。
 *
 * 这里用假 wx 真跑一遍，钉住：
 *   · 5xx 算网络失败 → 本次退到云函数，但**下次仍然先试直连**
 *   · 域名白名单 / 云开发被代持这类确定性失败 → 本次启动不再试直连
 *   · 业务错误（余额不足等）绝不换通道 —— 换了会重复下单 / 重复扣款
 *   · 两条通道都挂时，错误信息里要能看见网关那条的原因
 *   · 413 要打 payloadTooLarge，上传逻辑靠它切分片
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const TCB_PATH = require.resolve(path.join(__dirname, '..', 'utils', 'tcb.js'))

/** 每个用例都拿一份干净的 tcb（模块里有 gatewayUsable 这种运行期状态） */
function loadTcb(stub) {
  global.wx = stub
  delete require.cache[TCB_PATH]
  return require(TCB_PATH)
}

function makeStub(handlers) {
  const calls = { gateway: 0, cloud: 0 }
  const stub = {
    calls: calls,
    request: function (opts) {
      calls.gateway += 1
      handlers.gateway(opts, calls.gateway)
    },
    cloud: {
      callFunction: function (opts) {
        calls.cloud += 1
        handlers.cloud(opts, calls.cloud)
      },
    },
    getStorageSync: function () {
      return null
    },
    setStorageSync: function () {},
    removeStorageSync: function () {},
  }
  return stub
}

test('网关 5xx 时退到云函数，但下一个请求仍然先试直连', async () => {
  const stub = makeStub({
    gateway: function (opts) {
      opts.success({ statusCode: 503, data: '<html>503 Service Temporarily Unavailable</html>' })
    },
    cloud: function (opts) {
      opts.success({ result: { ok: true, data: { from: 'cloud' } } })
    },
  })
  const tcb = loadTcb(stub)

  const first = await tcb.call('api', {})
  assert.equal(first.data.from, 'cloud', '5xx 应该已经切到云函数通道')
  assert.equal(stub.calls.gateway, 1)
  assert.equal(stub.calls.cloud, 1)

  const second = await tcb.call('api', {})
  assert.equal(second.data.from, 'cloud')
  assert.equal(stub.calls.gateway, 2, '临时失败不能永久降级，下次还要试直连')
})

test('域名没配白名单这类确定性失败，本次启动不再撞直连', async () => {
  const stub = makeStub({
    gateway: function (opts) {
      opts.fail({ errMsg: 'request:fail url not in domain list' })
    },
    cloud: function (opts) {
      opts.success({ result: { ok: true, data: { from: 'cloud' } } })
    },
  })
  const tcb = loadTcb(stub)

  await tcb.call('api', {})
  assert.equal(stub.calls.gateway, 1)
  assert.equal(stub.calls.cloud, 1)

  await tcb.call('api', {})
  assert.equal(stub.calls.gateway, 1, '确定性失败后不该再试直连')
  assert.equal(stub.calls.cloud, 2)
})

test('超时只降级本次，不永久改道', async () => {
  const stub = makeStub({
    gateway: function (opts) {
      opts.fail({ errMsg: 'request:fail timeout' })
    },
    cloud: function (opts) {
      opts.success({ result: { ok: true, data: { from: 'cloud' } } })
    },
  })
  const tcb = loadTcb(stub)

  await tcb.call('api', {})
  assert.equal(stub.calls.gateway, 1)
  await tcb.call('api', {})
  assert.equal(stub.calls.gateway, 2, '超时属于临时失败，下次仍然先试直连')
})

test('业务错误绝不换通道（换通道会重复下单 / 重复扣款）', async () => {
  const stub = makeStub({
    gateway: function (opts) {
      opts.success({ statusCode: 200, data: { ok: false, error: '余额不足' } })
    },
    cloud: function (opts) {
      opts.success({ result: { ok: true, data: { from: 'cloud' } } })
    },
  })
  const tcb = loadTcb(stub)

  await assert.rejects(tcb.call('api', {}), /余额不足/)
  assert.equal(stub.calls.cloud, 0, '业务错误不该去打兜底通道')
})

test('两条通道都挂时，错误里要带上网关那条的原因', async () => {
  const stub = makeStub({
    gateway: function (opts) {
      opts.success({ statusCode: 503, data: '' })
    },
    cloud: function (opts) {
      opts.fail({ errMsg: 'cloud.callFunction:fail -501000' })
    },
  })
  const tcb = loadTcb(stub)

  await assert.rejects(tcb.call('api', {}), function (err) {
    assert.match(err.message, /网关暂时不可用/)
    assert.match(err.message, /兜底通道/)
    return true
  })
})

test('413 打上 payloadTooLarge，上传逻辑靠它切分片', async () => {
  const stub = makeStub({
    gateway: function (opts) {
      opts.success({ statusCode: 413, data: { code: 'EXCEED_MAX_PAYLOAD_SIZE' } })
    },
    cloud: function (opts) {
      opts.success({ result: { ok: true } })
    },
  })
  const tcb = loadTcb(stub)

  await assert.rejects(tcb.call('api', {}), function (err) {
    assert.equal(err.payloadTooLarge, true)
    return true
  })
})

test('网关成功时打上 _via=gateway，云函数成功时打 _via=cloud', async () => {
  const okStub = makeStub({
    gateway: function (opts) {
      opts.success({ statusCode: 200, data: { ok: true, data: 1 } })
    },
    cloud: function (opts) {
      opts.success({ result: { ok: true, data: 2 } })
    },
  })
  const tcb1 = loadTcb(okStub)
  assert.equal((await tcb1.call('api', {}))._via, 'gateway')
  assert.equal(okStub.calls.cloud, 0)

  const cloudStub = makeStub({
    gateway: function (opts) {
      opts.fail({ errMsg: 'request:fail url not in domain list' })
    },
    cloud: function (opts) {
      opts.success({ result: { ok: true, data: 2 } })
    },
  })
  const tcb2 = loadTcb(cloudStub)
  assert.equal((await tcb2.call('api', {}))._via, 'cloud')
})
