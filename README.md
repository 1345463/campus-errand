# 校园跑腿（广东邮电职业技术学院）

> 仓库：https://github.com/1345463/campus-errand （私有） · 默认分支 `main`

微信小程序「校园跑腿」—— 校园互助任务发布与接单平台。原生小程序 + PostgreSQL（WorkBuddy Cloud）后端，
所有跨用户写操作走 `SECURITY DEFINER` 函数，全表 RLS。

**历史可回溯**：`main` 上有 31 次提交，按 R1 → R29 的迭代顺序排列，
里程碑打了 `v0.1.0` ~ `v0.5.0` 五个 tag。`git log --reverse` 即可顺着时间线回到任意一轮。

> 📘 **42 轮迭代的完整过程、踩坑知识库、数据库演进与函数清单见 [`docs/ITERATIONS.md`](docs/ITERATIONS.md)**
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

- **29 张表，全量 RLS**（上面 21 张 + `faq_items` / `faq_settings`）
- **117 个数据库函数**，命名约定 `p_` 前缀参数。
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
npm ci --ignore-scripts
npm test
npm run check
```

`npm run check` 包含安全配置门禁、全量 JS 语法、页面和事件检查、ESM 上传预检、
真实包体积、WXML/WXSS 样式检查与回归测试。测试与构建工具均被排除在小程序上传包之外。
GitHub Actions 使用相同命令。默认禁止密码缓存、密码自动登录和预置账号。

订单与智能客服的修复范围、数据库迁移安装顺序见
[`docs/ITERATIONS.md`](docs/ITERATIONS.md)（R39 / R40 / R41）。

发布前必须在目标库按顺序执行三个迁移：
1. `sql/fix-order-support-workflows.sql` —— 订单分页 / 放弃接单 / AI 配额
2. `sql/restore-admin-password.sql` —— 后台密码（盐值哈希 + 限频 + 审计）
3. `sql/fix-asset-authorization.sql` —— 图片归属校验 + dispatch 权限

后台密码入口在「我的 → 设置 → 后台密码入口」。当前业务后端是 WorkBuddy Cloud PostgreSQL。

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

推送（已配 SSH 免密，密钥 `C:/campus-ssh/id_ed25519_campus`）：

```bash
git remote add origin git@github.com:1345463/campus-errand.git
git push -u origin main && git push --tags
```

日常不要手动敲这些 —— 用 `python scripts/sync_github.py "改动摘要"`（工作区根目录），
它会先跑校验四件套（含 style-lint.js），通过后才提交推送；每天 23:30 还有一个兜底的自动同步任务。

## 七、部署

1. 微信开发者工具打开本目录（`miniprogram_npm` 必须在，`node_modules` 被 `packOptions.ignore` 排除）。
2. 上传体积需 ≤ 2MB 主包限制，当前约 1.1MB。
3. 灰度开关默认**全关**，发布后由 super 管理员在「管理员工作台 → 总闸」逐个打开。
4. 环境选型与发布注意事项见 `docs/ENVIRONMENT.md`、`docs/RELEASE.md`。

## 八、已知风险

- 后台入口的服务端迁移使用加盐摘要、失败限流与审计；共享管理员口令仍应定期轮换，并仅供受信任人员使用。
- 未接支付，钱包不可提现（页面已如实说明）。
- 旧对象存储的证件照不可读，需用户重新提交。
- AI 配额已按账号在服务端记账，但模型客户端直连仍可绕过计数；严格成本防刷需要可信服务端网关。

---

Licensed for campus use. 迭代记录与踩坑知识库是本项目最重要的资产，改代码前请先读 `docs/ITERATIONS.md`。
