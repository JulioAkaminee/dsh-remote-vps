// Desktop-side client for one paired device: pairing, signed token refresh,
// and authenticated JSON calls. Transport-agnostic: it talks to `baseUrl`,
// which is either the device's own HTTPS URL or a local SSH-forwarded port.

import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { PORT_TUNNEL_PROTOCOL, ROUTES, TOKEN_HEADER, tokenSigningPayload } from './protocol.js'

export class DeviceHttpError extends Error {
  constructor(status, code, detail) {
    super(`${code ?? 'error'}${detail ? `: ${detail}` : ''} (HTTP ${status})`)
    this.status = status
    this.code = code
    this.detail = detail
  }
}

/** Generate the per-device client key. The private key never leaves this desktop. */
export function generateClientKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  }
}

/**
 * Minimal JSON-over-HTTP(S) request with a timeout.
 * @returns {Promise<{ status: number, body: any }>}
 */
export function requestJson(baseUrl, method, route, { body, headers = {}, timeoutMs = 15000, agent } = {}) {
  const url = new URL(route, baseUrl)
  const lib = url.protocol === 'https:' ? https : http
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method,
        agent,
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed = text
          try {
            parsed = text ? JSON.parse(text) : null
          } catch {}
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
        res.on('error', reject)
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`timeout after ${timeoutMs}ms`), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function expectOk({ status, body }) {
  if (status >= 200 && status < 300) return body
  throw new DeviceHttpError(status, body?.error, body?.detail)
}

/** Public identity probe. */
export async function hello(baseUrl, options) {
  return expectOk(await requestJson(baseUrl, 'GET', ROUTES.hello, options))
}

/** Exchange a one-time code for a client record on the device. */
export async function pair(baseUrl, { code, label, platform, publicKey }, options) {
  return expectOk(
    await requestJson(baseUrl, 'POST', ROUTES.pair, { ...options, body: { code, client: { label, platform, publicKey } } }),
  )
}

export class DeviceClient {
  /**
   * @param {{ baseUrl: () => string, deviceId: string, clientId: string, privateKeyPem: string, agent?: () => any }} options
   */
  constructor({ baseUrl, deviceId, clientId, privateKeyPem, agent }) {
    this.baseUrl = baseUrl
    this.deviceId = deviceId
    this.clientId = clientId
    this.privateKey = crypto.createPrivateKey(privateKeyPem)
    this.agent = agent ?? (() => undefined)
    /** @type {{ token: string, expiresAt: number } | null} */
    this.access = null
    this._refreshing = null
  }

  /** Sign a fresh token request and obtain a short-lived access token. */
  async _refresh() {
    const ts = Date.now()
    const nonce = crypto.randomBytes(18).toString('base64url')
    const payload = Buffer.from(tokenSigningPayload({ deviceId: this.deviceId, clientId: this.clientId, ts, nonce }))
    const sig = crypto.sign(null, payload, this.privateKey).toString('base64url')
    const body = expectOk(
      await requestJson(this.baseUrl(), 'POST', ROUTES.token, {
        agent: this.agent(),
        body: { clientId: this.clientId, ts, nonce, sig },
      }),
    )
    if (body?.device?.deviceId && body.device.deviceId !== this.deviceId) {
      throw new DeviceHttpError(409, 'device-mismatch', `expected ${this.deviceId}, got ${body.device.deviceId}`)
    }
    this.access = { token: body.token, expiresAt: body.expiresAt }
    return this.access.token
  }

  /** Current access token, refreshed when missing or within 5 minutes of expiry. */
  async token({ force = false } = {}) {
    if (!force && this.access && this.access.expiresAt - Date.now() > 5 * 60_000) return this.access.token
    if (!this._refreshing) {
      this._refreshing = this._refresh().finally(() => {
        this._refreshing = null
      })
    }
    return this._refreshing
  }

  invalidate() {
    this.access = null
  }

