const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const config = require('../../utils/config')

const DAYS = [1, 2, 3, 5, 7, 10, 15, 30]

// 上一页用 encodeURIComponent 编码后拼进 URL，onLoad 拿到的仍是编码态。
// 不还原就出现「大疆 POCKET 4」显示成 %E5%A4%A7%E7%96%86%20POCKET%204 这种天书。
// 已经还原过的字符串再解码可能抛异常（例如名字里本身带 %），所以 try 兜底返回原值。
function safeDecode(value) {
  if (value === null || value === undefined || value === '') return ''
  const text = String(value)
  try {
    return decodeURIComponent(text)
  } catch (e) {
    return text
  }
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

Page({
  data: {
    itemId: '',
    itemName: '相机',
    unitPrice: 0,
    days: 1,
    dayOptions: DAYS,
    totalText: '0',
    realName: '',
    studentNo: '',
    college: '',
    contact: '',
    expectFrom: '',
    expectTo: '',
    pickupAddr: config.pickupPoint || '',
    note: '',
    submitting: false,
    needLogin: false,
    errorText: '',
  },

  onLoad: function (options) {
    const query = options || {}
    const price = Number(safeDecode(query.price)) || 0
    this.setData({
      itemId: safeDecode(query.id),
      itemName: safeDecode(query.name) || '相机',
      unitPrice: price,
      totalText: String(round2(price * 1)),
      pickupAddr: config.pickupPoint || '',
    })
  },

  onShow: function () {
    const page = this
    api.getSession().then(function (session) {
      page.setData({ needLogin: !session })
    })
  },

  pickDay: function (event) {
    const days = Number(event.currentTarget.dataset.day) || 1
    this.setData({
      days: days,
      totalText: String(round2(this.data.unitPrice * days)),
    })
  },

  onInput: function (event) {
    const key = event.currentTarget.dataset.key
    const patch = {}
    patch[key] = event.detail.value
    this.setData(patch)
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },

  submit: function () {
    const page = this
    const data = page.data
    const realName = String(data.realName || '').trim()
    const studentNo = String(data.studentNo || '').trim()
    const contact = String(data.contact || '').trim()

    if (!realName) {
      ui.toast({ title: '请填写真实姓名', icon: 'none' })
      return
    }
    if (!studentNo) {
      ui.toast({ title: '请填写学号', icon: 'none' })
      return
    }
    if (!/^1\d{10}$/.test(contact)) {
      ui.toast({ title: '请填写正确的 11 位手机号', icon: 'none' })
      return
    }
    if (page.data.submitting) return

    page.setData({ submitting: true, errorText: '' })
    ui.loading({ title: '提交中', mask: true })
    api
      .requireSession()
      .then(function () {
        return api.submitRentalRequest({
          itemId: data.itemId,
          itemName: data.itemName,
          unitPrice: data.unitPrice,
          days: data.days,
          realName: realName,
          studentNo: studentNo,
          college: String(data.college || '').trim(),
          contact: contact,
          expectFrom: String(data.expectFrom || '').trim(),
          expectTo: String(data.expectTo || '').trim(),
          pickupAddr: String(data.pickupAddr || '').trim(),
          note: String(data.note || '').trim(),
        })
      })
      .then(function () {
        ui.hideLoading()
        page.setData({ submitting: false })
        ui.toast({ title: '已提交，等待管理员报价', icon: 'success' })
        setTimeout(function () {
          wx.navigateBack()
        }, 900)
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ submitting: false, errorText: message })
        if (message.indexOf('登录') >= 0) page.setData({ needLogin: true })
        guard.toastError(error)
      })
  },
})
