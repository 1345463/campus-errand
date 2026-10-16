-- ============================================================================
-- 第六轮：任务大厅独立页 + 楼栋楼层筛选 + 开价下限 + 送达佐证 + 积分券抵扣
--
-- 对应需求：
--   1) 任务大厅单独一页（首页只留入口）—— 前端改动，DB 侧只加灰度开关 hall_page
--   2) 大厅筛选新增楼栋 / 楼层 —— orders 增加结构化楼栋楼层字段 + 索引
--   3) 开价最小 1 元 —— create_order 里硬拦
--   4) 送达必须上传佐证照片 —— orders.deliver_images + complete_order 校验
--   5) 未接单不能看取餐码 / 图片 —— get_order_detail 服务端脱敏
--   6) 积分商城「兑换码使用接口」—— 抵扣券自动抵扣 + 管理员核销 + 商品管理
--
-- 注意：本文件里的函数都是「当前库的最终形态」，用 CREATE OR REPLACE 幂等；
--       create_order 之前是 12 个参数，本轮扩到 17 个。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. orders：结构化楼栋楼层 + 送达佐证 + 券抵扣
-- ---------------------------------------------------------------------------
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS deliver_images text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS pickup_building text NOT NULL DEFAULT '';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS pickup_floor   text NOT NULL DEFAULT '';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS deliver_building text NOT NULL DEFAULT '';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS deliver_floor   text NOT NULL DEFAULT '';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS discount_code   text NOT NULL DEFAULT '';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS discount_amount numeric NOT NULL DEFAULT 0;