  /** Authenticated JSON call; retries once with a fresh token on 401. */
  async call(method, route, body, { timeoutMs } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token({ force: attempt > 0 })
      const res = await requestJson(this.baseUrl(), method, route, {
        agent: this.agent(),
        body,
        headers: { [TOKEN_HEADER]: token },
        ...(timeoutMs ? { timeoutMs } : {}),
      })
      if (res.status === 401 && attempt === 0) continue
      return expectOk(res)
    }
  }

  info() {
    return this.call('GET', ROUTES.info)
  }

  sessions() {
    return this.call('GET', ROUTES.sessions)
  }

  workspaces() {
    return this.call('GET', ROUTES.workspaces)
  }

  unpair() {
    return this.call('DELETE', ROUTES.self)
  }

  /** Long-poll the device's change feed (resolves on change or after `timeout`). */
  async watch({ boot, rev, turns, att, timeout = 25_000 } = {}) {
    const q = new URLSearchParams({ timeout: String(timeout) })
    if (boot) q.set('boot', boot)
    if (rev !== undefined) q.set('rev', String(rev))
    if (turns !== undefined) q.set('turns', String(turns))
    if (att !== undefined) q.set('att', String(att))
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token({ force: attempt > 0 })
      const res = await requestJson(this.baseUrl(), 'GET', `${ROUTES.watch}?${q}`, {
        agent: this.agent(),
        headers: { [TOKEN_HEADER]: token },
        timeoutMs: timeout + 15_000,
      })
      if (res.status === 401 && attempt === 0) continue
      return expectOk(res)
    }
  }

  modelStatus() {
    return this.call('GET', ROUTES.modelKey)
  }

  setModelKey(apiKey) {
    return this.call('PUT', ROUTES.modelKey, { apiKey })
  }

  clearModelKey() {
    return this.call('DELETE', ROUTES.modelKey)
  }

  sessionAction(body) {
    return this.call('POST', ROUTES.sessionAction, body)
  }

  /** One level of folders on the device (`path` absent: its home folder). */
  folders(path, { hidden = false } = {}) {
    const q = new URLSearchParams()
    if (path) q.set('path', path)
    if (hidden) q.set('hidden', '1')
    const qs = q.toString()
    return this.call('GET', `${ROUTES.folders}${qs ? `?${qs}` : ''}`)
  }

  makeFolder(path, name) {
    return this.call('POST', ROUTES.folders, { path, name })
  }

  workspaceAction(body) {
    return this.call('POST', ROUTES.workspaceAction, body)
  }

  search(q) {
    return this.call('GET', `${ROUTES.search}?${new URLSearchParams({ q })}`, undefined, { timeoutMs: 20_000 })
  }

  accountStatus() {
    return this.call('GET', ROUTES.account)
  }

  setAccount(grant) {
    return this.call('PUT', ROUTES.account, { grant })
  }

  clearAccount() {
    return this.call('DELETE', ROUTES.account)
  }

  syncState() {
    return this.call('GET', ROUTES.sync, undefined, { timeoutMs: 30_000 })
  }

  /** Plugin installs run pnpm on the device: allow a long time. */
  syncApply(bundle) {
    return this.call('POST', ROUTES.sync, bundle, { timeoutMs: 15 * 60_000 })
  }

  ports() {
    return this.call('GET', ROUTES.ports)
  }

  /** Hand the device a new device host to install itself (base64 installer + tarball). */
  selfUpdate(body) {
    return this.call('POST', ROUTES.selfUpdate, body, { timeoutMs: 120_000 })
  }

  selfUpdateStatus() {
    return this.call('GET', ROUTES.selfUpdate, undefined, { timeoutMs: 15_000 })
  }

  /**
   * Open a raw TCP tunnel to `port` on the device (Upgrade: dsh-port-tunnel).
   * @returns {Promise<import('node:net').Socket>} the spliced socket
   */
  async portTunnel(port) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token({ force: attempt > 0 })
      try {
        return await this._portTunnel(port, token)
      } catch (error) {
        if (error instanceof DeviceHttpError && error.status === 401 && attempt === 0) continue
        throw error
      }
    }
  }

  _portTunnel(port, token) {
    const url = new URL(`${ROUTES.portTunnel}?port=${Number(port)}`, this.baseUrl())
    const lib = url.protocol === 'https:' ? https : http
    return new Promise((resolve, reject) => {
      const req = lib.request(url, {
        method: 'GET',
        agent: false,
        headers: { connection: 'Upgrade', upgrade: PORT_TUNNEL_PROTOCOL, [TOKEN_HEADER]: token },
      })
      req.setTimeout(15_000, () => req.destroy(Object.assign(new Error('port tunnel timeout'), { code: 'ETIMEDOUT' })))
      req.on('upgrade', (res, socket, head) => {
        req.setTimeout(0)
        if (head && head.length) socket.unshift(head)
        resolve(socket)
      })
      req.on('response', (res) => {
        res.resume()
        const status = res.statusCode ?? 0
        const code = status === 401 ? 'unauthorized' : status === 404 ? 'port-tunnel-unsupported' : 'port-unreachable'
        reject(new DeviceHttpError(status, code))
      })
      req.on('error', reject)
      req.end()
    })
  }
}
