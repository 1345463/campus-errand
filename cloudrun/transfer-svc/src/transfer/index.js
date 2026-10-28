/**
 * 商家转账服务（跑在云托管上）
 *
 * 为什么单独跑一个云托管服务：
 *   微信支付的商家转账接口校验「调用方 IP」，而云函数的出口 IP 每次都变。
 *   云托管服务使用环境级的「固定访问公网的出口 IP」，把那个 IP 填进
 *   微信支付商户平台的白名单后，转账才能通过。
 *
 * 调用方：云函数 transfer（管理端触发），不对外暴露。
 */
const crypto = require('crypto')
const https = require('https')
const http = require('http')

const APPID = process.env.WXPAY_APPID || ''
const MCHID = process.env.WXPAY_MCHID || ''
const SERIAL_NO = process.env.WXPAY_SERIAL_NO || ''
const PRIVATE_KEY = (process.env.WXPAY_PRIVATE_KEY || '').replace(/\\n/g, '\n')
const TRANSFER_SCENE = process.env.WXPAY_TRANSFER_SCENE || '1000'
// 用户收款感知：选填。文案必须是微信支持的措辞，传错会报
// 「暂不支持展示当前传入的用户收款感知」，所以默认不传，需要时用环境变量显式指定。
const PERCEPTION = process.env.WXPAY_TRANSFER_PERCEPTION || ''
// 场景报备信息（新版接口必填，不同场景 ID 要求不同字段，可用环境变量覆盖）
// 场景 1005（佣金报酬）固定要求这两条，不能换成"活动名称/奖励说明"（那是现金营销场景的）
const REPORT_DEFAULT = [
  { info_type: '岗位类型', info_content: '校园跑腿接单员' },
  { info_type: '报酬说明', info_content: '接单赏金提现' },
]
const REPORT_INFOS = (function () {
  try {
    const raw = process.env.WXPAY_TRANSFER_REPORT
    if (!raw) return REPORT_DEFAULT
    const v = JSON.parse(raw)
    return Array.isArray(v) && v.length ? v : REPORT_DEFAULT
  } catch (e) {
    return REPORT_DEFAULT
  }
})()
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
    const req = https.request({ hostname, path, method, headers: h, timeout: 12000 }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        let json = {}
        try { json = data ? JSON.parse(data) : {} } catch (e) { json = { raw: String(data).slice(0, 500) } }
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

function restGet(path) {
  return httpsJson(`${TCB_ENV}.api.tcloudbasegateway.com`, path, 'GET', '', {
    Authorization: 'Bearer ' + TCB_KEY,
    'Content-Type': 'application/json',
  })
}

// 按商户单号查微信转账单状态（GET，签名里 body 为空）
function queryBill(outBillNo) {
  const path = '/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/' + encodeURIComponent(outBillNo)
  const nonce = crypto.randomBytes(16).toString('hex')
  const ts = Math.floor(Date.now() / 1000)
  const message = `GET\n${path}\n${ts}\n${nonce}\n\n`
  const auth = `WECHATPAY2-SHA256-RSA2048 mchid="${MCHID}",` +
    `nonce_str="${nonce}",signature="${sign(message)}",` +
    `timestamp="${ts}",serial_no="${SERIAL_NO}"`
  return httpsJson('api.mch.weixin.qq.com', path, 'GET', '', {
    Authorization: auth,
    Accept: 'application/json',
    'User-Agent': 'campus-errand/1.0',
  })
}

const IPS = [
  'http://myip.ipip.net',
  'https://api.ipify.org?format=json',
  'https://myip.ipip.net',
  'http://ip-api.com/json',
]

function fetchText(url) {
  const mod = url.indexOf('https:') === 0 ? https : http
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { timeout: 8000 }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => resolve(String(d || '').trim()))
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
  })
}

function pickIp(text) {
  const m = String(text).match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/)
  return m ? m[0] : String(text).slice(0, 60)
}

// 探测本服务的公网出口 IP：用它去微信支付商户平台配白名单
async function egressIp() {
  const tried = []
  for (const url of IPS) {
    try {
      const t = await fetchText(url)
      const ip = pickIp(t)
      if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        return { ip: ip, source: url }
      }
      tried.push(url + ' -> ' + ip)
    } catch (e) {
      tried.push(url + ' -> ' + e.message)
    }
  }
  return { ip: '', source: 'all_failed', tried: tried }
}

function parseBody(event) {
  if (!event) return {}
  if (event.body) {
    let raw = event.body
    if (event.isBase64Encoded && typeof raw === 'string') {
      raw = Buffer.from(raw, 'base64').toString('utf8')
    }
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) } catch (e) { return {} }
    }
    return raw || {}
  }
  return event
}

