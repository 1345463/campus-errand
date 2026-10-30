/**
 * pay-create · 微信支付下单 + 取消退款
 *
 * 双入口兼容：
 *   ① wx.cloud.callFunction（微信云开发环境）—— 自动带 OPENID
 *   ② HTTPS 网关 /api/pay-create（腾讯云 CloudBase）—— 用 wx.login 的 code 换 OPENID
 *
 * 为什么要有 ②：wx.cloud 只能调「微信开发者工具里开通的云开发环境」，
 * 本项目数据层是腾讯云 CloudBase 的 PostgreSQL，两者不是一回事，
 * 所以小程序端走普通 HTTPS 请求。
 *
 * 为什么退款也放在这个函数里（R60）：
 *   退款要用商户私钥做 RSA 签名，而私钥在 CloudBase 上只能看到打码值 ——
 *   新建一个 refund-api 根本没法把密钥配进去。退款和下单用的是同一套凭据，
 *   所以合并进来是唯一能真正跑通的方案，也少一条网关路由。
 *   前端仍按语义调用（PATHS 里 'refund' 指向同一地址），代码里不混。
 *
 * action（不传 = 下单，保持老调用兼容）：
 *   create   下单（= 老行为，参数 code / orderId / amount / notifyUrl）
 *   cancel   发布方取消：待接单直接退款，已接单转协商
 *   respond  接单员回应取消申请
 *   sync     主动查退款结果（回调没到时的兜底）
 *
 * 环境变量：
 *   WXPAY_MCHID / WXPAY_APPID / WXPAY_SERIAL_NO / WXPAY_PRIVATE_KEY / WXPAY_NOTIFY_URL
 *   WX_APP_SECRET  小程序 AppSecret（code 换 openid、验会话令牌）
 *   TCB_ENV_ID / TCB_PUBLISHABLE_KEY  读库
 */
const crypto = require('crypto')
const https = require('https')

const MCHID = process.env.WXPAY_MCHID || ''
const APPID = process.env.WXPAY_APPID || ''
const SERIAL_NO = process.env.WXPAY_SERIAL_NO || ''
const PRIVATE_KEY = (process.env.WXPAY_PRIVATE_KEY || '').replace(/\\n/g, '\n')
const NOTIFY_URL = process.env.WXPAY_NOTIFY_URL || ''
const APP_SECRET = process.env.WX_APP_SECRET || ''
const TCB_ENV = process.env.TCB_ENV_ID || ''
const TCB_KEY = process.env.TCB_PUBLISHABLE_KEY || ''

/**
 * 读 pay_settings.enabled —— 在线支付总闸，超管在后台随时开关。
 *
 * 失败一律按「开」处理（fail-open）：这是个业务开关，不是安全控制。
 * 因为一次监控读超时就停掉所有收款，比「总闸没关成」代价大得多。
 * 但配置缺失（没给 DB 凭据）时同样只放行并留 no-creds 标记，便于排查。
 */
function payGateOpen() {
  if (!TCB_ENV || !TCB_KEY) return Promise.resolve({ open: true, reason: 'no-creds' })
  const body = '{}'
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: TCB_ENV + '.api.tcloudbasegateway.com',
        path: '/v1/rdb/rest/rpc/get_pay_settings',
        method: 'POST',
        timeout: 6000,
        headers: {
          Authorization: 'Bearer ' + TCB_KEY,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = ''
        res.on('data', (c) => { d += c })
        res.on('end', () => {
          try {
            const rows = JSON.parse(d)
            const row = Array.isArray(rows) ? rows[0] : rows
            // 查不到行也放行：宁可收钱，别把用户挡在外面
            resolve({ open: !row || row.enabled !== false, reason: 'db' })
          } catch (e) {
            resolve({ open: true, reason: 'parse' })
          }
        })
      }
    )
    req.on('timeout', () => { req.destroy(); resolve({ open: true, reason: 'timeout' }) })
    req.on('error', () => resolve({ open: true, reason: 'error' }))
    req.write(body)
    req.end()
  })
}

function missingEnv() {
  const miss = []
  if (!MCHID) miss.push('WXPAY_MCHID')
  if (!APPID) miss.push('WXPAY_APPID')
  if (!SERIAL_NO) miss.push('WXPAY_SERIAL_NO')
  if (!PRIVATE_KEY) miss.push('WXPAY_PRIVATE_KEY')
  return miss
}

