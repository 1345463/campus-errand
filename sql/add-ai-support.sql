-- ============================================================
-- AI 智能客服：FAQ 固定回答 + AI 兜底 + 转人工工单
-- 依赖：public.admin_has_perm('support')（客服权限）
-- ============================================================

-- ---------- 1. FAQ 问答表 ----------
CREATE TABLE IF NOT EXISTS public.faq_items (
  id         bigserial PRIMARY KEY,
  category   text        NOT NULL DEFAULT '常见问题',
  question   text        NOT NULL,
  answer     text        NOT NULL,
  -- 关键词：空格或逗号分隔，用户提问命中任意一个就算匹配上固定回答
  keywords   text        NOT NULL DEFAULT '',
  sort_order integer     NOT NULL DEFAULT 100,
  enabled    boolean     NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 注意是 text 不是 uuid：这套库里 auth.uid() 返回 text，
  -- admin_grants.user_id 也是 text（微信登录的是 "wx:openid" 这种）。
  -- 写成 uuid 的话 admin_upsert_faq_item 一进来就会 22P02 invalid input syntax for type uuid。
  updated_by text
);

-- ---------- 2. 客服设置（单行表，id 恒为 1） ----------
CREATE TABLE IF NOT EXISTS public.faq_settings (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ai_enabled  boolean     NOT NULL DEFAULT false,
  ai_model    text        NOT NULL DEFAULT '',
  ai_prompt   text        NOT NULL DEFAULT '',
  welcome     text        NOT NULL DEFAULT '你好，我是校园跑腿的智能助手，常见问题可以直接问我。',
  -- 每人每天 AI 提问上限：端上直连大模型，不限流会被刷爆配额
  daily_limit integer     NOT NULL DEFAULT 20,
  -- 下面五个是模型调用参数，端上 llmChat 直接照搬，改后台即生效、不用发版。
  -- 范围的上下限在 admin_update_faq_settings 里也卡一遍：
  -- 服务端是最后一道关，只靠前端输入框校验的话，脏值会把整个 AI 弄挂。
  temperature       numeric(3,2) NOT NULL DEFAULT 0.30,
  max_tokens        integer      NOT NULL DEFAULT 400,
  context_faq_limit integer      NOT NULL DEFAULT 40,
  history_turns     integer      NOT NULL DEFAULT 3,
  timeout_ms        integer      NOT NULL DEFAULT 30000,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.faq_settings (id, ai_prompt)
VALUES (
  1,
  E'你是「校园跑腿」小程序的智能客服助手，服务广东邮电职业技术学院的师生。\n'
  '只回答与本平台相关的问题：发布任务、接单、赏金与价格、取消订单、实名认证、信誉分、积分商城、相机租赁、意见反馈。\n'
  '规则：\n'
  '1. 用中文回答，简短直接，单次回答控制在 120 字以内。\n'
  '2. 只能依据下面「平台资料」里的内容回答；资料里没有的，直接说「这个我答不准，请点『转人工』」，绝不编造价格、时限或规则。\n'
  '3. 不要承诺任何具体金额、到账时间或平台没有的功能。\n'
  '4. 涉及投诉、退款、账号异常、订单纠纷，直接引导用户转人工。'
)
ON CONFLICT (id) DO NOTHING;

-- 老库升级：上面那句 CREATE TABLE IF NOT EXISTS 对已存在的表不会补列，
-- 所以新增列要单独 ALTER 一遍，重复执行也不会报错。
ALTER TABLE public.faq_settings
  ADD COLUMN IF NOT EXISTS temperature       numeric(3,2) NOT NULL DEFAULT 0.30,
  ADD COLUMN IF NOT EXISTS max_tokens        integer      NOT NULL DEFAULT 400,
  ADD COLUMN IF NOT EXISTS context_faq_limit integer      NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS history_turns     integer      NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS timeout_ms        integer      NOT NULL DEFAULT 30000;

-- ---------- 3. RLS ----------
ALTER TABLE public.faq_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.faq_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS faq_items_select_enabled ON public.faq_items;
CREATE POLICY faq_items_select_enabled ON public.faq_items
  FOR SELECT USING (enabled = true);

DROP POLICY IF EXISTS faq_items_admin_all ON public.faq_items;
CREATE POLICY faq_items_admin_all ON public.faq_items
  FOR ALL USING (public.admin_has_perm('support'))
  WITH CHECK (public.admin_has_perm('support'));

DROP POLICY IF EXISTS faq_settings_select ON public.faq_settings;
CREATE POLICY faq_settings_select ON public.faq_settings
  FOR SELECT USING (true);

DROP POLICY IF EXISTS faq_settings_admin_all ON public.faq_settings;
CREATE POLICY faq_settings_admin_all ON public.faq_settings
  FOR ALL USING (public.admin_has_perm('support'))
  WITH CHECK (public.admin_has_perm('support'));

-- ---------- 4. 公开：启用的 FAQ 列表 ----------
DROP FUNCTION IF EXISTS public.list_faq_items();
CREATE FUNCTION public.list_faq_items()
RETURNS TABLE (
  id         bigint,
  category   text,
  question   text,
  answer     text,
  keywords   text,
  sort_order integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT id, category, question, answer, keywords, sort_order
  FROM public.faq_items
  WHERE enabled = true
  ORDER BY sort_order ASC, id ASC;
$fn$;
GRANT EXECUTE ON FUNCTION public.list_faq_items() TO authenticated, anon;

-- ---------- 5. 公开：客服设置 ----------
-- 注意：这里要返回 ai_prompt。端上直连大模型，系统提示词得由客户端拼进 messages，
-- 所以 prompt 不是秘密（不含密钥），只要求它别写进日志。
DROP FUNCTION IF EXISTS public.get_faq_settings();
CREATE FUNCTION public.get_faq_settings()
RETURNS TABLE (
  ai_enabled boolean, ai_model text, ai_prompt text, welcome text, daily_limit integer,
  temperature numeric, max_tokens integer, context_faq_limit integer, history_turns integer, timeout_ms integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT ai_enabled, ai_model, ai_prompt, welcome, daily_limit,
         temperature, max_tokens, context_faq_limit, history_turns, timeout_ms
  FROM public.faq_settings
  WHERE id = 1;
$fn$;
GRANT EXECUTE ON FUNCTION public.get_faq_settings() TO authenticated, anon;

-- ---------- 6. 管理：全量 FAQ ----------
DROP FUNCTION IF EXISTS public.admin_list_faq_items();
CREATE FUNCTION public.admin_list_faq_items()
RETURNS TABLE (
  id         bigint,
  category   text,
  question   text,
  answer     text,
  keywords   text,
  sort_order integer,
  enabled    boolean,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT public.admin_has_perm('support') THEN
    RAISE EXCEPTION '没有客服权限';
  END IF;
  RETURN QUERY
    SELECT f.id, f.category, f.question, f.answer, f.keywords,
           f.sort_order, f.enabled, f.updated_at
    FROM public.faq_items f
    ORDER BY f.sort_order ASC, f.id ASC;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.admin_list_faq_items() TO authenticated;

-- ---------- 7. 管理：新增 / 更新 FAQ ----------
DROP FUNCTION IF EXISTS public.admin_upsert_faq_item(bigint, text, text, text, text, integer, boolean);
CREATE FUNCTION public.admin_upsert_faq_item(
  p_id         bigint,
  p_category   text,
  p_question   text,
  p_answer     text,
  p_keywords   text,
  p_sort_order integer,
  p_enabled    boolean
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid   text := auth.uid();
  v_newid bigint;
BEGIN
  IF NOT public.admin_has_perm('support') THEN
    RAISE EXCEPTION '没有客服权限';
  END IF;
  IF COALESCE(trim(p_question), '') = '' THEN
    RAISE EXCEPTION '问题不能为空';
  END IF;
  IF COALESCE(trim(p_answer), '') = '' THEN
    RAISE EXCEPTION '回答不能为空';
  END IF;

  IF p_id IS NOT NULL AND p_id > 0 THEN
    UPDATE public.faq_items
       SET category   = COALESCE(NULLIF(trim(p_category), ''), '常见问题'),
           question   = trim(p_question),
           answer     = trim(p_answer),
           keywords   = COALESCE(p_keywords, ''),
           sort_order = COALESCE(p_sort_order, 100),
           enabled    = COALESCE(p_enabled, true),
           updated_at = now(),
           updated_by = v_uid
     WHERE id = p_id
    RETURNING id INTO v_newid;
    IF v_newid IS NULL THEN
      RAISE EXCEPTION '这条 FAQ 不存在';
    END IF;
  ELSE
    INSERT INTO public.faq_items (category, question, answer, keywords, sort_order, enabled, updated_by)
    VALUES (
      COALESCE(NULLIF(trim(p_category), ''), '常见问题'),
      trim(p_question),
      trim(p_answer),
      COALESCE(p_keywords, ''),
      COALESCE(p_sort_order, 100),
      COALESCE(p_enabled, true),
      v_uid
    )
    RETURNING id INTO v_newid;
  END IF;
  RETURN v_newid;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.admin_upsert_faq_item(bigint, text, text, text, text, integer, boolean) TO authenticated;

-- ---------- 8. 管理：删除 FAQ ----------
DROP FUNCTION IF EXISTS public.admin_delete_faq_item(bigint);
CREATE FUNCTION public.admin_delete_faq_item(p_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT public.admin_has_perm('support') THEN
    RAISE EXCEPTION '没有客服权限';
  END IF;
  DELETE FROM public.faq_items WHERE id = p_id;
  RETURN FOUND;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.admin_delete_faq_item(bigint) TO authenticated;

-- ---------- 9. 管理：读取完整设置（含 prompt） ----------
DROP FUNCTION IF EXISTS public.admin_get_faq_settings();
CREATE FUNCTION public.admin_get_faq_settings()
RETURNS TABLE (
  ai_enabled boolean, ai_model text, ai_prompt text, welcome text, daily_limit integer,
  temperature numeric, max_tokens integer, context_faq_limit integer, history_turns integer, timeout_ms integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT public.admin_has_perm('support') THEN
    RAISE EXCEPTION '没有客服权限';
  END IF;
  RETURN QUERY
    SELECT s.ai_enabled, s.ai_model, s.ai_prompt, s.welcome, s.daily_limit,
           s.temperature, s.max_tokens, s.context_faq_limit, s.history_turns, s.timeout_ms
    FROM public.faq_settings s WHERE s.id = 1;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.admin_get_faq_settings() TO authenticated;

-- ---------- 10. 管理：更新设置 ----------
-- 十个参数：超过 8 个就别数位置了，调用方一律用命名参数 p_xxx。
DROP FUNCTION IF EXISTS public.admin_update_faq_settings(boolean, text, text, text, integer);
DROP FUNCTION IF EXISTS public.admin_update_faq_settings(boolean, text, text, text, integer, numeric, integer, integer, integer, integer);
CREATE FUNCTION public.admin_update_faq_settings(
  p_ai_enabled        boolean,
  p_ai_model          text,
  p_ai_prompt         text,
  p_welcome           text,
  p_daily_limit       integer,
  p_temperature       numeric,
  p_max_tokens        integer,
  p_context_faq_limit integer,
  p_history_turns     integer,
  p_timeout_ms        integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT public.admin_has_perm('support') THEN
    RAISE EXCEPTION '没有客服权限';
  END IF;
  IF p_daily_limit IS NOT NULL AND (p_daily_limit < 1 OR p_daily_limit > 200) THEN
    RAISE EXCEPTION '每日提问上限要在 1 到 200 之间';
  END IF;
  IF p_temperature IS NOT NULL AND (p_temperature < 0 OR p_temperature > 1) THEN
    RAISE EXCEPTION '温度要在 0 到 1 之间';
  END IF;
  IF p_max_tokens IS NOT NULL AND (p_max_tokens < 50 OR p_max_tokens > 2000) THEN
    RAISE EXCEPTION '单次最大字数要在 50 到 2000 之间';
  END IF;
  IF p_context_faq_limit IS NOT NULL AND (p_context_faq_limit < 0 OR p_context_faq_limit > 100) THEN
    RAISE EXCEPTION '上下文 FAQ 条数要在 0 到 100 之间';
  END IF;
  IF p_history_turns IS NOT NULL AND (p_history_turns < 0 OR p_history_turns > 8) THEN
    RAISE EXCEPTION '历史轮数要在 0 到 8 之间';
  END IF;
  IF p_timeout_ms IS NOT NULL AND (p_timeout_ms < 5000 OR p_timeout_ms > 120000) THEN
    RAISE EXCEPTION '超时要在 5000 到 120000 毫秒之间';
  END IF;
  UPDATE public.faq_settings
     SET ai_enabled        = COALESCE(p_ai_enabled, false),
         ai_model          = COALESCE(p_ai_model, ''),
         ai_prompt         = COALESCE(p_ai_prompt, ai_prompt),
         welcome           = COALESCE(NULLIF(trim(p_welcome), ''), welcome),
         daily_limit       = COALESCE(p_daily_limit, daily_limit),
         temperature       = COALESCE(p_temperature, temperature),
         max_tokens        = COALESCE(p_max_tokens, max_tokens),
         context_faq_limit = COALESCE(p_context_faq_limit, context_faq_limit),
         history_turns     = COALESCE(p_history_turns, history_turns),
         timeout_ms        = COALESCE(p_timeout_ms, timeout_ms),
         updated_at        = now()
   WHERE id = 1;
  RETURN FOUND;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.admin_update_faq_settings(boolean, text, text, text, integer, numeric, integer, integer, integer, integer) TO authenticated;

-- ---------- 11. 灰度开关 ----------
INSERT INTO public.feature_flags (flag_key, label, description, enabled, sort_order)
VALUES ('ai_support', 'AI 智能客服', '小程序内智能客服页：FAQ 固定回答 + AI 兜底 + 转人工工单', false, 240)
ON CONFLICT (flag_key) DO NOTHING;
