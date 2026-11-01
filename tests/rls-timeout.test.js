/**
 * 安全收口 + 业务超时（R64）
 *
 * 这一轮补的是三个「平时看不出来、出事就要命」的洞：
 *
 *   ① 5 张核心表的 RLS 从来没打开：direct_table_grants 授了 anon 的
 *      增删改查、也建了 policy，但少一句 ENABLE ROW LEVEL SECURITY，
 *      policy 全是死代码。38 张表 33 张开着，就这 5 张关着。
 *   ② waiting_confirm / cancel_requested 没有超时：接单员送完了发布方
 *      不点确认，钱永远在平台；发布方申请取消接单员不回应，订单僵死。
 *   ③ 提现的 pending 检查排在 FOR UPDATE 之前，并发能插两笔。
 *
 * 钉死的口径：
 *   · anon 读不到 orders、也删不掉（RLS 是静默过滤，要看行还在不在）
 *   · orders_read_all 只认 owner / runner / 管理员，不再给认证接单员看全站
 *   · 自动结算与 confirm_order_done 同口径：5% 抽成后 9.50、幂等不重复发钱
 *   · 已申诉（feedback_status='pending'）的单不能被自动确认盖掉
 *   · 余额单超时取消同步退款，微信单只转 canceling 交给 cron 补发
 *   · cron 分支必须同时满足「非 HTTP」
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { PGlite } = require('@electric-sql/pglite')

const ROOT = path.join(__dirname, '..')
const MIG = path.join(ROOT, '..', 'cloudbase', 'migrations', '20261101120500_rls_and_timeouts.sql')
const MIG2 = path.join(ROOT, '..', 'cloudbase', 'migrations', '20261101123000_refund_retry_fields.sql')
const mig = fs.existsSync(MIG) ? fs.readFileSync(MIG, 'utf8') : ''
const mig2 = fs.existsSync(MIG2) ? fs.readFileSync(MIG2, 'utf8') : ''
const payCreate = fs.readFileSync(
  path.join(ROOT, 'cloudfunctions', 'pay-create', 'index.js'), 'utf8'
)
const withdrawApi = fs.readFileSync(
  path.join(ROOT, 'cloudfunctions', 'withdraw-api', 'index.js'), 'utf8'
)

// ---------------------------------------------------------------
// 最小可跑环境：只建 R64 引用的表与函数，跑真 SQL
// ---------------------------------------------------------------
const BASE_SQL = `
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE ROLE service_role;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS text LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '') $$;

  CREATE TABLE public.profiles (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id text NOT NULL,
    balance numeric DEFAULT 0,
    points integer DEFAULT 0,
    nickname text
  );

  CREATE TABLE public.orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id text,
    owner_name text,
    runner_id text,
    runner_name text,
    title text,
    service_type text,
    service_name text,
    status text DEFAULT 'pending',
    pay_status text DEFAULT 'unpaid',
    pay_channel text DEFAULT 'wxpay',
    pay_txn_id text,
    reward numeric DEFAULT 0,
    discount_amount numeric DEFAULT 0,
    settle_amount numeric,
    platform_subsidy numeric DEFAULT 0,
    refund_no text,
    refund_amount numeric,
    refund_error text,
    refunded_at timestamptz,
    cancel_requested_at timestamptz,
    batch_no text,
    paid_at timestamptz,
    finished_at timestamptz,
    accepted_at timestamptz,
    runner_done_at timestamptz,
    feedback_status text,
    created_at timestamptz DEFAULT now()
  );

  CREATE TABLE public.addresses (id bigserial PRIMARY KEY, owner_id text);
  CREATE TABLE public.rental_requests (id bigserial PRIMARY KEY, owner_id text);
  CREATE TABLE public.runner_applications (id bigserial PRIMARY KEY, owner_id text);

  CREATE TABLE public.wallet_records (
    id bigserial PRIMARY KEY, user_id text, delta numeric, balance numeric,
    kind text, remark text, created_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.point_records (
    id bigserial PRIMARY KEY, user_id text, delta integer, balance integer,
    kind text, remark text, created_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.point_redemptions (
    id bigserial PRIMARY KEY, user_id text, goods_id text, goods_name text,
    cost integer, code text, status text DEFAULT 'unused',
    used_at timestamptz, used_by text, order_id bigint,
    created_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.profile_phones (
    owner_id text PRIMARY KEY, phone text, verified_at timestamptz
  );
  CREATE TABLE public.pay_settings (
    id integer PRIMARY KEY DEFAULT 1, min_withdraw numeric DEFAULT 10,
    commission_rate numeric DEFAULT 0.05
  );
  CREATE TABLE public.withdraw_requests (
    id bigserial PRIMARY KEY, owner_id text, amount numeric,
    status text DEFAULT 'pending', batch_id text, fail_reason text,
    created_at timestamptz DEFAULT now(), finished_at timestamptz
  );

  CREATE FUNCTION public.push_message(
    p_user_id text, p_kind text, p_title text, p_content text,
    p_ref_type text, p_ref_id bigint
  ) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;

  CREATE FUNCTION public.calc_settle_amount(p_reward numeric)
  RETURNS TABLE(reward numeric, commission numeric, settle_amount numeric, commission_rate numeric)
  LANGUAGE sql AS $$
    SELECT p_reward, round(p_reward * 0.05, 2), round(p_reward * 0.95, 2), 0.05::numeric
  $$;

  CREATE FUNCTION public.admin_is_any() RETURNS boolean LANGUAGE sql STABLE AS
    $$ SELECT false $$;

  CREATE FUNCTION public.svc_rollback_order_coupon(p_order_id bigint)
  RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
`

async function freshDb() {
  const db = new PGlite()
  await db.exec(BASE_SQL)
  await db.exec(mig)
  await db.exec(mig2)
  await db.exec(`
    INSERT INTO public.profiles(owner_id, balance, points, nickname) VALUES
      ('owner1', 0, 0, '发布方'), ('runner1', 0, 0, '接单员');
    INSERT INTO public.profile_phones(owner_id, phone, verified_at)
      VALUES ('owner1', '13800000001', now());
    INSERT INTO public.pay_settings(id, min_withdraw) VALUES (1, 10);
  `)
  return db
}

async function seedOrder(db, cols) {
  const keys = Object.keys(cols)
  const vals = keys.map((_, i) => `$${i + 1}`).join(', ')
  const r = await db.query(
    `INSERT INTO public.orders(${keys.join(', ')}) VALUES (${vals}) RETURNING id`,
    keys.map((k) => cols[k])
  )
  return r.rows[0].id
}

// ---------------------------------------------------------------
// 一、RLS 真的生效
// ---------------------------------------------------------------
test('五张核心表的 RLS 全部打开', async () => {
  const db = await freshDb()
  const r = await db.query(`
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname IN ('orders', 'profiles', 'addresses',
                         'rental_requests', 'runner_applications')
       AND NOT c.relrowsecurity
  `)
  assert.equal(r.rows.length, 0, '还有没开 RLS 的表：' + JSON.stringify(r.rows))
  // 迁移里必须逐条写上，不能靠别处兜底
  for (const t of ['orders', 'profiles', 'addresses', 'rental_requests', 'runner_applications']) {
    assert.match(
      mig,
      new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`),
      `${t} 缺少 ENABLE ROW LEVEL SECURITY`
    )
  }
  await db.close()
})

test('anon 读不到订单、删不掉订单、插不进订单', async () => {
  const db = await freshDb()
  const id = await seedOrder(db, {
    owner_id: 'owner1', owner_name: '发布方', service_type: 'express',
    service_name: '代取快递', title: 'RLS 测试单', reward: 10,
    status: 'pending', pay_status: 'paid',
  })
  // 真实库里 direct_table_grants 把表权限授给了 anon/write，
  // RLS 是第二道门。这里要还原同样的前提，否则测的只是「没授权」。
  await db.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.orders TO anon`)

  await db.exec(`SET ROLE anon`)
  const seen = await db.query('SELECT count(*)::int AS n FROM public.orders')
  assert.equal(seen.rows[0].n, 0, 'anon 不该看到任何订单')

  await db.exec(`DELETE FROM public.orders WHERE id = ${id}`)
  await db.exec(`RESET ROLE`)

  const left = await db.query('SELECT count(*)::int AS n FROM public.orders WHERE id = $1', [id])
  assert.equal(left.rows[0].n, 1, 'RLS 必须挡住 anon 的 DELETE')

  let blocked = false
  await db.exec(`SET ROLE anon`)
  try {
    await db.query(
      `INSERT INTO public.orders(owner_id, service_type, service_name, reward)
       VALUES ('hacker', 'express', '代取快递', 1)`
    )
  } catch (e) {
    blocked = true
  }
  await db.exec(`RESET ROLE`)
  assert.ok(blocked, 'anon 不该能往 orders 插数据')
  await db.close()
})

test('orders_read_all 收紧成只看自己的单', () => {
  assert.ok(mig, 'R64 迁移文件必须存在')
  const block = mig.slice(mig.indexOf('DROP POLICY IF EXISTS orders_read_all'))
  const stmt = block.slice(0, block.indexOf(';', block.indexOf('USING')) + 1)
  assert.match(stmt, /owner_id = auth\.uid\(\)/, '要认发布方')
  assert.match(stmt, /runner_id = auth\.uid\(\)/, '要认接单员')
  assert.doesNotMatch(stmt, /anon/, '不能再授给 anon')
  assert.doesNotMatch(stmt, /is_certified_runner/, '不能让认证接单员看全站订单')
})

// ---------------------------------------------------------------
// 二、超时未确认 → 自动结算
// ---------------------------------------------------------------
test('超时未确认自动结算：按抽成后金额入账，且只发一次', async () => {
  const db = await freshDb()
  const id = await seedOrder(db, {
    owner_id: 'owner1', owner_name: '发布方', runner_id: 'runner1',
    runner_name: '接单员', service_type: 'express', service_name: '代取快递',
    title: '自动结算测试', reward: 10, status: 'waiting_confirm',
    pay_status: 'paid', pay_channel: 'balance',
    runner_done_at: new Date(Date.now() - 80 * 3600 * 1000),
    accepted_at: new Date(Date.now() - 90 * 3600 * 1000),
  })

  const r1 = await db.query('SELECT * FROM public.svc_auto_confirm_orders(72)')
  assert.equal(Number(r1.rows[0].done_count), 1, '应结算 1 单')

  const o = await db.query('SELECT status, settle_amount FROM public.orders WHERE id = $1', [id])
  assert.equal(o.rows[0].status, 'done')
  assert.equal(Number(o.rows[0].settle_amount), 9.5, '5% 抽成后应入账 9.50')

  const p = await db.query("SELECT balance FROM public.profiles WHERE owner_id = 'runner1'")
  assert.equal(Number(p.rows[0].balance), 9.5)

  // 幂等：再跑一次不能再发钱
  const r2 = await db.query('SELECT * FROM public.svc_auto_confirm_orders(72)')
  assert.equal(Number(r2.rows[0].done_count), 0, '重复调用不应再结算')
  const p2 = await db.query("SELECT balance FROM public.profiles WHERE owner_id = 'runner1'")
  assert.equal(Number(p2.rows[0].balance), 9.5, '余额不能被重复加')
  await db.close()
})

test('已申诉的单不会被自动确认盖掉', async () => {
  const db = await freshDb()
  const id = await seedOrder(db, {
    owner_id: 'owner1', runner_id: 'runner1', service_type: 'express',
    service_name: '代取快递', title: '申诉中', reward: 10,
    status: 'waiting_confirm', pay_status: 'paid', pay_channel: 'balance',
    feedback_status: 'pending',
    runner_done_at: new Date(Date.now() - 80 * 3600 * 1000),
  })
  const r = await db.query('SELECT * FROM public.svc_auto_confirm_orders(72)')
  assert.equal(Number(r.rows[0].done_count), 0, '申诉中的单必须留给人工')
  const o = await db.query('SELECT status FROM public.orders WHERE id = $1', [id])
  assert.equal(o.rows[0].status, 'waiting_confirm')
  await db.close()
})

// ---------------------------------------------------------------
// 三、取消申请超时 → 自动同意
// ---------------------------------------------------------------
test('余额单超时取消：同步退回余额并落 canceled', async () => {
  const db = await freshDb()
  const id = await seedOrder(db, {
    owner_id: 'owner1', runner_id: 'runner1', service_type: 'express',
    service_name: '代取快递', title: '余额单超时取消', reward: 8,
    status: 'cancel_requested', pay_status: 'paid', pay_channel: 'balance',
    cancel_requested_at: new Date(Date.now() - 25 * 3600 * 1000),
  })
  const r = await db.query('SELECT * FROM public.svc_expire_cancel_requests(24)')
  assert.equal(Number(r.rows[0].refunded_count), 1)

  const o = await db.query('SELECT status, pay_status FROM public.orders WHERE id = $1', [id])
  assert.equal(o.rows[0].status, 'canceled')
  assert.equal(o.rows[0].pay_status, 'refunded')

  const p = await db.query("SELECT balance FROM public.profiles WHERE owner_id = 'owner1'")
  assert.equal(Number(p.rows[0].balance), 8)
  await db.close()
})

test('微信单超时取消：只转 canceling，交给 cron 补发退款', async () => {
  const db = await freshDb()
  const id = await seedOrder(db, {
    owner_id: 'owner1', runner_id: 'runner1', service_type: 'express',
    service_name: '代取快递', title: '微信单超时取消', reward: 6,
    status: 'cancel_requested', pay_status: 'paid', pay_channel: 'wxpay',
    pay_txn_id: '420000TEST64',
    cancel_requested_at: new Date(Date.now() - 25 * 3600 * 1000),
  })
  await db.query('SELECT * FROM public.svc_expire_cancel_requests(24)')

  const o = await db.query('SELECT status, pay_status, refund_no FROM public.orders WHERE id = $1', [id])
  assert.equal(o.rows[0].status, 'canceling')
  assert.equal(o.rows[0].pay_status, 'refunding')
  assert.equal(o.rows[0].refund_no, 'RF' + id)

  // 没到期的不能动
  const id2 = await seedOrder(db, {
    owner_id: 'owner1', runner_id: 'runner1', service_type: 'express',
    service_name: '代取快递', title: '刚申请取消', reward: 6,
    status: 'cancel_requested', pay_status: 'paid', pay_channel: 'wxpay',
    pay_txn_id: '420000TEST65', cancel_requested_at: new Date(),
  })
  await db.query('SELECT * FROM public.svc_expire_cancel_requests(24)')
  const o2 = await db.query('SELECT status FROM public.orders WHERE id = $1', [id2])
  assert.equal(o2.rows[0].status, 'cancel_requested', '没到 24 小时不能自动取消')
  await db.close()
})

// ---------------------------------------------------------------
// 四、提现并发窗口
// ---------------------------------------------------------------
test('提现的「在途单」检查必须排在锁之后', () => {
  const start = mig.indexOf('FUNCTION public.svc_create_withdraw')
  const body = mig.slice(start)
  const lock = body.indexOf('FOR UPDATE')
  const pending = body.indexOf("w.status IN ('pending', 'processing')")
  assert.ok(lock > 0, '必须有 FOR UPDATE')
  assert.ok(pending > 0, '必须有在途单检查')
  assert.ok(lock < pending, '先锁账户再查在途单，否则两个请求能同时通过检查')
})

test('提现：余额不足与在途单都挡住，且分文不动', async () => {
  const db = await freshDb()
  await db.query("UPDATE public.profiles SET balance = 5 WHERE owner_id = 'owner1'")
  await assert.rejects(
    () => db.query("SELECT * FROM public.svc_create_withdraw('owner1', 10)"),
    /余额不足/
  )
  const p = await db.query("SELECT balance FROM public.profiles WHERE owner_id = 'owner1'")
  assert.equal(Number(p.rows[0].balance), 5, '被拒后余额不能动')

  await db.query("UPDATE public.profiles SET balance = 50 WHERE owner_id = 'owner1'")
  await db.query("SELECT * FROM public.svc_create_withdraw('owner1', 10)")
  await assert.rejects(
    () => db.query("SELECT * FROM public.svc_create_withdraw('owner1', 10)"),
    /处理中/
  )
  const rows = await db.query("SELECT count(*)::int AS n FROM public.withdraw_requests")
  assert.equal(rows.rows[0].n, 1, '不能插进第二笔在途提现')
  await db.close()
})

// ---------------------------------------------------------------
// 五、cron 与退款补发接线
// ---------------------------------------------------------------
test('pay-create 的 cron 接上三个超时与退款补发', () => {
  assert.match(payCreate, /svc_auto_confirm_orders/, '要跑自动结算')
  assert.match(payCreate, /svc_expire_cancel_requests/, '要跑超时取消')
  assert.match(payCreate, /svc_list_stuck_withdrawals/, '要统计滞留提现')
  assert.match(payCreate, /REFUND_NOT_EXIST/, '404 时要认出来')
  assert.match(payCreate, /await doRefund\(one\.order_id/, '404 时要补发退款')
  assert.match(payCreate, /svc_list_stuck_refunds/, '要补查滞留退款')
})

test('withdraw-api 的 cron 只在非 HTTP 调用下生效', () => {
  const i = withdrawApi.indexOf("action === 'cron'")
  assert.ok(i > 0, '要有 cron 分支')
  const cond = withdrawApi.slice(Math.max(0, i - 200), i)
  assert.match(cond, /!isHttp/, '必须要求非 HTTP，网关伪造进不来')
  assert.match(withdrawApi, /SVC_'\s*\+/, '503 要按失败返回，不能记成同步成功')
})

test('滞留退款列表要带出补发所需字段', () => {
  assert.ok(mig2, '第二个迁移必须存在')
  assert.match(mig2, /pay_txn_id text/, '要带微信交易号')
  assert.match(mig2, /refund_amount numeric/, '要带退款金额')
  assert.match(mig2, /DROP FUNCTION IF EXISTS public\.svc_list_stuck_refunds/, '改返回类型必须 DROP')
})
