App({
  globalData: {
    session: null,
    profile: null,
    logged: false,
  },

  onLaunch() {
    const app = this
    // 微信云开发初始化：env 必须是「小程序自己的云开发环境」。
    // 这里用 baozi（在小程序后台开通的），wx.cloud 只认这类环境；
    // 数据库所在的腾讯云 CloudBase 环境 ceshi-xxx 是另一回事，由云函数侧访问。
    if (wx.cloud) {
      wx.cloud.init({ env: 'baozi-d2gbl784gd773f8b6', traceUser: true })
    } else {
      console.warn('[cloud] 基础库低于 2.2.3，wx.cloud 不可用，支付功能将无法使用')
    }
    const api = require('./utils/api')
    require('./utils/ui').removeStorage('savedAccount')
    app.checkUpdate()
    app
      .repairIdentity()
      .then(function () {
        return api.restoreSession()
      })
      .then(function (result) {
        app.globalData.session = result.session
        app.globalData.profile = result.profile
        app.globalData.logged = !!result.session
      })
      .catch(function () {
        app.globalData.logged = false
      })
  },

  // 「绑定手机号」会先把会话借道到手机号身份（验码必须由 auth provider 完成），
  // 验完再切回微信身份。若那一步中途断了（进程被杀 / wx.login 失败），
  // 用户下次打开就落在一个没有资料的陌生账号上 —— 看到的正是「跳到另一个账号」。
  // bind-phone 在切身份前会写下标记，这里见到标记就强制登出重登一次。
  repairIdentity: function () {
    const app = this
    const ui = require('./utils/ui')
    const api = require('./utils/api')
    const KEY = 'identitySwitchPendingV1'
    const pending = ui.getStorage(KEY)
    if (pending && pending.uid) {
      ui.removeStorage(KEY)
      return app.forceRelogin('绑定手机号时身份没切回来')
    }
    // 没有标记也要兜一次：会话存在但不是微信身份、库里又查不到资料，
    // 说明这是绑定过程中留下的空壳账号（正常账号一定有 profiles 行）。
    // 有资料的手机号账号不碰 —— 那是「我的」页注册入口建出来的老账号。
    return api
      .getSession()
      .then(function (session) {
        const uid = (session && session.user && String(session.user.id || '')) || ''
        if (!uid || uid.indexOf('wx:') === 0) return false
        return api.getProfile().then(function (profile) {
          if (profile) return false
          return app.forceRelogin('空壳手机号身份')
        })
      })
      .catch(function () {
        return false
      })
  },

  forceRelogin: function (reason) {
    const app = this
    const api = require('./utils/api')
    console.warn('[app] 强制重新登录：' + reason)
    return api
      .logout()
      .catch(function () {
        return null
      })
      .then(function () {
        return api.login()
      })
      .then(function (result) {
        app.globalData.session = result && result.session
        app.globalData.profile = result && result.profile
        app.globalData.logged = !!(result && result.session)
        return true
      })
      .catch(function () {
        app.globalData.logged = false
        return false
      })
  },

  onShow() {
    const app = this
    if (app.globalData.logged) return
    const api = require('./utils/api')
    api
      .restoreSession()
      .then(function (result) {
        app.globalData.session = result.session
        app.globalData.profile = result.profile
        app.globalData.logged = !!result.session
      })
      .catch(function () {})
  },

  // 版本更新：检测到新版就立刻下载并弹窗让用户重启。
  // 微信默认只是"下次冷启动再说"，最快也要一天才铺开；主动推一把能让
  // 后台那些依赖新版行为的改动（例如收回 orders 表的直写权限）早点安全地执行。
  checkUpdate: function () {
    if (typeof wx.getUpdateManager !== 'function') return
    const manager = wx.getUpdateManager()
    manager.onCheckForUpdate(function (result) {
      if (result && result.hasUpdate) wx.setStorageSync('hasNewVersion', true)
    })
    manager.onUpdateReady(function () {
      wx.showModal({
        title: '更新提示',
        content: '校园跑腿有新版本了，重启后即可使用最新功能',
        showCancel: false,
        confirmText: '立即重启',
        success: function () {
          manager.applyUpdate()
        },
      })
    })
    manager.onUpdateFailed(function () {
      // 下载失败不打扰用户，下次冷启动会自己再试一次
    })
  },
})
