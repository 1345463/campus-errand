# 发布与试用版授权

## 试用版状态

分享面板显示「试用版 已发布」，有效期至 2026/10/29，当前版本试用版支持「解绑」
（旧文档说不能改绑是过期信息）。

三条硬限制：

1. 14 天有效
2. 最多 15 人体验
3. 一个微信号最多建 5 个
4. **不能转正式版**

## 授权是「拉取式」的

试用版**没有成员管理界面**，用户在后台找不到入口是正常的。正确流程：

```
分享二维码 → 对方扫码 → 首次触发「申请体验权限」
          → 创建者在微信「服务通知」里点开批准
```

**排障技巧**：忘了管理员是哪个微信号时，用不常用的微信扫预览码申请成为体验者，
**哪个微信号收到「小程序体验成员申请」，哪个就是管理员**。

## 上传失败的排查

微信 CI 的真实报错藏在 WorkBuddy 前端日志里：

```
C:/Users/<你>/.workbuddy/logs/renderer.log
搜索： [miniprogram:publish] publish failed
```

字段 `raw=` 是完整错误，`displayed=cleaned` 表示界面上那句是「洗过」的。

最常见的原因不是网络也不是体积，而是 **同一个函数被声明了两次**：

```js
// utils/api.js
function completeOrder(...) { }   // 275 行
function completeOrder(...) { }   // 284 行  ← 微信 CI 直接编译失败
```

`node --check` 抓不到（非严格 Script 里顶层函数声明是 var 作用域，重复声明合法），
只有 `new vm.SourceTextModule(src)` 能抓到 → 已固化进 `tools/check-mp.js`。

## 包体积

- `node_modules` 5.89MB > 主包 2MB 限制 → `project.config.json` 的 `packOptions.ignore` 排除。
- `miniprogram_npm/` 是 SDK 构建产物，**必须入库**，删掉预览/上传都跑不起来。
- 当前上传体积约 1.1MB / 2.00MB。

## 发布后仍要盯的事

- `DROP POLICY orders_write_own` 已执行，但仍在观察窗口内（原计划等新版发布 + 48 小时）。
  触发条件是旧版客户端还能直接 UPDATE 自己的订单以绕过 accept/complete 改状态。
  一旦有反馈立刻回滚（回滚语句在 `sql/drop-orders-write-own.sql` 末尾注释里）。
- 灰度开关默认全关，发布后由 super 管理员在「管理员工作台 → 总闸」逐个打开。
