# 校园跑腿（广东邮电职业技术学院）

> 校内跑腿代办小程序。发单 → 接单 → 送达 → 确认 → 结算 → **提现**，全流程真实跑通。
> 微信支付**真金实测**：0.01 元下单成功、0.1 元提现打进微信零钱。

**技术栈一句话**：微信原生小程序 + 腾讯云 CloudBase（PostgreSQL + 云函数 + **云托管** + HTTPS 网关）。
**开发方式**：纯 WorkBuddy 项目，从第一行代码到支付闭环，全程 AI 与人协作完成。

## 数据看板

| 指标 | 数值 |
|---|---|
| 页面 | **39** 页 |
| 数据库 | **36** 表 / **154** 个函数 / **9** 个触发器 |
| 云函数 | **7** 个（`app-api` 统一入口 / `pay-create` 支付下单 / `pay-notify` 支付回调 / `tcb-proxy` 网关转发 / `transfer` 转账执行 / `transfer-notify` 转账回调 / `withdraw-api` 提现管理） |
| **云托管** | **1** 个（函数型服务，固定出口 IP，专门对接微信支付商家转账） |
| 迁移脚本 | **56** 条（全部可重放，`cloudbase/migrations/`） |
| 灰度开关 | **23** 个（默认关，可按功能逐条放开） |
| 违规词库 | **292** 条违规词（`utils/moderation-words.js` 的 `WORDS`）+ 4 条白名单，**13** 大类 |
| 图片鉴权 | **3** 条独立通道（本人 / 订单参与方 / 公开） |
| 小程序包体积 | **0.96 MB** / 上限 2 MB |

---

## 一、项目特点

### 1. ⭐ 提现用「腾讯云云托管」解决固定 IP 难题

这是整个项目最有技术含量的一处，也是踩坑最深的一处。

**问题**：微信支付的商家转账接口会校验**调用方 IP**。而云函数的出口 IP 每次冷启动都会变——实测连调 5 次拿到 5 个不同 IP（`118.25.84.125` / `1.117.67.181` / `124.223.156.249` / `101.34.204.192` / `124.221.12.168`），函数详情里 `EipConfig.EipFixed=FALSE`、`VpcConfig` 为空。白名单根本填不了。

**解法**：

1. 把转账逻辑从云函数搬到 **腾讯云 CloudBase 云托管**（函数型服务，Node.js 零依赖）
2. 在 CloudBase 控制台 → 云函数/托管 → 环境设置，开启「**固定访问公网的出口 IP**」
3. 探测云托管服务的出口 IP → **`122.51.67.142`**（连测两次完全一致）
4. 把这个 IP 填进微信支付商户平台的「系统信息管理」（应用范围含「商家转账到零钱」）
5. 云函数只做转发，真正调微信 API 的是云托管服务

**成本控制**：`MinNum=0`（无请求缩容到 0，不计费）、CPU 0.25 核 / 内存 0.5 G、零外部依赖。

**结果**：`state` 从 `WAIT_USER_CONFIRM` → 用户确认 → `SUCCESS`，钱到账。

> 顺带一个反直觉的结论：环境的「固定出口 IP」开关**只对云托管生效，对云函数不生效**。想做 IP 白名单类对接，云函数这条路走不通。

### 2. 微信支付全链路真金跑通

```
小程序 wx.login → code
   ↓ HTTPS / wx.cloud
pay-create（云函数）→ jscode2session 换 openid → 商户私钥签名 → 微信 JSAPI 下单
   ↓ 二次签名
wx.requestPayment → 用户输密码
   ↓ 微信服务器主动推送
pay-notify（云函数）→ 公钥验签 → AES-256-GCM 解密 → 核对金额 → mark_order_paid
   ↓
orders.pay_status = 'paid'
```

关键设计：

- **公钥模式验签**：2024 年后新商户没有平台证书（`/v3/certificates` 返回 404），必须改用「微信支付公钥 + 公钥 ID」
- **金额核对**：`reward - discount` 必须等于微信报的实付金额，防止前端改价
- **幂等**：已 `paid` 的订单重复回调直接返回成功，不重复记账
- **防重放**：时间戳超出 5 分钟直接拒

实测证据：`paid_at`（14:12:45）**早于**前端收到 success 回调（14:12:48）3 秒——证明是微信服务端推送写入的，不是前端伪造。

### 3. 场景报备字段必须对上号（1000 ≠ 1005）

商家转账新版接口要求传「转账场景报备信息」，但**不同场景 ID 要求的字段完全不同**：

| 场景 ID | 场景名 | `info_type` 必须传 |
|---|---|---|
| 1000 | 现金营销 | 活动名称 / 奖励说明 |
| **1005** | **佣金报酬** | **岗位类型 / 报酬说明** |

传错了报的是 `未传入完整且对应的转账场景报备信息`——错误信息完全没有提示缺哪个字段，只能查文档。

另外 `user_recv_perception`（用户收款感知）只支持「劳务报酬 / 报销款 / 企业补贴 / 开工利是」四个值，传别的会报「暂不支持展示当前传入的用户收款感知」。默认不传（微信按「劳务报酬」展示）最安全。

### 4. 双轨信誉分，两套互不干扰

同一个用户在两个角色下有两套独立评价：

