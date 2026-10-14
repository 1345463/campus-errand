# 云环境与后端选型

## 数据库类型必须是 PostgreSQL

腾讯云 CloudBase 新建环境时有两个选项：

| 选项 | 说明 | 结论 |
|---|---|---|
| **PostgreSQL 数据库** | 关系型，支持 `SECURITY DEFINER` 函数、RLS、事务、窗口函数 | ✅ 选这个 |
| 云数据库 | 文档型 JSON + `.watch()` 实时推送 | ❌ 选它等于整个后端重写 |

套餐：免费体验版；地域：上海。

## 重要提醒

**新建环境是空库，和 WorkBuddy 云服务的库不互通**，修不了正在修的 bug。
本项目后端跑在 WorkBuddy Cloud 应用 `wbapp_yPJnSvicojPmz998PjKfpM` 上，
数据库变更通过 `sql/*.sql` 执行。

## 自建 CloudBase 环境时的对应改动

1. `utils/cloud.js` 里的 endpoint / appKey 换成新环境的。
2. 按顺序重放 `sql/` 下全部脚本（脚本均幂等）。
3. `miniprogram_npm/@tencent-ai/workbuddy-cloud-sdk/miniprogram.js` 保持 CJS 版本 ——
   ESM 版本在小程序 CI 下会解析失败。

## 鉴权模型

- 前端拿到的 `session.user.id` 会作为 `request.jwt.claim.sub` 传给数据库。
- 服务端函数里 `auth.uid()` = `current_setting('request.jwt.claim.sub', true)`。
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
