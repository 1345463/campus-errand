# 校园跑腿（广东邮电职业技术学院）

> 校内跑腿代办小程序。发单 → 支付 → 接单 → 送达 → 确认 → 结算 → **提现到微信零钱**，全链路真金跑通。
> 微信支付实测：0.01 元下单成功、0.10 元提现到账；智能客服接的是真大模型（混元 hy3）。

**技术栈**：微信**原生**小程序 + 腾讯云 CloudBase（PostgreSQL + 云函数 + 云托管 + HTTPS 网关 + AI）。

**数据看板**（2026-10-30 复核，全部以代码与线上库为准）

| 指标 | 数值 |
|---|---|
| 页面 | **39** |
| 前端代码 | **18,037** 行 JS / **5,146** 行 WXML / **5,199** 行 WXSS |
| 数据库 | **38** 表 / **170** 个函数 / **9** 个触发器 |
| 云函数 | **8** 个 |
| 云托管 | **1** 个（固定出口 IP，专门对接商家转账） |
| 迁移脚本 | **64** 条（全部可重放） |
| 灰度开关 / 违规词 | **23** 个 / **292** 条（13 大类 + 4 条白名单） |
| 回归测试 | **181** 项（含真实 PostgreSQL 执行） |
| 小程序包体积 | **1.03 MB** / 上限 2 MB |

> JS / WXML / WXSS 行数口径 = `pages/` + `components/` + `utils/` + 根目录 `app.js`、`app.wxss`
> （不含 `tests/` `tools/` `cloudfunctions/` `cloudrun/`）。

---

## 一、这个项目解决了什么难问题

### 1. 提现：用云托管拿到固定出口 IP

微信「商家转账到零钱」按**调用方 IP** 校验，而云函数出口 IP 每次冷启动都变 —— 实测连调 5 次拿到
5 个不同 IP（`118.25.84.125` / `1.117.67.181` / `124.223.156.249` / `101.34.204.192` / `124.221.12.168`），
白名单根本填不了。

解法是把转账搬到 **CloudBase 云托管**（函数型服务，Node.js 零依赖），开启「固定访问公网出口 IP」后
探测到 `122.51.67.142`，填进微信商户平台「系统信息管理」。云函数只做转发。

> 一个反直觉的结论：环境的「固定出口 IP」开关**只对云托管生效，对云函数不生效**。

成本：`MinNum=0`（无请求缩容到 0）、CPU 0.25 核 / 内存 0.5 G、零外部依赖。代价是冷启动 2~5 秒。

### 2. 微信支付全链路

```
wx.login → code
   ↓
pay-create（云函数）→ jscode2session 换 openid → 商户私钥签名 → JSAPI 下单
   ↓ 二次签名
wx.requestPayment → 用户输密码
   ↓ 微信服务器主动推送
pay-notify（云函数）→ 公钥验签 → AES-256-GCM 解密 → 核对金额 → mark_order_paid
```

- **公钥模式验签**：2024 年后新商户没有平台证书（`/v3/certificates` 返回 404），必须用「微信支付公钥 + 公钥 ID」
- **金额核对**：`reward - discount` 必须等于微信实付金额，防止前端改价
- **幂等**：已 `paid` 的订单重复回调直接返回成功
- **防重放**：时间戳超 5 分钟直接拒

实测证据：`paid_at`（14:12:45）**早于**前端 success 回调（14:12:48）3 秒 —— 证明是微信服务端推送写入，不是前端伪造。

### 3. 提现：提交即打款，失败不丢钱

```
钱包页申请 → svc_create_withdraw（余额 FOR UPDATE + 单笔在途 + 门槛）
   → withdraw-api → 云托管 transfer-svc（固定 IP）→ 微信商家转账
   → 用户点「确认收款」→ 零钱
```

- **两道人工闸门**：`AUTO_TRANSFER=0` 整体退回人工；单笔超 `AUTO_TRANSFER_MAX`（默认 200 元）走人工
- **幂等**：`transfer_prepare` 里 `FOR UPDATE` 锁单，重复调用不会重复打款
- **不丢钱**：任何一步失败 → `admin_finish_withdrawal(false)` 退回余额并写退款流水
- **对账兜底**：回调不通时，`sync` 按 `out_bill_no` 去微信查真实状态回写；上一版遗留在 `pending` 的旧单
  会在打开钱包页时自动补转

