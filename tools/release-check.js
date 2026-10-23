const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const root = path.resolve(__dirname, '..')
require('./release-config').assertReleaseConfig(root)
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}
function syntax(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules','miniprogram_npm','.git'].includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) syntax(full)
    else if (entry.name.endsWith('.js')) run(['--check', full])
  }
}
syntax(root)
run(['tools/verify-mp.js', root])
run(['--experimental-vm-modules', 'tools/check-mp.js', root])
run(['tools/style-lint.js', root])
run(['--test', ...fs.readdirSync(path.join(root, 'tests')).filter(f => f.endsWith('.test.js')).map(f => 'tests/' + f)])
