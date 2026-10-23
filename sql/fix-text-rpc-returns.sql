-- ============================================================
-- R43 · 修「text 返回的 RPC 被前端当成报错」的整类问题
--
-- 现象：订单详情页整页红条 + toast 显示 `runner`（发布者显示 `owner`）。
--       后台设置权限点了报 `granted`、消息标记已读报 `read`。
--
-- 真因：WorkBuddy Cloud SDK 的 processResponse 对响应体做 JSON.parse，
--       解析失败时把**响应体原文**塞进 error.message：
--           try { data = JSON.parse(body) } catch { error = { message: body } }
--       PostgREST 对 RETURNS text 的函数返回裸字符串 `runner`（不是 `"runner"`），
--       不是合法 JSON → SDK 认定失败 → 前端 getErrorMessage 原样当错误文案弹出来。
--       所以那个位置显示的是「错误信息」，且随账号身份变化（owner / runner / none）。
--
--       同样中招的还有 6 个 text 返回的 RPC。boolean / bigint / integer / void
--       返回的都是合法 JSON（true / 123 / 空体），不受影响 —— 这就是为什么
--       order_hidden（boolean）一直正常，而 order_relation（text）一直报错。
--
-- 修法：全部改成 RETURNS TABLE(...)，让响应体变成 `[{"result":"deleted"}]`。
--       改返回类型必须先 DROP 再 CREATE（42P13），重建后 GRANT 要重新执行。
-- ============================================================

