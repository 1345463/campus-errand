const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const services = require('../../utils/services')
const config = require('../../utils/config')
const campus = require('../../utils/campus')
const flags = require('../../utils/flags')

// 首页：轮播 + 服务入口 + 热门入口 + 任务大厅入口。
// 任务列表本身已经整体搬到 pages/hall/index，首页不再自己拉列表、也不再做筛选排序，
// 免得同一个列表在两处各维护一份、两边逻辑慢慢跑偏。

Page({
  data: {
    notice: '',
    school: campus.SCHOOL_NAME,
    services: [],

    // ---- 首页轮播（灰度 home_banner）----
    banners: [],
  },

  onLoad: function () {
    this.setData({
      notice: config.notice,
      services: services.SERVICES,
    })
    this.loadFlags()
  },

  // 灰度开关决定轮播要不要出现。
  // 这里是游客也能进的页面，所以 flags.ensure() 内部拉开关时不做登录校验。
  loadFlags: function () {
    const page = this
    return flags.ensure().then(function () {
      if (!flags.on('home_banner')) {
        page.setData({ banners: [] })
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
          page.setData({ banners: [] })
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
        page.setData({ banners: [] })
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
    wx.navigateTo({
      url: '/pages/order/create?type=' + type,
      fail: function (err) {
        ui.toast({ title: '页面打开失败：' + (err.errMsg || '未知错误'), icon: 'none' })
      },
    })
  },

  // 任务大厅：接单员才能看任务，门槛判断在大厅页里做
  goHall: function () {
    wx.navigateTo({
      url: '/pages/hall/index',
      fail: function (err) {
        ui.toast({ title: '页面打开失败：' + (err.errMsg || '未知错误'), icon: 'none' })
      },
    })
  },

  goRental: function () {
    wx.navigateTo({
      url: '/pages/rental/index',
      fail: function (err) {
        ui.toast({ title: '页面打开失败：' + (err.errMsg || '未知错误'), icon: 'none' })
      },
    })
  },

  // 地址要读写用户私有数据，必须在登录后进入
  goAddress: function () {
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
})
