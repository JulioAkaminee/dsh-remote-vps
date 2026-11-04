// Client authentication on the host.
//
// Pairing leaves the host with the client's Ed25519 public key. To act, a
// client signs a fresh, device-bound payload and receives a short-lived
// opaque access token (kept only in this process's memory). Every tunnel and
// API request carries that token; revoking the client in the store
// invalidates its tokens on the very next request.

import crypto from 'node:crypto'
import { ACCESS_TOKEN_TTL_MS, SIGNATURE_MAX_SKEW_MS, tokenSigningPayload } from './protocol.js'

/** Parse a base64url SPKI DER Ed25519 public key; throws on anything else. */
export function parsePublicKey(spkiB64url) {
  const der = Buffer.from(String(spkiB64url ?? ''), 'base64url')
  if (der.length < 32 || der.length > 128) throw new Error('invalid public key')
  const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('public key must be ed25519')
  return key
}

export class HostAuth {
  /**
   * @param {import('./store.js').HostStore} store
   * @param {{ now?: () => number, tokenTtlMs?: number }} [options]
   */
  constructor(store, options = {}) {
    this.store = store
    this.now = options.now ?? Date.now
    this.tokenTtlMs = options.tokenTtlMs ?? ACCESS_TOKEN_TTL_MS
    /** @type {Map<string, { clientId: string, expiresAt: number }>} */
    this.tokens = new Map()
    /** @type {Map<string, number>} nonce -> expiry */
    this.nonces = new Map()
    /** @type {Map<string, number>} clientId -> last persisted lastSeenAt */
    this.lastTouch = new Map()
    /** Pairing failure timestamps for rate limiting. */
    this.pairFailures = []
  }

  _prune() {
    const now = this.now()
    for (const [k, v] of this.tokens) if (v.expiresAt <= now) this.tokens.delete(k)
    for (const [k, v] of this.nonces) if (v <= now) this.nonces.delete(k)
  }

  /**
   * Verify a signed token request and issue an access token.
   * @returns {{ ok: true, token: string, expiresAt: number, client: object } | { ok: false, status: number, error: string }}
   */
  issueToken({ clientId, ts, nonce, sig }, deviceId) {
    this._prune()
    const client = this.store.activeClient(String(clientId ?? ''))
    if (!client) return { ok: false, status: 401, error: 'unknown-or-revoked-client' }
    const t = Number(ts)
    if (!Number.isFinite(t) || Math.abs(this.now() - t) > SIGNATURE_MAX_SKEW_MS) {
      return { ok: false, status: 401, error: 'stale-signature' }
    }
    const n = String(nonce ?? '')
    if (n.length < 16 || n.length > 128) return { ok: false, status: 400, error: 'bad-nonce' }
    if (this.nonces.has(`${clientId}:${n}`)) return { ok: false, status: 401, error: 'replayed-nonce' }
    let valid = false
    try {
      const key = parsePublicKey(client.publicKey)
      const payload = Buffer.from(tokenSigningPayload({ deviceId, clientId, ts: t, nonce: n }))
      valid = crypto.verify(null, payload, key, Buffer.from(String(sig ?? ''), 'base64url'))
    } catch {
      valid = false
    }
    if (!valid) return { ok: false, status: 401, error: 'bad-signature' }
    this.nonces.set(`${clientId}:${n}`, this.now() + 2 * SIGNATURE_MAX_SKEW_MS)
    const token = crypto.randomBytes(32).toString('base64url')
    const expiresAt = this.now() + this.tokenTtlMs
    this.tokens.set(token, { clientId: client.id, expiresAt })
    this._touch(client.id)
    return { ok: true, token, expiresAt, client }
  }

  /**
   * Resolve an access token to its live client, or undefined.
   * @param {string|undefined} token
   */
  authenticate(token) {
    if (!token || typeof token !== 'string') return undefined
    const entry = this.tokens.get(token)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.tokens.delete(token)
      return undefined
    }
    const client = this.store.activeClient(entry.clientId)
    if (!client) {
      this.revokeTokensFor(entry.clientId)
      return undefined
    }
    this._touch(client.id)
    return client
  }

  revokeTokensFor(clientId) {
    for (const [k, v] of this.tokens) if (v.clientId === clientId) this.tokens.delete(k)
  }

  /** Persist lastSeenAt at most once a minute per client. */
  _touch(clientId) {
    const now = this.now()
    if (now - (this.lastTouch.get(clientId) ?? 0) < 60_000) return
    this.lastTouch.set(clientId, now)
    try {
      this.store.touchClient(clientId, new Date(now))
    } catch {}
  }

  // ── pairing rate limit: 10 failures per 10 minutes locks pairing for the window ──

  pairingLocked() {
    const cutoff = this.now() - 10 * 60_000
    this.pairFailures = this.pairFailures.filter((t) => t > cutoff)
    return this.pairFailures.length >= 10
  }

  recordPairFailure() {
    this.pairFailures.push(this.now())
  }
}
