const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const flags = require('../../utils/flags')

// 二次点击确认的自动解除时间，和订单页保持一致
const ARM_TTL = 4000

Page({
  data: {
    loading: true,
    grayOff: false,
    needLogin: false,
    points: 0,
    goods: [],
    redemptions: [],
    armId: '',
    tipText: '',
    exchanging: false,
    // 刚兑换成功的兑换码，单独放大展示一会儿
    justCode: '',
    justName: '',
  },

  onLoad: function () {
    this.load()
  },

  onShow: function () {
    // 从积分明细页返回时点数可能有变，重新拉一次
    if (this._loadedOnce) this.load()
  },

  onPullDownRefresh: function () {
    this.load().then(function () {
      wx.stopPullDownRefresh()
    })
  },

  onUnload: function () {
    if (this.armTimer) clearTimeout(this.armTimer)
  },

  load: function () {
    const page = this
    page.setData({ loading: true, tipText: '' })
    return flags
      .ensure()
      .then(function () {
        // 灰度未开：整页隐藏，避免用户看到不能用的功能
        if (!flags.on('point_mall')) {
          page.setData({ grayOff: true, loading: false })
          return null
        }
        return api.getSession().then(function (session) {
          if (!session) {
            page.setData({ needLogin: true, loading: false })
            return null
          }
          return Promise.all([
            api.getProfile().catch(function () {
              return null
            }),
            api.listPointGoods().catch(function () {
              return []
            }),
            // 券包而不是兑换流水：兑换码是「用得出去」的东西，
            // 退出页面再进来还得能翻出来，所以这里按「未用的排前面」列出全部
            api.listMyCoupons().catch(function () {
              return []
            }),
          ]).then(function (result) {
            const points = (result[0] && result[0].points) || 0
            const rows = result[1] || []
            const redemptions = result[2] || []
            page._loadedOnce = true
            page.setData({
              needLogin: false,
              loading: false,
              points: points,
              goods: rows.map(function (item) {
                const cost = Number(item.cost) || 0
                const stock = Number(item.stock) || 0
                return {
                  id: item.id,
                  name: item.name,
                  emoji: item.emoji || '🎁',
                  cost: cost,
                  stock: stock,
                  desc: item.descr || '',
                  kind: item.kind || 'coupon',
                  // 库存为 0 或积分不够都置灰，减少无效点击
                  disabled: stock <= 0 || points < cost,
                  stockText: stock <= 0 ? '已兑完' : '剩 ' + stock + ' 份',
                }
              }),
              redemptions: redemptions.map(function (row) {
                const used = row.status === 'used'
                const type = row.benefit_type || 'verify'
                return {
                  id: row.id,
                  name: row.goods_name,
                  code: row.code,
                  cost: row.cost,
                  timeText: api.formatTime(row.created_at),
                  statusText: used ? '已使用' : '待使用',
                  used: used,
                  // 「怎么用」直接写在行里，别让人对着一串码猜
                  hintText: used ? '已用掉' : row.expired_hint || '到核销处出示兑换码',
                  // 只有抵扣券 / 优先券能跳去下单页用，礼券只能现场核销
                  usable: !used && (type === 'deduct' || type === 'boost'),
                  benefitType: type,
                }
              }),
            })
            return null
          })
        })
      })
      .catch(function (error) {
        page.setData({ loading: false })
        guard.toastError(error)
      })
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },

  // 第一次点击「兑换」只是进入待确认状态，再点一次才真正执行，避免误触
  askExchange: function (event) {
    const page = this
    const id = event.currentTarget.dataset.id
    let target = null
    for (let i = 0; i < page.data.goods.length; i += 1) {
      if (page.data.goods[i].id === id) target = page.data.goods[i]
    }
    if (!target) return
    if (target.stock <= 0) {
      ui.toast({ title: '这个已经兑完了', icon: 'none' })
      return
    }
    if (page.data.points < target.cost) {
      ui.toast({ title: '积分不够，还差 ' + (target.cost - page.data.points) + ' 分', icon: 'none' })
      return
    }
    if (page.data.armId === id) {
      page.doExchange(target)
      return
    }
    page.setData({ armId: id, tipText: '再点一次确认兑换「' + target.name + '」，将扣除 ' + target.cost + ' 积分' })
    if (page.armTimer) clearTimeout(page.armTimer)
    page.armTimer = setTimeout(function () {
      page.setData({ armId: '', tipText: '' })
    }, ARM_TTL)
  },

  cancelExchange: function () {
    const page = this
    if (page.armTimer) clearTimeout(page.armTimer)
    page.setData({ armId: '', tipText: '' })
  },

  doExchange: function (item) {
    const page = this
    if (page.exchanging) return
    if (page.armTimer) clearTimeout(page.armTimer)
    page.setData({ armId: '', tipText: '', exchanging: true })
    ui.loading({ title: '兑换中', mask: true })

    api
      .exchangePointGoods(item.id)
      .then(function (row) {
        ui.hideLoading()
        const code = (row && row.code) || ''
        page.setData({
          exchanging: false,
          justCode: code,
          justName: (row && row.goods_name) || item.name,
          tipText: '兑换成功，凭下方兑换码使用',
        })
        ui.toast({ title: '兑换成功', icon: 'success' })
        return page.load().then(function () {
          // load() 会把 tipText 清掉，兑换结果要留在页面上
          page.setData({
            justCode: code,
            justName: (row && row.goods_name) || item.name,
            tipText: '兑换成功，凭下方兑换码使用',
          })
          return null
        })
      })
      .catch(function (error) {
        ui.hideLoading()
        page.setData({ exchanging: false })
        guard.toastError(error)
        // 积分不足 / 已兑完这类失败可能来自别人同时兑换，刷新一次拿最新库存
        page.load()
      })
  },

  copyCode: function (event) {
    const code = event.currentTarget.dataset.code
    if (!code) return
    if (typeof wx !== 'undefined' && typeof wx.setClipboardData === 'function') {
      wx.setClipboardData({
        data: String(code),
        success: function () {
          ui.toast({ title: '兑换码已复制', icon: 'none' })
        },
        fail: function () {
          ui.toast({ title: '兑换码：' + code, icon: 'none', duration: 3000 })
        },
      })
      return
    }
    ui.toast({ title: '兑换码：' + code, icon: 'none', duration: 3000 })
  },

  clearJustCode: function () {
    this.setData({ justCode: '', justName: '' })
  },

  goPoints: function () {
    wx.navigateTo({ url: '/pages/mine/points' })
  },

  // 抵扣券 / 优先券 → 直接跳下单页用掉；礼券只能现场核销，这里提示到地儿
  useCoupon: function (event) {
    const code = event.currentTarget.dataset.code
    if (!code) return
    wx.navigateTo({ url: '/pages/order/create?code=' + encodeURIComponent(code) })
  },
})
