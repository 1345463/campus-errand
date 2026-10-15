/**
 * 图片存取
 *
 * 写入通道 = 数据库（save_media_asset / get_media_asset 两个 RPC）
 * 返回给业务层的「路径」是 asset:<id>，读回时按这个前缀分派。
 *
 * 为什么不用对象存储写：这条路查到最后是平台侧故障，客户端绕不过去。
 *   1) SDK 的小程序适配层（createMiniProgramFetch）只实现了文本请求，请求体非字符串直接抛
 *      「暂不支持非字符串 body」，所以 cloud.storage.upload(path, buffer) 必然失败；
 *   2) 改用 wx.request 发原生二进制后写入成功——storage.objects 里行在、字节数对、owner_id 对，
 *      键与所传路径逐字符一致；
 *   3) 但**任何**读通道（object/sign、object/{bucket}/{path}、object/info、SDK 自带实现）
 *      对该对象一律返回 404 STORAGE_OBJECT_NOT_FOUND：桶在、行在，实体字节取不回来
 *      （该后端是 S3 兼容的，storage.objects.version 落库为空串）。
 *   4) 已排除请求头差异（与 SDK 内部逐项对齐）、签名 TTL、路径编码、权限。
 *   → 结论：写进去的图再也读不出来。图片改存库，数据库这层在本项目里已验证可靠，
 *     且不受 URL 路径编码影响。
 *
 * 本文件仍保留对象存储的**读**通道：旧数据里存的是对象路径，
 * 展示时先按旧逻辑试一遍（签名链接 → 带 token 直读 → data URL），避免历史记录直接变空白。
 */
const config = require('./config')
const { cloud } = require('./cloud')

// 与 SDK 内部常量保持一致（见 CLOUD_MODULE_PATHS / RUNTIME_STORAGE_BUCKET）
const STORAGE_PREFIX = '/.cloud/storage'
const BUCKET = 'runtime'
const CLIENT_INFO = 'storage-js/2.112.3'
const CACHE_CONTROL = 'max-age=3600'

// 存库后的路径形式
const ASSET_PREFIX = 'asset:'

// base64 会让体积涨 1/3。服务端 save_media_asset 的入口限制折算回来约 1.9MB 原图，
// 这里取一致的值，在客户端就拦住，别让用户等到服务端报错才发现。
const COMPRESS_THRESHOLD = 300 * 1024
const MAX_UPLOAD_BYTES = Math.floor(1900 * 1024)

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

function fsManager() {
  if (typeof wx === 'undefined' || typeof wx.getFileSystemManager !== 'function') {
    const error = new Error('当前环境不支持读取本地文件，图片上传请在微信小程序中进行')
    error.unsupported = true
    throw error
  }
  return wx.getFileSystemManager()
}

function extToMime(ext) {
  const key = String(ext || '').toLowerCase()
  return MIME_BY_EXT[key === 'jpeg' ? 'jpg' : key] || ''
}

function normalizeExt(filePath) {
  const matched = /\.([a-zA-Z0-9]+)$/.exec(String(filePath || ''))
  const mime = matched ? extToMime(matched[1]) : ''
  return EXT_BY_MIME[mime] || 'jpg'
}

/**
 * 决定最终要写入的 mime。
 *
 * wx.compressImage 返回的临时文件名不一定带扩展名（各客户端版本不一致），
 * 此时若一律猜 jpg，原图是 png 的话 mime 就错了 —— 写本地文件时后缀跟着错。
 * 所以压缩产物识别不出类型时，退回用原图的类型。
 */
function resolveMime(originalPath, finalPath) {
  return extToMime(deriveExt(finalPath)) || extToMime(deriveExt(originalPath)) || 'image/jpeg'
}

function deriveExt(filePath) {
  const matched = /\.([a-zA-Z0-9]+)$/.exec(String(filePath || ''))
  return matched ? matched[1] : ''
}

function makeFileName(ext) {
  return Date.now() + '_' + Math.floor(Math.random() * 100000) + '.' + ext
}

// users/<uid>/<folder>/<name> —— 与 SDK 的 storage.userPath 同构
function userObjectPath(uid, folder, fileName) {
  const safeFolder = String(folder || 'files').replace(/[^a-zA-Z0-9_-]/g, '') || 'files'
  return 'users/' + uid + '/' + safeFolder + '/' + fileName
}

