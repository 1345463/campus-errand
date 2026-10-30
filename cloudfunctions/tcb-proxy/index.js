/**
 * tcb-proxy · 网关转发（部署在「小程序自己的微信云开发环境」）
 *
 * 为什么需要它：
 *   wx.cloud.callFunction 走微信内部通道，不受 request 合法域名白名单限制；
 *   而我们的数据库在另一个腾讯云 CloudBase 环境（ceshi-xxx），
 *   小程序直接 wx.request 过去会被域名白名单拦截（正式版无法放行）。
 *   云函数发请求出网不受白名单限制，所以用云函数当中转。
 *
 * 本函数零配置：不读任何环境变量，转发地址写死在下面。
 * 只暴露白名单内的两个目标，避免被用来转发任意地址。
 *
 * 用法（小程序端）：
 *   wx.cloud.callFunction({
 *     name: 'tcb-proxy',
 *     data: { target: 'pay-create', code, orderId, amount }
 *   })
 *
 * 注意：本函数不持有任何密钥 —— 只有转发地址和白名单。
 * 身份由上游函数各自校验（app-api 用 code 换 openid、pay-create 同理），
 * 所以泄露转发能力也拿不到别人的数据（上限是代发请求，拿不到凭据）。
 */
const https = require('https')

const UPSTREAM = 'ceshi-d2g37cbg7c8f7ee48-1329559054.ap-shanghai.app.tcloudbase.com'

const ALLOW = {
  'pay-create': '/api/pay-create',
  api: '/api/app-api',
  withdraw: '/api/withdraw',
  'ai-api': '/api/ai-api',
  refund: '/api/pay-create',
}

function postJson(path, bodyObj) {
  const body = JSON.stringify(bodyObj || {})
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: UPSTREAM,
        path: path,
        method: 'POST',
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          let json = {}
          try { json = data ? JSON.parse(data) : {} } catch (e) { json = { raw: String(data).slice(0, 500) } }
          resolve({ httpStatus: res.statusCode, body: json })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('转发超时')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

exports.main = async (event) => {
  const payload = event || {}
  const target = String(payload.target || '')
  const path = ALLOW[target]

  if (!path) {
    return {
      ok: false,
      code: 'BAD_TARGET',
      error: '未知转发目标：' + (target || '(空)') + '，可选：' + Object.keys(ALLOW).join(', '),
    }
  }

  // 去掉转发控制字段和 wx.cloud 自动注入的上下文，其余原样透传
  const body = Object.assign({}, payload)
  delete body.target
  delete body.userInfo
  delete body.CLIENTIP

  try {
    const r = await postJson(path, body)
    // 上游网关无论业务成败都返回 200，错误体里带 ok=false，原样回传
    if (r.body && typeof r.body === 'object' && Object.prototype.hasOwnProperty.call(r.body, 'ok')) {
      return r.body
    }
    return { ok: false, code: 'BAD_UPSTREAM', error: '上游返回异常', detail: r.body }
  } catch (e) {
    return { ok: false, code: 'PROXY_FAILED', error: e.message || '转发失败' }
  }
}
