const ui = require('./ui')
const api = require('./api')

function confirmGoLogin() {
  return ui
    .confirm({
      title: '需要先登录',
      content: '发布任务、接单和查看联系方式都要先登录',
      confirmText: '去登录',
      cancelText: '再看看',
    })
    .then(function (ok) {
      if (ok) wx.switchTab({ url: '/pages/mine/index' })
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
      wx.switchTab({ url: '/pages/mine/index' })
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

module.exports = {
  ensureLogin: ensureLogin,
  toastError: toastError,
  nicknameMissing: nicknameMissing,
  ensureNickname: ensureNickname,
}
