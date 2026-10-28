/**
 * transfer-notify · 商家转账结果回调（Event + 网关路由）
 *
 * 微信在用户确认收款（或转账失败）后 POST 过来，报文结构同支付回调：
 *   { event_type: "MCHTRANSFER.BILL", resource: { ciphertext, nonce, associated_data } }
 * 解密后关键字段：out_bill_no / transfer_bill_no / state / fail_reason
 *
 * state 分支：
 *   SUCCESS    → 标记提现成功
 *   FAIL       → 标记失败并退款
 *   CANCELLED  → 用户放弃/超时，同样退款
 *   CANCELING  → 中间态，忽略，等终态
 *
 * 环境变量与 pay-notify 一致（多一个都不用少）：
 *   WXPAY_MCHID / WXPAY_APPID / WXPAY_SERIAL_NO / WXPAY_PRIVATE_KEY
 *   WXPAY_API_V3_KEY / WXPAY_PUBLIC_KEY_ID / WXPAY_PUBLIC_KEY
 *   PAY_WEBHOOK_SECRET / TCB_ENV_ID / TCB_PUBLISHABLE_KEY
 */
const crypto = require('crypto')
const https = require('https')

const APPID = process.env.WXPAY_APPID || ''
const MCHID = process.env.WXPAY_MCHID || ''
const SERIAL_NO = process.env.WXPAY_SERIAL_NO || ''
const PRIVATE_KEY = (process.env.WXPAY_PRIVATE_KEY || '').replace(/\\n/g, '\n')
const API_V3_KEY = process.env.WXPAY_API_V3_KEY || ''
const PUBLIC_KEY = (process.env.WXPAY_PUBLIC_KEY || '').replace(/\\n/g, '\n')
const PUBLIC_KEY_ID = process.env.WXPAY_PUBLIC_KEY_ID || ''
const SECRET = process.env.PAY_WEBHOOK_SECRET || ''
const TCB_ENV = process.env.TCB_ENV_ID || ''
const TCB_KEY = process.env.TCB_PUBLISHABLE_KEY || ''

let certCache = { at: 0, map: {} }

function resp(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj),
  }
}

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

function httpsJson(hostname, path, method, bodyStr, headers) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers)
    if (bodyStr) h['Content-Length'] = Buffer.byteLength(bodyStr)
    const req = https.request({ hostname, path, method, headers: h, timeout: 10000 }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        let json = {}
        try { json = data ? JSON.parse(data) : {} } catch (e) { json = { raw: data } }
        resolve({ status: res.statusCode, body: json })
      })
    })
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

function wxpayRequest(method, urlPath) {
  const nonce = crypto.randomBytes(16).toString('hex')
  const ts = Math.floor(Date.now() / 1000)
  const message = `${method}\n${urlPath}\n${ts}\n${nonce}\n\n`
  const auth = `WECHATPAY2-SHA256-RSA2048 mchid="${MCHID}",` +
    `nonce_str="${nonce}",signature="${sign(message)}",` +
    `timestamp="${ts}",serial_no="${SERIAL_NO}"`
  return httpsJson('api.mch.weixin.qq.com', urlPath, method, '', {
    Authorization: auth,
    Accept: 'application/json',
    'User-Agent': 'campus-errand/1.0',
  })
}

async function platformCerts() {
  if (Date.now() - certCache.at < 6 * 3600 * 1000 && Object.keys(certCache.map).length) {
    return certCache.map
  }
  const r = await wxpayRequest('GET', '/v3/certificates')
  if (r.status !== 200) {
    if (PUBLIC_KEY && r.status === 404) return {}
    throw new Error('拉平台证书失败：' + r.status + ' ' + JSON.stringify(r.body))
  }
  const map = {}
  for (const it of (r.body.data || [])) {
    const c = it.encrypt_certificate || {}
    map[it.serial_no] = gcmDecrypt(c.ciphertext, c.nonce, c.associated_data)
  }
  if (!Object.keys(map).length && !PUBLIC_KEY) {
    throw new Error('平台证书列表为空：该商户可能使用「微信支付公钥」模式')
  }
  return map
}

