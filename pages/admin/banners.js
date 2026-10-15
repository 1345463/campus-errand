const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const perms = require('../../utils/perms')
const flags = require('../../utils/flags')
const services = require('../../utils/services')

// 首页轮播管理（只有超级管理员能进，服务端 admin_*_banner 里也各查一次 admin_has_perm('super')）。
//
// 轮播是用户进小程序第一眼看到的东西，配错了影响面是全体用户，所以页面上有三处刻意的「慢一拍」：
//   1) 新建后 enabled 默认 false —— 先配好、先自己看一眼，确认无误再手动上架；
//   2) 删除是真删、没有回收站 —— 必须页内二次点击确认（4 秒自动解除），不用 wx.showModal；
//   3) 图片必须走 uploadImage(path, 'banner') —— 服务端按 scope='banner' 放行游客读取，
//      传成别的 folder 会让游客（未登录用户）看不到图，而首页恰恰是游客也能进的页面。

// 跳转类型：服务端 admin_create_banner 只认这三个值，前端 chip 与之对齐
const LINK_TYPES = [
  { key: 'none', label: '不跳转' },
  { key: 'service', label: '服务' },
  { key: 'url', label: '外链' },
]

// 跳转类型 → 中文，列表里直接用
const LINK_LABELS = {}
LINK_TYPES.forEach(function (item) {
  LINK_LABELS[item.key] = item.label
})

// 服务跳转的可选值直接取 utils/services.js，避免后台和下单页各写一份、慢慢对不上
const SERVICE_OPTIONS = services.SERVICES.map(function (item) {
  return { value: item.type, label: item.name }
})

const SERVICE_LABELS = {}
SERVICE_OPTIONS.forEach(function (item) {
  SERVICE_LABELS[item.value] = item.label
})

// 服务类型 → 中文，找不到就原样显示（以后新增服务时后台不至于显示空）
function serviceLabel(value) {
  return SERVICE_LABELS[value] || value
}

