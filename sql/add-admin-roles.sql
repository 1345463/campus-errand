-- ============================================================
-- 管理员分级授权 + 人员查找
-- 应用：wbapp_yPJnSvicojPmz998PjKfpM
--
-- 背景：之前后台只有一个 profiles.is_admin 布尔值 —— 谁拿到口令谁就是全权限管理员。
-- 一旦后台要交给不同的人（客服 / 人事 / 审核 / 相机 / 打印 / 结算），
-- 就必须能**按项**授权，并且「谁授的、什么时候授的」要留痕。
--
-- 权限键（perm_key）：
--   super   超级管理员 —— 隐含全部权限，且唯一能改灰度开关、唯一能授予/收回 super
--   support 客服       —— 处理意见反馈、查阅订单以便处理纠纷
--   hr      人事       —— 人员查找、授权他人（但碰不了 super）
--   review  审核       —— 接单员实名认证审核
--   rental  相机       —— 机型挂牌价、租赁申请报价与生成工单
--   print   打印       —— 打印工单处理
--   settle  结算核查   —— 48 小时未确认的结算申诉判定
--
-- 兼容性：profiles.is_admin 保留为「是否后台人员」的粗判（有任一权限即为 true），
-- 迁移时给所有现存 is_admin=true 的人补一条 super，保证老管理员不掉权限。
--
-- 执行方式：mode=migrate，按 SQL-1 … SQL-9 顺序各执行一次。
-- ============================================================

-- SQL-1：授权表。一行 = 某人拥有某项权限。
CREATE TABLE IF NOT EXISTS public.admin_grants (
  user_id text NOT NULL,
  perm_key text NOT NULL,
  granted_by text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, perm_key)
);
COMMENT ON TABLE public.admin_grants IS '管理员分级授权：一行＝某人拥有某项后台权限；super 隐含全部权限';

-- SQL-2：开 RLS 且不建任何策略 —— 客户端不能直连读写，只能经 SECURITY DEFINER 函数
ALTER TABLE public.admin_grants ENABLE ROW LEVEL SECURITY;

-- SQL-3：收回直连权限
REVOKE ALL ON public.admin_grants FROM PUBLIC, anon, authenticated;

-- SQL-4：索引（按权限反查人员用）
CREATE INDEX IF NOT EXISTS admin_grants_perm_idx ON public.admin_grants (perm_key, user_id);

-- SQL-5：权限判定。所有后台写操作都走它，不在各函数里重复写管理员判断。
-- super 是万能钥匙：拥有 super 的人对任何 p_perm 都返回 true。
CREATE OR REPLACE FUNCTION public.admin_has_perm(p_perm text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_perm text := btrim(COALESCE(p_perm, ''));
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  IF v_perm = '' THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1
      FROM public.admin_grants g
     WHERE g.user_id = v_uid
       AND (g.perm_key = 'super' OR g.perm_key = v_perm)
  );
END;
$fn$;

-- SQL-6：我实际拥有的权限清单。super 展开成全部七项，前端直接拿这个数组判断菜单显示。
CREATE OR REPLACE FUNCTION public.admin_my_perms()
RETURNS TABLE (perm_key text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_super boolean := false;
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.admin_grants g
     WHERE g.user_id = v_uid AND g.perm_key = 'super'
  ) INTO v_super;

  IF v_super THEN
    RETURN QUERY
      SELECT k.k FROM (
        VALUES ('super'), ('support'), ('hr'), ('review'), ('rental'), ('print'), ('settle')
      ) AS k(k);
    RETURN;
  END IF;

  RETURN QUERY
    SELECT g.perm_key
      FROM public.admin_grants g
     WHERE g.user_id = v_uid
     ORDER BY g.perm_key;
END;
$fn$;

-- SQL-7：我能不能给别人授权。只有 super 和 hr 有这个资格，
-- 普通后台人员（比如审核）不能自己去拉人进后台。
CREATE OR REPLACE FUNCTION public.admin_can_grant()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1
      FROM public.admin_grants g
     WHERE g.user_id = v_uid
       AND g.perm_key IN ('super', 'hr')
  );
END;
$fn$;

