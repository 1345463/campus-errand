-- 历史订单删除：按「人」隐藏，数据不真删
-- 应用：wbapp_yPJnSvicojPmz998PjKfpM
--
-- 需求：订单列表里彻底看不到某条订单，但只允许两种情况删：
--   ① 订单完结（已完成 / 已取消）满 7 天；
--   ② 被管理员下架的违规订单（不等 7 天，立刻可删）。
--
-- 设计：不做物理删除，用 order_hides 记「谁删除了哪一单」。
--   1) 结算、举报、审计都要靠订单记录，物理删掉等于把账和证据一起烧了；
--   2) 万一误删，还能恢复（记录仍在库里）；
--   3) 隐藏是**整单生效**：任一方删除后，发布方和接单员的列表里都会消失 ——
--      只藏自己那半边会出现「我删了、对方还看得见」的对不上账，用户明确要求两边一起没。
--      （早期版本按 user_id 只过滤本人，已改为整单过滤，见下方 SQL-10 的 NOT EXISTS。）
--
-- 过滤规则写进 list_my_orders：只过滤「我自己的」列表。
-- 管理员的 list_all_orders 不做过滤 —— 审核和核查必须能看到全部。
--
-- 执行方式：mode=migrate，按 SQL-1 … SQL-9 顺序各执行一次。

-- SQL-1：给订单加「是否被管理员下架」的标记。
-- 违规下架的订单要允许立刻删除，光看 status='canceled' 区分不出来
-- （发布方自己取消也是 canceled），所以单独加一列。
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS takedown boolean NOT NULL DEFAULT false;

-- SQL-2：隐藏关系表（同一人对同一单只会有一条）
CREATE TABLE IF NOT EXISTS public.order_hides (
  order_id bigint NOT NULL,
  user_id text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, user_id)
);

-- SQL-3：开启 RLS（不建任何策略 —— 客户端不能直连读写）
ALTER TABLE public.order_hides ENABLE ROW LEVEL SECURITY;

-- SQL-4：收回直连权限
REVOKE ALL ON public.order_hides FROM PUBLIC, anon, authenticated;

-- SQL-5：删除（隐藏）一单。服务端严格判定，不信任客户端传的「是否可删」。
CREATE OR REPLACE FUNCTION public.hide_my_order(p_order_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_row public.orders;
  v_closed_at timestamp with time zone;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT * INTO v_row FROM public.orders o WHERE o.id = p_order_id;
  IF v_row.id IS NULL THEN RAISE EXCEPTION '订单不存在'; END IF;

  IF v_row.owner_id <> v_uid AND v_row.runner_id <> v_uid THEN
    RAISE EXCEPTION '只能删除与自己相关的订单';
  END IF;

  -- 完结时间：完成用 finished_at，取消统一在取消时写 finished_at（见 SQL-7），
  -- 再兜底用 runner_done_at / created_at，避免老数据没有时间戳就永远删不掉
  v_closed_at := COALESCE(v_row.finished_at, v_row.runner_done_at, v_row.created_at);

  IF v_row.status = 'canceled' AND COALESCE(v_row.takedown, false) THEN
    -- 违规下架：立刻可删
    INSERT INTO public.order_hides (order_id, user_id)
      VALUES (p_order_id, v_uid)
      ON CONFLICT (order_id, user_id) DO NOTHING;
    RETURN 'deleted';
  END IF;

  IF v_row.status IN ('done', 'canceled') AND v_closed_at <= now() - interval '7 days' THEN
    INSERT INTO public.order_hides (order_id, user_id)
      VALUES (p_order_id, v_uid)
      ON CONFLICT (order_id, user_id) DO NOTHING;
    RETURN 'deleted';
  END IF;

  RAISE EXCEPTION '订单需完结满 7 天才能删除（违规下架的订单不受此限制）';
END;
$fn$;

-- SQL-6：恢复（从隐藏表里移除），给误删留一条退路
CREATE OR REPLACE FUNCTION public.restore_my_order(p_order_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  -- 隐藏是整单状态，恢复就把这一单上所有人的隐藏记录一起清掉，
  -- 否则会出现一方恢复、另一方仍看不见的错位
  DELETE FROM public.order_hides h WHERE h.order_id = p_order_id;
  RETURN 'restored';
END;
$fn$;

-- SQL-7：该单是否已删除（隐藏）—— 详情页用它判断要不要给看内容。
-- 注意不按 user_id 过滤：任一方删除后，双方都不该再看到内容。
CREATE OR REPLACE FUNCTION public.order_hidden(p_order_id bigint)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.order_hides h WHERE h.order_id = p_order_id
  );
END;
$fn$;

-- SQL-7b：删掉早期只按本人过滤的旧函数，避免两种语义并存
DROP FUNCTION IF EXISTS public.my_order_hidden(bigint);

-- SQL-8：列出自己隐藏过的订单（默认不展示，只在「显示已删除」时拉取）
CREATE OR REPLACE FUNCTION public.list_my_hidden_orders()
RETURNS SETOF public.orders
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT o.*
      FROM public.order_hides h
      JOIN public.orders o ON o.id = h.order_id
     WHERE h.user_id = v_uid
     ORDER BY h.created_at DESC
     LIMIT 50;
END;
$fn$;

-- SQL-9：取消订单时补写 finished_at —— 否则「取消的单」没有完结时间，永远算不满 7 天
CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id bigint)
RETURNS SETOF public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  RETURN QUERY UPDATE public.orders
     SET status = 'canceled',
         finished_at = COALESCE(finished_at, now())
   WHERE id = p_order_id
     AND owner_id = v_uid
     AND status = 'pending'
   RETURNING *;
END;
$fn$;

-- SQL-10：我的订单列表排除已隐藏的单。
-- 注意 NOT EXISTS 里**不带** h.user_id = v_uid：隐藏是整单状态。
-- 早期版本带了这个条件，导致「A 删了、B 的列表还在，B 点进去却显示已删除」，
-- 列表和详情对不上账 —— 与 order_hidden / restore_my_order 的口径必须一致。
CREATE OR REPLACE FUNCTION public.list_my_orders(p_mode text DEFAULT 'publish')
RETURNS SETOF public.orders
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  IF p_mode = 'accept' THEN
    RETURN QUERY
      SELECT o.*
        FROM public.orders o
       WHERE o.runner_id = v_uid
         AND NOT EXISTS (
           SELECT 1 FROM public.order_hides h WHERE h.order_id = o.id
         )
       ORDER BY o.created_at DESC
       LIMIT 50;
  ELSE
    RETURN QUERY
      SELECT o.*
        FROM public.orders o
       WHERE o.owner_id = v_uid
         AND NOT EXISTS (
           SELECT 1 FROM public.order_hides h WHERE h.order_id = o.id
         )
       ORDER BY o.created_at DESC
       LIMIT 50;
  END IF;
END;
$fn$;
