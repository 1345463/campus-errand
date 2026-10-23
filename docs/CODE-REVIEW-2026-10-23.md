# 校园跑腿 · 全量代码审阅报告

> 审阅时间：2026-10-23 21:35 ｜ 代码版本：R38（`cc97d5c`）
> 审阅范围：37 个页面 + 15 个 utils + 22 个 SQL 脚本，共 15,417 行 JS
> 基础校验：四件套 + UI 冒烟全绿（58 JS / 31 wxss / 39 wxml，上传包 1.32 MB / 2.00 MB）

---

## 总体结论

**代码质量整体高于同类个人项目**：ES5 纪律零违规、WXML 循环规范、错误处理有意识、踩坑文档完备、
不可逆操作有二次确认、图片三通道设计清晰、RPC 参数与 SQL 逐一对得上。

**但存在 5 个必须修的安全/数据问题**，其中 1 个（图片越权读取）可让任意登录用户读到全站证件照，
另 1 个（接单权限）可绕过认证直接接单。这两条建议在下次发版前修掉。

| 严重度 | 数量 | 说明 |
|---|---|---|
| 🔴 P0 安全/数据 | 5 | 必须在下次发版前修 |
| 🟠 P1 功能/体验 | 12 | 影响可用性，建议尽快修 |
| 🟡 P2 代码质量 | 15+ | 可排期清理 |
| 📄 文档 | 2 | 已在本次审阅中修正 |

---

## 🔴 P0 · 安全与数据问题

### P0-1 图片越权读取：任何人可遍历全站证件照

**这是本次审阅最严重的发现。**

三处叠加形成完整利用链：

| 环节 | 位置 | 问题 |
|---|---|---|
| ① 建单不校验图片归属 | `sql/add-round7.sql:172` | `create_order` 直接 `coalesce(p_images, array[]::text[])` 落库，不验证这些 `asset:<id>` 是不是调用者上传的 |
| ② 送达不校验归属 | `sql/add-round6.sql:234` | `complete_order` 只校验格式 `^asset:[0-9]+$`，同样不验证归属 |
| ③ 读图只校验"挂在单上" | `sql/add-round6.sql:605` | `get_order_asset` 的两个条件：我是这单参与方 + 路径在 `orders.images`/`deliver_images` 里 |

**利用链**：任意登录用户 → `create_order(p_images: ['asset:123'])` → `get_order_asset(123, 我的单)`
→ 两个条件都满足 → 拿到 123 号图的字节。`media_assets.id` 是 `bigserial`，可顺序枚举。

**影响**：`media_assets` 里有接单员的身份证、学生证照片（`runner_applications` 的证件照）。
虽然入库时做了脱敏（身份证只存前 6 + 后 4），但学生证照片是完整的。

**修法**（服务端，三步一起改）：
```sql
-- 1. get_order_asset 加归属校验
RETURN QUERY SELECT ma.id, ma.mime, ma.data FROM public.media_assets ma
 WHERE ma.id = p_asset_id
   AND ma.owner_id IN (v_row.owner_id, COALESCE(v_row.runner_id, ''));

-- 2. create_order 落库前校验每个 asset:<id> 的 owner_id = auth.uid()
-- 3. complete_order 同上
```

---

### P0-2 `accept_order` 缺认证校验，且可自接自单

**位置**：`sql/add-round4.sql:118-122`

```sql
UPDATE public.orders o
   SET runner_id = v_runner, runner_name = v_name, status = 'accepted', accepted_at = now()
 WHERE o.id = p_order_id AND o.status = 'pending' AND o.runner_id IS NULL
RETURNING * INTO v_row;
```

**缺两道校验**：
1. 没有 `is_certified_runner()` —— 任何登录账号都能接单，绕过「成为接单员」流程
2. 没有 `o.owner_id <> v_runner` —— 发布者可以接自己的单，用来刷完成单数和互评信誉分

前端 `pages/order/detail.js:585-590` 有 `profile.role !== 'runner'` 的判断，
但那是**客户端判断，可绕过**。`pages/hall/index.js` 的 `list_hall_orders` 也不过滤 `owner_id`。

**修法**：
```sql
-- 函数开头补认证校验
IF NOT EXISTS (
  SELECT 1 FROM public.profiles p
   WHERE p.owner_id = v_runner
     AND (p.cert_status = 'approved' OR p.role = 'runner')
) THEN
  RAISE EXCEPTION '请先完成接单员认证';
END IF;

-- UPDATE 的 WHERE 补一行
   AND o.owner_id <> v_runner
```

