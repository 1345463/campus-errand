/**
 * 大模型通道可配置（R58）
 *
 * 背景：智能客服原本只有云开发内置的 hy3 通道，额度用完就哑了。
 * 现在允许后台接第三方 OpenAI 兼容服务（DeepSeek / 通义 / Kimi / 自建）。
 *
 * 这一层最容易出事的是**密钥泄露**，所以三条边界必须钉死：
 *   1. 密钥只落 ai_secrets 这一张表，且该表 RLS 零 policy ——
 *      anon / authenticated 直连一律读不到（已用真实 PG 验过：0 行 + 42501）
 *   2. 后台读接口只回「有没有 key」和末四位，绝不回明文
 *   3. 读密钥的函数只 GRANT service_role，客户端够不着
 *
 * 另外两条业务边界：
 *   4. base 和 key 必须同时存在才算启用自定义通道 —— 只填一半时退回内置通道，
 *      比报「没配通道」友好
 *   5. 内置通道没有 /models 路由（会被当模型名报 403），第三方有 ——
 *      所以只有 custom 才去真探测，探测失败退回手写清单
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const SQL_PATH = path.join(ROOT, '..', 'cloudbase', 'migrations', '20261030150000_ai_channel_config.sql')
const sql = fs.existsSync(SQL_PATH) ? fs.readFileSync(SQL_PATH, 'utf8') : ''
const aiApi = read('cloudfunctions/ai-api/index.js')
const apiJs = read('utils/api.js')
const faqWxml = read('pages/admin/faq.wxml')
const faqJs = read('pages/admin/faq.js')

test('迁移建了 ai_secrets 表，且开着 RLS', () => {
  assert.ok(sql, '迁移文件不存在：cloudbase/migrations/20261030150000_ai_channel_config.sql')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.ai_secrets/)
  assert.match(sql, /ALTER TABLE public\.ai_secrets ENABLE ROW LEVEL SECURITY/)
})

test('ai_secrets 一条 policy 都不建 —— 开了 RLS 且零 policy 才是真关闭', () => {
  // 只要出现 CREATE POLICY，anon / authenticated 就可能拿到 SELECT，密钥就漏了
  assert.strictEqual(
    /CREATE\s+POLICY/i.test(sql),
    false,
    'ai_secrets 不能有任何 policy：后台读走 admin_get_ai_channel，云函数读走 ai_runtime_config'
  )
})

test('ai_runtime_config 只 GRANT 给 service_role，客户端调不动', () => {
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.ai_runtime_config\(\)\s*FROM PUBLIC,\s*anon,\s*authenticated/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.ai_runtime_config\(\) TO service_role/)
})

test('后台读接口只回末四位，RETURNS TABLE 里没有明文 api_key 列', () => {
  assert.match(sql, /right\(btrim\(s\.api_key\),\s*4\)/)
  // RETURNS TABLE 里出现 api_key 列就等于把明文送出去
  assert.strictEqual(
    /RETURNS TABLE \([^)]*api_key/.test(sql),
    false,
    'admin_get_ai_channel 不能返回 api_key 列'
  )
})

test('后台写接口要校 admin_has_perm、要卡 https、NULL 表示不修改', () => {
  const fn = sql.slice(sql.indexOf('FUNCTION public.admin_set_ai_channel'))
  assert.match(fn, /admin_has_perm\('support'\)/)
  assert.match(fn, /\^https:\/\//)
  // 三个参数都是 COALESCE 语义：NULL 不动，空串才清空
  assert.match(fn, /WHEN p_base_url\s+IS NULL THEN s\.base_url/)
  assert.match(fn, /WHEN p_api_key\s+IS NULL THEN s\.api_key/)
})

test('云函数从 ai_runtime_config 读通道，走的是和 app-api 同一条网关', () => {
  assert.match(aiApi, /\/v1\/rdb\/rest\/rpc\/ai_runtime_config/)
  assert.match(aiApi, /TCB_ENV \+ '\.api\.tcloudbasegateway\.com'/)
})

test('通道配置有 TTL 缓存，且拉模型列表时强制刷新', () => {
  assert.match(aiApi, /CHANNEL_TTL_MS/)
  assert.match(aiApi, /resolveChannel\(action === 'models'\)/)
})

test('base 和 key 必须同时存在才算自定义通道，只填一半退回内置', () => {
  assert.match(aiApi, /if \(dbBase && dbKey\)/)
})

test('只有自定义通道才探测 /models —— 内置通道没有这个路由', () => {
  assert.match(aiApi, /if \(ch\.custom\) \{[\s\S]{0,400}'\/models'/)
})

test('402 余额不足有专属文案（DeepSeek 用这个码）', () => {
  assert.match(aiApi, /status === 402/)
  assert.match(aiApi, /余额不足/)
})

test('前端导出通道读写方法，llmModels 仍返回数组', () => {
  assert.match(apiJs, /async function adminGetAiChannel\(\)/)
  assert.match(apiJs, /async function adminSetAiChannel\(patch\)/)
  assert.match(apiJs, /adminGetAiChannel: adminGetAiChannel/)
  assert.match(apiJs, /adminSetAiChannel: adminSetAiChannel/)
  assert.match(apiJs, /llmCatalog: llmCatalog/)
  const fn = apiJs.slice(apiJs.indexOf('async function llmModels'))
  assert.match(fn.slice(0, 200), /return info\.models/)
})

test('后台页面有通道卡片，密钥输入框是 password', () => {
  assert.match(faqWxml, /大模型通道/)
  assert.match(faqWxml, /bindinput="onChannelBaseInput"/)
  assert.match(faqWxml, /bindinput="onChannelKeyInput"/)
  assert.match(faqWxml, /password="\{\{true\}\}"/)
  assert.match(faqWxml, /bindtap="saveChannel"/)
})

test('保存通道时 key 留空不会覆盖已存的 key', () => {
  const fn = faqJs.slice(faqJs.indexOf('saveChannel: function'))
  assert.match(fn.slice(0, 1400), /if \(typedKey\) patch\.api_key = typedKey/)
})

test('退回内置通道时显式传空串（传 null 是「不修改」）', () => {
  const fn = faqJs.slice(faqJs.indexOf('clearChannel: function'))
  assert.match(fn.slice(0, 900), /base_url: '', api_key: '', models: ''/)
})
