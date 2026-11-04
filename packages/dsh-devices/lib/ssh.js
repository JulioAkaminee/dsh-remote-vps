// SSH transport for devices: ~/.ssh/config resolution, pinned host keys,
// agent + key authentication, one ProxyJump hop, remote exec, SFTP upload,
// and a local TCP listener that forwards into the device's loopback port.

import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
// ssh2 is vendored (lib/vendor) so the plugin has no dependencies: installs work offline
// and need no package build scripts in any package manager.
import ssh2 from './vendor/node_modules/ssh2/lib/index.js'

const { Client, utils } = ssh2

const SSH_DIR = () => path.join(os.homedir(), '.ssh')

function expandHome(p) {
  if (!p) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

function globToRegExp(glob) {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
}

/** Read ~/.ssh/config into blocks, following Include directives (one level of globs). */
function readSshConfigBlocks(file = path.join(SSH_DIR(), 'config'), depth = 0) {
  if (depth > 4) return []
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const blocks = [{ patterns: ['*'], options: [], implicit: true }]
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(\S+?)\s*(?:=\s*|\s+)(.+)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim().replace(/^"(.*)"$/, '$1')
    if (key === 'host') {
      blocks.push({ patterns: value.split(/\s+/), options: [] })
    } else if (key === 'match') {
      blocks.push({ patterns: [], options: [], unsupported: true })
    } else if (key === 'include') {
      for (const spec of value.split(/\s+/)) {
        const full = path.isAbsolute(expandHome(spec)) ? expandHome(spec) : path.join(SSH_DIR(), spec)
        const dir = path.dirname(full)
        const base = path.basename(full)
        let files = [full]
        if (/[*?]/.test(base)) {
          try {
            files = fs.readdirSync(dir).filter((f) => globToRegExp(base).test(f)).sort().map((f) => path.join(dir, f))
          } catch {
            files = []
          }
        }
        for (const f of files) blocks.push(...readSshConfigBlocks(f, depth + 1).filter((b) => !b.implicit))
      }
    } else {
      blocks[blocks.length - 1].options.push([key, value])
    }
  }
  return blocks
}

function blockMatches(block, alias) {
  if (block.unsupported) return false
  let matched = false
  for (const pattern of block.patterns) {
    if (pattern.startsWith('!')) {
      if (globToRegExp(pattern.slice(1)).test(alias)) return false
    } else if (globToRegExp(pattern).test(alias)) matched = true
  }
  return matched
}

// ── machines already saved on this computer by the desktop's dsh-tauri-remote ──
// `$DSH_HOME/remote/machines.json` (legacy `$DSH_HOME/ssh/machines.json`):
//   { version, enabled, machines: { [id]: { id, name, host, port, user, password?, passphrase?, ... } } }
// `$DSH_HOME/remote/known-hosts.json`: [{ machineId, fingerprint: "SHA256:..." }] — keys the user accepted there.

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Saved SSH machines, with their accepted host-key fingerprint when known.
 * Secrets are included only when `withSecrets` is true (host side, never sent to the browser).
 */
export function listSavedMachines({ withSecrets = false } = {}) {
  const out = []
  const seen = new Set()
  for (const dir of ['remote', 'ssh']) {
    const doc = readJsonFile(path.join(dshHomeDir(), dir, 'machines.json'))
    const fingerprints = readJsonFile(path.join(dshHomeDir(), dir, 'known-hosts.json'))
    const fpOf = (id) => (Array.isArray(fingerprints) ? fingerprints.find((r) => r && r.machineId === id)?.fingerprint : undefined)
    const machines = doc && typeof doc.machines === 'object' && doc.machines ? Object.values(doc.machines) : []
    for (const m of machines) {
      if (!m || typeof m.id !== 'string' || typeof m.host !== 'string' || !m.host || seen.has(m.id)) continue
      if (m.transport !== undefined && m.transport !== 'ssh') continue
      seen.add(m.id)
      const port = typeof m.port === 'number' ? m.port : 22
      const user = typeof m.user === 'string' && m.user ? m.user : undefined
      const fingerprint = fpOf(m.id)
      out.push({
        id: m.id,
        source: 'dsh-tauri-remote',
        name: typeof m.name === 'string' && m.name ? m.name : m.host,
        host: m.host,
        port,
        user,
        target: `${user ? `${user}@` : ''}${m.host}${port !== 22 ? `:${port}` : ''}`,
        fingerprint: typeof fingerprint === 'string' && fingerprint.startsWith('SHA256:') ? fingerprint : undefined,
        hasPassword: typeof m.password === 'string' && m.password !== '',
        ...(withSecrets ? { password: m.password || undefined, passphrase: m.passphrase || undefined } : {}),
      })
    }
  }
  return out
}

