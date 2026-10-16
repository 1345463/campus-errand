const ui = require('../../utils/ui')
const api = require('../../utils/api')
const perms = require('../../utils/perms')
const flags = require('../../utils/flags')
const campus = require('../../utils/campus')
const services = require('../../utils/services')
const config = require('../../utils/config')

// 管理员批量发单（发单员 / 超级管理员，服务端 admin_batch_create_orders 里查 admin_has_perm('dispatch')）
//
// 场景：同一件事要发给一片宿舍——比如一批快递到了、通知类配送、整层都要送。
// 填一次任务内容，勾选「哪些楼层 × 哪些房间」，一笔操作生成 N 笔订单：
//   标题 / 内容 / 取件点 / 赏金 / 联系方式 全部相同，只有送达地址不同。
//
// 归属：批量单的 owner 就是当前操作的管理员本人（服务端写死 auth.uid()），
// 不做「代别人发单」——一旦能做，赏金和信誉分会记到别人头上，没法追溯。
//
// 上限：一次最多 50 笔（服务端硬拦）。楼层 14 层 × 房间 40 个 = 560 种组合，
// 所以前端必须实時算出目标数量并拦住，别让人点半天才发现提交失败。

const TABS = [
  { key: 'create', label: '批量发单' },
  { key: 'batches', label: '我发的批次' },
]

const MAX_TARGETS = 50
const GENDERS = ['不限', '限男生', '限女生']

function defaultRooms() {
  return campus.ROOMS.map(function (name) {
    return { name: name, on: false }
  })
}

function defaultFloors() {
  return campus.FLOORS.map(function (name) {
    return { name: name, on: false }
  })
}

