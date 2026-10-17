# 校验体系

每次改完必跑四件套，顺序不能变。

> 一键版：`python scripts/sync_github.py "本次改动摘要"`（在工作区根目录跑）。
> 它会**先跑完下面四件套，任一失败就拒绝提交**，通过后才 commit + push 到 GitHub。
> 加 `--tag v0.6.0` 可顺便打里程碑 tag，加 `--check` 只校验不提交。
>
> **第 4 项（样式预检）是补上去的**：`app.wxss` 的注释里混进一个 Markdown 反引号，
> 前三项全绿，一路提交推送，直到点「发布」才被微信编译器打回
> `app.wxss:1663:12: error at token ` `` ` ``。JS 检查管不到 wxss，必须单独有一道闸。

## 1. 全量语法检查

```bash
cd campus-errand
for f in $(find . -name "*.js" -not -path "./node_modules/*" -not -path "./miniprogram_npm/*"); do
  node --check "$f" || echo "FAIL $f"
done
```

## 2. 页面注册 / 四件套 / 事件绑定

```bash
node tools/verify-mp.js
```

检查：

- `app.json` 里注册的每个页面，四件套（`.js/.json/.wxml/.wxss`）齐全
- WXML 里绑定的每个事件方法，在对应 JS 里有定义
- WXML 用到的 class 在 wxss 里有样式定义
- Page 对象里方法名不重复（`pages/mine/apply.js` 曾出现两个 `onLoad`）

## 3. 微信上传预检 + 真实包体积

```bash
node --experimental-vm-modules tools/check-mp.js campus-errand
```

七项检查：

1. **ESM 严格解析**（`vm.SourceTextModule`）→ 抓重复声明
2. JSON 可解析
3. WXML 标签配对 + `id` 唯一
4. `app.json` 页面文件齐全
5. `usingComponents` 指向存在
6. 按 `packOptions.ignore` 算**真实**上传体积
7. 裸包名能在 `miniprogram_npm` 解析

> `verify-mp.js` / `check-mp.js` 放在**工作区根目录**运行，放进包内会被当成缺 npm 依赖。
> 仓库里的 `tools/` 是副本，方便随代码一起归档。

## 4. 样式预检（wxss / wxml 语法）

```bash
node campus-errand/tools/style-lint.js campus-errand
```

查六项，都是「编译期必炸」或「静默失效」类问题：

1. **反引号** `` ` `` —— wxss 不支持，编译器报 `error at token`。**注释里也不行**
2. **Markdown 残留** `**粗体**` —— 多半是从文档里粘注释带进来的
3. **注释配对** —— `/*` 与 `*/` 数量必须相等（注释没闭合会把后面整段样式吃掉）
4. **花括号配对** —— 去掉注释后 `{` 与 `}` 数量必须相等
5. **全角标点** —— 去掉注释后仍出现 `：；，（）` 等，选择器或属性里必炸
6. **`var(--x)` 引用了从未定义的变量** —— 跨文件汇总所有 `--x:` 定义，
   没定义又没兜底值（`var(--x, fallback)`）时**不报错、整条样式静默失效**

顺带查 wxml 的反引号和 `{{ }}` 配对。

## 5. 附带的两个扫描（手工跑）

**WXML 循环变量名**：`wx:for` 默认循环变量叫 `item`。若 `wx:for="{{entries}}"` 没写
`wx:for-item="entry"`，标签内 `{{entry.icon}}` 全部取到 `undefined` —— 页面**不报错**，
只渲染出空白行。扫法：正则找 `wx:for` → 检查有没有 `wx:for-item` → 比对后面 400 字内
`{{变量.}}` 用到的变量名。

**重复入口**：统计 wxml 里每个 `bindtap` 的出现次数 → 映射到该函数里的 `navigateTo` url →
按 url 聚合。同一页同一目标只留一个入口。

## 6. 数据库侧自检

每轮用 `DO` 块冒充真实用户做角色化自检（见 `docs/ENVIRONMENT.md`），最后主动抛错回滚，
收尾一定跑脏数据复核（自测数量应为 0）。

写完「金额/计数」类 RPC 时顺手问一句：**这条路径能被重复调用吗？**
`admin_handle_report` 就出过同一条举报反复处理、每次都扣一次信誉分的问题，
必须加前置状态校验。
