const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const flags = require('../../utils/flags')

// 状态 → 中文文案 + 色块 class。色块样式写在本页 wxss 里，不污染 app.wxss
const STATUS_META = {
  pending: { text: '待审核', cls: 'st-pending', hint: '我们会在 1-2 个工作日内完成审核，请耐心等待' },
  approved: { text: '已通过', cls: 'st-approved', hint: '你已是认证接单员，可以去大厅接单了' },
  rejected: { text: '未通过', cls: 'st-rejected', hint: '请根据下面的驳回原因修改资料后重新提交' },
  none: { text: '未提交', cls: 'st-none', hint: '完成实名认证后才能接单' },
}

function metaOf(status) {
  return STATUS_META[status] || STATUS_META.none
}

Page({
  data: {
    grayOff: false,
    needLogin: false,
    loading: true,
    submitted: false,
    realName: '',
    idNoMasked: '',
    createdText: '',
    status: 'none',
    statusText: '未提交',
    statusClass: 'st-none',
    statusHint: '',
    reviewNote: '',
    docs: [],
    docsLoading: false,
    previewUrl: '',
    errorText: '',
    tipText: '',
  },

  onLoad: function () {
    this.checkAndLoad()
  },

  onPullDownRefresh: function () {
    const page = this
    page
      .checkAndLoad()
      .then(function () {
        wx.stopPullDownRefresh()
      })
      .catch(function () {
        wx.stopPullDownRefresh()
      })
  },

  checkAndLoad: function () {
    const page = this
    page.setData({ loading: true, errorText: '', tipText: '' })
    return flags
      .ensure()
      .then(function () {
        // 灰度没开就到此为止：不拉数据、不暴露任何认证信息
        if (!flags.on('cert_status')) {
          page.setData({ grayOff: true, loading: false })
          return null
        }
        return api.getSession().then(function (session) {
          if (!session) {
            page.setData({ grayOff: false, needLogin: true, loading: false })
            return null
          }
          page.setData({ grayOff: false, needLogin: false })
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
    // 申请记录 RLS 只允许本人读，未登录时服务端返回空，这里统一按「未提交」处理
    return api
      .getApplication()
      .then(function (app) {
        if (!app) {
          const meta = metaOf('none')
          page.setData({
            loading: false,
            submitted: false,
            status: 'none',
            statusText: meta.text,
            statusClass: meta.cls,
            statusHint: meta.hint,
            docs: [],
          })
          return null
        }
        const meta = metaOf(app.status)
        page.setData({
          loading: false,
          submitted: true,
          realName: app.real_name || '',
          // 库里存的就是脱敏号（前 6 + ******** + 后 4），直接展示，不再本地加工
          idNoMasked: app.id_no_masked || '',
          createdText: api.formatTime(app.created_at),
          status: app.status || 'pending',
          statusText: meta.text,
          statusClass: meta.cls,
          statusHint: meta.hint,
          reviewNote: app.review_note || '',
        })
        return page.loadDocs(app)
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ loading: false, errorText: message })
        guard.toastError(error)
      })
  },

  // 证件图存的是 storage 路径，必须换成带签名的临时链接才能显示
  loadDocs: function (app) {
    const page = this
    const paths = []
    const meta = []
    if (app.student_card_path) {
      paths.push(app.student_card_path)
      meta.push({ key: 'student', title: '学生证照片' })
    }
    if (app.id_card_path) {
      paths.push(app.id_card_path)
      meta.push({ key: 'idcard', title: '身份证正面' })
    }
    if (!paths.length) {
      page.setData({ docs: [], docsLoading: false })
      return Promise.resolve()
    }
    page.setData({ docsLoading: true })
    return api
      .getSignedUrls(paths)
      .then(function (rows) {
        const docs = meta.map(function (item, index) {
          const got = rows && rows[index]
          return {
            key: item.key,
            title: item.title,
            url: (got && got.url) || '',
            // 失败原因原样带出来：旧上传通道存的图服务端已经取不回，
            // 得让用户重传，而不是让他对着「加载失败」四个字反复点
            error: (got && got.error) || (got && got.url ? '' : '服务端没有返回链接'),
            legacy: !!(got && got.legacy),
            signError: (got && got.signError) || '',
          }
        })
        // 走了直读兜底的话，把签名接口的原始报错留在页面上，方便继续排查
        const signed = docs.filter(function (item) {
          return item.url && item.signError
        })
        page.setData({
          docs: docs,
          docsLoading: false,
          tipText: signed.length ? '签名链接不可用，已用直读方式显示（' + signed[0].signError + '）' : '',
        })
        return null
      })
      .catch(function (error) {
        page.setData({ docsLoading: false, docs: [] })
        const message = api.getErrorMessage(error)
        page.setData({ errorText: '证件加载失败：' + message })
        guard.toastError(error)
      })
  },

  previewDoc: function (event) {
    const page = this
    const index = Number(event.currentTarget.dataset.index)
    const doc = page.data.docs[index]
    if (!doc || !doc.url) {
      ui.toast({ title: '这张证件暂时无法显示', icon: 'none' })
      return
    }
    // data URL 进不了 previewImage，只能在页面内铺一层看
    const isData = /^data:/i.test(doc.url)
    if (!isData && ui.available('previewImage')) {
      wx.previewImage({ current: doc.url, urls: [doc.url] })
      return
    }
    page.setData({ previewUrl: doc.url })
  },

  closePreview: function () {
    this.setData({ previewUrl: '' })
  },

  retry: function () {
    this.checkAndLoad()
  },

  goApply: function () {
    wx.navigateTo({ url: '/pages/mine/apply' })
  },

  goMine: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },
})
