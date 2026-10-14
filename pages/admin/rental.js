const ui = require('../../utils/ui')
const api = require('../../utils/api')

const TABS = [
  { key: 'submitted', label: '待报价' },
  { key: 'quoted', label: '已报价' },
  { key: 'ordered', label: '已生成工单' },
  { key: 'all', label: '全部' },
]

const STATUS_TEXT = {
  submitted: '待报价',
  quoted: '已报价',
  ordered: '已生成工单',
}

Page({
  data: {
    tabs: TABS,
    tab: 'submitted',
    list: [],
    loading: false,
    needLogin: false,
    denied: false,
    actingId: 0,
    armId: 0,
    priceId: 0,
    price: '',
    deposit: '',
    errorText: '',
    tipText: '',
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
      .adminListRentalRequests(page.data.tab)
      .then(function (rows) {
        const list = rows.map(function (item) {
          const price = Number(item.quoted_price != null ? item.quoted_price : item.unit_price) || 0
          const days = Number(item.days) || 1
          return {
            id: item.id,
            itemName: item.item_name,
            days: days,
            unitPrice: Number(item.unit_price) || 0,
            quotedPrice: item.quoted_price,
            deposit: item.deposit,
            totalText: (price * days).toFixed(2),
            realName: item.real_name || '',
            studentNo: item.student_no || '',
            college: item.college || '',
            contact: item.contact || '',
            expectFrom: item.expect_from || '',
            expectTo: item.expect_to || '',
            pickupAddr: item.pickup_addr || '',
            note: item.note || '',
            status: item.status,
            statusText: STATUS_TEXT[item.status] || item.status,
            orderId: item.order_id || 0,
            createdText: api.formatTime(item.created_at),
          }
        })
        page.setData({
          list: list,
          loading: false,
          armId: 0,
          priceId: 0,
          price: '',
          deposit: '',
        })
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ loading: false, list: [], errorText: message })
        if (typeof console !== 'undefined' && console.error) console.error('[admin/rental]', message, error)
        ui.toast({ title: message, icon: 'none' })
      })
  },

  switchTab: function (event) {
    const page = this
    this.setData({ tab: event.currentTarget.dataset.key, tipText: '' }, function () {
      page.load()
    })
  },

  openPrice: function (event) {
    const id = Number(event.currentTarget.dataset.id)
    const row = this.data.list.filter(function (item) {
      return item.id === id
    })[0]
    this.setData({
      priceId: id,
      price: row && row.quotedPrice != null ? String(row.quotedPrice) : row ? String(row.unitPrice) : '',
      deposit: row && row.deposit != null ? String(row.deposit) : '',
    })
  },

  closePrice: function () {
    this.setData({ priceId: 0, price: '', deposit: '' })
  },

  onPriceInput: function (event) {
    const key = event.currentTarget.dataset.key
    const patch = {}
    patch[key] = event.detail.value
    this.setData(patch)
  },

  savePrice: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id)
    const price = Number(String(page.data.price || '').trim())
    const deposit = Number(String(page.data.deposit || '').trim())
    if (!isFinite(price) || price < 0) {
      ui.toast({ title: '请输入正确的日租金', icon: 'none' })
      return
    }
    if (!isFinite(deposit) || deposit < 0) {
      ui.toast({ title: '请输入正确的押金（没有就填 0）', icon: 'none' })
      return
    }
    if (page.data.actingId) return
    page.setData({ actingId: id })
    ui.loading({ title: '保存中', mask: true })
    api
      .adminSetRentalPrice(id, price, deposit)
      .then(function () {
        ui.hideLoading()
        page.setData({ actingId: 0, priceId: 0, tipText: '已保存报价' })
        ui.toast({ title: '报价已保存', icon: 'success' })
        return page.load()
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ actingId: 0, errorText: message })
        ui.toast({ title: message, icon: 'none' })
      })
  },

  // 生成特殊工单：点了会变字，再点一次才真的建单
  createOrder: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id)
    if (page.data.actingId) return
    if (page.data.armId !== id) {
      if (page._armTimer) clearTimeout(page._armTimer)
      page.setData({ armId: id, tipText: '' })
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
    page.setData({ armId: 0, actingId: id })
    ui.loading({ title: '生成中', mask: true })
    api
      .adminCreateRentalOrder(id)
      .then(function (order) {
        ui.hideLoading()
        page.setData({ actingId: 0, tipText: '已生成特殊工单 #' + (order && order.id ? order.id : '') })
        ui.toast({ title: '特殊工单已生成', icon: 'success' })
        return page.load()
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ actingId: 0, errorText: message })
        ui.toast({ title: message, icon: 'none' })
      })
  },

  openOrder: function (event) {
    const id = Number(event.currentTarget.dataset.id)
    if (!id) return
    wx.navigateTo({ url: '/pages/order/detail?id=' + id })
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },
})