Page({
  data: {
    tabs: TABS,
    tab: 'create',
    loading: true,
    needLogin: false,
    denied: false,
    grayOff: false,
    errorText: '',
    tipText: '',

    // ---- 表单 ----
    serviceNames: [],
    serviceIndex: 0,
    serviceType: 'express',
    serviceName: '取快递',
    title: '',
    description: '',
    pickupAddr: '',
    expectTime: '',
    contact: '',
    genderNames: GENDERS,
    genderIndex: 0,
    genderLimit: '不限',
    reward: '2',
    minReward: 1,
    maxReward: 200,

    // ---- 目标宿舍 ----
    buildingNames: [],
    buildingIndex: 0,
    floors: [],
    rooms: [],
    targetCount: 0,
    previewText: '',
    submitting: false,

    // ---- 我发的批次 ----
    batches: [],
  },

  onLoad: function () {
    this.setData({
      buildingNames: campus.BUILDINGS,
      floors: defaultFloors(),
      rooms: defaultRooms(),
      minReward: config.minReward,
      maxReward: config.maxReward,
      serviceNames: services.SERVICES.map(function (item) {
        return item.name
      }),
    })
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

  refresh: function () {
    if (this.data.tab === 'batches') return this.loadBatches()
    return Promise.resolve()
  },

  checkAndLoad: function () {
    const page = this
    page.setData({ loading: true, errorText: '' })
    return flags
      .ensure()
      .then(function () {
        if (!flags.on('admin_batch_order')) {
          page.setData({ grayOff: true, loading: false })
          return null
        }
        return api.getSession().then(function (session) {
          if (!session) {
            page.setData({ needLogin: true, loading: false })
            return null
          }
          return perms.load().then(function () {
            // 服务端只认 dispatch，super 在 admin_has_perm 里隐含通过
            if (!perms.has('dispatch') && !perms.has('super')) {
              page.setData({ denied: true, loading: false })
              return null
            }
            page.setData({ needLogin: false, denied: false, loading: false })
            return page.loadBatches()
          })
        })
      })
      .catch(function (error) {
        page.setData({ loading: false, errorText: api.getErrorMessage(error) })
      })
  },

  switchTab: function (event) {
    const key = event.currentTarget.dataset.key
    if (key === this.data.tab) return
    this.setData({ tab: key, errorText: '' })
    if (key === 'batches') this.loadBatches()
  },

  loadBatches: function () {
    const page = this
    return api
      .adminListDispatchOrders(50)
      .then(function (rows) {
        page.setData({
          batches: (rows || []).map(function (row) {
            return {
              batchNo: row.batch_no,
              title: row.sample_title || '批量任务',
              timeText: api.formatTime(row.created_at),
              total: row.total,
              pending: row.pending,
              doing: row.accepted,
              done: row.done,
              canceled: row.canceled,
              // 待接 + 已接还没完成，是管理员最关心的两个数
              runningText: '待接 ' + row.pending + ' · 进行中 ' + row.accepted,
              rewardText: '¥' + (Number(row.total_reward) || 0).toFixed(2),
              finishText: '已完成 ' + row.done + (row.canceled ? ' · 已取消 ' + row.canceled : ''),
            }
          }),
        })
        return null
      })
      .catch(function (error) {
        page.setData({ errorText: api.getErrorMessage(error) })
        return null
      })
  },

  // ---- 表单输入 ----

  onInput: function (event) {
    const key = event.currentTarget.dataset.key
    if (!key) return
    const patch = {}
    patch[key] = event.detail.value
    this.setData(patch)
  },

  pickService: function (event) {
    const index = Number(event.detail.value) || 0
    const item = services.SERVICES[index]
    if (!item) return
    this.setData({
      serviceIndex: index,
      serviceType: item.type,
      serviceName: item.name,
    })
  },

  pickBuilding: function (event) {
    const index = Number(event.detail.value) || 0
    this.setData({ buildingIndex: index })
    this.recalc()
  },

  pickGender: function (event) {
    const index = Number(event.detail.value) || 0
    this.setData({
      genderIndex: index,
      genderLimit: GENDERS[index] || '不限',
    })
  },

  // ---- 目标楼层 / 房间 ----

  toggleItem: function (event) {
    const group = event.currentTarget.dataset.group
    const index = Number(event.currentTarget.dataset.index)
    const list = group === 'room' ? this.data.rooms : this.data.floors
    if (index < 0 || index >= list.length) return
    const next = list.slice()
    next[index] = { name: list[index].name, on: !list[index].on }
    const patch = {}
    patch[group === 'room' ? 'rooms' : 'floors'] = next
    // setData 的回调是渲染完才跑的，这里要立刻重算组合数，
    // 所以单独 call recalc（page.data 在 setData 返回时已经是新值）
    this.setData(patch)
    this.recalc()
  },

  selectAll: function (event) {
    const group = event.currentTarget.dataset.group
    const on = event.currentTarget.dataset.on === 'true'
    const list = group === 'room' ? this.data.rooms : this.data.floors
    const patch = {}
    patch[group === 'room' ? 'rooms' : 'floors'] = list.map(function (item) {
      return { name: item.name, on: on }
    })
    this.setData(patch)
    this.recalc()
  },

  // 组合数是 楼层 × 房间，必须每次变动都重算：
  // 用户勾选到一半就能看到「这次会发 45 笔」，超了立刻拦，别等提交时才报错
  recalc: function () {
    const page = this
    const floors = page.data.floors.filter(function (item) {
      return item.on
    })
    const rooms = page.data.rooms.filter(function (item) {
      return item.on
    })
    const building = campus.BUILDINGS[page.data.buildingIndex]
    const count = floors.length * rooms.length
    let previewText = ''
    if (count > 0) {
      const samples = []
      for (let i = 0; i < floors.length && samples.length < 3; i += 1) {
        for (let j = 0; j < rooms.length && samples.length < 3; j += 1) {
          samples.push(floors[i].name + rooms[j].name)
        }
      }
      previewText = building + ' ' + samples.join('、') + (count > 3 ? ' 等' : '')
    }
    page.setData({ targetCount: count, previewText: previewText })
  },

  buildTargets: function () {
    const page = this
    const building = campus.BUILDINGS[page.data.buildingIndex]
    const floors = page.data.floors.filter(function (item) {
      return item.on
    })
    const rooms = page.data.rooms.filter(function (item) {
      return item.on
    })
    const targets = []
    floors.forEach(function (floor) {
      rooms.forEach(function (room) {
        targets.push({ building: building, floor: floor.name, room: room.name })
      })
    })
    return targets
  },

  // ---- 提交 ----

  submit: function () {
    const page = this
    if (page.data.submitting) return
    const d = page.data
    const title = String(d.title || '').trim()
    const description = String(d.description || '').trim()
    const pickupAddr = String(d.pickupAddr || '').trim()
    const contact = String(d.contact || '').trim()
    const reward = Number(d.reward)

    if (!title) return page.fail('任务标题还没填')
    if (!pickupAddr) return page.fail('取件 / 出发地址还没填')
    if (!contact) return page.fail('联系方式还没填，接单员拿到单联系不上你')
    if (!isFinite(reward) || reward < d.minReward) return page.fail('赏金最少 ' + d.minReward + ' 元')
    if (reward > d.maxReward) return page.fail('赏金最多 ' + d.maxReward + ' 元')

    const targets = page.buildTargets()
    if (!targets.length) return page.fail('还没有勾选要发到哪些宿舍')
    if (targets.length > MAX_TARGETS) return page.fail('一次最多发 ' + MAX_TARGETS + ' 笔，现在是 ' + targets.length + ' 笔，请减少楼层或房间')
    if (page.data.targetCount !== targets.length) return page.fail('目标数量对不上，请重新勾选')

    const summary = [
      '楼栋：' + targets[0].building,
      '目标：' + targets.length + ' 个宿舍',
      '赏金：每笔 ¥' + reward.toFixed(2) + '，合计 ¥' + (reward * targets.length).toFixed(2),
    ].join('\n')

    wx.showModal({
      title: '确认批量发布',
      content: summary,
      confirmText: '发布',
      success: function (res) {
        if (res.confirm) page.doSubmit(targets, {
          title: title,
          description: description,
          pickupAddr: pickupAddr,
          contact: contact,
          reward: reward,
        })
      },
    })
    return null
  },

  fail: function (message) {
    this.setData({ errorText: message })
    return null
  },

  doSubmit: function (targets, form) {
    const page = this
    page.setData({ submitting: true, errorText: '', tipText: '' })
    ui.loading({ title: '发布中', mask: true })
    return api
      .adminBatchCreateOrders({
        service_type: page.data.serviceType,
        service_name: page.data.serviceName,
        title: form.title,
        description: form.description,
        pickup_addr: form.pickupAddr,
        expect_time: page.data.expectTime,
        contact: form.contact,
        gender_limit: page.data.genderLimit,
        reward: form.reward,
        targets: targets,
      })
      .then(function (rows) {
        ui.hideLoading()
        const count = (rows || []).length
        page.setData({
          submitting: false,
          title: '',
          description: '',
          expectTime: '',
          rooms: defaultRooms(),
          floors: defaultFloors(),
          targetCount: 0,
          previewText: '',
          tipText: '已发布 ' + count + ' 笔订单',
          tab: 'batches',
        })
        ui.toast({ title: '已发布 ' + count + ' 笔', icon: 'success' })
        return page.loadBatches()
      })
      .catch(function (error) {
        ui.hideLoading()
        page.setData({ submitting: false, errorText: api.getErrorMessage(error) })
        return null
      })
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },
})