场景报备字段必须对上号：`1005`（佣金报酬）要求「岗位类型 / 报酬说明」，与 `1000`（现金营销）的
「活动名称 / 奖励说明」**不通用**，传错只报一句「未传入完整且对应的转账场景报备信息」。

### 4. 手机号：免短信，由微信直接给

主体转企业并通过审核后，主路径改成微信「手机号快速验证组件」：
`<button open-type="getPhoneNumber">` 拿一次性 code → 云函数换真实手机号 → 签一次性票据 → 凭票据绑定。

**中间那张票据不能省**：`bind_my_phone_wx` 本质是「免验证码直接绑号」，谁都能调的话，之前好不容易
堵死的「跳过发码直接绑号」就复活了。所以必须出示云函数刚签发的凭据：明文只回云函数、库里只存哈希、
5 分钟有效、用完即废。

### 5. 智能客服：三层兜底 + 服务端代持密钥

```
违规词拦截 → FAQ 关键词打分 → 大模型兜底 → 转人工工单
```

R57 之前这块是死的（R52 迁库时留下的占位实现），现在走 `cloudfunctions/ai-api`：

- **密钥只在云函数里**，端上只带 `action / model / messages`
- **必须验会话令牌**：AI 是要花钱的，匿名调用一律挡掉；每日次数另由库里 `begin_support_ai` 限流
- **通道可换（R58）**：默认走 CloudBase 内置通道（本环境实测可用 `hy3` / `hy3-preview`；
  内置通道**没有**模型列表路由，`/v1/models` 会被当模型名报 403，所以是静态目录 + `TCB_AI_MODELS` 扩展）。
  也可以在后台「智能客服配置 → 大模型通道」填任意 OpenAI 兼容服务（DeepSeek / 通义 / Kimi / 自建），
  对方有 `/models` 就实时拉，没有就用配置里手写的。
- **自定义通道的密钥不进前端**：存 `ai_secrets` 表，**RLS 开着但一条 policy 都不建** ——
  anon / authenticated 直连 0 行；读它的 `svc_ai_runtime_config()` 只 GRANT `service_role`，
  后台只能看到「有没有」和末四位。函数名**必须 `svc_` 前缀** —— `svc_rpc` 是拿 service_role
  身份 EXECUTE 的，GRANT 拦不住它，只有 `svc_` 前缀能被 `svc_rpc` 的硬规则直接拒掉。

### 6. 权限、灰度与闸门都在服务端

- **八级权限**：`super` / `support` / `hr` / `review` / `rental` / `print` / `settle` / `dispatch`
- **23 个灰度开关**：存 `feature_flags`，前端每次进页面拉一次，服务端每个 RPC 也校验一次 ——
  **前端隐藏不算数，服务端拒绝才算数**
- **手机号闸门用表级触发器**，不改 RPC：改 RPC 会漏（每个插入订单的路径都要记得加），触发器一劳永逸
- **图片三通道鉴权**：本人 / 订单参与方（`get_order_asset`）/ 公开（`get_public_asset`），
  订单图必须「先验本单参与方，再验图挂在本单的 `images` / `deliver_images` 里」，两步都过才返回

### 7. 全站写操作只有一个入口

前端**没有任何**直连写表的代码：

```
小程序 → rpc('函数名', { p_xxx }) → svc_rpc → SECURITY DEFINER 函数（RLS + auth.uid()）
```

`svc_rpc` 由云函数先验 HMAC 令牌拿到可信 uid，再在同一事务里 `set_config('request.jwt.claim.sub', uid)`
后执行业务函数 —— 库里 129 个 `SECURITY DEFINER` 函数**一行未改**就完成了整体迁移。

---

## 二、核心迭代（63 轮）

