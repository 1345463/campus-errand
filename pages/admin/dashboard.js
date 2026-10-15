const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const flags = require('../../utils/flags')
const perms = require('../../utils/perms')

// 六张统计卡片。perm 对应 adminDashboardStats 返回的 can_xxx，
// 后端已按调用者权限过滤：没有的权限 can_xxx 为 false，卡片直接不出现（不是置灰）。
// 今日/累计订单是管理员全局视角，挂在 can_super 上，避免客服、审核看到全局数字。
const CARD_DEFS = [
  { key: 'pending_certs', label: '待审核认证', perm: 'can_review', url: '/pages/admin/review' },
  { key: 'pending_rentals', label: '待报价租赁', perm: 'can_rental', url: '/pages/admin/rental' },
  { key: 'pending_reports', label: '待处理举报', perm: 'can_support', url: '/pages/admin/reports' },
  { key: 'pending_settles', label: '待核查结算', perm: 'can_settle', url: '/pages/admin/settle' },
  { key: 'pending_feedbacks', label: '待处理反馈', perm: 'can_support', url: '/pages/admin/feedback' },
  { key: 'today_orders', label: '今日订单', perm: 'can_super', url: '' },
  { key: 'total_orders', label: '累计订单', perm: 'can_super', url: '' },
]

// 全部后台页面的入口都在这里。「我的」页只留一个跳进工作台的入口，
// 谁能看到哪几项依旧由权限决定（check），灰度开关负责没上线完的功能（flag）。
// action 是少数不能直接 navigateTo 的入口：全部订单是 tabBar 页面，只能 switchTab。
const ENTRY_DEFS = [
  { key: 'orders', label: '全部订单', icon: '📋', check: 'super', action: 'adminOrders', desc: '查看所有人的订单' },
  { key: 'review', label: '审核接单员', icon: '🪪', url: '/pages/admin/review', check: 'review', desc: '实名认证审核' },
  { key: 'rental', label: '租赁申请与报价', icon: '📷', url: '/pages/admin/rental', check: 'rental', desc: '相机租赁工单' },
  { key: 'items', label: '机型与挂牌价', icon: '🏷️', url: '/pages/admin/items', check: 'rental', desc: '改价 / 上下架' },
  { key: 'reports', label: '举报处理', icon: '🛡️', url: '/pages/admin/reports', check: 'support', desc: '下架违规订单' },
  { key: 'settle', label: '结算核查', icon: '🧾', url: '/pages/admin/settle', check: 'settle', desc: '48 小时未确认申诉' },
  { key: 'points', label: '积分商城', icon: '🎁', url: '/pages/admin/points', check: 'settle', flag: 'point_mall', desc: '商品 / 积分 / 核销' },
  { key: 'dispatch', label: '批量发单', icon: '📦', url: '/pages/admin/dispatch', check: 'dispatch', flag: 'admin_batch_order', desc: '同栋同层一次发多单' },
  { key: 'staff', label: '人员与授权', icon: '👥', url: '/pages/admin/staff', check: ['hr', 'super'], flag: 'staff_search', desc: '查找并开通权限' },
  { key: 'feedback', label: '意见反馈', icon: '💬', url: '/pages/admin/feedback', check: 'support', flag: 'user_feedback', desc: '受理 / 驳回反馈' },
  // flags / banners 是配置和总闸页，不能再被自己的开关挡住（否则关了就进不去打开）
  { key: 'flags', label: '灰度开关', icon: '🎚️', url: '/pages/admin/flags', check: 'super', desc: '新功能总闸' },
  { key: 'banners', label: '轮播管理', icon: '🖼️', url: '/pages/admin/banners', check: 'super', desc: '首页广告位配置' },
]

function matchPerm(def) {
  const list = Array.isArray(def.check) ? def.check : [def.check]
  for (let i = 0; i < list.length; i++) {
    if (perms.has(list[i])) return true
  }
  return false
}

