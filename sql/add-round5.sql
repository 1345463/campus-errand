-- 第八轮：积分归属修正、对方信誉分、大厅接单员门槛
--
-- 三件事：
--   1. 确认完成时，积分给**下单人**（之前错发给了接单员）
--   2. 订单参与方可以查看对方信誉分（下单人看得到接单员的信誉分）
--   3. 未成为接单员的人不得读大厅任务（orders 的 SELECT 策略从 USING true 收紧）

-- ============================================================
-- 一、辅助判断函数（给 RLS 策略用，SECURITY DEFINER 才能读到 profiles）
-- ============================================================

-- 是否为管理员（含管理员口令开通的 is_admin，以及 admin_grants 里被授权的人）
CREATE OR REPLACE FUNCTION public.admin_is_any()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (
           SELECT 1 FROM public.profiles p
            WHERE p.owner_id = auth.uid() AND p.is_admin IS TRUE
         )
      OR EXISTS (
           SELECT 1 FROM public.admin_grants g
            WHERE g.user_id = auth.uid()
         );
$fn$;

-- 是否为接单员（认证通过，或身份已切到接单员）
-- 注意：这两个函数在 RLS 策略里被 orders 表逐行调用，
-- 必须是 SECURITY DEFINER，否则会因为 profiles 自身的 RLS 而查不到行。
CREATE OR REPLACE FUNCTION public.is_certified_runner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.owner_id = auth.uid()
       AND (p.role = 'runner' OR p.cert_status = 'approved')
  );
$fn$;

GRANT EXECUTE ON FUNCTION public.admin_is_any() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.is_certified_runner() TO authenticated, anon;

-- ============================================================
-- 二、确认完成：积分改发给下单人
-- ============================================================
-- 赏金依旧打给接单员钱包，但**积分记在下单人账上**（下单人负担赏金，积分作为回馈）。
-- 同时把站内消息拆成两条：接单员只说赏金到账，积分单独通知下单人。
CREATE OR REPLACE FUNCTION public.confirm_order_done(p_order_id bigint)
RETURNS SETOF public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_row public.orders;
  v_reward numeric;
  v_balance numeric;
  v_points integer;
  v_gain integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT * INTO v_row FROM public.orders o WHERE o.id = p_order_id;
  IF v_row.id IS NULL THEN RETURN; END IF;
  IF v_row.owner_id <> v_uid THEN RETURN; END IF;
  IF v_row.status <> 'waiting_confirm' THEN RETURN; END IF;
  IF v_row.runner_id IS NULL THEN RAISE EXCEPTION '该订单还没有接单员'; END IF;

  v_reward := COALESCE(v_row.reward, 0);

  UPDATE public.orders o
     SET status = 'done',
         finished_at = now(),
         feedback_status = 'none'
   WHERE o.id = p_order_id AND o.status = 'waiting_confirm' AND o.owner_id = v_uid;

  -- 赏金：打给接单员
  UPDATE public.profiles p
     SET balance = COALESCE(p.balance, 0) + v_reward
   WHERE p.owner_id = v_row.runner_id
  RETURNING p.balance INTO v_balance;

  INSERT INTO public.wallet_records (user_id, delta, balance, kind, remark)
    VALUES (v_row.runner_id, v_reward, COALESCE(v_balance, v_reward), 'order_reward', '订单 #' || p_order_id || ' 完成结算');

  -- 积分：按赏金 1:1 记给**下单人**
  v_gain := GREATEST(ROUND(v_reward)::integer, 0);
  IF v_gain > 0 THEN
    UPDATE public.profiles p
       SET points = COALESCE(p.points, 0) + v_gain
     WHERE p.owner_id = v_row.owner_id
    RETURNING p.points INTO v_points;

    INSERT INTO public.point_records (user_id, delta, balance, kind, remark)
      VALUES (v_row.owner_id, v_gain, COALESCE(v_points, v_gain), 'order_reward',
              '订单 #' || p_order_id || ' 完成，发布赏金 ' || to_char(v_reward, 'FM9999990.00') || ' 元获得 ' || v_gain || ' 积分');

    PERFORM public.push_message(
      v_row.owner_id,
      'point_reward',
      '积分已到账',
      COALESCE(v_row.title, '任务') || ' 已完成，赏金 ' || to_char(v_reward, 'FM9999990.00') ||
        ' 元按 1:1 折算，获得 ' || v_gain || ' 积分',
      'point',
      NULL
    );
  END IF;

  -- 接单员：只讲赏金，不提积分（积分不是给他的，避免误解）
  PERFORM public.push_message(
    v_row.runner_id,
    'order_confirmed',
    '赏金已到账',
    COALESCE(v_row.title, '任务') || ' 发布方已确认完成，赏金 ¥' || to_char(v_reward, 'FM9999990.00') || ' 已打入钱包',
    'order',
    p_order_id
  );

  RETURN QUERY SELECT * FROM public.orders WHERE id = p_order_id;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.confirm_order_done(bigint) TO authenticated;

