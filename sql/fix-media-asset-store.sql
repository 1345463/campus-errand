-- 证件/订单图片改用 PostgreSQL 存取（绕开对象存储的读故障）
-- 应用：wbapp_yPJnSvicojPmz998PjKfpM
--
-- 背景：小程序端把图片 PUT 进对象存储后，写是成功的（storage.objects 里行、字节数都对），
-- 但任何读通道（object/sign、object/{bucket}/{path}、object/info、SDK 自带实现）
-- 全部返回 404 STORAGE_OBJECT_NOT_FOUND —— 桶找得到、对象行也在，实体字节取不回来。
-- 已排除：请求头与 SDK 完全一致、键形式与 storage.objects.name 完全一致、签名 TTL 合法。
-- 怀疑与该后端的 S3 分片写入有关（storage.objects.version 落库为空串）。
--
-- 因此图片改存库：数据库这一层在本项目里已反复验证可靠，且不受 URL 路径编码影响。
-- 前端只需保证 uploadImage() 仍返回一个字符串路径，展示层按前缀分派：
--   asset:<id>  → 走 get_media_asset
--   其它        → 兼容旧的对象存储路径（旧数据仍尝试原通道）
--
-- 执行方式：mode=migrate，单条执行（工具一次一条语句），按 SQL-1 … SQL-6 顺序各执行一次。
--
-- 【执行状态】SQL-1 ~ SQL-6 已于 2026-10-15 全部执行成功。
-- 【验证】已用探针函数在 SQL 侧模拟三种身份，权限判定全部正确：
--   本人读自己 → 1 行；陌生人读 → 0 行；管理员读他人 → 1 行。
--   大体积：入参 400000 字符（≈300KB 图）与 1200000 字符（≈900KB 图）均正常入库。
--   探针函数已 DROP，media_assets 表当前 0 行。

-- SQL-1：建表
CREATE TABLE IF NOT EXISTS public.media_assets (
  id bigserial PRIMARY KEY,
  owner_id text NOT NULL,
  scope text NOT NULL DEFAULT 'file',
  mime text NOT NULL DEFAULT 'image/jpeg',
  byte_size integer NOT NULL DEFAULT 0,
  data text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- SQL-2：开 RLS（且不建任何策略 = 客户端无法直接读写，只能经下面的 SECURITY DEFINER 函数）
ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;

-- SQL-3：索引 + 收回直连权限
CREATE INDEX IF NOT EXISTS media_assets_owner_idx ON public.media_assets (owner_id, created_at DESC);

-- SQL-4：保存（调用者身份来自 JWT，owner_id 由服务端决定，客户端伪造不了）
CREATE OR REPLACE FUNCTION public.save_media_asset(p_scope text, p_mime text, p_data text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_id bigint;
  v_mime text := COALESCE(NULLIF(p_mime, ''), 'image/jpeg');
  v_scope text := COALESCE(NULLIF(p_scope, ''), 'file');
  v_len integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_data IS NULL OR length(p_data) < 24 THEN
    RAISE EXCEPTION '图片内容为空，请重新选择';
  END IF;

  v_len := length(p_data);
  IF v_len > 2600000 THEN
    RAISE EXCEPTION '图片约 % KB，超过上限，请换一张更小的', (v_len * 3 / 4 / 1024);
  END IF;

  IF v_mime NOT IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif') THEN
    v_mime := 'image/jpeg';
  END IF;
  IF length(v_scope) > 24 THEN
    v_scope := left(v_scope, 24);
  END IF;

  INSERT INTO public.media_assets (owner_id, scope, mime, byte_size, data)
  VALUES (v_uid, v_scope, v_mime, (v_len * 3) / 4, p_data)
  RETURNING media_assets.id INTO v_id;

  RETURN v_id;
END;
$fn$;

-- SQL-5：读取（只有本人或管理员能取到字节）
CREATE OR REPLACE FUNCTION public.get_media_asset(p_id bigint)
RETURNS TABLE(id bigint, mime text, data text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_admin boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT COALESCE(pf.is_admin, false) INTO v_admin
    FROM public.profiles pf
   WHERE pf.owner_id = v_uid
   LIMIT 1;

  RETURN QUERY
  SELECT ma.id, ma.mime, ma.data
    FROM public.media_assets ma
   WHERE ma.id = p_id
     AND (ma.owner_id = v_uid OR COALESCE(v_admin, false));
END;
$fn$;

-- SQL-6：收回直连权限（函数是 SECURITY DEFINER，不受影响）
REVOKE ALL ON public.media_assets FROM PUBLIC, anon, authenticated;
