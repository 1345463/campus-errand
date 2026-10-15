/**
 * 后台权限（管理员分级）
 *
 * 权限键与后端 admin_grants.perm_key 一一对应：
 *   super    超级管理员 —— 隐含全部权限；唯一能改灰度开关、唯一能授予/收回 super
 *   support  客服       —— 处理意见反馈、查订单处理纠纷
 *   hr       人事       —— 人员查找、授权他人（碰不了 super）
 *   review   审核       —— 接单员实名认证审核
 *   rental   相机       —— 机型挂牌价、租赁报价与生成工单
 *   print    打印       —— 打印工单
 *   settle   结算核查   —— 48 小时未确认的结算申诉判定
 *   dispatch 发单员     —— 批量发单（同楼栋/同楼层一次生成多笔订单）
 *
 * 前端只负责**显示/隐藏入口和二次确认**，真正的拦截在服务端各 RPC 里
 * （都调 admin_has_perm）。前端判断能被绕过，别拿它当安全边界。
 *
 * 用法：
 *   const perms = require('../../utils/perms')
 *   await perms.load()               // 拉本人权限
 *   if (perms.has('settle')) { ... }
 */
const api = require('./api')

const PERMS = [
  { key: 'super', label: '超级管理员', desc: '全部权限，可授权他人、切换灰度开关' },
  { key: 'support', label: '客服', desc: '处理意见反馈，查阅订单处理纠纷' },
  { key: 'hr', label: '人事', desc: '查找人员并授权后台权限（不能授予超级管理员）' },
  { key: 'review', label: '审核', desc: '审核接单员实名认证' },
  { key: 'rental', label: '相机', desc: '管理机型挂牌价与租赁申请报价' },
  { key: 'print', label: '打印', desc: '处理打印工单' },
  { key: 'settle', label: '结算核查', desc: '判定 48 小时未确认的结算申诉' },
  { key: 'dispatch', label: '发单员', desc: '按楼栋/楼层批量发单，并查看自己发出的批次' },
]

const PERM_LABELS = {}
PERMS.forEach(function (item) {
  PERM_LABELS[item.key] = item.label
})

let keys = []
let loaded = false

function load() {
  return api
    .adminMyPerms()
    .then(function (rows) {
      keys = (rows || []).map(function (row) {
        return String(row.perm_key || row)
      })
      loaded = true
      return keys
    })
    .catch(function () {
      keys = []
      loaded = true
      return keys
    })
}

function has(perm) {
  return keys.indexOf(perm) >= 0
}

// 是否有任意一项权限（决定要不要显示「后台」分组）
function anyAdmin() {
  return keys.length > 0
}

function label(perm) {
  return PERM_LABELS[perm] || perm
}

function reset() {
  keys = []
  loaded = false
}

module.exports = {
  PERMS: PERMS,
  PERM_LABELS: PERM_LABELS,
  load: load,
  has: has,
  anyAdmin: anyAdmin,
  label: label,
  reset: reset,
}
