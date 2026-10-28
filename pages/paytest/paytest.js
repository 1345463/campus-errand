/**
 * 支付联调测试页（临时）
 *
 * 调用统一走 utils/tcb.js：
 *   ① wx.cloud.callFunction('tcb-proxy')  —— 免域名，正式版可用
 *   ② 直连网关 HTTPS                       —— 预览模式可用
 * 日志会打印实际走的是哪条通道（_via）。
 *
 * 验证通过后可删：本目录 + app.json 里对应那行 + pages/mine/index 里的临时入口。
 */
const tcb = require('../../utils/tcb')

const ORDER_ID = 1
const AMOUNT = 0.01

Page({
  data: {
    orderId: ORDER_ID,
    amount: AMOUNT,
    paying: false,
    log: [],
  },

  onLoad: function () {
    const that = this
    that.pushLog('测试订单 #' + ORDER_ID + '，金额 ¥' + AMOUNT)
    that.pushLog('通道 ① wx.cloud → tcb-proxy（免域名）')
    that.pushLog('通道 ② 直连网关（预览模式）')
    that.pushLog('注意：点按钮会真实扣款 0.01 元')
  },

  pushLog: function (text) {
    const d = new Date()
    const t =
      ('0' + d.getHours()).slice(-2) + ':' +
      ('0' + d.getMinutes()).slice(-2) + ':' +
      ('0' + d.getSeconds()).slice(-2)
    this.setData({ log: this.data.log.concat(t + '  ' + text) })
    console.log('[paytest]', text)
  },

  pay: function () {
    const that = this
    if (that.data.paying) return
    that.setData({ paying: true })
    that.pushLog('wx.login 获取 code …')

    wx.login({
      success: function (loginRes) {
        if (!loginRes.code) {
          that.pushLog('wx.login 没返回 code')
          that.setData({ paying: false })
          return
        }
        that.pushLog('拿到 code：' + String(loginRes.code).slice(0, 8) + '…')
        that.pushLog('调用 pay-create …')

        tcb
          .call('pay-create', { code: loginRes.code, orderId: ORDER_ID, amount: AMOUNT })
          .then(function (body) {
            that.pushLog('下单成功（通道：' + (body._via || '未知') + '）')
            that.requestPay(body.payParams || {})
          })
          .catch(function (err) {
            that.pushLog('下单失败：' + (err.message || ''))
            that.setData({ paying: false })
          })
      },
      fail: function (e) {
        that.pushLog('wx.login 失败：' + (e.errMsg || ''))
        that.setData({ paying: false })
      },
    })
  },

  requestPay: function (p) {
    const that = this
    if (!p.package || !p.paySign) {
      that.pushLog('下单结果里没有 payParams，无法拉起收银台')
      that.setData({ paying: false })
      return
    }
    that.pushLog('拉起收银台 …')
    wx.requestPayment({
      timeStamp: p.timeStamp,
      nonceStr: p.nonceStr,
      package: p.package,
      signType: p.signType,
      paySign: p.paySign,
      success: function () {
        that.pushLog('前端收到支付成功')
        that.pushLog('等微信回调写入库，约 1-3 秒')
      },
      fail: function (err) {
        that.pushLog('支付失败或取消：' + JSON.stringify(err))
      },
      complete: function () {
        that.setData({ paying: false })
      },
    })
  },
})
