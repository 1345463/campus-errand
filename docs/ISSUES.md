# 校园跑腿 · 开发问题台账

> 数据来源：`CHANGELOG.md`（R1–R65）、`docs/ITERATIONS.md`（含踩坑知识库与第 8 章）、
> `.workbuddy/memory/2026-10-*.md` 工作日志。
> 统计截止：**2026-11-01**｜**65 轮迭代**｜共登记 **58 项**产品/代码问题、**48 项**平台与工具问题。
>
> 分表原则：**表一**是「我们自己写错的东西」；**表二**是「腾讯云 / WorkBuddy / 微信平台的行为或限制」
> —— 后者不一定是 bug，但都会拦住开发，且解法通常是「绕开 + 记住边界」。

---

## 表一 · 开发过程中的问题与错误（58 项）

### A. 登录、身份与数据一致性

| # | 轮次 | 问题与根因 | 修法 / 现状 |
|---|---|---|---|
| 1 | R2 | **首页服务宫格点不进去**：进下单页前 `guard.ensureLogin()` 前置拦截，而 H5 预览拿不到真实 `wx.login`，永远登不上；且 `getSession()` reject 时未 catch，Promise 中断后无任何反馈 | 填表改纯本地，登录校验挪到「提交任务」；所有 `navigateTo` 补 `fail`；大厅失败改可点重试空态 |
| 2 | R6 | **`owner_id` 大整数精度陷阱**：形如 `2110332344891084800`，超过 JS 安全整数 2^53，客户端 `===` / `.eq()` 匹配不上；RLS 又把不匹配的行静默过滤（返回 `data: []` 而非 error） | 所有「本人数据」读写一律 `SECURITY DEFINER` + 服务端 `auth.uid()`，客户端不拼 `owner_id` |
| 3 | R7 | **取消按钮消失**：关系判定 RPC 失败 → `.then` 链直接进 `.catch`，`setData` 没执行 | 关键渲染不依赖单一 RPC，`order_relation` 加本地兜底 |
| 4 | R7 | **退出登录无效**：退出后 `tryAutoLogin` 立刻把同一账号登回来 | 写 `manualLogout` 标记；弃用 `wx.showModal`，改页内两步确认（4 秒复位） |
| 5 | R7 | **`apply.js` 里出现两个 `onLoad`**：后一个覆盖前一个，页面逻辑半失效 | 校验脚本增加「Page 方法名查重」 |
| 6 | R8 | **OUT 参数名歧义**：`RETURNS TABLE` 的列名在 PL/pgSQL 里同时是变量，体内 `SELECT is_admin INTO v_admin ... WHERE owner_id = v_uid`（未限定表名）→ `column reference "owner_id" is ambiguous`，函数首次执行即失败 | 查询起表别名、列写 `o.owner_id`；到 R56 已是第 3 次撞上，已成铁律 |
| 7 | R12 | **`node --check` 全绿但微信上传失败**：`api.js` 里 `completeOrder` 被声明两次。非严格 Script 语义下顶层函数声明是 var 作用域、允许重复；微信 CI 用 Babel 按 ES Module 解析，顶层函数声明是词法声明 → 直接编译失败 | 预检改用 `vm.SourceTextModule` 做 ESM 严格解析（`check-mp.js` 第 1 项） |
| 8 | R43 | **`RETURNS text` 的 RPC 被整类误判为报错**：PostgREST 返回裸字符串 `runner`（不是 `"runner"`），SDK 对响应体 `JSON.parse` 失败后把**原文**塞进 `error.message` → 详情页整页错误态，红条恰好显示 `runner` / `owner`（随身份变化）。同类中招 7 个函数 | 全部改 `RETURNS TABLE(result text)`；前端加 `pickText()`；身份判定单独 `catch`，不拖白屏 |
| 9 | R47 | **默认昵称「同学」绕过强制补全**：12 个用户里 9 个叫「同学」——`guard.nicknameMissing()` 只判空串，而建号时写的默认值就是「同学」，非空 ⇒ 一次都没触发过 | 维护 `DEFAULT_NICKNAMES` 清单，空串 / 全空格 / 默认值都算缺失 |

### B. 页面、样式与交互

