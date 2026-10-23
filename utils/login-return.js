const ui = require('./ui')
const KEY = 'loginReturnV1'

// switchTab 会销毁非 tab 页。先让页面保存草稿，再记录受限的本地返回地址。
function goLogin() {
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
  const page = pages[pages.length - 1]
  if (page && typeof page.saveDraft === 'function') page.saveDraft(true)
  if (page && /^pages\/(order\/(create|detail)|mine\/support)$/.test(page.route || '')) {
    const options = page.options || {}
    const query = Object.keys(options).map(function (key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(options[key])
    }).join('&')
    ui.setStorage(KEY, { url: '/' + page.route + (query ? '?' + query : ''), at: Date.now() })
  }
  wx.switchTab({ url: '/pages/mine/index' })
}

function resume() {
  const target = ui.getStorage(KEY)
  if (!target) return
  ui.removeStorage(KEY)
  if (Date.now() - target.at > 30 * 60 * 1000 || !/^\/pages\/(order\/(create|detail)|mine\/support)(\?|$)/.test(target.url || '')) return
  wx.navigateTo({ url: target.url })
}

module.exports = { goLogin: goLogin, resume: resume }
