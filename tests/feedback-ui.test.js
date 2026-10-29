/**
 * 反馈/客服会话的三处 UI + 数据回归（R57）
 *
 * 这一轮修的三个问题都属于「改过一次、换个地方又犯」的类型，所以除了修代码，
 * 还要把判据写成断言，让下次有人再写歪时测试先炸：
 *   1. 气泡巨大间距 —— 类名撞上 app.wxss 全局命名空间
 *   2. 未读清不掉  —— feedback_mark_read 用 ELSIF 只更新一边
 *   3. 列表文字折断 —— 用全局 .detail-label（左侧写死 180rpx）
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const MIG_DIR = path.join(ROOT, '..', 'cloudbase', 'migrations')

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const appWxss = read('app.wxss')
const threadJs = read('pages/feedback/thread.js')
const threadWxss = read('pages/feedback/thread.wxss')
const threadWxml = read('pages/feedback/thread.wxml')
const fbWxml = read('pages/mine/feedback.wxml')
const fbWxss = read('pages/mine/feedback.wxss')

function migration(name) {
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.indexOf(name) >= 0)
  if (!files.length) return ''
  return fs.readFileSync(path.join(MIG_DIR, files[0]), 'utf8')
}

test('app.wxss 的页面命名空间一律带 pg- 前缀（裸 .mine 会把消息行撑成一屏高）', () => {
  // 历史事故：`.home, .mine { min-height: 100vh }`，而客服气泡行的 class 恰好叫 mine
  // → 每条自己发的消息 100vh 高，表现为「两句话中间空一大截」。
  assert.ok(!/^\.(home|mine|hall|orders)\s*[,{]/m.test(appWxss),
    '不能再出现裸的 .home/.mine/.hall/.orders 选择器')
  assert.ok(/\.pg-home,\s*\.pg-mine\s*\{\s*min-height:\s*100vh/.test(appWxss),
    '命名空间要统一成 pg- 前缀')
})

test('页面根节点用的是 pg- 前缀类名', () => {
  const roots = [
    ['pages/index/index.wxml', 'pg-home'],
    ['pages/mine/index.wxml', 'pg-mine'],
    ['pages/hall/index.wxml', 'pg-hall'],
    ['pages/orders/list.wxml', 'pg-orders'],
  ]
  for (const pair of roots) {
    const src = read(pair[0])
    assert.ok(src.indexOf('page ' + pair[1]) > 0, pair[0] + ' 根节点要用 ' + pair[1])
  }
})

test('工单会话气泡用 msg- 前缀，不裸用 mine/peer', () => {
  assert.ok(/align:\s*mine \? 'msg-mine' : 'msg-peer'/.test(threadJs),
    'align 必须带上 msg- 前缀')
  assert.ok(!/'mine' : 'peer'/.test(threadJs), '不能再回退到裸的 mine/peer')
  assert.ok(/\.msg-row\.msg-mine/.test(threadWxss) && /\.msg-row\.msg-peer/.test(threadWxss),
    'wxss 的对齐规则要跟着改名')
  assert.ok(!/\.msg-row\.(mine|peer)\b/.test(threadWxss), '不能残留裸的 .msg-row.mine')
})

test('会话 scroll-view 显式压高度为 0，否则 flex 分配不到正确高度', () => {
  // scroll-view 默认 height:auto 会被内容撑开，flex-grow 管不住它
  const block = threadWxss.slice(threadWxss.indexOf('.chat-scroll {'))
  const rule = block.slice(0, block.indexOf('}'))
  assert.ok(/height:\s*0/.test(rule), '.chat-scroll 要写 height: 0')
  assert.ok(/flex:\s*1/.test(rule), '.chat-scroll 仍要占满剩余空间')
})

test('反馈列表不用全局 .detail-label（左侧写死 180rpx 会把时间折断）', () => {
  assert.ok(!/class="detail-label"/.test(fbWxml), '列表行不能再用 detail-label')
  assert.ok(/class="fb-row"/.test(fbWxml), '要用本页专属的 fb-row')
  assert.ok(/wx:for-item="row"/.test(fbWxml), '循环要显式声明 for-item')
  assert.ok(/\.fb-main[\s\S]*?flex:\s*1[\s\S]*?min-width:\s*0/.test(fbWxss), '左侧可收缩')
  assert.ok(/\.fb-side[\s\S]*?flex:\s*none/.test(fbWxss), '右侧状态块不参与压缩')
})

test('标记已读：客服身份与提交人身份各自独立更新，不能用 ELSIF 二选一', () => {
  const sql = migration('feedback_unread_fix')
  assert.ok(sql, '要有对应的迁移脚本')
  const at = sql.indexOf('FUNCTION public.feedback_mark_read')
  const fn = sql.slice(at, sql.indexOf('$fn$;', at))
  assert.ok(fn.indexOf('ELSIF') === -1, 'ELSIF 会让「既是超管又是提交人」只更新一边')
  assert.ok(/admin_seen_at\s*=\s*CASE WHEN v_admin/.test(fn), '客服侧按权限更新')
  assert.ok(/user_seen_at\s*=\s*CASE WHEN v_row\.user_id = v_uid/.test(fn), '提交人侧按归属更新')
  // 两个 CASE 写在同一个 UPDATE 里，才能保证同时成立时两个都写
  const upd = fn.slice(fn.indexOf('UPDATE public.user_feedbacks'))
  assert.ok(upd.indexOf('admin_seen_at') > 0 && upd.indexOf('user_seen_at') > 0,
    '两个已读时间要在同一次 UPDATE 里更新')
})

test('未读数不把自己发的算进去', () => {
  const sql = migration('feedback_unread_fix')
  // 同一人既是提交人又有客服权限时，自己说的话 role 是 admin，会被算成「客服的新回复」
  const listAt = sql.indexOf('FUNCTION public.list_my_feedbacks')
  const list = sql.slice(listAt, sql.indexOf('$fn$;', listAt))
  assert.ok(/r\.user_id <> v_uid/.test(list), '我的反馈列表要排除自己发的')

  const adminAt = sql.indexOf('FUNCTION public.admin_list_user_feedbacks')
  const admin = sql.slice(adminAt, sql.indexOf('$fn$;', adminAt))
  assert.ok(/r\.user_id <> v_uid/.test(admin), '客服列表同样要排除自己发的')

  const detailAt = sql.indexOf('FUNCTION public.feedback_detail')
  const detail = sql.slice(detailAt, sql.indexOf('$fn$;', detailAt))
  assert.ok(/r\.user_id <> v_uid/.test(detail), '工单详情同样要排除自己发的')
  assert.ok(/CASE WHEN f\.user_id = v_uid THEN 'admin' ELSE 'user' END/.test(detail),
    '详情的未读口径要和列表一致（提交人看客服的，客服看提交人的）')
})

// ---- 智能客服的大模型通道（R57：修「无可用模型」）----
const AI_PATH = path.join(ROOT, 'cloudfunctions', 'ai-api', 'index.js')
const aiSrc = fs.existsSync(AI_PATH) ? fs.readFileSync(AI_PATH, 'utf8') : ''
const apiSrc = read('utils/api.js')
const tcbSrc = read('utils/tcb.js')
const proxySrc = read('cloudfunctions/tcb-proxy/index.js')

test('大模型通道不再是占位实现（不能返回空数组 / 直接抛错）', () => {
  assert.ok(aiSrc, 'cloudfunctions/ai-api/index.js 要存在')
  assert.ok(!/async function llmModels\(\)[\s\S]{0,200}return \[\]/.test(apiSrc),
    'llmModels 不能再硬返回空数组')
  assert.ok(!/智能客服正在迁移到新后端/.test(apiSrc), 'llmChat 不能再抛占位错误')
  assert.ok(/callTarget\('ai-api'/.test(apiSrc), '要走 ai-api 云函数')
})

test('密钥只留在云函数里，端上不碰', () => {
  const at = aiSrc.indexOf('exports.main')
  const head = aiSrc.slice(0, at)
  assert.ok(/process\.env\.TCB_AI_KEY/.test(head), 'AI 密钥从环境变量取')
  assert.ok(!/apiKey\s*[:=]\s*['"]/.test(aiSrc), '代码里不能出现硬编码密钥')
  // 端上那一层只允许带 action/model/messages，绝不能带密钥
  const chat = apiSrc.slice(apiSrc.indexOf('async function llmChat'))
  assert.ok(!/key|secret|token\s*:/i.test(chat.slice(0, chat.indexOf('}'))), '前端调用不带任何密钥字段')
})

test('AI 是花钱的接口，必须验会话令牌', () => {
  assert.ok(/const uid = verifyToken/.test(aiSrc), '要验令牌')
  assert.ok(/TOKEN_INVALID/.test(aiSrc), '验不过要给出可执行的提示')
  // 每日次数上限另由库里的 begin_support_ai 控制，这里只挡没人认领的调用
  assert.ok(/timingSafeEqual/.test(aiSrc), '验签要用定长时间比较')
})

test('模型目录：CloudBase 没有列表接口，用实测过的内置目录', () => {
  // 实测 /models、/v1/models、/v1/ai/models 全是 403 / 404，
  // 本环境真正能跑的只有 hy3 与 hy3-preview
  assert.ok(/DEFAULT_MODELS\s*=\s*\['hy3', 'hy3-preview'\]/.test(aiSrc), '内置目录要是实测可用的模型')
  assert.ok(/TCB_AI_MODELS/.test(aiSrc), '要能用环境变量扩展目录（买了 Token 包不用改代码）')
  assert.ok(/builtin:\s*true/.test(aiSrc), '要标明这份目录是静态的')
})

test('推理模型的空正文不能被当成成功', () => {
  // hy3 会把额度先花在 reasoning_content 上，max_tokens 给小了正文就是空的
  assert.ok(/Math\.max\(Math\.round\(maxTokens\), 300\)/.test(aiSrc), 'max_tokens 要有下限')
  assert.ok(/AI_EMPTY/.test(aiSrc), '只有思考过程没有正文时要明确报错')
})

test('网关与云函数两条通道都要认得 ai-api', () => {
  assert.ok(/'ai-api':\s*'\/api\/ai-api'/.test(tcbSrc), 'tcb.js 的 PATHS 要有 ai-api')
  assert.ok(/'ai-api':\s*'\/api\/ai-api'/.test(proxySrc), 'tcb-proxy 的转发白名单要有 ai-api')
  assert.ok(/callTarget: callTarget/.test(tcbSrc), 'callTarget 要导出')
})