Page({
  data: {
    list: [],
    loading: false,
    needLogin: false,
    denied: false,
    errorText: '',
    tipText: '',
    // 灰度开关 home_banner：关着的时候就算上架了用户端也看不到，这里显式提醒
    flagOn: true,

    // 新增表单
    newOpen: false,
    newTitle: '',
    newImage: '',
    newPreview: '',
    uploading: false,
    newLinkType: 'none',
    newLinkValue: '',
    newSort: '0',
    linkTypes: LINK_TYPES,
    serviceOptions: SERVICE_OPTIONS,

    // 改排序：点开输入框才写库，避免输一半就提交
    sortId: 0,
    sortValue: '',
    // 删除二次点击确认：记录「已上膛」的那一条
    delArmId: 0,
    actingId: 0,
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

  onUnload: function () {
    // 页面销毁时清掉上膛计时器，避免回调打在已经不存在的页面上
    if (this._armTimer) {
      clearTimeout(this._armTimer)
      this._armTimer = null
    }
  },

  checkAndLoad: function () {
    const page = this
    return api
      .getSession()
      .then(function (session) {
        if (!session) {
          page.setData({ needLogin: true, loading: false, list: [], denied: false })
          return
        }
        // 轮播是全站可见的运营位，只放开给 super
        return perms.load().then(function () {
          if (!perms.has('super')) {
            page.setData({ denied: true, loading: false, list: [] })
            return
          }
          page.setData({ needLogin: false, denied: false })
          // 开关只是提示用：关着也允许配，免得想提前配好内容时被卡住
          return flags.ensure().then(function () {
            page.setData({ flagOn: flags.on('home_banner') })
            return page.load()
          })
        })
      })
      .catch(function (error) {
        page.setData({ loading: false, errorText: api.getErrorMessage(error) })
      })
  },

  load: function () {
    const page = this
    page.setData({ loading: true, errorText: '', sortId: 0, delArmId: 0, actingId: 0 })
    return api
      .adminListBanners()
      .then(function (rows) {
        const list = rows.map(function (row) {
          const linkType = String(row.link_type || 'none')
          const linkValue = String(row.link_value || '')
          // 列表里「跳转」这一行直接给中文：服务显示服务名，外链显示地址本身
          const jumpText =
            linkType === 'service'
              ? '服务 · ' + serviceLabel(linkValue)
              : linkType === 'url'
              ? '外链 · ' + linkValue
              : '不跳转'
          return {
            id: row.id,
            title: String(row.title || '（未填标题）'),
            imagePath: String(row.image_path || ''),
            thumb: '',
            thumbError: '',
            linkType: linkType,
            linkValue: linkValue,
            jumpText: jumpText,
            sortOrder: Number(row.sort_order || 0),
            enabled: !!row.enabled,
            updatedText: api.formatTime(row.updated_at || row.created_at),
          }
        })
        page.setData({ list: list, loading: false })
        page.loadThumbs(list)
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ loading: false, list: [], errorText: message })
        if (typeof console !== 'undefined' && console.error) console.error('[admin/banners] list failed:', message, error)
        ui.toast({ title: message, icon: 'none', duration: 2500 })
      })
  },

  // 缩略图逐条取、逐条回填：
  // 一次性把所有图塞进 setData 时，兜底的 data URL 有体积膨胀，容易撞上单次 setData 1MB 上限；
  // 分开写既绕开上限，也让先回来的图先显示。
  loadThumbs: function (list) {
    const page = this
    list.forEach(function (item, index) {
      if (!item.imagePath) return
      api
        .getSignedUrls([item.imagePath])
        .then(function (rows) {
          const first = rows && rows[0]
          const patch = {}
          // 索引可能因为刷新已经错位，对一下 id 再写，防止把图贴到别的行上
          const current = page.data.list[index]
          if (!current || current.id !== item.id) return
          if (first && first.url) {
            patch['list[' + index + '].thumb'] = first.url
            patch['list[' + index + '].thumbError'] = ''
          } else {
            patch['list[' + index + '].thumbError'] = (first && first.error) || '图片加载失败'
          }
          page.setData(patch)
        })
        .catch(function (error) {
          const patch = {}
          patch['list[' + index + '].thumbError'] = api.getErrorMessage(error)
          page.setData(patch)
        })
    })
  },

  openNew: function () {
    this.setData({
      newOpen: true,
      newTitle: '',
      newImage: '',
      newPreview: '',
      newLinkType: 'none',
      newLinkValue: '',
      newSort: '0',
      tipText: '',
      errorText: '',
    })
  },

  closeNew: function () {
    this.setData({
      newOpen: false,
      newTitle: '',
      newImage: '',
      newPreview: '',
      newLinkType: 'none',
      newLinkValue: '',
      newSort: '0',
    })
  },

  // 表单输入统一走这一个方法，data-key 指明写回哪个字段
  onInput: function (event) {
    const key = event.currentTarget.dataset.key
    const patch = {}
    patch[key] = event.detail.value
    this.setData(patch)
  },

  pickLinkType: function (event) {
    const page = this
    const key = String(event.currentTarget.dataset.key || 'none')
    const patch = { newLinkType: key }
    // 切类型时清掉旧值：留着上一次填的外链，很容易出现「显示不跳转、实际存着跳转」
    if (key !== page.data.newLinkType) patch.newLinkValue = ''
    page.setData(patch)
  },

  // 服务类型用 chip 点选，比手打 type 不容易写错
  pickService: function (event) {
    const value = String(event.currentTarget.dataset.value || '')
    this.setData({ newLinkValue: value })
  },

  // 选图：folder 必须是 'banner'，否则游客读不到这张图（见文件头部说明）
  chooseImage: function () {
    const page = this
    if (!ui.available('chooseMedia')) {
      ui.toast({ title: '当前环境不支持选图，请在微信小程序里使用', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: function (res) {
        const files = res.tempFiles || []
        if (!files.length) return
        const tempPath = files[0].tempFilePath
        page.setData({ uploading: true })
        api
          .uploadImage(tempPath, 'banner')
          .then(function (imagePath) {
            page.setData({ uploading: false, newImage: imagePath, newPreview: tempPath })
            ui.toast({ title: '图片已上传', icon: 'success' })
          })
          .catch(function (error) {
            page.setData({ uploading: false })
            const message = api.getErrorMessage(error)
            page.setData({ errorText: message })
            guard.toastError(error)
          })
      },
    })
  },

  createBanner: function () {
    const page = this
    const title = String(page.data.newTitle || '').trim()
    const imagePath = String(page.data.newImage || '').trim()
    const linkType = String(page.data.newLinkType || 'none')
    const sortText = String(page.data.newSort || '').trim()
    const sortOrder = sortText === '' ? 0 : parseInt(sortText, 10)

    let linkValue = String(page.data.newLinkValue || '').trim()

    if (!imagePath) {
      ui.toast({ title: '请先上传轮播图片', icon: 'none' })
      return
    }
    // none 一律置空：服务端不会替你清，留着旧值就是隐患
    if (linkType === 'none') linkValue = ''
    if (linkType === 'service' && !linkValue) {
      ui.toast({ title: '请选择要跳转的服务', icon: 'none' })
      return
    }
    if (linkType === 'url') {
      if (!linkValue) {
        ui.toast({ title: '请填写外链地址', icon: 'none' })
        return
      }
      // 只放 http(s)：小程序的 webview 和跳转都认这个，别的协议放上去点了没反应
      if (!/^https?:\/\//i.test(linkValue)) {
        ui.toast({ title: '外链要以 http:// 或 https:// 开头', icon: 'none' })
        return
      }
    }
    if (!isFinite(sortOrder) || sortOrder < 0) {
      ui.toast({ title: '排序号要是不小于 0 的整数', icon: 'none' })
      return
    }

    ui.loading({ title: '新增中', mask: true })
    api
      .adminCreateBanner({
        title: title,
        image_path: imagePath,
        link_type: linkType,
        link_value: linkValue,
        sort_order: sortOrder,
      })
      .then(function () {
        ui.hideLoading()
        page.setData({
          newOpen: false,
          newTitle: '',
          newImage: '',
          newPreview: '',
          newLinkType: 'none',
          newLinkValue: '',
          newSort: '0',
          errorText: '',
          // 明确告知默认不上架，别让人以为没生效
          tipText: '已新增，默认不上架 —— 确认图片和跳转没问题后，再点「上架」',
        })
        ui.toast({ title: '已新增（未上架）', icon: 'success' })
        return page.load()
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ errorText: message, tipText: '' })
        ui.toast({ title: message, icon: 'none', duration: 2500 })
      })
  },

  // 上架 / 下架：只改 enabled，不动其它字段（patch 里不传的字段服务端视为不改）
  toggleEnabled: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id)
    const enabled = String(event.currentTarget.dataset.enabled) !== 'true'
    page.setData({ actingId: id })
    ui.loading({ title: enabled ? '上架中' : '下架中', mask: true })
    api
      .adminUpdateBanner(id, { enabled: enabled })
      .then(function () {
        ui.hideLoading()
        ui.toast({
          title: enabled ? '已上架，用户端可见' : '已下架，用户端不再显示',
          icon: 'success',
        })
        return page.load()
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ actingId: 0, errorText: message })
        ui.toast({ title: message, icon: 'none', duration: 2500 })
      })
  },

  openSort: function (event) {
    const id = Number(event.currentTarget.dataset.id)
    const row = this.data.list.filter(function (item) {
      return item.id === id
    })[0]
    if (!row) return
    // 同一时刻只改一条，避免两个输入框同时对一份列表做索引写入
    this.setData({ sortId: id, sortValue: String(row.sortOrder), delArmId: 0 })
  },

  closeSort: function () {
    this.setData({ sortId: 0, sortValue: '' })
  },

  saveSort: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id)
    const raw = String(page.data.sortValue || '').trim()
    const sortOrder = raw === '' ? 0 : parseInt(raw, 10)

    if (!isFinite(sortOrder) || sortOrder < 0) {
      ui.toast({ title: '排序号要是不小于 0 的整数', icon: 'none' })
      return
    }

    page.setData({ actingId: id })
    ui.loading({ title: '保存中', mask: true })
    api
      .adminUpdateBanner(id, { sort_order: sortOrder })
      .then(function () {
        ui.hideLoading()
        page.setData({ sortId: 0, sortValue: '', tipText: '排序已保存，数字越小越靠前' })
        ui.toast({ title: '已保存', icon: 'success' })
        return page.load()
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ actingId: 0, errorText: message })
        ui.toast({ title: message, icon: 'none', duration: 2500 })
      })
  },

  // 删除：第一次点上膛，4 秒内再点一次才真删（真删不可恢复，服务端没有软删）
  askDelete: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id)

    if (page.data.delArmId === id) {
      page.clearArm()
      page.doDelete(id)
      return
    }

    if (page._armTimer) clearTimeout(page._armTimer)
    page.setData({ delArmId: id, sortId: 0 })
    page._armTimer = setTimeout(function () {
      page._armTimer = null
      if (page.data.delArmId === id) page.setData({ delArmId: 0 })
    }, 4000)
  },

  clearArm: function () {
    const page = this
    if (page._armTimer) {
      clearTimeout(page._armTimer)
      page._armTimer = null
    }
    page.setData({ delArmId: 0 })
  },

  cancelDelete: function () {
    this.clearArm()
  },

  doDelete: function (id) {
    const page = this
    page.setData({ actingId: id })
    ui.loading({ title: '删除中', mask: true })
    api
      .adminDeleteBanner(id)
      .then(function () {
        ui.hideLoading()
        ui.toast({ title: '已删除，不可恢复', icon: 'success' })
        page.setData({ delArmId: 0, actingId: 0, tipText: '' })
        return page.load()
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ actingId: 0, errorText: message })
        ui.toast({ title: message, icon: 'none', duration: 2500 })
      })
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
