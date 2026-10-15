-- ============================================================
-- 评价与信誉分 / 积分流水 / 钱包流水 / 意见反馈 / 管理员工作台
-- 应用：wbapp_yPJnSvicojPmz998PjKfpM
--
-- 说明：
--   1) 评价：订单 status='done' 后，发布方与接单员各可评价一次
--      （UNIQUE(order_id, from_role) 从库层面挡住重复评价）。
--      给接单员的评分会累加进 profiles.runner_score_sum / runner_score_count。
--   2) 积分流水 / 钱包流水：当前版本积分只发放不扣减、钱包只在确认完成时入账，
--      两张流水表先把结构落好，由 confirm_order_done 写入钱包流水，
--      积分流水留给后续运营后台发积分时写入。
--   3) 意见反馈：用户提交建议 / 投诉，客服后台受理、回复。
--   4) 工作台：一次请求拿回各后台待办数量，省得五个后台页逐个点开看。
--
-- 执行方式：mode=migrate，按 SQL-1 … SQL-13 顺序各执行一次。
-- ============================================================

-- ---------- 评价与信誉分 ----------

-- SQL-1：profiles 加信誉分累计列（用「总分 + 次数」而不是存平均值，避免精度漂移）
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS runner_score_sum integer NOT NULL DEFAULT 0;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS runner_score_count integer NOT NULL DEFAULT 0;

-- SQL-2：评价表
CREATE TABLE IF NOT EXISTS public.order_reviews (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL,
  from_user text NOT NULL,
  from_role text NOT NULL,
  to_user text,
  to_role text,
  score integer NOT NULL DEFAULT 5,
  tags text[] NOT NULL DEFAULT '{}',
  comment text NOT NULL DEFAULT '',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (order_id, from_role)
);
COMMENT ON TABLE public.order_reviews IS '订单互评：一单一方只能评一次；给接单员的评分累计成信誉分';

-- SQL-3：RLS + 收回直连权限
ALTER TABLE public.order_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_reviews FROM PUBLIC, anon, authenticated;

-- SQL-4：索引
CREATE INDEX IF NOT EXISTS order_reviews_order_idx ON public.order_reviews (order_id);
CREATE INDEX IF NOT EXISTS order_reviews_target_idx ON public.order_reviews (to_user, created_at DESC);

-- SQL-5：提交评价
CREATE OR REPLACE FUNCTION public.submit_order_review(
  p_order_id bigint,
  p_score integer,
  p_tags text[],
  p_comment text
) RETURNS SETOF public.order_reviews
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_order public.orders;
  v_from_role text;
  v_to_user text;
  v_to_role text;
  v_exists integer := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT * INTO v_order FROM public.orders o WHERE o.id = p_order_id;
  IF v_order.id IS NULL THEN RAISE EXCEPTION '订单不存在'; END IF;
  IF v_order.status <> 'done' THEN RAISE EXCEPTION '订单完成后才能评价'; END IF;

  IF v_order.owner_id = v_uid THEN
    v_from_role := 'owner';
    v_to_user := v_order.runner_id;
    v_to_role := 'runner';
  ELSIF v_order.runner_id = v_uid THEN
    v_from_role := 'runner';
    v_to_user := v_order.owner_id;
    v_to_role := 'owner';
  ELSE
    RAISE EXCEPTION '只能评价自己参与的订单';
  END IF;

  IF p_score IS NULL OR p_score < 1 OR p_score > 5 THEN
    RAISE EXCEPTION '评分需要在 1 - 5 之间';
  END IF;

  SELECT count(*) INTO v_exists
    FROM public.order_reviews r
   WHERE r.order_id = p_order_id AND r.from_role = v_from_role;
  IF v_exists > 0 THEN RAISE EXCEPTION '你已经评价过这单了'; END IF;

  RETURN QUERY
    INSERT INTO public.order_reviews (order_id, from_user, from_role, to_user, to_role, score, tags, comment)
      VALUES (
        p_order_id,
        v_uid,
        v_from_role,
        v_to_user,
        v_to_role,
        p_score,
        COALESCE(p_tags, ARRAY[]::text[]),
        left(btrim(COALESCE(p_comment, '')), 200)
      )
    RETURNING *;

  -- 只有给接单员的评分才计入信誉分
  IF v_to_user IS NOT NULL AND v_to_role = 'runner' THEN
    UPDATE public.profiles p
       SET runner_score_sum   = COALESCE(p.runner_score_sum, 0) + p_score,
           runner_score_count = COALESCE(p.runner_score_count, 0) + 1
     WHERE p.owner_id = v_to_user;
  END IF;
END;
$fn$;

-- SQL-6：查看某单的评价。只限该单的参与方或管理员。
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

-- ---------- 积分流水 ----------

-- SQL-7
CREATE TABLE IF NOT EXISTS public.point_records (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  delta integer NOT NULL DEFAULT 0,
  balance integer NOT NULL DEFAULT 0,
  kind text NOT NULL DEFAULT 'system',
  remark text NOT NULL DEFAULT '',
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.point_records IS '积分流水：发放与扣减明细';

-- SQL-8
ALTER TABLE public.point_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.point_records FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS point_records_user_idx ON public.point_records (user_id, created_at DESC);

-- ---------- 钱包流水 ----------

-- SQL-9
CREATE TABLE IF NOT EXISTS public.wallet_records (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  delta numeric(12, 2) NOT NULL DEFAULT 0,
  balance numeric(12, 2) NOT NULL DEFAULT 0,
  kind text NOT NULL DEFAULT 'system',
  remark text NOT NULL DEFAULT '',
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.wallet_records IS '钱包流水：赏金入账与支出明细';

-- SQL-10
ALTER TABLE public.wallet_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wallet_records FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS wallet_records_user_idx ON public.wallet_records (user_id, created_at DESC);

-- ---------- 意见反馈 ----------

-- SQL-11
CREATE TABLE IF NOT EXISTS public.user_feedbacks (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  kind text NOT NULL DEFAULT 'suggestion',
  content text NOT NULL DEFAULT '',
  contact text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  admin_note text NOT NULL DEFAULT '',
  handled_at timestamp with time zone,
  handled_by text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.user_feedbacks IS '用户意见反馈：建议 / 投诉，由客服后台受理';

-- SQL-12
ALTER TABLE public.user_feedbacks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_feedbacks FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS user_feedbacks_status_idx ON public.user_feedbacks (status, created_at DESC);
