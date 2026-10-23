App({
  globalData: {
    session: null,
    profile: null,
    logged: false,
  },

  onLaunch() {
    const app = this
    const api = require('./utils/api')
    require('./utils/ui').removeStorage('savedAccount')
    app.checkUpdate()
    api
      .restoreSession()
      .then(function (result) {
        app.globalData.session = result.session
        app.globalData.profile = result.profile
        app.globalData.logged = !!result.session
      })
      .catch(function () {
        app.globalData.logged = false
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
