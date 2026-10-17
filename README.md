# 校园跑腿（广东邮电职业技术学院）

> 仓库：https://github.com/1345463/campus-errand （私有） · 默认分支 `main`

微信小程序「校园跑腿」—— 校园互助任务发布与接单平台。原生小程序 + PostgreSQL（WorkBuddy Cloud）后端，
所有跨用户写操作走 `SECURITY DEFINER` 函数，全表 RLS。

**历史可回溯**：`main` 上有 31 次提交，按 R1 → R29 的迭代顺序排列，
里程碑打了 `v0.1.0` ~ `v0.5.0` 五个 tag。`git log --reverse` 即可顺着时间线回到任意一轮。

> 📘 **29 轮迭代的完整过程、踩坑知识库、数据库演进与函数清单见 [`docs/ITERATIONS.md`](docs/ITERATIONS.md)**
> 📄 逐轮变更见 [`CHANGELOG.md`](CHANGELOG.md)（正序）

---

## 一、能力概览

| 模块 | 内容 |
|---|---|
| 任务 | 10 类服务下单、任务大厅（服务类型/排序、楼栋楼层筛选、上拉分页）、置顶（优先券） |
| 订单 | 接单 → 送达佐证（1–3 张）→ 发布方确认 → 结算；取消、软删除、举报下架、48h 核查 |
| 身份 | 账号密码 / 手机验证码登录；接单员需实名认证（姓名 + 学生证/身份证照片） |
| 积分 | 确认完成按赏金 1:1 发积分（记在**下单人**账上）；积分商城（抵扣券 / 核销券 / 优先券） |
| 信誉 | **双轨信誉分**：`runner_score_*`（别人对我这个接单员的评价）、`owner_score_*`（对我这个发布者的评价）；`credit_strikes` 违规次数 |
| 租赁 | 相机租赁：填预填信息 → 管理员报价 → 生成特殊工单；机型挂牌价后台可配 |
| 后台 | 分级管理员八级权限（super/support/hr/review/rental/print/settle/dispatch）+ 17 个灰度开关 + 数据看板 |
| 客服 | 意见反馈工单 + 双向跟进对话（pending 客服可说 / resolved 双方可说 / rejected 需重新受理） |
| 消息 | 订单、租赁、认证、举报四类触发器推送站内消息 |

## 二、技术栈与铁律

- **微信原生小程序**，不使用第三方框架。
- **页面层强制 ES5**：`const/let + function`，禁箭头函数 / 模板字符串 / 展开运算符；
  页面里用 `.then().catch()`，只有 `utils/api.js` 内部用 `async`。
- **后端 = WorkBuddy Cloud（PostgreSQL）**，应用 id `wbapp_yPJnSvicojPmz998PjKfpM`。
  前端 `cloud.database.rpc('fn', { p_xxx })` 调数据库函数。
- **写操作一律走 `SECURITY DEFINER` 函数**：RLS + `auth.uid()` + `SET search_path = public`。
  `owner_id` 是超过 2^53 的字符串，**绝不在客户端拼 `owner_id` / `runner_id` 做比较**（精度丢失 + RLS 静默过滤）。
- **所有数据库变更必须落成 `sql/*.sql`**，否则重建环境会退回旧语义。
- **WXML 循环必须显式写 `wx:for-item`**，否则默认变量叫 `item`，用 `{{entry.xxx}}` 会静默渲染成空白。
- `ui.*` 只认 `utils/ui.js` 的导出名（`loading` / `toast` / `hideLoading` …），写错取到 `undefined`，
  一调用就中断整段逻辑。
- 新增页面四件套后必须在 `app.json` 注册。

## 三、目录结构

```
campus-errand/
├── app.js / app.json / app.wxss     全局（含 wx.getUpdateManager 热更新检查）
├── pages/
│   ├── index/       首页（公告条 + 服务宫格 + 大厅入口卡）
│   ├── hall/        任务大厅（独立页，接单员门槛锁卡）
│   ├── order/       create / detail / review
│   ├── orders/      list（四维筛选 + 搜索）
│   ├── mine/        index / profile / address / apply / cert / credit / points /
│   │                wallet / mall / messages / feedback / reviews
│   ├── admin/       dashboard / staff / flags / banners / items / points /
│   │                review / rental / reports / settle / feedback / dispatch
│   ├── rental/      index / apply
│   ├── feedback/    thread（客服与用户共用的会话页）
│   └── agreement/   index（用户协议）
├── components/room-picker/   三级宿舍选择器（三个 scroll-view 列）
├── utils/          api / upload / ui / guard / flags / perms / moderation /
│                   campus / services / config / agreement / cloud
├── sql/            21 个迁移脚本（幂等，可重放）
├── tools/          verify-mp.js / check-mp.js
└── miniprogram_npm/ SDK 构建产物（必须入库，删了跑不起来）
```

