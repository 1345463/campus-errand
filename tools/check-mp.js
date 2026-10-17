// 微信小程序上传预检（模拟微信 CI / Babel 的编译前检查）
//
// 关键点：微信 CI 用 Babel 把每个 .js 当 ES Module 解析。在 Module 顶层，函数声明属于
// 词法声明，同名重复声明会直接在编译阶段报
//   "Identifier 'xxx' has already been declared"
// 而 `node --check` 默认按非严格 Script 解析（顶层函数是 var 作用域），重复声明合法，
// 所以常规自检会漏掉，等到上传时才炸。这里用 vm.SourceTextModule 做真正的 ESM 解析。
//
// 用法：node --experimental-vm-modules check-mp.js <小程序目录>

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = process.argv[2] || '.'
const SKIP_DIRS = new Set(['node_modules', 'miniprogram_npm', '.git', 'sql', 'tests'])

const problems = []
function fail(file, msg) {
  problems.push(file + ' → ' + msg)
}

function walk(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(full, out)
    } else if (e.isFile()) {
      out.push(full)
    }
  }
  return out
}

const allFiles = walk(ROOT, [])
const jsFiles = allFiles.filter((f) => f.endsWith('.js'))

// ---------- 1. JS：ESM 严格解析 ----------
for (const f of jsFiles) {
  let src
  try {
    src = fs.readFileSync(f, 'utf8')
  } catch (e) {
    fail(f, '读取失败: ' + e.message)
    continue
  }
  try {
    new vm.SourceTextModule(src, { identifier: f })
  } catch (err) {
    if (err instanceof SyntaxError) {
      fail(f, err.message)
    } else {
      fail(f, '非语法错误: ' + err.message)
    }
  }
}

