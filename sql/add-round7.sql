-- ===========================================================================
-- 第七轮：优先展示券次卡化 / 信誉分双轨 / 举报下架扣分 / 批量发单 / 地址回填
--
-- 本轮要解决的都是「功能看着有、实际用不了」的问题：
--   · 优先展示券买完之后完全没效果（大厅排序没用到它）
--   · 举报下架订单不扣信誉分（写了 narrative 但没落库）
--   · 评价提交后信誉分不涨（单轨计数写错列）
--   · 楼栋楼层筛选筛不到历史订单（老订单两个字段是空的）
-- 外加两个新需求：管理员批量发单、新增「发单员」权限。
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. profiles：信誉分拆成双轨 + 违规次数
--    接单信誉分（别人对我这个接单员的评价）和发布信誉分（别人对我这个发布者
--    的评价）是两件事，混在一个平均分里会互相污染；credit_strikes 留给下架处罚。
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists owner_score_sum integer,
  add column if not exists owner_score_count integer,
  add column if not exists credit_strikes integer not null default 0;

-- ---------------------------------------------------------------------------
-- 2. orders：置顶标记 + 批量单批次号
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists boosted boolean not null default false,
  add column if not exists batch_no text;

create index if not exists orders_dispatch_idx
  on public.orders (owner_id, batch_no) where batch_no is not null;

-- ---------------------------------------------------------------------------
-- 3. point_goods：优先展示券从 auto 独立成 boost
--    原先 kind='boost' 的礼券 benefit_type 是 auto，兑换即写 boost_until，
--    但大厅排序压根没读这个字段 —— 等于白买。改成 boost 之后走「次卡」：
--    下单时勾选，用在这一单上，服务端一次性核销。
-- ---------------------------------------------------------------------------
update public.point_goods set benefit_type = 'boost'
 where kind = 'boost' and benefit_type = 'auto';

-- ---------------------------------------------------------------------------
-- 4. parse_addr_part：从地址串里反解楼栋 / 楼层
--    老订单的 pickup_building / deliver_building 全是空串，楼栋楼层筛选
--    筛不到它们。这个函数给两处用：①一次性回填；②create_order 的兜底，
--    调用方没显式传结构化字段时（比如未来的脚本导入）也能解析出来。
-- ---------------------------------------------------------------------------
create or replace function public.parse_addr_part(p_addr text, p_what text)
returns text
language sql immutable
set search_path to 'public'
as $fn$
  select case
    when split_part(coalesce(p_addr, ''), ' · ', 1)
         in ('进取楼','团结楼','博学楼','精益楼','敬业楼','迎宾楼')
    then case p_what
           when 'building' then split_part(p_addr, ' · ', 1)
           when 'floor'    then split_part(p_addr, ' · ', 2)
           else ''
         end
    else ''
  end
$fn$;

grant execute on function public.parse_addr_part(text, text) to authenticated, anon, service_role;

-- 历史订单回填：只在两个字段都空时跑，避免覆盖新数据
update public.orders
   set deliver_building = public.parse_addr_part(deliver_addr, 'building'),
       deliver_floor    = public.parse_addr_part(deliver_addr, 'floor'),
       pickup_building  = public.parse_addr_part(pickup_addr, 'building'),
       pickup_floor     = public.parse_addr_part(pickup_addr, 'floor')
 where coalesce(deliver_building, '') = ''
   and coalesce(pickup_building, '') = '';

-- ---------------------------------------------------------------------------
-- 5. create_order：新增 p_boost_code / p_batch_no（17 → 19 个参数）
--    抵扣券和优先券是两个通道，各自校验 benefit_type，串用会被拒。
--    抵扣只记在订单上（discount_amount），接单员仍拿全额赏金，差价平台承担。
-- ---------------------------------------------------------------------------
drop function if exists public.create_order(
  text,text,text,text,text,text,text,text,text[],text[],text,numeric,text,text,text,text,text);

create or replace function public.create_order(
  p_service_type text, p_service_name text, p_title text, p_description text,
  p_pickup_addr text, p_deliver_addr text, p_expect_time text, p_contact text,
  p_images text[], p_tags text[], p_gender_limit text, p_reward numeric,
  p_pickup_building text, p_pickup_floor text,
  p_deliver_building text, p_deliver_floor text,
  p_deduct_code text, p_boost_code text default '', p_batch_no text default '')
