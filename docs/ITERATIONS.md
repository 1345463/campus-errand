# 校园跑腿小程序 · 全量迭代修改记录

> 广东邮电职业技术学院校园跑腿平台 ｜ 微信小程序原生 ｜ 云端 **CloudBase `ceshi-d2g37cbg7c8f7ee48`**
> 统计截止：**2026-10-30 01:50** ｜ 累计 **57 轮迭代**、**39 个页面**、**37 张表**、**156 个数据库函数**、**9 个触发器**、**58 个迁移脚本**、**97 项回归测试**、主包 **0.98 MB**
>
> 📌 **R52 已完成切换**：前端整体从 WorkBuddy Cloud 换到 CloudBase，WorkBuddy SDK 连同
> `miniprogram_npm/` 一起删除（主包 1.44 MB → 0.94 MB）。数据访问统一走「云函数代持身份」
> 的 `svc_rpc`，库里 129 个 `SECURITY DEFINER` 函数一行未改。发单已接入微信支付。

---

## 目录

- [0. 项目概况](#0-项目概况)
- [1. 技术基线（不可动摇的约定）](#1-技术基线不可动摇的约定)
- [2. 迭代时间线（57 轮）](#2-迭代时间线57-轮)
- [3. 数据库演进总览](#3-数据库演进总览)
- [4. 前端页面与模块总览](#4-前端页面与模块总览)
- [5. 踩坑知识库](#5-踩坑知识库)
- [6. 校验体系](#6-校验体系)
- [7. 遗留事项与风险](#7-遗留事项与风险)
- [8. 合并外部 AI 开发的踩坑与解法](#8-合并外部-ai-开发的踩坑与解法)

---

## 0. 项目概况

| 项 | 内容 |
|---|---|
| 项目 | 仿「韶乐园跑跑」（韶关学院校园跑腿平台）做同类双边校园跑腿小程序 |
| 学校 | 广东邮电职业技术学院 |
| 形态 | 微信小程序**原生**（无框架），3 个 tabBar + 39 个页面 |
| 云端 | WorkBuddy Cloud，应用 id `wbapp_yPJnSvicojPmz998PjKfpM`；**R48 起并行迁往 CloudBase `ceshi-d2g37cbg7c8f7ee48`**（数据库已迁完，待切前端 SDK） |
| 数据库 | PostgreSQL 31 张表，全量 RLS，129 个 `SECURITY DEFINER` 函数、7 个触发器（CloudBase 新库 32 表 / 131 函数 / 9 触发器） |
| 代码位置 | 工作区 `campus-errand/` |
| 发布状态 | **企业主体小程序已绑定，微信审核中（2026-10-27）**。此前经 WorkBuddy 试用版（微信「试用小程序」，14 天 / 15 人 / 不能转正式版）完成真机验证，试用期已结束；审核通过后发布正式版。 |

**业务模型**：学生发布任务并支付赏金 / 认证接单员接单赚赏金。
每服务一套独立下单表单（取快递、代排队、打印、租赁、搬运等 10 个宫格）。

**合规红线（立项即定，全程未破）**：
- **明确不做「乐跑代跑」** —— 代刷校园跑体测数据属作弊服务。
- 「代替服务」收紧为「代排队」，限定在代取代送、排队代办。
- 身份证号**只存脱敏值**（前 6 位 + `********` + 后 4 位），完整号码不入库。
- 任务大厅列表不返回 `contact` 字段，手机号不对所有人可见。

---

## 1. 技术基线（不可动摇的约定）

### 代码层
- 页面层**强制 ES5 语法**：`const/let + function`，禁用箭头函数、模板字符串、展开运算符。
- 页面里只用 `.then().catch()`；**只有 `utils/api.js` 内部允许 `async`**。
- WXML 循环**必须显式写 `wx:for-item`**，否则默认变量叫 `item`，用 `{{entry.xxx}}` 会静默渲染成空白（不报错，极难发现）。
- `ui.*` 只认 `utils/ui.js` 的导出名（如 `loading`/`toast`/`hideLoading`），写错名字取到 `undefined`，一调用就中断整段逻辑。
- 新增页面四件套（js/wxml/json/wxss）后**必须在 `app.json` 注册**。
- 新增入口前先 grep 目标 url，同一个 `navigateTo` 目标在同一屏出现两次就是重复入口。

### 数据层
- 前端 `cloud.database.rpc('fn', { p_xxx })` 调 PostgreSQL。
- 写操作**一律走 `SECURITY DEFINER` 函数**（RLS + `auth.uid()` + `SET search_path = public`）。
- 对应表全部 RLS 收口 + `REVOKE ALL FROM PUBLIC/anon/authenticated`，客户端不可直连业务表。
- PL/pgSQL 铁律：`RETURNS TABLE` 的 OUT 参数与体内列名冲突会报 `ambiguous`，统一返回 `SETOF <表>` + 列引用带表别名。

### 权限与灰度
- `admin_grants` 表存**八级**权限：`super / support / hr / review / rental / print / settle / dispatch`（`dispatch` 自 R28 批量发单引入）；super 隐含全部，只有 super 能授/收 super，服务端硬拦。
- 新增 perm_key 要改三处：`admin_set_perm` 白名单、`admin_my_perms` 返回列表、页面判断 —— 漏一处新权限根本授不出去。
- 前端判断只是显示用，真正拦截在每个 RPC 里调 `admin_has_perm()`。
- 新功能一律挂 `feature_flags`（现 23 个开关，`enabled` 默认 false；2026-10-24 现网 23 个均已打开）；总闸页 `pages/admin/flags` 只给 super。
- **配置类页面（flags / banners / feedback）不能被自己的开关挡住**，否则关了就再也进不去打开。

---

## 2. 迭代时间线（57 轮）

### Day 1 — 2026-10-14：从录屏原型到可用链路

#### R1 · 立项与原型还原
- 用户提供参考小程序 1 分 46 秒录屏。本机无 ffmpeg CLI，装 `imageio-ffmpeg` 到隔离 Python 包目录，按画面变化抽帧（`select='gt(scene,0.22)'`）得到 22 帧。
- 还原要点：双边平台、首页公告条 + 10 服务宫格 + 任务大厅、每服务独立下单表单、订单页四维度筛选、我的页身份切换、接单员需身份证 + 学生证 OCR、相机租赁。
- 首版落地 8 个页面 / 3 个 tabBar。后端接 WorkBuddy Cloud，`spec: @tencent-ai/workbuddy-cloud-sdk/miniprogram` + `createDiagnosticWx` 诊断适配器。
- 建表 `profiles / orders / addresses / runner_applications`（均 RLS）。
- 跨用户操作用 `SECURITY DEFINER`：`accept_order / complete_order / cancel_order`（避免放宽 orders 的 UPDATE 策略）。
- 同时确定上文的**合规红线**。

#### R2 · 修「首页服务宫格点不进去」
- **根因**：进下单页前做了 `guard.ensureLogin()` 前置拦截。H5 预览拿不到真实 `wx.login` code，永远登不上，每次点击都被弹框拦下；且 `getSession()` reject 时 `ensureLogin` 没有 catch，Promise 中断后页面完全无反馈 → 表现为「点了没反应」。
- 修法：
  1. `pages/index/index.js` 的 `goCreate` 去掉登录前置拦截（填表是本地操作），登录校验挪到下单页「提交任务」时。
  2. `utils/guard.js` 给 getSession 加 catch；`wx.showModal` 加 8s 超时兜底，fail 时退化为 toast。
  3. 下单页加未登录提示条（`signedIn` + `goLogin`）。
  4. 所有 `wx.navigateTo` 补 `fail` 回调。
  5. 首页大厅加载失败不再弹 toast 打断，改为「加载失败，点这里重试」空态（`hallError`）。
- **原则**：不用匿名登录/假 session 绕过鉴权；预览环境的登录限制只能靠真机验证。

#### R3 · 学校切换 + 三级宿舍选择 + 账号密码登录 + 管理员
- 学校改为**广东邮电职业技术学院**。新增 `utils/campus.js`：BUILDINGS = 进取楼/团结楼/博学楼/精益楼/敬业楼/迎宾楼；FLOORS 1-14 层；ROOMS 1-40 号；`formatRoom` → 「进取楼 · 5层 · 12号」，`parseRoom` 反解回填。
- 三级选择器做成自定义组件 `components/room-picker/`。`services.js` 用 `withDormPicker()` 给 `deliver_addr` 打 `kind:'dorm'`。
- 「我的地址」改用三级选择，拆成 `building="楼栋 · 楼层"` + `room="宿舍号"` 入库；列表项加「设为常用」，写入 `pickedAddress` 缓存。
- **账号登录**：`loginWithPassword / sendPhoneCode / registerWithPhone`（signInWithPassword + sendOtp + verifyOtp）。密码登录不依赖 `wx.login`，**预览环境可用**。
- **不能凭空建号**：验证过 `signUp` 无 verificationToken 会被拒，管理员账号必须由用户自己在界面注册一次。
- **管理员**：`profiles.is_admin` 列 + `activate_admin(code)`（R3 时为明文口令 `GDYZPT2026`；**R39 起改为服务端盐值 + SHA-256 哈希比对，客户端不再存任何明文**，见 `sql/restore-admin-password.sql`）+ `list_all_orders(limit)`。

#### R4 · 预览环境兼容性（关键教训）
- H5 预览容器不完整模拟原生能力，报 `wx.showLoading is not a function`；同一原因导致 `picker-view` 三列渲染错乱（点开直接是第三级房号）。
- 新增 **`utils/ui.js`**：所有 wx UI/storage 调用统一走这里，`available()` 检测 + try/catch + 超时兜底。confirm 带 15s 超时，绝不悬着。
- **已踩坑**：用 sed 全量替换时千万别把 `ui.js` 自己内部的 `wx.*` 也替换掉，会造成无限递归（本次已修复并复查）。
- 三级选择器**废弃 picker-view**，改为三个 `scroll-view` 列 + bindtap 选中。
- 管理员口令输入从 `wx.showModal({editable})` 改为页面内 inline input。

#### R5 · 提交任务 desc 报错 + 管理员审核接单员
- **Bug**：`pages/order/create.js` 的 `buildTitle` 里 `desc` 未定义（跨文件批量 sed 时误删声明），点「提交任务」必抛 `desc is not defined`。
- **教训**：批量 sed 后，`buildTitle` 这类函数级改动必须回归跑一遍，不能只做语法检查。
- 新增 `pages/admin/review` + 两个 RPC：`list_runner_applications(p_status, p_limit)`（RETURNS TABLE，因为 RLS 是 owner-only，管理员读不到别人的申请）、`review_runner_application(p_app_id, p_approve, p_note)`（同步写 `profiles.cert_status` 和 `role`）。
- 调试入口 `insert_demo_application(label)` 造 `demo_applicant_*` 合成申请，避免污染真实用户认证状态。

#### R6 · 身份切换失效 / 无接单按钮 / 无法取消（根因重要）
- **根因**：`owner_id` 是 `2110332344891084800` 这类**超过 JS 安全整数范围（2^53）的字符串**。客户端用 `session.user.id` 做 `===` 或 `.eq('owner_id', uid)` 过滤会因精度丢失而匹配不上，RLS 又把不匹配的行**静默过滤**（返回 `data: []` 而非 error）。
- **解决套路（沿用至今）**：所有涉及「本人数据」的读写一律改成 `SECURITY DEFINER` 函数用 `auth.uid()` 在服务端定位，绝不在客户端拼 owner_id / runner_id。新增 `set_my_role / update_my_profile / set_cert_pending / list_my_orders / order_relation`。
- **第二个坑**：`ui.confirm` 没有 `defaultConfirm` 时，预览环境缺 showModal 会 resolve(false)，「取消订单 / 确认完成 / 删除地址 / 退出登录」全部静默无反应。补 `defaultConfirm: true`。
- 新建 `pages/mine/points`、`pages/mine/wallet`；钱包如实说明「未接支付，暂不可提现」，不假装能用。

#### R7 · 去掉自接单 / 退出登录修好 / 双号联调
- 用户改为开两个账号双端联调，删除管理员自接单入口（`secondary` 概念及相关 WXML 分支）。
- **取消按钮消失的原因**：服务端关系判定 RPC 一旦失败，整个 `then` 链走到 catch，setData 没执行。**教训：关键渲染不能依赖单一 RPC**。给 `order_relation` 加本地兜底。
- **退出登录无效的真正原因**：退出后被 `tryAutoLogin` 立刻登回同一个账号。修法两条同时做：① 写 `manualLogout` 标记；② **彻底不用 `wx.showModal`**，改成页内两步确认（`logoutArmed`，4 秒自动复位）。
- 认证照片**仅在不支持选图的环境下放宽为可选**（第二个号在预览环境永远成不了接单员）。
- `pages/mine/apply.js` 因两次编辑出现**两个 `onLoad`**，`node --check` 才会报。已加入校验：扫描所有 Page 对象的方法名查重。

#### R8 · 取消按钮无反应 / 管理员后台 ambiguous
- **根因 1**：`list_runner_applications` 用 `RETURNS TABLE` 声明 OUT 参数（含 `owner_id`/`status`/`nickname`），它们在 PL/pgSQL 里同时是函数变量；体内写成 `SELECT is_admin INTO v_admin FROM profiles WHERE owner_id = v_uid`（未限定表名）→ `column reference "owner_id" is ambiguous`，整个函数第一次执行就失败。列表打不开，「生成测试申请」看起来像没反应。
- **根因 2**：detail 页的取消/完成依赖 `ui.confirm` → `wx.showModal`；该接口在预览容器可能缺失或 success 回调不带 `confirm` 字段（`!!undefined === false`），点击被静默吞掉。
- → 改成**页面内两段式确认**（`armKey/armLabel`，第一次点变字「再点一次，确认取消」，4 秒自动复位）+ `errorText` 内联错误条 + 重试按钮。这个模式后来成了全项目的标准做法。
- 排障手法：`auth.uid()` = `current_setting('request.jwt.claim.sub')`，可建临时 `SECURITY DEFINER` 探针函数里 `PERFORM set_config(...)` 再调业务函数，在 SQL 侧复现端上行为。

#### R9 · SQL 执行落库，审核页修好
- 落实 `campus-errand/sql/fix-admin-review.sql`（列引用全部加表别名）。探针验证：返回 11 行，含第二条真实申请 → 歧义报错消失。
- 清理 4 个临时探针函数；排障时被改动的订单 #2 还原为 pending。
- **此时确立规矩：所有数据库变更必须同时落成 `.sql` 文件**，否则下次重建环境会退回旧语义（后来在 R13 真的因为这个吃亏）。

#### R10 · 用户在腾讯云 CloudBase 控制台新建环境
- 建议：数据库类型选 **PostgreSQL 数据库**（另一个「云数据库」是文档型 JSON + `.watch()`，选它等于整个后端重写）；套餐选免费体验版；地域上海。
- **重要提醒**：新建环境是空库，和 WorkBuddy 云服务的库不互通，修不了正在修的 bug。

#### R11 · 大批量需求落地（结算 / 租赁 / 用户协议）
**数据库**
- `orders` 新增：`runner_done_at / feedback_text / feedback_at / feedback_status / admin_note / is_special`。
- `profiles` 新增：`agreed_version / agreed_at`。
- 新表 `rental_requests`。
- 新函数：`confirm_order_done`（发布方确认才结算）、`submit_settle_feedback`（满 48h）、`admin_list_feedbacks`、`admin_resolve_feedback`、`submit_rental_request`、`list_my_rental_requests`、`admin_list_rental_requests`、`admin_set_rental_price`、`admin_create_rental_order`、`accept_agreement`。
- **`complete_order` 语义改造**：从「直接结算」改为「接单员标记送达 → waiting_confirm」。这是整个订单状态机的关键转折。

**前端**
- room-picker：去掉面板上的 `catchtouchmove`（它会拦掉三列 scroll-view 的 touchmove 导致滑不动）；三列末尾加「其他」+ 自定义输入框。
- detail：`accepted` → 接单员「我已送达」；`waiting_confirm` → 发布方「确认完成并支付」；接单员侧 48h 后可申请核查。
- 新页面：`pages/agreement/index`（协议全文 + 强制勾选）、`pages/admin/settle`、`pages/admin/rental`、`pages/rental/apply`。
- 相机租赁不再直接下单：填预填信息 → 管理员报价 → 生成特殊工单（大厅用 `.eq('is_special', false)` 过滤）。
- 用户协议：`utils/agreement.js`（VERSION + 9 节正文），登录/注册/微信登录前必须勾选；登录后 `agreed_version ≠ 当前版本` 强制跳协议页。

---

### Day 2 — 2026-10-15：发布成功、二进制通道、内容安全

#### R12 · 排查「微信上传失败，请稍后重试」（不是网络/体积）
- **关键排障手法**：WorkBuddy 前端日志藏着微信 CI 的真实报错 —— `C:/Users/包子6688/.workbuddy/logs/renderer.log`，搜 `[miniprogram:publish] publish failed`。字段 `raw=` 是完整错误，`displayed=cleaned` 表示界面上那句是「洗过」的。
- **根因**：`utils/api.js` 里 `completeOrder` 被声明了两次（275 行、284 行）。微信 CI 报 `Identifier 'completeOrder' has already been declared. (412:9)`。
- **为什么 `node --check` 全绿却上传失败**：非严格 Script 里顶层函数声明是 **var 作用域**，重复声明合法 → `node --check` 放行；微信 CI 用 Babel 按 **ES Module** 解析，模块顶层函数声明是**词法声明**，同名重复直接编译失败。
  - `new vm.Script('"use strict";' + src)` → 抓不到
  - `new vm.Script('"use strict";(function(){' + src + '})')` → 抓不到
  - `new vm.SourceTextModule(src)`（需 `--experimental-vm-modules`）→ **能抓到** ✅
- 顺带修第二个隐患：`node_modules` 5.89 MB > 主包 2MB。`project.config.json` 的 `packOptions.ignore` 增加 `node_modules`；把 SDK 产物落到 `miniprogram_npm/@tencent-ai/workbuddy-cloud-sdk/miniprogram.js`（CJS，519582 字节）。结果上传体积 **0.69MB / 65 文件**。
- 固化工具 `check-mp.js`（7 项检查：ESM 严格解析 / JSON / WXML 标签配对与 id 唯一 / 页面文件齐全 / usingComponents 存在 / 真实上传体积 / 裸包名解析）。

#### R13 · 试用版发布成功 + 授权机制查证
- 确认分享面板显示「试用版 已发布」，有效期至 2026/10/29，**当前版本试用版支持「解绑」**（旧文档说不能改绑是过期信息）。
- **试用版没有成员管理界面，用户找不到是正常的**。授权是**拉取式**的：分享二维码 → 对方扫码 → 首次触发「申请体验权限」 → 创建者在微信「服务通知」里点开批准。
- 三条硬限制：14 天有效、最多 15 人体验、一个微信号最多建 5 个，**不能转正式版**。
- **排障技巧**：忘了管理员是哪个微信号时，用不常用的微信扫预览码申请成为体验者，**哪个微信号收到「小程序体验成员申请」，哪个就是管理员**。
- **风险提醒**：管理员口令硬编码在包里，拿到口令的人都能自己开管理员，本质是调试后门。

#### R14 · 修复「接单员上传证件照片失败」
- **现象**：选文件/拍照都一样，toast 显示 `createMiniProgramFetch: 暂不支持非字符串 body（Ar…`。
- **根因（SDK 层缺陷）**：`@tencent-ai/workbuddy-cloud-sdk` 的小程序适配层 `createMiniProgramFetch()`（miniprogram_dist/miniprogram.js:14859）**只实现文本请求**，`body` 非字符串直接抛错。`cloud.storage.upload()` 走 ArrayBuffer 分支 → 必抛。**小程序运行时用 SDK 传二进制文件必然失败**。
- **修复**：新增 `campus-errand/utils/upload.js`，绕开 SDK fetch，用 `wx.request` 原生二进制直传。端点与请求头与 SDK 内部逐一对齐（`POST {endpoint}/.cloud/storage/object/runtime/{objectPath}`，header `x-wb-webapp-access-key` + `Authorization` + `X-Client-Info: storage-js/2.112.3`）。
- 兜底：主通道失败自动改走 `wx.uploadFile` multipart；但 401/403 **不兜底**。>1.2MB 先 `wx.compressImage(quality:60)`；>8MB 报错。
- **用户真机回报：上传已正常** → 「wx.request 传 ArrayBuffer」这条通道在真机上确实可用。

#### R15 · 修复「管理员查看学生证提示加载失败」
- **根因两层**：① `getSignedUrls` 任何失败都只 push 空串，真实原因全丢（本项目反复出现的同一类毛病：**不要让失败只剩一句通用文案**）；② 底层签名链接接口报错。
- **修复**：`utils/upload.js` 新增「带 token 直读字节」通道。理由很硬 —— 上传用的就是同一套鉴权（同端点、同 token、同 appKey），只差一个 GET，上传在真机已验证成功。
- `downloadBuffer` → 字节 → `writeFileSync` 本地路径 → **不用 base64**（`setData` 单次上限 1MB，1MB 图 base64 就是 1.37MB，会直接炸）。兜底二才退 `data URL`。
- `getSignedUrls` 改为返回 `[{url, error, signError}]`（破坏性变更，两个调用方已同步）。页面**始终把失败原因显示出来**。

#### R16 · 登录页输入框「分界不明显」
- **根因**：`.field-input` 底色 `#F7F8FA` 与页面底色 `#F5F6F8` 几乎同色（差 2/255）→ **隐形**。加上 `.login-wrap` 的 `text-align: center` 被输入框继承，占位文字居中更像标题。
- **确立全局规则**：页面上的所有可见表面统一用**白底 `#FFFFFF` + `2rpx solid #E3E6EB` 描边**，灰底页面和白底卡片上都成立，一套规则通吃。

#### R17 · 修正输入框「比例不对」（盒子被压扁）
- **发现方式**：装 `pngjs` 解 PNG 做色值直方图 + 逐行扫描，用已知尺寸元素标定 `px/rpx`（本例 750rpx = 820px，1rpx ≈ 1.093px）。
  | 元素 | 样式应为 | 实测 | 结论 |
  |---|---|---|---|
  | 占位文字字高 (28rpx) | ≈25rpx | ≈ **13.7rpx** | 只剩 55%，上下被切 |
  | 输入框高度 | ≈86rpx | ≈ **55rpx** | **内容高度塌成 0** |
- 26×2 padding + 2×2 描边 = 56rpx ≈ 实测 55rpx → 盒子只剩 padding 和描边，内容高度被钳成 0。
- **根因**：小程序给 `input` 自带约 1.4em 的固定默认高度。同时加 `padding: 26rpx` 和 `box-sizing: border-box` 时，padding 从这个固定高度里扣，`height(auto) < padding + border` 就会把 content 钳到 0。
- **修复决策：盒子几何从 `input` 挪到外层 `view`**。`.login-box`（view）负责 flex + 固定 height + padding + 描边；`.login-input` 只留 flex/字号/颜色，去掉 padding/border/box-sizing/width。**这是 renderer 无关的稳妥写法。**
- 顺手修掉同一类「隐形表面」缺陷（`.room-picker`、`.custom-input`、`.quick-item`、`.task-card`、`.field-area`、`.note-input`）。

#### R18 · 图片改存 PostgreSQL —— 对象存储的读路径确认是平台侧故障
- **现象**：证书照片三条读取通道全报 `404 STORAGE_OBJECT_NOT_FOUND`。
- **排查到底**：① MCP 列存储确认对象**确实在**（31001 字节、路径逐字符一致、`owner_id` 正确）；② `storage.objects` 表的 **`version` 字段为空字符串**（正常应该有值）；③ 请求头/路由/TTL/路径校验/编码策略全部核对无误。
- **结论：写能成、读不回来，这是平台侧故障。不要再在这上面花时间。**
- **方案**：图片改存库。
  - 新表 `public.media_assets`（RLS 开启且**不建任何策略** → 客户端不可直连）。
  - `save_media_asset(scope, mime, data) → bigint`，长度上限 2,600,000 字符（≈1.9MB 原图）。
  - `get_media_asset(id)`，**仅本人或管理员可见**。
  - 路径格式 `asset:<id>`；旧对象路径仍走旧通道兼容历史数据。
- **过程中自查出两个真问题**：① `wx.compressImage` 返回的临时文件**不一定带扩展名**，一律按 target 猜会把 png 误判成 jpeg → 改成 `resolveMime(原图, 压缩产物)`；② 客户端原上限 8MB，**服务端折算只有 1.9MB** → 对齐为 `MAX_UPLOAD_BYTES = 1900*1024` + 两级压缩（60 不达标就从原图再压 35，不叠加压避免画质崩）。
- 通用经验：**小图（≤1.9MB）存 `text` 列比对象存储更可靠**，还天然带上行级权限。

#### R19 · 内容安全：违规词校验 + 订单举报
- **三层拦截**：① 发布页输入时本地实时检测（`utils/moderation.js`）；② 提交前再扫一次；③ **服务端 `create_order` / `submit_rental_request` 必扫** —— 只有第三层能拦绕过页面直调接口的人。
- **词库不能写死在前端**：`moderation_words` 表（292 黑名单 + 4 白名单 / 13 类），客户端经 `list_active_moderation_words` 拉缓存（30 分钟），改词无需重发小程序。
- **SQL 与 JS 的 normalize 必须逐字符一致**（全角转半角 → 小写 → 繁简/带调拼音折叠 → 剔除非 CJK/字母数字 → 子串匹配），已用 14 条样本逐条比对两端结果一致。
- **白名单机制**：本平台叫「校园跑腿」，词库里「代跑」会把「帮我代跑腿买饭」误拦 → 加 `severity='allow'` 词条，扫描前先从文本里删掉再匹配黑名单。
- **逐字段扫描、不拼接后扫**（拼接会让词跨字段边界误命中）。
- 发单改走 RPC 由服务端定 owner_id（防冒名）。配套的 `DROP POLICY orders_write_own` **故意先不执行** —— 旧版小程序还在用 `orders.insert`，过早收口会导致线上发布功能整体失效。

#### R20 · 租赁页乱码 / 取件快捷标签 / 挂牌价后台化
- **标题乱码**：`encodeURIComponent(item.name)` 拼进 URL，onLoad 直接展示就成了 `%E5%A4%A7%E7%96%86...`。修法：解码 + try/catch 兜底。**规则：凡是从 URL 参数取来要展示的字符串，先解码再渲染。**
- **租期 chip 重叠**：chip 是行内 `<text>` 直接塞进 block，行内元素的 padding 不参与行盒高度计算 → 背景与上一行文字叠在一起。修法：`<view class="chip-row">` flex-wrap 容器 + `.chip` 加 `white-space:nowrap`。
- **取件快捷标签**：六个地点放 `utils/config.js` 的 `pickupShortcuts`，改配置即可增删；`NO_SHORTCUT_LABELS` 排除要填房间号/窗口号的字段。
- **`rental_items` 表**：机型清单原写死在 `utils/services.js`，改价要重发小程序。建表 + `list_rental_items`（公开读，不校验登录——逛租赁页不该要求登录）/ `admin_list_rental_items` / `admin_update_rental_item` / `admin_create_rental_item`。前端失败时退回打包清单 + 顶部明确提示「价格可能是旧的」。**下架≠删除**（历史申请仍引用 item_id）；**改价要点保存才生效**（金额敏感）。

#### R21 · 历史订单删除（按人隐藏，不物理删除）
- 方案：`public.order_hides(order_id, user_id)`，只记「谁隐藏了哪一单」。**不做物理删除** —— 订单是双方共有的，一方删不能影响另一方；结算/举报核查/审计都要用这条记录。
- 新增 `hide_my_order / restore_my_order / my_order_hidden / list_my_hidden_orders`；`cancel_order` 补写 `finished_at`（否则取消的单永远算不满 7 天）；`orders` 加 `takedown boolean`（区分「发布方自己取消」和「管理员违规下架」）。
- 随后用户要求改为「整单生效」—— `list_my_orders` 的过滤从 `AND h.user_id = v_uid` 改为不带人，`my_order_hidden` → `order_hidden`，`restore_my_order` 清掉该单所有人的隐藏记录。
- **这里的坑**：改了库但 `.sql` 文件本体一直没改（`add-order-delete.sql` SQL-10 与线上不一致），症状是「A 删单后 B 的列表仍在，B 点进去却是已删除空态」。已改文件 + 新增幂等迁移 `sql/fix-order-hide-scope.sql`。

---

### Day 3 — 2026-10-16：大改版、灰度、后台体系、闭环

#### R21-补 · 全页面审查
- 已修：`pages/orders/list.js` 向未声明的 `errorText` 写值；`utils/config.js` 删掉明文管理员口令（会被反编译看到）；`getSignedUrls` 串行 await → `Promise.all`；「我的订单」四个 chip 补选中态。
- 仅提示未动：`config.js` 的 `rememberPassword/autoLogin/presetAccount` 仍为调试态 —— **用户还在联调，擅自关会打断测试**。

#### R22 · 全站大改版（高价值 + 中价值 + 锦上添花 + 轮播 + 管理员分级 + 人员查找 + 灰度）
**数据库**
- `admin_grants(user_id, perm_key, granted_by)`：七级权限。配套 `admin_has_perm / admin_can_grant / admin_my_perms / admin_search_staff / admin_set_perm`。super 在 `admin_my_perms` 里被展开成全部七项。存量 3 个 `is_admin` 用户自动补 super。
- `feature_flags`：14 个开关，默认全关，只有 super 能切。
- 六张新表：`banners / messages / order_reviews / point_records / wallet_records / user_feedbacks`；`profiles` 加 `runner_score_sum / runner_score_count`。
- **消息用触发器挂钩，不改动已跑通的订单函数**：`trg_order_notify / trg_rental_notify / trg_cert_notify / trg_report_notify`。确认完成那一步同时写钱包流水 + 通知，保证「到账」和「通知」成对出现。
- `list_my_orders` 加 limit/offset（**先 DROP 再 CREATE**，因为改了参数签名）；新增 `search_my_orders / my_order_review_state / admin_dashboard_stats / list_my_feedbacks`。

**前端**
- 新内核 `utils/flags.js`（缓存 5 分钟、拉不到一律按关闭）、`utils/perms.js`。
- 新增页面：`admin/staff`、`admin/flags`、`admin/dashboard`、`admin/banners`、`admin/feedback`、`mine/messages`、`mine/cert`、`mine/mall`、`mine/feedback`、`order/review`。
- 轮播图走**公开读通道**：`upload.publicAssetToLocalFile` → RPC `get_public_asset`（服务端限定 `scope='banner'`）。**不能用 `getSignedUrls`**，那是 owner-only，游客读不到。

#### R23 · 积分 / 商城 / 评价 / 实名 / 后台入口合并
- `confirm_order_done`：确认完成时**按赏金 1:1 发积分**（后来在 R26 改为记在下单人账上）。
- `accept_order`：`runner_name` 改用**实名认证申请的 `real_name`**（`LEFT JOIN LATERAL runner_applications status='approved'`）。
- `update_my_profile(p_nickname, p_avatar_path)`：**签名变了**（原单参数版本已 DROP）。用户名 2-16 字；头像只收本人上传的 `asset:<id>`。
- `get_public_asset` 放开 `scope IN ('banner','avatar')`。
- 新表 `point_goods` + `point_redemptions`；`profiles.boost_until`；RPC `list_point_goods / exchange_point_goods / list_my_redemptions / my_boost_active`。
- **反馈提交按钮无效的真因**：写了 `ui.showLoading(...)`，而 `utils/ui.js` 导出的是 `loading`，取到 undefined 一调就抛异常整段中断。
- `buildTimeline`：**「确认完成」节点只在 `status==='done'` 时出现** —— `cancel_order` 与违规下架都会写 `finished_at`，只看时间戳会让下架单凭空多出「赏金已结算」。
- 接单员实名卡片改为 `canSeeRunnerName`（参与方/管理员）才显示，大厅路人看不到别人实名。
- 所有零散后台入口全部收进 `admin/dashboard`，「我的」页只留「管理员口令」+「管理员工作台」。

#### R24 · 处理悬而未决的 `DROP POLICY orders_write_own`
- **背景**：这是 must-after-publish 的动作 —— 旧版小程序是客户端直写 orders 表发单，这条策略是它唯一写通道，删早了没更新的用户发不了单。
- **让这条 DROP 不再紧急**：`sql/add-order-write-guard.sql` 加 BEFORE INSERT 守卫补上 ①只能给自己发单 ②伪造 status/runner/时间戳一律复位成 pending ③重跑 scan_moderation_words。**设计原则 fail-open**：整个函数体包在 EXCEPTION 里，`WHEN raise_exception THEN RAISE`，`WHEN OTHERS THEN RETURN NEW`。守卫出任何意外都退回原行为，绝不卡住发单。
- `app.js` 新增 `checkUpdate()`：`wx.getUpdateManager()` 检测到新版立刻下载并弹窗重启（之前没有更新管理器，只能等最长一天的冷启动）。
- **用户要求立即执行，已执行并自检通过**。关键手法：默认 session 的 `current_user` 是表 owner 且 `rolbypassrls=true`，直接测会被 RLS 放过，**必须 `SET LOCAL ROLE authenticated` 才是真实前端语义**。
- **重要发现**：INSERT 报 row-level security 被拒；**UPDATE 不报错但影响行数 = 0** —— 所以用 `GET DIAGNOSTICS ROW_COUNT` 判才是准的，只 catch 异常会误判为「没拦住」。
- 复核：`create_order`（SECURITY DEFINER）在 authenticated 角色下照样能发单成功 → 新版发单路径不受影响。

#### R25 · 截图问题 + 积分归属 + 大厅门槛
- **关键 bug：`wx:for` 循环变量名写错**。`pages/admin/dashboard.wxml` 里 `wx:for="{{entries}}"` 没写 `wx:for-item="entry"`，但标签内全用 `{{entry.icon}}`。WXML 默认循环变量叫 `item`，于是所有字段取到 undefined —— 页面不报错，只渲染出「只剩 > 箭头」的空白行。
  > 这类错误永远不报错，只能靠扫。已写扫描脚本：正则找 `wx:for` → 检查有没有 `wx:for-item` → 比对紧随其后 400 字内 `{{变量.` 用到几个变量名。
- **积分归属改为下单人**（用户明确要求）：`confirm_order_done` 改为记在 `owner_id` 账上，赏金仍打给接单员钱包；站内消息拆成两条。
- 新增 `order_peer_credit(p_order_id)`：参与方互看信誉分，非参与方且非管理员直接抛错。
- 新增 `admin_is_any()`、`is_certified_runner()`。
- **`orders_read_all` 从 `USING (true)` 收紧**成参与方/认证接单员/管理员 —— 原来任何登录用户都能直读大厅全部任务（标题/描述/取件地点/发布人）。三档实测：未认证用户可见 0 行、认证接单员 18 行、管理员 18 行。
- 首页大厅加门槛：`checkRunner()` 先判登录 + 接单员资格，不达标渲染锁定卡，完全不拉取、不展示任务。

#### R26 · 清理重复入口（同页同一目标只留一个）
- 上一轮把「认证进度」收进「成为接单员」页时做成了**两个入口**（顶部卡片 + 底部按钮）。重写为**单卡结构**：`wx:if="{{!showForm || certStatus === 'rejected'}}"` 的进度卡是全页唯一入口。
- 「我的」页顺手扫出三处同款重复并合并：「我的评价」→ 保留「我的订单」里的待评价 chip；「我的信誉分」→ 保留统计栏格子；「头像与用户名」→ 保留头像区（`goProfile` 里判灰度）。
- > 复核脚本思路：wxml 里统计每个 bindtap 的出现次数 → 映射到该函数里的 navigateTo url → 按 url 聚合。

#### R27 · 意见反馈受理 + 双向跟进对话（客服工单）
- 新表 `feedback_replies`；`user_feedbacks` 加 `user_seen_at / admin_seen_at` 两个已读水位。
- 列表接口**改返回类型**（加 reply_count / unread_count / last_reply_at / last_role / last_preview），必须**先 DROP 再 CREATE**。
- 会话接口（客服与用户**共用同一套**，服务端按 support 权限或 owner_id 判定可见性）：`feedback_detail / feedback_thread / feedback_reply / feedback_mark_read / admin_reopen_feedback`。
- **对话开放规则**：pending → 只有客服能说，且第一条回复＝受理（不用再点受理按钮）；resolved → 双方都能说；rejected → 双方都不能说，客服先「重新受理」。
- **三个踩坑**：
  1. **`SELECT ... FOR UPDATE` 在 RLS 环境会报 permission denied**。取缔行锁并注释写清原因，避免以后有人手滑加回来。
  2. **冒充用户做自检时不能直读业务表**（`SET LOCAL ROLE authenticated` 后 `SELECT ... FROM public.user_feedbacks` 直接 42501）。状态一律走 SECURITY DEFINER 接口读。
  3. **`now()` 在事务内是同一个事务时间戳**。自动受理时若顺手把 `admin_seen_at` 推到 now()，同一事务里用户后来发的追评会被判成「已读」，客服未读数永远是 0。→ 已读水位只由 `feedback_mark_read` 负责。
  4. plpgsql 里 `BEGIN ... EXCEPTION` 捕获异常会**回滚该块内的所有修改**。
- 前端新建 `pages/feedback/thread`：**两端共用这一个会话页**，10 秒轮询（onHide/onUnload 清 timer），`scroll-into-view` 定位最新一条（setData 后延 80ms 再滚）。不能发言时底部换成说明文案，不留点了没反应的按钮。

#### R28 · 任务大厅独立页 / 楼栋楼层筛选 / 开价下限 / 送达佐证 / 积分券抵扣（本批 7 个问题）
**数据库**
- `orders` 新增 `deliver_images text[]`、`pickup_building/floor`、`deliver_building/floor`、`discount_code`、`discount_amount`；索引 `(status, deliver_building, deliver_floor, created_at DESC)`。
- `point_redemptions` 新增 `used_by / order_id`；`point_goods` 新增 `benefit_type`（`deduct` 抵扣 / `verify` 核销 / `auto` 自动生效）与 `deduct_value`。
- `create_order` 扩到 **17 个参数**：赏金 < 1 元直接 `RAISE EXCEPTION '赏金最少 1 元'`；抵扣券只认「本人 + unused + benefit_type='deduct'」，`v_discount = LEAST(deduct_value, reward)`。**抵扣只记在订单上，接单员仍拿全额赏金**（差价平台承担）。
- `complete_order(p_order_id, p_images)`：灰度 `deliver_photo` 开着时必须 1–3 张，关着时可选；只认 `^asset:[0-9]+$`。
- `get_order_detail`：非发布方 / 非接单员 / 非管理员 → `images`、`deliver_images` 置空、`contact` 置空串。
- 积分商城后台（全部 `admin_has_perm('settle')`）：`admin_list_point_goods / admin_upsert_point_goods / admin_adjust_points / admin_verify_redemption / admin_search_points_user`；用户端 `list_my_coupons`、`list_point_goods` 带 benefit_type。

**本轮最大的坑：私有图读不到**
`get_media_asset` 的条件是 `owner_id = 调用者 OR is_admin`，但订单里的图天然跨人 —— 任务图是发布方传的、送达佐证是接单员传的，对方根本读不出来（实测非上传者读到 0 条），佐证功能等于白做。
→ 新增 **`get_order_asset(p_asset_id, p_order_id)`**：① 调用方是这一单的发布方或接单员（或管理员），② 这张图确实挂在 `orders.images / deliver_images` 里，两道条件缺一不可。
前端配套 `upload.orderAssetToLocalFile/DataUrl` + `api.getOrderImageUrls(paths, orderId)`。**以后凡是「订单相关的图」都不能用 `getSignedUrls`。**

**前端**
- 新建 `pages/hall/index`（接单员门槛锁卡、服务类型/排序、楼栋楼层 picker、上拉分页）；`pages/index/index` 清掉列表与筛选，只留一个「📋 任务大厅」入口卡。`onLoad` 不发请求（后面必然紧跟 onShow，否则首屏会连发两遍）。
- `pages/mine/profile` 支持 `?force=1`：用 `wx.enableAlertBeforeUnload` 拦返回按钮与右滑手势，保存成功后 `disableAlertBeforeUnload` 再返回。`guard.ensureNickname/nicknameMissing` 是统一入口。
- 新建 `pages/admin/points`：商品管理 / 积分调整 / 兑换核销 三个 Tab。
- 灰度新增 `hall_building_filter`、`coupon_deduct`、`deliver_photo`。
- **`hall_page` 开关被删除**：大厅是任务列表的唯一入口，关掉等于直接下掉功能、没有回滚路径，不该做成开关。

**校验**：库里角色化自检全过且全部回滚（开价 0.5 拒 / 1 元过；送达空图与外链被拒；脱敏四种角色符合预期；抵扣券不可复用、拒绝手动核销；积分 ±5000 边界、空原因、越权全被拒；`get_order_asset` 五种取图场景正确；`deliver_photo` 开→强制、关→放行）。**脏数据复核 0**。49 个 JS `node --check` 全过。

---

### Day 4 — 2026-10-17：多单发单与批量修复

#### R29 · 第七轮：管理员多单发单 + 发单员权限 + 8 项修复

**新增能力**
- **管理员多单发单**：`admin_batch_create_orders(..., jsonb)`，一次最多 50 笔，同批生成 `batch_no`；`orders` 加 `batch_no` 列与 `orders_dispatch_idx` 索引；新增 `admin_list_dispatch_orders()` 查批次。
- **发单员管理员**：`admin_grants` 增加第八级权限 `dispatch`。注意 **新增 perm_key 要改三处**：`admin_has_perm`（查表，自动）、`admin_set_perm` 的白名单校验、`admin_my_perms` 里 super 返回的全权限列表 —— 漏了后两处新权限根本授不出去。
- **下单置顶（优先券）**：`point_goods.benefit_type` 增加 `boost`；`orders.boosted`；`create_order` 扩到 19 参（`p_boost_code`、`p_batch_no`）；`list_hall_orders` 按 `o.boosted OR pf.boost_until > now()` 置顶（后者兼容改成次卡之前买的老权益，别删）。

**本批修复的 8 个问题**
1. 兑换码兑换后退出再进无法复制 → `pages/mine/mall` 券列表常驻 + 历史兑换码复制按钮。
2. 积分商城优先展示券无法在下单时使用 → 改次卡机制 + 下单页优先券选择器。
3. 楼栋/楼层筛选筛不到历史订单 → 新增 `parse_addr_part()` 回填 `deliver_building/floor`，插入时兜底解析。
4. 收货人点不开接单人佐证照片 → `previewImage` 必须按组传 urls，页面用 `data-group` 区分「任务图 / 送达佐证」。
5. 举报下架不扣信誉分 → `admin_handle_report` 落 `credit_strikes`；**同时加 `status='pending'` 前置校验**，否则同一条举报可反复处理、每次都扣一次分。
6. 评价无效 → `submit_order_review` 之前写错计数列，改为**双轨**：给接单员累 `runner_score_*`，给发布方累 `owner_score_*`。
7. `profiles` 加 `owner_score_sum / owner_score_count / credit_strikes`；`my_credit_summary` / `order_peer_credit` 拆分展示。
8. 历史订单筛选字段为空 → 同第 3 条回填。

**校验**：角色化 `DO` 块自检全过且全部回滚（批量发单 3 笔 / 空数组 / 赏金 0.5 拒 / 非管理员越权拒；优先券核销 + 不可复用 + 类型隔离 + 新发置顶单仍排第一；楼栋筛选命中只传地址的旧单；举报下架 strikes 0→1、重复被拒；双轨评分 5★ 改 runner、3★ 改 owner、重复与 0★ 被拒）。**脏数据 0**。50 个 JS `node --check` 通过，`verify-mp.js` 通过，`check-mp.js` **1.13MB / 2.00MB** 通过。

**遗留**：`dispatch` 权限需超管在「人员与授权」手动给现有发单员开通。

### Day 5 — 2026-10-17（补录）：UI v3 重构与设计系统

#### R30 · UI v3 重构：自定义导航栏 / 动效层 / 吸顶筛选 / 悬浮发单 / 骨架屏 / 触感

> 补录说明：Day 5 / Day 6 这几批当时只写了提交信息，没同步进本文档，
> 编号在这里按 git 提交的实际时间线补齐（提交信息里标的 R31 记为 R30）。

- 全站换**自定义导航栏**：`navigationStyle: custom` + `<nav-bar>` 组件；三个约定：
  ① `navTotal` 一律从 `motion.systemInfo()` 取，别写死（iOS/安卓状态栏不一样）；
  ② 导航栏是 fixed 的，首屏必须自己让位，否则内容被盖住；
  ③ 子页面 `showBack`，返回失败兜底 `switchTab` 首页（没原生返回键会卡死）。
- 动效与触感统一收进 **`utils/motion.js`**：页面里不直接调 `wx.vibrateShort`
  （安卓/开发者工具可能没有这个 API，散着写迟早漏一处 try/catch 把点击打断）。
#### R31 · 页面命名空间 class 定义
给每个页面加一层命名空间 class，避免通用类名（`.card` / `.hint`）互相污染。

#### R32 · v2 设计系统统一全站 UI / 轮播广告图 / 排版引擎重写 / 样式预检闸门

- 主题色：**校园蓝 #2E7CF6**（主）+ **活力橙 #FF8A3D**（强调）；语义色
  success #16A34A / warn #F59E0B / danger #EF4444；底 #F4F6FB、卡 #FFFFFF、
  描边 #E6EAF2、文字 #131A2A / #5A6478 / #98A2B3。
- 令牌写在 `app.wxss` 的 `page{}` 里，**换肤只改这一块**；v2 覆盖层放在 app.wxss
  **文件末尾**（上半部的 v1 旧定义不动，靠后者覆盖）。
- **轮播广告比例 2.5:1**：容器 710×284rpx，上传图 1500×600。改容器宽度必须同步改高度，
  否则 `aspectFill` 会裁掉图片上下。

**广告图文字重叠 + 发布失败的真正原因（重要）**

- 广告图改用 `scripts/make_banners.py`（Pillow 排版）生成，**不要用 AI 生图 —— 中文会错字**。
  排版从「硬编码 y 坐标」改成「**先测量 → 再堆叠 → 最后居中**」：用 `font.getmetrics()` 取真实
  行高（ascent+descent），用 `getbbox()` 取墨迹盒，程序自动检查无交叉（最小间距 8px）。
- **发布被微信打回的两次事故**：
  1. 第一次误判为注释里的反引号 → 只删了注释，**没用**；
  2. 真凶是 `.stagger > *:nth-child(1)` —— **WXSS 不支持通配符 `*`**（报错列 12 就是星号位置），
     同时也不支持 `+` / `~` 兄弟选择器。已全量清理：`pages/mine/messages`、
     `pages/mine/mall`、新版 `pages/admin/dashboard` 都改写成等价写法。
- 由此补上第 4 道闸门 **`tools/style-lint.js`**：查反引号、中文全角标点、注释配对、花括号配对、
  `var(--x)` 未定义、**选择器里的通配符（硬失败）**、兄弟选择器（警告）、WXML 里
  `{{ }}` 配对。**三件套正式升级为四件套** —— 因为那次发布事故四件套之外三件套全绿照样放行。
- WXSS 注释同样会被 tokenizer 扫到，**注释里也别写反引号或 Markdown 粗体**。

### Day 6 — 2026-10-18（补录）：头部重叠 / 待办卡片 / 设置二级页

#### R33 · 头部白弧盖住头像 / 待办卡片拉满整行 / 数字 0 隐形

**头部白弧盖住头像与身份切换**
`.mine-hero-wave` 是 `height:72rpx; bottom:-2rpx` 的圆弧，而 hero 内容区是
`align-items:flex-end`。→ hero 底部内边距 `40rpx → 96rpx`，让内容整体抬起越过弧顶。

**工作台待办卡片两个问题**

- 最后一张卡片被拉满整行：卡片原本靠 `flex:1` 平分。→ 改成按每行 3 个分组渲染，
  每张 `flex: 0 0 calc(33.3333% - 11rpx); width: calc(33.3333% - 11rpx)`。
- 数字 0 看不见：`.disabled .quick-title` 用的 `var(--line)`（#E6EAF2，比卡片底色还浅）。
  → 换成 `var(--t3)`。

**新增「设置」二级页，收纳低频入口**

`pages/mine/settings` 把「我的地址 / 动效与触感 / 管理员权限 / 用户协议」四低频项收进去，
外加「关于」区块。「我的」页菜单由 12 项减到 9 项，只留一个带副标题的「⚙️ 设置」入口。

### Day 7 — 2026-10-22：AI 智能客服

#### R34 · FAQ 固定回答 + AI 流式兜底 + 转人工工单

**形态选型**：Knocket **否决** —— 它的 App 形态只给 WebView，小程序包 `web-view` 必须挂
**自己主体已备案的域名**（不能挂 knocket.ai），且**个人主体小程序直接用不了**。改走自建。

- 数据表：`faq_items`（分类/问题/回答/关键词/排序/启用）+ `faq_settings`（单行 id=1）。
- 函数 7 个：`list_faq_items` / `get_faq_settings` / `admin_list_faq_items` /
  `admin_upsert_faq_item` / `admin_delete_faq_item` / `admin_get_faq_settings` /
  `admin_update_faq_settings`；灰度开关 `ai_support`（sort 240，默认 false）。
- 页面 2 个：`pages/mine/support`（用户端：热门问题 chips + 会话气泡 + 固定输入区 +
  转人工）+ `pages/admin/faq`（后台：FAQ 增删改/上下架 + AI 设置）。
- 回答链路：违规词 → FAQ 关键词打分（阈值 8 = 命中词 6 + 词长）→ 大模型流式渲染 →
  都答不上才提示转人工。转人工会把最近 6 条对话打包成工单正文。
- **端上不能用 `for await ... of`**：小程序「ES6 转 ES5」的 babel 不保证注入
  `Symbol.asyncIterator`，真机会抛 TypeError 且极难定位 → 手动 `iterator.next()` 循环。
- **`get_faq_settings()` 必须返回 `ai_prompt`**：端上直连大模型，system 消息得在客户端拼。
  提示词不是密钥（凭证在云服务 SDK 里），藏起来 AI 就用不了。

#### R35 · 会话滚动与上下文修复、入口收敛、模型参数后台化

**「回答接不上上一条」两个成因一起修**（两个都会被用户描述成这句话）：
- **滚动**：原来用 `scroll-into-view`，在 setData 同一帧指向刚渲染的节点，经常滚空，
  新回答被丢在屏幕外。→ 改成 **`scroll-top` 递增**（超出内容高度时组件自动夹到底），
  配 **throttle 120ms**（不是 debounce：连续流式输出时 debounce 永不触发，尾巴看不到），
  再用 `bindscroll` 算贴底，用户翻历史时不抢滚动条。
- **会话区高度**：别靠 `flex:1` 量 scroll-view（各基础库不一致）→ 容器绝对定位
  `top:{{navTotal}}px; bottom:0`。消息行的入场动画也去掉了（有"延迟出现"错觉，
  且 transform 干扰滚动测量）。
- **上下文（真正的答非所问）**：之前每次只发 `[system, 当前提问]`，第二轮完全没前文，
  问「那赏金呢」必然接不上。→ 新增 `buildHistory()`，把最近 `history_turns` 轮（默认 3）
  拼进 messages；pending 占位气泡与欢迎语不参与。
- 顺手加**超时**：`timeout_ms` 到点 `controller.abort()` 并提示换问法。

**入口收敛**：删除设置页「联系客服」行（含 `config.support` 的可复制渠道行），
清理 `supportRows` / `buildSupport` / `copySupport`，`config.support` 字段一并删除。
客服统一走「我的 → 智能客服」。

**模型 API 配置进后台**：`faq_settings` 加 5 列
（`temperature` / `max_tokens` / `context_faq_limit` / `history_turns` / `timeout_ms`），
`admin/faq` 新增「模型 API 配置」卡片 + **测试连接**按钮（用页面上此刻填的值调一次模型，
返回耗时；先保存再测等于把错值先写进库）。改完即时生效、不用发版。

### Day 8 — 2026-10-23：客服会话滚动彻底重做

#### R36 · 「消息之间/上方大片空白」彻底修复：废弃 scroll-view，改整页滚动 + 固定输入区

**症状与判据**：用户三轮反馈「还是不行」，最后一张截图给出关键证据 ——
调试条显示「消息 3 条 · 已滚到锚点」，屏幕上却只看得到最后 1 条，上方约 450px 空白。
说明数据层和滚动触发都对，**是滚动容器的高度算错了**：滚到底的动作发生在
一个比真实视口高得多的容器里，内容就被顶出了可视区。

**在 scroll-view 上试过的四种写法（全部失败，写下来免得再回头）**：
1. `scroll-into-view` 指消息节点 —— 节点没渲染完就指，滚空；
2. `scroll-top` 塞超大值（999999）—— 内容不足一屏时基础库会**真的把内容顶上去**，
   屏幕中间留一片空白（就是截图那个样子）；
3. `scroll-top` 塞实测高度 —— 得先量，而量高度的时机很容易踩空
   （`onReady` 时页面还在 loading，滚动区根本还没渲染，量到 0 之后再没更新）；
4. `.sup-chat` 的 `min-height:100%` + `justify-content:flex-end` —— 想把消息顶到底部，
   但 scroll-view 里 100% 没有可参照高度，布局直接乱掉；最后一版给 `.sup-scroll`
   补 `height: 0`（flex 子项被内容撑开后 `flex-grow` 失效）也没根治。

**最终方案：整页滚动 + 输入区固定**
- 会话列表就是普通 `<view>`，滚动交给页面自己。`scrollToBottom` 用
  `wx.pageScrollTo({ scrollTop: 999999, duration: 0 })` —— 页面滚动超过最大可滚距离时
  **框架自己会夹到底部**，既不会滚过头，也不需要知道内容有多高。
  `duration: 0` 是因为流式输出时每次都带动画会一卡一卡。
- 输入区 `position: fixed; bottom: 0; z-index: 12`（低于转人工弹层的 20）。
  textarea 因为在 fixed 容器里，必须显式给 `fixed="{{true}}"`。
- 会话区底部留白 `bodyPad` 由 JS 量 `.sup-input` 实测高度 + 24px 写进内联 style：
  少了最后一条被压住，多了又是一片空白，只能量。输入框自增高（一行变多行）时
  用 `onInput` 节流 200ms 跟着改。
- 贴底判定改 `onPageScroll`：`文档高 − 窗口高 − scrollTop < 60` 就算贴底；
  文档高度取 `.support-page` 的 `boundingClientRect().height`（高度不受滚动影响）。
  没量到就**不做判断、保持未知**，否则一定是「没贴底」，自动滚动从第一条起就永久停摆。
- 键盘弹起时 `bindfocus` 把页面拉到底，否则最后一条会被键盘盖住。
- 临时调试条改成 `position: fixed` 顶在导航条下方（放文档流里一滚就没影，那还截什么图），
  显示「条数 N · 各条高[a,b,c] · 可滚 X · 输入区 Y」。

**同批顺手修**：气泡文本 `tidyText()` 清洗（模型输出首尾换行/连续空行会被 `pre-wrap`
原样渲染，把气泡虚高，看着也像「消息之间空一大块」）。

**待办**：用户确认不再空白后删掉三处临时调试代码 —— `support.js` 的 `debugInfo`
与 `measureLayout` 里的写回、`support.wxml` 的 `.sup-debug` 行、`support.wxss` 的
`.sup-debug` 样式。

---

#### R37 · 第五轮滚动修：回 scroll-view + 显式像素高度，输入区回文档流

用户反馈换来了最关键的判据：**「我发的内容会跟在后面，但回答的内容永远会出现在下一页」**
—— 自己的消息位置对，回答永远差一屏。这说明不是单纯"滚不到底"，而是**落点系统性错位**。

**全面审阅后定位到三处确定问题（R36 那版全中）**：
1. `wx.pageScrollTo({scrollTop: 999999})` 外面包了 `fail: function () {}` —— 调用失败被静默吞掉，
   回答就永远停在视口下方（用户看到的"下一页"）。
2. 贴底判定 `文档高 − 窗口高 − scrollTop < 60`：自定义导航下 `windowHeight` 和真实可视高对不齐，
   算错一次 `_atBottom` 就锁死成 false，`scheduleScroll` 从此**永久不滚**。
3. 输入区 `position: fixed` + 下面垫 `bodyPad` 等高留白：留白算不准就是**一整块空白**，
   正是"中间空一大截"。而且 `min-height:100vh` 让文档高度和内容高度脱钩，落点更难算。

**最终方案（第三次推翻，这次把高度彻底算死）**：
- 整页不滚动（`height:100vh; overflow:hidden`），只有中间 scroll-view 滚。
- **scroll-view 高度给死成像素**：`scrollH = 窗口高 − 导航条高 − 调试条 − 热门 − 输入区`，
  JS 算好写进内联 style。不用 `flex:1`、不用 `height:auto`、不用 `height:0` ——
  高度完全由我们给定，"量错高度"这类问题物理上不可能再发生。
- **输入区回文档流**（`flex:none`），不固定、不垫留白。
- **滚到底两条路叠着走**：
  ① `scroll-into-view` 指末尾锚点 `#chat-end`，走 **`setData` 回调**（保证节点已渲染），
     且先清空再赋值（值没变不触发）；
  ② `scroll-top` 给实测最大可滚（内容高 − 视口高 + 1px 保证值变）。
  塞超大值 999999 已在两处证实会把内容顶上去留空白，别再试。
- **贴底判定改用 scroll-view 自带 `bindscroll` 的 `detail.scrollHeight / scrollTop`**，
  不再量文档高窗口高。没量到就不下判断（否则自动跟随永久停摆）。
- **新消息（`pushMsg`）强制置 `_atBottom = true` 再滚**：贴底判定只该管流式输出要不要跟随，
  不该拦住"用户刚发的那句"和"回答刚到的那句"。R36 就是把它一并交给判定，回答才永远进不来。
- `tidyText` 收紧：全角空格/不间断空格归一、连续空行压成一个换行 ——
  气泡是 `pre-wrap`，模型输出的空行会原样撑高气泡，看着也像"空一大截"。

**R36 结论作废**：「聊天页别用 scroll-view」是错的，正确说法是
**「聊天页要用 scroll-view，但高度必须给死成像素」**。整页滚动那条路也已否决。

**待办**：确认修好后删掉 `.sup-debug` 三处临时调试代码。

---

#### R38 · 整页重写：彻底弃用 scroll-view，普通文档流 + 固定输入区

用户发来两张截图（调试条显示「内容 1053 · 各条高[87,78,137]」），直接给出判决：
**内容 1053px，三条消息加起来才 302px —— 中间 751px 幽灵高度，空白正好卡在第 2、3 条之间。**
这说明 scroll-view 的内容层被某种方式撑开了，前五轮补丁都治不了根。用户说"干脆直接重写"。

**第六版（最终版）：彻底删掉 scroll-view，改整页滚动 + 固定输入区。**

| 环节 | 做法 |
|---|---|
| 会话内容 | 普通 `<view class="sup-chat">`，消息从上往下排，**内容高度 = 消息实际高度之和** |
| 滚动 | **整页滚动**，`wx.pageScrollTo({scrollTop})`，优先用实测位置 `文档高−窗口高+10`，量不到兜底 999999 |
| 输入区 | `position: fixed` 钉屏幕底部，`z-index: 10` |
| 底部留白 | `chatPad` = 输入区实测高度 + 24px，内联 style 写进 `.sup-chat` 的 `padding-bottom` |
| 贴底判定 | `onPageScroll`：`文档高 − 窗口高 − scrollTop < 80`；没量到就不下判断 |
| 调试条 | **已删**（三处临时代码全部清除） |

**为什么这次能成**：scroll-view 的内容高度是"黑盒"（基础库自己算，各版本不一致），
而普通文档流的内容高度就是你排了多高 —— **没有算错的可能**。
前五轮一直在跟 scroll-view 的高度搏斗：flex:1 量不准、height:auto 被撑开、
height:0 方向对但还是被某种方式撑到 1053、scroll-into-view 滚空、scroll-top 塞大值留白。
根因是 scroll-view 内容层的 min-height/height 继承行为在不同基础库上不一致，
对开发者来说是不可控的 —— 所以直接换掉它。

**业务逻辑零改动**：FAQ 匹配、大模型流式、上下文、违规词、配额、转人工全部保留原样。

**待办**：无（调试条已删，功能完整）。

---

### Day 9 — 2026-10-23 晚：合入修复分支 + 安全加固

#### R39 · 合入 `codex/fix-orders-support` 分支

从 GitHub 快进合入 3 个提交（`1e013eb` → `19ac0bf` → `aeb2dfe`），
覆盖订单工作流 20 项 + 智能客服可靠性 18 项 + 测试/CI 基建。

**最关键的修复：客服页消息间隔空白的真正根因**
—— `app.wxss:1816` 有一条全局规则 `.home, .mine { min-height: 100vh; }`，
而客服页消息行的 class 就叫 `mine`，于是**每条「我发的」消息都被撑到一屏高**。
R36–R38 六轮都在调 scroll-view 容器高度，方向完全错了。本分支把类名改成
`msg-mine` / `msg-peer`，空白问题从根上消失。

**其余主要修复**：
- 订单：`list_my_orders_v2` 服务端分页/筛选、请求序号防乱序、登录草稿返回、
  放弃接单 `abandon_order`、送达照片可空、联系方式校验、赏金两位小数
- 客服：键盘高度适配、服务端配额（`begin/finish_support_ai`）、FAQ 单字误命中、
  空气泡、`Promise.race` 超时、会话本地保存、反馈/重新生成
- 安全：删除明文密码存储（`rememberPassword`/`autoLogin` 改 false）、
  `accept_order` 补认证校验 + 禁止自接自单、`completeOrder` 前端不再硬拦空照片
- 后台：工作台入口不再被 `admin_dashboard` 开关挡死；设置页新增「后台密码入口」
- 配置：`project.config.json` 填真实 appid（第三方 skill 文档已在 R42 整体移除）

#### R40 · 审阅补漏：图片越权 + 权限键对齐

R39 之后做了一次全量代码审阅（37 页 / 15 模块 / 22 个 SQL），
本次修掉审阅中发现但分支没覆盖的 5 项：

| # | 问题 | 修法 |
|---|---|---|
| P0-1 | **图片越权读取**：`create_order`/`complete_order` 不校验 asset 归属，`get_order_asset` 只校验「路径挂在单上」→ 任何人建单塞 `asset:123` 就能读别人的图（含证件照，id 可枚举） | 新增 `sql/fix-asset-authorization.sql`：① `orders` 表加 BEFORE INSERT/UPDATE 触发器校验每个 `asset:<id>` 属于调用者；② `get_order_asset` 补「图片必须属于本单参与方」第三道校验 |
| P0-4 | `getOrder` 用 `select('*')` 直读 orders，绕过脱敏 | 改为只取非敏感字段；评价页改用 `getOrderDetail`（服务端脱敏） |
| P1-3 | 评价页 `goBack` 用 try/catch 兜底，`navigateBack` 失败走 fail 回调，catch 永不执行 | 改 `fail` 回调 switchTab |
| P1-4 | 举报模块权限键三处不一致（dashboard 用 support / 页面用 is_admin / 服务端用 review）→ 客服能看不能做，审核员没入口 | 三处统一到 `review` |
| P1-5 | `admin_dashboard_stats` 白名单漏 `dispatch` → 第八级权限进不了后台 | SQL 补 `v_dispatch` + 返回 `can_dispatch`（改返回列需 DROP 重建） |

**顺手清理**：评价页去掉了 `require('../../utils/cloud')` 的裸调兜底分支
（`api.myOrderReviewState` 早已导出，那段是死代码，还绕过 api 层错误处理）。

**✅ 迁移已执行**（2026-10-23 23:5x，经 `workbuddy_cloudservice_db_exec_sql` 直连真库）：
1. `sql/fix-order-support-workflows.sql` —— 7 个 RPC + 3 张表（order_abandonments /
   support_ai_requests / support_answer_ratings），全部 RLS 已开
2. `sql/restore-admin-password.sql` —— 3 张表 + `activate_admin` 重写（盐值哈希 + 15 分钟限频 + 审计）
3. `sql/fix-asset-authorization.sql` —— `orders` 触发器 + `get_order_asset` 归属校验 + `can_dispatch`

**执行方式（踩坑记录）**：这个 MCP 工具一次只接受**一条**语句，多条会报
`42601 cannot insert multiple commands into a prepared statement`。
所以把整个迁移文件拆成单条语句，包进一个 `DO $$ BEGIN EXECUTE $qN$...$qN$; ... END $$;`
—— `DO` 本身是一条语句，既绕过限制又保证整文件原子执行（出错全回滚）。
内层用递增的 `$q1$`…`$qN$` 美元引用，避免和函数体里的 `$fn$` / `$function$` 撞车。

**校验**：四件套 + UI 冒烟全绿；`npm test` 36 项全过；上传包 1.34 MB / 2.00 MB。

---

#### R41 · 修 FAQ 新增/编辑无效 + 审阅遗留问题

**用户报的问题：客服配置页的「+ 新增」「编辑」点了没反应。**

根因不是绑定错了，也不是方法没执行 —— 用测试沙箱跑 `newFaq()` / `editFaq()`，
`editing` 确实变成 `true`、表单数据也回填了。问题是**表单卡片是页面的最后一块**
（在 AI 兜底设置 + 模型 API 配置 + FAQ 列表之后），点完新卡片出现在列表下方一两屏，
屏幕上什么都不变，看起来就是"点了没反应"。

修法：`openForm()` 里走 `setData` 回调，再 `scrollToForm()` 用
`createSelectorQuery` 量 `#faq-form` 的位置 + `wx.pageScrollTo` 滚过去；
量不到就退化滚到底（表单本来就是最后一块）。加了回归测试锁死这个行为。

**同批修掉的审阅遗留项**：

| # | 问题 | 修法 |
|---|---|---|
| P1-7 | 积分调整没有防重，连点两次发两笔 `admin_adjust_points` → 积分翻倍 | `doAdjust` 首行加 `adjusting` 守卫；正常加减也统一过一次确认（够不够扣写进文案，不弹两次） |
| P1-8 | 商品上下架用列表快照整行 upsert，把用户已兑换掉的库存写回旧值 → 凭空多出可兑份数 | 先 `adminListPointGoods()` 拉最新行，只用它改 `enabled`；加 `actingId` 防重 |
| P1-9 | 生产页面留着「生成测试申请」，会往真实审核队列插「测试同学」 | 删按钮 + `makeDemo` + `api.insertDemoApplication` |
| P1-10 | 报价留空当 0 元提交（`Number('') === 0`） | 先判空串，再判 `> 0`，并限两位小数 |
| P1-11 | `getErrorMessage` 直接透出英文 message：断网显示 `request:fail timeout`、token 失效显示 `no active session` | 按 SDK 的 `kind` 契约映射中文；**中文 message 原样透出**（那是我们自己 RPC 的 `RAISE EXCEPTION` 业务文案） |
| P2 | toast 超长被静默截断 | 超 40 字补省略号，让用户知道还有后半句 |
| P2 | `orders/list` 的 `_hideTimer` 没清理 | 补 `onHide` / `onUnload` |
| P2 | `buildTitle` 拿 `description` 前 20 字当标题 → 取餐码/姓名尾号公开到任务大厅 | 标题只由「服务名 + 去向」组成，description 只在详情里给参与者看 |
| P2 | 大厅 `quickAccept` 无并发锁，连点两张卡可并发接两单 | 加 `_accepting` 标记，成功/失败都复位 |
| P2 | FAQ 排序留空变 0，排到全站最前面 | 空串按 100，收口到 0..9999 整数 |

**顺带确认无问题**（审阅里怀疑、实测正常的）：`moderation.js` 的词库缓存判断
（`cached.index.block.length`）是对的，不会每次重发请求。

**校验**：四件套 + UI 冒烟全绿；`npm test` **37 项全过**（新增 FAQ 回归测试 1 项）。

---

#### R42 · 仓库清理：移除第三方文件、重写历史

R39 合入的分支带进来一批**不属于小程序本体**的东西，本轮整体清掉：

| 删除 | 内容 | 量 |
|---|---|---|
| `.agents/` | CloudBase 官方 skill 文档 | 209 个文件 / 2.2 MB |
| `skills-lock.json` | skill 依赖锁文件 | 1 个 |
| `tools/web-preview/` | 浏览器预览壳（小程序用不到） | 4 个文件 |
| `docs/FIX-REPORT-2026-10-23.md` 等 4 份 | 第三方写的修复/测试记录 | 4 个文件 |

**保留**（这些是当前工作流在用的闸门，也已经在里面加过自己的用例）：
`tests/`（37 项回归）、`tools/check-mp.js` / `style-lint.js` / `verify-mp.js` /
`release-check.js`、`.github/workflows/check.yml`、`package.json`。

**历史处理**：R39 的三个提交（作者为第三方）从 `main` 历史中摘除，
R39–R41 压成一条整合提交 `289e081`。改写前后**文件树 hash 完全一致**
（`4d86e16…`），即代码零改动，只有提交边界与作者变了。
R1–R38 的逐轮历史与 5 个 tag 未受影响。

顺带清理：`README` 里指向已删文档的 5 处链接、`package.json` 的 `preview:web` 脚本、
`project.config.json` 里为 `.agents` / `skills-lock.json` 加的 packOptions.ignore。

---
#### R43 · text 返回的 RPC 被整类误判为报错（红条显示 owner / runner）

**用户报的现象**：任务详情页整页进入错误态，顶部红条写着 `runner`，中间 toast 也是
`runner`；换发布者账号打开同一张单，红条变成 `owner`。

**这不是角色文案，是错误信息本身。** 根因分两段：

1. WorkBuddy Cloud SDK 的 `processResponse` 对响应体做 `JSON.parse`，**解析失败时把
   响应体原文塞进 `error.message`**：
   ```js
   try { data = JSON.parse(body) } catch { error = { message: body } }
   ```
2. PostgREST 对 `RETURNS text` 的函数返回的是**裸字符串** `runner`（不是带引号的
   `"runner"`），不是合法 JSON → SDK 判成失败 → 前端 `getOrderRelation` 看到
   `result.error` 就 `throw new Error('runner')` → 整页进错误态。

所以那个位置显示的值**随账号身份变化**：发布者 `owner`、接单员 `runner`、路人 `none`。

**同一类中招的共 7 个函数**（全部 `RETURNS text`）：

| 函数 | 前端表现 |
|---|---|
| `order_relation` | 订单详情整页红条（本次报的就是它） |
| `admin_set_perm` | 后台设置权限后弹 `granted`，看着像失败 |
| `admin_delete_banner` | 删除轮播后弹 `deleted`，以为没删掉 |
| `hide_my_order` / `restore_my_order` | 删除提示 `deleted` / 恢复提示 `restored` |
| `mark_message_read` / `mark_all_messages_read` | 标已读后弹 `read` |

`boolean` / `bigint` / `integer` / `void` 返回的不受影响 —— `true`、`123` 本身就是合法
JSON，空响应体也正常。这就是为什么 `order_hidden`（boolean）一直没事，而
`order_relation`（text）一直坏。这解释了为什么之前没人发现：坏的全是「只回一个状态词」
的接口，看着像小毛病。

**修法**（`sql/fix-text-rpc-returns.sql`）：7 个函数全部改成 `RETURNS TABLE(result text)`
（`order_relation` 用 `TABLE(relation text)`），响应体变成 `[{"result":"deleted"}]`。
改返回类型必须先 `DROP FUNCTION` 再 `CREATE`，重建后 **GRANT 要重新执行**（权限绑在函数 oid 上）。
顺带给 `order_relation` 补上漏掉的 `SET search_path TO 'public'` —— 它原来在
`SECURITY DEFINER` 函数里用不限定名的 `orders`，调用者可以靠改 `search_path` 指到别的表。

**前端配套**：`utils/api.js` 新增 `pickText(result, field)` 统一取 `[{"字段":"值"}]` 里的字符串；
`pages/order/detail.js` 把 `getOrderRelation` 单独 `.catch` 掉 —— 身份判定只决定「显示哪些按钮」，
它单点失败不该让整页白屏。

**验证**（真库，切 `authenticated` 角色 + 设 `request.jwt.claim.sub` 跑）：
同一张单 115，`asOwner=owner` / `asRunner=runner` / `asStranger=none`；
`mark_all_messages_read=read`、`admin_set_perm=granted`、`restore_my_order=restored`。

**教训（写进踩坑库）**：**RPC 的返回类型必须是结构化类型**（`TABLE` / `SETOF` / `json`），
不能是裸 `text`。判断标准很简单 —— 前端能不能 `JSON.parse` 出对象。
以后新增只回状态词的接口，一律 `RETURNS TABLE(result text)`，宁可多包一层。

---

#### R44 · 手机号闸门 + 账号注销（6 个月保留期）

**需求**：①浏览大厅可以，但发单 / 接单 / 查看联系方式前必须绑定手机号；②开关闭注销，
注销后 6 个月内不真删、保留追溯，期内重新登录可选「恢复原账号」，
选「不使用」则不允许注册新账号；③更新用户协议与销号弹窗。

##### 一、手机号为什么走短信而不是微信组件

微信「手机号快速验证组件」（`getPhoneNumber`）只对**非个人主体且已认证**的小程序开放，
2023-08-28 起 **0.03 元/次**（1000 次体验额度），而且拿到的 `code` 必须由**服务端**
用 `access_token` 换取手机号 —— 本项目没有服务端（纯 Postgres + 客户端），换了也没地方执行。
所以走已经在用的 `cloud.auth.sendOtp` 短信验证码；等主体转企业、加上云函数后再换组件，
页面交互不用改。

##### 二、拦截放在服务端，不靠弹窗

客户端弹窗只能引导，改包就绕。真正的闸是**表级触发器**：

| 触发点 | 时机 | 文案 |
|---|---|---|
| `orders_assert_phone` | INSERT 订单 / `runner_id` 由空变非空 | 请先绑定手机号后再发单 / 接单 |
| `runner_applications_assert_phone` | INSERT 接单员申请 | 请先绑定手机号后再提交 |
| `rental_requests_assert_phone` | INSERT 租赁申请 | 同上 |
| `get_order_detail` | 取详情 | 未绑定者 `contact` 一律置空 |

为什么用触发器而不是改 6 个 RPC：`create_order` / `admin_batch_create_orders` 写法各异，
一个个加容易漏；触发器是表级约束，谁都绕不过。三条豁免：`auth.uid()` 为空（直连迁移）、
`admin_is_any()`（管理员批量发单）、以及只改状态不动 `runner_id` 的更新（取消 / 送达 / 确认）。

##### 三、手机号单独一张表

`profile_phones(owner_id PK, phone UNIQUE, verified_at, updated_at)`，**不给任何 policy**，
只有 SECURITY DEFINER 函数能碰。不写成 `profiles.phone` 是因为后台、信誉分页等多处
`SELECT p.*` 往下发，哪天顺手就把号码漏出去了。

绑定时三条约束兜底：格式 `^1[3-9]\d{9}$`、**全站唯一**（含已注销仍在保留期的账号）、
同一账号 **24 小时只能改一次**。

##### 四、注销与 6 个月保留

`profiles.deleted_at` + `account_deletions`（owner_id / 手机号掩码 / 原因 / purge_after /
restored_at / purged_at）。规则：

- 注销前置：无未完成订单（pending / accepted / waiting_confirm）、钱包余额为 0、无后台权限
- 期内登录：`my_account_state` 返回 `can_restore=true`，前端弹「是否使用原账号？」
  - 选恢复 → `restore_my_account` 清 `deleted_at`
  - 选不使用 → 前端 `logout` + 写 `manualLogout` 标记，**保留期内不放行**
- 满 6 个月：`purge_account_data` 清除昵称 / 头像 / 手机号 / 证件照 / 联系方式，
  订单保留去标识化记录，手机号释放可被新账号绑定
- 清理时机：登录时 `purge_my_account_if_due`（只清自己）+ 超管打开工作台时
  `admin_purge_expired_deletions` 兜底（本项目没有定时任务，否则再没人登录的账号永远不会清）

##### 五、残余风险（必须知情）

**手机号是「客户端声明 + 短信验证过」的，服务端无法证明它。** 因为 OTP 由 auth provider 校验，
验证通过后会话会切成手机号身份，而 SDK 没有「绑定手机号」接口，只能：
发码 → 验码（拿到手机号身份的会话）→ 立刻 `wx.login` 切回微信身份 → 调 `bind_my_phone`。
恶意客户端可以跳过发码直接调 RPC 声明一个号码。当前靠三条约束把影响限制在
「占用一个号码」，等接入云函数后应改成「服务端换号 + 签名票据」。

##### 六、协议同步更新

`utils/agreement.js` 版本 `2026.10-v1 → v2`：新增「九、手机号绑定与账号注销（重要）」，
写清保留期、恢复、不恢复的后果与届满后的清除范围；老用户会被要求重新勾选一次。

**校验**：四件套 + 冒烟全绿；`npm test` **48 项全过**（新增 `tests/phone-deletion.test.js`
11 项：未绑定拦截、格式与唯一性、24 小时防抖、注销前置、6 个月恢复、到期清理与号码释放）。
真库验证：`my_phone_state` 绑定前后状态正确、触发器生效。

---

#### R45 · 图片归属触发器误伤接单员（放弃接单 / 提交送达都报错）

**现象**：接单员点「放弃接单」→ 报「图片不属于当前账号，请重新上传」。
用户补了一句：**提交送达时也一样**。

**真因**：R40 加的图片归属触发器把整行拿去校验：

```sql
FROM unnest(COALESCE(NEW.images,'{}') || COALESCE(NEW.deliver_images,'{}'))
WHERE ... AND NOT EXISTS (SELECT 1 FROM media_assets ma
                          WHERE ma.id = ... AND ma.owner_id = auth.uid())
```

但这两列**分属两个人**：

| 列 | 谁写的 | 内容 |
|---|---|---|
| `orders.images` | 发布方 | 任务图（取餐码截图等） |
| `orders.deliver_images` | 接单员 | 送达佐证 |

接单员一更新这行（放弃接单会清空 `deliver_images`、送达会写入 `deliver_images`），
`NEW.images` 里仍然是**发布方的图** → 必然判定越权 → 整笔回滚。
所以不是「放弃」单点问题，是**所有接单员侧的订单更新**都坏了。

**修法**（`sql/fix-order-asset-trigger.sql`）：只校验**本次真正改动的那一列** ——
`INSERT` 两列都校验；`UPDATE` 用 `IS DISTINCT FROM` 判断哪列变了，只校验变了的那列。
没变的列是对方的历史数据，不该拿当前用户去卡。

安全性不变：越权读图的真正边界在 `get_order_asset`（要求图片属于本单参与方），
这里只管「往单子里塞不属于自己的图」，语义反而更准了。

**为什么 R40 没测出来**：当时只测了「建单时塞别人的图会不会被拦」，
没测反向 —— 另一个角色更新同一行时，对方的图片还在行里。这是**多角色共享一张表**的典型盲区。

**校验**：新增 `tests/order-assets.test.js` 5 项（建单越权拦截、放弃接单清空佐证、
送达写自己的佐证、送达塞别人的图被拦、只改状态不触发）。
真库验证：订单 76 `abandon=ok`、`complete=ok rows=1`（事务回滚，未改数据）。

---

#### R46 · 两处布局错位：删除确认换行 / 待办概览留空

**① 订单卡片「再点一次确认删除」和「取消」不在同一行**

`.card-actions` 只写了 `display: flex`，没有对齐方式和换行策略。
未上膛时只有一个「删除订单」，上膛后文案变成 8 个字 + 一个「取消」，
两个按钮就各自占了一行，看着像错位。

修法（`app.wxss`）：`justify-content: space-between` + `flex-wrap: nowrap`，
子项 `flex: 0 0 auto` + `white-space: nowrap` —— 左删除右取消，且任何文案都不折行。

并排之后还有一层：左边是加粗的 8 个字、右边是常规 2 个字，两者行盒高度不同，
`align-items: center` 之后「取消」看着偏高。

**只加 `line-height` 不管用** —— 小程序 `<text>` 组件有自己的行盒算法，不吃这套。
最后把这两个操作项从 `<text>` 换成 `<view>`（走标准 flex 盒模型），
再给子项固定 `line-height: 1.4`，才真正对齐。

**教训**：flex 里要对齐多个文字元素时，别用 `<text>` 当 flex item ——
它本质是 inline 组件，行盒由组件自己算，`align-items` 对不齐。换成 `<view>` 最省事。

**② 待办概览每行只显示两张，右侧空一大格**

`.quick-item` 宽度写的是 `calc(33.3333% - 11rpx)`：

```
3 × (33.3333% - 11rpx) + 2 × 16rpx = 99.9999% - 1rpx
```

**余量只有 1rpx**，真机取整就放不下第三张 → `buildCards` 按 3 张分的组在渲染时折成 2+1。
7 张卡片原本是 3+3+1 三行，实际渲染成 `[2,1][2,1][1]` 五行，每行右侧都空一格。

修法：
- 宽度改 `calc(33.33% - 14rpx)`，3 张总宽约 99.99% - 10rpx，留 ~10rpx 余量
- 「今日订单 / 累计订单」是全局数字，和待办不是一个量纲，
  改成**单独一行两张宽卡**（`wide` 标记 + `calc(50% - 10rpx)`），
  最终 `[3][2][2]` 三行，最后一行刚好铺满

**教训**：`calc(33.3333% - N)` 这种写法别贴着 100% 卡，浏览器/WebView 的百分比取整不可控，
留 10rpx 级别的余量才稳。三列网格宁可每格窄 3rpx，也不要换行。

**校验**：新增 1 项回归（`cardRows` 形状必须是 `3,2,2`，且订单行 `wide=true`）；
`npm test` **55 项全过**；四件套 + 冒烟全绿。

---

### Day 10 — 2026-10-27：企业主体发版准备 / 迁库 CloudBase / 在线支付开工

#### R47 · 默认昵称「同学」绕过强制补全 + AppID 切到企业主体

**① 12 个用户里 9 个叫「同学」**

备份数据时发现：订单卡片清一色显示「发布 同学 · 接单 同学」，交易双方根本分不清是谁。

**真因**：`guard.nicknameMissing()` 只判空串 ——

```js
return !String(profile.nickname || '').trim()
```

而 `ensureProfile` 建号时写的默认昵称就是「同学」。**非空 ⇒ 永不命中 ⇒ 强制补全形同虚设。**
这是典型的「校验写了、默认值把校验架空了」：`nicknameMissing` 的语义是「 nick 不可用」，
不是「 nick 为空」，默认值和空串一样不可用。

修法（`utils/guard.js`）：引入 `DEFAULT_NICKNAMES = ['同学']`，空串、全空格、默认值**都算缺失**。

**教训**：任何「强制用户补全资料」的校验，**必须把建号时写的默认值一起判为缺失**，
否则默认值一写进去，这条校验就永远不再触发。以后加默认值，同步问一句「它会被当缺失吗」。

**② AppID 换成企业主体小程序**

`project.config.json` 的 `appid` 由 `wxf73d4e1b04e62d79`（试用小程序时期）
改为 **`wxaab192c68e403292`（i邮跑，企业主体）**。全仓只有这一处引用 AppID。

**校验**：新增 `tests/workflows.test.js` 1 项（用 `node:vm` 加载 `guard.js` 做纯函数级回归：
空串 / 全空格 / 「同学」都要补全，真实昵称不打断，null 不打断）；`npm test` **55 → 56 项**。

---

#### R48 · 数据库全量迁至 CloudBase（33 批迁移，结构齐平，待切前端 SDK）

**为什么迁**：全自动在线支付（R49）的支付回调必须由**云函数**处理并直接改订单状态，
而 WorkBuddy Cloud 没有云函数、也不对外提供写库的服务端凭据。**没有这一步就没有支付。**

**目标环境**：`ceshi-d2g37cbg7c8f7ee48`（ap-shanghai，PG 模式，体验版套餐，SHARED 租户）。
迁移脚本在 **`cloudbase/migrations/`**（工作区根下，与 `campus-errand/` 同级，**不在本仓库内**）。

**最关键的一条结论**：CloudBase PG **自带 `auth.uid()` / `auth.role()` / `auth.jwt()`，
`auth.uid()` 同样返回 text** —— 129 个函数可以**原样重放、一行不用改写**。
迁移成本因此从「几周」降到「一天」。

**最终验收（2026-10-27 22:59）**：32 表 / 131 函数 / 9 触发器 / 9 策略 / 23 开关全开 /
296 条违规词 / 7 条 FAQ；**前端 `api.js` 里全部 99 个 RPC 在新库零缺失**，只读函数冒烟全过。

**四个新坑**（详见第 5 章）：

1. `applyMigration` **必须内联传 SQL**，只给本地路径报 `SQL_REQUIRED`；
   本地已有同名文件时内容必须逐字符一致，否则 `LOCAL_MIGRATION_FILE_MISMATCH`。
2. `migrationName` 正则 `^[a-z][a-z_]*$` **不允许数字** —— `round4` 被拒，得写 `round_four`。
3. 带 `BEGIN/COMMIT` 的脚本不能拼接（事务嵌套）；`CREATE OR REPLACE` 改不了返回类型（42P13）
   也改不了签名（变重载），这两种都必须先 `DROP FUNCTION`。
4. **两个脚本必须跳过**：`fix-order-hide-scope.sql` 会建 `list_my_orders` 单参数版，
   与已建的三参数版并存产生**重载歧义**；`fix-asset-authorization.sql` 里的
   `assert_order_assets_owned` 是 **R40 整行校验版（有 bug）**，会把 R45 的修正版覆盖回去。

**另有一次误判（值得记）**：中途发现「新库 RLS 策略只剩 1 条」，一度判定为灾难。
查原库 `pg_policies` + `role_table_grants` 后才知道：原库本来就只给 **5 张表**
（`profiles` / `addresses` / `orders` / `rental_requests` / `runner_applications`）客户端直连，
其余 24 张一律 `REVOKE ALL` 只走 RPC —— 漏的是这 5 张的 GRANT + 策略，不是全库。
→ **判断「权限缺失」前先跑 `pg_policies` + `role_table_grants` 看原库实况，别凭「表开了 RLS 却只有一条策略」下结论。**

---

#### R49 · 在线支付打通第一步：云函数 `pay-create` 部署成功 + 提现 RPC

**先纠正一个错判**：此前一直认为「支付必须等前端换完 SDK」。实际不必 ——
`wx.cloud` 是微信原生能力，与 WorkBuddy SDK **并存**，云函数可独立部署、独立测试。

**方案（完整版见 `docs/PAYMENT.md`）**：全自动赏金预付款 + 可提现。

```
付款   用户 → pay-create（云函数签名调 JSAPI 下单）→ wx.requestPayment → pay-notify 回调改 pay_status
结算   确认完成 → settle 记账到接单员余额（此时钱还在商户号）
提现   接单员申请 → transfer 调「商家转账到零钱」→ 直接进接单员微信零钱
```

接单员**不需要商户号**（企业向个人付款的标准能力）。商户号 `1119307371`（普通商户）→
**不能分账**，但「商家转账到零钱」已开通，提现路径不受影响。

**已做**：

1. 支付 DDL（新库）：`orders` 加 `pay_status` / `pay_txn_id` / `paid_at` /
   `settle_amount` / `settled_at` + 2 个索引 + CHECK；新建 `withdraw_requests`
2. 抽佣后台可调：`pay_settings` 单行表（`commission_rate` 0.05 / `min_withdraw` 10 /
   `withdraw_fee_rate` 0.006 / `enabled` false）+ `get_pay_settings()` /
   `calc_settle_amount(reward)` / `admin_update_pay_settings(...)`
   —— **前端必须调 `calc_settle_amount` 而不是自己乘**，四舍五入口径只有一处
3. 提现 4 个 RPC：`create_withdraw_request`（校验余额/门槛/单笔在途）/ `list_my_withdrawals` /
   `admin_list_withdrawals` / `admin_finish_withdrawal`（失败自动退款）
4. 云函数 **`pay-create` 写好并部署成功**（`cloudfunctions/pay-create/`）：
   零外部依赖，只用内置 `crypto` + `https`，`wx-server-sdk` 仅用于取 openid
5. 实测调用 **4ms 返回** `{"ok":false,"code":"ENV_MISSING"}` —— 链路通

**卡在用户侧**：`WXPAY_SERIAL_NO`（证书序列号）+ `WXPAY_PRIVATE_KEY`（`apiclient_key.pem` 全文）
必须用户自己在云函数控制台的环境变量里填，**不能经过对话**。已配 `WXPAY_MCHID` / `WXPAY_APPID`。

**⚠️ 合规（写进 PAYMENT.md 第 4 章）**：平台「先收用户的钱、再转给接单员」在监管口径下
容易被认定为**二清**。规避靠业务定性而非技术：服务定性为「平台自营」、向接单员支付**劳务报酬**，
保留接单员协议与报酬明细，提现设门槛（满 10 元、T+1），不做「余额长期沉淀 + 任意提现」。
正式运营前建议过一遍学校法务/财务。

**待写**：`pay-notify`（回调验签 + 解密）、`transfer`、`transfer-notify`。

---

#### R52 · 前端整体切到 CloudBase + 发单接入微信支付

**背景**：R48 迁完库、R49 部署好 `pay-create` 之后，前端仍然连着旧 WorkBuddy 库 ——
回调改的是新库的 `orders.pay_status`，前端读的是旧库，**两条链路根本不在一起**。
所以「发单不用付款」不是漏了按钮，而是架构上就没接上。本轮一次做完切换 + 接支付。

**① 新通道 `utils/tcb.js`**
网关直连优先（`POST /api/app-api`），域名没配白名单时自动退到 `wx.cloud.callFunction('tcb-proxy')`；
**只有网络层失败才换通道**，业务拒绝（余额不足、无权限）不重试，避免把拒绝当成超时反复打。
会话不再依赖任何 SDK：服务端拿 `WX_APP_SECRET` 签 HMAC 令牌（`v1.<payload>.<sig>`），
验签用 `timingSafeEqual`，uid 必须 `wx:` 开头，端上只负责存和带。

**② 服务端代持身份 `svc_rpc`（关键设计）**
`wx.cloud` 中转之后「调用者是谁」不能再靠客户端声明，所以：云函数先验令牌拿到可信 uid，
再在**同一个事务**里 `set_config('request.jwt.claim.sub', uid)` 后执行业务函数 ——
库里 129 个按 `auth.uid()` 取身份的函数一行都不用改，RLS 与行级校验照常生效。
前端 95 处 `cloud.database.rpc` 批量换成 `rpc()`；剩下 7 处直连表操作
（资料 / 地址簿 / 认证申请）补成服务端函数，做到**没有一处裸表访问**。

**③ 手机号改自建验证码**
不再借道 auth provider，也就不会再出现「绑完跳到另一个账号」（R44 那个坑的根源）。
新增 `phone_codes` 表只存哈希，明文只回到云函数去发短信；新增 `bind_my_phone_verified`
把「验码 + 写入」合成一次 RPC —— 客户端拿不到明文，**跳过发码直接绑号这条路堵死了**
（`add-phone-and-deletion.sql` 里当年记的那条残余风险就此关闭）。

**④ 发单接支付**
- `create_order` 自己决定这一单要不要付钱：总闸关着、或抵扣券把赏金抵满 → 直接 `paid`；
  其余落 `unpaid`（应付 = `reward - discount_amount`）。
- `list_hall_orders` **只放已付的**（批量导入的工单由平台发，放行）。
- 前端 `utils/pay.js`：`wx.login` 取 code → `pay-create` → `wx.requestPayment` →
  轮询 `order_pay_state` 确认落库。**不能只信 `requestPayment` 的 success**，
  它只代表微信扣款成功，库里状态要等回调（1-3 秒）。
- 付不成的单留在「我发布的」里，卡片上多一枚「待付款」和「去支付 ¥x」入口，随时补付。

**踩坑（两条）**
- `bind_my_phone_verified` 自己 `RETURNS TABLE(bound, phone)`，函数体里裸写 `phone`
  就被判 `column reference "phone" is ambiguous` —— **本项目第二次踩 OUT 参数与列名冲突**
  （第一次是 withdraw 那条）。改法一致：表一律起别名、列一律带限定。
- 换 SDK 时漏删 `sendPhoneCode` / `myAuthPhone` 的函数体，导出里却还留着引用 ——
  `node --check` 照样过（它不查未声明标识符），真机一 `require` 就是 ReferenceError。
  **四件套跑完还要再扫一遍「导出的名字有没有对应实现」**。

**顺带**：删除 `utils/cloud.js` / `utils/workbuddy-cloud-diagnostics.js` / `miniprogram_npm/`
（508 KB），主包 1.44 MB → **0.94 MB**。

**遗留**：短信要腾讯云 SMS 的 5 个环境变量（`SMS_SECRET_ID` / `SMS_SECRET_KEY` /
`SMS_SDK_APP_ID` / `SMS_TEMPLATE_ID` / `SMS_SIGN_NAME`）。没配之前新用户绑不了手机号
（管理员账号已绑，不受影响），前端会明确提示「短信通道未开通」。

> 轮次说明：R50（支付打通：JSAPI 下单 + 公钥验签回调 + 金额核对 + 幂等）与
> R51（提现打通：云托管固定 IP + 商家转账 + 确认收款 + 失败自动退款）当时只写进了 README，
> 本文件漏记了两条，这里按 README 的编号往下接，故本轮为 **R52**。

---

#### R53 · 图片分片上传（修掉接单员传身份证弹 EXCEED_MAX_PAYLOAD_SIZE）

**症状**：「成为接单员」页上传身份证正面时弹一串大写英文 `EXCEED_MAX_PAYLOAD_SIZE`，
学生证那张小一点反而能过 —— 典型的「看体积下菜碟」，说明卡在**传输通道**而不是业务逻辑。

**根因**：链路是
`小程序 --(wx.request / wx.cloud.callFunction)--> 网关 --(https)--> app-api --> svc_rpc`。
真正的卡点是 **CloudBase HTTP 访问服务的请求体上限 = 100 KB（精确值 102400 字节）**，
超了网关直接回 `HTTP 413 {"code":"EXCEED_MAX_PAYLOAD_SIZE"}`；客户端把 `code` 原样透出，
就是用户看到的那行英文。而图片是 base64 塞在 `args` 里的，一张手机照片轻松 1~3MB，
必挂。服务端 `save_media_asset` 收 2.6M 字符才报太大，根本轮不到它 —— 所以服务端
日志里什么都查不到，这是「查后端没用」的典型。

> ⚠️ **第一版修错了，记下来免得再犯**：当时凭印象按「`wx.cloud.callFunction` 入参约 1MB」
> 设计，把片大小定成 **400 KB** —— 比 100 KB 上限大 4 倍，**每一片都必然 413**，
> 分片等于没做，用户重测照样弹英文。结论：**通道上限必须实测，不能靠印象估。**

**修法（三道线，各管一段）**

| 线 | 值 | 管什么 |
|---|---|---|
| 压缩线 `CHANNEL_BUDGET` | 原图 420 KB | 压到这里就停，只为减少分片次数，不为压到极限 |
| 整包线 `WHOLE_CALL_B64` | base64 64 KB | 只有这么小的图才整包发，其余直接走分片 |
| 单片线 `CHUNK_B64` | base64 80 KB | 请求体约 82 KB，距 100 KB 上限留约 18 KB 余量 |
| 服务端线 `MAX_UPLOAD_BYTES` | 原图 690 KB | 由服务端 950000 字符上限反推，到这里只能报错 |

> **读写上限不对称**（实测）：写必须切 ≤80 KB 的片，读可以一次拿回近 1 MB。
> 所以「能存进去的图一定读得回来」这条由 `SERVER_MAX_B64` 统一推导保证。

1. **压缩改成阶梯式**（`utils/upload.js` 的 `fitChannel`）：从原图按 70 → 55 → 40 → 25 逐级压，
   谁先达标用谁（只压一次，画质最好）；四档都压不下来才在产物上再压一次。
   原来只有「60 → 35」两级，大图照样过线。
2. **新增分片通道**：`begin_media_upload` → `push_media_part`（逐片）→ `finish_media_upload`
   （服务端按序号拼回、入库、删临时行）。每片 **80 KB**，单次调用永远在安全线内
   （初始版本定 400 KB，超出网关上限 4 倍，必挂）。
   **证件照不用为了塞进通道被压糊** —— 人工核验要看清姓名学号，这是分片的真正价值。
   同序号重复写会覆盖，网络重试不会拼出重复内容；半成品 2 小时后自动清理。
3. **兜底重试**：体积估算总会有偏差，若整包真被通道拒（`payloadTooLarge`），
   自动把片切到 48 KB 再来一次，不把英文报错丢给用户。
4. **报错人话化**：`EXCEED_MAX_PAYLOAD_SIZE` → 「图片太大，单次传不下，请换一张小点的图」。

**验证（网关实跑，非推演）**：
- 二分探测出请求体上限：64 KB 字符 → 200；96 KB → 200；112 KB → **413**；上限 = **102400 字节**。
- 修正后整包往返：690 KB 图 → base64 942080 字符 → **12 片全部 200** → finish → `asset_id`
  → 读回 942140 字节，**内容逐字符一致**，耗时约 2 s。
- 服务端 DO 块另跑通「没传完就收尾被拒 / 拼回内容一致 / 临时行清零 / 别人的任务传不进去」。
- 新增 `tests/upload-chunk.test.js` 6 条。全量 **63 项测试通过**。

**踩坑**：`INSERT ... RETURNING mu.id` 里用别名必须写成 `INSERT INTO t AS mu`，
否则报 `missing FROM-clause entry for table "mu"`；`finish_media_upload` 自己
`RETURNS TABLE(asset_id)`，函数体里的表仍要一律起别名（**OUT 参数撞列名第三次**）。

**补充（同轮追加）**：用户指出「只有拍照的会压缩」—— 属实。`wx.chooseMedia` 的
`sizeType:['compressed']` 官方只说「仅对 mediaType 为 image 时有效」，实测**从相册选的图
基本原样返回**（社区还有"压完反而更大"的反馈）。因此：
- 压缩**不看来源，一律自己做**，不把 `sizeType` 当依赖（本来也没依赖，但把档位从
  4 档扩到 6 档 70/55/40/25/15/8，并加了「压了跟没压一样就提前收手」，避免接口不可用时白转）；
- 服务端上限从 **1.9MB 收到 690KB**（迁移 `20261029225000_media_asset_limit`）：
  原上限是按**写入**算的，可图片**读回来同样受体积限制**，1.9MB 的图存进去就是一张
  **存得进、读不出的死图**。按服务端 950000 字符上限反推原图 = 950000 × 3/4 ≈ 712KB，
  客户端取 690KB 留余量。读回侧已实测：690KB 的图一次拿回 942140 字节、内容一致。

---

#### R54 · 提现改服务端自动转账（不用管理员点那一下）

**现象**：用户提现 10 元后，记录一直停在「待处理」，看起来像"又回退到手动版本"。

**根因是两个叠在一起的**：
1. **流程上从来没做到"提交即打款"**：`withdraw-api` 的 `create` 只建单，打款要管理员
   在后台「提现管理」里点一下「自动转账」。之前两次真金实测都是人工点的，所以体感上
   像是"自动"，实际链路里一直留着人工这一环。
2. **就算点了也会被拒**：云托管 `transfer-svc` 硬校验 `String(p.secret) !== SECRET`，
   而云函数 `withdraw-api` 的环境变量里**根本没有 `PAY_WEBHOOK_SECRET`** —— 转发时带的是
   空串，云托管直接回 `FORBIDDEN / secret 不匹配`。这层校验是 011 版本（01:57）加的，
   而 id=15 那次成功的转账发生在 01:39，**恰好在加密钥校验之前**，所以当时没暴露。

**修法**：
- `withdraw-api` 抽出统一的 `doTransfer()`（后台手动重试与自动打款共用一份实现）；
  `create` 成功后立刻打款，`summary` 再补转一次「还停在 pending 的历史单」——
  这样自动转账上线前申请的旧单（本轮就是 id=16）打开钱包页就会被转走，不用人工捞。
- **密钥不在控制台之间搬运**：环境变量没配时，云函数运行时自己读
  `pay_settings.webhook_secret`（当初发给云托管的就是这个值），两边天然一致。
- **留两道人工闸门**：`AUTO_TRANSFER=0` 可整体退回人工模式；`AUTO_TRANSFER_MAX`
  （默认 200 元）以上的单不自动打款，交给后台确认。
- **幂等与兜底**：`transfer_prepare` 会把单锁成 processing，重复调用不会重复打款；
  打款失败不影响申请本身（照常返回成功），后台可重试或标记失败自动退款。

**前端**：钱包页按返回的 `auto` 结果提示 —— 成功且 `WAIT_USER_CONFIRM` 时提示
「已自动转账，请点上方确认收款」，失败时如实说「自动转账未成功，可在后台重试」，
不再一律只说"申请已提交"。

**同轮追加的钱包页三处 UI 问题**（用户截图反馈）：
1. **余额明细文字重叠** —— 根因是 `kind` 的中文映射漏了 `withdraw_refund`，
   兜底又把英文原值直接显示出来，长串英文压在右侧金额上。
   修法两层：① `KIND_TEXT` 补 `withdraw_refund: '提现退回'`，
   **未映射的一律兜底成「其他」**（不再有任何英文原值泄漏到界面）；
   ② 布局上 `.detail-label` 全局是固定 `180rpx`、长文本必然溢出，
   钱包页改用专属 `wd-row / wd-label / wd-value`：左侧 `flex:1; min-width:0` 可收缩、
   类型名单行省略，右侧金额 `flex:none` 不参与压缩。
2. **申请提现后页面被刷到顶部** —— `loadWithdraw` 每次都把 `wdLoading` 置 true，
   整个提现区被替换成「加载中…」，页面高度骤减 → 滚动位置被顶回顶部。
   改成**静默刷新**：骨架已就绪时只换数据不动结构（`wdLoading && !wdReady` 才显示占位），
   并单独加 `refreshWithdraw()`（wxml 的 `bindtap` 会把事件对象当参数传进去）。
3. **确认收款改成弹窗** —— 转账发起后直接 `wx.showModal`（主按钮「确认收款」、
   次按钮「稍后」），确认即 `wx.requestMerchantTransfer`，不用等页面刷完再去找入口。

**校验**：新增 `tests/withdraw-auto.test.js` 10 条（默认开关、上限边界、create 自动打款、
summary 补转、手动与自动共用一份实现、前端提示、kind 映射、明细行布局、静默刷新、弹窗确认）。
全量 **73 项测试通过**；四件套全绿，主包 0.97 MB。`withdraw-api` 已重新部署到 `ceshi`。

**踩坑**：
- `updateFunctionCode` 传 `envVariables` 不会落到函数配置上（事后查详情里没有），
  要改环境变量得走 `updateFunctionConfig`。本轮改成读库之后，这两个变量也就没必要配了。
- 环境没开日志服务（`LOG_SERVICE_NOT_ENABLED`），云函数日志查不到，只能靠
  `withdraw_requests` 的状态变化反推链路是否真的通 —— **验证必须是端到端的**。

---

#### R55 · 手机号验证码：短信没开通时的超管调试通道

**现象**：绑定手机号点「获取验证码」，一律失败，提示「短信通道未开通，请联系管理员」——
可提这个需求的人自己就是管理员，等于整条链路谁也走不通。

**根因**：R52 把验证码改成服务端自建（6 位码、`phone_codes` 只存哈希、明文只回云函数发短信）
时，短信走腾讯云 SMS，需要 5 个环境变量（`SMS_SECRET_ID` / `SMS_SECRET_KEY` /
`SMS_SDK_APP_ID` / `SMS_TEMPLATE_ID` / `SMS_SIGN_NAME`）。`app-api` 上一个都没配，
所以 `smsConfigured()` 恒为假，发码在生成之前就被拒。这是 R52 当时就记下的遗留项，
一直没被真正解决。

**修法**：给超级管理员开一条调试通道 —— 短信没配好时，调用者若是 super，
云函数照常生成验证码但**不发短信**，把明文回显给前端，页面自动填进输入框并说明
「当前走管理员调试通道」。

**为什么不做成开关**：一旦引入 `SMS_DEV_ECHO` 之类的环境变量，就一定有人忘了关，
明文验证码会长期暴露在生产环境。这里把条件直接绑成「短信没配好」——
短信配好的那一刻这条分支自动失效，不存在忘记关的可能。测试里对此做了反向断言
（`tests/phone-code.test.js` 第 4 条禁止出现任何调试开关字样）。

**安全边界**（三条，缺一不可）：
1. 权限**现场查** `admin_my_perms`，不信客户端任何声明；判断必须早于生成验证码。
2. 短信一旦配好（`smsConfigured()` 为真），走 `sendSms` 后只回 `{ ok: true }`，
   `devCode` 绝不会出现在响应里 —— 这条是安全底线，测试第 3 条钉死。
3. 当前库里只有一条 super 授权（`wx:oGbsX…`），即使回显也只影响这一个账号。

**校验**：新增 `tests/phone-code.test.js` 6 条（未开通不假装成功、只对超管开放且现场查权限、
开通后不回显明文、禁止引入调试开关、前端自动填入、提示不用报错红）。
全量 **79 项测试通过**；四件套全绿，主包 0.97 MB。`app-api` 已重新部署到 `ceshi`。

**仍未解决**：短信通道本身没开通，普通用户绑不了手机号。要真正解决，二选一：
- 腾讯云 SMS：开通服务 → 申请签名（需企业资质）→ 报备模板 → 拿齐 5 个值配到 `app-api`
  环境变量，代码已就绪，配完即生效、不用改代码；
- 微信「手机号快速验证组件」`getPhoneNumber`：不需要短信，但要**非个人主体**且已认证，
  按次计费（0.03 元/次，赠送额度 1000 次），主体审核通过后才能用。

---

#### R56 · 手机号绑定改走微信快速验证组件（免短信）

**背景**：R55 只是给超管开了调试通道，普通用户仍然绑不了号。短信要腾讯云 SMS 的
5 个环境变量 + 企业资质签名报备，短期拿不到；而**主体已转企业并通过审核**，
微信「手机号快速验证组件」`getPhoneNumber` 这条路就通了 —— 号码由微信直接给，
不经用户输入，也不用短信。

**链路**（四步，全部在服务端）：
1. 前端 `<button open-type="getPhoneNumber">`，用户点允许后微信给一个**一次性 code**
   （5 分钟有效、只能用一次）。
2. 云函数 `app-api` 新增 `bindWxPhone`：用 AppID + AppSecret 换 access_token
   （模块级缓存，提前 60 秒过期）→ `POST /wxa/business/getuserphonenumber` 换手机号。
3. 换到的号码**不返回给客户端**，立刻调 `issue_wx_phone_ticket` 签一张一次性票据。
4. 再调 `bind_my_phone_wx` 凭票据完成绑定（内部复用 `_bind_phone_row`，
   与短信那条路共用同一份「24 小时只能改一次 / 一号一账号」的规则）。

**为什么中间要插一张票据**：`bind_my_phone_wx` 是「免验证码直接绑号」。
如果谁都能调，R52 好不容易堵死的「跳过发码直接绑号」就又开回来了 —— 而且这次更糟，
因为连验证码都不用猜。所以绑定必须出示云函数刚签发的凭据：明文只回给云函数、
库里只存哈希、5 分钟有效、用完即废。这样即使有人绕过 `app-api`
直接拿 publishable key 调 rpc，也造不出有效凭据。两个函数都进了 `SERVER_ONLY_FNS`。

**踩坑**：
- 环境**没装 pgcrypto**，`gen_random_bytes()` 不存在（实测报 42883）。
  票据改用内置 `sha256(random()::text || clock_timestamp()::text || uid || phone)`。
- **OUT 参数列名会变成 plpgsql 变量**（本项目第 3 次撞上）：`RETURNS TABLE(bound, phone)`
  里 `phone` 是变量，所以 `_bind_phone_row` 的结果一律写成 `r.bound, r.phone`，不写裸列名。
- 微信返回的 `phone_info` 里 `phoneNumber` 带 `+86`、`purePhoneNumber` 不带，
  且两者都可能缺 —— 两个都认，再统一剥前缀并用 `^1[3-9]\d{9}$` 复核一次。

**降级路径**：组件没开通、用户拒绝授权、基础库太旧，都拿不到 code。
这时前端提示「未获取到微信手机号，可改用短信验证码绑定」，退回手动输入，
不把绑定卡死在一条路上。短信那条路（`sendPhoneCode` + `bindPhone`）原样保留。

**验证**：库内端到端跑通（主动回滚、零副作用）——
票据长度 64、错误凭据被拒（「绑定凭据不正确」）、正确凭据走完 `_bind_phone_row`
返回 `bound=t`；验证后 `wx_phone_tickets` 0 行、手机号未变。
新增测试 5 条，`phone-code.test.js` 共 11 条，全量 **84 项通过**；四件套全绿，主包 0.97 MB。
`app-api` 已重新部署到 `ceshi`。

**待用户确认**：手机号快速验证组件需在微信后台开通并按次计费（0.03 元/次）。
未开通时点按钮会拿不到 code，走上面的降级路径 —— 真机点一次即可判断。

### R57 · 客服会话与反馈三修，外加把智能客服从「死的」救活（10-30 凌晨）

用户一次性报了三个界面问题，外加一句「还有 AI 客服无可用模型修一下」。四个都改完才发现，
**前三个其实是同一类病：改过一次、换个地方又犯。**

#### 1. 工单会话「两句话中间空很多」—— 和 R39 那个雷一模一样

`pages/feedback/thread` 的 align 计算出的是裸的 `mine` / `peer`，而 `app.wxss` 有
`.home, .mine { min-height: 100vh }` —— **每条自己发的消息被撑成一屏高**。
这正是 R36–R38 连改六轮才定位到的那个坑（当时把 support 页改成了 `msg-mine` / `msg-peer`，
但工单会话页是后来新写的，又写回了裸 `mine`）。

这次不只是改名，而是**把雷挖掉**：
- 全局命名空间统一成 `pg-home` / `pg-mine` / `pg-hall` / `pg-orders`，四个页面根节点跟着改；
- 会话气泡对齐 `msg-mine` / `msg-peer`，与智能客服页一致；
- 给 `.chat-scroll` 补 `height: 0`（scroll-view 默认 `height:auto` 会被内容撑开，`flex-grow` 管不住它）；
- **`style-lint` 加一条规则**：wxss 选择器与 wxml class 里出现裸的 `home/mine/hall/orders` 直接报错。
  已经验证过：往 thread.wxss 里塞一行 `.mine { color: red }` 会被拦下。

#### 2. 点进对话后「N 条未读」不刷新 —— SQL 里一个 ELSIF

库里实况：`user_feedbacks` id=1，`user_seen_at` 一直是 NULL，而 `admin_seen_at` 每次都被刷新。
说明标记已读一直在跑，只是**写错了列**。

```sql
IF v_admin THEN          -- 有 support 权限
  UPDATE ... admin_seen_at
ELSIF v_row.user_id = v_uid THEN   -- 是提交人
  UPDATE ... user_seen_at
```

「提交人恰好是超管」时两个条件同时成立，`ELSIF` 只走第一支 —— 客服侧的已读一直更新，
自己作为提交人的已读永远不动，而 `list_my_feedbacks` 的未读数正是按 `user_seen_at` 算的。

还有第二个成因：**未读数把「自己发的」也算进去了**。同一人既是提交人又有客服权限时，
他在会话里说的话 role 是 `admin`，于是被算成「客服的新回复」——截图里那 2 条未读，
其实全是用户自己发的。

改法：两支判断拆开、写进同一个 UPDATE；三个列表/详情函数的未读口径统一加 `r.user_id <> v_uid`。
库内验证（主动回滚零副作用）：`user_seen_at` 从 NULL 被正确写上、错误凭据仍被拒、未读数归零。

#### 3. 反馈列表文字折断 —— 又踩 `.detail-label`

「最新（10-30 00:28）」在截图里显示成 `00:2 8`，因为整行用的是全局 `.detail-label`
（左侧写死 `180rpx`），长文本在时间中间折行。改成本页专属 `fb-row / fb-main / fb-side`：
左侧 `flex:1; min-width:0` 可收缩，右侧状态块 `flex:none` 不参与压缩。

#### 4. 「AI 客服无可用模型」—— R52 留下的占位实现

R52 迁库时 `cloud.llm.*` 整体失效，当时的处理是「`llmModels()` 返回空数组、`llmChat()` 直接抛错」，
于是后台一直显示「暂无可用模型」，智能客服从那时起就是死的。

现在新建 `cloudfunctions/ai-api`：
- 走 CloudBase 自带的 OpenAI 兼容接口 `https://{env}.api.tcloudbasegateway.com/v1/ai/cloudbase`
- **密钥只在云函数里**（`TCB_AI_KEY`），端上只带 action / model / messages
- **必须验会话令牌**（AI 是要花钱的），每日次数另由库里 `begin_support_ai` 限流
- 网关加路由 `/api/ai-api`，`tcb-proxy` 白名单同步放行

**踩坑：CloudBase 的 AI 接口没有模型列表路由。** `/models`、`/v1/models`、`/v1/ai/models`
全是 403 / 404（`/models` 会被当成模型名，报 `AI_MODEL_NOT_SUPPORTED`）。
所以改成内置静态目录，并且是**实测过的**：逐个真调了一遍，本环境只有 `hy3` 与 `hy3-preview` 可用
（小程序成长计划送的正是 hy3 额度），deepseek / glm / kimi / qwen / minimax 全都是 403 ——
要用得先买 Token 资源包，买了之后把模型名填进 `TCB_AI_MODELS` 即可，不用改代码。

另一个坑：**hy3 是推理模型**，`max_tokens` 给小了会出现「reasoning 写完了、正文一个字没出」。
已兜下限 300，并在只有思考过程时明确报 `AI_EMPTY`，不假装回答成功。

顺带把库里 `faq_settings.ai_model` 从已失效的 `deepseek-v4.1-flash` 改成 `hy3`。
端到端实测：`chat` 3.2 秒返回「校园跑腿是指学生在校园内为其他同学提供代买、代送、代取等有偿或互助性质的便捷代办服务。」

#### 校验
新增 `tests/feedback-ui.test.js` 13 条（类名前缀、scroll-view 高度、列表布局、SQL 双写、排除自己、
大模型非占位、密钥不下发、令牌校验、内置目录、空正文、网关与转发白名单）。
全量 **97 项通过**；四件套全绿，主包 **0.98 MB**。`ai-api` 已部署并建好网关路由。

---

---

## 3. 数据库演进总览

### 数据表（36 张，全量 RLS）

| 表 | 用途 | 引入轮次 |
|---|---|---|
| `profiles` | 用户资料、角色、认证状态、积分、信誉分 | R1 |
| `orders` | 任务订单（含租赁工单、35+ 列） | R1 |
| `addresses` | 我的常用地址 | R1 |
| `runner_applications` | 接单员实名认证申请（证件照脱敏） | R1 |
| `rental_requests` | 相机租赁预填申请 | R11 |
| `order_hides` | 订单隐藏记录（软删除，整单生效） | R21 |
| `order_reports` | 举报工单 | R19 |
| `order_reviews` | 双向评价 | R22 |
| `moderation_words` | 违规词库（黑名单/白名单，后台可维护） | R19 |
| `media_assets` | 图片二进制（base64 存 text 列，替代对象存储） | R18 |
| `rental_items` | 相机机型与挂牌价（后台可维护） | R20 |
| `admin_grants` | 管理员八级权限 | R22 |
| `feature_flags` | 灰度开关（现 23 个） | R22 |
| `banners` | 首页轮播 | R22 |
| `messages` | 站内消息（触发器自动产生） | R22 |
| `point_records` | 积分流水 | R22 |
| `wallet_records` | 钱包流水 | R22 |
| `point_goods` | 积分商城礼券（含 benefit_type / deduct_value） | R23 / R28 |
| `point_redemptions` | 兑换码（含 used_by / order_id） | R23 / R28 |
| `user_feedbacks` | 客服工单（含双方已读水位） | R22 / R27 |
| `feedback_replies` | 工单对话 | R27 |
| `faq_items` | 智能客服 FAQ：分类 / 问题 / 固定回答 / 关键词 / 排序 / 上下架 | R34 |
| `faq_settings` | 客服设置单行表：AI 开关 / 模型 / 提示词 / 欢迎语 / 上限 + 5 个模型参数 | R34 / R35 |
| `order_abandonments` | 放弃接单记录（谁在哪一单上放弃过，防反复刷单） | R39 |
| `support_ai_requests` | AI 提问配额台账（按账号 + 日期，预占 130 秒过期） | R39 |
| `support_answer_ratings` | 回答有帮助 / 没帮助的评价（AI 与 FAQ 共用） | R39 |
| `admin_password_settings` | 后台密码（盐值 + 哈希，单行表） | R39 |
| `admin_password_attempts` | 后台密码失败限流（15 分钟窗口） | R39 |
| `admin_password_audit` | 后台密码激活审计 | R39 |
| `profile_phones` | 绑定手机号（全站唯一，无 policy，只给函数访问） | R44 |
| `account_deletions` | 注销记录（保留期 / 恢复 / 清理审计） | R44 |
| `pay_settings` | 支付总闸 / 费率（单行表，公开读） | R50 |
| `withdraw_requests` | 提现申请（含失败自动退款与对账状态） | R51 |
| `phone_codes` | 短信验证码（**只存哈希**，明文只回云函数发短信） | R52 |
| `wx_phone_tickets` | 微信取号的一次性绑定凭据（**只存哈希**，5 分钟有效、用完即废） | R56 |
| `media_uploads` | 图片分片上传任务（uid 隔离，2 小时自动清理） | R53 |
| `media_upload_parts` | 图片分片内容（按序号拼接，级联删除） | R53 |

### 关键：orders 表的列演进
```
R1   基础字段：owner_id / runner_id / title / desc / pickup_addr / deliver_addr /
     contact / reward / status / times
R11  结算链路：runner_done_at / feedback_text / feedback_at / feedback_status /
     admin_note / is_special / finished_at
R19  违规下架：takedown boolean
R28  结构化地址 + 送达佐证 + 抵扣：pickup_building / pickup_floor /
     deliver_building / deliver_floor / deliver_images text[] /
     discount_code / discount_amount
```

### 订单状态机（R11 之后确定）
```
pending ──accept_order──> accepted ──complete_order(+佐证照片)──> waiting_confirm
   │                          │                                        │
   │                     cancel_order                          confirm_order_done
   └──cancel_order──> canceled                                         ↓
                                                        done（钱包入账 + 下单人积分 + 评价待办）

waiting_confirm 满 48h → submit_settle_feedback → admin_resolve_feedback（管理员判定结算）
```

### 数据库函数（154 个，现役 CloudBase 库）
按职能分：
- **订单**：`create_order`(17参) / `accept_order` / `complete_order` / `cancel_order` / `confirm_order_done` / `get_order_detail` / `order_relation` / `list_my_orders` / `search_my_orders` / `hide_my_order` / `order_hidden` …
- **图片**：`save_media_asset` / `get_media_asset` / `get_public_asset` / **`get_order_asset`**
- **租赁**：`submit_rental_request` / `admin_set_rental_price` / `admin_create_rental_order` / `list_rental_items` / `admin_*_rental_item`
- **结算与争议**：`submit_settle_feedback` / `admin_list_feedbacks` / `admin_resolve_feedback`
- **积分商城**：`list_point_goods` / `exchange_point_goods` / `list_my_coupons` / `admin_list_point_goods` / `admin_upsert_point_goods` / `admin_adjust_points` / `admin_verify_redemption`
- **评价与信誉**：`submit_order_review` / `list_my_review_todo` / `order_peer_credit` / `my_credit_summary`
- **客服**：`submit_user_feedback` / `feedback_detail` / `feedback_thread` / `feedback_reply` / `feedback_mark_read` / `admin_reopen_feedback`
- **权限**：`admin_has_perm` / `admin_can_grant` / `admin_my_perms` / `admin_search_staff` / `admin_set_perm` / `admin_is_any` / `admin_set_feature_flag`
- **内容安全**：`normalize_mod_text` / `scan_moderation_words` / `list_active_moderation_words`
- **智能客服**：`list_faq_items` / `get_faq_settings` / `admin_list_faq_items` /
  `admin_upsert_faq_item` / `admin_delete_faq_item` / `admin_get_faq_settings` /
  `admin_update_faq_settings`(10 参数)
- **订单分页与放弃接单（R39）**：`list_my_orders_v2`(5 参数) / `abandon_order`
- **AI 配额（R39）**：`support_ai_usage` / `begin_support_ai` / `finish_support_ai` /
  `rate_support_answer`
- **后台密码（R39）**：`activate_admin`（盐值哈希 + 15 分钟限频 + 审计）
- **手机号（R44）**：`my_phone_state` / `has_phone` / `bind_my_phone` / `assert_phone_bound`
- **账号注销（R44）**：`my_account_state` / `request_account_deletion` / `restore_my_account` /
  `purge_account_data` / `purge_my_account_if_due` / `admin_purge_expired_deletions`
- **支付与抽佣（R50–R52）**：`get_pay_settings` / `admin_update_pay_settings` /
  `order_pay_state` / `mark_order_paid` / `calc_settle_amount`
- **提现与商家转账（R51–R52）**：`create_withdraw_request` / `list_my_withdrawals` /
  `list_my_wallet_records` / `admin_list_withdrawals` / `admin_finish_withdrawal` /
  `svc_create_withdraw` / `transfer_prepare` / `svc_save_transfer_result`
- **服务端短信验证码（R52）**：`issue_phone_code` / `bind_my_phone_verified` / `_bind_phone_row`
- **图片分片上传（R53）**：`begin_media_upload` / `push_media_part` / `finish_media_upload`
- **云函数代持身份（R52）**：`svc_rpc` —— 先验 HMAC 令牌取可信 uid，再
  `set_config('request.jwt.claim.sub', uid)`，最后执行业务函数；`svc_*` 与
  `SERVER_ONLY_FNS`（`issue_phone_code` / `bind_my_phone*`）禁止客户端直接调用。

### SQL 脚本清单（`campus-errand/sql/`，共 28 个）

| 文件 | 内容 |
|---|---|
| `fix-admin-review.sql` | 修 `list_runner_applications` 的 ambiguous |
| `fix-media-asset-store.sql` | media_assets 表与 save/get 函数 |
| `fix-order-hide-scope.sql` | 幂等迁移，隐藏改为整单生效 |
| `add-order-delete.sql` | order_hides 软删除体系 |
| `add-order-write-guard.sql` | BEFORE INSERT 守卫（fail-open） |
| `drop-orders-write-own.sql` | 已执行，回滚语句留在注释里 |
| `add-content-moderation.sql` + `moderation-words-seed.generated.sql` | 违规词三层拦截 |
| `add-rental-items.sql` | rental_items 表与后台读写 |
| `add-admin-roles.sql` / `add-feature-flags.sql` | admin_grants / feature_flags |
| `add-banners-messages.sql` / `add-notifications.sql` | 轮播、消息、触发器 |
| `add-reviews-points-feedback.sql`(+`-2`) | 评价、积分、反馈 |
| `add-paging-search-dashboard.sql` | 分页、搜索、工作台统计 |
| `add-round4.sql` | 积分归属、实名、评价汇总、积分商城 |
| `add-round5.sql` | 积分归下单人、信誉分互看、读策略收紧 |
| **`add-round6.sql`** | 大厅筛选字段、开价下限、送达佐证、券抵扣、按订单取图 |
| **`add-round7.sql`** | 优先券次卡化 / 信誉分双轨 / 举报下架扣分 / 批量发单 / 地址回填 |
| **`add-feedback-thread.sql`** | 工单双向对话（feedback_replies + 已读水位） |
| **`add-ai-support.sql`** | 智能客服：`faq_items` / `faq_settings` 两张表 + 7 个函数 + 开关 `ai_support` |
| **`fix-order-support-workflows.sql`** | 订单分页 / 放弃接单 / AI 配额台账（R39） |
| **`restore-admin-password.sql`** | 后台密码体系：盐值哈希 + 限流 + 审计（R39） |
| **`fix-asset-authorization.sql`** | 图片归属触发器 + `get_order_asset` 第三道校验 + `can_dispatch`（R40） |
| **`fix-text-rpc-returns.sql`** | 7 个 text 返回的 RPC 改 `RETURNS TABLE`（R43） |
| **`add-phone-and-deletion.sql`** | 手机号闸门（3 个触发器）+ 注销 6 个月保留（R44） |
| **`fix-order-asset-trigger.sql`** | 图片归属触发器只校验改动列（R45） |

> 上面 28 个脚本面向 **WorkBuddy Cloud 运行库**。R48/R49 的新增结构不在这个目录 ——
> 33 批迁库脚本与支付 DDL 在 **`cloudbase/migrations/`**（工作区根下，与 `campus-errand/` 同级，
> 不在本仓库内），`cloudbase/MIGRATION.md` 记执行顺序，`cloudbase/HANDOFF.md` 是一页纸交接单。

### 支付相关（R49 · 只落在 CloudBase 新库）

| 对象 | 用途 | 备注 |
|---|---|---|
| `pay_settings` | 抽佣配置单行表：`commission_rate` 0.05 / `min_withdraw` 10 / `withdraw_fee_rate` 0.006 / `enabled` false | 后台可调，不写死在前端 |
| `withdraw_requests` | 提现申请（金额 / 状态 / 微信批次号 / 失败原因） | pending→processing→success/failed |
| `orders.pay_status` / `pay_txn_id` / `paid_at` / `settle_amount` / `settled_at` | 支付状态与流水（+2 索引 + CHECK） | unpaid / paid / refunded |

- **抽佣与结算**：`get_pay_settings()`（公开读）/ `calc_settle_amount(p_reward)`（统一口径，
  前端只准调它）/ `admin_update_pay_settings(...)`（带 0–50% 范围校验，`COALESCE` = NULL 不改）
- **提现**：`create_withdraw_request` / `list_my_withdrawals` / `admin_list_withdrawals` /
  `admin_finish_withdrawal`（失败自动把钱退回余额）

---

## 4. 前端页面与模块总览

### 页面（39 个，含 3 个 tabBar）

| 分组 | 页面 | 说明 |
|---|---|---|
| **任务** | `index/index` | 首页：轮播 + 服务宫格 + 快捷入口 + 任务大厅入口卡 |
| | `hall/index` | **任务大厅**（R28 独立成页）：接单员门槛锁卡、类型/排序、楼栋楼层筛选、上拉分页 |
| | `order/create` | 下单（10 服务各一套表单，可选积分抵扣券） |
| | `order/detail` | 订单详情：时间轴、两段式确认、送达佐证卡片、信誉分 |
| | `order/review` | 双向评价 |
| | `orders/list` | 我的订单：分页 + 搜索 + 软删除/恢复 |
| **租赁** | `rental/index`、`rental/apply` | 机型列表（读服务端）、预填申请 |
| **我的** | `mine/index` | 我的：身份分段开关、统计四格、菜单（按权限+灰度显隐） |
| | `mine/profile` | 头像与用户名（支持 `?force=1` 强制模式） |
| | `mine/apply` | 成为接单员（单卡结构，含认证进度） |
| | `mine/points`、`mine/wallet` | 积分、钱包（**R52 起已通微信支付，可提现到零钱**） |
| | `mine/mall` | 积分商城（真实兑换，展示兑换码） |
| | `mine/credit`、`mine/reviews` | 信誉分、待评价/收到的评价 |
| | `mine/address` | 我的地址（三级选择 + 常用标记） |
| | `mine/messages`、`mine/cert`、`mine/feedback` | 站内消息、认证进度（查看已提交的证件）、历史反馈 |
| | `mine/settings` | **设置**：常用 / 体验 / 账号与权限（手机号、后台入口、注销账号）/ 关于（R33 补，R44 加手机号与注销） |
| | `mine/bind-phone` | **绑定手机号**（R44）：短信验证码绑定/更换，一个号只能绑一个账号 |
| | `mine/support` | **智能客服**（R34）：热门问题 + 会话 + AI 兜底 + 转人工 |
| | `feedback/thread` | **工单会话页（用户端与客服端共用）** |
| | `agreement/index` | 用户协议（强制勾选） |
| **管理后台** | `admin/dashboard` | 工作台（所有后台入口的唯一汇总处） |
| | `admin/staff`、`admin/flags` | 人员查找与授权矩阵、灰度总闸（仅 super） |
| | `admin/review`、`admin/settle` | 接单员审核、结算核查 |
| | `admin/reports`、`admin/feedback` | 举报处理、客服受理 |
| | `admin/rental`、`admin/items` | 租赁报价、机型挂牌价 |
| | `admin/banners` | 轮播管理 |
| | `admin/points` | **积分商城管理**：商品 CRUD / 积分调整 / 兑换核销（三 Tab） |
| | `admin/faq` | **智能客服配置**（R34）：FAQ 维护 + AI 设置；R35 加「模型 API 配置」与测试连接 |
| | `admin/dispatch` | **批量发单**（R28）：发单员一次下多单，需 `dispatch` 权限 |

### 工具模块（`utils/`，16 个）

`api.js`（唯一允许 async 的地方）、`ui.js`（wx API 安全封装）、`upload.js`（二进制上传 + 三条读图通道）、`cloud.js`、
`guard.js`（登录/命名统一入口；R44 加 `requirePhone()` 手机号闸门引导）、`flags.js`、`perms.js`、`moderation.js`、
`moderation-words.js`、`services.js`、`campus.js`、`config.js`、`agreement.js`、
`motion.js`（R31 新增：动效与触感统一入口）、`workbuddy-cloud-diagnostics.js`、
`login-return.js`（R39–R41 引入：登录跳走的返回归口：走之前先 `saveDraft()` 存草稿、记录受限白名单地址，30 分钟内回来自动 `navigateTo` 回去）

### 组件（2 个）
- `components/nav-bar`（自定义导航栏，fixed；高度由 `motion.systemInfo()` 计算）
- `components/room-picker`（三个 scroll-view 列 + 自定义输入，非原生 picker-view）

### 云函数（`cloudfunctions/`，R49 起，7 个）

⚠️ **整个 `cloudfunctions/` 目录已加进 `project.config.json` 的 `packOptions.ignore`** ——
云函数是服务端代码，不能进小程序包（见第 5 章）。它只参与四件套第 1 项的 `node --check`。

| 函数 | 用途 | 部署环境 |
|---|---|---|
| `app-api` | **统一入口**：`action` = login / rpc / sendPhoneCode / bindPhone；用 `WX_APP_SECRET` 签发 HMAC 会话令牌 | CloudBase `ceshi` |
| `pay-create` | 微信支付 JSAPI 下单（双入口：云函数带 OPENID / 网关用 code 换 OPENID） | CloudBase `ceshi` |
| `pay-notify` | 微信支付结果回调（**HTTP 函数**）：验签 → 解密 → `mark_order_paid` 落库 | CloudBase `ceshi` |
| `transfer` | 商家转账到零钱（提现执行）：校验 secret → `transfer_prepare` 锁单 → 调微信 API | CloudBase `ceshi` |
| `transfer-notify` | 商家转账结果回调（Event + 网关路由）：解密后写 `state` / `fail_reason` | CloudBase `ceshi` |
| `withdraw-api` | 提现管理 API（供管理后台调用，service_role 访问新库） | CloudBase `ceshi` |
| `tcb-proxy` | **网关转发**（零配置、白名单目标；不持有任何密钥，身份由上游函数各自校验） | **小程序自己的微信云开发环境** |

前 6 个走 CloudBase MCP/网关部署；`tcb-proxy` 因要跑在小程序自身的云开发环境里，用
微信开发者工具 CLI 部署（`cli cloud functions deploy --env <EnvId>`）。

### 灰度开关（23 个）
`home_banner` / `admin_roles` / `staff_search` / `message_center` / `order_paging` / `order_search` /
`hall_filter` / `order_timeline` / `admin_dashboard` / `cert_status` / `order_review` /
`point_records` / `point_mall` / `user_feedback` / `profile_edit` / `credit_score` /
`my_reviews` / `hall_building_filter` / `coupon_deduct` / `deliver_photo` / `admin_batch_order` /
`order_boost` / **`ai_support`**（R34 新增）
**默认全 false**（新功能一律关着上线）。2026-10-24 现网 23 个开关均已由超管打开。

---

## 5. 踩坑知识库

### 🔴 反复出现的同一类毛病（已三次以上）
**「失败只剩一句通用文案」** —— R2 宫格点了没反应、R6 退出登录静默、R14 上传失败只有 toast、R15 证件加载失败没细节、R21 删除后列表与详情对不上账。
→ **通用解法**：结果对象带上 `error` 字段一路透传；页面内联错误条 + toast 双保险；不能发言/不能操作时把按钮换成说明文案，不留点了没反应的按钮。

### Postgres / rpc
- `CREATE OR REPLACE FUNCTION` **不能改返回类型**（42P13），加列或改签名必须先 `DROP FUNCTION`。
- `RETURNS TABLE` 的 OUT 参数与体内列名冲突会报 `column reference "x" is ambiguous` —— 统一返回 `SETOF <表>`，体内列引用全部带表别名。
- `now()` 在事务内是同一个事务时间戳 —— 别在写操作里顺手推读水位。
- plpgsql 里 `BEGIN ... EXCEPTION` 捕获异常会**回滚该块内的所有修改**。
- **`SELECT ... FOR UPDATE` 在 RLS 环境会报 permission denied** —— 不要加行锁。
- 无 UPDATE 策略时，`UPDATE` **不报错但影响行数 0**，判定要用 `GET DIAGNOSTICS ROW_COUNT`。
- RLS 把不匹配的行**静默过滤**（返回 `data: []` 而非 error）—— 查不到数据先怀疑 owner_id 匹配。
- **DROP 完函数重新 CREATE 之后，GRANT 要再执行一遍** —— 权限是绑在函数 oid 上的，重建后不补授权，端上调就 42501。
- **MCP 一次只能执行一条 SQL**：多条一起发会报 `42601 cannot insert multiple commands into a prepared statement`，拆成多次调用。
- **DO 块里不要写 `--` 注释**：工具会把语句截坏，报 `42601 syntax error at end of input`。需要说明就写在 DO 块外面。
- **超过 10 个参数的 RPC，调用一律用命名参数 `p_xxx =>`**：位置参数数错一位，值会落到隔壁字段且不报错；命名参数则必须给全所有没有默认值的形参，漏一个报 42883。
- **更新类 RPC 的 `COALESCE` 语义**：写 `COALESCE(p_x, false)` 意思是「不传 = 关掉」，
  只想改别的字段时会连带把开关清掉（R35 调试时就这么把 AI 开关和模型一起清空过）。
  统一写 `COALESCE(p_x, 原列名)` —— NULL = 不改，传空串照样能清空。
- **多角色共用一张表时，触发器只能校验「本次改动的列」（R45）**：`orders.images` 属发布方、
  `deliver_images` 属接单员，整行校验会让接单员**任何一次**更新都因 `NEW.images` 越权而整笔回滚
  （表现为「放弃接单 / 提交送达都报图片不属于当前账号」）。
  正确写法：`INSERT` 两列都校验；`UPDATE` 用 `NEW.col IS DISTINCT FROM OLD.col` 只校验变了的那列。
  推广规则：**写行级约束前先问「这行会不会被另一个角色更新」**，会就不能整行校验；测试必须正反两个方向都写。

### RLS 自检的正确姿势
```sql
DO $t$ DECLARE r text := '';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '<uid>', true);
  EXECUTE 'SET LOCAL ROLE authenticated';   -- 必须！默认 session 是表 owner 且 bypassrls
  -- ... 走 SECURITY DEFINER 函数读状态（此时不能直接 SELECT 业务表，会 42501）
  RAISE EXCEPTION 'RESULT %', r;            -- 主动抛错回滚整笔，既拿到结果又不留脏数据
END $t$;
```

### owner_id 的精度陷阱
`owner_id` 形如 `2110332344891084800`，**超过 JS 安全整数范围（2^53）**。客户端 `===` 或 `.eq()` 会因精度丢失而匹配不上。**所有涉及本人数据的读写一律走服务端 `auth.uid()`。**

**配套的类型约定**：`auth.uid()` 在这套库里返回的是 **text，不是 uuid**（`admin_grants.user_id` 也是 text，
因为微信登录给的是 `wx:openid` 这种字符串）。所以**任何「谁改的 / 谁的」列一律用 text** ——
写成 `uuid` 时建表不报错，**真正写入才 22P02 invalid input syntax for type uuid**，真机才炸。`updated_by`、
`DECLARE v_uid ... := auth.uid()` 都要跟着用 text。（R34 踩过）

### 前端样式
- ⚠ **小程序 `input` 不要同时设 `padding` 和 `box-sizing: border-box`**：input 自带约 1.4em 固定默认高度，border-box 下 padding 从它里面扣，content 高度被钳成 0，文字上下各切一刀。稳妥写法：**几何放外层 `view`，input 只留字号/颜色**。
- **`#F7F8FA` 这种浅灰不能当页面上的输入框/卡片底色**（页面底色 `#F5F6F8`，差 2/255 = 隐形）。统一**白底 + `2rpx solid #E3E6EB` 描边**。
- 不要在 content-box 的 `input` 上加 `width: 100%`（padding+border 会溢出）。
- 行内 `<text>` 做 chip 会让圆角背景与上一行文字叠在一起（行内元素 padding 不参与行盒高度）—— 用 flex 容器 + `white-space:nowrap`。
- **像素级测量比肉眼估计可靠**：`pngjs` 解图 → 色值直方图 → 逐行扫描 → 用已知尺寸元素标定 `px/rpx`。
- WXML 循环**必须显式写 `wx:for-item`**，否则默认变量叫 `item`，静默渲染成空白。
- 从 URL 参数取来要展示的字符串，**先 `decodeURIComponent` 再渲染**。
- ⚠ **WXSS 选择器禁用清单**（编译器会拒收整个包，R33 因此被微信打回两次）：
  `*` 通配符（必拦）、`+` / `~` 兄弟选择器、`:nth-child` / `:not` 等伪类（不稳，能用 class 就别用）。
  `>` 子选择器官方文档没列，本项目一律不用。`:first-child` / `:last-child` / `:active` 历史在用、未出问题。
- **WXSS 的注释也会被 tokenizer 扫到** —— 注释里同样别写反引号、`**` 粗体、中文全角标点。
- **聊天页滚动的最终写法（R38 定稿，六轮才试出来，别再换）**：
  **不要用 scroll-view 滚消息** —— 它的内容高度是基础库自己算的黑盒，
  flex:1 量不准、height:auto 被撑开、height:0 也会被撑到两倍以上，
  scroll-into-view / scroll-top 各有失效方式。六轮全试过了。
  **正确做法：整页滚动 + 固定输入区**。
  消息放普通 view（内容高度 = 消息之和，物理上不可能出幽灵高度）；
  输入区 `position:fixed` 钉底部；内容 `padding-bottom` = 输入区实测高 + 24px；
  滚到底用 `wx.pageScrollTo`（优先实测位置 `文档高−窗口高+10`，量不到兜底 999999 ——
  注意 `pageScrollTo` 和 scroll-view 的 `scroll-top` 属性行为不同，后者塞大值会留白，前者不会）。
  贴底判定用 `onPageScroll` 的 `scrollTop` + 量出来的文档高窗口高。
  **新消息（pushMsg）强制置 `_atBottom = true`** —— 判定只管流式跟随，不该拦新消息。
- 滚动/测量**没量到高度时不要下判断**（`if (!doc || !win) return`）：算出来一定是「没贴底」，
  自动跟随滚动会从第一条起就永久停摆。宁可保持「未知」。
- fixed 容器里的 `textarea` 必须显式给 `fixed="{{true}}"`，否则渲染位置会漂。
- **网格宽度必须留 ~10rpx 余量（R46）**：三列写 `calc(33.3333% - 11rpx)` 时
  `3×宽 + 2×间距 = 99.9999% - 1rpx`，余量只剩 1rpx，真机取整直接折成 2+1。
  用 `calc(33.33% - 14rpx)`（三列）/ `calc(50% - 10rpx)`（两列）。别把百分比贴着 100% 卡。
- **同一行内字号不同的操作项基线不齐**：加粗 8 字与常规 2 字的 `<text>` 行盒高度不同，
  只加 `line-height` 不够（`<text>` 有自己的行盒算法）—— 换成 `<view>` 并给子项固定 `line-height: 1.4`。

### 前端 JS（ES5 页面层的坑）
- **`setTimeout(this.method, 120)` 会把 `this` 丢掉**，ES5 页面里一调就崩。
  → `const page = this; setTimeout(function () { page.method() }, 120)`。
- **不要写 `for await ... of`**：小程序「ES6 转 ES5」的 babel 不保证注入 `Symbol.asyncIterator`，
  真机会抛 TypeError 且极难定位。→ 手写 `iterator.next()` 循环（见 `utils/api.js` 的 `llmChat`）。

### 强制补全类校验（R47）
- **「必须补全」的判据不能只写「为空」** —— 建号时写的**默认值同样要算缺失**。
  `guard.nicknameMissing()` 原本只判空串，而 `ensureProfile` 写的默认昵称就是「同学」，
  结果 12 个用户里 9 个叫「同学」，强制补全一次都没触发过。
  → 维护一份 `DEFAULT_NICKNAMES` 之类的**默认值清单**，与「空」并列判定；
  新增默认值时同步问一句「它会被当缺失吗」。

### 云函数与小程序包（R49）
- **`cloudfunctions/` 必须加进 `packOptions.ignore`** —— 本项目 `miniprogramRoot` 是 `./`，
  云函数目录落在小程序根内，`check-mp.js` 会把它当小程序代码扫，报
  「npm 依赖 `crypto` / `https` / `wx-server-sdk` 在 `miniprogram_npm` 中不存在」，
  四件套第 3 项直接红、门禁拒绝提交。加上 ignore 后体积回到 176 文件（1.41MB，含文档）。
- **云函数可以独立于前端 SDK 部署与测试**：`wx.cloud` 是微信原生能力，与 WorkBuddy SDK 并存。
  别把「前端还没换 SDK」当成「云函数还不能动」的前提。
- **密钥只走 `process.env`**：商户私钥 / 证书序列号 / APIv3 密钥一律不进代码、不进 git、
  不经对话，由用户在云函数控制台填。缺环境变量时函数应返回结构化错误（本项目 `ENV_MISSING`），
  便于判断「链路通了、只是没配」。

### CloudBase 迁库（R48）
- **CloudBase PG 自带 `auth.uid()`，且同样返回 text** —— 129 个 `SECURITY DEFINER` 函数可原样重放。
- `applyMigration` **必须内联传 SQL**（只给路径报 `SQL_REQUIRED`）；本地同名文件内容要逐字符一致
  （否则 `LOCAL_MIGRATION_FILE_MISMATCH`）；`migrationName` 正则 `^[a-z][a-z_]*$` **不允许数字**。
- 带 `BEGIN/COMMIT` 的脚本不能拼接（事务嵌套）；改返回类型（42P13）或改签名（变重载）
  都**不能靠 `CREATE OR REPLACE`**，必须先 `DROP FUNCTION`。
- **判断权限缺失前先查原库 `pg_policies` + `information_schema.role_table_grants`**：
  本项目原库本来就只给 5 张表客户端直连、其余一律 `REVOKE ALL`，
  「表开了 RLS 却只有一条策略」是**正常的**，不是灾难。

### 文件与图片
- **WorkBuddy 对象存储在小程序端是单向的（能写不能读）**，是本项目的平台级结论。元数据就在业务库里，直接查 `storage.objects` 看 `version` 是否为空即可判断。
- **WorkBuddy Cloud SDK 在小程序里做不了任何二进制收发**：`createMiniProgramFetch` 只支持字符串 body。传文件一律绕开 SDK 用 `wx.request` 打 `/.cloud/storage/object/...`（header 抄 `x-wb-webapp-access-key` + `Authorization` + `X-Client-Info`）。**已在真机验证可行。**
- 小图（≤1.9MB）**存 PostgreSQL `text` 列比对象存储可靠**，还天然带上行级权限。配套缺一不可：RLS 开启且不建任何策略、`REVOKE ALL`、读取函数里显式判 admin。
- **客户端体积上限必须和服务端对齐**（服务端 base64 折算回原始字节只有 1.9MB）。
- `wx.compressImage` 返回的临时文件**不一定带扩展名**，一律按 target 猜会把 png 误判成 jpeg。
- 图片展示**优先写本地临时文件再交给 `<image>` / `previewImage`**，不要用 base64（`setData` 单次上限 1MB）。
- **订单相关的图必须用 `get_order_asset`，不能用 `getSignedUrls`**（后者 owner-only，跨人读不到）。轮播/头像用 `get_public_asset`。

### 微信小程序 CI 与发布
- 界面上的「上传失败，请稍后重试」是**洗过的通用文案**，真实报错在 `C:/Users/包子6688/.workbuddy/logs/renderer.log`，搜 `[miniprogram:publish] publish failed`（字段 `raw=`）。**微信 CI 每次只报第一个错**，修完会继续冒下一个。
- `node --check` 用的是非严格 Script 语义，**漏判重复声明**。小程序预检必须用 `vm.SourceTextModule` 做 ESM 严格解析。
- `packOptions.ignore` 必须忽略 `node_modules`（SDK 5.89MB 会撑爆 2MB 主包），并把 SDK 产物落到 `miniprogram_npm/`。
- 试用版：14 天有效、最多 15 人体验、**不能转正式版**；**没有成员管理界面**，授权是拉取式（扫码 → 申请 → 创建者在服务通知里批准）。

---

## 6. 校验体系

每轮改完必跑**四件套**（R33 起因通配符打回而补的第 4 项）：

```bash
# 1. 全量语法检查（58 个业务 JS：pages 40 + utils 16 + components 2）
cd campus-errand
for f in $(find pages utils components -name '*.js'); do node --check "$f" || echo "FAIL $f"; done

# 2. 页面注册 / 四件套 / 事件绑定校验（工作区根目录）
node verify-mp.js

# 3. 微信上传预检 + 真实包体积（必须 ESM 解析）
node --experimental-vm-modules check-mp.js campus-errand

# 4. WXSS / WXML 语法预检（通配符、兄弟选择器、{{ }} 配对、CSS 变量是否定义）
node campus-errand/tools/style-lint.js campus-errand
```

`scripts/sync_github.py` 已把第 4 项并入门禁，**校验没过的代码推不上去**。

| 工具 | 位置 | 检查内容 |
|---|---|---|
| `verify-mp.js` | **工作区根目录**（放包内会被当成缺 npm 依赖） | 页面四件套齐全、WXML 事件方法在 JS 里有定义、class 有样式定义 |
| `check-mp.js` | **工作区根目录** | ① ESM 严格解析（抓重复声明）② JSON 可解析 ③ WXML 标签配对 + id 唯一 ④ app.json 页面文件齐全 ⑤ usingComponents 指向存在 ⑥ 按 packOptions.ignore 算真实上传体积 ⑦ 裸包名能在 miniprogram_npm 解析 |
| `tools/style-lint.js` | 包内 `tools/`（不参与打包） | ① 反引号 / Markdown 粗体 ② 中文全角标点 ③ 注释与花括号配对 ④ `var(--x)` 是否已定义 ⑤ **选择器里的 `*` 通配符（硬失败）** ⑥ `+` / `~` 兄弟选择器（警告） ⑦ WXML 的 `{{ }}` 配对 |

**当前状态（2026-10-30 01:50 复核）**：58 个业务 JS `node --check` 全过，`verify-mp.js` 通过，
`check-mp.js` **0.98MB / 2.00MB**（183 个文件，扫描 JS 72 个）通过，`style-lint.js`（33 wxss / 42 wxml）通过，
`npm test` **97 项**全过。

> 主包从 1.41MB 降到 **0.95MB**，是 R52 删掉 WorkBuddy Cloud SDK 与 `miniprogram_npm/` 的结果。

> **云函数不算业务 JS、也不进包**：`cloudfunctions/pay-create/index.js` 走 Node CommonJS
> （`require('crypto')`），与页面层的 ES5 约束无关，且已由 `packOptions.ignore` 排除。
> 它只参与四件套第 1 项的 `node --check`，不参与后三项。

> ⚠️ **三个 JS 数字口径不同，别误判成文档漂移**（复核时三个都对，不要互相覆盖）：
> **58** = 业务代码：`pages` 40 + `utils` 16 + `components` 2（上面第 1 步 `find` 的范围）；
> **72** = `check-mp.js` 按 `packOptions.ignore` 算出的**真正会被上传**的 JS
> （含 `app.js`，排除 `tests/` `tools/` `cloudfunctions/`）；
> **79** = `scripts/sync_github.py` 四件套第 1 项实际检查的数量
> （`os.walk` 全扫，只排除 `node_modules` / `miniprogram_npm` / `.git`，**含** `tests/` 与 `tools/`）。

**数据库侧**：每轮用上面的 `DO` 块冒充真实用户做角色化自检，最后主动抛错回滚，收尾一定跑脏数据复核（自测数量应为 0）。

---

## 7. 遗留事项与风险

### 🔴 待用户操作
1. **`DROP POLICY orders_write_own` 已执行，但仍在观察窗口内**。按原计划应等「新版正式发布 + 48 小时」。触发条件是旧版客户端还能直接 UPDATE 自己的订单（可绕过 accept/complete 改状态）—— 这是**已知残留风险**。一旦有用户反馈立刻回滚策略（回滚语句在 `sql/drop-orders-write-own.sql` 末尾注释里），`add-order-write-guard.sql` 的 INSERT 守卫可独立留着继续兜底。

### 🟡 已知但未处理（2026-10-26 复核更新）
2. **旧对象存储的证件照永久不可读**：`runner_applications` 里 id=12/13 存的是旧路径，需让相应用户重新提交。管理员点开时会收到明确提示。
3. ~~**`utils/config.js` 的 `rememberPassword / autoLogin / presetAccount` 仍为调试态**~~
   ✅ **R39 起已解决**（2026-10-26 复核确认）：现值 `rememberPassword: false`、`autoLogin: false`、
   `presetAccount: { phone:'', password:'' }`，且注释明确「发布配置门禁会强制这两个开关为 false、
   预置账号必须为空、不再存储明文密码」。客户端已不含任何调试凭据。
4. ~~**管理员口令硬编码**（`GDYZPT2026`）~~ ✅ **R39 起已解决**（2026-10-26 复核确认）：
   `activate_admin` 改为与 `admin_password_settings` 里的**盐值 + SHA-256 哈希**比对，
   客户端不再出现明文口令（全仓 `grep GDYZPT` 只剩文档这行历史记录），
   并带 **15 分钟 5 次失败限流** + `admin_password_audit` 激活审计。
   残留风险降级为：口令本身的分发方式仍是「知道口令即可自助开 super」，正式运营需换更严格的开通流程。
5. **签名链接接口（`createSignedUrl`）为什么报错仍是未知** —— 已绕开不影响流程。
   2026-10-26 复核：业务代码（`pages/` `utils/`）**已无任何调用点**，仅 SDK 自带注释里出现，
   媒体读取统一走 `media_assets` + 三条读图通道。故此项实际已不再阻塞，仅在未来要恢复对象存储通道时才需再查。
6. ~~**钱包未接支付**~~ ✅ **R52 已闭环**（2026-10-29 复核）：
   发单接入 JSAPI 支付（未付不进大厅，待付款可补付），提现走云托管固定 IP 商家转账，
   已实测「0.01 元下单成功、0.1 元提现到账零钱」；确认收款与对账兜底齐备。
   `docs/PAYMENT.md` 保留为方案与前置清单存档。
7. ~~**试用版 2026/10/29 到期**~~ ✅ **2026-10-27 已转企业主体小程序，审核中**。
   试用版（微信「试用小程序」）本就是一次性验证通道：14 天、15 人、无后台、无 AppSecret、
   不能转正式版。已按官方路径「解绑 → 绑定已有小程序账号 → 发体验/正式版」处理，
   审核通过后即不再受 14 天限制。提审前需备齐：小程序备案、用户隐私保护指引、
   UGC 信息安全声明、企业主体服务类目。
8. ~~**客服页顶部还留着临时调试条**（`support.js` 的 `debugInfo` / `measureLayout`、
   `support.wxml` / `support.wxss` 的 `.sup-debug`）~~ ✅ **R38 已随整页重写清除**
   （2026-10-26 复核：全仓 `grep sup-debug` / `debugInfo` / `measureLayout` 均为空），
   滚动空白问题当时已由「弃用 scroll-view、改整页滚动 + 固定输入区」根治，无需再等确认。

### 🔴 新增待用户操作（R49，2026-10-27）
9. ~~**云函数环境变量缺两项，支付无法真正下单**~~ ✅ **已补齐**（2026-10-29 复核）：
   `WXPAY_SERIAL_NO`（商户证书序列号）与 `WXPAY_PRIVATE_KEY`（`apiclient_key.pem` 全文，
   换行用 `\n` 转义）已由用户在云函数控制台配好 —— 这两项**不能经过对话**，AI 也拿不到；
   已配 `WXPAY_MCHID=1119307371`、`WXPAY_APPID=wxaab192c68e403292`。
   ⚠️ **残留运维项**：商户 API 证书**有效期 5 年**、平台证书需定期轮换，到期不换支付回调会验签失败。
10. ~~**抽佣比例待拍板**~~ ✅ **已做成后台可调**（2026-10-29 复核）：
    `pay_settings.commission_rate` 默认 **0.05（5%）**，允许 0–50%，超管在后台随时改、
    改完立刻对所有客户端生效（不写死在前端）。成本基线：收款 0.6% + 提现 0.6% = 每单 1.2%，
    抽 5% 有约 3.8 个点毛利；抽 0 是亏钱的。
    仍待运营侧确认的是**长期定价策略**（活动期是否临时降佣），不再是技术阻塞项。

### 🟡 已知但未处理（R47–R49 新增）
11. **⚠️ 二清合规风险（业务定性问题，不是技术问题）**：平台「先收用户的钱、再转给接单员」
    在监管口径下易被认定为**无证从事支付结算业务**。规避靠定性：服务定性为「平台自营」、
    向接单员支付**劳务报酬**，保留接单员协议与报酬明细，提现设门槛（满 10 元、T+1），
    不做「余额长期沉淀 + 任意提现」。**正式运营前建议过一遍学校法务/财务。**
12. ~~**数据库双库期，前端还没切**~~ ✅ **R52 已结束**（2026-10-29 复核）：
    前端整体切到 CloudBase（`utils/cloud.js` 与 `miniprogram_npm/` 已删除，
    换为 `utils/tcb.js` + `svc_rpc` 代持身份），WorkBuddy Cloud 退役，**现役库只剩一套**，
    不再有「只改一边对不上账」的问题。
13. **`cloudbase/` 不在 git 仓库内** ⚠️ **仍是未决项**：56 批迁库脚本在工作区根下
    `cloudbase/migrations/`，与 `campus-errand/` 同级，目前**不受版本控制**（工作区根不是 git 仓库）。
    现役库的完整结构只存在于这些脚本 + 线上库本身，**没有异地留档**；
    若要长期留档，需单独入仓库或另建一个仓库。

### 🟢 设计取舍（不是 bug）
- **抵扣券只记在订单上，接单员仍拿全额赏金**，差价由平台承担。
- **订单删除是软删除且整单生效**，物理删除会破坏双方共有记录与审计链路。
- **`hall_page` 开关被主动删除** —— 大厅是任务列表唯一入口，关掉等于直接下掉功能、没有回滚路径。
- **租赁下架 ≠ 删除**（历史租赁申请仍引用 item_id）；**改价要点保存才生效**（金额敏感，不做失焦即改）。
- **前台积分14个新开关默认全 false**，只有 super 能切。
- **智能客服暂时只能走 WorkBuddy Cloud 的免密钥 LLM 通道**：不支持在后台填自己的第三方
  API Key / Base URL。要接第三方模型得另做一条通道，且小程序端不能明文放 Key、还要配 request 合法域名。
- ~~AI 每日配额记在本地 `storage`~~ **R39 起改为服务端按账号记账**：
  `begin_support_ai` 先预留、`finish_support_ai` 成功计入 / 失败释放，
  记录落在 `support_ai_requests`（按 Asia/Singapore 日期切分，预占 130 秒自动过期）。
  局限：模型仍走客户端直连，绕过端上代码仍可直接调 `llmChat`，
  所以它是**端上路径的配额**，不是严格的成本网关。
- **客服会话的上下文靠端上拼 history 携带**：目前最多带 `history_turns` 轮（默认 3），
  更早的内容模型看不到；也没有做会话长度裁剪，超长对话理论上会顶到模型上限。

---

## 8. 合并外部 AI 开发的踩坑与解法（2026-10-23）

> **背景**：另一个 AI（GitHub 账号 `MTKD0 <zhuangangyu@gmail.com>`）从分支
> `codex/fix-orders-support` 提了一个大 PR，自称修了「订单 20 项 + 客服 18 项」。
> 合进来用了整整一晚上，踩了 9 个坑。这一节把每个坑的现象、真因、解法记下来，
> 以后不管是人还是 AI 提的改动，都按这里过一遍。

### 8.1 看清单要展开，别只看汇总行

**现象**：`git diff --stat` 给的是 31 个文件 / +1372−435 行，看着挺干净。
但 `git show --stat <commit>` 展开后是 **235 个文件 / +37147 行** ——
多出来的是 `.agents/skills/cloudbase/**`：**209 个文件、2.2 MB** 的 CloudBase 官方 skill 文档。

**真因**：对方也是用 AI Agent 开发，Agent 把运行时的 skill 资料一起提交了。
`project.config.json` 里的 `packOptions.ignore` 能挡住微信上传包，**挡不住 git 仓库体积**。

**解法**：
- 合并前用 `git show --stat` 把文件分成「代码 / 文档 / 第三方资料」三类，逐个看
- 第三方资料单独一轮清掉（R42）
- 汇总行会把噪声平均掉，务必展开

**教训**：AI 生成的提交经常夹带运行时产物，人要看一眼文件清单。

### 8.2 先装依赖再跑测试，别急着判「代码坏了」

**现象**：合完跑 `npm test`，27 项里挂 1 项：
`Cannot find module '@electric-sql/pglite'`。

**真因**：对方引入了 PGlite 做数据库回归测试（在本地进程里跑真 PostgreSQL 迁移），
但本机没装这个依赖。**测试框架缺失，不是被测代码的问题。**

**解法**：`npm ci --ignore-scripts`，装完 27 项全过。

**教训**：拉别人的 PR 后第一步是装依赖。看到「测试挂了」先分清是
「代码逻辑错」还是「环境缺东西」—— 报错栈里出现 `Cannot find module` 一律先怀疑后者。

### 8.3 `reset --hard` 只回退被跟踪的文件，文档会脱节

**现象**：用户要求「撤销所有从 GitHub 拉取的改动」，`git reset --hard cc97d5c` 之后，
仓库里的 `docs/ITERATIONS.md` 回到了 R38，但**工作区根目录**的
`校园跑腿-迭代全记录.md`（不在 git 里）还留着 R39 的内容 ——
两份文档不一致，统计口径还写着「39 轮 / 116 个函数」。

**真因**：项目文档一直有**两份**：根目录那份是给人看的（git 之外），
`campus-errand/docs/ITERATIONS.md` 才是被跟踪的。`reset --hard` 只管后者。

**解法**：以仓库版本为准重新 `cp` 覆盖根目录那份，再补删 R39 段落、改回 38 轮 / 110 函数。

**教训**：任何 git 层面的回退，都要检查 git 之外的副本（根目录文档、`.workbuddy/memory/`）。

### 8.4 🔴 最大的坑：被「表面症状」带偏了六轮

**现象**：客服页「消息之间空一大截」，从 R36 到 R38 **连改六轮**，
一直在调 `scroll-view` 的高度（`flex:1` / `height:auto` / `height:0` /
`scroll-into-view` / `scroll-top` 塞大值 / 整页滚动），每一种都失败。
调试条实测：**内容 1053px，三条消息加起来才 302px** —— 中间 751px 幽灵高度。

**真因**（对方的改动一句话点破）：`app.wxss` 里有一条全局规则

```css
.home, .mine { min-height: 100vh; }
```

而客服页消息行的 class 恰好叫 `mine` → **每一条「我发的」消息都被撑到一屏高**。
问题根本不在滚动容器，六轮全打在空处。对方把类名改成 `msg-mine` / `msg-peer`
之后，「点一下就滚动」这类问题也一起消失了。

**解法**：
- 类名加前缀：`msg-mine` / `msg-peer` / `sup-card`，不用 `mine` / `home` / `page` / `card` 这类通用词
- 排查「高度异常」时**先量单个元素**：`boundingClientRect().height` 远大于内容
  （几十行的气泡报 700+），基本就是全局 `min-height` / `height` 撞车
- 写业务 class 前先 `grep app.wxss`，确认没被占用

**教训（最值钱的一条）**：
**当同一处连改两轮还不好，就该怀疑「问题不在这里」，而不是继续加大力度。**
这一轮之前一直假设「滚动容器算错高度」，从来没去查「消息元素本身是不是被撑高了」。

### 8.5 外部 PR 只能当「改进输入」，不能当「审计结论」

**现象**：对方自称修了 38 项，合进来之后**仍剩 5 个安全 / 功能问题**：

| 问题 | 严重度 | 真相 |
|---|---|---|
| `create_order` / `complete_order` 不校验图片归属，`get_order_asset` 只校验「路径挂在这张单上」 | P0 | 任何人建单塞 `asset:123` 就能读别人的证件照，`media_assets.id` 是 bigserial 可枚举 |
| `getOrder` 用 `select('*')` 直读 orders | P0 | 绕过 `get_order_detail` 的脱敏，把 `contact` / 取餐码下发到客户端 |
| 评价页 `goBack` 用 try/catch 兜底 | P1 | `navigateBack` 失败走 `fail` 回调，不抛异常，catch 永不执行 |
| 举报权限键三处不一致 | P1 | 客服能看不能做，审核员反而没入口 |
| `admin_dashboard_stats` 白名单漏 `dispatch` | P1 | 第八级权限进不了后台，形同虚设 |

**解法**：独立做一次全量审阅（37 页 / 15 模块 / 22 个 SQL），补 R40；
图片越权另写 `sql/fix-asset-authorization.sql`（触发器 + 第三道校验）。

**教训**：对方修的是「用户能看见的 bug」，没做安全审计。
**合入之后必须自己再扫一遍安全面**，尤其是「服务端鉴权」和「脱敏口径」这两块。

### 8.6 权限键要在三处对齐，改一处必须 grep 另外两处

**现象**：举报模块的权限判断在三个地方各写了一套：

| 位置 | 写法 | 后果 |
|---|---|---|
| `pages/admin/dashboard.js` 卡片 | `perm: 'can_support'` | 按 support 显示待办数字 |
| `pages/admin/dashboard.js` 入口 | `check: 'support'` | 客服看到入口，审核员看不到 |
| `pages/admin/reports.js` 门禁 | `profile.is_admin` | 任何后台身份都放行 |
| 服务端 `admin_handle_report` | `admin_has_perm('review')` | 只有 review 能真正处理 |

**真因**：`profiles.is_admin` 的语义是「有任意后台权限即为 true」，
拿它当「审核权限」用等于没有门禁。

**解法**：三处统一到 `review`，`reports.js` 改用 `perms.load()` + `perms.has('review')`。

**教训**：一个新权限键涉及「服务端 RPC / 前端入口 / 前端页面门禁」三处，
只改一处就会出现「看得见点不动」或「该看见的看不见」。

### 8.7 历史里有别人的提交，`reset --soft` 是安全的抹法

**现象**：`main` 历史上出现了三个第三方作者的提交（`1e013eb` / `19ac0bf` / `aeb2dfe`），
用户要求「清除另一个人提交的代码」。

**解法**：
```bash
git write-tree                       # ① 先记下当前文件树 hash
git reset --soft cc97d5c             # ② HEAD 退回合入前，工作区和索引不动
git add -A && git commit             # ③ 压成一条自己的整合提交
git rev-parse HEAD^{tree}            # ④ 比对：与 ① 一致 → 代码零改动
git push --force origin main
```
本次改写前后都是 `4d86e16c…`，**文件内容一个字节没变**，只换了提交边界与作者。
R1–R38 的逐轮历史和 5 个 tag 完全没受影响。

**教训**：改写历史前**必须**记文件树 hash —— 这是唯一能自证
「只动历史、没动代码」的硬证据，比任何口头说明都可靠。

### 8.8 迁移工具要写全限定名，多语句用 `DO` 块包

**现象**：以为 `workbuddy_cloudservice_db_exec_sql` 在本会话不可用，
让用户去管理面板手工粘贴 SQL，绕了一大圈才发现工具一直在。

**真因**：ToolSearch 要写**全限定名** `mcp__genie-baas__workbuddy_cloudservice_db_exec_sql`，
只写后半截搜不到。

**第二个坑**：这个工具**一次只接受一条语句**，多条直接报
`42601 cannot insert multiple commands into a prepared statement`。

**解法**：把迁移文件拆成单条语句，整体包进一个 `DO` 块 ——
```sql
DO $do$ BEGIN
  EXECUTE $q1$CREATE OR REPLACE FUNCTION ...$q1$;
  EXECUTE $q2$REVOKE ALL ON FUNCTION ...$q2$;
END $do$;
```
`DO` 本身算**一条**语句，既绕过限制，又保证整文件原子执行（中间失败全回滚）。
内层用递增的 `$q1$`…`$qN$` 美元引用，避免和函数体里的 `$fn$` / `$function$` 撞车。
拆分脚本：`.workbuddy/tmp/split_sql.py`（正确处理注释 / 单引号 / 美元引用）。

**教训**：ToolSearch 一律用全限定名；多语句迁移别想着"分几十次调用"，用 `DO` 块一次搞定。

### 8.9 前后端联动的改动，要核对「前端调的函数库里有没有」

**现象**：合入后前端已经在调 `list_my_orders_v2` / `abandon_order` /
`begin_support_ai` / `rate_support_answer`，但这四个函数在数据库里**还不存在**。
如果直接发版，订单列表、放弃接单、AI 客服会全部报错。

**解法**：先按顺序执行三个迁移，再发版：
1. `sql/fix-order-support-workflows.sql` —— 7 个 RPC + 3 张表
2. `sql/restore-admin-password.sql` —— 3 张表 + `activate_admin`
3. `sql/fix-asset-authorization.sql` —— 触发器 + `get_order_asset` + `can_dispatch`

执行后核对：`public` 有 29 张表 / 117 个函数 / 4 个触发器（R40 当时统计，
后续 R44 增至 31 表 / 129 函数 / 7 触发器），
7 个新 RPC 的参数名与前端调用逐一对齐。

**教训**：合入别人的前后端联动改动，**发布前必须列一张「前端 RPC ↔ 数据库函数」对照表**
逐个确认存在，而不是等用户点了才报 `function does not exist`。

### 8.10 合并外部 AI 改动的 SOP（下次照这个走）

```
① git fetch && git show --stat <commit>     分类：代码 / 文档 / 第三方资料
② npm ci --ignore-scripts && npm test       先装依赖，再判测试
③ 独立审阅安全面                            服务端鉴权 + 脱敏口径，不因"他修了很多"跳过
④ 核对前端 RPC ↔ 数据库函数                 列对照表，缺的先迁移
⑤ 清理非产物文件                            第三方资料 / 预览壳 / 个人记录
⑥ 需要抹作者时 reset --soft + 树 hash 校验   证明代码零改动
⑦ 四件套 + npm test 全绿后再推              不要在红的校验下发布
```

### 8.11 一句话总结

| 坑 | 一句话 |
|---|---|
| 夹带第三方资料 | 看清单要展开，`--stat` 汇总行会骗人 |
| 缺依赖 | 见到 `Cannot find module` 先装再判 |
| 文档脱节 | `reset --hard` 只管被跟踪的文件 |
| **六轮改错方向** | **同一处连改两轮不好，就该怀疑「问题不在这里」** |
| 安全审计缺位 | 外部 PR 是输入，不是结论 |
| 权限键漂移 | 三处对齐，改一处 grep 全部 |
| 抹作者 | 先记树 hash，`reset --soft` 才敢下手 |
| 迁移工具 | 全限定名 + `DO` 块包多语句 |
| 前后端脱节 | 发布前列 RPC 对照表 |

