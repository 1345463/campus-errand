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

## R11 · 结算 / 租赁 / 用户协议

- orders 新增 runner_done_at / feedback_text / feedback_at / feedback_status / admin_note / is_special；
- profiles 新增 agreed_version / agreed_at；新表 rental_requests。
- 新函数 confirm_order_done / submit_settle_feedback / admin_list_feedbacks /
- admin_resolve_feedback / submit_rental_request / list_my_rental_requests /
- admin_list_rental_requests / admin_set_rental_price / admin_create_rental_order / accept_agreement。
- complete_order 语义改造：从"直接结算"改为"接单员标记送达 → waiting_confirm"，
- 这是整个订单状态机的关键转折。
- room-picker 去掉面板上的 catchtouchmove（会拦掉三列 scroll-view 的 touchmove）；
- 三列末尾加"其他" + 自定义输入框。
- 新页面 pages/agreement/index、pages/admin/settle、pages/admin/rental、pages/rental/apply。
- utils/agreement.js：VERSION + 9 节正文，登录后 agreed_version 不等于当前版本强制跳协议页。

_提交时间：2026-10-14 23:30:00_

## R12 · 微信上传失败 + check-mp.js

- 关键排障手法：WorkBuddy 前端日志 renderer.log 藏着微信 CI 的真实报错，
- 搜 [miniprogram:publish] publish failed，字段 raw= 是完整错误，displayed=cleaned 是洗过的。
- 根因：utils/api.js 里 completeOrder 被声明了两次（275 行、284 行）。
- 为什么 node --check 全绿却上传失败：非严格 Script 里顶层函数声明是 var 作用域，
- 重复声明合法；微信 CI 用 Babel 按 ES Module 解析，模块顶层函数声明是词法声明 → 直接编译失败。
- 只有 new vm.SourceTextModule(src)（--experimental-vm-modules）能抓到。
- 顺带修第二个隐患：node_modules 5.89MB > 主包 2MB，packOptions.ignore 加 node_modules；
- SDK 产物落到 miniprogram_npm/@tencent-ai/workbuddy-cloud-sdk/miniprogram.js（CJS）。
- 结果：上传体积 0.69MB / 65 文件。固化工具 tools/check-mp.js（7 项检查）。

_提交时间：2026-10-15 10:00:00_

## R13 · 试用版发布 + 授权机制

- 分享面板显示"试用版 已发布"，有效期至 2026/10/29，当前版本试用版支持"解绑"。
- 试用版没有成员管理界面，用户找不到是正常的。授权是拉取式的：
- 分享二维码 → 对方扫码 → 首次触发"申请体验权限" → 创建者在微信服务通知里批准。
- 三条硬限制：14 天有效、最多 15 人体验、一个微信号最多建 5 个，不能转正式版。
- 排障技巧：忘了管理员是哪个微信号时，用不常用微信扫预览码申请体验，
- 哪个微信号收到"小程序体验成员申请"，哪个就是管理员。
- 风险：管理员口令硬编码在包里，本质是调试后门。

_提交时间：2026-10-15 11:00:00_

## R14 · 二进制直传通道（utils/upload.js）

- 现象：选文件/拍照都一样，toast：createMiniProgramFetch: 暂不支持非字符串 body。
- 根因（SDK 层缺陷）：@tencent-ai/workbuddy-cloud-sdk 小程序适配层 createMiniProgramFetch()
- 只实现文本请求，body 非字符串直接抛错；cloud.storage.upload() 走 ArrayBuffer 分支 → 必抛。
- 修复：新增 utils/upload.js，绕开 SDK fetch，用 wx.request 原生二进制直传。
- 端点与请求头逐一对齐：POST {endpoint}/.cloud/storage/object/runtime/{objectPath}，
- header x-wb-webapp-access-key + Authorization + X-Client-Info: storage-js/2.112.3。
- 兜底：主通道失败改走 wx.uploadFile multipart；401/403 不兜底；>1.2MB 先压缩到 60。
- 用户真机回报：上传已正常 → wx.request 传 ArrayBuffer 这条通道在真机确实可用。

_提交时间：2026-10-15 12:00:00_

## R15 · 证件照读取 + 失败原因可见

- 根因两层：getSignedUrls 任何失败都只 push 空串，真实原因全丢；底层签名链接接口报错。
- 本项目反复出现的同一类毛病：不要让失败只剩一句通用文案。
- 修复：utils/upload.js 新增"带 token 直读字节"通道 —— 上传用的就是同一套鉴权，
- 只差一个 GET，而上传在真机已验证成功。
- downloadBuffer → 字节 → writeFileSync 本地路径 → 不用 base64
- （setData 单次上限 1MB，1MB 图 base64 就是 1.37MB，会直接炸），兜底二才退 data URL。
- getSignedUrls 改为返回 [{url, error, signError}]（破坏性变更，调用方已同步）。

_提交时间：2026-10-15 14:00:00_

## R16 · 可见表面统一白底描边

- 根因：.field-input 底色 #F7F8FA 与页面底色 #F5F6F8 几乎同色（差 2/255）→ 隐形；
- 加上 .login-wrap 的 text-align:center 被输入框继承，占位文字居中更像标题。
- 确立全局规则：页面上所有可见表面统一用白底 #FFFFFF + 2rpx solid #E3E6EB 描边，
- 灰底页面和白底卡片上都成立，一套规则通吃。

_提交时间：2026-10-15 16:00:00_

## R17 · 输入框盒子几何挪到外层 view

- 发现方式：装 pngjs 解 PNG 做色值直方图 + 逐行扫描，用已知尺寸元素标定 px/rpx
- （本例 750rpx = 820px，1rpx ≈ 1.093px）。
- 实测：占位文字字高应为 ≈25rpx 只剩 13.7rpx；输入框高度应为 86rpx 只有 55rpx。
- 26×2 padding + 2×2 描边 = 56rpx ≈ 实测 55rpx → 盒子只剩 padding 和描边，内容高度塌成 0。
- 根因：小程序给 input 自带约 1.4em 固定默认高度；同时加 padding:26rpx 与
- box-sizing:border-box 时 padding 从这个固定高度里扣，height(auto) < padding+border 就钳成 0。
- 修复决策：盒子几何从 input 挪到外层 view（.login-box 负责 flex/height/padding/描边，
- .login-input 只留 flex/字号/颜色）。这是 renderer 无关的稳妥写法。
- 顺手修掉同一类"隐形表面"缺陷（.room-picker/.custom-input/.quick-item/.task-card 等）。

_提交时间：2026-10-15 17:00:00_

## R18 · 图片改存 PostgreSQL

- 现象：证书照片三条读取通道全报 404 STORAGE_OBJECT_NOT_FOUND。
- 排查到底：MCP 列存储确认对象确实在（31001 字节、路径逐字符一致、owner_id 正确）；
- storage.objects 表的 version 字段为空字符串；请求头/路由/TTL/路径校验/编码策略全核对无误。
- 结论：写能成、读不回来，平台侧故障。方案：图片改存库。
- 新表 public.media_assets（RLS 开启且不建任何策略 → 客户端不可直连）；
- save_media_asset(scope, mime, data) → bigint，长度上限 2,600,000 字符（≈1.9MB 原图）；
- get_media_asset(id) 仅本人或管理员可见；路径格式 asset:<id>，旧对象路径仍走旧通道兼容。
- 自查出两个真问题：wx.compressImage 返回的临时文件不一定带扩展名（按 target 猜会把
- png 误判成 jpeg）→ resolveMime(原图, 压缩产物)；客户端上限 8MB 但服务端折算只有 1.9MB
- → 对齐 MAX_UPLOAD_BYTES = 1900*1024 + 两级压缩（60 不达标就从原图再压 35，不叠加压）。
- 通用经验：小图（≤1.9MB）存 text 列比对象存储更可靠，还天然带上行级权限。

_提交时间：2026-10-15 20:43:00_

## R19 · 内容安全 + 订单举报

- 三层拦截：① 发布页输入时本地实时检测（utils/moderation.js）；② 提交前再扫一次；
- ③ 服务端 create_order / submit_rental_request 必扫 —— 只有第三层能拦绕过页面直调接口的人。
- 词库不能写死在前端：moderation_words 表（292 黑名单 + 4 白名单 / 13 类），
- 客户端经 list_active_moderation_words 拉缓存（30 分钟），改词无需重发小程序。
- SQL 与 JS 的 normalize 必须逐字符一致（全角转半角 → 小写 → 繁简/带调拼音折叠 →
- 剔除非 CJK/字母数字 → 子串匹配），已用 14 条样本逐条比对两端结果一致。
- 白名单机制：本平台叫"校园跑腿"，词库里"代跑"会把"帮我代跑腿买饭"误拦 →
- 加 severity='allow' 词条，扫描前先从文本里删掉再匹配黑名单。逐字段扫描、不拼接后扫。
- 发单改走 RPC 由服务端定 owner_id（防冒名）。配套 DROP POLICY orders_write_own
- 故意先不执行 —— 旧版小程序还在用 orders.insert，过早收口会导致线上发布功能整体失效。
- 新增 pages/admin/reports 处理举报。

