const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const flags = require('../../utils/flags')

// 星级文案
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
    hasScore: false,
    scoreText: '—',
    scoreLevel: '',
    runnerCount: 0,
    receivedCount: 0,
    goodCount: 0,
    goodRate: 0,
    doneCount: 0,
    boostOn: false,
    boostText: '',
    // 双轨信誉分：接单分和发布分各自累计，不能混在一个平均分里
    ownerCount: 0,
    ownerScoreText: '—',
    strikeCount: 0,
    reviews: [],
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
        if (!flags.on('credit_score')) {
          page.setData({ grayOff: true, loading: false })
          return null
        }
        return api.getSession().then(function (session) {
          if (!session) {
            page.setData({ needLogin: true, loading: false })
            return null
          }
          return Promise.all([
            api.myCreditSummary().catch(function () {
              return null
            }),
            api.listMyReceivedReviews(20).catch(function () {
              return []
            }),
          ]).then(function (result) {
            page.apply(result[0] || {}, result[1] || [])
            return null
          })
        })
      })
      .catch(function (error) {
        page.setData({ loading: false })
        guard.toastError(error)
      })
  },

  apply: function (summary, rows) {
    const page = this
    const count = Number(summary.runner_count) || 0
    const score = Number(summary.runner_score) || 0
    const received = Number(summary.received_count) || 0
    const good = Number(summary.good_count) || 0

    let scoreText = '—'
    let scoreLevel = ''
    if (count > 0) {
      scoreText = score.toFixed(1)
      if (score >= 4.5) scoreLevel = '信誉优秀'
      else if (score >= 4) scoreLevel = '信誉良好'
      else if (score >= 3) scoreLevel = '信誉一般'
      else scoreLevel = '需要改进'
    }

    let ownerCount = 0
    let ownerScore = 0
    if (summary) {
      ownerCount = Number(summary.owner_count) || 0
      ownerScore = Number(summary.owner_score) || 0
    }
    const boostUntil = summary.boost_until ? new Date(summary.boost_until).getTime() : 0
    const boostOn = boostUntil > Date.now()

    page.setData({
      loading: false,
      needLogin: false,
      grayOff: false,
      hasScore: count > 0,
      scoreText: scoreText,
      scoreLevel: scoreLevel,
      runnerCount: count,
      receivedCount: received,
      goodCount: good,
      goodRate: received > 0 ? Math.round((good / received) * 100) : 0,
      doneCount: Number(summary.done_count) || 0,
      boostOn: boostOn,
      ownerCount: ownerCount,
      ownerScoreText: ownerCount > 0 ? ownerScore.toFixed(1) : '—',
      strikeCount: Number(summary.credit_strikes) || 0,
      reviews: (rows || []).map(function (row) {
        return {
          id: row.id,
          orderId: row.order_id,
          orderTitle: row.order_title || '任务',
          fromName: row.from_name || (row.from_role === 'owner' ? '发布方' : '接单员'),
          fromRoleText: row.from_role === 'owner' ? '发布方评价' : '接单员评价',
          score: Number(row.score) || 0,
          scoreText: SCORE_TEXT[Number(row.score)] || '',
          comment: row.comment || '',
          timeText: api.formatTime(row.created_at),
        }
      }),
    })
  },

  goReviews: function () {
    wx.navigateTo({ url: '/pages/mine/reviews' })
  },

  goOrder: function (event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/order/detail?id=' + id })
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },
})
