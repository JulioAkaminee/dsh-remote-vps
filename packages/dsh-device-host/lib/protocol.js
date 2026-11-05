// Shared wire contract between dsh-device-host (runs on the VPS) and
// dsh-devices (runs on the controlling desktop). This file is duplicated
// byte-for-byte in both packages; `npm test` fails when the copies drift.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
   * Authenticated long-poll: `?rev=<n>&turns=<seq>&att=<seq>&timeout=<ms>` answers as soon as the
   * session list changes (or at the timeout) with
   * `{ boot, rev, turnSeq, turnEnds[], attSeq, attention[], items?, workspaces?, archived?, ports? }`.
   * `attention` lists sessions that started waiting for the user (approval or question).
   */
  watch: `${DEVICE_BASE}/watch`,
  /** Authenticated. GET model-credential status; PUT { apiKey } stores it; DELETE removes it. */
  modelKey: `${DEVICE_BASE}/model-key`,
  /** Authenticated. DELETE removes the calling client (unpair from the desktop). */
  self: `${DEVICE_BASE}/clients/self`,
  /**
   * Authenticated. POST `{ sessionId, action, title?, force? }` where action is
   * rename | pin | unpin | archive | unarchive.
   */
  sessionAction: `${DEVICE_BASE}/session-action`,
  /** Authenticated. GET `?q=` searches message content: `{ items: [{ sessionId, title, snippet }] }`. */
  search: `${DEVICE_BASE}/search`,
  /** Authenticated. GET DeepSeek account status; PUT `{ grant }` stores a sign-in; DELETE signs out here only. */
  account: `${DEVICE_BASE}/account`,
  /** Authenticated. GET what is customised on the device; POST a bundle of customisations to apply. */
  sync: `${DEVICE_BASE}/sync`,
  /** Authenticated. GET listening TCP ports of this user's processes (dev servers to preview). */
  ports: `${DEVICE_BASE}/ports`,
  /** Authenticated upgrade (`Upgrade: dsh-port-tunnel`, `?port=`): raw TCP to 127.0.0.1:<port> on the device. */
  portTunnel: `${DEVICE_BASE}/port-tunnel`,
  /**
   * Authenticated. POST `{ installer, tarball, tarballName, dshVersion }` (base64) installs a new
   * device host on the device itself, rolling back if it does not come up; GET reports the last update.
   */
  selfUpdate: `${DEVICE_BASE}/self-update`,
  /** Authenticated. Everything below is proxied to the host's own DSH web UI. */
  tunnel: `${DEVICE_BASE}/t`,
})

/** Credential reference the DeepSeek provider resolves (its default `apiKeyEnv`). */
export const MODEL_KEY_REF = 'DEEPSEEK_API_KEY'

/** Credential record holding a DeepSeek account sign-in (dsh-deepseek-account-platform). */
export const ACCOUNT_GRANT_KEY = 'deepseek-account-platform/default'

/** `Upgrade:` token of the raw port tunnel. */
export const PORT_TUNNEL_PROTOCOL = 'dsh-port-tunnel'

/** Capabilities a device host advertises in /info (desktops degrade gracefully without them). */
export const HOST_FEATURES = Object.freeze(['watch', 'model-key', 'pending', 'session-actions', 'search', 'account', 'sync', 'ports', 'health', 'panels'])
/** Advertised only when the host was installed by install-host.sh (it knows its installation root). */
export const SELF_UPDATE_FEATURE = 'self-update'

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

/** Marker file inside a skill directory written by "Sync with device". */
export const SKILL_SYNC_MARK = '.dsh-devices-sync'

/** Content hash both sides compute to tell whether a synced text changed. */
export function contentHash(text) {
  return crypto.createHash('sha256').update(String(text).replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 24)
}

/** Hash of a skill: its files' relative paths and bytes (the sync marker excluded). */
export function skillHash(files) {
  const h = crypto.createHash('sha256')
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (f.path === SKILL_SYNC_MARK) continue
    h.update(f.path)
    h.update('\0')
    h.update(Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data ?? ''))
    h.update('\0')
  }
  return h.digest('hex').slice(0, 24)
}

/** Harness home and shared agents home, resolved like DSH does. */
export function homes() {
  return {
    dsh: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    agents: process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents'),
  }
}

/** Limits for synced skills. */
export const MAX_SKILL_BYTES = 8 * 1024 * 1024
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024
export const SAFE_SYNC_NAME = /^[A-Za-z0-9][\w.@+-]{0,127}$/

/** Files of a skill directory (or a flat `<name>.md`), bounded. */
export function readSkill(root, name) {
  const dir = path.join(root, name)
  let stat
  try {
    stat = fs.statSync(dir)
  } catch {
    return null
  }
  if (stat.isFile()) {
    if (!name.endsWith('.md') || stat.size > MAX_SKILL_FILE_BYTES) return null
    return { flat: true, files: [{ path: name, data: fs.readFileSync(dir) }] }
  }
  if (!stat.isDirectory()) return null
  const files = []
  let total = 0
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue
      if (entry.name === 'node_modules' || entry.name === '__pycache__') continue
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(relPath)
      else if (entry.isFile()) {
        const size = fs.statSync(path.join(dir, relPath)).size
        if (size > MAX_SKILL_FILE_BYTES) continue
        total += size
        if (total > MAX_SKILL_BYTES) throw new Error(`skill ${name} is larger than ${MAX_SKILL_BYTES / 1024 / 1024} MB`)
        files.push({ path: relPath, data: fs.readFileSync(path.join(dir, relPath)) })
      }
    }
  }
  walk('')
  if (!files.some((f) => f.path === 'SKILL.md' || f.path.endsWith('.md'))) return null
  return { flat: false, files }
}

/** Skill names under a root: directories and flat markdown files. */
export function listSkillNames(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || (e.isFile() && e.name.endsWith('.md'))) && SAFE_SYNC_NAME.test(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}
