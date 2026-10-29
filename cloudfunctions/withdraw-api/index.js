/**
 * 提现管理 API（供小程序端 + 管理后台调用）
 *
 * 为什么走网关而不是 rpc：提现要写 withdraw_requests 并触发真实打款，
 * 打款依赖只给 service_role 的 svc_* 函数与云托管的固定出口 IP，
 * 客户端一律不许直连表，所以统一走本函数 + HTTPS 网关。
 *
 * action:
 *   summary —— 我的可提现余额 + 门槛 + 提现记录（登录即可）
 *   create  —— 提交提现申请（登录即可；成功后自动转账）
 *   list    —— 提现列表（需 settle/super 权限）
 *   transfer—— 对某笔提现单执行转账（需 settle/super 权限）
 *   finish  —— 标记失败并退款（需 settle/super 权限）
 *
 * 自动转账（R54）：create 成功后直接调云托管转账，不再需要管理员点那一下；
 * 环境变量 AUTO_TRANSFER=0 可关掉退回人工模式，AUTO_TRANSFER_MAX 是自动转账的
 * 单笔上限（默认 200 元），超过的仍留给后台人工确认。
 * summary 也会补转一次「停留在 pending 的历史单」，避免旧单永远没人点。
 *
 * 身份：小程序端 wx.login 拿 code，云函数用 AppSecret 换 openid，再查 admin_grants。
 */
const https = require('https')

const TCB_ENV = process.env.TCB_ENV_ID || ''
const TCB_KEY = process.env.TCB_PUBLISHABLE_KEY || ''
const APPID = process.env.WXPAY_APPID || ''
const APPSECRET = process.env.WX_APP_SECRET || ''
const SECRET = process.env.PAY_WEBHOOK_SECRET || ''
// 转账要走云托管服务：它用环境级的固定出口 IP（微信支付白名单只认这个）
const SVC_HOST = process.env.TRANSFER_SVC_HOST || ''
// 自动转账开关与单笔上限（上限用于风控：小额全自动，大额留人工）
const AUTO_TRANSFER = process.env.AUTO_TRANSFER !== '0'
const AUTO_MAX = Number(process.env.AUTO_TRANSFER_MAX || 200)

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

function rest(method, path, bodyObj) {
  const body = bodyObj ? JSON.stringify(bodyObj) : ''
  return httpsJson(`${TCB_ENV}.api.tcloudbasegateway.com`, path, method, body, {
    Authorization: 'Bearer ' + TCB_KEY,
    'Content-Type': 'application/json',
  })
}

function rpc(fnName, bodyObj) {
  return rest('POST', `/v1/rdb/rest/rpc/${fnName}`, bodyObj || {})
}

async function codeToOpenid(code) {
  const p = `/sns/jscode2session?appid=${APPID}&secret=${APPSECRET}` +
    `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`
  const r = await httpsJson('api.weixin.qq.com', p, 'GET', '')
  return (r.body && r.body.openid) || ''
}

// 判断是否有结算权限：admin_grants 里 owner_id 可能是 'wx:oxxx' 或裸 openid
async function hasSettlePerm(openid) {
  if (!openid) return false
  const keys = ['settle', 'super']
  for (const uid of ['wx:' + openid, openid]) {
    const r = await rest('GET',
      `/v1/rdb/rest/admin_grants?select=perm_key&user_id=eq.${encodeURIComponent(uid)}`)
    const rows = Array.isArray(r.body) ? r.body : []
    if (rows.some((x) => keys.indexOf(x.perm_key) >= 0)) return true
  }
  return false
}

// 确定用户在库里的 owner_id 写法：新库统一 'wx:oXXX'，兼容裸 openid
async function resolveUid(openid) {
  for (const uid of ['wx:' + openid, openid]) {
    const r = await rest('GET',
      `/v1/rdb/rest/profiles?select=owner_id&owner_id=eq.${encodeURIComponent(uid)}&limit=1`)
    if (Array.isArray(r.body) && r.body.length) return uid
  }
  return 'wx:' + openid
}

// 转账要用的共享密钥。优先用环境变量，没配就从库里现读 ——
// pay_settings.webhook_secret 就是当初发给云托管的那个值，两边必须一致，
// 由云函数运行时自己取，密钥不用在控制台之间搬来搬去。
async function getSecret() {
  if (SECRET) return SECRET
  try {
    const r = await rest('GET', '/v1/rdb/rest/pay_settings?select=webhook_secret&id=eq.1&limit=1')
    const row = Array.isArray(r.body) && r.body.length ? r.body[0] : null
    return (row && row.webhook_secret) || ''
  } catch (e) {
    return ''
  }
}

