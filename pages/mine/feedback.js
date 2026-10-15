const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const flags = require('../../utils/flags')

const KINDS = [
  { key: 'suggestion', label: '建议', desc: '功能、体验上的改进想法' },
  { key: 'complaint', label: '投诉', desc: '对订单或接单员的不满' },
  { key: 'bug', label: '故障', desc: '页面打不开、按钮点了没反应' },
  { key: 'other', label: '其他', desc: '上面都不合适的' },
]

const MAX_LEN = 500

Page({
  data: {
    loading: false,
    grayOff: false,
    needLogin: false,
    kinds: KINDS,
    kind: 'suggestion',
    kindLabel: '建议',
    kindDesc: '功能、体验上的改进想法',
    content: '',
    contact: '',
    countText: '0 / 500',
    // 历史提交列表
    mine: [],
    mineLoaded: false,
  },

  onShow: function () {
    const page = this
    page.setData({ loading: true })
    flags
      .ensure()
      .then(function () {
        if (!flags.on('user_feedback')) {
          page.setData({ grayOff: true, loading: false })
          return null
        }
        return api.getSession().then(function (session) {
          if (!session) {
            page.setData({ needLogin: true, loading: false })
            return null
          }
          page.setData({ needLogin: false })
          return page.loadMine()
        })
      })
      .catch(function (error) {
        page.setData({ loading: false })
        guard.toastError(error)
      })
  },

  // 拉我提交过的反馈，展示客服的处理结果
  loadMine: function () {
    const page = this
    return api
      .listMyFeedbacks(20)
      .then(function (rows) {
        const list = (rows || []).map(function (row) {
          let kindText = '其他'
          let statusText = '待处理'
          let statusClass = 'status-pending'
          if (row.kind === 'suggestion') kindText = '建议'
          else if (row.kind === 'complaint') kindText = '投诉'
          else if (row.kind === 'bug') kindText = '故障'
          if (row.status === 'resolved') {
            statusText = '已受理'
            statusClass = 'status-approved'
          } else if (row.status === 'rejected') {
            statusText = '已驳回'
            statusClass = 'status-rejected'
          }
          return {
            id: row.id,
            kindText: kindText,
            statusText: statusText,
            statusClass: statusClass,
            content: row.content,
            note: row.admin_note || '',
            timeText: api.formatTime(row.created_at),
            // 会话摘要：受理之后可以和客服来回沟通，这里给出入口与未读
            replyCount: Number(row.reply_count) || 0,
            unreadCount: Number(row.unread_count) || 0,
            lastPreview: row.last_preview || '',
            lastRoleText: row.last_role === 'admin' ? '客服' : '我',
            lastTimeText: row.last_reply_at ? api.formatTime(row.last_reply_at) : '',
          }
        })
        page.setData({ mine: list, mineLoaded: true, loading: false })
        return null
      })
      .catch(function () {
        // 历史列表拉不到不影响提交，静默降级
        page.setData({ mine: [], mineLoaded: true, loading: false })
        return null
      })
  },

  pickKind: function (event) {
    const key = event.currentTarget.dataset.key
    let label = '建议'
    let desc = ''
    for (let i = 0; i < KINDS.length; i += 1) {
      if (KINDS[i].key === key) {
        label = KINDS[i].label
        desc = KINDS[i].desc
      }
    }
    this.setData({ kind: key, kindLabel: label, kindDesc: desc })
  },

  onContentInput: function (event) {
    const value = event.detail.value || ''
    this.setData({
      content: value,
      countText: value.length + ' / ' + MAX_LEN,
    })
  },

  onContactInput: function (event) {
    this.setData({ contact: event.detail.value || '' })
  },

  submit: function () {
    const page = this
    const content = (page.data.content || '').trim()
    if (!content) {
      ui.toast({ title: '请先写点内容', icon: 'none' })
      return
    }
    if (content.length > MAX_LEN) {
      ui.toast({ title: '内容最多 ' + MAX_LEN + ' 字', icon: 'none' })
      return
    }
    // 之前这里写的是 ui.showLoading(...)，而 utils/ui.js 导出的名字是 loading，
    // 取到 undefined 后一调用就抛异常，整个提交函数当场中断 —— 表现就是「按钮点了没反应」。
    ui.loading({ title: '提交中', mask: true })
    api
      .submitUserFeedback(page.data.kind, content, (page.data.contact || '').trim())
      .then(function () {
        ui.hideLoading()
        ui.toast({ title: '已提交，客服会尽快处理', icon: 'none', duration: 2200 })
        page.setData({ content: '', contact: '', countText: '0 / ' + MAX_LEN })
        // 提交完立刻把新记录刷进历史列表
        return page.loadMine()
      })
      .catch(function (error) {
        ui.hideLoading()
        guard.toastError(error)
      })
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },

  // 进工单会话：客服受理后，这里可以继续追问、看客服的答复
  openThread: function (event) {
    const id = Number(event.currentTarget.dataset.id)
    if (!id) return
    wx.navigateTo({ url: '/pages/feedback/thread?id=' + id })
  },
})