function readBuffer(filePath) {
  return fsManager().readFileSync(filePath)
}

function fileSize(filePath) {
  try {
    return fsManager().statSync(filePath).size || 0
  } catch (e) {
    return 0
  }
}

function compressOnce(src, quality) {
  return new Promise(function (resolve) {
    wx.compressImage({
      src: src,
      quality: quality,
      success: function (res) {
        resolve((res && res.tempFilePath) || src)
      },
      fail: function () {
        resolve(src)
      },
    })
  })
}

/**
 * 手机拍的原图动辄 3-5MB，必须压到能安全通过为止。
 * 两级：先用 60 压；还超标就从**原图**再压一次 35（不叠在第一次的产物上，避免画质崩掉）。
 * 压缩接口不可用就原样返回，交给调用方按体积判错误处理。
 */
async function shrink(filePath, size) {
  if (size <= COMPRESS_THRESHOLD) return filePath
  if (typeof wx === 'undefined' || typeof wx.compressImage !== 'function') return filePath

  let best = await compressOnce(filePath, 60)
  let bestSize = fileSize(best)
  if (bestSize > MAX_UPLOAD_BYTES) {
    const lower = await compressOnce(filePath, 35)
    const lowerSize = fileSize(lower)
    if (lowerSize && lowerSize < bestSize) {
      best = lower
      bestSize = lowerSize
    }
  }
  return best
}

async function getAuthToken() {
  const result = await cloud.auth.getSession()
  const session = result && !result.error ? result.data : null
  if (!session) {
    const error = new Error('请先登录')
    error.needLogin = true
    throw error
  }
  let token = session.accessToken
  if (!token && typeof cloud.auth.getAccessToken === 'function') {
    token = await cloud.auth.getAccessToken()
  }
  if (!token) {
    const error = new Error('登录状态已失效，请重新登录')
    error.needLogin = true
    throw error
  }
  return token
}

function baseHeaders(token) {
  return {
    'x-wb-webapp-access-key': config.publishableKey,
    Authorization: 'Bearer ' + token,
    'X-Client-Info': CLIENT_INFO,
  }
}

// 把服务端返回的错误整理成一句人话，顺带把 code / statusCode 带出来，
// 让页面上就能看出到底卡在哪一步，不用再去翻手机日志。
function describeHttpError(status, data, action) {
  const what = action || '上传'
  if (status === 401 || status === 403) {
    const error = new Error(what + '失败：没有权限，请重新登录后再试')
    error.needLogin = true
    return error
  }
  let payload = data
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch (e) {
      payload = null
    }
  }
  if (status === 413) return new Error(what + '失败：文件太大，请换一张更小的')
  if (status === 409) return new Error(what + '失败：文件已存在，请重试')
  if (status === 404) return new Error(what + '失败：服务端找不到该文件（HTTP 404）')
  let message = payload && (payload.message || payload.error_description)
  if (!message && payload && payload.error && typeof payload.error === 'string') message = payload.error
  let code = payload && (payload.code || payload.statusCode)
  const detail = []
  detail.push('HTTP ' + status)
  if (code) detail.push(String(code))
  if (message) detail.push(String(message).slice(0, 100))
  return new Error(what + '失败：' + detail.join(' · '))
}

// 解析签名接口的返回。不同版本的 storage-api 字段名不完全一致，都兜住。
function parseSignResponse(data) {
  let payload = data
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch (e) {
      return { url: '', reason: '服务端返回的不是 JSON：' + String(data).slice(0, 80) }
    }
  }
  if (!payload || typeof payload !== 'object') return { url: '', reason: '服务端返回内容为空' }
  const raw = payload.signedURL || payload.signedUrl || payload.signed_url
  if (!raw) {
    const message = payload.message || payload.error || payload.error_description
    return { url: '', reason: message ? String(message).slice(0, 110) : '服务端没有返回 signedURL 字段' }
  }
  let absolute = String(raw)
  if (!/^https?:\/\//i.test(absolute)) {
    absolute = config.endpoint + STORAGE_PREFIX + (absolute.charAt(0) === '/' ? '' : '/') + absolute
  }
  return { url: absolute, reason: '' }
}

