const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const services = require('../../utils/services')
const flags = require('../../utils/flags')
const motion = require('../../utils/motion')

// 分页每页条数。服务端 list_my_orders 上限 50，这里取 20 兼顾首屏速度
const PAGE_SIZE = 20

const MODES = [
  { key: 'publish', label: '我发布的' },
  { key: 'accept', label: '我接的单' },
]

const STATUSES = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待接单' },
  { key: 'accepted', label: '进行中' },
  { key: 'waiting_confirm', label: '待确认' },
  { key: 'done', label: '已完成' },
  { key: 'canceled', label: '已取消' },
]

const CLOSED_STATUS = { done: true, canceled: true }
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

// 能否删除：完结满 7 天，或者被管理员判定违规下架。
// 这里只是「先给不给显示删除按钮」的粗判，真正的把关在服务端 hide_my_order —— 前端判断可以被绕过。
function canDelete(item) {
  if (!item || !CLOSED_STATUS[item.status]) return false
  if (item.takedown === true) return true
  const closedAt = item.finished_at || item.runner_done_at || item.created_at
  const time = closedAt ? new Date(closedAt).getTime() : 0
  if (!time) return false
  return Date.now() - time >= WEEK_MS
}

Page({
  data: {
    modes: MODES,
    statuses: STATUSES,
    mode: 'publish',
    status: 'all',
    list: [],
    loading: false,
    needLogin: false,
    isAdmin: false,
    // 删除是「隐藏给自己看」，默认彻底不显示；打开开关才列出已删除的（用于恢复）
    showHidden: false,
    hiddenList: [],
    hiddenLoading: false,
    hideArmId: 0,
    errorText: '',
    // ---- 分页（灰度 order_paging）----
    pagingOn: false,
    hasMore: false,
    loadingMore: false,
    // ---- 搜索（灰度 order_search）----
    searchOn: false,
    keyword: '',
    searching: false,

    // 自定义导航（fixed）让位 + 滚动联动 + 骨架屏行数
    navTotal: 64,
    motionClass: '',
    stuck: false,
    showTop: false,
    skeletonRows: [1, 2, 3, 4],
  },

  onLoad: function (options) {
    const sys = motion.systemInfo()
    const patch = {
      navTotal: sys.navTotalHeight,
      motionClass: motion.rootClass(),
    }
    if (options && options.mode === 'accept') patch.mode = 'accept'
    this.setData(patch)
    const page = this
    page._flagsReady = flags.ensure().then(function () {
      page.setData({
        pagingOn: flags.on('order_paging'),
        searchOn: flags.on('order_search'),
      })
    })
  },

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

  onPullDownRefresh: function () {
    const page = this
    page.checkAndLoad().then(function () {
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
    if (this.data.loading) return
    if (!this.data.hasMore || this.data.loadingMore) return
    this.loadMore()
  },

  onShow: function () {
    // 「我的」页跳转过来时带的筛选条件
    const status = ui.getStorage('orderFilterStatus')
    const mode = ui.getStorage('orderListMode')
    if (status) {
      ui.removeStorage('orderFilterStatus')
      this.setData({ status: status })
    }
    if (mode) {
      ui.removeStorage('orderListMode')
      this.setData({ mode: mode })
    }
    this.checkAndLoad(true)
  },

  // 「删除」是两次点击确认（4 秒上膛），定时器必须在页面销毁/切走后清掉：
  // 否则回调还会 setData 到一个已经不在栈上的页面。
  onHide: function () {
    this.cancelHide()
  },

  onUnload: function () {
    this.cancelHide()
  },

  checkAndLoad: function (silent) {
    const page = this
    return Promise.resolve(page._flagsReady).then(function () { return api.getSession() })
      .then(function (session) {
        if (!session) {
          page._request = (page._request || 0) + 1
          page._loadedFilter = null
          page.setData({ needLogin: true, list: [], loading: false, isAdmin: false, hasMore: false })
          return
        }
        page._sessionKey = session.user ? String(session.user.id) : ''
        if (page._lastSession && page._lastSession !== page._sessionKey) page.setData({ list: [], hiddenList: [] })
        page._lastSession = page._sessionKey
        return api
          .getProfile()
          .then(function (profile) {
            const isAdmin = !!(profile && profile.is_admin)
            // 管理员入口在 WXML 单独渲染，服务端仍会验证权限
            if (!isAdmin && page.data.mode === 'admin') page.setData({ mode: 'publish' })
            page.setData({ needLogin: false, isAdmin: isAdmin })
            return page.load(silent)
          })
          .catch(function () {
            page.setData({ needLogin: false, isAdmin: false })
            return page.load(silent)
          })
      })
      .catch(function () {
        page.setData({ needLogin: true, loading: false, list: [] })
      })
  },

  // 拉一页原始订单。offset 由调用方决定（首次 0，上拉用当前已加载条数）
  fetchPage: function (offset) {
    return api.listMyOrders(this.data.mode, PAGE_SIZE, offset, this.data.status,
      this.data.searching ? this.data.keyword : '')
  },

  mapRows: function (rows) {
    const page = this
    return (rows || [])
      .map(function (item) {
        const route = []
        if (item.pickup_addr) route.push(item.pickup_addr)
        if (item.deliver_addr) route.push(item.deliver_addr)
        return {
          id: item.id,
          title: item.title,
          serviceName: item.service_name,
          reward: item.reward,
          status: item.status,
          statusText: services.STATUS_TEXT[item.status] || item.status,
          createdText: api.formatTime(item.created_at),
          routeText: route.length ? route.join(' → ') : '地点待沟通',
          ownerName: item.owner_name || '',
          runnerName: item.runner_name || '',
          canDelete: canDelete(item),
        }
      })
  },

  load: function (silent) {
    const page = this
    const request = page._request = (page._request || 0) + 1
    const sessionKey = page._sessionKey || ''
    const filter = [sessionKey, page.data.mode, page.data.status, page.data.searching ? page.data.keyword : ''].join('|')
    const keep = !!(silent && page._loadedFilter === filter)
    const target = keep ? Math.max(page._offset || PAGE_SIZE, PAGE_SIZE) : PAGE_SIZE
    page.setData({ loading: !keep, loadingMore: false, errorText: '' })
    const rows = []
    function fetchNext() {
      return page.fetchPage(rows.length).then(function (batch) {
        if (request !== page._request) return null
        batch = batch || []
        Array.prototype.push.apply(rows, batch)
        if (batch.length === PAGE_SIZE && rows.length < target) return fetchNext()
        page._offset = rows.length
        page._loadedFilter = filter
        page.setData({ list: motion.stagger(page.mapRows(rows)), loading: false,
          hasMore: batch.length === PAGE_SIZE })
        return null
      })
    }
    return fetchNext().catch(function (error) {
      if (request !== page._request) return
      page.setData({ loading: false, errorText: api.getErrorMessage(error) })
      guard.toastError(error)
    })
  },

  loadMore: function () {
    const page = this
    if (page.data.loading || page.data.loadingMore || !page.data.hasMore) return Promise.resolve()
    const request = page._request
    const offset = page._offset || 0
    page.setData({ loadingMore: true })
    return page.fetchPage(offset).then(function (rows) {
      if (request !== page._request) return
      rows = rows || []
      page._offset = offset + rows.length
      const ids = {}
      const list = page.data.list.concat(motion.stagger(page.mapRows(rows))).filter(function (row) {
        if (ids[row.id]) return false
        ids[row.id] = true
        return true
      })
      page.setData({ list: list, loadingMore: false, hasMore: rows.length === PAGE_SIZE })
    }).catch(function (error) {
      if (request !== page._request) return
      page.setData({ loadingMore: false })
      guard.toastError(error)
    })
  },

  // ---- 订单搜索（灰度 order_search）----
  onKeywordInput: function (event) {
    const value = (event.detail && event.detail.value) || ''
    // 清空输入就退出搜索态，回到正常列表
    if (!value.trim()) {
      this.setData({ keyword: value, searching: false })
      return this.load()
    }
    this.setData({ keyword: value })
    return null
  },

  doSearch: function () {
    this.setData({ searching: !!String(this.data.keyword || '').trim() })
    return this.load()
  },

  clearSearch: function () {
    const page = this
    page.setData({ keyword: '', searching: false })
    return page.load()
  },

  switchMode: function (event) {
    const page = this
    motion.haptic('select')
    // 切换模式会换数据源，搜索结果不再适用，一起清掉
    this.setData({ mode: event.currentTarget.dataset.key, keyword: '', searching: false }, function () {
      page.load()
    })
  },

  switchStatus: function (event) {
    const page = this
    motion.haptic('select')
    this.setData({ status: event.currentTarget.dataset.key }, function () {
      page.load()
    })
  },

  openDetail: function (event) {
    motion.haptic('light')
    wx.navigateTo({
      url: '/pages/order/detail?id=' + event.currentTarget.dataset.id,
    })
  },

  // ---- 删除历史订单 ----
  // 数据不真删，只记一条「某人隐藏了某单」：
  //   1) 订单是双方共有的，不能因为一方删了让另一方也看不到；
  //   2) 结算、举报核查、审计都还要用这条记录。
  // 删除条件（服务端同样判定）：订单已完结且满 7 天，或被管理员判定违规下架（不受 7 天限制）。

  askHide: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id)
    if (page.data.hideArmId === id) {
      if (page._hideTimer) {
        clearTimeout(page._hideTimer)
        page._hideTimer = null
      }
      page.setData({ hideArmId: 0 })
      page.doHide(id)
      return
    }
    if (page._hideTimer) clearTimeout(page._hideTimer)
    page.setData({ hideArmId: id })
    page._hideTimer = setTimeout(function () {
      page._hideTimer = null
      if (page.data.hideArmId === id) page.setData({ hideArmId: 0 })
    }, 4000)
  },

  cancelHide: function () {
    if (this._hideTimer) {
      clearTimeout(this._hideTimer)
      this._hideTimer = null
    }
    this.setData({ hideArmId: 0 })
  },

  doHide: function (id) {
    const page = this
    ui.loading({ title: '删除中', mask: true })
    api
      .hideMyOrder(id)
      .then(function () {
        ui.hideLoading()
        ui.toast({ title: '已删除，双方列表都不再显示', icon: 'success' })
        page.setData({ hideArmId: 0 })
        return Promise.all([page.load(), page.data.showHidden ? page.loadHidden() : Promise.resolve()])
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ errorText: message, hideArmId: 0 })
        if (typeof console !== 'undefined' && console.error) console.error('[orders/list] hide failed:', message, error)
        ui.toast({ title: message, icon: 'none', duration: 2500 })
      })
  },

  toggleHidden: function () {
    const page = this
    const next = !page.data.showHidden
    page.setData({ showHidden: next, hideArmId: 0 })
    if (next) return page.loadHidden()
    page.setData({ hiddenList: [] })
    return Promise.resolve()
  },

  loadHidden: function () {
    const page = this
    page.setData({ hiddenLoading: true })
    return api
      .listMyHiddenOrders()
      .then(function (rows) {
        const hiddenList = rows.map(function (item) {
          return {
            id: item.id,
            title: item.title,
            serviceName: item.service_name,
            reward: item.reward,
            status: item.status,
            statusText: services.STATUS_TEXT[item.status] || item.status,
            createdText: api.formatTime(item.created_at),
          }
        })
        page.setData({ hiddenList: hiddenList, hiddenLoading: false })
      })
      .catch(function (error) {
        page.setData({ hiddenLoading: false, hiddenList: [] })
        guard.toastError(error)
      })
  },

  restoreOrder: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id)
    ui.loading({ title: '恢复中', mask: true })
    api
      .restoreMyOrder(id)
      .then(function () {
        ui.hideLoading()
        ui.toast({ title: '已恢复', icon: 'success' })
        return Promise.all([page.load(), page.loadHidden()])
      })
      .catch(function (error) {
        ui.hideLoading()
        guard.toastError(error)
      })
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },
})
