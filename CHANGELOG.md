# 校园跑腿 · 变更日志（按迭代正序）

> 本文件随每一次迭代提交自动追加。完整的过程记录、踩坑知识库与数据库演进
> 见 `docs/ITERATIONS.md`。

## R1 · 立项与原型还原（10-14）

- 用户提供 1 分 46 秒参考小程序录屏，抽帧 22 张还原页面。
- 首版 8 个页面 / 3 个 tabBar，后端接 WorkBuddy Cloud（PostgreSQL）。
- 建表 profiles / orders / addresses / runner_applications（全量 RLS）。
- 跨用户操作一律 SECURITY DEFINER：accept_order / complete_order / cancel_order。
- 确定合规红线：校园互助、不代做作业、不代考、不涉违禁品。

_提交时间：2026-10-14 13:20:00_

## R2 · 修「首页服务宫格点不进去」

- 根因：进下单页前的 guard.ensureLogin() 前置拦截；H5 预览拿不到真实 wx.login，
- 永远登不上，每次点击都被弹框拦下；且 getSession() reject 时未 catch，Promise 中断后无反馈。
- 填表改为纯本地操作，登录校验挪到"提交任务"时；所有 wx.navigateTo 补 fail 回调；
- 大厅加载失败改为可点击重试的空态，不再弹 toast 打断。
- 原则：不用匿名登录/假 session 绕过鉴权。

_提交时间：2026-10-14 14:10:00_
