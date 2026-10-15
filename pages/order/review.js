const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const cloudModule = require('../../utils/cloud')

const MAX_COMMENT = 200
// 二次点击确认的自动解除时间，和 orders/list 的 askHide 保持一致
const ARM_TIMEOUT = 4000

// 快捷标签按「我在评价谁」给不同选项：
// 我是发布方(owner) → 评价接单员；我是接单员(runner) → 评价发布方
const TAG_OPTIONS = {
  owner: ['送达准时', '沟通顺畅', '态度友好', '包装完好', '如实描述'],
  runner: ['描述准确', '地址清晰', '确认及时', '沟通顺畅', '态度友好'],
}

const SCORE_WORDS = ['', '很不满意', '不太满意', '一般', '比较满意', '非常满意']

// 取「我在这张单上的评价状态」。
// 服务端函数 my_order_review_state 已经建好，但 utils/api.js 的 module.exports 里
// 目前没有 myOrderReviewState 这一项 —— 这里做一层兜底：
// api 上有就直接用，没有就直接调同名 RPC，页面不至于因为缺一个导出而整个白屏。
// （等 api.js 补上导出后，下面这个分支自然就走不到了）
function fetchReviewState(orderId) {
  if (typeof api.myOrderReviewState === 'function') {
    return api.myOrderReviewState(orderId)
  }
  return cloudModule.cloud.database
    .rpc('my_order_review_state', { p_order_id: orderId })
    .then(function (result) {
      if (result.error) throw new Error(api.getErrorMessage(result.error))
      const rows = Array.isArray(result.data) ? result.data : []
      return rows.length ? rows[0] : null
    })
}

// from_role 是评价者的身份，用它区分「我写的」和「对方写的」，
// 比在客户端比对用户 id 可靠（id 是大整数字符串，前端比较会精度丢失）
function findReview(reviews, relation, mine) {
  const list = reviews.filter(function (item) {
    const isMine = item.from_role === relation
    return mine ? isMine : !isMine
  })
  return list.length ? list[0] : null
}

function buildTags(relation) {
  const labels = TAG_OPTIONS[relation] || []
  return labels.map(function (label) {
    return { label: label, on: false }
  })
}