returns setof orders
language plpgsql security definer
set search_path to 'public'
as $fn$
declare
  v_uid        text := auth.uid();
  v_name       text;
  v_parts      text[];
  v_text       text;
  v_hit        record;
  v_order_id   bigint;
  v_code       text := nullif(btrim(coalesce(p_deduct_code, '')), '');
  v_boost      text := nullif(btrim(coalesce(p_boost_code, '')), '');
  v_red        public.point_redemptions;
  v_boost_red  public.point_redemptions;
  v_discount   numeric := 0;
  v_boosted    boolean := false;
  v_db text; v_df text; v_pb text; v_pf text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select coalesce(nullif(pf.nickname, ''), nullif(pf.owner_name, ''), '同学')
    into v_name from public.profiles pf where pf.owner_id = v_uid limit 1;

  if coalesce(p_reward, 0) < 1 then raise exception '赏金最少 1 元'; end if;

  if v_code is not null then
    select r.* into v_red
      from public.point_redemptions r join public.point_goods g on g.id = r.goods_id
     where r.code = v_code and r.user_id = v_uid and r.status = 'unused'
       and g.benefit_type = 'deduct' limit 1;
    if v_red.id is null then
      raise exception '这张券不能用（不存在、已使用或不是抵扣券）';
    end if;
    select least(coalesce(g.deduct_value, 0), p_reward) into v_discount
      from public.point_goods g where g.id = v_red.goods_id;
  end if;

  if v_boost is not null then
    select r.* into v_boost_red
      from public.point_redemptions r join public.point_goods g on g.id = r.goods_id
     where r.code = v_boost and r.user_id = v_uid and r.status = 'unused'
       and g.benefit_type = 'boost' limit 1;
    if v_boost_red.id is null then
      raise exception '这张优先展示券不能用（不存在、已使用或不是优先券）';
    end if;
    v_boosted := true;
  end if;

  -- 结构化地址字段没传就从地址串兜底解析，保证历史/外部数据也能被筛选到
  v_db := coalesce(nullif(btrim(coalesce(p_deliver_building, '')), ''), public.parse_addr_part(p_deliver_addr, 'building'));
  v_df := coalesce(nullif(btrim(coalesce(p_deliver_floor, '')), ''),    public.parse_addr_part(p_deliver_addr, 'floor'));
  v_pb := coalesce(nullif(btrim(coalesce(p_pickup_building, '')), ''),  public.parse_addr_part(p_pickup_addr, 'building'));
  v_pf := coalesce(nullif(btrim(coalesce(p_pickup_floor, '')), ''),     public.parse_addr_part(p_pickup_addr, 'floor'));

  v_parts := array[
    coalesce(p_title, ''), coalesce(p_description, ''),
    coalesce(p_pickup_addr, ''), coalesce(p_deliver_addr, ''),
    coalesce(p_expect_time, ''), coalesce(p_contact, ''), coalesce(p_service_name, ''),
    coalesce(array_to_string(p_images, ' '), ''), coalesce(array_to_string(p_tags, ' '), '')];
  for v_text in select unnest(v_parts) loop
    select * into v_hit from public.scan_moderation_words(v_text) limit 1;
    if v_hit is not null and v_hit.hit_word is not null then
      raise exception '内容包含不允许发布的信息（%，命中：%）。请修改后再发布',
        v_hit.hit_category, v_hit.hit_word;
    end if;
  end loop;

  insert into public.orders (
    owner_id, owner_name, service_type, service_name, title, description,
    pickup_addr, deliver_addr, expect_time, contact, images, tags, gender_limit,
    reward, status, pickup_building, pickup_floor, deliver_building, deliver_floor,
    discount_code, discount_amount, boosted, batch_no)
  values (
    v_uid, v_name,
    coalesce(nullif(p_service_type, ''), 'other'),
    coalesce(nullif(p_service_name, ''), '其它服务'),
    left(coalesce(p_title, ''), 60), left(coalesce(p_description, ''), 500),
    left(coalesce(p_pickup_addr, ''), 120), left(coalesce(p_deliver_addr, ''), 120),
    left(coalesce(p_expect_time, ''), 60), left(coalesce(p_contact, ''), 60),
    coalesce(p_images, array[]::text[]), coalesce(p_tags, array[]::text[]),
    coalesce(nullif(p_gender_limit, ''), '不限'),
    p_reward, 'pending',
    left(v_pb, 40), left(v_pf, 20), left(v_db, 40), left(v_df, 20),
    coalesce(v_code, ''), coalesce(v_discount, 0), v_boosted,
    nullif(btrim(coalesce(p_batch_no, '')), ''))
  returning orders.id into v_order_id;

  if v_code is not null and v_discount > 0 then
    update public.point_redemptions
       set status = 'used', used_at = now(), used_by = v_uid, order_id = v_order_id
     where id = v_red.id;
  end if;
  if v_boosted then
    update public.point_redemptions
       set status = 'used', used_at = now(), used_by = v_uid, order_id = v_order_id
     where id = v_boost_red.id;
  end if;

  return query select * from public.orders where id = v_order_id;