_提交时间：2026-10-15 21:49:00_

## R20 · 挂牌价后台化 + rental_items

- 标题乱码：encodeURIComponent(item.name) 拼进 URL，onLoad 直接展示就成了 %E5%A4%A7...。
- 规则：凡是从 URL 参数取来要展示的字符串，先解码再渲染。
- 租期 chip 重叠：chip 是行内 <text> 直接塞进 block，行内元素的 padding 不参与行盒高度计算
- → 背景与上一行文字叠在一起。修法：<view class="chip-row"> flex-wrap 容器 + .chip nowrap。
- 取件快捷标签：六个地点放 utils/config.js 的 pickupShortcuts，改配置即可增删；
- NO_SHORTCUT_LABELS 排除要填房间号/窗口号的字段。
- rental_items 表：机型清单原写死在 utils/services.js，改价要重发小程序。
- 建表 + list_rental_items（公开读，不校验登录 —— 逛租赁页不该要求登录）
- / admin_list_rental_items / admin_update_rental_item / admin_create_rental_item。
- 前端失败时退回打包清单 + 顶部明确提示"价格可能是旧的"。
- 下架 ≠ 删除（历史申请仍引用 item_id）；改价要点保存才生效（金额敏感）。

_提交时间：2026-10-15 22:44:00_

## R21 · 软删除（order_hides）

- 方案：public.order_hides(order_id, user_id)，只记"谁隐藏了哪一单"。
- 不做物理删除 —— 订单是双方共有的，一方删不能影响另一方；结算/举报核查/审计都要用。
- 新增 hide_my_order / restore_my_order / my_order_hidden / list_my_hidden_orders；
- cancel_order 补写 finished_at（否则取消的单永远算不满 7 天）；orders 加 takedown boolean
- （区分"发布方自己取消"和"管理员违规下架"）。
- 后续改为"整单生效"：list_my_orders 的过滤从 AND h.user_id = v_uid 改为不带人，
- my_order_hidden → order_hidden，restore_my_order 清掉该单所有人的隐藏记录。
- 这里的坑：改了库但 .sql 文件本体一直没改（add-order-delete.sql 与线上不一致），
- 症状是"A 删单后 B 的列表仍在，B 点进去却是已删除空态" → 已改文件 + 加幂等迁移。

_提交时间：2026-10-15 23:30:00_

## R22 · 全站大改版（权限/灰度/消息）

- 数据库：
- - admin_grants(user_id, perm_key, granted_by)：七级权限，配套 admin_has_perm /
-   admin_can_grant / admin_my_perms / admin_search_staff / admin_set_perm；
-   super 在 admin_my_perms 里被展开成全部七项，存量 3 个 is_admin 用户自动补 super。
- - feature_flags：14 个开关，默认全关，只有 super 能切。
- - 六张新表：banners / messages / order_reviews / point_records / wallet_records / user_feedbacks；
-   profiles 加 runner_score_sum / runner_score_count。
- - 消息用触发器挂钩，不改动已跑通的订单函数：trg_order_notify / trg_rental_notify /
-   trg_cert_notify / trg_report_notify；确认完成那一步同时写钱包流水 + 通知，保证成对出现。
- - list_my_orders 加 limit/offset（先 DROP 再 CREATE，因为改了参数签名）；
-   新增 search_my_orders / my_order_review_state / admin_dashboard_stats / list_my_feedbacks。
- 前端：
- - 新内核 utils/flags.js（缓存 5 分钟、拉不到一律按关闭）、utils/perms.js。
- - 新增页面 admin/staff、admin/flags、admin/dashboard、admin/banners、admin/feedback、
-   mine/messages、mine/cert、mine/mall、mine/feedback、order/review、mine/profile。
- - 轮播图走公开读通道：upload.publicAssetToLocalFile → RPC get_public_asset
-   （服务端限定 scope='banner'）。不能用 getSignedUrls，那是 owner-only，游客读不到。

_提交时间：2026-10-16 01:08:00_

## R23 · 积分/商城/评价/实名

- confirm_order_done：确认完成时按赏金 1:1 发积分（后来在 R26 改为记在下单人账上）。
- accept_order：runner_name 改用实名认证申请的 real_name（LEFT JOIN LATERAL
- runner_applications status='approved'）。
- update_my_profile(p_nickname, p_avatar_path) 签名变了（原单参数版本已 DROP）；
- 用户名 2-16 字；头像只收本人上传的 asset:<id>。
- get_public_asset 放开 scope IN ('banner','avatar')。
- 新表 point_goods + point_redemptions；profiles.boost_until；
- RPC list_point_goods / exchange_point_goods / list_my_redemptions / my_boost_active。
- 反馈提交按钮无效的真因：写了 ui.showLoading(...)，而 utils/ui.js 导出的是 loading，
- 取到 undefined 一调就抛异常整段中断。
- buildTimeline：「确认完成」节点只在 status==='done' 时出现 —— cancel_order 与违规下架
- 都会写 finished_at，只看时间戳会让下架单凭空多出"赏金已结算"。
- 接单员实名卡片改为 canSeeRunnerName（参与方/管理员）才显示，大厅路人看不到别人实名。
- 所有零散后台入口收进 admin/dashboard，"我的"页只留"管理员口令"+"管理员工作台"。

_提交时间：2026-10-16 01:30:00_

## R21-补 · 全页面审查

- 已修：pages/orders/list.js 向未声明的 errorText 写值；utils/config.js 删掉明文管理员口令
- （会被反编译看到）；getSignedUrls 串行 await → Promise.all；"我的订单"四个 chip 补选中态。
- 仅提示未动：config.js 的 rememberPassword/autoLogin/presetAccount 仍为调试态 ——
- 用户还在联调，擅自关会打断测试。

_提交时间：2026-10-16 10:30:00_

## R24 · orders 写守卫 + 更新管理器

- 背景：这是 must-after-publish 的动作 —— 旧版小程序是客户端直写 orders 表发单，
- 这条策略是它唯一写通道，删早了没更新的用户发不了单。
- 让这条 DROP 不再紧急：sql/add-order-write-guard.sql 加 BEFORE INSERT 守卫，
- ① 只能给自己发单 ② 伪造 status/runner/时间戳一律复位成 pending ③ 重跑 scan_moderation_words。
- 设计原则 fail-open：整个函数体包在 EXCEPTION 里，WHEN raise_exception THEN RAISE，
- WHEN OTHERS THEN RETURN NEW —— 守卫出任何意外都退回原行为，绝不卡住发单。
- app.js 新增 checkUpdate()：wx.getUpdateManager() 检测到新版立刻下载并弹窗重启。
- 关键手法：默认 session 的 current_user 是表 owner 且 rolbypassrls=true，直接测会被 RLS 放过，
- 必须 SET LOCAL ROLE authenticated 才是真实前端语义。
- 重要发现：INSERT 报 row-level security 被拒；UPDATE 不报错但影响行数 = 0 ——
- 所以用 GET DIAGNOSTICS ROW_COUNT 判才是准的，只 catch 异常会误判为"没拦住"。
- 复核：create_order（SECURITY DEFINER）在 authenticated 角色下照样能发单成功。

_提交时间：2026-10-16 11:00:00_

## R25 · 第四轮（积分归属/大厅门槛）

- 关键 bug：wx:for 循环变量名写错。pages/admin/dashboard.wxml 里 wx:for="{{entries}}"
- 没写 wx:for-item="entry"，但标签内全用 {{entry.icon}}。WXML 默认循环变量叫 item，
- 于是所有字段取到 undefined —— 页面不报错，只渲染出"只剩 > 箭头"的空白行。
- 这类错误永远不报错，只能靠扫：正则找 wx:for → 检查有没有 wx:for-item →
- 比对紧随其后 400 字内 {{变量.}} 用到的变量名。
- 积分归属改为下单人（用户明确要求）：confirm_order_done 改为记在 owner_id 账上，
- 赏金仍打给接单员钱包；站内消息拆成两条。
- 新增 order_peer_credit(p_order_id)：参与方互看信誉分，非参与方且非管理员直接抛错。
- 新增 admin_is_any()、is_certified_runner()。
- orders_read_all 从 USING (true) 收紧成参与方/认证接单员/管理员 ——
- 原来任何登录用户都能直读大厅全部任务（标题/描述/取件地点/发布人）。
- 三档实测：未认证用户可见 0 行、认证接单员 18 行、管理员 18 行。
- 首页大厅加门槛：checkRunner() 先判登录 + 接单员资格，不达标渲染锁定卡，完全不拉取。