| 阶段 | 交付 |
|---|---|
| R1–R10 | 骨架：登录、发单、大厅、接单、送达、确认、钱包、订单列表 |
| R11–R20 | 权限体系、实名认证、租赁、轮播、FAQ 配置 |
| R21–R30 | 信誉分双轨、积分商城、优惠券抵扣、优先展示、举报下架、批量发单 |
| R31–R40 | 图片三通道鉴权、手机号闸门、账号注销、工单双向对话、AI 客服三层兜底 |
| R41–R46 | 修「点击没反应」类问题、入场动画、聊天页重构、包体积优化 |
| **R47–R49** | **数据库整体迁到 CloudBase PostgreSQL**（37 表 / 156 函数 / 9 触发器全部对齐） |
| **R50** | **微信支付打通**（JSAPI 下单 + 公钥验签回调 + 金额核对 + 幂等） |
| **R51** | **提现打通**（云托管固定 IP + 商家转账 + 用户确认收款 + 失败自动退款） |
| **R52** | **前端整体切到 CloudBase**（95 处 RPC 换通道）；**发单接入支付**；主包 1.44 → 0.95 MB |
| **R53** | **图片分片上传**：实测网关请求体上限只有 100KB，改 80KB 分片 + 阶梯压缩 |
| **R54** | **提现改服务端自动转账**（提交即打款）；查出云函数缺密钥会让转账被云托管拒掉 |
| **R55** | **验证码调试通道**：短信未开通时只对超管回显明文，条件绑「短信没配好」，配好自动失效 |
| **R56** | **手机号改走微信快速验证组件**，全程免短信；一次性票据防止「跳过验证直接绑号」 |
| **R57** | **客服会话与反馈三修 + 智能客服复活**：气泡间距（类名撞全局 `min-height:100vh`）、未读清不掉（SQL `ELSIF` 只更新一边）、列表文字折断；大模型通道改云函数 `ai-api` 代持密钥 |
| **R58** | **大模型通道可配置**：后台接任意 OpenAI 兼容服务（DeepSeek 等）；密钥存独立表且 **RLS 零 policy**，只 GRANT `service_role`，按口收死 |
| **R59** | **删掉「提现管理」后台页**：R54 之后提现提交即自动打款，那页只剩「重试 / 标记失败」，实际从未用过；页面、路由、入口一并移除，服务端收尾能力全部保留 |

最有价值的几次「翻车与纠正」：

- **连续 6 轮改错方向**：客服页消息间隔空一大截，前 3 轮都在调 `scroll-view` 高度，真实原因是
  `app.wxss` 里 `.home, .mine { min-height: 100vh }` 撞了消息行的 class 名 `mine`。**类名改掉，问题当场消失。**
  R57 里同一个雷在工单会话页又踩了一次 —— 现在全局命名空间统一成 `pg-` 前缀，并写进 `style-lint` 不许退化。
- **`RETURNS TABLE` 的列名会变成 plpgsql 变量**：`RETURNS TABLE(id, status, ...)` 里写 `WHERE id = p_id`
  直接报 `42702 ambiguous`。plpgsql 只在**首次执行**时编译，建函数显示成功、一调就炸。已踩 3 次。
- **通道上限必须实测**：按文档印象把图片分片设成 400KB，结果网关真实上限是 100KB，每片必 413。
- **`updateFunctionCode` 传 `envVariables` 不会落到函数配置上**，改环境变量必须走 `updateFunctionConfig`。

---

## 三、技术架构

```
┌──────────────────────────────────────────┐
│  微信小程序（原生，39 页）                  │
│  页面层 ES5，utils/api.js 是唯一数据出口    │
└──────────────┬───────────────────────────┘
               │ HTTPS 网关（优先）/ wx.cloud（兜底）
    ┌──────────┴───────────┐
┌───▼──────────────────┐  ┌▼────────────────────┐
│ CloudBase 云函数 ×8   │  │ tcb-proxy           │
│ app-api（统一入口）    │  │ （小程序自有环境转发） │
│ ai-api（大模型通道）   │  └─────────────────────┘
│ pay-create / pay-notify│
│ withdraw-api           │
│ transfer / transfer-notify│
└───┬──────────────┬────┘
    │              │ HTTPS（固定出口 IP）
    │      ┌───────▼───────────────────────┐
    │      │ 云托管 transfer-svc            │
    │      │ 固定出口 IP 122.51.67.142      │
    │      │ 对接微信商家转账                │
    │      └───────┬───────────────────────┘
    │              │
┌───▼──────────────▼─────┐
│ CloudBase PostgreSQL    │
│ 38 表 / 170 函数 / 9 触发器 │
│ RLS + SECURITY DEFINER  │
└─────────────────────────┘
```

