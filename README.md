# 校园跑腿（广东邮电职业技术学院）

> 🔓 **公开仓库**：https://github.com/1345463/campus-errand ｜ 默认分支 `main`
>
> 校园互助跑腿平台。微信原生小程序 + PostgreSQL（WorkBuddy Cloud）。
> 所有跨用户写操作走 `SECURITY DEFINER` 函数，全表 RLS，前端不做任何权限判断。

| 迭代 | 页面 | 数据表 | 数据库函数 | 回归测试 | 主包 |
|---|---|---|---|---|---|
| **46 轮** | **38 个** | **31 张** | **129 个** | **55 项** | **1.40 / 2.00 MB** |

> **📦 当前发布状态（2026-10-27）**
> 企业主体小程序账号已绑定，正在走微信审核流程。此前通过 WorkBuddy 的**试用版**通道
> （微信「试用小程序」：14 天有效、最多 15 人、不能直接转正式版）完成真机验证，试用期已结束。
> 审核通过后发布**正式版**，不再有 14 天与 15 人限制。

---

## 一、这是一个「纯 WorkBuddy」项目

**从第 1 行代码到第 43 轮迭代，没有一行是手写的。** 全程由 WorkBuddy 智能体驱动完成：
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
| 判断「这个交互对不对」 | 跑四件套校验、55 项回归测试、执行 SQL 迁移 |
| 决定要不要上线 | 更新文档、写踩坑记录、按轮次提交推送 |

### AI 实际交付了什么

| 产物 | 规模 |
|---|---|
| 页面 | 38 个（四件套齐全，全部在 `app.json` 注册） |
| 前端代码 | 16,326 行 JS ／ 4,987 行 WXML ／ 4,862 行 WXSS（含 utils / components / app） |
| 数据库 | 31 张表、129 个函数、7 个触发器、28 个幂等迁移脚本 |
| 测试 | 55 项回归测试（含真实 PostgreSQL 执行） |
| 文档 | 1,400+ 行迭代记录 + 踩坑知识库 + 逐轮 CHANGELOG |

### 为什么把过程也写进仓库

`docs/ITERATIONS.md` 里有 **9 条 AI 开发的真实踩坑**（第 8 章），包括那次
「连续 6 轮改错方向」的教训：客服页消息间隔空一大截，前 3 轮都在调 `scroll-view` 高度，
真实原因是 `app.wxss` 里一条全局 `.home, .mine { min-height: 100vh }` 撞了消息行的
class 名 `mine`——每条自己发的消息都被撑到一屏高。**类名改掉，问题当场消失。**

这类坑 AI 会重复踩，也会重复读。所以文档不是装饰，是这个项目能迭代 46 轮而不失控的原因。

---

## 二、项目特点

不是「又一个跑腿 demo」。下面每一条都有对应的服务端机制，不是前端摆样子。

### 1. 双轨信誉分，两套互不干扰

同一个账号，作为**接单员**和作为**发布方**是两套分：

- `runner_score_sum / count` —— 别人对「我这个接单员」的评价
- `owner_score_sum / count` —— 别人对「我这个发布者」的评价
- `credit_strikes` —— 违规次数，由举报下架累加

评价页会同时展示对方的分数、评分次数、完成单数、违规次数——**决定要不要和这个人合作之前，
信息是齐的**。

### 2. 八级权限 + 23 个灰度开关，拦截全在服务端

```
super / support / hr / review / rental / print / settle / dispatch
```

- `super` 隐含全部权限，**只有 super 能授或收 super**（服务端硬拦，前后端都过不去）
- 新增权限键要改三处：`admin_set_perm` 白名单、`admin_my_perms` 返回列表、页面判断
- 前端判断**只决定显示与否**，真正的拦截在每个 RPC 里调 `admin_has_perm()`

23 个灰度开关挂在 `feature_flags`，默认关闭，由 super 在「总闸」页逐个打开；
配置类页面（总闸 / 轮播 / FAQ）**不受自己的开关约束**，否则关掉就再也打不开。

### 3. 图片三通道鉴权（这是最容易漏的一块）

| 通道 | 谁能读 | 用在哪 |
|---|---|---|
| `get_media_asset` | 只有上传者本人（或管理员） | 认证材料、后台轮播 |
| `get_order_asset` | 只限**这一单的参与方** | 任务图、送达佐证 |
| `get_public_asset` | 所有人（scope 限 banner / avatar） | 轮播图、头像 |

