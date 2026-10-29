const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')

const PAGE_SIZE = 20

// 提现在新库 CloudBase，前端目前还连旧库，所以走 utils/tcb.js
// 等前端换完 SDK 之后改回 api.rpc('create_withdraw_request')

// kind → 中文说明
const KIND_TEXT = {
  order_reward: '订单赏金',
  withdraw: '提现',
  refund: '退款',
  admin_adjust: '管理员调整',
  system: '系统',
}

// 提现单状态 → 中文
const WD_STATUS = {
  pending: '待处理',
  processing: '处理中',
  success: '已转账',
  failed: '已退回',
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
    // 提现（新库）
    wdReady: false,
    wdLoading: false,
    wdErr: '',
    wdBalanceText: '0.00',
    wdMinText: '10.00',
    wdAmount: '',
    wdRecords: [],
    wdSubmitting: false,
    wdClaim: null,
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
              'R52 起已接入微信支付，可申请提现到微信零钱',
            ],
          })
          return page.fetchRecords(0).then(function (rows) {
            page.setData({
              records: rows,
              hasMore: rows.length >= PAGE_SIZE,
              loading: false,
            })
            page.loadWithdraw()
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

  // ---- 提现（走网关访问新库）----

  callWithdraw: function (payload) {
    const tcb = require('../../utils/tcb')
    return new Promise(function (resolve, reject) {
      wx.login({
        success: function (loginRes) {
          if (!loginRes.code) {
            reject(new Error('登录态失效，请重新进入'))
            return
          }
          tcb
            .call('withdraw', Object.assign({}, payload, { code: loginRes.code }))
            .then(resolve, reject)
        },
        fail: function () {
          reject(new Error('登录态失效，请重新进入'))
        },
      })
    })
  },

  loadWithdraw: function () {
    const page = this
    page.setData({ wdLoading: true, wdErr: '' })
    return page.callWithdraw({ action: 'summary' }).then(
      function (data) {
        const raw = data.records || []
        const list = raw.map(function (r) {
          return {
            id: r.id,
            amountText: Number(r.amount || 0).toFixed(2),
            statusText: WD_STATUS[r.status] || r.status || '',
            failReason: r.fail_reason || '',
            timeText: String(r.created_at || '').replace('T', ' ').slice(0, 16),
          }
        })
        // 已经发起转账、但用户还没在微信里确认收款的那一笔
        let claim = null
        raw.forEach(function (r) {
          if (r.status === 'processing' && r.package_info) {
            claim = {
              id: r.id,
              amountText: Number(r.amount || 0).toFixed(2),
              packageInfo: r.package_info,
            }
          }
        })
        page.setData({
          wdLoading: false,
          wdReady: true,
          wdBalanceText: Number(data.balance || 0).toFixed(2),
          wdMinText: Number(data.minWithdraw || 10).toFixed(2),
          wdRecords: list,
          wdClaim: claim,
        })
        return null
      },
      function (err) {
        page.setData({ wdLoading: false, wdErr: err.message || '加载失败' })
        return null
      }
    )
  },

  // 拉起微信的「确认收款」页。WAIT_USER_CONFIRM 状态的转账必须用户自己确认，
  // 否则 24 小时后会自动退回。
  claimTransfer: function () {
    const page = this
    const c = page.data.wdClaim
    if (!c) return
    if (!wx.requestMerchantTransfer) {
      ui.toast({ title: '当前微信版本不支持确认收款，请升级', icon: 'none' })
      return
    }
    wx.requestMerchantTransfer({
      mchId: '1119307371',
      appId: 'wxaab192c68e403292',
      package: c.packageInfo,
      success: function () {
        ui.toast({ title: '收款成功，请查看零钱' })
        page.setData({ wdClaim: null })
        page.loadWithdraw()
      },
      fail: function (e) {
        const msg = (e && (e.errMsg || e.err_msg)) || '确认失败'
        ui.toast({ title: msg, icon: 'none' })
      },
    })
  },

  onAmountInput: function (e) {
    this.setData({ wdAmount: e.detail.value || '' })
  },

  useAll: function () {
    this.setData({ wdAmount: this.data.wdBalanceText })
  },

  submitWithdraw: function () {
    const page = this
    const amount = Number(page.data.wdAmount || 0)
    if (!(amount > 0)) {
      ui.toast({ title: '请填写提现金额', icon: 'none' })
      return
    }
    if (page.data.wdSubmitting) return
    page.setData({ wdSubmitting: true })
    ui.loading('提交中')
    page.callWithdraw({ action: 'create', amount: amount }).then(
      function () {
        ui.hideLoading()
        ui.toast({ title: '提现申请已提交' })
        page.setData({ wdSubmitting: false, wdAmount: '' })
        page.loadWithdraw()
        return null
      },
      function (err) {
        ui.hideLoading()
        ui.toast({ title: err.message || '提交失败', icon: 'none' })
        page.setData({ wdSubmitting: false })
        return null
      }
    )
  },
})