end;
$fn$;

grant execute on function public.create_order(
  text,text,text,text,text,text,text,text,text[],text[],text,numeric,text,text,text,text,text,text,text)
  to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- 6. list_hall_orders：大厅查询收口到服务端
--    原先前端直连 orders 表，置顶、takedown 排除、接单员门槛全都散在客户端。
--    现在统一在这里：① boosted 优先；② boost_until 还在有效期内也算优先
--    （照顾改成次卡之前就买了「7 天优先展示」的老用户）；③ 返回 total 精确分页。
-- ---------------------------------------------------------------------------
create or replace function public.list_hall_orders(
  p_service_type text default '', p_sort text default 'time',
  p_building text default '', p_floor text default '', p_keyword text default '',
  p_offset integer default 0, p_limit integer default 10)
returns table(
  id bigint, owner_id text, owner_name text, service_type text, service_name text,
  title text, description text, pickup_addr text, deliver_addr text, expect_time text,
  tags text[], gender_limit text, reward numeric, status text, created_at timestamptz,
  pickup_building text, pickup_floor text, deliver_building text, deliver_floor text,
  discount_amount numeric, boosted boolean, is_special boolean, total bigint)
language plpgsql stable security definer
set search_path to 'public'
as $fn$
declare
  v_uid  text := auth.uid();
  v_off  integer := greatest(coalesce(p_offset, 0), 0);
  v_lim  integer := least(greatest(coalesce(p_limit, 10), 1), 50);
  v_kw   text := btrim(coalesce(p_keyword, ''));
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not public.is_certified_runner() and not public.admin_is_any() then
    raise exception '只有认证接单员才能查看任务大厅';
  end if;

  return query
  select o.id, o.owner_id, o.owner_name, o.service_type, o.service_name,
         o.title, o.description, o.pickup_addr, o.deliver_addr, o.expect_time,
         o.tags, o.gender_limit, o.reward, o.status, o.created_at,
         o.pickup_building, o.pickup_floor, o.deliver_building, o.deliver_floor,
         o.discount_amount,
         (o.boosted or coalesce(pf.boost_until, now()) > now()) as boosted,
         o.is_special,
         count(*) over() as total
    from public.orders o
    left join public.profiles pf on pf.owner_id = o.owner_id
   where o.status = 'pending'
     and coalesce(o.is_special, false) = false
     and coalesce(o.takedown, false) = false
     and (nullif(btrim(coalesce(p_service_type, '')), '') is null or o.service_type = p_service_type)
     and (nullif(btrim(coalesce(p_building, '')), '')     is null or o.deliver_building = p_building)
     and (nullif(btrim(coalesce(p_floor, '')), '')        is null or o.deliver_floor = p_floor)
     and (v_kw = ''
          or o.title       ilike '%' || v_kw || '%'
          or o.description ilike '%' || v_kw || '%'
          or o.pickup_addr ilike '%' || v_kw || '%'
          or o.deliver_addr ilike '%' || v_kw || '%')
   order by case when (o.boosted or coalesce(pf.boost_until, now()) > now()) then 0 else 1 end,
            case when p_sort = 'reward' then o.reward else null end desc nulls last,
            o.created_at desc, o.id desc
   offset v_off limit v_lim;
end;
$fn$;

grant execute on function public.list_hall_orders(text,text,text,text,text,integer,integer)
  to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- 7. 批量发单（发单员权限 dispatch）
