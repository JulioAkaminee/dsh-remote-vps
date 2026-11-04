// Shared wire contract between dsh-device-host (runs on the VPS) and
// dsh-devices (runs on the controlling desktop). This file is duplicated
// byte-for-byte in both packages; `npm test` fails when the copies drift.

/** Bumped on any incompatible change to the routes or payloads below. */
export const PROTOCOL_VERSION = 1

/** Every device route lives under this prefix on the host's web listener. */
export const DEVICE_BASE = '/device/v1'

export const ROUTES = Object.freeze({
  /** Public. Who is this? `{ protocol, deviceId, name, pairing }` */
  hello: `${DEVICE_BASE}/hello`,
  /** Public, rate limited. Exchange a one-time code for a client record. */
  pair: `${DEVICE_BASE}/pair`,
  /** Public. Signed proof of the client key returns a short-lived access token. */
  token: `${DEVICE_BASE}/token`,
  /** Authenticated JSON reads. */
  info: `${DEVICE_BASE}/info`,
  sessions: `${DEVICE_BASE}/sessions`,
  workspaces: `${DEVICE_BASE}/workspaces`,
  /**
   * Authenticated long-poll: `?rev=<n>&turns=<seq>&timeout=<ms>` answers as soon as the session
   * list changes (or at the timeout) with `{ boot, rev, turnSeq, turnEnds[], items?, workspaces? }`.
   */
  watch: `${DEVICE_BASE}/watch`,
  /** Authenticated. GET model-credential status; PUT { apiKey } stores it; DELETE removes it. */
  modelKey: `${DEVICE_BASE}/model-key`,
  /** Authenticated. DELETE removes the calling client (unpair from the desktop). */
  self: `${DEVICE_BASE}/clients/self`,
  /** Authenticated. Everything below is proxied to the host's own DSH web UI. */
  tunnel: `${DEVICE_BASE}/t`,
})

/** Credential reference the DeepSeek provider resolves (its default `apiKeyEnv`). */
export const MODEL_KEY_REF = 'DEEPSEEK_API_KEY'

/** Capabilities a device host advertises in /info (desktops degrade gracefully without them). */
export const HOST_FEATURES = Object.freeze(['watch', 'model-key'])

/** Longest long-poll a host holds open. */
export const WATCH_MAX_MS = 30_000

/** Header carrying the short-lived access token on authenticated requests. */
export const TOKEN_HEADER = 'x-dsh-device-token'

/** Access tokens live this long; clients refresh ahead of expiry. */
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000

/** Signed token requests must be this fresh. */
export const SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000

/** Default one-time pairing code lifetime. */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000

/** Crockford base32 without I, L, O, U: unambiguous when read aloud or typed. */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Pairing codes have 8 symbols (40 bits), shown as XXXX-XXXX. */
export const CODE_LENGTH = 8

/** Remote WebSocket paths the tunnel forwards (DSH's Gateway mux). */
export const TUNNEL_UPGRADE_PATHS = Object.freeze(['/api/remote.mux'])

/**
 * Normalize user-typed codes: case-insensitive, separators ignored, and the
 * usual look-alikes mapped the way Crockford base32 specifies.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeCode(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[\s_-]+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
}

/**
 * Format a normalized code for display.
 * @param {string} code
 */
export function formatCode(code) {
  const c = normalizeCode(code)
  return c.length === CODE_LENGTH ? `${c.slice(0, 4)}-${c.slice(4)}` : c
}

/**
 * The exact bytes a client signs to obtain an access token. Binding the
 * device id stops a signature for one device from being replayed to another.
 */
export function tokenSigningPayload({ deviceId, clientId, ts, nonce }) {
  return `dsh-device-token\n${deviceId}\n${clientId}\n${ts}\n${nonce}`
}

/** `dsh-device://pair?u=<base url>&c=<code>&d=<device id>` */
export function buildPairingLink({ url, code, deviceId }) {
  const q = new URLSearchParams()
  if (url) q.set('u', url)
  q.set('c', formatCode(code))
  if (deviceId) q.set('d', deviceId)
  return `dsh-device://pair?${q.toString()}`
}

/**
 * Parse a pairing link, or a bare code. Returns `{ code, url?, deviceId? }`.
 * @param {string} input
 */
export function parsePairingInput(input) {
  const text = String(input ?? '').trim()
  if (text.startsWith('dsh-device://')) {
    const q = new URL(text.replace(/^dsh-device:\/\//, 'http://x/')).searchParams
    return {
      code: normalizeCode(q.get('c') ?? ''),
      url: q.get('u') || undefined,
      deviceId: q.get('d') || undefined,
    }
  }
  return { code: normalizeCode(text) }
}