// 调用云托管执行转账。网络层异常吞成结构化结果，调用方决定要不要上报。
// 幂等：transfer_prepare 会把单锁成 processing，重复调用只会拿到同一笔，不会重复打款。
async function doTransfer(id) {
  if (!SVC_HOST) return { ok: false, code: 'ENV_MISSING', error: '未配置 TRANSFER_SVC_HOST' }
  const secret = await getSecret()
  if (!secret) return { ok: false, code: 'ENV_MISSING', error: '拿不到转账密钥（PAY_WEBHOOK_SECRET / pay_settings.webhook_secret）' }
  try {
    const r = await httpsJson(SVC_HOST, '/transfer', 'POST',
      JSON.stringify({ action: 'transfer', secret: secret, withdrawId: id }), {
        'Content-Type': 'application/json',
      })
    const body = (r && r.body) || {}
    if (!body.ok) {
      return {
        ok: false,
        code: body.code || 'TRANSFER_FAILED',
        error: body.error || '转账失败',
        detail: body.detail || null,
      }
    }
    return {
      ok: true,
      state: body.state || '',
      transferBillNo: body.transferBillNo || '',
      packageInfo: body.packageInfo || '',
    }
  } catch (e) {
    return { ok: false, code: 'NETWORK', error: '调用转账服务失败：' + ((e && e.message) || e) }
  }
}

// 自动转账的准入判断：开关开着 + 金额没超上限
function canAuto(amount) {
  return AUTO_TRANSFER && Number(amount || 0) <= AUTO_MAX
}

