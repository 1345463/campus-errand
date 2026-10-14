const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')

// 认证状态 → 页面顶部展示的文案
const CERT_TEXT = { none: '未提交', pending: '审核中', approved: '已通过', rejected: '未通过' }

// 认证状态 → 进度卡片的副标题。状态说明只写在这里一处，
// 页面不再另起卡片重复讲一遍状态，避免和二级页/入口卡互相重复。
const CERT_HINT = {
  pending: '申请已提交，1-2 个工作日内完成审核，通过后即可在大厅接单',
  approved: '你已经是认证接单员，可以在大厅查看并接单了',
  rejected: '上次审核未通过，点这里看原因',
}

// 只保留前 6 位和后 4 位，其余用 * 代替，完整号码不落库
function maskIdNo(value) {
  const id = String(value || '').trim()
  if (id.length < 10) return '****'
  return id.slice(0, 6) + '********' + id.slice(-4)
}

Page({
  data: {
    realName: '',
    idNo: '',
    studentCard: '',
    studentPreview: '',
    idCard: '',
    idPreview: '',
    submitting: false,
    rejectNote: '',
    canPickImage: true,
    // ---- 认证状态（认证进度已收进本页，作为二级页面）----
    certStatus: 'none',
    certText: '未提交',
    statusHint: '查看审核状态、提交资料与驳回原因',
    // 审核中 / 已通过时不再展示申请表单，避免重复提交造成误解
    showForm: true,
  },

  onLoad: function () {
    const page = this
    if (!ui.available('chooseMedia')) page.setData({ canPickImage: false })
    // 被驳回过的话，把管理员写的驳回原因带出来，同学知道改哪里
    api
      .getApplication()
      .then(function (app) {
        if (app && app.status === 'rejected' && app.review_note) {
          page.setData({ rejectNote: app.review_note })
        }
      })
      .catch(function () {
        /* 加载失败不影响填写 */
      })

    api
      .getProfile()
      .then(function (profile) {
        const status = (profile && profile.cert_status) || 'none'
        page.setData({
          certStatus: status,
          certText: CERT_TEXT[status] || '未提交',
          statusHint: CERT_HINT[status] || '查看审核状态、提交资料与驳回原因',
          showForm: status !== 'pending' && status !== 'approved',
        })
        return null
      })
      .catch(function () {
        return null
      })
  },

  // 认证进度是本页的二级页面：状态、提交资料、驳回原因都在那边
  goCert: function () {
    wx.navigateTo({ url: '/pages/mine/cert' })
  },

  onName: function (event) {
    this.setData({ realName: event.detail.value })
  },

  onIdNo: function (event) {
    this.setData({ idNo: event.detail.value })
  },

  pickImage: function (folder, onDone) {
    if (!ui.available('chooseMedia')) {
      ui.toast({ title: '当前环境不支持选图，请在微信小程序里使用', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: function (res) {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file) return
        ui.loading({ title: '上传中', mask: true })
        api
          .uploadImage(file.tempFilePath, folder)
          .then(function (serverPath) {
            ui.hideLoading()
            onDone(serverPath, file.tempFilePath)
          })
          .catch(function (error) {
            ui.hideLoading()
            guard.toastError(error)
          })
      },
    })
  },

  chooseStudent: function () {
    const page = this
    this.pickImage('certs', function (serverPath, tempPath) {
      page.setData({ studentCard: serverPath, studentPreview: tempPath })
    })
  },

  clearStudent: function () {
    this.setData({ studentCard: '', studentPreview: '' })
  },

  chooseIdCard: function () {
    const page = this
    this.pickImage('certs', function (serverPath, tempPath) {
      page.setData({ idCard: serverPath, idPreview: tempPath })
    })
  },

  clearIdCard: function () {
    this.setData({ idCard: '', idPreview: '' })
  },

  submit: function () {
    const page = this
    if (page.data.submitting) return
    const realName = page.data.realName.trim()
    const idNo = page.data.idNo.trim()

    if (!realName) {
      ui.toast({ title: '请填写真实姓名', icon: 'none' })
      return
    }
    if (!/^\d{17}[\dXx]$/.test(idNo)) {
      ui.toast({ title: '请输入正确的 18 位身份证号', icon: 'none' })
      return
    }
    // 预览环境不支持选图（wx.chooseMedia 缺失），此时不强制要求证件照，
    // 否则第二条测试账号永远走不到接单那一步
    if (ui.available('chooseMedia') && !page.data.studentCard) {
      ui.toast({ title: '请上传学生证照片', icon: 'none' })
      return
    }

    page.setData({ submitting: true })
    api
      .submitApplication({
        real_name: realName,
        id_no_masked: maskIdNo(idNo),
        id_card_path: page.data.idCard || null,
        student_card_path: page.data.studentCard,
        detected_name: realName,
        detected_no: maskIdNo(idNo),
      })
      .then(function () {
        return api.markCertPending()
      })
      .then(function () {
        page.setData({ submitting: false })
        ui.toast({ title: '已提交审核', icon: 'success' })
        setTimeout(function () {
          wx.navigateBack()
        }, 900)
      })
      .catch(function (error) {
        page.setData({ submitting: false })
        if (error && error.needLogin) {
          guard.ensureLogin()
          return
        }
        guard.toastError(error)
      })
  },
})
