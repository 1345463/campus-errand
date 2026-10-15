const ui = require('../../utils/ui')
const api = require('../../utils/api')

// 机型挂牌价管理。
// 之前机型清单写死在前端，改一次价就要改代码 + 重新发布小程序；现在直接改 rental_items 表，
// 用户端下次进租赁页就是新价格 —— 这也是这个页面存在的唯一理由。
//
// 两个刻意的设计：
//   1) 下架不等于删除：历史租赁申请里还引用着 item_id，删了会导致旧记录查不到机型；
//      下架只是让它在用户端不展示。
//   2) 改价要「保存」按钮才生效，不做失焦即改 —— 金额是敏感字段，误触必须有挽回余地。
Page({
  data: {
    list: [],
    loading: false,
    needLogin: false,
    denied: false,
    actingId: '',
    price: '',
    deposit: '',
    // 新增机型表单
    newOpen: false,
    newName: '',
    newSpec: '',
    newPrice: '',
    newDeposit: '',
    tipText: '',
    errorText: '',
  },

  onLoad: function () {
    this.checkAndLoad()
  },

  onPullDownRefresh: function () {
    const page = this
    this.load().then(
      function () {
        wx.stopPullDownRefresh()
      },
      function () {
        wx.stopPullDownRefresh()
      }
    )
  },

  checkAndLoad: function () {
    const page = this
    return api
      .getSession()
      .then(function (session) {
        if (!session) {
          page.setData({ needLogin: true, list: [], loading: false })
          return
        }
        return api
          .getProfile()
          .then(function (profile) {
            if (!profile || !profile.is_admin) {
              page.setData({ denied: true, list: [], loading: false })
              return
            }
            page.setData({ needLogin: false, denied: false })
            return page.load()
          })
      })
      .catch(function (error) {
        page.setData({ loading: false, errorText: api.getErrorMessage(error) })
      })
  },

  load: function () {
    const page = this
    page.setData({ loading: true, errorText: '' })
    return api
      .adminListRentalItems()
      .then(function (rows) {
        const list = rows.map(function (item) {
          return {
            id: item.id,
            name: item.name,
            spec: item.spec || '',
            priceText: Number(item.price || 0).toFixed(2),
            depositText: Number(item.deposit || 0).toFixed(2),
            enabled: !!item.enabled,
            updatedText: api.formatTime(item.updated_at),
          }
        })
        page.setData({
          list: list,
          loading: false,
          actingId: '',
          price: '',
          deposit: '',
        })
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ loading: false, list: [], errorText: message })
        if (typeof console !== 'undefined' && console.error) console.error('[admin/items]', message, error)
        ui.toast({ title: message, icon: 'none' })
      })
  },

  openPrice: function (event) {
    const id = String(event.currentTarget.dataset.id)
    const row = this.data.list.filter(function (item) {
      return item.id === id
    })[0]
    if (!row) return
    this.setData({
      actingId: id,
      price: row.priceText.replace(/\.00$/, ''),
      deposit: row.depositText.replace(/\.00$/, ''),
      tipText: '',
    })
  },

  closePrice: function () {
    this.setData({ actingId: '', price: '', deposit: '' })
  },

  onPriceInput: function (event) {
    const key = event.currentTarget.dataset.key
    const patch = {}
    patch[key] = event.detail.value
    this.setData(patch)
  },

  savePrice: function (event) {
    const page = this
    const id = String(event.currentTarget.dataset.id)
    const raw = String(page.data.price || '').trim()
    const price = Number(raw)
    const depositRaw = String(page.data.deposit || '').trim()
    const deposit = depositRaw === '' ? 0 : Number(depositRaw)

    if (raw === '' || !isFinite(price) || price <= 0) {
      ui.toast({ title: '挂牌价要大于 0', icon: 'none' })
      return
    }
    if (!isFinite(deposit) || deposit < 0) {
      ui.toast({ title: '押金不对（不收就填 0）', icon: 'none' })
      return
    }

    ui.loading({ title: '保存中', mask: true })
    api
      .adminUpdateRentalItem(id, { price: price, deposit: deposit })
      .then(function () {
        ui.hideLoading()
        page.setData({ actingId: '', price: '', deposit: '', tipText: '挂牌价已更新，用户端刷新即可看到' })
        ui.toast({ title: '已保存', icon: 'success' })
        return page.load()
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ errorText: message, tipText: '' })
        ui.toast({ title: message, icon: 'none' })
      })
  },

  // 下架 / 上架：不清数据，只是对用户端隐藏
  toggleEnabled: function (event) {
    const page = this
    const id = String(event.currentTarget.dataset.id)
    const enabled = String(event.currentTarget.dataset.enabled) !== 'true'
    ui.loading({ title: '处理中', mask: true })
    api
      .adminUpdateRentalItem(id, { enabled: enabled })
      .then(function () {
        ui.hideLoading()
        ui.toast({ title: enabled ? '已上架' : '已下架', icon: 'success' })
        return page.load()
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ errorText: message })
        ui.toast({ title: message, icon: 'none' })
      })
  },

  openNew: function () {
    this.setData({ newOpen: true, tipText: '' })
  },

  closeNew: function () {
    this.setData({ newOpen: false, newName: '', newSpec: '', newPrice: '', newDeposit: '' })
  },

  onNewInput: function (event) {
    const key = event.currentTarget.dataset.key
    const patch = {}
    patch[key] = event.detail.value
    this.setData(patch)
  },

  createItem: function () {
    const page = this
    const name = String(page.data.newName || '').trim()
    const spec = String(page.data.newSpec || '').trim()
    const price = Number(String(page.data.newPrice || '').trim())
    const depositRaw = String(page.data.newDeposit || '').trim()
    const deposit = depositRaw === '' ? 0 : Number(depositRaw)

    if (!name) {
      ui.toast({ title: '请填写机型名称', icon: 'none' })
      return
    }
    if (!isFinite(price) || price <= 0) {
      ui.toast({ title: '挂牌价要大于 0', icon: 'none' })
      return
    }
    if (!isFinite(deposit) || deposit < 0) {
      ui.toast({ title: '押金不对（不收就填 0）', icon: 'none' })
      return
    }

    ui.loading({ title: '新增中', mask: true })
    api
      .adminCreateRentalItem({ name: name, spec: spec, price: price, deposit: deposit })
      .then(function () {
        ui.hideLoading()
        page.setData({
          newOpen: false,
          newName: '',
          newSpec: '',
          newPrice: '',
          newDeposit: '',
          tipText: '已新增机型：' + name,
        })
        ui.toast({ title: '已新增', icon: 'success' })
        return page.load()
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ errorText: message, tipText: '' })
        ui.toast({ title: message, icon: 'none' })
      })
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },
})
