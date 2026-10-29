const upload = require('./upload')
const tcb = require('./tcb')

// 列表查询不返回联系方式，避免任务大厅把手机号暴露给所有人
// 大厅 / 列表只取这些字段：刻意不含 images 和 contact，
// 未接单的人本来就看不到取餐码和图片，列表层先把它们排除掉更省心。
const LIST_FIELDS =
  'id, service_type, service_name, title, description, pickup_addr, deliver_addr, expect_time, tags, gender_limit, reward, status, created_at, owner_name, pickup_building, pickup_floor, deliver_building, deliver_floor, discount_amount'

// SDK 归一后的错误类别（CloudErrorKind），是稳定的编程契约。
// 不要把英文 message 直接弹给用户 —— 断网会看到 request:fail timeout，
// token 失效会看到 no active session，用户根本不知道要做什么。
const KIND_MESSAGES = {
  unauthenticated: '登录状态已失效，请重新登录',
  'permission-denied': '没有权限执行这个操作',
  'invalid-request': '提交的内容有问题，请检查后重试',
  'not-found': '数据不存在，可能已被删除',
  unimplemented: '该功能暂未开放',
  'credits-exhausted': '服务额度已用完，请联系管理员',
  'rate-limited': '操作太频繁，请稍后再试',
  'backend-unavailable': '服务暂时不可用，请稍后重试',
  network: '网络不太稳定，请检查网络后重试',
}

// 我们自己的 RPC 里 RAISE EXCEPTION 写的都是中文（「请先完成接单员认证」
// 「今日 AI 提问次数已用完」），这类业务文案要原样透出，不能被 kind 覆盖。
function hasChinese(text) {
  return /[\u4e00-\u9fa5]/.test(String(text || ''))
}

function getErrorMessage(error) {
  if (!error) return '操作失败，请稍后重试'
  if (typeof error === 'string') return error
  if (error.code === 'invalid_username_or_password') return '账号或密码不对'

  const raw = String(error.message || '')
  if (hasChinese(raw)) return raw
  if (error.kind === 'invalid-request' && /incorrect/i.test(raw)) return '账号或密码不对'
  if (error.kind && KIND_MESSAGES[error.kind]) return KIND_MESSAGES[error.kind]
  if (raw) return raw
  return '操作失败，请稍后重试'
}

// 只返回一个字符串的 RPC 统一改成了 RETURNS TABLE(...)，
// 响应体变成 [{"result":"deleted"}] 这种能被 JSON.parse 的形态。
//
// 为什么必须改库、而不是在前端兼容：SDK 的 processResponse 对响应体做 JSON.parse，
// 解析失败就把**响应体原文**塞进 error.message。RETURNS text 的函数返回的是裸字符串
// （`runner`，不是 `"runner"`），必然解析失败 → 前端拿到的不是 data 而是 error，
// 文案还正好是那个值本身（订单详情页那条红条显示 owner / runner 就是这么来的）。
// 所以前端没法「兜底」，只能让服务端返回结构化结果。
function pickText(result, field) {
  const rows = result && Array.isArray(result.data) ? result.data : []
  if (!rows.length) return ''
  const row = rows[0]
  if (row && typeof row === 'object') {
    const value = row[field]
    return value === null || value === undefined ? '' : String(value)
  }
  return row === null || row === undefined ? '' : String(row)
}

function pad(value) {
  return value < 10 ? '0' + value : '' + value
}

function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (isNaN(date.getTime())) return String(value)
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

// ============================================================
// 会话与身份（R50：整套切到 CloudBase 之后重写）
//
// 旧实现靠 WorkBuddy 登录服务的会话；现在换成：
//   wx.login(code) → 服务端换 openid → 签回一个短期令牌。
// 令牌是服务端用 HMAC 签的，改一个字节验签就过不了，
// 所以「自己填一个 uid 冒充别人」这条路是堵死的 —— 端上只负责存和带。
//
// 对外仍然返回旧形状 { user: { id, name } }，页面层一行都不用改。
// ============================================================
async function getSession() {
  const s = tcb.readSession()
  if (!s) return null
  return { user: { id: s.uid, name: (s.profile && s.profile.nickname) || '' } }
}

async function requireSession() {
  const session = await getSession()
  if (!session) {
    const error = new Error('请先登录')
    error.needLogin = true
    throw error
  }
  return session
}

async function login() {
  const code = await new Promise(function (resolve, reject) {
    wx.login({
      success: function (res) {
        resolve((res && res.code) || '')
      },
      fail: function (err) {
        reject(new Error((err && err.errMsg) || '微信登录失败，请重试'))
      },
    })
  })
  if (!code) throw new Error('微信登录失败，请重试')

  const res = await tcb.callApi('login', { code: code })
  if (!res || !res.uid || !res.token) {
    throw new Error((res && res.error) || '登录失败，请重试')
  }
  tcb.saveSession({ uid: res.uid, token: res.token, profile: res.profile || null })
  return {
    session: { user: { id: res.uid, name: (res.profile && res.profile.nickname) || '' } },
    profile: res.profile || null,
  }
}

async function logout() {
  tcb.saveSession(null)
}

async function restoreSession() {
  const session = await getSession()
  if (!session) return { session: null, profile: null }
  try {
    const profile = await getProfile()
    return { session: session, profile: profile }
  } catch (e) {
    return { session: session, profile: null }
  }
}

