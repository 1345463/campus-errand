const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const flags = require('../../utils/flags')
const motion = require('../../utils/motion')
const moderation = require('../../utils/moderation')

// 智能客服：FAQ 固定回答优先，答不上来再让大模型兜底，还不行就转人工工单。
//
// 为什么要"固定回答优先"：
//   1) 校园场景 80% 的问题就那几条（赏金范围、没人接单、怎么成为接单员），
//      走 FAQ 是零延迟、零成本、零幻觉；
//   2) 大模型按调用计费，固定回答能挡掉大部分流量；
//   3) 涉及金额、时限的说法必须和后台文案一致 —— FAQ 是客服自己维护的，
//      大模型会编，编出来的价格承诺是要负责的。
//
// 三条硬约束（改动时别破）：
//   1) 用户输入先过本地违规词，再拼进 prompt —— 防止用提问改写系统指令；
//   2) AI 提问先由服务端预留账号配额，失败释放；
//   3) 大模型只能看到 FAQ 当"平台资料"，资料里没有的必须说答不准并引导转人工。

const MAX_LEN = 200
const SESSION_PREFIX = 'supportConversationV2:'
const HOT_LIMIT = 8
// 后端没给值时用的兜底：三个上限集中放在这里，别散进各个函数
const CONTEXT_FAQ_LIMIT = 40
const HISTORY_TURNS = 3
const DEFAULT_TIMEOUT_MS = 30000

const DEFAULT_PROMPT =
  '你是「校园跑腿」小程序的智能客服助手。只回答与本平台相关的问题。' +
  '用中文简短回答，单次不超过 120 字。只能依据下面「平台资料」回答；' +
  '资料里没有的直接说明答不准，并请用户点「转人工」，绝不编造价格、时限或规则。'

function norm(text) {
  try {
    return moderation.normalize(text)
  } catch (e) {
    return String(text || '').toLowerCase()
  }
}

// 关键词支持空格 / 逗号 / 顿号 / 分号 / 竖线分隔，后台怎么填都能用
function splitKeywords(raw) {
  return String(raw || '')
    .split(/[\s,，、;；|/]+/)
    .filter(function (word) {
      return !!word
    })
}

// 打分式匹配：命中越长、越具体的关键词分越高，取最高的一条。
// 阈值 6 的来由：单个两字关键词 = 6 + 2 = 8 分能命中；
// 只有一个字（如「钱」）单独出现时不该直接定性，需要配合更长的词。
function matchFaq(text, list) {
  const key = norm(text)
  if (key.length < 2) return null
  let best = null
  let bestScore = 0
  ;(list || []).forEach(function (item) {
    let score = 0
    const q = norm(item.question)
    if (!tidyText(item.answer)) return
    if (q && (key === q || (key.length >= 4 && q.indexOf(key) >= 0) || (q.length >= 4 && key.indexOf(q) >= 0))) score += 20
    splitKeywords(item.keywords).forEach(function (word) {
      const kw = norm(word)
      if (kw.length < 2 || key.indexOf(kw) < 0) return
      score += 6 + kw.length
    })
    if (score > bestScore) {
      bestScore = score
      best = item
    }
  })
  return bestScore >= 8 ? best : null
}

// 拼进 prompt 前先洗一遍：折行折叠、去三引号，避免用户用换行/引号把
// 「用户输入」的边界撑开、接着写一段假的 system 指令。
function sanitize(text) {
  return String(text || '')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LEN)
}

// 进气泡之前统一洗一遍文本。
// 模型输出常常带首尾换行、连续空行、全角空格；气泡 white-space 是 pre-wrap，
// 这些东西会原样渲染成空白行 —— 气泡被撑得老高，看着就像「消息之间空了一大截」。
// 这里一律压掉：空行全部并成一行，行内多余空白归一，首尾空白全去掉。
function tidyText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    // 全角空格 / 不间断空格都归一成普通空格，否则 trim 认不出来
    .replace(/[ 　]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]*/g, '\n')
    // 连续空行压成一个换行：聊天气泡里不需要留白排版
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function buildSystemPrompt(settings, faqList) {
  const base = String((settings && settings.ai_prompt) || '').trim() || DEFAULT_PROMPT
  // 后台可以关掉资料注入（填 0），只想让模型纯按提示词答时用得上
  const limit = num((settings || {}).context_faq_limit, CONTEXT_FAQ_LIMIT)
  if (limit <= 0) return base
  const rows = (faqList || []).slice(0, limit)
  if (!rows.length) return base
  const body = rows
    .map(function (item) {
      return 'Q：' + item.question + '\nA：' + item.answer
    })
    .join('\n')
  return base + '\n\n平台资料：\n' + body
}