- `runner_score_*` —— 我作为**接单员**收到的评价
- `owner_score_*` —— 我作为**发布方**收到的评价
- `credit_strikes` —— 违规次数（举报下架时 +1，同时记一次最差评）

分成两轨的原因：一个人既发单又接单时，混在一起算会导致「跑腿跑得好」被「发单要求高」拖累，评分失去参考价值。

### 5. 八级权限 + 23 个灰度开关，拦截全在服务端

权限：`super` / `support` / `hr` / `review` / `rental` / `print` / `settle` / `dispatch`。
`super` 隐含全部，只有 `super` 能授/收 `super`，且**至少保留一个超管**（否则系统没人能管）。

23 个灰度开关存在 `feature_flags` 表里，前端每次进页面拉一次，服务端在每个 RPC 里也校验一次——
**前端隐藏不算数，服务端拒绝才算数**。

配置类页面（开关/轮播/FAQ）不受自己的开关控制，否则一关就再也打不开了。

### 6. 图片三通道鉴权（最容易漏的一块）

图片存 PostgreSQL（base64），三条独立通道：

| 通道 | 函数 | 适用 |
|---|---|---|
| 本人 / 管理员 | `get_media_asset` | 认证材料、后台自读 |
| **订单参与方** | `get_order_asset(asset_id, order_id)` | 订单图跨人查看 |
| 公开 | `get_public_asset` | 轮播图、头像 |

订单图不能走「本人」通道——接单员看不到发布方上传的图。也不能走公开通道——那是泄露。
必须「先验本单参与方，再验图挂在本单的 `images` / `deliver_images` 里」，两步都过才返回。

### 7. 全站写操作只有一个入口：数据库函数

前端**没有任何**直连写表的代码。所有写操作都是：

```
小程序 → rpc('函数名', { p_xxx }) → SECURITY DEFINER 函数（RLS + auth.uid() + SET search_path=public）
```

只有 5 张表给客户端直连权限（`profiles` / `addresses` / `orders` / `rental_requests` / `runner_applications`），其余 28 张表一律 `REVOKE ALL`。

好处：权限、校验、审计全在数据库里，前端改不了、抓包也绕不过。

### 8. 智能客服：三层兜底，不是纯接大模型

```
违规词拦截 → FAQ 关键词打分（阈值 8 = 命中权重 6 + 词长）→ 大模型流式兜底 → 转人工工单
```

先走便宜的确定性路径，答不准才调模型。模型参数（模型名 / 温度 / 最大字数 / 每日限额 / 超时）
全在 `faq_settings` 表里，管理员可改，不用发版。

每日提问次数用 `support_ai_requests` 表 + advisory lock 限流，防刷。

### 9. 分页、筛选、搜索都在服务端

大厅列表支持：服务类型 / 楼栋 / 楼层 / 关键词 / 排序（时间 or 赏金）/ 分页。
全部在 `list_hall_orders` 里用窗口函数 `count(*) over()` 一次查出总数，避免两次查询。

订单列表同样：状态筛选 + 关键词 + 分页 + 软删除（`order_hides` 表）。

### 10. 每个「危险操作」都有第二道闸

| 操作 | 第二道闸 |
|---|---|
| 删除订单 | 必须完结满 7 天（违规下架不受限） |
| 确认完成 | 必须状态是 `waiting_confirm` 且操作人是发布方 |
| 提现 | 单笔在途限制 + 余额 `FOR UPDATE` 锁 + 24 小时改手机号冷却 |
| 转账 | `transfer_prepare` 里 `FOR UPDATE` 锁单 + 状态必须 `pending` |
| 授超管 | 至少保留一个，且只有超管能授 |
| 管理员后台 | 前端二次确认（点两次）+ 服务端权限校验 |

### 11. 发单 / 接单 / 看联系方式前必须绑手机号

用**表级触发器**实现，不改 RPC：

- `orders_assert_phone`（INSERT + UPDATE OF runner_id）
- `runner_applications_assert_phone`、`rental_requests_assert_phone`

改 RPC 会漏——每个插入订单的路径都要记得加，实际上必然漏掉几个。触发器一劳永逸。

手机号存在 `profile_phones` 独立表（**不开 RLS policy**），不塞 `profiles.phone`，避免后台 `SELECT p.*` 时顺带泄露。

### 12. 注销账号：6 个月保留期，可恢复，不能靠重注册洗白

- 注销 = 软删除（`profiles.deleted_at` + `account_deletions.purge_after`）
- 6 个月内登录会问「是否使用原账号」，选「不使用」必须 logout + 写本地标记，防止被自动恢复
- 有未完成订单、有余额、有后台权限时**不允许注销**（先处理完）
- 到期后清理：登录时清自己（`purge_my_account_if_due`）+ 超管工作台兜底（`admin_purge_expired_deletions`）
- 清理是**真清**：昵称改「已注销用户」、清图片、清手机号、撤销权限

### 13. 可维护性被当成功能来做

- **56 条迁移全部可重放**（`cloudbase/migrations/`），空库能一键建到当前状态
- **四件套校验**每次改完必跑：语法 → 页面注册 → 上传预检 → 样式语法
- **292 条违规词**按 13 大类归档，白名单 4 条（「校园跑腿」「代跑腿」等业务词不能被误杀）
- 文档与代码同步：`docs/ITERATIONS.md` 记录每一轮的决策与踩坑

