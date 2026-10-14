# 校园跑腿 · 变更日志（按迭代正序）

> 本文件随每一次迭代提交自动追加。完整的过程记录、踩坑知识库与数据库演进
> 见 `docs/ITERATIONS.md`。

## R1 · 立项与原型还原（10-14）

- 用户提供 1 分 46 秒参考小程序录屏，抽帧 22 张还原页面。
- 首版 8 个页面 / 3 个 tabBar，后端接 WorkBuddy Cloud（PostgreSQL）。
- 建表 profiles / orders / addresses / runner_applications（全量 RLS）。
- 跨用户操作一律 SECURITY DEFINER：accept_order / complete_order / cancel_order。
- 确定合规红线：校园互助、不代做作业、不代考、不涉违禁品。

_提交时间：2026-10-14 13:20:00_

## R2 · 修「首页服务宫格点不进去」

- 根因：进下单页前的 guard.ensureLogin() 前置拦截；H5 预览拿不到真实 wx.login，
- 永远登不上，每次点击都被弹框拦下；且 getSession() reject 时未 catch，Promise 中断后无反馈。
- 填表改为纯本地操作，登录校验挪到"提交任务"时；所有 wx.navigateTo 补 fail 回调；
- 大厅加载失败改为可点击重试的空态，不再弹 toast 打断。
- 原则：不用匿名登录/假 session 绕过鉴权。

_提交时间：2026-10-14 14:10:00_

## R3 · 学校切换 + 三级宿舍 + 账号登录 + 管理员

- utils/campus.js：广东邮电职业技术学院，进取楼/团结楼/博学楼/精益楼/敬业楼/迎宾楼，
- 1-14 层、1-40 号，formatRoom / parseRoom 双向解析。
- 自定义组件 components/room-picker 做三级选择；地址拆成 building="楼栋 · 楼层" + room="宿舍号"。
- 账号登录 loginWithPassword / sendPhoneCode / registerWithPhone（不依赖 wx.login，预览可用）。
- 管理员：profiles.is_admin + activate_admin(code) + list_all_orders(limit)。

_提交时间：2026-10-14 15:00:00_

## R4 · 预览环境兼容性（utils/ui.js）

- H5 预览容器不完整模拟原生能力，报 wx.showLoading is not a function；
- 同一原因导致 picker-view 三列渲染错乱（点开直接是第三级房号）。
- 新增 utils/ui.js：所有 wx UI/storage 调用统一走这里，available() 检测 + try/catch + 超时兜底；
- confirm 带 15s 超时，绝不悬着。
- 三级选择器废弃 picker-view，改为三个 scroll-view 列 + bindtap 选中。
- 踩坑：sed 全量替换时不能把 ui.js 自己内部的 wx.* 也替换掉（会无限递归）。

_提交时间：2026-10-14 16:00:00_

## R5 · 提交任务报错 + 管理员审核接单员

- Bug：pages/order/create.js 的 buildTitle 里 desc 未定义（批量 sed 误删声明），点提交必抛。
- 教训：批量 sed 后函数级改动必须回归跑一遍，不能只做语法检查。
- 新增 pages/admin/review 与 RPC：list_runner_applications(p_status, p_limit)（RETURNS TABLE，
- 因为 RLS 是 owner-only，管理员读不到别人的申请）、review_runner_application（同步写
- profiles.cert_status 与 role）。
- 调试入口 insert_demo_application(label) 造合成申请，不污染真实用户认证状态。

_提交时间：2026-10-14 17:00:00_

## R6 · 大整数 owner_id 精度陷阱

- 根因：owner_id 是超过 JS 安全整数（2^53）的字符串，客户端用 === 或 .eq 匹配不上，
- RLS 又把不匹配的行静默过滤（返回 data: [] 而非 error）。
- 解决套路（沿用至今）：所有"本人数据"读写一律改 SECURITY DEFINER 函数，
- 服务端用 auth.uid() 定位，绝不在客户端拼 owner_id / runner_id。
- 新增 set_my_role / update_my_profile / set_cert_pending / list_my_orders / order_relation。
- 第二个坑：ui.confirm 无 defaultConfirm 时预览环境会 resolve(false)，取消/完成/删除全部静默。
- 新建 pages/mine/points、pages/mine/wallet（钱包如实说明未接支付，不假装能提现）。

_提交时间：2026-10-14 18:00:00_

## R7 · 自接单 / 退出登录 / 双号联调

- 删除管理员自接单入口（secondary 概念及相关 WXML 分支）。
- 取消按钮消失的原因：服务端关系判定 RPC 失败 → then 链进 catch → setData 没执行。
- 教训：关键渲染不能依赖单一 RPC，order_relation 加本地兜底。
- 退出登录无效的真正原因：退出后被 tryAutoLogin 立刻登回同一账号。
- 修法：写 manualLogout 标记 + 彻底不用 wx.showModal，改页内两步确认（4 秒自动复位）。
- pages/mine/apply.js 曾出现两个 onLoad → 校验脚本增加"Page 方法名查重"。

_提交时间：2026-10-14 19:00:00_

## R8 · 两段式确认 + OUT 参数歧义

- 根因 1：list_runner_applications 用 RETURNS TABLE 声明 OUT 参数，它们在 PL/pgSQL 里
- 同时是函数变量；体内写 SELECT is_admin INTO v_admin FROM profiles WHERE owner_id = v_uid
- （未限定表名）→ column reference "owner_id" is ambiguous，整个函数首次执行即失败。
- 根因 2：detail 页取消/完成依赖 wx.showModal，预览容器可能缺失或回调不带 confirm 字段。
- → 改成页面内两段式确认（armKey/armLabel，首次点变字"再点一次，确认取消"，4 秒复位）
- + errorText 内联错误条 + 重试按钮。这个模式后来成为全项目标准做法。
- 排障手法：auth.uid() = current_setting('request.jwt.claim.sub')，可建临时 SECURITY DEFINER
- 探针函数里 PERFORM set_config(...) 再调业务函数，在 SQL 侧复现端上行为。

_提交时间：2026-10-14 20:00:00_

## R9 · SQL 落库 + 变更必须成文件

- 落实 sql/fix-admin-review.sql：列引用全部加表别名。探针验证返回 11 行，歧义报错消失。
- 清理 4 个临时探针函数；排障时被改动的订单 #2 还原为 pending。
- 确立规矩：所有数据库变更必须同时落成 .sql 文件，否则重建环境会退回旧语义
- （后来在 R13 真的因为这个吃亏）。

_提交时间：2026-10-14 22:46:00_

## R10 · 云环境选型建议

- 数据库类型选 PostgreSQL 数据库（另一个"云数据库"是文档型 JSON + .watch()，
- 选它等于整个后端重写）；套餐免费体验版；地域上海。
- 重要提醒：新建环境是空库，和 WorkBuddy 云服务的库不互通，修不了正在修的 bug。

_提交时间：2026-10-14 23:00:00_