-- ============================================================
-- 三、订单参与方互看信誉分
-- ============================================================
-- 下单人看接单员的信誉分（接单员看下单人的也一样），非参与方（除管理员）拿不到。
CREATE OR REPLACE FUNCTION public.order_peer_credit(p_order_id bigint)
RETURNS TABLE (
  peer_name text,
  peer_role text,
  score numeric,
  score_count integer,
  review_count bigint,
  done_count bigint,
  is_runner boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_order public.orders;
  v_peer text;
  v_side text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT * INTO v_order FROM public.orders o WHERE o.id = p_order_id;
  IF v_order.id IS NULL THEN RETURN; END IF;

  IF v_order.runner_id = v_uid THEN
    v_peer := v_order.owner_id;
    v_side := 'owner';
  ELSIF v_order.owner_id = v_uid THEN
    v_peer := v_order.runner_id;
    v_side := 'runner';
  ELSE
    IF NOT public.admin_is_any() THEN
      RAISE EXCEPTION '只有这单的双方和管理员可以查看对方信誉分';
    END IF;
    -- 管理员兜底：优先给看接单员那一侧
    v_peer := COALESCE(v_order.runner_id, v_order.owner_id);
    v_side := CASE WHEN v_order.runner_id IS NOT NULL THEN 'runner' ELSE 'owner' END;
  END IF;

  IF v_peer IS NULL THEN RETURN; END IF;

  RETURN QUERY
    SELECT COALESCE(NULLIF(btrim(p.nickname), ''), NULLIF(btrim(p.owner_name), ''), '同学'),
           v_side,
           CASE WHEN COALESCE(p.runner_score_count, 0) > 0
                THEN ROUND(p.runner_score_sum::numeric / p.runner_score_count, 1)
                ELSE 0::numeric
           END,
           COALESCE(p.runner_score_count, 0),
           (SELECT count(*) FROM public.order_reviews r WHERE r.to_user = v_peer),
           (SELECT count(*) FROM public.orders o2
             WHERE o2.status = 'done' AND (o2.owner_id = v_peer OR o2.runner_id = v_peer)),
           (COALESCE(p.role, 'user') = 'runner' OR COALESCE(p.cert_status, 'none') = 'approved')
      FROM public.profiles p
     WHERE p.owner_id = v_peer
     LIMIT 1;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.order_peer_credit(bigint) TO authenticated;

-- ============================================================
-- 四、大厅门槛：未成为接单员不得读任务
-- ============================================================
-- 原策略 USING (true) 意味着任何登录用户（甚至匿名）都能直接查 orders 表，
-- 把大厅所有任务的标题、描述、取件地点、发布人名字全读走 —— 前端藏起来没用。
-- 收紧成：本人发布的 / 本人接的 / 已认证接单员 / 管理员。
DROP POLICY IF EXISTS orders_read_all ON public.orders;

CREATE POLICY orders_read_all ON public.orders
  FOR SELECT
  TO authenticated, anon
  USING (
    owner_id = auth.uid()::text
    OR runner_id = auth.uid()::text
    OR public.is_certified_runner()
    OR public.admin_is_any()
  );
