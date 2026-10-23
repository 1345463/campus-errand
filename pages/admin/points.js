const ui = require('../../utils/ui')
const api = require('../../utils/api')
const perms = require('../../utils/perms')
const flags = require('../../utils/flags')

// 积分商城管理（结算员 / 超级管理员，服务端 admin_*_point* 里各查一次 admin_has_perm('settle')）
//
// 三个 Tab 对应积分商城的三件事：
//   1) 商品 —— 改名字、积分价、库存、上下架，以及最关键的「怎么用」；
//   2) 积分 —— 手工给某个同学加 / 减积分，必须写原因（事后对账全靠它）；
//   3) 核销 —— 礼券类兑换码在后台手动核销。
//
// 「怎么用」三种，和 point_goods.benefit_type 一一对应：
//   deduct 抵扣付款金额：用户下单时直接抵赏金，所以必须填抵扣面额，系统自动核销；
//   verify 管理员核销：兑换码要拿到这里点「核销」，适合奶茶券、打印券这类线下交付的；
//   auto   自动生效：兑换完立刻生效（比如置顶卡），不需要任何人再操作。
// 改一个商品的 benefit_type 会改变老兑换码的使用方式，所以页面里明确写了这句提醒。

const BENEFIT_TYPES = [
  { key: 'deduct', label: '抵扣付款金额' },
  { key: 'verify', label: '管理员核销' },
  { key: 'auto', label: '自动生效' },
]

const BENEFIT_LABELS = {}
BENEFIT_TYPES.forEach(function (item) {
  BENEFIT_LABELS[item.key] = item.label
})

const BENEFIT_HINTS = {
  deduct: '下单时直接抵扣赏金，必须填抵扣面额',
  verify: '兑换码拿到「核销」页手动核销',
  auto: '兑换后立刻生效，无需再操作',
}

const TABS = [
  { key: 'goods', label: '商品管理' },
  { key: 'points', label: '积分调整' },
  { key: 'verify', label: '兑换核销' },
]

function emptyForm() {
  return {
    name: '',
    emoji: '🎁',
    cost: '100',
    stock: '50',
    descr: '',
    benefitType: 'verify',
    deductValue: '',
    enabled: true,
    sortOrder: '100',
  }
}

function toInt(value, fallback) {
  const text = String(value === undefined || value === null ? '' : value).trim()
  if (text === '') return fallback
  const num = parseInt(text, 10)
  return isFinite(num) ? num : fallback
}

// 抵扣面额允许小数（比如 2.5 元），但最多两位，多了没意义
function toMoney(value) {
  const text = String(value === undefined || value === null ? '' : value).trim()
  if (text === '') return 0
  const num = Number(text)
  if (!isFinite(num) || num < 0) return -1
  return Math.round(num * 100) / 100
}

