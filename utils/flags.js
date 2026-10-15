/**
 * 灰度开关（feature flags）
 *
 * 所有本轮新增的功能都挂在一个开关上，由超级管理员在后台决定是否放开。
 * 任何一个新功能出问题，超管关掉对应开关即可，不必重新发布小程序。
 *
 * 三条约定：
 *   1) 开关读服务端 feature_flags 表，缓存 5 分钟，改完后台最多 5 分钟内在客户端生效；
 *   2) 拉不到开关（未登录 / 接口挂了）时**一律按关闭处理** ——
 *      宁可把没灰度完的功能藏起来，也不要误放出去；
 *   3) 首页这类游客也能进的页面同样走这里，所以 list_feature_flags() 服务端不做登录校验。
 *
 * 用法：
 *   const flags = require('../../utils/flags')
 *   await flags.load()                 // 一般在 onLoad / onShow 里调
 *   if (flags.on('home_banner')) { ... }
 */
const api = require('./api')

const CACHE_KEY = 'feature_flags_v1'
const CACHE_TTL = 5 * 60 * 1000

// 默认全关：接口还没回来的时候，新功能一律不可见
const DEFAULTS = {
  home_banner: false,
  admin_roles: false,
  staff_search: false,
  message_center: false,
  order_paging: false,
  order_search: false,
  hall_filter: false,
  order_timeline: false,
  admin_dashboard: false,
  cert_status: false,
  order_review: false,
  point_records: false,
  point_mall: false,
  user_feedback: false,
  // 第四轮新增
  profile_edit: false,
  credit_score: false,
  my_reviews: false,
  // 第六轮新增：楼栋楼层筛选、积分券抵扣、送达佐证图
  // （大厅独立页本身不挂开关：它是任务列表的唯一入口，关掉等于把功能下掉，没有回滚路径）
  hall_building_filter: false,
  coupon_deduct: false,
  deliver_photo: false,
  // 第七轮新增：批量发单、下单页勾选优先展示券
  admin_batch_order: false,
  order_boost: false,
}

let state = Object.assign({}, DEFAULTS)
let loadedAt = 0
let inflight = null

function apply(rows) {
  const next = Object.assign({}, DEFAULTS)
  ;(rows || []).forEach(function (row) {
    next[row.flag_key] = !!row.enabled
  })
  state = next
  loadedAt = Date.now()
  try {
    wx.setStorageSync(CACHE_KEY, { at: loadedAt, map: next })
  } catch (e) {
    /* 存储不可用就只放内存 */
  }
}

function restore() {
  try {
    const cached = wx.getStorageSync(CACHE_KEY)
    if (cached && cached.map) {
      state = Object.assign({}, DEFAULTS, cached.map)
      loadedAt = cached.at || 0
      return Date.now() - loadedAt < CACHE_TTL
    }
  } catch (e) {
    /* 忽略 */
  }
  return false
}

// 强制刷新（超管在开关页改完之后用）
function load() {
  if (inflight) return inflight
  inflight = api
    .listFeatureFlags()
    .then(function (rows) {
      apply(rows)
      inflight = null
      return state
    })
    .catch(function () {
      inflight = null
      return state
    })
  return inflight
}

// 一般页面用这个：缓存够新就直接用，不发请求
function ensure() {
  if (Date.now() - loadedAt < CACHE_TTL) return Promise.resolve(state)
  if (restore()) return Promise.resolve(state)
  return load()
}

function on(key) {
  return state[key] === true
}

function set(key, enabled) {
  state[key] = !!enabled
}

function snapshot() {
  return Object.assign({}, state)
}

module.exports = {
  DEFAULTS: DEFAULTS,
  load: load,
  ensure: ensure,
  on: on,
  set: set,
  snapshot: snapshot,
}
