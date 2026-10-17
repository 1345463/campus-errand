const ui = require('../../utils/ui')
const api = require('../../utils/api')
const services = require('../../utils/services')
const campus = require('../../utils/campus')
const flags = require('../../utils/flags')
const motion = require('../../utils/motion')

// 任务大厅：接单员浏览并接单的主战场。
// 任务列表只在这个页面出现（首页只留入口），避免同一个列表在两处各维护一份。
//
// 三条和首页一样的规矩：
//   1) 必须是已认证接单员才能看任务，否则整页换成锁定卡，连请求都不发；
//   2) 服务类型 / 排序沿用灰度 hall_filter，没开着的时候只按时间取全量；
//   3) 楼栋楼层筛选单独挂 hall_building_filter 开关，方便超管单独关掉。
//
// 这一版的交互改动：
//   · 筛选栏吸顶，滚多远都能随时改条件；
//   · 楼栋 / 楼层收进半屏面板，不再把筛选栏撑成三行；
//   · 卡片上直接给「立即接单」，不用进详情再点一次；
//     （accept_order 在服务端做了和详情页完全一样的门槛校验，不是绕过）
//   · 骨架屏 + 阶梯入场 + 触感反馈 + 回到顶部。

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

const BUILDING_DEFS = [{ value: '', name: '全部' }].concat(
  campus.BUILDINGS.map(function (name) {
    return { value: name, name: name }
  })
)

const FLOOR_DEFS = [{ value: '', name: '全部' }].concat(
  campus.FLOORS.map(function (name) {
    return { value: name, name: name }
  })
)

// 大厅卡片左上角的小色块：用服务名反查图标与底色
function serviceMeta(name) {
  for (let i = 0; i < services.SERVICES.length; i += 1) {
    if (services.SERVICES[i].name === name) {
      return { icon: services.SERVICES[i].icon, tint: services.SERVICES[i].tint }
    }
  }
  return { icon: '✨', tint: '#E4EEFF' }
}

