const ui = require('../../utils/ui')
const api = require('../../utils/api')
const services = require('../../utils/services')
const campus = require('../../utils/campus')
const flags = require('../../utils/flags')

// 任务大厅：从首页拆出来的独立页面。
// 任务列表只在这个页面出现（首页只留入口），避免同一个列表在两处各维护一份。
//
// 三条和首页一样的规矩：
//   1) 必须是已认证接单员才能看任务，否则整页换成锁定卡，连请求都不发；
//   2) 服务类型 / 排序沿用灰度 hall_filter，没开着的时候只按时间取全量；
//   3) 楼栋楼层筛选单独挂 hall_building_filter 开关，方便超管单独关掉。

const HALL_SIZE = 30
const PAGE_SIZE = 20

const FILTER_DEFS = [{ type: '', name: '全部' }].concat(
  services.SERVICES.map(function (item) {
    return { type: item.type, name: item.name }
  })
)

const SORT_DEFS = [
  { key: 'time', name: '最新发布' },
  { key: 'reward', name: '赏金最高' },
]

const BUILDING_DEFS = [{ value: '', name: '全部楼栋' }].concat(
  campus.BUILDINGS.map(function (name) {
    return { value: name, name: name }
  })
)

const FLOOR_DEFS = [{ value: '', name: '全部楼层' }].concat(
  campus.FLOORS.map(function (name) {
    return { value: name, name: name }
  })
)

