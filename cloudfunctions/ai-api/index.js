/**
 * ai-api · 智能客服的大模型通道（R57 起，R58 支持自定义通道）
 *
 * 为什么单独一个云函数：R52 把后端从 WorkBuddy Cloud 迁到 CloudBase 之后，
 * 原来的 cloud.llm.* 直接失效，当时的处理是「先返回空数组 + 抛一句占位错误」，
 * 于是后台 AI 设置页一直显示「暂无可用模型」，智能客服整体是死的。
 *
 * 通道有两条，优先级从高到低：
 *
 *   1) 库里的 ai_secrets（R58）—— 后台「智能客服配置 → 大模型通道」填的。
 *      用来接任何 OpenAI 兼容服务：DeepSeek / 通义 / Kimi / 自建 vLLM。
 *      密钥存独立表且 RLS 零 policy，anon / authenticated 直连一律读不到，
 *      只有本函数（service_role）能取。
 *
 *   2) 环境变量 —— 云开发自带大模型通道，R57 的默认值。
 *      后台把 base/key 清空就自动退回这里，不会变成「没配通道」。
 *
 *   云开发通道：Base https://{环境ID}.api.tcloudbasegateway.com/v1/ai/cloudbase
 *   第三方通道：Base 形如 https://api.deepseek.com/v1（末尾斜杠会被去掉）
 *
 * action:
 *   models  —— 返回 [{ id, name }]。自定义通道会真的去 /models 探测一次，
 *              探测失败再退回配置里手写的模型名；内置通道直接回静态目录。
 *   chat    —— 非流式问答，返回 { text }
 *
 * 环境变量：
 *   TCB_ENV_ID（必）            环境 ID：拼云开发 Base，也是读库的网关域名
 *   TCB_PUBLISHABLE_KEY（必）   读库配置时当 Bearer
 *   TCB_AI_KEY（推荐）          云开发 AI 的 API Key
 *   TCB_AI_BASE（可选）         内置通道的 Base URL 覆盖
 *   TCB_AI_MODELS（可选）       内置通道的模型名，逗号分隔
 *   WX_APP_SECRET              验前端会话令牌（和 app-api 同一把钥匙）
 */
const https = require('https')
const crypto = require('crypto')

const TCB_ENV = process.env.TCB_ENV_ID || ''
const TCB_KEY = process.env.TCB_PUBLISHABLE_KEY || ''
const ENV_AI_KEY = process.env.TCB_AI_KEY || process.env.TCB_PUBLISHABLE_KEY || ''
const ENV_AI_BASE = process.env.TCB_AI_BASE || (TCB_ENV ? 'https://' + TCB_ENV + '.api.tcloudbasegateway.com/v1/ai/cloudbase' : '')
const APP_SECRET = process.env.WX_APP_SECRET || ''

// 大模型一次回答可能要十几秒，留给网关的时间要放宽
const HTTP_TIMEOUT_MS = 45000
// 读库拿通道配置的超时单独设短：库慢了不能把整个问答拖死
const DB_TIMEOUT_MS = 5000
// 通道配置缓存。聊天走缓存（省一次往返），后台拉模型列表时强制刷新。
const CHANNEL_TTL_MS = 60 * 1000

// 云开发的 OpenAI 兼容接口**没有**模型列表路由 —— /models 会被当成模型名，
// 返回 403 AI_MODEL_NOT_SUPPORTED（实测：/v1/models、/v1/ai/models 全部 404/403）。
// 所以内置通道维护一份静态目录，并用真实调用逐个核过：本环境只有 hy3 与 hy3-preview
// 能用（小程序成长计划送的正是 hy3 额度）。第三方通道（如 DeepSeek）有 /models，
// 会去真拉，这里只是兜底。
const DEFAULT_MODELS = ['hy3', 'hy3-preview']
const ENV_MODELS = String(process.env.TCB_AI_MODELS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
if (!ENV_MODELS.length) ENV_MODELS.push.apply(ENV_MODELS, DEFAULT_MODELS)

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
  // DeepSeek 余额不足走 402，这条最容易撞上，单独说清楚
  if (status === 402) {
    return '大模型账户余额不足（HTTP 402），请充值后再用' + (text ? '：' + text : '')
  }
  if (status === 404) {
    return '模型不存在或没在控制台启用（HTTP 404）' + (text ? '：' + text : '')
  }
  if (status === 429) {
    return '大模型额度用完了或触发限流（HTTP 429）' + (text ? '：' + text : '')
  }
  if (status >= 500) {
    return '大模型服务端异常（HTTP ' + status + '），稍后重试' + (text ? '：' + text : '')
  }
  return '大模型调用失败（HTTP ' + status + '）' + (text ? '：' + text : '')
}