function sign(message) {
  return crypto.createSign('RSA-SHA256').update(message).sign(PRIVATE_KEY, 'base64')
}

function authHeader(method, urlPath, body) {
  const nonce = crypto.randomBytes(16).toString('hex')
  const ts = Math.floor(Date.now() / 1000)
  const message = `${method}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`
  return `WECHATPAY2-SHA256-RSA2048 mchid="${MCHID}",` +
    `nonce_str="${nonce}",signature="${sign(message)}",` +
    `timestamp="${ts}",serial_no="${SERIAL_NO}"`
}

function wxpayRequest(method, urlPath, bodyObj) {
  const body = bodyObj ? JSON.stringify(bodyObj) : ''
  const headers = {
    Authorization: authHeader(method, urlPath, body),
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'campus-errand/1.0',
  }
  if (body) headers['Content-Length'] = Buffer.byteLength(body)

  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'api.mch.weixin.qq.com', path: urlPath, method, headers, timeout: 10000 },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          let json
          try { json = data ? JSON.parse(data) : {} } catch (e) { json = { raw: data } }
          resolve({ status: res.statusCode, body: json })
        })
      }
    )
    req.on('timeout', () => { req.destroy(new Error('微信支付接口超时')) })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/** wx.login 的 code 换 openid */
function jscode2session(code) {
  return new Promise((resolve, reject) => {
    const qs = 'appid=' + APPID + '&secret=' + APP_SECRET +
      '&js_code=' + encodeURIComponent(code) + '&grant_type=authorization_code'
    const req = https.request(
      { hostname: 'api.weixin.qq.com', path: '/sns/jscode2session?' + qs, method: 'GET', timeout: 8000 },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          let json
          try { json = JSON.parse(data) } catch (e) { json = { raw: data } }
          resolve(json)
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('jscode2session 超时')))
    req.on('error', reject)
    req.end()
  })
}

// ============================================================
// R60 · 取消订单与退款
//
// 金额口径：全额退。下单付款时 mark_order_paid 校验的是
//   round((reward - discount_amount) * 100) 分，这里用同一个数，不多退不少退。
// 幂等：out_refund_no 固定为 RF + 订单号，微信侧同一单号重复提交返回同一笔，
//   所以网络抖动、用户连点、回调重试都不会退两次钱。
// 回调：复用 WXPAY_NOTIFY_URL（pay-notify 里按 event_type 分派 REFUND.*），
//   这样不用再加一条网关路由，也不用把 APIv3 密钥复制到新函数。
// ============================================================

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

/** 校验 app-api 签发的那套会话令牌（HMAC-SHA256，密钥同 WX_APP_SECRET） */
function verifyToken(token) {
  const raw = String(token || '')
  const parts = raw.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1' || !APP_SECRET) return ''
  const expect = b64url(crypto.createHmac('sha256', APP_SECRET).update(parts[1]).digest())
  const a = Buffer.from(expect)
  const b = Buffer.from(parts[2])
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return ''
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'))
    if (!payload || !payload.uid) return ''
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return ''
    return String(payload.uid)
  } catch (e) {
    return ''
  }
}

function httpsJson(host, path, method, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: host, path: path, method: method, timeout: 12000, headers: headers },
      (res) => {
        let d = ''
        res.on('data', (c) => {
          d += c
        })
        res.on('end', () => {
          let json = null
          try {
            json = d ? JSON.parse(d) : null
          } catch (e) {
            json = null
          }
          resolve({ status: res.statusCode, body: json, raw: d })
        })
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error('读库超时'))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/** 带身份调业务 RPC（走 svc_rpc 代持 auth.uid()，函数里的行级校验照常生效） */
async function svcRpc(uid, fn, args) {
  const r = await httpsJson(
    TCB_ENV + '.api.tcloudbasegateway.com',
    '/v1/rdb/rest/rpc/svc_rpc',
    'POST',
    JSON.stringify({ p_uid: uid, p_fn: fn, p_args: args || {} }),
    { Authorization: 'Bearer ' + TCB_KEY, 'Content-Type': 'application/json' }
  )
  if (r.status >= 400) {
    const b = r.body || {}
    throw new Error(b.message || b.hint || b.details || b.error || '调用失败（HTTP ' + r.status + '）')
  }
  return unwrapRpc(r.body)
}

/**
 * 直接调内部函数（svc_ 前缀）：svc_rpc 明确拒绝 svc_ 前缀，
 * 所以这两个只能服务端直连，客户端拿到 publishable key 也调不到。
 */
