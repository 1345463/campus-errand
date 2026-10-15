const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const perms = require('../../utils/perms')
const flags = require('../../utils/flags')

// 人员查找与分级授权。
// 后台不再靠「是不是管理员」一刀切：超管可以把客服 / 人事 / 审核 / 相机 / 打印 / 结算
// 分给不同的人，各自只能进自己的那几个页面。这个页面就是发权限的地方。
//
// 两条硬规则（前端先挡一道，服务端 admin_set_perm 里还会再判一次，
// 前端判断能被绕过，别拿它当安全边界）：
//   1) 不是超管的人碰不了「超级管理员」这一项 —— 否则人事能把自己提成超管，分级就形同虚设；
//   2) 收回最后一个超管会被服务端拒绝（系统至少要留一个超管），这里不预判，
//      直接把服务端返回的准确报错展示出来。

// 认证状态文案与配色：复用订单状态那套 class，颜色语义一致
const CERT_TEXT = {
  none: '未认证',
  pending: '认证待审核',
  approved: '已认证',
  rejected: '认证被驳回',
}
const CERT_CLASS = {
  none: 'status-canceled',
  pending: 'status-pending',
  approved: 'status-approved',
  rejected: 'status-rejected',
}
const ROLE_TEXT = { user: '普通用户', runner: '接单员' }

// 手机号脱敏：只留前 3 位和后 4 位。
// 查人是为了授权，看到完整号码没有任何必要，后台页面少暴露一份是一份。
function maskPhone(phone) {
  const text = String(phone || '').trim()
  if (!text) return '未绑定'
  if (text.length <= 7) return text.slice(0, 3) + '****'
  return text.slice(0, 3) + '****' + text.slice(-4)
}

function toRow(row, opts) {
  const uid = String(row.uid || '')
  const granted = (row.perm_keys || []).map(function (key) {
    return String(key)
  })

  // 七项权限铺成 chip 矩阵：on 表示已授权，locked 表示这一项当前操作者碰不了
  const permList = perms.PERMS.map(function (item) {
    return {
      key: item.key,
      label: item.label,
      uid: uid,
      on: granted.indexOf(item.key) >= 0,
      locked: item.key === 'super' && !opts.isSuper,
    }
  })

  let onCount = 0
  permList.forEach(function (item) {
    if (item.on) onCount += 1
  })

  const nickname = String(row.nickname || row.owner_name || '').trim() || '未填写昵称'
  const realName = String(row.owner_name || '').trim()
  // 昵称和姓名经常不一样（「阿强」/「陈伟强」），两个都显示才认得出人。
  // 拼接放在 JS 里做：WXML 表达式里拼字符串不可靠。
  const nameText = realName && realName !== nickname ? nickname + '（' + realName + '）' : nickname

  return {
    uid: uid,
    uidTail: uid ? uid.slice(-6) : '------',
    avatarText: nickname.slice(0, 1),
    nameText: nameText,
    roleText: ROLE_TEXT[row.role] || String(row.role || '普通用户'),
    certText: CERT_TEXT[row.cert_status] || '未认证',
    certClass: CERT_CLASS[row.cert_status] || 'status-canceled',
    phoneText: maskPhone(row.phone),
    createdText: api.formatTime(row.created_at),
    isMe: uid !== '' && uid === String(opts.myUid || ''),
    perms: permList,
    onCount: onCount,
  }
}