订单里的图天然跨人（发布方传任务图、接单员传送达佐证），所以不能走「本人」通道；
但也不能谁都能读——`get_order_asset` 会校验「你是这一单的发布方/接单员」+
「这张图确实挂在这张单上」+「这张图的 owner 是本单参与方」三道。

### 4. 全站写操作只有一个入口：数据库函数

前端没有任何 `INSERT / UPDATE / DELETE`，只有 `cloud.database.rpc('fn', { p_xxx })`。
每个函数都是 `SECURITY DEFINER` + `SET search_path = public` + `auth.uid()` 取身份，
表上开 RLS。客户端拿不到也改不了不该碰的行。

### 5. 智能客服：三层兜底，不是纯接大模型

```
违规词拦截 → FAQ 关键词打分（命中阈值 8）→ 大模型流式回答 → 转人工工单
```

- FAQ 命中直接回固定答案，**不烧 token**
- 兜底才走大模型，带 `buildHistory()` 自己拼上下文（会话 id 不等于服务端记忆）
- 两条都不行，引导转人工建工单
- 每日配额在**服务端按账号记账**（`begin_support_ai` 预占 / `finish_support_ai` 结算，
  130 秒未完成自动释放），不是本地 storage 计数

### 6. 分页、筛选、搜索都在服务端做

`list_my_orders_v2` 一次接住模式（发布/接单/管理）、状态、关键字、`limit/offset`。
**不是**前端拉全量再 `filter()`——那样翻页会重复、漏单，极端情况还会无限拉同一页。

### 7. 每个「危险操作」都有第二道闸

- 后台改积分：`adjusting` 防重 + 二次确认（扣到不够时说清会被归零）
- 商品上下架：先拉最新行再 upsert，**不会把用户已兑换的库存写回旧值**
- 详情页取消/确认：不用 `wx.showModal`，改成页面内「再点一次确认」（预览容器里 `showModal` 可能缺失）
- 举报下架：前置状态校验，同一条举报重复处理不会重复扣信誉分

### 8. 发单 / 接单 / 看联系方式前必须绑手机号

浏览任务大厅不需要绑定，但**发单、接单、提交接单员认证、租赁下单、查看对方联系方式**
必须先绑定本人手机号（`profile_phones`，全站唯一，24 小时只能改一次）。

拦截不是前端弹窗，而是服务端的表级触发器（`orders` / `runner_applications` /
`rental_requests`）+ 详情接口对 `contact` 的脱敏 —— 改包也绕不过。
手机号存独立表而不是 `profiles`，避免任何 `SELECT p.*` 顺手把它带出去。

### 9. 注销账号：6 个月保留期，可恢复，不能靠重注册洗白

注销后立即停用并退出登录，但数据**保留 6 个月**用于纠纷追溯：

- 期内用同一微信登录 → 弹「是否使用原账号？」；选恢复则继续用原来的订单与积分
- 选「不使用」→ 保留期内**不允许注册新账号**，手机号也不会释放给别人
- 满 6 个月 → 昵称 / 头像 / 手机号 / 证件照 / 联系方式全部清除，订单只留去标识化记录

注销前会拦：有未完成订单、钱包余额不为 0、还持有后台权限。

### 10. 可维护性被当成功能来做

| 机制 | 作用 |
|---|---|
| 校验四件套 | 语法 / 页面注册 / 上传预检 / WXSS 语法，缺一个就传不上去 |
| 55 项回归测试 | 含真实 PostgreSQL 执行（PGlite），改完立刻知道有没有打断 |
| GitHub Actions | 同样的命令跑在 CI，人懒的时候也不会漏 |
| 迭代记录 + 踩坑库 | 每轮的现象、真因、修法、教训，下次不用重新踩 |

---

## 三、能力概览（按角色）

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

## 四、页面地图（38 页）

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
| `pages/mine/wallet` | 钱包 | 余额与流水（未接支付，不可提现） |
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
| `pages/admin/rental` | 租赁报价 | `rental` |
| `pages/admin/items` | 机型与挂牌价 | `rental` |
| `pages/admin/feedback` | 客服受理 | `support` |
| `pages/admin/dispatch` | 批量发单 | `dispatch` |
| `pages/admin/faq` | FAQ 与模型参数 | `super` |

---

## 五、技术栈与铁律

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

## 六、目录结构

```
campus-errand/
├── app.js / app.json / app.wxss     全局（含 wx.getUpdateManager 热更新检查）
├── pages/            38 个页面（见「页面地图」）
├── components/room-picker/   三级宿舍选择器
├── utils/            api / upload / ui / guard / flags / perms / motion /
│                     moderation / campus / services / config / agreement / cloud
├── sql/              28 个幂等迁移脚本（可重放）
├── tests/            55 项回归测试（含 PGlite 真实 PostgreSQL）
├── tools/            verify-mp / check-mp / style-lint / release-check
├── docs/             迭代记录 / 环境 / 发布 / 验收 / 代码审阅
└── miniprogram_npm/  SDK 构建产物（必须入库，删了跑不起来）
```

