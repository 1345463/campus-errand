const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const flags = require('../../utils/flags')

const SCORE_TEXT = {
  5: '非常满意',
  4: '比较满意',
  3: '一般',
  2: '不太满意',
  1: '很不满意',
}

Page({
  data: {
    loading: true,
    grayOff: false,
    needLogin: false,
    tab: 'todo',
    todo: [],
    received: [],
    todoLoaded: false,
    receivedLoaded: false,
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

  load: function () {
    const page = this
    page.setData({ loading: true })
    return flags
      .ensure()
      .then(function () {
        if (!flags.on('my_reviews')) {
          page.setData({ grayOff: true, loading: false })
          return null
        }
        return api.getSession().then(function (session) {
          if (!session) {
            page.setData({ needLogin: true, loading: false })
            return null
          }
          return Promise.all([
            api.listMyReviewTodo(20).catch(function () {
              return []
            }),
            api.listMyReceivedReviews(20).catch(function () {
              return []
            }),
          ]).then(function (result) {
            page.setData({
              loading: false,
              needLogin: false,
              grayOff: false,
              todoLoaded: true,
              receivedLoaded: true,
              todo: (result[0] || []).map(function (row) {
                return {
                  orderId: row.order_id,
                  title: row.title || '任务',
                  reward: Number(row.reward) || 0,
                  peerName: row.peer_name || (row.as_role === 'owner' ? '接单员' : '发布方'),
                  peerLabel: row.as_role === 'owner' ? '评价接单员' : '评价发布方',
                  timeText: api.formatTime(row.finished_at),
                }
              }),
              received: (result[1] || []).map(function (row) {
                return {
                  id: row.id,
                  orderId: row.order_id,
                  orderTitle: row.order_title || '任务',
                  fromName: row.from_name || (row.from_role === 'owner' ? '发布方' : '接单员'),
                  score: Number(row.score) || 0,
                  scoreText: SCORE_TEXT[Number(row.score)] || '',
                  comment: row.comment || '',
                  timeText: api.formatTime(row.created_at),
                }
              }),
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

  switchTab: function (event) {
    const tab = event.currentTarget.dataset.tab
    if (!tab || tab === this.data.tab) return
    this.setData({ tab: tab })
  },

  goReview: function (event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/order/review?id=' + id })
  },

  goOrder: function (event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/order/detail?id=' + id })
  },

  goCredit: function () {
    wx.navigateTo({ url: '/pages/mine/credit' })
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },
})
