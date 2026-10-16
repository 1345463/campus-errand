-- ============================================================
-- 第四轮迭代：积分 1:1 到账 / 接单员真名 / 头像与用户名 / 积分商城上线 /
--              我的评价与信誉分 / 新增灰度开关
-- 应用：wbapp_yPJnSvicojPmz998PjKfpM
--
-- 执行方式：mode=migrate，按 SQL-1 … SQL-20 顺序，一次执行一条。
-- ============================================================

-- ---------- 一、积分按赏金 1:1 到账 ----------

-- SQL-1：发布方确认完成时，除了把赏金打进接单员钱包，
-- 再按「赏金 : 积分 = 1 : 1」给接单员发积分（四舍五入到整数）。
-- 积分与钱包分开记两本账：钱包可提现，积分只能换权益。
CREATE OR REPLACE FUNCTION public.confirm_order_done(p_order_id bigint)
RETURNS SETOF public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_row public.orders;
  v_reward numeric;
  v_balance numeric;
  v_points integer;
  v_gain integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT * INTO v_row FROM public.orders o WHERE o.id = p_order_id;
  IF v_row.id IS NULL THEN RETURN; END IF;
  IF v_row.owner_id <> v_uid THEN RETURN; END IF;
  IF v_row.status <> 'waiting_confirm' THEN RETURN; END IF;
  IF v_row.runner_id IS NULL THEN RAISE EXCEPTION '该订单还没有接单员'; END IF;

  v_reward := COALESCE(v_row.reward, 0);

  UPDATE public.orders o
     SET status = 'done',
         finished_at = now(),
         feedback_status = 'none'
   WHERE o.id = p_order_id AND o.status = 'waiting_confirm' AND o.owner_id = v_uid;

  UPDATE public.profiles p
     SET balance = COALESCE(p.balance, 0) + v_reward
   WHERE p.owner_id = v_row.runner_id
  RETURNING p.balance INTO v_balance;

  INSERT INTO public.wallet_records (user_id, delta, balance, kind, remark)
    VALUES (v_row.runner_id, v_reward, COALESCE(v_balance, v_reward), 'order_reward', '订单 #' || p_order_id || ' 完成结算');

  -- 赏金 1:1 折算成积分。0 元订单不写流水，避免刷出无意义的 0 分记录。
  v_gain := GREATEST(ROUND(v_reward)::integer, 0);
  IF v_gain > 0 THEN
    UPDATE public.profiles p
       SET points = COALESCE(p.points, 0) + v_gain
     WHERE p.owner_id = v_row.runner_id
    RETURNING p.points INTO v_points;

    INSERT INTO public.point_records (user_id, delta, balance, kind, remark)
      VALUES (v_row.runner_id, v_gain, COALESCE(v_points, v_gain), 'order_reward',
              '订单 #' || p_order_id || ' 完成，赏金 ' || to_char(v_reward, 'FM9999990.00') || ' 元按 1:1 发放');
  END IF;

  PERFORM public.push_message(
    v_row.runner_id,
    'order_confirmed',
    '赏金已到账',
    COALESCE(v_row.title, '任务') || ' 发布方已确认完成，赏金 ¥' || to_char(v_reward, 'FM9999990.00') ||
      ' 已打入钱包' || CASE WHEN v_gain > 0 THEN '，另得 ' || v_gain || ' 积分' ELSE '' END,
    'order',
    p_order_id
  );

  RETURN QUERY SELECT * FROM public.orders WHERE id = p_order_id;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.confirm_order_done(bigint) TO authenticated;

-- ---------- 二、接单页显示接单员真实姓名 ----------

-- SQL-2：接单时把 runner_name 写成接单员实名认证时填的**真实姓名**，
-- 而不是他自己取的昵称。优先级：已通过的认证申请 real_name → 昵称 → 注册名 → 兜底。
CREATE OR REPLACE FUNCTION public.accept_order(p_order_id bigint)
RETURNS SETOF public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_runner text := auth.uid();
  v_name text;
  v_row public.orders;