### 14. 回调不可靠时的对账兜底

微信回调可能因为验签失败、网络、重试耗尽而永远到不了。所以提现做了**双保险**：

- 微信回调 `/wxpay/transfer-notify` → 验签解密 → 改状态
- 后台刷新列表 / 用户打开钱包时，主动调 `transfer-svc` 的 `sync`，按 `out_bill_no` 去微信查真实状态并回写

即使回调完全不通，数据也永远是对的。这也解释了为什么 `WAIT_USER_CONFIRM` 的单子不会一直卡在「处理中」。

---

## 二、核心迭代

项目不是一次写完的，是一轮一轮长出来的。关键里程碑：

| 阶段 | 交付 |
|---|---|
| R1–R10 | 骨架：登录、发单、大厅、接单、送达、确认、钱包、订单列表 |
| R11–R20 | 权限体系（八级 + 23 开关）、实名认证、租赁、轮播、FAQ 配置 |
| R21–R30 | 信誉分双轨、积分商城、优惠券抵扣、优先展示、举报下架、批量发单 |
| R31–R40 | 图片三通道鉴权、手机号闸门、账号注销、工单双向对话、AI 客服三层兜底 |
| R41–R46 | 修复「点击没反应」类问题、入场动画、聊天页重构、性能与包体积优化 |
| **R47–R49** | **数据库整体迁移到腾讯云 CloudBase PostgreSQL**（36 表 / 154 函数 / 9 触发器全部对齐，56 条迁移可重放） |
| **R50** | **微信支付打通**（JSAPI 下单 + 公钥验签回调 + 金额核对 + 幂等） |
| **R51** | **提现打通**（云托管固定 IP + 商家转账 + 用户确认收款 + 失败自动退款 + 对账兜底） |
| **R52** | **前端整体切到 CloudBase**（云函数代持身份 `svc_rpc`，95 处 RPC 换通道，SDK 与 `miniprogram_npm` 一并删除）；**发单接入支付**（未付不进大厅），主包 1.44 → **0.95 MB** |
| **R53** | **图片分片上传**（绕开 `wx.cloud.callFunction` 1MB 入参上限）：阶梯压缩 + `begin/push/finish` 三片式上传，修掉接单员传身份证弹 `EXCEED_MAX_PAYLOAD_SIZE` |
| **R54** | **提现改服务端自动转账**：申请提交即打款，不再需要管理员点那一下；顺带查出云函数缺 `PAY_WEBHOOK_SECRET` 会让转账被云托管拒掉，改为运行时从库里读同一份密钥 |

其中最有价值的几次「翻车与纠正」：

- **`RETURNS TABLE` 的列名会变成 plpgsql 变量**——`admin_finish_withdrawal` 声明 `RETURNS TABLE(id, status, ...)`，函数体 `WHERE id = p_id` 直接报 `42702 ambiguous`。plpgsql 只在**首次执行**时编译，所以建函数时显示成功，一调就炸。而它是转账失败退款的入口，等于「钱扣了退不回来」。
- **`wx.cloud` 只能调「小程序自己的云开发环境」**——调腾讯云侧创建的 CloudBase 环境报 `-601034`。最后改成两张皮：小程序端走 HTTPS 网关，`wx.cloud` 只作为可选通道。
- **服务商授权会锁死域名和云开发**——小程序授权给第三方服务商后，`request 合法域名` 和开发者工具的云开发都会被拒（`80210`）。解除授权后域名配置权才回来。
- **`cloudfunctions/` 和 `cloudrun/` 必须进 `packOptions.ignore`**——否则上传预检会把 Node 内置模块当 npm 依赖，直接拦住发布。

---

## 三、技术架构

```
┌─────────────────────────────────────────────┐
│  微信小程序（原生，39 页）                    │
│  ES5 页面层，utils/api.js 唯一数据出口        │
└───────────────┬─────────────────────────────┘
                │ HTTPS（网关）或 wx.cloud
    ┌───────────┴────────────┐
    │                        │
┌───▼────────────────┐  ┌────▼──────────────────┐
│ CloudBase 云函数 ×6 │  │ 微信云开发（可选）      │
│ pay-create          │  │ tcb-proxy 转发          │
│ pay-notify          │  └───────────────────────┘
│ transfer-notify     │
│ withdraw-api        │
│ tcb-proxy           │
│ transfer            │
└───┬────────────┬────┘
    │            │
    │            │ HTTPS（固定出口 IP ✱）
    │      ┌─────▼──────────────────────┐
    │      │ CloudBase 云托管 transfer-svc │
    │      │ 固定出口 IP 122.51.67.142     │
    │      │ 对接微信支付商家转账            │
    │      └─────┬──────────────────────┘
    │            │
┌───▼────────────▼────┐
│ CloudBase PostgreSQL │
│ 36 表 / 154 函数      │
│ 9 触发器 / RLS        │
└─────────────────────┘
```

**为什么云托管单独拆出来**：只有它能拿到固定公网出口 IP，而微信商家转账按 IP 校验调用方。云函数做不到（实测 5 次 5 个 IP）。

