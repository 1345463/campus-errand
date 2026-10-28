/**
 * pay-notify · 微信支付结果回调（HTTP 函数）
 *
 * 微信会 POST 过来：{ id, event_type, resource: { ciphertext, nonce, associated_data } }
 * 流程：验签（平台证书）→ 解密（APIv3 密钥）→ 解析商户单号 → 调 PG 的 mark_order_paid 落库
 *
 * 环境变量：
 *   WXPAY_MCHID / WXPAY_APPID / WXPAY_SERIAL_NO / WXPAY_PRIVATE_KEY   （与 pay-create 相同）
 *   WXPAY_API_V3_KEY      APIv3 密钥，解回调和拉平台证书都要用
 *   PAY_WEBHOOK_SECRET    与 PG pay_settings.webhook_secret 一致，防止伪造
 *   TCB_ENV_ID            环境 ID（ceshi-d2g37cbg7c8f7ee48）
 *   TCB_PUBLISHABLE_KEY   调 CloudBase PG 的 PostgREST 用
 *
 * 重要：微信只认 HTTP 200 + {"code":"SUCCESS"}，否则会重试 8 次。
 *      业务层错误（订单不存在等）也返回 200，只在日志里记，避免无意义重试。
 */
const crypto = require('crypto')
const https = require('https')

const APPID = process.env.WXPAY_APPID || ''
const MCHID = process.env.WXPAY_MCHID || ''
const SERIAL_NO = process.env.WXPAY_SERIAL_NO || ''
const PRIVATE_KEY = (process.env.WXPAY_PRIVATE_KEY || '').replace(/\\n/g, '\n')
const API_V3_KEY = process.env.WXPAY_API_V3_KEY || ''
const WEBHOOK_SECRET = process.env.PAY_WEBHOOK_SECRET || ''
const TCB_ENV = process.env.TCB_ENV_ID || ''
const TCB_KEY = process.env.TCB_PUBLISHABLE_KEY || ''
// 微信支付公钥模式（2024 年后新商户默认）：用固定公钥验签，不拉平台证书
const PUBLIC_KEY = (process.env.WXPAY_PUBLIC_KEY || '').replace(/\\n/g, '\n')
const PUBLIC_KEY_ID = process.env.WXPAY_PUBLIC_KEY_ID || ''

let certCache = { at: 0, map: {} }

function resp(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj),
  }
}

/** AES-256-GCM 解密（APIv3 回调 / 平台证书都用它） */
function gcmDecrypt(ciphertext, nonce, aad) {
  const buf = Buffer.from(ciphertext, 'base64')
  const tag = buf.subarray(buf.length - 16)
  const data = buf.subarray(0, buf.length - 16)
  const d = crypto.createDecipheriv('aes-256-gcm', API_V3_KEY, nonce)
  d.setAuthTag(tag)
  if (aad) d.setAAD(Buffer.from(aad))
  return Buffer.concat([d.update(data), d.final()]).toString('utf8')
}

function sign(message) {
  return crypto.createSign('RSA-SHA256').update(message).sign(PRIVATE_KEY, 'base64')
}

function wxpayRequest(method, urlPath) {
  const nonce = crypto.randomBytes(16).toString('hex')
  const ts = Math.floor(Date.now() / 1000)
  const message = `${method}\n${urlPath}\n${ts}\n${nonce}\n\n`
  const auth = `WECHATPAY2-SHA256-RSA2048 mchid="${MCHID}",` +
    `nonce_str="${nonce}",signature="${sign(message)}",` +
    `timestamp="${ts}",serial_no="${SERIAL_NO}"`
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.mch.weixin.qq.com',
      path: urlPath,
      method,
      headers: { Authorization: auth, Accept: 'application/json', 'User-Agent': 'campus-errand/1.0' },
      timeout: 8000,
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        let json = {}
        try { json = data ? JSON.parse(data) : {} } catch (e) { json = { raw: data } }
        resolve({ status: res.statusCode, body: json })
      })
    })
    req.on('timeout', () => req.destroy(new Error('请求微信超时')))
    req.on('error', reject)
    req.end()
  })
}

/** 拉微信平台证书（内存缓存 6 小时），用于回调验签 */
async function platformCerts() {
  if (Date.now() - certCache.at < 6 * 3600 * 1000 && Object.keys(certCache.map).length) {
    return certCache.map
  }
  const r = await wxpayRequest('GET', '/v3/certificates')
  if (r.status !== 200) {
    // 公钥模式下这个接口本来就没有证书（404），返回空 map 交给上层给出「公钥ID不匹配」的明确提示
    if (PUBLIC_KEY && r.status === 404) return {}
    throw new Error('拉平台证书失败：' + r.status + ' ' + JSON.stringify(r.body))
  }
  const map = {}
  for (const it of (r.body.data || [])) {
    const c = it.encrypt_certificate || {}
    map[it.serial_no] = gcmDecrypt(c.ciphertext, c.nonce, c.associated_data)
  }
  // 微信新商户可能启用「公钥模式」，此时 /v3/certificates 返回空数组
  if (!Object.keys(map).length && !PUBLIC_KEY) {
    throw new Error('平台证书列表为空：该商户可能使用「微信支付公钥」模式，需配 WXPAY_PUBLIC_KEY')
  }
  certCache = { at: Date.now(), map }
  return map
}

