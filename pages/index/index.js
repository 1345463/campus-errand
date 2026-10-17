const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const services = require('../../utils/services')
const config = require('../../utils/config')
const campus = require('../../utils/campus')
const flags = require('../../utils/flags')
const motion = require('../../utils/motion')

// 首页：自定义导航 + 渐变主视觉 + 服务宫格 + 悬浮发单。
// 任务列表本身在 pages/hall/index，首页只留入口 —— 同一个列表不在两处各维护一份。
//
// 这一版的交互改动：
//   1) 悬浮「发单」按钮 + 半屏面板：原来发单要先进宫格找分类，现在一步到位；
//   2) 每个可点元素都挂 hover-class 按压回弹 + 触感反馈（小程序的手感就靠这个）；
//   3) 下拉刷新会顶掉 5 分钟的开关缓存，避免刷完还是旧灰度；
//   4) 支持转发给好友 / 分享到朋友圈。

// 半屏面板里的快捷服务：按校内真实频次排的，改这个数组就能换
const QUICK_TYPES = ['express', 'buy', 'takeout', 'milk', 'print', 'other']

function greetingText() {
  const hour = new Date().getHours()
  if (hour < 6) return '夜深了'
  if (hour < 11) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

function stopPullDown() {
  if (typeof wx !== 'undefined' && wx && typeof wx.stopPullDownRefresh === 'function') {
    try {
      wx.stopPullDownRefresh()
    } catch (e) {
      /* 忽略 */
    }
  }
}

Page({
  data: {
    notice: config.notice,
    school: campus.SCHOOL_NAME,
    services: services.SERVICES,
    serviceHours: '每日 8:00 - 22:00',

    greeting: '你好',
    navTotal: 64,
    motionClass: '',

    // 首页轮播（灰度 home_banner）
    banners: [],
    bannersLoading: true,

    // 半屏发单面板
    sheetOpen: false,
    quickItems: [],
  },

  onLoad: function () {
    const sys = motion.systemInfo()
    this.setData({
      navTotal: sys.navTotalHeight,
      motionClass: motion.rootClass(),
      greeting: greetingText(),
      quickItems: QUICK_TYPES.map(function (type) {
        return services.findService(type) || { type: type, name: type, icon: '✨', tint: '#E4EEFF' }
      }),
    })
    this.loadFlags()
  },

  onShow: function () {
    // 从别的页面回来时问候语可能过期（比如跨了整点），顺手刷一下
    this.setData({ greeting: greetingText() })
  },

  onPullDownRefresh: function () {
    const page = this
    page.setData({ bannersLoading: true })
    // flags.ensure() 的缓存有 5 分钟，下拉时必须强制重新拉，
    // 否则超管刚改的开关在这台手机上要 5 分钟后才生效
    flags
      .load()
      .then(function () {
        return page.loadFlags()
      })
      .then(function () {
        page.setData({ bannersLoading: false })
        stopPullDown()
        motion.haptic('light')
      })
  },

  onShareAppMessage: function () {
    return {
      title: '校园跑腿 · 不想出门？call 我马上办',
      path: '/pages/index/index',
    }
  },

  onShareTimeline: function () {
    return { title: '校园跑腿 · ' + campus.SCHOOL_NAME + '同学互助跑腿平台' }
  },

  // 灰度开关决定轮播要不要出现。
  // 这里是游客也能进的页面，所以 flags.ensure() 内部拉开关时不做登录校验。
  loadFlags: function () {
    const page = this
    return flags.ensure().then(function () {
      if (!flags.on('home_banner')) {
        page.setData({ banners: [], bannersLoading: false })
        return null
      }
      return page.loadBanners()
    })
  },

  loadBanners: function () {
    const page = this
    return api
      .listBanners()
      .then(function (rows) {
        const list = rows || []
        if (list.length === 0) {
          page.setData({ banners: [], bannersLoading: false })
          return null
        }
        // 轮播走公开读通道：图是管理员传的，游客没有私有读权限，
        // 用 getSignedUrls 会一律失败（详见 utils/upload.js 的 readPublicAsset 注释）
        return api
          .getPublicImageUrls(
            list.map(function (item) {
              return item.image_path
            })
          )
          .then(function (resolved) {
            page.setData({
              bannersLoading: false,
              banners: list
                .map(function (item, index) {
                  const got = (resolved && resolved[index]) || {}
                  return {
                    id: item.id,
                    title: item.title,
                    url: got.url || '',
                    linkType: item.link_type,
                    linkValue: item.link_value,
                  }
                })
                .filter(function (item) {
                  // 解析失败的图片不上轮播，避免出现占位灰块
                  return !!item.url
                }),
            })
            return null
          })
      })
      .catch(function () {
        // 轮播不是主流程，失败就静默不显示
        page.setData({ banners: [], bannersLoading: false })
        return null
      })
  },

  // 轮播点击：按后台配的跳转类型分发。
  // 个人主体小程序没法用 web-view 打开外链，所以 url 类型改成复制链接。
  tapBanner: function (event) {
    const page = this
    const index = Number(event.currentTarget.dataset.index)
    const item = page.data.banners[index]
    if (!item) return
    motion.haptic('light')
    if (item.linkType === 'service' && item.linkValue) {
      page.goCreate({ currentTarget: { dataset: { type: item.linkValue } } })
      return
    }
    if (item.linkType === 'url' && item.linkValue) {
      wx.setClipboardData({
        data: item.linkValue,
        success: function () {
          ui.toast({ title: '链接已复制，去浏览器打开', icon: 'none' })
        },
      })
    }
  },

  // 填写表单是本地操作，不读用户私有数据，所以不做前置登录拦截；
  // 真正的登录校验放在下单页点「提交任务」时
  goCreate: function (event) {
    const type = event.currentTarget.dataset.type
    motion.haptic('select')
    wx.navigateTo({
      url: '/pages/order/create?type=' + type,
      fail: function (err) {
        ui.toast({ title: '页面打开失败：' + (err.errMsg || '未知错误'), icon: 'none' })
      },
    })
  },

  // 任务大厅：接单员才能看任务，门槛判断在大厅页里做
  goHall: function () {
    motion.haptic('light')
    wx.navigateTo({
      url: '/pages/hall/index',
      fail: function (err) {
        ui.toast({ title: '页面打开失败：' + (err.errMsg || '未知错误'), icon: 'none' })
      },
    })
  },

  goRental: function () {
    motion.haptic('light')
    wx.navigateTo({
      url: '/pages/rental/index',
      fail: function (err) {
        ui.toast({ title: '页面打开失败：' + (err.errMsg || '未知错误'), icon: 'none' })
      },
    })
  },

  // 地址要读写用户私有数据，必须在登录后进入
  goAddress: function () {
    motion.haptic('light')
    guard.ensureLogin().then(function (ok) {
      if (!ok) return
      wx.navigateTo({
        url: '/pages/mine/address',
        fail: function (err) {
          ui.toast({ title: '页面打开失败：' + (err.errMsg || '未知错误'), icon: 'none' })
        },
      })
    })
  },

  // ---------- 悬浮发单按钮 + 半屏面板 ----------
  openSheet: function () {
    motion.haptic('medium')
    this.setData({ sheetOpen: true })
  },

  closeSheet: function () {
    this.setData({ sheetOpen: false })
  },

  pickQuick: function (event) {
    const type = event.currentTarget.dataset.type
    motion.haptic('select')
    this.setData({ sheetOpen: false })
    this.goCreate({ currentTarget: { dataset: { type: type } } })
  },
})