// 方式一：原生二进制请求体。这是 supabase-js 在 Node 侧走的同一条路径（非 Blob/FormData 分支）。
function postBinary(url, buffer, contentType, token, upsert) {
  return new Promise(function (resolve, reject) {
    if (typeof wx === 'undefined' || typeof wx.request !== 'function') {
      reject(new Error('当前环境不支持上传，请在微信小程序中进行'))
      return
    }
    const header = baseHeaders(token)
    header['content-type'] = contentType
    header['cache-control'] = CACHE_CONTROL
    header['x-upsert'] = upsert ? 'true' : 'false'
    wx.request({
      url: url,
      method: 'POST',
      header: header,
      data: buffer,
      timeout: 60000,
      success: function (res) {
        const status = res && res.statusCode
        if (status >= 200 && status < 300) {
          resolve(true)
          return
        }
        reject(describeHttpError(status, res && res.data))
      },
      fail: function (res) {
        reject(new Error('上传失败：' + ((res && res.errMsg) || '网络异常')))
      },
    })
  })
}

// 方式二：multipart 兜底。个别基础库对 ArrayBuffer 请求体支持不一致时可救回来。
function postMultipart(url, filePath, token, upsert) {
  return new Promise(function (resolve, reject) {
    if (typeof wx === 'undefined' || typeof wx.uploadFile !== 'function') {
      reject(new Error('当前环境不支持文件上传，请在微信小程序中进行'))
      return
    }
    const header = baseHeaders(token)
    header['x-upsert'] = upsert ? 'true' : 'false'
    wx.uploadFile({
      url: url,
      filePath: filePath,
      name: 'file',
      header: header,
      timeout: 60000,
      success: function (res) {
        const status = res && res.statusCode
        if (status >= 200 && status < 300) {
          resolve(true)
          return
        }
        reject(describeHttpError(status, res && res.data))
      },
      fail: function (res) {
        reject(new Error('上传失败：' + ((res && res.errMsg) || '网络异常')))
      },
    })
  })
}

/** 把本地文件读成 base64（wx.getFileSystemManager().readFile 支持 encoding: 'base64'） */
function readFileAsBase64(filePath) {
  return new Promise(function (resolve, reject) {
    const manager = fsManager()
    manager.readFile({
      filePath: filePath,
      encoding: 'base64',
      success: function (res) {
        const data = res && res.data
        if (!data) {
          reject(new Error('读取图片失败：文件内容为空'))
          return
        }
        resolve(String(data))
      },
      fail: function (res) {
        reject(new Error('读取图片失败：' + ((res && res.errMsg) || '无法读取本地文件')))
      },
    })
  })
}

// 把 RPC 的错误整理成人话。服务端 RAISE EXCEPTION 的原文在 message 里，直接透出来。
function describeRpcError(error, action) {
  const what = action || '保存图片'
  if (!error) return what + '失败，请重试'
  if (typeof error === 'string') return error
  const message = error.message || error.details || error.hint
  if (message) return String(message).slice(0, 160)
  if (error.code) return what + '失败（' + error.code + '）'
  return what + '失败，请重试'
}

function makeAssetPath(id) {
  return ASSET_PREFIX + String(id)
}

function isAssetPath(path) {
  return typeof path === 'string' && path.indexOf(ASSET_PREFIX) === 0
}

function parseAssetId(path) {
  const matched = /^asset:(\d+)$/.exec(String(path || ''))
  return matched ? matched[1] : ''
}

/**
 * 存库：把图片 base64 交给 save_media_asset。
 * owner_id 由服务端按 JWT 决定，客户端既传不了也伪造不了。
 */
async function saveToDatabase(filePath, folder, mime) {
  const base64 = await readFileAsBase64(filePath)
  const result = await cloud.database.rpc('save_media_asset', {
    p_scope: String(folder || 'file'),
    p_mime: mime || 'image/jpeg',
    p_data: base64,
  })
  if (result.error) throw new Error(describeRpcError(result.error))
  const id = result.data
  if (id === null || id === undefined || id === '') {
    throw new Error('保存图片失败：服务端没有返回编号')
  }
  return makeAssetPath(id)
}

/**
 * 上传本地临时文件，返回可直接写进数据库的图片路径。
 *
 * 只走存库通道，故意不做对象存储兜底：存储那条路「写能成、读不回来」，
 * 兜底只会把照片变成管理员看不见的幽灵记录 —— 宁可当场报错，也不要静默丢图。
 *
 * @returns {Promise<string>} asset:<id>
 */