-- SQL-8：人员查找。
-- 支持按昵称 / 姓名 / 用户 ID / 手机号后几位 / 学号模糊搜；
-- 关键词为空时返回最近注册的人，方便人事直接从上往下挑。
-- 同时带出该人已有的权限清单，授权页不用再发一次请求。
CREATE OR REPLACE FUNCTION public.admin_search_staff(p_keyword text, p_limit integer)
RETURNS TABLE (
  uid text,
  nickname text,
  owner_name text,
  phone text,
  role text,
  cert_status text,
  is_admin boolean,
  perm_keys text[],
  created_at timestamp with time zone
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_can boolean := false;
  v_kw text := btrim(COALESCE(p_keyword, ''));
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.admin_grants g
     WHERE g.user_id = v_uid
       AND g.perm_key IN ('super', 'hr')
  ) INTO v_can;

  IF NOT v_can THEN
    RAISE EXCEPTION '只有超级管理员或人事可以查找人员';
  END IF;

  RETURN QUERY
    SELECT
      p.owner_id                                   AS uid,
      p.nickname                                   AS nickname,
      p.owner_name                                 AS owner_name,
      COALESCE(ad.phone, '')                       AS phone,
      COALESCE(p.role, 'user')                     AS role,
      COALESCE(p.cert_status, 'none')              AS cert_status,
      COALESCE(p.is_admin, false)                  AS is_admin,
      COALESCE(perms.keys, ARRAY[]::text[])        AS perm_keys,
      p.created_at                                 AS created_at
    FROM public.profiles p
    LEFT JOIN LATERAL (
      SELECT a.phone
        FROM public.addresses a
       WHERE a.owner_id = p.owner_id
       ORDER BY a.is_default DESC, a.created_at DESC
       LIMIT 1
    ) ad ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(g.perm_key ORDER BY g.perm_key) AS keys
        FROM public.admin_grants g
       WHERE g.user_id = p.owner_id
    ) perms ON true
    WHERE v_kw = ''
       OR p.owner_id            ILIKE '%' || v_kw || '%'
       OR COALESCE(p.nickname, '')   ILIKE '%' || v_kw || '%'
       OR COALESCE(p.owner_name, '') ILIKE '%' || v_kw || '%'
       OR COALESCE(ad.phone, '')     ILIKE '%' || v_kw || '%'
       OR EXISTS (
            SELECT 1
              FROM public.rental_requests rr
             WHERE rr.owner_id = p.owner_id
               AND COALESCE(rr.student_no, '') ILIKE '%' || v_kw || '%'
          )
       OR EXISTS (
            SELECT 1
              FROM public.runner_applications ra
             WHERE ra.owner_id = p.owner_id
               AND COALESCE(ra.real_name, '') ILIKE '%' || v_kw || '%'
          )
    ORDER BY p.created_at DESC
    LIMIT v_limit;
END;
$fn$;

-- SQL-9：授予 / 收回某项权限。
--
-- 四条硬规则：
--   1) 只有 super 或 hr 能调用；
--   2) super 这一项只有 super 自己能动 —— 防止人事给自己提权；
--   3) perm_key 必须是白名单里的七项之一；
--   4) 不能撤销掉最后一个 super，否则后台再也进不去（自己撤自己也一样拦）。
--
-- 顺带同步 profiles.is_admin：有任一权限就是 true，全收回了才是 false。
CREATE OR REPLACE FUNCTION public.admin_set_perm(
  p_user_id text,
  p_perm_key text,
  p_enabled boolean
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  IF v_perm NOT IN ('super', 'support', 'hr', 'review', 'rental', 'print', 'settle') THEN
    RAISE EXCEPTION '未知的权限：%', v_perm;
  END IF;

  IF v_perm = 'super' AND NOT v_super THEN
    RAISE EXCEPTION '只有超级管理员可以授予或收回超级管理员权限';
  END IF;

  IF v_target = '' THEN
    RAISE EXCEPTION '请先选中要授权的人员';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.owner_id = v_target) THEN
    RAISE EXCEPTION '找不到这个用户（ID：%）', v_target;
  END IF;

  IF v_perm = 'super' AND v_on = false THEN
    SELECT count(*) INTO v_super_count
      FROM public.admin_grants g
     WHERE g.perm_key = 'super';
    IF v_super_count <= 1 THEN
      RAISE EXCEPTION '至少要保留一个超级管理员';
    END IF;
  END IF;

  IF v_on THEN
    INSERT INTO public.admin_grants (user_id, perm_key, granted_by)
      VALUES (v_target, v_perm, v_uid)
      ON CONFLICT (user_id, perm_key) DO NOTHING;
  ELSE
    DELETE FROM public.admin_grants g
   WHERE g.user_id = v_target AND g.perm_key = v_perm;
  END IF;

  UPDATE public.profiles p
     SET is_admin = EXISTS (
       SELECT 1 FROM public.admin_grants g WHERE g.user_id = p.owner_id
     )
   WHERE p.owner_id = v_target;

  RETURN CASE WHEN v_on THEN 'granted' ELSE 'revoked' END;
END;
$fn$;

-- SQL-10：迁移存量管理员。所有现在 is_admin=true 的人补一条 super，
-- 否则分级一上线他们就全掉权限了。重复执行安全。
INSERT INTO public.admin_grants (user_id, perm_key, granted_by)
SELECT p.owner_id, 'super', p.owner_id
  FROM public.profiles p
 WHERE p.is_admin IS TRUE
ON CONFLICT (user_id, perm_key) DO NOTHING;
