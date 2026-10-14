const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram')
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics')
const config = require('./config')

const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: config.endpoint,
  publishableKey: config.publishableKey,
  wx: createDiagnosticWx(wx),
})

module.exports = { cloud }
