/**
 * pay-create · 微信支付 JSAPI 下单
 *
 * 职责：小程序点「支付」→ 调本函数 → 用商户私钥签名调微信下单 → 返回 wx.requestPayment 参数
 *
 * 密钥来源：全部从环境变量读，**不要写死在代码里**（云函数代码可被下载）
 *   WXPAY_MCHID        商户号           1119307371
 *   WXPAY_APPID        小程序 AppID      wxaab192c68e403292
 *   WXPAY_SERIAL_NO    商户证书序列号
 *   WXPAY_PRIVATE_KEY  商户私钥 PEM（apiclient_key.pem 全文，换行可用 \n 转义）
 *   WXPAY_NOTIFY_URL   支付回调地址（云函数 HTTP 触发地址）
 *
 * 零外部依赖：只用 Node 内置 crypto + https，避免云函数装包
 */
const crypto = require('crypto')
const https = require('https')

const MCHID = process.env.WXPAY_MCHID || ''
const APPID = process.env.WXPAY_APPID || ''
const SERIAL_NO = process.env.WXPAY_SERIAL_NO || ''
const PRIVATE_KEY = (process.env.WXPAY_PRIVATE_KEY || '').replace(/\\n/g, '\n')
const NOTIFY_URL = process.env.WXPAY_NOTIFY_URL || ''

function missingEnv() {
  const miss = []
  if (!MCHID) miss.push('WXPAY_MCHID')
  if (!APPID) miss.push('WXPAY_APPID')
  if (!SERIAL_NO) miss.push('WXPAY_SERIAL_NO')
  if (!PRIVATE_KEY) miss.push('WXPAY_PRIVATE_KEY')
  return miss
}

/** 商户私钥签名（RSA-SHA256 → base64） */
function sign(message) {
  return crypto.createSign('RSA-SHA256').update(message).sign(PRIVATE_KEY, 'base64')
}

/** 构造 APIv3 的 Authorization 头 */
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

exports.main = async (event) => {
  try {
    const miss = missingEnv()
    if (miss.length) {
      // 环境变量没配时给出明确提示，而不是抛一个看不懂的错
      return { ok: false, code: 'ENV_MISSING', error: '云函数环境变量缺失：' + miss.join(', ') }
    }

    // 拿调用者 openid —— 必须来自服务端上下文，不能信客户端传的
    let openid = ''
    try {
      const cloud = require('wx-server-sdk')
      cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
      openid = (cloud.getWXContext() || {}).OPENID || ''
    } catch (e) {
      openid = event.__openid || '' // 本地直调测试用
    }
    if (!openid) return { ok: false, code: 'NO_OPENID', error: '拿不到 openid（请从小程序调用）' }

    const orderId = Number(event.orderId || 0)
    const amountFen = Math.round(Number(event.amount || 0) * 100)
    if (!orderId || amountFen <= 0) {
      return { ok: false, code: 'BAD_PARAM', error: 'orderId 与 amount 必填，且金额需大于 0' }
    }
    const notifyUrl = event.notifyUrl || NOTIFY_URL
    if (!notifyUrl) return { ok: false, code: 'NO_NOTIFY_URL', error: '缺少支付回调地址' }

    // 商户订单号：可重入（同一订单重复点支付会生成新的，旧的未支付会自动关闭）
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
      return {
        ok: false,
        code: 'WX_ORDER_FAILED',
        status: r.status,
        error: (r.body && (r.body.message || r.body.code)) || '下单失败',
        detail: r.body,
      }
    }

    // 二次签名：小程序 wx.requestPayment 要的是这一组
    const prepayId = r.body.prepay_id
    const ts = Math.floor(Date.now() / 1000)
    const nonce = crypto.randomBytes(16).toString('hex')
    const paySign = sign(`${APPID}\n${ts}\n${nonce}\nprepay_id=${prepayId}\n`)

    return {
      ok: true,
      outTradeNo,
      payParams: {
        timeStamp: String(ts),
        nonceStr: nonce,
        package: 'prepay_id=' + prepayId,
        signType: 'RSA',
        paySign,
      },
    }
  } catch (e) {
    return { ok: false, code: 'EXCEPTION', error: e.message }
  }
}
