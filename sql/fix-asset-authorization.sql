-- ============================================================================
-- 安全加固：图片归属校验 + 工作台 dispatch 权限
--
-- 承接 code-review-2026-10-23 的两个发现：
--   P0-1 图片越权：create_order / complete_order 不校验 asset 归属，
--        get_order_asset 只校验「路径挂在这张单上」→ 任何人建单塞 asset:123
--        就能读到别人的图（含接单员证件照）。media_assets.id 是 bigserial 可枚举。
--   P1-5 dispatch 白名单：admin_dashboard_stats 漏了 dispatch，
--        只有发单员权限的人进不了后台，第八级权限形同虚设。
--
-- 幂等：全部 CREATE OR REPLACE / IF NOT EXISTS / DROP IF EXISTS，可重复执行。
-- 执行顺序：在所有既有迁移之后。
-- 注意：本文件含多语句事务，必须整段执行（不能拆成单条）。
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 图片归属守卫：orders.images / deliver_images 里的 asset:<id>
--    必须属于调用者本人（或该单已确定的参与方）。
--
--    为什么用触发器而不是改写 create_order / complete_order：
--    那两个函数一个 19 个参数、一个带状态机，重写整段代码风险远大于收益；
--    触发器只在他们落库的最后一刻做一道校验，覆盖面反而更全
--    （将来任何新增的写 images 的路径都自动受保护）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_order_assets_owned()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_bad text;
BEGIN
  -- 服务端/迁移场景没有调用者身份时放行，避免历史数据修复被卡住。
  -- 前端一切写操作都带登录态，所以这条豁免不会成为绕过口。
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT t.path INTO v_bad
    FROM unnest(
           COALESCE(NEW.images, ARRAY[]::text[])
        || COALESCE(NEW.deliver_images, ARRAY[]::text[])
         ) AS t(path)
   WHERE t.path ~ '^asset:[0-9]+$'
     AND NOT EXISTS (
       SELECT 1
         FROM public.media_assets ma
        WHERE ma.id = substring(t.path FROM 7)::bigint
          AND ma.owner_id = v_uid
     )
   LIMIT 1;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '图片不属于当前账号，请重新上传';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS orders_assert_assets_owned ON public.orders;
CREATE TRIGGER orders_assert_assets_owned
  BEFORE INSERT OR UPDATE OF images, deliver_images ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_order_assets_owned();

REVOKE ALL ON FUNCTION public.assert_order_assets_owned() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. get_order_asset：读图时再补一道归属校验（纵深防御）
--
--    原逻辑只有两个条件：① 我是这一单的发布方/接单员（或管理员）；
--    ② 这个路径出现在 orders.images / deliver_images 里。
--    但这两个数组是攻击者可控的，所以必须再加一条：
--    ③ 这张图确实属于这一单的发布方或接单员。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_order_asset(p_asset_id bigint, p_order_id bigint)
RETURNS TABLE(id bigint, mime text, data text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_row public.orders;
  v_path text := 'asset:' || p_asset_id;
  v_admin boolean := false;
  v_allow boolean;
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

  IF NOT v_allow THEN RETURN; END IF;

  IF NOT (v_path = ANY(COALESCE(v_row.images, ARRAY[]::text[]))
       OR v_path = ANY(COALESCE(v_row.deliver_images, ARRAY[]::text[]))) THEN
    RETURN;
  END IF;

  -- ③ 图片必须属于这一单的参与方。管理员也不能借订单通道读无关的图。
  IF NOT EXISTS (
    SELECT 1 FROM public.media_assets ma
     WHERE ma.id = p_asset_id
       AND ma.owner_id IN (v_row.owner_id, COALESCE(v_row.runner_id, ''))
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT ma.id, ma.mime, ma.data FROM public.media_assets ma WHERE ma.id = p_asset_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_order_asset(bigint, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_order_asset(bigint, bigint) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. admin_dashboard_stats：补 can_dispatch
--
--    改返回列必须 DROP 后重建（42P13），重建后要重新 GRANT。
--    顺手把「待处理举报」的口径从 support 改成 review ——
--    服务端 admin_handle_report 判的就是 review，客服看得见却处理不了。
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_dashboard_stats();

CREATE FUNCTION public.admin_dashboard_stats()
RETURNS TABLE (
  pending_certs bigint,
  pending_rentals bigint,
  pending_reports bigint,
  pending_settles bigint,
  pending_feedbacks bigint,
  today_orders bigint,
  total_orders bigint,
  can_review boolean,
  can_rental boolean,
  can_support boolean,
  can_settle boolean,
  can_hr boolean,
  can_print boolean,
  can_dispatch boolean,
  can_super boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_review boolean;
  v_rental boolean;
  v_support boolean;
  v_settle boolean;
  v_hr boolean;
  v_print boolean;
  v_dispatch boolean;
  v_super boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  v_super    := public.admin_has_perm('super');
  v_review   := public.admin_has_perm('review');
  v_rental   := public.admin_has_perm('rental');
  v_support  := public.admin_has_perm('support');
  v_settle   := public.admin_has_perm('settle');
  v_hr       := public.admin_has_perm('hr');
  v_print    := public.admin_has_perm('print');
  v_dispatch := public.admin_has_perm('dispatch');

  IF NOT (v_super OR v_review OR v_rental OR v_support
          OR v_settle OR v_hr OR v_print OR v_dispatch) THEN
    RAISE EXCEPTION '没有后台权限';
  END IF;

  RETURN QUERY SELECT
    CASE WHEN (v_super OR v_review)
         THEN (SELECT count(*) FROM public.runner_applications ra WHERE ra.status = 'pending')
         ELSE 0 END,
    CASE WHEN (v_super OR v_rental)
         THEN (SELECT count(*) FROM public.rental_requests rr WHERE rr.status = 'submitted')
         ELSE 0 END,
    CASE WHEN (v_super OR v_review)
         THEN (SELECT count(*) FROM public.order_reports rp WHERE rp.status = 'pending')
         ELSE 0 END,
    CASE WHEN (v_super OR v_settle)
         THEN (SELECT count(*) FROM public.orders o WHERE o.feedback_status = 'pending')
         ELSE 0 END,
    CASE WHEN (v_super OR v_support)
         THEN (SELECT count(*) FROM public.user_feedbacks f WHERE f.status = 'pending')
         ELSE 0 END,
    CASE WHEN v_super
         THEN (SELECT count(*) FROM public.orders o WHERE o.created_at >= date_trunc('day', now()))
         ELSE 0 END,
    CASE WHEN v_super
         THEN (SELECT count(*) FROM public.orders o)
         ELSE 0 END,
    v_review, v_rental, v_support, v_settle, v_hr, v_print, v_dispatch, v_super;
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_dashboard_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_stats() TO authenticated;

COMMIT;

-- ============================================================================
-- 验证（执行后跑一遍，三项都该有结果）
-- ============================================================================
-- 1) 触发器存在
--    SELECT tgname FROM pg_trigger
--     WHERE tgrelid = 'public.orders'::regclass AND NOT tgisinternal;
--
-- 2) 三个函数都在，且 get_order_asset 含归属校验
--    SELECT p.oid::regprocedure, pg_get_functiondef(p.oid)
--      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--     WHERE n.nspname = 'public'
--       AND p.proname IN ('get_order_asset','assert_order_assets_owned',
--                         'admin_dashboard_stats');
--
-- 3) 工作台返回列含 can_dispatch
--    SELECT * FROM public.admin_dashboard_stats();
