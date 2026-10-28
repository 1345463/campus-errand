/**
 * 访问新库（CloudBase ceshi 环境）的统一入口
 *
 * 两条通道，默认优先直连网关：
 *   ① 直连网关 HTTPS —— 需要在小程序后台配 request 合法域名（免费，一次配好）。
 *      ceshi 环境的套餐已包含网关与云函数，不额外收费。
 *   ② wx.cloud.callFunction('tcb-proxy') —— 免域名，但需要小程序自己的云开发环境
 *      （可能产生费用）。仅当 ① 网络不通时兜底。
 *
 * 只有「网络层面失败」才换通道重试；业务错误（余额不足、无权限等）直接抛出，
 * 不重试，避免把业务拒绝当成网络问题反复打。
 */
const GATEWAY = 'https://ceshi-d2g37cbg7c8f7ee48-1329559054.ap-shanghai.app.tcloudbase.com'

const PATHS = {
  'pay-create': '/api/pay-create',
  withdraw: '/api/withdraw',
}

function viaGateway(target, payload) {
  return new Promise(function (resolve, reject) {
    const path = PATHS[target]
    if (!path) {
      reject(new Error('未知调用目标：' + target))
      return
    }
    wx.request({
      url: GATEWAY + path,
      method: 'POST',
      header: { 'content-type': 'application/json' },
      data: payload || {},
      success: function (res) {
        const data = res.data || {}
        if (data.ok) {
          data._via = 'gateway'
          resolve(data)
        } else {
          reject(new Error(data.error || data.code || '调用失败'))
        }
      },
      fail: function (e) {
        const err = new Error(e.errMsg || '网络请求失败')
        err._network = true
        reject(err)
      },
    })
  })
}

function viaCloud(target, payload) {
  return new Promise(function (resolve, reject) {
    if (!(wx.cloud && wx.cloud.callFunction)) {
      reject(new Error('wx.cloud 不可用'))
      return
    }
    wx.cloud.callFunction({
      name: 'tcb-proxy',
      data: Object.assign({}, payload, { target: target }),
      success: function (r) {
        const body = (r && r.result) || {}
        if (body.ok) {
          body._via = 'cloud'
          resolve(body)
        } else {
          reject(new Error(body.error || body.code || '调用失败'))
        }
      },
      fail: function (e) {
        const err = new Error((e && e.errMsg) || '云开发调用失败')
        err._network = true
        reject(err)
      },
    })
  })
}

function call(target, payload) {
  return new Promise(function (resolve, reject) {
    viaGateway(target, payload).then(resolve, function (err) {
      if (!err._network) {
        reject(err)
        return
      }
      viaCloud(target, payload).then(resolve, function () {
        reject(err)
      })
    })
  })
}

module.exports = {
  call: call,
  GATEWAY: GATEWAY,
}
