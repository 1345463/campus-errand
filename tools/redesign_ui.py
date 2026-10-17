# -*- coding: utf-8 -*-
"""
校园跑腿 UI 统一改造（v2 设计系统）

1) 在 app.wxss 的 page{} 里注入设计令牌（CSS 变量）
2) 全项目 wxss 的硬编码色值迁移到令牌
3) 在 app.wxss 末尾追加 v2 覆盖层（统一卡片/按钮/chip/宫格/统计/个人头部）
4) 更新 app.json 的导航栏与 tabBar 配色
5) 更新 utils/services.js 的服务宫格色块（tint）
"""
import io
import os
import re

REPO = r"C:/Users/包子6688/WorkBuddy/2026-10-14-12-13-59/campus-errand"

# ---------------------------------------------------------------- 1. 令牌
TOKENS = """
  /* ===== v2 设计令牌 =====
     校园蓝 = 校园/可靠；活力橙 = 跑腿/速度。改这一个块就能整体换肤。 */
  --brand: #2E7CF6;
  --brand-600: #1D5FD0;
  --brand-100: #E4EEFF;
  --brand-50: #F2F7FF;
  --accent: #FF8A3D;
  --accent-100: #FFF0E4;
  --success: #16A34A;
  --success-100: #E6F6EC;
  --warn: #F59E0B;
  --warn-100: #FFF5E3;
  --danger: #EF4444;
  --danger-100: #FDECEC;
  --bg: #F4F6FB;
  --card: #FFFFFF;
  --fill: #F1F4FA;
  --line: #E6EAF2;
  --t1: #131A2A;
  --t2: #5A6478;
  --t3: #98A2B3;
  --r-sm: 12rpx;
  --r: 20rpx;
  --r-lg: 28rpx;
  --r-pill: 999rpx;
  --sd-1: 0 2rpx 10rpx rgba(19, 26, 42, 0.05);
  --sd-2: 0 8rpx 28rpx rgba(19, 26, 42, 0.08);
  --sd-brand: 0 10rpx 26rpx rgba(46, 124, 246, 0.28);
"""

# ---------------------------------------------------------------- 2. 色值映射
COLOR_MAP = {
    # 主色：旧玫红 → 校园蓝
    'ff5a7a': 'var(--brand)',
    'c8364f': 'var(--brand-600)',
    'c8354a': 'var(--brand-600)',
    'ffeaf0': 'var(--brand-100)',
    'fff1f4': 'var(--brand-100)',
    'ffc9d4': 'var(--brand-100)',
    # 语义色
    'ff9f43': 'var(--warn)',
    'b26a00': 'var(--warn)',
    'fff7e8': 'var(--warn-100)',
    'fff4e5': 'var(--warn-100)',
    'ffe2b0': 'var(--warn-100)',
    'ea5455': 'var(--danger)',
    'e5484d': 'var(--danger)',
    'ffc9cd': 'var(--danger-100)',
    '07c160': 'var(--success)',
    '28c76f': 'var(--success)',
    '22a06b': 'var(--success)',
    # 底色
    'f5f6f8': 'var(--bg)',
    'f2f3f5': 'var(--fill)',
    'f7f8fa': 'var(--fill)',
    'f3f4f6': 'var(--fill)',
    'f0f0f2': 'var(--fill)',
    'efeff2': 'var(--fill)',
    # 文字
    '1f2023': 'var(--t1)',
    '1f2229': 'var(--t1)',
    '1f2233': 'var(--t1)',
    '1f2126': 'var(--t1)',
    '2b2b30': 'var(--t1)',
    '3a3d45': 'var(--t1)',
    '4a4a50': 'var(--t2)',
    '5a5d66': 'var(--t2)',
    '6b6b70': 'var(--t2)',
    '8a8a8f': 'var(--t3)',
    'a0a3aa': 'var(--t3)',
    '9a9ca1': 'var(--t3)',
    '9a9aa0': 'var(--t3)',
    # 描边
    'e3e6eb': 'var(--line)',
    'e3e3e8': 'var(--line)',
    'dcdde1': 'var(--line)',
    'c7c9ce': 'var(--line)',
    'c0c3ca': 'var(--line)',
}


def migrate_colors(text):
    def repl(m):
        key = m.group(1).lower()
        return COLOR_MAP.get(key, m.group(0))
    return re.sub(r'#([0-9a-fA-F]{6})\b', repl, text)


