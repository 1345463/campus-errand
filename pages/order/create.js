const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const services = require('../../utils/services')
const config = require('../../utils/config')
const moderation = require('../../utils/moderation')
const campus = require('../../utils/campus')
const flags = require('../../utils/flags')
const pay = require('../../utils/pay')

// 把「进取楼 · 5层 · 512号」拆成楼栋 / 楼层两个字段存进订单，
// 大厅的楼栋楼层筛选才能直接按字段过滤，不用对地址串做 LIKE。
// 不是标准宿舍格式（比如「南门快递柜」）就整段留空，避免脏数据混进筛选。
function roomParts(text) {
  const parts = String(text || '')
    .split('·')
    .map(function (item) {
      return String(item || '').trim()
    })
  const building = parts[0] || ''
  if (!building || campus.BUILDINGS.indexOf(building) < 0) return { building: '', floor: '' }
  return { building: building, floor: parts[1] || '' }
}

// 需要扫描的字段类型。reward 是数字、images 是图片路径，扫它们只会带来误判。
const TEXT_TYPES = { text: true, address: true, textarea: true, tags: true, gender: true }

// 这些 label 虽然也是 pickup_addr，但填的是宿舍房间号/窗口号，
// 挂一堆「校门口 / 食堂」的快捷标签只会干扰
const NO_SHORTCUT_LABELS = ['打印店', '宿舍地址', '排队地点', '搬出地址']

// 页面参数是 URL 编码态，直接展示会变成 %E5%A4%A7%E7%96%86 这种天书
function safeDecode(value) {
  if (value === null || value === undefined || value === '') return ''
  const text = String(value)
  try {
    return decodeURIComponent(text)
  } catch (e) {
    return text
  }
}

// 标题只由「服务名 + 去向」组成，**不要拿 description 当标题**。
// description 的占位符就写着「取餐码、外卖平台、姓名尾号」，而 title 会出现在
// 任务大厅，对所有已认证接单员可见 —— 等于把取餐码提前公开，别人能直接凭码取走。
// description 只在订单详情里给参与者看（服务端 get_order_detail 还有一道脱敏）。
function buildTitle(service, form) {
  const place = String(form.deliver_addr || form.pickup_addr || '').trim()
  if (place) return service.name + ' · ' + place
  return service.name
}