--    一次内容发到多个宿舍：内容 / 赏金 / 联系方式相同，只有送达地址不同。
--    归属只能是操作者本人，不支持「代别人发单」——否则赏金和信誉分记到别人头上。
-- ---------------------------------------------------------------------------
create or replace function public.admin_batch_create_orders(
  p_service_type text, p_service_name text, p_title text, p_description text,
  p_pickup_addr text, p_expect_time text, p_contact text, p_gender_limit text,
  p_reward numeric, p_targets jsonb)
returns setof orders
language plpgsql security definer
set search_path to 'public'
as $fn$
declare
  v_uid    text := auth.uid();
  v_batch  text;
  v_cnt    integer := 0;
  v_t      record;
  v_addr   text;
  v_b text; v_f text; v_r text;
  v_id     bigint;
  v_ids    bigint[] := array[]::bigint[];
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not public.admin_has_perm('dispatch') then raise exception '没有发单员权限'; end if;
  if coalesce(p_reward, 0) < 1 then raise exception '赏金最少 1 元'; end if;
  if p_targets is null or jsonb_array_length(p_targets) < 1 then
    raise exception '还没有选择要发到哪些宿舍';
  end if;
  if jsonb_array_length(p_targets) > 50 then
    raise exception '一次最多发 50 笔，请分批提交';
  end if;

  v_batch := 'B' || to_char(now(), 'YYMMDDHH24MISS') || substr(md5(v_uid || now()::text), 1, 4);

  for v_t in
    select t.building, t.floor, t.room
      from jsonb_to_recordset(p_targets) as t(building text, floor text, room text)
  loop
    v_b := coalesce(btrim(v_t.building), '');
    v_f := coalesce(btrim(v_t.floor), '');
    v_r := coalesce(btrim(v_t.room), '');
    if v_b = '' or v_f = '' or v_r = '' then
      raise exception '第 % 条目标地址不完整', v_cnt + 1;
    end if;
    v_addr := v_b || ' · ' || v_f || ' · ' || v_r;

    select id into v_id from public.create_order(
      p_service_type => p_service_type, p_service_name => p_service_name,
      p_title => p_title, p_description => p_description,
      p_pickup_addr => p_pickup_addr, p_deliver_addr => v_addr,
      p_expect_time => p_expect_time, p_contact => p_contact,
      p_images => array[]::text[], p_tags => array[]::text[],
      p_gender_limit => p_gender_limit, p_reward => p_reward,
      p_pickup_building => '', p_pickup_floor => '',
      p_deliver_building => v_b, p_deliver_floor => v_f,
      p_deduct_code => '', p_boost_code => '', p_batch_no => v_batch);

    if v_id is null then
      raise exception '第 % 笔创建失败，已发的 % 笔仍然有效', v_cnt + 1, v_cnt;
    end if;
    v_ids := v_ids || v_id;
    v_cnt := v_cnt + 1;
  end loop;

  return query select * from public.orders where id = any(v_ids) order by id;
end;
$fn$;

grant execute on function public.admin_batch_create_orders(text,text,text,text,text,text,text,text,numeric,jsonb)
  to authenticated, anon, service_role;

-- 发单员看自己发出的批次汇总
create or replace function public.admin_list_dispatch_orders(p_limit integer default 50)
returns table(batch_no text, total bigint, pending bigint, accepted bigint,
              done bigint, canceled bigint, created_at timestamptz,
              sample_title text, total_reward numeric)
language plpgsql stable security definer
set search_path to 'public'
as $fn$
declare v_uid text := auth.uid();
begin
  if v_uid is null then return; end if;
  if not public.admin_has_perm('dispatch') then raise exception '没有发单员权限'; end if;

  return query
  select o.batch_no,
         count(*)                                                         as total,
         count(*) filter (where o.status = 'pending')                     as pending,
         count(*) filter (where o.status = 'accepted' or o.status = 'waiting_confirm') as accepted,
         count(*) filter (where o.status = 'done')                        as done,
         count(*) filter (where o.status = 'canceled')                    as canceled,
         min(o.created_at)                                                as created_at,
         (array_agg(o.title order by o.id))[1]                            as sample_title,
         sum(o.reward)                                                    as total_reward
    from public.orders o
   where o.owner_id = v_uid and o.batch_no is not null
   group by o.batch_no
   order by min(o.created_at) desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
