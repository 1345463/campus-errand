-- 【已执行 2026-10-16】-- 本节内容已经执行完毕，留档备查。
--
-- 【收尾动作】收回订单表的客户端直写权限
--
-- 执行结果（冒充真实登录用户做的自检，全部在一笔事务里跑完并主动回滚，未留脏数据）：
--   SELECT  通过（大厅列表/订单详情不受影响）
--   INSERT  被拒 new row violates row-level security policy
--   UPDATE  影响行数 0（没有 UPDATE 策略，RLS 让语句匹配到 0 行，等于拦住）
--   create_order 正常返回订单号，status=pending，owner_id 与登录人一致
--   全表 15 行不变，无自检残留数据，未污染 k
--
-- 出问题的回滚方式在本文末尾（取消注释即可恢复）。
--
-- 前置条件（必须全部满足再执行）：
--   1. 新版小程序已经在微信公众平台「正式发布」（不是只传到体验版/开发版）；
--   2. 发布后至少等 48 小时，让用户端都更新过去。
--   　 新版 app.js 已加入 wx.getUpdateManager 强制更新：一检测到新版就弹窗让用户重启，
--   　 正常情况下当天就能覆盖绝大部分用户。
--
-- 为什么必须等：
--   已经装在用户手机里的旧版本，发单是「客户端直接往 orders 表 insert」。
--   这条 orders_write_own 策略就是它唯一的写入通道。删早了，
--   还没更新的用户点「发布任务」会直接失败，且不会有明确报错。
--
-- 为什么可以删：
--   新版本的全部订单写入都改成了走服务端函数（create_order / accept_order
--   / complete_order / confirm_order_done / cancel_order / admin_create_rental_order …），
--   这些函数是 SECURITY DEFINER，本来就不依赖这条策略。保留它反而等于
--   给客户端留了一个绕过 create_order 违规词校验的后门。
--   注：新版本对 orders 表只有 SELECT（大厅列表、订单详情读），删掉写策略不影响。
--
-- 已经做的兜底（与本条 SQL 无关，但让本条不再紧急）：
--   sql/add-order-write-guard.sql 里的 trg_orders_direct_insert_guard 触发器，
--   在 INSERT 层面补上了归属校验、伪造进度复位、违规词重扫（fail-open）。

-- ============ 一、执行前先确认一遍现状 ============
SELECT policyname, cmd, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'orders';
-- 期望看到两条：orders_read_all(SELECT) 和 orders_write_own(ALL)

-- ============ 二、正式执行 ============
DROP POLICY IF EXISTS orders_write_own ON public.orders;

-- ============ 三、执行后确认 ============
SELECT policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'orders';
-- 期望只剩一条：orders_read_all(SELECT)

-- ============ 四、出问题就立刻回滚（改账不禁账面改动，10 秒可恢复） ============
-- CREATE POLICY orders_write_own ON public.orders
--   FOR ALL TO authenticated
--   USING (owner_id = auth.uid())
--   WITH CHECK (owner_id = auth.uid());