Page({
  data: {
    service: null,
    renderFields: [],
    form: {},
    previews: [],
    quickRewards: [2, 3, 5, 8, 10],
    minReward: config.minReward,
    maxReward: config.maxReward,

    // ---- 积分抵扣券（灰度 coupon_deduct）----
    couponOn: false,
    coupons: [],
    couponNames: ['不使用抵扣券'],
    couponIndex: 0,
    // ---- 优先展示券（灰度 order_boost）：下单时勾选，这一单在大厅置顶 ----
    boostOn: false,
    boosts: [],
    boostNames: ['不使用优先展示'],
    boostIndex: 0,
    submitting: false,
    maxImages: 5,
    signedIn: false,
    modHitMap: {},
    modBanner: '',
  },

  refreshModWords: function () {
    const page = this
    moderation
      .load()
      .then(function () {
        // 词库更新后，之前放行的内容可能现在违规了，重新扫一遍
        page.checkInputs()
      })
      .catch(function () {})
  },

  // 逐字段扫描当前输入。返回第一条命中的提示文案（没有违规返回 ''）
  checkInputs: function () {
    const page = this
    const form = page.data.form
    const fields = (page.data.service && page.data.service.fields) || []
    const hits = {}
    let firstMessage = ''
    fields.forEach(function (field) {
      if (!TEXT_TYPES[field.type]) return
      const raw = form[field.key]
      const value = Array.isArray(raw) ? raw.join(' ') : raw === undefined || raw === null ? '' : String(raw)
      const hit = moderation.scanText(value)
      if (!hit) return
      const message = moderation.hitMessage(hit)
      hits[field.key] = message
      if (!firstMessage) firstMessage = '「' + field.label + '」' + message
    })
    page.setData({ modHitMap: hits, modBanner: firstMessage })
    return firstMessage
  },

  onShow: function () {
    const page = this
    api
      .getSession()
      .then(function (session) {
        page._draftOwner = session && session.user ? String(session.user.id) : 'guest'
        page.setData({ signedIn: !!session })
        const draft = page._restoreDraft
        page._restoreDraft = null
        if (draft && (draft.owner === page._draftOwner || (draft.owner === 'guest' && draft.forLogin))) {
          page.setData({ form: Object.assign({}, page.data.form, draft.form), previews: draft.previews || [] })
          page._draftCoupon = draft.couponCode || ''
          page._draftBoost = draft.boostCode || ''
          page.syncRender()
          page.checkInputs()
        }
        page.loadWallet()
      })
      .catch(function () {
        page.setData({ signedIn: false })
      })
  },

  goLogin: function () {
    require('../../utils/login-return').goLogin()
  },

  onLoad: function (options) {
    const type = options.type || 'other'
    const service = services.findService(type)
    if (!service) {
      ui.toast({ title: '服务类型不存在', icon: 'none' })
      setTimeout(function () {
        wx.navigateBack()
      }, 1200)
      return
    }

    const form = {}
    service.fields.forEach(function (field) {
      if (field.type === 'tags') form[field.key] = []
      else if (field.type === 'images') form[field.key] = []
      else if (field.type === 'reward') form[field.key] = 2
      else form[field.key] = ''
    })
    if (options.item) form.description = service.name + '：' + safeDecode(options.item)
    // 积分商城「去使用」跳过来时会带上券码，loadWallet 拉完券包后自动选中
    this._presetCode = safeDecode(options.code)

    // 「我的地址」里设为常用的那条，直接回填
    const picked = ui.getStorage('pickedAddress')
    if (picked && (picked.building || picked.room)) {
      const text = [picked.building, picked.room].filter(Boolean).join(' · ')
      if (Object.prototype.hasOwnProperty.call(form, 'deliver_addr')) form.deliver_addr = text
      if (picked.contact && Object.prototype.hasOwnProperty.call(form, 'contact')) form.contact = picked.contact
    }

    const page = this
    page.setData({
      service: service,
      form: form,
      previews: [],
      maxImages: 5,
    })
    const draft = ui.getStorage('orderDraftV1')
    if (draft && draft.type === type && Date.now() - draft.at < 24 * 3600000) page._restoreDraft = draft
    page.syncRender()
    page.refreshModWords()
  },

  // 券包：抵扣券 + 优先展示券。两种券都能在下单时消耗，但走不同开关，
  // 所以各拉各的；从积分商城「去使用」跳过来会带 code，这里预先选中。
  loadWallet: function () {
    const page = this
    return flags
      .ensure()
      .then(function () {
        const couponOn = flags.on('coupon_deduct')
        const boostOn = flags.on('order_boost')
        if (!couponOn && !boostOn) {
          page.setData({
            couponOn: false,
            boostOn: false,
            coupons: [],
            boosts: [],
            couponIndex: 0,
            boostIndex: 0,
          })
          return null
        }
        page.setData({ couponOn: couponOn, boostOn: boostOn })
        return api
          .listMyCoupons()
          .then(function (rows) {
            const list = rows || []
            const usable = function (type) {
              return list.filter(function (row) {
                return row.status === 'unused' && row.benefit_type === type
              })
            }
            const coupons = couponOn ? usable('deduct') : []
            const boosts = boostOn ? usable('boost') : []
            const couponNames = ['不使用抵扣券'].concat(
              coupons.map(function (row) {
                return row.goods_name + '（抵 ¥' + row.deduct_value + '）'
              })
            )
            const boostNames = ['不使用优先展示'].concat(
              boosts.map(function (row) {
                return row.goods_name + '（这单大厅置顶）'
              })
            )
            page.setData({
              coupons: coupons,
              couponNames: couponNames,
              boosts: boosts,
              boostNames: boostNames,
            })
            if (page._draftCoupon) page.setData({ couponIndex: coupons.map(function (row) { return row.code }).indexOf(page._draftCoupon) + 1 })
            if (page._draftBoost) page.setData({ boostIndex: boosts.map(function (row) { return row.code }).indexOf(page._draftBoost) + 1 })
            page._draftCoupon = ''
            page._draftBoost = ''
            page.applyPresetCode()
            return null
          })
          .catch(function () {
            page.setData({
              coupons: [],
              couponNames: ['不使用抵扣券'],
              boosts: [],
              boostNames: ['不使用优先展示'],
              couponIndex: 0,
              boostIndex: 0,
            })
            return null
          })
      })
      .catch(function () {
        return null
      })
  },

  // 从「我的兑换码 → 去使用」带过来的券码，直接帮你选上
  applyPresetCode: function () {
    const want = this._presetCode
    if (!want) return
    this._presetCode = ''
    const find = function (list, code) {
      for (let i = 0; i < list.length; i += 1) {
        if (list[i].code === code) return i + 1
      }
      return 0
    }
    const patch = {}
    const ci = find(this.data.coupons, want)
    const bi = find(this.data.boosts, want)
    if (ci) patch.couponIndex = ci
    if (bi) patch.boostIndex = bi
    if (ci || bi) {
      const found = ci ? this.data.coupons[ci - 1] : this.data.boosts[bi - 1]
      this.setData(patch)
      ui.toast({ title: '已选中「' + found.goods_name + '」', icon: 'none' })
    } else {
      ui.toast({ title: '这张券已使用或已失效', icon: 'none' })
    }
  },

  pickCoupon: function (event) {
    const index = Number(event.detail.value) || 0
    this.setData({ couponIndex: index })
  },

  pickBoost: function (event) {
    const index = Number(event.detail.value) || 0
    this.setData({ boostIndex: index })
  },

  syncRender: function () {
    const form = this.data.form
    const shortcuts = config.pickupShortcuts || []
    const renderFields = this.data.service.fields.map(function (field) {
      const base = Object.assign({}, field)
      if (base.key === 'pickup_addr' && shortcuts.length && NO_SHORTCUT_LABELS.indexOf(base.label) < 0) {
        base.shortcuts = shortcuts
      }
      if (field.type === 'tags') {
        base.opts = (field.options || []).map(function (value) {
          return { value: value, active: (form[field.key] || []).indexOf(value) >= 0 }
        })
        return base
      }
      if (field.type === 'gender') {
        base.opts = ['不限', '限男生', '限女生'].map(function (value) {
          return { value: value, active: (form[field.key] || []).indexOf(value) >= 0 }
        })
        return base
      }
      return base
    })
    this.setData({ renderFields: renderFields })
  },

  // 常用取件点：手机打字选这些地点很烦，点一下直接回填
  pickShortcut: function (event) {
    const page = this
    const key = event.currentTarget.dataset.key
    const value = event.currentTarget.dataset.value
    if (!key || !value) return
    const patch = {}
    patch['form.' + key] = value
    page.setData(patch, function () {
      page.syncRender()
      page.checkInputs()
    })
  },

  onInput: function (event) {
    const page = this
    const key = event.currentTarget.dataset.key
    const patch = {}
    const value = key === 'reward' ? String(event.detail.value).replace(/[^\d.]/g, '').replace(/^(\d*\.?\d{0,2}).*$/, '$1') : event.detail.value
    patch['form.' + key] = value
    this.setData(patch, function () {
      page.checkInputs()
    })
  },

  saveDraft: function (forLogin) {
    if (!this.data.service) return
    const coupon = this.data.coupons[this.data.couponIndex - 1]
    const boost = this.data.boosts[this.data.boostIndex - 1]
    if (forLogin) this._loginHandoff = true
    ui.setStorage('orderDraftV1', { type: this.data.service.type, form: this.data.form,
      owner: this._draftOwner || 'guest', forLogin: !!this._loginHandoff,
      previews: this.data.previews, couponCode: coupon ? coupon.code : '',
      boostCode: boost ? boost.code : '', at: Date.now() })
  },

  onHide: function () { if (!this._published) this.saveDraft() },
  onUnload: function () { if (!this._published) this.saveDraft() },

  pickExpectTime: function (event) {
    const choices = ['越快越好', '30 分钟内', '1 小时内', '2 小时内', '今天内']
    this.setData({ 'form.expect_time': choices[Number(event.detail.value)] || choices[0] })
  },

  toggleTag: function (event) {
    const key = event.currentTarget.dataset.key
    const value = event.currentTarget.dataset.value
    const current = this.data.form[key] || []
    let next
    if (key === 'gender_limit') {
      next = [value]
    } else if (current.indexOf(value) >= 0) {
      next = current.filter(function (item) {
        return item !== value
      })
    } else {
      next = current.concat([value])
    }
    const patch = {}
    patch['form.' + key] = next
    const page = this
    this.setData(patch, function () {
      page.syncRender()
      page.checkInputs()
    })
  },

  // 三级选择器回填：楼栋 · 楼层 · 宿舍号
  onRoomChange: function (event) {
    const page = this
    const key = event.currentTarget.dataset.key
    if (!key) return
    const patch = {}
    patch['form.' + key] = event.detail.value
    this.setData(patch, function () {
      page.checkInputs()
    })
  },

  setReward: function (event) {
    const patch = {}
    patch['form.reward'] = event.currentTarget.dataset.value
    this.setData(patch)
  },

  chooseImage: function () {
    const page = this
    const remain = page.data.maxImages - page.data.previews.length
    if (remain <= 0) {
      ui.toast({ title: '最多上传 ' + page.data.maxImages + ' 张', icon: 'none' })
      return
    }
    if (!ui.available('chooseMedia')) {
      ui.toast({ title: '当前环境不支持选图，请在微信小程序里使用', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: function (res) {
        const files = (res.tempFiles || []).map(function (file) {
          return file.tempFilePath
        })
        if (!files.length) return
        ui.loading({ title: '上传中', mask: true })
        let pending = files.length
        files.forEach(function (tempPath) {
          api
            .uploadImage(tempPath, 'orders')
            .then(function (serverPath) {
              page.setData({
                previews: page.data.previews.concat([tempPath]),
                'form.images': page.data.form.images.concat([serverPath]),
              })
            })
            .catch(function (error) {
              guard.toastError(error)
            })
            .then(function () {
              pending -= 1
              if (pending <= 0) ui.hideLoading()
            })
        })
      },
    })
  },

  removeImage: function (event) {
    const index = event.currentTarget.dataset.index
    const previews = this.data.previews.slice()
    const images = this.data.form.images.slice()
    previews.splice(index, 1)
    images.splice(index, 1)
    this.setData({ previews: previews, 'form.images': images })
  },

  submit: function () {
    const page = this
    if (page.data.submitting) return

    // 提交前再扫一次：用户可能在最后一次输入之后又改了内容。
    // 服务端 create_order 还会再扫一次，这里是让用户当场就知道哪里不能填。
    const modMessage = page.checkInputs()
    if (modMessage) {
      ui.toast({ title: '内容包含不允许发布的信息，请修改后再发布', icon: 'none', duration: 2500 })
      return
    }

    const service = page.data.service
    const form = page.data.form
    const missing = []
    service.fields.forEach(function (field) {
      if (!field.required) return
      const value = form[field.key]
      if (typeof value === 'string' && value.trim() === '') missing.push(field.label)
      if (Array.isArray(value) && value.length === 0) missing.push(field.label)
      if (field.type === 'reward' && (!value || Number(value) <= 0)) missing.push(field.label)
    })
    if (missing.length) {
      ui.toast({ title: '请填写：' + missing[0], icon: 'none' })
      return
    }

    const reward = Number(form.reward)
    if (!reward || reward < config.minReward || reward > config.maxReward) {
      ui.toast({ title: '赏金需在 ' + config.minReward + ' - ' + config.maxReward + ' 元之间', icon: 'none' })
      return
    }

    if (!/^\d+(\.\d{1,2})?$/.test(String(form.reward))) {
      ui.toast({ title: '赏金最多保留两位小数', icon: 'none' })
      return
    }
    const contact = String(form.contact || '').trim()
    if (contact && !/^(1[3-9]\d{9}|[a-zA-Z][a-zA-Z0-9_-]{5,19})$/.test(contact)) {
      ui.toast({ title: '请填写正确的手机号或微信号', icon: 'none' })
      return
    }

    // 送达地址是宿舍的话顺手拆出楼栋楼层，大厅才能按楼栋筛
    const deliverParts = roomParts(form.deliver_addr)
    const pickupParts = roomParts(form.pickup_addr)
    const coupon = page.data.coupons[page.data.couponIndex - 1]
    const boost = page.data.boosts[page.data.boostIndex - 1]

    page.setData({ submitting: true })
    guard
      .ensureLogin()
      .then(function (ok) {
        if (!ok) return 'skip'
        // 发单前必须有手机号（R44）。服务端 orders 触发器也会拦，
        // 这里提前拦是为了不让用户填完一整张表单才被拒。
        return guard.requirePhone().then(function (phoneOk) {
          return phoneOk ? 'ok' : 'skip'
        })
      })
      .then(function (stage) {
        if (stage !== 'ok') {
          page.setData({ submitting: false })
          return null
        }
        // 没用户名不让发布：订单卡片、接单员看到的都是这个名字
        return api
          .getProfile()
          .then(function (profile) {
            if (guard.ensureNickname(profile)) {
              page.setData({ submitting: false })
              return null
            }
            return api.createOrder({
          service_type: service.type,
          service_name: service.name,
          title: buildTitle(service, form),
          description: form.description || '',
          pickup_addr: form.pickup_addr || '',
          deliver_addr: form.deliver_addr || '',
          expect_time: form.expect_time || '',
          contact: form.contact || '',
          images: form.images || [],
          tags: form.tags || [],
          gender_limit: (form.gender_limit && form.gender_limit[0]) || null,
          reward: reward,
          pickup_building: pickupParts.building,
          pickup_floor: pickupParts.floor,
          deliver_building: deliverParts.building,
          deliver_floor: deliverParts.floor,
              deduct_code: coupon ? coupon.code : '',
              boost_code: boost ? boost.code : '',
            })
          })
      })
      .then(function (created) {
        if (!created) return
        page._published = true
        ui.removeStorage('orderDraftV1')

        // 服务端已经按 pay_settings 总闸和抵扣券算好了：
        // 标成 unpaid 才需要付钱，抵满或总闸关着时直接是 paid。
        if (created.pay_status !== 'unpaid') {
          ui.toast({ title: '发布成功', icon: 'success' })
          setTimeout(function () {
            wx.switchTab({ url: '/pages/orders/list' })
          }, 900)
          return
        }
        return page.payAndFinish(created)
      })
      .catch(function (error) {
        page.setData({ submitting: false })
        guard.toastError(error)
      })
  },

  // 赏金先付到平台，任务才进大厅；完成后由系统结算给接单员。
  // 付不付得成都不影响订单本身 —— 没付的单留在「我发布的」里，随时可以补付。
  payAndFinish: function (order) {
    const page = this
    const amount = pay.payableOf(order)
    return ui
      .confirm({
        title: '支付赏金',
        content:
          '发布任务需先支付赏金 ¥' + amount +
          '（抵扣后应付）。任务完成后平台再结算给接单员。',
        confirmText: '去支付',
        cancelText: '稍后再付',
        defaultConfirm: true,
      })
      .then(function (go) {
        if (!go) {
          page.setData({ submitting: false })
          ui.toast({
            title: '任务已保存为待付款，可在「我发布的」里继续支付',
            icon: 'none',
            duration: 2600,
          })
          setTimeout(function () {
            wx.switchTab({ url: '/pages/orders/list' })
          }, 900)
          return null
        }
        return pay.payOrder(order)
      })
      .then(function (result) {
        if (!result) return
        page.setData({ submitting: false })
        if (result.paid) {
          ui.toast({ title: '支付成功，任务已发布', icon: 'success' })
        } else {
          // 钱已扣、回调还没到。说「失败」会让用户以为没扣款，说「成功」又不严谨
          ui.toast({
            title: '已收到支付，正在确认，稍后可在订单里刷新查看',
            icon: 'none',
            duration: 2600,
          })
        }
        setTimeout(function () {
          wx.switchTab({ url: '/pages/orders/list' })
        }, 900)
      })
      .catch(function (error) {
        page.setData({ submitting: false })
        if (error && error.cancelled) {
          ui.toast({
            title: '支付已取消，任务已保存为待付款',
            icon: 'none',
            duration: 2400,
          })
          setTimeout(function () {
            wx.switchTab({ url: '/pages/orders/list' })
          }, 900)
          return
        }
        guard.toastError(error)
      })
  },
})