| # | 轮次 | 问题与根因 | 修法 / 现状 |
|---|---|---|---|
| 10 | R4 | **预览环境报 `wx.showLoading is not a function`**，同一原因让 `picker-view` 三列错乱（点开直接是第三级房号） | 新增 `utils/ui.js`：所有 `wx` UI/storage 调用统一走它，`available()` 检测 + try/catch + 超时兜底；三级选择器改三个 `scroll-view` 列 |
| 11 | R4 | **`sed` 全量替换把 `ui.js` 自己内部的 `wx.*` 也替换了** → 无限递归 | 批量替换必须排除被替换文件本身 |
| 12 | R5 | **提交任务必抛错**：`buildTitle` 里 `desc` 未定义 —— 批量 `sed` 误删了声明 | 批量 sed 后函数级改动必须回归跑一遍，不能只做语法检查 |
| 13 | R16 | **输入框「隐形」**：`.field-input` 底色 `#F7F8FA` 与页面底色 `#F5F6F8` 只差 2/255；且 `.login-wrap` 的 `text-align:center` 被输入框继承，占位文字居中像标题 | 全站可见表面统一「白底 `#FFFFFF` + `2rpx solid #E3E6EB`」 |
| 14 | R17 | **输入框高度塌成 0，文字上下各切一刀**：`input` 自带约 1.4em 固定默认高度，同时设 `padding:26rpx` + `box-sizing:border-box` 时，padding 从这个固定高度里扣，content 高度被钳成 0 | 盒子几何挪到外层 `view`，`input` 只留 flex / 字号 / 颜色 |
| 15 | R20 | **标题乱码**：`encodeURIComponent(item.name)` 拼进 URL，`onLoad` 直接渲染成 `%E5%A4%A7...` | 凡从 URL 参数取来要展示的字符串，先 `decodeURIComponent` |
| 16 | R20 | **租期 chip 与上一行文字重叠**：chip 是行内 `<text>` 直接塞进 block，行内元素 padding 不参与行盒高度 | 改 `flex-wrap` 容器 + `.chip { white-space: nowrap }` |
| 17 | R23 | **反馈提交按钮无效**：写了 `ui.showLoading(...)`，而 `utils/ui.js` 导出的是 `loading`，取到 `undefined` 一调就抛异常，整段中断 | `ui.*` 只认导出名；调用前确认存在 |
| 18 | R25 | **后台待办渲染成空白行**：`wx:for` 没写 `wx:for-item`，默认变量叫 `item`，标签内却用 `{{entry.icon}}` → 全 undefined，**页面不报错**，只剩箭头 | WXML 循环必须显式 `wx:for-item`；正则扫描「wx:for → 400 字内用到的变量名」 |
| 19 | R33 | **发布被微信打回两次**：`app.wxss` 里 `.stagger > *:nth-child(n)` 用了 `*` 通配符，编译器拒收整个包。第一次把报错里的 `*` 误读成反引号，改错了方向 | 报错给了「文件:行:列」就按列去数，别肉眼猜；新增 `style-lint.js` 硬拦 `*`，警告 `+` / `~` |
| 20 | R36–R38 | **客服页消息之间空一大截，连改六轮全打偏**：一直在调 `scroll-view` 的高度（flex:1 / auto / 0 / scroll-into-view / scroll-top 大值），实测「内容 1053px，消息才 302px」。真因是 `app.wxss` 的 `.home, .mine { min-height: 100vh }` 撞上消息行 class `mine` —— **每条自己发的消息被撑到一屏高** | 类名改 `msg-mine` / `msg-peer`；全局类加 `pg-` 前缀；教训：同一处连改两轮不好，就该怀疑「问题不在这里」 |
| 21 | R41 | **FAQ 新增 / 编辑「点了没反应」**：绑定与逻辑都正常，但表单卡片在页面最底部（AI 设置 + 模型配置 + 列表之后），点完新卡片出现在屏幕下方一两屏 | `setData` 回调里量 `#faq-form` 位置再 `pageScrollTo`；量不到退化滚到底 |
| 22 | R46 | **订单卡片删除确认换行**：`.card-actions` 只有 `display:flex`，没对齐与换行策略 | `space-between` + `nowrap` + 子项 `flex:0 0 auto` |
| 23 | R46 | **待办概览每行只显示两张、右侧留空**：`calc(33.3333% - 11rpx)` 三张合计 `99.9999% - 1rpx`，余量 1rpx，真机取整放不下第三张 | 改 `calc(33.33% - 14rpx)`（三列）/ `calc(50% - 10rpx)`（两列），留 ~10rpx 余量 |
| 24 | R46 | **同一行内基线不齐**：加粗 8 字与常规 2 字的 `<text>` 行盒高度不同，只加 `line-height` 无效（`<text>` 有自己的行盒算法） | 操作项从 `<text>` 换成 `<view>`，子项固定 `line-height: 1.4` |
| 25 | R54 | **钱包页三个 UI 问题**：① `kind` 映射漏 `withdraw_refund`，英文原值压在金额上；② `loadWithdraw` 每次置 `wdLoading`，整块被替换成「加载中…」→ 页面高度骤减、滚回顶部；③ `bindtap="loadWithdraw"` 把事件对象当参数传 | 补映射 + 未映射兜底「其他」；改静默刷新 `refreshWithdraw()`；带参方法包一层无参 |
| 26 | R57 | **反馈列表时间被折断**：整行套全局 `.detail-label`（左侧写死 `180rpx`），「最新（10-30 00:28）」显示成 `00:2 8` —— 同一个全局类第二次踩 | 改专属 `fb-row / fb-main / fb-side`；页面样式用专属类覆盖全局类 |

