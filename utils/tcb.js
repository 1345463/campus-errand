/**
 * 访问新库（CloudBase ceshi 环境）的统一入口
 *
 * 两条通道，默认优先直连网关：
 *   ① 直连网关 HTTPS —— 需要在小程序后台配 request 合法域名（免费，一次配好）。
 *      ceshi 环境的套餐已包含网关与云函数，不额外收费。
 *   ② wx.cloud.callFunction('tcb-proxy') —— 免域名，但需要小程序自己的云开发环境
 *      （可能产生费用）。仅当 ① 网络不通时兜底。
 *
 * 只有「网络层面失败」才换通道重试；业务错误（余额不足、无权限等）直接抛出，
 * 不重试，避免把业务拒绝当成网络问题反复打。
 *
 * 一旦确认直连走不通，本次启动内就固定在云函数通道上：
 * 不然每个接口都要先撞一次域名校验，白等一个往返。
 */
const GATEWAY = 'https://ceshi-d2g37cbg7c8f7ee48-1329559054.ap-shanghai.app.tcloudbase.com'

const PATHS = {
  'pay-create': '/api/pay-create',
  api: '/api/app-api',
  withdraw: '/api/withdraw',
}

// true = 网关可用；false = 本次启动只走云函数通道
let gatewayUsable = true

function isNetworkError(errMsg) {
  return /url not in domain list|不在以下 request 合法域名|request:fail|ERR_/i.test(String(errMsg || ''))
}

function viaGateway(target, payload) {
  return new Promise(function (resolve, reject) {
    const path = PATHS[target]
    if (!path) {
      reject(new Error('未知调用目标：' + target))
      return
    }
    wx.request({
      url: GATEWAY + path,
      method: 'POST',
      header: { 'content-type': 'application/json' },
      data: payload || {},
      success: function (res) {
        const data = res.data || {}
        if (data.ok) {
          data._via = 'gateway'
          resolve(data)
        } else {
          reject(new Error(data.error || data.code || '调用失败'))
        }
      },
      fail: function (e) {
        const err = new Error(e.errMsg || '网络请求失败')
        err._network = isNetworkError(e.errMsg)
        reject(err)
      },
    })
  })
}

function viaCloud(target, payload) {
  return new Promise(function (resolve, reject) {
    if (!(wx.cloud && wx.cloud.callFunction)) {
      reject(new Error('wx.cloud 不可用：请确认已开通云开发环境'))
      return
    }
    wx.cloud.callFunction({
      name: 'tcb-proxy',
      data: Object.assign({}, payload, { target: target }),
      success: function (r) {
        const body = (r && r.result) || {}
        if (body.ok) {
          body._via = 'cloud'
          resolve(body)
        } else {
          reject(new Error(body.error || body.code || '调用失败'))
        }
      },
      fail: function (e) {
        const err = new Error((e && e.errMsg) || '云开发调用失败')
        err._network = true
        reject(err)
      },
    })
  })
}

function call(target, payload) {
  if (!gatewayUsable) return viaCloud(target, payload)
  return new Promise(function (resolve, reject) {
    viaGateway(target, payload).then(resolve, function (err) {
      if (!err._network) {
        reject(err)
        return
      }
      // 域名没配白名单之类的网络问题：这次启动就别再试直连了
      gatewayUsable = false
      viaCloud(target, payload).then(resolve, function () {
        reject(err)
      })
    })
  })
}

/**
 * 调 app-api（登录 / 带身份执行业务 RPC）。
 * payload 里自带 action，其余字段原样透传。
 */
function callApi(action, payload) {
  const session = readSession()
  const body = Object.assign({ action: action }, payload || {})
  if (session && session.token) body.token = session.token
  return call('api', body)
}

// ============================================================
// 会话存储
//
// 放在这一层而不是 api.js 里，是因为图片上传（utils/upload.js）也要带同一个
// 令牌，而 upload 是被 api 依赖的 —— 反过来 require 会成环。
//
// 令牌由服务端 HMAC 签名，端上只负责存和带，改一个字节验签就过不了。
// ============================================================
const SESSION_KEY = 'appSessionV2'
let currentSession = null

function readSession() {
  if (currentSession) return currentSession
  let raw = null
  try {
    raw = wx.getStorageSync(SESSION_KEY)
  } catch (e) {
    raw = null
  }
  currentSession = raw && raw.uid && raw.token ? raw : null
  return currentSession
}

function saveSession(value) {
  currentSession = value || null
  try {
    if (currentSession) wx.setStorageSync(SESSION_KEY, currentSession)
    else wx.removeStorageSync(SESSION_KEY)
  } catch (e) {
    /* 存不下就只在内存里留着，下次启动重新登录 */
  }
}

/**
 * 执行业务 RPC。返回 { data, error } —— 与旧 SDK 的 cloud.database.rpc 完全一致，
 * 所以调用点不用改写法。
 *
 * 没登录时也发请求：首页轮播、功能开关、任务大厅这些是公开读接口，
 * 服务端对它们另有一份白名单（app-api 的 PUBLIC_FNS）。
 */
function rpc(fn, args) {
  const payload = { fn: fn, args: args || {} }
  return new Promise(function (resolve) {
    callApi('rpc', payload).then(
      function (res) {
        resolve({ data: res && res.data !== undefined ? res.data : null, error: null })
      },
      function (e) {
        const error = e instanceof Error ? e : new Error(String((e && e.message) || e || '请求失败'))
        if (/登录状态已失效/.test(error.message)) {
          error.needLogin = true
          saveSession(null)
        }
        resolve({ data: null, error: error })
      }
    )
  })
}

module.exports = {
  call: call,
  callApi: callApi,
  rpc: rpc,
  readSession: readSession,
  saveSession: saveSession,
  GATEWAY: GATEWAY,
}
