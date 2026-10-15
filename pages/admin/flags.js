const ui = require('../../utils/ui')
const api = require('../../utils/api')
const guard = require('../../utils/guard')
const perms = require('../../utils/perms')
const flags = require('../../utils/flags')

// 灰度开关总闸。
// 本轮所有新功能都挂在开关上：任何一个出问题，超管在这里关掉即可，
// 不用改代码、不用重新发版。反过来这也是个风险点 —— 关错一个，
// 全站用户立刻用不了对应功能，所以只有 super 能进，且每次切换都要二次点击确认。
Page({
  data: {
    list: [],
    loading: false,
    needLogin: false,
    denied: false,
    errorText: '',
    // 二次点击确认：第一次点开关只「上膛」，4 秒内再点一次才真的写库
    armKey: '',
    armLabel: '',
    armWillOn: false,
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

  checkAndLoad: function () {
    const page = this
    return api
      .getSession()
      .then(function (session) {
        if (!session) {
          page.setData({ needLogin: true, loading: false, list: [], denied: false })
          return
        }
        // 只有超级管理员：开关是总闸，误操作影响全站
        return perms.load().then(function () {
          if (!perms.has('super')) {
            page.setData({ denied: true, loading: false, list: [] })
            return
          }
          page.setData({ needLogin: false, denied: false })
          return page.load()
        })
      })
      .catch(function (error) {
        page.setData({ loading: false, errorText: api.getErrorMessage(error) })
      })
  },

  load: function () {
    const page = this
    page.setData({ loading: true, errorText: '', armKey: '', armLabel: '', armWillOn: false })
    return api
      .listFeatureFlags()
      .then(function (rows) {
        const list = rows
          .slice()
          .sort(function (a, b) {
            // 服务端一般已按 sort_order 排好，这里再排一次，防止新增开关顺序乱掉
            return Number(a.sort_order || 0) - Number(b.sort_order || 0)
          })
          .map(function (row) {
            return {
              key: String(row.flag_key || ''),
              label: String(row.label || row.flag_key || ''),
              desc: String(row.description || ''),
              enabled: !!row.enabled,
              updatedText: api.formatTime(row.updated_at),
            }
          })
        page.setData({ list: list, loading: false })
      })
      .catch(function (error) {
        const message = api.getErrorMessage(error)
        page.setData({ loading: false, list: [], errorText: message })
        if (typeof console !== 'undefined' && console.error) console.error('[admin/flags]', message, error)
        ui.toast({ title: message, icon: 'none', duration: 2500 })
      })
  },

  // 点开关：第一次上膛，第二次才真的切
  askToggle: function (event) {
    const page = this
    const dataset = event.currentTarget.dataset
    const key = String(dataset.key || '')
    const on = String(dataset.on) === 'true'
    const next = !on

    if (page.data.armKey === key) {
      page.clearArm()
      page.doToggle(key, next)
      return
    }

    if (page._armTimer) clearTimeout(page._armTimer)
    page.setData({
      armKey: key,
      armLabel: String(dataset.label || ''),
      armWillOn: next,
    })
    page._armTimer = setTimeout(function () {
      page._armTimer = null
      page.setData({ armKey: '', armLabel: '', armWillOn: false })
    }, 4000)
  },

  clearArm: function () {
    const page = this
    if (page._armTimer) {
      clearTimeout(page._armTimer)
      page._armTimer = null
    }
    page.setData({ armKey: '', armLabel: '', armWillOn: false })
  },

  cancelToggle: function () {
    this.clearArm()
  },

  // 只改页面数据 + 内存里的开关缓存，不整列表 reload：
  // 重载会让列表闪一下，这里字段就三个，本地同步足够。
  applyLocal: function (key, enabled) {
    const page = this
    const list = page.data.list.map(function (item) {
      if (item.key !== key) return item
      return {
        key: item.key,
        label: item.label,
        desc: item.desc,
        enabled: !!enabled,
        updatedText: '刚刚',
      }
    })
    page.setData({ list: list })
  },

  doToggle: function (key, enabled) {
    const page = this
    const row = page.data.list.filter(function (item) {
      return item.key === key
    })[0]
    const label = row ? row.label : key
    const previous = !enabled

    // 先本地生效，按下去立刻有反馈；失败再回滚到 previous
    page.applyLocal(key, enabled)
    flags.set(key, enabled)

    ui.loading({ title: enabled ? '开启中' : '关闭中', mask: true })
    api
      .adminSetFeatureFlag(key, enabled)
      .then(function () {
        ui.hideLoading()
        ui.toast({ title: (enabled ? '已开启：' : '已关闭：') + label, icon: 'success' })
        page.setData({ errorText: '' })
      })
      .catch(function (error) {
        ui.hideLoading()
        // 回滚：页面显示和内存缓存一起还原，别留下「看着是开的、其实没生效」的假状态
        page.applyLocal(key, previous)
        flags.set(key, previous)
        const message = api.getErrorMessage(error)
        page.setData({ errorText: message })
        if (typeof console !== 'undefined' && console.error) console.error('[admin/flags] toggle failed:', message, error)
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
