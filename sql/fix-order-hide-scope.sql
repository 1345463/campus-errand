-- 修复：订单删除（隐藏）必须是「整单生效」
-- 应用：wbapp_yPJnSvicojPmz998PjKfpM
--
-- 问题现象：
--   A 删除订单后，A 的订单列表里消失了；
--   但 B（另一方）的订单列表里**那条订单还在**，
--   B 点进去详情页却显示「订单已删除」的空态 —— 列表和详情对不上账。
--
-- 根因：
--   隐藏语义改成整单后，order_hidden（SQL-7）和 restore_my_order（SQL-6）
--   都已经不按 user_id 过滤了，但 list_my_orders 漏改，
--   NOT EXISTS 里还留着 `AND h.user_id = v_uid`，于是只滤掉了自己那半边。
--
-- 执行方式：mode=migrate，整段执行一次即可。
-- 影响面：只改「我发布的 / 我接的单」两个列表的过滤口径；
--         管理员 list_all_orders 本来就不做过滤，不受影响；
--         数据不删不改，误删仍可通过 restore_my_order 恢复。

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

-- 自检：确认线上函数体里已经没有 user_id 过滤
-- SELECT prosrc FROM pg_proc WHERE proname = 'list_my_orders';
-- 期望结果：两个 NOT EXISTS 子查询里都只有 h.order_id = o.id，不出现 h.user_id