// 卡片按每行 3 个分组渲染：app.wxss 的 .quick-row 不换行，
// 六个 flex:1 挤在一行会被压成一条，分成两行才是网格的样子
function buildCards(stats) {
  const rows = []
  let row = null
  CARD_DEFS.forEach(function (def) {
    if (stats[def.perm] !== true) return
    if (!row || row.items.length >= 3) {
      row = { key: 'row' + rows.length, items: [] }
      rows.push(row)
    }
    const value = Number(stats[def.key]) || 0
    row.items.push({
      key: def.key,
      label: def.label,
      value: value,
      url: def.url,
      // 数字为 0 的置灰，但仍然可以点进去看空列表
      dim: value === 0,
      isLast: false,
    })
  })
  rows.forEach(function (r) {
    if (r.items.length) r.items[r.items.length - 1].isLast = true
  })
  return rows
}

function buildEntries() {
  const entries = ENTRY_DEFS.filter(function (def) {
    if (!matchPerm(def)) return false
    // 没有 flag 的项是老功能，一直可用；有 flag 的必须开关打开
    return !def.flag || flags.on(def.flag)
  })
  return entries.map(function (def, index) {
    return {
      key: def.key,
      label: def.label,
      icon: def.icon,
      url: def.url || '',
      action: def.action || '',
      desc: def.desc || '',
      isLast: index === entries.length - 1,
    }
  })
}

Page({
  data: {
    grayOff: false,
    needLogin: false,
    denied: false,
    loading: false,
    errorText: '',
    stats: null,
    cardRows: [],
    entries: [],
  },

  onLoad: function () {
    this.checkAndLoad()
  },

  onPullDownRefresh: function () {
    const page = this
    page.load().then(
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
    page.setData({ loading: true, errorText: '' })
    return flags
      .ensure()
      .then(function () {
        // 灰度没开直接收口：不拉统计、不列入口
        if (!flags.on('admin_dashboard')) {
          page.setData({ grayOff: true, loading: false, cardRows: [], entries: [] })
          return null
        }
        return api.getSession().then(function (session) {
          if (!session) {
            page.setData({ grayOff: false, needLogin: true, loading: false })
            return null
          }
          // 权限拉回来再判断：只要有任何一项后台权限就放行，具体能看什么由卡片/入口各自过滤
          return perms.load().then(function () {
            if (!perms.anyAdmin()) {
              page.setData({ grayOff: false, needLogin: false, denied: true, loading: false })
              return null
            }
            page.setData({ grayOff: false, needLogin: false, denied: false })
            return page.load()
          })
        })
      })
      .catch(function (error) {
        page.setData({ loading: false })
        guard.toastError(error)
      })
  },

  load: function () {
    const page = this
    page.setData({ loading: true, errorText: '' })
    return api
      .adminDashboardStats()
      .then(function (row) {
        const stats = row || {}
        page.setData({
          stats: stats,
          cardRows: buildCards(stats),
          entries: buildEntries(),
          loading: false,
        })
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        // 统计拉不出来就把卡片和入口一起收掉：留着旧的空数字会让人以为真的没有待办
        page.setData({ loading: false, errorText: message, cardRows: [], entries: [] })
        guard.toastError(error)
      })
  },

  openCard: function (event) {
    const page = this
    const url = event.currentTarget.dataset.url
    if (!url) {
      // 今日 / 累计订单只是全局统计，没有对应的后台列表页
      ui.toast({ title: '订单是全局统计，去「订单」页查看', icon: 'none' })
      return
    }
    wx.navigateTo({ url: url })
  },

  openEntry: function (event) {
    const dataset = event.currentTarget.dataset
    // 「全部订单」在 tabBar 里，只能用 switchTab 过去，并且要带上管理员模式标记
    if (dataset.action === 'adminOrders') {
      ui.setStorage('orderListMode', 'admin')
      wx.switchTab({ url: '/pages/orders/list' })
      return
    }
    if (!dataset.url) return
    wx.navigateTo({ url: dataset.url })
  },

  goOrders: function () {
    wx.switchTab({ url: '/pages/orders/list' })
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },
})
