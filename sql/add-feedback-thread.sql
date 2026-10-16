-- ============================================================
-- 意见反馈：受理 + 双向后期跟进对话（客服工单）
-- 一个工单 = 一条 user_feedbacks，受理后双方可以在 feedback_replies 里来回说话。
-- 会话/回复全部走 SECURITY DEFINER 函数，表本身禁用 RLS 直连。
-- ============================================================

-- ---------- 1. 对话表 ----------
CREATE TABLE IF NOT EXISTS public.feedback_replies (
  id bigserial PRIMARY KEY,
  feedback_id bigint NOT NULL REFERENCES public.user_feedbacks (id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role text NOT NULL DEFAULT 'user',          -- 'user' 提交人 / 'admin' 客服
  content text NOT NULL DEFAULT '',
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_replies_fb_idx
  ON public.feedback_replies (feedback_id, id);

ALTER TABLE public.feedback_replies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.feedback_replies FROM PUBLIC, anon, authenticated;

-- ---------- 2. 工单上的「已读水位」 ----------
-- user_seen_at：提交人最后一次打开会话的时间；admin_seen_at：客服侧同理。
-- 未读数 = 对方角色在这两个时间点之后写下的回复数。
ALTER TABLE public.user_feedbacks ADD COLUMN IF NOT EXISTS user_seen_at timestamp with time zone;
ALTER TABLE public.user_feedbacks ADD COLUMN IF NOT EXISTS admin_seen_at timestamp with time zone;

COMMENT ON COLUMN public.user_feedbacks.user_seen_at IS '提交人最后一次查看会话的时间，用于算用户侧未读';
COMMENT ON COLUMN public.user_feedbacks.admin_seen_at IS '客服最后一次查看会话的时间，用于算客服侧未读';

-- ---------- 3. 辅助：本客服是否在岗 ----------
CREATE OR REPLACE FUNCTION public.admin_has_support_perm()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT public.admin_has_perm('support');
$fn$;

GRANT EXECUTE ON FUNCTION public.admin_has_support_perm() TO authenticated, anon;

-- ---------- 4. 列表：管理端（增加对话摘要与未读） ----------
-- 注意：改返回类型必须先把老函数 DROP 掉，否则报 42P13「cannot change return type」。
DROP FUNCTION IF EXISTS public.admin_list_user_feedbacks(text, integer);

CREATE FUNCTION public.admin_list_user_feedbacks(p_status text, p_limit integer)
RETURNS TABLE (
  id bigint,
  user_id text,
  kind text,
  content text,
  contact text,
  status text,
  admin_note text,
  handled_at timestamp with time zone,
  handled_by text,
  created_at timestamp with time zone,
  reply_count bigint,
  unread_count bigint,
  last_reply_at timestamp with time zone,
  last_role text,
  last_preview text
)
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
    SELECT f.id, f.user_id, f.kind, f.content, f.contact, f.status,
           f.admin_note, f.handled_at, f.handled_by, f.created_at,
           (SELECT count(*) FROM public.feedback_replies r WHERE r.feedback_id = f.id),
           (SELECT count(*) FROM public.feedback_replies r
             WHERE r.feedback_id = f.id
               AND r.role = 'user'
               AND r.created_at > COALESCE(f.admin_seen_at, TIMESTAMPTZ '-infinity')),
           (SELECT max(r.created_at) FROM public.feedback_replies r WHERE r.feedback_id = f.id),
           (SELECT r.role FROM public.feedback_replies r
             WHERE r.feedback_id = f.id ORDER BY r.id DESC LIMIT 1),
           (SELECT left(r.content, 40) FROM public.feedback_replies r
             WHERE r.feedback_id = f.id ORDER BY r.id DESC LIMIT 1)
      FROM public.user_feedbacks f
     WHERE (COALESCE(NULLIF(btrim(COALESCE(p_status, '')), ''), 'all') = 'all' OR f.status = p_status)
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT v_limit;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.admin_list_user_feedbacks(text, integer) TO authenticated;

-- ---------- 5. 列表：提交人自己的（同样带未读） ----------
DROP FUNCTION IF EXISTS public.list_my_feedbacks(integer);

CREATE FUNCTION public.list_my_feedbacks(p_limit integer)
RETURNS TABLE (
  id bigint,
  kind text,
  content text,
  contact text,
  status text,
  admin_note text,
  created_at timestamp with time zone,
  handled_at timestamp with time zone,
  reply_count bigint,
  unread_count bigint,
  last_reply_at timestamp with time zone,
  last_role text,
  last_preview text
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
    SELECT f.id, f.kind, f.content, f.contact, f.status, f.admin_note,
           f.created_at, f.handled_at,
           (SELECT count(*) FROM public.feedback_replies r WHERE r.feedback_id = f.id),
           (SELECT count(*) FROM public.feedback_replies r
             WHERE r.feedback_id = f.id
               AND r.role = 'admin'
               AND r.created_at > COALESCE(f.user_seen_at, TIMESTAMPTZ '-infinity')),
           (SELECT max(r.created_at) FROM public.feedback_replies r WHERE r.feedback_id = f.id),
           (SELECT r.role FROM public.feedback_replies r
             WHERE r.feedback_id = f.id ORDER BY r.id DESC LIMIT 1),
           (SELECT left(r.content, 40) FROM public.feedback_replies r
             WHERE r.feedback_id = f.id ORDER BY r.id DESC LIMIT 1)
      FROM public.user_feedbacks f
     WHERE f.user_id = v_uid
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT v_limit;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.list_my_feedbacks(integer) TO authenticated;

-- ---------- 6. 会话详情（工单头） ----------
-- 双方共用这一个接口：服务端按 support 权限或 owner_id 决定能不能看。
CREATE OR REPLACE FUNCTION public.feedback_detail(p_feedback_id bigint)
RETURNS TABLE (
  id bigint,
  kind text,
  content text,
  contact text,
  status text,
  admin_note text,
  created_at timestamp with time zone,
  handled_at timestamp with time zone,
  author_name text,
  author_id text,
  is_admin boolean,
  can_reply boolean,
  close_hint text,
  unread_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_row public.user_feedbacks;
  v_admin boolean := false;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT * INTO v_row FROM public.user_feedbacks f WHERE f.id = p_feedback_id;
  IF v_row.id IS NULL THEN RAISE EXCEPTION '这条反馈不存在'; END IF;

  BEGIN
    v_admin := public.admin_has_perm('support');
  EXCEPTION WHEN OTHERS THEN
    v_admin := false;
  END;

  IF NOT v_admin AND v_row.user_id <> v_uid THEN
    RAISE EXCEPTION '这条反馈不是你提交的';
  END IF;

  RETURN QUERY
    SELECT f.id, f.kind, f.content, f.contact, f.status, f.admin_note,
           f.created_at, f.handled_at,
           COALESCE(NULLIF(btrim(p.nickname), ''), NULLIF(btrim(p.owner_name), ''), '同学'),
           f.user_id,
           v_admin,
           -- 对话只有在「已受理」时才双向开放
           (f.status = 'resolved'),
           CASE f.status
             WHEN 'pending'  THEN '客服还没受理，受理之后可以在这里继续沟通'
             WHEN 'rejected' THEN '这条已经驳回，如需再沟通请让客服重新受理'
             ELSE ''
           END,
           (SELECT count(*) FROM public.feedback_replies r
             WHERE r.feedback_id = f.id
               AND r.role = CASE WHEN v_admin THEN 'user' ELSE 'admin' END
               AND r.created_at > COALESCE(
                     CASE WHEN v_admin THEN f.admin_seen_at ELSE f.user_seen_at END,
                     TIMESTAMPTZ '-infinity'))
      FROM public.user_feedbacks f
      LEFT JOIN public.profiles p ON p.owner_id = f.user_id
     WHERE f.id = p_feedback_id
     LIMIT 1;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.feedback_detail(bigint) TO authenticated;

-- ---------- 7. 会话消息 ----------
CREATE OR REPLACE FUNCTION public.feedback_thread(p_feedback_id bigint, p_limit integer)
RETURNS TABLE (
  id bigint,
  role text,
  content text,
  created_at timestamp with time zone,
  author text,
  mine boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_row public.user_feedbacks;
  v_admin boolean := false;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 300);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT * INTO v_row FROM public.user_feedbacks f WHERE f.id = p_feedback_id;
  IF v_row.id IS NULL THEN RAISE EXCEPTION '这条反馈不存在'; END IF;

  BEGIN
    v_admin := public.admin_has_perm('support');
  EXCEPTION WHEN OTHERS THEN
    v_admin := false;
  END;

  IF NOT v_admin AND v_row.user_id <> v_uid THEN
    RAISE EXCEPTION '这条反馈不是你提交的';
  END IF;

  RETURN QUERY
    SELECT r.id, r.role, r.content, r.created_at,
           COALESCE(NULLIF(btrim(p.nickname), ''), NULLIF(btrim(p.owner_name), ''),
                    CASE WHEN r.role = 'admin' THEN '客服' ELSE '同学' END),
           (r.user_id = v_uid)
      FROM public.feedback_replies r
      LEFT JOIN public.profiles p ON p.owner_id = r.user_id
     WHERE r.feedback_id = p_feedback_id
     ORDER BY r.id ASC
     LIMIT v_limit;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.feedback_thread(bigint, integer) TO authenticated;

-- ---------- 8. 标记为已读 ----------
CREATE OR REPLACE FUNCTION public.feedback_mark_read(p_feedback_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_row public.user_feedbacks;
  v_admin boolean := false;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT * INTO v_row FROM public.user_feedbacks f WHERE f.id = p_feedback_id;
  IF v_row.id IS NULL THEN RETURN false; END IF;

  BEGIN
    v_admin := public.admin_has_perm('support');
  EXCEPTION WHEN OTHERS THEN
    v_admin := false;
  END;

  IF v_admin THEN
    UPDATE public.user_feedbacks SET admin_seen_at = now() WHERE id = p_feedback_id;
  ELSIF v_row.user_id = v_uid THEN
    UPDATE public.user_feedbacks SET user_seen_at = now() WHERE id = p_feedback_id;
  ELSE
    RAISE EXCEPTION '这条反馈不是你提交的';
  END IF;

  RETURN true;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.feedback_mark_read(bigint) TO authenticated;

-- ---------- 9. 发言 ----------
-- 客服在「待处理」状态下的第一条回复 = 受理（顺带把状态改成 resolved 并通知提交人）；
-- 提交人只能在「已受理」之后追评，避免未受理就刷屏。
CREATE OR REPLACE FUNCTION public.feedback_reply(p_feedback_id bigint, p_content text)
RETURNS SETOF public.feedback_replies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_row public.user_feedbacks;
  v_admin boolean := false;
  v_text text := btrim(COALESCE(p_content, ''));
  v_target text;
  v_id bigint;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF v_text = '' THEN RAISE EXCEPTION '回复内容不能为空'; END IF;
  IF char_length(v_text) > 500 THEN RAISE EXCEPTION '一条回复最多 500 字'; END IF;

  -- 灰度开关把关：关掉时整个会话通道一并停用
  IF NOT COALESCE((SELECT f.enabled FROM public.feature_flags f WHERE f.flag_key = 'user_feedback'), false) THEN
    RAISE EXCEPTION '意见反馈功能当前未开放';
  END IF;

  -- 这里刻意不加 FOR UPDATE 行锁：工单对话没有强一致要求，而 RLS 环境下
  -- 「SELECT ... FOR UPDATE」在某些权限组合下会直接报 permission denied，
  -- 实测就是这样整条函数跑不动。宁可放弃锁，也不能让客服发不出消息。
  SELECT * INTO v_row FROM public.user_feedbacks f WHERE f.id = p_feedback_id;
  IF v_row.id IS NULL THEN RAISE EXCEPTION '这条反馈不存在'; END IF;

  BEGIN
    v_admin := public.admin_has_perm('support');
  EXCEPTION WHEN OTHERS THEN
    v_admin := false;
  END;

  IF NOT v_admin AND v_row.user_id <> v_uid THEN
    RAISE EXCEPTION '这条反馈不是你提交的';
  END IF;

  IF v_admin THEN
    IF v_row.status = 'pending' THEN
      -- 第一次回复即受理
      UPDATE public.user_feedbacks
         SET status = 'resolved', handled_at = now(), handled_by = v_uid
       WHERE id = p_feedback_id;
      PERFORM public.push_message(v_row.user_id, 'feedback_handled', '反馈已受理',
        '你提交的反馈我们已受理并开始跟进：' || left(v_text, 60), 'feedback', p_feedback_id);
    ELSIF v_row.status = 'rejected' THEN
      RAISE EXCEPTION '这条反馈已驳回，请先在会话页点「重新受理」';
    END IF;
    PERFORM public.push_message(v_row.user_id, 'feedback_reply', '客服回复了你',
      left(v_text, 80), 'feedback', p_feedback_id);
  ELSE
    IF v_row.status = 'pending' THEN
      RAISE EXCEPTION '客服还没受理，受理后才能继续沟通';
    ELSIF v_row.status = 'rejected' THEN
      RAISE EXCEPTION '这条反馈已驳回，如需沟通请重新提交';
    END IF;
    -- 提交人追评：广播给所有在线坐席（客服 / 超管）
    FOR v_target IN
      SELECT DISTINCT g.user_id FROM public.admin_grants g
       WHERE g.perm_key IN ('support', 'super')
      UNION
      SELECT DISTINCT p.owner_id FROM public.profiles p
       WHERE p.is_admin IS TRUE
         AND p.owner_id IS NOT NULL
         AND btrim(p.owner_id) <> ''
    LOOP
      PERFORM public.push_message(v_target, 'feedback_reply', '同学追问了反馈',
        '工单 #' || p_feedback_id || '：' || left(v_text, 60), 'feedback', p_feedback_id);
    END LOOP;
  END IF;

  INSERT INTO public.feedback_replies (feedback_id, user_id, role, content)
    VALUES (p_feedback_id, v_uid, CASE WHEN v_admin THEN 'admin' ELSE 'user' END, v_text)
  RETURNING id INTO v_id;

  RETURN QUERY SELECT * FROM public.feedback_replies WHERE id = v_id;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.feedback_reply(bigint, text) TO authenticated;

-- ---------- 10. 重新受理（驳回后重开会话） ----------
CREATE OR REPLACE FUNCTION public.admin_reopen_feedback(p_feedback_id bigint)
RETURNS SETOF public.user_feedbacks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_row public.user_feedbacks;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT public.admin_has_perm('support') THEN
    RAISE EXCEPTION '只有客服或超级管理员可以受理反馈';
  END IF;

  SELECT * INTO v_row FROM public.user_feedbacks f WHERE f.id = p_feedback_id;
  IF v_row.id IS NULL THEN RAISE EXCEPTION '这条反馈不存在'; END IF;

  UPDATE public.user_feedbacks
     SET status = 'resolved', handled_at = now(), handled_by = v_uid
   WHERE id = p_feedback_id;

  PERFORM public.push_message(v_row.user_id, 'feedback_handled', '反馈已重新受理',
    '客服重新受理了你提交的反馈，现在可以在会话里继续沟通了', 'feedback', p_feedback_id);

  RETURN QUERY SELECT * FROM public.user_feedbacks WHERE id = p_feedback_id;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.admin_reopen_feedback(bigint) TO authenticated;

-- ---------- 11. 提交时把已读水位压到当前时间，避免自己的提交被算成未读 ----------
CREATE OR REPLACE FUNCTION public.submit_user_feedback(p_kind text, p_content text, p_contact text)
RETURNS SETOF public.user_feedbacks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_kind text := COALESCE(NULLIF(btrim(COALESCE(p_kind, '')), ''), 'suggestion');
  v_content text := btrim(COALESCE(p_content, ''));
  v_id bigint;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF v_content = '' THEN RAISE EXCEPTION '请填写反馈内容'; END IF;
  IF char_length(v_content) > 500 THEN RAISE EXCEPTION '反馈内容最多 500 字'; END IF;
  IF v_kind NOT IN ('suggestion', 'complaint', 'bug', 'other') THEN
    RAISE EXCEPTION '未知的反馈类型';
  END IF;

  -- user_seen_at 留空：提交当下还没有任何回复，留到用户真正打开会话再打水位，
  -- 否则 now() 在事务内取同一个值，会让「客服紧接着发来的第一条回复」被判成已读。
  INSERT INTO public.user_feedbacks (user_id, kind, content, contact)
    VALUES (v_uid, v_kind, v_content, left(btrim(COALESCE(p_contact, '')), 60))
  RETURNING id INTO v_id;

  RETURN QUERY SELECT * FROM public.user_feedbacks WHERE id = v_id;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.submit_user_feedback(text, text, text) TO authenticated;