---

### P0-3 `completeOrder` 前端硬拦，灰度回滚失效

**位置**：`utils/api.js:429-432`

```js
function completeOrder(id, images) {
  if (!images || !images.length) {
    return Promise.reject(new Error('请先上传送达佐证照片'))
  }
```

服务端 `sql/add-round6.sql:226` 的判断是：
```sql
IF v_need AND COALESCE(array_length(v_imgs, 1), 0) < 1 THEN
  RAISE EXCEPTION '请先上传至少一张送达佐证照片';
```
`v_need` 来自 `feature_flags.deliver_photo`。**开关关闭时服务端允许 0 张**，
但前端这层硬拦没同步放宽。

**后果**：超管关掉 `deliver_photo` 想回滚（比如照片上传出故障），
`pages/order/detail.js:526-528` 传空数组 → 前端直接 reject →
**所有 `accepted` 状态的单彻底卡死**，只能等 48 小时走核查流程。

**修法**：前端只校验数组类型和长度上限，是否必填交给服务端开关判定。

---

### P0-4 `getOrder` 直读 `orders` 全字段，绕过脱敏

**位置**：`utils/api.js:392-396`

```js
async function getOrder(id) {
  const result = await cloud.database.from('orders').select('*').eq('id', id).maybeSingle()
```

`orders_read_all` 策略（`sql/add-round5.sql:208-216`）允许**任何已认证接单员** SELECT 全表。
所以任何接单员拿任意 orderId 就能读到 `contact`（手机/微信）、`images`、`deliver_images`（取餐码截图）。

项目为此专门写了 `get_order_detail`（`sql/add-round6.sql:300-304`）做脱敏：
```sql
IF NOT v_allow THEN
  v_row.images := ARRAY[]::text[];
  v_row.deliver_images := ARRAY[]::text[];
  v_row.contact := '';
```

**当前只有一处调用**（`pages/order/review.js:148`），且该页是参与者页面，所以**暂时没造成泄露**。
但 api 层暴露了一个无脱敏接口，任何新页面拿来用就是全量泄露。

**修法**：删掉 `getOrder`，统一走 `getOrderDetail`；或至少限定 select 字段。

---

### P0-5 明文密码落本地存储

**位置**：`utils/config.js:30-34` + `pages/mine/index.js:164-168`

```js
rememberPassword: true,
autoLogin: true,
presetAccount: { phone: '', password: '' },
```
```js
ui.setStorage('savedAccount', { phone: phone, password: password })
```

小程序 storage 在同设备上可被调试/备份读取，等于把账号密码明文写在手机上。
注释里写"上线前必须改回 false"，但默认值仍是 `true`。

**修法**：删掉 `rememberPassword` 这条路径，改用 `wx.login`（`api.login` 已有）
或服务端下发的短时 token 续期；`presetAccount` 直接删除。

---

## 🟠 P1 · 功能与体验问题

### P1-1 调用不存在的方法，上传失败无任何提示

**位置**：`pages/order/detail.js:575`

```js
.catch(function (error) {
  ui.hideLoading()
  page.toastError(error)   // ← Page 上没有 toastError 方法
})
```

本页所有其它分支都用 `page.fail(error)`（594/629/701 行）或 `guard.toastError`。
这里拼错后，接单员拍照上传失败只会看到 loading 消失，既无 toast 也无错误文案，
日志里是一条 unhandled rejection。

**修法**：改成 `page.fail(error)`。

---

### P1-2 状态筛选在前端做，分页 offset 用过滤后条数

**位置**：`pages/orders/list.js:183` + `232`

```js
.filter(function (item) {
  return page.data.status === 'all' || item.status === page.data.status
})
```
```js
.fetchPage(page.data.list.length)   // 已加载的是"过滤后"的条数，不是已消费的偏移
```

`list_my_orders` 服务端不接 status 参数。举例：选「已完成」，第 1 页 20 条里只有 3 条 done
→ `list.length=3`、`hasMore=true` → 上拉请求 `offset=3` → 服务端返回第 4~23 条，
其中第 4~20 条又被过滤一次，那 3 条 done 可能再次命中 → **列表出现重复项**。

