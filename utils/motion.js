// 小程序动效 / 触感的统一入口。
//
// 为什么单独抽一个文件：
//   1) wx.vibrateShort 在开发者工具和部分安卓机上直接不存在，散落在页面里
//      每次都要 try/catch，漏一处就抛异常中断点击；
//   2) 自定义导航栏要读胶囊按钮位置，三个页面各算一遍必然算歪；
//   3) 入场延迟、减弱动效偏好需要一个全局开关，页面自己管就会各写一套。
//
// 页面层强制 ES5（const/let + function，禁箭头函数 / 模板字符串 / 展开），
// 这个 utils 也一样，别在这里用 ES6 语法。

var REDUCE_KEY = 'motion_reduce'

var sysCache = null
var reduceCache = null

function has(name) {
  return typeof wx !== 'undefined' && wx && typeof wx[name] === 'function'
}

// ---------- 系统与导航栏度量 ----------
// 自定义导航必须和右上角胶囊对齐，否则标题会被胶囊压住。
// 标准算法：导航栏高 = (胶囊顶 - 状态栏高) * 2 + 胶囊高
function systemInfo() {
  if (sysCache) return sysCache

  var info = {}
  if (has('getSystemInfoSync')) {
    try {
      info = wx.getSystemInfoSync() || {}
    } catch (e) {
      info = {}
    }
  }

  var capsule = null
  if (has('getMenuButtonBoundingClientRect')) {
    try {
      capsule = wx.getMenuButtonBoundingClientRect() || null
    } catch (e) {
      capsule = null
    }
  }

  var statusBar = Number(info.statusBarHeight) || 20
  var winWidth = Number(info.windowWidth) || 375
  var winHeight = Number(info.windowHeight) || 667

  var navBar = 44
  var capsuleHeight = 32
  var capsuleWidth = 87
  var capsuleTop = statusBar + 4

  if (capsule && capsule.height) {
    capsuleHeight = Number(capsule.height)
    capsuleTop = Number(capsule.top) || capsuleTop
    navBar = (capsuleTop - statusBar) * 2 + capsuleHeight
  } else if (info.platform === 'android') {
    navBar = 48
  }
  if (capsule && capsule.width) capsuleWidth = Number(capsule.width)

  // 胶囊右侧到屏幕右边的间距 —— 自定义导航的内容区右边界就是它
  var capsuleGap = 10
  if (capsule && capsule.right) capsuleGap = Math.max(winWidth - Number(capsule.right), 0)

  sysCache = {
    statusBarHeight: statusBar,
    navBarHeight: navBar,
    navTotalHeight: statusBar + navBar,
    capsuleHeight: capsuleHeight,
    capsuleWidth: capsuleWidth,
    capsuleTop: capsuleTop,
    capsuleRightGap: capsuleGap,
    windowWidth: winWidth,
    windowHeight: winHeight,
    // 页面可视高度给 scroll-view 用（自定义导航时整页高度要自己算）
    contentHeight: winHeight - statusBar - navBar,
  }
  return sysCache
}

// ---------- 减弱动效偏好 ----------
// 微信没有暴露系统的「减弱动态效果」开关，这里用本地存储自己做一个，
// 入口放在「我的」页面，默认关闭（即默认开启动画）。
function reduced() {
  if (reduceCache !== null) return reduceCache
  reduceCache = false
  if (has('getStorageSync')) {
    try {
      reduceCache = wx.getStorageSync(REDUCE_KEY) === true
    } catch (e) {
      reduceCache = false
    }
  }
  return reduceCache
}

function setReduced(value) {
  reduceCache = !!value
  if (has('setStorageSync')) {
    try {
      wx.setStorageSync(REDUCE_KEY, reduceCache)
    } catch (e) {
      /* 存不下就算了，本次会话内仍然生效 */
    }
  }
  return reduceCache
}

