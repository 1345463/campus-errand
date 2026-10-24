-- ============================================================
-- R45 · 修图片归属触发器误伤接单员
--
-- 现象：接单员点「放弃接单」→ 报「图片不属于当前账号，请重新上传」。
--
-- 真因：R40 的 assert_order_assets_owned 把整行的 images + deliver_images
--       一起拿去校验，要求全部属于 auth.uid()。但这两列分属两个人：
--         orders.images          —— 发布方上传的任务图
--         orders.deliver_images  —— 接单员上传的送达佐证
--       接单员一旦更新这一行（放弃接单会清空 deliver_images、提交送达会写入
--       deliver_images），NEW.images 里仍然是发布方的图 → 必然判定为越权。
--       同理，接单员「提交送达」在带图订单上也是坏的，不只是放弃接单。
--
-- 修法：只校验「本次真正被修改的那一列」。
--       INSERT 两列都校验（同一个人建单）；
--       UPDATE 用 IS DISTINCT FROM 判断哪列变了，只校验变了的那列。
--       没变的列是对方的历史数据，不该拿当前用户去卡。
--
-- 安全性不变：越权读图的真正边界在 get_order_asset（要求图片属于本单参与方），
-- 这里拦的是「往单子里塞不属于自己的图」，语义保持精确。
-- ============================================================

CREATE OR REPLACE FUNCTION public.assert_order_assets_owned()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_check text[];
  v_bad text;
BEGIN
  -- 直连迁移 / 后台补数据没有会话，放行
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_check := COALESCE(NEW.images, ARRAY[]::text[])
            || COALESCE(NEW.deliver_images, ARRAY[]::text[]);
  ELSE
    -- 只挑出本次真正改动的那一列。两边都可能更新同一行：
    -- 发布方建单写 images，接单员送达写 deliver_images，
    -- 放弃接单时会把 deliver_images 清空 —— 但 images 仍是发布方的。
    IF NEW.images IS DISTINCT FROM OLD.images THEN
      v_check := COALESCE(v_check, ARRAY[]::text[])
              || COALESCE(NEW.images, ARRAY[]::text[]);
    END IF;
    IF NEW.deliver_images IS DISTINCT FROM OLD.deliver_images THEN
      v_check := COALESCE(v_check, ARRAY[]::text[])
              || COALESCE(NEW.deliver_images, ARRAY[]::text[]);
    END IF;
  END IF;

  -- 两列都没变（只改了状态字段），没有任何图片需要校验
  IF v_check IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT t.path INTO v_bad
    FROM unnest(v_check) AS t(path)
   WHERE t.path ~ '^asset:[0-9]+$'
     AND NOT EXISTS (
       SELECT 1
         FROM public.media_assets ma
        WHERE ma.id = substring(t.path FROM 7)::bigint
          AND ma.owner_id = v_uid
     )
   LIMIT 1;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '图片不属于当前账号，请重新上传';
  END IF;

  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.assert_order_assets_owned() FROM PUBLIC, anon, authenticated;
