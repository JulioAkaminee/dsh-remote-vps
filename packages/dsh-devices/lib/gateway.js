// Per-device local gateway on the desktop. The device's own DSH UI is served
// at http://127.0.0.1:<port>/<secret>/ and every request is forwarded to the
// device's authenticated tunnel (/device/v1/t/...) with a fresh access token,
// so the UI, its API calls and its WebSocket all run against the device.
//
// Why a secret path instead of a cookie: the desktop embeds this UI in an
// iframe next to its local chats. A path secret works the same in every
// webview (no third-party-cookie rules), while each device keeps its own
// origin (own port), so its localStorage never mixes with the desktop's.
// Host/Origin are checked against the gateway's own authority (DNS-rebinding
// and cross-site defense), and responses carry `Referrer-Policy: no-referrer`
// so the secret never leaks to other sites.

import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { ROUTES, TOKEN_HEADER } from './protocol.js'

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'])

export class DeviceGateway {
  /**
   * @param {{
   *   deviceId: string,
   *   baseUrl: () => string,          // device base (https URL or SSH-forwarded http://127.0.0.1:N)
   *   token: (opts?: { force?: boolean }) => Promise<string>,
   *   agent?: () => any,
   *   preferredPort?: number,
   * }} options
   */
  constructor({ deviceId, baseUrl, token, agent, preferredPort, secret }) {
    this.deviceId = deviceId
    this.baseUrl = baseUrl
    this.token = token
    this.agent = agent ?? (() => undefined)
    this.preferredPort = preferredPort
    // A stable per-device secret keeps asset URLs stable, so the webview's
    // HTTP cache survives restarts (the device UI opens much faster).
    this.secret = typeof secret === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(secret) ? secret : crypto.randomBytes(24).toString('base64url')
    this.server = null
    this.port = null
    this.sockets = new Set()
  }

  get origin() {
    return `http://127.0.0.1:${this.port}`
  }

  /** Root of the device UI on this gateway (ends with '/'). */
  get root() {
    return `${this.origin}/${this.secret}/`
  }

  /** URL of `next` (a path on the device UI, e.g. '/?dsh-embed=1') behind the secret prefix. */
  entryUrl(next = '/') {
    const safe = typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/'
    return `${this.origin}/${this.secret}${safe}`
  }

