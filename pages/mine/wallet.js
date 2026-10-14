const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')

const PAGE_SIZE = 20

// kind → 中文说明
const KIND_TEXT = {
  order_reward: '订单赏金',
  withdraw: '提现',
  refund: '退款',
  admin_adjust: '管理员调整',
  system: '系统',
}

Page({
  data: {
    loading: true,
    needLogin: false,
    balance: '0.00',
    nickname: '同学',
    notes: [],
    records: [],
    hasMore: false,
    loadingMore: false,
  },

  onShow: function () {
    this.load()
  },

  onPullDownRefresh: function () {
    const page = this
    page.load().then(function () {
      wx.stopPullDownRefresh()
    })
  },

  onReachBottom: function () {
    if (this.data.hasMore && !this.data.loadingMore) {
      this.loadMore()
    }
  },

  load: function () {
    const page = this
    page.setData({ loading: true })
    return api
      .getSession()
      .then(function (session) {
        if (!session) {
          page.setData({ needLogin: true, loading: false })
          return null
        }
        return api.getProfile().then(function (profile) {
          page.setData({
            needLogin: false,
            balance: Number((profile && profile.balance) || 0).toFixed(2),
            nickname: (profile && profile.nickname) || '同学',
            notes: [
              '钱包余额用于平台内的赏金结算',
              '接单员标记送达后，需要发布方确认，赏金才会计入余额',
              '发布方超 48 小时未确认，可在订单详情申请管理员核查',
              '本版本未接微信支付，提现功能暂不可用',
            ],
          })
          return page.fetchRecords(0).then(function (rows) {
            page.setData({
              records: rows,
              hasMore: rows.length >= PAGE_SIZE,
              loading: false,
            })
            return null
          })
        })
      })
      .catch(function (error) {
        page.setData({ loading: false })
        guard.toastError(error)
      })
  },

  loadMore: function () {
    const page = this
    page.setData({ loadingMore: true })
    return page
      .fetchRecords(page.data.records.length)
      .then(function (rows) {
        page.setData({
          records: page.data.records.concat(rows),
          hasMore: rows.length >= PAGE_SIZE,
          loadingMore: false,
        })
        return null
      })
      .catch(function (error) {
        page.setData({ loadingMore: false })
        guard.toastError(error)
      })
  },

  fetchRecords: function (offset) {
    return api.listMyWalletRecords(PAGE_SIZE, offset).then(function (rows) {
      return (rows || []).map(function (row) {
        const delta = Number(row.delta) || 0
        return {
          id: row.id,
          deltaText: (delta > 0 ? '+' : '') + delta.toFixed(2),
          balanceText: Number(row.balance || 0).toFixed(2),
          kindText: KIND_TEXT[row.kind] || row.kind || '系统',
          remark: row.remark || '',
          timeText: api.formatTime(row.created_at),
          positive: delta > 0,
        }
      })
    })
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },

  goAccepted: function () {
    ui.setStorage('orderListMode', 'accept')
    wx.switchTab({ url: '/pages/orders/list' })
  },

  comingSoon: function () {
    ui.toast({ title: '提现需要开通微信支付商户号后才能使用', icon: 'none' })
  },
})
