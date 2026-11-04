// The tunnel: the single authenticated door through which a paired desktop
// reaches this host's own DSH web UI.
//
// Requests arrive at `/device/v1/t/<path>` carrying a device access token.
// They are replayed against the local DSH listener as if they came from a
// loopback browser: Host/Origin are rewritten to the listener's authority and
// the DSH browser-session cookie — minted here by exchanging the process
// launch token — is attached. That cookie never leaves this process, so a
// revoked client loses access immediately and no DSH credential is exposed.

import http from 'node:http'
import net from 'node:net'
import { HOP_BY_HOP } from './http-util.js'
import { TOKEN_HEADER } from './protocol.js'

const STRIP_REQUEST = new Set([
  ...HOP_BY_HOP,
  'host',
  'cookie',
  TOKEN_HEADER,
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
])

const STRIP_RESPONSE = new Set([...HOP_BY_HOP, 'set-cookie'])

function cookiePairs(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
  return list.map((line) => String(line).split(';')[0].trim()).filter((pair) => pair.includes('='))
}

export class LocalTunnel {
  /**
   * @param {{
   *   origin: () => string,
   *   authenticatedUrl: (base: string) => string,
   *   logger?: { info: Function, warn: Function },
   * }} options
   */
  constructor({ origin, authenticatedUrl, logger = console }) {
    this.origin = origin
    this.authenticatedUrl = authenticatedUrl
    this.logger = logger
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 128 })
    /** @type {Map<string, string>} cookie name -> value */
    this.jar = new Map()
    this._pending = null
    /** @type {Set<import('node:net').Socket>} */
    this.sockets = new Set()
  }

  get target() {
    const url = new URL(this.origin())
    return { url, host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || 80, authority: url.host }
  }

  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  _absorb(setCookie) {
    for (const pair of cookiePairs(setCookie)) {
      const i = pair.indexOf('=')
      this.jar.set(pair.slice(0, i), pair.slice(i + 1))
    }
  }

  invalidate() {
    this.jar.clear()
  }

  /** Exchange the process launch token for the DSH browser cookie (once, lazily). */
  async ensureCookie() {
    if (this.jar.size > 0) return
    if (!this._pending) {
      this._pending = this._exchange().finally(() => {
        this._pending = null
      })
    }
    await this._pending
  }

  _exchange() {
    const { url, authority } = this.target
    const tokenUrl = new URL(this.authenticatedUrl(`${url.origin}/`))
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: this.target.host,
          port: this.target.port,
          method: 'GET',
          path: `${tokenUrl.pathname}${tokenUrl.search}`,
          headers: { host: authority, accept: 'text/html' },
          agent: this.agent,
        },
        (res) => {
          res.resume()
          this._absorb(res.headers['set-cookie'])
          if (this.jar.size === 0) {
            reject(new Error(`device-host: launch-token exchange returned ${res.statusCode} without a session cookie`))
          } else resolve()
        },
      )
      req.on('error', reject)
      req.setTimeout(15000, () => req.destroy(new Error('launch-token exchange timed out')))
      req.end()
    })
  }

  _requestHeaders(req) {
    const { url, authority } = this.target
    const headers = {}
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]
      const lower = name.toLowerCase()
      if (STRIP_REQUEST.has(lower)) continue
      headers[lower] = headers[lower] === undefined ? req.rawHeaders[i + 1] : `${headers[lower]}, ${req.rawHeaders[i + 1]}`
    }
    headers.host = authority
    if (headers.origin) headers.origin = url.origin
    if (headers.referer) {
      try {
        const r = new URL(headers.referer)
        headers.referer = `${url.origin}${r.pathname}${r.search}`
      } catch {
        delete headers.referer
      }
    }
    const cookie = this.cookieHeader()
    if (cookie) headers.cookie = cookie
    return headers
  }

  _responseHeaders(upstream) {
    const { url } = this.target
    const out = {}
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (STRIP_RESPONSE.has(name)) continue
      out[name] = value
    }
    if (typeof out.location === 'string' && out.location.startsWith(url.origin)) {
      out.location = out.location.slice(url.origin.length) || '/'
    }
    return out
  }

  /**
   * Proxy one HTTP request to the local listener.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} upstreamPath - path + query below the tunnel prefix, starting with '/'
   */
  async handleHttp(req, res, upstreamPath) {
    try {
      await this.ensureCookie()
    } catch (error) {
      this.logger.warn?.(`[dsh-device-host] tunnel cookie unavailable: ${error.message}`)
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end('device host is starting')
      return
    }
    const retryable = req.method === 'GET' || req.method === 'HEAD'
    const send = (attempt) => {
      const upstream = http.request(
        {
          host: this.target.host,
          port: this.target.port,
          method: req.method,
          path: upstreamPath,
          headers: this._requestHeaders(req),
          agent: this.agent,
        },
        (up) => {
          if (up.statusCode === 401 && attempt === 0 && retryable) {
            // The DSH signing secret may have rotated; mint a fresh cookie once.
            up.resume()
            this.invalidate()
            this.ensureCookie().then(
              () => send(1),
              () => {
                res.writeHead(502)
                res.end()
              },
            )
            return
          }
          if (up.headers['set-cookie']) this._absorb(up.headers['set-cookie'])
          res.writeHead(up.statusCode ?? 502, this._responseHeaders(up))
          up.pipe(res)
          up.on('error', () => res.destroy())
        },
      )
      upstream.on('error', (error) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain' })
          res.end(`tunnel upstream error: ${error.message}`)
        } else res.destroy()
      })
      res.on('close', () => {
        if (!res.writableFinished) upstream.destroy()
      })
      if (attempt === 0) req.pipe(upstream)
      else upstream.end()
    }
    send(0)
  }

  /**
   * Proxy a WebSocket upgrade by replaying the handshake on a raw socket.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   * @param {string} upstreamPath
   */
  async handleUpgrade(req, socket, head, upstreamPath) {
    try {
      await this.ensureCookie()
    } catch {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const headers = this._requestHeaders(req)
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade ?? 'websocket'
    const lines = [`GET ${upstreamPath} HTTP/1.1`]
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`)
    const upstream = net.connect(this.target.port, this.target.host)
    this.sockets.add(upstream)
    this.sockets.add(socket)
    const cleanup = () => {
      this.sockets.delete(upstream)
      this.sockets.delete(socket)
      upstream.destroy()
      socket.destroy()
    }
    upstream.once('connect', () => {
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head?.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', cleanup)
    socket.on('error', cleanup)
    upstream.on('close', cleanup)
    socket.on('close', cleanup)
  }

  dispose() {
    for (const s of this.sockets) s.destroy()
    this.sockets.clear()
    this.agent.destroy()
  }
}
