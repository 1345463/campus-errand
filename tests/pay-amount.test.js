/**
 * 下单金额只认库（R65）
 *
 * 起因：pay-create 的 create 分支原来直接拿调用方传的 amount 去微信下单。
 * 微信那边真扣款，但回调落库时 mark_order_paid 会按
 *   round((reward - discount_amount) * 100)
 * 重算并比对，对不上就拒绝落 paid —— 结果「钱收了、单没开通」，还得人工退。
 *
 * 钉死的口径：
 *   · 应付金额 = round((reward - discount_amount) * 100) 分，与 mark_order_paid 一致
 *   · 订单不存在 / 已支付 / 已取消 都在打微信接口之前就拒掉
 *   · 调用方金额与库里不一致 → AMOUNT_MISMATCH，绝不发到微信
 *   · 发往微信的 total 必须用服务端算出来的数，不能用调用方传的
 *   · 带令牌时校验归属；老前端不带令牌仍然放行（金额照样被卡住）
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { PGlite } = require('@electric-sql/pglite')

const ROOT = path.join(__dirname, '..')
const MIG = path.join(
  ROOT, '..', 'cloudbase', 'migrations', '20261101201500_order_pay_amount.sql'
)
const mig = fs.existsSync(MIG) ? fs.readFileSync(MIG, 'utf8') : ''
const payCreate = fs.readFileSync(
  path.join(ROOT, 'cloudfunctions', 'pay-create', 'index.js'), 'utf8'
)
const payJs = fs.readFileSync(path.join(ROOT, 'utils', 'pay.js'), 'utf8')

const BASE_SQL = `
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE ROLE service_role;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS text LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '') $$;

  CREATE TABLE public.orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id text,
    status text DEFAULT 'pending',
    pay_status text DEFAULT 'unpaid',
    reward numeric DEFAULT 0,
    discount_amount numeric DEFAULT 0,
    created_at timestamptz DEFAULT now()
  );
`

// 迁移文件里同时有建函数和建索引，整体跑一遍最贴近线上
async function freshDb() {
  const db = new PGlite()
  await db.exec(BASE_SQL)
  await db.exec(mig)
  return db
}

test('迁移文件里应付金额函数的权限口径正确', () => {
  assert.ok(mig, '找不到 20261101201500_order_pay_amount.sql')
  assert.match(mig, /CREATE OR REPLACE FUNCTION public\.svc_order_pay_amount/)
  // svc_ 前缀只能给 service_role，客户端拿 publishable key 也调不到
  assert.match(
    mig,
    /REVOKE ALL ON FUNCTION public\.svc_order_pay_amount\(bigint, text\) FROM PUBLIC, anon, authenticated/
  )
  assert.match(
    mig,
    /GRANT EXECUTE ON FUNCTION public\.svc_order_pay_amount\(bigint, text\) TO service_role/
  )
  // 订单列表在「不筛状态」时按 created_at 倒序，得有对应索引
  assert.match(mig, /CREATE INDEX IF NOT EXISTS orders_created_idx ON public\.orders \(created_at DESC\)/)
})

test('应付金额 = round((reward - discount) * 100)，与 mark_order_paid 同口径', async () => {
  const db = await freshDb()
  const rows = await db.query(
    `INSERT INTO public.orders (owner_id, reward, discount_amount)
     VALUES ('u1', 20, 5) RETURNING id`
  )
  const id = rows.rows[0].id
  const r = await db.query('SELECT * FROM public.svc_order_pay_amount($1, $2)', [id, 'u1'])
  const row = r.rows[0]
  assert.equal(Number(row.amount_fen), 1500, '20 元减 5 元券 = 1500 分')
  assert.equal(row.order_status, 'pending')
  assert.equal(row.pay_status, 'unpaid')
  assert.equal(row.is_owner, true)
  assert.equal(row.token_missing, false)
  await db.close()
})

test('券抵满时应付 0 分（前端据此跳过支付）', async () => {
  const db = await freshDb()
  const rows = await db.query(
    `INSERT INTO public.orders (owner_id, reward, discount_amount)
     VALUES ('u1', 10, 10) RETURNING id`
  )
  const r = await db.query('SELECT * FROM public.svc_order_pay_amount($1, $2)', [
    rows.rows[0].id, 'u1',
  ])
  assert.equal(Number(r.rows[0].amount_fen), 0)
  await db.close()
})

test('订单不存在时返回 missing，不抛错', async () => {
  const db = await freshDb()
  const r = await db.query('SELECT * FROM public.svc_order_pay_amount($1, $2)', [999999, 'u1'])
  assert.equal(r.rows.length, 1)
  assert.equal(r.rows[0].order_status, 'missing')
  assert.equal(r.rows[0].amount_fen, null)
  await db.close()
})

test('不带令牌时 token_missing=true，不做归属判断', async () => {
  const db = await freshDb()
  const rows = await db.query(
    `INSERT INTO public.orders (owner_id, reward) VALUES ('u1', 8) RETURNING id`
  )
  const r = await db.query('SELECT * FROM public.svc_order_pay_amount($1, NULL)', [
    rows.rows[0].id,
  ])
  assert.equal(r.rows[0].token_missing, true)
  assert.equal(r.rows[0].is_owner, false, '没有身份就谈不上是主人')
  assert.equal(Number(r.rows[0].amount_fen), 800, '金额照样算得出来')
  await db.close()
})

test('别人的订单 is_owner=false，云函数据此拒绝', async () => {
  const db = await freshDb()
  const rows = await db.query(
    `INSERT INTO public.orders (owner_id, reward) VALUES ('u1', 8) RETURNING id`
  )
  const r = await db.query('SELECT * FROM public.svc_order_pay_amount($1, $2)', [
    rows.rows[0].id, 'u2',
  ])
  assert.equal(r.rows[0].is_owner, false)
  assert.equal(r.rows[0].token_missing, false)
  await db.close()
})

test('下单前先问库要金额，对不上就不发到微信', () => {
  // 拿到服务端金额
  assert.match(payCreate, /directRpc\('svc_order_pay_amount'/)
  // 失败分支齐全
  assert.match(payCreate, /ORDER_NOT_FOUND/)
  assert.match(payCreate, /ALREADY_PAID/)
  assert.match(payCreate, /ORDER_CANCELED/)
  assert.match(payCreate, /AMOUNT_MISMATCH/)
  // 只有带了有效令牌才判归属（老前端不带 token 仍然可用）
  assert.match(payCreate, /expect\.token_missing === false && expect\.is_owner === false/)

  // 校验必须排在取 openid 之前：不然要白等一次 jscode2session
  const iAmount = payCreate.indexOf("directRpc('svc_order_pay_amount'")
  const iOpenid = payCreate.indexOf('// ---- 取 openid')
  assert.ok(iAmount > 0 && iOpenid > 0, '两段都要在')
  assert.ok(iAmount < iOpenid, '金额校验要在取 openid 之前')

  // 发往微信的金额必须是服务端算出来的那个数
  assert.match(payCreate, /amount: \{ total: serverFen, currency: 'CNY' \}/)
  assert.ok(
    !/amount: \{ total: amountFen/.test(payCreate),
    '不能把调用方传的 amountFen 直接发给微信'
  )
})

test('前端支付时带上会话令牌（否则云函数判不了归属）', () => {
  assert.match(payJs, /tcb\.callTarget\('pay-create'/)
  assert.ok(!/tcb\.call\('pay-create'/.test(payJs), '不能用不带令牌的 call')
})