async function directRpc(fn, args) {
  const r = await httpsJson(
    TCB_ENV + '.api.tcloudbasegateway.com',
    '/v1/rdb/rest/rpc/' + fn,
    'POST',
    JSON.stringify(args || {}),
    { Authorization: 'Bearer ' + TCB_KEY, 'Content-Type': 'application/json' }
  )
  if (r.status >= 400) {
    const b = r.body || {}
    throw new Error(b.message || b.hint || b.details || b.error || '调用失败（HTTP ' + r.status + '）')
  }
  return unwrapRpc(r.body)
}

function unwrapRpc(body) {
  if (Array.isArray(body)) {
    const first = body.length ? body[0] : null
    if (first && typeof first === 'object' && first !== null && 'svc_rpc' in first) return first.svc_rpc
    return body
  }
  if (body && typeof body === 'object' && 'svc_rpc' in body) return body.svc_rpc
  return body
}

/** 把微信的错误码翻成人话；前端弹窗只认这一层 */
function describeWxError(status, body) {
  const b = body || {}
  const code = String(b.code || '')
  const map = {
    NOT_ENOUGH: '商户号可用余额不足，退款暂时发不出去，请稍后重试或联系客服',
    PARAM_ERROR: '退款参数有误，请把这条提示发给管理员',
    INVALID_REQUEST: '微信拒绝了这次退款请求，请联系客服',
    ORDERNOTEXIST: '微信侧查不到这笔支付，请联系客服',
    ORDER_CLOSED: '这笔订单已关闭，无法退款',
    ORDER_PAID_ERROR: '订单支付状态异常，无法退款',
    REFUND_FEE_INVALID: '退款金额与原订单对不上，请联系客服',
    REFUND_NOT_EXIST: '微信侧没有这笔退款记录',
    FREQUENCY_LIMITED: '操作太频繁了，停一会儿再试',
    SYSTEMERROR: '微信支付系统繁忙，请稍后重试',
    NOT_ENABLED: '商户号没有退款权限',
  }
  if (map[code]) return map[code]
  const msg = String(b.message || b.detail || '')
  if (code) return '微信退款失败（' + code + '）' + (msg ? '：' + msg : '')
  return '微信退款失败（HTTP ' + status + '）'
}

function toOrderId(v) {
  const n = Number(v)
  if (!isFinite(n) || n <= 0 || Math.floor(n) !== n) return 0
  if (n > 9007199254740991) return 0
  return n
}

async function markRefundFail(refundNo, reason) {
  try {
    await directRpc('svc_fail_order_refund', { p_refund_no: refundNo, p_reason: reason })
  } catch (e) {
    // 回滚失败也不能把原始错误吞掉；订单会停在 refunding，客服可人工收尾
    console.error('svc_fail_order_refund failed', refundNo, String((e && e.message) || e))
  }
}

/** 真正发起退款：金额与交易号都来自库里刚锁过的那一行，前端传不进来 */
async function doRefund(orderId, row) {
  const fen = Number(row.refund_fen) || 0
  const txn = String(row.txn_id || '')
  const refundNo = 'RF' + orderId
  if (!fen || !txn) {
    return { ok: false, code: 'BAD_REFUND', error: '退款信息不完整（缺金额或微信交易号），请联系客服' }
  }
  if (!NOTIFY_URL) {
    return { ok: false, code: 'NO_NOTIFY_URL', error: '退款回调地址没配置，自动退款暂不可用，请联系客服' }
  }

  let r
  try {
    r = await wxpayRequest('POST', '/v3/refund/domestic/refunds', {
      transaction_id: txn,
      out_refund_no: refundNo,
      reason: '发布方取消订单',
      notify_url: NOTIFY_URL,
      amount: { refund: fen, total: fen, currency: 'CNY' },
    })
  } catch (e) {
    const msg = String((e && e.message) || e || '发起退款失败')
    await markRefundFail(refundNo, msg)
    return { ok: false, code: 'REFUND_FAILED', error: msg }
  }

  if (r.status < 200 || r.status >= 300) {
    const msg = describeWxError(r.status, r.body)
    await markRefundFail(refundNo, msg)
    return {
      ok: false,
      code: 'REFUND_FAILED',
      error: msg,
      wxCode: String((r.body && r.body.code) || ''),
    }
  }

  // 微信状态：SUCCESS 已完成、PROCESSING 已受理。两者都算发起成功，
  // 最终以回调为准 —— 不在这里直接把订单标成 refunded。
  const wxStatus = String((r.body && r.body.status) || '')
  return {
    ok: true,
    status: 'canceling',
    refunding: true,
    refundNo: refundNo,
    wxStatus: wxStatus,
    message: '退款已受理，1~3 个工作日到账',
  }
}