// ---------- 2. JSON：可解析 ----------
for (const f of allFiles.filter((x) => x.endsWith('.json'))) {
  try {
    JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch (e) {
    fail(f, 'JSON 解析失败: ' + e.message)
  }
}

// ---------- 3. WXML：标签配对 + id 唯一 ----------
const VOID_TAGS = new Set(['image', 'input', 'icon', 'import', 'include', 'wxs', 'slot', 'br'])
for (const f of allFiles.filter((x) => x.endsWith('.wxml'))) {
  const src = fs.readFileSync(f, 'utf8')
  const stack = []
  const re = /<(\/?)([a-zA-Z][-a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  let m
  while ((m = re.exec(src))) {
    const closing = m[1] === '/'
    const tag = m[2]
    const selfClose = m[4] === '/'
    if (closing) {
      // <image></image> 这类「成对书写的空元素」是合法的，直接跳过，不能去弹栈
      if (VOID_TAGS.has(tag)) continue
      const top = stack.pop()
      if (top !== tag) {
        fail(f, '标签未正确闭合：期望 </' + top + '>，实际 </' + tag + '>')
      }
    } else if (!selfClose && !VOID_TAGS.has(tag)) {
      stack.push(tag)
    }
  }
  if (stack.length) fail(f, '标签未闭合: ' + stack.join(' > '))

  const ids = {}
  const idRe = /\sid="([^"]*)"/g
  let im
  while ((im = idRe.exec(src))) {
    if (ids[im[1]]) fail(f, 'id 重复: "' + im[1] + '"（WXML 内 id 必须唯一）')
    ids[im[1]] = true
  }
}

// ---------- 4. app.json 引用的页面/组件必须存在 ----------
const appJsonPath = path.join(ROOT, 'app.json')
if (fs.existsSync(appJsonPath)) {
  let app
  try {
    app = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'))
  } catch (e) {
    fail(appJsonPath, 'app.json 解析失败: ' + e.message)
  }
  if (app) {
    const norm = (x) => path.relative(ROOT, x).split(path.sep).join('/')
    const known = new Set(allFiles.map(norm))
    for (const p of app.pages || []) {
      const base = p.replace(/\/$/, '')
      if (!known.has(base + '.js')) fail(appJsonPath, 'pages 引用的页面缺少 .js: ' + p)
      if (!known.has(base + '.wxml')) fail(appJsonPath, 'pages 引用的页面缺少 .wxml: ' + p)
    }
    for (const t of (app.tabBar && app.tabBar.list) || []) {
      if (!(app.pages || []).includes(t.pagePath)) {
        fail(appJsonPath, 'tabBar 页面不在 pages 中: ' + t.pagePath)
      }
    }
  }
}

// ---------- 5. 各页面 .json 里 usingComponents 指向的组件存在 ----------
for (const f of allFiles.filter((x) => x.endsWith('.json'))) {
  let conf
  try {
    conf = JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch (e) {
    continue
  }
  const uc = conf && conf.usingComponents
  if (!uc) continue
  for (const k of Object.keys(uc)) {
    const target = uc[k]
    if (!target.startsWith('/')) continue
    const base = path.join(ROOT, target.replace(/^\//, ''))
    const ok = ['.js', '.wxml', '.json'].every((ext) => fs.existsSync(base + ext))
    if (!ok) fail(f, 'usingComponents "' + k + '" 指向的组件文件缺失: ' + target)
  }
}

// ---------- 6. 包体积（主包 2MB 上限） ----------
// 上传时 node_modules 是否被排除，取决于打包配置，所以两种情况都算出来。
function sumSize(files) {
  let n = 0
  for (const f of files) {
    try {
      n += fs.statSync(f).size
    } catch (e) {
      /* ignore */
    }
  }
  return n
}
function walkAll(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walkAll(full, out)
    else if (e.isFile()) out.push(full)
  }
  return out
}

// 读取 project.config.json 的 packOptions.ignore，算出「真正会被上传」的文件集合
let ignoreRules = []
const pcPath = path.join(ROOT, 'project.config.json')
if (fs.existsSync(pcPath)) {
  try {
    ignoreRules = JSON.parse(fs.readFileSync(pcPath, 'utf8')).packOptions.ignore || []
  } catch (e) {
    fail(pcPath, 'project.config.json 解析失败: ' + e.message)
  }
}
function isIgnored(relPath, size) {
  const rel = relPath.split(path.sep).join('/')
  const isDir = size === undefined
  return ignoreRules.some((r) => {
    if (r.type === 'folder') return rel === r.value || rel.startsWith(r.value + '/')
    return rel === r.value
  })
}

const everyFile = walkAll(ROOT, [])
const uploaded = everyFile.filter((f) => !isIgnored(path.relative(ROOT, f)))
const withNm = everyFile.filter((f) => {
  const rel = path.relative(ROOT, f).split(path.sep).join('/')
  return !rel.startsWith('node_modules/')
})

const LIMIT = 2 * 1024 * 1024
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB'
const uploadSize = sumSize(uploaded)
const withoutNm = sumSize(withNm)
const sizeLine =
  '实际上传体积 = ' +
  mb(uploadSize) +
  '（' +
  uploaded.length +
  ' 个文件）/ 主包上限 2.00 MB'
if (uploadSize > LIMIT) {
  const top = uploaded
    .map((f) => ({ f: path.relative(ROOT, f), s: fs.statSync(f).size }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .map((x) => x.f + ' ' + mb(x.s))
  fail('包体积', mb(uploadSize) + ' 超出主包 2MB 限制，最大的几个：' + top.join('、'))
}
if (withoutNm > LIMIT) {
  fail('包体积', '即使排除 node_modules 也有 ' + mb(withoutNm) + '，超出主包 2MB 限制')
}

// ---------- 7. npm 依赖必须能在 miniprogram_npm 里解析到 ----------
// 上传包里不含 node_modules 时，require('包名/子路径') 靠 miniprogram_npm 解析；
// 缺了它，真机会直接报 module not found。
// 只扫"真正会被上传"的 JS：被 packOptions.ignore 排除的目录（sql/ docs/ tools/）
// 根本不进包，里面用 require('fs') 这类 Node 内置模块是完全正常的。
const jsUploaded = jsFiles.filter((f) => !isIgnored(path.relative(ROOT, f)))
for (const f of jsUploaded) {
  const src = fs.readFileSync(f, 'utf8')
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g
  let m
  while ((m = re.exec(src))) {
    const spec = m[1]
    if (spec.startsWith('.') || spec.startsWith('/')) continue
    const candidate = path.join(ROOT, 'miniprogram_npm', spec)
    const ok = fs.existsSync(candidate + '.js') || fs.existsSync(path.join(candidate, 'index.js'))
    if (!ok) {
      fail(
        f,
        "npm 依赖 '" +
          spec +
          "' 在 miniprogram_npm 中不存在 —— 需先构建 npm，或把产物放到 miniprogram_npm/" +
          spec +
          '.js'
      )
    }
  }
}

// ---------- 输出 ----------
console.log('扫描 JS ' + jsFiles.length + ' 个，其他文件 ' + (allFiles.length - jsFiles.length) + ' 个')
console.log(sizeLine)
console.log('----')
if (problems.length === 0) {
  console.log('预检通过：未发现会导致微信上传失败的问题')
  process.exit(0)
}
console.log('发现 ' + problems.length + ' 个问题：')
for (const p of problems) console.log('  ✗ ' + p)
process.exit(1)