async function uploadImage(tempFilePath, folder, uid) {
  if (!tempFilePath) throw new Error('没有拿到文件，请重新选择')
  if (!uid) throw new Error('登录信息不完整，请重新登录')

  const target = await shrink(tempFilePath, fileSize(tempFilePath))

  const size = fileSize(target)
  if (size > MAX_UPLOAD_BYTES) {
    throw new Error(
      '图片约 ' +
        (size / 1024 / 1024).toFixed(1) +
        'MB，压缩后仍超过 1.9MB 上限，请换个角度重拍或选一张更小的'
    )
  }

  const mime = resolveMime(tempFilePath, target)
  return saveToDatabase(target, folder, mime)
}

/** 读库里的图片，返回 { mime, data(base64) } */
async function readAsset(assetPath) {
  const id = parseAssetId(assetPath)
  if (!id) throw new Error('图片路径无效：' + String(assetPath).slice(0, 40))
  const result = await cloud.database.rpc('get_media_asset', { p_id: Number(id) })
  if (result.error) throw new Error(describeRpcError(result.error, '读取图片'))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('找不到这张图片：可能不是本人提交的')
  const row = rows[0] || {}
  if (!row.data) throw new Error('读取图片失败：内容为空')
  return { mime: row.mime || 'image/jpeg', data: String(row.data) }
}

/**
 * asset:<id> → 本地临时文件路径。
 * 优先用本地文件而不是 data URL：没有体积膨胀（setData 单次上限 1MB），
 * 而且本地路径照样能进 wx.previewImage 放大看。
 */
async function assetToLocalFile(assetPath) {
  const asset = await readAsset(assetPath)
  const manager = fsManager()
  const path =
    wx.env.USER_DATA_PATH +
    '/asset_' +
    Date.now() +
    '_' +
    Math.floor(Math.random() * 10000) +
    '.' +
    (EXT_BY_MIME[asset.mime] || 'jpg')
  manager.writeFileSync(path, asset.data, 'base64')
  return path
}

/** asset:<id> → data URL。文件系统不可用时兜底。 */
async function assetToDataUrl(assetPath) {
  const asset = await readAsset(assetPath)
  return 'data:' + asset.mime + ';base64,' + asset.data
}

/**
 * 读**订单相关的**图片（任务图 / 送达佐证）。
 *
 * 为什么不能直接用 readAsset：get_media_asset 只认"本人上传的图"，
 * 但订单里的图天然要跨人看 ——
 *   · 任务图是发布方传的，接单员接单后必须能看到才知道要取什么；
 *   · 送达佐证是接单员传的，发布方确认收货前必须能看到才知道收没收对。
 * 所以服务端另开了 get_order_asset：先确认调用方是这一单的发布方或接单员
 * （管理员也放行），再确认这张图确实挂在这一单上，两个条件缺一不可。
 * 没接单的人既拿不到图、也拿不到取餐码。
 */
async function readOrderAsset(assetPath, orderId) {
  const id = parseAssetId(assetPath)
  if (!id) throw new Error('图片路径无效：' + String(assetPath).slice(0, 40))
  if (!orderId) throw new Error('缺少订单号，无法校验图片权限')
  const result = await cloud.database.rpc('get_order_asset', {
    p_asset_id: Number(id),
    p_order_id: Number(orderId),
  })
  if (result.error) throw new Error(describeRpcError(result.error, '读取订单图片'))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('看不到这张图片：可能还没有接单，或图片不属于这一单')
  const row = rows[0] || {}
  if (!row.data) throw new Error('读取图片失败：内容为空')
  return { mime: row.mime || 'image/jpeg', data: String(row.data) }
}

async function orderAssetToLocalFile(assetPath, orderId) {
  const asset = await readOrderAsset(assetPath, orderId)
  const manager = fsManager()
  const path =
    wx.env.USER_DATA_PATH +
    '/asset_' +
    Date.now() +
    '_' +
    Math.floor(Math.random() * 10000) +
    '.' +
    (EXT_BY_MIME[asset.mime] || 'jpg')
  manager.writeFileSync(path, asset.data, 'base64')
  return path
}

async function orderAssetToDataUrl(assetPath, orderId) {
  const asset = await readOrderAsset(assetPath, orderId)
  return 'data:' + asset.mime + ';base64,' + asset.data
}