### C. 业务逻辑与状态机

| # | 轮次 | 问题与根因 | 修法 / 现状 |
|---|---|---|---|
| 27 | R11 | **「完成订单」语义过粗**：`complete_order` 直接结算，发布方没有确认环节，钱在接单员点一下就出去 | 改为「接单员标记送达 → `waiting_confirm` → 发布方确认才结算」，整个状态机的关键转折 |
| 28 | R21 | **软删除只对操作者生效**：A 删单后 B 的列表仍在，B 点进去却是「已删除」空态；且 `add-order-delete.sql` 文件本体与线上不一致 | 改「整单生效」（不带 `user_id` 过滤）；文件与库对齐 + 幂等迁移 |
| 29 | R23 | **违规下架单凭空多出「赏金已结算」**：`buildTimeline` 的「确认完成」节点只看 `finished_at`，而 `cancel_order` 与下架都会写这个时间戳 | 节点只在 `status === 'done'` 时出现 |
| 30 | R29 | **同一条举报可重复处理、重复扣信誉分** | `admin_handle_report` 加 `status='pending'` 守卫 |
| 31 | R39 | **安全三连**：客户端存明文密码（`rememberPassword` / `autoLogin`）、`accept_order` 缺接单员资格校验、允许自己接自己的单 | 删除明文存储；`accept_order` 补认证校验 + 禁止自接自单 |
| 32 | R41 | **积分调整连点两次发两笔** → 积分翻倍 | `doAdjust` 首行加 `adjusting` 守卫 |
| 33 | R41 | **商品上下架把库存写回旧值**：用列表快照整行 upsert，用户已兑换掉的库存被覆盖 → 凭空多出可兑份数 | 先拉最新行，只改 `enabled`；加 `actingId` 防重 |
| 34 | R41 | **报价留空当 0 元提交**（`Number('') === 0`）；**`buildTitle` 拿 `description` 前 20 字当标题**，把取餐码 / 姓名尾号公开到大厅 | 先判空串再判 `>0`；标题只由「服务名 + 去向」组成，描述只在详情给参与者 |
| 35 | R41 | **大厅 `quickAccept` 无并发锁**，连点两张卡可并发接两单 | 加 `_accepting` 标记，成功失败都复位 |
| 36 | R44 | **手机号可被「跳过发码直接声明」**（残余风险）：OTP 由 auth provider 校验，验证后会话切成手机号身份，SDK 没有「绑定手机号」接口，恶意客户端可直调 RPC 声明号码 | 当前靠格式 + 全站唯一 + 24 小时防抖把影响限制在「占用号码」；R52 起改服务端换号 + 签名票据 |
| 37 | R45 | **图片归属触发器误伤接单员**：`assert_order_assets_owned` 把 `images`（发布方的任务图）与 `deliver_images`（接单员的佐证）合并校验，接单员一更新这行，`NEW.images` 仍是别人的图 → 判定越权、整笔回滚。表现为「放弃接单 / 提交送达都报图片不属于当前账号」 | `INSERT` 两列都校验；`UPDATE` 用 `IS DISTINCT FROM` 只校验真正改动的那列 |
| 38 | R59 | **「提现管理」后台页与实际行为相反**：R54 后提现已提交即自动打款，页面却写着「人工转账后标记结果」，两个按钮一次都没走过 | 删页面，保留 `admin_finish_withdrawal` RPC 与补转链路 |
| 39 | R60 | **取消订单一分钱不退**：`cancel_order` 只改状态；而发单是「先付钱才进大厅」，待接单时取消，钱留在商户号、用户没有任何入口能拿回 | 引入 `cancel_requested`（协商）/ `canceling`（退款中）；全额退、已接单需接单员同意；`out_refund_no = RF+订单号` 幂等 |
| 40 | R63 | **券核销后取消不回滚**：下单即把 `point_redemptions` 置 `used`，取消 / 退款路径一处都没放回，用户券永久蒸发 | `svc_rollback_order_coupon()` 铺进 6 个函数的 8 个终态出口；微信单只在退款 SUCCESS 还券 |
| 41 | R63 | **管理端没有能处理订单的接口**：30 多个 `admin_*` 里没有一个能改订单状态或动退款，退款回调丢了只能改库 | 补 `admin_list_orders` / `admin_order_detail` / `admin_force_cancel_order` + `pages/admin/orders` |
| 42 | R63 | **`syncRefund` 前端零调用**：R60 写好但一处没调，回调一丢订单永久卡 `canceling`，而钱早退了 | 详情页进页面自动补查（2 分钟节流）+ 手动「刷新退款进度」 |
| 43 | R63 | **全仓没有任何定时任务**：超时未付单永不关闭、滞留退款无人补查 | `pay-create` 挂 timer（`0 */10 * * * * *`），跑关单 + 补查；判定强制 `!isHttp &&` 防伪造 |
| 44 | R63 | **`profiles.owner_id` 无唯一索引**：并发首登能插两行 profile，之后 `balance` 双写、扣款只扣一行 | 补唯一索引；重复行不删，`owner_id` 改成「原值`#dup<id>`」保留数据 |
| 45 | R64 | **三个状态永久卡住、钱跟着卡**：`waiting_confirm`（发布方不点确认，钱永远在平台）、`cancel_requested`（接单员不回应，双方都动不了）、`withdraw_requests.pending`（转账没发起，钱扣了却「处理中」） | 补三个出口：`svc_auto_confirm_orders(72)`、`svc_expire_cancel_requests(24)`、`withdraw-api` cron 补转 |