**为什么云托管单独拆出来**：只有它能拿到固定公网出口 IP。**为什么云函数和云托管分两套**：
云函数负责「不需要固定 IP」的一切，云托管只负责「必须固定 IP」的一件事，职责单一、故障隔离。

---

## 四、能力概览（按角色）

### 发布方
10 类服务下单（取快递 / 帮我买 / 取奶咖 / 拿外卖 / 打印 / 宿舍清洁 / 代排队 / 到店取餐 /
行李代搬 / 其它）· 三级宿舍地址 · 赏金两位小数 · 期望时间 · 性别限制 · 配图（违规词校验）·
积分券抵扣 · 优先券置顶 · 取消任务 · 确认完成（二次点击）· 48h 未确认可申请核查

### 接单员
实名认证（姓名 + 学生证/身份证）· 大厅筛选（类型 / 赏金或时间排序 / 楼栋楼层）· 上拉分页 ·
接单（禁止自接自单）· 放弃接单 · 送达佐证 1–3 张 · 被评价 / 收信誉分

### 管理员（八级）
工作台待办汇总 · 权限矩阵 · 灰度总闸 · 轮播 · 积分商品与调分 · 接单员审核 · 相机租赁报价 ·
举报下架 · 结算核查 · 反馈工单 · 批量发单 · FAQ 与模型参数

### 所有人
微信一键登录 · 绑定手机号（微信一键 / 短信降级）· 消息中心（订单/租赁/认证/举报四类）·
**智能客服**（FAQ → AI → 转人工）· 意见反馈工单（双向对话）· 注销账号（6 个月内可恢复）

---

## 五、页面地图（39 页）

### 主流程
| 路径 | 页面 | 做什么 |
|---|---|---|
| `pages/index/index` | 首页 | 公告条 + 10 类服务宫格 + 大厅入口卡 + 轮播 |
| `pages/hall/index` | 任务大厅 | 类型/排序/楼栋楼层筛选、上拉分页、未认证锁卡引导 |
| `pages/order/create` | 发单 | 服务表单、三级地址、赏金、期望时间、配图、违规词校验、草稿 |
| `pages/order/detail` | 任务详情 | 时间轴、对方信誉分、送达佐证、二次确认、举报、48h 核查 |
| `pages/orders/list` | 我的订单 | 发布/接单双模式、状态筛选、搜索、分页、软删除与恢复 |
| `pages/order/review` | 互评 | 打分 + 标签 + 评论（仅订单参与方） |

### 我的
| 路径 | 页面 | 做什么 |
|---|---|---|
| `pages/mine/index` | 我的 | 资料卡、钱包/积分/信誉/优惠券入口、客服与设置 |
| `pages/mine/profile` | 资料 | 头像与昵称（缺昵称强制补全） |
| `pages/mine/address` | 常用地址 | 增删改，发单时直接选 |
| `pages/mine/apply` | 接单员申请 | 实名信息 + 证件照上传 |
| `pages/mine/cert` | 认证状态 | 审核进度与驳回原因 |
| `pages/mine/credit` | 信誉分 | 双轨分数、评分次数、完成单数、违规次数 |
| `pages/mine/points` | 我的积分 | 余额与逐笔明细 |
| `pages/mine/wallet` | 钱包 | 余额与流水、申请提现、确认收款 |
| `pages/mine/mall` | 积分商城 | 兑换抵扣券 / 核销券 / 优先券 |
| `pages/mine/messages` | 消息中心 | 四类推送、单条已读、全部已读 |
| `pages/mine/feedback` | 意见反馈 | 提交工单与我提交的列表（含未读） |
| `pages/feedback/thread` | 工单会话 | 用户与客服共用（pending 只有客服能说 / resolved 双方可说） |
| `pages/mine/reviews` | 评价 | 我收到的评价 + 待评价 |
| `pages/mine/bind-phone` | 绑定手机号 | 微信一键绑定（主）+ 短信验证码（降级） |
| `pages/mine/settings` | 设置 | 手机号、后台密码入口、注销账号、协议 |
| `pages/mine/support` | 智能客服 | FAQ 命中 → AI 回答 → 转人工 |