**为什么云函数和云托管分两套**：云函数负责「不需要固定 IP」的一切（下单、回调、列表、提现申请）；云托管只负责「必须固定 IP」的一件事（转账）。职责单一，故障隔离。

---

## 四、支付与提现（端到端）

### 支付

| 步骤 | 位置 | 关键点 |
|---|---|---|
| 1. 拿 code | 小程序 `wx.login` | code 一次性，5 分钟有效 |
| 2. 换 openid | `pay-create` 调 `jscode2session` | AppSecret 只在服务端 |
| 3. 下单 | `pay-create` 签名调 JSAPI | 商户私钥 RSA-SHA256 |
| 4. 拉起收银台 | `wx.requestPayment` | 二次签名 `paySign` |
| 5. 回调 | 微信 POST `/wxpay/notify` | 公钥验签 + AES-256-GCM 解密 |
| 6. 落库 | `mark_order_paid` | 校验 secret + 幂等 + 金额核对 |

下单前先过一道闸：`pay_settings.enabled`（超管在后台随时开关）。关闸时 `pay-create`
直接返回 `PAY_DISABLED`，**不会去调微信下单接口**——真出事时能一键停收款。

### 提现

| 步骤 | 位置 | 关键点 |
|---|---|---|
| 1. 申请 | 钱包页 → `svc_create_withdraw` | 绑手机号 / 余额 `FOR UPDATE` / 单笔在途 / 门槛校验 |
| 2. 扣款 | 同上 | 扣余额 + 写 `wallet_records` 流水 |
| 3. **自动转账** | `withdraw-api` → 云托管 `transfer-svc` | **提交即打款**，不用人工点；固定 IP + 场景 1005 报备 |
| 4. 用户确认 | 钱包页「确认收款」 | `wx.requestMerchantTransfer` |
| 5. 到账 | 微信零钱 | 实测 0.1 元 |
| 6. 状态回写 | 回调 + `sync` 兜底 | 回调不通也能对账 |

**两道人工闸门**：`AUTO_TRANSFER=0` 可整体退回人工审核；单笔超过 `AUTO_TRANSFER_MAX`
（默认 200 元）的不自动打款，留给后台确认。**打款失败不会丢钱** —— 后台可重试，
或标记失败由 `admin_finish_withdrawal(false)` 退回余额并写退款流水；
上一版遗留在 `pending` 的旧单，会在下次打开钱包页时自动补转。

---

## 五、这是一个「纯 WorkBuddy」项目

**从第 1 行代码到第 51 轮迭代，没有一行是手写的。** 全程由 WorkBuddy 智能体驱动完成：
读需求 → 改代码 → 跑校验 → 执行数据库迁移 → 写迭代记录 → 推送 GitHub。

### 使用的模型

| 模型 | 承担的部分 |
|---|---|
| **混元 4（Hunyuan 4）** | 方案设计、架构决策、复杂推理、跨模块审阅 |
| **DeepSeek V4.1 Flash** | 长上下文快速改写、页面实现、批量重构、文档整理 |

两者按任务复杂度路由：需要「想清楚」的走混元 4，需要「快速翻完 15,000 行再动手」的走 Flash。

### 人和 AI 各自做什么

| 人 | AI |
|---|---|
| 提需求、定优先级、验收真机效果 | 拆需求、读历史、定位根因、写实现 |
| 判断「这个交互对不对」 | 跑四件套校验、69 项回归测试、执行 SQL 迁移 |
| 决定要不要上线 | 更新文档、写踩坑记录、按轮次提交推送 |

### AI 实际交付了什么

| 产物 | 规模 |
|---|---|
| 页面 | 39 个（四件套齐全，全部在 `app.json` 注册） |
| 前端代码 | 16,326 行 JS ／ 4,987 行 WXML ／ 4,862 行 WXSS（含 utils / components / app） |
| 数据库 | 36 张表、154 个函数、9 个触发器、56 个幂等迁移脚本 |
| 测试 | 69 项回归测试（含真实 PostgreSQL 执行） |
| 文档 | 1,400+ 行迭代记录 + 踩坑知识库 + 逐轮 CHANGELOG |

### 为什么把过程也写进仓库

`docs/ITERATIONS.md` 里有 **9 条 AI 开发的真实踩坑**（第 8 章），包括那次
「连续 6 轮改错方向」的教训：客服页消息间隔空一大截，前 3 轮都在调 `scroll-view` 高度，
真实原因是 `app.wxss` 里一条全局 `.home, .mine { min-height: 100vh }` 撞了消息行的
class 名 `mine`——每条自己发的消息都被撑到一屏高。**类名改掉，问题当场消失。**

这类坑 AI 会重复踩，也会重复读。所以文档不是装饰，是这个项目能迭代 49 轮而不失控的原因。

---

---

## 六、能力概览（按角色）

### 发布方
10 类服务下单（取快递 / 帮我买 / 取奶咖 / 拿外卖 / 打印 / 宿舍清洁 / 代排队 / 到店取餐 /
行李代搬 / 其它）· 三级宿舍地址选择 · 赏金两位小数 · 期望时间 · 性别限制 · 配图（违规词校验）·
积分券抵扣 · 优先券置顶 · 取消任务 · 确认完成（二次点击）· 48h 未确认可申请核查

