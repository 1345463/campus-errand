/**
 * 提现管理（后台兜底）
 *
 * 数据在新库 CloudBase，直连表与打款都不对客户端开放，所以走 utils/tcb.js：
 * wx.login 拿 code → /api/withdraw → 云函数用 service_role 访问新库。
 *
 * R54 起用户提交申请后由服务端自动打款（小额全自动，大额留在这里人工确认），
 * 所以本页的日常职责只剩两件：① 自动转账失败时点「自动转账」重试；
 * ② 判定不能打款时点「转账失败」，金额会自动退回用户钱包并写流水。
 */
const ui = require('../../utils/ui')

function fmtTime(v) {
  if (!v) return ''
  var s = String(v)
  return s.replace('T', ' ').slice(0, 16)
}

function fmtMoney(v) {
  var n = Number(v || 0)
  return n.toFixed(2)
}

Page({
  data: {
    list: [],
    loading: false,
    errorText: '',
    actingId: 0,
    armId: 0,
    noteId: 0,
    note: '',
  },

  onLoad: function () {
    this.load()
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

  // 每次都重新 wx.login：code 是一次性的，复用会失效
  call: function (payload) {
    const tcb = require('../../utils/tcb')
    return new Promise(function (resolve, reject) {
      wx.login({
        success: function (loginRes) {
          if (!loginRes.code) {
            reject(new Error('wx.login 没返回 code'))
            return
          }
          tcb
            .call('withdraw', Object.assign({}, payload, { code: loginRes.code }))
            .then(resolve, reject)
        },
        fail: function () {
          reject(new Error('wx.login 失败'))
        },
      })
    })
  },

  load: function () {
    const page = this
    page.setData({ loading: true, errorText: '' })
    return page.call({ action: 'list', status: 'all' }).then(
      function (data) {
        const raw = data.list || []
        const list = raw.map(function (r) {
          return {
            id: r.id,
            ownerId: r.owner_id,
            nickname: r.nickname || '同学',
            amountText: fmtMoney(r.amount),
            status: r.status,
            statusText: page.statusLabel(r.status),
            statusClass: page.statusClass(r.status),
            batchId: r.batch_id || '',
            failReason: r.fail_reason || '',
            createdText: fmtTime(r.created_at),
            finishedText: fmtTime(r.finished_at),
          }
        })
        page.setData({ list: list, loading: false })
      },
      function (err) {
        page.setData({ loading: false, errorText: err.message || '加载失败' })
      }
    )
  },

  statusLabel: function (s) {
    if (s === 'pending') return '待处理'
    if (s === 'processing') return '处理中'
    if (s === 'success') return '已转账'
    if (s === 'failed') return '已退回'
    return s || ''
  },

  statusClass: function (s) {
    if (s === 'pending') return 'status-pending'
    if (s === 'processing') return 'status-accepted'
    if (s === 'success') return 'status-approved'
    if (s === 'failed') return 'status-rejected'
    return ''
  },

  onNoteInput: function (e) {
    this.setData({ note: e.detail.value || '' })
  },

  openNote: function (e) {
    const id = Number(e.currentTarget.dataset.id || 0)
    this.setData({ noteId: id, note: '' })
  },

  cancelNote: function () {
    this.setData({ noteId: 0, note: '' })
  },

  // 自动转账：走云托管服务（固定出口 IP），微信直接打款给对方
  autoTransfer: function (e) {
    const page = this
    const id = Number(e.currentTarget.dataset.id || 0)
    if (!id || page.data.actingId) return
    if (page.data.armId !== id) {
      page.setData({ armId: id })
      ui.toast({ title: '确认自动转账？再点一次', icon: 'none' })
      return
    }
    page.setData({ actingId: id, armId: 0 })
    ui.loading('转账中')
    page.call({ action: 'transfer', id: id }).then(
      function (data) {
        ui.hideLoading()
        const st = (data && data.state) || ''
        if (st === 'WAIT_USER_CONFIRM') {
          ui.toast({ title: '已发起，等待对方确认收款', icon: 'none' })
        } else {
          ui.toast({ title: '转账成功' })
        }
        page.setData({ actingId: 0 })
        page.load()
        return null
      },
      function (err) {
        ui.hideLoading()
        ui.toast({ title: err.message || '转账失败', icon: 'none' })
        page.setData({ actingId: 0 })
        return null
      }
    )
  },

  // 标记失败：需要填原因，服务端会自动退款
  reject: function (e) {
    const page = this
    const id = Number(e.currentTarget.dataset.id || 0)
    if (!id || page.data.actingId) return
    const reason = (page.data.note || '').trim()
    if (!reason) {
      ui.toast({ title: '请填写失败原因', icon: 'none' })
      return
    }
    page.setData({ actingId: id })
    ui.loading('提交中')
    page.call({ action: 'finish', id: id, success: false, reason: reason }).then(
      function () {
        ui.hideLoading()
        ui.toast({ title: '已标记失败，金额已退回' })
        page.setData({ actingId: 0, noteId: 0, note: '' })
        page.load()
      },
      function (err) {
        ui.hideLoading()
        ui.toast({ title: err.message || '操作失败', icon: 'none' })
        page.setData({ actingId: 0 })
      }
    )
  },
})
