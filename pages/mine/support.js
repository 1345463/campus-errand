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
//   2) 每人每天 AI 提问有上限，存在本地，防止一台机器把配额刷干；
//   3) 大模型只能看到 FAQ 当"平台资料"，资料里没有的必须说答不准并引导转人工。

const MAX_LEN = 200
const QUOTA_KEY = 'ai_support_quota_v1'
const HOT_LIMIT = 8
// 塞进 system 的 FAQ 条数上限：全量塞进去 token 太贵，且条目多了模型反而挑不准
const CONTEXT_FAQ_LIMIT = 40

const DEFAULT_PROMPT =
  '你是「校园跑腿」小程序的智能客服助手。只回答与本平台相关的问题。' +
  '用中文简短回答，单次不超过 120 字。只能依据下面「平台资料」回答；' +
  '资料里没有的直接说明答不准，并请用户点「转人工」，绝不编造价格、时限或规则。'

function dayKey() {
  const d = new Date()
  const m = d.getMonth() + 1
  const day = d.getDate()
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day)
}

// 每日配额记在本地：改日期就自动归零，不依赖服务端也不依赖登录态
function readQuota() {
  const raw = ui.getStorage(QUOTA_KEY)
  if (!raw || raw.day !== dayKey()) return 0
  return Number(raw.used) || 0
}