Page({
  data: {
    tabs: TABS,
    tab: 'goods',
    loading: false,
    needLogin: false,
    denied: false,
    errorText: '',
    tipText: '',
    flagOn: true,

    // ---- 商品管理 ----
    list: [],
    benefitTypes: BENEFIT_TYPES,
    formOpen: false,
    editingId: '',
    form: emptyForm(),
    saving: false,
    formError: '',
    actingId: '',

    // ---- 积分调整 ----
    kw: '',
    searching: false,
    users: [],
    pickedUid: '',
    pickedName: '',
    pickedPoints: 0,
    adjustDelta: '',
    adjustRemark: '',
    adjusting: false,

    // ---- 兑换核销 ----
    code: '',
    verifying: false,
    verifyResult: null,
  },

  onLoad: function () {
    this.checkAndLoad()
  },

  onPullDownRefresh: function () {
    const page = this
    page.refresh().then(
      function () {
        wx.stopPullDownRefresh()
      },
      function () {
        wx.stopPullDownRefresh()
      }
    )
  },

  // 下拉只刷当前 Tab：核销页没有列表，刷了也没意义，直接什么都不做
  refresh: function () {
    if (this.data.tab === 'goods') return this.loadGoods()
    if (this.data.tab === 'points' && this.data.pickedUid) return this.searchUsers()
    return Promise.resolve()
  },

  checkAndLoad: function () {
    const page = this
    page.setData({ loading: true, errorText: '' })
    return flags
      .ensure()
      .then(function () {
        return api.getSession().then(function (session) {
          if (!session) {
            page.setData({ needLogin: true, loading: false, list: [] })
            return null
          }
          return perms.load().then(function () {
            // 服务端只认 settle，super 在 admin_has_perm 里隐含通过
            if (!perms.has('settle') && !perms.has('super')) {
              page.setData({ denied: true, loading: false, list: [] })
              return null
            }
            page.setData({
              needLogin: false,
              denied: false,
              // 只是提示：开关关着也允许提前配好商品
              flagOn: flags.on('point_mall'),
            })
            return page.loadGoods()
          })
        })
      })
      .catch(function (error) {
        page.setData({ loading: false, errorText: api.getErrorMessage(error) })
      })
  },

  switchTab: function (event) {
    const key = String(event.currentTarget.dataset.key || 'goods')
    if (key === this.data.tab) return
    this.setData({ tab: key, errorText: '', tipText: '' })
    if (key === 'goods' && this.data.list.length === 0) this.loadGoods()
  },

  // ---- 商品管理 ----

  loadGoods: function () {
    const page = this
    page.setData({ loading: true, errorText: '', actingId: '' })
    return api
      .adminListPointGoods()
      .then(function (rows) {
        const list = (rows || []).map(function (row) {
          const type = String(row.benefit_type || 'verify')
          const deduct = Number(row.deduct_value || 0)
          return {
            id: String(row.id || ''),
            emoji: String(row.emoji || '🎁'),
            name: String(row.name || '（未命名）'),
            cost: Number(row.cost || 0),
            stock: Number(row.stock || 0),
            descr: String(row.descr || ''),
            benefitType: type,
            benefitText: BENEFIT_LABELS[type] || type,
            benefitHint: BENEFIT_HINTS[type] || '',
            deductValue: deduct,
            deductText: type === 'deduct' ? '抵 ¥' + deduct.toFixed(2) : '—',
            sortOrder: Number(row.sort_order || 0),
            enabled: !!row.enabled,
          }
        })
        page.setData({ list: list, loading: false })
        return null
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ loading: false, list: [], errorText: message })
        ui.toast({ title: message, icon: 'none', duration: 2500 })
      })
  },

  openNew: function () {
    this.setData({ formOpen: true, editingId: '', form: emptyForm(), formError: '', tipText: '' })
  },

  openEdit: function (event) {
    const id = String(event.currentTarget.dataset.id || '')
    const row = this.data.list.filter(function (item) {
      return item.id === id
    })[0]
    if (!row) return
    this.setData({
      formOpen: true,
      editingId: id,
      formError: '',
      tipText: '',
      form: {
        name: row.name,
        emoji: row.emoji,
        cost: String(row.cost),
        stock: String(row.stock),
        descr: row.descr,
        benefitType: row.benefitType,
        // 非抵扣券面额是 0，编辑时留空比显示 0 好懂
        deductValue: row.benefitType === 'deduct' ? String(row.deductValue || '') : '',
        enabled: row.enabled,
        sortOrder: String(row.sortOrder),
      },
    })
  },

  closeForm: function () {
    this.setData({ formOpen: false, editingId: '', form: emptyForm(), formError: '' })
  },

  // 表单统一入口：data-key 指明写回 form 的哪个字段
  onInput: function (event) {
    const key = String(event.currentTarget.dataset.key || '')
    if (!key) return
    const patch = {}
    patch['form.' + key] = event.detail.value
    patch.formError = ''
    this.setData(patch)
  },

  pickBenefit: function (event) {
    const key = String(event.currentTarget.dataset.key || 'verify')
    const patch = { 'form.benefitType': key, formError: '' }
    // 换成别的类型时清掉面额：留着上一次填的金额，很容易配出一张「核销券却带面额」的怪商品
    if (key !== 'deduct') patch['form.deductValue'] = ''
    this.setData(patch)
  },

  toggleFormEnabled: function () {
    this.setData({ 'form.enabled': !this.data.form.enabled })
  },

  saveGoods: function () {
    const page = this
    const form = page.data.form
    const name = String(form.name || '').trim()
    if (!name) {
      page.setData({ formError: '商品名称不能为空' })
      ui.toast({ title: '商品名称不能为空', icon: 'none' })
      return
    }

    const cost = toInt(form.cost, 0)
    const stock = toInt(form.stock, 0)
    const sortOrder = toInt(form.sortOrder, 100)
    if (cost < 0) {
      page.setData({ formError: '积分价格不能为负' })
      return
    }
    if (stock < 0) {
      page.setData({ formError: '库存不能为负' })
      return
    }

    let deductValue = 0
    if (form.benefitType === 'deduct') {
      deductValue = toMoney(form.deductValue)
      if (deductValue <= 0) {
        page.setData({ formError: '「抵扣付款金额」类券必须填抵扣面额' })
        ui.toast({ title: '抵扣券必须填抵扣面额', icon: 'none' })
        return
      }
    }

    if (page.data.saving) return
    page.setData({ saving: true, formError: '' })
    ui.loading({ title: '保存中', mask: true })
    api
      .adminUpsertPointGoods({
        id: page.data.editingId,
        name: name,
        emoji: String(form.emoji || '').trim(),
        cost: cost,
        stock: stock,
        descr: String(form.descr || '').trim(),
        benefit_type: form.benefitType,
        deduct_value: deductValue,
        enabled: form.enabled !== false,
        sort_order: sortOrder,
      })
      .then(function (row) {
        ui.hideLoading()
        page.setData({
          saving: false,
          formOpen: false,
          editingId: '',
          form: emptyForm(),
          tipText: row ? '已保存：' + String(row.name || name) : '已保存',
        })
        ui.toast({ title: '已保存', icon: 'success' })
        return page.loadGoods()
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ saving: false, formError: message })
        ui.toast({ title: message, icon: 'none', duration: 2500 })
      })
  },

  // 上下架：把这一行的现有值原样回传，只翻 enabled。
  // 服务端 upsert 是按字段覆盖的，少传一个字段就会被写成默认值。
  toggleGoods: function (event) {
    const page = this
    const id = String(event.currentTarget.dataset.id || '')
    // 防重复：连点会发两次 upsert，状态来回翻
    if (page.data.actingId) return
    const row = page.data.list.filter(function (item) {
      return item.id === id
    })[0]
    if (!row) return
    const next = !row.enabled
    page.setData({ actingId: id, errorText: '' })
    ui.loading({ title: next ? '上架中' : '下架中', mask: true })
    // admin_upsert_point_goods 是全字段覆盖。直接用列表快照会把「管理员停留期间
    // 被用户兑换掉的库存」写回旧值，凭空多出可兑换份数。所以先拉一次最新数据，
    // 只用它来改 enabled，其余字段跟着服务端的最新值走。
    api
      .adminListPointGoods()
      .then(function (rows) {
        const fresh = (rows || []).filter(function (item) {
          return String(item.id || '') === id
        })[0]
        const src = fresh || {}
        return api.adminUpsertPointGoods({
          id: id,
          name: src.name != null ? String(src.name) : row.name,
          emoji: src.emoji != null ? String(src.emoji) : row.emoji,
          cost: src.cost != null ? Number(src.cost) : row.cost,
          stock: src.stock != null ? Number(src.stock) : row.stock,
          descr: src.descr != null ? String(src.descr) : row.descr,
          benefit_type: src.benefit_type != null ? String(src.benefit_type) : row.benefitType,
          deduct_value: src.deduct_value != null ? Number(src.deduct_value) : row.deductValue,
          enabled: next,
          sort_order: src.sort_order != null ? Number(src.sort_order) : row.sortOrder,
        })
      })
      .then(function () {
        ui.hideLoading()
        page.setData({ tipText: next ? '已上架，用户端可见' : '已下架，用户端不再显示' })
        ui.toast({ title: next ? '已上架' : '已下架', icon: 'success' })
        return page.loadGoods()
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ actingId: '', errorText: message })
        ui.toast({ title: message, icon: 'none', duration: 2500 })
      })
  },

  // ---- 积分调整 ----

  onKwInput: function (event) {
    this.setData({ kw: event.detail.value })
  },

  searchUsers: function () {
    const page = this
    const kw = String(page.data.kw || '').trim()
    if (!kw) {
      ui.toast({ title: '输入昵称或 ID 后再搜索', icon: 'none' })
      return Promise.resolve()
    }
    page.setData({ searching: true, errorText: '' })
    return api
      .adminSearchPointsUser(kw, 20)
      .then(function (rows) {
        const list = (rows || []).map(function (row) {
          return {
            uid: String(row.uid || ''),
            nickname: String(row.nickname || '同学'),
            points: Number(row.points || 0),
            role: String(row.role || 'user') === 'runner' ? '接单员' : '用户',
          }
        })
        page.setData({ searching: false, users: list })
        if (list.length === 0) ui.toast({ title: '没找到匹配的同学', icon: 'none' })
        return null
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ searching: false, users: [], errorText: message })
        ui.toast({ title: message, icon: 'none', duration: 2500 })
      })
  },

  pickUser: function (event) {
    const uid = String(event.currentTarget.dataset.uid || '')
    const row = this.data.users.filter(function (item) {
      return item.uid === uid
    })[0]
    if (!row) return
    this.setData({
      pickedUid: row.uid,
      pickedName: row.nickname,
      pickedPoints: row.points,
      adjustDelta: '',
      adjustRemark: '',
      errorText: '',
    })
  },

  clearUser: function () {
    this.setData({ pickedUid: '', pickedName: '', pickedPoints: 0, adjustDelta: '', adjustRemark: '' })
  },

  onAdjustInput: function (event) {
    const key = String(event.currentTarget.dataset.key || '')
    if (!key) return
    const patch = {}
    patch[key] = event.detail.value
    this.setData(patch)
  },

  // 快捷加减：直接填进输入框，具体数值还能再改，比只能手输省心
  quickDelta: function (event) {
    const value = String(event.currentTarget.dataset.value || '')
    this.setData({ adjustDelta: value })
  },

  doAdjust: function () {
    const page = this
    // 防重复：网络慢时连点会发两笔 admin_adjust_points，积分直接翻倍，
    // 而且两笔都有独立流水，事后只能手工冲正。
    if (page.data.adjusting) return
    const uid = page.data.pickedUid
    if (!uid) {
      ui.toast({ title: '先搜索并选中一个同学', icon: 'none' })
      return
    }
    const delta = toInt(page.data.adjustDelta, 0)
    if (!delta) {
      ui.toast({ title: '调整数量不能为 0', icon: 'none' })
      return
    }
    if (delta > 5000 || delta < -5000) {
      ui.toast({ title: '一次最多调整 5000 积分', icon: 'none' })
      return
    }
    const remark = String(page.data.adjustRemark || '').trim()
    if (!remark) {
      ui.toast({ title: '请填写调整原因', icon: 'none' })
      return
    }
    // 加/扣积分都是不可撤销的账目变动，统一过一次确认（不区分是否够扣，
    // 够不够扣写在文案里，避免弹两次框）。
    const shortage = delta < 0 && -delta > page.data.pickedPoints
    ui.confirm({
      title: shortage ? '积分不足，确认继续？' : '确认调整积分',
      content:
        page.data.pickedName + '：' + (delta > 0 ? '+' : '') + delta + ' 分' +
        (shortage
          ? '（当前只有 ' + page.data.pickedPoints + ' 分，扣减后会被置为 0）'
          : '') +
        '\n原因：' + remark,
      confirmText: shortage ? '继续扣减' : '确认调整',
      cancelText: '取消',
    }).then(function (ok) {
      if (!ok) return
      page.submitAdjust(uid, delta, remark)
    })
  },

  submitAdjust: function (uid, delta, remark) {
    const page = this
    page.setData({ adjusting: true, errorText: '' })
    ui.loading({ title: '调整中', mask: true })
    api
      .adminAdjustPoints(uid, delta, remark)
      .then(function (row) {
        ui.hideLoading()
        page.setData({
          adjusting: false,
          adjustDelta: '',
          adjustRemark: '',
          pickedPoints: row ? Number(row.points_after || 0) : page.data.pickedPoints,
          tipText: row
            ? '已调整：' + String(row.nickname || '') + ' ' + row.points_before + ' → ' + row.points_after
            : '已调整',
        })
        ui.toast({ title: '已调整', icon: 'success' })
        // 列表里的分数已经过期了，顺手刷一次
        return page.searchUsers()
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ adjusting: false, errorText: message })
        ui.toast({ title: message, icon: 'none', duration: 2500 })
      })
  },

  // ---- 兑换核销 ----

  onCodeInput: function (event) {
    // 兑换码是 8 位大写，用户复制过来可能带空格或小写，这里先规整再存
    const value = String(event.detail.value || '').toUpperCase().replace(/\s+/g, '')
    this.setData({ code: value, errorText: '', tipText: '' })
  },

  doVerify: function () {
    const page = this
    const code = String(page.data.code || '').trim()
    if (!code) {
      ui.toast({ title: '请输入兑换码', icon: 'none' })
      return
    }
    if (page.data.verifying) return
    page.setData({ verifying: true, errorText: '', tipText: '' })
    ui.loading({ title: '核销中', mask: true })
    api
      .adminVerifyRedemption(code)
      .then(function (row) {
        ui.hideLoading()
        page.setData({
          verifying: false,
          code: '',
          verifyResult: {
            code: String(row.code || code),
            goodsName: String(row.goods_name || ''),
            nickname: String(row.nickname || '同学'),
            cost: Number(row.cost || 0),
            usedAtText: api.formatTime(row.used_at),
          },
          tipText: '核销成功',
        })
        ui.toast({ title: '核销成功', icon: 'success' })
        return null
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ verifying: false, errorText: message, verifyResult: null })
        ui.toast({ title: message, icon: 'none', duration: 2500 })
      })
  },

  clearVerify: function () {
    this.setData({ verifyResult: null, code: '', errorText: '', tipText: '' })
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },

  // 从「我的」直接进来时没有上一页，退回不了就回「我的」，别卡在空白页
  goBack: function () {
    wx.navigateBack({
      fail: function () {
        wx.switchTab({ url: '/pages/mine/index' })
      },
    })
  },
})