  async start() {
    if (this.server) return this
    const server = http.createServer((req, res) => this._handle(req, res).catch(() => res.destroy()))
    server.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head).catch(() => socket.destroy()))
    server.on('connection', (s) => {
      this.sockets.add(s)
      s.on('close', () => this.sockets.delete(s))
    })
    const listen = (port) =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          resolve(server.address().port)
        })
      })
    try {
      this.port = await listen(this.preferredPort ?? 0)
    } catch {
      this.port = await listen(0)
    }
    this.server = server
    return this
  }

  _authorityOk(req) {
    const host = String(req.headers.host ?? '').toLowerCase()
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`
  }

  _originOk(req) {
    const origin = req.headers.origin
    if (!origin) return true
    return origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`
  }

  /** Strip the secret prefix; undefined when the path does not carry it. */
  _devicePath(url) {
    const prefix = `/${this.secret}`
    const a = Buffer.from(url.slice(0, prefix.length))
    const b = Buffer.from(prefix)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return undefined
    const rest = url.slice(prefix.length)
    if (rest === '') return '/'
    if (!rest.startsWith('/') && !rest.startsWith('?')) return undefined
    return rest.startsWith('?') ? `/${rest}` : rest
  }

  _deny(res, status, text) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    res.end(text)
  }

  async _handle(req, res) {
    if (!this._authorityOk(req)) return this._deny(res, 403, 'forbidden host')
    const devicePath = this._devicePath(req.url)
    if (devicePath === undefined) return this._deny(res, 404, 'not found')
    const rest = req.url.slice(this.secret.length + 1)
    if (rest === '' || rest.startsWith('?')) {
      // `/<secret>` without the trailing slash: relative URLs need the directory form.
      res.writeHead(308, { location: `/${this.secret}/${rest}`, 'referrer-policy': 'no-referrer' })
      res.end()
      return
    }
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    if (unsafe && !this._originOk(req)) return this._deny(res, 403, 'cross-origin request refused')
    await this._forward(req, res, devicePath, false)
  }

  _upstreamHeaders(req, token) {
    const base = new URL(this.baseUrl())
    const headers = {}
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const lower = req.rawHeaders[i].toLowerCase()
      if (HOP.has(lower) || lower === 'cookie' || lower === TOKEN_HEADER) continue
      headers[lower] = req.rawHeaders[i + 1]
    }
    headers.host = base.host
    headers[TOKEN_HEADER] = token
    if (headers.referer) {
      try {
        const r = new URL(headers.referer)
        headers.referer = `http://device${this._devicePath(r.pathname + r.search) ?? '/'}`
      } catch {
        delete headers.referer
      }
    }
    // The page talks to the gateway same-origin; framing by the desktop makes
    // top-level navigations look cross-site, which DSH would refuse.
    if (headers['sec-fetch-site'] === 'cross-site' || headers['sec-fetch-site'] === 'none') headers['sec-fetch-site'] = 'same-origin'
    return headers
  }

  _target(devicePath) {
    const base = new URL(this.baseUrl())
    const lib = base.protocol === 'https:' ? https : http
    return { base, lib, path: `${base.pathname.replace(/\/+$/, '')}${ROUTES.tunnel}${devicePath}` }
  }

  async _forward(req, res, devicePath, retried) {
    const token = await this.token({ force: retried })
    const { base, lib, path } = this._target(devicePath)
    const upstream = lib.request(
      { protocol: base.protocol, hostname: base.hostname, port: base.port, method: req.method, path, headers: this._upstreamHeaders(req, token), agent: this.agent() },
      (up) => {
        if (up.statusCode === 401 && !retried && (req.method === 'GET' || req.method === 'HEAD')) {
          up.resume()
          this._forward(req, res, devicePath, true).catch(() => res.destroy())
          return
        }
        const headers = { ...up.headers }
        for (const h of ['connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'x-frame-options']) delete headers[h]
        headers['referrer-policy'] = 'no-referrer'
        if (typeof headers.location === 'string' && headers.location.startsWith('/') && !headers.location.startsWith('//')) {
          headers.location = `/${this.secret}${headers.location}`
        }
        res.writeHead(up.statusCode ?? 502, headers)
        up.pipe(res)
      },
    )
    upstream.on('error', (error) => {
      if (!res.headersSent) this._deny(res, 502, `device unreachable: ${error.message}`)
      else res.destroy()
    })
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy()
    })
    if (retried) upstream.end()
    else req.pipe(upstream)
  }

  async _upgrade(req, socket, head) {
    const reject = (status, text) => socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    if (!this._authorityOk(req) || !this._originOk(req)) return reject(403, 'Forbidden')
    const devicePath = this._devicePath(req.url)
    if (devicePath === undefined) return reject(404, 'Not Found')
    const token = await this.token()
    const { base, lib, path } = this._target(devicePath)
    const headers = this._upstreamHeaders(req, token)
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade ?? 'websocket'
    const upstream = lib.request({ protocol: base.protocol, hostname: base.hostname, port: base.port, method: 'GET', path, headers, agent: false })
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || 'Switching Protocols'}`]
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`)
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (upHead?.length) socket.write(upHead)
      if (head?.length) upSocket.write(head)
      this.sockets.add(upSocket)
      const close = () => {
        this.sockets.delete(upSocket)
        upSocket.destroy()
        socket.destroy()
      }
      upSocket.on('error', close)
      socket.on('error', close)
      upSocket.on('close', close)
      socket.on('close', close)
      socket.pipe(upSocket)
      upSocket.pipe(socket)
    })
    upstream.on('response', (upRes) => {
      upRes.resume()
      reject(upRes.statusCode ?? 502, upRes.statusMessage || 'Bad Gateway')
    })
    upstream.on('error', () => reject(502, 'Bad Gateway'))
    upstream.end()
  }

  async stop() {
    for (const s of this.sockets) s.destroy()
    this.sockets.clear()
    if (this.server) await new Promise((r) => this.server.close(() => r()))
    this.server = null
  }
}
