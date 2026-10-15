-- ============================================================
-- 首页轮播（banners）+ 消息中心（messages）
-- 应用：wbapp_yPJnSvicojPmz998PjKfpM
--
-- 轮播：
--   图片复用 media_assets（asset:<id>），但 get_media_asset 要求登录且限本人/管理员，
--   游客看不了 —— 所以另外开一个 get_public_asset()，只放行 scope='banner' 的资产。
--   这样既让首页轮播对所有人可见，又不放开其它人的证件照。
--   后台上传轮播图时 scope 传 'banner'。
--
-- 消息中心：
--   之前所有状态变更（接单/送达/确认/报价/举报结果）都只能靠用户自己刷页面才知道。
--   现在由服务端在对应 RPC 里直接写一条 messages，用户进消息中心就能看到。
--   消息只有收件人自己能读（RLS + 函数内按 auth.uid() 过滤）。
--
-- 执行方式：mode=migrate，按 SQL-1 … SQL-14 顺序各执行一次。
-- ============================================================

-- SQL-1：轮播表
CREATE TABLE IF NOT EXISTS public.banners (
  id bigserial PRIMARY KEY,
  title text NOT NULL DEFAULT '',
  image_path text NOT NULL,
  link_type text NOT NULL DEFAULT 'none',
  link_value text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT false,
  start_at timestamp with time zone,
  end_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.banners IS '首页轮播广告位：后台配图与跳转，受灰度开关 home_banner 控制';

-- SQL-2：RLS + 收回直连权限
ALTER TABLE public.banners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.banners FROM PUBLIC, anon, authenticated;

-- SQL-3：公开读取轮播。不校验登录：首页是游客也能进的页面。
CREATE OR REPLACE FUNCTION public.list_banners()
RETURNS TABLE (
  id bigint,
  title text,
  image_path text,
  link_type text,
  link_value text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  RETURN QUERY
    SELECT b.id, b.title, b.image_path, b.link_type, b.link_value
      FROM public.banners b
     WHERE b.enabled
       AND (b.start_at IS NULL OR b.start_at <= now())
       AND (b.end_at IS NULL OR b.end_at >= now())
     ORDER BY b.sort_order, b.id;
END;
$fn$;

-- SQL-4：管理员读取全部轮播（含已停用的）
CREATE OR REPLACE FUNCTION public.admin_list_banners()
RETURNS SETOF public.banners
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT public.admin_has_perm('super') THEN
    RAISE EXCEPTION '只有超级管理员可以管理轮播';
  END IF;

  RETURN QUERY
    SELECT b.* FROM public.banners b
     ORDER BY b.sort_order, b.created_at DESC, b.id;
END;
$fn$;

-- SQL-5：新增轮播
CREATE OR REPLACE FUNCTION public.admin_create_banner(
  p_title text,
  p_image_path text,
  p_link_type text,
  p_link_value text,
  p_sort_order integer
) RETURNS SETOF public.banners
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_image text := btrim(COALESCE(p_image_path, ''));
  v_type text := COALESCE(NULLIF(btrim(COALESCE(p_link_type, '')), ''), 'none');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT public.admin_has_perm('super') THEN
    RAISE EXCEPTION '只有超级管理员可以管理轮播';
  END IF;
  IF v_image = '' THEN RAISE EXCEPTION '请先上传轮播图片'; END IF;
  IF v_type NOT IN ('none', 'service', 'url') THEN
    RAISE EXCEPTION '未知的跳转类型：%', v_type;
  END IF;

  RETURN QUERY
    INSERT INTO public.banners (title, image_path, link_type, link_value, sort_order, enabled)
      VALUES (
        btrim(COALESCE(p_title, '')),
        v_image,
        v_type,
        btrim(COALESCE(p_link_value, '')),
        COALESCE(p_sort_order, 0),
        false
      )
    RETURNING *;
END;
$fn$;

-- SQL-6：改轮播（NULL = 不动这一项）。上/下架、改标题、改跳转、改排序都走这里。
CREATE OR REPLACE FUNCTION public.admin_update_banner(
  p_id bigint,
  p_title text,
  p_image_path text,
  p_link_type text,
  p_link_value text,
  p_sort_order integer,
  p_enabled boolean
) RETURNS SETOF public.banners
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT public.admin_has_perm('super') THEN
    RAISE EXCEPTION '只有超级管理员可以管理轮播';
  END IF;
  IF p_id IS NULL THEN RAISE EXCEPTION '缺少轮播编号'; END IF;

  UPDATE public.banners b
     SET title       = COALESCE(NULLIF(btrim(COALESCE(p_title, '')), ''), b.title),
         image_path  = COALESCE(NULLIF(btrim(COALESCE(p_image_path, '')), ''), b.image_path),
         link_type   = COALESCE(NULLIF(btrim(COALESCE(p_link_type, '')), ''), b.link_type),
         link_value = COALESCE(p_link_value, b.link_value),
         sort_order  = COALESCE(p_sort_order, b.sort_order),
         enabled     = COALESCE(p_enabled, b.enabled),
         updated_at  = now()
   WHERE b.id = p_id;

  IF NOT FOUND THEN RAISE EXCEPTION '轮播不存在：%', p_id; END IF;

  RETURN QUERY SELECT * FROM public.banners WHERE id = p_id;
END;
$fn$;

-- SQL-7：删除轮播（真删——轮播是运营素材，没有历史订单引用它）
CREATE OR REPLACE FUNCTION public.admin_delete_banner(p_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT public.admin_has_perm('super') THEN
    RAISE EXCEPTION '只有超级管理员可以管理轮播';
  END IF;
  IF p_id IS NULL THEN RAISE EXCEPTION '缺少轮播编号'; END IF;

  DELETE FROM public.banners b WHERE b.id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION '轮播不存在：%', p_id; END IF;

  RETURN 'deleted';
END;
$fn$;

-- SQL-8：读取公开图片资产（目前只放行 scope='banner'）。
-- 与 get_media_asset 分开是为了不动已有证件照的权限判定，避免回归风险。
CREATE OR REPLACE FUNCTION public.get_public_asset(p_id bigint)
RETURNS TABLE (id bigint, mime text, data text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF p_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
    SELECT ma.id, ma.mime, ma.data
      FROM public.media_assets ma
     WHERE ma.id = p_id
       AND ma.scope = 'banner';
END;
$fn$;

-- ============================================================
-- 消息中心
-- ============================================================

-- SQL-9：消息表
CREATE TABLE IF NOT EXISTS public.messages (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  kind text NOT NULL DEFAULT 'system',
  title text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  ref_type text NOT NULL DEFAULT '',
  ref_id bigint,
  read_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.messages IS '站内消息：订单状态变更与后台处理结果通知';

-- SQL-10：RLS + 收回直连权限
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.messages FROM PUBLIC, anon, authenticated;

-- SQL-11：索引（按人倒序取消息 + 未读数）
CREATE INDEX IF NOT EXISTS messages_user_idx ON public.messages (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_unread_idx ON public.messages (user_id) WHERE read_at IS NULL;

-- SQL-12：写消息。只给服务端内部调用，所以不对外开放任何权限校验，
-- 但仍要防住「给自己之外的人乱发」——这里不做限制，就是让业务函数决定收件人。
CREATE OR REPLACE FUNCTION public.push_message(
  p_user_id text,
  p_kind text,
  p_title text,
  p_content text,
  p_ref_type text,
  p_ref_id bigint
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_id bigint;
BEGIN
  IF p_user_id IS NULL OR btrim(p_user_id) = '' THEN RETURN NULL; END IF;

  INSERT INTO public.messages (user_id, kind, title, content, ref_type, ref_id)
    VALUES (
      btrim(p_user_id),
      COALESCE(NULLIF(btrim(COALESCE(p_kind, '')), ''), 'system'),
      btrim(COALESCE(p_title, '')),
      btrim(COALESCE(p_content, '')),
      COALESCE(p_ref_type, ''),
      p_ref_id
    )
  RETURNING messages.id INTO v_id;

  RETURN v_id;
END;
$fn$;

-- SQL-13：我的消息（新的在前）。严格按 auth.uid() 过滤，拿不到别人的消息。
CREATE OR REPLACE FUNCTION public.list_my_messages(p_limit integer, p_offset integer)
RETURNS TABLE (
  id bigint,
  kind text,
  title text,
  content text,
  ref_type text,
  ref_id bigint,
  read_at timestamp with time zone,
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
    SELECT m.id, m.kind, m.title, m.content, m.ref_type, m.ref_id, m.read_at, m.created_at
      FROM public.messages m
     WHERE m.user_id = v_uid
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT v_limit OFFSET v_offset;
END;
$fn$;

-- SQL-14：未读数
CREATE OR REPLACE FUNCTION public.unread_message_count()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_count integer := 0;
BEGIN
  IF v_uid IS NULL THEN RETURN 0; END IF;

  SELECT count(*)::integer INTO v_count
    FROM public.messages m
   WHERE m.user_id = v_uid
     AND m.read_at IS NULL;

  RETURN v_count;
END;
$fn$;

-- SQL-15：单条已读 / 全部已读。只影响自己的消息。
CREATE OR REPLACE FUNCTION public.mark_message_read(p_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p_id IS NULL THEN RAISE EXCEPTION '缺少消息编号'; END IF;

  UPDATE public.messages m
     SET read_at = COALESCE(m.read_at, now())
   WHERE m.id = p_id
     AND m.user_id = v_uid;

  IF NOT FOUND THEN RAISE EXCEPTION '消息不存在或不是你的'; END IF;

  RETURN 'read';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.mark_all_messages_read()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  UPDATE public.messages m
     SET read_at = COALESCE(m.read_at, now())
   WHERE m.user_id = v_uid
     AND m.read_at IS NULL;

  RETURN 'read';
END;
$fn$;
