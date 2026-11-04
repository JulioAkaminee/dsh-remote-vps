// Desktop-side client for one paired device: pairing, signed token refresh,
// and authenticated JSON calls. Transport-agnostic: it talks to `baseUrl`,
// which is either the device's own HTTPS URL or a local SSH-forwarded port.

import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { ROUTES, TOKEN_HEADER, tokenSigningPayload } from './protocol.js'

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
  async call(method, route, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token({ force: attempt > 0 })
      const res = await requestJson(this.baseUrl(), method, route, {
        agent: this.agent(),
        body,
        headers: { [TOKEN_HEADER]: token },
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
  async watch({ boot, rev, turns, timeout = 25_000 } = {}) {
    const q = new URLSearchParams({ timeout: String(timeout) })
    if (boot) q.set('boot', boot)
    if (rev !== undefined) q.set('rev', String(rev))
    if (turns !== undefined) q.set('turns', String(turns))
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
}
