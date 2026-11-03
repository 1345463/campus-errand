# 云环境与后端选型

> 2026-11-01 复核重写。上一版停留在 **R52 迁库之前**（最后改动 10-17），
> 里面「后端跑在 WorkBuddy Cloud 应用 `wbapp_yPJnSvicojPmz998PjKfpM`、改 `utils/cloud.js` 的 endpoint」
> 等表述已全部失效 —— WorkBuddy Cloud 应用与 `miniprogram_npm/` 都在 **R52** 退役/删除。

## 数据库类型必须是 PostgreSQL

腾讯云 CloudBase 新建环境时有两个选项：

| 选项 | 说明 | 结论 |
|---|---|---|
| **PostgreSQL 数据库** | 关系型，支持 `SECURITY DEFINER` 函数、RLS、事务、窗口函数 | ✅ 选这个 |
| 云数据库 | 文档型 JSON + `.watch()` 实时推送 | ❌ 选它等于整个后端重写 |

## 现役环境（唯一一套）

| 项 | 值 |
|---|---|
| CloudBase 环境 | **`ceshi-d2g37cbg7c8f7ee48`**（PostgreSQL） |
| 小程序自有云开发环境 | `baozi-d2gbl784gd773f8b6` —— 只放 `tcb-proxy` 一个函数 |
| 结构规模 | 38 张表 / **174** 个 `SECURITY DEFINER` 函数 / 9 个触发器（2026-11-03 复核） |
| 迁移脚本 | **`cloudbase/migrations/*.sql`，67 条**，在工作区根下与 `campus-errand/` 同级，**不在 git 仓库内** |
| 退役结构 | 包内 `campus-errand/sql/*.sql` 那 28 个脚本面向已退役的 WorkBuddy Cloud 旧库，只作结构参考 |
| 访问链 | `utils/api.js` → `utils/tcb.js`：网关 `/api/xxx` 直连优先，域名没白名单时退 `wx.cloud.callFunction('tcb-proxy')`；**只有网络层失败才换通道，业务拒绝不重试** |
| 云函数 | 8 个：`app-api` / `ai-api` / `pay-create` / `pay-notify` / `transfer` / `transfer-notify` / `withdraw-api` / `tcb-proxy` |
| 定时任务 | **两个**，都要在控制台手动挂，不跟着代码走（见 README「十、部署」第 5 条）：`pay-create` cron `0 */10 * * * * *`；`withdraw-api` cron `0 5,15,25,35,45,55 * * * * *`（R64 起，与前者错开） |

## 从零重建环境时的顺序

1. 在 CloudBase 建 **PostgreSQL** 环境，拿到 EnvId。
2. 按 `cloudbase/MIGRATION.md` 记的顺序重放 `cloudbase/migrations/` 下全部脚本（均幂等、可重放）。
3. `utils/config.js` / `utils/tcb.js` 里的 EnvId 与网关域名换成新环境的。
4. 部署 8 个云函数；**密钥类环境变量要单独 `updateFunctionConfig` 下发**（`updateFunctionCode`
   传 `envVariables` 不会落到函数配置上）。
5. ⚠️ **新建函数无法继承商户私钥**：凡是需要 `WXPAY_PRIVATE_KEY` 的能力，只能并进已有函数
   （`pay-create` / `pay-notify` 目前靠 `action` 分派实现多能力），不要新建函数。
6. 挂两个定时触发器（7 段 cron）：`pay-create` 的 `0 */10 * * * * *`（否则超时单与滞留退款无人清理）、
   `withdraw-api` 的 `0 5,15,25,35,45,55 * * * * *`（否则提现回调丢失后只能等用户打开钱包页才补转）。
   ⚠️ cron 判定必须写成 `!isHttp && event.Type === 'Timer'` —— 只判 `Type` 的话，
   请求体里伪造 `{"Type":"Timer"}` 就能直接触发关单。

## 鉴权模型

- 云函数用 `WX_APP_SECRET` 签 HMAC 会话令牌（`v1.<payload>.<sig>`，30 天），端上只存只带。
- 服务端 `svc_rpc(p_uid, p_fn, p_args)` 先验令牌取可信 uid → `set_config('request.jwt.claim.sub', uid)` → 执行业务函数。
- `auth.uid()` 返回 **text**（形如 `wx:openid`），所有「谁的」列一律 text，写 `uuid` 真机才炸。
- **默认 session 的 `current_user` 是表 owner 且带 `rolbypassrls=true`**，
  直接查表测不出 RLS 效果。自检必须：

```sql
EXECUTE 'SET LOCAL ROLE authenticated';
PERFORM set_config('request.jwt.claim.sub', '<uid>', true);
```

- **INSERT 被 RLS 拒绝会报错；UPDATE 不报错但影响行数 = 0** ——
  判定要用 `GET DIAGNOSTICS ... ROW_COUNT`，只 catch 异常会误判成「没拦住」。
- 切角色之后**不能**再直接 SELECT/INSERT 业务表（42501），造数据要放在切角色之前，
  或用 SECURITY DEFINER 函数代劳；跨用户读原始表先 `EXECUTE 'RESET ROLE'`。
- 自检统一用 `DO` 块，末尾 `RAISE EXCEPTION 'RESULT ...'` 主动抛错回滚，
  既拿到结果又不留脏数据。**DO 块里不要写 `--` 注释**（会被工具截坏，报 42601）。
- **超过 10 个参数的 RPC，测试一律用命名参数 `p_xxx => value`**，且必须给全所有无默认值的形参。
- 改函数**返回类型**必须先 `DROP FUNCTION` 再 `CREATE`，重建后 **GRANT 要重跑**（权限绑函数 oid）；
  只改函数体用 `CREATE OR REPLACE`。
