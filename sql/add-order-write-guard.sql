-- 第七轮补充：order 表直写守卫
--
-- 背景：
--   SQL-16（add-content-moderation.sql）里的
--     DROP POLICY IF EXISTS orders_write_own ON public.orders;
--   一直没执行，因为现在已经在线上的旧版小程序是用「客户端直接 insert orders 表」
--   来发单的。一旦把这条策略删掉，那些还没更新到新版的用户就一条单都发不出去。
--
--   所以这条 DROP 必须等新版（走 create_order 函数发单）真正覆盖到用户之后再跑。
--   在那之前，先用下面的触发器把「绕过 create_order 的违规词校验」这个洞补上：
--   不管请求来自哪个版本的小程序，只要往 orders 里插一行，都强制过一遍违规词。
--
-- 设计原则：**fail-open（出错一律放行）**。
--   守卫是为了堵漏，绝不能因为守卫本身出问题就把正常发单卡死。
--   函数体整体包在 EXCEPTION 里，任何"没预料到"的错误都退回原行为；
--   只有明确用 RAISE EXCEPTION 抛出的拒绝理由（P0001）才会真的拦下来。

CREATE OR REPLACE FUNCTION public.orders_direct_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_hit record;
  v_parts text[];
  v_text text;
  v_is_admin boolean := false;
BEGIN
  BEGIN
    -- 服务端内部写入（auth.uid() 为空，比如迁移脚本）不拦
    IF v_uid IS NULL THEN
      RETURN NEW;
    END IF;

    -- 只能给自己发单。owner_id 和登录人不符时，只有超管（admin_create_rental_order
    -- 会用申请人的 id 代发租赁工单）可以放行。
    IF NEW.owner_id IS DISTINCT FROM v_uid THEN
      BEGIN
        v_is_admin := public.admin_has_perm('super');
      EXCEPTION WHEN OTHERS THEN
        -- admin_has_perm 万一不存在/变了签名：退回让 RLS 自己管（策略本身就要求 owner_id = auth.uid()）
        v_is_admin := false;
      END;
      IF NOT v_is_admin THEN
        RAISE EXCEPTION '不能替别人发布任务';
      END IF;
    ELSE
      -- 客户端直写不允许伪造进度：只能创建待接单的新任务。
      -- 否则可以插一条「已经被自己接单且已完成」的记录，走正常 UI 直接骗到结算。
      NEW.status := 'pending';
      NEW.runner_id := NULL;
      NEW.runner_name := NULL;
      NEW.accepted_at := NULL;
      NEW.runner_done_at := NULL;
      NEW.finished_at := NULL;
      NEW.feedback_status := COALESCE(NEW.feedback_status, 'none');
      NEW.feedback_text := NULL;
      NEW.feedback_at := NULL;
      NEW.takedown := COALESCE(NEW.takedown, false);
    END IF;

    -- 违规词扫描：和 create_order 用的是同一个 public.scan_moderation_words
    v_parts := ARRAY[
      COALESCE(NEW.title, ''),
      COALESCE(NEW.description, ''),
      COALESCE(NEW.pickup_addr, ''),
      COALESCE(NEW.deliver_addr, ''),
      COALESCE(NEW.expect_time, ''),
      COALESCE(NEW.contact, ''),
      COALESCE(NEW.service_name, ''),
      COALESCE(array_to_string(NEW.images, ' '), ''),
      COALESCE(array_to_string(NEW.tags, ' '), '')
    ];

    FOR v_text IN SELECT unnest(v_parts) LOOP
      BEGIN
        SELECT * INTO v_hit FROM public.scan_moderation_words(v_text) LIMIT 1;
      EXCEPTION WHEN OTHERS THEN
        -- 词表/函数异常时放行，不能因为审核挂了就发不了单
        CONTINUE;
      END;
      IF v_hit IS NOT NULL AND v_hit.hit_word IS NOT NULL THEN
        RAISE EXCEPTION '内容包含不允许发布的信息（%，命中：%）。请修改后再发布',
          v_hit.hit_category, v_hit.hit_word;
      END IF;
    END LOOP;

    RETURN NEW;
  EXCEPTION
    WHEN raise_exception THEN
      -- 上面明确抛出的拒绝理由，原样上抛（PL/pgSQL 里 CONTINUE 不会被认成这个）
      RAISE;
    WHEN OTHERS THEN
      -- 守卫自身出任何意外都放行，退回到"没有守卫"的原始行为
      RETURN NEW;
  END;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_orders_direct_insert_guard ON public.orders;
CREATE TRIGGER trg_orders_direct_insert_guard
  BEFORE INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.orders_direct_insert_guard();

COMMENT ON FUNCTION public.orders_direct_insert_guard() IS
  '旧版小程序直写 orders 表时的兜底守卫：校验归属、复位伪造的订单进度、重跑违规词扫描。出错一律放行（fail-open）。';