/**
 * 读「公开资源」里的图片（目前只有首页轮播走这条路）。
 *
 * 为什么不能直接用 readAsset：get_media_asset 只认本人上传的图，
 * 轮播是管理员传的，游客去读会被判"找不到这张图片"。
 * get_public_asset 在服务端限定 scope = 'banner'，只放这一类出去。
 */
async function readPublicAsset(assetPath) {
  const id = parseAssetId(assetPath)
  if (!id) throw new Error('图片路径无效：' + String(assetPath).slice(0, 40))
  const result = await cloud.database.rpc('get_public_asset', { p_id: Number(id) })
  if (result.error) throw new Error(describeRpcError(result.error, '读取轮播图'))
  const rows = Array.isArray(result.data) ? result.data : []
  if (!rows.length) throw new Error('找不到这张轮播图：可能还没上传成功')
  const row = rows[0] || {}
  if (!row.data) throw new Error('读取轮播图失败：内容为空')
  return { mime: row.mime || 'image/jpeg', data: String(row.data) }
}

/** 公开资源 → 本地临时文件路径 */
async function publicAssetToLocalFile(assetPath) {
  const asset = await readPublicAsset(assetPath)
  const manager = fsManager()
  const path =
    wx.env.USER_DATA_PATH +
    '/banner_' +
    Date.now() +
    '_' +
    Math.floor(Math.random() * 10000) +
    '.' +
    (EXT_BY_MIME[asset.mime] || 'jpg')
  manager.writeFileSync(path, asset.data, 'base64')
  return path
}

/** 公开资源 → data URL。文件系统不可用时兜底。 */
async function publicAssetToDataUrl(assetPath) {
  const asset = await readPublicAsset(assetPath)
  return 'data:' + asset.mime + ';base64,' + asset.data
}

/**
 * 生成带签名的临时访问链接。
 * 与 SDK 的 createSignedUrl 同构：POST /object/sign/{bucket}/{path}，body { expiresIn }。
 * token 在查询串里，所以 <image src> / wx.previewImage 不需要带请求头就能显示。
 */
async function createSignedUrl(objectPath, expiresIn) {
  if (!objectPath) throw new Error('生成链接失败：缺少文件路径')
  const ttl = expiresIn || 3600
  const token = await getAuthToken()
  const url = config.endpoint + STORAGE_PREFIX + '/object/sign/' + BUCKET + '/' + objectPath
  return new Promise(function (resolve, reject) {
    if (typeof wx === 'undefined' || typeof wx.request !== 'function') {
      reject(new Error('当前环境不支持生成链接，请在微信小程序中进行'))
      return
    }
    const header = baseHeaders(token)
    header['content-type'] = 'application/json'
    wx.request({
      url: url,
      method: 'POST',
      header: header,
      data: JSON.stringify({ expiresIn: ttl }),
      timeout: 20000,
      success: function (res) {
        const status = res && res.statusCode
        if (status < 200 || status >= 300) {
          reject(describeHttpError(status, res && res.data, '生成链接'))
          return
        }
        const parsed = parseSignResponse(res && res.data)
        if (!parsed.url) {
          reject(new Error('生成链接失败：' + parsed.reason))
          return
        }
        resolve(parsed.url)
      },
      fail: function (res) {
        reject(new Error('生成链接失败：' + ((res && res.errMsg) || '网络异常')))
      },
    })
  })
}

/**
 * 诊断用：确认这个对象到底在不在存储里。
 * 签名失败时调一次，好区分「文件没传上去」和「文件在但没权限读」。
 */