# ---------------------------------------------------------------- 3. v2 覆盖层
OVERRIDE = r"""

/* =========================================================================
   v2 设计系统覆盖层（2026-10-17）
   上面是 v1 的旧定义，这里统一覆盖：白卡 + 浅描边 + 柔和阴影 + 品牌蓝渐变。
   全项目共用这一套，改主题只动「设计令牌」这一块。
   ========================================================================= */

/* ---------- 容器与卡片 ---------- */
.card {
  background: var(--card);
  margin: 20rpx;
  padding: 28rpx;
  border-radius: var(--r-lg);
  border: 1rpx solid var(--line);
  box-shadow: var(--sd-1);
}

.card-elevated {
  box-shadow: var(--sd-2);
}

.order-card {
  background: var(--card);
  margin: 0 20rpx 20rpx;
  padding: 28rpx;
  border-radius: var(--r-lg);
  border: 1rpx solid var(--line);
  box-shadow: var(--sd-1);
}

.task-card {
  padding: 24rpx;
  border-radius: var(--r);
  background: var(--card);
  border: 1rpx solid var(--line);
  box-shadow: var(--sd-1);
  margin-bottom: 20rpx;
}

/* ---------- 顶部主视觉 ---------- */
.hero {
  margin: 20rpx;
  padding: 40rpx 36rpx;
  border-radius: var(--r-lg);
  background: linear-gradient(135deg, #2E7CF6 0%, #4FA1FF 60%, #63B3FF 100%);
  color: #FFFFFF;
  box-shadow: var(--sd-brand);
}
.hero-title {
  font-size: 42rpx;
  font-weight: 700;
  letter-spacing: 1rpx;
}
.hero-sub {
  font-size: 24rpx;
  margin-top: 14rpx;
  opacity: 0.9;
}

/* ---------- 公告条 ---------- */
.notice-bar {
  display: flex;
  align-items: center;
  padding: 18rpx 24rpx;
  background: var(--brand-50);
  border-bottom: 1rpx solid var(--line);
}
.notice-dot {
  width: 12rpx;
  height: 12rpx;
  border-radius: 50%;
  background: var(--accent);
  margin-right: 12rpx;
}
.notice-text {
  font-size: 24rpx;
  color: var(--t2);
  flex: 1;
}

/* ---------- 区块标题：左侧品牌竖条 ---------- */
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20rpx;
}
.section-title {
  font-size: 30rpx;
  font-weight: 600;
  color: var(--t1);
}
.section-title::before {
  content: '';
  display: inline-block;
  width: 8rpx;
  height: 28rpx;
  border-radius: 4rpx;
  background: var(--brand);
  margin-right: 12rpx;
  vertical-align: -4rpx;
}
.section-more {
  font-size: 24rpx;
  color: var(--t3);
}

/* ---------- 服务宫格 ---------- */
.grid {
  display: flex;
  flex-wrap: wrap;
}
.grid-item {
  width: 20%;
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 26rpx;
}
.grid-icon {
  width: 92rpx;
  height: 92rpx;
  border-radius: 26rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 42rpx;
  box-shadow: var(--sd-1);
}
.grid-label {
  font-size: 24rpx;
  margin-top: 10rpx;
  color: var(--t2);
}

/* ---------- 快捷入口 ---------- */
.quick-item {
  flex: 1;
  min-width: 0;
  background: var(--fill);
  border-radius: var(--r);
  padding: 24rpx;
  margin-right: 16rpx;
}
.quick-item.last {
  margin-right: 0;
}
.quick-title {
  font-size: 28rpx;
  font-weight: 600;
  color: var(--t1);
}
.quick-desc {
  font-size: 22rpx;
  color: var(--t3);
  margin-top: 8rpx;
}

/* ---------- 按钮 ---------- */
.btn-primary {
  background: linear-gradient(135deg, #2E7CF6 0%, #4FA1FF 100%);
  color: #FFFFFF;
  text-align: center;
  padding: 26rpx;
  border-radius: var(--r-pill);
  font-size: 30rpx;
  font-weight: 600;
  box-shadow: var(--sd-brand);
}
.btn-accent {
  background: linear-gradient(135deg, #FF8A3D 0%, #FFA45F 100%);
  color: #FFFFFF;
  text-align: center;
  padding: 26rpx;
  border-radius: var(--r-pill);
  font-size: 30rpx;
  font-weight: 600;
  box-shadow: 0 10rpx 26rpx rgba(255, 138, 61, 0.28);
}
.btn-ghost {
  background: var(--card);
  color: var(--t2);
  text-align: center;
  padding: 26rpx;
  border-radius: var(--r-pill);
  font-size: 30rpx;
  border: 1rpx solid var(--line);
}
.btn-disabled {
  opacity: 0.45;
}

/* ---------- chip / tag ---------- */
.chip {
  padding: 12rpx 26rpx;
  border-radius: var(--r-pill);
  background: var(--card);
  border: 1rpx solid var(--line);
  font-size: 24rpx;
  margin: 0 16rpx 16rpx 0;
  color: var(--t2);
  white-space: nowrap;
}
.chip.active {
  background: var(--brand-100);
  color: var(--brand);
  border-color: var(--brand);
  font-weight: 600;
}
.tag {
  padding: 12rpx 26rpx;
  border-radius: var(--r-pill);
  background: var(--fill);
  font-size: 24rpx;
  margin: 0 16rpx 16rpx 0;
  color: var(--t2);
}
.tag.active {
  background: var(--brand-100);
  color: var(--brand);
  font-weight: 600;
}

/* ---------- 列表项 ---------- */
.menu-list {
  background: var(--card);
  margin: 20rpx;
  border-radius: var(--r-lg);
  border: 1rpx solid var(--line);
  box-shadow: var(--sd-1);
  overflow: hidden;
}
.menu-item {
  display: flex;
  align-items: center;
  padding: 28rpx;
  border-bottom: 1rpx solid var(--line);
}
.menu-item.last {
  border-bottom: none;
}
.menu-label {
  flex: 1;
  font-size: 28rpx;
  color: var(--t1);
}
.menu-value {
  font-size: 26rpx;
  color: var(--t3);
}
.menu-arrow {
  color: var(--t3);
  font-size: 26rpx;
  margin-left: 12rpx;
}

/* ---------- 统计栏 ---------- */
.stat-row {
  display: flex;
  background: var(--card);
  margin: 20rpx;
  padding: 26rpx 0;
  border-radius: var(--r-lg);
  border: 1rpx solid var(--line);
  box-shadow: var(--sd-1);
}
.stat-item {
  flex: 1;
  text-align: center;
}
.stat-num {
  font-size: 36rpx;
  font-weight: 700;
  color: var(--brand);
}
.stat-label {
  font-size: 22rpx;
  color: var(--t3);
  margin-top: 6rpx;
}

/* ---------- 个人中心头部 ---------- */
.profile-head {
  padding: 40rpx 32rpx;
  background: linear-gradient(135deg, #2E7CF6 0%, #4FA1FF 60%, #63B3FF 100%);
  color: #FFFFFF;
}
.avatar {
  width: 112rpx;
  height: 112rpx;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.22);
  border: 2rpx solid rgba(255, 255, 255, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 40rpx;
  overflow: hidden;
}
.uname {
  font-size: 34rpx;
  font-weight: 600;
}

/* ---------- 空态 / 提示 ---------- */
.empty {
  text-align: center;
  color: var(--t3);
  font-size: 26rpx;
  padding: 64rpx 0;
}
.err-bar, .tip-bar {
  margin: 20rpx;
  padding: 20rpx 24rpx;
  border-radius: var(--r);
  background: var(--danger-100);
  color: var(--danger);
  font-size: 24rpx;
}
.tip-bar {
  background: var(--brand-50);
  color: var(--brand);
}

/* ---------- 状态圆标（pill 系列，新增可复用组件） ---------- */
.pill {
  display: inline-block;
  padding: 6rpx 18rpx;
  border-radius: var(--r-pill);
  font-size: 22rpx;
  line-height: 1.6;
}
.pill-brand { background: var(--brand-100); color: var(--brand); }
.pill-accent { background: var(--accent-100); color: var(--accent); }
.pill-success { background: var(--success-100); color: var(--success); }
.pill-warn { background: var(--warn-100); color: var(--warn); }
.pill-danger { background: var(--danger-100); color: var(--danger); }
.pill-gray { background: var(--fill); color: var(--t3); }

/* ---------- 小工具类 ---------- */
.text-brand { color: var(--brand); }
.text-danger { color: var(--danger); }
.text-muted { color: var(--t3); }
.shadow-1 { box-shadow: var(--sd-1); }
.shadow-2 { box-shadow: var(--sd-2); }
.row-between { display: flex; align-items: center; justify-content: space-between; }
.divider-line { height: 1rpx; background: var(--line); margin: 20rpx 0; }
"""