极端情况：第 1 页一条都不匹配 → `list.length` 恒为 0 → 上拉永远请求 `offset=0`
→ **无限拉同一页**。

**修法**：另存 `rawCount`（已拉取的原始行数）用于 offset；`hasMore` 用服务端总数；
更彻底的做法是把 status 下推到 RPC（这正是被回退的 PR 里 `list_my_orders_v2` 做的事）。

---

### P1-3 `goBack` 的 try/catch 兜底无效

**位置**：`pages/order/review.js:300-307`

```js
goBack: function () {
  try {
    wx.navigateBack()
  } catch (e) {
    wx.switchTab({ url: '/pages/orders/list' })
  }
},
```

`wx.navigateBack` 在页面栈只有一页（分享卡片/扫码直达）时走的是 `fail` **回调**，
不会同步抛异常，`catch` 永远不执行 —— 用户点「返回」毫无反应。

**修法**：
```js
wx.navigateBack({ fail: function () { wx.switchTab({ url: '/pages/orders/list' }) } })
```

---

### P1-4 举报模块权限键三处不一致

| 位置 | 判断 | 结果 |
|---|---|---|
| `pages/admin/dashboard.js:13` | `perm: 'can_support'` | 客服看到「待处理举报」卡片 |
| `pages/admin/dashboard.js:28` | `check: 'support'` | 客服看到入口，审核员看不到 |
| `pages/admin/reports.js:61` | `profile.is_admin` | 任何管理员都能进（粗判） |
| `sql/add-round7.sql:387` | `admin_has_perm('review')` | 只有审核员能处理 |

**后果**：客服能看到入口和待处理数字，点进去能读列表，但每次「判定成立并下架」都报 `admin only`；
真正的审核员（review）在工作台看不到这个入口。

**修法**：统一到 `review` 或 `support`，三处一起改。

---

### P1-5 `admin_dashboard_stats` 白名单漏 `dispatch`

**位置**：`sql/add-round4.sql:538-556`

声明的变量只有 `v_review / v_rental / v_support / v_settle / v_hr / v_print / v_super`，
**没有 `v_dispatch`**；白名单判断也漏了 dispatch。

**后果**：只有 `dispatch` 权限（第八级）的人，`perms.anyAdmin()` 为 true → 放行到工作台 →
RPC 抛「没有后台权限」→ 页面把卡片和入口一起清空。工作台是后台唯一入口，
所以**第八级权限形同虚设**。

**修法**：SQL 补 `v_dispatch`，返回值加 `can_dispatch`；前端 `CARD_DEFS` 补对应卡片。

---

### P1-6 工作台入口被自己的开关挡死

**位置**：`pages/admin/dashboard.js:131` + `pages/mine/index.wxml:323`

```xml
<view wx:if="{{flagsOn.admin_dashboard && isAnyAdmin}}" ... bindtap="goDashboard">
```

超管在灰度页关掉「管理员工作台」→ 离开页面后入口消失 →
**再没有任何路径回到 `pages/admin/flags`**，只能改库。

`flags` / `banners` / `faq` 三个配置页本身没挂自己的开关（这点做对了），
但它们的**唯一入口**挂在 `admin_dashboard` 上，等于间接被挡死。

**修法**：`mine/index.wxml` 的入口改为只看 `isAnyAdmin`（不受 admin_dashboard 约束）。

---

### P1-7 积分调整无二次确认 + 无防重

**位置**：`pages/admin/points.js:442-483`

`doAdjust` 入口没有 `if (page.data.adjusting) return`，按钮的 `.disabled` 只改透明度不拦点击。
网络慢时连点两次 = 两笔 `admin_adjust_points`，**积分直接翻倍**，且都有独立流水，
事后只能手工冲正。

**修法**：`doAdjust` 第一行加守卫，并对正常加减也走一次 `ui.confirm`（文案带 +120 / -50 和当前余额）。

---

### P1-8 商品上下架用旧快照整行 upsert，库存被写回

**位置**：`pages/admin/points.js:335-357`

```js
api.adminUpsertPointGoods({ id: id, ..., stock: row.stock })  // row 来自列表快照
```

服务端是全字段覆盖（`sql/add-round6.sql:377`）。管理员开着页面 10 分钟（期间用户兑换掉 5 份），
点一次「下架」，库存就变回旧数字 —— **凭空多出 5 份可兑换库存**。

