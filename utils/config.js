// 云端配置来自开通云服务时返回的 publicConfig。
// 小程序没有 location.origin，endpoint 必须显式传入，不能依赖同域回退。
module.exports = {
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_yPJnSvicojPmz998PjKfpM_hs4SteZBB4P4ukL80RiCj3xjoM56hZ3b',
  appTitle: '校园跑腿',
  // 设置页「关于」里显示，每次发版记得 +1
  appVersion: '1.0.0',
  school: '广东邮电职业技术学院',
  // 客服不在这里配联系方式：统一入口是「我的 → 智能客服」，
  // 里面有后台维护的 FAQ 固定回答、AI 兜底和转人工工单，改文案进后台即可。
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
  // 发布配置门禁会强制这两个开关为 false，预置账号必须为空。
  // 不再存储明文密码；SDK 负责已登录会话的恢复。
  rememberPassword: false,
  autoLogin: false,
  presetAccount: { phone: '', password: '' },
}
