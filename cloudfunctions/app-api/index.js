/**
 * app-api · 新后端（CloudBase ceshi 环境）对外统一入口
 *
 * 为什么要有这一层：
 *   小程序的 request 合法域名配不了（试用小程序没有后台），前端没法直连网关，
 *   只能走 wx.cloud.callFunction('tcb-proxy') 中转。中转之后「调用者是谁」
 *   就不能再靠客户端声明了 —— 所以这里用 wx.login 的 code 换 openid，
 *   换出来之后签一个短期令牌，之后每次调用服务端自己验签，拿到可信 uid。
 *
 * 安全设计：
 *   · openid 只从 code 换，绝不接受调用方直接传 openid（传了就是可伪造身份）
 *   · 令牌用 HMAC-SHA256 签名，密钥取 WX_APP_SECRET（服务端独有），
 *     验签用 timingSafeEqual，且 uid 必须是 wx: 开头 —— 与库侧 svc_rpc 对齐
 *   · 真正的读写都由 svc_rpc 带着 auth.uid() 执行，业务函数里的行级校验照常生效
 *
 * action:
 *   login           { code }                 → { ok, uid, token, profile }
 *   rpc             { token, fn, args }      → { ok, data }
 *   sendPhoneCode   { token, phone }         → { ok }
 *   bindPhone       { token, phone, code }   → { ok, data }
 *
 * 后两个不走 rpc：验证码明文要由云函数拿去发短信，绑定又必须「验码 + 写入」
 * 一次做完，都只能在这一层编排，不能让客户端自己挑函数调。
 *
 * 环境变量：TCB_ENV_ID / TCB_PUBLISHABLE_KEY / WXPAY_APPID / WX_APP_SECRET
 *          四个都在 pay-create、withdraw-api 上配过了，不用新增。
 * 短信（腾讯云 SMS，可选）：SMS_SECRET_ID / SMS_SECRET_KEY / SMS_SDK_APP_ID /
 *          SMS_TEMPLATE_ID / SMS_SIGN_NAME。没配满就只发码不发短信，
 *          前端会收到「短信通道未开通」，不会假装发送成功。
 */
const https = require('https')
const crypto = require('crypto')

const TCB_ENV = process.env.TCB_ENV_ID || ''
const TCB_KEY = process.env.TCB_PUBLISHABLE_KEY || ''
const APPID = process.env.WXPAY_APPID || ''
const APP_SECRET = process.env.WX_APP_SECRET || ''

const SMS_ID = process.env.SMS_SECRET_ID || ''
const SMS_KEY = process.env.SMS_SECRET_KEY || ''
const SMS_APP = process.env.SMS_SDK_APP_ID || ''
const SMS_TPL = process.env.SMS_TEMPLATE_ID || ''
const SMS_SIGN = process.env.SMS_SIGN_NAME || ''

// 令牌有效期。到期后前端静默 wx.login 换新的，用户无感。
const TOKEN_TTL_SEC = 30 * 24 * 3600

/**
 * 游客可读的公开接口。
 *
 * 首页轮播、功能开关、任务大厅、FAQ 这些在登录前就要能看，所以留一个匿名通道。
 * 匿名时用固定 uid 'wx:anonymous' 调 svc_rpc —— 业务函数里凡是按 auth.uid()
 * 过滤「我的数据」的查询，对这个人一律返回空，拿不到任何人的东西。
 *
 * 只放只读的公开接口。任何「我的 xxx」、写操作都不在这个名单里，
 * 它们本来就必须带令牌（见下面的 TOKEN_INVALID）。
 */
const PUBLIC_FNS = [
  'list_banners',
  'list_feature_flags',
  'get_faq_settings',
  'get_pay_settings',
  'list_hall_orders',
  'list_point_goods',
  'list_rental_items',
  'list_faq_items',
  'get_public_asset',
  'get_order_detail',
  'get_order_reviews',
  'order_relation',
  'order_peer_credit',
]
const ANON_UID = 'wx:anonymous'

