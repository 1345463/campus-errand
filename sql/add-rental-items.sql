-- 相机租赁：机型与挂牌价搬到数据库，管理员后台可直接改，不必重新发布小程序
-- 应用：wbapp_yPJnSvicojPmz998PjKfpM
--
-- 背景：机型清单原本写死在 utils/services.js 的 RENTAL_ITEMS。
-- 结果就是挂牌价一改就必须改代码 + 重新提审发布 —— 这在要频繁调价的租赁业务里没法用。
-- 改法：清单落到 rental_items 表，客户端只负责读；改价/上下架/新增机型由管理员后台直接操作。
--
-- 权限：表本身开 RLS 并收回所有直连权限（和 orders / moderation_words 一样），
-- 一切读写都经 SECURITY DEFINER 函数：公开读取不用登录（逛租赁页不需要先登录），
-- 写操作一律校验 profiles.is_admin。
--
-- 执行方式：mode=migrate，按 SQL-1 … SQL-8 顺序各执行一次。

-- SQL-1：机型表
CREATE TABLE IF NOT EXISTS public.rental_items (
  id text PRIMARY KEY,
  name text NOT NULL,
  spec text NOT NULL DEFAULT '',
  price numeric NOT NULL DEFAULT 0,
  deposit numeric NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- SQL-2：开启 RLS（不建任何策略 —— 客户端不能直连读写）
ALTER TABLE public.rental_items ENABLE ROW LEVEL SECURITY;

-- SQL-3：收回直连权限
REVOKE ALL ON public.rental_items FROM PUBLIC, anon, authenticated;

-- SQL-4：自增序列号（新增机型时不传 id 时用它生成）
CREATE SEQUENCE IF NOT EXISTS public.rental_item_seq;

-- SQL-5：公开读取机型。刻意不校验登录 —— 浏览租赁页面不该要求先登录。
CREATE OR REPLACE FUNCTION public.list_rental_items()
RETURNS TABLE (id text, name text, spec text, price numeric, deposit numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  RETURN QUERY
    SELECT ri.id, ri.name, ri.spec, ri.price, ri.deposit
      FROM public.rental_items ri
     WHERE ri.enabled
     ORDER BY ri.sort_order, ri.price DESC, ri.name;
END;
$fn$;

-- SQL-6：管理员读取全部机型（含已下架的），附带一个 updated_at 好知道谁什么时候改过价
CREATE OR REPLACE FUNCTION public.admin_list_rental_items()
RETURNS TABLE (
  id text,
  name text,
  spec text,
  price numeric,
  deposit numeric,
  sort_order integer,
  enabled boolean,
  updated_at timestamp with time zone
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_uid text := auth.uid(); DECLARE v_admin boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  SELECT pf.is_admin INTO v_admin FROM public.profiles pf WHERE pf.owner_id = v_uid LIMIT 1;
  IF v_admin IS NOT TRUE THEN RAISE EXCEPTION 'admin only'; END IF;

  RETURN QUERY
    SELECT ri.id, ri.name, ri.spec, ri.price, ri.deposit, ri.sort_order, ri.enabled, ri.updated_at
      FROM public.rental_items ri
     ORDER BY ri.sort_order, ri.created_at, ri.name;
END;
$fn$;

-- SQL-7：改价 / 改押金 / 上下架 / 改名改规格。
-- 传 NULL 表示「这一项不动」，避免为了改价格把机型名重传一遍（打错字就毁了）。
CREATE OR REPLACE FUNCTION public.admin_update_rental_item(
  p_id text,
  p_name text,
  p_spec text,
  p_price numeric,
  p_deposit numeric,
  p_enabled boolean
) RETURNS SETOF public.rental_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_uid text := auth.uid(); DECLARE v_admin boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  SELECT pf.is_admin INTO v_admin FROM public.profiles pf WHERE pf.owner_id = v_uid LIMIT 1;
  IF v_admin IS NOT TRUE THEN RAISE EXCEPTION 'admin only'; END IF;

  IF p_price IS NOT NULL AND p_price < 0 THEN RAISE EXCEPTION '挂牌价不能为负数'; END IF;
  IF p_deposit IS NOT NULL AND p_deposit < 0 THEN RAISE EXCEPTION '押金不能为负数'; END IF;

  UPDATE public.rental_items ri
     SET name = COALESCE(NULLIF(btrim(COALESCE(p_name, '')), ''), ri.name),
         spec = COALESCE(p_spec, ri.spec),
         price = COALESCE(p_price, ri.price),
         deposit = COALESCE(p_deposit, ri.deposit),
         enabled = COALESCE(p_enabled, ri.enabled),
         updated_at = now()
   WHERE ri.id = p_id;

  IF NOT FOUND THEN RAISE EXCEPTION '机型不存在：%', COALESCE(p_id, '(空)'); END IF;

  RETURN QUERY SELECT * FROM public.rental_items WHERE id = p_id;
END;
$fn$;

-- SQL-8：新增机型。id 留空时自动生成 cam1、cam2 …
CREATE OR REPLACE FUNCTION public.admin_create_rental_item(
  p_name text,
  p_spec text,
  p_price numeric,
  p_deposit numeric
) RETURNS SETOF public.rental_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_admin boolean;
  v_id text;
  v_name text := btrim(COALESCE(p_name, ''));
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  SELECT pf.is_admin INTO v_admin FROM public.profiles pf WHERE pf.owner_id = v_uid LIMIT 1;
  IF v_admin IS NOT TRUE THEN RAISE EXCEPTION 'admin only'; END IF;

  IF v_name = '' THEN RAISE EXCEPTION '请填写机型名称'; END IF;
  IF COALESCE(p_price, 0) <= 0 THEN RAISE EXCEPTION '挂牌价必须大于 0'; END IF;
  IF COALESCE(p_deposit, 0) < 0 THEN RAISE EXCEPTION '押金不能为负数'; END IF;

  v_id := 'cam' || nextval('public.rental_item_seq');

  RETURN QUERY INSERT INTO public.rental_items (id, name, spec, price, deposit)
    VALUES (v_id, v_name, COALESCE(p_spec, ''), p_price, COALESCE(p_deposit, 0))
    RETURNING *;
END;
$fn$;

-- SQL-9：把原来写死在 utils/services.js 里的 5 个机型灌进表（重复执行安全）
INSERT INTO public.rental_items (id, name, spec, price, deposit, sort_order) VALUES
  ('pocket4', '大疆 POCKET 4', '一英寸云台相机 · 4K', 29.8, 0, 1),
  ('pocket3', '大疆 POCKET 3', '口袋云台 · Vlog 神器', 19.8, 0, 2),
  ('mini99',  '富士 Mini99',   '拍立得 · 多档滤镜',   15,   0, 3),
  ('wide400', '富士 instax WIDE 400', '宽幅拍立得 · 合影首选', 18, 0, 4),
  ('mini12',  '富士 Mini12',   '入门拍立得 · 上手就会', 12,  0, 5)
ON CONFLICT (id) DO NOTHING;
