-- Apply LAST, after existing migrations. Additive RPCs avoid PostgREST overload ambiguity.
BEGIN;

CREATE OR REPLACE FUNCTION public.list_my_orders_v2(
  p_mode text DEFAULT 'publish', p_limit integer DEFAULT 20, p_offset integer DEFAULT 0,
  p_status text DEFAULT 'all', p_keyword text DEFAULT ''
) RETURNS SETOF public.orders
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_kw text := btrim(COALESCE(p_keyword, ''));
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF p_mode NOT IN ('publish', 'accept', 'admin') THEN RAISE EXCEPTION '无效的订单模式'; END IF;
  IF p_mode = 'admin' AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.owner_id=v_uid AND p.is_admin) THEN
    RAISE EXCEPTION 'admin only';
  END IF;
  IF p_status NOT IN ('all','pending','accepted','waiting_confirm','done','canceled') THEN
    RAISE EXCEPTION '无效的订单状态';
  END IF;
  RETURN QUERY SELECT o.* FROM public.orders o
    WHERE (p_mode='admin' OR (CASE WHEN p_mode = 'accept' THEN o.runner_id = v_uid ELSE o.owner_id = v_uid END))
      AND (p_mode='admin' OR NOT EXISTS (SELECT 1 FROM public.order_hides h WHERE h.order_id = o.id))
      AND (p_status = 'all' OR o.status = p_status)
      AND (v_kw = '' OR o.id::text = v_kw
        OR strpos(lower(COALESCE(o.title,'')), lower(v_kw)) > 0
        OR strpos(lower(COALESCE(o.description,'')), lower(v_kw)) > 0
        OR strpos(lower(COALESCE(o.service_name,'')), lower(v_kw)) > 0
        OR strpos(lower(COALESCE(o.pickup_addr,'')), lower(v_kw)) > 0
        OR strpos(lower(COALESCE(o.deliver_addr,'')), lower(v_kw)) > 0)
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit,20),1),50)
    OFFSET GREATEST(COALESCE(p_offset,0),0);
END;
$fn$;
REVOKE ALL ON FUNCTION public.list_my_orders_v2(text,integer,integer,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_my_orders_v2(text,integer,integer,text,text) TO authenticated;

-- Server acceptance gate matches hall/detail; atomic UPDATE arbitrates concurrent accepts.
CREATE OR REPLACE FUNCTION public.accept_order(p_order_id bigint)
RETURNS SETOF public.orders LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_uid text := auth.uid(); v_name text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.owner_id = v_uid
    AND (p.cert_status = 'approved' OR p.role = 'runner')) THEN
    RAISE EXCEPTION '请先完成接单员认证';
  END IF;
  SELECT COALESCE(NULLIF(btrim(a.real_name),''), NULLIF(btrim(p.nickname),''),
    NULLIF(btrim(p.owner_name),''), '接单员') INTO v_name
    FROM public.profiles p LEFT JOIN LATERAL (
      SELECT ra.real_name FROM public.runner_applications ra
      WHERE ra.owner_id = v_uid AND ra.status = 'approved'
      ORDER BY ra.created_at DESC LIMIT 1
    ) a ON true WHERE p.owner_id = v_uid LIMIT 1;
  RETURN QUERY UPDATE public.orders o SET runner_id = v_uid, runner_name = v_name,
    status = 'accepted', accepted_at = now()
    WHERE o.id = p_order_id AND o.status = 'pending' AND o.runner_id IS NULL
      AND o.owner_id <> v_uid AND NOT COALESCE(o.takedown,false)
      AND NOT EXISTS (SELECT 1 FROM public.order_hides h WHERE h.order_id = o.id)
    RETURNING o.*;
  -- Existing orders_notify_aiu sends exactly one owner notification.