function bumpQuota() {
  const used = readQuota() + 1
  ui.setStorage(QUOTA_KEY, { day: dayKey(), used: used })
  return used
}

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
  if (!key) return null
  let best = null
  let bestScore = 0
  ;(list || []).forEach(function (item) {
    let score = 0
    const q = norm(item.question)
    if (q && (key.indexOf(q) >= 0 || q.indexOf(key) >= 0)) score += 20
    splitKeywords(item.keywords).forEach(function (word) {
      const kw = norm(word)
      if (!kw || key.indexOf(kw) < 0) return
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

function buildSystemPrompt(settings, faqList) {
  const base = String((settings && settings.ai_prompt) || '').trim() || DEFAULT_PROMPT
  const rows = (faqList || []).slice(0, CONTEXT_FAQ_LIMIT)
  if (!rows.length) return base
  const body = rows
    .map(function (item) {
      return 'Q：' + item.question + '\nA：' + item.answer
    })
    .join('\n')
  return base + '\n\n平台资料：\n' + body
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
    toView: '',
    input: '',
    countText: '0 / ' + MAX_LEN,
    sending: false,

    // 热门问题（点一下直接问）
    hot: [],
    hotOpen: true,

    // AI 能力：开关 + 有没有选模型 + 今天还剩几次
    aiReady: false,
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
    page.boot()
  },

  onUnload: function () {
    if (this._abort && typeof this._abort.abort === 'function') {
      try {
        this._abort.abort()
      } catch (e) {
        /* 忽略 */
      }
    }
    this._abort = null
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
        return Promise.all([api.listFaqItems(), api.getFaqSettings()])
      })
      .then(function (result) {
        if (!result) return null
        const faqList = result[0] || []
        const settings = result[1] || {}
        const limit = Number(settings.daily_limit) || 20
        const used = readQuota()
        page.setData({
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
        page.pushBot(welcome, 'tip')
        page.setData({ loading: false })
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

  reload: function () {
    this.boot()
  },

  // ---------- 消息 ----------
  pushMsg: function (msg) {
    const page = this
    const list = (page.data.messages || []).slice()
    list.push(msg)
    page.setData({ messages: list })
    page.scrollToBottom()
    return msg.id
  },

  pushBot: function (text, kind) {
    return this.pushMsg({
      id: nextId(),
      role: 'bot',
      kind: kind || 'ai',
      text: String(text || ''),
      timeText: nowText(),
      pending: false,
    })
  },

  updateMsg: function (id, text, extra) {
    const page = this
    const list = (page.data.messages || []).map(function (item) {
      if (item.id !== id) return item
      const next = {
        id: item.id,
        role: item.role,
        kind: item.kind,
        text: String(text || ''),
        timeText: item.timeText,
        pending: false,
      }
      if (extra) {
        Object.keys(extra).forEach(function (key) {
          next[key] = extra[key]
        })
      }
      return next
    })
    page.setData({ messages: list })
  },

  scrollToBottom: function () {
    const page = this
    const list = page.data.messages || []
    if (!list.length) return
    const last = list[list.length - 1]
    // setData 之后 DOM 未必就位，晚一帧再滚，否则最后一条会被输入框盖住
    setTimeout(function () {
      page.setData({ toView: last.id })
    }, 80)
  },

  // ---------- 输入 ----------
  onInput: function (event) {
    const value = event.detail.value || ''
    this.setData({ input: value, countText: value.length + ' / ' + MAX_LEN })
  },

  onHotTap: function (event) {
    const text = String(event.currentTarget.dataset.q || '')
    if (!text) return
    motion.haptic('light')
    this.setData({ input: text, countText: text.length + ' / ' + MAX_LEN })
    this.send()
  },

  toggleHot: function () {
    motion.haptic('light')
    this.setData({ hotOpen: !this.data.hotOpen })
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

    page.setData({ sending: true, input: '', countText: '0 / ' + MAX_LEN })
    page.pushMsg({ id: nextId(), role: 'me', kind: 'me', text: raw, timeText: nowText(), pending: false })

    const faq = matchFaq(raw, page.data.faqList)
    if (faq) {
      // 固定回答：零延迟、零成本，也最可信
      page.pushBot(faq.answer, 'faq')
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
        'ai'
      )
      page.setData({ sending: false })
      return
    }
    if (page.data.aiUsed >= page.data.aiLimit) {
      page.pushBot(
        '今天 AI 提问次数用完了（上限 ' + page.data.aiLimit + ' 次/天）。可以先看看上面的热门问题，或点「转人工」。',
        'ai'
      )
      page.setData({ sending: false })
      return
    }

    const msgId = page.pushBot('正在思考…', 'ai')
    page.updateMsg(msgId, '正在思考…', { pending: true })

    const used = bumpQuota()
    page.setData({
      aiUsed: used,
      aiLeftText: String(Math.max(page.data.aiLimit - used, 0)),
    })

    const messages = [
      { role: 'system', content: buildSystemPrompt(settings, page.data.faqList) },
      { role: 'user', content: '用户提问：' + sanitize(question) },
    ]

    // AbortController 在部分基础库里不存在，不存在就不支持中断，不影响主流程
    let controller = null
    if (typeof AbortController === 'function') {
      try {
        controller = new AbortController()
        page._abort = controller
      } catch (e) {
        controller = null
      }
    }

    api
      .llmChat(
        settings.ai_model,
        messages,
        function (partial) {
          page.updateMsg(msgId, partial, { pending: true })
        },
        { conversationId: page.data.conversationId || '', signal: controller ? controller.signal : undefined }
      )
      .then(function (answer) {
        page._abort = null
        const text = String(answer || '').trim()
        page.updateMsg(msgId, text || '这个我答不准，请点「转人工」让人工客服帮你。', { pending: false })
        page.setData({ sending: false })
        page.scrollToBottom()
      })
      .catch(function (error) {
        page._abort = null
        const message = api.getErrorMessage(error)
        if (typeof console !== 'undefined' && console.error) {
          console.error('[mine/support] llm failed:', message, error)
        }
        page.updateMsg(msgId, 'AI 暂时答不上来（' + message + '）。可以换个问法，或点「转人工」。', {
          pending: false,
          failed: true,
        })
        page.setData({ sending: false })
      })
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
    const lines = []
    const list = page.data.messages || []
    for (let i = Math.max(list.length - 6, 0); i < list.length; i += 1) {
      const item = list[i]
      lines.push((item.role === 'me' ? '我：' : '助手：') + item.text)
    }
    const content = (lines.length ? lines.join('\n') + '\n\n' : '') + '（由智能客服转人工）'

    page.setData({ humanSending: true })
    ui.loading({ title: '提交中', mask: true })
    api
      .submitUserFeedback('other', content.slice(0, 500), contact)
      .then(function () {
        ui.hideLoading()
        page.setData({ humanSending: false, humanOpen: false, humanContact: '' })
        page.pushBot('工单已提交，客服会尽快回复，可以在「我的 → 意见反馈」里跟进。', 'tip')
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
            if (ok) wx.switchTab({ url: '/pages/mine/index' })
          })
          return
        }
        guard.toastError(error)
      })
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
