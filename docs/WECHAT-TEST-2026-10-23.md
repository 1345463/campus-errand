# 微信开发者工具运行测试

## 环境

- 项目：`D:\GDYD`。
- 工具：`D:\微信web开发者工具`，版本 `2.02.2608080`，内置 wechatide skill `0.3.11`。
- 官方 `wechatide` 状态：微信已登录，skill 版本一致；用户开启本机服务端口并批准客户端连接。
- 使用当前账号下唯一可管理的小程序测试号 `wxf73d4e1b04e62d79`，替换无效的 `touristappid`。
- `project_import` 返回成功，`open_project_window` 打开完整项目窗口，`simulator_open_page` 编译进入智能客服。没有上传体验版或发布微信小程序。

## 实际操作

| 操作 | 结果 |
| --- | --- |
| 进入智能客服 | 真实小程序渲染欢迎语、热门问题和固定输入区，loading=false，errorText 为空。 |
| 输入“怎么发布一个跑腿任务？”并点发送 | 页面新增用户消息与非空 FAQ 回复，显示有帮助/没帮助，输入清空。 |
| 测量用户消息行 | `.msg-mine` 高度 59.484375px，没有继承全屏最小高度。 |
| 进入设置 `?admin=1` | 未登录时可见“后台密码入口 / 请先登录”，密码面板关闭，不获得权限。 |
| 进入外卖发布表单，输入 5.123 | 页面数据规范为 5.12。 |
| 点击赏金 ¥8 快捷项 | 页面数据 reward=8。 |

截图保存在本机 Codex 可视化目录，文件名为 `wechat-support-faq.jpg`、`wechat-admin-entry.jpg`。

首次通过工具切换编译页面时，控制台记录一次微信内部 `routeDone with a webviewId 5 is not found` / `SystemError (appServiceSDKScriptError)`。后续 FAQ 交互和页面导航可以执行，复查没有新增同类行；该启动日志保留在缓冲区，本报告不将其描述为“控制台无错误”。

## 测试边界

本轮没有业务登录测试账号，未操作线上订单、付费模型调用、照片上传或管理员授权。后台口令和订单/客服 RPC 的新迁移仅在本地 PostgreSQL 测试中验证，尚未在现有 WorkBuddy Cloud 目标库执行。用户决定先上传 GitHub，暂不继续线上数据库设置及登录后测试。手机预览、iOS/Android 键盘与照片权限仍需后续验证。

## 开发技能

已执行 `npx skills add tencentcloudbase/cloudbase-skills`，使用非交互参数安装官方 `cloudbase` 2.36.1 到 `.agents/skills/cloudbase`，并生成 `skills-lock.json`。技能文件和锁文件不进入小程序上传包。业务后端仍是现有 WorkBuddy Cloud PostgreSQL。