# ---------------------------------------------------------------- 4. services.js tint
TINT_MAP = {
    '#FFF0F3': '#FFF0E4',  # 粉 → 橙（活力）
    '#FFF4E8': '#FFF5E3',
    '#F1F5FF': '#E4EEFF',  # 蓝
    '#FFF7E6': '#FFF5E3',
    '#F0F7FF': '#E4EEFF',
    '#EAF7F1': '#E6F6EC',  # 绿
    '#F6F1FF': '#EAF1FF',
    '#FFF0F0': '#FDECEC',  # 红
    '#FDF1F6': '#FFF0E4',
    '#EEF6FF': '#E4EEFF',
    '#F3F0FF': '#EAF1FF',
}

# ---------------------------------------------------------------- 5. app.json
APP_JSON_COLORS = {
    '"navigationBarBackgroundColor": "#FF5A7A"': '"navigationBarBackgroundColor": "#2E7CF6"',
    '"backgroundColor": "#F5F6F8"': '"backgroundColor": "#F4F6FB"',
    '"selectedColor": "#FF5A7A"': '"selectedColor": "#2E7CF6"',
    '"color": "#8A8A8F"': '"color": "#98A2B3"',
}


def main():
    # 1) 色值迁移（所有 wxss）
    n_files = 0
    for base, dirs, files in os.walk(REPO):
        dirs[:] = [d for d in dirs if d not in ('node_modules', 'miniprogram_npm', '.git')]
        for f in files:
            if not f.endswith('.wxss'):
                continue
            p = os.path.join(base, f)
            src = io.open(p, encoding='utf-8').read()
            out = migrate_colors(src)
            if out != src:
                io.open(p, 'w', encoding='utf-8').write(out)
                n_files += 1
    print('色值迁移：%d 个 wxss' % n_files)

    # 2) 令牌注入 app.wxss
    app_css = os.path.join(REPO, 'app.wxss')
    s = io.open(app_css, encoding='utf-8').read()
    if '--brand:' not in s:
        anchor = "page {\n  background: var(--bg);\n  color: var(--t1);"
        if anchor not in s:
            raise RuntimeError('找不到 page{} 锚点，检查 app.wxss 头部')
        s = s.replace(anchor, "page {\n  background: var(--bg);\n  color: var(--t1);" + TOKENS, 1)
        print('设计令牌已注入 app.wxss')

    # 3) 追加 v2 覆盖层
    if 'v2 设计系统覆盖层' not in s:
        s = s.rstrip() + '\n' + OVERRIDE
        print('v2 覆盖层已追加')
    io.open(app_css, 'w', encoding='utf-8').write(s)

    # 4) services.js tint
    svc = os.path.join(REPO, 'utils', 'services.js')
    t = io.open(svc, encoding='utf-8').read()
    hit = 0
    for old, new in TINT_MAP.items():
        if old in t:
            t = t.replace(old, new)
            hit += 1
    io.open(svc, 'w', encoding='utf-8').write(t)
    print('服务宫格色块：%d 个' % hit)

    # 5) app.json 配色
    aj = os.path.join(REPO, 'app.json')
    j = io.open(aj, encoding='utf-8').read()
    for old, new in APP_JSON_COLORS.items():
        if old in j:
            j = j.replace(old, new)
    io.open(aj, 'w', encoding='utf-8').write(j)
    print('app.json 导航栏 / tabBar 配色已更新')

    # 6) 首页轮播指示点
    idx = os.path.join(REPO, 'pages', 'index', 'index.wxml')
    w = io.open(idx, encoding='utf-8').read()
    w = w.replace('indicator-active-color="#FF5A7A"', 'indicator-active-color="#2E7CF6"')
    io.open(idx, 'w', encoding='utf-8').write(w)
    print('首页轮播指示点已更新')


if __name__ == '__main__':
    main()