// 只能由本函数编排、不允许客户端直接 rpc 的函数。
// issue_phone_code 会把验证码明文返回来；bind_my_phone* 是写绑定，
// 放开就等于「跳过发码直接绑号」，旧实现的那条残余风险正是这么来的。
const SERVER_ONLY_FNS = ['issue_phone_code', 'bind_my_phone_verified', 'bind_my_phone']

function httpsJson(hostname, path, method, bodyStr, headers) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers)
    if (bodyStr) h['Content-Length'] = Buffer.byteLength(bodyStr)
    const req = https.request(
      { hostname, path, method, headers: h, timeout: 20000 },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          let json = {}
          try { json = data ? JSON.parse(data) : {} } catch (e) { json = { raw: data } }
          resolve({ status: res.statusCode, body: json })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

function codeToOpenid(code) {
  const p = `/sns/jscode2session?appid=${APPID}&secret=${APP_SECRET}` +
    `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`
  return httpsJson('api.weixin.qq.com', p, 'GET', '').then((r) => (r.body && r.body.openid) || '')
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function signToken(uid) {
  const now = Math.floor(Date.now() / 1000)
  const payload = b64url(Buffer.from(JSON.stringify({ uid, iat: now, exp: now + TOKEN_TTL_SEC })))
  const sig = b64url(crypto.createHmac('sha256', APP_SECRET).update(payload).digest())
  return 'v1.' + payload + '.' + sig
}

function verifyToken(token) {
  const raw = String(token || '')
  const parts = raw.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return ''
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

// ---------- 腾讯云短信（TC3-HMAC-SHA256 手工签名，不引第三方包）----------
//
// 云函数部署只传代码、不装依赖，所以这里照 pay-create 的做法自己签。
// 算法见腾讯云 API 3.0 文档：规范请求串 → 待签串 → 四级密钥派生。
function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

function hmacSha256(key, s) {
  return crypto.createHmac('sha256', key).update(s).digest()
}

function smsConfigured() {
  return !!(SMS_ID && SMS_KEY && SMS_APP && SMS_TPL && SMS_SIGN)
}

/**
 * 是不是超级管理员。
 *
 * 只在一个地方用到：短信没开通时，给超管开一条「把验证码直接取出来」的调试通道。
 * 之所以不做成环境变量开关 —— 开关要人记得关，而这条分支的条件是
 * 「短信没配好」，短信一配好它自己就失效了，不存在忘记关的问题。
 */
async function isSuperAdmin(uid) {
  try {
    const rows = await svcRpc(uid, 'admin_my_perms', {})
    const list = Array.isArray(rows) ? rows : []
    for (let i = 0; i < list.length; i++) {
      if (String((list[i] && list[i].perm_key) || '') === 'super') return true
    }
  } catch (e) {
    console.error('[app-api] admin_my_perms failed', e.message)
  }
  return false
}

function sendSms(phone, code) {
  const host = 'sms.tencentcloudapi.com'
  const action = 'SendSms'
  const body = {
    PhoneNumberSet: ['+86' + phone],
    SmsSdkAppId: SMS_APP,
    SignName: SMS_SIGN,
    TemplateId: SMS_TPL,
    TemplateParamSet: [String(code), '10'],
  }
  const payload = JSON.stringify(body)
  const now = Math.floor(Date.now() / 1000)
  const date = new Date(now * 1000).toISOString().slice(0, 10)
  const canonicalHeaders =
    'content-type:application/json\nhost:' + host + '\nx-tc-action:' + action.toLowerCase() + '\n'
  const signedHeaders = 'content-type;host;x-tc-action'
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256hex(payload)].join('\n')
  const scope = date + '/sms/tc3_request'
  const stringToSign = ['TC3-HMAC-SHA256', String(now), scope, sha256hex(canonicalRequest)].join('\n')
  const kDate = hmacSha256('TC3' + SMS_KEY, date)
  const kService = hmacSha256(kDate, 'sms')
  const kSign = hmacSha256(kService, 'tc3_request')
  const signature = crypto.createHmac('sha256', kSign).update(stringToSign).digest('hex')
  const auth =
    'TC3-HMAC-SHA256 Credential=' + SMS_ID + '/' + scope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature

  return httpsJson(host, '/', 'POST', payload, {
    'Content-Type': 'application/json',
    Host: host,
    'X-TC-Action': action,
    'X-TC-Version': '2021-01-11',
    'X-TC-Timestamp': String(now),
    Authorization: auth,
  }).then(function (r) {
    const resp = (r.body && r.body.Response) || {}
    const item = (resp.SendStatusSet && resp.SendStatusSet[0]) || {}
    if (item.Code && String(item.Code) !== 'Ok') {
      throw new Error('短信发送失败：' + (item.Message || item.Code))
    }
    if (r.status >= 400 && !item.Code) {
      throw new Error('短信发送失败（HTTP ' + r.status + '）')
    }
    return true
  })
}

/**
 * 带身份调用 svc_rpc。
 * 返回三种形态里的一种：数组（集合返回）/ 标量（boolean、int）/ null（void）。
 * 出错统一抛 Error，由上层包成 { ok:false }。
 */
async function svcRpc(uid, fn, args) {
  const r = await httpsJson(
    `${TCB_ENV}.api.tcloudbasegateway.com`,
    '/v1/rdb/rest/rpc/svc_rpc',
    'POST',
    JSON.stringify({ p_uid: uid, p_fn: fn, p_args: args || {} }),
    { Authorization: 'Bearer ' + TCB_KEY, 'Content-Type': 'application/json' }
  )
  if (r.status >= 400) {
    const b = r.body || {}
    throw new Error(b.message || b.hint || b.details || b.error || ('调用失败（HTTP ' + r.status + '）'))
  }
  // 返回形态不统一，三种都要认：
  //   · 集合返回 → PostgREST 直接把 svc_rpc 的 json 数组当响应体（没有外层包装）
  //   · 标量返回 → 也可能是 [{ "svc_rpc": 8 }] 这种带列名的包装
  //   · 个别版本会给裸标量
  let value
  if (Array.isArray(r.body)) {
    const first = r.body.length ? r.body[0] : null
    value = first && typeof first === 'object' && first !== null && 'svc_rpc' in first
      ? first.svc_rpc
      : r.body
  } else if (r.body && typeof r.body === 'object' && 'svc_rpc' in r.body) {
    value = r.body.svc_rpc
  } else {
    value = r.body
  }
  return value === undefined ? null : value
}

exports.main = async (event) => {
  const isHttp = !!(event && (event.httpMethod || event.requestContext))
  const done = (obj) =>
    isHttp
      ? { statusCode: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(obj) }
      : obj

  const miss = []
  if (!TCB_ENV) miss.push('TCB_ENV_ID')
  if (!TCB_KEY) miss.push('TCB_PUBLISHABLE_KEY')
  if (!APPID) miss.push('WXPAY_APPID')
  if (!APP_SECRET) miss.push('WX_APP_SECRET')
  if (miss.length) return done({ ok: false, code: 'ENV_MISSING', error: '环境变量缺失：' + miss.join(', ') })

  let payload = event || {}
  if (isHttp) {
    let raw = event.body || ''
    if (event.isBase64Encoded && raw) raw = Buffer.from(raw, 'base64').toString('utf8')
    try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
  }

  const action = String(payload.action || '')

  try {
    if (action === 'login') {
      const code = String(payload.code || '')
      if (!code) return done({ ok: false, code: 'NO_CODE', error: '缺少 code：小程序端请先 wx.login' })
      const openid = await codeToOpenid(code)
      if (!openid) {
        return done({ ok: false, code: 'NO_OPENID', error: 'code 换 openid 失败，请重新登录后重试' })
      }
      const uid = 'wx:' + openid
      let profile = null
      try {
        const rows = await svcRpc(uid, 'ensure_my_profile', {
          p_nickname: String(payload.nickname || ''),
          p_avatar_url: '',
        })
        profile = Array.isArray(rows) && rows.length ? rows[0] : null
      } catch (e) {
        // 建档失败不阻塞登录：资料可以在「我的」页补，但要把原因留下来
        console.error('[app-api] ensure_my_profile failed', e.message)
      }
      return done({ ok: true, uid, token: signToken(uid), profile })
    }

    if (action === 'rpc') {
      const fn = String(payload.fn || '')
      if (!fn) return done({ ok: false, code: 'BAD_PARAM', error: '缺少 fn' })

      // 有令牌就按令牌里的 uid 走；没令牌只允许 PUBLIC_FNS 里的公开读接口
      let uid = verifyToken(payload.token)
      if (!uid) {
        if (payload.token || PUBLIC_FNS.indexOf(fn) < 0) {
          return done({ ok: false, code: 'TOKEN_INVALID', error: '登录状态已失效，请重新登录' })
        }
        uid = ANON_UID
      }
      if (fn.indexOf('svc_') === 0 || SERVER_ONLY_FNS.indexOf(fn) >= 0) {
        return done({ ok: false, code: 'FORBIDDEN_FN', error: '不允许直接调用内部函数' })
      }
      const data = await svcRpc(uid, fn, payload.args || {})
      return done({ ok: true, data })
    }

    if (action === 'sendPhoneCode') {
      const uid = verifyToken(payload.token)
      if (!uid) return done({ ok: false, code: 'TOKEN_INVALID', error: '登录状态已失效，请重新登录' })
      const phone = String(payload.phone || '').trim()
      if (!/^1[3-9]\d{9}$/.test(phone)) {
        return done({ ok: false, code: 'BAD_PHONE', error: '请输入正确的 11 位手机号' })
      }
      // 没开短信就别发码：发了用户也收不到，还白占一小时的额度。
      // 唯一的例外是超管 —— 短信没配好的这段时间，总得有人能把绑定流程走通，
      // 所以给他把明文码回显出来（前端直接填进输入框）。普通用户一律拒绝。
      const smsOn = smsConfigured()
      if (!smsOn && !(await isSuperAdmin(uid))) {
        return done({ ok: false, code: 'SMS_NOT_CONFIGURED', error: '短信通道未开通，暂时无法绑定手机号，请联系管理员' })
      }
      const rows = await svcRpc(uid, 'issue_phone_code', { p_uid: uid, p_phone: phone })
      const code = Array.isArray(rows) && rows.length ? String(rows[0].code || '') : ''
      if (!code) return done({ ok: false, code: 'NO_CODE', error: '验证码生成失败，请稍后再试' })
      if (smsOn) {
        await sendSms(phone, code)
        return done({ ok: true })
      }
      // 走到这里必然是「短信没开 + 调用者是超管」：把码回显，前端自动填入
      return done({ ok: true, devEcho: true, devCode: code })
    }

    if (action === 'bindPhone') {
      const uid = verifyToken(payload.token)
      if (!uid) return done({ ok: false, code: 'TOKEN_INVALID', error: '登录状态已失效，请重新登录' })
      const data = await svcRpc(uid, 'bind_my_phone_verified', {
        p_phone: String(payload.phone || ''),
        p_code: String(payload.code || ''),
      })
      return done({ ok: true, data })
    }

    return done({ ok: false, code: 'BAD_ACTION', error: '未知的 action：' + (action || '(空)') })
  } catch (e) {
    console.error('[app-api] ' + action + ' failed:', e.message)
    return done({ ok: false, code: 'EXCEPTION', error: e.message || '请求失败' })
  }
}