function probeObject(objectPath) {
  return new Promise(function (resolve) {
    if (!objectPath || typeof wx === 'undefined' || typeof wx.request !== 'function') {
      resolve('')
      return
    }
    cloud.auth
      .getAccessToken()
      .then(function (token) {
        // 带 token 探测才有意义：匿名访问 runtime 桶一律返回 bucket not found
        const header = baseHeaders(token || '')
        if (!token) delete header.Authorization
        const url =
          config.endpoint + STORAGE_PREFIX + '/object/info/' + BUCKET + '/' + objectPath
        wx.request({
          url: url,
          method: 'GET',
          header: header,
          timeout: 15000,
          success: function (res) {
            const status = (res && res.statusCode) || '?'
            resolve(status === 200 ? '对象存在' : '对象探测 HTTP ' + status)
          },
          fail: function () {
            resolve('')
          },
        })
      })
      .catch(function () {
        resolve('')
      })
  })
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// wx.arrayBufferToBase64 在部分基础库已标记废弃，留一份纯 JS 实现兜底
function base64FromBuffer(buffer) {
  if (typeof wx !== 'undefined' && typeof wx.arrayBufferToBase64 === 'function') {
    try {
      return wx.arrayBufferToBase64(buffer)
    } catch (e) {
      /* 落到下面的手动实现 */
    }
  }
  const bytes = new Uint8Array(buffer)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64_CHARS.charAt(b0 >> 2)
    out += B64_CHARS.charAt(((b0 & 3) << 4) | (b1 >> 4))
    out += i + 1 < bytes.length ? B64_CHARS.charAt(((b1 & 15) << 2) | (b2 >> 6)) : '='
    out += i + 2 < bytes.length ? B64_CHARS.charAt(b2 & 63) : '='
  }
  return out
}

/**
 * 带 token 直接读取对象字节（下载路由 GET /object/{bucket}/{path}）。
 * 签名接口不可用时靠它兜底：管理员必须能看到证件照片，不能让某个接口坏掉就卡死审核。
 */
async function downloadBuffer(objectPath) {
  if (!objectPath) throw new Error('缺少文件路径')
  const token = await getAuthToken()
  const url = config.endpoint + STORAGE_PREFIX + '/object/' + BUCKET + '/' + objectPath
  return new Promise(function (resolve, reject) {
    if (typeof wx === 'undefined' || typeof wx.request !== 'function') {
      reject(new Error('当前环境不支持读取图片，请在微信小程序中进行'))
      return
    }
    wx.request({
      url: url,
      method: 'GET',
      header: baseHeaders(token),
      responseType: 'arraybuffer',
      timeout: 30000,
      success: function (res) {
        const status = res && res.statusCode
        if (status < 200 || status >= 300) {
          reject(describeHttpError(status, res && res.data, '读取图片'))
          return
        }
        const data = res && res.data
        if (!data || typeof data.byteLength !== 'number' || !data.byteLength) {
          reject(new Error('读取图片失败：服务端返回内容为空'))
          return
        }
        resolve(data)
      },
      fail: function (res) {
        reject(new Error('读取图片失败：' + ((res && res.errMsg) || '网络异常')))
      },
    })
  })
}

/**
 * 兜底通道一：把字节写成小程序本地临时文件，返回本地路径。
 * 相比 base64 没有体积膨胀（setData 单次上限 1MB），而且本地路径照样能进 previewImage 放大看。
 */
async function fetchToLocalFile(objectPath) {
  const buffer = await downloadBuffer(objectPath)
  const manager = fsManager()
  const path =
    wx.env.USER_DATA_PATH +
    '/view_' +
    Date.now() +
    '_' +
    Math.floor(Math.random() * 10000) +
    '.' +
    normalizeExt(objectPath)
  manager.writeFileSync(path, buffer)
  return path
}

/** 兜底通道二：data URL。不依赖文件系统，预览容器里也能用。 */
async function fetchAsDataUrl(objectPath, contentType) {
  const buffer = await downloadBuffer(objectPath)
  const mime = contentType || MIME_BY_EXT[normalizeExt(objectPath)]
  return 'data:' + mime + ';base64,' + base64FromBuffer(buffer)
}

module.exports = {
  uploadImage: uploadImage,
  isAssetPath: isAssetPath,
  assetToLocalFile: assetToLocalFile,
  assetToDataUrl: assetToDataUrl,
  orderAssetToLocalFile: orderAssetToLocalFile,
  orderAssetToDataUrl: orderAssetToDataUrl,
  publicAssetToLocalFile: publicAssetToLocalFile,
  publicAssetToDataUrl: publicAssetToDataUrl,
  // 以下仍是对象存储的读通道，只为兼容历史数据保留
  createSignedUrl: createSignedUrl,
  downloadBuffer: downloadBuffer,
  fetchToLocalFile: fetchToLocalFile,
  fetchAsDataUrl: fetchAsDataUrl,
  probeObject: probeObject,
  userObjectPath: userObjectPath,
}
