-- =============================================================================
-- 站内消息：用数据库触发器挂钩，不改动已经跑通的订单函数
--
-- 为什么用触发器而不是直接改 accept_order / complete_order / confirm_order_done：
--   这几个函数已经上线跑了一段时间，逐个重写风险高；
--   触发器挂在 orders / rental_requests / runner_applications / order_reports 的
--   UPDATE 上，只在状态真的变化时写一条消息，逻辑集中在一处，出问题也好摘。
--
-- 已执行于：wbapp_yPJnSvicojPmz998PjKfpM
-- =============================================================================

-- SQL-1：订单状态变更 → 通知相关方
CREATE OR REPLACE FUNCTION public.trg_order_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_balance numeric;
BEGIN
  -- 状态没变就不写消息，避免任何 UPDATE（比如改标题）都刷一条通知
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'accepted' THEN
    PERFORM public.push_message(
      NEW.owner_id, 'order_accepted', '有人接了你的任务',
      COALESCE(NULLIF(NEW.title, ''), '任务') || ' 已被接单，去订单里查看对方联系方式',
      'order', NEW.id
    );

  ELSIF OLD.status = 'accepted' AND NEW.status = 'waiting_confirm' THEN
    PERFORM public.push_message(
      NEW.owner_id, 'order_done', '接单员已标记送达',
      COALESCE(NULLIF(NEW.title, ''), '任务') || ' 已送达，确认无误后赏金会打给对方',
      'order', NEW.id
    );

  ELSIF OLD.status = 'waiting_confirm' AND NEW.status = 'done' AND NEW.runner_id IS NOT NULL THEN
    -- 确认完成：赏金入账 + 写钱包流水 + 通知接单员。
    -- 流水也放这里，是为了让"到账"和"通知"永远成对出现，不会出现给了钱没通知。
    UPDATE public.profiles p
       SET balance = COALESCE(p.balance, 0) + COALESCE(NEW.reward, 0)
     WHERE p.owner_id = NEW.runner_id
    RETURNING p.balance INTO v_balance;

    INSERT INTO public.wallet_records (user_id, delta, balance, kind, remark)
      VALUES (
        NEW.runner_id,
        COALESCE(NEW.reward, 0),
        COALESCE(v_balance, COALESCE(NEW.reward, 0)),
        'order_reward',
        '订单 #' || NEW.id || ' 完成结算'
      );

    PERFORM public.push_message(
      NEW.runner_id, 'order_confirmed', '赏金已到账',
      COALESCE(NULLIF(NEW.title, ''), '任务') ||
        ' 发布方已确认完成，赏金 ¥' || to_char(COALESCE(NEW.reward, 0), 'FM9999990.00') ||
        ' 已打入你的钱包',
      'order', NEW.id
    );

  ELSIF NEW.status = 'canceled'
        AND COALESCE(NEW.takedown, false) = false
        AND NEW.runner_id IS NOT NULL THEN
    -- takedown（违规下架）不通知接单员：那是平台的处置动作，
    -- 按"发布方取消了"措辞发出去会误导双方。
    PERFORM public.push_message(
      NEW.runner_id, 'order_canceled', '任务已被取消',
      COALESCE(NULLIF(NEW.title, ''), '任务') || ' 发布方取消了任务',
      'order', NEW.id
    );
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS orders_notify_aiu ON public.orders;
CREATE TRIGGER orders_notify_aiu
  AFTER UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.trg_order_notify();

-- SQL-2：租赁申请被报价 / 生成工单
CREATE OR REPLACE FUNCTION public.trg_rental_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  IF OLD.status = 'submitted' AND NEW.status = 'quoted' THEN
    PERFORM public.push_message(
      NEW.owner_id, 'rental_quoted', '租赁申请已报价',
      COALESCE(NEW.item_name, '相机') || ' 日租金报价 ¥' ||
        to_char(COALESCE(NEW.quoted_price, NEW.unit_price, 0), 'FM9999990.00') ||
        '，确认后即可生成工单',
      'rental', NEW.id
    );
  ELSIF NEW.status = 'ordered' AND OLD.status <> 'ordered' THEN
    PERFORM public.push_message(
      NEW.owner_id, 'rental_ordered', '特殊工单已生成',
      COALESCE(NEW.item_name, '相机') || ' 的租赁工单已生成，可在订单里查看进度',
      'order', NEW.order_id
    );
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS rental_requests_notify_aiu ON public.rental_requests;
CREATE TRIGGER rental_requests_notify_aiu
  AFTER UPDATE ON public.rental_requests
  FOR EACH ROW EXECUTE FUNCTION public.trg_rental_notify();

-- SQL-3：实名认证审核结果
CREATE OR REPLACE FUNCTION public.trg_cert_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  IF NEW.status = 'approved' THEN
    PERFORM public.push_message(
      NEW.owner_id, 'cert_reviewed', '实名认证已通过',
      '你已通过接单员实名认证，可以到「我的」切换为接单员开始接单',
      'cert', NEW.id
    );
  ELSIF NEW.status = 'rejected' THEN
    PERFORM public.push_message(
      NEW.owner_id, 'cert_reviewed', '实名认证未通过',
      '审核未通过：' || COALESCE(NULLIF(NEW.review_note, ''), '信息不完整，请修改后重新提交'),
      'cert', NEW.id
    );
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS runner_applications_notify_aiu ON public.runner_applications;
CREATE TRIGGER runner_applications_notify_aiu
  AFTER UPDATE ON public.runner_applications
  FOR EACH ROW EXECUTE FUNCTION public.trg_cert_notify();

-- SQL-4：举报处理结果
CREATE OR REPLACE FUNCTION public.trg_report_notify()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  IF NEW.status = 'resolved' THEN
    PERFORM public.push_message(
      NEW.reporter_id, 'report_handled', '举报已受理',
      '你举报的内容已核实，平台已对该订单下架处理',
      'report', NEW.id
    );
  ELSIF NEW.status = 'rejected' THEN
    PERFORM public.push_message(
      NEW.reporter_id, 'report_handled', '举报已核查',
      '经核查，该订单未发现问题。' || COALESCE(NULLIF(NEW.admin_note, ''), ''),
      'report', NEW.id
    );
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS order_reports_notify_aiu ON public.order_reports;
CREATE TRIGGER order_reports_notify_aiu
  AFTER UPDATE ON public.order_reports
  FOR EACH ROW EXECUTE FUNCTION public.trg_report_notify();
