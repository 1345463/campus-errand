const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const campus = require('../../utils/campus')

function maskPhone(phone) {
  const value = String(phone || '')
  if (value.length !== 11) return value
  return value.slice(0, 3) + '****' + value.slice(7)
}

// 「进取楼 · 5层 · 12号」拆成楼栋+楼层 / 宿舍号两列
function splitRoom(text) {
  const parts = String(text || '').split('·').map(function (item) {
    return item.trim()
  })
  return {
    building: parts[0] && parts[1] ? parts[0] + ' · ' + parts[1] : parts[0] || '',
    room: parts[2] || '',
  }
}

Page({
  data: {
    form: {
      contact_name: '',
      phone: '',
      building: '',
      room: '',
      tag: '宿舍',
    },
    roomValue: '',
    tagOptions: ['宿舍', '教学楼', '快递柜', '食堂', '其它'],
    list: [],
    saving: false,
  },

  onShow: function () {
    this.load()
  },

  load: function () {
    const page = this
    return api
      .listAddresses()
      .then(function (rows) {
        const list = rows.map(function (item) {
          return Object.assign({}, item, { phoneMask: maskPhone(item.phone) })
        })
        page.setData({ list: list })
      })
      .catch(function (error) {
        if (error && error.needLogin) {
          guard.ensureLogin()
          return
        }
        guard.toastError(error)
      })
  },

  onInput: function (event) {
    const key = event.currentTarget.dataset.key
    const patch = {}
    patch['form.' + key] = event.detail.value
    this.setData(patch)
  },

  onRoomChange: function (event) {
    this.setData({ roomValue: event.detail.value })
  },

  pickTag: function (event) {
    this.setData({ 'form.tag': event.currentTarget.dataset.value })
  },

  // 把常用地址回填到下单页
  useAddress: function (event) {
    const addr = this.data.list[Number(event.currentTarget.dataset.index)]
    if (!addr) return
    ui.setStorage('pickedAddress', {
      building: addr.building,
      room: addr.room,
      contact: addr.phone,
    })
    ui.toast({ title: '已选为常用收货地址', icon: 'none' })
  },

  add: function () {
    const page = this
    const form = page.data.form
    if (page.data.saving) return
    if (!form.contact_name.trim()) {
      ui.toast({ title: '请填写联系人', icon: 'none' })
      return
    }
    if (!/^1\d{10}$/.test(form.phone)) {
      ui.toast({ title: '请输入正确的 11 位手机号', icon: 'none' })
      return
    }
    if (!page.data.roomValue) {
      ui.toast({ title: '请选择宿舍地址', icon: 'none' })
      return
    }
    const roomParts = splitRoom(page.data.roomValue)

    page.setData({ saving: true })
    api
      .addAddress({
        contact_name: form.contact_name.trim(),
        phone: form.phone,
        building: roomParts.building,
        room: roomParts.room,
        tag: form.tag,
        is_default: false,
      })
      .then(function () {
        page.setData({
          saving: false,
          form: { contact_name: '', phone: '', building: '', room: '', tag: '宿舍' },
          roomValue: '',
        })
        ui.toast({ title: '已保存', icon: 'success' })
        return page.load()
      })
      .catch(function (error) {
        page.setData({ saving: false })
        if (error && error.needLogin) {
          guard.ensureLogin()
          return
        }
        guard.toastError(error)
      })
  },

  remove: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id)
    ui
      .confirm({
        title: '删除地址',
        content: '删除后无法恢复，确定删除吗？',
        defaultConfirm: true,
      })
      .then(function (ok) {
        if (!ok) return null
        return api.removeAddress(id).then(function () {
          ui.toast({ title: '已删除', icon: 'success' })
          return page.load()
        })
      })
      .then(function () {})
      .catch(function (error) {
        guard.toastError(error)
      })
  },
})