-- ---------- 1. order_relation：详情页判断「我是发布方 / 接单员 / 路人」 ----------
DROP FUNCTION IF EXISTS public.order_relation(bigint);
CREATE FUNCTION public.order_relation(p_order_id bigint)
RETURNS TABLE(relation text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
-- 原来漏了 search_path，函数体里又写的是不限定名的 orders，
-- 调用者可以靠改 search_path 把查询指到别的表上。一并补上。
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_row record;
BEGIN
  IF v_uid IS NULL THEN
    RETURN QUERY SELECT 'none'::text;
    RETURN;
  END IF;

  SELECT o.owner_id, o.runner_id INTO v_row
    FROM public.orders o WHERE o.id = p_order_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'none'::text;
    RETURN;
  END IF;

  -- 接单员优先：同一单不可能既是我发又是我接（服务端 accept_order 已禁自接）
  IF v_row.runner_id IS NOT NULL AND v_row.runner_id = v_uid THEN
    RETURN QUERY SELECT 'runner'::text;
  ELSIF v_row.owner_id = v_uid THEN
    RETURN QUERY SELECT 'owner'::text;
  ELSE
    RETURN QUERY SELECT 'none'::text;
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION public.order_relation(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_relation(bigint) TO authenticated;

-- ---------- 2. hide_my_order：订单列表里删除 ----------
DROP FUNCTION IF EXISTS public.hide_my_order(bigint);
CREATE FUNCTION public.hide_my_order(p_order_id bigint)
RETURNS TABLE(result text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_row public.orders;
  v_closed_at timestamptz;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT * INTO v_row FROM public.orders o WHERE o.id = p_order_id;
  IF v_row.id IS NULL THEN RAISE EXCEPTION '订单不存在'; END IF;

  IF v_row.owner_id <> v_uid AND v_row.runner_id <> v_uid THEN
    RAISE EXCEPTION '只能删除与自己相关的订单';
  END IF;

  v_closed_at := COALESCE(v_row.finished_at, v_row.runner_done_at, v_row.created_at);

  IF v_row.status = 'canceled' AND COALESCE(v_row.takedown, false) THEN
    INSERT INTO public.order_hides (order_id, user_id)
      VALUES (p_order_id, v_uid)
      ON CONFLICT (order_id, user_id) DO NOTHING;
    RETURN QUERY SELECT 'deleted'::text;
    RETURN;
  END IF;

  IF v_row.status IN ('done', 'canceled') AND v_closed_at <= now() - interval '7 days' THEN
    INSERT INTO public.order_hides (order_id, user_id)
      VALUES (p_order_id, v_uid)
      ON CONFLICT (order_id, user_id) DO NOTHING;
    RETURN QUERY SELECT 'deleted'::text;
    RETURN;
  END IF;

  RAISE EXCEPTION '订单需完结满 7 天才能删除（违规下架的订单不受此限制）';
END;
$fn$;
REVOKE ALL ON FUNCTION public.hide_my_order(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hide_my_order(bigint) TO authenticated;

-- ---------- 3. restore_my_order：误删恢复 ----------
DROP FUNCTION IF EXISTS public.restore_my_order(bigint);
CREATE FUNCTION public.restore_my_order(p_order_id bigint)
RETURNS TABLE(result text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  -- 隐藏是「整单」状态，恢复就把这一单上所有人的隐藏记录一起清掉，
  -- 否则会出现一方恢复、另一方仍看不见的错位
  DELETE FROM public.order_hides h WHERE h.order_id = p_order_id;
  RETURN QUERY SELECT 'restored'::text;
END;
$fn$;
REVOKE ALL ON FUNCTION public.restore_my_order(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_my_order(bigint) TO authenticated;

-- ---------- 4. mark_message_read：单条消息标已读 ----------
DROP FUNCTION IF EXISTS public.mark_message_read(bigint);
CREATE FUNCTION public.mark_message_read(p_id bigint)
RETURNS TABLE(result text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_id IS NULL THEN RAISE EXCEPTION '缺少消息编号'; END IF;

  UPDATE public.messages m
     SET read_at = COALESCE(m.read_at, now())
   WHERE m.id = p_id
     AND m.user_id = v_uid;

  IF NOT FOUND THEN RAISE EXCEPTION '消息不存在或不是你的'; END IF;

  RETURN QUERY SELECT 'read'::text;
END;
$fn$;
REVOKE ALL ON FUNCTION public.mark_message_read(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_message_read(bigint) TO authenticated;

-- ---------- 5. mark_all_messages_read：全部标已读 ----------
DROP FUNCTION IF EXISTS public.mark_all_messages_read();
CREATE FUNCTION public.mark_all_messages_read()
RETURNS TABLE(result text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  UPDATE public.messages m
     SET read_at = COALESCE(m.read_at, now())
   WHERE m.user_id = v_uid
     AND m.read_at IS NULL;

  RETURN QUERY SELECT 'read'::text;
END;
$fn$;
REVOKE ALL ON FUNCTION public.mark_all_messages_read() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_all_messages_read() TO authenticated;

-- ---------- 6. admin_set_perm：后台权限授予 / 收回 ----------
DROP FUNCTION IF EXISTS public.admin_set_perm(text, text, boolean);
CREATE FUNCTION public.admin_set_perm(p_user_id text, p_perm_key text, p_enabled boolean)
RETURNS TABLE(result text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_super boolean;
  v_hr boolean;
  v_perm text := btrim(COALESCE(p_perm_key, ''));
  v_target text := btrim(COALESCE(p_user_id, ''));
  v_super_count integer;
  v_on boolean := COALESCE(p_enabled, false);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  v_super := public.admin_has_perm('super');
  v_hr := public.admin_has_perm('hr');

  IF NOT (v_super OR v_hr) THEN
    RAISE EXCEPTION '只有超级管理员或人事可以管理后台权限';
  END IF;

  IF v_perm NOT IN ('super', 'support', 'hr', 'review', 'rental', 'print', 'settle', 'dispatch') THEN
    RAISE EXCEPTION '未知的权限：%', v_perm;
  END IF;

  -- super 是最高权限，只有 super 能授 / 收，hr 拿不到这个权利
  IF v_perm = 'super' AND NOT v_super THEN
    RAISE EXCEPTION '只有超级管理员可以授予或收回超级管理员权限';
  END IF;

  IF v_target = '' THEN RAISE EXCEPTION '请先选中要授权的人员'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.owner_id = v_target) THEN
    RAISE EXCEPTION '找不到这个用户（ID：%）', v_target;
  END IF;

  IF v_perm = 'super' AND v_on = false THEN
    SELECT count(*) INTO v_super_count FROM public.admin_grants g WHERE g.perm_key = 'super';
    IF v_super_count <= 1 THEN
      RAISE EXCEPTION '至少要保留一个超级管理员';
    END IF;
  END IF;

  IF v_on THEN
    INSERT INTO public.admin_grants (user_id, perm_key, granted_by)
      VALUES (v_target, v_perm, v_uid)
      ON CONFLICT (user_id, perm_key) DO NOTHING;
  ELSE
    DELETE FROM public.admin_grants g WHERE g.user_id = v_target AND g.perm_key = v_perm;
  END IF;

  -- is_admin 只是「有没有任意后台权限」的冗余标记，页面显示用；真正的拦截在 admin_has_perm
  UPDATE public.profiles p
     SET is_admin = EXISTS (SELECT 1 FROM public.admin_grants g WHERE g.user_id = p.owner_id)
   WHERE p.owner_id = v_target;

  RETURN QUERY SELECT (CASE WHEN v_on THEN 'granted' ELSE 'revoked' END)::text;
END;
$fn$;
REVOKE ALL ON FUNCTION public.admin_set_perm(text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_perm(text, text, boolean) TO authenticated;

-- ---------- 7. admin_delete_banner：删除轮播 ----------
DROP FUNCTION IF EXISTS public.admin_delete_banner(bigint);
CREATE FUNCTION public.admin_delete_banner(p_id bigint)
RETURNS TABLE(result text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT public.admin_has_perm('super') THEN
    RAISE EXCEPTION '只有超级管理员可以管理轮播';
  END IF;
  IF p_id IS NULL THEN RAISE EXCEPTION '缺少轮播编号'; END IF;

  DELETE FROM public.banners b WHERE b.id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION '轮播不存在'; END IF;

  RETURN QUERY SELECT 'deleted'::text;
END;
$fn$;
REVOKE ALL ON FUNCTION public.admin_delete_banner(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_banner(bigint) TO authenticated;