// 页面根节点用的 class：动画开着返回 ''，关掉返回 'reduced-motion'
function rootClass() {
  return reduced() ? 'reduced-motion' : ''
}

// ---------- 触感反馈 ----------
// 小程序最有辨识度的交互细节就是震动：选筛选、接单成功、操作失败各给不同强度。
// 安卓部分机型 / 开发者工具没有这个 API，一律静默失败，绝不能因为震动崩掉主流程。
var HAPTIC_MAP = {
  light: 'light',
  select: 'light',
  medium: 'medium',
  heavy: 'heavy',
  success: 'light',
  error: 'heavy',
}

function haptic(kind) {
  if (reduced()) return
  var name = HAPTIC_MAP[kind] || 'light'
  if (!has('vibrateShort')) return
  try {
    wx.vibrateShort({ type: name, fail: function () {} })
  } catch (e) {
    // 老版本基础库不接受 type 参数，退一步用无参调用
    try {
      wx.vibrateShort()
    } catch (e2) {
      /* 没有震动能力，忽略 */
    }
  }
}

// 强反馈：重要节点（接单成功、提交成功）用长震
function hapticStrong() {
  if (reduced()) return
  if (!has('vibrateLong')) return
  try {
    wx.vibrateLong({ fail: function () {} })
  } catch (e) {
    /* 忽略 */
  }
}

// ---------- 入场编排 ----------
// 给列表每一项塞一个 delay 字段，WXML 里写 style="--d:{{item.delay}}ms"。
// step 默认 55ms，max 默认 450ms —— 再长用户就会觉得「卡了一下才出来」。
function stagger(list, step, max) {
  var source = list || []
  var gap = typeof step === 'number' ? step : 55
  var cap = typeof max === 'number' ? max : 450
  var out = []
  for (var i = 0; i < source.length; i += 1) {
    var item = source[i]
    var copy = Object.assign({}, item)
    copy.delay = Math.min(i * gap, cap)
    out.push(copy)
  }
  return out
}

// 一次性把「列表 + 阶梯延迟 + 动画开关」写进页面 data
function setList(page, key, list, step, max) {
  var payload = {}
  payload[key] = stagger(list, step, max)
  page.setData(payload)
  return payload[key]
}

// ---------- 数字滚动 ----------
// 积分 / 余额这类数字直接跳变很生硬，滚上去才有「活」的感觉。
// 返回停止函数，页面 onUnload 里调一下，避免后台还在跑定时器。
function countUp(page, key, target, duration, decimals) {
  var to = Number(target) || 0
  var fixed = typeof decimals === 'number' ? decimals : null
  var shape = function (value) {
    if (fixed !== null) return value.toFixed(fixed)
    return to % 1 === 0 ? Math.round(value) : Math.round(value * 10) / 10
  }
  if (reduced()) {
    var fast = {}
    fast[key] = shape(to)
    page.setData(fast)
    return function () {}
  }
  var ms = typeof duration === 'number' ? duration : 700
  var frames = Math.max(Math.round(ms / 32), 1)
  var step = to / frames
  var current = 0
  var timer = setInterval(function () {
    current += 1
    if (current >= frames) {
      clearInterval(timer)
      var last = {}
      last[key] = shape(to)
      page.setData(last)
      return
    }
    var next = {}
    next[key] = shape(step * current)
    page.setData(next)
  }, 32)
  return function () {
    clearInterval(timer)
  }
}

// ---------- 页面转场 ----------
// 关键操作（下单、接单）给一点触感 + 可选的长震，配合 navigateTo 的原生转场。
function tapFeedback(kind) {
  haptic(kind || 'light')
}

module.exports = {
  systemInfo: systemInfo,
  reduced: reduced,
  setReduced: setReduced,
  rootClass: rootClass,
  haptic: haptic,
  hapticStrong: hapticStrong,
  stagger: stagger,
  setList: setList,
  countUp: countUp,
  tapFeedback: tapFeedback,
}