async function verifySignature(headers, rawBody) {
  const get = (k) => headers[k] || headers[k.toLowerCase()] || headers[k.toUpperCase()] || ''
  const serial = get('Wechatpay-Serial')
  const sig = get('Wechatpay-Signature')
  const ts = get('Wechatpay-Timestamp')
  const nonce = get('Wechatpay-Nonce')
  if (!serial || !sig || !ts || !nonce) return { ok: false, why: '缺少签名头' }
  // 防重放：时间戳偏离超过 5 分钟直接拒
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return { ok: false, why: '时间戳过期' }

  const msg = `${ts}\n${nonce}\n${rawBody}\n`

  // ① 微信支付公钥模式（新商户）：Wechatpay-Serial 头里是 PUB_KEY_ID_xxx
  if (PUBLIC_KEY && PUBLIC_KEY_ID && serial === PUBLIC_KEY_ID) {
    const ok = crypto.createVerify('RSA-SHA256').update(msg).verify(PUBLIC_KEY, sig, 'base64')
    return { ok, why: ok ? '' : '公钥验签不匹配' }
  }

  // ② 平台证书模式（老商户）：按 serial 匹配证书验签
  const certs = await platformCerts()
  const cert = certs[serial]
  if (!cert) {
    return {
      ok: false,
      why: PUBLIC_KEY
        ? `证书模式与公钥不匹配：serial=${serial}，已配公钥ID=${PUBLIC_KEY_ID}`
        : '平台证书未找到 serial=' + serial,
    }
  }
  const ok = crypto.createVerify('RSA-SHA256').update(msg).verify(cert, sig, 'base64')
  return { ok, why: ok ? '' : '签名不匹配' }
}

/** 调 CloudBase PG 的 PostgREST RPC */
function callRpc(fnName, bodyObj) {
  const body = JSON.stringify(bodyObj)
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: `${TCB_ENV}.api.tcloudbasegateway.com`,
      path: `/v1/rdb/rest/rpc/${fnName}`,
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + TCB_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 8000,
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        let json = {}
        try { json = data ? JSON.parse(data) : {} } catch (e) { json = { raw: data } }
        resolve({ status: res.statusCode, body: json })
      })
    })
    req.on('timeout', () => req.destroy(new Error('RPC 超时')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/** CE<orderId>T<timestamp> → orderId */
function parseOrderId(outTradeNo) {
  const m = /^CE(\d+)T\d+$/.exec(String(outTradeNo || ''))
  return m ? Number(m[1]) : 0
}

exports.main = async (event) => {
  const rawBody = typeof event.body === 'string' ? event.body : JSON.stringify(event.body || {})
  const headers = event.headers || {}

  if (!API_V3_KEY) return resp(500, { code: 'FAIL', message: 'WXPAY_API_V3_KEY 未配置' })
  if (PUBLIC_KEY_ID && !PUBLIC_KEY) {
    return resp(500, {
      code: 'FAIL',
      message: '已配 WXPAY_PUBLIC_KEY_ID，但缺 WXPAY_PUBLIC_KEY（商户平台下载的 pub_key.pem 全文）',
    })
  }

  // 1. 验签
  let v
  try {
    v = await verifySignature(headers, rawBody)
  } catch (e) {
    console.error('verify error', e.message)
    // 诊断期临时返回原因（含 status / 微信返回体），定位完改回通用文案
    return resp(500, { code: 'FAIL', message: '验签异常', detail: e.message })
  }
  if (!v.ok) {
    console.error('signature rejected:', v.why)
    // 诊断期带上原因；稳定后可去掉 detail
    return resp(401, { code: 'FAIL', message: '签名验证失败', detail: v.why })
  }

  // 2. 解密
  let plain
  try {
    const payload = JSON.parse(rawBody)
    if (payload.event_type !== 'TRANSACTION.SUCCESS') {
      return resp(200, { code: 'SUCCESS', message: '非支付成功事件，忽略' })
    }
    const r = payload.resource || {}
    plain = JSON.parse(gcmDecrypt(r.ciphertext, r.nonce, r.associated_data))
  } catch (e) {
    console.error('decrypt error', e.message)
    return resp(500, { code: 'FAIL', message: '解密失败' })
  }

  // 3. 落库
  try {
    const orderId = parseOrderId(plain.out_trade_no)
    if (!orderId) {
      console.error('unrecognized out_trade_no', plain.out_trade_no)
      return resp(200, { code: 'SUCCESS', message: '无法识别的商户单号' })
    }
    if (plain.trade_state !== 'SUCCESS') {
      return resp(200, { code: 'SUCCESS', message: '非成功状态：' + plain.trade_state })
    }
    const amount = plain.amount || {}
    // 用 payer_total（用户实付，含优惠）比对；没有就退回 total
    const paidFen = Number(amount.payer_total || amount.total || 0)

    if (!TCB_ENV || !TCB_KEY) {
      console.error('TCB_ENV_ID / TCB_PUBLISHABLE_KEY 未配置，无法落库')
      return resp(500, { code: 'FAIL', message: '落库配置缺失' })
    }

    const r = await callRpc('mark_order_paid', {
      p_order_id: orderId,
      p_txn_id: plain.transaction_id,
      p_amount_fen: paidFen,
      p_secret: WEBHOOK_SECRET,
    })

    const row = (r.body && r.body[0]) || {}
    console.log('mark_order_paid', orderId, r.status, JSON.stringify(row))

    if (r.status !== 200) {
      return resp(500, { code: 'FAIL', message: '落库接口异常：' + r.status })
    }
    if (row.ok !== true) {
      // 业务失败不重试，但要能被日志发现
      console.error('mark_order_paid rejected:', row.reason)
      return resp(200, { code: 'SUCCESS', message: '已接收（业务未通过：' + (row.reason || '') + '）' })
    }
  } catch (e) {
    console.error('persist error', e.message)
    return resp(500, { code: 'FAIL', message: '落库异常' })
  }

  return resp(200, { code: 'SUCCESS', message: '成功' })
}
