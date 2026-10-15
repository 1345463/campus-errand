const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const flags = require('../../utils/flags')

const PAGE_SIZE = 20
// 二次点击确认的自动解除时间，和 orders/list 的 askHide 保持一致
const ARM_TIMEOUT = 4000

// 消息类型 → 图标 + 兜底标题。
// 后端用触发器在订单/租赁/认证/举报的关键节点写消息，kind 就是这些取值；
// 认不出来的 kind 统一回落到 system，避免以后新增类型时列表里出现空白行。
const KIND_META = {
  order_accepted: { icon: '🙋', label: '订单被接单' },
  order_done: { icon: '📦', label: '接单员已送达' },
  order_confirmed: { icon: '✅', label: '订单已完成' },
  order_canceled: { icon: '🚫', label: '订单被取消' },
  rental_quoted: { icon: '💰', label: '租赁已报价' },
  rental_ordered: { icon: '🧾', label: '租赁工单已生成' },
  cert_reviewed: { icon: '🪪', label: '实名认证已审核' },
  report_handled: { icon: '🛡️', label: '举报已处理' },
  system: { icon: '🔔', label: '系统通知' },
}

function metaOf(kind) {
  return KIND_META[kind] || KIND_META.system
}

// 置已读时重新造一个对象：直接改 page.data.list 里的元素再 setData，
// 数组引用没变、元素引用也没变，视图不一定刷新。
function asRead(item) {
  return {
    id: item.id,
    kind: item.kind,
    icon: item.icon,
    kindText: item.kindText,
    title: item.title,
    content: item.content,
    timeText: item.timeText,
    unread: false,
    refType: item.refType,
    refId: item.refId,
  }
}

Page({
  data: {
    grayOff: false,
    needLogin: false,
    loading: false,
    list: [],
    offset: 0,
    hasMore: true,
    unread: 0,
    errorText: '',
    markAllArmed: false,
  },

  onLoad: function () {
    this.checkAndLoad()
  },

  // 二次确认的定时器挂在页面实例上，页面销毁时必须清掉，否则回调会打到已卸载的页面上
  onUnload: function () {
    this.clearArmTimer()
  },

  onPullDownRefresh: function () {
    const page = this
    page
      .reload()
      .then(
        function () {
          wx.stopPullDownRefresh()
        },
        function () {
          wx.stopPullDownRefresh()
        }
      )
  },

  onReachBottom: function () {
    this.loadMore()
  },

  checkAndLoad: function () {
    const page = this
    page.setData({ loading: true, errorText: '' })
    return flags
      .ensure()
      .then(function () {
        // 灰度没开就到此为止：不拉数据、不暴露任何内容
        if (!flags.on('message_center')) {
          page.setData({ grayOff: true, loading: false, list: [] })
          return null
        }
        return api.getSession().then(function (session) {
          if (!session) {
            page.setData({ grayOff: false, needLogin: true, loading: false, list: [] })
            return null
          }
          page.setData({ grayOff: false, needLogin: false })
          return page.reload()
        })
      })
      .catch(function (error) {
        page.setData({ loading: false })
        guard.toastError(error)
      })
  },

  reload: function () {
    const page = this
    page.setData({ offset: 0, hasMore: true, errorText: '' })
    return page.fetch(true).then(function () {
      return page.refreshUnread()
    })
  },

  loadMore: function () {
    const page = this
    // 未登录 / 灰度未开 / 正在加载 / 已经到底：都不再发请求
    if (page.data.needLogin || page.data.grayOff) return Promise.resolve()
    if (page.data.loading || !page.data.hasMore) return Promise.resolve()
    return page.fetch(false)
  },

  fetch: function (reset) {
    const page = this
    page.setData({ loading: true })
    return api
      .listMyMessages(PAGE_SIZE, page.data.offset)
      .then(function (rows) {
        const list = rows.map(function (item) {
          const meta = metaOf(item.kind)
          return {
            id: item.id,
            kind: item.kind,
            icon: meta.icon,
            kindText: meta.label,
            title: item.title || meta.label,
            content: item.content || '',
            timeText: api.formatTime(item.created_at),
            unread: !item.read_at,
            refType: item.ref_type || '',
            // ref_id 有可能是大整数，统一转成字符串再拼跳转链接，精度不会丢
            refId: item.ref_id ? String(item.ref_id) : '',
          }
        })
        const offset = page.data.offset + rows.length
        page.setData({
          list: reset ? list : page.data.list.concat(list),
          offset: offset,
          // 取回来不满一页说明后面没有了，否则触底会一直空转发请求
          hasMore: rows.length >= PAGE_SIZE,
          loading: false,
        })
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ loading: false, errorText: message })
        guard.toastError(error)
      })
  },

  refreshUnread: function () {
    const page = this
    return api
      .unreadMessageCount()
      .then(function (count) {
        page.setData({ unread: count })
      })
      .catch(function () {
        // 未读数只是个角标，拿不到就保留上一次的值，不打断列表显示
      })
  },

  // 全部标为已读是不可逆的批量操作，走页内二次点击确认，不用 wx.showModal
  //（预览环境里 showModal 可能永不回调，点了会没反应）
  askMarkAll: function () {
    const page = this
    if (page.data.unread <= 0) {
      ui.toast({ title: '没有未读消息', icon: 'none' })
      return
    }
    if (page.data.markAllArmed) {
      page.clearArmTimer()
      page.setData({ markAllArmed: false })
      page.doMarkAll()
      return
    }
    page.setData({ markAllArmed: true })
    page._armTimer = setTimeout(function () {
      page._armTimer = null
      if (page.data.markAllArmed) page.setData({ markAllArmed: false })
    }, ARM_TIMEOUT)
  },

  cancelMarkAll: function () {
    this.clearArmTimer()
    this.setData({ markAllArmed: false })
  },

  clearArmTimer: function () {
    if (this._armTimer) {
      clearTimeout(this._armTimer)
      this._armTimer = null
    }
  },

  doMarkAll: function () {
    const page = this
    ui.loading({ title: '处理中', mask: true })
    api
      .markAllMessagesRead()
      .then(function () {
        ui.hideLoading()
        // 本地整体置为已读，省一次重新拉取
        const list = page.data.list.map(function (item) {
          return asRead(item)
        })
        page.setData({ list: list, unread: 0 })
        ui.toast({ title: '已全部标为已读', icon: 'success' })
      })
      .catch(function (error) {
        ui.hideLoading()
        guard.toastError(error)
      })
  },

  openMessage: function (event) {
    const page = this
    const id = event.currentTarget.dataset.id
    const index = Number(event.currentTarget.dataset.index)
    const item = page.data.list[index]
    if (!item) return

    if (item.unread) {
      // 先本地置为已读，点下去立刻有反馈；接口失败再提示，不把状态回滚（不影响服务端判定）
      page.setRead(index)
      api
        .markMessageRead(id)
        .then(function () {
          const unread = page.data.unread > 0 ? page.data.unread - 1 : 0
          page.setData({ unread: unread })
        })
        .catch(function (error) {
          guard.toastError(error)
        })
    }

    // 只有带 ref_id 的订单类消息才有详情页可跳；
    // 认证、举报、租赁类消息目前没有对应页面，点了就停在列表
    if (item.refType === 'order' && item.refId) {
      wx.navigateTo({ url: '/pages/order/detail?id=' + item.refId })
    }
  },

  setRead: function (index) {
    const page = this
    const list = page.data.list.map(function (item, i) {
      return i === index ? asRead(item) : item
    })
    page.setData({ list: list })
  },

  retry: function () {
    return this.reload()
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },
})