async function verifySignature(headers, rawBody) {
  const get = (k) => headers[k] || headers[k.toLowerCase()] || headers[k.toUpperCase()] || ''
  const serial = get('Wechatpay-Serial')
  const sig = get('Wechatpay-Signature')
  const ts = get('Wechatpay-Timestamp')
  const nonce = get('Wechatpay-Nonce')
  if (!serial || !sig || !ts || !nonce) return { ok: false, why: '缺少签名头' }
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return { ok: false, why: '时间戳过期' }

  const msg = `${ts}\n${nonce}\n${rawBody}\n`

  // 公钥模式（新商户）：serial 就是 PUB_KEY_ID_xxx
  if (PUBLIC_KEY && PUBLIC_KEY_ID && serial === PUBLIC_KEY_ID) {
    const ok = crypto.createVerify('RSA-SHA256').update(msg).verify(PUBLIC_KEY, sig, 'base64')
    return { ok, why: ok ? '' : '公钥验签不匹配' }
  }

  const certs = await platformCerts()
  const cert = certs[serial]
  if (!cert) return { ok: false, why: '证书未找到 serial=' + serial }
  const ok = crypto.createVerify('RSA-SHA256').update(msg).verify(cert, sig, 'base64')
  return { ok, why: ok ? '' : '签名不匹配' }
}

function callRpc(fnName, bodyObj) {
  const body = JSON.stringify(bodyObj)
  return httpsJson(`${TCB_ENV}.api.tcloudbasegateway.com`, `/v1/rdb/rest/rpc/${fnName}`, 'POST', body, {
    Authorization: 'Bearer ' + TCB_KEY,
    'Content-Type': 'application/json',
  })
}

/** WD<withdrawId>T<timestamp> → withdrawId */
function parseWithdrawId(outBillNo) {
  const m = /^WD(\d+)T\d+$/.exec(String(outBillNo || ''))
  return m ? Number(m[1]) : 0
}

exports.main = async (event) => {
  const rawBody = typeof event.body === 'string' ? event.body : JSON.stringify(event.body || {})
  const headers = event.headers || {}

  if (!API_V3_KEY) return resp(500, { code: 'FAIL', message: 'WXPAY_API_V3_KEY 未配置' })

  let v
  try {
    v = await verifySignature(headers, rawBody)
  } catch (e) {
    console.error('verify error', e.message)
    return resp(500, { code: 'FAIL', message: '验签异常', detail: e.message })
  }
  if (!v.ok) {
    console.error('signature rejected:', v.why)
    return resp(401, { code: 'FAIL', message: '签名验证失败', detail: v.why })
  }

  let plain
  try {
    const payload = JSON.parse(rawBody)
    if (payload.event_type !== 'MCHTRANSFER.BILL') {
      return resp(200, { code: 'SUCCESS', message: '非转账事件，忽略' })
    }
    const r = payload.resource || {}
    plain = JSON.parse(gcmDecrypt(r.ciphertext, r.nonce, r.associated_data))
  } catch (e) {
    console.error('decrypt error', e.message)
    return resp(500, { code: 'FAIL', message: '解密失败' })
  }

  try {
    const withdrawId = parseWithdrawId(plain.out_bill_no)
    if (!withdrawId) {
      console.error('unrecognized out_bill_no', plain.out_bill_no)
      return resp(200, { code: 'SUCCESS', message: '无法识别的转账单号' })
    }

    const state = String(plain.state || '').toUpperCase()
    const billNo = plain.transfer_bill_no || plain.out_bill_no || ''

    if (state === 'SUCCESS') {
      const r = await callRpc('admin_finish_withdrawal', {
        p_id: withdrawId, p_success: true, p_batch_id: billNo, p_reason: null,
      })
      console.log('withdraw success', withdrawId, r.status, JSON.stringify(r.body))
      return resp(200, { code: 'SUCCESS', message: '成功' })
    }

    if (state === 'FAIL' || state === 'CANCELLED') {
      const reason = plain.fail_reason || (state === 'CANCELLED' ? '用户取消或超时' : '转账失败')
      const r = await callRpc('admin_finish_withdrawal', {
        p_id: withdrawId, p_success: false, p_batch_id: null, p_reason: reason,
      })
      console.log('withdraw failed+refund', withdrawId, state, JSON.stringify(r.body))
      return resp(200, { code: 'SUCCESS', message: '已处理' })
    }

    // CANCELING / ACCEPTED 等中间态：先应下来，等终态回调
    console.log('withdraw intermediate', withdrawId, state)
    return resp(200, { code: 'SUCCESS', message: '中间态已记录' })
  } catch (e) {
    console.error('persist error', e.message)
    return resp(500, { code: 'FAIL', message: '落库异常', detail: e.message })
  }
}
