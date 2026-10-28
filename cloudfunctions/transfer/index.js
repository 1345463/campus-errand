/**
 * transfer · 商家转账到零钱（提现执行）
 *
 * 调用方：管理后台（带 secret）。小程序端不直接调，避免有人伪造提现。
 *
 * 流程：校验 secret → PG transfer_prepare（取单+锁单，返回 openid 和金额）→
 *      调微信 mch-transfer 创建转账单 → 返回 package_info 给前端拉起确认页
 *      → 用户确认 → 微信回调 transfer-notify → 最终态
 *
 * 环境变量：
 *   WXPAY_MCHID / WXPAY_APPID / WXPAY_SERIAL_NO / WXPAY_PRIVATE_KEY
 *   WXPAY_TRANSFER_SCENE   商家转账场景 ID（商户平台「商家转账」里查，佣金报酬常见 1000）
 *   WXPAY_TRANSFER_NOTIFY  转账回调地址（可选）
 *   PAY_WEBHOOK_SECRET     与 PG pay_settings.webhook_secret 一致
 *   TCB_ENV_ID / TCB_PUBLISHABLE_KEY
 */
const crypto = require('crypto')
const https = require('https')

const APPID = process.env.WXPAY_APPID || ''
const MCHID = process.env.WXPAY_MCHID || ''
const SERIAL_NO = process.env.WXPAY_SERIAL_NO || ''
const PRIVATE_KEY = (process.env.WXPAY_PRIVATE_KEY || '').replace(/\\n/g, '\n')
const TRANSFER_SCENE = process.env.WXPAY_TRANSFER_SCENE || '1000'
const TRANSFER_NOTIFY = process.env.WXPAY_TRANSFER_NOTIFY || ''
const SECRET = process.env.PAY_WEBHOOK_SECRET || ''
const TCB_ENV = process.env.TCB_ENV_ID || ''
const TCB_KEY = process.env.TCB_PUBLISHABLE_KEY || ''

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

function wxpayRequest(method, urlPath, bodyObj) {
  const body = bodyObj ? JSON.stringify(bodyObj) : ''
  const nonce = crypto.randomBytes(16).toString('hex')
  const ts = Math.floor(Date.now() / 1000)
  const message = `${method}\n${urlPath}\n${ts}\n${nonce}\n${body}\n`
  const auth = `WECHATPAY2-SHA256-RSA2048 mchid="${MCHID}",` +
    `nonce_str="${nonce}",signature="${sign(message)}",` +
    `timestamp="${ts}",serial_no="${SERIAL_NO}"`
  return httpsJson('api.mch.weixin.qq.com', urlPath, method, body, {
    Authorization: auth,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'campus-errand/1.0',
  })
}

function callRpc(fnName, bodyObj) {
  const body = JSON.stringify(bodyObj)
  return httpsJson(`${TCB_ENV}.api.tcloudbasegateway.com`, `/v1/rdb/rest/rpc/${fnName}`, 'POST', body, {
    Authorization: 'Bearer ' + TCB_KEY,
    'Content-Type': 'application/json',
  })
}

exports.main = async (event) => {
  try {
    const miss = []
    if (!MCHID) miss.push('WXPAY_MCHID')
    if (!APPID) miss.push('WXPAY_APPID')
    if (!SERIAL_NO) miss.push('WXPAY_SERIAL_NO')
    if (!PRIVATE_KEY) miss.push('WXPAY_PRIVATE_KEY')
    if (!SECRET) miss.push('PAY_WEBHOOK_SECRET')
    if (!TCB_ENV) miss.push('TCB_ENV_ID')
    if (!TCB_KEY) miss.push('TCB_PUBLISHABLE_KEY')
    if (miss.length) return { ok: false, code: 'ENV_MISSING', error: '环境变量缺失：' + miss.join(', ') }

    // 1. 调用方鉴权：必须是管理端（带 secret）
    if (String(event.secret || '') !== SECRET) {
      return { ok: false, code: 'FORBIDDEN', error: 'secret 不匹配' }
    }
    // 1.5 调试：探测云函数公网出口 IP
    // 商家转账接口有「调用 IP 白名单」校验，需要知道云函数实际出口 IP 才能去商户平台配置。
    // 需要在 secret 校验之后，避免被外部随意探测。验证完可保留（无副作用）。
    if (event.__probe === 'ip') {
      let txt = ''
      try {
        txt = await fetch('https://api.ipify.org?format=json').then((r) => r.text())
      } catch (e) {
        try {
          txt = await fetch('https://myip.ipip.net').then((r) => r.text())
        } catch (e2) {
          txt = 'probe failed: ' + e.message + ' / ' + e2.message
        }
      }
      return { ok: true, probe: 'egress_ip', result: String(txt).trim().slice(0, 200) }
    }

    const withdrawId = Number(event.withdrawId || 0)
    if (!withdrawId) return { ok: false, code: 'BAD_PARAM', error: 'withdrawId 必填' }

    // 2. 取单 + 锁单
    const prep = await callRpc('transfer_prepare', { p_id: withdrawId, p_secret: SECRET })
    const p = (prep.body && prep.body[0]) || {}
    if (prep.status !== 200) {
      return { ok: false, code: 'PREPARE_FAILED', error: '取单接口异常：' + prep.status, detail: prep.body }
    }
    if (p.ok !== true) {
      return { ok: false, code: 'PREPARE_REJECTED', error: p.reason || '取单未通过' }
    }

    // 3. 创建转账单
    const outBillNo = `WD${withdrawId}T${Date.now()}`
    const payload = {
      appid: APPID,
      out_bill_no: outBillNo,
      transfer_scene_id: TRANSFER_SCENE,
      openid: p.openid,
      transfer_amount: Number(p.amount_fen),
      transfer_remark: '校园跑腿提现',
    }
    if (TRANSFER_NOTIFY) payload.notify_url = TRANSFER_NOTIFY

    const r = await wxpayRequest('POST', '/v3/fund-app/mch-transfer/transfer-bills', payload)

    // 4. 失败 → 立刻退款并置 failed
    if (r.status !== 200) {
      const msg = (r.body && (r.body.message || r.body.code)) || ('HTTP ' + r.status)
      await callRpc('admin_finish_withdrawal', {
        p_id: withdrawId, p_success: false, p_batch_id: null, p_reason: msg,
      })
      return { ok: false, code: 'WX_TRANSFER_FAILED', status: r.status, error: msg, detail: r.body }
    }

    // 5. 成功创建：state 可能是 ACCEPTED（已到账）或 WAIT_USER_CONFIRM（需用户确认）
    const state = r.body.state || ''
    if (state === 'ACCEPTED' || state === 'SUCCESS') {
      await callRpc('admin_finish_withdrawal', {
        p_id: withdrawId, p_success: true,
        p_batch_id: r.body.transfer_bill_no || outBillNo, p_reason: null,
      })
    }

    return {
      ok: true,
      outBillNo,
      transferBillNo: r.body.transfer_bill_no || '',
      state,
      // WAIT_USER_CONFIRM 时前端要拿这个拉起确认页
      packageInfo: r.body.package_info || '',
    }
  } catch (e) {
    return { ok: false, code: 'EXCEPTION', error: e.message }
  }
}
