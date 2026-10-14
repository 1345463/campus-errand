-- 修复：管理员后台报 column reference "owner_id" is ambiguous
-- 应用：wbapp_yPJnSvicojPmz998PjKfpM
--
-- 根因：list_runner_applications 用 RETURNS TABLE 声明了 OUT 参数（owner_id / status / nickname ...），
-- 这些名字在 PL/pgSQL 里同时是函数变量；函数体内的管理员校验写的是
--   SELECT is_admin INTO v_admin FROM profiles WHERE owner_id = v_uid
-- 未限定表名的 owner_id 既可能是 profiles 的列、也可能是那个 OUT 变量，于是 Postgres 直接报歧义，
-- 第一次执行到这一行就整个函数失败了（管理员列表因此打不开、看起来像「生成测试申请没反应」）。
-- 修法：函数体内所有列引用都带表别名，OUT 参数名保持不变（前端依赖这些字段名）。
--
-- 执行方式：mode=migrate，单条执行（工具一次只支持一条语句），按 SQL-1、SQL-2、SQL-3 顺序各执行一次。
--
-- 状态：2026-10-14 22:45 已全部执行完毕（SQL-1 替换函数、SQL-2 清理探针、SQL-3 还原订单 #2）。
-- 后续若有人重跑 SQL-1 是幂等的，无副作用；SQL-3 只有在订单 #2 又处于 canceled 时才会再改回去。

-- SQL-1：修复列表函数
CREATE OR REPLACE FUNCTION public.list_runner_applications(p_status text DEFAULT 'pending'::text, p_limit integer DEFAULT 50)
RETURNS TABLE(id bigint, owner_id text, real_name text, id_no_masked text, id_card_path text, student_card_path text, detected_name text, detected_no text, status text, review_note text, created_at timestamp with time zone, nickname text, cert_status text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
AS $fn$
DECLARE
  v_uid TEXT := auth.uid();
  v_admin BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT pf.is_admin INTO v_admin FROM public.profiles pf WHERE pf.owner_id = v_uid LIMIT 1;
  IF v_admin IS NOT TRUE THEN RAISE EXCEPTION 'admin only'; END IF;

  RETURN QUERY
    SELECT ra.id,
           ra.owner_id,
           ra.real_name,
           ra.id_no_masked,
           ra.id_card_path,
           ra.student_card_path,
           ra.detected_name,
           ra.detected_no,
           ra.status,
           ra.review_note,
           ra.created_at,
           pf.nickname,
           pf.cert_status
    FROM public.runner_applications ra
    LEFT JOIN public.profiles pf ON pf.owner_id = ra.owner_id
    WHERE (p_status IS NULL OR p_status = '' OR p_status = 'all' OR ra.status = p_status)
    ORDER BY ra.created_at DESC
    LIMIT p_limit;
END;
$fn$;

-- SQL-2：清理排障时留下的临时探针函数（如果执行时提示不存在，忽略即可）
DROP FUNCTION IF EXISTS public.__probe_list(text, integer);
DROP FUNCTION IF EXISTS public.__probe_cancel(text, bigint);

-- SQL-3：还原排障时被置为 canceled 的订单 #2（本次用 RPC 验证取消链路时被改过一条）
-- 不需要还原就不要执行这一条。
UPDATE public.orders SET status = 'pending' WHERE id = 2 AND status = 'canceled';
