/**
 * pay-create · 微信支付 JSAPI 下单
 *
 * 双入口兼容：
 *   ① wx.cloud.callFunction（微信云开发环境）—— 自动带 OPENID
 *   ② HTTPS 网关 /api/pay-create（腾讯云 CloudBase）—— 用 wx.login 的 code 换 OPENID
 *
 * 为什么要有 ②：wx.cloud 只能调「微信开发者工具里开通的云开发环境」，
 * 本项目数据层是腾讯云 CloudBase 的 PostgreSQL，两者不是一回事，
 * 所以小程序端走普通 HTTPS 请求。
 *
 * 环境变量：
 *   WXPAY_MCHID / WXPAY_APPID / WXPAY_SERIAL_NO / WXPAY_PRIVATE_KEY / WXPAY_NOTIFY_URL
 *   WX_APP_SECRET  小程序 AppSecret（code 换 openid 用）
 */
const crypto = require('crypto')
const https = require('https')

const MCHID = process.env.WXPAY_MCHID || ''
const APPID = process.env.WXPAY_APPID || ''
const SERIAL_NO = process.env.WXPAY_SERIAL_NO || ''
const PRIVATE_KEY = (process.env.WXPAY_PRIVATE_KEY || '').replace(/\\n/g, '\n')
const NOTIFY_URL = process.env.WXPAY_NOTIFY_URL || ''
const APP_SECRET = process.env.WX_APP_SECRET || ''

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
    const miss = missingEnv()
    if (miss.length) {
      return done({ ok: false, code: 'ENV_MISSING', error: '云函数环境变量缺失：' + miss.join(', ') })
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
