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
  'ai-api': '/api/ai-api',
  // 取消与退款：和下单是同一个云函数（商户私钥只配在它上面），
  // 这里用独立名字是为了让页面层看起来仍是「退款通道」，别混进下单逻辑
  refund: '/api/pay-create',
}

// true = 网关可用；false = 本次启动只走云函数通道
let gatewayUsable = true

function isNetworkError(errMsg) {
  return /url not in domain list|不在以下 request 合法域名|request:fail|ERR_/i.test(String(errMsg || ''))
}

/**
 * 网络失败分两种，处理方式不能一样：
 *   · **确定性**：域名没配白名单、云开发被授权给服务商 —— 再试也不会变，
 *     本次启动内就不该再撞；撞一次白等一个往返。
 *   · **临时性**：超时、5xx、连接被重置 —— 只让这一次退到云函数通道，
 *     下个请求还试直连。否则用户在电梯里丢一次包，整场会话都走慢通道。
 */
function isPermanentFailure(errMsg) {
  return /url not in domain list|不在以下 request 合法域名|-601034|已授权服务商使用云开发资源/i.test(
    String(errMsg || '')
  )
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
        const raw = res.data
        // 网关层（HTTP 访问服务）自己的错误**不是** { ok:false, error }，
        // 而是 { code, message }。最典型的一条：请求体超过 100KB →
        // HTTP 413 {"code":"EXCEED_MAX_PAYLOAD_SIZE"}。
        // 这条必须认出来：一来别把英文 code 直接弹给用户，
        // 二来要打上 payloadTooLarge，让上传逻辑切到分片通道。
        const code = raw && typeof raw === 'object' ? String(raw.code || '') : ''
        if (res.statusCode === 413 || /EXCEED_MAX_PAYLOAD_SIZE/i.test(code)) {
          const err = new Error(
            '单次传输超过网关上限（100KB）。图片会自动分片重试，若反复出现请换一张小点的图'
          )
          err.payloadTooLarge = true
          reject(err)
          return
        }
        // 5xx 是**网关自己挂了**（缩容到 0 冷启动、滚动发布、后端超时），
        // 响应体往往是一页 HTML 或空串，根本没有 data.ok。
        // 以前这里会掉到下面的 else，报一句「调用失败」且不标 _network，
        // 于是既不切云函数通道、日志里也看不出是网关的问题。
        // （同一类坑 R64 在 withdraw-api 上刚踩过：503 被记成 ok:true。）
        if (res.statusCode >= 500) {
          const err = new Error('服务网关暂时不可用（HTTP ' + res.statusCode + '），已自动切换通道重试')
          err._network = true
          err._transient = true
          err.statusCode = res.statusCode
          reject(err)
          return
        }
        const data = raw || {}
        if (data.ok) {
          data._via = 'gateway'
          resolve(data)
        } else if (data.code || data.error) {
          reject(new Error(data.error || data.code))
        } else {
          // 2xx/4xx 但既没有 ok 也没有 code/error：把状态码带出来，
          // 否则排查时只剩「调用失败」四个字。
          const err = new Error('调用失败（HTTP ' + res.statusCode + '，响应体无法识别）')
          err.statusCode = res.statusCode
          reject(err)
        }
      },
      fail: function (e) {
        const err = new Error(e.errMsg || '网络请求失败')
        err._network = isNetworkError(e.errMsg)
        err._permanent = isPermanentFailure(e.errMsg)
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
        const raw = String((e && e.errMsg) || '')
        const err = new Error(describeCloudError(raw))
        err._network = true
        // 让上层知道「是太大，不是网络坏了」—— 图片上传靠这个标记改走分片
        if (/EXCEED_MAX_PAYLOAD_SIZE/i.test(raw)) err.payloadTooLarge = true
        reject(err)
      },
    })
  })
}

// 云函数通道的原始报错是一串大写英文，直接弹给用户看不懂。
// 这里只翻译确定的那几条，其余原样透出（保留排查线索）。
function describeCloudError(errMsg) {
  const raw = String(errMsg || '云开发调用失败')
  if (/EXCEED_MAX_PAYLOAD_SIZE/i.test(raw)) return '图片太大，单次传不下，请换一张小点的图'
  if (/-501000|could not be found/i.test(raw)) return '云函数没部署或名字不对，请联系管理员'
  // -601034：小程序把云开发资源授权给了服务商（托管/第三方平台），管理员自己就用不了云开发
  if (/-601034|没有权限，请先开通云开发|已授权服务商使用云开发资源/i.test(raw)) {
    return '兜底通道（云开发）不可用，请检查网关域名是否已在 request 合法域名里'
  }
  if (/-601003|env.*not.*exist|环境不存在/i.test(raw)) return '云开发环境不存在或已失效，兜底通道已停用'
  if (/timed out|timeout/i.test(raw)) return '云函数超时，请稍后重试'
  return raw
}

function call(target, payload) {
  if (!gatewayUsable) return viaCloud(target, payload)
  return new Promise(function (resolve, reject) {
    viaGateway(target, payload).then(resolve, function (err) {
      if (!err._network) {
        reject(err)
        return
      }
      // 域名没配白名单这类**确定性**失败，才值得在本次启动内永久放弃直连；
      // 超时、5xx 只让这一次退到云函数通道，下个请求仍然先试直连 ——
      // 否则一次电梯里丢包，整场会话都挂在慢通道上。
      if (err._permanent) gatewayUsable = false
      viaCloud(target, payload).then(resolve, function (e2) {
        // 两条通道都失败：把网关那条的真实原因拼进去。
        // 原来这里固定 reject(err)，云函数通道的报错被整个丢掉，
        // 用户只看到「请求超时」，看不出兜底通道到底怎么了。
        const msg = String((e2 && e2.message) || '')
        if (e2 && msg) e2.message = err.message + '；兜底通道：' + msg
        reject(e2 || err)
      })
    })
  })
}

/**
 * 调某个云函数，自动带上会话令牌（没有令牌就照发，由服务端决定要不要放行）。
 * callApi 是它在 app-api 上的特例。
 */
function callTarget(target, payload) {
  const session = readSession()
  const body = Object.assign({}, payload || {})
  if (session && session.token) body.token = session.token
  return call(target, body)
}

/**
 * 调 app-api（登录 / 带身份执行业务 RPC）。
 * payload 里自带 action，其余字段原样透传。
 */
function callApi(action, payload) {
  return callTarget('api', Object.assign({ action: action }, payload || {}))
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
  callTarget: callTarget,
  rpc: rpc,
  readSession: readSession,
  saveSession: saveSession,
  GATEWAY: GATEWAY,
}