### 租赁 / 其它
| 路径 | 页面 | 做什么 |
|---|---|---|
| `pages/rental/index` | 相机租赁 | 5 款机型与日租金 |
| `pages/rental/apply` | 租赁申请 | 填资料提交，等管理员报价 |
| `pages/agreement/index` | 用户协议 | 首次下单前必须同意 |

### 后台（八级权限隔离）
| 路径 | 页面 | 权限 |
|---|---|---|
| `pages/admin/dashboard` | 工作台 | 任意后台身份（按权限过滤待办） |
| `pages/admin/staff` | 权限管理 | `super` / `hr` |
| `pages/admin/flags` | 灰度总闸 | 仅 `super` |
| `pages/admin/banners` | 轮播 | `super` |
| `pages/admin/points` | 积分商品 / 调分 | `support` |
| `pages/admin/review` | 接单员审核 | `review` |
| `pages/admin/reports` | 举报处理 | `review` |
| `pages/admin/settle` | 结算核查 | `settle` |
| `pages/admin/orders` | 订单运维（查单 / 强制退款） | `settle` |
| `pages/admin/rental` | 租赁报价 | `rental` |
| `pages/admin/items` | 机型与挂牌价 | `rental` |
| `pages/admin/feedback` | 客服受理 | `support` |
| `pages/admin/dispatch` | 批量发单 | `dispatch` |
| `pages/admin/faq` | FAQ 与模型参数 | `super` |

---

## 六、技术栈与铁律

- **微信原生小程序**，不用第三方框架。
- **页面层强制 ES5**：`const/let + function`，禁箭头函数 / 模板字符串 / 展开运算符；
  页面里只用 `.then().catch()`，只有 `utils/api.js` 内部用 `async`。
- **后端 = CloudBase PostgreSQL**（环境 `ceshi-d2g37cbg7c8f7ee48`，R52 起 WorkBuddy Cloud 已退役）。
  访问链 `utils/api.js` → `utils/tcb.js` → 网关直连优先，域名没白名单时退 `wx.cloud.callFunction('tcb-proxy')`；
  **只有网络层失败才换通道，业务拒绝不重试**。
- **会话 = 云函数用 `WX_APP_SECRET` 签的 HMAC 令牌**（`v1.<payload>.<sig>`，30 天），端上只存只带。
- **写操作一律走 `SECURITY DEFINER` 函数**。RPC 必须返回**结构化类型**（`TABLE` / `SETOF` / `json`）——
  `RETURNS text` 会让前端 JSON.parse 失败，症状是弹窗只有一两个英文单词（R43 修了 7 个）。
- **`auth.uid()` 返回 text**，所有「谁的」列一律 text，写 `uuid` 真机才炸。
- **写业务 class 前先 `grep app.wxss`**：`.home` / `.mine` / `.page` 这类全局通用词已被命名空间占用，
  业务 class 一律加前缀（现在全局那批统一成 `pg-`，`style-lint` 会拦裸用）。
- **WXML 循环必须显式写 `wx:for-item`**，否则默认变量叫 `item`，`{{entry.x}}` 静默渲染空白。
- **WXSS 禁用**：`*` 通配符、`+` `~` 兄弟选择器、`:nth-child` / `:not`、`>` 子选择器；注释里也别写反引号。
- **表级约束优先于改函数**：手机号闸门用触发器，因为 `create_order` / `admin_batch_create_orders` 写法各异。

---

## 七、目录结构

```
campus-errand/
├── app.js / app.json / app.wxss     全局（含 wx.getUpdateManager 热更新）
├── pages/            39 个页面（见「页面地图」）
├── components/room-picker/          三级宿舍选择器
├── utils/            16 个：api / tcb / upload / pay / ui / guard / flags / perms /
│                     motion / moderation / moderation-words / campus / services /
│                     config / agreement / login-return
├── cloudfunctions/   8 个：app-api / ai-api / pay-create / pay-notify /
│                     tcb-proxy / transfer / transfer-notify / withdraw-api
├── cloudrun/         云托管 transfer-svc（固定出口 IP，对接商家转账）
├── tests/            181 项回归测试（含 PGlite 真实 PostgreSQL）
├── tools/            verify-mp / check-mp / style-lint / release-check
└── docs/             迭代记录 / 环境 / 发布 / 验收 / 代码审阅 / 支付方案
```

