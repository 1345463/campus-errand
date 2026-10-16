# 校园跑腿小程序 · 全量迭代修改记录

> 广东邮电职业技术学院校园跑腿平台 ｜ 微信小程序原生 ｜ 云端 WorkBuddy Cloud
> 统计截止：2026-10-16 23:30 ｜ 累计 **22 轮迭代**、**34 个页面**、**21 张表**、**99 个数据库函数**

---

## 目录

- [0. 项目概况](#0-项目概况)
- [1. 技术基线（不可动摇的约定）](#1-技术基线不可动摇的约定)
- [2. 迭代时间线（22 轮）](#2-迭代时间线22-轮)
- [3. 数据库演进总览](#3-数据库演进总览)
- [4. 前端页面与模块总览](#4-前端页面与模块总览)
- [5. 踩坑知识库](#5-踩坑知识库)
- [6. 校验体系](#6-校验体系)
- [7. 遗留事项与风险](#7-遗留事项与风险)

---

## 0. 项目概况

| 项 | 内容 |
|---|---|
| 项目 | 仿「韶乐园跑跑」（韶关学院校园跑腿平台）做同类双边校园跑腿小程序 |
| 学校 | 广东邮电职业技术学院 |
| 形态 | 微信小程序**原生**（无框架），3 个 tabBar + 34 个页面 |
| 云端 | WorkBuddy Cloud，应用 id `wbapp_yPJnSvicojPmz998PjKfpM` |
| 数据库 | PostgreSQL 21 张表，全量 RLS，99 个 `SECURITY DEFINER` 函数 |
| 代码位置 | 工作区 `campus-errand/` |
| 发布状态 | 试用版已发布成功，有效期至 2026/10/29 |

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
- `admin_grants` 表存七级权限：`super / support / hr / review / rental / print / settle`；super 隐含全部，只有 super 能授/收 super，服务端硬拦。
- 前端判断只是显示用，真正拦截在每个 RPC 里调 `admin_has_perm()`。
- 新功能一律挂 `feature_flags`（现 17 个开关，payload 默认 false）；总闸页 `pages/admin/flags` 只给 super。
- **配置类页面（flags / banners / feedback）不能被自己的开关挡住**，否则关了就再也进不去打开。

---

## 2. 迭代时间线（29 轮）

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
- **管理员**：`profiles.is_admin` 列 + `activate_admin(code)`（口令 `GDYZPT2026`）+ `list_all_orders(limit)`。

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

---

## 3. 数据库演进总览

### 数据表（21 张，全量 RLS）

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
| `admin_grants` | 管理员七级权限 | R22 |
| `feature_flags` | 灰度开关（现 17 个） | R22 |
| `banners` | 首页轮播 | R22 |
| `messages` | 站内消息（触发器自动产生） | R22 |
| `point_records` | 积分流水 | R22 |
| `wallet_records` | 钱包流水 | R22 |
| `point_goods` | 积分商城礼券（含 benefit_type / deduct_value） | R23 / R28 |
| `point_redemptions` | 兑换码（含 used_by / order_id） | R23 / R28 |
| `user_feedbacks` | 客服工单（含双方已读水位） | R22 / R27 |
| `feedback_replies` | 工单对话 | R27 |

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

### 数据库函数（99 个）
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

### SQL 脚本清单（`campus-errand/sql/`，共 20 个）

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
| `add-feedback-thread.sql` | 客服工单双向对话 |
| **`add-round6.sql`** | 大厅筛选字段、开价下限、送达佐证、券抵扣、按订单取图 |

---

## 4. 前端页面与模块总览

### 页面（34 个，含 3 个 tabBar）

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
| | `mine/points`、`mine/wallet` | 积分、钱包（未接支付，如实说明） |
| | `mine/mall` | 积分商城（真实兑换，展示兑换码） |
| | `mine/credit`、`mine/reviews` | 信誉分、待评价/收到的评价 |
| | `mine/address` | 我的地址（三级选择 + 常用标记） |
| | `mine/messages`、`mine/cert`、`mine/feedback` | 站内消息、认证进度（查看已提交的证件）、历史反馈 |
| | `feedback/thread` | **工单会话页（用户端与客服端共用）** |
| | `agreement/index` | 用户协议（强制勾选） |
| **管理后台** | `admin/dashboard` | 工作台（所有后台入口的唯一汇总处） |
| | `admin/staff`、`admin/flags` | 人员查找与授权矩阵、灰度总闸（仅 super） |
| | `admin/review`、`admin/settle` | 接单员审核、结算核查 |
| | `admin/reports`、`admin/feedback` | 举报处理、客服受理 |
| | `admin/rental`、`admin/items` | 租赁报价、机型挂牌价 |
| | `admin/banners` | 轮播管理 |
| | `admin/points` | **积分商城管理**：商品 CRUD / 积分调整 / 兑换核销（三 Tab） |

### 工具模块（`utils/`，14 个）
`api.js`（唯一允许 async 的地方）、`ui.js`（wx API 安全封装）、`upload.js`（二进制上传 + 三条读图通道）、`cloud.js`、`guard.js`（登录/命名统一入口）、`flags.js`、`perms.js`、`moderation.js`、`moderation-words.js`、`services.js`、`campus.js`、`config.js`、`agreement.js`、`workbuddy-cloud-diagnostics.js`

### 组件（1 个）
`components/room-picker`（三个 scroll-view 列 + 自定义输入，非原生 picker-view）

### 灰度开关（17 个）
`profile_edit` / `credit_score` / `my_reviews` / `staff_search` / `point_mall` / `hall_filter` / `hall_building_filter` / `coupon_deduct` / `deliver_photo` / `order_timeline` / `order_review` / `banners` / `messages` / `search_orders` / `feedback` / `cert` / `rental`
**默认全 false**（新功能一律关着上线），其中 `hall_building_filter`、`coupon_deduct`、`deliver_photo` 当前为 true。

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

### 前端样式
- ⚠ **小程序 `input` 不要同时设 `padding` 和 `box-sizing: border-box`**：input 自带约 1.4em 固定默认高度，border-box 下 padding 从它里面扣，content 高度被钳成 0，文字上下各切一刀。稳妥写法：**几何放外层 `view`，input 只留字号/颜色**。
- **`#F7F8FA` 这种浅灰不能当页面上的输入框/卡片底色**（页面底色 `#F5F6F8`，差 2/255 = 隐形）。统一**白底 + `2rpx solid #E3E6EB` 描边**。
- 不要在 content-box 的 `input` 上加 `width: 100%`（padding+border 会溢出）。
- 行内 `<text>` 做 chip 会让圆角背景与上一行文字叠在一起（行内元素 padding 不参与行盒高度）—— 用 flex 容器 + `white-space:nowrap`。
- **像素级测量比肉眼估计可靠**：`pngjs` 解图 → 色值直方图 → 逐行扫描 → 用已知尺寸元素标定 `px/rpx`。
- WXML 循环**必须显式写 `wx:for-item`**，否则默认变量叫 `item`，静默渲染成空白。
- 从 URL 参数取来要展示的字符串，**先 `decodeURIComponent` 再渲染**。

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

每轮改完必跑三件套：

```bash
# 1. 全量语法检查（约 49 个 JS）
cd campus-errand
for f in $(find pages utils components -name '*.js'); do node --check "$f" || echo "FAIL $f"; done

# 2. 页面注册 / 四件套 / 事件绑定校验（工作区根目录）
node verify-mp.js

# 3. 微信上传预检 + 真实包体积（必须 ESM 解析）
node --experimental-vm-modules check-mp.js campus-errand
```

| 工具 | 位置 | 检查内容 |
|---|---|---|
| `verify-mp.js` | **工作区根目录**（放包内会被当成缺 npm 依赖） | 页面四件套齐全、WXML 事件方法在 JS 里有定义、class 有样式定义 |
| `check-mp.js` | **工作区根目录** | ① ESM 严格解析（抓重复声明）② JSON 可解析 ③ WXML 标签配对 + id 唯一 ④ app.json 页面文件齐全 ⑤ usingComponents 指向存在 ⑥ 按 packOptions.ignore 算真实上传体积 ⑦ 裸包名能在 miniprogram_npm 解析 |

**当前状态**：49 个 JS `node --check` 全过，`verify-mp.js` 通过，`check-mp.js` **1.10MB / 2.00MB** 通过。

**数据库侧**：每轮用上面的 `DO` 块冒充真实用户做角色化自检，最后主动抛错回滚，收尾一定跑脏数据复核（自测数量应为 0）。

---

## 7. 遗留事项与风险

### 🔴 待用户操作
1. **`DROP POLICY orders_write_own` 已执行，但仍在观察窗口内**。按原计划应等「新版正式发布 + 48 小时」。触发条件是旧版客户端还能直接 UPDATE 自己的订单（可绕过 accept/complete 改状态）—— 这是**已知残留风险**。一旦有用户反馈立刻回滚策略（回滚语句在 `sql/drop-orders-write-own.sql` 末尾注释里），`add-order-write-guard.sql` 的 INSERT 守卫可独立留着继续兜底。

### 🟡 已知但未处理
2. **旧对象存储的证件照永久不可读**：`runner_applications` 里 id=12/13 存的是旧路径，需让相应用户重新提交。管理员点开时会收到明确提示。
3. **`utils/config.js` 的 `rememberPassword / autoLogin / presetAccount` 仍为调试态**（注释自己写了「上线前必须改」）—— 用户还在双号联调，擅自关会打断测试，**未动**。
4. **管理员口令硬编码**（`GDYZPT2026`）：拿到口令的人都能自己开管理员（可见全部订单 + 直接获得接单资格）。正式运营需要换掉这套机制。
5. **签名链接接口（`createSignedUrl`）为什么报错仍是未知** —— 已绕开不影响流程，但如果以后要恢复对象存储通道需要再查。
6. **钱包未接支付**：暂不可提现，页面已如实说明。
7. **试用版 2026/10/29 到期**，且不能转正式版。长期运营必须绑定自有小程序账号并提交审核（UGH 类目还需服务内容声明）。

### 🟢 设计取舍（不是 bug）
- **抵扣券只记在订单上，接单员仍拿全额赏金**，差价由平台承担。
- **订单删除是软删除且整单生效**，物理删除会破坏双方共有记录与审计链路。
- **`hall_page` 开关被主动删除** —— 大厅是任务列表唯一入口，关掉等于直接下掉功能、没有回滚路径。
- **租赁下架 ≠ 删除**（历史租赁申请仍引用 item_id）；**改价要点保存才生效**（金额敏感，不做失焦即改）。
- **前台积分14个新开关默认全 false**，只有 super 能切。