Page({
  data: {
    hall: [],
    loading: false,
    loadingMore: false,
    hallError: false,
    hasMore: false,
    totalText: '',

    // 接单员门槛
    locked: false,
    lockTitle: '',
    lockDesc: '',
    lockBtn: '',
    lockMode: 'login',

    // 筛选 / 排序（灰度 hall_filter）
    filterOn: false,
    filters: FILTER_DEFS,
    filterType: '',
    sorts: SORT_DEFS,
    sortKey: 'time',

    // 楼栋 / 楼层筛选（灰度 hall_building_filter）
    buildingOn: false,
    buildings: BUILDING_DEFS,
    floors: FLOOR_DEFS,
    buildingNames: [],
    floorNames: [],
    buildingIndex: 0,
    floorIndex: 0,
    building: '',
    floor: '',
  },

  onLoad: function () {
    this.setData({
      filters: FILTER_DEFS,
      buildingNames: BUILDING_DEFS.map(function (item) {
        return item.name
      }),
      floorNames: FLOOR_DEFS.map(function (item) {
        return item.name
      }),
    })
    // 这里不发请求：onLoad 之后必然紧跟一次 onShow，列表统一在 onShow 里拉，
    // 否则首屏会连着发两遍（一次不带开关、一次带开关）
  },

  onShow: function () {
    this.loadFlags()
  },

  onPullDownRefresh: function () {
    const page = this
    page.loadHall(true).then(function () {
      wx.stopPullDownRefresh()
    })
  },

  onReachBottom: function () {
    if (this.data.hasMore && !this.data.loadingMore) this.loadMore()
  },

  loadFlags: function () {
    const page = this
    return flags.ensure().then(function () {
      page.setData({
        filterOn: flags.on('hall_filter'),
        buildingOn: flags.on('hall_building_filter'),
      })
      return page.loadHall(true)
    })
  },

  pickFilter: function (event) {
    const type = event.currentTarget.dataset.type || ''
    if (type === this.data.filterType) return
    this.setData({ filterType: type })
    this.loadHall(true)
  },

  pickSort: function (event) {
    const key = event.currentTarget.dataset.key || 'time'
    if (key === this.data.sortKey) return
    this.setData({ sortKey: key })
    this.loadHall(true)
  },

  pickBuilding: function (event) {
    const index = Number(event.detail.value) || 0
    const value = BUILDING_DEFS[index] ? BUILDING_DEFS[index].value : ''
    this.setData({ buildingIndex: index, building: value })
    this.loadHall(true)
  },

  pickFloor: function (event) {
    const index = Number(event.detail.value) || 0
    const value = FLOOR_DEFS[index] ? FLOOR_DEFS[index].value : ''
    this.setData({ floorIndex: index, floor: value })
    this.loadHall(true)
  },

  resetFilter: function () {
    this.setData({
      filterType: '',
      sortKey: 'time',
      buildingIndex: 0,
      floorIndex: 0,
      building: '',
      floor: '',
    })
    this.loadHall(true)
  },

  // 大厅只对已认证接单员开放：散户进来只能看到锁定卡，
  // 服务端 orders 的读策略也做了同样一层拦截，两边一致。
  checkRunner: function () {
    const page = this
    return Promise.all([
      api.getSession().catch(function () {
        return null
      }),
      api.getProfile().catch(function () {
        return null
      }),
    ]).then(function (result) {
      const session = result[0]
      const profile = result[1]
      if (!session || !profile) {
        page.setData({
          lockTitle: '任务大厅仅对接单员开放',
          lockDesc: '登录并完成接单员实名认证后，就能看到大厅里的任务并接单',
          lockBtn: '去登录',
          lockMode: 'login',
        })
        return false
      }
      const qualified = profile.cert_status === 'approved' || profile.role === 'runner'
      if (!qualified) {
        page.setData({
          lockTitle: '成为接单员后才能查看任务大厅',
          lockDesc: '大厅任务只对已认证的接单员开放。完成实名认证后即可查看任务、接单赚赏金',
          lockBtn: '去认证接单员',
          lockMode: 'apply',
        })
        return false
      }
      return true
    })
  },

  tapLock: function () {
    if (this.data.lockMode === 'apply') {
      wx.navigateTo({ url: '/pages/mine/apply' })
      return
    }
    wx.switchTab({ url: '/pages/mine/index' })
  },

  loadHall: function (reset) {
    const page = this
    page.setData({ loading: true })
    return page
      .checkRunner()
      .then(function (qualified) {
        if (!qualified) {
          page.setData({ loading: false, hall: [], hallError: false, hasMore: false, locked: true })
          return null
        }
        page.setData({ locked: false })
        return api
          .listHallOrders({
            serviceType: page.data.filterOn ? page.data.filterType : '',
            sort: page.data.filterOn ? page.data.sortKey : 'time',
            building: page.data.buildingOn ? page.data.building : '',
            floor: page.data.buildingOn ? page.data.floor : '',
            limit: HALL_SIZE,
            offset: 0,
          })
          .then(function (list) {
            const rows = list || []
            // list_hall_orders 每行都带 count(*) OVER() 算出的总数，比分页长度准
            const total = Number(rows.length ? rows[0].total : 0) || 0
            page.setData({
              hall: rows.map(function (item) {
                return page.toCard(item)
              }),
              hasMore: total > rows.length,
              totalText: total ? '共 ' + total + ' 个任务可接' : '',
              loading: false,
              hallError: false,
            })
            return null
          })
          .catch(function (error) {
            console.error('[hall] load failed', api.getErrorMessage(error))
            page.setData({ loading: false, hall: [], hallError: true, hasMore: false })
            return null
          })
      })
      .catch(function () {
        page.setData({ loading: false, hall: [], hallError: true })
        return null
      })
  },

  loadMore: function () {
    const page = this
    page.setData({ loadingMore: true })
    return api
      .listHallOrders({
        serviceType: page.data.filterOn ? page.data.filterType : '',
        sort: page.data.filterOn ? page.data.sortKey : 'time',
        building: page.data.buildingOn ? page.data.building : '',
        floor: page.data.buildingOn ? page.data.floor : '',
        limit: PAGE_SIZE,
        offset: page.data.hall.length,
      })
      .then(function (list) {
        const rows = list || []
        const total = Number(rows.length ? rows[0].total : 0) || 0
        const next = page.data.hall.concat(
          rows.map(function (item) {
            return page.toCard(item)
          })
        )
        page.setData({
          hall: next,
          loadingMore: false,
          hasMore: total > next.length,
          totalText: total ? '共 ' + total + ' 个任务可接' : '',
        })
        return null
      })
      .catch(function () {
        page.setData({ loadingMore: false })
        ui.toast({ title: '加载更多失败', icon: 'none' })
        return null
      })
  },

  toCard: function (item) {
    const where = item.deliver_building
      ? '送到：' + item.deliver_building + (item.deliver_floor ? ' ' + item.deliver_floor : '')
      : item.deliver_addr
        ? '送到：' + item.deliver_addr
        : item.pickup_addr
          ? '取件：' + item.pickup_addr
          : '位置：待沟通'
    return {
      id: item.id,
      title: item.title,
      serviceName: item.service_name,
      reward: item.reward,
      createdText: api.formatTime(item.created_at),
      whereText: where,
      discountText: item.discount_amount ? '已用券抵扣 ¥' + item.discount_amount : '',
      // 用了优先展示券的单会被服务端排到最前面，这里给个标识，
      // 不然其他人看着「凭什么它在第一」会以为是黑幕
      boosted: !!item.boosted,
    }
  },

  openDetail: function (event) {
    wx.navigateTo({ url: '/pages/order/detail?id=' + event.currentTarget.dataset.id })
  },

  retry: function () {
    this.loadHall(true)
  },

  goBack: function () {
    wx.navigateBack({
      fail: function () {
        wx.switchTab({ url: '/pages/index/index' })
      },
    })
  },
})
