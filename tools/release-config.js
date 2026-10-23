const path = require('path')

function assertReleaseConfig(root) {
  const file = path.resolve(root, 'utils/config.js')
  delete require.cache[require.resolve(file)]
  const config = require(file)
  const preset = config.presetAccount || {}
  if (config.rememberPassword !== false || config.autoLogin !== false || preset.phone || preset.password) {
    throw new Error('发布被阻止：必须关闭密码缓存和密码自动登录，并清空预置账号')
  }
}
module.exports = { assertReleaseConfig }
