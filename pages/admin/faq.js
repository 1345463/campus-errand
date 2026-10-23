const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const perms = require('../../utils/perms')

// 智能客服后台：左边维护 FAQ 固定回答，右边配大模型兜底。
//
// 两条重要约定：
//   1) 这个页面**不挂 ai_support 灰度开关**。它是配置页，被自己的开关挡住就变成了
//      「关掉之后再也进不去打开」—— 和 flags / banners 页一个道理。
//      真正面向用户的客服页 pages/mine/support 才走开关。
//   2) 权限用 support（客服）。super 在 admin_my_perms 里隐含全部权限，不需要另写。
//      真正的拦截在每个 admin_xxx 的 RPC 里做，前端只负责显示/隐藏。

Page({
  data: {
    loading: true,
    needLogin: false,
    denied: false,
    errorText: '',

    // FAQ
    list: [],
    editing: false,
    editingId: 0,
    saving: false,
    form: {
      category: '常见问题',
      question: '',
      answer: '',
      keywords: '',
      sort_order: '100',
      enabled: true,
    },
    formTitle: '新增常见问题',

    // AI 设置
    aiEnabled: false,
    modelIds: [],
    modelNames: [],
    modelIndex: 0,
    modelHint: '',
    aiPrompt: '',
    welcome: '',
    dailyLimit: '20',
    settingsSaving: false,

    // 模型 API 参数（与 support 页 llmChat 一一对应）
    temperature: '0.3',
    maxTokens: '400',
    timeoutSec: '30',
    historyTurns: '3',
    contextFaqLimit: '40',
    testing: false,
    testText: '',
  },

  onLoad: function () {
    this.checkAndLoad()
  },

  onPullDownRefresh: function () {
    const page = this
    this.load().then(
      function () {
        wx.stopPullDownRefresh()
      },
      function () {
        wx.stopPullDownRefresh()
      }
    )
  },

  checkAndLoad: function () {
    const page = this
    return api
      .getSession()
      .then(function (session) {
        if (!session) {
          page.setData({ needLogin: true, loading: false, list: [], denied: false })
          return null
        }
        return perms.load().then(function () {
          if (!perms.has('support')) {
            page.setData({ denied: true, loading: false, list: [] })
            return null
          }
          page.setData({ needLogin: false, denied: false })
          return page.load()
        })
      })
      .catch(function (error) {
        page.setData({ loading: false, errorText: api.getErrorMessage(error) })
      })
  },

  load: function () {
    const page = this
    page.setData({ loading: true, errorText: '', editing: false, editingId: 0 })
    return Promise.all([
      api.adminListFaqItems(),
      api.adminGetFaqSettings(),
      api
        .llmModels()
        .then(function (rows) {
          return rows || []
        })
        .catch(function () {
          // 模型列表拿不到不影响改 FAQ，只是不能选模型而已
          return []
        }),
    ])
      .then(function (result) {
        const items = result[0] || []
        const settings = result[1] || {}
        const models = result[2] || []

        const list = items.map(function (row) {
          return {
            id: Number(row.id) || 0,
            category: String(row.category || '常见问题'),
            question: String(row.question || ''),
            answer: String(row.answer || ''),
            keywords: String(row.keywords || ''),
            sortOrder: Number(row.sort_order) || 0,
            enabled: !!row.enabled,
            updatedText: api.formatTime(row.updated_at),
          }
        })

        // 模型下拉：disabled 的不能选，也别拿它当兜底默认值
        const usable = models.filter(function (item) {
          return item && item.disabled !== true
        })
        const modelIds = []
        const modelNames = []
        usable.forEach(function (item) {
          modelIds.push(String(item.id || ''))
          modelNames.push(String(item.name || item.id || ''))
        })
        const current = String(settings.ai_model || '')
        let modelIndex = current ? modelIds.indexOf(current) : -1
        if (modelIndex < 0 && modelIds.length) modelIndex = 0

        // 这四个是新加的参数，服务端可能还没刷出来，取不到就按兜底值显示
        const temperature = Number(settings.temperature)
        const timeoutSec = Math.round((Number(settings.timeout_ms) || 30000) / 1000)

        page.setData({
          list: list,
          loading: false,
          aiEnabled: !!settings.ai_enabled,
          aiPrompt: String(settings.ai_prompt || ''),
          welcome: String(settings.welcome || ''),
          dailyLimit: String(Number(settings.daily_limit) || 20),
          modelIds: modelIds,
          modelNames: modelNames,
          modelIndex: modelIndex < 0 ? 0 : modelIndex,
          modelHint: modelIds.length
            ? ''
            : '没有可用模型：请先在云服务里开通大模型能力，或稍后重试',
          temperature: isNaN(temperature) ? '0.3' : String(temperature),
          maxTokens: String(Number(settings.max_tokens) || 400),
          timeoutSec: String(timeoutSec),
          historyTurns: String(Number(settings.history_turns) || 0),
          contextFaqLimit: String(Number(settings.context_faq_limit) || 0),
          testText: '',
        })
        return null
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ loading: false, list: [], errorText: message })
        if (typeof console !== 'undefined' && console.error) console.error('[admin/faq]', message, error)
        ui.toast({ title: message, icon: 'none', duration: 2500 })
      })
  },

  // ---------- 设置 ----------
  onAiToggle: function (event) {
    this.setData({ aiEnabled: !!event.detail.value })
  },

  onModelChange: function (event) {
    this.setData({ modelIndex: Number(event.detail.value) || 0 })
  },

  onPromptInput: function (event) {
    this.setData({ aiPrompt: event.detail.value || '' })
  },

  onWelcomeInput: function (event) {
    this.setData({ welcome: event.detail.value || '' })
  },

  onLimitInput: function (event) {
    this.setData({ dailyLimit: event.detail.value || '' })
  },

  onTemperatureInput: function (event) {
    this.setData({ temperature: event.detail.value || '' })
  },

  onMaxTokensInput: function (event) {
    this.setData({ maxTokens: event.detail.value || '' })
  },

  onTimeoutInput: function (event) {
    this.setData({ timeoutSec: event.detail.value || '' })
  },

  onHistoryInput: function (event) {
    this.setData({ historyTurns: event.detail.value || '' })
  },

  onContextInput: function (event) {
    this.setData({ contextFaqLimit: event.detail.value || '' })
  },

  // 连通测试：改完参数不用真去客服页问一轮才知道配错没。
  // 用的是页面上「此刻填的值」，不用先保存 —— 先保存再测的话，
  // 配错了等于把错值先写进库里。
  testModel: function () {
    const page = this
    if (page.data.testing) return
    const modelId = page.data.modelIds[page.data.modelIndex]
    if (!modelId) {
      ui.toast({ title: '没有可选模型', icon: 'none' })
      return
    }
    const started = Date.now()
    page.setData({ testing: true, testText: '正在调用…' })
    api
      .llmChat(
        modelId,
        [
          { role: 'system', content: '你只做连通性检查，用户说什么都只回两个字：正常' },
          { role: 'user', content: '连通性检查' },
        ],
        null,
        { temperature: Number(page.data.temperature) || 0.3, maxTokens: Number(page.data.maxTokens) || 400 }
      )
      .then(function (answer) {
        const cost = Date.now() - started
        const reply = String(answer || '').trim().slice(0, 40)
        page.setData({
          testing: false,
          testText: '调用成功，耗时 ' + cost + ' ms' + (reply ? '，模型返回：' + reply : ''),
        })
      })
      .catch(function (error) {
        page.setData({ testing: false, testText: '调用失败：' + api.getErrorMessage(error) })
      })
  },

  saveSettings: function () {
    const page = this
    if (page.data.settingsSaving) return
    const limit = Number(page.data.dailyLimit)
    if (!limit || limit < 1 || limit > 200) {
      ui.toast({ title: '每日上限要在 1 到 200 之间', icon: 'none' })
      return
    }
    if (page.data.aiEnabled && !page.data.modelIds.length) {
      ui.toast({ title: '没有可选模型，先开通大模型能力', icon: 'none' })
      return
    }

    // 模型参数逐个卡范围：这些值直接进 llmChat，超界会被服务端整条拒绝，
    // 用户端看到的就是「AI 答不上来」，很难联想到是后台配了一个 200 度的温度
    const temperature = Number(page.data.temperature)
    const maxTokens = Number(page.data.maxTokens)
    const timeoutSec = Number(page.data.timeoutSec)
    const historyTurns = Number(page.data.historyTurns)
    const contextFaqLimit = Number(page.data.contextFaqLimit)
    if (isNaN(temperature) || temperature < 0 || temperature > 1) {
      ui.toast({ title: '温度要在 0 到 1 之间', icon: 'none' })
      return
    }
    if (isNaN(maxTokens) || maxTokens < 50 || maxTokens > 2000) {
      ui.toast({ title: '最大字数要在 50 到 2000 之间', icon: 'none' })
      return
    }
    if (isNaN(timeoutSec) || timeoutSec < 5 || timeoutSec > 120) {
      ui.toast({ title: '超时要在 5 到 120 秒之间', icon: 'none' })
      return
    }
    if (isNaN(historyTurns) || historyTurns < 0 || historyTurns > 8) {
      ui.toast({ title: '历史轮数要在 0 到 8 之间', icon: 'none' })
      return
    }
    if (isNaN(contextFaqLimit) || contextFaqLimit < 0 || contextFaqLimit > 100) {
      ui.toast({ title: '注入 FAQ 条数要在 0 到 100 之间', icon: 'none' })
      return
    }

    page.setData({ settingsSaving: true })
    ui.loading({ title: '保存中', mask: true })
    api
      .adminUpdateFaqSettings({
        ai_enabled: !!page.data.aiEnabled,
        ai_model: page.data.modelIds[page.data.modelIndex] || '',
        ai_prompt: page.data.aiPrompt,
        welcome: page.data.welcome,
        daily_limit: limit,
        temperature: temperature,
        max_tokens: maxTokens,
        context_faq_limit: contextFaqLimit,
        history_turns: historyTurns,
        timeout_ms: Math.round(timeoutSec * 1000),
      })
      .then(function () {
        ui.hideLoading()
        page.setData({ settingsSaving: false, errorText: '' })
        ui.toast({ title: '已保存', icon: 'success' })
      })
      .catch(function (error) {
        ui.hideLoading()
        page.setData({ settingsSaving: false })
        page.setData({ errorText: api.getErrorMessage(error) })
        guard.toastError(error)
      })
  },

  // ---------- FAQ 编辑 ----------
  // 表单是整个页面的最后一张卡片。点「新增 / 编辑」时如果只是 setData，
  // 新卡片会出现在列表下方一两屏的位置，屏幕上什么都不变 —— 用户看到的就是
  // 「点了没反应」。所以每次打开表单都要把页面滚过去。
  scrollToForm: function () {
    if (typeof wx.createSelectorQuery !== 'function') return
    // 等一帧让 auto-height 的 textarea 把高度撑开，否则量到的位置会偏上
    setTimeout(function () {
      // 页面级查询，不要加 .in(this)：那是组件内查询的用法
      const query = wx.createSelectorQuery()
      query.select('#faq-form').boundingClientRect()
      query.selectViewport().scrollOffset()
      query.exec(function (res) {
        const box = (res && res[0]) || null
        const view = (res && res[1]) || {}
        // 量不到就退化成滚到底 —— 表单是页面最后一张卡片，滚到底一定能看到
        if (!box) {
          wx.pageScrollTo({ scrollTop: 999999, duration: 200 })
          return
        }
        // boundingClientRect 是相对视口的，加上当前 scrollTop 才是文档绝对位置
        const top = Math.max((Number(view.scrollTop) || 0) + box.top - 12, 0)
        wx.pageScrollTo({ scrollTop: top, duration: 200 })
      })
    }, 80)
  },

  openForm: function (patch) {
    const page = this
    page.setData(patch, function () {
      page.scrollToForm()
    })
  },

  newFaq: function () {
    this.openForm({
      editing: true,
      editingId: 0,
      formTitle: '新增常见问题',
      form: {
        category: '常见问题',
        question: '',
        answer: '',
        keywords: '',
        sort_order: '100',
        enabled: true,
      },
    })
  },

  editFaq: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id) || 0
    const row = page.data.list.filter(function (item) {
      return item.id === id
    })[0]
    if (!row) return
    page.openForm({
      editing: true,
      editingId: id,
      formTitle: '编辑常见问题',
      form: {
        category: row.category,
        question: row.question,
        answer: row.answer,
        keywords: row.keywords,
        sort_order: String(row.sortOrder),
        enabled: row.enabled,
      },
    })
  },

  cancelEdit: function () {
    this.setData({ editing: false, editingId: 0 })
  },

  bindField: function (event) {
    const key = String(event.currentTarget.dataset.field || '')
    if (!key) return
    const form = this.data.form || {}
    const next = {
      category: form.category,
      question: form.question,
      answer: form.answer,
      keywords: form.keywords,
      sort_order: form.sort_order,
      enabled: form.enabled,
    }
    next[key] = event.detail.value
    this.setData({ form: next })
  },

  onFormToggle: function (event) {
    const form = this.data.form || {}
    this.setData({
      form: {
        category: form.category,
        question: form.question,
        answer: form.answer,
        keywords: form.keywords,
        sort_order: form.sort_order,
        enabled: !!event.detail.value,
      },
    })
  },

  saveFaq: function () {
    const page = this
    if (page.data.saving) return
    const form = page.data.form || {}
    const question = String(form.question || '').trim()
    const answer = String(form.answer || '').trim()
    if (!question) {
      ui.toast({ title: '问题不能为空', icon: 'none' })
      return
    }
    if (!answer) {
      ui.toast({ title: '回答不能为空', icon: 'none' })
      return
    }

    // 排序留空按 100 处理（Number('') === 0，直接算会排到全站最前面），
    // 并收口到 0..9999 的整数，避免脏值把列表顺序搞乱。
    const sortRaw = String(form.sort_order == null ? '' : form.sort_order).trim()
    const sortNum = sortRaw === '' ? 100 : Number(sortRaw)
    const sortOrder = isNaN(sortNum) ? 100 : Math.min(Math.max(Math.round(sortNum), 0), 9999)
    page.setData({ saving: true })
    ui.loading({ title: '保存中', mask: true })
    api
      .adminUpsertFaqItem({
        id: page.data.editingId || null,
        category: String(form.category || '').trim(),
        question: question,
        answer: answer,
        keywords: String(form.keywords || '').trim(),
        sort_order: sortOrder,
        enabled: !!form.enabled,
      })
      .then(function () {
        ui.hideLoading()
        page.setData({ saving: false, editing: false, editingId: 0 })
        ui.toast({ title: '已保存', icon: 'success' })
        return page.load()
      })
      .catch(function (error) {
        ui.hideLoading()
        page.setData({ saving: false })
        guard.toastError(error)
      })
  },

  // 上下架：只改 enabled，不动内容，比整条删掉安全
  toggleFaq: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id) || 0
    const row = page.data.list.filter(function (item) {
      return item.id === id
    })[0]
    if (!row) return
    ui.loading({ title: row.enabled ? '下架中' : '上架中', mask: true })
    api
      .adminUpsertFaqItem({
        id: id,
        category: row.category,
        question: row.question,
        answer: row.answer,
        keywords: row.keywords,
        sort_order: row.sortOrder,
        enabled: !row.enabled,
      })
      .then(function () {
        ui.hideLoading()
        return page.load()
      })
      .catch(function (error) {
        ui.hideLoading()
        guard.toastError(error)
      })
  },

  deleteFaq: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id) || 0
    const row = page.data.list.filter(function (item) {
      return item.id === id
    })[0]
    if (!row) return
    ui
      .confirm({
        title: '删除这条 FAQ？',
        content: row.question,
        confirmText: '删除',
        defaultConfirm: false,
      })
      .then(function (ok) {
        if (!ok) return null
        ui.loading({ title: '删除中', mask: true })
        return api.adminDeleteFaqItem(id).then(function () {
          ui.hideLoading()
          ui.toast({ title: '已删除', icon: 'success' })
          return page.load()
        })
      })
      .catch(function (error) {
        if (!error) return
        ui.hideLoading()
        guard.toastError(error)
      })
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },

  goBack: function () {
    wx.navigateBack({
      fail: function () {
        wx.switchTab({ url: '/pages/mine/index' })
      },
    })
  },
})