/** Concrete Host aliases (no wildcards) for the "Add device" picker. */
export function listSshAliases() {
  const out = new Set()
  for (const block of readSshConfigBlocks()) {
    for (const p of block.patterns) if (!/[*?!]/.test(p)) out.add(p)
  }
  return [...out]
}

/**
 * Resolve `target` ("alias", "user@host", "host:port", "user@host:port") through ~/.ssh/config.
 * First obtained value wins, as in OpenSSH.
 */
export function resolveSshTarget(target, overrides = {}) {
  let text = String(target ?? '').trim()
  if (!text) throw new Error('ssh target is empty')
  let user
  let port
  if (text.includes('@')) [user, text] = [text.slice(0, text.lastIndexOf('@')), text.slice(text.lastIndexOf('@') + 1)]
  const portMatch = text.match(/^(.*?):(\d+)$/)
  if (portMatch && !text.startsWith('[')) [text, port] = [portMatch[1], Number(portMatch[2])]
  const bracket = text.match(/^\[(.+)\](?::(\d+))?$/)
  if (bracket) [text, port] = [bracket[1], bracket[2] ? Number(bracket[2]) : port]
  const alias = text
  const opts = {}
  const identityFiles = []
  for (const block of readSshConfigBlocks()) {
    if (!blockMatches(block, alias)) continue
    for (const [k, v] of block.options) {
      if (k === 'identityfile') identityFiles.push(v)
      else if (!(k in opts)) opts[k] = v
    }
  }
  const resolvedUser = overrides.username || user || opts.user || os.userInfo().username
  const hostName = (opts.hostname || alias).replace(/%h/g, alias)
  const expand = (p) => expandHome(p.replace(/%d/g, os.homedir()).replace(/%u/g, os.userInfo().username).replace(/%r/g, resolvedUser).replace(/%h/g, hostName))
  return {
    alias,
    host: hostName,
    port: Number(overrides.port || port || opts.port || 22),
    username: resolvedUser,
    identityFiles: [...(overrides.identityFile ? [overrides.identityFile] : []), ...identityFiles].map(expand),
    proxyJump: overrides.proxyJump ?? (opts.proxyjump && opts.proxyjump.toLowerCase() !== 'none' ? opts.proxyjump.split(',')[0].trim() : undefined),
    identitiesOnly: String(opts.identitiesonly ?? '').toLowerCase() === 'yes',
  }
}

/** OpenSSH-style fingerprint: "SHA256:<base64 without padding>". */
export function fingerprint(keyBlob) {
  return `SHA256:${crypto.createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`
}

/** Whether ~/.ssh/known_hosts already vouches for this exact key. */
export function knownHostsHas(host, port, keyBlob) {
  let text
  try {
    text = fs.readFileSync(path.join(SSH_DIR(), 'known_hosts'), 'utf8')
  } catch {
    return false
  }
  const names = port === 22 ? [host] : [`[${host}]:${port}`]
  const want = keyBlob.toString('base64')
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3 || parts[0].startsWith('#')) continue
    if (parts[0].startsWith('@')) continue
    const [hosts, , key] = parts
    if (key !== want) continue
    for (const entry of hosts.split(',')) {
      if (entry.startsWith('|1|')) {
        const [, , salt, hash] = entry.split('|')
        for (const name of names) {
          const h = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64')
          if (h === hash) return true
        }
      } else if (names.some((n) => globToRegExp(entry).test(n))) return true
    }
  }
  return false
}

