const ui = require('../../utils/ui')
const api = require('../../utils/api')

Page({
  data: {
    list: [],
    loading: false,
    needLogin: false,
    denied: false,
    actingId: 0,
    armId: 0,
    noteId: 0,
    note: '',
    errorText: '',
    pay: null,
    rateText: '',
    minWithdrawText: '',
    feeText: '',
    payEnabled: false,
    savingPay: false,
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
        return api
          .getProfile()
          .then(function (profile) {
            if (!profile || !profile.is_admin) {
              page.setData({ denied: true, list: [], loading: false })
              return
            }
            page.setData({ needLogin: false, denied: false })
            page.loadPay()
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
      .adminListFeedbacks(50)
      .then(function (rows) {
        const list = rows.map(function (item) {
          return {
            id: item.id,
            title: item.title || '未命名任务',
            serviceName: item.service_name || '',
            reward: item.reward,
            ownerName: item.owner_name || '',
            runnerName: item.runner_name || '',
            feedbackText: item.feedback_text || '',
            feedbackAtText: api.formatTime(item.feedback_at),
            doneAtText: api.formatTime(item.runner_done_at),
            adminNote: item.admin_note || '',
          }
        })
        page.setData({ list: list, loading: false, armId: 0, noteId: 0, note: '' })
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ loading: false, list: [], errorText: message })
        if (typeof console !== 'undefined' && console.error) console.error('[admin/settle]', message, error)
        ui.toast({ title: message, icon: 'none' })
      })
  },

  openNote: function (event) {
    this.setData({ noteId: Number(event.currentTarget.dataset.id), note: '' })
  },

  cancelNote: function () {
    this.setData({ noteId: 0, note: '' })
  },

  onNoteInput: function (event) {
    this.setData({ note: event.detail.value })
  },

  doResolve: function (id, approve, note) {
    const page = this
    if (page.data.actingId) return
    page.setData({ actingId: id })
    ui.loading({ title: '处理中', mask: true })
    api
      .adminResolveFeedback(id, approve, note)
      .then(function () {
        ui.hideLoading()
        page.setData({ actingId: 0, armId: 0, noteId: 0, note: '' })
        ui.toast({ title: approve ? '已判定通过，赏金已结算' : '已驳回', icon: 'success' })
        return page.load()
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ actingId: 0, errorText: message })
        ui.toast({ title: message, icon: 'none' })
      })
  },

  // 判定通过＝把钱打给接单员，所以也是二次点击确认
  approve: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id)
    if (page.data.actingId) return
    if (page.data.armId !== id) {
      if (page._armTimer) clearTimeout(page._armTimer)
      page.setData({ armId: id })
      page._armTimer = setTimeout(function () {
        page._armTimer = null
        if (page.data.armId === id) page.setData({ armId: 0 })
      }, 4000)
      return
    }
    if (page._armTimer) {
      clearTimeout(page._armTimer)
      page._armTimer = null
    }
    page.setData({ armId: 0 })
    page.doResolve(id, true, '')
  },

  reject: function (event) {
    const id = Number(event.currentTarget.dataset.id)
    const note = String(this.data.note || '').trim()
    if (!note) {
      ui.toast({ title: '请填写驳回原因', icon: 'none' })
      return
    }
    this.doResolve(id, false, note)
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },

  // ---------------- 结算与抽佣 ----------------
  // 费率存的是小数（0.05），页面上按百分比显示（5），免得填 5 变成 500%
  pctText: function (value) {
    const n = Number(value || 0) * 100
    return String(Math.round(n * 100) / 100)
  },

  loadPay: function () {
    const page = this
    return api
      .getPaySettings()
      .then(function (row) {
        if (!row) {
          page.setData({ pay: null })
          return
        }
        page.setData({
          pay: row,
          rateText: page.pctText(row.commission_rate),
          minWithdrawText: Number(row.min_withdraw || 0).toFixed(2),
          feeText: page.pctText(row.withdraw_fee_rate),
          payEnabled: !!row.enabled,
        })
      })
      .catch(function () {
        // 非超管拿不到这个接口，卡片直接不显示
        page.setData({ pay: null })
      })
  },

  onRateInput: function (event) {
    this.setData({ rateText: event.detail.value })
  },

  onMinWithdrawInput: function (event) {
    this.setData({ minWithdrawText: event.detail.value })
  },

  onFeeInput: function (event) {
    this.setData({ feeText: event.detail.value })
  },

  onTogglePay: function (event) {
    this.setData({ payEnabled: !!event.detail.value })
  },

  savePay: function () {
    const page = this
    if (page.data.savingPay) return
    const rate = Number(page.data.rateText)
    const minWithdraw = Number(page.data.minWithdrawText)
    const fee = Number(page.data.feeText)
    if (!isFinite(rate) || rate < 0 || rate > 50) {
      ui.toast({ title: '抽佣比例要填 0 到 50 之间的数字', icon: 'none' })
      return
    }
    if (!isFinite(minWithdraw) || minWithdraw < 0) {
      ui.toast({ title: '提现门槛要填不小于 0 的数字', icon: 'none' })
      return
    }
    if (!isFinite(fee) || fee < 0 || fee > 10) {
      ui.toast({ title: '提现手续费要填 0 到 10 之间的数字', icon: 'none' })
      return
    }
    const willDisable = page.data.pay && page.data.pay.enabled && !page.data.payEnabled
    const ask = willDisable
      ? ui.confirm({
          title: '关闭在线支付？',
          content: '关闭后新发布的订单不经过微信支付，直接视为已付款。确认要关吗？',
          confirmText: '确认关闭',
          cancelText: '再想想',
        })
      : Promise.resolve(true)
    ask.then(function (go) {
      if (!go) return null
      page.setData({ savingPay: true })
      return api
        .adminUpdatePaySettings({
          commissionRate: rate / 100,
          minWithdraw: minWithdraw,
          feeRate: fee / 100,
          enabled: page.data.payEnabled,
        })
        .then(function () {
          ui.toast({ title: '已保存', icon: 'success' })
          return page.loadPay()
        })
        .catch(function (error) {
          ui.toast({ title: api.getErrorMessage(error), icon: 'none' })
        })
        .then(function () {
          page.setData({ savingPay: false })
        })
    })
  },
})