## 七、数据库

- **31 张表，27 张开 RLS**（`profile_phones` / `account_deletions` 不开 policy，只给函数访问；其余 2 张是公开只读的 FAQ 配置）
- **129 个函数**，命名约定 `p_` 前缀参数
- **7 个触发器**：订单消息推送、图片归属校验、手机号闸门 ×3 等
- **28 个迁移脚本**，全部幂等，按文件名顺序执行即可重建（完整清单见
  [`docs/ITERATIONS.md` 第 3 章](docs/ITERATIONS.md)）

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

## 八、本地校验（每次改完必跑）

```bash
npm ci --ignore-scripts
npm test        # 55 项回归
npm run check   # 四件套：语法 / 页面注册 / 上传预检 / WXSS 语法
```

`npm run check` 包含安全配置门禁、全量 JS 语法、页面与事件绑定检查、ESM 上传预检、
真实包体积、WXML/WXSS 样式检查与回归测试。测试与构建工具都被排除在上传包之外，
GitHub Actions 跑同样的命令。

## 九、部署

**发布通道**：企业主体小程序（2026-10-27 绑定，审核中）。WorkBuddy 试用版通道已停用 ——
试用小程序没有后台、没有 AppSecret、14 天不转正即注销，只能用于早期真机验证。
正式版提审前需按微信要求准备：小程序备案、用户隐私保护指引（手机号 / 证件照 / 地址 / 图片）、
UGC 信息安全声明，服务类目需企业主体（跑腿类目个人主体不可选）。

1. 微信开发者工具打开本目录（`miniprogram_npm` 必须在，`node_modules` 被 `packOptions.ignore` 排除）。
2. 主包需 ≤ 2 MB，当前 **1.40 MB / 2.00 MB**（176 个文件，`node_modules` 已由
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

## 十、关于 Git 历史（务必知情）

仓库在 2026-10-17 立项，此前 29 轮迭代只留有「最终态」文件，**没有逐行 diff 可还原**。
因此历史按下述方式重建：

```
每一轮提交 = 该轮首次引入的文件（以最终内容入库） + CHANGELOG.md 追加一节
提交时间   = 该轮真实发生时间（锚点取自 sql/*.sql 的 mtime 与迭代记录）
```

即：**文件级快照可回溯，行级 diff 不可回溯**。想看某一轮「改了什么」，读 `CHANGELOG.md`
对应小节 + `docs/ITERATIONS.md`；想看某一轮「引入了哪些文件」，`git show --stat <commit>`。
R29 之后的所有改动都是真实 diff。

当前 `main` 有 **70 次提交、6 个 tag**（`v0.1.0` ~ `v0.6.0`）。
R39 的三个第三方提交曾被摘除并压成一条整合提交，改写前后文件树 hash 完全一致
（代码零改动，只换了提交边界与作者）。

## 十一、已知风险

- 后台入口使用加盐摘要 + 失败限流 + 审计；共享管理员口令仍应定期轮换。
- 未接支付，钱包不可提现（页面已如实说明）。
- 旧对象存储的证件照不可读，需用户重新提交。
- AI 配额按账号在服务端记账，但模型仍由客户端直连，**绕过端上代码仍可直接调 `llmChat`**；
  严格成本防刷需要可信服务端网关。
- `getOrder` 等聚合查询依赖服务端脱敏口径，新增字段时记得同步更新字段白名单。
- **手机号是「客户端声明 + 短信验证过」的**：OTP 由 auth provider 校验，验证后会话会切成手机号
  身份，而 SDK 没有绑定接口，只能验完立刻切回微信身份再写绑定。恶意客户端可跳过发码直接调
  `bind_my_phone` 声明号码，当前靠格式 + 全站唯一 + 24 小时防抖把影响限制在「占用一个号码」。
  等接入云函数后应改为「服务端换号 + 签名票据」。

---

## 十二、许可

仓库**公开**供学习与参考，但**未附开源许可证**（即默认保留所有权利）。
如需二次开发、分发或商用，请先联系仓库所有者。

---

**迭代记录与踩坑知识库是本项目最重要的资产 —— 改代码前请先读 [`docs/ITERATIONS.md`](docs/ITERATIONS.md)。**