-- 大厅按「状态 + 送达楼栋 + 送达楼层」筛，索引顺序和查询顺序保持一致
CREATE INDEX IF NOT EXISTS orders_hall_building_idx
  ON public.orders (status, deliver_building, deliver_floor, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. point_redemptions：券被谁用了、用在哪一单
-- ---------------------------------------------------------------------------
ALTER TABLE public.point_redemptions ADD COLUMN IF NOT EXISTS used_by text;
ALTER TABLE public.point_redemptions ADD COLUMN IF NOT EXISTS order_id bigint;

-- ---------------------------------------------------------------------------
-- 3. point_goods：兑换后「怎么用」
--    deduct 抵扣付款金额（下单时抵赏金，需 deduct_value）
--    verify 管理员核销（后台手动核销兑换码）
--    auto   自动生效（兑换后立刻生效，如置顶卡）
-- ---------------------------------------------------------------------------
ALTER TABLE public.point_goods ADD COLUMN IF NOT EXISTS benefit_type text NOT NULL DEFAULT 'verify';
ALTER TABLE public.point_goods ADD COLUMN IF NOT EXISTS deduct_value numeric NOT NULL DEFAULT 0;

UPDATE public.point_goods SET benefit_type = 'deduct', deduct_value = 2 WHERE id = 'coupon_2';
UPDATE public.point_goods SET benefit_type = 'deduct', deduct_value = 5 WHERE id = 'coupon_5';
UPDATE public.point_goods SET benefit_type = 'auto' WHERE kind = 'boost';

-- ---------------------------------------------------------------------------
-- 4. 灰度开关
-- ---------------------------------------------------------------------------
-- 任务大厅独立页本身**不挂开关**：它是任务列表的唯一入口（首页只留了入口），
-- 关掉等于直接把功能下掉、又没有回滚路径，所以只有下面三个新能力进灰度。
INSERT INTO public.feature_flags (flag_key, label, enabled, sort_order)
VALUES
  ('hall_building_filter',  '大厅楼栋楼层筛选',      true, 190),
  ('coupon_deduct',         '积分券抵扣付款金额',    true, 200),
  ('deliver_photo',         '送达佐证照片',          true, 210)
ON CONFLICT (flag_key) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order;

-- 上一版误插的 hall_page 开关作废（同上原因）
DELETE FROM public.feature_flags WHERE flag_key = 'hall_page';

-- ---------------------------------------------------------------------------
-- 5. create_order：17 参数版本
--    新增 p_pickup_building / p_pickup_floor / p_deliver_building / p_deliver_floor / p_deduct_code
--    · 开价 < 1 元直接拒绝
--    · 抵扣券只能用自己的、未使用的、且商品类型是 deduct 的券
--    · 抵扣只记在订单上，接单员仍拿全额赏金（差价平台承担）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_order(
  p_service_type text,
  p_service_name text,
  p_title text,
  p_description text,
  p_pickup_addr text,
  p_deliver_addr text,
  p_expect_time text,
  p_contact text,
  p_images text[],
  p_tags text[],
  p_gender_limit text,
  p_reward numeric,
  p_pickup_building text,
  p_pickup_floor text,
  p_deliver_building text,
  p_deliver_floor text,
  p_deduct_code text
)
RETURNS SETOF orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_name text;
  v_parts text[];
  v_text text;
  v_hit record;
  v_order_id bigint;
  v_code text := NULLIF(btrim(COALESCE(p_deduct_code, '')), '');
  v_red public.point_redemptions;
  v_discount numeric := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT COALESCE(NULLIF(pf.nickname, ''), NULLIF(pf.owner_name, ''), '同学')
    INTO v_name
    FROM public.profiles pf
   WHERE pf.owner_id = v_uid
   LIMIT 1;

  -- 开价下限：低于 1 元不给发。有人瞎填 0.01 会把大厅刷满垃圾单。
  IF COALESCE(p_reward, 0) < 1 THEN
    RAISE EXCEPTION '赏金最少 1 元';
  END IF;

  -- 抵扣券：只能用自己的、未核销的、且商品本身是「抵扣付款金额」类型。
  -- 抵扣只记在订单上（discount_amount），接单员仍然拿全额赏金，差价由平台承担，
  -- 否则会出现「发布方用了券、接单员少拿钱」的扯皮。
  IF v_code IS NOT NULL THEN
    SELECT r.* INTO v_red
      FROM public.point_redemptions r
      JOIN public.point_goods g ON g.id = r.goods_id
     WHERE r.code = v_code
       AND r.user_id = v_uid
       AND r.status = 'unused'
       AND g.benefit_type = 'deduct'
     LIMIT 1;
    IF v_red.id IS NULL THEN
      RAISE EXCEPTION '这张券不能用（不存在、已使用或不是抵扣券）';
    END IF;
    SELECT LEAST(COALESCE(g.deduct_value, 0), p_reward) INTO v_discount
      FROM public.point_goods g WHERE g.id = v_red.goods_id;
  END IF;

  v_parts := ARRAY[
    COALESCE(p_title, ''),
    COALESCE(p_description, ''),
    COALESCE(p_pickup_addr, ''),
    COALESCE(p_deliver_addr, ''),
    COALESCE(p_expect_time, ''),
    COALESCE(p_contact, ''),
    COALESCE(p_service_name, ''),
    COALESCE(array_to_string(p_images, ' '), ''),
    COALESCE(array_to_string(p_tags, ' '), '')
  ];

  FOR v_text IN SELECT unnest(v_parts) LOOP
    SELECT * INTO v_hit FROM public.scan_moderation_words(v_text) LIMIT 1;
    IF v_hit IS NOT NULL AND v_hit.hit_word IS NOT NULL THEN
      RAISE EXCEPTION '内容包含不允许发布的信息（%，命中：%）。请修改后再发布',
        v_hit.hit_category, v_hit.hit_word;
    END IF;
  END LOOP;

  INSERT INTO public.orders (
    owner_id, owner_name, service_type, service_name, title, description,
    pickup_addr, deliver_addr, expect_time, contact, images, tags, gender_limit, reward, status,
    pickup_building, pickup_floor, deliver_building, deliver_floor,
    discount_code, discount_amount
  ) VALUES (
    v_uid,
    v_name,
    COALESCE(NULLIF(p_service_type, ''), 'other'),
    COALESCE(NULLIF(p_service_name, ''), '其它服务'),
    left(COALESCE(p_title, ''), 60),
    left(COALESCE(p_description, ''), 500),
    left(COALESCE(p_pickup_addr, ''), 120),
    left(COALESCE(p_deliver_addr, ''), 120),
    left(COALESCE(p_expect_time, ''), 60),
    left(COALESCE(p_contact, ''), 60),
    COALESCE(p_images, ARRAY[]::text[]),
    COALESCE(p_tags, ARRAY[]::text[]),
    COALESCE(NULLIF(p_gender_limit, ''), '不限'),
    p_reward,
    'pending',
    left(COALESCE(p_pickup_building, ''), 40),
    left(COALESCE(p_pickup_floor, ''), 20),
    left(COALESCE(p_deliver_building, ''), 40),
    left(COALESCE(p_deliver_floor, ''), 20),
    COALESCE(v_code, ''),
    COALESCE(v_discount, 0)
  ) RETURNING orders.id INTO v_order_id;

  IF v_code IS NOT NULL AND v_discount > 0 THEN
    UPDATE public.point_redemptions
       SET status = 'used', used_at = now(), used_by = v_uid, order_id = v_order_id
     WHERE id = v_red.id;
  END IF;

  RETURN QUERY SELECT * FROM public.orders WHERE id = v_order_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. complete_order：送达要带 1-3 张佐证照片（灰度 deliver_photo）
--    · 开关开：必须 1-3 张，发布方确认时才有东西可核对，事后扯皮也有凭据；
--    · 开关关：照片变可选（仍校验 ≤3 张、仍校验格式），给超管一条回滚路径；
--    · 无论开关如何，只认服务端存图路径 asset:<id>，避免有人塞外链绕过存储。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_order(p_order_id bigint, p_images text[])
RETURNS SETOF orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_row public.orders;
  v_imgs text[];
  v_bad text;
  v_need boolean := false;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT EXISTS (SELECT 1 FROM public.feature_flags f WHERE f.flag_key = 'deliver_photo' AND f.enabled)
    INTO v_need;

  v_imgs := ARRAY(
    SELECT DISTINCT x FROM unnest(COALESCE(p_images, ARRAY[]::text[])) AS x
     WHERE COALESCE(btrim(x), '') <> ''
  );
  IF v_need AND COALESCE(array_length(v_imgs, 1), 0) < 1 THEN
    RAISE EXCEPTION '请先上传至少一张送达佐证照片';
  END IF;
  IF COALESCE(array_length(v_imgs, 1), 0) > 3 THEN
    RAISE EXCEPTION '佐证照片最多 3 张';
  END IF;

  -- 只认服务端存图路径 asset:<id>，避免有人塞 http 链接进来绕过存储
  SELECT x INTO v_bad FROM unnest(v_imgs) AS x WHERE x !~ '^asset:[0-9]+$' LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '佐证照片还没传完，请重新上传';
  END IF;

  UPDATE public.orders o
     SET status = 'waiting_confirm',
         runner_done_at = now(),
         deliver_images = v_imgs
   WHERE o.id = p_order_id
     AND o.status = 'accepted'
     AND o.runner_id = v_uid
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN RETURN; END IF;

  PERFORM public.push_message(
    v_row.owner_id,
    'order_done',
    '接单员已标记送达',
    COALESCE(v_row.title, '任务') ||
      CASE WHEN COALESCE(array_length(v_imgs, 1), 0) > 0
           THEN ' 已送达（附 ' || array_length(v_imgs, 1) || ' 张佐证照片），确认无误后赏金会打给对方'
           ELSE ' 已送达，确认无误后赏金会打给对方' END,
    'order',
    v_row.id
  );

  RETURN QUERY SELECT * FROM public.orders WHERE id = v_row.id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. get_order_detail：没接单的人看不到取餐码 / 图片 / 联系方式
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_order_detail(p_order_id bigint)
RETURNS SETOF orders
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_row public.orders;
  v_admin boolean := false;
  v_allow boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT * INTO v_row FROM public.orders o WHERE o.id = p_order_id;
  IF v_row.id IS NULL THEN RETURN; END IF;

  v_allow := (v_row.owner_id = v_uid)
          OR (v_row.runner_id IS NOT NULL AND v_row.runner_id = v_uid);

  IF NOT v_allow THEN
    BEGIN
      v_admin := public.admin_is_any();
    EXCEPTION WHEN OTHERS THEN
      v_admin := false;
    END;
    v_allow := v_admin;
  END IF;

  -- 没接单之前， outsiders 只看得到任务本身，看不到取餐码 / 图片 /
  -- 联系方式这类交付信息；接单后才有资格拿到，避免有人白嫖一趟跑腿。
  IF NOT v_allow THEN
    v_row.images := ARRAY[]::text[];
    v_row.deliver_images := ARRAY[]::text[];
    v_row.contact := '';
  END IF;

  RETURN NEXT v_row;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 8. 积分商城：商品管理 / 积分调整 / 核销（全部 settle 权限，super 隐含通过）
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_list_point_goods()
RETURNS SETOF point_goods
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT public.admin_has_perm('settle') THEN
    RAISE EXCEPTION '只有结算员或超级管理员可以管理积分商城';
  END IF;
  RETURN QUERY SELECT * FROM public.point_goods g ORDER BY g.sort_order, g.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_upsert_point_goods(
  p_id text, p_name text, p_emoji text, p_cost integer, p_stock integer,
  p_descr text, p_benefit_type text, p_deduct_value numeric,
  p_enabled boolean, p_sort_order integer
)
RETURNS SETOF point_goods
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_id text := NULLIF(btrim(COALESCE(p_id, '')), '');
  v_name text := btrim(COALESCE(p_name, ''));
  v_type text := COALESCE(NULLIF(btrim(COALESCE(p_benefit_type, '')), ''), 'verify');
  v_cost integer := COALESCE(p_cost, 0);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT public.admin_has_perm('settle') THEN
    RAISE EXCEPTION '只有结算员或超级管理员可以管理积分商城';
  END IF;

  IF v_name = '' THEN RAISE EXCEPTION '商品名称不能为空'; END IF;
  IF char_length(v_name) > 30 THEN RAISE EXCEPTION '商品名称最多 30 个字'; END IF;
  IF v_cost < 0 THEN RAISE EXCEPTION '积分价格不能为负'; END IF;
  IF v_type NOT IN ('deduct', 'verify', 'auto') THEN
    RAISE EXCEPTION '未知的抵扣方式（可选：抵扣付款金额 / 管理员核销 / 自动生效）';
  END IF;
  IF v_type = 'deduct' AND COALESCE(p_deduct_value, 0) <= 0 THEN
    RAISE EXCEPTION '「抵扣付款金额」类券必须填抵扣面额';
  END IF;

  IF v_id IS NULL THEN
    v_id := 'g' || to_char(now(), 'YYMMDDHH24MISS');
    INSERT INTO public.point_goods (id, name, emoji, cost, stock, descr, benefit_type, deduct_value, enabled, sort_order, kind)
      VALUES (v_id, v_name, COALESCE(NULLIF(btrim(COALESCE(p_emoji, '')), ''), '🎁'), v_cost,
              GREATEST(COALESCE(p_stock, 0), 0), left(COALESCE(p_descr, ''), 120), v_type,
              CASE WHEN v_type = 'deduct' THEN COALESCE(p_deduct_value, 0) ELSE 0 END,
              COALESCE(p_enabled, true), COALESCE(p_sort_order, 100),
              CASE WHEN v_type = 'auto' THEN 'boost' ELSE 'coupon' END)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.point_goods g
       SET name = v_name,
           emoji = COALESCE(NULLIF(btrim(COALESCE(p_emoji, '')), ''), g.emoji),
           cost = v_cost,
           stock = GREATEST(COALESCE(p_stock, 0), 0),
           descr = left(COALESCE(p_descr, g.descr), 120),
           benefit_type = v_type,
           deduct_value = CASE WHEN v_type = 'deduct' THEN COALESCE(p_deduct_value, g.deduct_value) ELSE 0 END,
           enabled = COALESCE(p_enabled, g.enabled),
           sort_order = COALESCE(p_sort_order, g.sort_order),
           kind = CASE WHEN v_type = 'auto' THEN 'boost' ELSE CASE WHEN g.kind = 'boost' THEN 'coupon' ELSE g.kind END END
     WHERE g.id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION '商品不存在（可能已被删除）'; END IF;
  END IF;

  RETURN QUERY SELECT * FROM public.point_goods WHERE id = v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_adjust_points(p_user_id text, p_delta integer, p_remark text)
RETURNS TABLE(user_id text, nickname text, points_before integer, points_after integer, delta integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_target text := NULLIF(btrim(COALESCE(p_user_id, '')), '');
  v_delta integer := COALESCE(p_delta, 0);
  v_remark text := btrim(COALESCE(p_remark, ''));
  v_before integer;
  v_after integer;
  v_nick text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT public.admin_has_perm('settle') THEN
    RAISE EXCEPTION '只有结算员或超级管理员可以调整积分';
  END IF;
  IF v_target IS NULL THEN RAISE EXCEPTION '请选择要调整的同学'; END IF;
  IF v_delta = 0 THEN RAISE EXCEPTION '调整数量不能为 0'; END IF;
  IF abs(v_delta) > 5000 THEN RAISE EXCEPTION '一次最多调整 5000 积分'; END IF;
  IF v_remark = '' THEN RAISE EXCEPTION '请填写调整原因，方便事后对账'; END IF;

  -- 这里不加 FOR UPDATE：RLS 环境下 SELECT ... FOR UPDATE 会报 permission denied
  SELECT COALESCE(p.points, 0),
         COALESCE(NULLIF(btrim(p.nickname), ''), NULLIF(btrim(p.owner_name), ''), '同学')
    INTO v_before, v_nick
    FROM public.profiles p
   WHERE p.owner_id = v_target;

  IF v_nick IS NULL THEN RAISE EXCEPTION '找不到这个同学'; END IF;

  -- 积分不为负：扣到 0 就收口
  v_after := GREATEST(v_before + v_delta, 0);
  UPDATE public.profiles p SET points = v_after WHERE p.owner_id = v_target;

  INSERT INTO public.point_records (user_id, delta, balance, kind, remark)
    VALUES (v_target, v_after - v_before, v_after, 'admin_adjust', v_remark);

  PERFORM public.push_message(
    v_target,
    'point_adjust',
    CASE WHEN v_delta > 0 THEN '积分已增加' ELSE '积分已扣减' END,
    '管理员调整积分 ' || (v_after - v_before) || ' 分（调整后 ' || v_after || ' 分），原因：' || v_remark,
    'point',
    NULL
  );

  RETURN QUERY SELECT v_target, v_nick, v_before, v_after, (v_after - v_before);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_verify_redemption(p_code text)
RETURNS TABLE(code text, goods_name text, nickname text, cost integer, used_at timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_code text := upper(btrim(COALESCE(p_code, '')));
  v_red public.point_redemptions;
  v_goods public.point_goods;
  v_nick text;
  v_now timestamp with time zone := now();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT public.admin_has_perm('settle') THEN
    RAISE EXCEPTION '只有结算员或超级管理员可以核销';
  END IF;
  IF v_code = '' THEN RAISE EXCEPTION '请输入兑换码'; END IF;

  SELECT * INTO v_red FROM public.point_redemptions r WHERE upper(r.code) = v_code LIMIT 1;
  IF v_red.id IS NULL THEN RAISE EXCEPTION '兑换码不存在，请核对后再试'; END IF;
  IF v_red.status = 'used' THEN
    RAISE EXCEPTION '这个兑换码已经在 % 被核销过了', to_char(v_red.used_at, 'YYYY-MM-DD HH24:MI');
  END IF;

  SELECT * INTO v_goods FROM public.point_goods g WHERE g.id = v_red.goods_id;
  -- 抵扣券和自动生效券由系统处理，不进手动核销流程，避免重复核销同一张券
  IF v_goods.id IS NOT NULL AND v_goods.benefit_type <> 'verify' THEN
    RAISE EXCEPTION '「%」不需要核销（系统会自动抵扣或已生效）', v_goods.name;
  END IF;

  SELECT COALESCE(NULLIF(btrim(p.nickname), ''), NULLIF(btrim(p.owner_name), ''), '同学')
    INTO v_nick FROM public.profiles p WHERE p.owner_id = v_red.user_id;

  UPDATE public.point_redemptions
     SET status = 'used', used_at = v_now, used_by = v_uid
   WHERE id = v_red.id;

  PERFORM public.push_message(
    v_red.user_id,
    'point_used',
    '兑换码已核销',
    '「' || v_red.goods_name || '」兑换码已由管理员核销，感谢使用',
    'point',
    NULL
  );

  RETURN QUERY SELECT v_red.code, v_red.goods_name, COALESCE(v_nick, '同学'), v_red.cost, v_now;
END;
$function$;

-- 积分调整时选人：按昵称 / 真名 / ID 后几位搜
CREATE OR REPLACE FUNCTION public.admin_search_points_user(p_keyword text, p_limit integer)
RETURNS TABLE(uid text, nickname text, points integer, role text, cert_status text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_kw text := btrim(COALESCE(p_keyword, ''));
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT public.admin_has_perm('settle') THEN
    RAISE EXCEPTION '只有结算员或超级管理员可以查找用户积分';
  END IF;

  RETURN QUERY
    SELECT p.owner_id, COALESCE(NULLIF(btrim(p.nickname), ''), NULLIF(btrim(p.owner_name), ''), '同学'),
           COALESCE(p.points, 0), COALESCE(p.role, 'user'), COALESCE(p.cert_status, 'none')
      FROM public.profiles p
     WHERE v_kw = ''
        OR p.owner_id ILIKE '%' || v_kw || '%'
        OR COALESCE(p.nickname, '') ILIKE '%' || v_kw || '%'
        OR COALESCE(p.owner_name, '') ILIKE '%' || v_kw || '%'
     ORDER BY p.created_at DESC
     LIMIT v_limit;
END;
$function$;

-- 我的券：用户端看自己的兑换码，顺带告诉它「怎么用」
CREATE OR REPLACE FUNCTION public.list_my_coupons()
RETURNS TABLE(id bigint, code text, goods_id text, goods_name text, cost integer,
              deduct_value numeric, benefit_type text, status text,
              created_at timestamp with time zone, expired_hint text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;

  RETURN QUERY
    SELECT r.id, r.code, r.goods_id, r.goods_name, r.cost,
           COALESCE(g.deduct_value, 0),
           COALESCE(g.benefit_type, 'verify'),
           r.status,
           r.created_at,
           CASE
             WHEN r.status = 'used' THEN '已使用'
             WHEN COALESCE(g.benefit_type, 'verify') = 'deduct' THEN '下单时可直接抵扣'
             WHEN COALESCE(g.benefit_type, 'verify') = 'auto' THEN '已自动生效'
             ELSE '到店出示兑换码核销'
           END
      FROM public.point_redemptions r
      LEFT JOIN public.point_goods g ON g.id = r.goods_id
     WHERE r.user_id = v_uid
     ORDER BY CASE WHEN r.status = 'unused' THEN 0 ELSE 1 END, r.created_at DESC, r.id DESC
     LIMIT 50;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 9. get_order_asset：订单里的图要跨人看，不能只认上传者本人
--
--    背景：get_media_asset 的条件是 ma.owner_id = 调用者 OR is_admin。
--    但订单场景天然跨人：
--      · 任务图是发布方传的 → 接单员接单后必须能看到才知道要取什么；
--      · 送达佐证是接单员传的 → 发布方确认前必须能看到才知道收没收对。
--    所以另开一个按订单授权的接口，两道条件缺一不可：
--      ① 调用者是这一单的发布方或接单员（管理员也放行，admin_is_any 可能不存在故包了异常兜底）；
--      ② 这张图确实挂在 orders.images / orders.deliver_images 里。
--    没接单的人既拿不到图也拿不到取餐码（配合 get_order_detail 的脱敏）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_order_asset(p_asset_id bigint, p_order_id bigint)
RETURNS TABLE(id bigint, mime text, data text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid text := auth.uid();
  v_row public.orders;
  v_path text := 'asset:' || p_asset_id;
  v_admin boolean := false;
  v_allow boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT * INTO v_row FROM public.orders o WHERE o.id = p_order_id;
  IF v_row.id IS NULL THEN RETURN; END IF;

  v_allow := (v_row.owner_id = v_uid)
          OR (v_row.runner_id IS NOT NULL AND v_row.runner_id = v_uid);

  IF NOT v_allow THEN
    BEGIN
      v_admin := public.admin_is_any();
    EXCEPTION WHEN OTHERS THEN
      v_admin := false;
    END;
    v_allow := v_admin;
  END IF;

  IF NOT v_allow THEN RETURN; END IF;

  IF NOT (v_path = ANY(COALESCE(v_row.images, ARRAY[]::text[]))
       OR v_path = ANY(COALESCE(v_row.deliver_images, ARRAY[]::text[]))) THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT ma.id, ma.mime, ma.data FROM public.media_assets ma WHERE ma.id = p_asset_id;
END;
$function$;

-- 商城列表带出「怎么用」，用户下单前就能看出这张券是抵扣还是核销
CREATE OR REPLACE FUNCTION public.list_point_goods()
RETURNS TABLE(id text, name text, emoji text, cost integer, stock integer, descr text,
              kind text, benefit_type text, deduct_value numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT g.id, g.name, g.emoji, g.cost, g.stock, g.descr, g.kind, g.benefit_type, g.deduct_value
    FROM public.point_goods g
   WHERE g.enabled = true
   ORDER BY g.sort_order, g.id;
$function$;
