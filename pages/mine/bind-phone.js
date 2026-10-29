const ui = require('../../utils/ui')
const api = require('../../utils/api')

// 绑定手机号。产品规则：浏览大厅不拦，发单 / 接单 / 查看联系方式前必须先绑。
//
// 新后端的流程比旧版短得多：
//   发码 → 服务端生成 6 位码、库里只存哈希、明文只回到云函数去发短信
//   绑定 → 客户端把「手机号 + 收到的验证码」一起交上去，服务端一次做完验码 + 写入
//
// 旧版要「借道」到手机号身份让 auth provider 验码，验完再切回微信身份，
// 中间一断用户就落在陌生账号上（R44 修的「绑完跳号」就是这么来的）。
// 现在整条链路都在同一个 wx: 身份里完成，没有身份可跳，也就不需要
// identitySwitchPending 那套标记和兜底重登了。

Page({
  data: {
    phone: '',
    code: '',
    countdown: 0,
    sending: false,
    submitting: false,
    formError: '',
    bound: false,
    boundPhone: '',
    fromGate: false,
  },

  onLoad: function (options) {
    this.setData({ fromGate: !!(options && options.from === 'gate') })
  },

  onShow: function () {
    this.load()
  },

  onUnload: function () {
    this.stopCountdown()
  },

  load: function () {
    const page = this
    api
      .getMyPhoneState()
      .then(function (state) {
        const value = String((state && state.phone) || '')
        page.setData({
          bound: !!(state && state.bound),
          boundPhone: value ? value.slice(0, 3) + '****' + value.slice(7) : '',
        })
      })
      .catch(function (error) {
        // 未登录时静默：本页也可能被分享链接直接打开
        console.warn('[bind-phone] state failed', api.getErrorMessage(error))
      })
  },

  onPhone: function (event) {
    this.setData({ phone: event.detail.value, formError: '' })
  },

  onCode: function (event) {
    this.setData({ code: event.detail.value, formError: '' })
  },

  stopCountdown: function () {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer)
      this.countdownTimer = null
    }
  },

  startCountdown: function () {
    const page = this
    page.stopCountdown()
    page.setData({ countdown: 60 })
    page.countdownTimer = setInterval(function () {
      const left = page.data.countdown - 1
      if (left <= 0) {
        page.stopCountdown()
        page.setData({ countdown: 0 })
        return
      }
      page.setData({ countdown: left })
    }, 1000)
  },

  sendCode: function () {
    const page = this
    const phone = String(page.data.phone || '').trim()
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      page.setData({ formError: '请输入正确的 11 位手机号' })
      return
    }
    if (page.data.countdown > 0 || page.data.sending) return
    page.setData({ sending: true, formError: '' })
    ui.loading({ title: '发送中', mask: true })
    api
      .sendPhoneCode(phone)
      .then(function () {
        ui.hideLoading()
        // 记住发过码的号码：换号就必须重新发，不能用 A 的码绑 B 的号
        page.sentPhone = phone
        page.setData({ sending: false })
        page.startCountdown()
        ui.toast({ title: '验证码已发送', icon: 'none' })
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ sending: false, formError: message })
        ui.toast({ title: message, icon: 'none' })
      })
  },

  submit: function () {
    const page = this
    if (page.data.submitting) return
    const phone = String(page.data.phone || '').trim()
    const code = String(page.data.code || '').trim()
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      page.setData({ formError: '请输入正确的 11 位手机号' })
      return
    }
    if (page.sentPhone !== phone) {
      page.setData({ formError: '请先获取验证码' })
      return
    }
    if (!/^\d{6}$/.test(code)) {
      page.setData({ formError: '请输入 6 位验证码' })
      return
    }

    page.setData({ submitting: true, formError: '' })
    ui.loading({ title: '绑定中', mask: true })

    api
      .bindMyPhone(phone, code)
      .then(function () {
        ui.hideLoading()
        page.setData({ submitting: false, bound: true, code: '' })
        page.sentPhone = ''
        page.stopCountdown()
        page.setData({
          boundPhone: phone.slice(0, 3) + '****' + phone.slice(7),
          countdown: 0,
        })
        ui.toast({ title: '绑定成功', icon: 'success' })
        setTimeout(function () {
          const pages = getCurrentPages()
          if (pages.length > 1) {
            wx.navigateBack()
          } else {
            wx.switchTab({ url: '/pages/mine/index' })
          }
        }, 700)
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ submitting: false, formError: message })
        ui.toast({ title: message, icon: 'none', duration: 2600 })
      })
  },

  goBack: function () {
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }
    wx.switchTab({ url: '/pages/mine/index' })
  },
})
