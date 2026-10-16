const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')

// 工单跟进会话：客服（support / super）和提交人共用这一个页面。
// 「能不能发言」由服务端 feedback_detail 的 can_reply 决定，前端不自己猜身份：
//   待处理  —— 只有客服能说话，且第一条回复＝受理；
//   已受理  —— 双方都能说话（这是常态）；
//   已驳回  —— 双方都不能说，客服可以先点「重新受理」再继续。
// 这样可以避免前后端各自维护一套状态规则、然后两边写歪还不报错。

const KIND_TEXT = {
  suggestion: '建议',
  complaint: '投诉',
  bug: '故障',
  other: '其他',
}

const STATUS_TEXT = {
  pending: '待处理',
  resolved: '已受理',
  rejected: '已驳回',
}

const STATUS_CLASS = {
  pending: 'status-pending',
  resolved: 'status-done',
  rejected: 'status-canceled',
}

// 轮询间隔：客服对话是即时场景，10 秒拉一次，掉线也不至于让用户盯着旧消息
const POLL_MS = 10000

Page({
  data: {
    id: 0,
    loading: true,
    errorText: '',
    tipText: '',

    detail: null,
    kindText: '其他',
    statusText: '待处理',
    statusClass: 'status-pending',
    createdText: '',
    handledText: '',

    isAdmin: false,
    canReply: false,
    closeHint: '',

    thread: [],
    // scroll-view 定位到哪一条；为空表示不主动滚动
    toView: '',

    input: '',
    countText: '0 / 500',
    sending: false,
    reopening: false,
  },

  onLoad: function (options) {
    const page = this
    const id = Number((options && options.id) || 0)
    page.setData({ id: id })
    if (!id) {
      page.setData({ loading: false, errorText: '缺少工单编号' })
      return
    }
    page.load()
    // 轮询：拿到 canReply/isAdmin 后开始，页面销毁时清掉
    page._timer = setInterval(function () {
      if (!page.data.id) return
      page.load(true)
    }, POLL_MS)
  },

  onUnload: function () {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  },

  onHide: function () {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  },

  onShow: function () {
    const page = this
    // 从后台切回来时把轮询补上（onHide 时被清掉了）
    if (page.data.id && !page._timer) {
      page._timer = setInterval(function () {
        page.load(true)
      }, POLL_MS)
    }
  },

  // silent=true 时不显示「加载中」，用于轮询刷新，避免页面一直在闪
  load: function (silent) {
    const page = this
    const id = page.data.id
    if (!silent) page.setData({ loading: true, errorText: '' })
    return api
      .feedbackDetail(id)
      .then(function (detail) {
        if (!detail) {
          page.setData({ loading: false, errorText: '这条反馈不存在或你没有权限查看' })
          return null
        }
        const status = String(detail.status || 'pending')
        page.setData({
          detail: detail,
          loading: false,
          errorText: '',
          kindText: KIND_TEXT[detail.kind] || '其他',
          statusText: STATUS_TEXT[status] || status,
          statusClass: STATUS_CLASS[status] || '',
          createdText: api.formatTime(detail.created_at),
          handledText: detail.handled_at ? api.formatTime(detail.handled_at) : '',
          isAdmin: !!detail.is_admin,
          canReply: !!detail.can_reply,
          closeHint: String(detail.close_hint || ''),
        })
        wx.setNavigationBarTitle({
          title: detail.is_admin ? '跟进：' + String(detail.author_name || '同学') : '客服跟进',
        })
        return null
      })
      .then(function () {
        if (!page.data.detail) return null
        return api.feedbackThread(id, 200)
      })
      .then(function (rows) {
        if (!rows) return null
        const thread = (rows || []).map(function (row) {
          const mine = !!row.mine
          return {
            id: row.id,
            role: String(row.role || 'user'),
            content: String(row.content || ''),
            author: String(row.author || (row.role === 'admin' ? '客服' : '同学')),
            mine: mine,
            align: mine ? 'mine' : 'peer',
            timeText: api.formatTime(row.created_at),
          }
        })
        page.setData({ thread: thread })
        page.scrollToBottom()
        return null
      })
      .then(function () {
        if (!page.data.detail) return null
        return api.feedbackMarkRead(page.data.id).catch(function () {
          return false
        })
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ loading: false, errorText: message })
        if (typeof console !== 'undefined' && console.error) {
          console.error('[feedback/thread] load failed:', message, error)
        }
        guard.toastError(error)
      })
  },

  scrollToBottom: function () {
    const page = this
    const thread = page.data.thread || []
    if (!thread.length) return
    const last = thread[thread.length - 1]
    // setData 之后 DOM 未必立刻就位，晚一帧再滚，否则最后一条会被输入框盖住
    setTimeout(function () {
      page.setData({ toView: 'msg-' + last.id })
    }, 80)
  },

  onInput: function (event) {
    const value = event.detail.value || ''
    this.setData({ input: value, countText: value.length + ' / 500' })
  },

  send: function () {
    const page = this
    const text = String(page.data.input || '').trim()
    if (page.data.sending) return
    if (!text) {
      ui.toast({ title: '先写点内容', icon: 'none' })
      return
    }
    if (!page.data.canReply) {
      ui.toast({ title: page.data.closeHint || '当前不能发言', icon: 'none' })
      return
    }
    page.setData({ sending: true })
    api
      .feedbackReply(page.data.id, text)
      .then(function () {
        page.setData({
          sending: false,
          input: '',
          countText: '0 / 500',
          tipText: '已发送',
        })
        return page.load(true)
      })
      .catch(function (error) {
        page.setData({ sending: false, tipText: '' })
        guard.toastError(error)
      })
  },

  // 客服专用：把驳回的工单重新受理，恢复双向对话
  reopen: function () {
    const page = this
    if (page.data.reopening) return
    page.setData({ reopening: true })
    ui.loading({ title: '受理中', mask: true })
    api
      .adminReopenFeedback(page.data.id)
      .then(function () {
        ui.hideLoading()
        ui.toast({ title: '已重新受理', icon: 'success' })
        page.setData({ reopening: false, tipText: '已重新受理，双方可以继续沟通了' })
        return page.load(true)
      })
      .catch(function (error) {
        ui.hideLoading()
        page.setData({ reopening: false })
        guard.toastError(error)
      })
  },

  // 复制工单原文，方便客服粘到别的地方排查
  copyContent: function () {
    const page = this
    const text = page.data.detail ? String(page.data.detail.content || '') : ''
    if (!text) return
    wx.setClipboardData({ data: text })
  },

  retry: function () {
    this.load()
  },

  goBack: function () {
    wx.navigateBack({
      fail: function () {
        wx.switchTab({ url: '/pages/mine/index' })
      },
    })
  },
})