**修法**：服务端加 `admin_set_point_goods_enabled(id, enabled)` 只改一列。

---

### P1-9 生产页面留着「生成测试申请」

**位置**：`pages/admin/review.js:258-280`

```js
makeDemo: function () {
  ...
  api.insertDemoApplication('测试同学')
```

没有挂任何 feature_flag，任何 review 权限的人都能点，
`runner_applications` 里会出现「测试同学」的待审核记录，审核列表和统计都被污染。

**修法**：删除，或挂默认 false 的 `dev_tools` 开关。

---

### P1-10 报价留空会被当成 0 元提交

**位置**：`pages/admin/rental.js:153-165`

```js
const price = Number(String(page.data.price || '').trim())   // Number('') === 0
if (!isFinite(price) || price < 0) { ... }                   // 0 通过校验
```

管理员清空输入框直接点保存 → 写入日租金 0，用户端按 0 元生成工单。

**修法**：`if (raw === '' || !isFinite(price) || price <= 0)`，并补两位小数校验。

---

### P1-11 `getErrorMessage` 不认识 SDK 的错误类型

**位置**：`utils/api.js:10-17`

SDK 明确提供了 `kind` 契约（`unauthenticated / permission-denied / network / backend-unavailable / rate-limited`），
并注明"message 只供展示，不要去 match message 文本"—— 第 14 行正好在 match 文本。

**后果**：
- token 失效 → 用户看到 `no active session` / `JWT expired`，且不会跳登录
- 断网 → 显示 `request:fail timeout` 这类原始串
- `requireSession` 设的 `error.needLogin` 信号**全项目没有一处读取**

**修法**：按 `kind` 映射成中文文案；`guard.toastError` 接住 `needLogin` 引导登录。

---

### P1-12 AI 每日配额只在客户端

**位置**：`pages/mine/support.js:43-51` + `utils/api.js:1442-1486`

`bumpQuota()` 把次数写在本地 storage，`llmChat` 不经过任何配额 RPC。
任何人（改 storage、直接调 `llmChat`）都能无限调用模型，直接烧 Token 成本。

**修法**：加 `ai_consume_quota()` SECURITY DEFINER 函数，`llmChat` 调用前先原子自增并判上限。
（这是被回退的 PR 里 `begin_support_ai` / `finish_support_ai` 做的事。）

---

## 🟡 P2 · 代码质量问题

| # | 位置 | 问题 |
|---|---|---|
| 1 | `utils/api.js:7-8` | `LIST_FIELDS` 是死代码，从未被使用，注释却声称"列表层已排除联系方式" |
| 2 | `utils/upload.js:230-289` | `postBinary` / `postMultipart` / `readBuffer` 约 100 行死代码 |
| 3 | `utils/moderation.js:210` | 缓存判断 `cached.index.length` 恒为 `undefined`（index 是 `{block, allow}`）→ 每次重发请求 |
| 4 | `utils/moderation.js:99-108` | 白名单摘除顺序与 SQL 不一致（JS 按长度降序，SQL 无 ORDER BY）→ 可能"前端放过、服务端拒绝" |
| 5 | `utils/upload.js:401-502` | 本地临时文件只写不删，`USER_DATA_PATH` 会持续增长直到写满配额 |
| 6 | `utils/ui.js:22-34` | toast 固定截断 40 字、忽略调用方传入的 `duration` |
| 7 | `utils/perms.js:53-57` / `utils/flags.js:97-100` | 拉取失败一律当"无权限/全关" → 网络抖动时误报「功能正在灰度中」 |
| 8 | `pages/orders/list.js:322-340` | `_hideTimer` 没有 `onUnload`/`onHide` 清理 |
| 9 | 多个 admin 页面 | `_armTimer` 未清理（只有 `banners.js` 和 `feedback.js` 做了） |
| 10 | `pages/admin/*.js` | 列表固定 50 条无分页 → 超过 50 条后更早的记录永远翻不到 |
| 11 | `pages/admin/items.js` / `dispatch.js` / `banners.js` | 金额与整数无精度/范围校验（`Number('12.345')` 直接写入） |
| 12 | `pages/order/create.js:42-48` | `buildTitle` 拿 `description` 前 20 字当标题 → 取餐码/姓名尾号公开到大厅 |
| 13 | `pages/order/create.js:129` | `wx.navigateBack()` 无 fail 兜底 |
| 14 | `pages/hall/index.js:404-435` | `quickAccept` 无 in-flight 标记，连点可并发接多单 |
| 15 | `pages/order/detail.js:476-498` | accept 路径未预占 `busy`，双击会发两次接单请求 |
| 16 | `utils/api.js:608-640` | 四处写操作直接打表（`addAddress`/`removeAddress`/`submitApplication`/`ensureProfile`），违反"写操作一律走 SECURITY DEFINER"约定 |
| 17 | `utils/motion.js:165` | 用 `Object.assign`（ES6 API），与文件头"别在这里用 ES6"自相矛盾 |
| 18 | `utils/motion.js:24-81` | `sysCache` 永不失效，横竖屏切换后 `windowHeight` 是旧值 |