_提交时间：2026-10-16 11:44:00_

## R26 · 第五轮（去重入口）

- 上一轮把"认证进度"收进"成为接单员"页时做成了两个入口（顶部卡片 + 底部按钮）。
- 重写为单卡结构：wx:if="{{!showForm || certStatus === 'rejected'}}" 的进度卡是全页唯一入口。
- "我的"页顺手扫出三处同款重复并合并："我的评价" → 保留"我的订单"里的待评价 chip；
- "我的信誉分" → 保留统计栏格子；"头像与用户名" → 保留头像区（goProfile 里判灰度）。
- 复核脚本思路：wxml 里统计每个 bindtap 的出现次数 → 映射到该函数里的 navigateTo url →
- 按 url 聚合。

_提交时间：2026-10-16 13:20:00_

## R27 · 客服工单双向对话

- 新表 feedback_replies；user_feedbacks 加 user_seen_at / admin_seen_at 两个已读水位。
- 列表接口改返回类型（加 reply_count / unread_count / last_reply_at / last_role / last_preview），
- 必须先 DROP 再 CREATE。
- 会话接口（客服与用户共用同一套，服务端按 support 权限或 owner_id 判定可见性）：
- feedback_detail / feedback_thread / feedback_reply / feedback_mark_read / admin_reopen_feedback。
- 对话开放规则：pending → 只有客服能说，且第一条回复＝受理；resolved → 双方都能说；
- rejected → 双方都不能说，客服先"重新受理"。
- 四个踩坑：
- 1. SELECT ... FOR UPDATE 在 RLS 环境会报 permission denied，取缔行锁并注释写清原因。
- 2. 冒充用户自检时不能直读业务表（SET LOCAL ROLE authenticated 后 SELECT 直接 42501），
-    状态一律走 SECURITY DEFINER 接口读。
- 3. now() 在事务内是同一个事务时间戳。自动受理时若顺手把 admin_seen_at 推到 now()，
-    同一事务里用户后来发的追评会被判成"已读"，客服未读数永远是 0。
-    → 已读水位只由 feedback_mark_read 负责。
- 4. plpgsql 里 BEGIN ... EXCEPTION 捕获异常会回滚该块内的所有修改。
- 前端新建 pages/feedback/thread：两端共用这一个会话页，10 秒轮询（onHide/onUnload 清 timer），
- scroll-into-view 定位最新一条（setData 后延 80ms 再滚）；不能发言时底部换成说明文案。

_提交时间：2026-10-16 13:58:00_

## R28 · 第六轮（大厅/佐证/抵扣券）

- 数据库：
- - orders 新增 deliver_images text[]、pickup_building/floor、deliver_building/floor、
-   discount_code、discount_amount；索引 (status, deliver_building, deliver_floor, created_at DESC)。
- - point_redemptions 新增 used_by / order_id；point_goods 新增 benefit_type
-   （deduct 抵扣 / verify 核销 / auto 自动生效）与 deduct_value。
- - create_order 扩到 17 个参数：赏金 < 1 元直接 RAISE EXCEPTION；抵扣券只认
-   "本人 + unused + benefit_type='deduct'"，v_discount = LEAST(deduct_value, reward)。
-   抵扣只记在订单上，接单员仍拿全额赏金（差价平台承担）。
- - complete_order(p_order_id, p_images)：灰度 deliver_photo 开着时必须 1–3 张，关着时可选；
-   只认 ^asset:[0-9]+$。
- - get_order_detail：非发布方/非接单员/非管理员 → images、deliver_images 置空、contact 置空串。
- - 积分商城后台（全部 admin_has_perm('settle')）与用户端 list_my_coupons。
- 本轮最大的坑：私有图读不到。get_media_asset 的条件是 owner_id = 调用者 OR is_admin，
- 但订单里的图天然跨人 —— 任务图是发布方传的、送达佐证是接单员传的，对方根本读不出来。
- → 新增 get_order_asset(p_asset_id, p_order_id)：① 调用方是这一单的发布方或接单员（或管理员）
- ② 这张图确实挂在 orders.images / deliver_images 里，两道条件缺一不可。
- 前端配套 upload.orderAssetToLocalFile/DataUrl + api.getOrderImageUrls(paths, orderId)。
- 以后凡是"订单相关的图"都不能用 getSignedUrls。
- 前端：新建 pages/hall/index（接单员门槛锁卡、服务类型/排序、楼栋楼层 picker、上拉分页）；
- pages/index/index 清掉列表与筛选，只留一个"任务大厅"入口卡；onLoad 不发请求。
- pages/mine/profile 支持 ?force=1：wx.enableAlertBeforeUnload 拦返回与右滑手势。
- 新建 pages/admin/points：商品管理 / 积分调整 / 兑换核销 三个 Tab。
- 灰度新增 hall_building_filter、coupon_deduct、deliver_photo；
- hall_page 开关被删除 —— 大厅是任务列表唯一入口，关掉等于直接下掉功能。

_提交时间：2026-10-16 22:38:00_

## R29 · 第七轮（多单发单 + 修复）

- 数据库（sql/add-round7.sql）：
- - profiles 加 owner_score_sum / owner_score_count / credit_strikes；
-   orders 加 boosted / batch_no 及 orders_dispatch_idx；新增 parse_addr_part()。
- - create_order 扩为 19 参（含 p_boost_code、p_batch_no），赏金 < 1 抛错，
-   boost 券核销置 boosted。
- - admin_batch_create_orders(..., jsonb)：≤50 笔，生成 batch_no；admin_list_dispatch_orders()。
- - admin_handle_report 加 status='pending' 守卫，防同一条举报重复处理重复扣信誉分。
- - submit_order_review 改双轨：给接单员累 runner_score_*，给发布方累 owner_score_*。
- - my_credit_summary / order_peer_credit 拆分 owner/runner 分 + credit_strikes。
- - list_hall_orders RPC：按 o.boosted OR pf.boost_until > now() 置顶、楼栋/楼层筛选、
-   count(*) OVER() 分页。
- - exchange_point_goods / list_my_coupons 兼容 boost；历史订单 deliver_building/floor 回填。
- 前端：
- - utils/perms.js 加 dispatch；utils/flags.js 加 admin_batch_order(220)、order_boost(230)。
- - 新建 pages/admin/dispatch（批量发单 + 批次列表）。
- - pages/mine/mall 券列表 + 历史兑换码复制按钮。
- - pages/order/detail 的 previewImage 按 data-group 分组取图（任务图 / 送达佐证）。
- - pages/order/create 优先券选择器；pages/hall/index 改 RPC + .hall-boost 标记。
- - pages/mine/credit 双轨分 / 违规次数展示。
- 校验：角色化 DO 块自检全过且全部回滚（批量发单 3 笔/空/低赏金/越权；优先券核销 +
- 不可复用 + 类型隔离；楼栋筛选命中只传地址的旧单；举报下架 strikes 0→1 且重复被拒；
- 双轨评分 5★改 runner、3★改 owner、重复/0★被拒），脏数据 0；
- 50 个 JS node --check 通过，verify-mp.js 通过，check-mp.js 1.13MB/2.00MB 通过。

_提交时间：2026-10-17 00:54:00_

## 文档 · 迭代全记录 + 校验体系

- 把 29 轮迭代的完整过程、踩坑知识库、数据库演进、页面与函数清单沉淀成文档。
- 固化三件套校验：node --check（全量语法）→ verify-mp.js（页面注册/四件套/事件绑定）
- → check-mp.js（微信上传预检 + 真实包体积，必须 ESM 解析）。
- 遗留事项：admin_grants 的 dispatch 权限需超管在「人员与授权」手动给现有发单员开通。

_提交时间：2026-10-17 01:10:00_

## R30 · UI v3 重构（10-17 12:19，提交信息标为 R31）

- 自定义导航栏三约定：`navigationStyle: custom` + `<nav-bar>`；`navTotal` 从 `motion.systemInfo()`
  取不写死；首屏自己让位；子页面 `showBack` + 返回失败兜底 `switchTab` 首页。