end;
$fn$;

grant execute on function public.admin_list_dispatch_orders(integer) to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- 8. 举报下架必须扣信誉分
--    原来的 admin_handle_report 只改订单状态和举报状态，被举报方一点代价没有。
--    现在下架会给被举报方记一次 1 星评价 + credit_strikes +1。
--    同时补了 status <> 'pending' 的拦截：同一条举报重复处理会重复扣分。
-- ---------------------------------------------------------------------------
create or replace function public.admin_handle_report(p_id bigint, p_action text, p_note text)
returns table(report_id bigint, status text, order_status text)
language plpgsql security definer
set search_path to 'public'
as $fn$
declare
  v_uid text := auth.uid();
  v_order_id bigint; v_new_status text; v_order_status text;
  v_role text; v_owner text; v_runner text; v_target text; v_target_role text;
  v_cur_status text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if not public.admin_has_perm('review') then raise exception 'admin only'; end if;

  select r.order_id, r.reporter_role, r.status
    into v_order_id, v_role, v_cur_status
    from public.order_reports r where r.id = p_id;
  if v_order_id is null then raise exception '举报不存在'; end if;
  if coalesce(v_cur_status, '') <> 'pending' then
    raise exception '这条举报已经处理过了（%）。同一条举报重复处理会重复扣信誉分，已拦截', v_cur_status;
  end if;

  if p_action = 'take_down' then
    select o.owner_id, o.runner_id into v_owner, v_runner
      from public.orders o where o.id = v_order_id;
    if v_role = 'owner' then v_target := v_runner; v_target_role := 'runner';
    else                     v_target := v_owner;  v_target_role := 'owner';
    end if;

    if v_target is not null then
      if v_target_role = 'runner' then
        update public.profiles pf
           set runner_score_sum   = coalesce(pf.runner_score_sum, 0) + 1,
               runner_score_count = coalesce(pf.runner_score_count, 0) + 1,
               credit_strikes     = coalesce(pf.credit_strikes, 0) + 1
         where pf.owner_id = v_target;
      else
        update public.profiles pf
           set owner_score_sum   = coalesce(pf.owner_score_sum, 0) + 1,
               owner_score_count = coalesce(pf.owner_score_count, 0) + 1,
               credit_strikes    = coalesce(pf.credit_strikes, 0) + 1
         where pf.owner_id = v_target;
      end if;
      perform public.push_message(
        v_target, 'report_penalty', '订单被下架，信誉分已扣减',
        '你有一笔订单因违规被管理员下架，已记一次最差评并累计违规次数。如有异议可在意见反馈中申诉。',
        'order', v_order_id);
    end if;

    v_new_status := 'resolved';
    update public.orders
       set status = 'canceled',
           admin_note = left(coalesce(p_note, '内容违规，已由管理员下架'), 200),
           finished_at = coalesce(finished_at, now()),
           takedown = true
     where id = v_order_id
    returning orders.status into v_order_status;

  elsif p_action = 'reject' then
    v_new_status := 'rejected';
    select o.status into v_order_status from public.orders o where o.id = v_order_id;
  else
    raise exception '未知的处理动作：%', coalesce(p_action, '(空)');
  end if;

  update public.order_reports
     set status = v_new_status, admin_note = left(coalesce(p_note, ''), 200),
         handled_at = now(), handled_by = v_uid
   where id = p_id;

  return query select p_id, v_new_status, coalesce(v_order_status, '-');
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 9. submit_order_review：写对列，双轨互不干扰
--    接单方打的分累到对方的 runner_*，发布方打的分累到对方的 owner_*。
-- ---------------------------------------------------------------------------
create or replace function public.submit_order_review(
  p_order_id bigint, p_score integer, p_tags text[], p_comment text)
