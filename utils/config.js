// 云端配置来自开通云服务时返回的 publicConfig。
// 小程序没有 location.origin，endpoint 必须显式传入，不能依赖同域回退。
module.exports = {
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_yPJnSvicojPmz998PjKfpM_hs4SteZBB4P4ukL80RiCj3xjoM56hZ3b',
  appTitle: '校园跑腿',
  school: '广东邮电职业技术学院',
  notice: '服务时间：每日 8:00 - 22:00，其余时间下单将在次日服务时间处理',
  pickupPoint: '线下自提点：进取楼一楼大堂',
  // 常用取件点：发布任务时「取件地址」下面会渲染成快捷标签，点一下即回填。
  // 改这里就能增删，不需要动页面代码。
  pickupShortcuts: [
    '大门外卖柜',
    '外卖柜旁',
    '美心食堂',
    '博学楼食堂',
    '美心食堂小卖部',
    '博学楼天福',
  ],
  // 管理员口令只在服务端 activate_admin 里比对，不要在这里放明文：
  // 小程序代码包可以被反编译，写进来等于把口令公开。
  minReward: 1,
  maxReward: 200,
  // ============ 调试期开关（上线前必须处理） ============
  // 1. 记住登录凭证并在下次打开时自动重登，省去反复输入
  rememberPassword: true,
  autoLogin: true,
  // 2. 预置账号：填上后首次打开就直接自动登录。留空表示不使用。
  //    上线前必须清空这里，并把 rememberPassword / autoLogin 都改成 false。
  presetAccount: { phone: '', password: '' },
  // ============ 调试期开关结束 ============
}
