const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')

const TABS = [
  { key: 'pending', label: '待审核' },
  { key: 'approved', label: '已通过' },
  { key: 'rejected', label: '已驳回' },
  { key: 'all', label: '全部' },
]

const STATUS_TEXT = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已驳回',
}

Page({
  data: {
    tabs: TABS,
    tab: 'pending',
    list: [],
    loading: false,
    needLogin: false,
    denied: false,
    actingId: 0,
    armId: 0,
    noteId: 0,
    note: '',
    previewUrl: '',
    errorText: '',
    tipText: '',
  },

  onLoad: function () {
    this.checkAndLoad()
  },

  onPullDownRefresh: function () {
    const page = this
    this.load().then(function () {
      wx.stopPullDownRefresh()
    }).catch(function () {
      wx.stopPullDownRefresh()
    })
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
        page.setData({ loading: false })
        guard.toastError(error)
      })
  },

  load: function () {
    const page = this
    page.setData({ loading: true, errorText: '' })
    return api
      .listApplications(page.data.tab)
      .then(function (rows) {
        const list = rows.map(function (item) {
          // 证件图是 storage 路径，需要换成带签名的临时链接才能显示
          return {
            id: item.id,
            ownerId: String(item.owner_id || '').slice(-6),
            nickname: item.nickname || '未设置昵称',
            realName: item.real_name || '',
            idNoMasked: item.id_no_masked || '',
            studentCard: item.student_card_path || '',
            idCard: item.id_card_path || '',
            status: item.status,
            statusText: STATUS_TEXT[item.status] || item.status,
            createdText: api.formatTime(item.created_at),
            studentUrl: '',
            idUrl: '',
          }
        })
        page.setData({ list: list, loading: false, errorText: '' })
      })
      .catch(function (error) {
        // 列表失败不要把原因吞掉：既弹 toast，也在页面里留一条可见的错误条
        const message = api.getErrorMessage(error)
        page.setData({ loading: false, list: [], errorText: message })
        if (typeof console !== 'undefined' && console.error) console.error('[admin/review] list failed:', message, error)
        guard.toastError(error)
      })
  },

  switchTab: function (event) {
    const page = this
    if (page._armTimer) {
      clearTimeout(page._armTimer)
      page._armTimer = null
    }
    this.setData({ tab: event.currentTarget.dataset.key, noteId: 0, note: '', tipText: '', armId: 0 }, function () {
      page.load()
    })
  },

  retry: function () {
    this.checkAndLoad()
  },

  // 点「查看证件」时才生成签名链接，避免列表一次性拉一堆图片
  viewDoc: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id)
    const kind = event.currentTarget.dataset.kind
    const row = page.data.list.filter(function (item) {
      return item.id === id
    })[0]
    if (!row) return
    const path = kind === 'id' ? row.idCard : row.studentCard
    if (!path) {
      ui.toast({ title: '该同学没有上传这张证件', icon: 'none' })
      return
    }
    ui.loading({ title: '加载中', mask: true })
    api
      .getSignedUrls([path])
      .then(function (rows) {
        ui.hideLoading()
        const item = rows && rows[0]
        const url = item && item.url
        if (!url) {
          // 不要把原因吞掉：页面上留一条可见的错误条，日志里留全文
          const reason = (item && item.error) || '服务端没有返回链接'
          // 旧通道的照片重试多少次都一样，文案直接指向「让用户重传」，
          // toast 只放短句，技术细节留给页面上的错误条。
          const legacy = !!(item && item.legacy)
          page.setData({
            errorText: legacy ? reason : '证件加载失败：' + reason,
          })
          ui.toast({
            title: legacy ? '照片已不可读，请让用户重新提交证件' : '证件加载失败',
            icon: 'none',
          })
          if (typeof console !== 'undefined' && console.error) {
            console.error('[admin/review] load image failed:', reason, '| path =', path)
          }
          return
        }
        // 走了直读兜底的话，把签名接口的原始报错留在页面上，方便继续排查
        page.setData({
          errorText: '',
          tipText: item.signError ? '签名链接不可用，已用直读方式显示（' + item.signError + '）' : '',
        })
        // data URL 不能进 previewImage；签名链接和本地临时文件都可以
        const isRemote = !/^data:/i.test(url)
        if (isRemote && ui.available('previewImage')) {
          wx.previewImage({ current: url, urls: [url] })
        } else {
          page.setData({ previewUrl: url })
        }
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ errorText: '证件加载失败：' + message })
        guard.toastError(error)
      })
  },

  closePreview: function () {
    this.setData({ previewUrl: '' })
  },

  openNote: function (event) {
    const id = Number(event.currentTarget.dataset.id)
    this.setData({ noteId: id, note: '' })
  },

  cancelNote: function () {
    this.setData({ noteId: 0, note: '' })
  },

  onNoteInput: function (event) {
    this.setData({ note: event.detail.value })
  },

  doReview: function (id, approve, note) {
    const page = this
    if (page.data.actingId) return
    page.setData({ actingId: id })
    ui.loading({ title: '提交中', mask: true })
    api
      .reviewApplication(id, approve, note)
      .then(function () {
        ui.hideLoading()
        page.setData({ actingId: 0, noteId: 0, note: '', armId: 0 })
        ui.toast({ title: approve ? '已通过' : '已驳回', icon: 'success' })
        return page.load()
      })
      .catch(function (error) {
        ui.hideLoading()
        page.setData({ actingId: 0 })
        guard.toastError(error)
      })
  },

  // 通过认证同样改成页面内二次点击，不依赖 wx.showModal 的回调结果
  approve: function (event) {
    const page = this
    const id = Number(event.currentTarget.dataset.id)
    if (page.data.actingId) return
    if (page.data.armId !== id) {
      if (page._armTimer) clearTimeout(page._armTimer)
      page.setData({ armId: id, tipText: '' })
      page._armTimer = setTimeout(function () {
        page._armTimer = null
        if (page.data.armId === id) page.setData({ armId: 0 })
      }, 4000)
      return
    }
    if (page._armTimer) {
      clearTimeout(page._armTimer)
      page._armTimer = null
    }
    page.setData({ armId: 0 })
    page.doReview(id, true, '')
  },

  reject: function (event) {
    const id = Number(event.currentTarget.dataset.id)
    const note = String(this.data.note || '').trim()
    if (!note) {
      ui.toast({ title: '请填写驳回原因，方便同学修改后重新提交', icon: 'none' })
      return
    }
    this.doReview(id, false, note)
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },

  // 调试入口：没人提交申请时，管理员自己造一条走通审核流程。
  // 注意：插入成功就立刻在页面里留可见提示，哪怕随后刷新列表失败也不会「像没反应」。
  makeDemo: function () {
    const page = this
    if (page.data.actingId) return
    page.setData({ actingId: -1, errorText: '', tipText: '' })
    ui.loading({ title: '生成中', mask: true })
    api
      .insertDemoApplication('测试同学')
      .then(function () {
        ui.hideLoading()
        ui.toast({ title: '已生成测试申请', icon: 'success' })
        page.setData({ actingId: 0, tab: 'pending', tipText: '已生成一条测试申请' })
        return page.load().catch(function () {
          return null
        })
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        if (typeof console !== 'undefined' && console.error) console.error('[admin/review] demo failed:', message, error)
        page.setData({ actingId: 0, errorText: '生成失败：' + message })
        ui.toast({ title: '生成失败：' + message, icon: 'none' })
      })
  },
})
