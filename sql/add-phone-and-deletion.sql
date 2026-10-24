-- ============================================================
-- R44 · 手机号绑定 + 账号注销（6 个月保留期）
--
-- 两条产品规则：
--   1) 浏览大厅不拦；**发单 / 接单 / 查看联系方式前必须绑定手机号**。
--      拦截必须发生在服务端 —— 客户端弹窗只是引导，改包就能绕。
--   2) 注销后 6 个月内不真删，保留追溯；期内重新登录可「恢复原账号」，
--      选择不恢复则不允许新注册（避免靠重新注册洗白）。满 6 个月才清除 PII。
--
-- 为什么手机号单独一张表而不是 profiles.phone：
--   profiles 的读策略是「只看自己」，但很多 SECURITY DEFINER 函数会 SELECT p.*
--   往下发（后台、信誉分页…）。手机号是 PII，单独存 + 无任何 policy，
--   只有本文件的函数能碰，避免哪天顺手就漏出去。
-- ============================================================

-- ---------- 1. 表 ----------

CREATE TABLE IF NOT EXISTS public.profile_phones (
  owner_id text PRIMARY KEY,
  phone text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- 一个手机号只能绑一个账号：这是「账号重复」的唯一防线
CREATE UNIQUE INDEX IF NOT EXISTS profile_phones_phone_uniq
  ON public.profile_phones (phone);
ALTER TABLE public.profile_phones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profile_phones FROM PUBLIC, anon, authenticated;

-- 注销记录：6 个月保留期内它是「恢复」的依据，满了以后它还是审计凭据
CREATE TABLE IF NOT EXISTS public.account_deletions (
  id bigserial PRIMARY KEY,
  owner_id text NOT NULL,
  phone_masked text,
  reason text,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  purge_after timestamptz NOT NULL,
  restored_at timestamptz,
  purged_at timestamptz
);
CREATE INDEX IF NOT EXISTS account_deletions_owner_idx
  ON public.account_deletions (owner_id, deleted_at DESC);
ALTER TABLE public.account_deletions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_deletions FROM PUBLIC, anon, authenticated;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deleted_reason text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS purged_at timestamptz;

-- ---------- 2. 手机号 ----------

-- 绑定状态。前端拿它决定「显示号码 / 引导绑定」，服务端拿它做最终拦截。
CREATE OR REPLACE FUNCTION public.my_phone_state()
RETURNS TABLE(
  bound boolean,
  phone text,
  verified_at timestamptz,
  cooldown_until timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_row public.profile_phones;
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT * INTO v_row FROM public.profile_phones pp WHERE pp.owner_id = v_uid;
  IF v_row.owner_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::text, NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, v_row.phone, v_row.verified_at,
                      v_row.updated_at + interval '24 hours';
END;
$fn$;
REVOKE ALL ON FUNCTION public.my_phone_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_phone_state() TO authenticated;

CREATE OR REPLACE FUNCTION public.has_phone()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.profile_phones pp WHERE pp.owner_id = auth.uid()
  );
$fn$;
REVOKE ALL ON FUNCTION public.has_phone() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_phone() TO authenticated;

-- 供其它函数内部调用的断言。用固定文案，前端据此弹「去绑定」。
CREATE OR REPLACE FUNCTION public.assert_phone_bound()
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '请先登录';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profile_phones pp WHERE pp.owner_id = auth.uid()
  ) THEN
    RAISE EXCEPTION '请先绑定手机号';
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION public.assert_phone_bound() FROM PUBLIC, anon, authenticated;

