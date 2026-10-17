const motion = require('../../utils/motion')

// 自定义导航栏（navigationStyle: custom 时使用）。
//
// 为什么不用原生导航栏：
//   原生栏只能填一个纯色 + 一个标题，做不了品牌渐变、做不了和页面头部
//   融为一体的主视觉，也没法在标题右边塞自定义入口。小程序的沉浸感
//   基本就靠这一条。
//
// 高度算法见 utils/motion.js 的 systemInfo()：
//   总高 = 状态栏高 + (胶囊顶 - 状态栏高) * 2 + 胶囊高
// 算错就会出现「标题被右上角胶囊压住」或者「标题上下不居中」。
// 真机 iOS / 安卓的状态栏高度不一样，必须运行时取，不能写死。

Component({
  properties: {
    title: { type: String, value: '' },
    // 背景：可以是纯色，也可以直接传 linear-gradient(...)
    bg: { type: String, value: 'linear-gradient(135deg, #2E7CF6 0%, #4FA1FF 60%, #63B3FF 100%)' },
    color: { type: String, value: '#FFFFFF' },
    showBack: { type: Boolean, value: false },
    // 标题随页面滚动淡入：首页顶部是渐变主视觉，标题一直挂着会和 logo 打架
    fadeTitle: { type: Boolean, value: false },
    flow: { type: Boolean, value: false },
  },

  data: {
    statusBarH: 20,
    navH: 44,
    totalH: 64,
    capsuleGap: 10,
    reduced: false,
  },

  lifetimes: {
    attached: function () {
      const sys = motion.systemInfo()
      this.setData({
        statusBarH: sys.statusBarHeight,
        navH: sys.navBarHeight,
        totalH: sys.navTotalHeight,
        capsuleGap: sys.capsuleRightGap + 8,
        reduced: motion.reduced(),
      })
    },
  },

  methods: {
    onBack: function () {
      motion.haptic('light')
      wx.navigateBack({
        fail: function () {
          // 已经是第一个页面（比如从 tabBar 直接进来），退回首页
          wx.switchTab({ url: '/pages/index/index' })
        },
      })
    },
  },
})
