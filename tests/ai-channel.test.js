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
const SQL2_PATH = path.join(ROOT, '..', 'cloudbase', 'migrations', '20261030160000_ai_runtime_config_rename.sql')
const sql = fs.existsSync(SQL_PATH) ? fs.readFileSync(SQL_PATH, 'utf8') : ''
const sql2 = fs.existsSync(SQL2_PATH) ? fs.readFileSync(SQL2_PATH, 'utf8') : ''
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

test('读密钥的函数叫 svc_ai_runtime_config，旧名已 DROP，且只 GRANT service_role', () => {
  assert.ok(sql2, '迁移文件不存在：cloudbase/migrations/20261030160000_ai_runtime_config_rename.sql')
  // 旧名必须删掉：留着就等于「svc_rpc 能把它转发出去」
  assert.match(sql2, /DROP FUNCTION IF EXISTS public\.ai_runtime_config\(\)/)
  assert.match(sql2, /CREATE FUNCTION public\.svc_ai_runtime_config\(\)/)
  assert.match(sql2, /REVOKE ALL ON FUNCTION public\.svc_ai_runtime_config\(\)\s*FROM PUBLIC,\s*anon,\s*authenticated/)
  assert.match(sql2, /GRANT EXECUTE ON FUNCTION public\.svc_ai_runtime_config\(\) TO service_role/)
})

test('读密钥的 RPC 一律 svc_ 前缀 —— 否则 svc_rpc 会把它原样转发给客户端', () => {
  // app-api 的 rpc 入口只挡「svc_ 前缀」和一份人工维护的 SERVER_ONLY_FNS 名单，
  // 而 svc_rpc 是 service_role 身份 EXECUTE 的，函数里的 GRANT 对它完全无效。
  // 所以「不带 svc_ 前缀 + 没做权限校验」的读密钥函数 = 明文密钥对全体登录用户开放。
  const paths = aiApi.match(/\/v1\/rdb\/rest\/rpc\/[a-z_]+/g) || []
  assert.ok(paths.length > 0, 'ai-api 应该至少有一条读库 RPC')
  paths.forEach((p) => {
    const fn = p.split('/').pop()
    assert.strictEqual(fn.indexOf('svc_'), 0, '读密钥的 RPC 必须以 svc_ 开头，当前：' + fn)
  })
  assert.match(aiApi, /\/v1\/rdb\/rest\/rpc\/svc_ai_runtime_config/)
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

test('云函数从 svc_ai_runtime_config 读通道，走的是和 app-api 同一条网关', () => {
  assert.match(aiApi, /\/v1\/rdb\/rest\/rpc\/svc_ai_runtime_config/)
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

test('换通道后模型名自动跟随，否则 ai_model 还停在 hy3 → 必然 404', () => {
  assert.match(faqJs, /syncModel: function/)
  const save = faqJs.slice(faqJs.indexOf('saveChannel: function'))
  assert.match(save.slice(0, 1600), /page\.syncModel\(\)/)
  const clear = faqJs.slice(faqJs.indexOf('clearChannel: function'))
  assert.match(clear.slice(0, 1200), /page\.syncModel\(\)/)
  // 比较基准必须是「已保存的 ai_model」，不能拿当前选中值跟自己比
  const sync = faqJs.slice(faqJs.indexOf('syncModel: function'))
  assert.match(sync.slice(0, 500), /picked === page\.data\.aiModel/)
})

// ---- R58 补丁3：ok 字段漏写导致「暂无可用模型」 ----
//
// 踩坑记录：models / chat 两个成功分支原本 return done({ models, ... })，
// 没有 ok 字段。前端 utils/tcb.js 的 viaGateway 只认 data.ok，
// 于是「成功响应」被判成失败整份丢掉，表现是后台一直显示「暂无可用模型」，
// 而且连报错都没有 —— 因为它不是失败，是成功被当成失败。
// 所以这里不逐条写死，而是扫全部 done() 调用，缺 ok 直接失败。

test('ai-api 里每个 done({...}) 都必须显式带 ok 字段', () => {
  const re = /return done\(\{/g
  let m = null
  let n = 0
  while ((m = re.exec(aiApi)) !== null) {
    n += 1
    const seg = aiApi.slice(m.index, m.index + 300)
    assert.ok(
      /ok:\s*(?:true|false)/.test(seg),
      '第 ' + n + ' 个 done() 漏了 ok 字段，前端会把这整份响应当失败丢掉：' + seg.slice(0, 120)
    )
  }
  assert.ok(n >= 2, '至少要扫到 2 个 done()（models 与 chat 的成功分支），实际 ' + n)
})

test('models 成功响应带 ok:true，并回报手写清单是否过期', () => {
  const seg = aiApi.slice(aiApi.indexOf("if (action === 'models')"))
  assert.match(seg.slice(0, 2200), /ok:\s*true/)
  assert.match(seg.slice(0, 2200), /modelsStale/)
})

test('chat 成功响应带 ok:true，否则客服页会把答出来的结果当失败降级', () => {
  const seg = aiApi.slice(aiApi.indexOf("if (action === 'chat')"))
  assert.match(seg.slice(0, 2600), /done\(\{\s*ok:\s*true,\s*text:/)
})

test('llmCatalog 不会把「漏 ok」的响应静默当成空目录', () => {
  const fn = apiJs.slice(apiJs.indexOf('async function llmCatalog'))
  assert.match(fn.slice(0, 900), /res\.ok === false/)
  assert.match(fn.slice(0, 900), /throw new Error/)
})

test('后台发现手写模型名与真实 id 不符时，静默纠正库里的清单', () => {
  assert.match(faqJs, /cat\.modelsStale/)
  assert.match(faqJs, /adminSetAiChannel\(\{ models: picker\.modelIds\[0\] \}\)/)
})

test('探测到真实模型列表时以它为准，手写清单只作兜底', () => {
  const seg = aiApi.slice(aiApi.indexOf("if (action === 'models')"))
  const body = seg.slice(0, 2200)
  assert.match(body, /if \(ids\.length\)/)
  assert.match(body, /models = ids\.map/)
  // 探测失败才用 probeErr 兜底，不能因为探测失败就清空列表
  assert.match(body, /probeErr/)
})
