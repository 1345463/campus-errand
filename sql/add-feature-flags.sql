-- ============================================================
-- 灰度开关（feature flags）
-- 应用：wbapp_yPJnSvicojPmz998PjKfpM
--
-- 目的：本轮新加的功能全部默认关闭，由超级管理员在后台逐个打开。
-- 任何一个新功能出问题，超管关掉对应开关即可，不必重新发版。
--
-- 设计要点：
--   1) 开关放表里而不是写死在前端 —— 超管改一条记录，所有客户端下次进来就生效；
--   2) 读取**不要求登录**：首页轮播在游客状态下也要能按开关决定是否展示，
--      所以 list_feature_flags() 不做 auth 校验（开关内容本身不敏感）；
--   3) 写入只有 super 能动，且记下 updated_by / updated_at 便于追溯；
--   4) 前端拿不到开关（接口挂了）时**按关闭处理** —— 宁可藏起来，也不要放出未灰度完的功能。
--
-- 执行方式：mode=migrate，按 SQL-1 … SQL-4 顺序各执行一次。
-- ============================================================

-- SQL-1：开关表
CREATE TABLE IF NOT EXISTS public.feature_flags (
  flag_key text PRIMARY KEY,
  label text NOT NULL,
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by text
);
COMMENT ON TABLE public.feature_flags IS '灰度开关：本轮新功能的总闸，默认关闭，由超级管理员逐个放开';

-- SQL-2：开 RLS + 收回直连权限（读写全走函数）
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.feature_flags FROM PUBLIC, anon, authenticated;

-- SQL-3：公开读取全部开关。刻意不校验登录：首页轮播要在游客态生效。
CREATE OR REPLACE FUNCTION public.list_feature_flags()
RETURNS SETOF public.feature_flags
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  RETURN QUERY
    SELECT f.* FROM public.feature_flags f
     ORDER BY f.sort_order, f.flag_key;
END;
$fn$;

-- SQL-4：切换开关。只有超级管理员能调用。
CREATE OR REPLACE FUNCTION public.admin_set_feature_flag(
  p_flag_key text,
  p_enabled boolean
) RETURNS SETOF public.feature_flags
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_key text := btrim(COALESCE(p_flag_key, ''));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  IF NOT public.admin_has_perm('super') THEN
    RAISE EXCEPTION '只有超级管理员可以切换灰度开关';
  END IF;

  IF v_key = '' THEN RAISE EXCEPTION '缺少开关名'; END IF;

  UPDATE public.feature_flags f
     SET enabled = COALESCE(p_enabled, false),
         updated_at = now(),
         updated_by = auth.uid()
   WHERE f.flag_key = v_key;

  IF NOT FOUND THEN RAISE EXCEPTION '开关不存在：%', v_key; END IF;

  RETURN QUERY SELECT * FROM public.feature_flags WHERE flag_key = v_key;
END;
$fn$;

-- SQL-5：灌入本轮全部新功能的开关（重复执行安全，已存在的只更新文案不覆盖状态）
INSERT INTO public.feature_flags (flag_key, label, description, enabled, sort_order) VALUES
  ('home_banner',    '首页广告轮播',   '首页顶部轮播广告位，后台可配图片与跳转',       false, 10),
  ('admin_roles',    '管理员分级授权', '把后台权限拆成客服/人事/审核/相机/打印/结算', false, 20),
  ('staff_search',   '人员查找',       '按昵称/姓名/学号/手机号搜索注册用户',          false, 30),
  ('message_center', '消息中心',       '接单、送达、确认、报价、举报结果统一通知',     false, 40),
  ('order_paging',   '订单分页加载',   '订单列表上拉加载更多，突破 50 条上限',         false, 50),
  ('order_search',  '订单搜索',       '按单号或标题关键字搜索订单',                  false, 60),
  ('hall_filter',    '大厅筛选排序',   '任务大厅按服务类型筛选、按赏金/时间排序',      false, 70),
  ('order_timeline', '订单进度时间轴', '详情页按时间顺序展示订单每个节点',            false, 80),
  ('admin_dashboard','管理员工作台',   '汇总各后台待办数量，一个入口分发',              false, 90),
  ('cert_status',    '认证进度查询',   '查看已提交的接单员实名认证信息与审核状态',      false, 100),
  ('order_review',   '评价与信誉分',   '完成后互评，累积接单员信誉分',                false, 110),
  ('point_records',  '积分流水',       '展示积分的发放与扣减明细',                    false, 120),
  ('point_mall',     '积分商城',       '用积分兑换权益或实物',                        false, 130),
  ('user_feedback',  '意见反馈',       '用户提交建议/投诉，客服后台处理并回复',        false, 140)
ON CONFLICT (flag_key) DO UPDATE
   SET label = EXCLUDED.label,
       description = EXCLUDED.description,
       sort_order = EXCLUDED.sort_order;
