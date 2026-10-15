-- 续：评价查询 / 积分与钱包流水 / 意见反馈 / 工作台统计
-- 执行方式：mode=migrate，按 SQL-16 … SQL-24 顺序各执行一次。

-- SQL-16：查看某单的评价。只限该单参与方或管理员。
CREATE OR REPLACE FUNCTION public.get_order_reviews(p_order_id bigint)
RETURNS TABLE (
  id bigint,
  order_id bigint,
  from_role text,
  to_role text,
  score integer,
  tags text[],
  comment text,
  created_at timestamp with time zone
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_order public.orders;
  v_admin boolean := false;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT * INTO v_order FROM public.orders o WHERE o.id = p_order_id;
  IF v_order.id IS NULL THEN RETURN; END IF;

  IF v_order.owner_id <> v_uid AND v_order.runner_id <> v_uid THEN
    SELECT COALESCE(pf.is_admin, false) INTO v_admin
      FROM public.profiles pf WHERE pf.owner_id = v_uid LIMIT 1;
    IF NOT v_admin THEN RAISE EXCEPTION '无权查看这单的评价'; END IF;
  END IF;

  RETURN QUERY
    SELECT r.id, r.order_id, r.from_role, r.to_role, r.score, r.tags, r.comment, r.created_at
      FROM public.order_reviews r
     WHERE r.order_id = p_order_id
     ORDER BY r.created_at, r.id;
END;
$fn$;

-- SQL-17：我的积分流水
CREATE OR REPLACE FUNCTION public.list_my_point_records(p_limit integer, p_offset integer)
RETURNS TABLE (
  id bigint,
  delta integer,
  balance integer,
  kind text,
  remark text,
  created_at timestamp with time zone
)
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

  RETURN QUERY
    SELECT r.id, r.delta, r.balance, r.kind, r.remark, r.created_at
      FROM public.point_records r
     WHERE r.user_id = v_uid
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT v_limit OFFSET v_offset;
END;
$fn$;

-- SQL-18：我的钱包流水
CREATE OR REPLACE FUNCTION public.list_my_wallet_records(p_limit integer, p_offset integer)
RETURNS TABLE (
  id bigint,
  delta numeric,
  balance numeric,
  kind text,
  remark text,
  created_at timestamp with time zone
)
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

  RETURN QUERY
    SELECT r.id, r.delta, r.balance, r.kind, r.remark, r.created_at
      FROM public.wallet_records r
     WHERE r.user_id = v_uid
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT v_limit OFFSET v_offset;
END;
$fn$;

-- SQL-19：提交意见反馈
CREATE OR REPLACE FUNCTION public.submit_user_feedback(
  p_kind text,
  p_content text,
  p_contact text
) RETURNS SETOF public.user_feedbacks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_kind text := COALESCE(NULLIF(btrim(COALESCE(p_kind, '')), ''), 'suggestion');
  v_content text := btrim(COALESCE(p_content, ''));
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF v_content = '' THEN RAISE EXCEPTION '请填写反馈内容'; END IF;
  IF char_length(v_content) > 500 THEN RAISE EXCEPTION '反馈内容最多 500 字'; END IF;
  IF v_kind NOT IN ('suggestion', 'complaint', 'bug', 'other') THEN
    RAISE EXCEPTION '未知的反馈类型：%', v_kind;
  END IF;

  RETURN QUERY
    INSERT INTO public.user_feedbacks (user_id, kind, content, contact)
      VALUES (v_uid, v_kind, v_content, left(btrim(COALESCE(p_contact, '')), 60))
    RETURNING *;
END;
$fn$;

-- SQL-20：客服后台读取反馈
CREATE OR REPLACE FUNCTION public.admin_list_user_feedbacks(p_status text, p_limit integer)
RETURNS SETOF public.user_feedbacks
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT public.admin_has_perm('support') THEN
    RAISE EXCEPTION '只有客服或超级管理员可以查看反馈';
  END IF;

  RETURN QUERY
    SELECT f.* FROM public.user_feedbacks f
     WHERE (COALESCE(NULLIF(btrim(COALESCE(p_status, '')), ''), 'all') = 'all' OR f.status = p_status)
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT v_limit;
END;
$fn$;

-- SQL-21：客服受理 / 驳回反馈，并给提交人发站内消息
CREATE OR REPLACE FUNCTION public.admin_handle_user_feedback(
  p_id bigint,
  p_action text,
  p_note text
) RETURNS SETOF public.user_feedbacks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_new text;
  v_target text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT public.admin_has_perm('support') THEN
    RAISE EXCEPTION '只有客服或超级管理员可以处理反馈';
  END IF;

  IF p_action = 'resolve' THEN
    v_new := 'resolved';
  ELSIF p_action = 'reject' THEN
    v_new := 'rejected';
  ELSE
    RAISE EXCEPTION '未知的处理动作：%', COALESCE(p_action, '(空)');
  END IF;

  IF v_new = 'rejected' AND COALESCE(btrim(COALESCE(p_note, '')), '') = '' THEN
    RAISE EXCEPTION '驳回需要填写理由，方便同学理解';
  END IF;

  SELECT f.user_id INTO v_target FROM public.user_feedbacks f WHERE f.id = p_id;
  IF v_target IS NULL THEN RAISE EXCEPTION '反馈不存在'; END IF;

  UPDATE public.user_feedbacks f
     SET status = v_new,
         admin_note = left(COALESCE(p_note, ''), 300),
         handled_at = now(),
         handled_by = v_uid
   WHERE f.id = p_id;

  PERFORM public.push_message(
    v_target,
    'feedback_handled',
    CASE WHEN v_new = 'resolved' THEN '反馈已受理' ELSE '反馈已处理' END,
    CASE WHEN v_new = 'resolved'
         THEN '你提交的反馈我们已受理，感谢反馈'
         ELSE ('你提交的反馈处理结果：' || COALESCE(p_note, ''))
    END,
    'feedback',
    p_id
  );

  RETURN QUERY SELECT * FROM public.user_feedbacks WHERE id = p_id;
END;
$fn$;

-- SQL-22：我的评价入口 —— 某单我还能不能评、对方给我评了什么
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

-- SQL-23：管理员工作台统计。一次请求拿回各后台待办数，
-- 每项都按调用者的权限返回：没权限的项返回 0，页面据此不显示对应卡片。
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

  v_super   := public.admin_has_perm('super');
  v_review  := public.admin_has_perm('review');
  v_rental  := public.admin_has_perm('rental');
  v_support := public.admin_has_perm('support');
  v_settle  := public.admin_has_perm('settle');
  v_hr      := public.admin_has_perm('hr');
  v_print   := public.admin_has_perm('print');

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
         THEN (SELECT count(*) FROM public.orders o
                WHERE o.feedback_status = 'pending')
         ELSE 0 END,
    (SELECT count(*) FROM public.orders o
      WHERE o.created_at >= date_trunc('day', now())),
    (SELECT count(*) FROM public.orders o),
    v_review, v_rental, v_support, v_settle, v_hr, v_print, v_super;
END;
$fn$;
