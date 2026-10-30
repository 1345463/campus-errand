/**
 * 钱包余额支付（R61）
 *
 * 只做「用余额下单」，不做「退款到余额」。
 * 后者被《微信小程序平台运营规范》2.14.6 明确禁止（资金应当原路退回，
 * 不得强制退至账户余额），而且可提现余额一旦能由退款产生就是储值，
 * 等于开了「信用卡付款 → 取消 → 提现」的套现通道。
 *
 * 这一层最容易出事的是**扣错钱 / 扣两次 / 退了没加回去**，所以钉死：
 *   · 金额口径与 mark_order_paid 一致（round((reward - discount) * 100) 分）
 *   · 同一订单重复支付只扣一次（pay_status 已 paid 直接返回）
 *   · 余额不足时不扣钱，订单也不动
 *   · 余额单取消/协商退款同步完成，不需要微信交易号、不写 refund_no
 *   · 微信单仍然走原路退款，行为不能因为加了余额支付而变
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { PGlite } = require('@electric-sql/pglite')

const ROOT = path.join(__dirname, '..')
const MIG = path.join(ROOT, '..', 'cloudbase', 'migrations', '20261030220000_wallet_pay.sql')
const mig = fs.existsSync(MIG) ? fs.readFileSync(MIG, 'utf8') : ''

const apiJs = fs.readFileSync(path.join(ROOT, 'utils', 'api.js'), 'utf8')
const createJs = fs.readFileSync(path.join(ROOT, 'pages', 'order', 'create.js'), 'utf8')
const listJs = fs.readFileSync(path.join(ROOT, 'pages', 'orders', 'list.js'), 'utf8')
const detailJs = fs.readFileSync(path.join(ROOT, 'pages', 'order', 'detail.js'), 'utf8')
const walletJs = fs.readFileSync(path.join(ROOT, 'pages', 'mine', 'wallet.js'), 'utf8')
const payCreate = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'pay-create', 'index.js'), 'utf8')

async function freshDb() {
  const db = new PGlite()
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS text LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '') $$;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon;
    CREATE TABLE public.orders (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      owner_id text,
      runner_id text,
      status text DEFAULT 'pending',
      pay_status text DEFAULT 'unpaid',
      reward numeric,
      discount_amount numeric DEFAULT 0,
      pay_txn_id text,
      paid_at timestamptz,
      refund_no text,
      refund_amount numeric,
      refund_error text,
      refunded_at timestamptz,
      cancel_reason text,
      cancel_requested_at timestamptz,
      finished_at timestamptz
    );
    CREATE TABLE public.profiles (owner_id text PRIMARY KEY, balance numeric DEFAULT 0);
    CREATE TABLE public.wallet_records (
      id bigserial PRIMARY KEY, user_id text, delta numeric, balance numeric,
      kind text, remark text, created_at timestamptz DEFAULT now()
    );
  `)
  await db.exec(mig)
  return db
}

async function asUser(db, uid, sql, params) {
  await db.exec('RESET ROLE')
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [uid])
  await db.exec('SET ROLE authenticated')
  try {
    const res = await db.query(sql, params || [])
    return res.rows
  } finally {
    await db.exec('RESET ROLE')
  }
}

async function balanceOf(db, uid) {
  const r = await db.query('SELECT balance FROM public.profiles WHERE owner_id = $1', [uid])
  return Number(r.rows[0].balance)
}

async function orderRow(db, id) {
  const r = await db.query(
    'SELECT status, pay_status, pay_channel, refund_no, refund_amount, finished_at FROM public.orders WHERE id = $1',
    [id]
  )
  return r.rows[0]
}

test('迁移只加 pay_channel，没有引入可提现的退款余额', () => {
  assert.ok(mig.length > 1000, '迁移脚本没读到')
  assert.match(mig, /ADD COLUMN IF NOT EXISTS pay_channel/, '缺 pay_channel')
  // 这两个字段是「退款进余额」方案的遗留物，用户已经决定不做
  assert.doesNotMatch(mig, /credit_balance/, '不该出现 credit_balance')
  assert.doesNotMatch(mig, /refund_channel/, '退款永远原路，不需要 refund_channel')
})

test('余额支付：扣款、幂等、余额不足都不出错', async t => {
  const db = await freshDb()
  try {
    await db.exec(`
      INSERT INTO public.profiles (owner_id, balance) VALUES ('u1', 50.00), ('u2', 0);
      INSERT INTO public.orders (owner_id, status, pay_status, reward, discount_amount)
        VALUES ('u1', 'pending', 'unpaid', 10.00, 0)
        RETURNING id;
    `)
    const oid = (await db.query('SELECT id FROM public.orders LIMIT 1')).rows[0].id

    const first = (await asUser(db, 'u1', 'SELECT * FROM public.pay_order_with_balance($1)', [oid]))[0]
    assert.equal(first.result, 'ok')
    assert.equal(Number(first.paid_fen), 1000, '金额必须是 10 元 = 1000 分')
    assert.equal(Number(first.balance_left), 40)
    assert.equal(await balanceOf(db, 'u1'), 40)

    const row = await orderRow(db, oid)
    assert.equal(row.pay_status, 'paid')
    assert.equal(row.pay_channel, 'balance', '支付渠道要能区分，否则退款分流会走错')

    const rec = await db.query(
      "SELECT count(*)::int AS c FROM public.wallet_records WHERE user_id = 'u1' AND kind = 'order_pay'"
    )
    assert.equal(rec.rows[0].c, 1, '一次支付只写一条流水')

    // 幂等：再点一次不能再扣
    const again = (await asUser(db, 'u1', 'SELECT * FROM public.pay_order_with_balance($1)', [oid]))[0]
    assert.equal(again.result, 'paid')
    assert.equal(await balanceOf(db, 'u1'), 40, '重复支付不能扣两次')

    // 余额不足：不扣钱、订单不动
    await db.exec(`
      INSERT INTO public.orders (owner_id, status, pay_status, reward, discount_amount)
        VALUES ('u1', 'pending', 'unpaid', 100.00, 0)
    `)
    const big = (await db.query("SELECT id FROM public.orders WHERE reward = 100.00")).rows[0].id
    const poor = (await asUser(db, 'u1', 'SELECT * FROM public.pay_order_with_balance($1)', [big]))[0]
    assert.equal(poor.result, 'insufficient')
    assert.equal(await balanceOf(db, 'u1'), 40, '余额不足时不能扣款')
    assert.equal((await orderRow(db, big)).pay_status, 'unpaid')

    // 别人的单不能付
    const other = (await asUser(db, 'u2', 'SELECT * FROM public.pay_order_with_balance($1)', [big]))[0]
    assert.equal(other.result, 'forbidden')
  } finally {
    await db.close()
  }
})

test('折扣后的金额口径与支付回调一致', async t => {
  const db = await freshDb()
  try {
    await db.exec(`
      INSERT INTO public.profiles (owner_id, balance) VALUES ('u1', 20.00);
      INSERT INTO public.orders (owner_id, status, pay_status, reward, discount_amount)
        VALUES ('u1', 'pending', 'unpaid', 10.00, 3.00)
    `)
    const oid = (await db.query('SELECT id FROM public.orders LIMIT 1')).rows[0].id
    const r = (await asUser(db, 'u1', 'SELECT * FROM public.pay_order_with_balance($1)', [oid]))[0]
    assert.equal(r.result, 'ok')
    // (10 - 3) * 100 = 700，和 mark_order_paid 的 v_expect 同一口径
    assert.equal(Number(r.paid_fen), 700)
    assert.equal(await balanceOf(db, 'u1'), 13)
  } finally {
    await db.close()
  }
})

test('余额单取消：同步退回余额，不碰微信也不需要交易号', async t => {
  const db = await freshDb()
  try {
    await db.exec(`
      INSERT INTO public.profiles (owner_id, balance) VALUES ('u1', 50.00);
      INSERT INTO public.orders (owner_id, status, pay_status, reward, discount_amount)
        VALUES ('u1', 'pending', 'unpaid', 10.00, 0)
    `)
    const oid = (await db.query('SELECT id FROM public.orders LIMIT 1')).rows[0].id
    await asUser(db, 'u1', 'SELECT * FROM public.pay_order_with_balance($1)', [oid])
    assert.equal(await balanceOf(db, 'u1'), 40)

    // 注意：这笔单没有 pay_txn_id。如果函数还是先查交易号，这里就会返回 no_txn
    const c = (await asUser(db, 'u1', "SELECT * FROM public.request_cancel_order($1, '不想要了')", [oid]))[0]
    assert.equal(c.result, 'ok')
    assert.equal(c.order_status, 'canceled', '余额单退款是同步的，直接落终态')
    assert.equal(await balanceOf(db, 'u1'), 50, '钱要一分不少地回到余额')
    assert.equal((await orderRow(db, oid)).pay_status, 'refunded')

    const rec = await db.query(
      "SELECT count(*)::int AS c FROM public.wallet_records WHERE user_id = 'u1' AND kind = 'refund_in'"
    )
    assert.equal(rec.rows[0].c, 1)

    // 重复取消不能退第二次
    const twice = (await asUser(db, 'u1', "SELECT * FROM public.request_cancel_order($1, '再取消')", [oid]))[0]
    assert.equal(twice.result, 'bad_state')
    assert.equal(await balanceOf(db, 'u1'), 50, '重复取消不能重复退款')
  } finally {
    await db.close()
  }
})

test('已接单的余额单：协商同意后才退，拒绝则不动钱', async t => {
  const db = await freshDb()
  try {
    await db.exec(`
      INSERT INTO public.profiles (owner_id, balance) VALUES ('u1', 50.00);
      INSERT INTO public.orders (owner_id, runner_id, status, pay_status, reward, discount_amount)
        VALUES ('u1', 'r1', 'pending', 'unpaid', 10.00, 0)
    `)
    const oid = (await db.query('SELECT id FROM public.orders LIMIT 1')).rows[0].id
    await asUser(db, 'u1', 'SELECT * FROM public.pay_order_with_balance($1)', [oid])
    await db.exec("UPDATE public.orders SET status = 'accepted' WHERE id = " + oid)
    assert.equal(await balanceOf(db, 'u1'), 40)

    const req = (await asUser(db, 'u1', "SELECT * FROM public.request_cancel_order($1, '临时有事')", [oid]))[0]
    assert.equal(req.order_status, 'cancel_requested')
    assert.equal(await balanceOf(db, 'u1'), 40, '申请阶段不能先退钱')

    const no = (await asUser(db, 'r1', 'SELECT * FROM public.respond_cancel_request($1, false)', [oid]))[0]
    assert.equal(no.order_status, 'accepted')
    assert.equal(await balanceOf(db, 'u1'), 40, '拒绝后不能退钱')

    await asUser(db, 'u1', "SELECT * FROM public.request_cancel_order($1, '还是取消')", [oid])
    const yes = (await asUser(db, 'r1', 'SELECT * FROM public.respond_cancel_request($1, true)', [oid]))[0]
    assert.equal(yes.order_status, 'canceled')
    assert.equal(await balanceOf(db, 'u1'), 50)
  } finally {
    await db.close()
  }
})

test('微信单的取消行为没被改坏：仍然进 refunding 等回调', async t => {
  const db = await freshDb()
  try {
    await db.exec(`
      INSERT INTO public.profiles (owner_id, balance) VALUES ('u1', 0);
      INSERT INTO public.orders (owner_id, status, pay_status, reward, discount_amount, pay_txn_id)
        VALUES ('u1', 'pending', 'paid', 10.00, 0, 'WXTXN1')
    `)
    const oid = (await db.query('SELECT id FROM public.orders LIMIT 1')).rows[0].id
    const r = (await asUser(db, 'u1', "SELECT * FROM public.request_cancel_order($1, '')", [oid]))[0]
    assert.equal(r.result, 'ok')
    assert.equal(r.order_status, 'canceling')
    assert.equal(r.txn_id, 'WXTXN1', '要把交易号交给云函数去调微信')

    const row = await orderRow(db, oid)
    assert.equal(row.pay_status, 'refunding')
    assert.equal(row.refund_no, 'RF' + oid, '退款单号固定 RF+订单号，天然幂等')

    // 没有交易号的微信单：宁可挡住也不改状态
    await db.exec(`
      INSERT INTO public.orders (owner_id, status, pay_status, reward, discount_amount)
        VALUES ('u1', 'pending', 'paid', 20.00, 0)
    `)
    const bare = (await db.query('SELECT id FROM public.orders WHERE reward = 20.00')).rows[0].id
    const bad = (await asUser(db, 'u1', 'SELECT * FROM public.request_cancel_order($1)', [bare]))[0]
    assert.equal(bad.result, 'no_txn')
    assert.equal((await orderRow(db, bare)).status, 'pending', '不能把订单卡在退款态')
  } finally {
    await db.close()
  }
})

test('权限与重载：客户端能调，anon 不能，且没有留下旧签名', async t => {
  const db = await freshDb()
  try {
    const anonPay = await db.query(
      "SELECT has_function_privilege('anon', 'public.pay_order_with_balance(bigint)', 'EXECUTE') AS ok"
    )
    assert.equal(anonPay.rows[0].ok, false, 'anon 不该能花别人的余额')

    const authPay = await db.query(
      "SELECT has_function_privilege('authenticated', 'public.pay_order_with_balance(bigint)', 'EXECUTE') AS ok"
    )
    assert.equal(authPay.rows[0].ok, true)

    for (const fn of ['request_cancel_order', 'respond_cancel_request']) {
      const n = await db.query('SELECT count(*)::int AS c FROM pg_proc WHERE proname = $1', [fn])
      assert.equal(n.rows[0].c, 1, fn + ' 不能留下旧签名（重载会让 PostgREST 报歧义）')
    }
  } finally {
    await db.close()
  }
})

test('前端接的是余额支付，不是重开一条微信支付', () => {
  assert.match(apiJs, /function payOrderWithBalance/)
  assert.match(apiJs, /rpc\('pay_order_with_balance'/)
  assert.doesNotMatch(apiJs, /cancelOrder\(id, reason, to\)/, '取消不该再带退款去向')

  assert.match(createJs, /choosePayChannel/)
  assert.match(createJs, /payByBalance/)
  assert.match(createJs, /payOrderWithBalance/)
  // 余额不够时不该弹选择，直接走微信
  assert.match(createJs, /bal < need/)

  assert.match(listJs, /chooseChannel/)
  assert.match(listJs, /payWithBalance/)

  // 详情页要把「立刻退回余额」和「1~3 个工作日」分开说，别让用户白等
  assert.match(detailJs, /pay_channel === 'balance'/)
  assert.match(detailJs, /立刻退回钱包余额/)

  assert.match(walletJs, /order_pay: '余额支付'/)
  assert.match(walletJs, /refund_in: '退款入账'/)

  // 云函数：余额单不该再调微信退款
  assert.match(payCreate, /need_wxpay === false/)
})
