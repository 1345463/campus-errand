const ui = require('../../utils/ui')
const api = require('../../utils/api')
const agreement = require('../../utils/agreement')

Page({
  data: {
    title: agreement.TITLE,
    updatedAt: agreement.UPDATED_AT,
    version: agreement.VERSION,
    sections: agreement.SECTIONS,
    force: false,
    agreed: false,
    saving: false,
    errorText: '',
    needLogin: false,
  },

  onLoad: function (options) {
    this.setData({ force: !!(options && options.force === '1') })
  },

  toggleAgree: function () {
    this.setData({ agreed: !this.data.agreed })
  },

  // 强制模式下点「同意并继续」：把版本号写进资料，之后不再拦截
  accept: function () {
    const page = this
    if (!page.data.agreed) {
      ui.toast({ title: '请先勾选「我已阅读并同意」', icon: 'none' })
      return
    }
    if (page.data.saving) return
    page.setData({ saving: true, errorText: '' })
    ui.loading({ title: '提交中', mask: true })
    api
      .acceptAgreement(agreement.VERSION)
      .then(function (profile) {
        ui.hideLoading()
        page.setData({ saving: false })
        ui.toast({ title: '已同意用户协议', icon: 'success' })
        const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
        if (pages.length > 1) {
          wx.navigateBack()
          return null
        }
        wx.switchTab({ url: '/pages/mine/index' })
        return profile
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ saving: false, errorText: message })
        ui.toast({ title: message, icon: 'none' })
      })
  },
})
