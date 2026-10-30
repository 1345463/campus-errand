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

function wxpayRequest(method, urlPath, bodyObj) {
  const nonce = crypto.randomBytes(16).toString('hex')
  const ts = Math.floor(Date.now() / 1000)
  const body = bodyObj ? JSON.stringify(bodyObj) : ''
  // 签名串第五行是请求体；不带 body 时保持空行（拉证书用的是 GET）
  const message = `${method}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`
  const auth = `WECHATPAY2-SHA256-RSA2048 mchid="${MCHID}",` +
    `nonce_str="${nonce}",signature="${sign(message)}",` +
    `timestamp="${ts}",serial_no="${SERIAL_NO}"`
  const headers = { Authorization: auth, Accept: 'application/json', 'User-Agent': 'campus-errand/1.0' }
  if (body) {
    headers['Content-Type'] = 'application/json'
    headers['Content-Length'] = Buffer.byteLength(body)
  }
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.mch.weixin.qq.com',
      path: urlPath,
      method,
      headers,
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
    req.end(body || undefined)
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

/**
 * 重复支付自动退款
 *
 * 场景：用户点微信支付后，回调还没到又点了「余额支付」，两笔都成功。
 * mark_order_paid 会把这类回调判成 DUPLICATE_PAY（订单已由余额付掉）。
 * 钱既然真收了就必须原路退回 —— 用 out_refund_no = 'RD' + 订单号，
 * 固定单号天然幂等，微信重试回调也不会退两次。
 * 不传 notify_url：这是笔不需要业务状态流转的补退，微信不回调。
 */
async function refundDuplicatePay(orderId, plain) {
  const amount = plain.amount || {}
  const fen = Number(amount.payer_total || amount.total || 0)
  const totalFen = Number(amount.total || fen)
  if (!fen || !totalFen) {
    console.error('dup refund bad amount', orderId, JSON.stringify(amount))
    return { ok: false, why: '金额缺失' }
  }
  const r = await wxpayRequest('POST', '/v3/refund/domestic/refunds', {
    transaction_id: String(plain.transaction_id || ''),
    out_refund_no: 'RD' + orderId,
    reason: '订单已完成支付，重复付款自动退回',
    amount: { refund: fen, total: totalFen, currency: 'CNY' },
  })
  const st = String((r.body && r.body.status) || '')
  if (r.status >= 200 && r.status < 300 && (st === 'SUCCESS' || st === 'PROCESSING')) {
    console.log('dup refund accepted', orderId, r.body.refund_id, st)
    return { ok: true }
  }
  console.error('dup refund failed', orderId, r.status, JSON.stringify(r.body).slice(0, 300))
  return { ok: false, why: st || String(r.status) }
}

/**
 * R60 · 退款回调。
 *
 * 支付和退款共用同一个 notify_url（pay-create 里的 WXPAY_NOTIFY_URL），
 * 靠 event_type 前缀区分：TRANSACTION.* 是收款，REFUND.* 是退款。
 * 三个状态怎么处理写在了 svc_finish_order_refund 里：
 *   SUCCESS  → 订单 refunded + canceled
 *   CLOSED   → 钱没出去，回滚成 paid，用户可重新发起
 *   ABNORMAL → 保持 refunding 留人工，不擅自回滚
 */
async function handleRefundNotify(plain) {
  const refundNo = String(plain.out_refund_no || '')
  const refundId = String(plain.refund_id || '')
  const status = String(plain.refund_status || plain.status || '').toUpperCase()

  if (!refundNo) {
    console.error('refund notify missing out_refund_no', JSON.stringify(plain).slice(0, 300))
    return resp(200, { code: 'SUCCESS', message: '无退款单号，已忽略' })
  }
  // 重复支付的补退单号是 RD+订单号，不经过业务表，收到回调只记日志
  if (refundNo.indexOf('RD') === 0) {
    console.log('dup-pay refund notify', refundNo, status)
    return resp(200, { code: 'SUCCESS', message: '重复支付退款已记录' })
  }
  if (!TCB_ENV || !TCB_KEY) {
    console.error('TCB_ENV_ID / TCB_PUBLISHABLE_KEY 未配置，无法落库')
    return resp(500, { code: 'FAIL', message: '落库配置缺失' })
  }

  const r = await callRpc('svc_finish_order_refund', {
    p_refund_no: refundNo,
    p_refund_id: refundId,
    p_state: status,
  })
  if (r.status >= 400) {
    console.error('svc_finish_order_refund failed', refundNo, r.status, JSON.stringify(r.body).slice(0, 300))
    // 返回 500 让微信重试：这次是库的问题，不是业务问题
    return resp(500, { code: 'FAIL', message: '落库失败' })
  }
  console.log('refund notify', refundNo, status, JSON.stringify(r.body).slice(0, 200))
  return resp(200, { code: 'SUCCESS', message: '成功' })
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

  // 2. 解密 + 按事件类型分派
  let plain
  try {
    const payload = JSON.parse(rawBody)
    const et = String(payload.event_type || '')
    const isRefund = et.indexOf('REFUND.') === 0
    // 只处理收款成功与退款两类；其余事件别去解密（白费一次 AES 还可能报错）
    if (!isRefund && et !== 'TRANSACTION.SUCCESS') {
      return resp(200, { code: 'SUCCESS', message: '非支付成功事件，忽略' })
    }
    const r = payload.resource || {}
    plain = JSON.parse(gcmDecrypt(r.ciphertext, r.nonce, r.associated_data))
    // 退款回调必须排在支付逻辑之前，否则会被当成「非支付事件」直接忽略掉
    if (isRefund) return await handleRefundNotify(plain)
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
      const reason = String(row.reason || '')
      // 重复付款：订单已由余额付掉，但微信这笔钱真收了 → 自动原路退回
      if (reason.indexOf('DUPLICATE_PAY') === 0) {
        const rf = await refundDuplicatePay(orderId, plain)
        if (!rf.ok) {
          // 没受理成功就返 500 让微信重试；同单号幂等，不会退两次
          return resp(500, { code: 'FAIL', message: '重复支付退款未受理：' + rf.why })
        }
        return resp(200, { code: 'SUCCESS', message: '重复支付已自动退款' })
      }
      // 业务失败不重试，但要能被日志发现
      console.error('mark_order_paid rejected:', reason)
      return resp(200, { code: 'SUCCESS', message: '已接收（业务未通过：' + reason + '）' })
    }
  } catch (e) {
    console.error('persist error', e.message)
    return resp(500, { code: 'FAIL', message: '落库异常' })
  }

  return resp(200, { code: 'SUCCESS', message: '成功' })
}
