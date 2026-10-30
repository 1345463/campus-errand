const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const services = require('../../utils/services')
const flags = require('../../utils/flags')

// 所有关键操作都不依赖 wx.showModal：预览容器里它可能缺失或回调不带 confirm 字段
// （点了等于 false，操作被静默吞掉）。改成页面内二次点击，第一次点一定会有可见反馈。
const ARM_TEXT = {
  cancel: '再点一次，确认取消',
  complete: '再点一次，确认已送达',
  confirm: '再点一次，确认完成并支付',
  abandon: '再点一次，确认放弃接单',
  // 这两个不会走到二次确认（都用弹窗），留着是为了别的地方复用时不至于显示默认文案
  request_cancel: '再点一次，提交取消申请',
  respond_cancel: '再点一次，同意取消并退款',
}
const ARM_TIMEOUT = 4000
const SETTLE_WAIT_HOURS = 48

// 举报诉求。最后一项之外的都属于「选了就能提交」，最后一项强制补充 details。
const REPORT_REASONS = [
  '内容涉嫌违规（代考 / 代课 / 刷单等）',
  '实际任务与描述不符',
  '对方要求私下交易或绕过平台',
  '联系方式虚假或联系不上',
  '人身攻击、骚扰或威胁',
  '其他问题（请在下方说明）',
]

function leftText(ms) {
  const total = Math.floor(ms / 60000)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h > 0) return '还需等待约 ' + h + ' 小时 ' + m + ' 分钟才能申请核查'
  return '还需等待约 ' + m + ' 分钟才能申请核查'
}

// 信誉分文案。没被评过分时说「暂无评分」而不是「0 分」——
// 0 分会让人以为评价很差，实际只是还没人评。
function creditText(credit) {
  if (!credit) return ''
  const parts = []
  if (Number(credit.score_count) > 0) {
    parts.push(Number(credit.score).toFixed(1) + ' 分 · ' + credit.score_count + ' 次评分')
  } else {
    parts.push('暂无评分')
  }
  if (Number(credit.review_count) > 0) parts.push(credit.review_count + ' 条评价')
  if (Number(credit.done_count) > 0) parts.push('完成 ' + credit.done_count + ' 单')
  // 被下架过就是有违规记录，对方得知道再决定要不要合作
  if (Number(credit.credit_strikes) > 0) parts.push('违规 ' + credit.credit_strikes + ' 次')
  return parts.join(' · ')
}

// 订单进度时间轴：按顺序列出已经发生的节点，没发生的整条不显示。
// 用时间戳字段判断"是否发生"而不是状态机反推，因为订单可能被取消、被下架，
// 状态机反推在这些分支上容易和实际时间对不上。
//
// 唯一的例外是「确认完成」：cancel_order 与违规下架都会把 finished_at 写成结束时间，
// 光看 finished_at 会让一张被下架的单凭空多出一条「赏金已结算给接单员」。
// 所以这一条必须以 status === 'done' 为准，不能只看时间戳。
function buildTimeline(order, showRunnerName) {
  const steps = [
    { key: 'created', title: '发布任务', at: order.created_at, desc: '任务已发布，等待接单' },
    {
      key: 'accepted',
      title: '有人接单',
      at: order.accepted_at,
      // 真实姓名只给订单参与方看，大厅里路过的用户只能看到「已接单」
      desc:
        showRunnerName && order.runner_name
          ? '接单员：' + order.runner_name
          : '接单员已确认接单',
    },
    { key: 'done', title: '标记送达', at: order.runner_done_at, desc: '接单员提交完成，等待发布方确认' },
  ]
  if (order.status === 'done') {
    steps.push({ key: 'finished', title: '确认完成', at: order.finished_at, desc: '赏金已结算给接单员' })
  }
  const list = []
  for (let i = 0; i < steps.length; i += 1) {
    if (!steps[i].at) continue
    list.push({
      key: steps[i].key,
      title: steps[i].title,
      desc: steps[i].desc,
      timeText: api.formatTime(steps[i].at),
      // 最后一个节点不画连接线
      isLast: false,
    })
  }
  if (order.status === 'canceled') {
    list.push({
      key: 'canceled',
      title: '任务取消',
      desc: order.takedown ? '管理员判定违规，已下架' : '发布方取消了任务',
      timeText: api.formatTime(order.finished_at || order.created_at),
      isLast: false,
    })
  }
  if (list.length) list[list.length - 1].isLast = true
  return list
}