BEGIN
  IF v_runner IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT COALESCE(
           NULLIF(btrim(ra.real_name), ''),
           NULLIF(btrim(p.nickname), ''),
           NULLIF(btrim(p.owner_name), ''),
           '接单员'
         )
    INTO v_name
    FROM public.profiles p
    LEFT JOIN LATERAL (
      SELECT a.real_name
        FROM public.runner_applications a
       WHERE a.owner_id = v_runner AND a.status = 'approved'
       ORDER BY a.created_at DESC
       LIMIT 1
    ) ra ON true
   WHERE p.owner_id = v_runner
   LIMIT 1;

  IF v_name IS NULL THEN v_name := '接单员'; END IF;

  UPDATE public.orders o
     SET runner_id = v_runner,
         runner_name = v_name,
         status = 'accepted',
         accepted_at = now()
   WHERE o.id = p_order_id AND o.status = 'pending' AND o.runner_id IS NULL
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN RETURN; END IF;

  PERFORM public.push_message(
    v_row.owner_id,
    'order_accepted',
    '有人接了你的任务',
    COALESCE(v_row.title, '任务') || ' 已被接单，去订单里查看对方联系方式',
    'order',
    v_row.id
  );

  RETURN QUERY SELECT * FROM public.orders WHERE id = v_row.id;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.accept_order(bigint) TO authenticated;

-- ---------- 三、用户名与头像 ----------

-- SQL-3：改资料。用户名（2-16 字）与头像一起改；头像只接受本人上传的图片编号。
-- 原来的单参数版本签名不同，先丢掉避免出现重载歧义。
DROP FUNCTION IF EXISTS public.update_my_profile(text);

-- SQL-4
CREATE OR REPLACE FUNCTION public.update_my_profile(p_nickname text, p_avatar_path text)
RETURNS SETOF public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_name text := NULLIF(btrim(COALESCE(p_nickname, '')), '');
  v_avatar text := NULLIF(btrim(COALESCE(p_avatar_path, '')), '');
  v_asset_id bigint;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  IF v_name IS NOT NULL THEN
    IF char_length(v_name) < 2 THEN RAISE EXCEPTION '用户名至少 2 个字'; END IF;
    IF char_length(v_name) > 16 THEN RAISE EXCEPTION '用户名最多 16 个字'; END IF;
  END IF;

  IF v_avatar IS NOT NULL THEN
    IF v_avatar !~ '^asset:[0-9]+$' THEN RAISE EXCEPTION '头像格式不正确，请重新上传'; END IF;
    v_asset_id := substring(v_avatar from 7)::bigint;
    IF NOT EXISTS (
      SELECT 1 FROM public.media_assets ma WHERE ma.id = v_asset_id AND ma.owner_id = v_uid
    ) THEN
      RAISE EXCEPTION '这张头像不存在或不是本人上传的';
    END IF;
  END IF;

  RETURN QUERY
    UPDATE public.profiles
       SET nickname = COALESCE(v_name, nickname),
           owner_name = COALESCE(v_name, owner_name),
           avatar_url = COALESCE(v_avatar, avatar_url)
     WHERE owner_id = v_uid
    RETURNING *;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.update_my_profile(text, text) TO authenticated;

-- SQL-5：头像要给别人看（订单、评价列表），把 avatar 也放进公开资源白名单。
-- 仍然只放这一种 scope 出去，证件照等私有图片不受影响。
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
     WHERE ma.id = p_id AND ma.scope IN ('banner', 'avatar');
END;
$fn$;

-- ---------- 四、积分商城真正上线 ----------

-- SQL-6：礼券配置表。放在库里而不是写死在页面，改库存/上下架不用发版。
CREATE TABLE IF NOT EXISTS public.point_goods (
  id text PRIMARY KEY,
  name text NOT NULL,
  emoji text NOT NULL DEFAULT '🎁',
  cost integer NOT NULL DEFAULT 0,
  stock integer NOT NULL DEFAULT 0,
  descr text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'coupon',
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
);
COMMENT ON TABLE public.point_goods IS '积分商城礼券配置';

-- SQL-7
ALTER TABLE public.point_goods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.point_goods FROM PUBLIC, anon, authenticated;