`cloudfunctions/` 与 `cloudrun/` 都在 `packOptions.ignore` 里 —— 不进小程序包。

## 八、数据库

**现役库只有一套**：CloudBase `ceshi-d2g37cbg7c8f7ee48`。

- **38 张表**：`pay_settings` / `withdraw_requests` / `phone_codes` / `wx_phone_tickets` /
  `media_uploads` / `media_upload_parts` 等；`profile_phones` / `account_deletions` 不开 policy，只给函数访问
- **170 个函数**，命名约定 `p_` 前缀参数
- **9 个触发器**：订单消息推送、图片归属校验、手机号闸门 ×3 等
- **64 条迁移脚本**，全部幂等 —— 在 **`cloudbase/migrations/`**（工作区根下，与 `campus-errand/` 同级，
  **不在本仓库内**）。完整清单见 [`docs/ITERATIONS.md` 第 3 章](docs/ITERATIONS.md)
- 包内 `sql/` 还有 28 个早期脚本，属已退役旧库的结构参考，不再对现役库执行

### 订单状态机

```
pending ──accept──> accepted ──complete──> waiting_confirm ──confirm──> done
   │                    │                        │
   │                    └──abandon──> pending    └──submit_settle_feedback(满48h)──> 核查
   └──cancel──> canceled
   └──admin_handle_report──> takedown（orders.takedown = true，扣信誉）
```

### 三个关键约定

1. `auth.uid()` 返回 **text**（`wx:openid` 这种字符串），任何「谁改的」列都用 text，写 `uuid` 会 22P02。
2. 更新类 RPC 写 `COALESCE(p_x, 原列名)` 表示 NULL = 不改；**不要写 `COALESCE(p_x, false)`**。
3. 改函数**返回类型**必须先 `DROP FUNCTION` 再 `CREATE`，重建后 **GRANT 要重跑**（权限绑函数 oid）。

## 九、本地校验（每次改完必跑）

```bash
npm ci --ignore-scripts
npm test        # 181 项回归测试
npm run check   # 四件套：语法 / 页面注册 / 上传预检 / 样式预检
```

四件套 = 全量 JS 语法 → `verify-mp.js`（页面注册、四件套、事件绑定）→ `check-mp.js`（上传预检 + 真实包体积）
→ `style-lint.js`（WXSS/WXML 语法 + CSS 变量 + 全局命名空间类名）。GitHub Actions 跑同样的命令。

## 十、部署

**发布通道**：企业主体小程序（2026-10-27 绑定）。试用版通道已停用 —— 试用小程序没有后台、
没有 AppSecret、14 天不转正即注销。正式提审前需准备：小程序备案、用户隐私保护指引
（手机号 / 证件照 / 地址 / 图片）、UGC 信息安全声明。

1. 微信开发者工具打开本目录；主包需 ≤ 2 MB，当前 **1.03 MB / 2.00 MB**（185 个文件）。
2. **云函数 8 个**已部署到 `ceshi`（`tcb-proxy` 在小程序自有环境 `baozi-d2gbl784gd773f8b6`，
   需由开发者工具上传）。密钥只在云函数控制台的环境变量里配，不进代码与仓库。
3. **云托管 `cloudrun/transfer-svc`**：函数型服务，端口 3000，9 个环境变量
   （`WXPAY_MCHID` / `WXPAY_APPID` / `WXPAY_SERIAL_NO` / `WXPAY_PRIVATE_KEY` /
   `WXPAY_TRANSFER_SCENE=1005` / `WXPAY_TRANSFER_NOTIFY` / `PAY_WEBHOOK_SECRET` /
   `TCB_ENV_ID` / `TCB_PUBLISHABLE_KEY`）。上线前两件事必做：
   - 控制台开启「**固定访问公网的出口 IP**」
   - 把固定 IP 填进微信支付商户平台 → **系统信息管理**（应用范围含「商家转账到零钱」）
4. **AI 通道**：两条路任选其一。
   - **云开发内置**：`ai-api` 云函数配 `TCB_ENV_ID` + `TCB_AI_KEY`（控制台「环境配置 → API Key」拿），
     模型在「控制台 → AI → 生文模型」里启用。
   - **第三方 OpenAI 兼容服务**（DeepSeek 等，R58）：后台「智能客服配置 → 大模型通道」填
     Base URL + API Key + 模型名，存在 `ai_secrets` 表，60 秒生效，优先级高于环境变量。