### 接单员
需实名认证（姓名 + 学生证/身份证）· 任务大厅筛选（服务类型 / 赏金或时间排序 / 楼栋楼层）·
上拉分页 · 接单（禁止自接自单）· 放弃接单（重新开放）· 送达佐证 1–3 张 ·
被评价 / 收信誉分 / 看违规次数

### 管理员（八级）
工作台待办汇总 · 权限矩阵 · 灰度总闸 · 轮播 · 积分商品与调分 · 接单员审核 ·
相机租赁报价 · 举报下架（扣信誉）· 结算核查 · 反馈工单 · 批量发单 · FAQ 与模型参数

### 所有人
微信一键登录 · 绑定手机号（发单/接单前置）· 消息中心（订单/租赁/认证/举报四类触发）·
智能客服 · 意见反馈工单（双向对话）· 注销账号（6 个月内可恢复）· 用户协议 · 热更新检查

---

## 七、页面地图（39 页）

### 主流程

| 路径 | 页面 | 做什么 |
|---|---|---|
| `pages/index/index` | 首页 | 公告条 + 10 类服务宫格 + 大厅入口卡 + 轮播 |
| `pages/hall/index` | 任务大厅 | 类型/排序/楼栋楼层筛选、上拉分页、未认证时锁卡引导 |
| `pages/order/create` | 发单 | 服务表单、三级地址、赏金、期望时间、配图、违规词校验、草稿 |
| `pages/order/detail` | 任务详情 | 时间轴、对方信誉分、送达佐证上传、二次点击确认、举报、48h 核查 |
| `pages/orders/list` | 我的订单 | 发布/接单双模式、状态筛选、关键字搜索、上拉分页、软删除与恢复 |
| `pages/order/review` | 互评 | 打分 + 标签 + 评论（仅订单参与方） |

### 我的

| 路径 | 页面 | 做什么 |
|---|---|---|
| `pages/mine/index` | 我的 | 资料卡、钱包/积分/信誉/优惠券入口、客服与设置入口 |
| `pages/mine/profile` | 资料 | 头像与昵称（缺昵称时强制补全） |
| `pages/mine/address` | 常用地址 | 增删改，发单时直接选 |
| `pages/mine/apply` | 接单员申请 | 实名信息 + 证件照上传 |
| `pages/mine/cert` | 认证状态 | 审核进度与驳回原因 |
| `pages/mine/credit` | 信誉分 | 双轨分数、评分次数、完成单数、违规次数 |
| `pages/mine/points` | 我的积分 | 余额与逐笔明细 |
| `pages/mine/wallet` | 钱包 | 余额与流水（**R52 起已通微信支付，可提现到零钱**） |
| `pages/mine/mall` | 积分商城 | 兑换抵扣券 / 核销券 / 优先券 |
| `pages/mine/messages` | 消息中心 | 四类推送、单条已读、全部已读 |
| `pages/mine/feedback` | 意见反馈 | 提交工单与我提交的列表 |
| `pages/feedback/thread` | 工单会话 | 用户与客服共用（pending 只有客服能说 / resolved 双方可说） |
| `pages/mine/reviews` | 评价 | 我收到的评价 + 待评价 |
| `pages/mine/bind-phone` | 绑定手机号 | 短信验证码绑定/更换，说明一个号只能绑一个账号 |
| `pages/mine/settings` | 设置 | 手机号、后台密码入口、注销账号（含后果确认弹窗）、协议 |
| `pages/mine/support` | 智能客服 | FAQ 命中 → AI 流式 → 转人工 |

### 租赁 / 其它

| 路径 | 页面 | 做什么 |
|---|---|---|
| `pages/rental/index` | 相机租赁 | 5 款机型（POCKET 4/3、Mini99、WIDE 400、Mini12）与日租金 |
| `pages/rental/apply` | 租赁申请 | 填资料提交，等管理员报价 |
| `pages/agreement/index` | 用户协议 | 首次下单前必须同意 |

### 后台（八级权限隔离）

| 路径 | 页面 | 权限 |
|---|---|---|
| `pages/admin/dashboard` | 工作台 | 任意后台身份（按权限过滤待办卡片） |
| `pages/admin/staff` | 权限管理 | `super` / `hr` |
| `pages/admin/flags` | 灰度总闸 | 仅 `super` |
| `pages/admin/banners` | 轮播 | `super` |
| `pages/admin/points` | 积分商品 / 调分 | `support` |
| `pages/admin/review` | 接单员审核 | `review` |
| `pages/admin/reports` | 举报处理 | `review` |
| `pages/admin/settle` | 结算核查 | `settle` |
| `pages/admin/withdraw` | **提现管理（自动转账）** | `settle` |
| `pages/admin/rental` | 租赁报价 | `rental` |
| `pages/admin/items` | 机型与挂牌价 | `rental` |
| `pages/admin/feedback` | 客服受理 | `support` |
| `pages/admin/dispatch` | 批量发单 | `dispatch` |
| `pages/admin/faq` | FAQ 与模型参数 | `super` |

---

## 八、技术栈与铁律

