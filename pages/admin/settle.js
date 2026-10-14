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
})