### D. 支付、结算与资金

| # | 轮次 | 问题与根因 | 修法 / 现状 |
|---|---|---|---|
| 46 | R52 | **前端读旧库、回调写新库**：迁库后前端仍连 WorkBuddy Cloud，微信回调改的是新库 `orders.pay_status`，两条链路根本不在一起 | 前端整体切 CloudBase（`utils/tcb.js` + `svc_rpc` 代持身份），WorkBuddy Cloud 退役 |
| 47 | R53 | **图片上传报 `EXCEED_MAX_PAYLOAD_SIZE`**：网关请求体上限 102400 字节，而图片 base64 塞在 `args` 里，一张手机照片 1–3 MB 必挂 | 三道线（压缩 420KB / 整包 64KB / 单片 80KB）+ 分片上传；被拒自动降 48KB 重试 |
| 48 | R53 | **第一版分片「修了个寂寞」**：凭印象按「`wx.cloud.callFunction` 入参约 1MB」把片定成 400KB，比真实上限大 4 倍，每片都必然 413 | 通道上限必须实测（二分探测确认 102400 字节），不能靠印象估 |
| 49 | R54 | **提现 10 元后一直「待处理」**：两条叠在一起 —— ① `withdraw-api` 的 `create` 只建单，打款要管理员在后台点；② 云托管 011 版加了 secret 硬校验，而云函数**没配 `PAY_WEBHOOK_SECRET`**，转发带空串 → `FORBIDDEN` | 抽 `doTransfer()` 让自动打款与重试共用；`create` 成功后直接打款；密钥改为运行时读 `pay_settings.webhook_secret`，不在控制台之间搬运 |
| 50 | R61 | **「退款退到余额」既违规又开套现通道**：运营规范 2.14.6 要求资金原路退回；「退款进余额 + 余额可提现」等于信用卡套现。且商家转账零手续费，退余额再提现成本一样 | 明确不做；只做「余额支付」（少一次退款），退款一律原路 |
| 51 | R62 | **确认完成发双份赏金**：`confirm_order_done` 加一次余额，`trg_order_notify` 的 `waiting_confirm → done` 分支又加一次。赏金 10 元到账 20 元、流水 2 条，从 R5 一直存在 | 钱只在一个地方动，触发器降级为只发通知；函数用 `ROW_COUNT` 幂等 + `pay_status='paid'` 校验 |
| 52 | R62 | **微信 + 余额双付**：回调晚到时用户又点余额支付，两笔都成功，`mark_order_paid` 只认 `pay_status='paid'` 就返回幂等，钱收了不记账 | 回调侧返回 `DUPLICATE_PAY` + 写 `dup_txn_id`，自动原路退（`RD+订单号`）；余额侧遇已有交易号返回 `already_wxpay`，分文不扣 |
| 53 | R62 | **券补贴看不见**：用券后用户实付变少、接单员仍按赏金结算（产品定为平台补贴），但库里没有字段记这笔成本 | 新增 `orders.platform_subsidy` |
| 54 | R62 | **抽成函数从定义起零调用**：`calc_settle_amount()` 没人调，费率配了白配、平台收入为 0 | 结算接上它，读 `pay_settings.commission_rate`（0.05）；后台 `admin/settle` 可改 |
| 55 | R64 | **提现卡 50 小时的真因不是回调丢失**：云托管 `transfer-svc` 的 `MinNum=0`、`ScaleStatus=zero`，常态 0 实例，每次都要冷启动；而 `withdraw-api` 里 `httpsJson`（调云托管那一跳）超时写死 10s、函数 Timeout 20s | `withdraw-api` 的 `HTTP_TIMEOUT` 改 25s（`SVC_TIMEOUT_MS` 可覆盖）/ 函数 60s；⚠️ `transfer-svc` 内部调微信的 `httpsJson` 仍是 12s 写死，别把两者混谈；补 HTTP 状态码判定；提现 #20 已补转成功 |
| 56 | R64 | **提现并发窗口**：`svc_create_withdraw` 的「是否已有 pending/processing」检查排在 `profiles ... FOR UPDATE` **之前**，两个请求能同时通过检查各插一笔 | 检查挪到行锁之后 |
| 57 | R64 | **退款「只查不发」**：`doSync` 遇 `REFUND_NOT_EXIST` 就结束；若当初 `doRefund` 就失败（网络错 / 余额不足），订单永远卡 `canceling` | `svc_list_stuck_refunds` 补 `pay_txn_id` / `refund_amount` / `refund_error`，404 时 cron 直接补发 |
| 58 | R65 | **下单金额由调用方说了算**：`pay-create` 直接把 `payload.amount` 发给微信。不会「1 分钱买 20 元服务」（落库会重算比对），但会变成**「钱收了、单没开通」** —— 微信真扣款，订单永远 `unpaid`，只能人工退 | 新增 `svc_order_pay_amount(order_id, uid)` 取库里的应付分，四种情况拒绝；**发给微信的必须是 `serverFen`**，客户端 amount 只用于比对 |

