const http = require('http')

const CONNECTION = 'connection'
const FORWARDED = 'forwarded'
const HOST = 'host'
const KEEP_ALIVE = 'keep-alive'
const PROXY_AUTHORIZATION = 'proxy-authorization'
const PROXY_CONNECTION = 'proxy-connection'
const TE = 'te'
const TRAILER = 'trailer'
const TRANSFER_ENCODING = 'transfer-encoding'
const UPGRADE = 'upgrade'
const VIA = 'via'
const AUTHORITY = ':authority'
const HTTP2_SETTINGS = 'http2-settings'

module.exports = {
  ws (req, socket, head, options, callback) {
    return proxy(req, socket, head || null, options, callback)
  },
  web (req, res, options, callback) {
    return proxy(req, res, undefined, options, callback)
  }
}

function noop () {}

const kReq = Symbol('req')
const kRes = Symbol('res')
const kSelf = Symbol('self')
const kProxyCallback = Symbol('callback')
const kProxyReq = Symbol('proxyReq')
const kProxyRes = Symbol('proxyRes')
const kProxySocket = Symbol('proxySocket')
const kOnProxyRes = Symbol('onProxyRes')

function proxy (req, res, head, {
  hostname,
  port,
  timeout,
  proxyTimeout,
  proxyName,
  onReq,
  onRes
}, callback) {
  req[kRes] = res

  res[kSelf] = this
  res[kReq] = req
  res[kRes] = res
  res[kProxyCallback] = callback
  res[kProxyReq] = null
  res[kProxySocket] = null

  if (proxyName && req.headers[VIA]) {
    for (const name of req.headers[VIA].split(',')) {
      if (sanitize(name).endsWith(proxyName.toLowerCase())) {
        process.nextTick(onError.call, res, createError('loop detected', null, 508))
        return
      }
    }
  }

  const headers = getRequestHeaders(req.headers, req.socket)

  if (head !== undefined) {
    if (req.method !== 'GET') {
      process.nextTick(onError.call, res, createError('method not allowed', null, 405))
      return
    }

    if (sanitize(req.headers[UPGRADE]) !== 'websocket') {
      process.nextTick(onError.call, res, createError('bad request', null, 400))
      return
    }

    if (head && head.length) {
      res.unshift(head)
    }

    setupSocket(res)

    headers[CONNECTION] = 'upgrade'
    headers[UPGRADE] = 'websocket'
  }

  if (proxyName) {
    if (headers[VIA]) {
      headers[VIA] += `,${req.httpVersion} ${proxyName}`
    } else {
      headers[VIA] = `${req.httpVersion} ${proxyName}`
    }
  }

  if (timeout != null) {
    req.setTimeout(timeout)
  }

  const options = {
    method: req.method,
    hostname,
    port,
    path: req.url,
    headers,
    timeout: proxyTimeout
  }

  let proxyReq

  if (onReq) {
    proxyReq = onReq.call(res[kSelf], req, options)
  }

  if (!proxyReq) {
    proxyReq = http.request(options)
  }

  proxyReq[kReq] = req
  proxyReq[kRes] = res
  res[kProxyReq] = proxyReq
  proxyReq[kOnProxyRes] = onRes

  req
    .on('aborted', onRequestAborted)
    .on('timeout', onRequestTimeout)
    .pipe(proxyReq)
    .on('error', onError)
    .on('timeout', onProxyTimeout)
    .on('response', onProxyResponse)
    .on('upgrade', onProxyUpgrade)
}

function onEnd () {
  onError.call(this)
}

function onError (err) {
  const res = this[kRes]
  const req = res[kReq]

  req
    .removeListener('timeout', onRequestTimeout)
    .removeListener('aborted', onRequestAborted)

  if (res[kProxySocket]) {
    res[kProxySocket]
      .removeListener('error', onError)
    res[kProxySocket].on('error', noop)
    res[kProxySocket].end()
    res[kProxySocket] = null
  }

  if (res[kProxyRes]) {
    res[kProxyRes]
      .removeListener('error', onError)
      .removeListener('aborted', onProxyAborted)
      .removeListener('end', onEnd)
    res[kProxyRes].on('error', noop)
    res[kProxyRes].destroy()
  }

  if (res[kProxyReq]) {
    res[kProxyReq]
      .removeListener('error', onError)
      .removeListener('timeout', onProxyTimeout)
      .removeListener('response', onProxyResponse)
      .removeListener('upgrade', onProxyUpgrade)
    res[kProxyReq].on('error', noop)
    res[kProxyReq].abort()
    res[kProxyReq] = null
  }

  if (err) {
    err.statusCode = err.statusCode || 500
    err.code = err.code || res.code

    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      err.statusCode = 503
    } else if (/HPE_INVALID/.test(err.code)) {
      err.statusCode = 502
    }
  }

  res[kProxyCallback].call(res[kSelf], err, req, res)
}

