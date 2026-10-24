const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const config = require('../../utils/config')
const motion = require('../../utils/motion')
const perms = require('../../utils/perms')

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
    adminError: '',
    // 手机号与注销（R44）
    phoneBound: false,
    phoneMask: '',
    deleteOpen: false,
    deleteAgreed: false,
    deleteReason: '',
    deleting: false,
    deleteError: '',

    // 关于
    agreementVersionText: '未签署',
    appTitle: config.appTitle,
    appVersion: config.appVersion,
    school: config.school,
    notice: config.notice,
    // 联系客服不再放这里：智能客服页统一承接（AI 回答 + 转人工工单），
    // 同一个诉求留两个入口只会让用户不知道点哪个。
  },

  onLoad: function (options) {
    const sys = motion.systemInfo()
    this.setData({
      navTotal: sys.navTotalHeight,
      motionClass: motion.rootClass(),
      reduceMotion: motion.reduced(),
      adminPanelOpen: !!(options && options.admin === '1'),
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
          page.setData({ logged: false, isAdmin: false, adminCode: '', adminError: '', adminPanelOpen: false })
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
        return api.getMyPhoneState().catch(function () { return { bound: false } })
      })
      .then(function (state) {
        if (!state) return
        const value = String(state.phone || '')
        page.setData({
          phoneBound: !!state.bound,
          phoneMask: value ? value.slice(0, 3) + '****' + value.slice(7) : '',
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

  goBindPhone: function () {
    this.goPage('/pages/mine/bind-phone')
  },

  // ---- 注销账号（R44）----
  onDeleteTap: function () {
    if (!this.data.logged) {
      ui.toast({ title: '请先登录', icon: 'none' })
      return
    }
    motion.haptic('light')
    this.setData({ deleteOpen: true, deleteAgreed: false, deleteError: '', deleteReason: '' })
  },

  // 弹窗内部点击不该冒泡到遮罩，否则点输入框就把弹窗关了
  noop: function () {},

  closeDelete: function () {
    if (this.data.deleting) return
    this.setData({ deleteOpen: false })
  },

  onDeleteReason: function (event) {
    this.setData({ deleteReason: event.detail.value })
  },

  toggleDeleteAgree: function () {
    motion.haptic('light')
    this.setData({ deleteAgreed: !this.data.deleteAgreed, deleteError: '' })
  },

  confirmDelete: function () {
    const page = this
    if (page.data.deleting) return
    if (!page.data.deleteAgreed) {
      page.setData({ deleteError: '请先勾选「我已阅读并理解以上后果」' })
      return
    }
    page.setData({ deleting: true, deleteError: '' })
    ui.loading({ title: '注销中', mask: true })
    api
      .requestAccountDeletion(page.data.deleteReason)
      .then(function () {
        ui.hideLoading()
        page.setData({ deleting: false, deleteOpen: false })
        ui.toast({ title: '账号已注销，6 个月内可恢复', icon: 'none', duration: 2600 })
        // 注销后立刻退出登录，避免停留在「已注销但还能操作」的状态
        return api.logout()
      })
      .then(function () {
        setTimeout(function () {
          wx.switchTab({ url: '/pages/mine/index' })
        }, 900)
      })
      .catch(function (error) {
        ui.hideLoading()
        page.setData({ deleting: false, deleteError: api.getErrorMessage(error) })
      })
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
    if (this.data.adminSaving) return
    if (!this.data.logged) return guard.ensureLogin()
    if (this.data.isAdmin) {
      return this.goDashboard()
    }
    this.setData({ adminPanelOpen: !this.data.adminPanelOpen, adminCode: '', adminError: '' })
  },

  onAdminCodeInput: function (event) {
    this.setData({ adminCode: event.detail.value || '', adminError: '' })
  },

  submitAdminCode: function () {
    const page = this
    if (!page.data.logged) return guard.ensureLogin()
    const code = String(page.data.adminCode || '').trim()
    if (!code) {
      ui.toast({ title: '请输入管理员口令', icon: 'none' })
      return
    }
    if (page.data.adminSaving) return
    page.setData({ adminSaving: true, adminError: '' })
    ui.loading({ title: '处理中', mask: true })
    return api
      .activateAdmin(code)
      .then(function (profile) {
        if (!profile || !profile.is_admin) throw new Error('后台权限校验未通过，请重试')
        ui.hideLoading()
        perms.reset()
        page.setData({ adminSaving: false, adminPanelOpen: false, adminCode: '', adminError: '', isAdmin: true })
        ui.toast({ title: '后台密码验证通过', icon: 'success' })
        page.goDashboard()
      })
      .catch(function (error) {
        ui.hideLoading()
        page.setData({ adminSaving: false, adminCode: '', adminError: api.getErrorMessage(error) })
        guard.toastError(error)
      })
  },

  goDashboard: function () {
    this.goPage('/pages/admin/dashboard')
  },

  onHide: function () { this.setData({ adminCode: '' }) },
  onUnload: function () { this.setData({ adminCode: '' }) },

})