returns setof order_reviews
language plpgsql security definer
set search_path to 'public'
as $fn$
declare
  v_uid text := auth.uid();
  v_order public.orders;
  v_from_role text; v_to_user text; v_to_role text;
  v_exists integer := 0;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select * into v_order from public.orders o where o.id = p_order_id;
  if v_order.id is null then raise exception '订单不存在'; end if;
  if v_order.status <> 'done' then raise exception '订单完成后才能评价'; end if;

  if v_order.owner_id = v_uid then
    v_from_role := 'owner';  v_to_user := v_order.runner_id; v_to_role := 'runner';
  elsif v_order.runner_id = v_uid then
    v_from_role := 'runner'; v_to_user := v_order.owner_id;  v_to_role := 'owner';
  else
    raise exception '只能评价自己参与的订单';
  end if;

  if p_score is null or p_score < 1 or p_score > 5 then
    raise exception '评分需要在 1 - 5 之间';
  end if;
  select count(*) into v_exists
    from public.order_reviews r
   where r.order_id = p_order_id and r.from_role = v_from_role;
  if v_exists > 0 then raise exception '你已经评价过这单了'; end if;

  return query insert into public.order_reviews
    (order_id, from_user, from_role, to_user, to_role, score, tags, comment)
  values (p_order_id, v_uid, v_from_role, v_to_user, v_to_role, p_score,
          coalesce(p_tags, array[]::text[]), left(btrim(coalesce(p_comment, '')), 200))
  returning *;

  if v_to_user is not null then
    if v_to_role = 'runner' then
      update public.profiles p
         set runner_score_sum   = coalesce(p.runner_score_sum, 0) + p_score,
             runner_score_count = coalesce(p.runner_score_count, 0) + 1
       where p.owner_id = v_to_user;
    else
      update public.profiles p
         set owner_score_sum   = coalesce(p.owner_score_sum, 0) + p_score,
             owner_score_count = coalesce(p.owner_score_count, 0) + 1
       where p.owner_id = v_to_user;
    end if;
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 10. my_credit_summary / order_peer_credit：把双轨和违规次数暴露给前端
--    两个函数的返回列都变过 → 必须先 drop 再 create（返回类型不同会报 42P13）。
-- ---------------------------------------------------------------------------
drop function if exists public.my_credit_summary();
create or replace function public.my_credit_summary()
returns table(runner_score numeric, runner_count integer, owner_score numeric,
              owner_count integer, received_count bigint, good_count bigint,
              done_count bigint, credit_strikes integer, boost_until timestamptz)
language plpgsql stable security definer
set search_path to 'public'
as $fn$
declare v_uid text := auth.uid();
begin
  if v_uid is null then return; end if;
  return query
  select case when coalesce(p.runner_score_count, 0) > 0
              then round(p.runner_score_sum::numeric / p.runner_score_count, 1) else 0::numeric end,
         coalesce(p.runner_score_count, 0),
         case when coalesce(p.owner_score_count, 0) > 0
              then round(p.owner_score_sum::numeric / p.owner_score_count, 1) else 0::numeric end,
         coalesce(p.owner_score_count, 0),
         (select count(*) from public.order_reviews r where r.to_user = v_uid),
         (select count(*) from public.order_reviews r where r.to_user = v_uid and r.score >= 4),
         (select count(*) from public.orders o where o.status = 'done'
            and (o.owner_id = v_uid or o.runner_id = v_uid)),
         coalesce(p.credit_strikes, 0),
         p.boost_until
    from public.profiles p where p.owner_id = v_uid;
end;
$fn$;

grant execute on function public.my_credit_summary() to authenticated, anon, service_role;

drop function if exists public.order_peer_credit(bigint);
create or replace function public.order_peer_credit(p_order_id bigint)
returns table(peer_name text, peer_role text, score numeric, score_count integer,
              review_count bigint, done_count bigint, is_runner boolean, credit_strikes integer)
