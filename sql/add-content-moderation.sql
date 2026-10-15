-- 内容安全：违规词库 + 发布强校验 + 订单举报
-- 应用：wbapp_yPJnSvicojPmz998PjKfpM
--
-- 为什么词库放表里而不是写死在前端：
--   1) 前端校验可以被绕过（用户可以不走页面直接调接口），必须服务端再拦一次；
--   2) 违规词需要持续补充，放表里管理员后台改一条就生效，不必重新发布小程序；
--   3) 客户端只拉取缓存，命中判断在本地完成，输入时能立刻给出提示。
--
-- 检测算法（SQL 与 JS 两端实现必须一致，见 utils/moderation.js）：
--   规范化文本 -> 逐字段子串匹配（不做分词，绕过式变形如「代-课」「代 课」strip 后就能命中）
--   规范化 = 全角转半角 + 繁体转简体（常用字）+ 大写转小写 + 去掉所有非「中日韩字符/字母/数字」
--   注意是**按字段分别扫描**再汇总，不是把字段拼起来扫：
--   拼起来会让词跨字段边界误命中（上一字段结尾「代」+ 下一字段开头「课」）。
--
-- 执行方式：mode=migrate，单条执行（工具一次一条语句），按 SQL-1 … SQL-N 顺序各执行一次。