- 动效与触感统一走 `utils/motion.js`，页面不再直接调 `wx.vibrateShort`。
- 吸顶筛选 / 悬浮发单 / 骨架屏 / 触感反馈一并落地。

## R31 · 页面命名空间 class 定义（10-17 12:21）

- 每个页面加一层命名空间 class，隔离通用类名污染。

## R32 · v2 设计系统统一全站 + 广告图排版重写 + 样式预检闸门（10-17）

- 校园蓝 #2E7CF6 + 活力橙 #FF8A3D 令牌化，写在 `app.wxss` 的 `page{}`，覆盖层放文件末尾。
- 轮播广告 2.5:1（容器 710×284rpx / 上传 1500×600）。
- `scripts/make_banners.py` 排版引擎重写：测量 → 堆叠 → 居中，自动查墨迹盒交叉。
- 新增第 4 道闸门 `tools/style-lint.js`，**三件套升级为四件套**。

## R33 · 头部白弧 / 待办卡片 / 设置二级页（10-18）

- `.mine-hero` 底部内边距 40rpx → 96rpx，越过白弧。
- 待办卡片改为每行 3 个分组渲染 + 固定宽度；`.disabled .quick-title` 改用 `var(--t3)`。
- 新增 `pages/mine/settings`，「我的」菜单 12 → 9 项。

## R34 · AI 智能客服：FAQ 固定回答 + AI 流式兜底 + 转人工工单（10-22 20:48）

- Knocket 否决（web-view 需自有备案域名 + 个人主体不可用）→ 自建。
- 表 `faq_items` / `faq_settings`；7 个 SECURITY DEFINER 函数；开关 `ai_support`。
- 新页面 `pages/mine/support` / `pages/admin/faq`；灌 7 条种子 FAQ。
- 端上禁用 `for await ... of`，改手写 `iterator.next()`。

## R35 · 会话滚动与上下文修复 / 入口收敛 / 模型 API 参数后台化（10-22 21:44）

- 滚动改 `scroll-top` 递增 + throttle + 贴底判定；会话区绝对定位。
- 新增 `buildHistory()` 携带最近 N 轮上下文；加 `timeout_ms` 超时中断。
- 删除设置页「联系客服」行与 `config.support`。
- `faq_settings` 加 5 个模型参数列，管理端新增「模型 API 配置」卡片 + 测试连接。

_提交时间：2026-10-22 22:50:00_

## R36 · 客服会话滚动彻底重做：废弃 scroll-view，改整页滚动 + 固定输入区（10-23 14:50）

- 症状：调试条显示「消息 3 条 · 已滚到锚点」，屏幕却只显示最后 1 条、上方约 450px 空白。
  数据层没问题，是滚动容器高度算错，滚到底的动作发生在比真实视口高得多的容器里。
- scroll-view 上试过四种写法全部失败：`scroll-into-view` 滚空、`scroll-top` 塞大值把内容
  顶上去留一片空白、塞实测高度踩空量高度时机、`min-height:100%` + `flex-end` 在 scroll-view
  里没有可参照高度。
- 最终方案：会话列表改普通 view，滚动交给页面（`wx.pageScrollTo({scrollTop:999999})`，
  超界由框架夹取）；输入区 `position:fixed` 钉底部（textarea 需 `fixed="{{true}}"`）；
  列表底部留白 `bodyPad` 按输入区实测高度算，自增高时节流 200ms 跟随。
- 贴底判定改 `onPageScroll`（文档高 − 窗口高 − scrollTop < 60），没量到就不下判断；
  键盘弹起 `bindfocus` 拉到底。
- 顺手：`tidyText()` 清洗气泡文本（模型输出首尾换行会把气泡虚高）。
- 待办：确认后删掉 `.sup-debug` 三处临时调试代码。

_提交时间：2026-10-23 14:50:00_

## R37 · 第五轮滚动修：scroll-view 显式像素高度 + 输入区回文档流（10-23 15:20）

- 用户判据：「我发的内容会跟在后面，但回答的内容永远会出现在下一页」—— 落点系统性错位。
- 全面审阅定位三处：① `pageScrollTo(999999)` 的 `fail` 被静默吞掉；② 贴底判定用
  文档高−窗口高，自定义导航下 windowHeight 与真实可视高对不齐，算错一次就永久不滚；
  ③ 固定输入区 + bodyPad 等高留白 = 一整块空白。
- 最终方案：整页不滚动，scroll-view 高度给死成像素（窗口高 − 导航条 − 调试条 − 热门 − 输入区）；
  输入区回文档流不固定不留白；滚到底双保险（scroll-into-view 走 setData 回调 + scroll-top 实测值）；
  贴底判定改用 bindscroll 的 detail.scrollHeight/scrollTop；新消息强制置 _atBottom=true。
- tidyText 收紧（全角空格归一、连续空行压单行），R36「别用 scroll-view」的结论作废。

_提交时间：2026-10-23 15:20:00_

## R38 · 整页重写：彻底弃用 scroll-view，普通文档流 + 固定输入区（10-23 16:50）

- 用户截图判决：调试条显示「内容 1053 · 各条高[87,78,137]」——内容 1053px，消息才 302px，
  751px 幽灵高度卡在消息之间。scroll-view 内容层被撑开，前五轮补丁治不了根，用户要求直接重写。
- 最终方案：删掉 scroll-view，消息放普通 view（内容高度 = 消息之和）；整页滚动 + wx.pageScrollTo
  （优先实测位置，量不到兜底 999999）；输入区 position:fixed 钉底部；chatPad = 输入区实测高 + 24px。
- 贴底判定用 onPageScroll 的 scrollTop + 量出的文档高窗口高；新消息强制 _atBottom=true。
- 删掉三处临时调试代码（debugInfo / sup-debug / measureLayout）。
- 业务逻辑零改动：FAQ / AI 流式 / 上下文 / 违规词 / 配额 / 转人工全部保留。
- 根因结论：scroll-view 内容高度是基础库黑盒，六轮全试过（flex:1/auto/height:0/scroll-into-view/
  scroll-top 大值/scroll-top 实测），全都有失效方式。整页滚动内容高度物理上不可能出幽灵。

_提交时间：2026-10-23 16:50:00_

## R39 · 合入 codex/fix-orders-support 分支（10-23 23:40）

- 从 GitHub 快进合入 3 个提交：订单工作流 20 项 + 客服可靠性 18 项 + 测试/CI 基建。
- **根因修复**：客服页消息空白来自 `app.wxss` 全局 `.home, .mine { min-height: 100vh }`
  与消息行 class `mine` 撞车 —— 每条自己发的消息被撑到一屏高。类名改 `msg-mine` / `msg-peer`。
- 订单：list_my_orders_v2 服务端分页筛选、请求序号防乱序、登录草稿返回、放弃接单、
  送达照片可空、联系方式校验、赏金两位小数。
- 客服：键盘高度适配、服务端配额、FAQ 单字误命中、空气泡、Promise.race 超时、会话本地保存。
- 安全：删除明文密码存储；accept_order 补认证校验 + 禁止自接自单；completeOrder 不再前端硬拦。
- 后台：工作台入口不再被自身开关挡死；设置页新增后台密码入口。
- 配置：project.config.json 填真实 appid，.agents 加入 packOptions.ignore。

## R40 · 审阅补漏：图片越权 + 权限键对齐（10-23 23:40）

- P0-1 图片越权：新增 sql/fix-asset-authorization.sql —— orders 表加触发器校验
  asset:<id> 归属；get_order_asset 补「图片必须属于本单参与方」第三道校验。
- P0-4 getOrder 改只取非敏感字段；评价页改用 getOrderDetail（服务端脱敏）。
- P1-3 评价页 goBack 改 fail 回调（try/catch 兜不住 navigateBack 失败）。
- P1-4 举报权限键三处统一到 review（dashboard 卡片/入口 + reports 门禁 + 服务端）。
- P1-5 admin_dashboard_stats 补 v_dispatch / can_dispatch，第八级权限可用。
- 清理评价页 require('../../utils/cloud') 裸调兜底死代码。
- 校验：四件套 + UI 冒烟全绿；npm test 36 项全过；1.34 MB / 2.00 MB。

## 数据库迁移已执行（10-23 23:58）