-- 绑定。手机号已经由短信验证码验证过，这里负责：格式、唯一、防抖、写入。
-- ⚠️ 残余风险：本项目没有服务端，无法把「验证码通过」这件事以密码学方式
--    绑定到这次 RPC 调用上（客户端可以跳过发码直接调本函数）。因此加了
--    三条约束兜底：格式校验、全站唯一、同一账号 24 小时只能改一次。
--    等接入云函数后应改成「服务端换号 + 签名票据」。
CREATE OR REPLACE FUNCTION public.bind_my_phone(p_phone text)
RETURNS TABLE(bound boolean, phone text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_phone text := btrim(COALESCE(p_phone, ''));
  v_row public.profile_phones;
  v_profile public.profiles;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;

  SELECT * INTO v_profile FROM public.profiles p WHERE p.owner_id = v_uid;
  IF v_profile.owner_id IS NULL THEN RAISE EXCEPTION '用户资料不存在，请重新登录'; END IF;
  IF v_profile.deleted_at IS NOT NULL THEN RAISE EXCEPTION '账号已注销，请先恢复账号'; END IF;

  IF v_phone !~ '^1[3-9][0-9]{9}$' THEN
    RAISE EXCEPTION '请输入正确的 11 位手机号';
  END IF;

  -- 已被别的账号占用（含已注销但仍在 6 个月保留期内的账号）
  IF EXISTS (
    SELECT 1 FROM public.profile_phones pp
     WHERE pp.phone = v_phone AND pp.owner_id <> v_uid
  ) THEN
    RAISE EXCEPTION '该手机号已绑定其他账号，一个手机号只能绑定一个账号';
  END IF;

  SELECT * INTO v_row FROM public.profile_phones pp WHERE pp.owner_id = v_uid;
  IF v_row.owner_id IS NOT NULL THEN
    IF v_row.phone = v_phone THEN
      RETURN QUERY SELECT true, v_phone;
      RETURN;
    END IF;
    IF v_row.updated_at > now() - interval '24 hours' THEN
      RAISE EXCEPTION '手机号 24 小时内只能修改一次';
    END IF;
  END IF;

  INSERT INTO public.profile_phones (owner_id, phone, verified_at, updated_at)
  VALUES (v_uid, v_phone, now(), now())
  ON CONFLICT (owner_id) DO UPDATE
    SET phone = EXCLUDED.phone,
        verified_at = now(),
        updated_at = now();

  RETURN QUERY SELECT true, v_phone;
END;
$fn$;
REVOKE ALL ON FUNCTION public.bind_my_phone(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bind_my_phone(text) TO authenticated;

-- ---------- 3. 发单 / 接单 / 认证 / 租赁的服务端拦截 ----------
-- 用触发器而不是改每个函数：create_order / admin_batch_create_orders 这类
-- 写法各异，改函数容易漏；触发器是表级约束，谁都绕不过。

CREATE OR REPLACE FUNCTION public.assert_order_phone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  -- 直连迁移 / 后台补数据（没有会话）直接放行
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  -- 管理员批量发单是替别人建单，不要求管理员自己绑
  BEGIN
    IF public.admin_is_any() THEN RETURN NEW; END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.profile_phones pp WHERE pp.owner_id = NEW.owner_id
    ) THEN
      RAISE EXCEPTION '请先绑定手机号后再发单';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.runner_id IS NOT NULL AND OLD.runner_id IS DISTINCT FROM NEW.runner_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.profile_phones pp WHERE pp.owner_id = NEW.runner_id
    ) THEN
      RAISE EXCEPTION '请先绑定手机号后再接单';
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.assert_order_phone() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS orders_assert_phone ON public.orders;
CREATE TRIGGER orders_assert_phone
  BEFORE INSERT OR UPDATE OF runner_id ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_order_phone();

CREATE OR REPLACE FUNCTION public.assert_owner_phone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  BEGIN
    IF public.admin_is_any() THEN RETURN NEW; END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.profile_phones pp WHERE pp.owner_id = auth.uid()
  ) THEN
    RAISE EXCEPTION '请先绑定手机号后再提交';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.assert_owner_phone() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS runner_applications_assert_phone ON public.runner_applications;
CREATE TRIGGER runner_applications_assert_phone
  BEFORE INSERT ON public.runner_applications
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_owner_phone();

DROP TRIGGER IF EXISTS rental_requests_assert_phone ON public.rental_requests;
CREATE TRIGGER rental_requests_assert_phone
  BEFORE INSERT ON public.rental_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_owner_phone();

-- ---------- 4. 「查看联系方式」也要绑 ----------
-- 详情接口按参与方脱敏，但没绑定手机号的老参与方仍然能拿到 contact，
-- 这里把它一并掐掉（其余字段不动）。
CREATE OR REPLACE FUNCTION public.get_order_detail(p_order_id bigint)
RETURNS SETOF public.orders
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_row public.orders;
  v_admin boolean := false;
  v_allow boolean;
  v_phone boolean := false;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT * INTO v_row FROM public.orders o WHERE o.id = p_order_id;
  IF v_row.id IS NULL THEN RETURN; END IF;

  v_allow := (v_row.owner_id = v_uid)
          OR (v_row.runner_id IS NOT NULL AND v_row.runner_id = v_uid);

  IF NOT v_allow THEN
    BEGIN
      v_admin := public.admin_is_any();
    EXCEPTION WHEN OTHERS THEN
      v_admin := false;
    END;
    v_allow := v_admin;
  END IF;

  -- 没接单之前，outsiders 只看得到任务本身，看不到取餐码 / 图片 / 联系方式
  IF NOT v_allow THEN
    v_row.images := ARRAY[]::text[];
    v_row.deliver_images := ARRAY[]::text[];
    v_row.contact := '';
    RETURN NEXT v_row;
    RETURN;
  END IF;

  -- 参与方也要先绑手机号才给联系方式（浏览不受影响，这里只关这一列）
  SELECT EXISTS (
    SELECT 1 FROM public.profile_phones pp WHERE pp.owner_id = v_uid
  ) INTO v_phone;
  IF NOT v_phone AND NOT v_admin THEN
    v_row.contact := '';
  END IF;

  RETURN NEXT v_row;