- **微信原生小程序**，不使用第三方框架。
- **页面层强制 ES5**：`const/let + function`，禁箭头函数 / 模板字符串 / 展开运算符；
  页面里用 `.then().catch()`，只有 `utils/api.js` 内部用 `async`。
- **后端 = WorkBuddy Cloud（PostgreSQL）**，应用 id `wbapp_yPJnSvicojPmz998PjKfpM`。
  前端 `cloud.database.rpc('fn', { p_xxx })` 调数据库函数。
- **写操作一律走 `SECURITY DEFINER` 函数**：RLS + `auth.uid()` + `SET search_path = public`。
  `owner_id` 是超过 2^53 的字符串，**绝不在客户端拼 `owner_id` / `runner_id` 做比较**。
- **RPC 返回类型必须是结构化类型**（`TABLE` / `SETOF` / `json`）。`RETURNS text` 会让 SDK
  解析失败并把**响应体原文当错误信息**——详情页红条显示 `runner` 就是这么来的（R43 修了 7 个）。
- **所有数据库变更必须落成 `sql/*.sql`**，否则重建环境会退回旧语义。
- **WXML 循环必须显式写 `wx:for-item`**，否则用自定义变量名会静默渲染成空白。
- `ui.*` 只认 `utils/ui.js` 的导出名（`loading` / `toast` / `hideLoading` …），写错取到 `undefined`。
- **写业务 class 前先 `grep app.wxss`**，别撞上 `.home` / `.mine` / `.page` 这类全局规则。
- **表级约束优先于改函数**：手机号闸门用触发器实现（`orders` / `runner_applications` /
  `rental_requests`），因为 `create_order` / `admin_batch_create_orders` 写法各异，逐个加必漏。
- 新增页面四件套后必须在 `app.json` 注册。

## 九、目录结构

```
campus-errand/
├── app.js / app.json / app.wxss     全局（含 wx.getUpdateManager 热更新检查）
├── pages/            39 个页面（见「页面地图」）
├── components/room-picker/   三级宿舍选择器
├── utils/            16 个：api / tcb / upload / pay / ui / guard / flags / perms /
│                     motion / moderation / moderation-words / campus / services /
│                     config / agreement / login-return
├── sql/              28 个幂等迁移脚本（可重放；旧库 WorkBuddy Cloud 已退役，留作结构参考）
├── cloudfunctions/   7 个（app-api / pay-create / pay-notify / tcb-proxy /
│                     transfer / transfer-notify / withdraw-api）
├── cloudrun/         云托管函数型服务 transfer-svc（固定出口 IP，对接商家转账；已加 packOptions.ignore）
├── tests/            69 项回归测试（含 PGlite 真实 PostgreSQL）
├── tools/            verify-mp / check-mp / style-lint / release-check
└── docs/             迭代记录 / 环境 / 发布 / 验收 / 代码审阅 / 支付方案
```

## 十、数据库

**现役库只有一套**：CloudBase `ceshi-d2g37cbg7c8f7ee48`（R52 起，WorkBuddy Cloud 已退役）。

- **36 张表**（`pay_settings` / `withdraw_requests` / `phone_codes` / `media_uploads` /
  `media_upload_parts` 等为 R50–R53 新增；`profile_phones` / `account_deletions` 不开 policy，
  只给函数访问；FAQ 两张为公开只读）
- **154 个函数**，命名约定 `p_` 前缀参数
- **9 个触发器**：订单消息推送、图片归属校验、手机号闸门 ×3 等
- **56 条迁移脚本**，全部幂等，按文件名顺序执行即可重建 —— 在
  **`cloudbase/migrations/`**（工作区根下，与 `campus-errand/` 同级，**不在本仓库内**）。
  完整清单与引入轮次见 [`docs/ITERATIONS.md` 第 3 章](docs/ITERATIONS.md)。
- 包内 `sql/` 还有 **28 个**早期迁移脚本，属已退役旧库的结构参考，不再对现役库执行。
- 支付方案与前置清单见 [`docs/PAYMENT.md`](docs/PAYMENT.md)。

### 订单状态机

```
pending ──accept──> accepted ──complete──> waiting_confirm ──confirm──> done
   │                    │                        │
   │                    └──abandon──> pending    └──submit_settle_feedback(满48h)──> 核查
   └──cancel──> canceled
   └──admin_handle_report──> takedown（orders.takedown = true，扣信誉）
```

### 三个关键约定

1. `auth.uid()` 返回 **text**（微信登录是 `wx:openid` 这种字符串），任何「谁改的」列都用 text，
   写 `uuid` 会在真机写入时 22P02。
2. 更新类 RPC 里写 `COALESCE(p_x, 原列名)` 表示 NULL = 不改；**不要写 `COALESCE(p_x, false)`**，
   那会把没传的开关一起清掉。
3. 改函数**返回列**必须先 `DROP FUNCTION` 再 `CREATE`，重建后 **GRANT 要重跑**（权限绑函数 oid）。

## 十一、本地校验（每次改完必跑）

```bash
npm ci --ignore-scripts
npm test        # 60 项回归
npm run check   # 四件套：语法 / 页面注册 / 上传预检 / WXSS 语法
```

`npm run check` 包含安全配置门禁、全量 JS 语法、页面与事件绑定检查、ESM 上传预检、
真实包体积、WXML/WXSS 样式检查与回归测试。测试与构建工具都被排除在上传包之外，
GitHub Actions 跑同样的命令。

