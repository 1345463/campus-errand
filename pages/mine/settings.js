const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const config = require('../../utils/config')
const motion = require('../../utils/motion')

Page({
  data: {
    // 自定义导航是 fixed 的，内容要自己让位
    navTotal: 64,
    motionClass: '',
    reduceMotion: false,
    logged: false,

    // 账号与权限
    isAdmin: false,
    adminPanelOpen: false,
    adminCode: '',
    adminSaving: false,

    // 关于
    agreementVersionText: '未签署',
    appTitle: config.appTitle,
    appVersion: config.appVersion,
    school: config.school,
    notice: config.notice,
    // 联系客服不再放这里：智能客服页统一承接（AI 回答 + 转人工工单），
    // 同一个诉求留两个入口只会让用户不知道点哪个。
  },

  onLoad: function () {
    const sys = motion.systemInfo()
    this.setData({
      navTotal: sys.navTotalHeight,
      motionClass: motion.rootClass(),
      reduceMotion: motion.reduced(),
    })
  },

  onShow: function () {
    this.load()
  },

  load: function () {
    const page = this
    return api
      .getSession()
      .then(function (session) {
        if (!session) {
          page.setData({ logged: false })
          return null
        }
        page.setData({ logged: true })
        return api.getProfile()
      })
      .then(function (profile) {
        if (!profile) return
        page.setData({
          isAdmin: !!profile.is_admin,
          agreementVersionText: profile.agreed_version
            ? '已签署 ' + profile.agreed_version
            : '未签署',
        })
      })
      .catch(function (error) {
        // 设置页拉不到资料不该把整页卡住，只在控制台留个痕迹，
        // 别弹 toast —— 用户进设置页看到红字会以为设置坏了
        console.error('[settings] 加载资料失败', error)
      })
  },

  goPage: function (url) {
    motion.haptic('light')
    wx.navigateTo({
      url: url,
      fail: function (err) {
        ui.toast({ title: '页面打开失败：' + (err.errMsg || '未知错误'), icon: 'none' })
      },
    })
  },

  goBack: function () {
    motion.haptic('light')
    wx.navigateBack({
      fail: function () {
        wx.switchTab({ url: '/pages/mine/index' })
      },
    })
  },

  goAddress: function () {
    this.goPage('/pages/mine/address')
  },

  goAgreement: function () {
    this.goPage('/pages/agreement/index')
  },

  // 减弱动效：关掉后全站循环动画停掉、入场动画只保留淡入
  toggleMotion: function (event) {
    // switch 的 checked=true 表示「开启动效」
    const enabled = !!event.detail.value
    motion.setReduced(!enabled)
    this.setData({
      reduceMotion: !enabled,
      motionClass: motion.rootClass(),
    })
    motion.haptic('light')
  },

  onAdminTap: function () {
    if (this.data.isAdmin) {
      ui.toast({ title: '管理员权限已开通', icon: 'none' })
      return
    }
    this.setData({ adminPanelOpen: !this.data.adminPanelOpen })
  },

  onAdminCodeInput: function (event) {
    this.setData({ adminCode: event.detail.value || '' })
  },

  submitAdminCode: function () {
    const page = this
    const code = String(page.data.adminCode || '').trim()
    if (!code) {
      ui.toast({ title: '请输入管理员口令', icon: 'none' })
      return
    }
    if (page.data.adminSaving) return
    page.setData({ adminSaving: true })
    ui.loading({ title: '处理中', mask: true })
    api
      .activateAdmin(code)
      .then(function (profile) {
        ui.hideLoading()
        page.setData({ adminSaving: false, adminPanelOpen: false, adminCode: '' })
        page.setData({ isAdmin: !!(profile && profile.is_admin) })
        ui.toast({ title: '已开通管理员', icon: 'success' })
      })
      .catch(function (error) {
        ui.hideLoading()
        page.setData({ adminSaving: false })
        guard.toastError(error)
      })
  },

})
