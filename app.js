App({
  globalData: {
    session: null,
    profile: null,
    logged: false,
    cloudReady: false,
  },

  onLaunch() {
    const app = this
    // 微信云开发（小程序自己的环境 baozi-xxx）只承担「免域名的兜底通道」。
    // ⚠️ 小程序一旦把云开发资源授权给服务商（如 WorkBuddy 托管），管理员在开发者工具里
    //    就用不了云开发，这个 env 随之不可用；此时全靠主通道：直连 CloudBase 网关，
    //    前提是网关域名已加进「request 合法域名」。
    // 所以这里**初始化失败绝不能挡住启动** —— 包一层 try，失败只关掉兜底通道。
    if (wx.cloud) {
      try {
        wx.cloud.init({ env: 'baozi-d2gbl784gd773f8b6', traceUser: true })
        app.globalData.cloudReady = true
      } catch (e) {
        console.warn('[cloud] 云开发环境初始化失败，兜底通道不可用：', (e && e.message) || e)
      }
    } else {
      console.warn('[cloud] 基础库低于 2.2.3，wx.cloud 不可用，只走网关直连')
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

  // 换库之后只剩微信一种身份（uid 恒为 wx: 开头），绑定手机号也不再借道别的身份，
  // 所以「切身份切不回来」这一类事故不存在了。这里只做两件事：
  //   1) 清掉旧版本留下的 identitySwitchPending 标记（历史用户升级上来会带着）
  //   2) 令牌本身失效（服务端换了密钥、过期、被清库）时静默重登一次
  repairIdentity: function () {
    const app = this
    const ui = require('./utils/ui')
    const api = require('./utils/api')
    ui.removeStorage('identitySwitchPendingV1')
    return api
      .getSession()
      .then(function (session) {
        if (!session) return false
        return api.getProfile().then(function (profile) {
          if (profile) return false
          // 有令牌却读不到资料：令牌或账号已经对不上了，重登一次拿新的
          return app.forceRelogin('会话与账号不匹配')
        })
      })
      .catch(function (error) {
        // 明确报「登录失效」的（令牌验签不过 / 过期）才重登，
        // 网络抖动不在这里折腾，等 onShow 再试
        if (error && error.needLogin) return app.forceRelogin('登录状态已失效')
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