---

## 📄 文档问题（本次已修正）

1. **根目录文档还留着 R39**（PR 合入记录，39 轮 / 116 函数），但代码已回退到 R38。
   已删除 R39 整段，统计口径改回 **38 轮 / 110 函数**。
2. **遗留事项第 7 条说"客服页顶部还留着临时调试条"**，实际 R38 已删干净。
   已改为删除线 + 说明。
3. 两份文档（根目录 + `campus-errand/docs/ITERATIONS.md`）已重新 `cp` 同步。

---

## ✅ 做得好的地方

1. **ES5 纪律零违规**：37 个页面 + 2 个组件，grep `=>` / 反引号 / `...` / `async` 全部 0 命中。
2. **WXML 循环规范**：全部显式 `wx:for-item`，`wx:key` 基本齐全。
3. **RPC 参数与 SQL 逐一对得上**：`create_order` 19 参、`list_hall_orders` 7 参、
   `admin_update_faq_settings` 10 参、`get_order_asset` 2 参，全部一致。
4. **图片三通道设计清晰**：`get_media_asset`（本人）/ `get_order_asset`（订单相关人）/
   `get_public_asset`（公开），页面侧没有用错通道 —— 唯一缺口是服务端鉴权不够严（P0-1）。
5. **不可逆操作的二次确认很克制**：统一"第一次点上膛、第二次才提交"，4 秒超时，
   并在注释里说明为什么不用 `wx.showModal`（预览环境回调不带 `confirm`）。
6. **定时器清理细致**：`detail.js` / `review.js` / `mine/index.js` 都做了双保险。
7. **违规词前后端同一套算法**：`normalize` 与 SQL 逐条对应，`scanFields` 刻意不拼接多字段避免造词误伤。
8. **踩坑文档完备**：`upload.js` 顶部 20 多行记录了对象存储"写得进读不出"的完整排查过程，
   是项目里最值钱的一段文档。
9. **密钥纪律**：`config.js` 明确拒绝把管理员口令放进前端并解释原因；
   `workbuddy-cloud-diagnostics.js` 只记 `appId/code/requestId`，URL 掐掉查询串。
10. **AI 客服流式实现正确**：手动 `iterator.next()` 循环，零 `for await`，`signal` 位置正确。

---

## 建议的修复顺序

| 批次 | 内容 | 预估影响面 |
|---|---|---|
| **第 1 批（发版前必做）** | P0-1 图片越权、P0-2 接单校验、P0-3 前端硬拦、P0-5 明文密码 | 3 个 SQL 函数 + 2 个前端文件 |
| **第 2 批（本周）** | P1-1 到 P1-6（错方法名、分页错位、goBack、权限键、dispatch、工作台入口） | 8 个文件 |
| **第 3 批（排期）** | P1-7 到 P1-12 + P2 清单 | 视人力 |
| **第 4 批（技术债）** | 死代码清理、写操作收口到 SECURITY DEFINER、金额校验统一 | 可分批 |

---

## 附：审阅方法与覆盖度

- **静态扫描**：ES5 违规、WXML 循环、硬编码密钥、SQL 函数权限修饰符
- **逐文件审阅**：订单流程 5 页、管理后台 12 页、utils 12 个、SQL 22 个
- **交叉验证**：前端 RPC 参数 ↔ SQL 函数签名、前端权限判断 ↔ 服务端 `admin_has_perm`
- **利用链推演**：图片通道、接单路径、配额路径
- **未覆盖**：真机运行时行为、并发时序、实际数据库当前状态（无法直连 WorkBuddy Cloud 数据库）