-- SQL-8
INSERT INTO public.point_goods (id, name, emoji, cost, stock, descr, kind, sort_order) VALUES
  ('coupon_2',   '免跑腿券',      '🎫', 20,  50,  '一次订单免 2 元跑腿费',        'coupon', 10),
  ('coupon_5',   '跑腿折扣券',    '💸', 50,  20,  '一次订单立减 5 元',            'coupon', 20),
  ('print_10',   '免费打印 10 页', '🖨️', 30,  100, '校内打印店出示兑换码可用',      'coupon', 30),
  ('rental_off', '相机租借 8 折',  '📷', 80,  8,   '一次相机租赁订单可用',          'coupon', 40),
  ('boost_7',    '接单优先展示',   '⭐', 200, 999, '7 天内接单名片优先曝光',        'boost',  50),
  ('milk',       '奶茶兑换券',    '🧋', 120, 0,   '合作店铺兑换，已兑完',          'coupon', 60)
ON CONFLICT (id) DO NOTHING;

-- SQL-9：兑换记录。code 是给用户线下核销的兑换码。
CREATE TABLE IF NOT EXISTS public.point_redemptions (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  goods_id text NOT NULL,
  goods_name text NOT NULL,
  cost integer NOT NULL DEFAULT 0,
  code text NOT NULL,
  status text NOT NULL DEFAULT 'unused',
  used_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.point_redemptions IS '积分商城兑换记录与兑换码';

-- SQL-10
ALTER TABLE public.point_redemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.point_redemptions FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS point_redemptions_user_idx ON public.point_redemptions (user_id, created_at DESC);

-- SQL-11：接单优先展示的生效截止时间
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS boost_until timestamp with time zone;

-- SQL-12：礼券列表（游客也能看，登录后再兑）
CREATE OR REPLACE FUNCTION public.list_point_goods()
RETURNS TABLE (id text, name text, emoji text, cost integer, stock integer, descr text, kind text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT g.id, g.name, g.emoji, g.cost, g.stock, g.descr, g.kind
    FROM public.point_goods g
   WHERE g.enabled = true
   ORDER BY g.sort_order, g.id;
$fn$;
GRANT EXECUTE ON FUNCTION public.list_point_goods() TO authenticated, anon;

-- SQL-13：兑换。库存与积分都在服务端扣，客户端算的那点校验只是提前提示。
CREATE OR REPLACE FUNCTION public.exchange_point_goods(p_goods_id text)
RETURNS TABLE (code text, goods_name text, cost integer, points_left integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_goods public.point_goods;
  v_points integer;
  v_stock integer;
  v_code text;
  v_raw text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT * INTO v_goods
    FROM public.point_goods g
   WHERE g.id = p_goods_id AND g.enabled = true
   FOR UPDATE;

  IF v_goods.id IS NULL THEN RAISE EXCEPTION '礼券不存在或已下架'; END IF;
  IF v_goods.stock <= 0 THEN RAISE EXCEPTION '这个礼券已经兑完了'; END IF;

  SELECT COALESCE(p.points, 0) INTO v_points
    FROM public.profiles p
   WHERE p.owner_id = v_uid
   FOR UPDATE;

  IF v_points IS NULL THEN RAISE EXCEPTION '找不到你的账户资料，请重新登录'; END IF;
  IF v_points < v_goods.cost THEN
    RAISE EXCEPTION '积分不够，还差 % 分', v_goods.cost - v_points;
  END IF;

  UPDATE public.point_goods SET stock = stock - 1 WHERE id = v_goods.id RETURNING stock INTO v_stock;

  UPDATE public.profiles SET points = COALESCE(points, 0) - v_goods.cost
   WHERE owner_id = v_uid
  RETURNING points INTO v_points;

  v_raw := upper(substr(md5(random()::text || v_uid || clock_timestamp()::text), 1, 8));
  v_code := v_goods.id || '-' || substr(v_raw, 1, 4) || '-' || substr(v_raw, 5, 4);

  INSERT INTO public.point_redemptions (user_id, goods_id, goods_name, cost, code)
    VALUES (v_uid, v_goods.id, v_goods.name, v_goods.cost, v_code);

  INSERT INTO public.point_records (user_id, delta, balance, kind, remark)
    VALUES (v_uid, -v_goods.cost, v_points, 'exchange', '兑换「' || v_goods.name || '」');

  IF v_goods.kind = 'boost' THEN
    UPDATE public.profiles
       SET boost_until = GREATEST(COALESCE(boost_until, now()), now()) + interval '7 days'
     WHERE owner_id = v_uid;
  END IF;

  PERFORM public.push_message(
    v_uid,
    'point_exchange',
    '兑换成功',
    '「' || v_goods.name || '」兑换成功，兑换码 ' || v_code || '，可在积分商城「我的兑换」里查看',
    'point',
    NULL
  );

  RETURN QUERY SELECT v_code, v_goods.name, v_goods.cost, v_points;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.exchange_point_goods(text) TO authenticated;

-- SQL-14：我的兑换记录
CREATE OR REPLACE FUNCTION public.list_my_redemptions(p_limit integer)
RETURNS TABLE (
  id bigint,
  goods_id text,
  goods_name text,
  cost integer,
  code text,
  status text,
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
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;

  RETURN QUERY
    SELECT r.id, r.goods_id, r.goods_name, r.cost, r.code, r.status, r.created_at
      FROM public.point_redemptions r
     WHERE r.user_id = v_uid
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT v_limit;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.list_my_redemptions(integer) TO authenticated;

-- ---------- 五、我的评价与信誉分 ----------

-- SQL-15：我还欠着的评价（已完成的单、我是参与方、我还没评）
CREATE OR REPLACE FUNCTION public.list_my_review_todo(p_limit integer)
RETURNS TABLE (
  order_id bigint,
  title text,
  reward numeric,
  as_role text,
  peer_name text,
  finished_at timestamp with time zone
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
    SELECT o.id,
           COALESCE(o.title, '任务'),
           o.reward,
           CASE WHEN o.owner_id = v_uid THEN 'owner' ELSE 'runner' END,
           CASE WHEN o.owner_id = v_uid
                THEN COALESCE(NULLIF(btrim(o.runner_name), ''), '接单员')
                ELSE COALESCE(NULLIF(btrim(o.owner_name), ''), '发布方')
           END,
           o.finished_at
      FROM public.orders o
     WHERE o.status = 'done'
       AND (o.owner_id = v_uid OR o.runner_id = v_uid)
       AND NOT EXISTS (
         SELECT 1 FROM public.order_reviews r
          WHERE r.order_id = o.id AND r.from_user = v_uid
       )
     ORDER BY o.finished_at DESC NULLS LAST, o.id DESC
     LIMIT v_limit;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.list_my_review_todo(integer) TO authenticated;

-- SQL-16：我收到的评价
CREATE OR REPLACE FUNCTION public.list_my_received_reviews(p_limit integer)
RETURNS TABLE (
  id bigint,
  order_id bigint,
  order_title text,
  from_role text,
  from_name text,
  score integer,
  comment text,
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
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;

  RETURN QUERY
    SELECT r.id,
           r.order_id,
           COALESCE(o.title, '任务'),
           r.from_role,
           CASE WHEN r.from_role = 'owner'
                THEN COALESCE(NULLIF(btrim(o.owner_name), ''), '发布方')
                ELSE COALESCE(NULLIF(btrim(o.runner_name), ''), '接单员')
           END,
           r.score,
           COALESCE(r.comment, ''),
           r.created_at
      FROM public.order_reviews r
      LEFT JOIN public.orders o ON o.id = r.order_id
     WHERE r.to_user = v_uid
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT v_limit;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.list_my_received_reviews(integer) TO authenticated;

-- SQL-17：信誉分汇总
CREATE OR REPLACE FUNCTION public.my_credit_summary()
RETURNS TABLE (
  runner_score numeric,
  runner_count integer,
  received_count bigint,
  good_count bigint,
  done_count bigint,
  boost_until timestamp with time zone
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;

  RETURN QUERY
    SELECT CASE WHEN COALESCE(p.runner_score_count, 0) > 0
                THEN ROUND((p.runner_score_sum::numeric / p.runner_score_count), 1)
                ELSE 0::numeric
           END,
           COALESCE(p.runner_score_count, 0),
           (SELECT count(*) FROM public.order_reviews r WHERE r.to_user = v_uid),
           (SELECT count(*) FROM public.order_reviews r WHERE r.to_user = v_uid AND r.score >= 4),
           (SELECT count(*) FROM public.orders o
             WHERE o.status = 'done' AND (o.owner_id = v_uid OR o.runner_id = v_uid)),
           p.boost_until
      FROM public.profiles p
     WHERE p.owner_id = v_uid;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.my_credit_summary() TO authenticated;

-- ---------- 六、新增灰度开关 ----------

-- SQL-18：新引入的三项功能同样纳入灰度总闸，由超级管理员决定是否放开。
-- enabled 与现网其他开关保持一致（当前全部为开），上线后可在「灰度开关」页随时关掉。
INSERT INTO public.feature_flags (flag_key, label, description, enabled, sort_order) VALUES
  ('profile_edit', '头像与用户名',   '点头像区可更换头像与用户名',              true, 150),
  ('credit_score', '信誉分查询',     '查看自己的信誉分与收到的评价',            true, 160),
  ('my_reviews',   '我的评价入口',   '我的页新增待评价入口与我收到的评价',      true, 170)
ON CONFLICT (flag_key) DO NOTHING;

-- SQL-19：后台统计里补一个「待处理反馈」数字，让客服在工作台就能看到待办。
-- 沿用原签名，只加一列，前端按列名取。
CREATE OR REPLACE FUNCTION public.admin_dashboard_stats()
RETURNS TABLE (
  pending_certs bigint,
  pending_rentals bigint,
  pending_reports bigint,
  pending_settles bigint,
  pending_feedbacks bigint,
  today_orders bigint,
  total_orders bigint,
  can_review boolean,
  can_rental boolean,
  can_support boolean,
  can_settle boolean,
  can_hr boolean,
  can_print boolean,
  can_super boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_review boolean;
  v_rental boolean;
  v_support boolean;
  v_settle boolean;
  v_hr boolean;
  v_print boolean;
  v_super boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  v_super   := public.admin_has_perm('super');
  v_review  := public.admin_has_perm('review');
  v_rental  := public.admin_has_perm('rental');
  v_support := public.admin_has_perm('support');
  v_settle  := public.admin_has_perm('settle');
  v_hr      := public.admin_has_perm('hr');
  v_print   := public.admin_has_perm('print');

  IF NOT (v_super OR v_review OR v_rental OR v_support OR v_settle OR v_hr OR v_print) THEN
    RAISE EXCEPTION '没有后台权限';
  END IF;

  RETURN QUERY SELECT
    CASE WHEN (v_super OR v_review)
         THEN (SELECT count(*) FROM public.runner_applications ra WHERE ra.status = 'pending')
         ELSE 0 END,
    CASE WHEN (v_super OR v_rental)
         THEN (SELECT count(*) FROM public.rental_requests rr WHERE rr.status = 'submitted')
         ELSE 0 END,
    CASE WHEN (v_super OR v_support)
         THEN (SELECT count(*) FROM public.order_reports rp WHERE rp.status = 'pending')
         ELSE 0 END,
    CASE WHEN (v_super OR v_settle)
         THEN (SELECT count(*) FROM public.orders o WHERE o.feedback_status = 'pending')
         ELSE 0 END,
    CASE WHEN (v_super OR v_support)
         THEN (SELECT count(*) FROM public.user_feedbacks f WHERE f.status = 'pending')
         ELSE 0 END,
    (SELECT count(*) FROM public.orders o WHERE o.created_at >= date_trunc('day', now())),
    (SELECT count(*) FROM public.orders o),
    v_review, v_rental, v_support, v_settle, v_hr, v_print, v_super;
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_stats() TO authenticated;

-- SQL-20：接单优先展示的排序生效——大厅按 boost_until 未过期优先排前。
-- 未登录/无 boost 的用户一律为 false，不影响原有按时间/赏金排序。
CREATE OR REPLACE FUNCTION public.my_boost_active()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_until timestamp with time zone;
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  SELECT p.boost_until INTO v_until FROM public.profiles p WHERE p.owner_id = v_uid LIMIT 1;
  RETURN COALESCE(v_until > now(), false);
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.my_boost_active() TO authenticated;