- 通过 `workbuddy_cloudservice_db_exec_sql` 直连真库（`wbapp_yPJnSvicojPmz998PjKfpM`）执行三个迁移：
  1. fix-order-support-workflows.sql — 7 个 RPC + 3 张表，RLS 全开
  2. restore-admin-password.sql — 3 张表 + activate_admin 重写
  3. fix-asset-authorization.sql — orders 触发器 + get_order_asset 归属校验 + can_dispatch
- 验证：public schema 29 张表 / 27 张开 RLS；7 个新 RPC 参数与前端调用逐一对齐。
- 执行技巧：MCP 只接受单条语句（多条报 42601），把整文件拆成语句后包进
  `DO $$ BEGIN EXECUTE $qN$...$qN$; ... END $$;` —— 单语句 + 原子执行。

## R41 · 修 FAQ 新增/编辑无效 + 审阅遗留问题（10-24 00:20）

- **FAQ 新增/编辑点击"无效"**：根因不是绑定错，是表单卡片在页面最底部（AI 设置 +
  模型配置 + FAQ 列表之后），点完新卡片出现在列表下方一两屏，屏幕没变化。
  修法：`openForm()` 走 setData 回调 + `scrollToForm()` 量 `#faq-form` 位置后
  `wx.pageScrollTo`；量不到退化滚到底。新增回归测试。
- P1-7 积分调整：加 `adjusting` 防重 + 统一二次确认（不再只在"不够扣"时弹）。
- P1-8 商品上下架：先拉最新数据再 upsert，避免把已兑换的库存写回旧值。
- P1-9 删除「生成测试申请」按钮 + makeDemo + api.insertDemoApplication。
- P1-10 报价留空当 0 元：判空串 + 必须 > 0 + 两位小数。
- P1-11 getErrorMessage 按 SDK kind 映射中文；中文业务文案（我们自己的 RAISE EXCEPTION）原样透出。
- P2 toast 超长补省略号；orders/list 补 onHide/onUnload 清理定时器；
  buildTitle 不再拿 description 当标题（避免取餐码公开到大厅）；大厅 quickAccept 加并发锁；
  FAQ 排序留空按 100。
- 校验：四件套 + 冒烟全绿；npm test 37 项全过。

## R42 · 仓库清理：移除第三方文件、重写历史（10-24 00:35）

- 删除 `.agents/`（209 文件 2.2MB）、`skills-lock.json`、`tools/web-preview/`、
  4 份第三方文档（FIX-REPORT / WEB-TEST / WECHAT-TEST / ADMIN-ACCESS）。
- 保留 tests/（37 项回归）、tools 校验脚本、CI、package.json —— 这些是发布闸门。
- 历史：R39 的三个第三方提交从 main 摘除，R39–R41 压成一条整合提交；
  改写前后文件树 hash 一致（4d86e16…），代码零改动。R1–R38 历史与 5 个 tag 未受影响。
- 同步清理 README 的 5 处死链、package.json 的 preview:web、project.config.json 的忽略项。
- 校验：四件套 + 冒烟全绿；npm test 37 项全过。

## 文档：新增「合并外部 AI 开发的踩坑与解法」（10-24 01:05）

- 迭代记录新增第 8 章，系统记录本次合入第三方 PR 的 9 个坑与解法：
  夹带第三方资料、缺依赖误判、reset --hard 文档脱节、**六轮改错方向（.mine 撞 100vh）**、
  外部 PR 不等于安全审计、权限键三处漂移、抹作者的正确姿势（树 hash 校验）、
  迁移工具全限定名 + DO 块包、前后端 RPC 对照。
- 附「合并外部 AI 改动的 SOP」7 步与一句话总结表。
- 顺带修正第 7 章过期描述：AI 配额已从本地 storage 改为服务端记账。

## R43 · 修「text 返回的 RPC 被整类误判为报错」（10-24 01:40）

- **用户报的现象**：任务详情页整页错误态，红条写着 `runner`（发布者账号则写 `owner`）。
  这不是角色文案，是错误信息本身。
- **根因**：SDK 对响应体做 `JSON.parse`，失败时把**响应体原文**塞进 `error.message`；
  而 `RETURNS text` 的函数返回裸字符串 `runner`（不是 `"runner"`），必然解析失败。
  于是 `getOrderRelation` 拿到 error → throw → 整页进错误态，文案恰好是那个关系值。
- **同类中招 7 个函数**：order_relation / hide_my_order / restore_my_order /
  mark_message_read / mark_all_messages_read / admin_set_perm / admin_delete_banner，
  表现为弹 `granted` / `read` / `deleted` 这类看似失败的提示（其实已经执行成功）。
- **修法**：`sql/fix-text-rpc-returns.sql` 全部改 `RETURNS TABLE(result text)`
  （order_relation 用 `TABLE(relation text)`）；改返回类型走 DROP → CREATE → 重跑 GRANT。
  顺带补 order_relation 缺失的 `SET search_path TO 'public'`（原来用不限定名 orders）。
- **前端**：api.js 新增 `pickText(result, field)`；detail.js 给 getOrderRelation 单独 catch
  （身份判定失败不该让整页白屏）。
- **真库验证**：单 115 下 asOwner=owner / asRunner=runner / asStranger=none；
  markAll=read / setPerm=granted / restore=restored。
- 校验：四件套 + 冒烟全绿；npm test 37 项全过；上传包 1.35 MB / 2.00 MB。

## 文档 · README 重写（10-24 21:10）

- 仓库已转为**公开**，README 去掉「私有」标注，补「十二、许可」说明（未附许可证 = 保留所有权利）。
- 新增「一、这是一个纯 WorkBuddy 项目」：说明全程由 WorkBuddy 智能体开发，
  使用 **混元 4（Hunyuan 4）** 与 **DeepSeek V4.1 Flash** 两个模型，
  并给出「人和 AI 各做什么」的对照表与实际交付规模（37 页 / 15,697 行 JS / 29 表 / 117 函数）。
- 新增「二、项目特点」8 条：双轨信誉分、八级权限 + 22 个灰度开关、图片三通道鉴权、
  写操作单一入口（SECURITY DEFINER + RLS）、客服三层兜底、服务端分页筛选、
  危险操作二道闸、可维护性机制化。
- 新增「四、页面地图」：37 个页面逐页说明（主流程 6 / 我的 15 / 租赁与其它 3 / 后台 13 + 权限列）。
- 能力概览改为按角色（发布方 / 接单员 / 管理员 / 所有人）描述。
- 铁律补一条：RPC 返回类型必须结构化（R43 踩坑）；补 WXSS 全局 class 撞车提醒。
- 目录结构、数据库、校验、部署、Git 历史同步到最新（26 个迁移脚本 / 22 个开关 / 58 次提交 / 6 个 tag / 1.35 MB）。

## R44 · 手机号闸门 + 账号注销（6 个月保留期）（10-24 22:10）

- **手机号绑定**：新增 `sql/add-phone-and-deletion.sql`
  - `profile_phones(owner_id PK, phone UNIQUE)`，无 policy，只给 SECURITY DEFINER 函数访问
  - `bind_my_phone`：格式 `^1[3-9]\d{9}$` + 全站唯一 + 同账号 24 小时只能改一次
  - `my_phone_state` / `has_phone` / `assert_phone_bound`
- **服务端闸门**（浏览不拦，发单/接单/认证/租赁/看联系方式才拦）：
  - 触发器 `orders_assert_phone`（INSERT 订单 / runner_id 由空变非空）
  - 触发器 `runner_applications_assert_phone` / `rental_requests_assert_phone`
  - `get_order_detail` 对未绑定者把 `contact` 置空
  - 豁免：无会话（直连迁移）、`admin_is_any()`（管理员批量发单）
- **注销**：`profiles.deleted_at` + `account_deletions`（purge_after = 6 个月）
  - 前置校验：无未完成订单、钱包余额为 0、无后台权限
  - `my_account_state` / `request_account_deletion` / `restore_my_account`
  - `purge_account_data`：清除昵称/头像/手机号/证件照/联系方式，订单去标识化
  - 清理时机：登录时 `purge_my_account_if_due` + 超管工作台 `admin_purge_expired_deletions`
- **前端**：新增 `pages/mine/bind-phone`（短信验证码）；`guard.requirePhone()` 在发单/接单/
  认证/租赁/详情接单处引导绑定；设置页新增「手机号」与「注销账号」（后果逐条列清 + 勾选确认）；
  登录后检测到注销状态弹「是否使用原账号」，选不使用则退出并禁止注册新账号。
- **协议**：`utils/agreement.js` 版本 `2026.10-v1 → v2`，新增「九、手机号绑定与账号注销（重要）」。
- **测试**：新增 `tests/phone-deletion.test.js` 11 项；`npm test` 48 项全过；四件套全绿；
  上传包 1.38 MB / 2.00 MB。

