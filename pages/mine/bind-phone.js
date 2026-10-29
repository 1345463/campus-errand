const ui = require('../../utils/ui')
const api = require('../../utils/api')

// 绑定手机号。产品规则：浏览大厅不拦，发单 / 接单 / 查看联系方式前必须先绑。
//
// 流程上有个弯：验证码必须由 auth provider 校验，所以 verifyOtp 会**把会话换成
// 手机号身份**（手机号没注册过就顺手注册一个，密码是随机的，用户拿不到也不用）。
// 验完必须立刻 wx.login 切回微信身份，再调 bind_my_phone 写绑定。
//
// ⚠️ 切回来这一步原来是「只管调，不校验」：api.login() 一旦失败或返回了别的身份，
// 后面的 bindMyPhone 会用当前会话的 uid 去写库 —— 手机号就被绑到一个陌生账号上，
// 用户看到的就是「绑完跳到了另一个账号」。现在改成先记下原 uid，切回后逐个比对，
// 对不上就退出重登，仍然对不上就中止，绝不往库里写。
// 另外在切身份前写一个标记，真没切回来时 app.js 下次启动会强制兜一次。
const IDENTITY_PENDING_KEY = 'identitySwitchPendingV1'

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
    // 老账号自带的手机号自动绑定失败时的原因（一般是该号已被别的账号占用）
    authPhoneError: '',
    // 老账号（非微信身份）换号时，需要它的登录密码才能切回来
    needPassword: false,
    accountPassword: '',
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
      .getSession()
      .then(function (session) {
        page._uid = (session && session.user && session.user.id) || ''
        return api.myAuthPhone()
      })
      .then(function (phone) {
        page._authPhone = phone || ''
        // 老账号（不是微信身份）切走之后只能靠「手机号 + 密码」切回来，
        // 所以换号时必须先拿到密码。微信身份不需要这一栏。
        const isWechat = String(page._uid || '').indexOf('wx:') === 0
        page.setData({ needPassword: !isWechat && !!page._authPhone })
        return api.getMyPhoneState()
      })
      .then(function (state) {
        const value = String(state.phone || '')
        page.setData({
          bound: !!state.bound,
          boundPhone: value
            ? value.slice(0, 3) + '****' + value.slice(7)
            : '',
        })
        if (state && state.bound) return false
        // 还没绑 → 试着用账号自带的手机号直接补上（老账号专用，见 tryAuthPhone）
        return page.tryAuthPhone()
      })
      .catch(function (error) {
        // 未登录时静默：本页也可能被分享链接直接打开
        console.warn('[bind-phone] state failed', api.getErrorMessage(error))
      })
  },

  // 老账号（手机号注册、uid 是数字）在绑定页里其实无路可走：
  // 它会发短信 → verifyOtp 把会话换成手机号身份 → 而老账号没有微信身份可切回，
  // 强行切就等于把用户踢到另一个账号上。但这类账号注册时已经用短信验证过号码了，
  // 登录服务里就存着这个号 —— 直接把它写进 profile_phones 即可，不用再验一次。
  // 微信身份读不到 auth phone，这里会直接返回，走正常的短信流程。
  tryAuthPhone: function () {
    const page = this
    if (page._authPhoneTried) return Promise.resolve(false)
    page._authPhoneTried = true
    return api
      .myAuthPhone()
      .then(function (phone) {
        if (!phone) return false
        return api
          .bindMyPhone(phone)
          .then(function () {
            page.setData({
              bound: true,
              boundPhone: phone.slice(0, 3) + '****' + phone.slice(7),
              authPhoneError: '',
            })
            ui.toast({ title: '已绑定账号注册手机号', icon: 'success' })
            return true
          })
          .catch(function (error) {
            // 最常见是这个号已经被别的账号绑走了，把服务端原因显示出来
            page.setData({ authPhoneError: api.getErrorMessage(error) })
            return false
          })
      })
      .catch(function () {
        return false
      })
  },

  onPhone: function (event) {
    this.setData({ phone: event.detail.value, formError: '' })
  },

  onCode: function (event) {
    this.setData({ code: event.detail.value, formError: '' })
  },

  onAccountPassword: function (event) {
    this.setData({ accountPassword: event.detail.value, formError: '' })
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

    let uidBefore = ''

    api
      .getSession()
      .then(function (session) {
        uidBefore = (session && session.user && session.user.id) || ''
        if (!uidBefore) {
          throw new Error('登录状态已失效，请回到「我的」重新登录后再绑定')
        }
        // 老账号（非微信身份）被切走之后没有微信身份可切回，只能靠
        // 「账号手机号 + 密码」重新登录回来 —— 所以密码在这一步之前必须先拿到。
        page._isWechat = uidBefore.indexOf('wx:') === 0
        if (!page._isWechat && !String(page.data.accountPassword || '')) {
          throw new Error('当前账号不是微信身份，请先填写本账号的登录密码：换号验证后要用它切回原账号')
        }
        // 写标记：下一步会话会借道到手机号身份，正常流程结束后清除；
        // 万一进程被杀 / 网络断了，app.js 下次启动看到标记会强制切回微信身份。
        ui.setStorage(IDENTITY_PENDING_KEY, { uid: uidBefore, at: Date.now() })
        return api.verifyPhoneOnly({
          phone: phone,
          verificationId: page.pendingChallenge.verificationId,
          isExistingUser: page.pendingChallenge.isExistingUser,
          token: code,
          password: randomPassword(),
        })
      })
      .then(function () {
        // 验码后会话可能已经变成手机号身份。先看看是不是「本来就是这个账号」
        // —— 老账号本身就是手机号身份时，绑自己的号码验完还是同一个 uid，
        // 这时候再调 api.login() 反而会把用户踢到微信身份上（就是「跳到另一个账号」）。
        return api.getSession()
      })
      .then(function (session) {
        const uidAfter = (session && session.user && session.user.id) || ''
        if (uidBefore && uidAfter === uidBefore) {
          // 验完还是本人（老账号绑自己的号），不用切
          ui.removeStorage(IDENTITY_PENDING_KEY)
          return { session: session }
        }
        // 确实被换成了别的身份：微信身份用 wx.login 切回；
        // 老账号用「账号手机号 + 密码」重新登录切回。
        page._switched = true
        if (page._isWechat) return api.login()
        return api.loginWithPassword(page._authPhone, String(page.data.accountPassword || ''))
      })
      .then(function (result) {
        if (!result || !result.session) {
          throw new Error('切回微信登录失败，请重新进入小程序后再试')
        }
        return page.assertIdentity(uidBefore, result)
      })
      .then(function () {
        return api.bindMyPhone(phone)
      })
      .then(function () {
        ui.hideLoading()
        ui.removeStorage(IDENTITY_PENDING_KEY)
        page._switched = false
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
        ui.toast({ title: message, icon: 'none', duration: 2600 })
        // 只要已经借道过手机号身份，就必须把它切回微信身份：
        // 否则用户会停留在一个没有资料的陌生账号里，看起来就是「跳到另一个账号」
        page.recoverIdentity(uidBefore)
      })
  },

  // 切回微信身份后核对 uid。对不上就退出重登一次；还不对就抛出，
  // 让上层直接中止 —— 绑到别人账号上比绑不上严重得多。
  assertIdentity: function (uidBefore, result) {
    const uidAfter =
      (result && result.session && result.session.user && result.session.user.id) || ''
    if (uidBefore && uidAfter === uidBefore) return Promise.resolve(result)
    console.warn('[bind-phone] identity mismatch', uidBefore, '->', uidAfter)
    return api
      .logout()
      .catch(function () {
        return null
      })
      .then(function () {
        return api.login()
      })
      .then(function (again) {
        const uid2 =
          (again && again.session && again.session.user && again.session.user.id) || ''
        if (!uidBefore || uid2 !== uidBefore) {
          const error = new Error('账号校验未通过，已为你退出登录，请重新进入小程序后再绑定')
          error.identityLost = true
          throw error
        }
        return again
      })
  },

  // 兜底：退出当前（可能是手机号身份的）会话，用 wx.login 重新拿回微信身份。
  // 只有真的切回来了才清除标记；修不回来就留着，等 app.js 下次启动再兜。
  recoverIdentity: function (uidBefore) {
    const page = this
    if (!page._switched) return
    page._switched = false
    api
      .logout()
      .catch(function () {
        return null
      })
      .then(function () {
        return api.login()
      })
      .then(function (result) {
        const uid =
          (result && result.session && result.session.user && result.session.user.id) || ''
        if (!uidBefore || uid === uidBefore) ui.removeStorage(IDENTITY_PENDING_KEY)
      })
      .catch(function () {
        // 保持标记不动，下次启动由 app.js repairIdentity 处理
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