function loadKeys(resolved, passphrase) {
  const files = [...resolved.identityFiles]
  if (!resolved.identitiesOnly || files.length === 0) {
    for (const f of ['id_ed25519', 'id_ecdsa', 'id_rsa']) files.push(path.join(SSH_DIR(), f))
  }
  const keys = []
  const seen = new Set()
  for (const file of files) {
    if (seen.has(file)) continue
    seen.add(file)
    let data
    try {
      data = fs.readFileSync(file)
    } catch {
      continue
    }
    let parsed = utils.parseKey(data)
    if (parsed instanceof Error && passphrase) parsed = utils.parseKey(data, passphrase)
    if (parsed instanceof Error) continue // encrypted without a known passphrase, or unsupported: use ssh-agent
    keys.push({ file, data, passphrase: utils.parseKey(data) instanceof Error ? passphrase : undefined })
  }
  return keys
}

function authHandlerFor(resolved, { password, passphrase } = {}) {
  const methods = []
  const agent = process.env.SSH_AUTH_SOCK
  if (agent && !resolved.identitiesOnly) methods.push({ type: 'agent', username: resolved.username, agent })
  for (const key of loadKeys(resolved, passphrase)) {
    methods.push({ type: 'publickey', username: resolved.username, key: key.data, ...(key.passphrase ? { passphrase: key.passphrase } : {}) })
  }
  if (agent && resolved.identitiesOnly) methods.push({ type: 'agent', username: resolved.username, agent })
  if (password) methods.push({ type: 'password', username: resolved.username, password })
  if (methods.length === 0) methods.push({ type: 'none', username: resolved.username })
  return methods
}

/**
 * One SSH connection. `expectFingerprint` pins the host key: a different key
 * aborts the handshake. Without a pin, the presented key is recorded so the
 * caller can ask the user to confirm it.
 */
export class SshConnection {
  constructor(resolved, { expectFingerprint, password, passphrase, readyTimeout = 20000 } = {}) {
    this.resolved = resolved
    this.expectFingerprint = expectFingerprint
    this.password = password
    this.passphrase = passphrase
    this.readyTimeout = readyTimeout
    this.client = null
    this.jump = null
    this.presented = null
    this.closed = false
    this.onClose = null
  }

  async connect() {
    let sock
    if (this.resolved.proxyJump) {
      const jumpResolved = resolveSshTarget(this.resolved.proxyJump)
      this.jump = new SshConnection(jumpResolved, { readyTimeout: this.readyTimeout, trustKnownHostsOnly: true })
      this.jump.allowUnpinned = true
      await this.jump.connect()
      sock = await new Promise((resolve, reject) =>
        this.jump.client.forwardOut('127.0.0.1', 0, this.resolved.host, this.resolved.port, (err, stream) =>
          err ? reject(err) : resolve(stream),
        ),
      )
    }
    const client = new Client()
    this.client = client
    await new Promise((resolve, reject) => {
      let settled = false
      const done = (err) => {
        if (settled) return
        settled = true
        err ? reject(err) : resolve()
      }
      client.on('ready', () => done())
      client.on('error', (err) => done(err))
      client.on('close', () => {
        this.closed = true
        done(new Error('ssh connection closed during handshake'))
        this.onClose?.()
      })
      client.connect({
        host: this.resolved.host,
        port: this.resolved.port,
        username: this.resolved.username,
        sock,
        readyTimeout: this.readyTimeout,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
        authHandler: authHandlerFor(this.resolved, { password: this.password, passphrase: this.passphrase }),
        hostVerifier: (key) => {
          const fp = fingerprint(key)
          this.presented = { fingerprint: fp, known: knownHostsHas(this.resolved.host, this.resolved.port, key) }
          if (this.expectFingerprint) return fp === this.expectFingerprint
          // Unpinned: only a jump host may proceed on known_hosts trust alone;
          // a device's first contact always stops for explicit confirmation.
          return this.allowUnpinned ? this.presented.known : false
        },
      })
    }).catch((error) => {
      if (!this.expectFingerprint && this.presented && !this.allowUnpinned) {
        throw Object.assign(new Error('host key requires confirmation'), { code: 'HOSTKEY_UNCONFIRMED', presented: this.presented })
      }
      if (this.expectFingerprint && this.presented && this.presented.fingerprint !== this.expectFingerprint) {
        throw Object.assign(new Error(`host key changed: expected ${this.expectFingerprint}, got ${this.presented.fingerprint}`), {
          code: 'HOSTKEY_MISMATCH',
          presented: this.presented,
        })
      }
      if (/authentication methods failed/i.test(error.message)) {
        throw Object.assign(new Error(`ssh authentication failed for ${this.resolved.username}@${this.resolved.host} (use ssh-agent or an unencrypted key)`), {
          code: 'AUTH_FAILED',
        })
      }
      throw error
    })
    return this
  }

