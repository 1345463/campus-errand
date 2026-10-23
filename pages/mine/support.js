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
// 后端没给值时用的兜底：三个上限集中放在这里，别散进各个函数
const CONTEXT_FAQ_LIMIT = 40
const HISTORY_TURNS = 3
const DEFAULT_TIMEOUT_MS = 30000

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

// 进气泡之前统一洗一遍文本。
// 两个目的：① 模型输出常常带首尾换行 / 连续空行，气泡 white-space 是 pre-wrap，
//   这些空行会原样渲染出来，看着就像「消息之间空了一大块」；
// ② 顺手压掉行尾空格，避免气泡右边出现莫名的空白。
function tidyText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
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
    if (item.pending) return
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
    // 会话区底部留白 = 输入区实测高度 + 一点余量，避免最后一条被压住。
    // 240 是首帧兜底（输入区还没渲染时量不到），量到之后会被覆盖。
    bodyPad: 240,
    // 临时调试信息：条数 / 每条高度 / 可滚距离，定位完一并删掉
    debugInfo: '',

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

  // 一次量三样东西，全部写进调试条，排查「只显示一条消息」时靠它定位：
  //   ① 每条消息的实际高度（哪条被撑高了一眼就能看出来）；
  //   ② 输入区高度 -> 换算成会话区底部留白（bodyPad）；
  //   ③ 整页文档高度 -> 配合窗口高度算出最大可滚距离，用来判断有没有贴底。
  measureLayout: function () {
    const page = this
    if (typeof wx.createSelectorQuery !== 'function') return
    try {
      const query = wx.createSelectorQuery().in(page)
      query.selectAll('.msg-row').boundingClientRect()
      query.select('.sup-input').boundingClientRect()
      query.select('.support-page').boundingClientRect()
      query.exec(function (res) {
        const rows = (res && res[0]) || []
        const input = (res && res[1]) || {}
        const doc = (res && res[2]) || {}
        const win = motion.systemInfo().windowHeight || 0
        if (doc.height) page._docHeight = doc.height
        if (win) page._windowHeight = win
        const pad = Math.round(Number(input.height) || 0)
        const next = {}
        // 余量给 24px：输入区边框/圆角之外再留一口气，最后一条不贴着输入框
        if (pad > 0) next.bodyPad = pad + 24
        const heights = []
        rows.forEach(function (row) {
          heights.push(Math.round(row.height || 0))
        })
        const maxScroll = Math.max(Math.round((page._docHeight || 0) - win), 0)
        next.debugInfo =
          '条数 ' + rows.length +
          ' · 各条高[' + heights.join(',') + ']' +
          ' · 可滚 ' + maxScroll +
          ' · 输入区 ' + pad
        page.setData(next)
      })
    } catch (e) {
      /* 查询失败不用管 */
    }
  },

  onReady: function () {
    // 布局第一帧之后才量得到真实高度，放 onLoad 里会量到 0。
    // 这里必须包一层：直接 setTimeout(this.measureLayout, 120) 会把 this 丢掉。
    const page = this
    setTimeout(function () {
      page.measureLayout()
    }, 120)
  },

  onUnload: function () {
    if (this._scrollTimer) clearTimeout(this._scrollTimer)
    if (this._measureTimer) clearTimeout(this._measureTimer)
    if (this._padTimer) clearTimeout(this._padTimer)
    if (this._timeout) clearTimeout(this._timeout)
    if (this._abort && typeof this._abort.abort === 'function') {
      try {
        this._abort.abort()
      } catch (e) {
        /* 忽略 */
      }
    }
    this._scrollTimer = null
    this._timeout = null
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
        // 关键：会话区是在 loading 变 false 之后才渲染的，
        // onReady 里根本量不到（量到 0，之后再没更新，贴底判定就一直空转）。
        // 所以要在这里补量一次，多等一帧让渲染落地。
        setTimeout(function () {
          page.measureLayout()
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

  reload: function () {
    this.boot()
  },

  // ---------- 消息 ----------
  pushMsg: function (msg) {
    const page = this
    const list = (page.data.messages || []).slice()
    const next = {
      id: msg.id,
      role: msg.role,
      kind: msg.kind,
      text: tidyText(msg.text),
      timeText: msg.timeText,
      pending: !!msg.pending,
    }
    if (msg.failed) next.failed = true
    list.push(next)
    page.setData({ messages: list })
    // 用户正贴着底部时，新气泡要自己滚进视野，否则要手动拉到底才看得到
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
    const list = (page.data.messages || []).map(function (item) {
      if (item.id !== id) return item
      const next = {
        id: item.id,
        role: item.role,
        kind: item.kind,
        text: tidyText(text),
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
    // 流式渲染期间也要跟着滚：字越堆越多，不跟着走用户只能看到开头几行
    page.scheduleScroll()
  },

  // --------------------------------------------------------------------------
  // 滚到底
  // 最终方案：不用 scroll-view，滚动交给页面自己，用 wx.pageScrollTo。
  // 之前在 scroll-view 上试过三种写法，全都不行，记下来别再回头：
  //   ① scroll-into-view 指消息节点 —— 节点没渲染完就指，滚空；
  //   ② scroll-top 塞超大值 —— 内容不足一屏时基础库会把内容顶上去，
  //      屏幕中间留一大片空白（就是截图里那个样子）；
  //   ③ scroll-top 塞实测高度 —— 得先量，而量高度的时机很容易踩空
  //      （onReady 时页面还在 loading，滚动区根本还没渲染）。
  // 页面滚动没有这些毛病：超过最大可滚距离时框架自己会夹到底部，
  // 既不会滚过头，也不需要知道内容有多高。
  // duration 给 0：流式输出时每次都带动画会一卡一卡的。
  // --------------------------------------------------------------------------
  scrollToBottom: function () {
    const page = this
    if (!(page.data.messages || []).length) return
    if (typeof wx.pageScrollTo !== 'function') return
    try {
      // 内容不足一屏时这一调用会失败，属于正常情况，安静吞掉即可
      wx.pageScrollTo({ scrollTop: 999999, duration: 0, fail: function () {} })
    } catch (e) {
      /* 页面不可滚时不必处理 */
    }
    // 滚完再量一次：新气泡进来后文档高度变了，贴底判定要用最新值
    if (page._measureTimer) clearTimeout(page._measureTimer)
    page._measureTimer = setTimeout(function () {
      page._measureTimer = null
      page.measureLayout()
    }, 60)
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
    }, 120)
  },

  // 页面级滚动回调：记一下用户是否还贴在底部，不在的话自动滚动暂停，
  // 用户自己往下翻回底部附近才恢复跟随（不然翻历史时会被一直拽回底部）。
  // 文档高度和窗口高度都是量出来的，没量到时不做判断、保持「未知」——
  // 否则算出来一定「没贴底」，自动滚动会从第一条起就永久停摆。
  onPageScroll: function (event) {
    const page = this
    const top = Number((event && event.scrollTop) || 0)
    const doc = page._docHeight || 0
    const win = page._windowHeight || 0
    if (!doc || !win) return
    // 留 60px 容差：手指滑动很难精确停在 0
    page._atBottom = doc - win - top < 60
  },

  // 键盘弹起时把页面拉到底：不然最后一条消息会被键盘盖住，
  // 用户一边打字一边看不到自己刚发的那句。
  onFocus: function () {
    const page = this
    setTimeout(function () {
      page.scrollToBottom()
    }, 260)
  },

  // ---------- 输入 ----------
  onInput: function (event) {
    const page = this
    const value = event.detail.value || ''
    page.setData({ input: value, countText: value.length + ' / ' + MAX_LEN })
    // 输入框是自增高的一行变多行会把输入区顶高，底部留白得跟着变，
    // 否则最后一条消息会被压住。节流一下，别每个字都量。
    if (page._padTimer) return
    page._padTimer = setTimeout(function () {
      page._padTimer = null
      page.measureLayout()
    }, 200)
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

    // 历史要在占位气泡之前拼：此刻 messages 里刚好是「上文 + 用户刚才那句」，
    // 占位气泡 push 进去以后会被 pending 过滤掉，所以放前放后都安全，放前面更好读。
    const history = buildHistory(page.data.messages, settings.history_turns, '')

    const msgId = page.pushBot('正在思考…', 'ai')
    page.updateMsg(msgId, '正在思考…', { pending: true })

    const used = bumpQuota()
    page.setData({
      aiUsed: used,
      aiLeftText: String(Math.max(page.data.aiLimit - used, 0)),
    })

    const messages = [{ role: 'system', content: buildSystemPrompt(settings, page.data.faqList) }]
    if (history.length) {
      history.forEach(function (item) {
        messages.push(item)
      })
    } else {
      // 后台把历史轮数调成 0 时也要保证模型知道用户问了什么
      messages.push({ role: 'user', content: '用户提问：' + sanitize(question) })
    }

    // 超时一道保险：弱网下流可能半天不动，别让用户对着「正在思考」干等
    const timeoutMs = Math.max(num(settings.timeout_ms, DEFAULT_TIMEOUT_MS), 5000)
    let controller = null
    if (typeof AbortController === 'function') {
      try {
        controller = new AbortController()
        page._abort = controller
      } catch (e) {
        controller = null
      }
    }
    if (controller) {
      page._timeout = setTimeout(function () {
        page._timeout = null
        try {
          controller.abort()
        } catch (e) {
          /* 忽略 */
        }
      }, timeoutMs)
    }

    api
      .llmChat(
        settings.ai_model,
        messages,
        function (partial) {
          page.updateMsg(msgId, partial, { pending: true })
        },
        {
          conversationId: page.data.conversationId || '',
          signal: controller ? controller.signal : undefined,
          temperature: num(settings.temperature, 0.3),
          maxTokens: num(settings.max_tokens, 400),
        }
      )
      .then(function (answer) {
        if (page._timeout) {
          clearTimeout(page._timeout)
          page._timeout = null
        }
        page._abort = null
        const text = String(answer || '').trim()
        page.updateMsg(msgId, text || '这个我答不准，请点「转人工」让人工客服帮你。', { pending: false })
        page.setData({ sending: false })
        page.scrollToBottom()
      })
      .catch(function (error) {
        if (page._timeout) {
          clearTimeout(page._timeout)
          page._timeout = null
        }
        page._abort = null
        const message = api.getErrorMessage(error)
        if (typeof console !== 'undefined' && console.error) {
          console.error('[mine/support] llm failed:', message, error)
        }
        // 自己 abort 出去的（多半是超时），换个用户看得懂的说法
        const aborted = message.indexOf('abort') >= 0 || message.indexOf('Abort') >= 0
        page.updateMsg(
          msgId,
          aborted
            ? '这次想太久了（超过 ' + Math.round(timeoutMs / 1000) + ' 秒没答完）。可以换个简单点的问法，或点「转人工」。'
            : 'AI 暂时答不上来（' + message + '）。可以换个问法，或点「转人工」。',
          { pending: false, failed: true }
        )
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