language plpgsql stable security definer
set search_path to 'public'
as $fn$
declare
  v_uid text := auth.uid();
  v_order public.orders;
  v_peer text; v_side text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select * into v_order from public.orders o where o.id = p_order_id;
  if v_order.id is null then return; end if;

  if v_order.runner_id = v_uid then     v_peer := v_order.owner_id;  v_side := 'owner';
  elsif v_order.owner_id = v_uid then   v_peer := v_order.runner_id; v_side := 'runner';
  else
    if not public.admin_is_any() then
      raise exception '只有这单的双方和管理员可以查看对方信誉分';
    end if;
    v_peer := coalesce(v_order.runner_id, v_order.owner_id);
    v_side := case when v_order.runner_id is not null then 'runner' else 'owner' end;
  end if;
  if v_peer is null then return; end if;

  return query
  select coalesce(nullif(btrim(p.nickname), ''), nullif(btrim(p.owner_name), ''), '同学'),
         v_side,
         case when v_side = 'runner'
              then case when coalesce(p.runner_score_count, 0) > 0
                        then round(p.runner_score_sum::numeric / p.runner_score_count, 1)
                        else 0::numeric end
              else case when coalesce(p.owner_score_count, 0) > 0
                        then round(p.owner_score_sum::numeric / p.owner_score_count, 1)
                        else 0::numeric end end,
         case when v_side = 'runner' then coalesce(p.runner_score_count, 0)
              else coalesce(p.owner_score_count, 0) end,
         (select count(*) from public.order_reviews r where r.to_user = v_peer),
         (select count(*) from public.orders o2 where o2.status = 'done'
            and (o2.owner_id = v_peer or o2.runner_id = v_peer)),
         (coalesce(p.role, 'user') = 'runner' or coalesce(p.cert_status, 'none') = 'approved'),
         coalesce(p.credit_strikes, 0)
    from public.profiles p where p.owner_id = v_peer limit 1;
end;
$fn$;

grant execute on function public.order_peer_credit(bigint) to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- 11. 新增发单员权限：perm_key = dispatch
--    admin_has_perm 不需要改（它是查表），但白名单校验的两处要放行：
--    admin_set_perm 的参数校验、admin_my_perms 里 super 的全权限列表。
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_perm(p_user_id text, p_perm_key text, p_enabled boolean)
returns text
language plpgsql security definer
set search_path to 'public'
as $fn$
declare
  v_uid text := auth.uid();
  v_super boolean; v_hr boolean;
  v_perm text := btrim(coalesce(p_perm_key, ''));
  v_target text := btrim(coalesce(p_user_id, ''));
  v_super_count integer;
  v_on boolean := coalesce(p_enabled, false);
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  v_super := public.admin_has_perm('super');
  v_hr    := public.admin_has_perm('hr');
  if not (v_super or v_hr) then
    raise exception '只有超级管理员或人事可以管理后台权限';
  end if;
  if v_perm not in ('super','support','hr','review','rental','print','settle','dispatch') then
    raise exception '未知的权限：%', v_perm;
  end if;
  if v_perm = 'super' and not v_super then
    raise exception '只有超级管理员可以授予或收回超级管理员权限';
  end if;
  if v_target = '' then raise exception '请先选中要授权的人员'; end if;
  if not exists (select 1 from public.profiles p where p.owner_id = v_target) then
    raise exception '找不到这个用户（ID：%）', v_target;
  end if;
  if v_perm = 'super' and v_on = false then
    select count(*) into v_super_count from public.admin_grants g where g.perm_key = 'super';
    if v_super_count <= 1 then raise exception '至少要保留一个超级管理员'; end if;
  end if;

  if v_on then
    insert into public.admin_grants (user_id, perm_key, granted_by)
    values (v_target, v_perm, v_uid)
    on conflict (user_id, perm_key) do nothing;
  else
    delete from public.admin_grants g where g.user_id = v_target and g.perm_key = v_perm;
  end if;

  update public.profiles p
     set is_admin = exists (select 1 from public.admin_grants g where g.user_id = p.owner_id)
   where p.owner_id = v_target;

  return case when v_on then 'granted' else 'revoked' end;
end;
$fn$;

create or replace function public.admin_my_perms()
returns table(perm_key text)
language plpgsql stable security definer
set search_path to 'public'
as $fn$
declare v_uid text := auth.uid(); v_super boolean := false;
begin
  if v_uid is null then return; end if;
  select exists (select 1 from public.admin_grants g
                  where g.user_id = v_uid and g.perm_key = 'super') into v_super;
  if v_super then
    return query select k.k from (values ('super'),('support'),('hr'),('review'),
                                        ('rental'),('print'),('settle'),('dispatch')) as k(k);
    return;
  end if;
  return query select g.perm_key from public.admin_grants g
                where g.user_id = v_uid order by g.perm_key;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 12. exchange_point_goods / list_my_coupons：把「怎么用」讲清楚
