/**
 * 本地校验：微信开发者工具上传前能自己发现的问题
 *   1) app.json 里注册的页面，四件套文件是否齐全
 *   2) WXML 里 bind/catch 的方法，JS 里是否真的定义了
 *   3) WXML 用到的 class，app.wxss 或页面 wxss 里是否有样式
 * 用法：node verify-mp.js
 */
const fs = require('fs')
const path = require('path')

// 这个脚本是开发工具，故意放在小程序包外面，避免被打包进上传产物
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
const appCss = fs.readFileSync(path.join(root, 'app.wxss'), 'utf8')

function collectCssClasses(css) {
  const set = new Set()
  let m
  const re = /\.([A-Za-z0-9_-]+)/g
  while ((m = re.exec(css))) set.add(m[1])
  return set
}

const appClasses = collectCssClasses(appCss)

let problems = 0

console.log('=== 1) 页面文件完整性 ===')
app.pages.forEach(function (p) {
  const base = path.join(root, p)
  ;['.js', '.json', '.wxml'].forEach(function (ext) {
    if (!fs.existsSync(base + ext)) {
      problems += 1
      console.log('  缺失文件', p + ext)
    }
  })
})

console.log('=== 2) WXML 事件方法是否在 JS 中定义 ===')
app.pages.forEach(function (p) {
  const jsPath = path.join(root, p + '.js')
  const wxmlPath = path.join(root, p + '.wxml')
  if (!fs.existsSync(jsPath) || !fs.existsSync(wxmlPath)) return
  const js = fs.readFileSync(jsPath, 'utf8')
  const wm = fs.readFileSync(wxmlPath, 'utf8')
  const names = new Set()
  let m
  const re = /(?:bind|catch|capture-bind|capture-catch):?[a-zA-Z]+\s*=\s*"([^"]+)"/g
  while ((m = re.exec(wm))) {
    m[1]
      .split(/\s+/)
      .forEach(function (n) {
        if (n) names.add(n)
      })
  }
  names.forEach(function (n) {
    // 形如 `name: function` 或 `name(`（简写方法）或字符串里出现过
    const defined =
      new RegExp('(^|[\\s,{])' + n + '\\s*:\\s*function', 'm').test(js) ||
      new RegExp('(^|[\\s,{])' + n + '\\s*\\(', 'm').test(js) ||
      js.indexOf("'" + n + "'") >= 0 ||
      js.indexOf('"' + n + '"') >= 0
    if (!defined) {
      problems += 1
      console.log('  未定义方法', p, '->', n)
    }
  })
})

console.log('=== 3) WXML 用到的 class 是否有样式 ===')
app.pages.forEach(function (p) {
  const wxmlPath = path.join(root, p + '.wxml')
  if (!fs.existsSync(wxmlPath)) return
  const ownPath = path.join(root, p + '.wxss')
  const own = fs.existsSync(ownPath) ? collectCssClasses(fs.readFileSync(ownPath, 'utf8')) : new Set()
  const wm = fs.readFileSync(wxmlPath, 'utf8')
  const missing = new Set()
  let m
  const cre = /class="([^"]*)"/g
  while ((m = cre.exec(wm))) {
    m[1].trim().split(/\s+/).forEach(function (raw) {
      const c = raw.trim()
      if (!c) return
      if (c.indexOf('{{') >= 0) {
        // 动态 class：把里面出现的字符串字面量都当作可能的类名
        const dyn = c.match(/'([A-Za-z0-9_-]+)'/g) || []
        dyn.forEach(function (d) {
          const k = d.replace(/'/g, '')
          if (!appClasses.has(k) && !own.has(k)) missing.add(k)
        })
        const base = c.split('{{')[0].trim()
        if (base && !appClasses.has(base) && !own.has(base)) missing.add(base)
        return
      }
      if (!appClasses.has(c) && !own.has(c)) missing.add(c)
    })
  }
  if (missing.size) {
    // 状态类（status-xxx）是数据驱动的，允许缺失；其余的报出来仅供参考
    const real = Array.from(missing).filter(function (c) {
      return c.indexOf('status-') !== 0
    })
    if (real.length) console.log('  ' + p + ' -> ' + real.join(', '))
  }
})

console.log('----')
console.log(problems === 0 ? '校验通过：没有致命问题' : '发现 ' + problems + ' 个必须修的问题')

process.exitCode = problems ? 1 : 0