## R45 · 修图片归属触发器误伤接单员（10-24 23:05）

- **现象**：接单员「放弃接单」报「图片不属于当前账号」，用户补充「提交送达时也会」。
- **真因**：`assert_order_assets_owned` 把整行的 `images`（发布方上传的任务图）与
  `deliver_images`（接单员上传的佐证）合并校验，要求全部属于 `auth.uid()`。
  接单员一更新这行，`NEW.images` 仍是发布方的图 → 必然判越权 → 整笔回滚。
  受影响的不只是放弃接单，**所有接单员侧的订单更新都会失败**。
- **修法**：`sql/fix-order-asset-trigger.sql` —— INSERT 两列都校验；
  UPDATE 用 `IS DISTINCT FROM` 只校验**本次真正改动的那一列**。
  安全性不变：越权读图边界仍在 `get_order_asset`（要求图片属于本单参与方）。
- **测试**：新增 `tests/order-assets.test.js` 5 项；`npm test` 54 项全过。
- **真库验证**：订单 76 `abandon=ok` / `complete=ok rows=1`（事务回滚，未改数据）。

## R46 · 两处布局错位（10-25 00:10）

- **订单卡片删除确认换行**：`.card-actions` 只写了 `display:flex`，没有对齐与换行策略，
  「再点一次确认删除」+「取消」各占一行。改为 `space-between` + `nowrap`，
  子项 `flex: 0 0 auto` + `white-space: nowrap`。
- **待办概览每行只显示两张、右侧留空**：`.quick-item` 宽度 `calc(33.3333% - 11rpx)`，
  三张合计 `99.9999% - 1rpx`，余量仅 1rpx，真机取整放不下第三张 →
  按 3 张分的组渲染成 2+1，7 张卡片变成 5 行。
  改为 `calc(33.33% - 14rpx)`（余量约 10rpx）。
- **今日/累计订单单独一行两张宽卡**：它们是全局数字，与待办不同量纲；
  `buildCards` 增加 `wide` 标记，`.quick-item.wide` 宽 `calc(50% - 10rpx)`，
  最终 `[3][2][2]` 三行，最后一行刚好铺满。
- **同一行内基线不齐**：左「再点一次确认删除」加粗 8 字、右「取消」常规 2 字，
  两者行盒高度不同 → `align-items: center` 也让「取消」看着偏高。
  只加 `line-height` 不够（`<text>` 组件有自己的行盒算法），
  把这两个操作项从 `<text>` 换成 `<view>`，并给子项固定 `line-height: 1.4`。
- 测试：新增 1 项（cardRows 形状必须 3,2,2）；`npm test` 55 项全过。

## 文档 · 按 R43–R46 补齐说明（10-25 00:30）

- README：灰度开关 22 → **23**（之前数错，数据库实为 23 个）、目录结构页面数 37 → 38、
  测试规模统一为 55 项。
- ITERATIONS：第 2 章标题轮次 42 → 46（前几轮只改了顶部统计，标题与目录锚点静默漏改）；
  数据表 23 → **31 张**（补 `order_abandonments` / `support_ai_requests` /
  `support_answer_ratings` / `admin_password_*` ×3 / `profile_phones` / `account_deletions`）；
  数据库函数 110 → **129 个**（补 R39 订单分页与 AI 配额、R39 后台密码、R44 手机号与注销）；
  SQL 脚本 22 → **27 个**（补 R39/R40/R43/R44/R45 六个脚本）；
  页面 37 → **38 个**（补 `mine/bind-phone`，设置页补手机号与注销入口）；
  灰度开关说明改为「23 个均已打开」；R40 段落的历史数字加注「当时统计」。
- 根目录副本已同步。

## 文档 · 全量统计二次复核对齐（10-24 23:40）

紧接上一节的文档补齐，用代码与真库重新核了一遍存量数字，把上一轮漏改的补齐：

- **README**：迁移脚本口径统一为 **28 个**（`sql/*.sql` 实际 28 个文件，此前正文写 26/27）；
  三处「37 项回归测试」旧文案统一为 **55 项**；主包 **1.35 → 1.39 MB**（176 个文件）；
  「迭代 43 轮」→ **46 轮**；Git 提交数 58 → **65 次**；
  代码行数按实算更新为 JS 16,326 ／ WXSS 4,862（WXML 4,987 未变）。
- **ITERATIONS 第 0 章概况表**：数据库 **23 张表 / 110 函数 → 31 张 / 129 个**
  （顶部统计早就是新值，概况表一直停在旧值）。
- **ITERATIONS 第 1 章**：权限 **七级 → 八级**（补 `dispatch`），并补上
  「新增 perm_key 要改三处」；灰度开关 17 → **23 个**。
- **ITERATIONS 第 3 章**：SQL 脚本清单去掉重复的 `add-feedback-thread` 一行，数量 → **28 个**。
- **ITERATIONS 第 4 章**：补漏登记的 `pages/admin/dispatch`；工具模块 15 → **16 个**
  （补 `utils/login-return.js`，R39–R41 引入）。
- **真库核对**（MCP 直连，本次全部核过）：表 31 / 函数 129 / 触发器 7 /
  灰度开关 23 个且全部 `enabled`，与文档一致；页面 38 与 `app.json` 一致，
  README「页面地图」38 行无遗漏。
- 根目录副本 `校园跑腿-迭代全记录.md` 已同步。

## 文档 · 自动任务定期复核（10-24 23:45）

按自动同步任务的要求，用代码与真库把存量数字再核一遍，并把 R45 / R46 的经验沉淀进知识库：

- **README**：主包 **1.39 → 1.40 MB**（`check-mp.js` 实测 176 个文件）；
  Git 提交数 65 → **67 次**（上一轮写的是提交**前**的计数，天然少 1，本次按提交后计数）。
  其余数字核对一致：页面 38（`app.json`）、脚本 28（`sql/*.sql`）、测试 55（`npm test`）、
  表 31 / 函数 129 / 触发器 7（真库 `pg_tables` / `pg_proc` / `pg_trigger`）、灰度开关 23 个且全部打开。
- **ITERATIONS 第 6 章**：「当前状态」同步为 56 个 JS ／ 1.40MB ／ 32 wxss + 40 wxml ／ 55 项测试
  （此前停在 58 个 JS ／ 1.31MB ／ 31 + 39，与实际差得比较远）。
- **ITERATIONS 第 5 章（踩坑知识库）** 新增两条本轮才沉淀的规律：
  ① 多角色共用一张表时触发器只校验**改动的列**（R45，整行校验会误伤接单员）；
  ② 网格宽度必须留 ~10rpx 余量、行内基线不齐要把 `<text>` 换成 `<view>`（R46）。
- 根目录副本 `校园跑腿-迭代全记录.md` 已同步。

## 文档 · 自动任务定期复核（10-25 23:30）

本轮**无代码改动**（`main` = `origin/main` = `a078452`，工作区干净），按自动任务要求
仍把存量数字用代码与真库全量核了一遍，结论是**全部一致，无需修正**：

- 页面 **38**（`app.json` pages 长度）／迁移脚本 **28**（`sql/*.sql` 文件数）／
  测试 **55**（`npm test` `# pass 55`）／主包 **1.40 MB · 176 个文件**（`check-mp.js`）／
  表 **31** ／函数 **129** ／触发器 **7**（真库 `pg_tables` / `pg_proc` / `pg_trigger`）。
- 权限键 8 个与 `admin_set_perm` 白名单一致；灰度开关 **23 个且全部 `enabled`**，
  键名与文档清单逐一对上；`feature_flags` 的主键列名是 **`flag_key`**（不是 `key`）。
- README「页面地图」38 行与 `app.json` 逐项比对**无遗漏**；ITERATIONS 第 3 章 SQL 清单
  覆盖全部 28 个脚本文件；第 4 章页面清单同样无遗漏。

**本轮唯一改动是消除一处口径歧义**（不是纠错）：
- `pg_trigger` 直接 `count(*)` 得 **11**，比文档的 7 多 4 —— 多出来的是 `storage` schema 下
  4 个系统自带触发器，业务触发器仍在 `public` 下的 **7** 个。已在下面按 schema 记明，
  下次复核别被 11 误导去改文档。
