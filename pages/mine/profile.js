const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const flags = require('../../utils/flags')

// 用户名长度：和服务端 update_my_profile 的校验保持一致，
// 前端先拦一道是为了让用户马上看到原因，不是安全边界。
const MIN_LEN = 2
const MAX_LEN = 16

Page({
  data: {
    loading: true,
    grayOff: false,
    needLogin: false,
    nickname: '',
    initial: '同',
    avatarPath: '',
    avatarSrc: '',
    avatarError: '',
    // 只有这次真的换过图，保存时才把头像一起提交
    avatarDirty: false,
    uploading: false,
    saving: false,
    formError: '',
    isFirstTime: false,
    // force=1：由「我的」页在发现用户没名字时跳转过来，属于强制补全，不填完不放走
    forceMode: false,
  },

  onLoad: function (options) {
    const force = !!(options && String(options.force) === '1')
    this.setData({ forceMode: force })
    if (force) this.lockBack()
    this.load()
  },

  onUnload: function () {
    // 兜底：万一真的被带走了（比如手势返回点了「确定」），把拦截撤掉，
    // 免得这个提示跟着页面栈影响到后面的页面
    if (this.data.forceMode) this.unlockBack()
  },

  // 微信没提供「禁用返回」的 API，只能用官方的离开确认拦截。
  // 它会拦住左上角返回按钮和右滑手势，用户点「确定」才会真的退出。
  lockBack: function () {
    if (typeof wx.enableAlertBeforeUnload !== 'function') return
    try {
      wx.enableAlertBeforeUnload({ message: '还没设置用户名，现在离开将无法下单和接单' })
    } catch (error) {
      /* 部分基础库不支持，忽略即可 */
    }
  },

  unlockBack: function () {
    if (typeof wx.disableAlertBeforeUnload !== 'function') return
    try {
      wx.disableAlertBeforeUnload()
    } catch (error) {
      /* 同上 */
    }
  },

  load: function () {
    const page = this
    page.setData({ loading: true, formError: '' })
    return flags
      .ensure()
      .then(function () {
        // 强制补名不受「修改资料」灰度开关影响：名字是硬需求，开关关了也得能填
        if (!flags.on('profile_edit') && !page.data.forceMode) {
          page.setData({ grayOff: true, loading: false })
          return null
        }
        return api.getSession().then(function (session) {
          if (!session) {
            page.setData({ needLogin: true, loading: false })
            return null
          }
          return api.getProfile().then(function (profile) {
            const name = (profile && profile.nickname) || ''
            const avatar = (profile && profile.avatar_url) || ''
            const forced = page.data.forceMode || !name
            page.setData({
              loading: false,
              needLogin: false,
              nickname: name,
              initial: name ? name.slice(0, 1) : '同',
              avatarPath: avatar,
              // 一个名字都没有的老账号，进来说明是来补名字的
              isFirstTime: !name,
              forceMode: forced,
            })
            // 只要还是空名字就按强制流程走：没名字不能下单也不能接单
            if (forced && !name) page.lockBack()
            if (avatar) page.loadAvatar(avatar)
            return null
          })
        })
      })
      .catch(function (error) {
        page.setData({ loading: false })
        guard.toastError(error)
      })
  },

  // 头像走公开读通道（scope='avatar'），自己的头像同样能读，页面不用分叉。
  // 历史数据里可能存的是微信头像的 https 链接，这种直接就能显示，不用去服务端绕。
  loadAvatar: function (path) {
    const page = this
    if (String(path).indexOf('asset:') !== 0) {
      page.setData({ avatarSrc: path || '', avatarError: '' })
      return Promise.resolve()
    }
    return api
      .getPublicImageUrl(path)
      .then(function (result) {
        page.setData({
          avatarSrc: (result && result.url) || '',
          avatarError: result && result.url ? '' : (result && result.error) || '头像加载失败',
        })
        return null
      })
      .catch(function (error) {
        page.setData({ avatarError: api.getErrorMessage(error) })
        return null
      })
  },

  chooseAvatar: function () {
    const page = this
    if (page.data.uploading) return

    const handle = function (tempFilePath) {
      if (!tempFilePath) return
      page.setData({ uploading: true, formError: '' })
      ui.loading({ title: '上传中', mask: true })
      api
        .uploadImage(tempFilePath, 'avatar')
        .then(function (serverPath) {
          ui.hideLoading()
          // 本地临时文件先顶上显示，省一次读图往返
          page.setData({
            uploading: false,
            avatarPath: serverPath,
            avatarDirty: true,
            avatarSrc: tempFilePath,
            avatarError: '',
          })
          ui.toast({ title: '头像已选好，记得点保存', icon: 'none' })
          return null
        })
        .catch(function (error) {
          ui.hideLoading()
          page.setData({ uploading: false })
          guard.toastError(error)
        })
    }

    if (typeof wx !== 'undefined' && typeof wx.chooseMedia === 'function') {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sizeType: ['compressed'],
        success: function (res) {
          const files = res.tempFiles || []
          handle(files.length ? files[0].tempFilePath : '')
        },
        fail: function () {
          /* 用户主动取消，不提示 */
        },
      })
      return
    }

    if (typeof wx !== 'undefined' && typeof wx.chooseImage === 'function') {
      wx.chooseImage({
        count: 1,
        sizeType: ['compressed'],
        success: function (res) {
          const list = res.tempFilePaths || []
          handle(list.length ? list[0] : '')
        },
        fail: function () {
          /* 忽略取消 */
        },
      })
      return
    }

    ui.toast({ title: '当前环境不支持选图，请在微信小程序里使用', icon: 'none' })
  },

  onNicknameInput: function (event) {
    const value = event.detail.value || ''
    this.setData({
      nickname: value,
      initial: value ? value.trim().slice(0, 1) || '同' : '同',
      formError: '',
    })
  },

  showError: function (message) {
    this.setData({ formError: message })
    ui.toast({ title: message, icon: 'none' })
  },

  save: function () {
    const page = this
    const name = String(page.data.nickname || '').trim()
    if (name.length < MIN_LEN) {
      page.showError('用户名至少 ' + MIN_LEN + ' 个字')
      return
    }
    if (name.length > MAX_LEN) {
      page.showError('用户名最多 ' + MAX_LEN + ' 个字')
      return
    }
    if (page.data.saving) return
    page.setData({ saving: true, formError: '' })
    ui.loading({ title: '保存中', mask: true })

    api
      // 只有真的换过头像才把头像一起提交：老数据里的头像是微信的 https 链接，
      // 服务端只认 asset:<id>，把它原样发上去会被判「格式不正确」。
      .updateMyProfile(name, page.data.avatarDirty ? page.data.avatarPath : undefined)
      .then(function (profile) {
        ui.hideLoading()
        page.setData({
          saving: false,
          nickname: (profile && profile.nickname) || name,
          avatarPath: (profile && profile.avatar_url) || page.data.avatarPath,
          avatarDirty: false,
          isFirstTime: false,
          forceMode: false,
        })
        ui.toast({ title: '已保存', icon: 'success' })
        // 名字已经补上了，离开确认要撤掉，否则返回会被自己拦一下
        page.unlockBack()
        setTimeout(function () {
          const pages = getCurrentPages ? getCurrentPages() : []
          // 强制补名可能是从 tab 页直接 push 进来的，栈里只有一页时退回「我的」
          if (pages && pages.length > 1) wx.navigateBack({ delta: 1 })
          else wx.switchTab({ url: '/pages/mine/index' })
        }, 700)
        return null
      })
      .catch(function (error) {
        ui.hideLoading()
        page.setData({ saving: false, formError: api.getErrorMessage(error) })
        guard.toastError(error)
      })
  },

  goLogin: function () {
    wx.switchTab({ url: '/pages/mine/index' })
  },
})
