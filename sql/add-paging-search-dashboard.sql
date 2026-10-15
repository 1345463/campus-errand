-- =============================================================================
-- 订单分页 / 搜索 / 工作台统计 / 我的反馈
--
-- 注意：list_my_orders 原来只有一个 p_mode 参数，加分页参数必须改签名，
-- 而 CREATE OR REPLACE 不能改返回类型之外的签名差异（这里返回类型没变、
-- 参数变了，属于重载而不是替换），所以先 DROP 再 CREATE。
--
-- 已执行于：wbapp_yPJnSvicojPmz998PjKfpM
-- =============================================================================

-- SQL-1：我的订单列表支持分页
DROP FUNCTION IF EXISTS public.list_my_orders(text);

CREATE OR REPLACE FUNCTION public.list_my_orders(
  p_mode text DEFAULT 'publish',
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS SETOF public.orders
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;

  -- 隐藏判断不按 user_id 过滤：删除是「整单生效」，
  -- 一方删掉之后双方列表都不该再看到这条单
  IF p_mode = 'accept' THEN
    RETURN QUERY
      SELECT o.* FROM public.orders o
       WHERE o.runner_id = v_uid
         AND NOT EXISTS (SELECT 1 FROM public.order_hides h WHERE h.order_id = o.id)
       ORDER BY o.created_at DESC
       LIMIT v_limit OFFSET v_offset;
  ELSE
    RETURN QUERY
      SELECT o.* FROM public.orders o
       WHERE o.owner_id = v_uid
         AND NOT EXISTS (SELECT 1 FROM public.order_hides h WHERE h.order_id = o.id)
       ORDER BY o.created_at DESC
       LIMIT v_limit OFFSET v_offset;
  END IF;
END;
$fn$;

-- SQL-2：按单号 / 标题 / 描述 / 地址搜自己相关的单
CREATE OR REPLACE FUNCTION public.search_my_orders(p_keyword text, p_limit integer)
RETURNS SETOF public.orders
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_kw text := btrim(COALESCE(p_keyword, ''));
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  IF v_kw = '' THEN RETURN; END IF;

  RETURN QUERY
    SELECT o.* FROM public.orders o
     WHERE (o.owner_id = v_uid OR o.runner_id = v_uid)
       AND NOT EXISTS (SELECT 1 FROM public.order_hides h WHERE h.order_id = o.id)
       AND (
            o.title        ILIKE '%' || v_kw || '%'
         OR o.description  ILIKE '%' || v_kw || '%'
         OR o.service_name ILIKE '%' || v_kw || '%'
         OR o.pickup_addr  ILIKE '%' || v_kw || '%'
         OR o.deliver_addr ILIKE '%' || v_kw || '%'
         OR (o.id)::text = v_kw          -- 直接输单号
       )
     ORDER BY o.created_at DESC
     LIMIT v_limit;
END;
$fn$;

-- SQL-3：管理员拉全部订单，同样支持分页
DROP FUNCTION IF EXISTS public.list_all_orders(integer);

CREATE OR REPLACE FUNCTION public.list_all_orders(
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS SETOF public.orders
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_admin boolean;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT pf.is_admin INTO v_admin FROM public.profiles pf WHERE pf.owner_id = v_uid LIMIT 1;
  IF v_admin IS NOT TRUE THEN RAISE EXCEPTION 'admin only'; END IF;

  RETURN QUERY
    SELECT o.* FROM public.orders o
     ORDER BY o.created_at DESC
     LIMIT v_limit OFFSET v_offset;
END;
$fn$;

-- SQL-4：我在某张单上的评价状态
CREATE OR REPLACE FUNCTION public.my_order_review_state(p_order_id bigint)
RETURNS TABLE (
  can_review boolean,
  my_score integer,
  my_comment text,
  peer_score integer,
  peer_comment text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_order public.orders;
  v_mine public.order_reviews;
  v_peer public.order_reviews;
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;

  SELECT * INTO v_order FROM public.orders o WHERE o.id = p_order_id;
  IF v_order.id IS NULL THEN RETURN; END IF;

  SELECT * INTO v_mine FROM public.order_reviews r
   WHERE r.order_id = p_order_id AND r.from_user = v_uid LIMIT 1;
  SELECT * INTO v_peer FROM public.order_reviews r
   WHERE r.order_id = p_order_id AND r.from_user <> v_uid LIMIT 1;

  RETURN QUERY SELECT
    (v_mine.id IS NULL AND v_order.status = 'done'
     AND (v_order.owner_id = v_uid OR v_order.runner_id = v_uid)),
    v_mine.score,
    COALESCE(v_mine.comment, ''),
    v_peer.score,
    COALESCE(v_peer.comment, '');
END;
$fn$;

-- SQL-5：管理员工作台统计
-- 按调用者权限过滤：没有的权限计数返回 0 且 can_xxx 为 false，
-- 前端据此整张卡片不渲染，而不是显示一个 0 让人以为真的没有待办。
CREATE OR REPLACE FUNCTION public.admin_dashboard_stats()
RETURNS TABLE (
  pending_certs bigint,
  pending_rentals bigint,
  pending_reports bigint,
  pending_settles bigint,
  today_orders bigint,
  total_orders bigint,
  can_review boolean,
  can_rental boolean,
  can_support boolean,
  can_settle boolean,
  can_hr boolean,
  can_print boolean,
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
  v_super boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  v_super := public.admin_has_perm('super');
  v_review := public.admin_has_perm('review');
  v_rental := public.admin_has_perm('rental');
  v_support := public.admin_has_perm('support');
  v_settle := public.admin_has_perm('settle');
  v_hr := public.admin_has_perm('hr');
  v_print := public.admin_has_perm('print');

  IF NOT (v_super OR v_review OR v_rental OR v_support OR v_settle OR v_hr OR v_print) THEN
    RAISE EXCEPTION '没有后台权限';
  END IF;

  RETURN QUERY SELECT
    CASE WHEN (v_super OR v_review)
         THEN (SELECT count(*) FROM public.runner_applications ra WHERE ra.status = 'pending')
         ELSE 0 END,
    CASE WHEN (v_super OR v_rental)
         THEN (SELECT count(*) FROM public.rental_requests rr WHERE rr.status = 'submitted')
         ELSE 0 END,
    CASE WHEN (v_super OR v_support)
         THEN (SELECT count(*) FROM public.order_reports rp WHERE rp.status = 'pending')
         ELSE 0 END,
    CASE WHEN (v_super OR v_settle)
         THEN (SELECT count(*) FROM public.orders o WHERE o.feedback_status = 'pending')
         ELSE 0 END,
    (SELECT count(*) FROM public.orders o WHERE o.created_at >= date_trunc('day', now())),
    (SELECT count(*) FROM public.orders o),
    v_review, v_rental, v_support, v_settle, v_hr, v_print, v_super;
END;
$fn$;

-- SQL-6：我提交过的意见反馈（普通用户可查自己的）
CREATE OR REPLACE FUNCTION public.list_my_feedbacks(p_limit integer)
RETURNS TABLE (
  id bigint,
  kind text,
  content text,
  contact text,
  status text,
  admin_note text,
  created_at timestamp with time zone,
  handled_at timestamp with time zone
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;

  RETURN QUERY
    SELECT f.id, f.kind, f.content, f.contact, f.status, f.admin_note, f.created_at, f.handled_at
      FROM public.user_feedbacks f
     WHERE f.user_id = v_uid
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT v_limit;
END;
$fn$;
