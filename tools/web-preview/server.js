const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '../..')
const port = Number(process.env.CAMPUS_PREVIEW_PORT || 4317)
const pages = ['orders/list','hall/index','order/create','order/detail','mine/support','mine/index','mine/settings','admin/dashboard']
function bundle() {
  const modules = {}
  for (const name of fs.readdirSync(path.join(root, 'utils'))) {
    if (!name.endsWith('.js') || ['api.js','cloud.js','upload.js','workbuddy-cloud-diagnostics.js'].includes(name)) continue
    modules['utils/' + name] = fs.readFileSync(path.join(root, 'utils', name), 'utf8')
  }
  const templates = {}, styles = {}
  for (const page of pages) {
    const key = 'pages/' + page
    modules[key + '.js'] = fs.readFileSync(path.join(root, key + '.js'), 'utf8')
    templates[key] = fs.readFileSync(path.join(root, key + '.wxml'), 'utf8')
    styles[key] = fs.readFileSync(path.join(root, key + '.wxss'), 'utf8')
  }
  return {modules, templates, styles, appCss: fs.readFileSync(path.join(root, 'app.wxss'), 'utf8')}
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + port)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (url.pathname === '/preview-admin/activate' && req.method === 'POST') {
    const origin = req.headers.origin
    if (origin && origin !== 'http://127.0.0.1:' + port) {res.statusCode=403;return res.end('Forbidden')}
    let body = ''
    req.on('data', chunk => {body += chunk; if (body.length > 1024) req.destroy()})
    req.on('end', () => {
      try {
        const sql = fs.readFileSync(path.join(root,'sql/restore-admin-password.sql'),'utf8')
        const setting = sql.match(/VALUES\(1,'([a-f0-9]+)',\s*'([a-f0-9]+)'\)/)
        if (!setting) throw new Error('Missing test configuration')
        const code = String(JSON.parse(body).code || '').trim()
        const digest = crypto.createHash('sha256').update(setting[1]+':'+code).digest('hex')
        const ok = crypto.timingSafeEqual(Buffer.from(digest),Buffer.from(setting[2]))
        res.setHeader('Content-Type','application/json; charset=utf-8')
        res.end(JSON.stringify({ok}))
      } catch {res.statusCode=400;res.end('{"ok":false}')}
    })
    return
  }
  if (url.pathname === '/bundle.json') {
    res.setHeader('Content-Type','application/json; charset=utf-8')
    return res.end(JSON.stringify(bundle()))
  }
  if (url.pathname === '/fixture.svg') {
    res.setHeader('Content-Type','image/svg+xml')
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240"><rect width="360" height="240" fill="#dbeafe"/><path d="M90 150 L180 70 L270 150" fill="none" stroke="#2563eb" stroke-width="12"/><text x="180" y="205" text-anchor="middle" font-size="24">送达佐证 · 测试图片</text></svg>')
  }
  const files = {'/':'index.html','/frame':'frame.html','/runtime.js':'runtime.js'}
  if (!files[url.pathname]) {res.statusCode=404;return res.end('Not found')}
  res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8')
  res.end(fs.readFileSync(path.join(__dirname,files[url.pathname])))
})
server.listen(port,'127.0.0.1',()=>console.log('Local mini-program browser adapter: http://127.0.0.1:' + port))