## 四、数据库

- **21 张表，全量 RLS**（`profiles` / `orders` / `addresses` / `runner_applications` /
  `rental_requests` / `rental_items` / `order_hides` / `admin_grants` / `feature_flags` /
  `banners` / `messages` / `order_reviews` / `point_records` / `wallet_records` /
  `user_feedbacks` / `feedback_replies` / `point_goods` / `point_redemptions` /
  `moderation_words` / `media_assets` / `notifications`）
- **99 个数据库函数**，命名约定 `p_` 前缀参数。
- 迁移脚本按 `sql/` 下的顺序执行即可重建；每个脚本都写成幂等。

### 订单状态机

```
pending ──accept──> accepted ──complete──> waiting_confirm ──confirm_order_done──> done
   │                    │                        │
   └──cancel──> cancelled                        └──submit_settle_feedback(满48h)──> 核查
   └──admin_handle_report──> takedown（orders.takedown = true，扣信用）
```

## 五、本地校验（每次改完必跑）

```bash
# 1. 全量语法检查
for f in $(find . -name "*.js" -not -path "./node_modules/*" -not -path "./miniprogram_npm/*"); do node --check "$f"; done

# 2. 页面注册 / 四件套 / 事件绑定校验（放工作区根目录，别放进包内）
node tools/verify-mp.js

# 3. 微信上传预检 + 真实包体积（必须 ESM 解析，才能抓出重复声明）
node --experimental-vm-modules tools/check-mp.js .
```

`check-mp.js` 的七项检查：ESM 严格解析 / JSON 可解析 / WXML 标签配对 + id 唯一 /
页面文件齐全 / `usingComponents` 指向存在 / 按 `packOptions.ignore` 算真实上传体积 /
裸包名能在 `miniprogram_npm` 解析。

> ⚠️ `node --check` 抓不到「同名函数重复声明」：非严格 Script 里顶层函数声明是 var 作用域，
> 重复声明合法；微信 CI 按 ES Module 解析会直接编译失败。只有 `vm.SourceTextModule` 能抓到，
> 这正是 R12 那个「上传失败」的真因。

## 六、关于 Git 历史（务必知情）

仓库在 2026-10-17 立项，此前 29 轮迭代只留有「最终态」文件，**没有逐行 diff 可还原**。
因此历史按下述方式重建：

```
每一轮提交 = 该轮首次引入的文件（以最终内容入库） + CHANGELOG.md 追加一节
提交时间   = 该轮真实发生时间（锚点取自 sql/*.sql 的 mtime 与迭代记录）
```

即：**文件级快照可回溯，行级 diff 不可回溯**。想看某一轮"改了什么"，读 `CHANGELOG.md`
对应小节 + `docs/ITERATIONS.md`；想看某一轮"引入了哪些文件"，`git show --stat <commit>`。
从这个提交往后的所有改动都是真实 diff，不再有这个限制。

推送：

```bash
git remote add origin https://github.com/1345463/campus-errand.git
git push -u origin main && git push --tags
```

## 七、部署

1. 微信开发者工具打开本目录（`miniprogram_npm` 必须在，`node_modules` 被 `packOptions.ignore` 排除）。
2. 上传体积需 ≤ 2MB 主包限制，当前约 1.1MB。
3. 灰度开关默认**全关**，发布后由 super 管理员在「管理员工作台 → 总闸」逐个打开。
4. 环境选型与发布注意事项见 `docs/ENVIRONMENT.md`、`docs/RELEASE.md`。

## 八、已知风险

- 管理员口令硬编码（`activate_admin`），本质是调试后门，正式运营需替换。
- 未接支付，钱包不可提现（页面已如实说明）。
- 旧对象存储的证件照不可读，需用户重新提交。
- `utils/config.js` 的 `rememberPassword / autoLogin / presetAccount` 为联调调试态，上线前必须关。

---

Licensed for campus use. 迭代记录与踩坑知识库是本项目最重要的资产，改代码前请先读 `docs/ITERATIONS.md`。