function onRequestTimeout () {
  onError.call(this, createError('request timeout', null, 408))
}

function onRequestAborted () {
  onError.call(this)
}

function onProxyTimeout () {
  onError.call(this, createError('gateway timeout', null, 504))
}

function onProxyResponse (proxyRes) {
  const res = this[kRes]

  res[kProxyRes] = proxyRes
  proxyRes[kRes] = res

  proxyRes.on('aborted', onProxyAborted)

  if (!res.writeHead) {
    if (this[kOnProxyRes]) {
      this[kOnProxyRes].call(res[kSelf], this[kReq], res, proxyRes)
    }

    if (!proxyRes.upgrade) {
      res.end()
    }
  } else {
    setupHeaders(proxyRes.headers)

    res.statusCode = proxyRes.statusCode
    for (const [ key, value ] of Object.entries(proxyRes.headers)) {
      res.setHeader(key, value)
    }

    if (this[kOnProxyRes]) {
      this[kOnProxyRes].call(res[kSelf], this[kReq], res, proxyRes)
    }

    if (!res.headersSent) {
      res.writeHead(res.statusCode)
    }

    proxyRes
      .on('error', onError)
      .on('end', onEnd)
      .pipe(res, { end: false })
  }
}

function onProxyAborted () {
  onError.call(this, createError('socket hang up', 'ECONNRESET', 502))
}

function onProxyUpgrade (proxyRes, proxySocket, proxyHead) {
  const res = this[kRes]

  res[kProxySocket] = proxySocket
  proxySocket[kRes] = res

  setupSocket(proxySocket)

  if (proxyHead && proxyHead.length) {
    proxySocket.unshift(proxyHead)
  }

  let head = 'HTTP/1.1 101 Switching Protocols'

  for (const [ key, value ] of Object.entries(proxyRes.headers)) {
    if (!Array.isArray(value)) {
      head += '\r\n' + key + ': ' + value
    } else {
      for (let i = 0; i < value.length; i++) {
        head += '\r\n' + key + ': ' + value[i]
      }
    }
  }

  head += '\r\n\r\n'

  res.write(head)

  proxySocket
    .on('error', onError)
    .pipe(res)
    .pipe(proxySocket)
}

function getRequestHeaders (reqHeaders, reqSocket) {
  const host = reqHeaders[AUTHORITY] || reqHeaders[HOST]
  const forwarded = reqHeaders[FORWARDED]

  const headers = {}
  for (const [ key, value ] of Object.entries(reqHeaders)) {
    if (key.charAt(0) !== ':') {
      headers[key] = value
    }
  }

  setupHeaders(headers)

  if (reqSocket) {
    headers[FORWARDED] = `by=${reqSocket.localAddress}`
    headers[FORWARDED] += `; for=${reqSocket.remoteAddress}`
  }

  if (forwarded) {
    const expr = /for=\s*([^\s]+)/ig
    while (true) {
      const m = expr.exec(forwarded)
      if (!m) {
        break
      }
      headers[FORWARDED] += `; for=${m[1]}`
    }
  }

  if (host) {
    headers[FORWARDED] += `; host=${host}`
  }

  if (reqSocket) {
    headers[FORWARDED] += `; proto=${reqSocket.encrypted ? 'https' : 'http'}`
  }

  return headers
}

function setupSocket (socket) {
  socket.setTimeout(0)
  socket.setNoDelay(true)
  socket.setKeepAlive(true, 0)
}

function setupHeaders (headers) {
  const connection = sanitize(headers[CONNECTION])

  if (connection && connection !== CONNECTION && connection !== KEEP_ALIVE) {
    for (const name of connection.split(',')) {
      delete headers[name.trim()]
    }
  }

  // Remove hop by hop headers
  delete headers[CONNECTION]
  delete headers[KEEP_ALIVE]
  delete headers[TRANSFER_ENCODING]
  delete headers[TE]
  delete headers[UPGRADE]
  delete headers[PROXY_AUTHORIZATION]
  delete headers[PROXY_CONNECTION]
  delete headers[TRAILER]
  delete headers[HTTP2_SETTINGS]

  return headers
}

function sanitize (name) {
  return name ? name.trim().toLowerCase() : ''
}

function createError (msg, code, statusCode) {
  const err = new Error(msg)
  err.code = code
  err.statusCode = statusCode
  return err
}