async function getProfile() {
  const result = await rpc('my_profile', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

// 首次登录时服务端已经建过档，这里留给「资料没建成」的兜底路径
async function ensureProfile() {
  const existing = await getProfile()
  if (existing) return existing
  const result = await rpc('ensure_my_profile', { p_nickname: '', p_avatar_url: '' })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

/**
 * 统一的 RPC 通道。真正的实现在 utils/tcb.js —— 图片上传（utils/upload.js）
 * 也走同一条路，而 upload 被 api 依赖，反过来 require 会成环，所以放公共层。
 */
function rpc(fn, args) {
  return tcb.rpc(fn, args)
}

async function activateAdmin(code) {
  await requireSession()
  const result = await rpc('activate_admin', { p_code: code })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('激活失败，口令可能不对')
  return rows[0]
}

async function listAllOrders(limit, offset) {
  const result = await rpc('list_all_orders', {
    p_limit: limit || 50,
    p_offset: offset || 0,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

async function updateProfile(patch) {
  await requireSession()
  // 资料写入统一走服务端函数，用 auth.uid() 定位本人记录。
  // owner_id 是大整数字符串（超过 JS 安全整数范围），客户端拼 id 做过滤会因精度丢失匹配不上。
  const p = patch || {}
  if (typeof p.nickname === 'string' || typeof p.avatar_url === 'string') {
    return updateNickname(p.nickname, p.avatar_url)
  }
  if (p.role) return setRole(p.role)
  throw new Error('暂不支持的资料修改')
}

// 身份切换：用户 <-> 接单员。服务端同时校验接单资格是否已审核通过。
async function setRole(role) {
  const result = await rpc('set_my_role', { p_role: role })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('身份切换失败，请重新登录后再试')
  return rows[0]
}

// 提交/重新提交接单员认证：把本人标记为待审核，role 保持 user，等管理端审核通过才升级
async function markCertPending() {
  const result = await rpc('set_cert_pending', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('提交失败，请重新登录后再试')
  return rows[0]
}

// 用户名 / 头像。两个参数都可以只传一个：只传的那个才改，另一个传 undefined 保持原样
// （服务端用 COALESCE 兜底，不会把没传的字段清空）。
async function updateNickname(nickname, avatarPath) {
  const payload = {
    p_nickname: typeof nickname === 'string' ? nickname : null,
    p_avatar_path: typeof avatarPath === 'string' ? avatarPath : null,
  }
  const result = await rpc('update_my_profile', payload)
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('保存失败，请重新登录后再试')
  return rows[0]
}

// 页面用的直白名字：一次把用户名和头像交上去（哪个不要改就传 undefined）
async function updateMyProfile(nickname, avatarPath) {
  await requireSession()
  return updateNickname(nickname, avatarPath)
}

// 发单必须走服务端函数 create_order：
//   1) owner_id / owner_name 由服务端按 auth.uid() 决定，客户端改不了，杜绝冒名发布；
//   2) 服务端会用同一套算法再扫一遍违规词 —— 页面上的检查只是提前提醒，拦不住绕过页面的人。
// 页面层面另有 utils/moderation.js 做输入时的实时检查，提交前会先挡一道。
async function createOrder(payload) {
  await requireSession()
  const result = await rpc('create_order', {
    p_service_type: payload.service_type,
    p_service_name: payload.service_name,
    p_title: payload.title,
    p_description: payload.description,
    p_pickup_addr: payload.pickup_addr,
    p_deliver_addr: payload.deliver_addr,
    p_expect_time: payload.expect_time,
    p_contact: payload.contact,
    p_images: payload.images || [],
    p_tags: payload.tags || [],
    p_gender_limit: payload.gender_limit,
    p_reward: payload.reward,
    // 楼栋 / 楼层由下单页的宿舍选择器拆出来，单独存字段给大厅筛选用，
    // 省得每次筛选都要去 LIKE 地址字符串
    p_pickup_building: payload.pickup_building || '',
    p_pickup_floor: payload.pickup_floor || '',
    p_deliver_building: payload.deliver_building || '',
    p_deliver_floor: payload.deliver_floor || '',
    // 用了抵扣券就传券码，服务端负责核销并记账；没用就传空串
    p_deduct_code: payload.deduct_code || '',
    // 优先展示券：勾选后这一单在大厅置顶（服务端校验类型并一次性核销）
    p_boost_code: payload.boost_code || '',
    // 批量发单的批次号，普通下单留空
    p_batch_no: payload.batch_no || '',
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('发布失败，请稍后重试')
  return rows[0]
}

// ---- 内容安全 ----

// 拉服务端最新违规词（缓存逻辑在 utils/moderation.js 里）
async function listModerationWords() {
  const result = await rpc('list_active_moderation_words', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 举报订单。服务端会校验举报人是该单的发布方或接单员，重复举报会被拒绝。
async function reportOrder(orderId, reason, detail) {
  const result = await rpc('report_order', {
    p_order_id: orderId,
    p_reason: reason,
    p_detail: detail || '',
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return result.data
}

async function getMyReport(orderId) {
  const result = await rpc('my_order_report', { p_order_id: orderId })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

async function adminListReports(limit) {
  const result = await rpc('admin_list_reports', { p_limit: limit || 50 })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// action: 'take_down' 下架订单 | 'reject' 驳回举报
async function adminHandleReport(id, action, note) {
  const result = await rpc('admin_handle_report', {
    p_id: id,
    p_action: action,
    p_note: note || null,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('处理失败，该举报可能已被处理')
  return rows[0]
}

// 大厅：走服务端 list_hall_orders，不再直连 orders 表。
// 原因有三：①置顶要求 boosted 优先排序；②is_special / takedown 的排除条件
// 散在前端容易漂移；③接单员门槛必须服务端判（前端判断能被绕过）。
async function listHallOrders(options) {
  const opts = options || {}
  const result = await rpc('list_hall_orders', {
    p_service_type: opts.serviceType || '',
    p_sort: opts.sort || 'time',
    p_building: opts.building || '',
    p_floor: opts.floor || '',
    p_keyword: opts.keyword || '',
    p_offset: opts.offset || 0,
    p_limit: opts.limit || 20,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 管理员批量发单：一次内容发到多个宿舍，返回本次生成的所有订单
async function adminBatchCreateOrders(payload) {
  await requireSession()
  const result = await rpc('admin_batch_create_orders', {
    p_service_type: payload.service_type,
    p_service_name: payload.service_name,
    p_title: payload.title,
    p_description: payload.description,
    p_pickup_addr: payload.pickup_addr,
    p_expect_time: payload.expect_time,
    p_contact: payload.contact,
    p_gender_limit: payload.gender_limit || '不限',
    p_reward: payload.reward,
    p_targets: payload.targets || [],
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 发单员看自己发出去的批次汇总
async function adminListDispatchOrders(limit) {
  const result = await rpc('admin_list_dispatch_orders', {
    p_limit: limit || 50,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 本人的订单同样走服务端函数定位，避免客户端拿 owner_id / runner_id 做等值过滤。
async function listMyOrders(mode, limit, offset, status, keyword) {
  await requireSession()
  const result = await rpc('list_my_orders_v2', {
    p_mode: mode === 'admin' ? 'admin' : mode === 'accept' ? 'accept' : 'publish',
    p_limit: limit || 20,
    p_offset: offset || 0,
    p_status: status || 'all',
    p_keyword: String(keyword || '').trim(),
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 按单号 / 标题 / 描述搜自己相关的单（受灰度开关 order_search 控制）
async function searchMyOrders(keyword, limit) {
  await requireSession()
  const result = await rpc('search_my_orders', {
    p_keyword: String(keyword || '').trim(),
    p_limit: limit || 20,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 'owner' | 'runner' | 'none'，由服务端判断，客户端不做 id 比较
async function getOrderRelation(id) {
  const result = await rpc('order_relation', { p_order_id: id })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const relation = pickText(result, 'relation')
  return relation || 'none'
}

// 只取「非敏感」的展示字段。
// orders 的行级读策略对已认证接单员是全表放开的，select('*') 会把 contact（手机/微信）、
// images、deliver_images（取餐码截图）一并下发 —— 想拿整单请走 getOrderDetail，
// 那里由服务端按「是不是这一单的参与方」做脱敏。
const ORDER_SUMMARY_FIELDS =
  'id, owner_id, runner_id, status, reward, service_type, service_name, title, ' +
  'created_at, accepted_at, runner_done_at, finished_at, deliver_building, deliver_floor'

async function getOrder(id) {
  // 直接查表这条路不能留：中转用的是服务角色，RLS 被绕过，
  // 一旦还能按任意条件查表，等于谁都能读别人的行。
  // get_order_detail 在服务端按「是不是这一单的参与方」脱敏，更严格也更省事。
  const result = await rpc('get_order_detail', { p_order_id: id })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

// 订单详情统一走服务端函数 get_order_detail：
// 没接单的人拿到的是脱敏结果（images / contact / deliver_images 被清空），
// 接单员只有在自己接了这单之后才看得到取餐码和图片。
// 前端自己藏字段没用——数据都已经到客户端了，得在服务端就掐掉。
async function getOrderDetail(id) {
  const result = await rpc('get_order_detail', { p_order_id: id })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

function callOrderRpc(name, id) {
  return rpc(name, { p_order_id: id })
    .then(function (result) {
      if (result.error) throw new Error(getErrorMessage(result.error))
      const rows = Array.isArray(result.data) ? result.data : []
      if (!rows.length) {
        const error = new Error('操作未生效：订单状态可能已变更')
        error.noEffect = true
        throw error
      }
      return rows[0]
    })
}

function acceptOrder(id) {
  return callOrderRpc('accept_order', id)
}

// 接单员标记送达：必须带佐证照片（服务端会校验至少 1 张），只改状态不结算
function completeOrder(id, images) {
  // 是否强制照片由服务端 deliver_photo 开关判定。
  images = images || []
  return rpc('complete_order', { p_order_id: id, p_images: images })
    .then(function (result) {
      if (result.error) throw new Error(getErrorMessage(result.error))
      const rows = Array.isArray(result.data) ? result.data : []
      if (!rows.length) {
        const error = new Error('操作未生效：订单状态可能已变更')
        error.noEffect = true
        throw error
      }
      return rows[0]
    })
}

function abandonOrder(id) {
  return callOrderRpc('abandon_order', id)
}

function cancelOrder(id) {
  return callOrderRpc('cancel_order', id)
}

// 发布方确认：赏金才真正打进接单员钱包
function confirmOrderDone(id) {
  return callOrderRpc('confirm_order_done', id)
}

// 接单员：完成满 48 小时发布方仍未确认，可申请管理员核查
async function submitSettleFeedback(id, text) {
  const result = await rpc('submit_settle_feedback', { p_order_id: id, p_text: text })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('提交失败，请确认订单状态')
  return rows[0]
}

async function adminListFeedbacks(limit) {
  const result = await rpc('admin_list_feedbacks', { p_limit: limit || 50 })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

async function adminResolveFeedback(id, approve, note) {
  const result = await rpc('admin_resolve_feedback', {
    p_order_id: id,
    p_approve: !!approve,
    p_note: note || null,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('处理失败，该反馈可能已被处理')
  return rows[0]
}

// 相机租赁：用户端只提交预填信息，不再直接下单
async function submitRentalRequest(payload) {
  await requireSession()
  const result = await rpc('submit_rental_request', {
    p_item_id: payload.itemId,
    p_item_name: payload.itemName,
    p_unit_price: payload.unitPrice,
    p_days: payload.days,
    p_real_name: payload.realName,
    p_student_no: payload.studentNo,
    p_college: payload.college,
    p_contact: payload.contact,
    p_expect_from: payload.expectFrom,
    p_expect_to: payload.expectTo,
    p_pickup_addr: payload.pickupAddr,
    p_note: payload.note,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('提交失败，请重试')
  return rows[0]
}

async function listMyRentalRequests() {
  const result = await rpc('list_my_rental_requests', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 管理员：查看全部租赁预填申请
async function adminListRentalRequests(status) {
  const result = await rpc('admin_list_rental_requests', {
    p_status: status || 'all',
    p_limit: 100,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 管理员：改价格（含押金），并标记为已报价
async function adminSetRentalPrice(id, price, deposit) {
  const result = await rpc('admin_set_rental_price', {
    p_id: id,
    p_price: price,
    p_deposit: deposit,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('改价失败，请重试')
  return rows[0]
}

// 管理员：按报价生成特殊工单（仅管理员可见，不进公共大厅）
async function adminCreateRentalOrder(id) {
  const result = await rpc('admin_create_rental_order', { p_id: id })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('生成失败，请重试')
  return rows[0]
}

// 相机租赁机型 + 挂牌价：读服务端 rental_items 表。
// 以前写死在 utils/services.js 里，改一次价就要发一次版 —— 现在管理员后台改完即刻生效。
// 请求失败退回打包的兜底清单，保证老版本 / 断网时页面不空白。
async function listRentalItems() {
  const result = await rpc('list_rental_items', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

async function adminListRentalItems() {
  const result = await rpc('admin_list_rental_items', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 传 null 的字段表示不改，只动传了值的那些
async function adminUpdateRentalItem(id, patch) {
  const change = patch || {}
  const result = await rpc('admin_update_rental_item', {
    p_id: id,
    p_name: change.name === undefined ? null : change.name,
    p_spec: change.spec === undefined ? null : change.spec,
    p_price: change.price === undefined ? null : change.price,
    p_deposit: change.deposit === undefined ? null : change.deposit,
    p_enabled: change.enabled === undefined ? null : !!change.enabled,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('保存失败，该机型可能已不存在')
  return rows[0]
}

async function adminCreateRentalItem(payload) {
  const result = await rpc('admin_create_rental_item', {
    p_name: payload.name,
    p_spec: payload.spec || '',
    p_price: payload.price,
    p_deposit: payload.deposit || 0,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('新增失败，请重试')
  return rows[0]
}

// 用户协议：记录同意的版本与时间
async function acceptAgreement(version) {
  const result = await rpc('accept_agreement', { p_version: version || 'v1' })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('记录失败，请重新登录后再试')
  return rows[0]
}

async function listAddresses() {
  const result = await rpc('list_my_addresses', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

async function addAddress(payload) {
  await requireSession()
  const p = payload || {}
  const result = await rpc('create_my_address', {
    p_contact_name: p.contact_name,
    p_phone: p.phone,
    p_building: p.building,
    p_room: p.room,
    p_tag: p.tag,
    p_is_default: !!p.is_default,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

async function removeAddress(id) {
  await requireSession()
  const result = await rpc('delete_my_address', { p_id: id })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const removed = Array.isArray(result.data) ? result.data : []
  if (!removed.length) throw new Error('删除失败，该地址可能不存在')
  return true
}

async function getApplication() {
  const result = await rpc('my_cert_application', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

async function submitApplication(payload) {
  await requireSession()
  const p = payload || {}
  const result = await rpc('submit_cert_application', {
    p_real_name: p.real_name,
    p_id_no_masked: p.id_no_masked,
    p_id_card_path: p.id_card_path,
    p_student_card_path: p.student_card_path,
    p_detected_name: p.detected_name,
    p_detected_no: p.detected_no,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

// 管理员：查接单员认证申请。走 SECURITY DEFINER 函数，
// 因为 runner_applications 的 RLS 只允许本人读写。
async function listApplications(status) {
  const result = await rpc('list_runner_applications', {
    p_status: status || 'pending',
    p_limit: 100,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 调试用：生成一条合成申请，owner_id 是虚构值，不会污染任何真实用户的认证状态。
// 让管理员在没有人提交申请时也能走通审核流程。

// ---- 灰度开关 ----

// 公开读：游客也要能按开关决定首页轮播展不展示
async function listFeatureFlags() {
  const result = await rpc('list_feature_flags', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 只有超级管理员能切换
async function adminSetFeatureFlag(key, enabled) {
  const result = await rpc('admin_set_feature_flag', {
    p_flag_key: key,
    p_enabled: !!enabled,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

// ---- 管理员分级授权 ----

// 我拥有的权限（super 会被展开成全部七项）
async function adminMyPerms() {
  const result = await rpc('admin_my_perms', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 我能不能给别人授权（super / hr）
async function adminCanGrant() {
  const result = await rpc('admin_can_grant', {})
  if (result.error) return false
  return result.data === true || result.data === 'true'
}

// 人员查找：昵称 / 姓名 / ID / 手机号 / 学号 模糊搜
async function adminSearchStaff(keyword, limit) {
  const result = await rpc('admin_search_staff', {
    p_keyword: String(keyword || '').trim(),
    p_limit: limit || 20,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 授予或收回某人的某项权限
async function adminSetPerm(userId, permKey, enabled) {
  const result = await rpc('admin_set_perm', {
    p_user_id: String(userId || '').trim(),
    p_perm_key: permKey,
    p_enabled: !!enabled,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return pickText(result, 'result')
}

// ---- 首页轮播 ----

async function listBanners() {
  const result = await rpc('list_banners', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

async function adminListBanners() {
  const result = await rpc('admin_list_banners', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

async function adminCreateBanner(payload) {
  const result = await rpc('admin_create_banner', {
    p_title: payload.title || '',
    p_image_path: payload.image_path || '',
    p_link_type: payload.link_type || 'none',
    p_link_value: payload.link_value || '',
    p_sort_order: payload.sort_order || 0,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

async function adminUpdateBanner(id, patch) {
  const p = patch || {}
  const result = await rpc('admin_update_banner', {
    p_id: id,
    p_title: p.title === undefined ? null : p.title,
    p_image_path: p.image_path === undefined ? null : p.image_path,
    p_link_type: p.link_type === undefined ? null : p.link_type,
    p_link_value: p.link_value === undefined ? null : p.link_value,
    p_sort_order: p.sort_order === undefined ? null : p.sort_order,
    p_enabled: p.enabled === undefined ? null : p.enabled,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

async function adminDeleteBanner(id) {
  const result = await rpc('admin_delete_banner', { p_id: id })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return pickText(result, 'result')
}

// ---- 消息中心 ----

async function listMyMessages(limit, offset) {
  const result = await rpc('list_my_messages', {
    p_limit: limit || 20,
    p_offset: offset || 0,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

async function unreadMessageCount() {
  const result = await rpc('unread_message_count', {})
  if (result.error) return 0
  return Number(result.data) || 0
}

async function markMessageRead(id) {
  const result = await rpc('mark_message_read', { p_id: id })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return pickText(result, 'result')
}

async function markAllMessagesRead() {
  const result = await rpc('mark_all_messages_read', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  return pickText(result, 'result')
}

// ---- 评价 ----

async function submitOrderReview(orderId, score, tags, comment) {
  const result = await rpc('submit_order_review', {
    p_order_id: orderId,
    p_score: Number(score) || 5,
    p_tags: tags || [],
    p_comment: comment || '',
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

async function getOrderReviews(orderId) {
  const result = await rpc('get_order_reviews', { p_order_id: orderId })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 我在这张单上的评价状态：能不能评、我评了几分、对方评了几分。
// 返回 { can_review, my_score, my_comment, peer_score, peer_comment }
async function myOrderReviewState(orderId) {
  const result = await rpc('my_order_review_state', { p_order_id: orderId })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : { can_review: false, my_score: 0, my_comment: '', peer_score: 0, peer_comment: '' }
}

// 这单「对面那位」的信誉分：下单人看接单员，接单员看下单人。
// 非参与方（管理员除外）在服务端会被直接拒绝。
async function orderPeerCredit(orderId) {
  const result = await rpc('order_peer_credit', { p_order_id: orderId })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

// 我提交过的反馈及处理状态（普通用户可查自己的）
async function listMyFeedbacks(limit) {
  const result = await rpc('list_my_feedbacks', { p_limit: limit || 20 })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// ---- 意见反馈工单：受理后的双向跟进对话 ----
// 客服和提交人共用同一组接口，能不能看、能不能说，全由服务端按角色判定，
// 前端不再拿自己的 profile 猜身份，避免两边规则写歪。

// 工单详情（含「我能不能发言」与对方未读数）
async function feedbackDetail(id) {
  const result = await rpc('feedback_detail', { p_feedback_id: id })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

// 会话消息（按时间正序，前端直接拿来渲染气泡）
async function feedbackThread(id, limit) {
  const result = await rpc('feedback_thread', {
    p_feedback_id: id,
    p_limit: limit || 200,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 发言。客服在「待处理」下的第一条回复＝受理；服务端会把状态一并流转
async function feedbackReply(id, content) {
  const result = await rpc('feedback_reply', {
    p_feedback_id: id,
    p_content: content || '',
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

// 打开会话后清掉自己这侧的未读水位
async function feedbackMarkRead(id) {
  const result = await rpc('feedback_mark_read', { p_feedback_id: id })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return result.data === true
}

// 客服：把驳回的工单重新受理，重新开放双向对话
async function adminReopenFeedback(id) {
  const result = await rpc('admin_reopen_feedback', { p_feedback_id: id })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

// 管理员工作台：各类待办计数 + 调用者自身权限位图
async function adminDashboardStats() {
  const result = await rpc('admin_dashboard_stats', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

// ---- 积分 / 钱包流水 ----

async function listMyPointRecords(limit, offset) {
  const result = await rpc('list_my_point_records', {
    p_limit: limit || 20,
    p_offset: offset || 0,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

async function listMyWalletRecords(limit, offset) {
  const result = await rpc('list_my_wallet_records', {
    p_limit: limit || 20,
    p_offset: offset || 0,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// ---- 积分商城（真实兑换）----

// 礼券由服务端 point_goods 表下发：库存、上下架在库里改，不用发新版本
async function listPointGoods() {
  const result = await rpc('list_point_goods', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 兑换：扣积分、扣库存、生成兑换码都在服务端一次做完
async function exchangePointGoods(goodsId) {
  await requireSession()
  const result = await rpc('exchange_point_goods', { p_goods_id: goodsId })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('兑换没有生效，请稍后再试')
  return rows[0]
}

async function listMyRedemptions(limit) {
  const result = await rpc('list_my_redemptions', { p_limit: limit || 20 })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 我的券包：兑换后直接躺在账户里，抵扣券在下单时能用，礼券到店出示码核销
async function listMyCoupons() {
  const result = await rpc('list_my_coupons', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// ---- 积分商城：结算员 / 超管后台 ----

async function adminListPointGoods() {
  const result = await rpc('admin_list_point_goods', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 新增或改一个商品：不传 id 就是新增（id 由服务端按时间生成）
async function adminUpsertPointGoods(payload) {
  const result = await rpc('admin_upsert_point_goods', {
    p_id: payload.id || '',
    p_name: payload.name || '',
    p_emoji: payload.emoji || '',
    p_cost: payload.cost || 0,
    p_stock: payload.stock || 0,
    p_descr: payload.descr || '',
    p_benefit_type: payload.benefit_type || 'verify',
    p_deduct_value: payload.deduct_value || 0,
    p_enabled: payload.enabled !== false,
    p_sort_order: payload.sort_order || 100,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

// 手工调整某个同学的积分（正负都行，必须写原因）
async function adminAdjustPoints(userId, delta, remark) {
  const result = await rpc('admin_adjust_points', {
    p_user_id: userId || '',
    p_delta: delta || 0,
    p_remark: remark || '',
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

// 管理员核销兑换码（礼券类）
async function adminVerifyRedemption(code) {
  const result = await rpc('admin_verify_redemption', { p_code: code || '' })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('核销没有生效，请稍后再试')
  return rows[0]
}

// 按昵称 / ID 搜人，用于积分调整时选对象
async function adminSearchPointsUser(keyword, limit) {
  const result = await rpc('admin_search_points_user', {
    p_keyword: keyword || '',
    p_limit: limit || 20,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// ---- 我的评价 / 信誉分 ----

// 已经完成、我还没评的订单
async function listMyReviewTodo(limit) {
  const result = await rpc('list_my_review_todo', { p_limit: limit || 20 })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 别人给我的评价
async function listMyReceivedReviews(limit) {
  const result = await rpc('list_my_received_reviews', { p_limit: limit || 20 })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 信誉分汇总：平均分 / 被评次数 / 好评数 / 完成订单数 / 优先展示有效期
async function myCreditSummary() {
  const result = await rpc('my_credit_summary', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return (
    rows[0] || {
      runner_score: 0,
      runner_count: 0,
      received_count: 0,
      good_count: 0,
      done_count: 0,
      boost_until: null,
    }
  )
}

// ---- 意见反馈 ----

async function submitUserFeedback(kind, content, contact) {
  await requireSession()
  const result = await rpc('submit_user_feedback', {
    p_kind: kind || 'suggestion',
    p_content: content || '',
    p_contact: contact || '',
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

async function adminListUserFeedbacks(status, limit) {
  const result = await rpc('admin_list_user_feedbacks', {
    p_status: status || 'all',
    p_limit: limit || 50,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

async function adminHandleUserFeedback(id, action, note) {
  const result = await rpc('admin_handle_user_feedback', {
  p_id: id,
  p_action: action,
  p_note: note || null,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

// 管理员：通过 / 驳回认证。函数内部会同步改写 profiles 的 cert_status 和 role。
async function reviewApplication(id, approve, note) {
  const result = await rpc('review_runner_application', {
    p_app_id: id,
    p_approve: !!approve,
    p_note: note || null,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('处理失败，该申请可能已被处理过')
  return rows[0]
}

// ---- 历史订单删除 ----

// 删除只影响「我自己的」列表：接单员/发布方那边的同一张单不受影响。
// 服务端 hide_my_order 会再判一次资格（完结满 7 天，或违规下架），前端只是提前给个提示。
async function hideMyOrder(orderId) {
  const result = await rpc('hide_my_order', { p_order_id: orderId })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return pickText(result, 'result')
}

// 误删退路：把隐藏记录去掉，订单重新出现在列表里
async function restoreMyOrder(orderId) {
  const result = await rpc('restore_my_order', { p_order_id: orderId })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return pickText(result, 'result')
}

// 该单是否已进入删除状态（任一方删除即整单隐藏，双方列表都不再显示）
async function isOrderHidden(orderId) {
  const result = await rpc('order_hidden', { p_order_id: orderId })
  if (result.error) return false
  return result.data === true || result.data === 'true'
}

async function listMyHiddenOrders() {
  const result = await rpc('list_my_hidden_orders', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 图片上传走 utils/upload.js 自实现的通道。
// SDK 的 cloud.storage.upload 在小程序里传 ArrayBuffer 必然失败
//（小程序适配层的 fetch 只支持字符串 body），详见该文件头部说明。
async function uploadImage(tempFilePath, folder) {
  const session = await requireSession()
  return upload.uploadImage(tempFilePath, folder, session.user.id)
}

async function signOne(path) {
  if (!path) return { url: '', error: '这条记录没有图片路径' }
  let reason = ''

  // 旧的 WorkBuddy SDK 通道已经随换库一起下线，这里只剩自实现这一条：
  // 出错时能拿到 HTTP 状态和服务端原话，比 SDK 的黑盒好排查。
  try {
    const url = await upload.createSignedUrl(path, 3600)
    if (url) return { url: url, error: '' }
    reason = '服务端没有返回链接'
  } catch (error) {
    reason = getErrorMessage(error)
  }

  // 签名失败时再探一次对象是否真的存在，好区分「没传上去」和「传了但没权限读」
  const probe = await upload.probeObject(path)
  if (probe) reason = reason + '（' + probe + '）'
  return { url: '', error: reason || '生成链接失败' }
}

/**
 * 取一张图片可用的显示地址。
 *
 * 新数据（asset:<id>，存库）：走 media_assets 表
 *   1) 优先写成本地临时文件 —— 没有体积膨胀（setData 单次上限 1MB），且能进 previewImage 放大看
 *   2) 文件系统不可用时退到 data URL
 * 旧数据（users/... 对象路径）：沿用对象存储的三级兜底，避免历史记录直接变空白
 *
 * 返回 { url, error, signError }。error 一定说人话，绝不返回空串让页面猜。
 */
async function getImageUrl(path) {
  if (!path) return { url: '', error: '这条记录没有图片路径', signError: '' }

  if (upload.isAssetPath(path)) {
    const reasons = []
    try {
      const localPath = await upload.assetToLocalFile(path)
      if (localPath) return { url: localPath, error: '', signError: '' }
      reasons.push('本地文件为空')
    } catch (error) {
      reasons.push(getErrorMessage(error))
    }
    try {
      const dataUrl = await upload.assetToDataUrl(path)
      if (dataUrl) return { url: dataUrl, error: '', signError: '' }
      reasons.push('data URL 为空')
    } catch (error) {
      reasons.push(getErrorMessage(error))
    }
    return { url: '', error: reasons.join('；') || '读取图片失败', signError: '' }
  }

  const signed = await signOne(path)
  if (signed.url) return { url: signed.url, error: '', signError: '' }

  const legacyReasons = []
  const note = function (message) {
    if (message && legacyReasons.indexOf(message) < 0) legacyReasons.push(message)
  }
  try {
    const localPath = await upload.fetchToLocalFile(path)
    if (localPath) return { url: localPath, error: '', signError: signed.error || '未知原因' }
    note('本地文件为空')
  } catch (error) {
    note(getErrorMessage(error))
  }
  try {
    const dataUrl = await upload.fetchAsDataUrl(path)
    if (dataUrl) return { url: dataUrl, error: '', signError: signed.error || '未知原因' }
    note('data URL 为空')
  } catch (error) {
    note(getErrorMessage(error))
  }

  const direct = legacyReasons.join('；')
  const detail = signed.error ? signed.error + '；直读：' + direct : direct
  // 旧通道存的图服务端已经取不回来（见 upload.js 顶部说明）。
  // 这种情况不是偶发失败，重试多少次都一样 —— 直接告诉管理员该让用户重传，
  // 别让他对着一串 STORAGE_OBJECT_NOT_FOUND 反复点。技术细节仍附在括号里备查。
  return {
    url: '',
    error: '这张照片是用旧上传通道存的，服务端已取不回，请让该用户重新提交证件（' + detail + '）',
    signError: signed.error || '',
    legacy: true,
  }
}

// 返回 [{ url, error, signError }]。
// 早先这里失败只 push 一个空串，页面上永远只看到「加载失败」四个字，
// 真正的原因（权限 / 路径 / 服务端报错）全被吞掉 —— 现在原样带出来。
/**
 * 取**订单相关**图片（任务图 / 送达佐证）的可显示地址。
 *
 * 和 getSignedUrls 的区别：订单里的图是跨人看的（发布方传任务图给接单员看、
 * 接单员传佐证给发布方看），所以必须带上订单号走 get_order_asset，
 * 让服务端按"我是这一单的参与方 + 这张图挂在这一单上"两道条件放行。
 * 直接走 getSignedUrls 会因为"不是本人上传"而一张都读不出来。
 */
async function getOrderImageUrl(path, orderId) {
  if (!path) return { url: '', error: '这条记录没有图片路径', signError: '' }
  if (!upload.isAssetPath(path)) {
    // 历史数据里存的是对象路径，那种没有订单归属，沿用老通道
    return getImageUrl(path)
  }
  const reasons = []
  try {
    const localPath = await upload.orderAssetToLocalFile(path, orderId)
    if (localPath) return { url: localPath, error: '', signError: '' }
    reasons.push('本地文件为空')
  } catch (error) {
    reasons.push(getErrorMessage(error))
  }
  try {
    const dataUrl = await upload.orderAssetToDataUrl(path, orderId)
    if (dataUrl) return { url: dataUrl, error: '', signError: '' }
    reasons.push('data URL 为空')
  } catch (error) {
    reasons.push(getErrorMessage(error))
  }
  return { url: '', error: reasons.join('；') || '读取订单图片失败', signError: '' }
}

async function getOrderImageUrls(paths, orderId) {
  const list = Array.isArray(paths) ? paths : []
  return Promise.all(
    list.map(function (path) {
      return getOrderImageUrl(path, orderId).catch(function (error) {
        return { url: '', error: getErrorMessage(error), signError: '' }
      })
    })
  )
}

async function getSignedUrls(paths) {
  const list = Array.isArray(paths) ? paths : []
  // 并发取：一张图一次往返，5 张串起来要等 5 轮，详情页打开会明显卡一下。
  // 结果顺序与入参一致（Promise.all 保证），出错的单条各自带 error，不拖垮其它图。
  return Promise.all(
    list.map(function (path) {
      return getImageUrl(path).catch(function (error) {
        return { url: '', error: getErrorMessage(error), signError: '' }
      })
    })
  )
}

/**
 * 取公开图片（首页轮播）的可显示地址。
 *
 * 轮播是管理员上传的，游客也要能看到，所以走 get_public_asset 而不是私有的 get_media_asset。
 * 返回结构和 getSignedUrls 一致，页面代码不用分叉。
 */
async function getPublicImageUrl(path) {
  if (!path) return { url: '', error: '这条记录没有图片路径' }
  const reasons = []
  try {
    const localPath = await upload.publicAssetToLocalFile(path)
    if (localPath) return { url: localPath, error: '' }
    reasons.push('本地文件为空')
  } catch (error) {
    reasons.push(getErrorMessage(error))
  }
  try {
    const dataUrl = await upload.publicAssetToDataUrl(path)
    if (dataUrl) return { url: dataUrl, error: '' }
    reasons.push('data URL 为空')
  } catch (error) {
    reasons.push(getErrorMessage(error))
  }
  return { url: '', error: reasons.join('；') || '读取轮播图失败' }
}

async function getPublicImageUrls(paths) {
  const list = Array.isArray(paths) ? paths : []
  return Promise.all(
    list.map(function (path) {
      return getPublicImageUrl(path).catch(function (error) {
        return { url: '', error: getErrorMessage(error) }
      })
    })
  )
}

// ============================================================
// AI 智能客服：FAQ 固定回答 + 大模型兜底
// FAQ 由客服在后台维护（faq_items 表），端上只读启用的条目；
// 大模型走云服务免密钥 LLM，只有流式一种调用方式，端上把片段拼成完整回答。
// ============================================================

// 游客也能看的常见问题（服务端只返回 enabled 的）
async function listFaqItems() {
  const result = await rpc('list_faq_items', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

// 客服设置：AI 开关 / 模型 / 系统提示词 / 欢迎语 / 上限，还有一整套模型调用参数。
// ai_prompt 一并返回：端上直连大模型，system 消息得在客户端拼。
// 它不是密钥 —— 真正的凭证在云服务 SDK 里，端上拿不到；藏起来只会让 AI 用不了。
async function getFaqSettings() {
  const result = await rpc('get_faq_settings', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length
    ? rows[0]
    : {
        ai_enabled: false,
        ai_model: '',
        ai_prompt: '',
        welcome: '',
        daily_limit: 20,
        temperature: 0.3,
        max_tokens: 400,
        context_faq_limit: 40,
        history_turns: 3,
        timeout_ms: 30000,
      }
}

async function adminListFaqItems() {
  const result = await rpc('admin_list_faq_items', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data : []
}

async function adminUpsertFaqItem(item) {
  const result = await rpc('admin_upsert_faq_item', {
    p_id: item.id || null,
    p_category: item.category || '',
    p_question: item.question || '',
    p_answer: item.answer || '',
    p_keywords: item.keywords || '',
    p_sort_order: item.sort_order === undefined ? null : item.sort_order,
    p_enabled: item.enabled === undefined ? null : item.enabled,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return result.data
}

async function adminDeleteFaqItem(id) {
  const result = await rpc('admin_delete_faq_item', { p_id: id })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return result.data === true
}

async function adminGetFaqSettings() {
  const result = await rpc('admin_get_faq_settings', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.length ? rows[0] : null
}

// 超过 10 个参数的 RPC，参数名一个都不能拼错：PostgreSQL 是按名字匹配的，
// 漏一个直接 42883 function does not exist。
async function adminUpdateFaqSettings(patch) {
  const p = patch || {}
  const result = await rpc('admin_update_faq_settings', {
    p_ai_enabled: p.ai_enabled === undefined ? null : p.ai_enabled,
    p_ai_model: p.ai_model === undefined ? null : p.ai_model,
    p_ai_prompt: p.ai_prompt === undefined ? null : p.ai_prompt,
    p_welcome: p.welcome === undefined ? null : p.welcome,
    p_daily_limit: p.daily_limit === undefined ? null : p.daily_limit,
    p_temperature: p.temperature === undefined ? null : p.temperature,
    p_max_tokens: p.max_tokens === undefined ? null : p.max_tokens,
    p_context_faq_limit: p.context_faq_limit === undefined ? null : p.context_faq_limit,
    p_history_turns: p.history_turns === undefined ? null : p.history_turns,
    p_timeout_ms: p.timeout_ms === undefined ? null : p.timeout_ms,
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  return result.data === true
}

// ---- 大模型 ----
// R52 迁到 CloudBase 之后这里一度是占位实现（返回空数组 / 直接抛错），
// 结果后台一直显示「暂无可用模型」。现在走 cloudfunctions/ai-api：
// 云开发自带大模型能力且兼容 OpenAI 协议，密钥只留在云函数里，端上碰不到。
//
// 关于流式：云函数 → 小程序这一段没法流式回传，所以这里拿到的是一次性的完整文本。
// onDelta 仍然按约定回调一次（传完整文本），页面层的「正在输入」效果不变。
async function llmModels() {
  const res = await tcb.callTarget('ai-api', { action: 'models' })
  const list = (res && Array.isArray(res.models) && res.models) || []
  return list
}

// options: { conversationId, signal, temperature, maxTokens }
// conversationId 只做服务端路由与计量 —— 它不等于「服务端记住了上文」，
// 上下文仍然要靠 messages 自己带上（support 页会把最近几轮对话拼进来）。
// 温度与最大字数由后台 faq_settings 下发，默认给客服场景的保守值。
async function llmChat(modelId, messages, onDelta, options) {
  const opts = options || {}
  const res = await tcb.callTarget('ai-api', {
    action: 'chat',
    model: String(modelId || ''),
    messages: messages || [],
    temperature: typeof opts.temperature === 'number' ? opts.temperature : undefined,
    maxTokens: typeof opts.maxTokens === 'number' ? opts.maxTokens : undefined,
  })
  const text = String((res && res.text) || '')
  if (typeof onDelta === 'function') onDelta(text)
  return text
}

async function supportRpc(name, args) {
  await requireSession()
  const result = await rpc(name, args || {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  return Array.isArray(result.data) ? result.data[0] : result.data
}
function beginSupportAi() { return supportRpc('begin_support_ai') }
function finishSupportAi(id, success) { return supportRpc('finish_support_ai', { p_request_id: id, p_success: success }) }
function getSupportUsage() { return supportRpc('support_ai_usage') }
function rateSupportAnswer(id, faqId, helpful) {
  return supportRpc('rate_support_answer', { p_request_id: id, p_faq_id: faqId, p_helpful: helpful })
}

// ---- 手机号绑定（R44）----
//
// 产品规则：浏览大厅不拦，但**发单 / 接单 / 查看联系方式**必须先绑手机号。
// 真正拦截在服务端（orders 触发器 + get_order_detail 脱敏），这里只给页面
// 一个「要不要先引导去绑定」的判断，避免用户填完表单才被拒。

async function getMyPhoneState() {
  await requireSession()
  const result = await rpc('my_phone_state', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  const row = rows[0] || {}
  return {
    bound: row.bound === true,
    phone: row.phone || '',
    verifiedAt: row.verified_at || '',
    cooldownUntil: row.cooldown_until || '',
  }
}

// 发短信验证码。
//
// 旧实现要「借道」到手机号身份去让 auth provider 验码，验完再切回微信身份 ——
// 中间一断用户就落在陌生账号上（就是 R44 修的那个「绑完跳号」）。
// 新后端不需要借道：验证码由服务端生成、库里只存哈希、明文只回到云函数去发短信，
// 整条链路都在同一个 wx: 身份里完成，也就没有身份可跳。
async function sendPhoneCode(phone) {
  await requireSession()
  const res = await tcb.callApi('sendPhoneCode', { phone: String(phone || '').trim() })
  if (!res) throw new Error('验证码发送失败，请稍后再试')
  // devEcho 只在「短信没配好 + 调用者是超管」时出现：服务端把明文码回显，
  // 让这段时间的绑定流程还能走通。短信一配好这个字段就没了，前端无需特判开关。
  return {
    sent: true,
    devEcho: res.devEcho === true,
    devCode: res.devCode ? String(res.devCode) : '',
  }
}

// 验码 + 绑定，服务端一次做完（bind_my_phone_verified）。
// 客户端拿不到验证码明文，所以「不发码直接绑号」这条路是不通的。
async function bindMyPhone(phone, code) {
  const session = await requireSession()
  const res = await tcb.callApi('bindPhone', {
    phone: String(phone || '').trim(),
    code: String(code || '').trim(),
  })
  const rows = Array.isArray(res && res.data) ? res.data : []
  const row = rows[0] || {}
  if (row.bound !== true && !row.phone) throw new Error('绑定失败，请重新获取验证码后再试')
  return { bound: true, phone: row.phone || '', uid: session.user && session.user.id }
}

// 微信手机号快速验证组件：一次性 code 换真实手机号并完成绑定。
//
// 号码由微信直接给，不经用户输入，也不用短信 —— 所以这是手机号绑定的主路径。
// 短信那条（sendPhoneCode + bindMyPhone）留着兜底：组件没开通、或用户不愿授权时用。
async function bindWxPhone(code) {
  const session = await requireSession()
  const res = await tcb.callApi('bindWxPhone', { code: String(code || '').trim() })
  const phone = String((res && res.phone) || '')
  if (!phone) throw new Error('未能获取到微信手机号，请稍后再试')
  return { bound: true, phone: phone, uid: session.user && session.user.id }
}

// ---- 账号注销（R44，6 个月保留期）----

async function getAccountState() {
  await requireSession()
  const result = await rpc('my_account_state', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  const row = rows[0] || {}
  return {
    deleted: row.deleted === true,
    deletedAt: row.deleted_at || '',
    purgeAfter: row.purge_after || '',
    canRestore: row.can_restore === true,
    purged: row.purged === true,
  }
}

// 满 6 个月的账号在登录时顺手清掉 PII。返回 purged=true 说明已经不是「原账号」了。
async function purgeMyAccountIfDue() {
  const result = await rpc('purge_my_account_if_due', {})
  if (result.error) return false
  const rows = Array.isArray(result.data) ? result.data : []
  return !!(rows[0] && rows[0].purged === true)
}

async function requestAccountDeletion(reason) {
  await requireSession()
  const result = await rpc('request_account_deletion', {
    p_reason: String(reason || ''),
  })
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return { deleted: !!(rows[0] && rows[0].deleted), purgeAfter: rows[0] ? rows[0].purge_after : '' }
}

async function restoreMyAccount() {
  await requireSession()
  const result = await rpc('restore_my_account', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return !!(rows[0] && rows[0].restored)
}

// 后台兜底清理：只有 super 能跑。本项目没有定时任务，所以挂在工作台打开时顺手跑一次，
// 否则「注销满 6 个月」的账号再也没人登录，数据就一直留着。
async function adminPurgeExpiredDeletions() {
  const result = await rpc('admin_purge_expired_deletions', {})
  if (result.error) throw new Error(getErrorMessage(result.error))
  const rows = Array.isArray(result.data) ? result.data : []
  return rows[0] ? Number(rows[0].purged_count) || 0 : 0
}

module.exports = {
  getErrorMessage: getErrorMessage,
  formatTime: formatTime,
  listFaqItems: listFaqItems,
  getFaqSettings: getFaqSettings,
  adminListFaqItems: adminListFaqItems,
  adminUpsertFaqItem: adminUpsertFaqItem,
  adminDeleteFaqItem: adminDeleteFaqItem,
  adminGetFaqSettings: adminGetFaqSettings,
  adminUpdateFaqSettings: adminUpdateFaqSettings,
  llmModels: llmModels,
  llmChat: llmChat,
  beginSupportAi: beginSupportAi,
  finishSupportAi: finishSupportAi,
  getSupportUsage: getSupportUsage,
  rateSupportAnswer: rateSupportAnswer,
  getSession: getSession,
  requireSession: requireSession,
  login: login,
  sendPhoneCode: sendPhoneCode,
  activateAdmin: activateAdmin,
  listAllOrders: listAllOrders,
  logout: logout,
  getProfile: getProfile,
  getMyPhoneState: getMyPhoneState,
  bindMyPhone: bindMyPhone,
  bindWxPhone: bindWxPhone,
  getAccountState: getAccountState,
  purgeMyAccountIfDue: purgeMyAccountIfDue,
  requestAccountDeletion: requestAccountDeletion,
  restoreMyAccount: restoreMyAccount,
  adminPurgeExpiredDeletions: adminPurgeExpiredDeletions,
  restoreSession: restoreSession,
  updateProfile: updateProfile,
  updateMyProfile: updateMyProfile,
  setRole: setRole,
  updateNickname: updateNickname,
  createOrder: createOrder,
  listModerationWords: listModerationWords,
  reportOrder: reportOrder,
  getMyReport: getMyReport,
  adminListReports: adminListReports,
  adminHandleReport: adminHandleReport,
  adminBatchCreateOrders: adminBatchCreateOrders,
  adminListDispatchOrders: adminListDispatchOrders,
  listHallOrders: listHallOrders,
  listMyOrders: listMyOrders,
  searchMyOrders: searchMyOrders,
  listFeatureFlags: listFeatureFlags,
  adminSetFeatureFlag: adminSetFeatureFlag,
  adminMyPerms: adminMyPerms,
  adminCanGrant: adminCanGrant,
  adminSearchStaff: adminSearchStaff,
  adminSetPerm: adminSetPerm,
  listBanners: listBanners,
  adminListBanners: adminListBanners,
  adminCreateBanner: adminCreateBanner,
  adminUpdateBanner: adminUpdateBanner,
  adminDeleteBanner: adminDeleteBanner,
  listMyMessages: listMyMessages,
  unreadMessageCount: unreadMessageCount,
  markMessageRead: markMessageRead,
  markAllMessagesRead: markAllMessagesRead,
  submitOrderReview: submitOrderReview,
  getOrderReviews: getOrderReviews,
  myOrderReviewState: myOrderReviewState,
  orderPeerCredit: orderPeerCredit,
  adminDashboardStats: adminDashboardStats,
  listMyPointRecords: listMyPointRecords,
  listMyWalletRecords: listMyWalletRecords,
  listPointGoods: listPointGoods,
  exchangePointGoods: exchangePointGoods,
  listMyRedemptions: listMyRedemptions,
  listMyCoupons: listMyCoupons,
  adminListPointGoods: adminListPointGoods,
  adminUpsertPointGoods: adminUpsertPointGoods,
  adminAdjustPoints: adminAdjustPoints,
  adminVerifyRedemption: adminVerifyRedemption,
  adminSearchPointsUser: adminSearchPointsUser,
  listMyReviewTodo: listMyReviewTodo,
  listMyReceivedReviews: listMyReceivedReviews,
  myCreditSummary: myCreditSummary,
  submitUserFeedback: submitUserFeedback,
  listMyFeedbacks: listMyFeedbacks,
  feedbackDetail: feedbackDetail,
  feedbackThread: feedbackThread,
  feedbackReply: feedbackReply,
  feedbackMarkRead: feedbackMarkRead,
  adminReopenFeedback: adminReopenFeedback,
  adminListUserFeedbacks: adminListUserFeedbacks,
  adminHandleUserFeedback: adminHandleUserFeedback,
  getOrderRelation: getOrderRelation,
  getOrder: getOrder,
  getOrderDetail: getOrderDetail,
  acceptOrder: acceptOrder,
  completeOrder: completeOrder,
  confirmOrderDone: confirmOrderDone,
  cancelOrder: cancelOrder,
  abandonOrder: abandonOrder,
  submitSettleFeedback: submitSettleFeedback,
  adminListFeedbacks: adminListFeedbacks,
  adminResolveFeedback: adminResolveFeedback,
  submitRentalRequest: submitRentalRequest,
  listMyRentalRequests: listMyRentalRequests,
  adminListRentalRequests: adminListRentalRequests,
  adminListRentalItems: adminListRentalItems,
  adminUpdateRentalItem: adminUpdateRentalItem,
  adminCreateRentalItem: adminCreateRentalItem,
  adminSetRentalPrice: adminSetRentalPrice,
  adminCreateRentalOrder: adminCreateRentalOrder,
  listRentalItems: listRentalItems,
  acceptAgreement: acceptAgreement,
  listAddresses: listAddresses,
  addAddress: addAddress,
  removeAddress: removeAddress,
  getApplication: getApplication,
  submitApplication: submitApplication,
  listApplications: listApplications,
  markCertPending: markCertPending,
  reviewApplication: reviewApplication,
  hideMyOrder: hideMyOrder,
  restoreMyOrder: restoreMyOrder,
  isOrderHidden: isOrderHidden,
  listMyHiddenOrders: listMyHiddenOrders,
  uploadImage: uploadImage,
  getSignedUrls: getSignedUrls,
  getOrderImageUrl: getOrderImageUrl,
  getOrderImageUrls: getOrderImageUrls,
  getPublicImageUrl: getPublicImageUrl,
  getPublicImageUrls: getPublicImageUrls,
}