## 十二、部署

**发布通道**：企业主体小程序（2026-10-27 绑定，审核中）。WorkBuddy 试用版通道已停用 ——
试用小程序没有后台、没有 AppSecret、14 天不转正即注销，只能用于早期真机验证。
正式版提审前需按微信要求准备：小程序备案、用户隐私保护指引（手机号 / 证件照 / 地址 / 图片）、
UGC 信息安全声明，服务类目需企业主体（跑腿类目个人主体不可选）。

1. 微信开发者工具打开本目录（`miniprogram_npm` 必须在，`node_modules` 被 `packOptions.ignore` 排除）。
2. 主包需 ≤ 2 MB，当前 **0.96 MB / 2.00 MB**（183 个文件，`node_modules` 已由
   `packOptions.ignore` 排除，不在包内）。
3. 目标库按顺序执行以下关键迁移（均已落库，重建环境时需要按此顺序重放；
   完整 28 个脚本见 `docs/ITERATIONS.md` 第 3 章）：
   - `sql/fix-order-support-workflows.sql` —— 订单分页 / 放弃接单 / AI 配额
   - `sql/restore-admin-password.sql` —— 后台密码（盐值哈希 + 15 分钟限频 + 审计）
   - `sql/fix-asset-authorization.sql` —— 图片归属校验 + dispatch 权限
   - `sql/fix-text-rpc-returns.sql` —— 7 个 text 返回改成 TABLE
   - `sql/add-phone-and-deletion.sql` —— 手机号闸门 + 账号注销（6 个月保留期）
   - `sql/fix-order-asset-trigger.sql` —— 图片归属触发器只校验改动列
4. 灰度开关默认**全关**，发布后由 super 在「管理员工作台 → 总闸」逐个打开。
5. 后台密码入口在「我的 → 设置 → 后台密码入口」。
6. 环境选型与发布细节见 [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md)、
   [`docs/RELEASE.md`](docs/RELEASE.md)、[`docs/VERIFY.md`](docs/VERIFY.md)。
7. **云函数（R49 起）**：`cloudfunctions/` 下 6 个函数已部署。云函数属服务端代码，
   已加进 `packOptions.ignore`，**不进小程序包**；密钥（`WXPAY_SERIAL_NO` /
   `WXPAY_PRIVATE_KEY` 等）只在云函数控制台的环境变量里配，不进代码与仓库。
   支付完整方案见 [`docs/PAYMENT.md`](docs/PAYMENT.md)。

8. **云托管（R51 起）**：`cloudrun/transfer-svc` 是**函数型云托管服务**，专门负责
   提现转账。之所以不用云函数：微信商家转账按调用方 IP 校验，而**云函数的出口 IP
   每次都变**（实测 5 次 5 个不同 IP），云托管才能拿到固定的公网出口 IP。

   部署与配置：
   ```bash
   # 代码在 cloudrun/transfer-svc/，零外部依赖
   # 通过 CloudBase 控制台或 MCP 部署；函数型服务端口固定 3000
   # 环境变量 9 个：WXPAY_MCHID / WXPAY_APPID / WXPAY_SERIAL_NO / WXPAY_PRIVATE_KEY
   #   WXPAY_TRANSFER_SCENE=1005（佣金报酬） / WXPAY_TRANSFER_NOTIFY
   #   PAY_WEBHOOK_SECRET / TCB_ENV_ID / TCB_PUBLISHABLE_KEY
   # MinNum=0 可缩容到 0，无请求时不计费
   ```
   上线前必须做两件事：
   - CloudBase 控制台 → 云函数/托管 → 环境设置 → 开启「**固定访问公网的出口 IP**」
   - 把这个固定 IP 填进微信支付商户平台 → **系统信息管理**（应用范围含「商家转账到零钱」）

## 十三、关于 Git 历史（务必知情）

仓库在 2026-10-17 立项，此前 29 轮迭代只留有「最终态」文件，**没有逐行 diff 可还原**。
因此历史按下述方式重建：

```
每一轮提交 = 该轮首次引入的文件（以最终内容入库） + CHANGELOG.md 追加一节
提交时间   = 该轮真实发生时间（锚点取自 sql/*.sql 的 mtime 与迭代记录）
```

即：**文件级快照可回溯，行级 diff 不可回溯**。想看某一轮「改了什么」，读 `CHANGELOG.md`
对应小节 + `docs/ITERATIONS.md`；想看某一轮「引入了哪些文件」，`git show --stat <commit>`。
R29 之后的所有改动都是真实 diff。

当前 `main` 有 **87 次提交、6 个 tag**（`v0.1.0` ~ `v0.6.0`）。
R39 的三个第三方提交曾被摘除并压成一条整合提交，改写前后文件树 hash 完全一致
（代码零改动，只换了提交边界与作者）。

## 十四、已知风险

