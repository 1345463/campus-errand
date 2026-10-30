const ui = require('../../utils/ui')
const api = require('../../utils/api')

// 状态筛选。伪状态由服务端翻译（unpaid / refund / doing / closed），
// 前端只传 key，避免两边各写一套判断逻辑。
const TABS = [
  { key: '', label: '全部' },
  { key: 'doing', label: '进行中' },
  { key: 'refund', label: '退款相关' },
  { key: 'unpaid', label: '未付款' },
  { key: 'closed', label: '已结束' },
]

// 枚举回显一律兜中文：取不到就显示「其他」，绝不把英文原样丢给用户
const STATUS_TEXT = {
  pending: '待接单',
  accepted: '进行中',
  waiting_confirm: '待确认',
  cancel_requested: '等接单员同意',
  canceling: '退款中',
  canceled: '已取消',
  done: '已完成',
}

const PAY_TEXT = {
  unpaid: '未付款',
  paid: '已付款',
  refunding: '退款中',
  refunded: '已退款',
}

// 这些状态才允许「强制取消」。canceling 只能重试退款，canceled/done 没有可做的。
const CAN_CANCEL = ['pending', 'accepted', 'cancel_requested', 'waiting_confirm']

Page({
  data: {
    tabs: TABS,
    tab: '',
    keyword: '',
    list: [],
    loading: false,
    needLogin: false,
    denied: false,
    errorText: '',
    actingId: 0,
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
          page.setData({ needLogin: true, list: [], loading: false })
          return
        }
        return api.getProfile().then(function (profile) {
          if (!profile || !profile.is_admin) {
            page.setData({ denied: true, list: [], loading: false })
            return
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
    page.setData({ loading: true, errorText: '' })
    return api
      .adminListOrders(page.data.keyword, page.data.tab, 30)
      .then(function (rows) {
        const list = (rows || []).map(function (item) {
          const status = String(item.order_status || '')
          const payStatus = String(item.pay_status || 'unpaid')
          const reward = Number(item.reward || 0)
          const discount = Number(item.discount_amount || 0)
          const paidAmount = Math.round((reward - discount) * 100) / 100
          return {
            id: item.order_id,
            title: item.title || '未命名任务',
            status: status,
            statusText: STATUS_TEXT[status] || '其他',
            payStatus: payStatus,
            payText: PAY_TEXT[payStatus] || '其他',
            payChannel: item.pay_channel === 'balance' ? '余额' : '微信',
            reward: reward.toFixed(2),
            paidAmount: paidAmount.toFixed(2),
            refundAmount: Number(item.refund_amount || 0).toFixed(2),
            ownerName: item.owner_name || '未填写',
            runnerName: item.runner_name || '',
            createdText: api.formatTime(item.created_at),
            paidText: item.paid_at ? api.formatTime(item.paid_at) : '',
            refundNo: item.refund_no || '',
            refundError: item.refund_error || '',
            cancelReason: item.cancel_reason || '',
            canCancel: CAN_CANCEL.indexOf(status) >= 0,
            isRefunding: status === 'canceling',
            isRefunded: payStatus === 'refunded',
          }
        })
        page.setData({ list: list, loading: false })
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ loading: false, list: [], errorText: message })
        if (typeof console !== 'undefined' && console.error) console.error('[admin/orders]', message, error)
      })
  },

  onKeywordInput: function (event) {
    this.setData({ keyword: event.detail.value })
  },

  doSearch: function () {
    this.load()
  },

  clearSearch: function () {
    this.setData({ keyword: '' })
    this.load()
  },

  onTab: function (event) {
    const key = String(event.currentTarget.dataset.key || '')
    if (key === this.data.tab) return
    this.setData({ tab: key })
    this.load()
  },

  // 强制取消：钱的事必须先讲清楚退多少、退到哪
  forceCancel: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id)
    const item = page.findItem(id)
    if (!item) return
    if (page.data.actingId) return

    const isWaiting = item.status === 'waiting_confirm'
    const content =
      (item.payStatus === 'unpaid'
        ? '这笔订单还没付款，取消后不可恢复。'
        : item.payChannel === '余额'
          ? '将把 ¥' + item.paidAmount + ' 退回发布方钱包余额（立刻到账）。'
          : '将原路退回 ¥' + item.paidAmount + ' 到微信，1~3 个工作日到账。') +
      (isWaiting ? '接单员已经标记送达，取消后他不会拿到赏金，请确认已和双方沟通。' : '')

    ui.confirm({
      title: '强制取消订单 #' + id,
      content: content,
      confirmText: '确认取消',
      cancelText: '再想想',
    }).then(function (go) {
      if (!go) return null
      page.doCancel(id)
    })
  },

  doCancel: function (id) {
    const page = this
    page.setData({ actingId: id })
    ui.loading({ title: '处理中', mask: true })
    api
      .adminCancelOrder(id, '管理员取消')
      .then(function (res) {
        ui.hideLoading()
        page.setData({ actingId: 0 })
        ui.toast({ title: (res && res.message) || '已取消', icon: 'success' })
        return page.load()
      })
      .catch(function (error) {
        ui.hideLoading()
        page.setData({ actingId: 0 })
        ui.toast({ title: api.getErrorMessage(error), icon: 'none' })
        // 失败也要刷新：库里可能已经进退款态，只是微信那一步没成功
        return page.load()
      })
  },

  // 退款中：让云函数去查微信，SUCCESS 就把订单落成 canceled
  refreshRefund: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id)
    if (page.data.actingId) return
    page.setData({ actingId: id })
    ui.loading({ title: '查询中', mask: true })
    api
      .adminRetryRefund(id)
      .then(function (res) {
        ui.hideLoading()
        page.setData({ actingId: 0 })
        const msg = (res && res.message) || (res && res.ok ? '已查询' : '查询失败')
        ui.toast({ title: msg, icon: res && res.ok === false ? 'none' : 'success' })
        return page.load()
      })
      .catch(function (error) {
        ui.hideLoading()
        page.setData({ actingId: 0 })
        ui.toast({ title: api.getErrorMessage(error), icon: 'none' })
      })
  },

  findItem: function (id) {
    const list = this.data.list || []
    for (let i = 0; i < list.length; i++) {
      if (Number(list[i].id) === Number(id)) return list[i]
    }
    return null
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },
})
