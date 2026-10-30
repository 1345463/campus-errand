/**
 * 订单运维收尾（R63）
 *
 * 这一轮补的是三个「没人管」的洞：
 *
 *   ① 券核销后取消不回滚：create_order 下单就把 point_redemptions 置 used，
 *      可订单取消/退款后没有任何一处把它放回 unused —— 用户那张券永久蒸发。
 *      回滚点必须分散在四个终态出口，漏一个就有人的券回不来。
 *   ② 管理端没有能处理订单的接口：退款回调丢了只能干等，客服全在改库。
 *   ③ 全仓没有定时任务：未付款订单永远 pending，退款回调丢了永远 canceling。
 *
 * 钉死的口径：
 *   · 券只回滚「由这笔订单核销掉」的（order_id 匹配），管理员手动核销的不动
 *   · 微信单必须等退款 SUCCESS 才回滚，CLOSED（钱没出去）不能回滚
 *   · admin_force_cancel_order / admin_list_orders 的权限只在 DB 函数里判
 *   · cron 分支必须同时满足「非 HTTP」，伪造 body 进不来
 *   · profiles.owner_id 唯一索引真的存在（并发首登会插两行 → 余额双写）
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { PGlite } = require('@electric-sql/pglite')

const ROOT = path.join(__dirname, '..')
const MIG = path.join(ROOT, '..', 'cloudbase', 'migrations', '20261030235000_order_ops.sql')
const mig = fs.existsSync(MIG) ? fs.readFileSync(MIG, 'utf8') : ''
const payCreate = fs.readFileSync(
  path.join(ROOT, 'cloudfunctions', 'pay-create', 'index.js'), 'utf8'
)
const apiJs = fs.readFileSync(path.join(ROOT, 'utils', 'api.js'), 'utf8')
const detailJs = fs.readFileSync(path.join(ROOT, 'pages', 'order', 'detail.js'), 'utf8')
const dashboardJs = fs.readFileSync(path.join(ROOT, 'pages', 'admin', 'dashboard.js'), 'utf8')
const ordersJs = fs.existsSync(path.join(ROOT, 'pages', 'admin', 'orders.js'))
  ? fs.readFileSync(path.join(ROOT, 'pages', 'admin', 'orders.js'), 'utf8')
  : ''
const ordersWxml = fs.existsSync(path.join(ROOT, 'pages', 'admin', 'orders.wxml'))
  ? fs.readFileSync(path.join(ROOT, 'pages', 'admin', 'orders.wxml'), 'utf8')
  : ''

// ---------------------------------------------------------------
// 最小可跑环境：只建 R63 引用的表与函数，跑真 SQL
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

  CREATE TABLE public.admin_grants (
    user_id text NOT NULL,
    perm_key text NOT NULL,
    granted_by text
  );

  CREATE FUNCTION public.admin_has_perm(p_perm text)
  RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
  DECLARE
    v_uid text := auth.uid();
    v_perm text := btrim(coalesce(p_perm, ''));
  BEGIN
    IF v_uid IS NULL THEN RETURN false; END IF;
    IF v_perm = '' THEN RETURN false; END IF;
    RETURN EXISTS (
      SELECT 1 FROM public.admin_grants g
       WHERE g.user_id = v_uid AND (g.perm_key = 'super' OR g.perm_key = v_perm)
    );
  END $$;

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
    dup_txn_id text,
    reward numeric DEFAULT 0,
    discount_amount numeric DEFAULT 0,
    refund_no text,
    refund_id text,
    refund_amount numeric,
    refund_error text,
    refunded_at timestamptz,
    settle_amount numeric,
    platform_subsidy numeric DEFAULT 0,
    cancel_reason text,
    cancel_requested_at timestamptz,
    batch_no text,
    paid_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz DEFAULT now()
  );

  CREATE TABLE public.point_redemptions (
    id bigserial PRIMARY KEY,
    user_id text,
    goods_id text,
    goods_name text,
    cost integer,
    code text,
    status text DEFAULT 'unused',
    used_at timestamptz,
    used_by text,
    order_id bigint,
    created_at timestamptz DEFAULT now()
  );

  CREATE TABLE public.wallet_records (
    id bigserial PRIMARY KEY,
    user_id text,
    delta numeric,
    balance numeric,
    kind text,
    remark text,
    created_at timestamptz DEFAULT now()
  );
`

async function freshDb() {
  const db = new PGlite()
  await db.exec(BASE_SQL)
  await db.exec(mig)
  await db.exec(`
    INSERT INTO public.profiles(owner_id, balance, nickname) VALUES
      ('u1', 100, '发布方'), ('adm', 0, '管理员');
    INSERT INTO public.admin_grants(user_id, perm_key, granted_by)
      VALUES ('adm', 'settle', 'adm');
  `)
  return db
}

// ---------------------------------------------------------------
// ① 券回滚：只回滚本单核销的
// ---------------------------------------------------------------
test('余额单取消：钱退回余额，券同时回滚，管理员手动核销的不受影响', async () => {
  const db = await freshDb()
  const order = await db.query(`
    INSERT INTO public.orders(owner_id, title, reward, status, pay_status, pay_channel)
    VALUES ('u1', '余额单', 10, 'pending', 'paid', 'balance')
    RETURNING id
  `)
  const oid = Number(order.rows[0].id)

  await db.exec(`
    INSERT INTO public.point_redemptions(user_id, goods_id, goods_name, cost, code, status, used_at, used_by, order_id)
    VALUES ('u1', 'g1', '5元券', 100, 'C1', 'used', now(), 'u1', ${oid});
    INSERT INTO public.point_redemptions(user_id, goods_id, goods_name, cost, code, status, used_at, used_by)
    VALUES ('u1', 'g2', '线下核销券', 100, 'C2', 'used', now(), 'adm');
    SELECT set_config('request.jwt.claim.sub', 'u1', true);
    SELECT * FROM public.request_cancel_order(${oid}, '不想要了');
  `)

  const prof = await db.query(`SELECT balance FROM public.profiles WHERE owner_id = 'u1'`)
  assert.equal(Number(prof.rows[0].balance), 110, '余额没退回：100 + 10 应为 110')

  const c1 = await db.query(`SELECT status, used_at, used_by, order_id FROM public.point_redemptions WHERE code = 'C1'`)
  assert.equal(c1.rows[0].status, 'unused', '本单的券必须回到 unused')
  assert.equal(c1.rows[0].order_id, null, 'order_id 必须清空，否则重新下单带不上')
  assert.equal(c1.rows[0].used_at, null)

  const c2 = await db.query(`SELECT status FROM public.point_redemptions WHERE code = 'C2'`)
  assert.equal(c2.rows[0].status, 'used', '管理员手动核销的券不能被订单取消连带回滚')

  const ord = await db.query(`SELECT status, pay_status FROM public.orders WHERE id = ${oid}`)
  assert.equal(ord.rows[0].status, 'canceled')
  assert.equal(ord.rows[0].pay_status, 'refunded')
})

test('未付款取消：没有钱要退，但券照样要还', async () => {
  const db = await freshDb()
  const order = await db.query(`
    INSERT INTO public.orders(owner_id, title, reward, status, pay_status)
    VALUES ('u1', '未付单', 8, 'pending', 'unpaid') RETURNING id
  `)
  const oid = Number(order.rows[0].id)
  await db.exec(`
    INSERT INTO public.point_redemptions(user_id, goods_id, goods_name, cost, code, status, used_at, used_by, order_id)
    VALUES ('u1', 'g1', '3元券', 60, 'C3', 'used', now(), 'u1', ${oid});
    SELECT set_config('request.jwt.claim.sub', 'u1', true);
    SELECT * FROM public.request_cancel_order(${oid}, '');
  `)
  const c = await db.query(`SELECT status FROM public.point_redemptions WHERE code = 'C3'`)
  assert.equal(c.rows[0].status, 'unused')
  const prof = await db.query(`SELECT balance FROM public.profiles WHERE owner_id = 'u1'`)
  assert.equal(Number(prof.rows[0].balance), 100, '未付款不该动余额')
})

test('微信退款回调：SUCCESS 才回滚券，CLOSED 不能回滚', async () => {
  const db = await freshDb()
  const a = await db.query(`
    INSERT INTO public.orders(owner_id, title, reward, status, pay_status, pay_channel, pay_txn_id, refund_no, refund_amount)
    VALUES ('u1', '微信单A', 10, 'canceling', 'refunding', 'wxpay', '4200A', 'RF1', 10)
    RETURNING id
  `)
  const b = await db.query(`
    INSERT INTO public.orders(owner_id, title, reward, status, pay_status, pay_channel, pay_txn_id, refund_no, refund_amount)
    VALUES ('u1', '微信单B', 10, 'canceling', 'refunding', 'wxpay', '4200B', 'RF2', 10)
    RETURNING id
  `)
  await db.exec(`
    INSERT INTO public.point_redemptions(user_id, goods_id, goods_name, cost, code, status, used_at, used_by, order_id)
    VALUES ('u1', 'g1', '券A', 100, 'CA', 'used', now(), 'u1', ${Number(a.rows[0].id)}),
           ('u1', 'g1', '券B', 100, 'CB', 'used', now(), 'u1', ${Number(b.rows[0].id)});
    SELECT * FROM public.svc_finish_order_refund('RF1', 'rid1', 'SUCCESS');
    SELECT * FROM public.svc_finish_order_refund('RF2', 'rid2', 'CLOSED');
  `)

  const ca = await db.query(`SELECT status FROM public.point_redemptions WHERE code = 'CA'`)
  assert.equal(ca.rows[0].status, 'unused', '退款成功，券必须还回去')

  const cb = await db.query(`SELECT status FROM public.point_redemptions WHERE code = 'CB'`)
  assert.equal(cb.rows[0].status, 'used', '退款被关闭＝钱没出去，订单回到待处理，券不能还')

  const oa = await db.query(`SELECT status, pay_status FROM public.orders WHERE id = ${Number(a.rows[0].id)}`)
  assert.equal(oa.rows[0].status, 'canceled')
  assert.equal(oa.rows[0].pay_status, 'refunded')

  const ob = await db.query(`SELECT status, pay_status FROM public.orders WHERE id = ${Number(b.rows[0].id)}`)
  assert.equal(ob.rows[0].pay_status, 'paid', 'CLOSED 必须回滚成 paid，否则用户没有重试入口')
})

// ---------------------------------------------------------------
// ② 管理端权限边界
// ---------------------------------------------------------------
test('强制取消：普通用户被拒，结算权限的管理员才能动', async () => {
  const db = await freshDb()
  const order = await db.query(`
    INSERT INTO public.orders(owner_id, title, reward, status, pay_status, pay_channel)
    VALUES ('u1', '待强制取消', 10, 'pending', 'paid', 'balance') RETURNING id
  `)
  const oid = Number(order.rows[0].id)

  // 普通用户：必须抛「没有结算权限」
  await assert.rejects(
    () => db.exec(`
      SELECT set_config('request.jwt.claim.sub', 'u1', true);
      SELECT * FROM public.admin_force_cancel_order(${oid}, '越权');
    `),
    /没有结算权限/,
    '普通用户竟然能强制取消'
  )

  // 管理员：成功，且余额退回、券回滚
  await db.exec(`
    INSERT INTO public.point_redemptions(user_id, goods_id, goods_name, cost, code, status, used_at, used_by, order_id)
    VALUES ('u1', 'g1', '券', 100, 'CX', 'used', now(), 'u1', ${oid});
    SELECT set_config('request.jwt.claim.sub', 'adm', true);
    SELECT * FROM public.admin_force_cancel_order(${oid}, '用户投诉');
  `)
  const prof = await db.query(`SELECT balance FROM public.profiles WHERE owner_id = 'u1'`)
  assert.equal(Number(prof.rows[0].balance), 110)
  const c = await db.query(`SELECT status FROM public.point_redemptions WHERE code = 'CX'`)
  assert.equal(c.rows[0].status, 'unused')
})

test('查单：普通用户被拒，管理员能按状态筛选', async () => {
  const db = await freshDb()
  await db.exec(`
    INSERT INTO public.orders(owner_id, title, reward, status, pay_status)
    VALUES ('u1', '未付A', 5, 'pending', 'unpaid'),
           ('u1', '已付B', 6, 'pending', 'paid');
  `)
  await assert.rejects(
    () => db.exec(`
      SELECT set_config('request.jwt.claim.sub', 'u1', true);
      SELECT * FROM public.admin_list_orders('', '', 10);
    `),
    /admin only/
  )

  // db.query 走 prepared statement，不能让 set_config 和查询挤在一条 SQL 里，
  // 所以这里用会话级设置（第三个参数 false），它在后续 query 里仍然有效
  await db.exec(`SELECT set_config('request.jwt.claim.sub', 'adm', false)`)
  const all = await db.query(`SELECT * FROM public.admin_list_orders('', '', 10)`)
  assert.ok(all.rows.length >= 2, '管理员应该能看到两单')
  const kw = await db.query(`SELECT * FROM public.admin_list_orders('未付A', '', 10)`)
  assert.equal(kw.rows.length, 1, '按标题搜索应该只命中一单')
  const unpaid = await db.query(`SELECT * FROM public.admin_list_orders('', 'unpaid', 10)`)
  assert.equal(unpaid.rows.length, 1, '未付款筛选应只命中未付的那单')
})

// ---------------------------------------------------------------
// ③ 定时任务
// ---------------------------------------------------------------
test('定时关单：只关「超时 + 未付 + 非批量」，已付和批量单一个都不碰', async () => {
  const db = await freshDb()
  await db.exec(`
    INSERT INTO public.orders(owner_id, title, reward, status, pay_status, created_at)
    VALUES ('u1', '超时未付', 5, 'pending', 'unpaid', now() - interval '2 hours'),
           ('u1', '刚发未付', 5, 'pending', 'unpaid', now()),
           ('u1', '超时已付', 5, 'pending', 'paid', now() - interval '2 hours'),
           ('u1', '批量线下', 5, 'pending', 'unpaid', now() - interval '3 hours');
    UPDATE public.orders SET batch_no = 'B1' WHERE title = '批量线下';
  `)
  const r = await db.query(`SELECT * FROM public.svc_close_expired_orders(30)`)
  assert.equal(Number(r.rows[0].closed_count), 1, '只应关掉那一单超时未付的')

  const rows = await db.query(`SELECT title, status FROM public.orders ORDER BY id`)
  const map = {}
  rows.rows.forEach(function (x) { map[x.title] = x.status })
  assert.equal(map['超时未付'], 'canceled')
  assert.equal(map['刚发未付'], 'pending', '没超时的不能关')
  assert.equal(map['超时已付'], 'pending', '已付款的一律不动')
  assert.equal(map['批量线下'], 'pending', '批量单是线下收款，不参与超时关单')
})

test('滞留退款：只列 refunding 且超过阈值的单', async () => {
  const db = await freshDb()
  await db.exec(`
    INSERT INTO public.orders(owner_id, title, reward, status, pay_status, pay_channel, refund_no, refund_amount, cancel_requested_at)
    VALUES ('u1', '滞留', 6, 'canceling', 'refunding', 'wxpay', 'RF10', 6, now() - interval '1 hour'),
           ('u1', '刚发起', 6, 'canceling', 'refunding', 'wxpay', 'RF11', 6, now()),
           ('u1', '正常单', 6, 'pending', 'paid', 'wxpay', '', NULL, NULL);
  `)
  const r = await db.query(`SELECT * FROM public.svc_list_stuck_refunds(10)`)
  assert.equal(r.rows.length, 1, '只该列出一笔滞留的')
  assert.equal(r.rows[0].refund_no, 'RF10')
})

// ---------------------------------------------------------------
// ④ 唯一索引
// ---------------------------------------------------------------
test('profiles.owner_id 唯一索引生效：并发首登插两行会被拦', async () => {
  const db = await freshDb()
  const idx = await db.query(`
    SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'profiles'
       AND indexname = 'profiles_owner_id_uidx'
  `)
  assert.equal(idx.rows.length, 1, '唯一索引不存在，并发首登会写出两行 profile')

  await assert.rejects(
    () => db.exec(`INSERT INTO public.profiles(owner_id, balance) VALUES ('u1', 0)`),
    /duplicate key|unique/i,
    '重复 owner_id 竟然插得进去 —— 余额会被双写'
  )
})

// ---------------------------------------------------------------
// ⑤ 静态接线
// ---------------------------------------------------------------
test('迁移：券回滚覆盖所有终态出口，内部函数只给 service_role', () => {
  assert.ok(mig.length > 2000, '迁移没读到')
  const calls = mig.match(/PERFORM public\.svc_rollback_order_coupon\(/g) || []
  assert.ok(calls.length >= 6, '券回滚调用点只有 ' + calls.length + ' 处，终态出口漏了')
  assert.match(
    mig,
    /REVOKE ALL ON FUNCTION public\.svc_rollback_order_coupon\(bigint\) FROM PUBLIC, anon, authenticated/
  )
  assert.match(
    mig,
    /GRANT EXECUTE ON FUNCTION public\.svc_rollback_order_coupon\(bigint\) TO service_role/
  )
  assert.match(mig, /CREATE UNIQUE INDEX IF NOT EXISTS profiles_owner_id_uidx/)
})

test('云函数：adminRetry 的权限只由 DB 判，cron 必须非 HTTP', () => {
  assert.match(payCreate, /action === 'adminRetry'/)
  // 权限走 svcRpc('admin_order_detail')，函数内部 admin_has_perm 才是唯一口径
  assert.match(payCreate, /svcRpc\(uid, 'admin_order_detail'/)
  assert.doesNotMatch(payCreate, /is_admin/, '云函数不该自己判管理员，口径会分叉')

  // cron 判定必须带 !isHttp：HTTP 请求一定带 httpMethod，body 里伪造进不来
  assert.match(payCreate, /const isTimer =\s*!isHttp/, 'cron 分支没有强制非 HTTP，可被网关请求伪造')
  assert.match(payCreate, /svc_close_expired_orders/)
  assert.match(payCreate, /svc_list_stuck_refunds/)
})

test('前端：订单运维页四件套、路由、工作台入口都在', () => {
  for (const f of ['orders.js', 'orders.json', 'orders.wxml', 'orders.wxss']) {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'pages', 'admin', f)),
      '缺 pages/admin/' + f
    )
  }
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
  assert.ok(appJson.pages.indexOf('pages/admin/orders') >= 0, 'app.json 没注册页面')
  assert.match(dashboardJs, /url: '\/pages\/admin\/orders'/, '工作台没有入口')

  // WXML 循环必须显式 wx:for-item（全站铁律）
  assert.match(ordersWxml, /wx:for-item="item"/)
  assert.match(ordersJs, /adminCancelOrder/)
  assert.match(ordersJs, /adminRetryRefund/)
})

test('前端：退款中会自动补查退款，也有手动入口', () => {
  assert.match(detailJs, /autoSyncRefund: function/)
  assert.match(detailJs, /api\s*\.\s*syncRefund\(id\)/)
  assert.match(detailJs, /key: 'sync_refund'/, 'canceling 态没有手动查退款的按钮')
  // 只读操作不该走二次点按确认
  assert.match(detailJs, /action\.key === 'sync_refund'[\s\S]{0,120}runRpc\('sync_refund'\)/)
})

test('api：订单运维四个方法都已导出', () => {
  for (const fn of ['adminListOrders', 'adminForceCancelOrder', 'adminRetryRefund', 'adminCancelOrder']) {
    assert.match(apiJs, new RegExp('function ' + fn + '\\('), '缺函数 ' + fn)
    assert.match(apiJs, new RegExp(fn + ': ' + fn), '缺导出 ' + fn)
  }
})