async function doCancel(uid, payload) {
  const orderId = toOrderId(payload.orderId)
  if (!orderId) return { ok: false, code: 'BAD_PARAM', error: '订单号有误' }

  const rows = await svcRpc(uid, 'request_cancel_order', {
    p_order_id: orderId,
    p_reason: String(payload.reason || '').slice(0, 100),
  })
  const row = (rows && rows[0]) || {}
  if (row.result !== 'ok') {
    return {
      ok: false,
      code: 'CANCEL_REJECTED',
      error: row.message || '取消失败',
      status: row.order_status || '',
    }
  }
  // 余额支付的单在库里已经同步退完（钱没进过商户号），状态直接是 canceled。
  // need_wxpay 只有「微信付 + 原路退」才是 true；老库没这列时退回按状态判断。
  if (row.order_status !== 'canceling' || row.need_wxpay === false) {
    return {
      ok: true,
      status: row.order_status,
      refunding: false,
      message: row.message || '',
    }
  }
  return doRefund(orderId, row)
}

async function doRespond(uid, payload) {
  const orderId = toOrderId(payload.orderId)
  if (!orderId) return { ok: false, code: 'BAD_PARAM', error: '订单号有误' }
  const agree = payload.agree === true || payload.agree === 'true' || payload.agree === 1

  const rows = await svcRpc(uid, 'respond_cancel_request', { p_order_id: orderId, p_agree: agree })
  const row = (rows && rows[0]) || {}
  if (row.result !== 'ok') {
    return {
      ok: false,
      code: 'RESPOND_REJECTED',
      error: row.message || '操作失败',
      status: row.order_status || '',
    }
  }
  if (row.order_status !== 'canceling' || row.need_wxpay === false) {
    return {
      ok: true,
      status: row.order_status,
      refunding: false,
      message: row.message || '',
    }
  }
  return doRefund(orderId, row)
}

/** 主动查一次退款结果：回调丢了 / 用户等不及时的兜底 */
async function doSync(uid, payload) {
  const orderId = toOrderId(payload.orderId)
  if (!orderId) return { ok: false, code: 'BAD_PARAM', error: '订单号有误' }
  const refundNo = 'RF' + orderId

  let r
  try {
    r = await wxpayRequest('GET', '/v3/refund/domestic/refunds/' + refundNo, null)
  } catch (e) {
    return { ok: false, code: 'SYNC_FAILED', error: String((e && e.message) || e || '查询退款结果失败') }
  }
  if (r.status === 404) return { ok: false, code: 'REFUND_NOT_EXIST', error: '微信侧还没有这笔退款' }
  if (r.status < 200 || r.status >= 300) {
    return { ok: false, code: 'SYNC_FAILED', error: describeWxError(r.status, r.body) }
  }

  const wxStatus = String((r.body && r.body.status) || '')
  const refundId = String((r.body && r.body.refund_id) || '')
  if (wxStatus === 'SUCCESS' || wxStatus === 'CLOSED') {
    await directRpc('svc_finish_order_refund', {
      p_refund_no: refundNo,
      p_refund_id: refundId,
      p_state: wxStatus,
    })
  }
  return { ok: true, wxStatus: wxStatus, refundId: refundId }
}

async function runRefund(action, payload) {
  const uid = verifyToken(payload.token)
  // 退款是花真金白银的操作，没有有效会话一律不往下走
  if (!uid) return { ok: false, code: 'TOKEN_INVALID', error: '登录状态已失效，请重新进入小程序' }
  if (!TCB_ENV || !TCB_KEY) {
    return { ok: false, code: 'NOT_CONFIGURED', error: '读库配置缺失（TCB_ENV_ID / TCB_PUBLISHABLE_KEY）' }
  }

  try {
    if (action === 'cancel') return await doCancel(uid, payload)
    if (action === 'respond') return await doRespond(uid, payload)
    return await doSync(uid, payload)
  } catch (err) {
    return { ok: false, code: 'REFUND_ERROR', error: String((err && err.message) || err || '退款处理异常') }
  }
}