async function loadNicknames(uids) {
  const map = {}
  const list = uids.filter(Boolean)
  if (!list.length) return map
  const inq = list.map((s) => '"' + String(s).replace(/"/g, '') + '"').join(',')
  const r = await rest('GET',
    `/v1/rdb/rest/profiles?select=owner_id,nickname,owner_name&owner_id=in.(${encodeURIComponent(inq)})`)
  const rows = Array.isArray(r.body) ? r.body : []
  rows.forEach((p) => {
    map[p.owner_id] = p.nickname || p.owner_name || ''
  })
  return map
}

exports.main = async (event) => {
  const isHttp = !!(event && (event.httpMethod || event.requestContext))
  const done = (obj) => (isHttp
    ? { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }
    : obj)

  const miss = []
  if (!TCB_ENV) miss.push('TCB_ENV_ID')
  if (!TCB_KEY) miss.push('TCB_PUBLISHABLE_KEY')
  if (!APPID) miss.push('WXPAY_APPID')
  if (!APPSECRET) miss.push('WX_APP_SECRET')
  if (miss.length) return done({ ok: false, code: 'ENV_MISSING', error: '环境变量缺失：' + miss.join(', ') })

  let payload = event || {}
  if (isHttp) {
    let raw = event.body || ''
    if (event.isBase64Encoded && raw) raw = Buffer.from(raw, 'base64').toString('utf8')
    try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
  }

  const action = String(payload.action || '')
  const code = String(payload.code || '')

  if (!code) return done({ ok: false, code: 'NO_CODE', error: '缺少 code：小程序端请先 wx.login' })
  if (!action) return done({ ok: false, code: 'BAD_PARAM', error: '缺少 action' })

  const openid = await codeToOpenid(code)
  if (!openid) return done({ ok: false, code: 'NO_OPENID', error: 'code 换 openid 失败，请重新登录' })

  // list / finish 是管理端操作，需要 settle/super；
  // summary / create 是普通用户操作，只要求已登录。
  if (action === 'list' || action === 'finish') {
    if (!(await hasSettlePerm(openid))) {
      // 带上 openid 方便把当前账号加进 admin_grants；授权完成后可去掉这段回显
      return done({
        ok: false,
        code: 'FORBIDDEN',
        error: '没有结算权限。当前 openid：' + openid,
        openid: openid,
      })
    }
  }

  // 我的可提现余额 + 门槛 + 最近提现记录
  if (action === 'summary') {
    // 同上：先兜底同步一次真实状态（用户确认收款后要能立刻看到变化）
    const sec = await getSecret()
    if (SVC_HOST && sec) {
      try {
        await httpsJson(SVC_HOST, '/transfer', 'POST',
          JSON.stringify({ action: 'sync', secret: sec }), { 'Content-Type': 'application/json' })
      } catch (e) {
        // 忽略
      }
    }
    const uid = await resolveUid(openid)
    const pr = await rest('GET',
      `/v1/rdb/rest/profiles?select=owner_id,nickname,balance&owner_id=eq.${encodeURIComponent(uid)}&limit=1`)
    const prof = Array.isArray(pr.body) && pr.body.length ? pr.body[0] : null
    if (!prof) {
      return done({ ok: false, code: 'NO_PROFILE', error: '新库里还没有你的账户资料（等前端切换完成后自动建立）' })
    }
    const sr = await rest('GET', '/v1/rdb/rest/pay_settings?select=min_withdraw,commission_rate&id=eq.1&limit=1')
    const set = Array.isArray(sr.body) && sr.body.length ? sr.body[0] : {}
    const wpath = `/v1/rdb/rest/withdraw_requests?select=id,amount,status,fail_reason,created_at,package_info&owner_id=eq.${encodeURIComponent(uid)}&order=created_at.desc&limit=20`
    const wr = await rest('GET', wpath)
    let records = Array.isArray(wr.body) ? wr.body : []

    // 兜底：补转「还停在 pending」的单（自动转账上线前申请的、或当时云托管抖了没转成的）。
    // 只挑最新的一笔，转完重查一次，让前端立刻看到 processing / 确认收款卡片。
    let auto = null
    if (SVC_HOST) {
      const stuck = records.filter(function (x) {
        return x.status === 'pending' && canAuto(x.amount)
      })
      if (stuck.length) {
        auto = await doTransfer(Number(stuck[0].id))
        const wr2 = await rest('GET', wpath)
        if (Array.isArray(wr2.body)) records = wr2.body
      }
    }

    return done({
      ok: true,
      uid: uid,
      nickname: prof.nickname || '',
      balance: Number(prof.balance || 0),
      minWithdraw: Number(set.min_withdraw || 10),
      records: records,
      auto: auto,
    })
  }

  // 提交提现申请
  if (action === 'create') {
    const amount = Number(payload.amount || 0)
    if (!(amount > 0)) return done({ ok: false, code: 'BAD_PARAM', error: '请填写提现金额' })
    const uid = await resolveUid(openid)
    const r = await rpc('svc_create_withdraw', { p_owner_id: uid, p_amount: amount })
    const row = Array.isArray(r.body) ? r.body[0] : null
    if (!row && r.status >= 400) {
      return done({
        ok: false,
        code: 'CREATE_FAILED',
        error: (r.body && (r.body.message || r.body.hint || r.body.details)) || '提现申请失败',
      })
    }
    // 自动转账：申请一成功就打款，不用等管理员点。失败不影响申请本身，
    // 后台仍可重试（action=transfer）或标记失败退款。
    const wdId = Number((row && (row.request_id || row.id)) || 0)
    let auto = null
    if (wdId && SVC_HOST && canAuto(amount)) auto = await doTransfer(wdId)
    return done({ ok: true, result: row || {}, auto: auto })
  }

  // 列出提现申请
  if (action === 'list') {
    // 先让云托管按真实状态同步一遍（微信回调可能没到，这是兜底）。
    // 同步失败不影响列表返回。
    const sec = await getSecret()
    if (SVC_HOST && sec) {
      try {
        await httpsJson(SVC_HOST, '/transfer', 'POST',
          JSON.stringify({ action: 'sync', secret: sec }), { 'Content-Type': 'application/json' })
      } catch (e) {
        // 忽略：同步失败不影响查看
      }
    }
    const status = String(payload.status || 'all')
    let path = '/v1/rdb/rest/withdraw_requests?select=id,owner_id,amount,status,batch_id,fail_reason,created_at,finished_at'
    if (status && status !== 'all') path += `&status=eq.${encodeURIComponent(status)}`
    path += '&order=created_at.desc&limit=100'
    const r = await rest('GET', path)
    const rows = Array.isArray(r.body) ? r.body : []
    const names = await loadNicknames(rows.map((x) => x.owner_id))
    return done({
      ok: true,
      list: rows.map((x) => Object.assign({}, x, {
        nickname: names[x.owner_id] || '同学',
      })),
    })
  }

  // 手动触发转账（后台重试 / 关闭自动转账时的主入口）
  if (action === 'transfer') {
    const id = Number(payload.id || 0)
    if (!id) return done({ ok: false, code: 'BAD_PARAM', error: '缺少提现单号 id' })
    const r = await doTransfer(id)
    if (!r.ok) return done(r)
    return done({
      ok: true,
      state: r.state || '',
      transferBillNo: r.transferBillNo || '',
      packageInfo: r.packageInfo || '',
    })
  }

  // 标记成功 / 失败
  if (action === 'finish') {
    const id = Number(payload.id || 0)
    if (!id) return done({ ok: false, code: 'BAD_PARAM', error: '缺少提现单号 id' })
    const success = payload.success === true || payload.success === 'true'
    const r = await rpc('admin_finish_withdrawal', {
      p_id: id,
      p_success: success,
      p_batch_id: payload.batch_id || null,
      p_reason: payload.reason || null,
    })
    const row = Array.isArray(r.body) ? r.body[0] : null
    if (!row && r.status >= 400) {
      return done({ ok: false, code: 'RPC_FAILED', error: (r.body && (r.body.message || r.body.error)) || '处理失败', detail: r.body })
    }
    return done({ ok: true, result: row || { id: id } })
  }

  return done({ ok: false, code: 'BAD_ACTION', error: '未知的 action：' + action })
}
