// Durable device state on the host: identity, paired clients, one-time
// pairing codes. Plain JSON files under `$DSH_HOME/device-host/`, written
// atomically with mode 0600 and guarded by a lock file, because the running
// plugin and the `dsh-device` CLI both mutate them.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CODE_ALPHABET, CODE_LENGTH, PAIRING_CODE_TTL_MS, normalizeCode } from './protocol.js'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function defaultStoreDir() {
  return path.join(dshHome(), 'device-host')
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(`device-host: cannot read ${file}: ${error.message}`)
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/** Random code over the unambiguous alphabet, rejection-sampled (no modulo bias). */
export function generateCode(length = CODE_LENGTH) {
  let out = ''
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte < 256 - (256 % CODE_ALPHABET.length)) out += CODE_ALPHABET[byte % CODE_ALPHABET.length]
      if (out.length === length) break
    }
  }
  return out
}

export function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`
}

export class HostStore {
  /** @param {string} [dir] */
  constructor(dir = defaultStoreDir()) {
    this.dir = dir
    this.deviceFile = path.join(dir, 'device.json')
    this.clientsFile = path.join(dir, 'clients.json')
    this.codesFile = path.join(dir, 'pairing-codes.json')
    this.lockFile = path.join(dir, '.lock')
    this.runtimeFile = path.join(dir, 'runtime.json')
    this._clientsCache = null
    this._clientsMtime = -1
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(this.dir, 0o700)
    } catch {}
  }

  /** Run `fn` holding an exclusive lock across processes. */
  withLock(fn) {
    this.ensureDir()
    const deadline = Date.now() + 5000
    let fd
    for (;;) {
      try {
        fd = fs.openSync(this.lockFile, 'wx', 0o600)
        break
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        try {
          const age = Date.now() - fs.statSync(this.lockFile).mtimeMs
          if (age > 15000) fs.rmSync(this.lockFile, { force: true })
        } catch {}
        if (Date.now() > deadline) throw new Error(`device-host: store is locked (${this.lockFile})`)
        sleepSync(25)
      }
    }
    try {
      return fn()
    } finally {
      fs.closeSync(fd)
      fs.rmSync(this.lockFile, { force: true })
    }
  }

  /** Stable identity of this device, created on first use. */
  device() {
    const existing = readJson(this.deviceFile, null)
    if (existing?.id) return existing
    return this.withLock(() => {
      const again = readJson(this.deviceFile, null)
      if (again?.id) return again
      const record = { id: crypto.randomUUID(), name: null, createdAt: new Date().toISOString() }
      writeJsonAtomic(this.deviceFile, record)
      return record
    })
  }

  setDeviceName(name) {
    return this.withLock(() => {
      const record = this.device()
      record.name = name ? String(name).slice(0, 80) : null
      writeJsonAtomic(this.deviceFile, record)
      return record
    })
  }

  // ── clients ──────────────────────────────────────────────────────────────

  /** All client records, re-read whenever the file changes (the CLI may revoke). */
  clients() {
    let mtime = -1
    try {
      mtime = fs.statSync(this.clientsFile).mtimeMs
    } catch {}
    if (this._clientsCache && mtime === this._clientsMtime) return this._clientsCache
    const doc = readJson(this.clientsFile, { clients: [] })
    this._clientsCache = Array.isArray(doc.clients) ? doc.clients : []
    this._clientsMtime = mtime
    return this._clientsCache
  }

  client(id) {
    return this.clients().find((c) => c.id === id)
  }

  /** Active (not revoked) client by id. */
  activeClient(id) {
    const c = this.client(id)
    return c && !c.revokedAt ? c : undefined
  }

  _mutateClients(fn) {
    return this.withLock(() => {
      const doc = readJson(this.clientsFile, { clients: [] })
      const clients = Array.isArray(doc.clients) ? doc.clients : []
      const result = fn(clients)
      writeJsonAtomic(this.clientsFile, { clients })
      this._clientsCache = null
      return result
    })
  }

  addClient({ label, platform, publicKey, pairedVia }) {
    return this._mutateClients((clients) => {
      const record = {
        id: randomId('cl'),
        label: String(label || 'desktop').slice(0, 80),
        platform: platform ? String(platform).slice(0, 32) : null,
        publicKey,
        pairedVia: pairedVia ?? 'code',
        createdAt: new Date().toISOString(),
        lastSeenAt: null,
        revokedAt: null,
      }
      clients.push(record)
      return record
    })
  }

  touchClient(id, at = new Date()) {
    return this._mutateClients((clients) => {
      const c = clients.find((x) => x.id === id)
      if (c) c.lastSeenAt = at.toISOString()
      return c
    })
  }

  revokeClient(id) {
    return this._mutateClients((clients) => {
      const c = clients.find((x) => x.id === id)
      if (c && !c.revokedAt) c.revokedAt = new Date().toISOString()
      return c
    })
  }

  /** Revoked clients older than `olderThanMs` are dropped; returns how many. */
  pruneRevoked(olderThanMs = 30 * 24 * 3600 * 1000) {
    return this._mutateClients((clients) => {
      const before = clients.length
      const keep = clients.filter((c) => !c.revokedAt || Date.now() - Date.parse(c.revokedAt) < olderThanMs)
      clients.splice(0, clients.length, ...keep)
      return before - keep.length
    })
  }

  // ── pairing codes ────────────────────────────────────────────────────────

  _mutateCodes(fn) {
    return this.withLock(() => {
      const doc = readJson(this.codesFile, { codes: [] })
      const now = Date.now()
      // Expired and consumed codes are kept for an hour for diagnostics, then dropped.
      const codes = (Array.isArray(doc.codes) ? doc.codes : []).filter(
        (c) => now - Date.parse(c.consumedAt ?? c.expiresAt) < 3600 * 1000,
      )
      const result = fn(codes, now)
      writeJsonAtomic(this.codesFile, { codes })
      return result
    })
  }

  /**
   * Mint a one-time pairing code. Only its hash is stored.
   * @returns {{ code: string, expiresAt: string, label: string|null }}
   */
  createCode({ ttlMs = PAIRING_CODE_TTL_MS, label = null, via = 'code' } = {}) {
    const ttl = Math.max(10_000, Math.min(Number(ttlMs) || PAIRING_CODE_TTL_MS, 24 * 3600 * 1000))
    const code = generateCode()
    const expiresAt = new Date(Date.now() + ttl).toISOString()
    this._mutateCodes((codes) => {
      codes.push({
        hash: sha256(code),
        label: label ? String(label).slice(0, 80) : null,
        via,
        createdAt: new Date().toISOString(),
        expiresAt,
        consumedAt: null,
      })
    })
    return { code, expiresAt, label }
  }

  /**
   * Consume a code exactly once.
   * @returns {{ ok: true, label: string|null, via: string } | { ok: false, reason: 'invalid'|'expired'|'used' }}
   */
  consumeCode(raw) {
    const code = normalizeCode(raw)
    if (code.length !== CODE_LENGTH) return { ok: false, reason: 'invalid' }
    const hash = Buffer.from(sha256(code), 'hex')
    return this._mutateCodes((codes, now) => {
      const entry = codes.find((c) => {
        const h = Buffer.from(c.hash, 'hex')
        return h.length === hash.length && crypto.timingSafeEqual(h, hash)
      })
      if (!entry) return { ok: false, reason: 'invalid' }
      if (entry.consumedAt) return { ok: false, reason: 'used' }
      if (Date.parse(entry.expiresAt) <= now) return { ok: false, reason: 'expired' }
      entry.consumedAt = new Date(now).toISOString()
      return { ok: true, label: entry.label, via: entry.via ?? 'code' }
    })
  }

  pendingCodes() {
    const doc = readJson(this.codesFile, { codes: [] })
    const now = Date.now()
    return (doc.codes ?? []).filter((c) => !c.consumedAt && Date.parse(c.expiresAt) > now)
  }

  // ── runtime facts written by the running plugin, read by the CLI ─────────

  writeRuntime(info) {
    this.ensureDir()
    writeJsonAtomic(this.runtimeFile, info)
  }

  runtime() {
    return readJson(this.runtimeFile, null)
  }

  clearRuntime(pid) {
    const current = this.runtime()
    if (current && current.pid === pid) fs.rmSync(this.runtimeFile, { force: true })
  }
}