END;
$fn$;
REVOKE ALL ON FUNCTION public.accept_order(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_order(bigint) TO authenticated;

CREATE TABLE IF NOT EXISTS public.order_abandonments (
  id bigserial PRIMARY KEY, order_id bigint NOT NULL, runner_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.order_abandonments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_abandonments FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.abandon_order(p_order_id bigint)
RETURNS SETOF public.orders LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_uid text := auth.uid(); v_row public.orders;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  UPDATE public.orders o SET status = 'pending', runner_id = NULL, runner_name = NULL,
    accepted_at = NULL, runner_done_at = NULL, deliver_images = ARRAY[]::text[]
    WHERE o.id = p_order_id AND o.runner_id = v_uid AND o.status = 'accepted'
      AND NOT COALESCE(o.takedown,false)
      AND NOT EXISTS (SELECT 1 FROM public.order_hides h WHERE h.order_id = o.id)
    RETURNING o.* INTO v_row;
  IF v_row.id IS NULL THEN RETURN; END IF;
  INSERT INTO public.order_abandonments(order_id,runner_id) VALUES(p_order_id,v_uid);
  PERFORM public.push_message(v_row.owner_id,'order_abandoned','接单员已放弃接单',
    '订单 #' || p_order_id || ' 已重新开放接单，请留意后续进度。','order',p_order_id);
  RETURN NEXT v_row;
END;
$fn$;
REVOKE ALL ON FUNCTION public.abandon_order(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.abandon_order(bigint) TO authenticated;

-- Account quota ledger: reserve before call, count completed answers, release failures.
-- This governs this client's RPC path. Strict provider-cost enforcement additionally
-- requires routing ALL model requests through a trusted server gateway (see release notes).
CREATE TABLE IF NOT EXISTS public.support_ai_requests (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  user_id text NOT NULL, usage_day date NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','success','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_ai_requests_user_day ON public.support_ai_requests(user_id,usage_day);
ALTER TABLE public.support_ai_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.support_ai_requests FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.support_ai_usage()
RETURNS TABLE(used integer,daily_limit integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AI 提问请先登录'; END IF;
  RETURN QUERY SELECT count(*)::integer,
    (SELECT f.daily_limit FROM public.faq_settings f WHERE f.id=1)
    FROM public.support_ai_requests r
    WHERE r.user_id=v_uid AND r.usage_day=(now() AT TIME ZONE 'Asia/Singapore')::date
      AND (r.state='success' OR (r.state='pending' AND r.created_at>now()-interval '130 seconds'));
END;
$fn$;

CREATE OR REPLACE FUNCTION public.begin_support_ai()
RETURNS TABLE(request_id text,used integer,daily_limit integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_uid text := auth.uid(); v_limit integer; v_used integer; v_id text;
  v_day date := (now() AT TIME ZONE 'Asia/Singapore')::date;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AI 提问请先登录'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags f WHERE f.flag_key='ai_support' AND f.enabled) THEN
    RAISE EXCEPTION '智能客服暂未开放';
  END IF;
  SELECT f.daily_limit INTO v_limit FROM public.faq_settings f
    WHERE f.id=1 AND f.ai_enabled AND btrim(f.ai_model)<>'';
  IF v_limit IS NULL THEN RAISE EXCEPTION 'AI 暂未开启'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('support:' || v_uid,0));
  SELECT count(*)::integer INTO v_used FROM public.support_ai_requests r
    WHERE r.user_id=v_uid AND r.usage_day=v_day
      AND (r.state='success' OR (r.state='pending' AND r.created_at>now()-interval '130 seconds'));
  IF v_used>=v_limit THEN RAISE EXCEPTION '今日 AI 提问次数已用完，可以转人工'; END IF;
  INSERT INTO public.support_ai_requests(user_id,usage_day) VALUES(v_uid,v_day) RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id,v_used+1,v_limit;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.finish_support_ai(p_request_id text,p_success boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  UPDATE public.support_ai_requests r
    SET state=CASE WHEN p_success AND r.created_at>now()-interval '130 seconds' THEN 'success' ELSE 'failed' END
    WHERE r.id=p_request_id AND r.user_id=auth.uid() AND r.state='pending';
END;
$fn$;

CREATE TABLE IF NOT EXISTS public.support_answer_ratings (
  user_id text NOT NULL, answer_key text NOT NULL, helpful boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,answer_key)
);
ALTER TABLE public.support_answer_ratings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.support_answer_ratings FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE FUNCTION public.rate_support_answer(p_request_id text,p_faq_id bigint,p_helpful boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_uid text := auth.uid(); v_key text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '反馈前请先登录'; END IF;
  IF NULLIF(p_request_id,'') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.support_ai_requests r WHERE r.id=p_request_id AND r.user_id=v_uid AND r.state='success') THEN
      RAISE EXCEPTION '回答不存在';
    END IF;
    v_key := 'ai:' || p_request_id;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.faq_items f WHERE f.id=p_faq_id AND f.enabled) THEN RAISE EXCEPTION '常见问题不存在'; END IF;
    v_key := 'faq:' || p_faq_id;
  END IF;
  INSERT INTO public.support_answer_ratings(user_id,answer_key,helpful) VALUES(v_uid,v_key,p_helpful)
    ON CONFLICT(user_id,answer_key) DO UPDATE SET helpful=EXCLUDED.helpful;
END;
$fn$;
REVOKE ALL ON FUNCTION public.support_ai_usage() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.begin_support_ai() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finish_support_ai(text,boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rate_support_answer(text,bigint,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.support_ai_usage(), public.begin_support_ai(),
  public.finish_support_ai(text,boolean), public.rate_support_answer(text,bigint,boolean) TO authenticated;
COMMIT;