function request(method, path, payload, base, key, timeoutMs) {
  const url = new URL(base + path)
  const bodyStr = payload ? JSON.stringify(payload) : ''
  const headers = {
    Authorization: 'Bearer ' + key,
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
        timeout: timeoutMs || HTTP_TIMEOUT_MS,
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

// ------------------------------------------------------------
// 通道解析
// ------------------------------------------------------------

function envChannel() {
  return {
    base: ENV_AI_BASE,
    key: ENV_AI_KEY,
    models: ENV_MODELS.slice(),
    custom: false,
    source: 'cloudbase',
  }
}

function readDbChannel() {
  if (!TCB_ENV || !TCB_KEY) return Promise.resolve(null)
  const host = TCB_ENV + '.api.tcloudbasegateway.com'
  return request('POST', '/v1/rdb/rest/rpc/ai_runtime_config', {}, 'https://' + host, TCB_KEY, DB_TIMEOUT_MS)
    .then((r) => {
      if (r.status < 200 || r.status >= 300) return null
      let data = r.body
      // PostgREST 对标量 json 返回有两种形态：裸对象，或包一层函数名
      if (data && typeof data === 'object' && !data.base_url && data.ai_runtime_config) {
        data = data.ai_runtime_config
      }
      return data && typeof data === 'object' ? data : null
    })
    .catch(() => null)
}

let channelCache = null
let channelPending = null

function resolveChannel(force) {
  const now = Date.now()
  if (!force && channelCache && now - channelCache.at < CHANNEL_TTL_MS) {
    return Promise.resolve(channelCache.value)
  }
  if (channelPending) return channelPending
  channelPending = readDbChannel().then((db) => {
    let value = envChannel()
    const dbBase = String((db && db.base_url) || '').trim().replace(/\/+$/, '')
    const dbKey = String((db && db.api_key) || '').trim()
    // base 和 key 必须同时在库里才算「启用了自定义通道」——
    // 只填一半大概率是填到一半保存了，这时退回内置通道比报错友好。
    if (dbBase && dbKey) {
      const list = String((db && db.models) || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (!list.length) list.push('deepseek-chat')
      value = { base: dbBase, key: dbKey, models: list, custom: true, source: 'custom' }
    }
    channelCache = { at: Date.now(), value: value }
    channelPending = null
    return value
  })
  return channelPending
}

function notConfigured(ch) {
  return {
    ok: false,
    code: 'AI_NOT_CONFIGURED',
    error: '大模型通道没配好：既没有自定义通道，也没有云开发内置通道',
    hint: '后台「智能客服配置 → 大模型通道」填 Base URL 和 API Key（DeepSeek 填 https://api.deepseek.com/v1，模型 deepseek-chat）；或在云函数 ai-api 的环境变量里配 TCB_AI_KEY。',
    base: ch && ch.base ? ch.base : '',
  }
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

  // 会话令牌照 app-api 的规矩验：AI 是要花钱的，不能让人匿名刷。
  // 每日次数上限另由 begin_support_ai 在库里控制，这里只挡没人认领的调用。
  const uid = verifyToken(payload && payload.token)
  if (!uid) {
    return { ok: false, code: 'TOKEN_INVALID', error: '登录状态已失效，请重新登录' }
  }

  try {
    // 拉模型列表时强制刷新通道缓存：后台改完 key，紧接着点「重新加载」
    // 就该看到新模型，而不是等 60 秒。
    const ch = await resolveChannel(action === 'models')
    if (!ch.base || !ch.key) return notConfigured(ch)

    if (action === 'models') {
      let models = ch.models.map((id) => ({ id: id, name: id }))
      let builtin = !ch.custom
      let probeErr = ''
      if (ch.custom) {
        // 第三方通道（OpenAI 协议）有 /models，真拉一次覆盖手写清单
        try {
          const r = await request('GET', '/models', null, ch.base, ch.key, 8000)
          if (r.status >= 200 && r.status < 300) {
            const items = (r.body && Array.isArray(r.body.data) && r.body.data) || []
            const ids = items.map((it) => String((it && it.id) || '')).filter(Boolean)
            if (ids.length) {
              models = ids.map((id) => ({ id: id, name: id }))
              builtin = false
            }
          } else {
            probeErr = describeUpstream(r.status, r.body)
          }
        } catch (e) {
          probeErr = String((e && e.message) || e || '拉取模型列表失败')
        }
      }
      return done({
        models: models,
        builtin: builtin,
        source: ch.source,
        // probeErr 只是提示：探测失败时前端仍能用配置里手写的模型名
        probeErr: probeErr,
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
      // 推理模型（hy3 / deepseek-reasoner）的思考过程也占 max_tokens：
      // 上限给太小（比如 60）会出现「reasoning 写完了、正文一个字没出」，所以兜下限。
      const maxTokens = Number(payload.maxTokens)
      if (isFinite(maxTokens) && maxTokens > 0) {
        body.max_tokens = Math.min(Math.max(Math.round(maxTokens), 300), 2000)
      } else {
        body.max_tokens = 400
      }

      const r = await request('POST', '/chat/completions', body, ch.base, ch.key)
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
      return done({ text: text, model: model, source: ch.source })
    }

    return { ok: false, code: 'BAD_ACTION', error: '未知的 action：' + (action || '(空)') }
  } catch (err) {
    return { ok: false, code: 'AI_FAILED', error: String((err && err.message) || err || '大模型调用异常') }
  }
}
