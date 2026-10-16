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