---

## 表二 · 腾讯云 / WorkBuddy / 微信平台相关（48 项）

> 这一栏不一定是「平台的 bug」，很多是**规则与限制**。列出来是因为它们每一个都真实拦住过开发，
> 而且下次换项目还会遇到。

### A. 腾讯云 CloudBase

| # | 轮次 | 问题与根因 | 影响与解法 |
|---|---|---|---|
| 1 | R10/R48 | **开通 CloudBase 需腾讯云账号实名认证**，未实名时创建失败且只在控制台右上角小字提示 | 先确认实名状态再引导开通 |
| 2 | R48 | **微信「测试号」不支持云开发**：开发者工具里「云开发」按钮是灰的 | 必须用正式注册的小程序账号 |
| 3 | R48 | **开发者工具看不到环境 ≠ 故障**：工具内云开发控制台用「小程序绑定的腾讯云账号」登录，两边账号不一致就不显示；CloudBase 连接器同理，必须用「微信公众平台」登录 | 核对账号 → 「设置 → 环境设置 → 使用已有腾讯云环境」导入；一个小程序只能绑一个腾讯云账号 |
| 4 | R49–R65 | **CloudBase MCP 会掉线**：工具报不可用、`db_exec_sql` 消失 | `auth(start_auth, device)` 出设备码让用户浏览器授权（10 分钟），再 `auth(status)` 确认 |
| 5 | R39/R48 | **MCP 一次只能执行一条 SQL**：多条报 `42601 cannot insert multiple commands into a prepared statement` | 整份迁移拆成单条，包进一个 `DO $do$ BEGIN EXECUTE $q1$…$q1$; END $do$;`（DO 本身算一条，且原子执行） |
| 6 | R48 | **`applyMigration` 必须内联传 SQL**，只给路径报 `SQL_REQUIRED`；且本地同名文件内容要**逐字符一致**，否则 `LOCAL_MIGRATION_FILE_MISMATCH`（fail-closed） | 注释也要一致；不一致就换版本号重来 |
| 7 | R48 | **`migrationName` 正则 `^[a-z][a-z_]*$` 不允许数字**：`round4` 直接失败 | 改 `round_four` 这类纯字母命名 |
| 8 | R48 | **`DO` 块里不要写 `--` 注释**：工具会把语句截坏，报 `42601 syntax error at end of input` | 说明写在 `DO` 块外面 |
| 9 | R53 | **网关 HTTP 访问服务请求体上限 102400 字节（100KB）**，超了直接回 `HTTP 413` + `EXCEED_MAX_PAYLOAD_SIZE` | 客户端必须分片；上限要实测，不能按「云函数 1MB」的印象估 |
| 10 | R64/R65 | **网关 5xx 返回的是 HTML 或空串**，既无 `ok` 也无 `code`；只判 `catch` 会把 503 记成 `ok:true`，日志永远看不出问题 | HTTP 调用必须判状态码；`utils/tcb.js` 把 5xx 归为 `_network` 并切兜底通道 |
| 11 | R64 | **云托管 `transfer-svc` 的 `MinNum=0` / `ScaleStatus=zero`**：常态 0 实例，每次请求冷启动 > 10 秒，而客户端超时 10s、函数 Timeout 20s | 超时提到 25s / 函数 60s（只能容忍）；根治要后台把 `MinNum` 设 1（有常驻费用） |
| 12 | R64 | **缩容到 0 时网关返回 nginx 503 HTML 页**，不是 JSON | 见第 10 条：认状态码 + 原文记日志 |
| 13 | R49 | **新建云函数无法继承商户私钥**：CloudBase 环境变量在控制台只有打码值，新函数配不进 `apiclient_key.pem` | 要私钥的能力只能并进已有函数（`pay-create` / `pay-notify` 加 action 分派） |
| 14 | R54 | **`updateFunctionCode` 不能传 `envVariables`**，传了也不会落到函数配置上 | 单独调 `updateFunctionConfig` |
| 15 | R52 | **`updateFunctionConfig` 会覆盖丢失已有变量**：`WXPAY_NOTIFY_URL` 被冲掉，支付回调地址变空 | 改配置前列出全部变量，改完立刻回读核对 |
| 16 | R54 | **`getFunctionDetail` 的环境变量值打码成 `***`** | 只能确认「有没有」，不能读出值；值要用户自己保管 |
| 17 | R65 | **`updateFunctionCode` 返回 success 后，第一次调用可能仍打到旧实例**：实测返回老分支的 `NO_OPENID`，第二次才生效 | 部署后至少打两次，或等几秒再验 |
| 18 | R63 | **MCP `invokeFunction` 把参数序列化成 JSON 字符串传**：入口不解析则 `event.Type` 读不到，cron 会掉进下单分支报 `NO_OPENID` | 入口先 `typeof event === 'string' ? JSON.parse(event) : event` |
| 19 | R54 | **环境未开日志服务，云函数日志查不到** | 只能靠业务表状态变化做端到端验证 |
| 20 | R57 | **`genie-baas` MCP 连的是已退役旧库**（31 表 / 129 函数 / 7 触发器），拿它核对线上会误判「少 6 张表」 | 线上库数按迁移脚本去重计数，或换 `cloudbase` MCP |
| 21 | R57 | **CloudBase AI 接口没有模型列表路由**：`/models`、`/v1/models` 全 403/404（`/models` 被当成模型名 → `AI_MODEL_NOT_SUPPORTED`） | 改内置静态目录；只有自定义通道才探 `/models` |
| 22 | R57 | **内置 AI 通道只有 `hy3` / `hy3-preview` 可用**，deepseek / glm / kimi / qwen / minimax 全 403（要买 Token 资源包）；且 `hy3` 是推理模型，`max_tokens` 太小只有 `reasoning_content` 没正文 | 兜下限 300，空正文报 `AI_EMPTY`；扩展走 `TCB_AI_MODELS` |
| 23 | R30/R57 | **小程序把云开发资源授权给服务商（WorkBuddy 托管）后，管理员自己就用不了云开发**：报 `-601034`，面板打不开、`tcb-proxy` 传不上去 | 平台规则，两者互斥；主通道必须走「网关直连 + request 合法域名」，`wx.cloud.init` 必须 try/catch |
| 24 | R57 | **`tcb-proxy` 在小程序自有环境 `baozi-xxx`，MCP 账号下只有 `ceshi`** | MCP 推不上去，只能由用户在微信开发者工具里手动上传一次 |
| 25 | R49 | **两套「云开发」不是一回事**：`wx.cloud` 只认微信开发者工具里开通的环境；腾讯云侧建的 PG 环境在真机上必然 `-601034` | 数据与业务函数全走 HTTPS 网关；`wx.cloud` 只做免域名兜底 |
| 26 | R48 | **CloudBase PG 没有 `pgcrypto`**：`gen_random_bytes()` 不存在（42883） | 用内置 `sha256(random()::text \|\| clock_timestamp()::text \|\| 业务值)` |
| 27 | R48 | **`CREATE OR REPLACE FUNCTION` 改不了返回类型（42P13）也改不了签名**（会变重载）；且 `DROP` 重建后 **GRANT 要重跑**（权限绑 oid） | 先 DROP → CREATE → 重跑 GRANT |
| 28 | R48 | **「新库 RLS 策略只剩 1 条」被误判成灾难**：其实原库本来就只给 5 张表客户端直连、其余 `REVOKE ALL` | 判断权限缺失前先查 `pg_policies` + `role_table_grants` |