Page({
  data: {
    orderId: 0,
    starList: [1, 2, 3, 4, 5],
    loading: true,
    needLogin: false,
    denied: false,
    deniedText: '',
    title: '',
    serviceName: '',
    statusText: '',
    createdText: '',
    relation: '',
    otherLabel: '',
    submitted: false,
    score: 0,
    scoreWord: '',
    tagOptions: [],
    comment: '',
    commentLen: 0,
    myScore: 0,
    myTags: [],
    myComment: '',
    peerHas: false,
    peerScore: 0,
    peerComment: '',
    submitArmed: false,
    submitting: false,
    errorText: '',
  },

  onLoad: function (options) {
    const page = this
    const id = Number((options && options.id) || 0)
    if (!id) {
      // 没有单号查不出任何东西，直接给提示，不发一次必然失败的请求
      page.setData({ loading: false, denied: true, deniedText: '订单号不正确，无法评价' })
      return
    }
    page.setData({ orderId: id })
    page.checkAndLoad()
  },

  // 二次确认定时器挂在页面实例上，页面销毁时必须清掉，否则回调会打到已卸载的页面
  onUnload: function () {
    this.clearArmTimer()
  },

  clearArmTimer: function () {
    const page = this
    if (page._armTimer) {
      clearTimeout(page._armTimer)
      page._armTimer = null
    }
  },

  checkAndLoad: function () {
    const page = this
    page.setData({ loading: true, errorText: '', denied: false, deniedText: '' })
    return api
      .getSession()
      .then(function (session) {
        if (!session) {
          page.setData({ loading: false, needLogin: true })
          return null
        }
        page.setData({ needLogin: false })
        return page.checkRelation()
      })
      .catch(function (error) {
        page.setData({ loading: false })
        guard.toastError(error)
      })
  },

  // 参与方判断交给服务端：客户端不比对 owner_id / runner_id
  checkRelation: function () {
    const page = this
    return api.getOrderRelation(page.data.orderId).then(function (relation) {
      if (relation !== 'owner' && relation !== 'runner') {
        page.setData({
          loading: false,
          denied: true,
          deniedText: '订单不存在，或你不是这张订单的发布方 / 接单员',
        })
        return null
      }
      return page.loadOrder(relation)
    })
  },

  // 只有「已完成」的单才开放互评，进行中 / 已取消的单不给入口
  loadOrder: function (relation) {
    const page = this
    return api.getOrder(page.data.orderId).then(function (order) {
      if (!order) {
        page.setData({ loading: false, denied: true, deniedText: '订单不存在，可能已被删除' })
        return null
      }
      if (order.status !== 'done') {
        page.setData({ loading: false, denied: true, deniedText: '订单还没完成，完成后双方才能互评' })
        return null
      }
      page.setData({
        title: order.title || '未命名订单',
        serviceName: order.service_name || '',
        statusText: '已完成',
        createdText: api.formatTime(order.created_at),
        relation: relation,
        // 我是 owner 就评价接单员，我是 runner 就评价发布方
        otherLabel: relation === 'owner' ? '接单员' : '发布方',
        tagOptions: buildTags(relation),
      })
      return page.loadReviews(relation)
    })
  },

  loadReviews: function (relation) {
    const page = this
    return Promise.all([
      fetchReviewState(page.data.orderId),
      api.getOrderReviews(page.data.orderId),
    ])
      .then(function (res) {
        const state = res[0] || null
        const reviews = Array.isArray(res[1]) ? res[1] : []
        const mine = findReview(reviews, relation, true)
        const peer = findReview(reviews, relation, false)
        const canReview = !!(state && state.can_review)
        const submitted = !!mine

        // 已完成 + 是参与方，却既不能评也没评过：属于异常状态，直接挡掉而不是让用户对着空表单
        if (!canReview && !submitted) {
          page.setData({ loading: false, denied: true, deniedText: '这张订单当前不可评价' })
          return null
        }

        page.setData({
          loading: false,
          denied: false,
          submitted: submitted,
          myScore: mine ? Number(mine.score) || 0 : 0,
          myTags: mine && Array.isArray(mine.tags) ? mine.tags : [],
          myComment: (mine && mine.comment) || '',
          peerHas: !!peer,
          peerScore: peer ? Number(peer.score) || 0 : 0,
          peerComment: (peer && peer.comment) || '',
        })
        return null
      })
      .catch(function (error) {
        page.setData({ loading: false })
        guard.toastError(error)
      })
  },

  pickScore: function (event) {
    const page = this
    // 点第 n 颗就是 n 分；再点同一颗不做「取消评分」，避免误触把分清零
    const score = Number(event.currentTarget.dataset.n)
    page.setData({ score: score, scoreWord: SCORE_WORDS[score] || '' })
  },

  toggleTag: function (event) {
    const page = this
    const index = Number(event.currentTarget.dataset.index)
    // 重新造数组：直接改 page.data 里的元素再 setData，元素引用没变，视图不一定刷新
    const next = page.data.tagOptions.map(function (item, i) {
      if (i !== index) return { label: item.label, on: item.on }
      return { label: item.label, on: !item.on }
    })
    page.setData({ tagOptions: next })
  },

  onComment: function (event) {
    const page = this
    // maxlength 已经挡住超长输入，这里再截一次防止不同内核的行为差异
    const value = String(event.detail.value || '').slice(0, MAX_COMMENT)
    page.setData({ comment: value, commentLen: value.length })
  },

  // 提交走页内二次点击确认，不依赖 wx.showModal（预览环境下它不回调）
  askSubmit: function () {
    const page = this
    if (page.data.submitting) return
    if (page.data.submitArmed) {
      page.clearArmTimer()
      page.setData({ submitArmed: false })
      page.doSubmit()
      return
    }
    if (!page.data.score) {
      ui.toast({ title: '请先选择评分', icon: 'none' })
      return
    }
    page.clearArmTimer()
    page.setData({ submitArmed: true })
    page._armTimer = setTimeout(function () {
      page._armTimer = null
      if (page.data.submitArmed) page.setData({ submitArmed: false })
    }, ARM_TIMEOUT)
  },

  cancelSubmit: function () {
    this.clearArmTimer()
    this.setData({ submitArmed: false })
  },

  doSubmit: function () {
    const page = this
    if (page.data.submitting) return
    if (!page.data.score) {
      ui.toast({ title: '请先选择评分', icon: 'none' })
      return
    }
    const tags = page.data.tagOptions
      .filter(function (item) {
        return item.on
      })
      .map(function (item) {
        return item.label
      })
    page.setData({ submitting: true })
    ui.loading({ title: '提交中', mask: true })
    api
      .submitOrderReview(page.data.orderId, page.data.score, tags, String(page.data.comment).trim())
      .then(function () {
        ui.hideLoading()
        page.setData({ submitting: false, submitArmed: false })
        ui.toast({ title: '评价已提交', icon: 'success' })
        // 重新拉一次，切到只读视图，顺带把对方的评价带出来
        return page.loadReviews(page.data.relation)
      })
      .catch(function (error) {
        ui.hideLoading()
        page.setData({ submitting: false, submitArmed: false })
        const message = api.getErrorMessage(error)
        page.setData({ errorText: message })
        guard.toastError(error)
      })
  },

  retry: function () {
    this.checkAndLoad()
  },

  goBack: function () {
    // 直接分享链接进来时页面栈里没有上一页，退回订单列表兜底
    try {
      wx.navigateBack()
    } catch (e) {
      wx.switchTab({ url: '/pages/orders/list' })
    }
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },
})