- ITERATIONS 第 6 章补口径说明，**实际有三个 JS 数字，三个都对**：
  **56 = 业务 JS**（pages 38 + utils 16 + components 2）；
  **62 = `check-mp.js` 按 `packOptions.ignore` 算出的上传 JS**（另含 `app.js` 与
  `miniprogram_npm` SDK 产物，排除 tests/tools）；
  **68 = `scripts/sync_github.py` 四件套第 1 项实际检查数**（只排除 node_modules /
  miniprogram_npm / .git，**含** tests 与 tools）—— 门禁打印的就是这个数。
  此前只有「56 vs 62」两条，看到门禁打出 68 仍会误判，故补全为三条。
- README 提交数 67 → **68 次**（按提交后计数）。
- 根目录副本 `校园跑腿-迭代全记录.md` 已同步。

## 文档 · 自动任务定期复核（10-26 23:30）

本轮**无代码改动**（`main` = `origin/main` = `136bb45`，工作区干净）。全量数字复核结论：
**全部一致，无需修正** —— 页面 **38**（`app.json`）／迁移脚本 **28**（`sql/*.sql`）／
测试 **55**（`npm test` `# pass 55`）／主包 **1.40 MB · 176 个文件**（`check-mp.js`）／
表 **31** ／函数 **129** ／业务触发器 **7**（真库，已按 `public` schema 过滤掉 `storage` 下
4 个系统触发器）／灰度开关 **23 个全部 `enabled`**。README「页面地图」与 ITERATIONS
第 3、4 章清单与代码逐项比对无遗漏。

本轮真正修的是**「文档记着风险、代码早已修好」的三条过期条目**（用 `grep` 全仓确认后划掉）：

- **第 7 章 #3 `utils/config.js` 调试态** → ✅ R39 起已解决。现值
  `rememberPassword: false` / `autoLogin: false` / `presetAccount` 为空，
  注释写明「发布配置门禁会强制这两个开关为 false、不再存储明文密码」。
- **第 7 章 #4 管理员口令硬编码 `GDYZPT2026`** → ✅ R39 起已解决。
  `activate_admin` 改为与 `admin_password_settings` 的**盐值 + SHA-256 哈希**比对，
  客户端无任何明文（全仓 `grep GDYZPT` 只剩文档这一行历史），并带 15 分钟 5 次限流 + 激活审计。
  残留风险降级为「知道口令即可自助开 super」的分发方式问题。
  同步更正第 2 章 R3 那条 R3 时代的历史描述，避免后人照着旧文去找明文。
- **第 7 章 #8 客服页临时调试条** → ✅ R38 整页重写时已清除
  （全仓 `grep sup-debug` / `debugInfo` / `measureLayout` 均为空），
  滚动空白当时已由「弃用 scroll-view、改整页滚动 + 固定输入区」根治，不再需要等确认。
- **#5 `createSignedUrl` 报错未知** → 降级：业务代码已无任何调用点（仅 SDK 注释里有），
  媒体读取统一走 `media_assets` + 三条读图通道，不再阻塞。
- **#7 试用版到期** → 升为 🔴：复核日距 2026/10/29 到期**仅剩 3 天**，
  第 0 章概况表同步标注，到期后现网不可访问。
- 顶部「统计截止」刷新为 2026-10-26 23:30。根目录副本 `校园跑腿-迭代全记录.md` 已同步。

## 文档 · 发布状态转为「企业主体审核中」（10-27 13:40）

- README 头部新增「📦 当前发布状态」：企业主体小程序已绑定、微信审核中；
  说明此前的 WorkBuddy 试用版（微信试用小程序：14 天 / 15 人 / 不能转正式版）已结束。
- README「九、部署」补「发布通道」段与提审前置材料清单（备案 / 隐私指引 / UGC 声明 / 企业类目）。
- ITERATIONS 第 0 章「发布状态」改写；风险清单第 7 条由 🔴 待处理改为 ✅ 已转企业主体。
- `docs/RELEASE.md` 重写为「当前通道 + 历史试用版」，保留试用版时期的排障记录作留档。

## R47 · 默认昵称「同学」绕过强制补全 + AppID 切企业主体（10-27 18:45）

- **昵称**：备份数据时发现 12 个用户里 9 个叫「同学」，订单卡片全是「发布 同学 · 接单 同学」。
  根因是 `guard.nicknameMissing()` 只判空串，而 `ensureProfile` 建号时写的默认昵称就是「同学」——
  非空 ⇒ 强制补全一次都没触发过。修法：新增 `DEFAULT_NICKNAMES = ['同学']`，
  空串 / 全空格 / 默认值都算缺失。新增回归测试，`npm test` 55 → **56 项**。
- **AppID**：`project.config.json` 由 `wxf73d4e1b04e62d79`（试用小程序）改为
  **`wxaab192c68e403292`**（i邮跑，企业主体），全仓仅此一处引用。

## R48 · 数据库全量迁至 CloudBase（10-27 18:40–22:59）

- **动因**：在线支付的回调必须由云函数处理并直接改订单状态，而 WorkBuddy Cloud 没有云函数、
  也不对外提供写库凭据。目标环境 `ceshi-d2g37cbg7c8f7ee48`（ap-shanghai，PG 模式）。
- **关键结论**：CloudBase PG 自带 `auth.uid()` 且同样返回 **text** ——
  129 个 `SECURITY DEFINER` 函数原样重放、一行不用改，迁移成本从几周降到一天。
- **验收**：32 表 / 131 函数 / 9 触发器 / 9 策略 / 23 开关全开 / 296 违规词 / 7 FAQ，
  前端 `api.js` 的 **99 个 RPC 零缺失**；33 批迁移全部 Succeed。
- **四个新坑**：`applyMigration` 必须内联传 SQL；`migrationName` 不允许数字（`round4` → `round_four`）；
  `CREATE OR REPLACE` 改不了返回类型（42P13）也改不了签名；两个脚本必须跳过
  （`fix-order-hide-scope` 会造成重载歧义、`fix-asset-authorization` 会把 R45 修正版覆盖回 R40 有 bug 版）。
- **一次误判**：中途「新库 RLS 策略只剩 1 条」被当成灾难，查原库后才知道本来就只给 5 张表
  客户端直连、其余一律 `REVOKE ALL`。判断权限缺失前先看 `pg_policies` + `role_table_grants`。
- **只剩前端换 SDK**：`cloud.js` / `config.js` / `api.js` 1784 行 + 登录改 CloudBase 微信登录。

## R49 · 在线支付打通第一步（10-27 19:06–23:30）

- **纠正错判**：支付不必等前端换 SDK —— `wx.cloud` 是微信原生能力，与 WorkBuddy SDK 并存，
  云函数可独立部署独立测试。
- **已做**：① 支付 DDL（`orders` 加 `pay_status` / `pay_txn_id` / `paid_at` /
  `settle_amount` / `settled_at` + 2 索引 + CHECK；新建 `withdraw_requests`）
  ② 抽佣后台可调：`pay_settings` + `get_pay_settings` / `calc_settle_amount` /
  `admin_update_pay_settings`  ③ 提现 4 个 RPC（`create_withdraw_request` 校验余额与门槛、
  `admin_finish_withdrawal` 失败自动退款）  ④ 云函数 **`pay-create` 部署成功**
  （零依赖，只用内置 crypto + https）  ⑤ 实测 4ms 返回 `ENV_MISSING`，链路通。
- **卡在用户侧**：`WXPAY_SERIAL_NO` 与 `WXPAY_PRIVATE_KEY` 必须用户自己在控制台填，不经对话。
- **待写**：`pay-notify`（验签 + 解密）、`transfer`（商家转账到零钱）、`transfer-notify`；
  抽佣比例待用户拍板（收款 0.6% + 提现 0.6%，平台抽 0 每单亏 1.2%）。
- ⚠️ **合规**：代收再转付易被认定「二清」，需定性为平台自营 + 向接单员付劳务报酬，
  正式运营前建议过学校法务/财务。完整方案见 `docs/PAYMENT.md`。
- 工程配套：`cloudfunctions/` 加进 `packOptions.ignore`（云函数是服务端代码，
  不进小程序包，否则 check-mp.js 会报 npm 依赖缺失并拒绝提交）。

## R50 · 微信支付打通（10-28）

- **云函数 `pay-create` 上线**：`wx.login` 取 code → `jscode2session` 换 openid →
  JSAPI 下单（商户私钥 RSA-SHA256 签名）→ 返回 `paySign` 等二次签名参数给端上拉起收银台。
- **`pay-notify` 回调**：微信 POST 过来后先**平台证书/公钥验签**，再 AES-256-GCM 解密
  `resource`，取出商户单号与金额，最后调 `mark_order_paid` 落库。