### B. WorkBuddy（腾讯）

| # | 轮次 | 问题与根因 | 影响与解法 |
|---|---|---|---|
| 29 | R48 | **WorkBuddy Cloud 没有云函数、也不对外提供写库凭据**，而微信支付回调必须由服务端改订单状态 | 整套迁到 CloudBase（R48），前端 R52 跟着切 |
| 30 | R18 | **WorkBuddy 对象存储在小程序端是单向的（能写不能读）**：证书照片三条读取通道全 404 `STORAGE_OBJECT_NOT_FOUND`，而 MCP 列存储对象确实在（31001 字节、路径逐字符一致），`storage.objects.version` 为空串 | 平台侧故障；图片改存 PostgreSQL `media_assets`（小图 ≤1.9MB 反而更可靠，还自带行级权限） |
| 31 | R14 | **WorkBuddy Cloud SDK 的 `createMiniProgramFetch()` 只实现文本请求**，body 非字符串直接抛错；`cloud.storage.upload()` 走 ArrayBuffer 分支 → 必抛 `暂不支持非字符串 body` | 绕开 SDK，用 `wx.request` 原生二进制直传 `/.cloud/storage/object/...`（已真机验证） |
| 32 | R43 | **WorkBuddy Cloud SDK 的 `processResponse` 对响应体 `JSON.parse`，失败时把响应体原文当 `error.message`** | 直接导致 `RETURNS text` 全类被误判（表一 #8）；RPC 返回类型必须结构化 |
| 33 | R49 | **服务器域名被 WorkBuddy 托管，改不了** | `project.config.json` 的 `urlCheck:false` 让预览生效；正式版要在微信后台配 request 合法域名 |
| 34 | R13 | **WorkBuddy 试用版是「试用小程序」**：14 天有效、最多 15 人体验、**没有成员管理界面**、**不能转正式版**；授权是拉取式（扫码 → 申请 → 创建者在服务通知里批准） | 只当验证通道；正式发版必须走企业主体注册，R47 已切 `wxaab192c68e403292` |
| 35 | R12 | **微信「上传失败，请稍后重试」是洗过的文案**，真实报错只在 WorkBuddy 前端日志里 | 搜 `C:\Users\...\.workbuddy\logs\renderer.log` 的 `[miniprogram:publish] publish failed`，看 `raw=` 字段；微信 CI 每次只报第一个错 |
| 36 | R30/R57 | **WorkBuddy 会话中断 / MCP 断连**：工具不可用，SQL 只能落盘等重连 | 迁移脚本必须先落文件再执行，不能只在对话里跑 |
| 37 | R64 | **WorkBuddy 侧的工程约束**：`packOptions.ignore` 曾漏掉 `README.md` / `CHANGELOG.md`，132 KB 纯 markdown 跟着上传包走（端上一行读不到） | 补进 ignore，1.03 → 0.91 MB；文档类文件一律排除 |

