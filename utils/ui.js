// 预览容器不会完整模拟所有 wx API（例如 wx.showLoading 直接不存在）。
// 这里统一做安全降级：任何环境下都不因为某个 API 缺失而让点击静默中断。
function available(name) {
  return typeof wx !== 'undefined' && wx && typeof wx[name] === 'function'
}

function pickText(value, fallback) {
  if (value && typeof value === 'object') return String(value.title || fallback || '')
  return String(value === undefined || value === null ? fallback || '' : value)
}

function pickIcon(value, explicit) {
  if (explicit !== undefined) return explicit
  if (value && typeof value === 'object') return value.icon || 'none'
  return 'none'
}

function fallbackLog(tag, text) {
  if (typeof console !== 'undefined' && console.log) console.log('[ui.' + tag + ']', text)
}

function toast(title, icon) {
  const text = pickText(title, '').slice(0, 40)
  const kind = pickIcon(title, icon)
  if (available('showToast')) {
    try {
      wx.showToast({ title: text, icon: kind, duration: 2200 })
      return
    } catch (e) {
      /* 继续走兜底 */
    }
  }
  fallbackLog('toast', text)
}

function loading(title) {
  if (!available('showLoading')) return
  try {
    wx.showLoading({ title: pickText(title, '处理中'), mask: true })
  } catch (e) {
    /* 忽略：loading 只是提示 */
  }
}

function hideLoading() {
  if (!available('hideLoading')) return
  try {
    wx.hideLoading()
  } catch (e) {
    /* 忽略 */
  }
}

// 确认框：API 缺失、调用失败或迟迟不回调时都按 defaultConfirm 收尾，绝不悬着不返回
function confirm(options) {
  const opts = options || {}
  const fallback = !!opts.defaultConfirm
  return new Promise(function (resolve) {
    if (!available('showModal')) {
      fallbackLog('confirm', (opts.title || '') + ' | showModal 不可用，按默认处理')
      resolve(fallback)
      return
    }
    let settled = false
    const finish = function (value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(function () {
      finish(fallback)
    }, opts.timeout || 15000)
    try {
      wx.showModal({
        title: opts.title || '提示',
        content: opts.content || '',
        confirmText: opts.confirmText || '确定',
        cancelText: opts.cancelText || '取消',
        success: function (res) {
          finish(!!res.confirm)
        },
        fail: function () {
          finish(fallback)
        },
      })
    } catch (e) {
      finish(fallback)
    }
  })
}

// 输入型模态框（editable）在预览里同样不可靠，调用方应有页面内输入作为退路
function prompt(options) {
  const opts = options || {}
  return new Promise(function (resolve) {
    if (!available('showModal')) {
      fallbackLog('prompt', 'showModal 不可用，无法弹输入框')
      resolve(null)
      return
    }
    try {
      wx.showModal({
        title: opts.title || '请输入',
        content: '',
        editable: true,
        placeholderText: opts.placeholderText || '',
        success: function (res) {
          if (!res.confirm) {
            resolve(null)
            return
          }
          resolve(String((res.content || '')) || null)
        },
        fail: function () {
          resolve(null)
        },
      })
    } catch (e) {
      resolve(null)
    }
  })
}

function getStorage(key) {
  if (!available('getStorageSync')) return null
  try {
    const value = wx.getStorageSync(key)
    return value === '' ? null : value
  } catch (e) {
    return null
  }
}

function setStorage(key, value) {
  if (!available('setStorageSync')) return false
  try {
    wx.setStorageSync(key, value)
    return true
  } catch (e) {
    return false
  }
}

function removeStorage(key) {
  if (!available('removeStorageSync')) return
  try {
    wx.removeStorageSync(key)
  } catch (e) {
    /* 忽略 */
  }
}

module.exports = {
  available: available,
  toast: toast,
  loading: loading,
  hideLoading: hideLoading,
  confirm: confirm,
  prompt: prompt,
  getStorage: getStorage,
  setStorage: setStorage,
  removeStorage: removeStorage,
}