5. 灰度开关默认**全关**，发布后由 super 在「管理员工作台 → 总闸」逐个打开。

详见 [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md)、[`docs/RELEASE.md`](docs/RELEASE.md)、
[`docs/PAYMENT.md`](docs/PAYMENT.md)、[`docs/VERIFY.md`](docs/VERIFY.md)。

## 十一、Git 历史（务必知情）

仓库 2026-10-17 立项，此前 29 轮迭代只留有「最终态」文件，**没有逐行 diff 可还原**。
历史按下述方式重建：每一轮提交 = 该轮首次引入的文件（以最终内容入库）+ CHANGELOG 追加一节。
即：**文件级快照可回溯，行级 diff 不可回溯**。R29 之后的所有改动都是真实 diff。

当前 `main` 有 **105 次提交、6 个 tag**（`v0.1.0` ~ `v0.6.0`）—— 提交数随时间增长，
数字以「截至 2026-10-30 23:45」为准，复核时按 `git rev-list --count HEAD` 重取。

## 十二、已知风险

- 后台入口使用加盐摘要 + 失败限流 + 审计；共享管理员口令仍应定期轮换。
- **`pay_settings.commission_rate` 是唯一结算口径**：抽佣、到手金额必须走 `calc_settle_amount()`，
  **前端不准自己乘**，否则会出现「页面显示 9.50、实际入账 9.49」。
- **二清合规风险（业务定性，非技术）**：平台代收再转付接单员，需定性为「平台自营 +
  向接单员支付劳务报酬」并保留协议与报酬明细，正式运营前建议过一遍学校法务/财务。
- **提现绑死在云托管的固定出口 IP 上**：换环境、换服务名、重建实例都要重新确认 IP 并重配白名单，
  否则直接报 `此IP地址不允许调用接口`。
- **图片通道上限是实测出来的 100KB**（不是 1MB）：写必须切 ≤80KB 的片，读可一次拿回 ~1MB。
  改通道前务必重新二分实测。
- **内置通道的模型目录是静态的**（CloudBase 没有列表接口），本环境只有 `hy3` / `hy3-preview` 可用；
  换了自定义通道（R58）才会真拉 `/models`。内置通道要加模型得先买 Token 资源包再填 `TCB_AI_MODELS`。
- **`cloudbase/migrations/` 的 64 条脚本不在 git 内** —— 不是被 `.gitignore` 忽略，而是仓库根是
  `campus-errand/`、`cloudbase/` 是同级兄弟目录。空库重建目前只能靠这份本地目录，建议尽快纳入版本控制。
- **短信仍未开通**：腾讯云 SMS 的 5 个环境变量未配置。主路径已是微信 `getPhoneNumber`（免短信），
  短信只作降级通道；配齐这 5 个变量仍有价值（代码已就绪，配完即生效）。
- 微信手机号快速验证**按次计费**（约 0.03 元/次）且需在微信后台开通；未开通时拿不到 code，会提示改用短信。
- 旧对象存储的证件照不可读，需用户重新提交。商户 API 证书 5 年到期需轮换。

- **`pages/paytest/` 是 R50 支付联调留下的孤儿页**：4 个文件、约 194 行，未注册进 `app.json`、
  全仓无任何跳转点，但仍会被打进主包。确认不再需要后可整个目录删除。

✅ 已解决：`RETURNS text` 解析失败（R43）· 跨库桥接（R52）· 图片上传超限（R53）·
提现需人工点（R54）· 验证码通道（R55/R56）· 智能客服无可用模型（R57）·
确认完成发双份赏金与微信/余额双付（R62）· 券核销后取消不回滚、管理端无法处理订单、
退款回调丢失后永久卡 `canceling`、全仓无定时任务（R63）。

---

## 十三、许可

仓库**公开**供学习与参考，但**未附开源许可证**（即默认保留所有权利）。
如需二次开发、分发或商用，请先联系仓库所有者。

---

**迭代记录与踩坑知识库是本项目最重要的资产 —— 改代码前请先读 [`docs/ITERATIONS.md`](docs/ITERATIONS.md)。**