### C. 微信平台与微信支付（腾讯）

| # | 轮次 | 问题与根因 | 影响与解法 |
|---|---|---|---|
| 38 | R50 | **商户是「微信支付公钥」模式，没有平台证书**：`/v3/certificates` 直接 404 | 验签改用公钥模式，不能照抄「下载平台证书」的旧文档 |
| 39 | R51 | **商家转账校验调用方 IP，而云函数出口 IP 每次冷启动都变**（实测连调 5 次 5 个不同 IP） | 转账逻辑搬云托管并开「固定访问公网出口 IP」（`122.51.67.142`），填进商户平台白名单 |
| 40 | R51 | **商家转账场景报备四层错**：① `此IP地址不允许调用接口`；② `未传入完整且对应的转账场景报备信息`；③ `暂不支持展示当前传入的用户收款感知`；④ `你尚未获取该转账场景`（商户号只开了 1005，代码按 1000 传） | 加 IP 白名单；1005 要传「岗位类型 / 报酬说明」；`user_recv_perception` 默认不传；场景号以商户号实际开通为准 |
| 41 | R51 | **微信两个账户不可互转**：基本账户收款（可提现/退款），运营账户付款专用（只能银行卡充值）；运营账户余额不足时商家转账报 `NOT_ENOUGH`；自动提现**留存额必须设**，否则退款报 `NOT_ENOUGH` | 运营账户要留余额；留存额在商户平台配置，代码管不了 |
| 42 | R56 | **手机号快速验证组件只对非个人主体且已认证的小程序开放**，2023-08-28 起约 0.03 元/次，且 `code` 必须由服务端用 `access_token` 换 | 转企业主体后才可用；R56 已接，换到的号码不返回客户端 |
| 43 | R55 | **腾讯云 SMS 的 5 个环境变量一直没配**（`SMS_SECRET_ID` / `SMS_SECRET_KEY` / `SMS_SDK_APP_ID` / `SMS_TEMPLATE_ID` / `SMS_SIGN_NAME`），`smsConfigured()` 恒假，发码在生成之前就被拒 | 短信降级路径实际不可用；绑手机号只能走微信一键取号（R56） |
| 44 | R32 | **微信 CI 每次只报第一个错**，修完继续冒下一个 | 一次只改一个，别指望一次修全 |
| 45 | R33 | **WXSS 不支持通配符选择器**（`*` 会让编译器拒收**整个包**），`+` / `~` / `:nth-child` / `:not` 也不稳 | 本地必须有 `style-lint` 闸门；报错按「文件:行:列」定位 |
| 46 | R48+ | **微信开发者工具单例锁会导致 CLI / 连接器授权超时**；授权时要弹「请求连接 CLI」「MCP 客户端授权」两个确认框 | 先完全退出开发者工具再授权；发起后轮询，不要干等 |
| 47 | R47 | **企业主体变更不可逆**：个人 → 企业要走主体变更，需公证书 + 300 元审核费 + 约 7 个工作日 | 主体选定前先定「卖实物还是虚拟商品」，再决定个人/企业 |
| 48 | R55 | **短信模板审核对个人主体严、周期长** | 优先用微信取号；短信只作降级 |

---

## 三条贯穿全程的规律

1. **「失败只剩一句通用文案」是最高频的一类 bug**（R2 宫格没反应、R6 退出静默、R14 上传只有 toast、
   R15 证件加载无细节、R21 删除后列表与详情对不上账）。
   通用解法：结果对象带 `error` 一路透传；页面内联错误条 + toast 双保险；不能操作时把按钮换成说明文案。
2. **静默失败比报错更危险**：RLS 对 DELETE 静默过滤（删 0 行仍返回成功）、无 UPDATE 策略时影响 0 行、
   `wx:for` 缺 `item` 渲染空白、`RETURNS text` 被当错误吞掉、`done()` 漏 `ok` 把成功当失败。
   → 断言要验「结果对不对」，不能只验「有没有抛异常」。
3. **平台限制必须实测，不能靠印象**：网关 100KB（不是 1MB）、云托管冷启动 >10s、`/models` 不存在、
   对象存储单向、`migrationName` 不许数字。每一次「凭印象」都导致返工，R53 甚至整版分片白做。
