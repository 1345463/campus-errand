const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const perms = require('../../utils/perms')
const flags = require('../../utils/flags')

// 意见反馈处理（客服 / 超级管理员；服务端 admin_*_user_feedback 里也各查一次 admin_has_perm('support')）。
//
// 两条硬规则：
//   1) 驳回必须填理由 —— 理由会原样作为站内消息发给提交人，空理由等于「已驳回」三个字砸过去，
//      服务端会以「驳回需要填写理由」拒绝，这里先在页面拦一道，省一次往返；
//   2) 受理和驳回都要二次点击确认 —— 处理完会立刻给提交人发站内消息，撤不回来。

// 状态筛选：与 user_feedbacks.status 对齐
const TABS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待处理' },
  { key: 'resolved', label: '已受理' },
  { key: 'rejected', label: '已驳回' },
]

// 反馈类型 → 中文
const KIND_TEXT = {
  suggestion: '建议',
  complaint: '投诉',
  bug: '故障',
  other: '其他',
}

// 处理状态 → 中文
const STATUS_TEXT = {
  pending: '待处理',
  resolved: '已受理',
  rejected: '已驳回',
}

// 状态 → 颜色类：pending 提醒、resolved 绿、rejected 灰
const STATUS_CLASS = {
  pending: 'status-pending',
  resolved: 'status-done',
  rejected: 'status-canceled',
}

function kindText(kind) {
  return KIND_TEXT[kind] || '其他'
}

