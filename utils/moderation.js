// 违规词检测（前端版）
//
// 和数据库里 normalize_mod_text + scan_moderation_words 是同一套算法：
//   全角转半角 -> 小写 -> 繁体转简体（含带调拼音折叠）-> 只保留中日韩字符 / 字母 / 数字 -> 子串匹配。
// 两端必须一致，否则会出现「前端放过、服务端拒绝」，用户只看到一句莫名其妙的失败提示。
// 改动这里的同时要改 sql/add-content-moderation.sql 里的 SQL-4，并用 scripts/gen-moderation-sql.js 自检。
//
// 三步走的取舍：
//   1) 输入框里实时检测：本地词库（内存/缓存）子串匹配，输入时立刻标红，不打断打字。
//   2) 提交时再检测一次：防止用户在上一次检测结果之后又改了内容。
//   3) 服务端（create_order）还会检测一次：本地检测只能劝退，拦不住绕过页面直接调接口的人。
//
// 词库优先级：服务端表里的最新词（缓存 30 分钟）> 打包进小程序的兜底词库。
// 这样管理员在后台加词后无需重新发布小程序，断网/首次进页面也不会完全裸奔。

const BUILTIN = require('./moderation-words')

const CACHE_KEY = 'moderation_words_v1'
const CACHE_TTL = 30 * 60 * 1000

let cached = readCache()

// 白名单比黑名单先生效：先把这些说法从文本里删掉，再做命中判断。
// 和服务器（scan_moderation_words）保持完全一致的顺序，否则会出现
// 「前端放行、服务端拒绝」这种最难排查的体验问题。
function maskAllow(key, allowList) {
  let out = key
  const list = allowList || []
  for (let i = 0; i < list.length; i += 1) {
    if (list[i]) out = out.split(list[i]).join('')
  }
  return out
}

function buildTradMap() {
  const map = {}
  const pairs = BUILTIN.TRAD_TO_SIMP || []
  pairs.forEach(function (pair) {
    map[pair[0]] = pair[1]
  })
  return map
}

const TRAD_MAP = buildTradMap()

function readCache() {
  try {
    const raw = wx.getStorageSync(CACHE_KEY)
    if (!raw || !Array.isArray(raw.words)) return null
    if (!raw.at || Date.now() - raw.at > CACHE_TTL) return null
    return { index: buildIndex(raw.words), at: raw.at }
  } catch (e) {
    return null
  }
}

function writeCache(rows) {
  try {
    wx.setStorageSync(CACHE_KEY, { words: rows, at: Date.now() })
  } catch (e) {
    // 存不下就算了，顶多下次进来多拉一次
  }
}

// 唯一的规范化入口，必须与 SQL 的 normalize_mod_text 行为一致
function normalize(raw) {
  const source = raw === null || raw === undefined ? '' : String(raw)
  let step = ''
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i)
    if (code === 12288) {
      step += ' '
    } else if (code >= 65281 && code <= 65374) {
      step += String.fromCharCode(code - 65248).toLowerCase()
    } else {
      step += source.charAt(i).toLowerCase()
    }
  }
  let mapped = ''
  for (let j = 0; j < step.length; j += 1) {
    const ch = step.charAt(j)
    mapped += TRAD_MAP[ch] || ch
  }
  return mapped.replace(/[^一-龥a-zA-Z0-9]/g, '')
}

function buildIndex(rows) {
  const list = (rows || [])
    .map(function (row) {
      const entry = Array.isArray(row)
        ? { word: row[1], category: row[0] }
        : { word: row.word, category: row.category, severity: row.severity || 'block' }
      return { word: entry.word, category: entry.category, key: normalize(entry.word), severity: entry.severity || 'block' }
    })
    .filter(function (item) {
      return !!item.word && !!item.key
    })

  const allowList = list
    .filter(function (item) {
      return item.severity === 'allow'
    })
    .sort(function (a, b) {
      return b.key.length - a.key.length
    })
    .map(function (item) {
      return item.key
    })

  // 长词优先：命中「代写论文」时不要报成「代写」
  const blockList = list
    .filter(function (item) {
      return item.severity !== 'allow'
    })
    .sort(function (a, b) {
      return b.key.length - a.key.length
    })

  return { block: blockList, allow: allowList }
}

function fallbackRows() {
  const source = BUILTIN.WORDS || []
  return source
    .map(function (row) {
      return { word: row[1], category: row[0] }
    })
    .concat(
      (BUILTIN.ALLOW_WORDS || []).map(function (word) {
        return { word: word, category: '白名单', severity: 'allow' }
      })
    )
}

function currentIndex() {
  if (cached && cached.index && cached.index.block && cached.index.block.length) return cached.index
  return buildIndex(fallbackRows())
}

// 异步拉服务端最新词库。失败不影响使用（自动落到打包的兜底词库里）。
function refreshWords() {
  const tcb = require('./tcb')
  return tcb
    .rpc('list_active_moderation_words', {})
    .then(function (result) {
      if (result.error) return null
      const rows = Array.isArray(result.data) ? result.data : []
      if (!rows.length) return null
      cached = { index: buildIndex(rows), at: Date.now() }
      writeCache(rows)
      return cached.index
    })
    .catch(function () {
      return null
    })
}

// 单段文本：返回 null 或 { category, word }
function scanText(text) {
  const raw = normalize(text)
  if (!raw) return null
  const index = currentIndex()
  const key = maskAllow(raw, index.allow)
  if (!key) return null
  for (let i = 0; i < index.block.length; i += 1) {
    if (key.indexOf(index.block[i].key) >= 0) {
      return { category: index.block[i].category, word: index.block[i].word }
    }
  }
  return null
}

function flatten(value) {
  if (Array.isArray(value)) return value.join(' ')
  if (value === null || value === undefined) return ''
  return String(value)
}

// 多个字段逐段扫描。刻意不先拼接再扫：
// 拼接会让「上一字段结尾 + 下一字段开头」凑出一个词，冤枉正常需求（如描述以「代」结尾、备注以「课」开头）。
// 返回 null 或 { field, label, category, word }
function scanFields(fields) {
  const list = fields || []
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i]
    const hit = scanText(flatten(item.value))
    if (hit) {
      return {
        field: item.field,
        label: item.label || '',
        category: hit.category,
        word: hit.word,
      }
    }
  }
  return null
}

function hitMessage(hit) {
  if (!hit) return ''
  return (
    '内容包含不允许发布的信息（' +
    hit.category +
    '，命中：' +
    hit.word +
    '）。校园跑腿不接受违反校纪校规和法律法规的事项，请修改后再发布'
  )
}

function loadPromise() {
  // 进入发布页时预热一次：本地已有缓存时跳过网络请求
  if (cached && cached.index && cached.index.length) return Promise.resolve(cached.index)
  return refreshWords()
}

module.exports = {
  normalize: normalize,
  scanText: scanText,
  scanFields: scanFields,
  hitMessage: hitMessage,
  refreshWords: refreshWords,
  load: loadPromise,
  CACHE_TTL: CACHE_TTL,
}
