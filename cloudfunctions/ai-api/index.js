/**
 * ai-api · 智能客服的大模型通道（R57）
 *
 * 为什么单独一个云函数：R52 把后端从 WorkBuddy Cloud 迁到 CloudBase 之后，
 * 原来的 cloud.llm.* 直接失效，当时的处理是「先返回空数组 + 抛一句占位错误」，
 * 于是后台 AI 设置页一直显示「暂无可用模型」，智能客服整体是死的。
 *
 * CloudBase 自带大模型能力，并且兼容 OpenAI 协议：
 *   Base URL  https://{环境ID}.api.tcloudbasegateway.com/v1/ai/cloudbase
 *   鉴权      Authorization: Bearer {云开发 API Key}
 *   模型      控制台 → AI → 生文模型 里启用哪个才能用哪个
 * 密钥必须留在服务端，所以由这个云函数代持，前端只认 action。
 *
 * action:
 *   models  —— 拉可用模型列表（归一化成 [{ id, name }]）
 *   chat    —— 非流式问答，返回 { text }
 *
 * 环境变量：
 *   TCB_ENV_ID（必）            用来拼 Base URL
 *   TCB_AI_KEY（推荐）          云开发 AI 的 API Key；没配时退回 TCB_PUBLISHABLE_KEY
 *   TCB_AI_BASE（可选）         整个 Base URL 覆盖，换通道时用
 *   WX_APP_SECRET              验前端会话令牌（和 app-api 同一把钥匙）
 */
const https = require('https')
const crypto = require('crypto')

const TCB_ENV = process.env.TCB_ENV_ID || ''
const AI_KEY = process.env.TCB_AI_KEY || process.env.TCB_PUBLISHABLE_KEY || ''
const AI_BASE = process.env.TCB_AI_BASE || (TCB_ENV ? 'https://' + TCB_ENV + '.api.tcloudbasegateway.com/v1/ai/cloudbase' : '')
const APP_SECRET = process.env.WX_APP_SECRET || ''

// 大模型一次回答可能要十几秒，留给网关的时间要放宽
const HTTP_TIMEOUT_MS = 45000

