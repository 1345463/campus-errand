/**
 * 取消订单走微信退款（R60）
 *
 * 背景：改之前 cancel_order 只把 status 改成 canceled，一分钱不动。
 * 已付款的单子取消后，钱留在商户号，用户没有任何入口能拿回来 ——
 * 只能线下找管理员。这次补的就是这条路。
 *
 * 两条业务规则（用户定的）：
 *   1. 全额退：付多少退多少，0.6% 手续费平台承担
 *   2. 已接单不能单方面取消，要接单员同意 —— 他可能已经在路上
 *
 * 这一层最容易出事的是**钱退错 / 退两次 / 退了单没改**，所以钉死这些：
 *   · 金额口径与 mark_order_paid 完全一致（round((reward - discount) * 100) 分）
 *   · out_refund_no 固定 RF+订单号，微信侧天然幂等，连点不会退两次
 *   · 退款成功前订单不进 canceled（否则失败后用户没有重试入口）
 *   · 回调只认 svc_ 前缀，客户端调不到
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SQL = path.join(ROOT, '..', 'cloudbase', 'migrations', '20261030170000_order_refund.sql')
const sql = fs.existsSync(SQL) ? fs.readFileSync(SQL, 'utf8') : ''
const payCreate = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'pay-create', 'index.js'), 'utf8')
const payNotify = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'pay-notify', 'index.js'), 'utf8')
const apiJs = fs.readFileSync(path.join(ROOT, 'utils', 'api.js'), 'utf8')
const tcbJs = fs.readFileSync(path.join(ROOT, 'utils', 'tcb.js'), 'utf8')
const services = fs.readFileSync(path.join(ROOT, 'utils', 'services.js'), 'utf8')
const detailJs = fs.readFileSync(path.join(ROOT, 'pages', 'order', 'detail.js'), 'utf8')
const detailWxml = fs.readFileSync(path.join(ROOT, 'pages', 'order', 'detail.wxml'), 'utf8')

test('迁移文件存在，退款字段与幂等索引都在', () => {
  assert.ok(sql.length > 500, '迁移脚本没读到')
  for (const col of ['refund_no', 'refund_id', 'refund_amount', 'refund_error', 'refunded_at']) {
    assert.match(sql, new RegExp('ADD COLUMN IF NOT EXISTS ' + col), '缺字段 ' + col)
  }
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS orders_refund_no_uidx/)
})

test('金额口径与付款时完全一致：round((reward - discount) * 100) 分', () => {
  // 付款那边是 mark_order_paid 里的 v_expect，退款必须用同一个算式，
  // 否则会出现「付 10 退 9.94」这种用户一眼就能发现的错
  const hits = sql.match(/round\(\(coalesce\(v_row\.reward, 0\) - coalesce\(v_row\.discount_amount, 0\)\) \* 100\)::integer/g) || []
  assert.ok(hits.length >= 2, '申请与同意两条路都要算同一个金额，实际出现 ' + hits.length + ' 次')
})

test('待接单且已付 → 直接进退款态，不先标 canceled', () => {
  assert.match(sql, /SET status = 'canceling',\s*\n\s*pay_status = 'refunding'/)
  // 关键：不是点一下直接 canceled —— 退款失败就再也点不了取消
  assert.ok(
    !/WHERE o\.id = p_order_id;\s*\n\s*RETURN QUERY SELECT 'ok'::text, 'canceled'::text, v_fen/.test(sql),
    '已付款分支不能直接落 canceled'
  )
})

test('已接单 → 转协商态，pay_status 仍是 paid（钱没动）', () => {
  // 精确切到 accepted 那个 IF 分支的结尾，别把后面的退款分支一起看进来
  const start = sql.indexOf("IF v_row.status = 'accepted' THEN")
  const end = sql.indexOf('END IF;', start)
  const body = sql.slice(start, end)
  assert.ok(body.length > 100, '切不到 accepted 分支')
  assert.match(body, /SET status = 'cancel_requested'/)
  assert.ok(!/pay_status/.test(body), '协商阶段不该动 pay_status')
})

test('接单员拒绝 → 回到 accepted，不退款', () => {
  const seg = sql.slice(sql.indexOf('IF p_agree IS NOT TRUE THEN'))
  assert.match(seg.slice(0, 400), /SET status = 'accepted'/)
})

test('没有微信交易号就不进退款态（宁可挡住，也不留残局）', () => {
  const seg = sql.slice(sql.indexOf("= '' THEN\n    RETURN QUERY SELECT 'no_txn'"))
  assert.ok(seg.length > 0, '缺 no_txn 分支')
  assert.ok(sql.indexOf("'no_txn'") < sql.indexOf("status = 'canceling'"), '必须在改状态之前判断')
})

test('退款回调幂等：已 refunded 直接返回，不重复落库', () => {
  const seg = sql.slice(sql.indexOf('FUNCTION public.svc_finish_order_refund'))
  assert.match(seg.slice(0, 900), /IF v_row\.pay_status = 'refunded' THEN/)
})

test('CLOSED 回滚成 paid 并按有无接单员还原状态', () => {
  const seg = sql.slice(sql.indexOf("ELSIF v_state = 'CLOSED' THEN"))
  const body = seg.slice(0, 500)
  assert.match(body, /pay_status = 'paid'/)
  assert.match(body, /THEN 'pending' ELSE 'accepted' END/)
})

test('ABNORMAL 不擅自回滚，只记错误留人工', () => {
  const seg = sql.slice(sql.indexOf('PROCESSING / ABNORMAL'))
  assert.match(seg.slice(0, 400), /refund_error = left/)
  assert.ok(!/pay_status = 'paid'/.test(seg.slice(0, 400)), '异常退款不能回滚，钱可能已经出去了')
})

test('回调收尾与失败回滚只给服务端（svc_ 前缀 + 只 GRANT service_role）', () => {
  for (const fn of ['svc_finish_order_refund', 'svc_fail_order_refund']) {
    const re = new RegExp('REVOKE ALL ON FUNCTION public\\.' + fn + '\\([^)]*\\) FROM PUBLIC, anon, authenticated')
    assert.match(sql, re, fn + ' 必须对客户端收回权限')
    const grant = new RegExp('GRANT EXECUTE ON FUNCTION public\\.' + fn + '\\([^)]*\\) TO service_role')
    assert.match(sql, grant, fn + ' 必须只给 service_role')
  }
  // 两个用户侧函数反过来要开着，否则前端调不到
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.request_cancel_order\(bigint, text\) TO authenticated/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.respond_cancel_request\(bigint, boolean\) TO authenticated/)
})

test('pay-create 用 action 分派，老下单调用不受影响', () => {
  assert.match(payCreate, /const action = String\(payload\.action \|\| ''\)/)
  assert.match(payCreate, /if \(action === 'cancel' \|\| action === 'respond' \|\| action === 'sync'\)/)
  // 不传 action 时仍然走到下单逻辑
  assert.ok(
    payCreate.indexOf('const miss = missingEnv()') > payCreate.indexOf("action === 'cancel'"),
    '分派必须在下单逻辑之前'
  )
})

test('退款前必须验会话令牌（这是花真金白银的操作）', () => {
  const seg = payCreate.slice(payCreate.indexOf('async function runRefund'))
  assert.match(seg.slice(0, 400), /const uid = verifyToken\(payload\.token\)/)
  assert.match(seg.slice(0, 400), /if \(!uid\) return/)
  assert.match(payCreate, /crypto\.timingSafeEqual/)
})

test('退款金额与交易号只从库里取，前端传不进来', () => {
  const seg = payCreate.slice(payCreate.indexOf('async function doRefund'))
  const body = seg.slice(0, 700)
  assert.match(body, /const fen = Number\(row\.refund_fen\)/)
  assert.match(body, /const txn = String\(row\.txn_id \|\| ''\)/)
  assert.ok(!/payload\.(amount|refund_fen|txn)/.test(body), '不能信任前端传来的金额')
})

test('out_refund_no 固定为 RF+订单号（微信侧幂等）', () => {
  assert.match(payCreate, /const refundNo = 'RF' \+ orderId/)
  // 每次都生成新单号的话，连点就会退两次钱
  assert.ok(!/refundNo = 'RF' \+ orderId \+ Date\.now/.test(payCreate), '不能用时间戳做退款单号')
})

test('退款请求带全额退参数与回调地址', () => {
  const seg = payCreate.slice(payCreate.indexOf("'/v3/refund/domestic/refunds'"))
  const body = seg.slice(0, 500)
  assert.match(body, /transaction_id: txn/)
  assert.match(body, /amount: \{ refund: fen, total: fen, currency: 'CNY' \}/)
  assert.match(body, /notify_url: NOTIFY_URL/)
})

test('微信退款失败要翻成人话，并回滚订单', () => {
  assert.match(payCreate, /NOT_ENOUGH: '商户号可用余额不足/)
  assert.match(payCreate, /await markRefundFail\(refundNo, msg\)/)
  assert.match(payCreate, /svc_fail_order_refund/)
})

test('退款回调按 REFUND. 前缀分派，且排在支付判断之前', () => {
  assert.match(payNotify, /const isRefund = et\.indexOf\('REFUND\.'\) === 0/)
  assert.match(payNotify, /if \(isRefund\) return await handleRefundNotify\(plain\)/)
  // 比的是实际调用位置，不是文件头注释里提到的函数名
  assert.ok(
    payNotify.indexOf('if (isRefund) return await handleRefundNotify') <
      payNotify.indexOf("callRpc('mark_order_paid'"),
    '退款分支必须早于支付落库逻辑，否则会被当成「非支付事件」忽略'
  )
  assert.match(payNotify, /p_refund_no: refundNo/)
})

test('回调落库失败返回 500 让微信重试，业务失败返回 200', () => {
  const seg = payNotify.slice(payNotify.indexOf('async function handleRefundNotify'))
  // 窗口要盖住整个函数（R62 加了重复支付补退的分支，函数变长了）
  assert.match(seg.slice(0, 2400), /return resp\(500, \{ code: 'FAIL', message: '落库失败' \}\)/)
  assert.match(seg.slice(0, 2400), /return resp\(200, \{ code: 'SUCCESS', message: '成功' \}\)/)
})

test('前端退款走独立 target，实际打到 pay-create', () => {
  assert.match(tcbJs, /refund: '\/api\/pay-create'/)
  assert.match(apiJs, /tcb\.callTarget\('refund', \{/)
  assert.match(apiJs, /function respondCancel\(id, agree\)/)
  assert.match(apiJs, /function syncRefund\(id\)/)
})

test('两个新状态有中文文案，绝不回显英文 key', () => {
  assert.match(services, /cancel_requested: '取消申请中'/)
  assert.match(services, /canceling: '退款中'/)
})

test('详情页四种取消入口都在，且金额写进弹窗', () => {
  assert.match(detailJs, /doCancel: function/)
  assert.match(detailJs, /doRequestCancel: function/)
  assert.match(detailJs, /doRespondCancel: function/)
  // 弹窗必须写明退多少钱，不能只说「取消」
  assert.match(detailJs, /' 将全额退回微信，1~3 个工作日到账。'/)
  // 已付款的按钮文案要体现退款
  assert.match(detailJs, /'取消并退款 ¥' \+ payAmount/)
})

test('已接单只给「申请取消」，不给单方面取消', () => {
  const seg = detailJs.slice(detailJs.indexOf("} else if (order.status === 'accepted') {"))
  const body = seg.slice(0, 700)
  assert.match(body, /primary = \{ key: 'request_cancel', label: '申请取消' \}/)
})

test('接单员收到申请时有同意与拒绝两个按钮', () => {
  const seg = detailJs.slice(detailJs.indexOf("} else if (order.status === 'cancel_requested') {"))
  const body = seg.slice(0, 500)
  assert.match(body, /key: 'respond_cancel'/)
  assert.match(body, /secondary = \{ key: 'reject_cancel'/)
  assert.match(detailWxml, /bindtap="onSecondary"/)
})

test('退款失败后页面会重新拉一次，按钮不会卡在「退款中」', () => {
  const seg = detailJs.slice(detailJs.lastIndexOf('page.fail(error)'))
  assert.match(seg.slice(0, 400), /return page\.load\(\)/)
})

test('前端不直接调 cancel_order（老函数只改状态不退钱）', () => {
  assert.ok(!/callOrderRpc\('cancel_order'/.test(apiJs), '取消必须走退款通道，不能退回老 RPC')
})