- 后台入口使用加盐摘要 + 失败限流 + 审计；共享管理员口令仍应定期轮换。
- **支付与提现已全链路真金跑通，跨库桥接态已于 R52 结束**：`pay-create` / `pay-notify` /
  `transfer` / `transfer-notify` 四个云函数 + 云托管 `transfer-svc` 全部上线。
  2026-10-28 真钱付了 0.01 元（微信回调写入 `pay_status=paid`，`paid_at` 比前端收到
  success 还早 3 秒，证明是服务端推的）；2026-10-29 真钱提了 0.10 元（微信侧
  `state=SUCCESS`，`update_time=01:46:36`）。R52 前端整体切到 CloudBase 后，
  **支付与业务数据已在同一库**，真实订单带 `pay_status` 字段，不再是「只有测试单能付」。
  残留运维项：商户 API 证书 5 年有效期到期需轮换。
- **`pay_settings.commission_rate` 是唯一结算口径**：抽佣、到手金额必须走
  `calc_settle_amount()`，**前端不准自己乘**——四舍五入的口径只存在数据库一处。
  否则会出现「页面显示到手 9.50、实际入账 9.49」的对不上账。
  （`pay_settings.enabled` 这个总闸已接进 `pay-create`：关闸直接返回 `PAY_DISABLED`，
  连微信接口都不碰；查询失败按「开」放行，不因监控读超时停掉收款。）
- **二清合规风险（业务定性，非技术）**：平台代收再转付接单员，需定性为「平台自营 +
  向接单员支付劳务报酬」，并保留协议与报酬明细；正式运营前建议过一遍学校法务/财务。
  商家转账走场景 **`1005`（佣金报酬）**，报备字段必须传「岗位类型 / 报酬说明」，
  与 `1000`（现金营销）的「活动名称 / 奖励说明」**不通用**；微信改规则时这里要跟着改。
- **提现绑死在云托管的固定出口 IP 上**：云函数出口 IP 每次冷启动都可能变（实测连调 5 次
  拿到 5 个不同 IP：`118.25.84.125` / `1.117.67.181` / `124.223.156.249` /
  `101.34.204.192` / `124.221.12.168`），所以转账只能在云托管 `transfer-svc` 上跑
  （固定 `122.51.67.142`，已进商户平台「系统信息管理」白名单）。**换环境、换服务名、
  重建实例都要重新确认 IP 并重配白名单**，否则转账直接报 `此IP地址不允许调用接口`。
  `MinNum=0` 省钱的代价是冷启动 2~5 秒（用户点完会觉得慢半拍）。
- ~~**数据库处于双库期**~~（R52 已结束）：前端整体切到 CloudBase，WorkBuddy Cloud 退役。
  数据访问统一走「云函数代持身份」的 `svc_rpc`：`wx.cloud` 中转之后调用者身份不能靠客户端
  声明，由云函数先验 HMAC 令牌拿到可信 uid，再在同一事务里 `set_config('request.jwt.claim.sub', uid)`
  后执行业务函数 —— 库里 129 个 `SECURITY DEFINER` 函数一行未改。
  `cloudbase/migrations/` 的 56 条脚本 **不在 git 内**——不是被 `.gitignore` 忽略，
  而是仓库根是 `campus-errand/`、`cloudbase/` 是同级兄弟目录。空库重建目前只能靠这份
  本地目录，建议尽快纳入版本控制或另存一份。
- **短信验证码尚未开通**：腾讯云 SMS 的 5 个环境变量（`SMS_SECRET_ID` / `SMS_SECRET_KEY` /
  `SMS_SDK_APP_ID` / `SMS_TEMPLATE_ID` / `SMS_SIGN_NAME`）未配置前，新用户绑不了手机号，
  也就发不了单（管理员账号已绑，不受影响）。
- 旧对象存储的证件照不可读，需用户重新提交。
- AI 配额按账号在服务端记账，但模型仍由客户端直连（`api.llmChat` →
  `cloud.llm.chat.completions.create`），**绕过端上代码仍可直接调 `llmChat`**；
  严格成本防刷需要可信服务端网关。云函数已就位，这是下一步最值得搬的一块。
- `getOrder` 等聚合查询依赖服务端脱敏口径，新增字段时记得同步更新字段白名单。
- ~~**手机号是「客户端声明 + 短信验证过」的，可跳过发码直接声明号码**~~ ✅ **R52 已堵死**：
  不再借道 auth provider，改为**自建服务端验证码** —— `issue_phone_code` 生成 6 位码，
  `phone_codes` **只存哈希**，明文只回云函数用于发短信；`bind_my_phone_verified` 把验码与写库
  合并成一次原子调用。**客户端拿不到明文验证码，「跳过发码直接绑号」这条路已不存在**，
  也不会再出现「绑完跳到另一个账号」。
  残留项：腾讯云 SMS 的 5 个环境变量（`SMS_SECRET_ID` / `SMS_SECRET_KEY` /
  `SMS_SDK_APP_ID` / `SMS_TEMPLATE_ID` / `SMS_SIGN_NAME`）未配置前发不了码，
  新用户绑不了手机号（管理员账号已绑，不受影响）。

---

## 十五、许可

仓库**公开**供学习与参考，但**未附开源许可证**（即默认保留所有权利）。
如需二次开发、分发或商用，请先联系仓库所有者。

---

**迭代记录与踩坑知识库是本项目最重要的资产 —— 改代码前请先读 [`docs/ITERATIONS.md`](docs/ITERATIONS.md)。**
