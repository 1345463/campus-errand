/**
 * 结算与重复支付（R62）
 *
 * 这一轮修的是三处「钱会算错」的漏洞，每一条都有实测证据：
 *
 *   ① 双倍结算：confirm_order_done 加了一次余额，trg_order_notify 的
 *      waiting_confirm→done 分支又加了一次。线上实测赏金 10 元到账 20 元、流水 2 条。
 *      所以这里钉死「结算只有一个出口」，并且把触发器挂上去跑，证明它确实不再动钱。
 *   ② 双付：微信回调晚到时用户点了余额支付，两边都扣。mark_order_paid 必须
 *      把「订单已由余额付掉」识别成 DUPLICATE_PAY 而不是幂等，交回调函数自动退。
 *   ③ 券的成本：用户用券后实付变少，接单员仍按赏金结算，差额是平台营销成本，
 *      以前库里没有字段记，现在必须有 platform_subsidy。
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { PGlite } = require('@electric-sql/pglite')

const ROOT = path.join(__dirname, '..')
const MIG = path.join(
  ROOT, '..', 'cloudbase', 'migrations', '20261030233000_fix_settle_dup_pay.sql'
)
const mig = fs.existsSync(MIG) ? fs.readFileSync(MIG, 'utf8') : ''
const payNotify = fs.readFileSync(
  path.join(ROOT, 'cloudfunctions', 'pay-notify', 'index.js'), 'utf8'
)
const apiJs = fs.readFileSync(path.join(ROOT, 'utils', 'api.js'), 'utf8')
const settleJs = fs.readFileSync(path.join(ROOT, 'pages', 'admin', 'settle.js'), 'utf8')
const settleWxml = fs.readFileSync(path.join(ROOT, 'pages', 'admin', 'settle.wxml'), 'utf8')

async function freshDb() {
  const db = new PGlite()
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS text LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '') $$;
    CREATE TABLE public.orders (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      owner_id text,
      runner_id text,
      title text,
      status text DEFAULT 'pending',
      pay_status text DEFAULT 'unpaid',
      pay_channel text DEFAULT 'wxpay',
      pay_txn_id text,
      reward numeric,
      discount_amount numeric DEFAULT 0,
      refund_no text,
      refund_amount numeric,
      refund_error text,
      takedown boolean DEFAULT false,
      feedback_status text,
      paid_at timestamptz,
      finished_at timestamptz
    );
  `)
  await db.exec(mig)
  await db.exec(`
    CREATE TABLE public.profiles (
      owner_id text PRIMARY KEY,
      balance numeric DEFAULT 0,
      points integer DEFAULT 0
    );
    CREATE TABLE public.wallet_records (
      id bigserial PRIMARY KEY, user_id text, delta numeric, balance numeric,
      kind text, remark text, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.point_records (
      id bigserial PRIMARY KEY, user_id text, delta integer, balance integer,
      kind text, remark text, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.pay_settings (
      id integer PRIMARY KEY DEFAULT 1,
      commission_rate numeric(5,4) NOT NULL DEFAULT 0.0500,
      webhook_secret text
    );
    INSERT INTO public.pay_settings (id, commission_rate, webhook_secret)
    VALUES (1, 0.0500, 'test-secret');

    CREATE OR REPLACE FUNCTION public.push_message(
      p_user_id text, p_kind text, p_title text, p_content text,
      p_ref_type text, p_ref_id bigint
    ) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;

    CREATE OR REPLACE FUNCTION public.calc_settle_amount(p_reward numeric)
    RETURNS TABLE (reward numeric, commission numeric, settle_amount numeric, commission_rate numeric)
    LANGUAGE plpgsql STABLE AS $fn$
    DECLARE
      v_rate numeric := 0.05;
      v_reward numeric := GREATEST(COALESCE(p_reward, 0), 0);
      v_commission numeric;
    BEGIN
      SELECT s.commission_rate INTO v_rate FROM public.pay_settings s WHERE s.id = 1;
      v_rate := COALESCE(v_rate, 0.05);
      v_commission := round(v_reward * v_rate, 2);
      RETURN QUERY SELECT v_reward, v_commission, round(v_reward - v_commission, 2), v_rate;
    END;
    $fn$;

    CREATE TRIGGER orders_notify_aiu AFTER UPDATE ON public.orders
      FOR EACH ROW EXECUTE FUNCTION public.trg_order_notify();
  `)
  return db
}

function textOf(file) {
  return String(file || '')
}

test('R62 迁移文件存在且确实改了三个函数', () => {
  assert.ok(mig.length > 2000, '迁移文件缺失或过短')
  assert.match(mig, /ADD COLUMN IF NOT EXISTS settle_amount/)
  assert.match(mig, /ADD COLUMN IF NOT EXISTS platform_subsidy/)
  assert.match(mig, /ADD COLUMN IF NOT EXISTS dup_txn_id/)
})

test('触发器不再动钱：只发通知，不碰 profiles / wallet_records', () => {
  const start = textOf(mig).indexOf('CREATE OR REPLACE FUNCTION public.trg_order_notify')
  const end = textOf(mig).indexOf('CREATE OR REPLACE FUNCTION public.confirm_order_done')
  const body = textOf(mig).slice(start, end)
  assert.ok(start > 0 && end > start, '找不到触发器函数')
  assert.equal(
    body.indexOf('UPDATE public.profiles'), -1,
    '触发器里又出现了改余额的语句 —— 这正是双倍结算的成因'
  )
  assert.equal(
    body.indexOf("'order_reward'"), -1,
    '触发器里又写了赏金流水 —— 结算只能有一个出口'
  )
  assert.ok(body.indexOf('cancel_request') > 0, '缺少「发布方申请取消」的通知分支')
  assert.ok(body.indexOf('refund_failed') > 0, '缺少「退款失败」的通知分支')
})

test('确认完成：幂等靠 ROW_COUNT，未付款不许结算', () => {
  const start = textOf(mig).indexOf('CREATE OR REPLACE FUNCTION public.confirm_order_done')
  const end = textOf(mig).indexOf('CREATE OR REPLACE FUNCTION public.mark_order_paid')
  const body = textOf(mig).slice(start, end)
  assert.ok(start > 0 && end > start, '找不到 confirm_order_done')
  assert.ok(body.indexOf('GET DIAGNOSTICS v_n = ROW_COUNT') > 0, '缺少 ROW_COUNT 幂等')
  assert.ok(body.indexOf('IF v_n = 0 THEN RETURN') > 0, '没有「状态没改就不发钱」的判断')
  assert.ok(body.indexOf("<> 'paid'") > 0, '没有校验订单是否已支付')
  assert.ok(body.indexOf('calc_settle_amount') > 0, '结算没有走抽成函数，费率配了也白配')
  assert.ok(body.indexOf('platform_subsidy') > 0, '没有记录券补贴成本')
})

test('真库跑：赏金 10 元只发一次 9.50（5% 抽成），重复确认不重发', async () => {
  const db = await freshDb()
  await db.exec(`
    INSERT INTO public.profiles (owner_id, balance) VALUES ('u_owner', 50), ('u_runner', 0);
    INSERT INTO public.orders (owner_id, runner_id, title, status, pay_status, reward, pay_txn_id)
    VALUES ('u_owner', 'u_runner', '测试单', 'waiting_confirm', 'paid', 10.00, 'TXN1');
    SELECT set_config('request.jwt.claim.sub', 'u_owner', false);
  `)
  await db.exec('SELECT * FROM public.confirm_order_done(1)')

  const first = await db.query(`SELECT balance FROM public.profiles WHERE owner_id = 'u_runner'`)
  assert.equal(Number(first.rows[0].balance), 9.5, '结算金额应为赏金扣 5% 抽成')

  const flow = await db.query(
    `SELECT count(*)::int AS c FROM public.wallet_records WHERE kind = 'order_reward'`
  )
  assert.equal(flow.rows[0].c, 1, '赏金流水只能有一条')

  const settle = await db.query('SELECT settle_amount FROM public.orders WHERE id = 1')
  assert.equal(Number(settle.rows[0].settle_amount), 9.5, 'settle_amount 要落库留痕')

  // 再点一次「确认完成」：状态已不是 waiting_confirm，一分钱都不能多
  await db.exec('SELECT * FROM public.confirm_order_done(1)')
  const second = await db.query(`SELECT balance FROM public.profiles WHERE owner_id = 'u_runner'`)
  assert.equal(Number(second.rows[0].balance), 9.5, '重复确认把赏金又发了一遍')
  const flow2 = await db.query(
    `SELECT count(*)::int AS c FROM public.wallet_records WHERE kind = 'order_reward'`
  )
  assert.equal(flow2.rows[0].c, 1, '重复确认又写了一条赏金流水')
  await db.close()
})

test('真库跑：用券单的差额记进 platform_subsidy', async () => {
  const db = await freshDb()
  await db.exec(`
    INSERT INTO public.profiles (owner_id, balance) VALUES ('u_owner', 50), ('u_runner', 0);
    INSERT INTO public.orders (owner_id, runner_id, title, status, pay_status, reward, discount_amount, pay_txn_id)
    VALUES ('u_owner', 'u_runner', '用券单', 'waiting_confirm', 'paid', 10.00, 5.00, 'TXN2');
    SELECT set_config('request.jwt.claim.sub', 'u_owner', false);
  `)
  await db.exec('SELECT * FROM public.confirm_order_done(1)')
  const row = await db.query(
    'SELECT settle_amount, platform_subsidy FROM public.orders WHERE id = 1'
  )
  assert.equal(Number(row.rows[0].settle_amount), 9.5, '券是平台补贴，接单员照拿全额再抽成')
  assert.equal(Number(row.rows[0].platform_subsidy), 5.0, '平台补贴必须落库，否则成本看不见')
  await db.close()
})

test('真库跑：余额付过的单再收到微信回调 → DUPLICATE_PAY 并留痕', async () => {
  const db = await freshDb()
  await db.exec(`
    INSERT INTO public.profiles (owner_id, balance) VALUES ('u_owner', 50);
    INSERT INTO public.orders (owner_id, title, status, pay_status, reward)
    VALUES ('u_owner', '双付单', 'pending', 'unpaid', 10.00);
    SELECT set_config('request.jwt.claim.sub', 'u_owner', false);
  `)
  const paid = await db.query('SELECT result FROM public.pay_order_with_balance(1)')
  assert.equal(paid.rows[0].result, 'ok', '余额支付应成功')

  const r = await db.query(
    `SELECT ok, reason FROM public.mark_order_paid(1, 'TXN_WX', 1000, 'test-secret')`
  )
  assert.equal(r.rows[0].ok, false, '双付不能被当成幂等吞掉')
  assert.match(String(r.rows[0].reason), /^DUPLICATE_PAY/, '要能被回调函数识别成重复支付')

  const dup = await db.query('SELECT dup_txn_id, pay_channel FROM public.orders WHERE id = 1')
  assert.equal(dup.rows[0].dup_txn_id, 'TXN_WX', '重复的微信交易号必须留痕，否则退不了款')
  assert.equal(dup.rows[0].pay_channel, 'balance', '订单支付渠道不能被覆盖')

  const bal = await db.query(`SELECT balance FROM public.profiles WHERE owner_id = 'u_owner'`)
  assert.equal(Number(bal.rows[0].balance), 40, '余额只扣一次，不能被回调再扣')
  await db.close()
})

test('真库跑：同一交易号重复回调仍然幂等', async () => {
  const db = await freshDb()
  await db.exec(`
    INSERT INTO public.orders (owner_id, title, status, pay_status, reward)
    VALUES ('u_owner', '普通单', 'pending', 'unpaid', 10.00);
  `)
  const first = await db.query(
    `SELECT ok FROM public.mark_order_paid(1, 'TXN_SAME', 1000, 'test-secret')`
  )
  assert.equal(first.rows[0].ok, true)
  const again = await db.query(
    `SELECT ok, reason FROM public.mark_order_paid(1, 'TXN_SAME', 1000, 'test-secret')`
  )
  assert.equal(again.rows[0].ok, true, '同一笔回调重发必须继续返回成功')
  assert.match(String(again.rows[0].reason), /幂等/, '真正的幂等要保留')
  await db.close()
})

test('真库跑：已有微信交易号的单不许再走余额支付', async () => {
  const db = await freshDb()
  await db.exec(`
    INSERT INTO public.profiles (owner_id, balance) VALUES ('u_owner', 50);
    INSERT INTO public.orders (owner_id, title, status, pay_status, reward, pay_txn_id)
    VALUES ('u_owner', '微信已付', 'pending', 'unpaid', 10.00, 'TXN_WXPAID');
    SELECT set_config('request.jwt.claim.sub', 'u_owner', false);
  `)
  const r = await db.query('SELECT result FROM public.pay_order_with_balance(1)')
  assert.equal(r.rows[0].result, 'already_wxpay', '微信已付成功却还能扣余额，就是双付')
  const bal = await db.query(`SELECT balance FROM public.profiles WHERE owner_id = 'u_owner'`)
  assert.equal(Number(bal.rows[0].balance), 50, '被挡住时一分钱都不能扣')
  await db.close()
})

test('回调函数：重复支付自动退款，单号固定可幂等', () => {
  assert.ok(payNotify.indexOf('refundDuplicatePay') > 0, '缺少重复支付自动退款')
  assert.ok(
    payNotify.indexOf("out_refund_no: 'RD' + orderId") > 0,
    '补退单号必须是 RD+订单号，随机号会退两次'
  )
  assert.ok(
    payNotify.indexOf("reason.indexOf('DUPLICATE_PAY') === 0") > 0,
    '没有接住 DUPLICATE_PAY 分支'
  )
  assert.ok(
    payNotify.indexOf('/v3/refund/domestic/refunds') > 0,
    '没有真的调微信退款接口'
  )
  // wxpayRequest 必须支持 body，否则 POST 退款签名串的第五行是空的
  assert.ok(payNotify.indexOf('wxpayRequest(method, urlPath, bodyObj)') > 0, '请求函数不支持 body')
  assert.ok(payNotify.indexOf('req.end(body || undefined)') > 0, '请求体没有被发出去')
  assert.ok(
    payNotify.indexOf("if (refundNo.indexOf('RD') === 0)") > 0,
    '补退回调要单独放开，不能塞进业务退款表'
  )
})

test('后台能改费率：接口已导出，结算页有入口', () => {
  assert.ok(apiJs.indexOf('admin_update_pay_settings') > 0, '缺少更新支付参数的 RPC 调用')
  assert.ok(apiJs.indexOf('getPaySettings: getPaySettings') > 0, '没有导出 getPaySettings')
  assert.ok(
    apiJs.indexOf('adminUpdatePaySettings: adminUpdatePaySettings') > 0,
    '没有导出 adminUpdatePaySettings'
  )
  assert.ok(settleWxml.indexOf('结算与抽佣') > 0, '结算页没有费率配置卡片')
  assert.ok(settleWxml.indexOf('bindtap="savePay"') > 0, '没有保存按钮')
  assert.ok(settleJs.indexOf('savePay: function') > 0, '没有保存逻辑')
  assert.ok(settleJs.indexOf('rate / 100') > 0, '页面按百分比输入，提交前必须换算成小数')
})
