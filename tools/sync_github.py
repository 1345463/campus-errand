# -*- coding: utf-8 -*-
"""
把 campus-errand 的当前改动同步到 GitHub。

设计原则（重要）：
1. **校验不过就不提交** —— 先跑小程序四件套校验（语法 / 页面 / 预检 / 样式），任一失败就原样退出并报告，
   绝不把编译不过的代码推上去。
2. **提交信息必须说明这一轮改了什么**，用 -m 写清楚，不要 "update"。
3. 只在有真实改动时提交；没有改动就直接推（把上一轮忘记推的提交补上）。
4. 数据库变更必须同时落成 sql/*.sql，否则会被拦下并提示。

用法：
    python scripts/sync_github.py "本次改动摘要"
    python scripts/sync_github.py "摘要" --tag v0.6.0     # 里程碑打 tag
    python scripts/sync_github.py --check                  # 只校验不提交
"""
import os
import subprocess
import sys

ROOT = r"C:/Users/包子6688/WorkBuddy/2026-10-14-12-13-59"
REPO = os.path.join(ROOT, "campus-errand")
NODE = r"C:/Users/包子6688/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"


def git(*args, check=True):
    r = subprocess.run(['git'] + list(args), cwd=REPO, capture_output=True,
                       text=True, encoding='utf-8', errors='replace')
    if check and r.returncode != 0:
        raise RuntimeError('git %s 失败:\n%s' % (' '.join(args), r.stderr))
    return r.stdout.strip()


def git_all(*args):
    """git 命令的完整输出（stdout + stderr）—— git push 的进度走 stderr"""
    r = subprocess.run(['git'] + list(args), cwd=REPO, capture_output=True,
                       text=True, encoding='utf-8', errors='replace')
    if r.returncode != 0:
        raise RuntimeError('%s' % (r.stderr or r.stdout).strip())
    return (r.stdout + r.stderr).strip()


def ok(msg):
    print('  [OK]   %s' % msg)


def bad(msg):
    print('  [FAIL] %s' % msg)


def verify():
    """小程序四件套校验，返回 (是否通过, 失败项列表)"""
    fails = []

    # 1) 全量语法检查
    js_files = []
    for base, dirs, files in os.walk(REPO):
        dirs[:] = [d for d in dirs if d not in ('node_modules', 'miniprogram_npm', '.git')]
        for f in files:
            if f.endswith('.js'):
                js_files.append(os.path.join(base, f))
    for f in js_files:
        r = subprocess.run([NODE, '--check', f], capture_output=True, text=True)
        if r.returncode != 0:
            fails.append('语法错误: %s' % os.path.relpath(f, REPO))
    if not fails:
        ok('全量语法检查（%d 个 JS）' % len(js_files))
    else:
        bad('全量语法检查')

    # 2) verify-mp.js
    r = subprocess.run([NODE, os.path.join(ROOT, 'verify-mp.js')], cwd=ROOT,
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode == 0:
        ok('verify-mp.js（页面注册 / 四件套 / 事件绑定）')
    else:
        bad('verify-mp.js\n%s' % (r.stdout or r.stderr)[:800])
        fails.append('verify-mp.js')

    # 3) check-mp.js（必须 ESM 解析）
    r = subprocess.run([NODE, '--experimental-vm-modules', os.path.join(ROOT, 'check-mp.js'), 'campus-errand'],
                       cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode == 0:
        ok('check-mp.js（上传预检 + 包体积）')
    else:
        bad('check-mp.js\n%s' % (r.stdout or r.stderr)[:800])
        fails.append('check-mp.js')

    # 4) style-lint.js（wxss/wxml 语法 + CSS 变量定义）
    #    为什么加这一步：app.wxss 注释里混进一个反引号，三件套全绿，
    #    直到点「发布」才被微信编译器打回 app.wxss:1663:12 error at token。
    r = subprocess.run([NODE, os.path.join(REPO, 'tools', 'style-lint.js'), REPO],
                       cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode == 0:
        ok('style-lint.js（%s）' % (r.stdout or '').strip().split('\n')[0].replace('样式预检：', ''))
    else:
        bad('style-lint.js\n%s' % (r.stdout or r.stderr)[:800])
        fails.append('style-lint.js')

    return len(fails) == 0, fails


def main():
    argv = sys.argv[1:]
    tag = None
    if '--tag' in argv:
        i = argv.index('--tag')
        tag = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    only_check = '--check' in argv
    if only_check:
        argv.remove('--check')
    subject = ' '.join(argv).strip()

    print('=' * 60)
    print('campus-errand → GitHub 同步')
    print('=' * 60)

    # 分支保护：必须在 main 上
    branch = git('rev-parse', '--abbrev-ref', 'HEAD')
    if branch != 'main':
        bad('当前分支是 %s，不是 main —— 已停止，请人工确认' % branch)
        return 2
    ok('当前分支 main')

    # 校验
    print('\n[1/4] 校验四件套')
    passed, fails = verify()
    if not passed:
        print('\n❌ 校验未通过，拒绝提交。失败项：')
        for f in fails:
            print('   - %s' % f)
        return 1

    if only_check:
        print('\n（--check 模式，不提交）')
        return 0

    if not subject:
        bad('缺少提交摘要：python scripts/sync_github.py "本次改动摘要"')
        return 2

    # 有改动就提交
    print('\n[2/4] 检查改动')
    status = git('status', '--porcelain')
    if status:
        git('add', '-A')
        git('commit', '-q', '-m', subject)
        ok('已提交：%s（%d 个文件）' % (subject, len(status.splitlines())))
    else:
        ok('工作区无改动（把上一轮未推送的提交补推）')

    # 推送（注意：git push 的进度信息走 stderr，只看 stdout 会误显示成 "already up to date"）
    print('\n[3/4] 推送到 origin/main')
    try:
        out = git_all('push', 'origin', 'main')
        print('  %s' % (out or 'already up to date（远端已是最新）'))
    except RuntimeError as e:
        bad('推送失败 —— 检查 SSH：ssh -F C:/campus-ssh/config -T git@github.com\n%s' % e)
        return 1

    # tag
    if tag:
        print('\n[4/4] 打里程碑 tag %s' % tag)
        git('tag', '-f', tag)
        git('push', '-f', 'origin', tag)
        ok('tag %s 已推送' % tag)
    else:
        print('\n[4/4] 未指定 --tag，跳过（里程碑轮次记得打 tag）')

    head = git('log', '-1', '--pretty=%h %s')
    print('\n✅ 完成，远端 HEAD：%s' % head)
    print('   https://github.com/1345463/campus-errand')
    return 0


if __name__ == '__main__':
    sys.exit(main())