  /** Run a command; resolves with exit code and captured output (capped at 4 MB each). */
  exec(command, { onLine, timeoutMs = 10 * 60_000, stdin } = {}) {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, stream) => {
        if (err) return reject(err)
        let stdout = ''
        let stderr = ''
        let lineBuf = ''
        const timer = setTimeout(() => {
          stream.close()
          reject(new Error(`remote command timed out after ${Math.round(timeoutMs / 1000)}s`))
        }, timeoutMs)
        const feed = (chunk, which) => {
          const s = chunk.toString('utf8')
          if (which === 'out' && stdout.length < 4e6) stdout += s
          if (which === 'err' && stderr.length < 4e6) stderr += s
          if (onLine) {
            lineBuf += s
            let i
            while ((i = lineBuf.indexOf('\n')) >= 0) {
              onLine(lineBuf.slice(0, i))
              lineBuf = lineBuf.slice(i + 1)
            }
          }
        }
        stream.on('data', (c) => feed(c, 'out'))
        stream.stderr.on('data', (c) => feed(c, 'err'))
        stream.on('close', (code) => {
          clearTimeout(timer)
          if (onLine && lineBuf) onLine(lineBuf)
          resolve({ code: code ?? 0, stdout, stderr })
        })
        if (stdin !== undefined) stream.end(stdin)
      })
    })
  }

  /** Upload local files over SFTP: [[localPath, remotePath], ...]. Remote dirs must exist. */
  upload(pairs) {
    return new Promise((resolve, reject) => {
      this.client.sftp(async (err, sftp) => {
        if (err) return reject(err)
        try {
          for (const [local, remote] of pairs) {
            await new Promise((res, rej) => sftp.fastPut(local, remote, (e) => (e ? rej(e) : res())))
          }
          sftp.end()
          resolve()
        } catch (e) {
          sftp.end()
          reject(e)
        }
      })
    })
  }

  /**
   * Listen on 127.0.0.1:<ephemeral> and forward each connection to
   * remoteHost:remotePort as seen from the device.
   * @returns {Promise<{ port: number, close: () => void }>}
   */
  /** A direct-tcpip stream to host:port as seen from the server. */
  openStream(host, port) {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.client) return reject(new Error('ssh connection closed'))
      this.client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => (err ? reject(err) : resolve(stream)))
    })
  }

  forwardLocal(remotePort, remoteHost = '127.0.0.1') {
    const sockets = new Set()
    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      if (this.closed) return socket.destroy()
      this.client.forwardOut('127.0.0.1', socket.remotePort ?? 0, remoteHost, remotePort, (err, stream) => {
        if (err) return socket.destroy()
        socket.pipe(stream).pipe(socket)
        stream.on('error', () => socket.destroy())
        socket.on('error', () => stream.destroy())
      })
    })
    return new Promise((resolve, reject) => {
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        resolve({
          port: server.address().port,
          close: () => {
            for (const s of sockets) s.destroy()
            server.close()
          },
        })
      })
    })
  }

  end() {
    this.closed = true
    try {
      this.client?.end()
    } catch {}
    try {
      this.jump?.end()
    } catch {}
  }
}

/** Single-quote a string for POSIX sh. */
export function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}
