/**
 * 在线支付：发单时先把赏金付到平台，订单完成后再结算给接单员。
 *
 * 链路：wx.login(code) → pay-create（微信 JSAPI 下单）→ wx.requestPayment →
 *      微信回调 pay-notify → mark_order_paid 落库 → 前端轮询确认
 *
 * 两个容易踩的点：
 *   1) 不能只信 wx.requestPayment 的 success。它只说明「微信那边扣款成功」，
 *      库里的 pay_status 要等回调（通常 1-3 秒，极端情况更久）才变。
 *      所以付完必须轮询 order_pay_state，而不是直接当成功。
 *   2) 金额一律由服务端订单算（reward - discount_amount），客户端只做展示和传参。
 *      pay-create 用 code 换 openid，不接受调用方指定付款人。
 *
 * 总闸 pay_settings.enabled 关着时 create_order 会直接给订单打上 paid，
 * 这里根本不会被调到 —— 客户端不需要单独判断开关。
 */
const tcb = require('./tcb')

// 回调写入有延迟：先等一拍再开始问，最多问 8 次（约 7 秒）
const POLL_TIMES = 8
const POLL_INTERVAL = 800

function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms)
  })
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

// 应付金额：赏金减去抵扣券，抵满就是 0（那种情况服务端已经标成已付）
function payableOf(order) {
  const reward = Number((order && order.reward) || 0)
  const discount = Number((order && order.discount_amount) || 0)
  return Math.max(round2(reward - discount), 0)
}

function loginCode() {
  return new Promise(function (resolve, reject) {
    wx.login({
      success: function (res) {
        if (res && res.code) resolve(res.code)
        else reject(new Error('微信登录失败，请重试'))
      },
      fail: function (e) {
        reject(new Error((e && e.errMsg) || '微信登录失败，请重试'))
      },
    })
  })
}

function orderPayState(orderId) {
  return tcb.rpc('order_pay_state', { p_order_id: Number(orderId) }).then(function (res) {
    if (res.error) return null
    const rows = Array.isArray(res.data) ? res.data : []
    return rows[0] || null
  })
}

function requestPayment(params) {
  return new Promise(function (resolve, reject) {
    wx.requestPayment({
      timeStamp: params.timeStamp,
      nonceStr: params.nonceStr,
      package: params.package,
      signType: params.signType,
      paySign: params.paySign,
      success: function () {
        resolve()
      },
      fail: function (e) {
        const msg = String((e && e.errMsg) || '')
        const error = new Error(/cancel/i.test(msg) ? '支付已取消' : '支付未完成')
        error.cancel = /cancel/i.test(msg)
        reject(error)
      },
    })
  })
}

// 轮询到 paid 为止。查不到状态（网络抖动）不算失败，继续问。
function waitPaid(orderId) {
  let times = 0
  function again() {
    return orderPayState(orderId).then(function (row) {
      if (row && row.pay_status === 'paid') return true
      times += 1
      if (times >= POLL_TIMES) return false
      return wait(POLL_INTERVAL).then(again)
    })
  }
  return wait(POLL_INTERVAL).then(again)
}

/**
 * 为一笔订单付款。
 * 返回 { paid, amount, cancelled }：
 *   paid=true  库里已经是 paid
 *   paid=false 付了但回调还没到（钱大概率已扣），调用方应提示「确认中」而不是「失败」
 *   cancelled  用户自己取消了
 */
function payOrder(order) {
  const orderId = Number((order && order.id) || 0)
  const amount = payableOf(order)
  if (!orderId) return Promise.reject(new Error('订单不存在，无法支付'))
  if (amount <= 0) return Promise.resolve({ paid: true, amount: 0, skipped: true })

  return loginCode()
    .then(function (code) {
      return tcb.call('pay-create', { code: code, orderId: orderId, amount: amount })
    })
    .then(function (body) {
      const params = (body && body.payParams) || {}
      if (!params.package || !params.paySign) throw new Error('支付下单失败，请重试')
      return requestPayment(params)
    })
    .then(function () {
      return waitPaid(orderId).then(function (paid) {
        return { paid: paid, amount: amount }
      })
    })
    .catch(function (error) {
      error.cancelled = !!(error && error.cancel)
      throw error
    })
}

module.exports = {
  payOrder: payOrder,
  payableOf: payableOf,
  orderPayState: orderPayState,
}