-- SQL-1：词库表
CREATE TABLE IF NOT EXISTS public.moderation_words (
  id bigserial PRIMARY KEY,
  category text NOT NULL,
  word text NOT NULL UNIQUE,
  severity text NOT NULL DEFAULT 'block',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- SQL-2：开启 RLS 且不建任何策略 —— 客户端不能直连读写，只能经下面的 SECURITY DEFINER 函数
ALTER TABLE public.moderation_words ENABLE ROW LEVEL SECURITY;

-- SQL-3：索引 + 收回直连权限
CREATE INDEX IF NOT EXISTS moderation_words_enabled_idx ON public.moderation_words (enabled, category);
REVOKE ALL ON public.moderation_words FROM PUBLIC, anon, authenticated;

-- SQL-4：文本规范化。
-- 全角转半角（FF01-FF5E -> 21-7E，U+3000 -> 空格）、繁体转简体（只覆盖本词库波及的常用字）、
-- 大写转小写、剔除一切非「中日韩字符/字母/数字」的字符。
-- 返回 NULL 时按空串处理。
CREATE OR REPLACE FUNCTION public.normalize_mod_text(p_raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $fn$
DECLARE
  v_s text := COALESCE(p_raw, '');
  v_out text := '';
  v_i integer;
  v_c integer;
  v_ch text;
  v_norm text;
  -- 繁体 -> 简体 + 带调拼音字母 -> 无调。两段由 scripts/gen-moderation-sql.js 生成，必须等长。
  c_from constant text := '課寫學槍賭藥煙買賣偽單號遊戲帳驗網幫郵銀專論業實檔辦證護駕發稅錄監勞質習畢書圖開關點線務個們這樣頭貨項體測練級語試車輪會員區協現場廣āáǎàēéěèêīíǐìōóǒòūúǔùǖǘǚǜü';
  c_to   constant text := '课写学枪赌药烟买卖伪单号游戏帐验网帮邮银专论业实档办证护驾发税录监劳质习毕书图开关点线务个们这样头货项体测练级语试车轮会员区协现场广aaaaeeeeeiiiioooouuuuuuuuu';
BEGIN
  IF v_s = '' THEN RETURN ''; END IF;

  -- 全角转半角 + 大写转小写
  v_i := 1;
  WHILE v_i <= char_length(v_s) LOOP
    v_ch := substring(v_s from v_i for 1);
    v_c  := ascii(v_ch);
    IF v_c = 12288 THEN
      v_out := v_out || ' ';
    ELSIF v_c >= 65281 AND v_c <= 65374 THEN
      v_out := v_out || lower(chr(v_c - 65248));
    ELSE
      v_out := v_out || lower(v_ch);
    END IF;
    v_i := v_i + 1;
  END LOOP;

  IF char_length(c_from) <> char_length(c_to) THEN
    RAISE EXCEPTION '繁简映射表长度不一致（% vs %）', char_length(c_from), char_length(c_to);
  END IF;
  v_norm := translate(v_out, c_from, c_to);

  -- 只保留中日韩字符、字母、数字
  RETURN regexp_replace(v_norm, '[^一-龥a-zA-Z0-9]', '', 'g');
END;
$fn$;

-- SQL-5：扫描单段文本，返回命中的（分类, 词）。最多 5 条，够用且避免报错信息过长。
-- 顺序很关键：先把白名单从文本里删掉，再匹配黑名单（severity = 'block'）。
-- 本平台就叫「校园跑腿」，用户写「帮我代跑腿买饭」是正常需求，但词库里有「代跑」这条
-- （针对代跑体测），不先摘白名单就会把普通跑腿需求误拦 —— 白名单和黑名单共用一张表，
-- 管理员在后台加一行就能修，不用改代码。
CREATE OR REPLACE FUNCTION public.scan_moderation_words(p_text text)
RETURNS TABLE (hit_category text, hit_word text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_norm text; v_allow record;
BEGIN
  v_norm := public.normalize_mod_text(p_text);
  IF v_norm = '' THEN RETURN; END IF;

  FOR v_allow IN
    SELECT public.normalize_mod_text(mw.word) AS w
      FROM public.moderation_words mw
     WHERE mw.enabled
       AND mw.severity = 'allow'
       AND public.normalize_mod_text(mw.word) <> ''
  LOOP
    v_norm := replace(v_norm, v_allow.w, '');
  END LOOP;

  IF v_norm = '' THEN RETURN; END IF;
  RETURN QUERY
    SELECT mw.category, mw.word
      FROM public.moderation_words mw
     WHERE mw.enabled
       AND COALESCE(mw.severity, 'block') = 'block'
       AND public.normalize_mod_text(mw.word) <> ''
       AND position(public.normalize_mod_text(mw.word) IN v_norm) > 0
     ORDER BY char_length(mw.word) DESC, mw.id
     LIMIT 5;
END;
$fn$;

-- SQL-6：客户端拉取词库（登录用户可读）。黑名单与白名单一起下发，
-- 前端用同一套算法本地预判 —— 顺序必须和服务端一致：先摘白名单再匹配黑名单。
CREATE OR REPLACE FUNCTION public.list_active_moderation_words()
RETURNS TABLE (id bigint, category text, word text, severity text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  RETURN QUERY
    SELECT mw.id, mw.category, mw.word, COALESCE(mw.severity, 'block')
      FROM public.moderation_words mw
     WHERE mw.enabled
     ORDER BY mw.severity DESC, mw.category, mw.word;
END;
$fn$;

-- SQL-7：举报表
CREATE TABLE IF NOT EXISTS public.order_reports (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL,
  reporter_id text NOT NULL,
  reporter_role text NOT NULL DEFAULT 'runner',
  reason text NOT NULL,
  detail text NOT NULL DEFAULT '',
  hit_words jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  admin_note text NOT NULL DEFAULT '',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  handled_at timestamp with time zone,
  handled_by text
);

-- SQL-8
ALTER TABLE public.order_reports ENABLE ROW LEVEL SECURITY;

-- SQL-9
CREATE INDEX IF NOT EXISTS order_reports_status_idx ON public.order_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS order_reports_order_idx ON public.order_reports (order_id, reporter_id);

-- SQL-10
REVOKE ALL ON public.order_reports FROM PUBLIC, anon, authenticated;

-- SQL-11：举报。
-- 允许任何登录用户举报（在大厅看到可疑任务也能报），但要记录身份：
--   owner = 发布方本人、runner = 已接单的接单员、viewer = 路过的第三方。
-- 管理员看列表时能据此判断可信度。同一人对同一单未处理的举报只能有一条。
CREATE OR REPLACE FUNCTION public.report_order(p_order_id bigint, p_reason text, p_detail text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_id bigint;
  v_role text;
  v_reason text := COALESCE(NULLIF(btrim(COALESCE(p_reason, '')), ''), '未填写');
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT COALESCE(
           CASE WHEN o.owner_id = v_uid THEN 'owner'
                WHEN o.runner_id = v_uid THEN 'runner'
                ELSE NULL END,
           'viewer')
    INTO v_role
    FROM public.orders o
   WHERE o.id = p_order_id;

  IF v_role IS NULL THEN
    RAISE EXCEPTION '订单不存在';
  END IF;

  SELECT r.id INTO v_id
    FROM public.order_reports r
   WHERE r.order_id = p_order_id AND r.reporter_id = v_uid AND r.status = 'pending'
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    RAISE EXCEPTION '你已举报过该订单，请等待管理员处理';
  END IF;

  INSERT INTO public.order_reports (order_id, reporter_id, reporter_role, reason, detail)
  VALUES (p_order_id, v_uid, v_role, left(v_reason, 40), left(COALESCE(p_detail, ''), 300))
  RETURNING order_reports.id INTO v_id;

  RETURN v_id;
END;
$fn$;

-- SQL-12：本人对该单的举报状态（用于详情页展示「你已举报，处理中」）
CREATE OR REPLACE FUNCTION public.my_order_report(p_order_id bigint)
RETURNS TABLE (report_id bigint, reason text, detail text, status text, admin_note text, created_at timestamp with time zone)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  RETURN QUERY
    SELECT r.id, r.reason, r.detail, r.status, r.admin_note, r.created_at
      FROM public.order_reports r
     WHERE r.order_id = p_order_id AND r.reporter_id = v_uid
     ORDER BY r.created_at DESC
     LIMIT 1;
END;
$fn$;

-- SQL-13：管理员查看举报列表
CREATE OR REPLACE FUNCTION public.admin_list_reports(p_limit integer)
RETURNS TABLE (
  report_id bigint,
  order_id bigint,
  reason text,
  detail text,
  status text,
  admin_note text,
  created_at timestamp with time zone,
  reporter_id text,
  reporter_role text,
  order_title text,
  order_desc text,
  order_reward numeric,
  order_status text,
  owner_id text,
  runner_id text,
  owner_name text,
  runner_name text,
  reporter_name text
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
    SELECT r.id, r.order_id, r.reason, r.detail, r.status, r.admin_note, r.created_at,
           r.reporter_id, r.reporter_role,
           COALESCE(o.title, '(订单已删除)'), COALESCE(o.description, ''), o.reward,
           COALESCE(o.status, '-'), COALESCE(o.owner_id, ''), COALESCE(o.runner_id, ''),
           COALESCE(o.owner_name, ''), COALESCE(o.runner_name, ''),
           COALESCE(NULLIF(pf.nickname, ''), NULLIF(pf.owner_name, ''), r.reporter_id)
      FROM public.order_reports r
      LEFT JOIN public.orders o ON o.id = r.order_id
      LEFT JOIN public.profiles pf ON pf.owner_id = r.reporter_id
     ORDER BY (r.status <> 'pending') ASC, r.created_at DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
END;
$fn$;

-- SQL-14：管理员处理举报。p_action = 'take_down'（下架订单并取消）或 'reject'（驳回）
CREATE OR REPLACE FUNCTION public.admin_handle_report(p_id bigint, p_action text, p_note text)
RETURNS TABLE (report_id bigint, status text, order_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_admin boolean;
  v_order_id bigint;
  v_new_status text;
  v_order_status text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  SELECT pf.is_admin INTO v_admin FROM public.profiles pf WHERE pf.owner_id = v_uid LIMIT 1;
  IF v_admin IS NOT TRUE THEN RAISE EXCEPTION 'admin only'; END IF;

  SELECT r.order_id INTO v_order_id FROM public.order_reports r WHERE r.id = p_id;
  IF v_order_id IS NULL THEN RAISE EXCEPTION '举报不存在'; END IF;

  IF p_action = 'take_down' THEN
    v_new_status := 'resolved';
    UPDATE public.orders
       SET status = 'canceled',
           admin_note = left(COALESCE(p_note, '内容违规，已由管理员下架'), 200),
           runner_id = NULL,
           runner_name = NULL
     WHERE id = v_order_id
    RETURNING orders.status INTO v_order_status;
  ELSIF p_action = 'reject' THEN
    v_new_status := 'rejected';
    SELECT o.status INTO v_order_status FROM public.orders o WHERE o.id = v_order_id;
  ELSE
    RAISE EXCEPTION '未知的处理动作：%', COALESCE(p_action, '(空)');
  END IF;

  UPDATE public.order_reports
     SET status = v_new_status,
         admin_note = left(COALESCE(p_note, ''), 200),
         handled_at = now(),
         handled_by = v_uid
   WHERE id = p_id;

  IF NOT FOUND THEN RAISE EXCEPTION '举报不存在'; END IF;

  RETURN QUERY SELECT p_id, v_new_status, COALESCE(v_order_status, '-');
END;
$fn$;

-- SQL-15：发单统一入口。
-- 之前客户端是 orders 表直接 insert，配合 orders_write_own 这条 ALL 策略，
-- 意味着任何人都能绕过页面自己构造请求写内容 —— 前端的违规词检查形同虚设。
-- 这里改成走函数：在服务端再校验一次，并由服务端决定 owner_id / owner_name（防冒名）。
-- 返回 SETOF public.orders（不用 RETURNS TABLE，避免 OUT 参数名与列名的歧义问题）。
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
  p_reward numeric
) RETURNS SETOF public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_name text;
  v_parts text[];
  v_text text;
  v_hit record;
  v_order_id bigint;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT COALESCE(NULLIF(pf.nickname, ''), NULLIF(pf.owner_name, ''), '同学')
    INTO v_name
    FROM public.profiles pf
   WHERE pf.owner_id = v_uid
   LIMIT 1;

  IF COALESCE(p_reward, 0) <= 0 THEN
    RAISE EXCEPTION '赏金必须大于 0';
  END IF;

  -- 逐字段扫描，不先拼接再扫：拼接会让词跨字段边界误命中
  -- （上一字段结尾「代」+ 下一字段开头「课」就冤枉好人了）
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
    pickup_addr, deliver_addr, expect_time, contact, images, tags, gender_limit, reward, status
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
    'pending'
  ) RETURNING orders.id INTO v_order_id;

  RETURN QUERY SELECT * FROM public.orders WHERE id = v_order_id;
END;
$fn$;

-- SQL-16：收回订单表的客户端直写权限。
-- 全项目的订单写入此刻已经全部走 RPC（create_order / admin_create_rental_order
-- / accept_order / complete_order / confirm_order_done / cancel_order …），
-- 保留这条策略只会让人绕过 create_order 的违规词校验。
-- 只留 orders_read_all（SELECT）。
DROP POLICY IF EXISTS orders_write_own ON public.orders;

-- SQL-17：举报相关（若前面已建，这里幂等重复一次无妨）
CREATE INDEX IF NOT EXISTS order_reports_order_idx ON public.order_reports (order_id, reporter_id);

-- SQL-18：租赁预填也要过违规词。
-- 这是 create_order 之外的第二个用户自由文本入口（备注、学院、取件地址都能随便填），
-- 不拦的话「租赁渠道发违规内容」就成了绕过发单校验的旁路。
CREATE OR REPLACE FUNCTION public.submit_rental_request(
  p_item_id text,
  p_item_name text,
  p_unit_price numeric,
  p_days integer,
  p_real_name text,
  p_student_no text,
  p_college text,
  p_contact text,
  p_expect_from text,
  p_expect_to text,
  p_pickup_addr text,
  p_note text
) RETURNS SETOF public.rental_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_parts text[];
  v_text text;
  v_hit record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF COALESCE(p_days, 0) < 1 THEN RAISE EXCEPTION '租期至少 1 天'; END IF;

  v_parts := ARRAY[
    COALESCE(p_item_name, ''),
    COALESCE(p_real_name, ''),
    COALESCE(p_college, ''),
    COALESCE(p_contact, ''),
    COALESCE(p_pickup_addr, ''),
    COALESCE(p_note, '')
  ];
  FOR v_text IN SELECT unnest(v_parts) LOOP
    SELECT * INTO v_hit FROM public.scan_moderation_words(v_text) LIMIT 1;
    IF v_hit IS NOT NULL AND v_hit.hit_word IS NOT NULL THEN
      RAISE EXCEPTION '内容包含不允许发布的信息（%，命中：%）。请修改后再提交',
        v_hit.hit_category, v_hit.hit_word;
    END IF;
  END LOOP;

  RETURN QUERY INSERT INTO public.rental_requests (
    owner_id, item_id, item_name, unit_price, days, real_name, student_no,
    college, contact, expect_from, expect_to, pickup_addr, note, status
  ) VALUES (
    v_uid, p_item_id, p_item_name, COALESCE(p_unit_price, 0), p_days,
    COALESCE(p_real_name, ''), COALESCE(p_student_no, ''), COALESCE(p_college, ''),
    COALESCE(p_contact, ''), COALESCE(p_expect_from, ''), COALESCE(p_expect_to, ''),
    COALESCE(p_pickup_addr, ''), COALESCE(p_note, ''), 'submitted'
  ) RETURNING *;
END;
$fn$;

-- 【执行状态】SQL-1 ~ SQL-15、SQL-18 已执行（SQL-5 / SQL-6 于 2026-10-15 加白名单后重跑一次）。
-- SQL-16 暂缓：见下方说明。
-- 【灌库】292 条黑名单 + 4 条白名单 / 13 个违规分类（由 scripts/gen-moderation-sql.js 生成并自检）。
-- 【重要】改 SQL-16 之前必须确认客户端已改用 create_order RPC，否则发布流程会整体失效。
-- 【复用】后续增删违规词只需改 moderation_words 表：
--   UPDATE public.moderation_words SET enabled = false WHERE word = '某词';
--   INSERT INTO public.moderation_words (category, word) VALUES ('分类', '某词')
--     ON CONFLICT (word) DO NOTHING;
--   客户端缓存 30 分钟过期，管理员停用后最多 30 分钟生效；想立刻生效可清除小程序缓存或重启。