exports.main = async function (event, context) {
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

    const p = parseBody(event)
    const action = String(p.action || '')

    // 探测出口 IP：白名单配置用，只返回 IP，不泄露环境 ID 或密钥
    if (action === 'probe') {
      return { ok: true, egressIp: await egressIp() }
    }

    // 兜底同步：微信回调不一定能到（验签/网络/重试耗尽），主动查一次真实状态。
    // 后台刷新列表时调用，保证 processing 的单子最终一致。
    if (action === 'sync') {
      if (String(p.secret || '') !== SECRET) {
        return { ok: false, code: 'FORBIDDEN', error: 'secret 不匹配' }
      }
      const list = await restGet(
        '/v1/rdb/rest/withdraw_requests?select=id,amount,out_bill_no&status=eq.processing&out_bill_no=not.is.null&limit=20')
      const rows = Array.isArray(list.body) ? list.body : []
      const out = []
      for (const w of rows) {
        const q = await queryBill(w.out_bill_no)
        const st = q.status === 200 ? String(q.body.state || '').toUpperCase() : ''
        if (st === 'SUCCESS') {
          await callRpc('admin_finish_withdrawal', {
            p_id: w.id, p_success: true,
            p_batch_id: q.body.transfer_bill_no || w.out_bill_no, p_reason: null,
          })
          out.push({ id: w.id, state: st, synced: true })
        } else if (st === 'FAIL' || st === 'CANCELLED') {
          await callRpc('admin_finish_withdrawal', {
            p_id: w.id, p_success: false, p_batch_id: null,
            p_reason: q.body.fail_reason || (st === 'CANCELLED' ? '用户超时未确认，已退回' : '转账失败'),
          })
          out.push({ id: w.id, state: st, synced: true })
        } else {
          out.push({ id: w.id, state: st || ('HTTP ' + q.status), synced: false })
        }
      }
      return { ok: true, checked: rows.length, results: out }
    }

    if (action !== 'transfer') {
      return { ok: false, code: 'BAD_ACTION', error: '未知 action：' + (action || '(空)') }
    }

    if (String(p.secret || '') !== SECRET) {
      return { ok: false, code: 'FORBIDDEN', error: 'secret 不匹配' }
    }

    const withdrawId = Number(p.withdrawId || 0)
    if (!withdrawId) return { ok: false, code: 'BAD_PARAM', error: 'withdrawId 必填' }

    // 1. 取单 + 锁单
    const prep = await callRpc('transfer_prepare', { p_id: withdrawId, p_secret: SECRET })
    const row = (prep.body && prep.body[0]) || {}
    if (prep.status !== 200) {
      return { ok: false, code: 'PREPARE_FAILED', error: '取单接口异常：' + prep.status, detail: prep.body }
    }
    if (row.ok !== true) {
      return { ok: false, code: 'PREPARE_REJECTED', error: row.reason || '取单未通过' }
    }

    // 2. 创建转账单
    const outBillNo = `WD${withdrawId}T${Date.now()}`
    const payload = {
      appid: APPID,
      out_bill_no: outBillNo,
      transfer_scene_id: TRANSFER_SCENE,
      openid: row.openid,
      transfer_amount: Number(row.amount_fen),
      transfer_remark: '校园跑腿提现',
      transfer_scene_report_infos: REPORT_INFOS,
    }
    if (PERCEPTION) payload.user_recv_perception = PERCEPTION
    if (TRANSFER_NOTIFY) payload.notify_url = TRANSFER_NOTIFY

    const r = await wxpayRequest('POST', '/v3/fund-app/mch-transfer/transfer-bills', payload)

    // 3. 失败：立刻退款并置 failed
    if (r.status !== 200) {
      const msg = (r.body && (r.body.message || r.body.code)) || ('HTTP ' + r.status)
      await callRpc('admin_finish_withdrawal', {
        p_id: withdrawId, p_success: false, p_batch_id: null, p_reason: msg,
      })
      return { ok: false, code: 'WX_TRANSFER_FAILED', status: r.status, error: msg, detail: r.body }
    }

    // 4. 先把单号和 package 落库（WAIT_USER_CONFIRM 时用户要靠它拉起确认页）
    const state = r.body.state || ''
    await callRpc('svc_save_transfer_result', {
      p_id: withdrawId,
      p_out_bill_no: outBillNo,
      p_bill_no: r.body.transfer_bill_no || '',
      p_package_info: r.body.package_info || '',
    })

    // 5. 已经终态的直接标记完成；WAIT_USER_CONFIRM 交给回调 / sync 兜底
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
      packageInfo: r.body.package_info || '',
    }
  } catch (e) {
    return { ok: false, code: 'EXCEPTION', error: e.message }
  }
}
