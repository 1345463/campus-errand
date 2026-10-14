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

## R3 · 学校切换 + 三级宿舍 + 账号登录 + 管理员

- utils/campus.js：广东邮电职业技术学院，进取楼/团结楼/博学楼/精益楼/敬业楼/迎宾楼，
- 1-14 层、1-40 号，formatRoom / parseRoom 双向解析。
- 自定义组件 components/room-picker 做三级选择；地址拆成 building="楼栋 · 楼层" + room="宿舍号"。
- 账号登录 loginWithPassword / sendPhoneCode / registerWithPhone（不依赖 wx.login，预览可用）。
- 管理员：profiles.is_admin + activate_admin(code) + list_all_orders(limit)。

_提交时间：2026-10-14 15:00:00_

## R4 · 预览环境兼容性（utils/ui.js）

- H5 预览容器不完整模拟原生能力，报 wx.showLoading is not a function；
- 同一原因导致 picker-view 三列渲染错乱（点开直接是第三级房号）。
- 新增 utils/ui.js：所有 wx UI/storage 调用统一走这里，available() 检测 + try/catch + 超时兜底；
- confirm 带 15s 超时，绝不悬着。
- 三级选择器废弃 picker-view，改为三个 scroll-view 列 + bindtap 选中。
- 踩坑：sed 全量替换时不能把 ui.js 自己内部的 wx.* 也替换掉（会无限递归）。

_提交时间：2026-10-14 16:00:00_
