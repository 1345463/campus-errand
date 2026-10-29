/**
 * 手机号验证码（R55）回归测试
 *
 * 背景：短信通道（腾讯云 SMS）需要 5 个环境变量，一个没配满就发不出短信。
 * 之前的处理是「一律拒绝」，结果连管理员自己都绑不了号，整条链路走不通。
 *
 * 这里钉死四件事：
 *   ① 短信没开通时，绝不能假装发送成功（用户收不到，还白占额度）
 *   ② 只有超级管理员能走「明文回显」的调试通道，且必须现查 admin_my_perms
 *   ③ 短信一旦配好，明文码绝不能出现在响应里（这条是安全底线）
 *   ④ 前端拿到回显的码要自动填入，别让人再去别处找
 *
 * 云函数依赖 https 与环境变量，起不来实例，所以用源码特征验证。
 */
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const API_PATH = path.join(__dirname, '..', 'cloudfunctions', 'app-api', 'index.js')
const UTIL_PATH = path.join(__dirname, '..', 'utils', 'api.js')
const PAGE_PATH = path.join(__dirname, '..', 'pages', 'mine', 'bind-phone.js')
const WXML_PATH = path.join(__dirname, '..', 'pages', 'mine', 'bind-phone.wxml')

const src = fs.readFileSync(API_PATH, 'utf8')
const utilSrc = fs.readFileSync(UTIL_PATH, 'utf8')
const pageSrc = fs.readFileSync(PAGE_PATH, 'utf8')
const wxml = fs.readFileSync(WXML_PATH, 'utf8')

test('短信没开通时不能假装发码：先判配置，不通就拒', () => {
  const seg = src.slice(src.indexOf("if (action === 'sendPhoneCode')"))
  const send = seg.slice(0, seg.indexOf("if (action === 'bindPhone')"))
  assert.ok(/const smsOn = smsConfigured\(\)/.test(send), '要先取一次短信配置状态')
  assert.ok(/SMS_NOT_CONFIGURED/.test(send), '未开通要返回明确的错误码，不能 ok:true')
  assert.ok(/issue_phone_code/.test(send), '生成码的业务函数还在')
})

test('调试通道只对超管开放，且必须现场查权限', () => {
  assert.ok(/async function isSuperAdmin\(uid\)/.test(src), '要有独立的超管判断')
  assert.ok(/svcRpc\(uid, 'admin_my_perms', \{\}\)/.test(src), '必须查 admin_my_perms，不能信客户端声明')
  assert.ok(/perm_key/.test(src) && /=== 'super'/.test(src), '要认 perm_key 里的 super')
  // 关键顺序：非超管在发码之前就被挡掉，不能先发码再决定给不给看
  const seg = src.slice(src.indexOf("if (action === 'sendPhoneCode')"))
  const send = seg.slice(0, seg.indexOf("if (action === 'bindPhone')"))
  assert.ok(send.indexOf('isSuperAdmin') < send.indexOf('issue_phone_code'), '权限判断必须早于生成验证码')
})

test('短信开通后绝不回显明文验证码', () => {
  const seg = src.slice(src.indexOf("if (action === 'sendPhoneCode')"))
  const send = seg.slice(0, seg.indexOf("if (action === 'bindPhone')"))
  assert.ok(/if \(smsOn\) \{\s*[\s\S]*?await sendSms\(phone, code\)\s*[\s\S]*?return done\(\{ ok: true \}\)\s*\}/.test(send), '走短信时只回 ok:true')
  // devCode 只能出现在 smsOn 为假的分支后面
  const at = send.indexOf('devCode')
  assert.ok(at > 0, '存在 devCode 分支')
  assert.ok(/if \(smsOn\) \{[\s\S]*?return done\(\{ ok: true \}\)[\s\S]*?\}[\s\S]*?devCode/.test(send), 'devCode 必须在正常短信分支 return 之后')
})

test('调试通道不做成开关：条件就是「短信没配好」，配好自动失效', () => {
  // 一旦引入 SMS_DEV_ECHO 之类的开关，就会有人忘了关，所以这里反向钉死
  assert.ok(!/SMS_DEV_ECHO|DEV_MODE|debugMode/.test(src), '不要额外引入调试开关，用「短信未配置」本身当条件')
})

test('前端把回显的码自动填进输入框', () => {
  assert.ok(/devEcho: res\.devEcho === true/.test(utilSrc), 'api 层要把 devEcho 透传出来')
  assert.ok(/devCode: res\.devCode/.test(utilSrc), 'api 层要把明文码透传出来')
  assert.ok(/res\.devEcho && res\.devCode/.test(pageSrc), '页面要判断回显')
  assert.ok(/code: res\.devCode/.test(pageSrc), '要自动填入，不能只提示')
  assert.ok(/devHint/.test(pageSrc) && /devHint/.test(wxml), '页面要说明当前走的是调试通道')
})

test('页面样式：调试提示不能用报错红', () => {
  const wxss = fs.readFileSync(path.join(__dirname, '..', 'pages', 'mine', 'bind-phone.wxss'), 'utf8')
  const at = wxss.indexOf('.bp-dev-hint')
  assert.ok(at >= 0, '要有独立的提示样式')
  const block = wxss.slice(at, wxss.indexOf('}', at))
  assert.ok(!/#d93025/.test(block), '调试提示不是错误，别用报错红')
})