--    boost 类型不再写 boost_until（那是次卡了），改由下单时勾选消耗。
-- ---------------------------------------------------------------------------
create or replace function public.exchange_point_goods(p_goods_id text)
returns table(code text, goods_name text, cost integer, points_left integer)
language plpgsql security definer
set search_path to 'public'
as $fn$
declare
  v_uid text := auth.uid();
  v_goods public.point_goods;
  v_points integer; v_stock integer; v_code text; v_raw text; v_hint text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select * into v_goods from public.point_goods g
   where g.id = p_goods_id and g.enabled = true for update;
  if v_goods.id is null then raise exception '礼券不存在或已下架'; end if;
  if v_goods.stock <= 0 then raise exception '这个礼券已经兑完了'; end if;

  select coalesce(p.points, 0) into v_points from public.profiles p
   where p.owner_id = v_uid for update;
  if v_points is null then raise exception '找不到你的账户资料，请重新登录'; end if;
  if v_points < v_goods.cost then raise exception '积分不够，还差 % 分', v_goods.cost; end if;

  update public.point_goods set stock = stock - 1 where id = v_goods.id returning stock into v_stock;
  update public.profiles set points = coalesce(points, 0) - v_goods.cost
   where owner_id = v_uid returning points into v_points;

  v_raw  := upper(substr(md5(random()::text || v_uid || clock_timestamp()::text), 1, 8));
  v_code := v_goods.id || '-' || substr(v_raw, 1, 4) || '-' || substr(v_raw, 5, 4);

  insert into public.point_redemptions (user_id, goods_id, goods_name, cost, code)
  values (v_uid, v_goods.id, v_goods.name, v_goods.cost, v_code);
  insert into public.point_records (user_id, delta, balance, kind, remark)
  values (v_uid, -v_goods.cost, v_points, 'exchange', '兑换「' || v_goods.name || '」');

  -- benefit_type 已经是 boost 的走次卡流程，这里只给还没迁移的 kind='boost' 兜底
  if v_goods.kind = 'boost' and coalesce(v_goods.benefit_type, '') <> 'boost' then
    update public.profiles
       set boost_until = greatest(coalesce(boost_until, now()), now()) + interval '7 days'
     where owner_id = v_uid;
  end if;

  v_hint := case coalesce(v_goods.benefit_type, 'verify')
              when 'deduct' then '下单时选择它就能直接抵扣赏金'
              when 'boost'  then '下单时选择它，这一单会排在大厅最前面'
              else '到核销处出示兑换码即可' end;

  perform public.push_message(
    v_uid, 'point_exchange', '兑换成功',
    '「' || v_goods.name || '」兑换成功，兑换码 ' || v_code || '。' || v_hint, 'point', null);

  return query select v_code, v_goods.name, v_goods.cost, v_points;
end;
$fn$;

create or replace function public.list_my_coupons()
returns table(id bigint, code text, goods_id text, goods_name text, cost integer,
              deduct_value numeric, benefit_type text, status text,
              created_at timestamptz, expired_hint text)
language plpgsql stable security definer
set search_path to 'public'
as $fn$
declare v_uid text := auth.uid();
begin
  if v_uid is null then return; end if;
  return query
  select r.id, r.code, r.goods_id, r.goods_name, r.cost,
         coalesce(g.deduct_value, 0), coalesce(g.benefit_type, 'verify'), r.status, r.created_at,
         case when r.status = 'used' then '已使用'
              when coalesce(g.benefit_type, 'verify') = 'deduct'
                then '下单时可直接抵扣 ¥' || coalesce(g.deduct_value, 0)
              when coalesce(g.benefit_type, 'verify') = 'boost'
                then '下单时勾选，这一单大厅优先展示'
              else '到店出示兑换码核销' end
    from public.point_redemptions r
    left join public.point_goods g on g.id = r.goods_id
   where r.user_id = v_uid
   order by case when r.status = 'unused' then 0 else 1 end, r.created_at desc, r.id desc
   limit 50;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 13. 灰度开关
-- ---------------------------------------------------------------------------
insert into public.feature_flags (flag_key, label, enabled, sort_order)
values ('admin_batch_order', '管理员批量发单', true, 220),
       ('order_boost',       '下单可用优先展示券', true, 230)
on conflict (flag_key) do update
  set label = excluded.label, sort_order = excluded.sort_order;

commit;