// 数字兜底：后台字段是空值 / 脏值时不能用 NaN 去拼 prompt 或算历史轮数
function num(value, fallback) {
  const parsed = Number(value)
  return isNaN(parsed) ? fallback : parsed
}

// selectorQuery 量不到节点时拿到的是 null / undefined，统一取高度为 0
function heightOf(rect) {
  return Math.round(Number(rect && rect.height) || 0)
}

// ============================================================================
// 上下文：把最近几轮对话一起发给模型
// ----------------------------------------------------------------------------
// 为什么必须要：不带历史的话每一轮都是一次全新提问。用户顺着往下问
// 「那赏金呢」「多久能到」这种省略句时模型完全不知道在问什么，回答就会
// 接不上上一句 —— 看起来像"答非所问"，其实是上下文丢了。
// 只尾巴中的内容进历史：欢迎语（tip）是开场白，占位气泡（pending）还没内容。
// ============================================================================
function buildHistory(list, turns, excludeId) {
  const maxTurns = Math.max(Math.min(num(turns, HISTORY_TURNS), 8), 0)
  if (maxTurns <= 0) return []
  const history = []
  ;(list || []).forEach(function (item) {
    if (excludeId && item.id === excludeId) return
    if (item.pending || item.failed || !tidyText(item.text)) return
    if (item.role === 'me') {
      history.push({ role: 'user', content: sanitize(item.text) })
    } else if (item.kind === 'ai' || item.kind === 'faq') {
      history.push({ role: 'assistant', content: String(item.text || '').slice(0, 500) })
    }
  })
  // 一轮 = 一问一答两条，所以留 2×maxTurns 条
  const keep = maxTurns * 2
  return history.slice(Math.max(history.length - keep, 0))
}

let seq = 0
function nextId() {
  seq += 1
  return 'm' + seq
}