Page({
  data: {
    tabs: TABS,
    tab: 'all',
    list: [],
    loading: false,
    needLogin: false,
    denied: false,
    errorText: '',
    tipText: '',
    // 灰度开关 user_feedback：关着的时候用户端没有提交入口，这里提醒一下
    flagOn: true,

    // 驳回理由：只对 noteId 那一条生效
    noteId: 0,
    note: '',
    // 二次点击确认：armId + armAction 一起定位「哪一条的哪个动作已上膛」
    armId: 0,
    armAction: '',
    actingId: 0,
  },

  onLoad: function () {
    this.checkAndLoad()
  },

  // 从会话页返回时重拉一次，让未读数和对话摘要跟着更新
  onShow: function () {
    if (this._checked && !this.data.needLogin && !this.data.denied) this.load()
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

  onUnload: function () {
    // 页面销毁时清掉上膛计时器，避免回调打在已经不存在的页面上
    if (this._armTimer) {
      clearTimeout(this._armTimer)
      this._armTimer = null
    }
  },

  checkAndLoad: function () {
    const page = this
    return api
      .getSession()
      .then(function (session) {
        if (!session) {
          page.setData({ needLogin: true, loading: false, list: [], denied: false })
          return
        }
        // 客服权限；super 在服务端会被展开成全部权限，所以只判 support 一项就够
        return perms.load().then(function () {
          if (!perms.has('support')) {
            page.setData({ denied: true, loading: false, list: [] })
            return
          }
          page.setData({ needLogin: false, denied: false })
          return flags.ensure().then(function () {
            page._checked = true
            page.setData({ flagOn: flags.on('user_feedback') })
            return page.load()
          })
        })
      })
      .catch(function (error) {
        page.setData({ loading: false, errorText: api.getErrorMessage(error) })
      })
  },

  load: function () {
    const page = this
    page.setData({ loading: true, errorText: '', actingId: 0 })
    return api
      .adminListUserFeedbacks(page.data.tab, 50)
      .then(function (rows) {
        const list = rows.map(function (row) {
          const status = String(row.status || 'pending')
          return {
            id: row.id,
            kind: String(row.kind || 'other'),
            kindText: kindText(row.kind),
            content: String(row.content || ''),
            contact: String(row.contact || ''),
            status: status,
            statusText: STATUS_TEXT[status] || status,
            statusClass: STATUS_CLASS[status] || '',
            pending: status === 'pending',
            adminNote: String(row.admin_note || ''),
            createdText: api.formatTime(row.created_at),
            handledText: api.formatTime(row.handled_at),
            // 会话摘要：让客服在列表上就能看出哪一单还需要跟进
            replyCount: Number(row.reply_count) || 0,
            unreadCount: Number(row.unread_count) || 0,
            lastPreview: String(row.last_preview || ''),
            lastRoleText: row.last_role === 'admin' ? '客服' : '同学',
            lastTimeText: row.last_reply_at ? api.formatTime(row.last_reply_at) : '',
          }
        })
        // 处理完列表会重排，原先上膛 / 展开的输入框一律收起，避免残留状态指向错行
        page.setData({ list: list, loading: false, noteId: 0, note: '', armId: 0, armAction: '' })
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ loading: false, list: [], errorText: message })
        if (typeof console !== 'undefined' && console.error) console.error('[admin/feedback] list failed:', message, error)
        ui.toast({ title: message, icon: 'none', duration: 2500 })
      })
  },

  switchTab: function (event) {
    const page = this
    const key = String(event.currentTarget.dataset.key || 'all')
    if (key === page.data.tab) return
    page.clearArm()
    // setData 回调里再拉：等 tab 渲染完，列表不会用旧筛选闪一下
    page.setData({ tab: key, noteId: 0, note: '', tipText: '' }, function () {
      page.load()
    })
  },

  clearArm: function () {
    const page = this
    if (page._armTimer) {
      clearTimeout(page._armTimer)
      page._armTimer = null
    }
    page.setData({ armId: 0, armAction: '' })
  },

  cancelArm: function () {
    this.clearArm()
  },

  // 上膛：第一次点只是「准备执行」，4 秒内再点一次才真的写库
  arm: function (id, action) {
    const page = this
    if (page._armTimer) clearTimeout(page._armTimer)
    page.setData({ armId: id, armAction: action })
    page._armTimer = setTimeout(function () {
      page._armTimer = null
      if (page.data.armId === id && page.data.armAction === action) {
        page.setData({ armId: 0, armAction: '' })
      }
    }, 4000)
  },

  isArmed: function (id, action) {
    return this.data.armId === id && this.data.armAction === action
  },

  // 受理：不需要理由，但仍要二次确认（一受理就给提交人发站内消息）
  askResolve: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id)
    if (page.isArmed(id, 'resolve')) {
      page.clearArm()
      page.doHandle(id, 'resolve', '')
      return
    }
    page.arm(id, 'resolve')
  },

  openReject: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id)
    page.clearArm()
    page.setData({ noteId: id, note: '' })
  },

  cancelNote: function () {
    this.setData({ noteId: 0, note: '' })
    this.clearArm()
  },

  onNoteInput: function (event) {
    this.setData({ note: event.detail.value })
  },

  // 驳回：理由必填，页面先拦；确认同样要二次点击
  askReject: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id)
    const note = String(page.data.note || '').trim()

    if (!note) {
      ui.toast({ title: '驳回要填理由，同学会收到', icon: 'none' })
      return
    }
    if (page.isArmed(id, 'reject')) {
      page.clearArm()
      page.doHandle(id, 'reject', note)
      return
    }
    page.arm(id, 'reject')
  },

  doHandle: function (id, action, note) {
    const page = this
    page.setData({ actingId: id })
    ui.loading({ title: action === 'resolve' ? '受理中' : '驳回中', mask: true })
    api
      .adminHandleUserFeedback(id, action, note)
      .then(function () {
        ui.hideLoading()
        ui.toast({
          title: action === 'resolve' ? '已受理，已通知提交人' : '已驳回，已通知提交人',
          icon: 'success',
        })
        page.setData({
          actingId: 0,
          noteId: 0,
          note: '',
          tipText: action === 'resolve' ? '已受理：提交人会收到一条站内消息' : '已驳回：理由会以站内消息发给提交人',
        })
        // 重新拉列表：当前筛选下这条可能已经不符合条件，让它自然消失
        return page.load()
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ actingId: 0, errorText: message, tipText: '' })
        if (typeof console !== 'undefined' && console.error) console.error('[admin/feedback] handle failed:', message, error)
        guard.toastError(error)
      })
  },

  // 进工单会话：受理之后的双向跟进、追问、追问答复都在这个页面里
  openThread: function (event) {
    const id = Number(event.currentTarget.dataset.id)
    wx.navigateTo({ url: '/pages/feedback/thread?id=' + id })
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },

  // 从「我的」直接进来时没有上一页，退回不了就回「我的」，别卡在空白页
  goBack: function () {
    wx.navigateBack({
      fail: function () {
        wx.switchTab({ url: '/pages/mine/index' })
      },
    })
  },
})
