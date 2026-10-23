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
    return Promise.resolve(page._flagsReady).then(function () { return page.load() })
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
          primary: { key: 'login', label: '登录后查看或接单' }, errorText: '', canReport: false })
        return null
      }
      return Promise.all([Promise.resolve(session), api.getOrderDetail(id), api.getProfile().catch(function () { return null }),
      api.isOrderHidden(id), api.getOrderRelation(id)])
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
            order: {}, images: [], canReport: false,
          })
          return null
        }
        const isAdmin = !!(profile && profile.is_admin)

        if (result[3]) {
          page.setData({ hidden: true, order: {}, images: [], primary: null, canReport: false })
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
            if (session) {
              if (order.status === 'pending') {
                if (isOwner) {
                  primary = { key: 'cancel', label: '取消任务' }
                } else {
                  primary = { key: 'accept', label: '接单赚 ¥' + order.reward }
                }
              } else if (order.status === 'accepted' && isRunner) {
                primary = { key: 'complete', label: '我已送达，提交完成' }
              } else if (order.status === 'waiting_confirm' && isOwner) {
                primary = { key: 'confirm', label: '确认完成并支付 ¥' + order.reward }
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

    page.armOrRun(action.key, undefined)
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
        return page.runRpc('accept')
      })
      .catch(function (error) {
        page.fail(error)
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

  runRpc: function (kind, images) {
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
            : api.cancelOrder(id)
    return call
      .then(function () {
        ui.toast({
          title:
            kind === 'accept'
              ? '接单成功'
              : kind === 'complete'
                ? '已提交，等发布方确认'
                : kind === 'confirm'
                  ? '已确认，赏金已打给接单员'
                  : kind === 'abandon' ? '已放弃，任务重新开放' : '已取消',
          icon: 'success',
        })
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
      })
  },
})