exports.main = async (event) => {
  const isHttp = !!(event && (event.httpMethod || event.requestContext))
  let payload = event || {}
  if (isHttp && typeof event.body === 'string') {
    try { payload = JSON.parse(event.body || '{}') } catch (e) { payload = {} }
  }

  function done(obj) {
    if (!isHttp) return obj
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(obj),
    }
  }

  try {
    // R60：取消与退款走另一条分支，和下单共用同一套商户凭据。
    // 不传 action 的老调用照旧走下单，前端不用改。
    const action = String(payload.action || '')
    if (action === 'cancel' || action === 'respond' || action === 'sync') {
      return done(await runRefund(action, payload))
    }

    const miss = missingEnv()
    if (miss.length) {
      return done({ ok: false, code: 'ENV_MISSING', error: '云函数环境变量缺失：' + miss.join(', ') })
    }

    // 在线支付总闸（pay_settings.enabled）。放在最前面：关闸时连微信接口都不碰。
    const gate = await payGateOpen()
    if (!gate.open) {
      return done({ ok: false, code: 'PAY_DISABLED', error: '在线支付暂未开放，请稍后再试或联系客服' })
    }

    // ---- 取 openid，三条路按优先级 ----
    let openid = ''

    // ① wx.cloud 上下文（只有当函数跑在微信云开发环境时才有）
    try {
      const cloud = require('wx-server-sdk')
      cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
      openid = (cloud.getWXContext() || {}).OPENID || ''
    } catch (e) {
      // 走 HTTP 路径时这里拿不到，正常
    }

    // ② HTTP 路径：用 wx.login 的 code 换
    if (!openid && payload.code) {
      if (!APP_SECRET) {
        return done({ ok: false, code: 'NO_APP_SECRET', error: '未配置 WX_APP_SECRET，无法用 code 换 openid' })
      }
      const s = await jscode2session(String(payload.code))
      if (s.openid) {
        openid = s.openid
      } else {
        return done({
          ok: false, code: 'CODE_INVALID',
          error: 'code 换 openid 失败：' + (s.errmsg || JSON.stringify(s)),
        })
      }
    }

    // 注意：这里不再接受外部传入的 openid。
    // 之前有个 PAY_ALLOW_TEST_OPENID 调试开关，能让调用方自己指定 __openid，
    // 等于可以伪造任意用户身份下单，已移除。
    if (!openid) {
      return done({ ok: false, code: 'NO_OPENID', error: '缺少身份：小程序端请先 wx.login 拿 code 再调用' })
    }

    const orderId = Number(payload.orderId || 0)
    const amountFen = Math.round(Number(payload.amount || 0) * 100)
    if (!orderId || amountFen <= 0) {
      return done({ ok: false, code: 'BAD_PARAM', error: 'orderId 与 amount 必填，且金额需大于 0' })
    }
    const notifyUrl = payload.notifyUrl || NOTIFY_URL
    if (!notifyUrl) {
      return done({ ok: false, code: 'NO_NOTIFY_URL', error: '缺少支付回调地址' })
    }

    const outTradeNo = `CE${orderId}T${Date.now()}`

    const r = await wxpayRequest('POST', '/v3/pay/transactions/jsapi', {
      appid: APPID,
      mchid: MCHID,
      description: `校园跑腿 订单${orderId}`,
      out_trade_no: outTradeNo,
      notify_url: notifyUrl,
      amount: { total: amountFen, currency: 'CNY' },
      payer: { openid },
    })

    if (r.status !== 200) {
      return done({
        ok: false, code: 'WX_ORDER_FAILED', status: r.status,
        error: (r.body && (r.body.message || r.body.code)) || '下单失败',
        detail: r.body,
      })
    }

    const prepayId = r.body.prepay_id
    const ts = Math.floor(Date.now() / 1000)
    const nonce = crypto.randomBytes(16).toString('hex')
    const paySign = sign(`${APPID}\n${ts}\n${nonce}\nprepay_id=${prepayId}\n`)

    return done({
      ok: true,
      outTradeNo,
      payParams: {
        timeStamp: String(ts),
        nonceStr: nonce,
        package: 'prepay_id=' + prepayId,
        signType: 'RSA',
        paySign,
      },
    })
  } catch (e) {
    return done({ ok: false, code: 'EXCEPTION', error: e.message })
  }
}