Page({
  data: {
    keyword: '',
    list: [],
    loading: false,
    // 区分「还没搜过」和「搜过但没人」，避免一进页面就闪一下空状态
    searched: false,
    needLogin: false,
    denied: false,
    grayOff: false,
    errorText: '',
    isSuper: false,
    canGrant: false,
    myUid: '',
    // 二次点击确认：第一次点 chip 只「上膛」，4 秒内再点一次才真的写库
    armUid: '',
    armKey: '',
    armLabel: '',
    armWillGrant: false,
  },

  onLoad: function () {
    this.checkAndLoad()
  },

  onPullDownRefresh: function () {
    const page = this
    this.search().then(
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
    return flags
      .ensure()
      .then(function () {
        // 人员查找单独挂一个开关：出了舆情可以先关掉查人入口，不影响其它后台功能
        if (!flags.on('staff_search')) {
          page.setData({ grayOff: true, loading: false, list: [] })
          return null
        }
        return page.checkPermAndLoad()
      })
      .catch(function (error) {
        page.setData({ loading: false, errorText: api.getErrorMessage(error) })
      })
  },

  checkPermAndLoad: function () {
    const page = this
    return api
      .getSession()
      .then(function (session) {
        if (!session) {
          page.setData({ needLogin: true, loading: false, list: [], denied: false })
          return
        }
        page.setData({ myUid: String((session.user && session.user.id) || '') })
        // 权限以服务端 admin_my_perms 为准（super 会被展开成全部七项）
        return perms.load().then(function () {
          const allowed = perms.has('hr') || perms.has('super')
          if (!allowed) {
            page.setData({ denied: true, loading: false, list: [] })
            return
          }
          page.setData({ needLogin: false, denied: false, isSuper: perms.has('super') })
          // 能不能授权再问一次服务端：有 hr/super 之外的情况（权限被回收）时按钮要变灰提示
          return api.adminCanGrant().then(function (can) {
            page.setData({ canGrant: !!can })
            return page.search()
          })
        })
      })
      .catch(function (error) {
        page.setData({ loading: false, errorText: api.getErrorMessage(error) })
      })
  },

  onKeywordInput: function (event) {
    this.setData({ keyword: event.detail.value })
  },

  clearKeyword: function () {
    const page = this
    page.setData({ keyword: '' }, function () {
      page.search()
    })
  },

  // 关键词留空也要能搜：服务端此时返回最近注册的人，正好当默认列表用
  onSearch: function () {
    return this.search()
  },

  search: function () {
    const page = this
    const keyword = String(page.data.keyword || '').trim()
    page.setData({ loading: true, errorText: '', armUid: '', armKey: '', armLabel: '', armWillGrant: false })
    return api
      .adminSearchStaff(keyword, 20)
      .then(function (rows) {
        const opts = { isSuper: page.data.isSuper, myUid: page.data.myUid }
        const list = rows.map(function (row) {
          return toRow(row, opts)
        })
        page.setData({ list: list, loading: false, searched: true })
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ loading: false, list: [], searched: true, errorText: message })
        if (typeof console !== 'undefined' && console.error) console.error('[admin/staff]', message, error)
        ui.toast({ title: message, icon: 'none', duration: 2500 })
      })
  },

  // 点权限 chip：第一次上膛，第二次（或点下方确认文案）才写库
  togglePerm: function (event) {
    const page = this
    const dataset = event.currentTarget.dataset
    const uid = String(dataset.uid || '')
    const key = String(dataset.key || '')
    const locked = String(dataset.locked) === 'true'
    const on = String(dataset.on) === 'true'

    if (locked) {
      ui.toast({ title: '只有超级管理员可以授予或收回超级管理员权限', icon: 'none', duration: 2500 })
      return
    }
    if (!page.data.canGrant) {
      ui.toast({ title: '你没有授权权限，只能查看', icon: 'none', duration: 2200 })
      return
    }

    if (page.data.armUid === uid && page.data.armKey === key) {
      page.clearArm()
      page.doSetPerm(uid, key, !on)
      return
    }

    page.arm(uid, key, !on)
  },

  // 上膛：4 秒不确认自动解除，避免误触后一直挂着「待确认」
  arm: function (uid, key, willGrant) {
    const page = this
    if (page._armTimer) clearTimeout(page._armTimer)
    page.setData({
      armUid: uid,
      armKey: key,
      armLabel: perms.label(key),
      armWillGrant: !!willGrant,
    })
    page._armTimer = setTimeout(function () {
      page._armTimer = null
      page.setData({ armUid: '', armKey: '', armLabel: '', armWillGrant: false })
    }, 4000)
  },

  clearArm: function () {
    const page = this
    if (page._armTimer) {
      clearTimeout(page._armTimer)
      page._armTimer = null
    }
    page.setData({ armUid: '', armKey: '', armLabel: '', armWillGrant: false })
  },

  cancelPerm: function () {
    this.clearArm()
  },

  // 下方「再点一次…」文案也接同一个动作：chip 上膛后手指就在附近，少一次跳转
  confirmArmed: function (event) {
    const page = this
    const uid = String(event.currentTarget.dataset.uid || '')
    if (page.data.armUid !== uid || !page.data.armKey) return
    const key = page.data.armKey
    const willGrant = page.data.armWillGrant
    page.clearArm()
    page.doSetPerm(uid, key, willGrant)
  },

  doSetPerm: function (uid, key, enabled) {
    const page = this
    ui.loading({ title: enabled ? '授权中' : '收回中', mask: true })
    api
      .adminSetPerm(uid, key, enabled)
      .then(function () {
        ui.hideLoading()
        ui.toast({
          title: (enabled ? '已授予「' : '已收回「') + perms.label(key) + '」',
          icon: 'success',
        })
        // 重新拉一次列表：权限可能连带变化（super 会展开成全部七项），以服务端为准
        return page.search()
      })
      .catch(function (error) {
        ui.hideLoading()
        const message = api.getErrorMessage(error)
        page.setData({ errorText: message })
        if (typeof console !== 'undefined' && console.error) console.error('[admin/staff] set perm failed:', message, error)
        // 服务端会给准确原因（例如「至少要保留一个超级管理员」，或没有授权资格），原样展示
        guard.toastError(error)
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
