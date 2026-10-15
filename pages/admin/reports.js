const ui = require('../../utils/ui')
const api = require('../../utils/api')

// 管理员处理用户对订单的举报。
// 两种处置：
//   take_down —— 判定成立，订单直接取消下架（把接单员摘出来，避免他继续跑一趟违规任务）
//   reject    —— 判定不成立，给举报人和双方留一句说明
// 下架是不可逆的操作（订单变 canceled），所以沿用「再点一次确认」的二次交互，不当面消失。
const STATUS_TEXT = {
  pending: '待处理',
  resolved: '已下架',
  rejected: '已驳回',
}
const ROLE_TEXT = {
  owner: '发布方',
  runner: '接单员',
  viewer: '无关第三方',
}

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
      .adminListReports(50)
      .then(function (rows) {
        const list = rows.map(function (item) {
          return {
            id: item.report_id,
            orderId: item.order_id,
            reason: item.reason || '未填写',
            detail: item.detail || '',
            statusText: STATUS_TEXT[item.status] || item.status,
            pending: item.status === 'pending',
            adminNote: item.admin_note || '',
            createdText: api.formatTime(item.created_at),
            reporterName: item.reporter_name || '匿名',
            reporterRole: ROLE_TEXT[item.reporter_role] || '未知身份',
            orderTitle: item.order_title || '未命名任务',
            orderDesc: item.order_desc || '',
            reward: item.reward,
            orderReward: item.order_reward,
            orderStatus: item.order_status || '-',
            ownerName: item.owner_name || '未填写',
            runnerName: item.runner_name || '（暂无）',
          }
        })
        page.setData({ list: list, loading: false, armId: 0, noteId: 0, note: '' })
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ loading: false, list: [], errorText: message })
        if (typeof console !== 'undefined' && console.error) console.error('[admin/reports]', message, error)
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

  doHandle: function (id, action, note) {
    const page = this
    if (page.data.actingId) return
    page.setData({ actingId: id })
    ui.loading({ title: '处理中', mask: true })
    api
      .adminHandleReport(id, action, note)
      .then(function () {
        ui.hideLoading()
        page.setData({ actingId: 0, armId: 0, noteId: 0, note: '' })
        ui.toast({ title: action === 'take_down' ? '已下架该订单' : '已驳回举报', icon: 'success' })
        return page.load()
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ actingId: 0, errorText: message })
        ui.toast({ title: message, icon: 'none' })
      })
  },

  takeDown: function (event) {
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
    page.doHandle(id, 'take_down', '')
  },

  // 驳回必须写理由：举报人和这张单的双方都会看到，空话会让用户更不信任平台
  reject: function (event) {
    const id = Number(event.currentTarget.dataset.id)
    const note = String(this.data.note || '').trim()
    if (!note) {
      ui.toast({ title: '请填写驳回原因', icon: 'none' })
      return
    }
    this.doHandle(id, 'reject', note)
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },
})
