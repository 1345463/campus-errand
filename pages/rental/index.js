const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const services = require('../../utils/services')
const config = require('../../utils/config')

const STATUS_TEXT = {
  submitted: '待管理员报价',
  quoted: '已报价，等待生成工单',
  ordered: '已生成特殊工单',
}

Page({
  data: {
    items: [],
    itemsStale: false,
    pickupPoint: '',
    mine: [],
    mineLoading: false,
    needLogin: false,
    errorText: '',
  },

  onLoad: function () {
    this.setData({
      items: services.RENTAL_ITEMS,
      pickupPoint: config.pickupPoint,
    })
    this.loadItems()
  },

  // 机型与挂牌价读服务端：管理员后台改完，用户这边刷新就有了。
  // 拉不到数据时保留打包的兜底清单，不让页面空着 —— 只是价格可能是旧的，
  // 所以成功与否都把结果摆出来，拉失败时给一句明确提示。
  loadItems: function () {
    const page = this
    return api
      .listRentalItems()
      .then(function (rows) {
        if (!rows.length) return
        page.setData({
          items: rows.map(function (item) {
            return {
              id: item.id,
              name: item.name,
              spec: item.spec,
              price: Number(item.price) || 0,
            }
          }),
          itemsStale: false,
        })
      })
      .catch(function (error) {
        page.setData({ itemsStale: true })
        if (typeof console !== 'undefined' && console.error) console.error('[rental] items', error)
      })
  },

  onShow: function () {
    this.loadMine()
  },

  loadMine: function () {
    const page = this
    return api
      .getSession()
      .then(function (session) {
        if (!session) {
          page.setData({ needLogin: true, mine: [] })
          return null
        }
        page.setData({ needLogin: false, mineLoading: true })
        return api
          .listMyRentalRequests()
          .then(function (rows) {
            const mine = rows.map(function (item) {
              return {
                id: item.id,
                itemName: item.item_name,
                days: item.days,
                status: item.status,
                statusText: STATUS_TEXT[item.status] || item.status,
                quotedText:
                  item.quoted_price != null ? '报价 ¥' + item.quoted_price + '/天' : '管理员还未报价',
                orderId: item.order_id || 0,
                createdText: api.formatTime(item.created_at),
              }
            })
            page.setData({ mine: mine, mineLoading: false, errorText: '' })
          })
          .catch(function (error) {
            page.setData({ mineLoading: false, errorText: api.getErrorMessage(error) })
          })
      })
      .catch(function () {
        page.setData({ needLogin: true })
      })
  },

  // 租赁不再直接下单：先填预填信息，管理员报价后生成特殊工单
  goApply: function (event) {
    const page = this
    const item = event.currentTarget.dataset
    guard.ensureLogin().then(function (ok) {
      if (!ok) return
      const query =
        '?id=' +
        encodeURIComponent(item.id) +
        '&name=' +
        encodeURIComponent(item.name) +
        '&price=' +
        encodeURIComponent(item.price)
      wx.navigateTo({ url: '/pages/rental/apply' + query })
      if (page.data.errorText) page.setData({ errorText: '' })
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
