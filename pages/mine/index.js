const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const campus = require('../../utils/campus')
const config = require('../../utils/config')
const agreement = require('../../utils/agreement')
const flags = require('../../utils/flags')
const perms = require('../../utils/perms')
const motion = require('../../utils/motion')

Page({
  data: {
    logged: false,
    logining: false,
    school: campus.SCHOOL_NAME,
    mode: 'login',
    phone: '',
    password: '',
    code: '',
    regNickname: '',
    countdown: 0,
    submitting: false,
    rememberPassword: config.rememberPassword,
    profile: null,
    initial: '同',
    nicknameText: '同学',
    uidText: '',
    // 头像：avatarPath 是入库路径（asset:<id>），avatarSrc 是能直接塞进 <image> 的地址
    avatarPath: '',
    avatarSrc: '',
    points: 0,
    balance: '0.00',
    roleText: '用户',
    // 信誉分：还没拉到数据时显示占位符，不要假装是 0 分
    creditScore: '—',
    creditReady: false,
    isAdmin: false,
    // 有没有任意一项后台权限 —— 决定「管理员工作台」入口出不出现
    isAnyAdmin: false,
    switching: false,
    logoutArmed: false,
    certText: '未认证',
    certShort: '未认证',
    agreed: false,
    agreementNotice: agreement.SHORT_NOTICE,
    agreementVersionText: '未签署',
    // 表单内联报错：预览容器里 wx.showToast 可能不可用，
    // 只靠 toast 会让「手机号格式不对」这类校验彻底静默，用户只看到按钮没反应
    formError: '',
    focusKey: '',
    // 「我的订单」下面四个快捷入口的高亮项。这几个 chip 是跳转到订单页并带筛选，
    // 不是在本页过滤，所以记一下最后点的是哪个，回到本页时才看得出上次看的是哪一类
    orderFilter: 'all',
    // 灰度开关快照：WXML 里用 flagsOn.xxx 决定新入口要不要出现
    flagsOn: {},
    // 我拥有的后台权限：WXML 里用 permsOn.xxx 决定后台入口要不要出现
    permsOn: {},
    unread: 0,

    // 自定义导航（fixed）让位
    navTotal: 64,
    motionClass: '',
  },

  onLoad: function () {
    const sys = motion.systemInfo()
    this.setData({
      navTotal: sys.navTotalHeight,
      motionClass: motion.rootClass(),
    })
  },

  onUnload: function () {
    this.stopCountdown()
    this.stopStatTimers()
  },

  onPullDownRefresh: function () {
    const page = this
    page
      .refresh()
      .then(function () {
        if (typeof wx.stopPullDownRefresh === 'function') {
          try {
            wx.stopPullDownRefresh()
          } catch (e) {
            /* 忽略 */
          }
        }
        motion.haptic('light')
      })
      .catch(function () {
        if (typeof wx.stopPullDownRefresh === 'function') {
          try {
            wx.stopPullDownRefresh()
          } catch (e) {
            /* 忽略 */
          }
        }
      })
  },

  // 统计数字滚动进场：积分 / 余额跳变太生硬，滚上去才有「活」的感觉
  animateStats: function () {
    const page = this
    page.stopStatTimers()
    page._stopPoints = motion.countUp(page, 'points', Number(page.data.points) || 0, 760, 0)
    page._stopBalance = motion.countUp(page, 'balance', Number(page.data.balance) || 0, 760, 2)
  },

  stopStatTimers: function () {
    if (this._stopPoints) {
      this._stopPoints()
      this._stopPoints = null
    }
    if (this._stopBalance) {
      this._stopBalance()
      this._stopBalance = null
    }
  },

  onShow: function () {
    if (!this.autoLoginTried) {
      this.autoLoginTried = true
      this.tryAutoLogin()
      return
    }
    this.refresh()
  },

  // 记住过凭证就直接静默重登，测试期每次进来不用再输一遍
  tryAutoLogin: function () {
    const page = this
    // 用户主动退出过就不再自动登回去，否则没法切换到另一个账号
    if (ui.getStorage('manualLogout')) {
      page.refresh()
      return
    }
    const saved = ui.getStorage('savedAccount')
    const preset = config.presetAccount || {}
    const account =
      config.autoLogin && preset.phone && preset.password
        ? preset
        : saved && saved.phone && saved.password
          ? saved
          : null
    if (!account) {
      page.refresh()
      return
    }
    page.setData({ phone: account.phone, password: account.password })
    api
      .loginWithPassword(account.phone, account.password)
      .then(function (result) {
        page.applyProfile(result.session, result.profile)
        return page.refresh()
      })
      .catch(function () {
        // 静默失败不打扰用户，落到正常登录界面
        page.refresh()
      })
  },

  remember: function (phone, password) {
    if (!config.rememberPassword) return
    try {
      ui.setStorage('savedAccount', { phone: phone, password: password })
      // 主动登录过就解除"退出后不再自动登录"的限制
      ui.removeStorage('manualLogout')
    } catch (e) {
      /* 存储不可用时忽略 */
    }
  },

  refresh: function () {
    const page = this
    return api.getSession().then(function (session) {
      if (!session) {
        page.setData({ logged: false, profile: null })
        return null
      }
      return api.getProfile().then(function (profile) {
        page.applyProfile(session, profile)
      })
    })
  },

  applyProfile: function (session, profile) {
    const uid =
      (session && session.user && String(session.user.id || '')) ||
      (profile && profile.owner_id ? String(profile.owner_id) : '')
    const name = (profile && profile.nickname) || (session && session.user && session.user.name) || '同学'
    const certStatus = (profile && profile.cert_status) || 'none'
    const certMap = { none: '未认证', pending: '审核中', approved: '已认证', rejected: '未通过' }
    const role = (profile && profile.role) || 'user'
    const avatarPath = (profile && profile.avatar_url) || ''
    this.setData({
      logged: true,
      profile: profile,
      initial: name.slice(0, 1),
      nicknameText: name,
      uidText: uid ? uid.slice(-6) : '',
      avatarPath: avatarPath,
      points: (profile && profile.points) || 0,
      balance: Number((profile && profile.balance) || 0).toFixed(2),
      roleText: role === 'runner' ? '接单员' : '用户',
      isAdmin: !!(profile && profile.is_admin),
      certText: certMap[certStatus] || '未认证',
      certShort: certStatus === 'none' ? '无' : certStatus === 'approved' ? '已开通' : '审核中',
      agreementVersionText: profile && profile.agreed_version ? '已签署 ' + profile.agreed_version : '未签署',
    })
    this.animateStats()
    this.loadAvatar(avatarPath)
    this.maybeForceAgreement(profile)
    this.loadExtras()
    // 微信一键登录不会带用户名，老账号也可能一直是空的。
    // 名字是硬需求（接单员真名、评价、消息里都要显示），没有就当场逼着填一个。
    this.maybeForceNickname(profile)
  },

  // 没有用户名 → 直接进资料页补全，填完才放回来（见 pages/mine/profile 的 force 模式）
  maybeForceNickname: function (profile) {
    if (!guard.nicknameMissing(profile)) {
      this._nickForced = false
      return
    }
    // applyProfile 会被多处调用（登录、刷新、保存资料后），只弹一次就够了
    if (this._nickForced) return
    this._nickForced = true
    guard.ensureNickname(profile)
  },

  // 头像走公开读通道（scope='avatar'），自己的头像也能读，因此不用区分是不是本人
  loadAvatar: function (path) {
    const page = this
    if (!path) {
      page.setData({ avatarSrc: '' })
      return Promise.resolve()
    }
    // asset:<id> 要经服务端取字节；其余情况（微信头像 https、本地临时路径、data URL）直接显示
    if (String(path).indexOf('asset:') !== 0) {
      page.setData({ avatarSrc: path })
      return Promise.resolve()
    }
    return api
      .getPublicImageUrl(path)
      .then(function (result) {
        if (result && result.url) page.setData({ avatarSrc: result.url })
        return null
      })
      .catch(function () {
        // 头像读不出来不该影响整页，退回首字头像
        page.setData({ avatarSrc: '' })
        return null
      })
  },

  // 灰度开关 + 后台权限 + 未读消息数。
  // 三个都是"有就用、没有就当没有"，失败一律静默降级，不能因为拿不到就挡住整个页面。
  loadExtras: function () {
    const page = this
    const snap = {}
    const pmap = {}
    return flags
      .ensure()
      .then(function () {
        const s = flags.snapshot()
        Object.keys(s).forEach(function (key) {
          snap[key] = s[key]
        })
        return perms.load()
      })
      .then(function (keys) {
        ;(keys || []).forEach(function (key) {
          pmap[key] = true
        })
        // 灰度没开时，后台入口回退到老的「isAdmin 一把梭」判断，
        // 否则超管还没开 admin_roles 开关就看不到任何后台入口
        if (!snap.admin_roles) {
          const all = ['super', 'support', 'hr', 'review', 'rental', 'print', 'settle']
          if (page.data.isAdmin) {
            all.forEach(function (key) {
              pmap[key] = true
            })
          }
        }
        let anyAdmin = false
        Object.keys(pmap).forEach(function (key) {
          if (pmap[key]) anyAdmin = true
        })
        page.setData({ flagsOn: snap, permsOn: pmap, isAnyAdmin: anyAdmin })

        // 下面几项都是「有就显示、没有就当没有」，各自 catch 掉，
        // 任何一个接口挂了都不能把整页拖住
        const tasks = []
        if (snap.credit_score) {
          tasks.push(
            api
              .myCreditSummary()
              .then(function (row) {
                const count = Number(row && row.runner_count) || 0
                page.setData({
                  creditReady: true,
                  // 一次评价都没有时不显示 0.0，那是"没数据"不是"很差"
                  creditScore: count > 0 ? Number(row.runner_score).toFixed(1) : '暂无',
                })
                return null
              })
              .catch(function () {
                return null
              })
          )
        }
        if (snap.message_center) {
          tasks.push(
            api
              .unreadMessageCount()
              .then(function (unread) {
                page.setData({ unread: Number(unread) || 0 })
                return null
              })
              .catch(function () {
                return null
              })
          )
        }
        return Promise.all(tasks)
      })
      .then(function () {
        return null
      })
      .catch(function () {
        page.setData({ flagsOn: snap, permsOn: pmap })
        return null
      })
  },

  onLogin: function () {
    const page = this
    if (!page.data.agreed) {
      ui.toast({ title: '请先勾选同意《用户协议》', icon: 'none' })
      return
    }
    if (page.data.logining) return
    page.setData({ logining: true })
    api
      .login()
      .then(function (result) {
        page.setData({ logining: false })
        page.applyProfile(result.session, result.profile)
        ui.toast({ title: '登录成功', icon: 'success' })
      })
      .catch(function (error) {
        page.setData({ logining: false })
        guard.toastError(error)
      })
  },

  // 勾选用户协议：登录和注册都必须先勾选
  toggleAgreed: function () {
    const next = !this.data.agreed
    // 勾上之后「请先勾选同意《用户协议》」这条提示就不该再挂着
    this.setData({ agreed: next, formError: next ? '' : this.data.formError })
  },

  goAgreement: function () {
    this.goPage('/pages/agreement/index')
  },

  // 登录后如果资料里没有当前版本的同意记录，强制到协议页勾选一次
  maybeForceAgreement: function (profile) {
    const page = this
    if (!profile) return
    if (profile.agreed_version === agreement.VERSION) return
    if (page._agreementPushed) return
    page._agreementPushed = true
    wx.navigateTo({ url: '/pages/agreement/index?force=1' })
  },

  toggleRole: function () {
    const page = this
    const profile = page.data.profile
    if (!profile) {
      ui.toast({ title: '资料还没加载出来，请稍后再试', icon: 'none' })
      return
    }
    if (profile.cert_status === 'none') {
      // 不走 ui.confirm：预览环境的弹窗回调不可靠，这里直接提示 + 跳到认证页
      ui.toast({ title: '还没有接单资格，去完成认证', icon: 'none' })
      page.goApply()
      return
    }
    if (profile.cert_status === 'pending') {
      ui.toast({ title: '认证审核中，通过后才能切换', icon: 'none' })
      return
    }
    if (profile.cert_status === 'rejected') {
      ui.toast({ title: '认证被驳回，去按原因修改', icon: 'none' })
      page.goApply()
      return
    }

    const next = profile.role === 'runner' ? 'user' : 'runner'
    if (page.data.switching) return
    page.setData({ switching: true })
    ui.loading({ title: '切换中', mask: true })
    api
      .setRole(next)
      .then(function (updated) {
        ui.hideLoading()
        page.setData({ switching: false, profile: updated })
        // 服务端返回的是完整行，再走一次 applyProfile 保证展示口径一致
        page.applyProfile(null, updated)
        ui.toast({
          title: next === 'runner' ? '已切换为接单员' : '已切换为用户',
          icon: 'success',
        })
        return page.refresh()
      })
      .catch(function (error) {
        ui.hideLoading()
        page.setData({ switching: false })
        guard.toastError(error)
      })
  },

  switchMode: function () {
    this.setData({
      mode: this.data.mode === 'login' ? 'register' : 'login',
      code: '',
      password: '',
      formError: '',
      focusKey: '',
    })
  },

  onFieldFocus: function (event) {
    this.setData({ focusKey: event.currentTarget.dataset.key || '' })
  },

  onFieldBlur: function () {
    this.setData({ focusKey: '' })
  },

  // 校验不通过时同时给出内联文案 + toast：toast 在真机上好认，
  // 内联文案保证预览环境（没有 showToast）也一定能看到原因
  showFormError: function (message) {
    this.setData({ formError: message })
    ui.toast({ title: message, icon: 'none' })
  },

  clearFormError: function () {
    if (this.data.formError) this.setData({ formError: '' })
  },

  onAccountInput: function (event) {
    const key = event.currentTarget.dataset.key
    const patch = { formError: '' }
    patch[key] = event.detail.value
    this.setData(patch)
  },

  stopCountdown: function () {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer)
      this.countdownTimer = null
    }
  },

  startCountdown: function () {
    const page = this
    page.stopCountdown()
    page.setData({ countdown: 60 })
    page.countdownTimer = setInterval(function () {
      const left = page.data.countdown - 1
      if (left <= 0) {
        page.stopCountdown()
        page.setData({ countdown: 0 })
        return
      }
      page.setData({ countdown: left })
    }, 1000)
  },

  sendCode: function () {
    const page = this
    const phone = String(page.data.phone || '').trim()
    if (!/^1\d{10}$/.test(phone)) {
      page.showFormError('请输入正确的 11 位手机号')
      return
    }
    if (page.data.countdown > 0) return
    page.clearFormError()
    ui.loading({ title: '发送中', mask: true })
    api
      .sendPhoneCode(phone)
      .then(function (challenge) {
        ui.hideLoading()
        page.pendingChallenge = {
          phone: phone,
          verificationId: challenge.verificationId,
          isExistingUser: challenge.isExistingUser,
        }
        page.startCountdown()
        ui.toast({ title: '验证码已发送', icon: 'none' })
      })
      .catch(function (error) {
        ui.hideLoading()
        page.setData({ formError: api.getErrorMessage(error) })
        guard.toastError(error)
      })
  },

  accountLogin: function () {
    const page = this
    const phone = String(page.data.phone || '').trim()
    const password = String(page.data.password || '')
    if (!/^1\d{10}$/.test(phone)) {
      page.showFormError('请输入正确的 11 位手机号')
      return
    }
    if (!password) {
      page.showFormError('请输入密码')
      return
    }
    if (!page.data.agreed) {
      page.showFormError('请先勾选同意《用户协议》')
      return
    }
    if (page.data.submitting) return
    page.setData({ submitting: true, formError: '' })
    api
      .loginWithPassword(phone, password)
      .then(function (result) {
        page.setData({ submitting: false, formError: '' })
        page.remember(phone, password)
        page.applyProfile(result.session, result.profile)
        ui.toast({ title: '登录成功', icon: 'success' })
      })
      .catch(function (error) {
        page.setData({ submitting: false, formError: api.getErrorMessage(error) })
        guard.toastError(error)
      })
  },

  accountRegister: function () {
    const page = this
    const phone = String(page.data.phone || '').trim()
    const code = String(page.data.code || '').trim()
    const password = String(page.data.password || '')
    // 用户名是必填项：注册就定下来，之后在「我的 → 头像与用户名」里改。
    // 不填的话对方的订单页上只能看到"同学"，没法确认是谁在接单。
    const nickname = String(page.data.regNickname || '').trim()
    if (!/^1\d{10}$/.test(phone)) {
      page.showFormError('请输入正确的 11 位手机号')
      return
    }
    if (!page.pendingChallenge || page.pendingChallenge.phone !== phone) {
      page.showFormError('请先获取当前手机号的验证码')
      return
    }
    if (!/^\d{4,8}$/.test(code)) {
      page.showFormError('请输入短信验证码')
      return
    }
    if (password.length < 6) {
      page.showFormError('密码至少 6 位')
      return
    }
    if (nickname.length < 2) {
      page.showFormError('请填写用户名，至少 2 个字')
      return
    }
    if (nickname.length > 16) {
      page.showFormError('用户名最多 16 个字')
      return
    }
    if (!page.data.agreed) {
      page.showFormError('请先勾选同意《用户协议》')
      return
    }
    if (page.data.submitting) return
    page.setData({ submitting: true, formError: '' })
    api
      .registerWithPhone({
        phone: phone,
        verificationId: page.pendingChallenge.verificationId,
        isExistingUser: page.pendingChallenge.isExistingUser,
        token: code,
        password: password,
      })
      .then(function (result) {
        // 账号已经建好了，用户名这一步失败就不算注册失败：
        // 尽最大努力写进去，真写不进去就提示用户去「头像与用户名」补一次。
        return api
          .updateProfile({ nickname: nickname, owner_name: nickname })
          .then(function (profile) {
            return { session: result.session, profile: profile || result.profile, nameSaved: true }
          })
          .catch(function () {
            return { session: result.session, profile: result.profile, nameSaved: false }
          })
      })
      .then(function (result) {
        page.setData({ submitting: false, formError: '' })
        page.pendingChallenge = null
        page.stopCountdown()
        page.remember(phone, password)
        page.applyProfile(result.session, result.profile)
        if (result.nameSaved === false) {
          ui.toast({ title: '注册成功，请再去设置一次用户名', icon: 'none', duration: 2600 })
          setTimeout(function () {
            wx.navigateTo({ url: '/pages/mine/profile' })
          }, 800)
          return
        }
        ui.toast({ title: '注册成功', icon: 'success' })
      })
      .catch(function (error) {
        page.setData({ submitting: false, formError: api.getErrorMessage(error) })
        guard.toastError(error)
      })
  },

  // 管理员：口令在页面内输入（editable 弹窗在预览里不可靠），开通后可查看
  // 全部订单并直接拥有接单资格，便于一个人把发布端和接单端都跑一遍
  goOrders: function (event) {
    const status = event.currentTarget.dataset.status || 'all'
    motion.haptic('select')
    this.setData({ orderFilter: status })
    ui.setStorage('orderFilterStatus', status)
    wx.switchTab({ url: '/pages/orders/list' })
  },

  goAccepted: function () {
    motion.haptic('light')
    ui.setStorage('orderListMode', 'accept')
    wx.switchTab({ url: '/pages/orders/list' })
  },

  goApply: function () {
    // 「成为接单员」现在是认证的唯一入口：页面里既有申请表单，
    // 也有「认证进度」二级入口，所以待审核/已通过都照常进去看状态，
    // 不再在这里弹 toast 挡住。
    this.goPage('/pages/mine/apply')
  },

  // 所有「跳二级页」的入口统一走这里：加触感反馈 + 统一的失败提示，
  // 免得每个方法各写一份（原来失败时是静默的，点了没反应）
  goPage: function (url) {
    motion.haptic('light')
    wx.navigateTo({
      url: url,
      fail: function (err) {
        ui.toast({ title: '页面打开失败：' + (err.errMsg || '未知错误'), icon: 'none' })
      },
    })
  },

  goPoints: function () {
    this.goPage('/pages/mine/points')
  },

  goWallet: function () {
    this.goPage('/pages/mine/wallet')
  },

  // 后台各模块的入口统一收进「管理员工作台」，本页不再散着列。
  // 这里只留一个跳转，具体能进哪几个页面由工作台按权限决定。
  goDashboard: function () {
    this.goPage('/pages/admin/dashboard')
  },

  goRental: function () {
    this.goPage('/pages/rental/index')
  },

  // 设置：我的地址 / 动效与触感 / 管理员权限 / 用户协议 / 关于 都收在这个二级页里，
  // 「我的」页只留一个入口，避免低频功能把菜单拉得老长
  goSettings: function () {
    this.goPage('/pages/mine/settings')
  },

  // 智能客服：FAQ 固定回答优先，匹配不到再让大模型兜底，还不行可以转人工工单
  goSupport: function () {
    this.goPage('/pages/mine/support')
  },

  // 点头像区 → 改头像和用户名（唯一入口，菜单里不重复列）
  // 入口本身是页面头部，没法隐藏，所以灰度关掉时用提示兜住，避免点进去是空页面
  goProfile: function () {
    if (this.data.flagsOn && this.data.flagsOn.profile_edit === false) {
      ui.toast({ title: '该功能暂未开放', icon: 'none' })
      return
    }
    this.goPage('/pages/mine/profile')
  },

  // 我的订单里的「待评价」是评价页的唯一入口
  goMyReviews: function () {
    this.goPage('/pages/mine/reviews')
  },

  goCredit: function () {
    this.goPage('/pages/mine/credit')
  },

  // ---- 灰度开关控制的入口 ----
  // 这些页面都由灰度开关控制，页面内部还会再判一次，这里只是决定入口出不出现

  goMessages: function () {
    this.goPage('/pages/mine/messages')
  },

  // 注意：认证进度（pages/mine/cert）不再从本页直接进，
  // 它已经收进「成为接单员」的二级页面，避免和那个菜单项重复。
  // 本页也不要有任何指向 cert 的入口。

  goMall: function () {
    this.goPage('/pages/mine/mall')
  },

  goFeedback: function () {
    this.goPage('/pages/mine/feedback')
  },

  // 不用 wx.showModal：预览环境里它可能永不回调，导致点了没反应。
  // 改成页内两步确认，只依赖 setData，任何环境都成立。
  onLogout: function () {
    const page = this
    if (page.data.logoutArmed) {
      page.doLogout()
      return
    }
    page.setData({ logoutArmed: true })
    ui.toast({ title: '再点一次「退出登录」即可确认', icon: 'none' })
    setTimeout(function () {
      if (page.data.logoutArmed) page.setData({ logoutArmed: false })
    }, 4000)
  },

  doLogout: function () {
    const page = this
    page.setData({ logoutArmed: false, submitting: true })
    ui.loading({ title: '退出中', mask: true })
    api
      .logout()
      .then(function () {
        ui.hideLoading()
        ui.removeStorage('savedAccount')
        ui.removeStorage('pickedAddress')
        // 这个标记阻止下次进页面时被自动登录回去
        ui.setStorage('manualLogout', true)
        if (getApp && typeof getApp === 'function') {
          const app = getApp()
          if (app && app.globalData) {
            app.globalData.session = null
            app.globalData.profile = null
            app.globalData.logged = false
          }
        }
        page.resetView()
        ui.toast({ title: '已退出登录', icon: 'none' })
      })
      .catch(function (error) {
        ui.hideLoading()
        page.setData({ submitting: false })
        guard.toastError(error)
      })
  },

  resetView: function () {
    const page = this
    page.autoLoginTried = true
    page.setData({
      logged: false,
      profile: null,
      submitting: false,
      logining: false,
      phone: '',
      password: '',
      code: '',
      regNickname: '',
      mode: 'login',
      isAdmin: false,
      isAnyAdmin: false,
      switching: false,
      nicknameText: '同学',
      uidText: '',
      avatarPath: '',
      avatarSrc: '',
      points: 0,
      balance: '0.00',
      creditScore: '—',
      creditReady: false,
      roleText: '用户',
      certText: '未认证',
      certShort: '未认证',
      agreed: false,
      agreementVersionText: '未签署',
    })
    this._agreementPushed = false
  },
})