END;
$fn$;
REVOKE ALL ON FUNCTION public.get_order_detail(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_order_detail(bigint) TO authenticated;

-- ---------- 5. 注销 / 恢复 / 到期清理 ----------

-- 只查状态，无副作用。前端登录后调它决定弹不弹「是否恢复原账号」。
CREATE OR REPLACE FUNCTION public.my_account_state()
RETURNS TABLE(
  deleted boolean,
  deleted_at timestamptz,
  purge_after timestamptz,
  can_restore boolean,
  purged boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_profile public.profiles;
  v_del public.account_deletions;
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT false, NULL::timestamptz, NULL::timestamptz, false, false;
    RETURN;
  END IF;

  SELECT * INTO v_profile FROM public.profiles p WHERE p.owner_id = v_uid;

  SELECT * INTO v_del FROM public.account_deletions d
   WHERE d.owner_id = v_uid AND d.restored_at IS NULL
   ORDER BY d.deleted_at DESC LIMIT 1;

  IF v_profile.deleted_at IS NULL THEN
    RETURN QUERY SELECT false, NULL::timestamptz, v_del.purge_after, false,
                        (v_del.purged_at IS NOT NULL);
    RETURN;
  END IF;

  RETURN QUERY SELECT
    true,
    v_profile.deleted_at,
    v_del.purge_after,
    (v_del.purge_after IS NOT NULL AND v_del.purge_after > now()
       AND v_del.purged_at IS NULL),
    (v_del.purged_at IS NOT NULL);
END;
$fn$;
REVOKE ALL ON FUNCTION public.my_account_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_account_state() TO authenticated;

CREATE OR REPLACE FUNCTION public.request_account_deletion(p_reason text)
RETURNS TABLE(deleted boolean, purge_after timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_profile public.profiles;
  v_active integer := 0;
  v_balance numeric := 0;
  v_phone text;
  v_after timestamptz := now() + interval '6 months';
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;

  SELECT * INTO v_profile FROM public.profiles p WHERE p.owner_id = v_uid;
  IF v_profile.owner_id IS NULL THEN RAISE EXCEPTION '用户资料不存在'; END IF;
  IF v_profile.deleted_at IS NOT NULL THEN RAISE EXCEPTION '账号已注销'; END IF;

  -- 未完成订单会牵扯对方，必须处理完
  SELECT count(*) INTO v_active
    FROM public.orders o
   WHERE (o.owner_id = v_uid OR o.runner_id = v_uid)
     AND o.status IN ('pending', 'accepted', 'waiting_confirm');
  IF v_active > 0 THEN
    RAISE EXCEPTION '你还有 % 个未完成的订单，请先处理完再注销', v_active;
  END IF;

  v_balance := COALESCE(v_profile.balance, 0);
  IF v_balance <> 0 THEN
    RAISE EXCEPTION '钱包还有 ¥%，请先处理后再注销', v_balance;
  END IF;

  -- 后台权限不清掉就注销，会让工单/审核挂在一个「已注销」的人身上
  IF EXISTS (SELECT 1 FROM public.admin_grants g WHERE g.user_id = v_uid) THEN
    RAISE EXCEPTION '你还有后台权限，请先让超管收回后再注销';
  END IF;

  SELECT pp.phone INTO v_phone FROM public.profile_phones pp WHERE pp.owner_id = v_uid;

  UPDATE public.profiles p
     SET deleted_at = now(),
         deleted_reason = left(COALESCE(p_reason, ''), 200)
   WHERE p.owner_id = v_uid;

  INSERT INTO public.account_deletions (owner_id, phone_masked, reason, purge_after)
  VALUES (
    v_uid,
    CASE WHEN v_phone IS NULL OR v_phone = '' THEN NULL
         ELSE left(v_phone, 3) || '****' || right(v_phone, 4) END,
    left(COALESCE(p_reason, ''), 200),
    v_after
  );

  RETURN QUERY SELECT true, v_after;
END;
$fn$;
REVOKE ALL ON FUNCTION public.request_account_deletion(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_account_deletion(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.restore_my_account()
RETURNS TABLE(restored boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_profile public.profiles;
  v_del public.account_deletions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;

  SELECT * INTO v_profile FROM public.profiles p WHERE p.owner_id = v_uid;
  IF v_profile.owner_id IS NULL THEN RAISE EXCEPTION '用户资料不存在'; END IF;
  IF v_profile.deleted_at IS NULL THEN RAISE EXCEPTION '账号未注销，无需恢复'; END IF;

  SELECT * INTO v_del FROM public.account_deletions d
   WHERE d.owner_id = v_uid AND d.restored_at IS NULL
   ORDER BY d.deleted_at DESC LIMIT 1;

  IF v_del.purged_at IS NOT NULL THEN
    RAISE EXCEPTION '账号数据已按约定清除，无法恢复';
  END IF;
  IF v_del.purge_after IS NULL OR v_del.purge_after <= now() THEN
    RAISE EXCEPTION '已超过 6 个月保留期，无法恢复';
  END IF;

  UPDATE public.profiles p
     SET deleted_at = NULL, deleted_reason = NULL
   WHERE p.owner_id = v_uid;

  UPDATE public.account_deletions d
     SET restored_at = now()
   WHERE d.id = v_del.id;

  RETURN QUERY SELECT true;
END;
$fn$;
REVOKE ALL ON FUNCTION public.restore_my_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_my_account() TO authenticated;

-- 真正清除 PII。只给内部函数与超管用，不对 authenticated 开放。
CREATE OR REPLACE FUNCTION public.purge_account_data(p_uid text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  UPDATE public.profiles p
     SET nickname = '已注销用户',
         owner_name = '已注销用户',
         avatar_url = '',
         role = 'user',
         cert_status = 'none',
         is_admin = false,
         points = 0,
         balance = 0,
         boost_until = NULL,
         deleted_at = NULL,
         purged_at = now()
   WHERE p.owner_id = p_uid;

  DELETE FROM public.profile_phones pp WHERE pp.owner_id = p_uid;
  DELETE FROM public.addresses a WHERE a.owner_id = p_uid;
  DELETE FROM public.messages m WHERE m.user_id = p_uid;
  DELETE FROM public.admin_grants g WHERE g.user_id = p_uid;

  -- 认证材料与人像图片属于敏感个人信息，必须删净；轮播图是运营素材，保留
  DELETE FROM public.media_assets ma
   WHERE ma.owner_id = p_uid AND COALESCE(ma.scope, '') <> 'banner';

  UPDATE public.orders o SET owner_name = '已注销用户' WHERE o.owner_id = p_uid;
  UPDATE public.orders o SET runner_name = '已注销用户' WHERE o.runner_id = p_uid;
  UPDATE public.orders o SET contact = '' WHERE o.owner_id = p_uid;
  UPDATE public.orders o
     SET images = ARRAY[]::text[], deliver_images = ARRAY[]::text[]
   WHERE o.owner_id = p_uid OR o.runner_id = p_uid;

  UPDATE public.runner_applications ra
     SET real_name = '已注销用户'
   WHERE ra.owner_id = p_uid;
  UPDATE public.rental_requests rr
     SET real_name = '已注销用户', contact = ''
   WHERE rr.owner_id = p_uid;

  UPDATE public.account_deletions d
     SET purged_at = now()
   WHERE d.owner_id = p_uid AND d.purged_at IS NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.purge_account_data(text) FROM PUBLIC, anon, authenticated;

-- 登录时自查：满 6 个月就直接清（这里只清调用者自己，避免被拿来删别人）
CREATE OR REPLACE FUNCTION public.purge_my_account_if_due()
RETURNS TABLE(purged boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_profile public.profiles;
  v_del public.account_deletions;
BEGIN
  IF v_uid IS NULL THEN RETURN QUERY SELECT false; RETURN; END IF;

  SELECT * INTO v_profile FROM public.profiles p WHERE p.owner_id = v_uid;
  IF v_profile.deleted_at IS NULL THEN RETURN QUERY SELECT false; RETURN; END IF;

  SELECT * INTO v_del FROM public.account_deletions d
   WHERE d.owner_id = v_uid AND d.restored_at IS NULL AND d.purged_at IS NULL
   ORDER BY d.deleted_at DESC LIMIT 1;

  IF v_del.id IS NULL OR v_del.purge_after > now() THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  PERFORM public.purge_account_data(v_uid);
  RETURN QUERY SELECT true;
END;
$fn$;
REVOKE ALL ON FUNCTION public.purge_my_account_if_due() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purge_my_account_if_due() TO authenticated;

-- 后台兜底：没人登录就一直不清。超管可以手动跑一次批量清理。
CREATE OR REPLACE FUNCTION public.admin_purge_expired_deletions()
RETURNS TABLE(purged_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_row record;
  v_n integer := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF NOT public.admin_has_perm('super') THEN
    RAISE EXCEPTION '只有超级管理员可以执行数据清理';
  END IF;

  FOR v_row IN
    SELECT d.owner_id
      FROM public.account_deletions d
     WHERE d.restored_at IS NULL
       AND d.purged_at IS NULL
       AND d.purge_after <= now()
  LOOP
    PERFORM public.purge_account_data(v_row.owner_id);
    v_n := v_n + 1;
  END LOOP;

  RETURN QUERY SELECT v_n;
END;
$fn$;
REVOKE ALL ON FUNCTION public.admin_purge_expired_deletions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_purge_expired_deletions() TO authenticated;