Page({
  data: {
    hall: [],
    loading: false,
    loadingMore: false,
    hallError: false,
    hasMore: false,
    totalText: '',

    // 自定义导航（fixed）让位 + 滚动联动
    navTotal: 64,
    motionClass: '',
    stuck: false,
    showTop: false,
    skeletonRows: [1, 2, 3, 4],

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
    building: '',
    floor: '',
    placeText: '楼栋楼层',

    // 半屏筛选面板：先在面板里选，点「查看结果」才真正请求
    filterSheet: false,
    draftBuilding: '',
    draftFloor: '',
  },

  onLoad: function () {
    const sys = motion.systemInfo()
    this.setData({
      navTotal: sys.navTotalHeight,
      motionClass: motion.rootClass(),
      filterOn: flags.on('hall_filter'),
      buildingOn: flags.on('hall_building_filter'),
    })
    // 这里不发请求：onLoad 之后必然紧跟一次 onShow，列表统一在 onShow 里拉，
    // 否则首屏会连着发两遍（一次不带开关、一次带开关）
  },

  onShow: function () {
    this.loadFlags()
  },

  onPullDownRefresh: function () {
    const page = this
    // 下拉必须顶掉 5 分钟的开关缓存，否则超管刚改的开关在这台手机上不生效
    flags.load().then(function () {
      return page.loadFlags()
    }).then(function () {
      if (typeof wx.stopPullDownRefresh === 'function') {
        try {
          wx.stopPullDownRefresh()
        } catch (e) {
          /* 忽略 */
        }
      }
      motion.haptic('light')
    })
  },

  onReachBottom: function () {
    if (this.data.hasMore && !this.data.loadingMore) this.loadMore()
  },

  // 吸顶阴影 + 回到顶部按钮：只在跨过阈值时 setData，滚动过程中不频繁刷新
  onPageScroll: function (event) {
    const top = event.scrollTop || 0
    const stuck = top > 30
    const showTop = top > 600
    if (stuck !== this.data.stuck || showTop !== this.data.showTop) {
      this.setData({ stuck: stuck, showTop: showTop })
    }
  },

  goTop: function () {
    motion.haptic('light')
    if (typeof wx.pageScrollTo === 'function') {
      wx.pageScrollTo({ scrollTop: 0, duration: 300 })
    }
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
    motion.haptic('select')
    this.setData({ filterType: type })
    this.loadHall(true)
  },

  pickSort: function (event) {
    const key = event.currentTarget.dataset.key || 'time'
    if (key === this.data.sortKey) return
    motion.haptic('select')
    this.setData({ sortKey: key })
    this.loadHall(true)
  },

  // ---------- 楼栋 / 楼层：半屏面板里选，点「查看结果」才请求 ----------
  openFilter: function () {
    motion.haptic('light')
    this.setData({
      filterSheet: true,
      draftBuilding: this.data.building,
      draftFloor: this.data.floor,
    })
  },

  closeFilter: function () {
    this.setData({ filterSheet: false })
  },

  pickPlace: function (event) {
    const kind = event.currentTarget.dataset.kind
    const value = event.currentTarget.dataset.value || ''
    motion.haptic('select')
    if (kind === 'building') this.setData({ draftBuilding: value })
    else this.setData({ draftFloor: value })
  },

  clearPlace: function () {
    motion.haptic('light')
    this.setData({ draftBuilding: '', draftFloor: '' })
  },

  applyPlace: function () {
    const page = this
    const building = page.data.draftBuilding
    const floor = page.data.draftFloor
    motion.haptic('medium')
    page.setData({
      filterSheet: false,
      building: building,
      floor: floor,
      placeText: placeLabel(building, floor),
    })
    page.loadHall(true)
  },

  resetFilter: function () {
    motion.haptic('light')
    this.setData({
      filterType: '',
      sortKey: 'time',
      building: '',
      floor: '',
      draftBuilding: '',
      draftFloor: '',
      placeText: '楼栋楼层',
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
              // 阶梯入场：每一项带自己的 --d 延迟，列表是一条条「长」出来的
              hall: motion.stagger(
                rows.map(function (item) {
                  return page.toCard(item)
                })
              ),
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
        // 追加的第二页从第 0ms 开始，不要接着第一页的延迟往下排
        const next = page.data.hall.concat(
          motion.stagger(
            rows.map(function (item) {
              return page.toCard(item)
            })
          )
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
    const meta = serviceMeta(item.service_name)
    return {
      id: item.id,
      title: item.title,
      serviceName: item.service_name,
      icon: meta.icon,
      tint: meta.tint,
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
    motion.haptic('light')
    wx.navigateTo({ url: '/pages/order/detail?id=' + event.currentTarget.dataset.id })
  },

  // 大厅内直接接单：省掉「进详情 → 找到按钮 → 点」两步。
  // 服务端 accept_order 的门槛校验和详情页按钮走的是同一个 RPC，不存在绕过。
  quickAccept: function (event) {
    const page = this
    const id = event.currentTarget.dataset.id
    motion.haptic('medium')
    ui
      .confirm({
        title: '确认接这一单？',
        content: '接单后请尽快联系发布方，按时送达。接了不完成会影响你的信誉分。',
        confirmText: '接了',
        cancelText: '再看看',
        defaultConfirm: false,
      })
      .then(function (ok) {
        if (!ok) return null
        ui.loading('接单中')
        return api
          .acceptOrder(id)
          .then(function () {
            ui.hideLoading()
            motion.hapticStrong()
            ui.toast({ title: '接单成功，快去完成吧', icon: 'success' })
            return page.loadHall(true)
          })
          .catch(function (error) {
            ui.hideLoading()
            motion.haptic('error')
            ui.toast({ title: api.getErrorMessage(error), icon: 'none' })
            // 状态可能已经变了，顺手刷一下列表
            return page.loadHall(true)
          })
      })
  },

  retry: function () {
    this.loadHall(true)
  },
})

function placeLabel(building, floor) {
  if (!building && !floor) return '楼栋楼层'
  if (building && floor) return building + ' · ' + floor
  return building || floor
}