- **两道保险**：① 回调里做**金额核对**（防止被改成 0.01 元）；② **幂等** —— 同一单重复
  回调不会二次入账。
- **总闸**：`pay_settings.enabled` 关闭时 `pay-create` 直接返回 `PAY_DISABLED`，连微信
  下单接口都不碰；查询失败按「开」放行，避免监控读超时把收款停掉。
- **真金验证**：2026-10-28 实付 **0.01 元**成功，微信回调写入 `pay_status=paid`，
  且 `paid_at` 比前端收到 success 还早 3 秒 —— 证明状态是**服务端推的**，不是前端伪造的。

## R51 · 提现打通（10-29 凌晨）

- **全链路**：钱包页申请 → `svc_create_withdraw`（绑手机号校验、余额 `FOR UPDATE` 锁行、
  单笔在途检查、门槛校验）→ 扣余额 + 写 `wallet_records` → 后台审核 → `withdraw-api` 转发到
  云托管 `transfer-svc` → 微信**商家转账到零钱** → 用户确认收款 → 到账 → 状态回写。
- **解决固定 IP 难题**：云函数出口 IP 每次冷启动都变（实测连调 5 次 5 个不同 IP），
  而商家转账校验调用方 IP。改为把转账逻辑搬到**云托管**并开启「固定访问公网的出口 IP」
  （探测为 `122.51.67.142`），填进商户平台白名单。
- **失败自动退款**：任何一步失败都调 `admin_finish_withdrawal(false)` 退回余额并写退款流水，
  不会出现「扣了钱没转出去」。
- **对账兜底**：回调之外还有 `sync` 兜底查询，回调不通也能把状态对上。
- **真金验证**：2026-10-29 实提 **0.10 元**，微信侧 `state=SUCCESS`。

## R52 · 前端整体切到 CloudBase + 发单接入微信支付（10-29）

- **背景**：R48 迁完库、R49 部署好 `pay-create` 后，前端仍连旧 WorkBuddy 库 —— 回调改的是
  新库 `orders.pay_status`，前端读的是旧库，两条链路根本不在一起。
- **① 新通道 `utils/tcb.js`**：网关直连优先（`POST /api/app-api`），域名未配白名单时自动退到
  `wx.cloud.callFunction('tcb-proxy')`；**只有网络层失败才换通道**，业务拒绝不重试。
  会话改为服务端用 `WX_APP_SECRET` 签 HMAC 令牌（`v1.<payload>.<sig>`），
  验签用 `timingSafeEqual`，uid 必须 `wx:` 开头。
- **② `svc_rpc` 代持身份（关键设计）**：云函数先验令牌取可信 uid，再在**同一事务**里
  `set_config('request.jwt.claim.sub', uid)` 后执行业务函数 —— 库里 129 个按 `auth.uid()`
  取身份的函数**一行不用改**，RLS 与行级校验照常生效。前端 95 处 RPC 换通道，
  剩余 7 处裸表访问（资料 / 地址簿 / 认证申请）补成服务端函数，做到无裸表访问。
- **③ 手机号改自建验证码**：不再借道 auth provider，`phone_codes` 只存哈希、明文只回云函数，
  `bind_my_phone_verified` 把验码与写入合成一次原子调用 —— 「跳过发码直接绑号」这条路堵死，
  也不会再「绑完跳到另一个账号」。
- **④ 发单接支付**：`create_order` 自判是否要付钱（总闸关 / 抵扣满 → `paid`，其余 `unpaid`，
  应付 = `reward - discount_amount`）；`list_hall_orders` 只放已付的；端上付完必须轮询
  `order_pay_state` 确认落库，**不能只信 `requestPayment` 的 success**；未付单留在
  「我发布的」里带「去支付 ¥x」入口随时补付。
- **瘦身**：删 `utils/cloud.js` / `utils/workbuddy-cloud-diagnostics.js` / `miniprogram_npm/`，
  主包 1.44 MB → **0.94 MB**。

## R53 · 图片分片上传（10-29）

- **症状**：「成为接单员」上传身份证正面弹大写英文 `EXCEED_MAX_PAYLOAD_SIZE`，
  学生证那张小一点反而能过 —— 卡在**传输通道**而非业务逻辑。
- **根因**：网关 **HTTP 访问服务请求体上限 = 100 KB（精确 102400 字节）**，
  超了直接回 `HTTP 413`；客户端把 `code` 原样透出就成了那行英文。
  图片 base64 塞在 `args` 里，一张手机照片 1~3 MB，必挂。
- ⚠️ **第一版修错**：凭印象按「`wx.cloud.callFunction` 入参约 1MB」把片定成 **400 KB**，
  比真实上限大 4 倍，每片都必然 413，分片等于没做。**通道上限必须实测，不能靠印象估。**
- **三道线**：压缩线 420 KB（原图）／整包线 base64 64 KB／单片线 base64 80 KB（请求体约
  82 KB，留 18 KB 余量）／服务端线 690 KB。
- **实现**：`fitChannel` 阶梯压缩（70 → 55 → 40 → 25 → 15 → 8，压了没变小就收手）；
  新增 `begin_media_upload` → `push_media_part` → `finish_media_upload`；
  被拒自动降到 48 KB 重试；`EXCEED_MAX_PAYLOAD_SIZE` → 「图片太大，单次传不下，请换一张小点的图」。
- **验证**：二分探测确认上限 102400 字节；690 KB 图 → 12 片全部 200 → 读回 942140 字节，
  逐字符一致。新增 `tests/upload-chunk.test.js` 6 条，全量 **63 项测试通过**。

## R54 · 提现改服务端自动转账（10-29 深夜）

- **症状**：提现 10 元后，记录一直停在「待处理」，看起来像回退到手动版本。
- **根因是两条叠在一起**：
  1. `withdraw-api` 的 `create` 只建单，打款一直要管理员在后台点「自动转账」——
     从没做到「提交即打款」，之前两次真金实测都是人工点的。
  2. 云托管 `transfer-svc` 011 版加了 secret 硬校验，而云函数 `withdraw-api`
     **没配 `PAY_WEBHOOK_SECRET`**，转发时带的是空串 → `FORBIDDEN / secret 不匹配`。
     id=15 那次成功发生在加校验之前，所以一直没暴露。
- **改法**：抽出 `doTransfer()` 让自动打款与后台重试共用一份实现；`create` 成功后直接打款；
  `summary` 补转还停在 `pending` 的旧单（本轮就是 id=16，打开钱包页即被转走）；
  **密钥不再在控制台之间搬运** —— 环境变量没配时，云函数运行时自己读
  `pay_settings.webhook_secret`，与云托管天然一致。
- **两道人工闸门**：`AUTO_TRANSFER=0` 整体退回人工；单笔超 `AUTO_TRANSFER_MAX`
  （默认 200 元）不自动打款。
- **幂等与兜底**：`transfer_prepare` 锁单，重复调用不会重复打款；打款失败不影响申请本身，
  后台可重试或标记失败自动退款。
- **前端**：钱包页按返回的 `auto` 提示「已自动转账，请点上方确认收款」或
  「申请已提交，自动转账未成功，可在后台重试」，不再一律只说"申请已提交"。
- **校验**：新增 `tests/withdraw-auto.test.js` 6 条，全量 **69 项测试通过**；
  四件套全绿，主包 **0.96 MB**；`withdraw-api` 已重新部署到 `ceshi`。
- **踩坑**：`updateFunctionCode` 传 `envVariables` 不会落到函数配置上（查详情里没有），
  改环境变量要走 `updateFunctionConfig`；环境未开日志服务，云函数日志查不到，
  只能用 `withdraw_requests` 的状态变化做端到端验证。

## 文档维护（10-29 23:30 自动同步）

- 按代码/迁移脚本全面复核统计数字：页面 **38 → 39**；数据库函数 **129 → 154**；
  云函数 **6 → 7**（补 `app-api`）；迁移脚本 **47 → 56**；违规词库 **296 → 292**（13 大类）；
  主包 **1.41 → 0.95 MB**（183 文件）。
- README 第十章改为以「现役 CloudBase 单库」为主口径，旧库 28 条脚本标注为已退役的结构参考。
- 修正过时风险条目：钱包「未接支付、不可提现」、双库期、手机号可跳过发码，均已随
  R52 闭环；保留证书轮换、SMS 未开通、`cloudbase/` 未入版本控制等真实残留项。
- 修正钱包页残留文案（`wallet.js` 说明条、`wallet.wxml` 底部提示），不再与实际提现能力矛盾。
- CHANGELOG 补齐 R50–R53 四节（此前只写到 R49）。