function nowText() {
  const d = new Date()
  const pad = function (n) {
    return n < 10 ? '0' + n : String(n)
  }
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

Page({
  data: {
    navTotal: 64,
    motionClass: '',

    grayOff: false,
    loading: true,
    errorText: '',

    // 会话
    messages: [],
    input: '',
    countText: '0 / ' + MAX_LEN,
    sending: false,
    // 会话内容底部留白（px）= 固定输入区高度 + 余量。
    // 不留这块的话最后一条消息会被输入区盖住。
    chatPad: 220,
    keyboardHeight: 0,
    inputLimit: MAX_LEN + 1,
    ticketId: '',
    inputWarning: '',

    // 热门问题（点一下直接问）
    hot: [],
    hotOpen: true,

    // AI 能力：开关 + 有没有选模型 + 今天还剩几次
    aiReady: false,
    signedIn: false,
    aiLimit: 20,
    aiUsed: 0,
    aiLeftText: '',

    // 转人工面板
    humanOpen: false,
    humanContact: '',
    humanSending: false,
  },

  onLoad: function () {
    const page = this
    const sys = motion.systemInfo()
    page.setData({
      navTotal: sys.navTotalHeight,
      motionClass: motion.rootClass(),
      // 一个会话窗口一个 ID，整页生命周期内复用（服务端用它做路由与计量）
      conversationId: 'cs_' + Date.now() + '_' + Math.floor(Math.random() * 100000),
    })
    page._alive = true
    page._atBottom = true
    page.boot()
  },

  onReady: function () {
    // 布局第一帧之后才量得到真实高度，放 onLoad 里会量到 0。
    // 这里必须包一层：直接 setTimeout(this.measureInput, 200) 会把 this 丢掉。
    const page = this
    setTimeout(function () {
      page.measureInput()
    }, 200)
  },

  onHide: function () { this.saveDraft() },

  onUnload: function () {
    this.saveDraft()
    this._alive = false
    if (this._cancelAi) this._cancelAi()
    ;['_scrollTimer', '_docTimer', '_padTimer', '_streamTimer'].forEach(function (key) {
      if (this[key]) clearTimeout(this[key])
      this[key] = null
    }, this)
  },

  saveDraft: function (forLogin) {
    if (!this._storageKey) return
    const draft = { messages: (this.data.messages || []).slice(-100).map(function (item) {
      return item.pending ? Object.assign({}, item, { pending: false, failed: true, text: '回答已中断，可重新生成。' }) : item
    }), input: this.data.input, conversationId: this.data.conversationId,
      humanContact: this.data.humanContact, humanOpen: this.data.humanOpen,
      ticketId: this.data.ticketId, at: Date.now() }
    ui.setStorage(this._storageKey, draft)
    if (forLogin) ui.setStorage('supportLoginDraftV2', draft)
  },

  restoreDraft: function (session) {
    if (this._storageKey) return
    this._storageKey = SESSION_PREFIX + (session && session.user ? String(session.user.id) : 'guest')
    const pendingLogin = session ? ui.getStorage('supportLoginDraftV2') : null
    const loginDraft = pendingLogin && Date.now() - pendingLogin.at < 30 * 60000 ? pendingLogin : null
    const draft = loginDraft || ui.getStorage(this._storageKey)
    if (session) ui.removeStorage('supportLoginDraftV2')
    if (!draft || Date.now() - draft.at > 7 * 86400000) return
    const messages = (Array.isArray(draft.messages) ? draft.messages : []).slice(-100)
    seq = Math.max(seq, Date.now())
    this.setData({ messages: messages, input: String(draft.input || '').slice(0, MAX_LEN),
      countText: String(draft.input || '').length + ' / ' + MAX_LEN,
      conversationId: draft.conversationId || this.data.conversationId,
      humanContact: draft.humanContact || '', humanOpen: !!draft.humanOpen,
      ticketId: draft.ticketId || '' })
  },

  clearChat: function () {
    const page = this
    if (page.data.sending) return
    return ui.confirm({ title: '清空对话', content: '清空本账号在这台设备上的客服聊天记录？' }).then(function (ok) {
      if (!ok) return
      page.setData({ messages: [], input: '', ticketId: '', countText: '0 / ' + MAX_LEN,
        conversationId: 'cs_' + Date.now() + '_' + Math.floor(Math.random() * 100000) })
      page.pushBot((page.data.settings || {}).welcome || '你好，有什么可以帮你？', 'tip')
      page.saveDraft()
      page.measureInput()
    })
  },

  // 量输入区高度 -> 写进 chatPad（会话内容底部留白）。
  // 同时量一次文档总高度，贴底判定和 scrollTop 计算都要用。
  measureInput: function () {
    const page = this
    if (page._alive === false || typeof wx.createSelectorQuery !== 'function') return
    try {
      const query = wx.createSelectorQuery().in(page)
      query.select('.sup-input').boundingClientRect()
      query.exec(function (res) {
        const input = (res && res[0]) || {}
        const h = heightOf(input)
        if (h > 0) {
          page.setData({ chatPad: h + page.data.keyboardHeight + 24 }, function () {
            page.scheduleScroll()
          })
        }
        page.measureDoc()
      })
    } catch (e) {
      /* 查询失败不用管 */
    }
  },

  // 量文档总高度（页面从顶部到最底部的距离）。
  // 整页滚动方案下，贴底判定 = 文档高 − 窗口高 − scrollTop < 阈值。
  measureDoc: function (done) {
    const page = this
    if (typeof wx.createSelectorQuery !== 'function') { if (done) done(0); return }
    try {
      const query = wx.createSelectorQuery()
      query.select('.support-page').boundingClientRect()
      query.exec(function (res) {
        const rect = (res && res[0]) || {}
        const h = Number(rect.height) || 0
        if (h > 0) page._docHeight = h
        if (done) done(h)
      })
    } catch (e) {
      if (done) done(0)
    }
  },

  // 灰度开关 -> FAQ + 设置。开关没开直接显示未开放，不发任何请求
  boot: function () {
    const page = this
    page.setData({ loading: true, errorText: '' })
    return flags
      .ensure()
      .then(function () {
        if (!flags.on('ai_support')) {
          page.setData({ grayOff: true, loading: false })
          return null
        }
        page.setData({ grayOff: false })
        return Promise.all([api.listFaqItems(), api.getFaqSettings(), api.getSession()])
      })
      .then(function (result) {
        if (!result) return null
        const faqList = result[0] || []
        const settings = result[1] || {}
        const limit = Math.max(num(settings.daily_limit, 20), 0)
        page.restoreDraft(result[2])
        const used = 0
        page.setData({
          signedIn: !!result[2],
          faqList: faqList,
          settings: settings,
          aiReady: !!(settings.ai_enabled && settings.ai_model),
          aiLimit: limit,
          aiUsed: used,
          aiLeftText: String(Math.max(limit - used, 0)),
          hot: faqList.slice(0, HOT_LIMIT),
          hotOpen: true,
        })
        const welcome =
          String(settings.welcome || '').trim() || '你好，我是校园跑腿的智能助手，常见问题可以直接问我。'
        if (!page.data.messages.length) page.pushBot(welcome, 'tip')
        page.setData({ loading: false })
        page.refreshUsage()
        // 输入区是在 loading 变 false 之后才渲染的，在这里补量一次。
        setTimeout(function () {
          page.measureInput()
        }, 260)
        return null
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ loading: false, errorText: message })
        if (typeof console !== 'undefined' && console.error) {
          console.error('[mine/support] boot failed:', message, error)
        }
      })
  },

  refreshUsage: function () {
    const page = this
    return api.getSupportUsage().then(function (usage) {
      if (!usage || page._alive === false) return
      page.setData({ aiUsed: usage.used, aiLimit: usage.daily_limit,
        aiLeftText: String(Math.max(usage.daily_limit - usage.used, 0)) })
    }).catch(function () {})
  },

  reload: function () {
    this.boot()
  },

  // ---------- 消息 ----------
  pushMsg: function (msg) {
    const page = this
    const list = (page.data.messages || []).slice(-99)
    const next = {
      id: msg.id,
      role: msg.role,
      kind: msg.kind,
      text: tidyText(msg.text) || (msg.pending ? '正在思考…' : '这个问题暂时答不上来，请转人工。'),
      timeText: msg.timeText,
      pending: !!msg.pending,
    }
    if (msg.failed) next.failed = true
    if (msg.question) next.question = msg.question
    if (msg.requestId) next.requestId = msg.requestId
    if (msg.faqId) next.faqId = msg.faqId
    list.push(next)
    page.setData({ messages: list }, function () { page.saveDraft() })
    // 新消息必须自己滚进视野 —— 不受「贴底」判定限制。
    // 判定只该管流式输出要不要跟着跑，不该拦住「用户刚发的那句」和「回答刚到的那句」。
    page._atBottom = true
    page.scheduleScroll()
    return msg.id
  },

  pushBot: function (text, kind) {
    return this.pushMsg({
      id: nextId(),
      role: 'bot',
      kind: kind || 'ai',
      text: text,
      timeText: nowText(),
      pending: false,
    })
  },

  updateMsg: function (id, text, extra) {
    const page = this
    const index = (page.data.messages || []).findIndex(function (item) { return item.id === id })
    if (index < 0 || page._alive === false) return
    const clean = tidyText(text)
    const patch = {}
    patch['messages[' + index + '].text'] = clean || (extra && extra.pending ? '正在思考…' : '这个问题暂时答不上来，请转人工。')
    patch['messages[' + index + '].pending'] = false
    Object.keys(extra || {}).forEach(function (key) { patch['messages[' + index + '].' + key] = extra[key] })
    page.setData(patch, function () {
      page.scheduleScroll()
      if (!extra || !extra.pending) page.saveDraft()
    })
  },

  // --------------------------------------------------------------------------
  // 滚到底 —— 整页滚动，用 wx.pageScrollTo。
  //
  // 为什么不用 scroll-view：内容高度在各基础库上算不准，五轮修复都没治住
  // （实测内容 1053px 而消息只有 302px，中间 751px 幽灵高度）。
  //
  // 为什么不用 scroll-top 塞大数（999999）：在 scroll-view 的 scroll-top 属性上
  // 会把内容顶上去留一片空白。wx.pageScrollTo 是页面级 API，行为不同 ——
  // 但为了保险，还是优先用实测位置，量不到才兜底用大数。
  // --------------------------------------------------------------------------
  scrollToBottom: function () {
    const page = this
    if (!(page.data.messages || []).length) return
    if (typeof wx.pageScrollTo !== 'function') return
    // setData 回调后重新测量，再使用本次高度滚动。
    page.measureDoc(function (doc) {
      if (page._alive === false || page._atBottom === false) return
      const win = Number(motion.systemInfo().windowHeight) || 0
      const target = doc > 0 && win > 0 ? Math.max(doc - win, 0) : 999999
      try { wx.pageScrollTo({ scrollTop: target, duration: 0 }) } catch (e) {}
    })
  },

  // 节流版：流式输出每个字都会回调一次，逐字滚会把 setData 刷爆。
  // 用 throttle 而不是 debounce —— debounce 在连续输出时永远不触发，
  // 那样最后一次滚动就丢了，回答的尾巴还是看不到。
  scheduleScroll: function () {
    const page = this
    if (page._atBottom === false) return // 用户自己往上翻历史了，别抢他的滚动条
    if (page._scrollTimer) return
    page._scrollTimer = setTimeout(function () {
      page._scrollTimer = null
      page.scrollToBottom()
    }, 100)
  },

  // 页面滚动回调：判断用户是否贴在底部。
  // 贴底判定 = 文档高 − 窗口高 − scrollTop < 80。
  // 没量到就不下判断、保持未知：否则算出来一定「没贴底」，自动跟随会永久停摆。
  onPageScroll: function (event) {
    const page = this
    const top = Number((event && event.scrollTop) || 0)
    const doc = page._docHeight || 0
    const sys = motion.systemInfo()
    const win = Number(sys.windowHeight) || 0
    if (!doc || !win) return
    page._atBottom = doc - win - top < 80
  },

  // 键盘弹起时把页面拉到底：不然最后一条消息会被键盘盖住，
  // 用户一边打字一边看不到自己刚发的那句。
  onFocus: function () {
    const page = this
    setTimeout(function () {
      page._atBottom = true
      page.scrollToBottom()
    }, 260)
  },

  onKeyboardHeightChange: function (event) {
    const height = Math.max(Number(event.detail.height) || 0, 0)
    const page = this
    page.setData({ keyboardHeight: height }, function () { page.measureInput() })
  },

  onResize: function () { this.measureInput() },

  // ---------- 输入 ----------
  onInput: function (event) {
    const page = this
    const raw = event.detail.value || ''
    const value = raw.slice(0, MAX_LEN)
    page.setData({ input: value, countText: value.length + ' / ' + MAX_LEN, inputWarning: raw.length >= MAX_LEN ? '每条最多 200 字，较长内容请分条发送。' : '' })
    // 输入框是自增高的，一行变多行会把输入区顶高，底部留白要跟着变。
    // 节流一下，别每个字都量。
    if (page._padTimer) return
    page._padTimer = setTimeout(function () {
      page._padTimer = null
      page.measureInput()
    }, 200)
  },

  onHotTap: function (event) {
    if (this.data.sending) return
    const text = String(event.currentTarget.dataset.q || '')
    if (!text) return
    motion.haptic('light')
    this.setData({ input: text, countText: text.length + ' / ' + MAX_LEN })
    this.send()
  },

  toggleHot: function () {
    motion.haptic('light')
    this.setData({ hotOpen: !this.data.hotOpen })
    // 热门展开/收起会改变文档高度，重量一次让贴底判定用最新值
    const page = this
    setTimeout(function () {
      page.measureDoc()
    }, 60)
  },

  send: function () {
    const page = this
    const raw = String(page.data.input || '').trim()
    if (!raw) {
      ui.toast({ title: '先写点内容', icon: 'none' })
      return
    }
    if (page.data.sending) return
    if (raw.length > MAX_LEN) {
      ui.toast({ title: '最多 ' + MAX_LEN + ' 字', icon: 'none' })
      return
    }

    // 违规词：本地先拦一道，别让脏字进大模型、也别落在会话记录里
    const hit = moderation.scanText(raw)
    if (hit) {
      ui.toast({ title: moderation.hitMessage(hit), icon: 'none', duration: 2600 })
      return
    }

    page.setData({ sending: true, input: '', inputWarning: '', countText: '0 / ' + MAX_LEN }, function () { page.measureInput() })
    page.pushMsg({ id: nextId(), role: 'me', kind: 'me', text: raw, timeText: nowText(), pending: false })

    const faq = matchFaq(raw, page.data.faqList)
    if (faq) {
      // 固定回答：零延迟、零成本，也最可信
      page.pushMsg({ id: nextId(), role: 'bot', kind: 'faq', text: faq.answer, timeText: nowText(), faqId: faq.id })
      page.setData({ sending: false })
      return
    }

    page.askAi(raw)
  },

  // ---------- 大模型兜底 ----------
  askAi: function (question) {
    const page = this
    const settings = page.data.settings || {}

    if (!page.data.aiReady) {
      page.pushBot(
        '这个问题我还没学会答。点下方「转人工」提交工单，客服会尽快回复你。',
        'tip'
      )
      page.setData({ sending: false })
      return
    }
    // 历史要在占位气泡之前拼：此刻 messages 里刚好是「上文 + 用户刚才那句」，
    // 占位气泡 push 进去以后会被 pending 过滤掉，所以放前放后都安全，放前面更好读。
    const history = buildHistory(page.data.messages, settings.history_turns, '')

    const msgId = nextId()
    page.pushMsg({ id: msgId, role: 'bot', kind: 'ai', question: question, text: '正在思考…', timeText: nowText(), pending: true })

    const messages = [{ role: 'system', content: buildSystemPrompt(settings, page.data.faqList) }]
    if (history.length) {
      history.forEach(function (item) {
        messages.push(item)
      })
    }
    if (!history.length || history[history.length - 1].role !== 'user' || history[history.length - 1].content !== sanitize(question)) {
      // 重生成和关闭历史时也明确携带当前问题。
      // 后台把历史轮数调成 0 时也要保证模型知道用户问了什么
      messages.push({ role: 'user', content: '用户提问：' + sanitize(question) })
    }

    const timeoutMs = Math.min(Math.max(num(settings.timeout_ms, DEFAULT_TIMEOUT_MS), 5000), 120000)
    let active = true
    let claim = null
    let controller = typeof AbortController === 'function' ? new AbortController() : null
    let timer = null
    let lastPartial = ''
    let cancel = null
    const finishClaim = function (success) {
      if (!claim) return Promise.resolve()
      return api.finishSupportAi(claim.request_id, success).then(function () { return page.refreshUsage() }).catch(function () {
        // 网络恢复后下次查询会显示服务端的计数；不伪称写入成功。
        if (page._alive !== false) ui.toast({ title: '提问次数同步失败，请稍后重试', icon: 'none' })
      })
    }
    const timeout = new Promise(function (resolve, reject) {
      cancel = function () { reject(new Error('回答已中断')) }
      page._cancelAi = cancel
      timer = setTimeout(function () { reject(new Error('回答超时')) }, timeoutMs)
    })
    const request = api.beginSupportAi().then(function (ticket) {
      claim = ticket
      if (!active || page._alive === false) { finishClaim(false); throw new Error('回答已中断') }
      page.setData({ aiUsed: Number(ticket.used) || 0, aiLimit: Number(ticket.daily_limit) || page.data.aiLimit,
        aiLeftText: String(Math.max(Number(ticket.daily_limit) - Number(ticket.used), 0)) })
      return api.llmChat(settings.ai_model, messages, function (partial) {
        if (!active || page._alive === false) return
        lastPartial = partial
        if (page._streamTimer) return
        page._streamTimer = setTimeout(function () {
          page._streamTimer = null
          if (active) page.updateMsg(msgId, lastPartial, { pending: true })
        }, 80)
      }, { conversationId: page.data.conversationId || '', signal: controller ? controller.signal : undefined,
        temperature: num(settings.temperature, 0.3), maxTokens: num(settings.max_tokens, 400) })
    })
    function stop() {
      active = false
      clearTimeout(timer)
      if (page._streamTimer) clearTimeout(page._streamTimer)
      page._streamTimer = null
      page._cancelAi = null
      if (controller) { try { controller.abort() } catch (e) {} }
    }
    return Promise.race([request, timeout]).then(function (answer) {
      stop()
      const text = tidyText(answer)
      page.updateMsg(msgId, text || '这个我答不准，请点「转人工」让客服帮你。',
        { pending: false, failed: !text, requestId: claim ? claim.request_id : '' })
      if (page._alive !== false) page.setData({ sending: false })
      return finishClaim(!!text)
    }).catch(function (error) {
      stop()
      const message = api.getErrorMessage(error)
      page.updateMsg(msgId, message === '回答超时' ? '这次回答超时了，可以重新生成或转人工。' : '回答失败：' + message + '。可重试或转人工。', { pending: false, failed: true })
      if (page._alive !== false) page.setData({ sending: false })
      return finishClaim(false)
    })
  },

  regenerate: function (event) {
    if (this.data.sending) return
    const message = (this.data.messages || []).filter(function (item) { return item.id === event.currentTarget.dataset.id })[0]
    if (!message || !message.question) return
    this.setData({ sending: true })
    return this.askAi(message.question)
  },

  rateAnswer: function (event) {
    const page = this
    const msg = (page.data.messages || []).filter(function (item) { return item.id === event.currentTarget.dataset.id })[0]
    if (!msg || msg.rating) return
    const rating = event.currentTarget.dataset.rating
    return api.rateSupportAnswer(msg.requestId || '', msg.faqId || null, rating === 'helpful').then(function () {
      page.updateMsg(msg.id, msg.text, { rating: rating })
      ui.toast({ title: '已收到反馈，谢谢', icon: 'none' })
      if (rating !== 'helpful') page.openHuman()
    }).catch(guard.toastError)
  },

  // ---------- 转人工 ----------
  openHuman: function () {
    motion.haptic('light')
    this.setData({ humanOpen: true })
  },

  closeHuman: function () {
    this.setData({ humanOpen: false })
  },

  onContactInput: function (event) {
    this.setData({ humanContact: event.detail.value || '' })
  },

  // 工单正文带上最近一轮对话，客服打开就能看懂上下文，不用再问一遍
  submitHuman: function () {
    const page = this
    if (page.data.humanSending) return
    const contact = String(page.data.humanContact || '').trim()
    if (!(page.data.messages || []).some(function (item) { return item.role === 'me' && tidyText(item.text) })) {
      ui.toast({ title: '请先描述需要客服处理的问题', icon: 'none' })
      return
    }
    const lines = []
    const list = page.data.messages || []
    for (let i = Math.max(list.length - 6, 0); i < list.length; i += 1) {
      const item = list[i]
      if (item.kind === 'tip' || item.pending) continue
      lines.push((item.role === 'me' ? '我：' : '助手：') + item.text)
    }
    const marker = '（由智能客服转人工）'
    const content = lines.join('\n').slice(-(500 - marker.length - 2)) + '\n\n' + marker

    page.setData({ humanSending: true })
    ui.loading({ title: '提交中', mask: true })
    api
      .submitUserFeedback('other', content, contact)
      .then(function (ticket) {
        if (!ticket || !ticket.id) throw new Error('未收到工单编号，请到意见反馈核对提交结果')
        page.setData({ ticketId: String(ticket.id) })
        ui.hideLoading()
        page.setData({ humanSending: false, humanOpen: false, humanContact: '' })
        page.pushBot('工单 #' + ticket.id + ' 已提交，客服会在工单内回复。点「查看工单」可跟进。', 'tip')
        ui.toast({ title: '已转人工', icon: 'success' })
      })
      .catch(function (error) {
        ui.hideLoading()
        page.setData({ humanSending: false })
        const message = api.getErrorMessage(error)
        // 没登录是最常见的一种失败，直接引导去登录，别只弹一句看不懂的报错
        if (message.indexOf('登录') >= 0 || message.indexOf('未认证') >= 0) {
          ui.confirm({
            title: '需要先登录',
            content: '提交工单要登录账号，现在去「我的」登录吗？',
            confirmText: '去登录',
          }).then(function (ok) {
            if (ok) require('../../utils/login-return').goLogin()
          })
          return
        }
        guard.toastError(error)
      })
  },

  goLogin: function () { require('../../utils/login-return').goLogin() },

  openTicket: function () {
    if (this.data.ticketId) wx.navigateTo({ url: '/pages/feedback/thread?id=' + encodeURIComponent(this.data.ticketId) })
  },

  // 弹层里点面板本身不该关掉弹层，catchtap 需要一个空实现占位
  noop: function () {},

  // ---------- 导航 ----------
  goBack: function () {
    motion.haptic('light')
    wx.navigateBack({
      fail: function () {
        wx.switchTab({ url: '/pages/mine/index' })
      },
    })
  },
})
