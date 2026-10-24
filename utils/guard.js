const ui = require('./ui')
const api = require('./api')
const loginReturn = require('./login-return')

function confirmGoLogin() {
  return ui
    .confirm({
      title: '需要先登录',
      content: '发布任务、接单和查看联系方式都要先登录',
      confirmText: '去登录',
      cancelText: '再看看',
    })
    .then(function (ok) {
      if (ok) loginReturn.goLogin()
      return false
    })
}

// 需要登录才能继续的操作统一走这里，未登录时引导到「我的」页登录
function ensureLogin() {
  return api
    .getSession()
    .then(function (session) {
      if (session) return true
      return confirmGoLogin()
    })
    .catch(function (error) {
      console.error('[guard] session check failed', api.getErrorMessage(error))
      // 查询会话失败不等于未登录：提示并放行到登录页，不再静默吞掉
      ui.toast({ title: '登录状态校验失败，请到「我的」页重试', icon: 'none', duration: 2200 })
      loginReturn.goLogin()
      return false
    })
}

function toastError(error) {
  const message = api.getErrorMessage(error)
  ui.toast({ title: message, icon: 'none', duration: 2200 })
}

// 用户名是硬需求：接单员真名、评价、订单卡片、消息里都要显示。
// 但微信一键登录拿不到昵称，老账号也可能一直是空的，
// 所以只要读到 profile 发现没名字，就当场弹到资料页补全（force 模式，不填完不放走）。
function nicknameMissing(profile) {
  if (!profile) return false
  return !String(profile.nickname || '').trim()
}

function ensureNickname(profile) {
  if (!nicknameMissing(profile)) return false
  wx.navigateTo({
    url: '/pages/mine/profile?force=1',
    fail: function () {
      // 页面栈异常（比如从 tab 直接跳）时退回「我的」，下一次回来还会再拦一次
      wx.switchTab({ url: '/pages/mine/index' })
    },
  })
  return true
}

// 发单 / 接单 / 查看联系方式前必须先绑定手机号（R44）。
// 服务端有触发器与详情脱敏兜底，这里只负责在用户动手之前拦下来并给出下一步，
// 避免填完一整张表单才被拒。
function requirePhone() {
  return api
    .getMyPhoneState()
    .then(function (state) {
      if (state && state.bound) return true
      return ui
        .confirm({
          title: '需要先绑定手机号',
          content: '发单、接单和查看联系方式需要绑定手机号，方便对方联系你。只浏览任务不用绑定。',
          confirmText: '去绑定',
          cancelText: '再看看',
        })
        .then(function (ok) {
          if (ok) {
            wx.navigateTo({
              url: '/pages/mine/bind-phone?from=gate',
              fail: function () {
                wx.switchTab({ url: '/pages/mine/index' })
              },
            })
          }
          return false
        })
    })
    .catch(function (error) {
      console.error('[guard] phone state failed', api.getErrorMessage(error))
      ui.toast({ title: '校验手机号状态失败，请稍后重试', icon: 'none' })
      return false
    })
}

module.exports = {
  ensureLogin: ensureLogin,
  requirePhone: requirePhone,
  toastError: toastError,
  nicknameMissing: nicknameMissing,
  ensureNickname: ensureNickname,
}
