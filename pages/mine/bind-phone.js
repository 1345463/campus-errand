const ui = require('../../utils/ui')
const api = require('../../utils/api')

// 绑定手机号。产品规则：浏览大厅不拦，发单 / 接单 / 查看联系方式前必须先绑。
//
// 流程上有个弯：验证码必须由 auth provider 校验，所以 verifyOtp 会**把会话换成
// 手机号身份**。验完必须立刻 wx.login 切回微信身份，再调 bind_my_phone 写绑定。
// 中途任何一步失败都要明确告诉用户「没绑上」，不能吞。
function randomPassword() {
  // 新建手机号身份时需要一个密码占位。用户拿不到它，也不该拿它登录：
  // 本项目不使用「手机号+密码」作为登录方式（见 R44 论证）。
  return 'Bp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12) + 'Aa9'
}

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
        const value = String(state.phone || '')
        page.setData({
          bound: !!state.bound,
          boundPhone: value
            ? value.slice(0, 3) + '****' + value.slice(7)
            : '',
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
      .then(function (challenge) {
        ui.hideLoading()
        page.pendingChallenge = {
          phone: phone,
          verificationId: challenge.verificationId,
          isExistingUser: !!challenge.isExistingUser,
        }
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
    if (!page.pendingChallenge || page.pendingChallenge.phone !== phone) {
      page.setData({ formError: '请先获取验证码' })
      return
    }
    if (!/^\d{4,6}$/.test(code)) {
      page.setData({ formError: '请输入收到的验证码' })
      return
    }

    page.setData({ submitting: true, formError: '' })
    ui.loading({ title: '绑定中', mask: true })

    api
      .verifyPhoneOnly({
        phone: phone,
        verificationId: page.pendingChallenge.verificationId,
        isExistingUser: page.pendingChallenge.isExistingUser,
        token: code,
        password: randomPassword(),
      })
      .then(function () {
        // 此刻会话已经变成手机号身份，必须切回微信身份才能写到自己账号上
        page._switched = true
        return api.login()
      })
      .then(function (result) {
        if (!result || !result.session) {
          throw new Error('切回微信登录失败，请重新进入小程序后再试')
        }
        return api.bindMyPhone(phone)
      })
      .then(function () {
        ui.hideLoading()
        page.setData({ submitting: false, bound: true, code: '' })
        page.pendingChallenge = null
        page.stopCountdown()
        page.setData({
          boundPhone: phone.slice(0, 3) + '****' + phone.slice(7),
          countdown: 0,
        })
        page.load()
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
        ui.toast({ title: message, icon: 'none' })
        // 如果已经切到手机号身份又失败了，必须切回微信身份：
        // 否则下次启动会变成一个没有资料的陌生账号
        if (page._switched) {
          page._switched = false
          page.recoverIdentity()
        }
      })
  },

  recoverIdentity: function () {
    return api
      .login()
      .catch(function () {
        return api.logout().catch(function () {})
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
