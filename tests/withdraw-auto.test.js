/**
 * 提现自动转账（R54）回归测试
 *
 * 背景：一度出现「申请提现后没人打款」，根因是转账必须由管理员在后台点一下。
 * 现在改成服务端自动打款，这里把三件事钉死：
 *   ① 默认打开自动转账（环境变量没配也是开）
 *   ② 超过单笔上限的单不自动打款，留给人工
 *   ③ create 成功后会真的去调转账服务，summary 会补转卡在 pending 的旧单
 *
 * 云函数是 CommonJS + 依赖 https，不能直接 require 起来跑网络，
 * 所以这里用源码特征 + 抽出纯函数求值的方式验证。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC_PATH = path.join(__dirname, '..', 'cloudfunctions', 'withdraw-api', 'index.js')
const WALLET_PATH = path.join(__dirname, '..', 'pages', 'mine', 'wallet.js')
const src = fs.readFileSync(SRC_PATH, 'utf8')

// 抽出 canAuto 与其依赖的两个常量，在沙箱里求值
function makeCanAuto(env) {
  const sandbox = { process: { env: env } }
  const m = src.match(/const AUTO_TRANSFER = [^\n]+\nconst AUTO_MAX = [^\n]+\n/)
  assert.ok(m, '源码里应有 AUTO_TRANSFER / AUTO_MAX 两个常量')
  const fnMatch = src.match(/function canAuto\(amount\) \{[\s\S]*?\n\}/)
  assert.ok(fnMatch, '源码里应有 canAuto 判定函数')
  vm.createContext(sandbox)
  vm.runInContext(m[0] + '\n' + fnMatch[0], sandbox)
  return sandbox.canAuto
}

test('默认开启自动转账，且上限默认 200 元', () => {
  const canAuto = makeCanAuto({})
  assert.equal(canAuto(10), true, '没配环境变量时，小额应自动转账')
  assert.equal(canAuto(200), true, '默认上限 200 元，正好 200 也算小额')
  assert.equal(canAuto(200.01), false, '超过默认上限的不自动打款')
})

test('AUTO_TRANSFER=0 时全部转人工，AUTO_TRANSFER_MAX 可覆盖上限', () => {
  assert.equal(makeCanAuto({ AUTO_TRANSFER: '0' })(1), false, '关掉开关后任何金额都不自动转')
  const canAuto = makeCanAuto({ AUTO_TRANSFER_MAX: '50' })
  assert.equal(canAuto(50), true)
  assert.equal(canAuto(50.01), false)
})

test('create 成功后会自动打款，且失败不影响申请本身', () => {
  const body = src.slice(src.indexOf("if (action === 'create')"), src.indexOf("if (action === 'list')"))
  assert.ok(/auto\s*=\s*await doTransfer\(wdId\)/.test(body), 'create 分支应在成功后自动转账')
  assert.ok(/wdId && SVC_HOST && canAuto\(amount\)/.test(body), '自动转账要过开关与上限判断')
  assert.ok(/ok:\s*true/.test(body) && /auto:\s*auto/.test(body), '结果里要带上 auto，失败也照常返回申请成功')
})

test('summary 会补转卡在 pending 的旧单', () => {
  const body = src.slice(src.indexOf("if (action === 'summary')"), src.indexOf("// 提交提现申请"))
  assert.ok(/status === 'pending'/.test(body), '应筛出 pending 的单')
  assert.ok(/doTransfer\(Number\(stuck\[0\].id\)\)/.test(body), '应对这批单触发转账')
  assert.ok(/rest\('GET', wpath\)/.test(body.slice(body.indexOf('doTransfer(Number'))), '转完应重查一次记录')
})

test('转账入口复用同一份实现（后台重试与自动打款不两套逻辑）', () => {
  const transferBody = src.slice(src.indexOf("if (action === 'transfer')"))
  assert.ok(/const r = await doTransfer\(id\)/.test(transferBody), '后台手动转账应复用 doTransfer')
  assert.ok(!/httpsJson\(SVC_HOST/.test(transferBody.split('}')[0]), '不应再内联一份转账请求')
})

test('钱包页提交后提示自动转账结果', () => {
  const wallet = fs.readFileSync(WALLET_PATH, 'utf8')
  assert.ok(/WAIT_USER_CONFIRM/.test(wallet), '前端应区分「已发起、待确认收款」')
  assert.ok(/自动转账未成功/.test(wallet), '自动转账失败时应如实提示而不是只说提交成功')
})