Page({
  data: {
    id: 0,
    order: {},
    images: [],
    // 送达佐证：接单员提交的照片 与 已展示的预览
    deliverPhotos: [],
    deliverPreviews: [],
    uploading: false,
    needLogin: false,
    deliverImageUrls: [],
    isOwner: false,
    isRunner: false,
    canSeeContact: false,
    // 是否已绑定手机号：联系方式要绑定后才展示（R44）
    phoneBound: false,
    expectTimeText: '',
    genderText: '',
    tagsText: '',
    settleRuleText: services.SETTLE_RULE_TEXT,
    settleHint: '',
    hidden: false,
    canFeedback: false,
    feedbackWaitText: '',
    feedbackStatusText: '',
    feedbackOpen: false,
    feedbackText: '',
    feedbackBusy: false,
    canReport: false,
    reportOpen: false,
    reportReasons: REPORT_REASONS,
    reportReason: '',
    reportDetail: '',
    reportBusy: false,
    reportStatusText: '',
    primary: null,
    secondary: null,
    cancelHint: '',
    busy: false,
    armKey: '',
    armLabel: '',
    errorText: '',
    // ---- 进度时间轴（灰度 order_timeline）----
    timelineOn: false,
    timeline: [],
    // 接单员实名是否可见（参与方 / 管理员）
    canSeeRunnerName: false,
    // 对方（接单员）的信誉分文案。空串表示不展示
    peerCreditText: '',
    // ---- 评价与信誉分（灰度 order_review）----
    reviewOn: false,
    canReview: false,
    myScore: 0,
    peerScore: 0,
    peerComment: '',
    reviewBusy: false,
    // ---- 送达佐证照片（灰度 deliver_photo）----
    // 开关关着时不强制拍照，服务端 complete_order 同样按这个开关放宽
    photoOn: false,
  },

  onLoad: function (options) {
    const page = this
    page.setData({ id: Number(options.id) || 0 })
    page._flagsReady = flags.ensure().then(function () {
      page.setData({
        timelineOn: flags.on('order_timeline'),
        reviewOn: flags.on('order_review'),
        photoOn: flags.on('deliver_photo'),
      })
    })
  },

  onShow: function () {
    const page = this
    return Promise.resolve(page._flagsReady)
      .then(function () {
        return page.load()
      })
      .then(function () {
        return page.autoSyncRefund()
      })
  },

  // 退款中（canceling）时自动查一次微信退款结果。
  // 为什么需要：微信退款是「先受理、后回调」，回调一旦丢了，订单就永远停在
  // canceling —— 钱其实早就退了，只是没人把状态落库，用户只能看着「退款中」
  // 干等。这里进页面顺手补一次，失败静默（不能因为兜底反而打扰用户）。
  // 两分钟内只自动查一次：微信查单接口有频率限制，用户来回切页不能一直打。
  autoSyncRefund: function () {
    const page = this
    const order = page.data.order || {}
    const id = Number(page.data.id) || 0
    if (!id || order.status !== 'canceling') return null

    const key = 'refundSyncAt_' + id
    let last = 0
    try {
      last = Number(wx.getStorageSync(key) || 0)
    } catch (e) {
      last = 0
    }
    if (last && Date.now() - last < 2 * 60 * 1000) return null
    try {
      wx.setStorageSync(key, Date.now())
    } catch (e) {
      // 存不进去也照样查，只是下次可能再查一遍
    }

    return api
      .syncRefund(id)
      .then(function (res) {
        if (res && res.wxStatus === 'SUCCESS') return page.load()
        return null
      })
      .catch(function () {
        return null
      })
  },

  onUnload: function () {
    this.clearArm()
  },

  onHide: function () {
    this.clearArm()
  },

  clearArm: function () {
    if (this._armTimer) {
      clearTimeout(this._armTimer)
      this._armTimer = null
    }
    if (this.data.armKey) this.setData({ armKey: '', armLabel: '' })
  },

  load: function () {
    const page = this
    const id = page.data.id
    if (!id) return Promise.resolve()

    // 走服务端 get_order_detail：没接单的人拿到的是脱敏结果（图片 / 联系方式被清空）
    return api.getSession().then(function (session) {
      if (!session) {
        page.setData({ needLogin: true, hidden: false, order: {}, images: [], deliverImageUrls: [],
          primary: { key: 'login', label: '登录后查看或接单' }, secondary: null, cancelHint: '',
          errorText: '', canReport: false })
        return null
      }
      // 身份判定只决定「显示哪些按钮」，它单点失败不该让整页进错误态
      // （R43 之前就是这样：order_relation 返回裸字符串被 SDK 判成错误，红条显示 owner/runner）
      const relationPromise = api.getOrderRelation(id).catch(function (error) {
        console.error('[detail] order_relation failed', api.getErrorMessage(error))
        return 'none'
      })
      // 手机号绑定状态只影响「联系方式」这一块的展示，失败就当未绑定处理
      const phonePromise = api.getMyPhoneState().catch(function () { return { bound: false } })
      return Promise.all([Promise.resolve(session), api.getOrderDetail(id), api.getProfile().catch(function () { return null }),
      api.isOrderHidden(id), relationPromise, phonePromise])
    }).then(function (result) {
        if (!result) return null
        const session = result[0]
        const order = result[1]
        const profile = result[2]
        page.setData({ needLogin: !session })
        if (!order) {
          // 读不到有两种可能：单子真没了，或者当前账号根本没资格看（未认证接单员）。
          // 对后者给一句明确的话，别让人以为是系统坏了。
          const qualified = !!(profile && (profile.cert_status === 'approved' || profile.role === 'runner'))
          page.setData({
            errorText: qualified
              ? '订单不存在或已被删除'
              : '该任务仅对接单员开放，完成接单员认证后即可查看',
            primary: null,
            secondary: null,
            cancelHint: '',
            order: {}, images: [], canReport: false,
          })
          return null
        }
        const isAdmin = !!(profile && profile.is_admin)
        page.setData({ phoneBound: !!(result[5] && result[5].bound) })

        if (result[3]) {
          page.setData({ hidden: true, order: {}, images: [], primary: null, secondary: null, cancelHint: '', canReport: false })
          return null
        }
        page.setData({ hidden: false })
        return page.loadRelation(id, session, order, isAdmin, result[4])
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ errorText: message })
        guard.toastError(error)
      })
  },

  // 身份始终由服务端判断，避免大整数 ID 在客户端失真。
  loadRelation: function (id, session, order, isAdmin, relation) {
    const page = this
    return Promise.resolve().then(function () {
            const isOwner = relation === 'owner'
            const isRunner = relation === 'runner'
            // 与服务端 get_order_detail 的口径保持一致：本人 / 接单员 / 管理员
            const canSeeContact = isOwner || isRunner || isAdmin
            // 举报对所有登录用户开放：在大厅看到可疑任务也可以报，不必等接单。
            // 服务端 report_order 会按身份记录 owner / runner / viewer 供管理员判断。
            const canReport = !!session

            let primary = session ? null : { key: 'login', label: '登录后接单' }
            // 次要操作只有一个场景：接单员收到取消申请，可以「拒绝」
            let secondary = null
            // 底部说明：退款相关的话必须写清楚金额与到账时间，
            // 不然用户点完以为钱立刻回来，结果三天没到就来找客服
            let cancelHint = ''
            const payAmount = (Number(order.reward || 0) - Number(order.discount_amount || 0)).toFixed(2)
            if (session) {
              if (order.status === 'pending') {
                if (isOwner) {
                  primary = {
                    key: 'cancel',
                    label:
                      order.pay_status === 'paid'
                        ? order.pay_channel === 'balance'
                          ? '取消，退回余额 ¥' + payAmount
                          : '取消并退款 ¥' + payAmount
                        : '取消任务',
                  }
                } else {
                  primary = { key: 'accept', label: '接单赚 ¥' + order.reward }
                }
              } else if (order.status === 'accepted') {
                if (isRunner) {
                  primary = { key: 'complete', label: '我已送达，提交完成' }
                } else if (isOwner) {
                  // 已接单不能单方面取消：接单员可能已经在路上
                  primary = { key: 'request_cancel', label: '申请取消' }
                }
              } else if (order.status === 'cancel_requested') {
                if (isRunner) {
                  primary = { key: 'respond_cancel', label: '同意取消并退款' }
                  secondary = { key: 'reject_cancel', label: '拒绝，继续完成' }
                }
              } else if (order.status === 'waiting_confirm' && isOwner) {
                primary = { key: 'confirm', label: '确认完成并支付 ¥' + order.reward }
              } else if (order.status === 'canceling') {
                // 钱在微信那边，改不了也拦不住，但允许主动查一次进度：
                // 回调可能丢，用户不该只能干等（自动补查在 autoSyncRefund）
                primary = { key: 'sync_refund', label: '刷新退款进度' }
              }

              if (order.status === 'pending' && isOwner) {
                if (order.pay_status !== 'paid') {
                  cancelHint = '还没付款，任务不会出现在大厅；可在「我发布的」里继续支付'
                } else if (order.pay_channel === 'balance') {
                  // 余额支付的退款是同库内两条 UPDATE，没有微信那一趟，秒到
                  cancelHint = '取消后 ¥' + payAmount + ' 立刻退回钱包余额'
                } else {
                  cancelHint = '取消后全额退回 ¥' + payAmount + '，1~3 个工作日到账'
                }
              } else if (order.status === 'accepted' && isOwner) {
                cancelHint = order.pay_channel === 'balance'
                  ? '已接单，取消需接单员同意；他同意后 ¥' + payAmount + ' 立刻退回余额'
                  : '已接单，取消需接单员同意；他同意后全额退回 ¥' + payAmount
              } else if (order.status === 'cancel_requested') {
                cancelHint = isRunner
                  ? '发布方申请取消，同意后全额退款给他，本单结束'
                  : '已提交取消申请，等接单员回应'
              } else if (order.status === 'canceling') {
                cancelHint = order.refund_error
                  ? '退款异常：' + order.refund_error + '。请联系客服处理'
                  : '退款处理中，1~3 个工作日到账；到账后本单自动结束'
              }
            }

            // 结算相关提示：谁在等谁、能不能申请核查
            let settleHint = ''
            let canFeedback = false
            let feedbackWaitText = ''

            if (order.status === 'accepted') {
              settleHint = '送达后点下方按钮，由发布方确认后赏金到账'
            } else if (order.status === 'waiting_confirm') {
              if (isRunner) {
                settleHint = '已提交完成，等待发布方确认后赏金到账'
                const doneAt = order.runner_done_at ? new Date(order.runner_done_at).getTime() : 0
                if (doneAt) {
                  const left = doneAt + SETTLE_WAIT_HOURS * 3600 * 1000 - Date.now()
                  if (left > 0) {
                    canFeedback = false
                    feedbackWaitText = leftText(left)
                  } else {
                    canFeedback = true
                  }
                }
              } else if (isOwner) {
                settleHint = '接单员已标记送达，确认无误后赏金将打给接单员'
              }
            } else if (order.status === 'done') {
              settleHint = '已完成，赏金已结算给接单员'
            }

            let feedbackStatusText = ''
            const feedbackStatus = order.feedback_status || 'none'
            if (feedbackStatus === 'pending') feedbackStatusText = '已提交核查，等待管理员处理'
            else if (feedbackStatus === 'resolved') feedbackStatusText = '管理员已判定通过，赏金已结算'
            else if (feedbackStatus === 'rejected')
              feedbackStatusText = '管理员核查未通过：' + (order.admin_note || '未提供原因')

            page.setData({
              order: Object.assign({}, order, {
                serviceName: order.service_name,
                statusText: services.STATUS_TEXT[order.status] || order.status,
                createdText: api.formatTime(order.created_at),
              }),
              isOwner: isOwner,
              isRunner: isRunner,
              isAdmin: isAdmin,
              canSeeContact: canSeeContact,
              canAbandon: isRunner && order.status === 'accepted',
              peerCreditText: '',
              canReview: false,
              expectTimeText: order.expect_time || '越快越好',
              genderText: order.gender_limit && order.gender_limit !== '不限' ? order.gender_limit : '',
              tagsText: (order.tags || []).join('、'),
              acceptedText: api.formatTime(order.accepted_at),
              doneText: api.formatTime(order.runner_done_at),
              settleHint: settleHint,
              canFeedback: canFeedback,
              feedbackWaitText: feedbackWaitText,
              feedbackStatusText: feedbackStatusText,
              primary: primary,
              secondary: secondary,
              cancelHint: cancelHint,
              errorText: '',
              canReport: canReport,
              // 接单员真实姓名只对「这单的参与方 + 管理员」展示。
              // 大厅里其他用户能看到进度，但不该看到别人的实名。
              canSeeRunnerName: isOwner || isRunner || isAdmin,
              // 时间轴直接按已有时间戳拼，没发生的节点不会出现
              timeline: page.data.timelineOn
                ? buildTimeline(order, isOwner || isRunner || isAdmin)
                : [],
            })

            const tail = function () {
              return page.loadReport(id, canReport)
            }

            // 接单员信誉分：下单人要能看到接单员的信誉，才敢把单交给他。
            // 只对参与方和管理员拉（服务端也会再拦一次），失败静默降级不显示。
            const tailCredit = function () {
              if (!order.runner_id) return Promise.resolve()
              if (!(isOwner || isRunner || isAdmin)) return Promise.resolve()
              return api
                .orderPeerCredit(id)
                .then(function (credit) {
                  page.setData({ peerCreditText: creditText(credit) })
                  return null
                })
                .catch(function () {
                  return null
                })
            }

            // 评价态：只有灰度开了、订单已完成、且我是参与方时才拉。
            // 拉失败不影响页面其它部分，静默降级成不可评价。
            const tailReview = function () {
              if (!page.data.reviewOn || order.status !== 'done') return Promise.resolve()
              return api
                .myOrderReviewState(id)
                .then(function (state) {
                  page.setData({
                    canReview: !!(state && state.can_review),
                    myScore: (state && state.my_score) || 0,
                    peerScore: (state && state.peer_score) || 0,
                    peerComment: (state && state.peer_comment) || '',
                  })
                  return null
                })
                .catch(function () {
                  return null
                })
            }

            // 送达佐证照片：接单员提交完成时会带 1-3 张，
            // 发布方确认收货前靠它核对，所以和任务图片分开一块展示。
            // 这些图是接单员传的，发布方不是上传者，必须带订单号走 get_order_asset，
            // 否则 get_media_asset 会因为"不是本人提交的"一张都读不出来。
            const loadDeliver = function () {
              if (!order.deliver_images || !order.deliver_images.length) {
                page.setData({ deliverImageUrls: [] })
                return Promise.resolve(null)
              }
              return api
                .getOrderImageUrls(order.deliver_images, id)
                .then(function (rows) {
                  page.setData({
                    deliverImageUrls: (rows || [])
                      .filter(function (row) {
                        return row && row.url
                      })
                      .map(function (row) {
                        return row.url
                      }),
                  })
                  return null
                })
                .catch(function () {
                  page.setData({ deliverImageUrls: [] })
                  return null
                })
            }

            const loadImages = function () {
              if (!order.images || !order.images.length) {
                page.setData({ images: [] })
                return Promise.resolve()
              }
              return api.getOrderImageUrls(order.images, id).then(function (rows) {
                const ok = (rows || []).filter(function (row) { return row && row.url })
                page.setData({ images: ok.map(function (row) { return row.url }) })
                if (!ok.length) page.setData({ errorText: '图片加载失败，请稍后重试' })
              }).catch(function () { page.setData({ images: [], errorText: '图片加载失败，请稍后重试' }) })
            }
            return Promise.all([loadImages(), loadDeliver(), tail(), tailCredit(), tailReview()])
          })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ errorText: message })
        guard.toastError(error)
      })
  },

  goOrders: function () {
    wx.switchTab({ url: '/pages/orders/list' })
  },

  goReview: function () {
    const page = this
    if (page.data.reviewBusy) return
    page.setData({ reviewBusy: true })
    wx.navigateTo({
      url: '/pages/order/review?id=' + page.data.id,
      complete: function () {
        page.setData({ reviewBusy: false })
      },
    })
  },

  // 预览图片。任务图和送达佐证是两组图，必须按 data-group 取对应的那一组 urls，
  // 否则点了佐证图却把任务图塞进 urls，预览要么打不开要么串到别张去。
  previewImage: function (event) {
    const dataset = event.currentTarget.dataset || {}
    const current = dataset.src
    const group = dataset.group === 'deliver' ? 'deliverImageUrls' : 'images'
    // data URL 不能交给 previewImage（只认 http(s) 和本地文件路径），此时图片已内联展示
    if (/^data:/i.test(current || '')) {
      ui.toast({ title: '图片已展示，长按可保存', icon: 'none' })
      return
    }
    const urls = (this.data[group] || []).filter(function (url) {
      return !/^data:/i.test(url || '')
    })
    if (!urls.length) {
      ui.toast({ title: '图片还在加载，稍等一下再试', icon: 'none' })
      return
    }
    wx.previewImage({
      current: current,
      urls: urls,
    })
  },

  onPrimary: function () {
    const page = this
    const action = page.data.primary
    if (!action) return
    if (page.data.busy || page.data.uploading) {
      ui.toast({ title: '正在处理，请稍候', icon: 'none' })
      return
    }

    if (action.key === 'login') {
      require('../../utils/login-return').goLogin()
      return
    }

    if (action.key === 'accept') {
      page.doAccept()
      return
    }

    // 送达必须先带佐证照片：先选图，选完再走原来的二次确认。
    // 直接弹确认会让接单员以为「点一下就完事了」，结果被服务端挡回来。
    if (action.key === 'complete') {
      page.doComplete()
      return
    }

    // 查退款进度是只读操作，不需要二次确认，点一下就查
    if (action.key === 'sync_refund') {
      page.runRpc('sync_refund')
      return
    }

    // 取消 / 退款类全部走弹窗：金额、到账时间必须在动手前讲明白。
    // 不用 armOrRun 的二次点按，是因为「再点一次」写不清退多少钱。
    if (action.key === 'cancel') {
      page.doCancel()
      return
    }
    if (action.key === 'request_cancel') {
      page.doRequestCancel()
      return
    }
    if (action.key === 'respond_cancel') {
      page.doRespondCancel(true)
      return
    }

    page.armOrRun(action.key, undefined)
  },

  onSecondary: function () {
    const action = this.data.secondary
    if (!action) return
    if (this.data.busy) {
      ui.toast({ title: '正在处理，请稍候', icon: 'none' })
      return
    }
    if (action.key === 'reject_cancel') this.doRespondCancel(false)
  },

  /** 取消订单：待接单且已付款 → 直接全额退款；未付款 → 纯取消 */
  doCancel: function () {
    const page = this
    const order = page.data.order || {}
    const paid = order.pay_status === 'paid'
    const amount = (Number(order.reward || 0) - Number(order.discount_amount || 0)).toFixed(2)
    wx.showModal({
      title: paid ? '取消并退款' : '取消任务',
      content: paid
        ? '确认取消这一单？¥' + amount + ' 将全额退回微信，1~3 个工作日到账。'
        : '确认取消这一单？取消后任务会从大厅撤下，需要重新发布。',
      confirmText: paid ? '取消并退款' : '确认取消',
      confirmColor: '#E5484D',
      success: function (res) {
        if (!res.confirm) return
        page.runRpc('cancel')
      },
    })
  },

  /** 已接单：只能申请取消，等接单员同意 */
  doRequestCancel: function () {
    const page = this
    const order = page.data.order || {}
    const amount = (Number(order.reward || 0) - Number(order.discount_amount || 0)).toFixed(2)
    wx.showModal({
      title: '申请取消',
      content: '接单员可能已经在路上，需要他同意才能退款（¥' + amount + ' 全额退回）。',
      editable: true,
      placeholderText: '取消原因（选填，接单员能看到）',
      confirmText: '提交申请',
      success: function (res) {
        if (!res.confirm) return
        page.runRpc('request_cancel', undefined, String(res.content || ''))
      },
    })
  },

  /** 接单员回应取消申请 */
  doRespondCancel: function (agree) {
    const page = this
    const order = page.data.order || {}
    const amount = (Number(order.reward || 0) - Number(order.discount_amount || 0)).toFixed(2)
    wx.showModal({
      title: agree ? '同意取消' : '拒绝取消',
      content: agree
        ? '同意后 ¥' + amount + ' 将全额退回发布方，本单结束。'
        : '拒绝后订单继续，你需要按约完成并送达。',
      confirmText: agree ? '同意并退款' : '拒绝',
      confirmColor: agree ? '#E5484D' : '#2E7CF6',
      success: function (res) {
        if (!res.confirm) return
        page.runRpc(agree ? 'respond_cancel' : 'reject_cancel')
      },
    })
  },

  // 二次确认：第一次点上膛并改按钮文案，ARM_TIMEOUT 内再点一次才真提交。
  // 送达这类不可撤销的操作都要走这里，payload 会原样交给 runRpc。
  armOrRun: function (key, payload, label) {
    const page = this
    if (page.data.armKey !== key) {
      page.clearArm()
      page.setData({
        armKey: key,
        armLabel: label || ARM_TEXT[key] || '再点一次确认',
        errorText: '',
      })
      if (key === 'complete') return Promise.resolve(null)
      page._armTimer = setTimeout(function () {
        page._armTimer = null
        if (page.data.armKey === key) page.setData({ armKey: '', armLabel: '' })
      }, ARM_TIMEOUT)
      return Promise.resolve(null)
    }
    page.clearArm()
    return page.runRpc(key, payload)
  },

  // 送达佐证：先选图上传，拿到服务端路径后再交给 runRpc。
  // 照片是发布方确认收货的依据，服务端 complete_order 也会校验至少 1 张。
  doComplete: function () {
    const page = this
    // 开关关着时不强制拍照：直接走原来的二次确认，服务端也会同步放宽
    if (!page.data.photoOn) {
      page.armOrRun('complete', [])
      return
    }
    if ((page.data.deliverPhotos || []).length) {
      if (page.data.armKey === 'complete') {
        page.clearArm()
        return page.runRpc('complete', page.data.deliverPhotos)
      }
      return page.armOrRun('complete', page.data.deliverPhotos, '确认用这 ' + page.data.deliverPhotos.length + ' 张照片提交送达')
    }
    return page.chooseDeliverPhotos()
  },

  chooseDeliverPhotos: function () {
    const page = this
    if (page.data.busy || page.data.uploading) return
    if (!ui.available('chooseMedia')) {
      ui.toast({ title: '当前环境不支持拍照，请在微信小程序里使用', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: 3,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: function (res) {
        const files = (res.tempFiles || []).map(function (file) {
          return file.tempFilePath
        })
        if (!files.length) {
          ui.toast({ title: '请先拍照或选择照片', icon: 'none' })
          return
        }
        page.setData({ uploading: true })
        ui.loading({ title: '上传佐证中', mask: true })
        Promise.all(
          files.map(function (tempPath) {
            return api.uploadImage(tempPath, 'deliver').then(function (path) { return { path: path, preview: tempPath } })
          })
        )
          .then(function (paths) {
            ui.hideLoading()
            page.setData({ uploading: false, deliverPhotos: paths.map(function (row) { return row.path }),
              deliverPreviews: paths.map(function (row) { return row.preview }) })
            return page.armOrRun('complete', page.data.deliverPhotos, '确认用这 ' + paths.length + ' 张照片提交送达')
          })
          .catch(function (error) {
            ui.hideLoading()
            page.setData({ uploading: false })
            page.fail(error)
          })
      },
    })
  },

  removeDeliverPhoto: function (event) {
    if (this.data.busy || this.data.uploading) return
    const index = Number(event.currentTarget.dataset.index)
    const photos = this.data.deliverPhotos.slice()
    const previews = this.data.deliverPreviews.slice()
    photos.splice(index, 1)
    previews.splice(index, 1)
    this.clearArm()
    this.setData({ deliverPhotos: photos, deliverPreviews: previews })
  },

  previewDeliverDraft: function (event) {
    wx.previewImage({ current: this.data.deliverPreviews[Number(event.currentTarget.dataset.index)], urls: this.data.deliverPreviews })
  },

  abandon: function () {
    if (this.data.busy || this.data.uploading) return
    return this.armOrRun('abandon')
  },

  doAccept: function () {
    const page = this
    if (page.data.busy) return Promise.resolve()
    page.setData({ busy: true })
    return api
      .getProfile()
      .then(function (profile) {
        if (!profile) throw new Error('请先登录')
        if (!(profile.cert_status === 'approved' || profile.role === 'runner')) {
          page.setData({ busy: false })
          ui.toast({ title: '请先完成接单员认证', icon: 'none' })
          return null
        }
        return guard.requirePhone().then(function (phoneOk) {
          if (!phoneOk) {
            page.setData({ busy: false })
            return null
          }
          return page.runRpc('accept')
        })
      })
      .catch(function (error) {
        page.fail(error)
      })
  },

  goBindPhone: function () {
    wx.navigateTo({
      url: '/pages/mine/bind-phone?from=gate',
      fail: function () {
        wx.switchTab({ url: '/pages/mine/index' })
      },
    })
  },

  // 接单员：满 48 小时未确认时申请管理员核查
  openFeedback: function () {
    this.setData({ feedbackOpen: true, errorText: '' })
  },

  closeFeedback: function () {
    this.setData({ feedbackOpen: false })
  },

  onFeedbackInput: function (event) {
    this.setData({ feedbackText: event.detail.value })
  },

  submitFeedback: function () {
    const page = this
    const text = String(page.data.feedbackText || '').trim()
    if (text.length < 5) {
      ui.toast({ title: '请简单说明情况（至少 5 个字）', icon: 'none' })
      return
    }
    if (page.data.feedbackBusy) return
    page.setData({ feedbackBusy: true })
    api
      .submitSettleFeedback(page.data.id, text)
      .then(function () {
        page.setData({ feedbackBusy: false, feedbackOpen: false, feedbackText: '' })
        ui.toast({ title: '已提交，管理员会尽快核查', icon: 'success' })
        return page.load()
      })
      .catch(function (error) {
        page.setData({ feedbackBusy: false })
        page.fail(error)
      })
  },

  // ---- 举报 ----

  loadReport: function (id, enabled) {
    const page = this
    if (!enabled) {
      page.setData({ reportStatusText: '', reportOpen: false })
      return Promise.resolve()
    }
    return api
      .getMyReport(id)
      .catch(function () {
        return null
      })
      .then(function (row) {
        if (!row) {
          page.setData({ reportStatusText: '' })
          return
        }
        const map = { pending: '举报已提交，等待管理员处理', resolved: '举报已受理，管理员已处理该订单', rejected: '举报已核查，未发现问题' }
        let text = map[row.status] || '举报已提交'
        if (row.status === 'rejected' && row.admin_note) text = text + '：' + row.admin_note
        page.setData({
          reportStatusText: text,
          reportOpen: row.status === 'pending' ? false : page.data.reportOpen,
        })
      })
  },

  openReport: function () {
    this.setData({ reportOpen: true, errorText: '' })
  },

  closeReport: function () {
    this.setData({ reportOpen: false, reportReason: '', reportDetail: '' })
  },

  pickReason: function (event) {
    const value = event.currentTarget.dataset.value
    this.setData({ reportReason: this.data.reportReason === value ? '' : value })
  },

  onReportInput: function (event) {
    this.setData({ reportDetail: event.detail.value })
  },

  submitReport: function () {
    const page = this
    const reason = String(page.data.reportReason || '')
    const detail = String(page.data.reportDetail || '').trim()
    if (!reason) {
      ui.toast({ title: '请先选择举报原因', icon: 'none' })
      return
    }
    if (reason.indexOf('其他问题') >= 0 && detail.length < 5) {
      ui.toast({ title: '请简单说明具体情况（至少 5 个字）', icon: 'none' })
      return
    }
    if (page.data.reportBusy) return
    page.setData({ reportBusy: true })
    api
      .reportOrder(page.data.id, reason, detail)
      .then(function () {
        page.setData({ reportBusy: false, reportOpen: false, reportReason: '', reportDetail: '' })
        ui.toast({ title: '举报已提交，管理员会尽快处理', icon: 'success' })
        return page.load()
      })
      .catch(function (error) {
        page.setData({ reportBusy: false })
        page.fail(error)
      })
  },

  fail: function (error) {
    const message = api.getErrorMessage(error)
    this.setData({ busy: false, errorText: message })
    if (typeof console !== 'undefined' && console.error) console.error('[order/detail]', message, error)
    ui.toast({ title: message, icon: 'none', duration: 2200 })
  },

  // 每种操作成功后的提示语。
  // 取消这一条要看服务端回来的状态：已付款是「退款已发起」，
  // 已接单是「申请已提交」，未付款才是「已取消」—— 三句话含义完全不同。
  resultText: function (kind, res) {
    const r = res || {}
    if (kind === 'accept') return '接单成功'
    if (kind === 'complete') return '已提交，等发布方确认'
    if (kind === 'confirm') return '已确认，赏金已打给接单员'
    if (kind === 'abandon') return '已放弃，任务重新开放'
    if (kind === 'request_cancel') return '已提交取消申请，等接单员回应'
    if (kind === 'respond_cancel') return '已同意，退款处理中'
    if (kind === 'reject_cancel') return '已拒绝，订单继续'
    if (kind === 'sync_refund') {
      if (r.wxStatus === 'SUCCESS') return '退款已完成，订单已结束'
      if (r.wxStatus === 'CLOSED') return '退款已关闭，钱没有出去'
      return '微信还在处理退款，请稍后再看'
    }
    if (r.refunding) return '已发起退款，1~3 个工作日到账'
    if (r.status === 'cancel_requested') return '已提交取消申请，等接单员回应'
    return '已取消'
  },

  runRpc: function (kind, images, reason) {
    const page = this
    const id = page.data.id
    page.setData({ busy: true, errorText: '' })
    const call =
      kind === 'abandon'
        ? api.abandonOrder(id)
        : kind === 'accept'
        ? api.acceptOrder(id)
        : kind === 'complete'
          ? api.completeOrder(id, images)
          : kind === 'confirm'
            ? api.confirmOrderDone(id)
            : kind === 'respond_cancel'
              ? api.respondCancel(id, true)
              : kind === 'reject_cancel'
                ? api.respondCancel(id, false)
                : kind === 'sync_refund'
                  ? api.syncRefund(id)
                  : api.cancelOrder(id, reason)
    return call
      .then(function (res) {
        ui.toast({ title: page.resultText(kind, res), icon: 'success' })
        page.setData({ busy: false, deliverPhotos: [], deliverPreviews: [] })
        return page.load()
      })
      .catch(function (error) {
        if (error && error.needLogin) {
          page.setData({ busy: false, errorText: '请先登录' })
          guard.ensureLogin()
          return
        }
        if (error && error.noEffect) {
          page.setData({ busy: false, errorText: '该任务状态已变更，页面已刷新' })
          ui.toast({ title: '手慢了，该任务状态已变更', icon: 'none' })
          return page.load()
        }
        page.fail(error)
        // 退款发起失败时服务端已经把订单回滚成原状态（paid + pending/accepted），
        // 页面必须跟着刷新，否则按钮还停在「退款中」，用户以为钱在路上了
        if (kind === 'cancel' || kind === 'request_cancel' || kind === 'respond_cancel' || kind === 'reject_cancel') {
          return page.load()
        }
      })
  },
})
