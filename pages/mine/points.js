const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const flags = require('../../utils/flags')

const PAGE_SIZE = 20

// kind → 中文说明。后端写流水时用的 kind 有限，未知的按原样展示，不下掉。
const KIND_TEXT = {
  order_reward: '订单完成',
  order_publish: '发布订单',
  review: '评价奖励',
  signin: '签到',
  admin_adjust: '管理员调整',
  exchange: '积分兑换',
  system: '系统',
}

Page({
  data: {
    loading: true,
    needLogin: false,
    points: 0,
    nickname: '同学',
    rules: [],
    records: [],
    // 流水走灰度：point_records 关掉时只显示规则，不显示明细
    recordsOn: false,
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
    if (this.data.recordsOn && this.data.hasMore && !this.data.loadingMore) {
      this.loadMore()
    }
  },

  load: function () {
    const page = this
    page.setData({ loading: true })
    return flags
      .ensure()
      .then(function () {
        return api.getSession()
      })
      .then(function (session) {
        if (!session) {
          page.setData({ needLogin: true, loading: false })
          return null
        }
        return api.getProfile().then(function (profile) {
          const points = (profile && profile.points) || 0
          page.setData({
            needLogin: false,
            points: points,
            nickname: (profile && profile.nickname) || '同学',
            rules: [
              '完成任务后发放，具体发放时机在运营后台配置',
              '违规行为被核实后可能扣减',
              '积分不可提现，仅用于平台内权益兑换',
            ],
          })
          // 灰度未开就不拉流水，列表保持空
          if (!flags.on('point_records')) {
            page.setData({ recordsOn: false, records: [], hasMore: false, loading: false })
            return null
          }
          return page.fetchRecords(0).then(function (rows) {
            page.setData({
              recordsOn: true,
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
    return api.listMyPointRecords(PAGE_SIZE, offset).then(function (rows) {
      return (rows || []).map(function (row) {
        const delta = Number(row.delta) || 0
        return {
          id: row.id,
          // 正数显示 +N，负数直接显示，和钱包流水口径一致
          deltaText: delta > 0 ? '+' + delta : String(delta),
          balanceText: String(Number(row.balance) || 0),
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

  goOrders: function () {
    ui.setStorage('orderFilterStatus', 'done')
    wx.switchTab({ url: '/pages/orders/list' })
  },

  goMall: function () {
    wx.navigateTo({ url: '/pages/mine/mall' })
  },
})