// 云开发的 OpenAI 兼容接口**没有**模型列表路由 —— /models 会被当成模型名，
// 返回 403 AI_MODEL_NOT_SUPPORTED（实测：/v1/models、/v1/ai/models 全部 404/403）。
// 所以这里维护一份内置目录，并用真实调用逐个核过：本环境只有 hy3 与 hy3-preview
// 能用（小程序成长计划送的正是 hy3 额度），其余要买 Token 资源包才开通。
// 买了包之后不用改代码：把新模型名填进环境变量 TCB_AI_MODELS（逗号分隔）即可。
const DEFAULT_MODELS = ['hy3', 'hy3-preview']
const MODEL_CATALOG = String(process.env.TCB_AI_MODELS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
if (!MODEL_CATALOG.length) MODEL_CATALOG.push.apply(MODEL_CATALOG, DEFAULT_MODELS)

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function verifyToken(token) {
  const parts = String(token || '').split('.')
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

// 网关返回的错误形态不统一（有的是 { error: { message } }，有的是 { message }），
// 这里统一成一句能给人看的话，附带原始串方便排查。
function describeUpstream(status, body) {
  const raw =
    (body && body.error && (body.error.message || body.error.code)) ||
    (body && body.message) ||
    (typeof body === 'string' && body) ||
    ''
  const text = String(raw || '').slice(0, 200)
  if (status === 401 || status === 403) {
    return '大模型密钥无效或没权限（HTTP ' + status + '）' + (text ? '：' + text : '')
  }
  if (status === 404) {
    return '模型不存在或没在控制台启用（HTTP 404）' + (text ? '：' + text : '')
  }
  if (status === 429) {
    return '大模型额度用完了或触发限流（HTTP 429）' + (text ? '：' + text : '')
  }
  return '大模型调用失败（HTTP ' + status + '）' + (text ? '：' + text : '')
}

function request(method, path, payload) {
  const url = new URL(AI_BASE + path)
  const bodyStr = payload ? JSON.stringify(payload) : ''
  const headers = {
    Authorization: 'Bearer ' + AI_KEY,
    'Content-Type': 'application/json',
  }
  if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr)
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + (url.search || ''),
        method: method,
        headers: headers,
        timeout: HTTP_TIMEOUT_MS,
      },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          let json = {}
          try { json = data ? JSON.parse(data) : {} } catch (e) { json = { raw: data } }
          resolve({ status: res.statusCode || 0, body: json })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('大模型响应超时')))
    req.on('error', reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

exports.main = async function (event) {
  // 走 HTTP 访问服务进来时，真正的请求体在 event.body 里（可能还被 base64 过）；
  // 被云函数直接调用时 event 就是请求体本身。两种都要认，和 app-api 保持一致。
  const isHttp = !!(event && (event.httpMethod || event.requestContext))
  const done = (obj) =>
    isHttp
      ? {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(obj),
        }
      : obj

  let payload = event || {}
  if (isHttp) {
    let raw = event.body || ''
    if (event.isBase64Encoded && raw) raw = Buffer.from(raw, 'base64').toString('utf8')
    try { payload = raw ? JSON.parse(raw) : {} } catch (e) { payload = {} }
  }

  const action = String((payload && payload.action) || '')

  if (!AI_BASE || !AI_KEY) {
    return {
      ok: false,
      code: 'AI_NOT_CONFIGURED',
      error: '大模型通道没配好：需要 TCB_ENV_ID 和 AI 密钥（TCB_AI_KEY）',
      hint: '云开发控制台 → AI → 生文模型里启用模型，再到「环境配置 → API Key」拿密钥，配到本函数的 TCB_AI_KEY 上。',
    }
  }

  // 会话令牌照 app-api 的规矩验：AI 是要花钱的，不能让人匿名刷。
  // 每日次数上限另由 begin_support_ai 在库里控制，这里只挡没人认领的调用。
  const uid = verifyToken(payload && payload.token)
  if (!uid) {
    return { ok: false, code: 'TOKEN_INVALID', error: '登录状态已失效，请重新登录' }
  }

  try {
    if (action === 'models') {
      return done({
        models: MODEL_CATALOG.map((id) => ({ id: id, name: id })),
        // 明确告诉页面这份目录是静态的，省得以后有人以为是实时拉的
        builtin: true,
      })
    }

    if (action === 'chat') {
      const model = String((payload && payload.model) || '')
      const messages = (payload && payload.messages) || []
      if (!model) return { ok: false, code: 'BAD_PARAM', error: '没指定模型，请先到后台「智能客服配置」里选一个' }
      if (!Array.isArray(messages) || !messages.length) {
        return { ok: false, code: 'BAD_PARAM', error: '消息为空' }
      }
      const body = {
        model: model,
        messages: messages.slice(-20),
        stream: false,
      }
      const temp = Number(payload.temperature)
      if (isFinite(temp) && temp >= 0 && temp <= 2) body.temperature = temp
      // hy3 是推理模型：思考过程也要占 max_tokens。上限给太小（比如 60）会
      // 出现「reasoning 写完了、正文一个字没出」，所以这里兜一个下限。
      const maxTokens = Number(payload.maxTokens)
      if (isFinite(maxTokens) && maxTokens > 0) {
        body.max_tokens = Math.min(Math.max(Math.round(maxTokens), 300), 2000)
      } else {
        body.max_tokens = 400
      }

      const r = await request('POST', '/chat/completions', body)
      if (r.status < 200 || r.status >= 300) {
        return { ok: false, code: 'AI_UPSTREAM', error: describeUpstream(r.status, r.body) }
      }
      const choice = r.body && Array.isArray(r.body.choices) ? r.body.choices[0] : null
      const msg = (choice && choice.message) || {}
      const text = String(msg.content || choice && choice.text || r.body && r.body.text || '')
      if (!text && msg.reasoning_content) {
        // 推理模型把额度全花在思考上了：告诉人可以调大上限，别假装回答成功
        return {
          ok: false,
          code: 'AI_EMPTY',
          error: '模型这次只输出了思考过程就到字数上限了，把「最大字数」调大些再试',
        }
      }
      return done({ text: text })
    }

    return { ok: false, code: 'BAD_ACTION', error: '未知的 action：' + (action || '(空)') }
  } catch (err) {
    return { ok: false, code: 'AI_FAILED', error: String((err && err.message) || err || '大模型调用异常') }
  }
}
