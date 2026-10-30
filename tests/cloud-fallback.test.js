/**
 * 云开发兜底通道的降级边界（10-30 运维补丁）
 *
 * 背景：小程序把云开发资源授权给服务商（WorkBuddy 托管）之后，管理员在开发者工具里
 * 就用不了云开发 —— 报 `-601034 没有权限，请先开通云开发或者云托管`，
 * `baozi-d2gbl784gd773f8b6` 这个环境随之不可用。此时唯一能走的通道是直连 CloudBase 网关，
 * 所以这三条边界必须钉住：
 *   1. `wx.cloud.init` 失败绝不能挡住 App 启动（否则整包白屏）
 *   2. 兜底通道的错误要翻成人话，别把 -601034 原样弹给用户
 *   3. 通道切换只能发生在网络层失败 —— 业务错误换通道会重复下单 / 重复扣款
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const appJs = read('app.js')
const tcbJs = read('utils/tcb.js')

test('wx.cloud.init 被 try/catch 包住，初始化失败不阻断启动', () => {
  assert.match(appJs, /if\s*\(wx\.cloud\)\s*\{\s*try\s*\{[\s\S]{0,240}wx\.cloud\.init/)
  assert.match(appJs, /catch\s*\(e\)/)
})

test('全局记录 cloudReady：默认 false，init 成功后置 true', () => {
  assert.match(appJs, /cloudReady:\s*false/)
  assert.match(appJs, /cloudReady\s*=\s*true/)
})

test('不再宣称「支付功能将无法使用」—— 支付走云函数，与 wx.cloud 无关', () => {
  assert.strictEqual(appJs.indexOf('支付功能将无法使用'), -1)
})

test('-601034（云开发被服务商代持）翻成可读提示，并指向真正的解法', () => {
  assert.match(tcbJs, /-601034/)
  assert.match(tcbJs, /request 合法域名/)
})

test('环境不存在（-601003 / env not exist）单独提示', () => {
  assert.match(tcbJs, /-601003/)
})

test('只有网络层失败才切通道，业务错误直接抛出（避免重复下单）', () => {
  assert.match(tcbJs, /if\s*\(!err\._network\)\s*\{[\s\S]{0,80}reject\(err\)/)
})
