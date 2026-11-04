// DeviceManager: every paired device, its live transport, health and
// session list, plus the long-running pairing / install jobs.
//
// One connection per device. A device that fails a health check is retried
// with jittered exponential backoff; other devices are unaffected.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeviceClient, DeviceHttpError, generateClientKey, hello, pair } from './device-client.js'
import { DeviceGateway } from './gateway.js'
import { parsePairingInput, PROTOCOL_VERSION } from './protocol.js'
import { DeviceRegistry } from './registry.js'
import { resolveSshTarget, shq, SshConnection } from './ssh.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ASSETS = path.join(here, '..', 'assets')
const REMOTE_ROOT = '$HOME/.dsh-device'
const REMOTE_CLI = `${REMOTE_ROOT}/bin/dsh-device`
const POLL_MS = 15_000
const OFFLINE_AFTER_FAILURES = 2

function readVersion(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).version ?? null
  } catch {
    return null
  }
}

export const PLUGIN_VERSION = readVersion(path.join(here, '..', 'package.json'))

/** Version of the dsh runtime this desktop runs; remote devices are aligned to it. */
export function localDshVersion() {
  const bin = process.argv[1]
  if (bin) {
    const v = readVersion(path.join(path.dirname(bin), '..', 'package.json'))
    if (v) return v
  }
  return process.env.DSH_DEVICES_DSH_VERSION || null
}

function backoffMs(failures) {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1))
  return base / 2 + Math.random() * (base / 2)
}

function errorText(error) {
  if (!error) return null
  if (error instanceof DeviceHttpError) return error.message
  return error.code && !String(error.message).includes(error.code) ? `${error.message} (${error.code})` : String(error.message ?? error)
}

export class DeviceManager {
  constructor({ registry = new DeviceRegistry(), logger = console, pollMs = POLL_MS } = {}) {
    this.registry = registry
    this.logger = logger
    this.pollMs = pollMs
    /** @type {Map<string, any>} device id -> runtime state */
    this.state = new Map()
    /** @type {Map<string, any>} */
    this.jobs = new Map()
    this.timer = null
    this.disposed = false
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  start() {
    for (const d of this.registry.list()) this._ensureState(d.id)
    this.timer = setInterval(() => this._tick(), 1000)
    this._tick()
  }

  async dispose() {
    this.disposed = true
    clearInterval(this.timer)
    await Promise.all([...this.state.keys()].map((id) => this._teardown(id)))
  }

  _ensureState(id) {
    if (!this.state.has(id)) {
      this.state.set(id, {
        status: 'connecting',
        error: null,
        failures: 0,
        nextCheckAt: 0,
        checking: false,
        info: null,
        sessions: null,
        sessionsAt: null,
        ssh: null,
        forward: null,
        client: null,
        gateway: null,
      })
    }
    return this.state.get(id)
  }

  async _teardown(id) {
    const s = this.state.get(id)
    if (!s) return
    try {
      await s.gateway?.stop()
    } catch {}
    s.gateway = null
    this._closeTransport(s)
  }

  _closeTransport(s) {
    try {
      s.forward?.close()
    } catch {}
    try {
      s.ssh?.end()
    } catch {}
    s.forward = null
    s.ssh = null
  }

  _tick() {
    if (this.disposed) return
    const now = Date.now()
    for (const d of this.registry.list()) {
      const s = this._ensureState(d.id)
      if (s.checking || s.status === 'revoked' || now < s.nextCheckAt) continue
      s.checking = true
      this._check(d.id).finally(() => {
        s.checking = false
      })
    }
    for (const [id, job] of this.jobs) if (now - job.createdAt > 3600_000) this.jobs.delete(id)
  }

  /** Force an immediate health check (UI refresh button, wake from sleep). */
  refresh(id) {
    for (const d of this.registry.list()) {
      if (id && d.id !== id) continue
      const s = this._ensureState(d.id)
      if (s.status === 'revoked') continue
      s.nextCheckAt = 0
    }
    this._tick()
  }

  // ── transport ────────────────────────────────────────────────────────────

  /** Make sure the device is reachable; returns its base URL. */
  async _transport(device, s) {
    if (device.transport.kind === 'url') return device.transport.url.replace(/\/+$/, '')
    if (s.ssh && !s.ssh.closed && s.forward) return `http://127.0.0.1:${s.forward.port}`
    // Health checks, "open" and "remove" may race here; share one connect.
    if (!s.connecting) {
      s.connecting = this._openSshTransport(device, s).finally(() => {
        s.connecting = null
      })
    }
    return s.connecting
  }

  async _openSshTransport(device, s) {
    this._closeTransport(s)
    const t = device.transport
    const resolved = resolveSshTarget(t.target, { port: t.port, username: t.username, identityFile: t.identityFile, proxyJump: t.proxyJump })
    const ssh = new SshConnection(resolved, { expectFingerprint: t.fingerprint })
    await ssh.connect()
    let remotePort = t.remotePort
    try {
      s.forward = await ssh.forwardLocal(remotePort)
    } catch (error) {
      ssh.end()
      throw error
    }
    s.ssh = ssh
    ssh.onClose = () => {
      if (s.ssh === ssh) {
        this._closeTransport(s)
        if (s.status === 'online') {
          s.status = 'connecting'
          s.nextCheckAt = 0
        }
      }
    }
    return `http://127.0.0.1:${s.forward.port}`
  }

  /** Ask the device over SSH where its host listens (after a restart on another port). */
  async _rediscoverPort(device, s) {
    if (device.transport.kind !== 'ssh' || !s.ssh) return false
    const r = await s.ssh.exec(`${REMOTE_CLI} status --json`, { timeoutMs: 20_000 })
    const status = JSON.parse(r.stdout.trim().split('\n').pop() || '{}')
    const port = status.origin ? Number(new URL(status.origin).port) : null
    if (!status.running) {
      await s.ssh.exec(`${REMOTE_CLI} service start`, { timeoutMs: 30_000 }).catch(() => {})
    }
    if (port && port !== device.transport.remotePort) {
      this.registry.update(device.id, { transport: { ...device.transport, remotePort: port } })
      this._closeTransport(s)
      return true
    }
    return !status.running
  }

  _client(device, s) {
    if (!s.client) {
      s.client = new DeviceClient({
        baseUrl: () => s.baseUrl,
        deviceId: device.id,
        clientId: device.clientId,
        privateKeyPem: this.registry.readKey(device.id),
      })
    }
    return s.client
  }

  async _check(id) {
    const device = this.registry.get(id)
    const s = this.state.get(id)
    if (!device || !s) return
    try {
      s.baseUrl = await this._transport(device, s)
      const client = this._client(device, s)
      let info
      try {
        info = await client.info()
      } catch (error) {
        if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET' || error.status === 502) {
          if (await this._rediscoverPort(device, s).catch(() => false)) {
            s.baseUrl = await this._transport(this.registry.get(id), s)
            info = await client.info()
          } else throw error
        } else throw error
      }
      const sessions = await client.sessions().catch(() => null)
      s.info = info
      if (sessions) {
        s.sessions = sessions.items ?? []
        s.sessionsAt = Date.now()
      }
      s.status = 'online'
      s.error = null
      s.failures = 0
      s.nextCheckAt = Date.now() + this.pollMs
      const patch = { lastSeenAt: new Date().toISOString(), versions: info.versions, platform: info.platform }
      if (info.name && info.name !== device.remoteName) patch.remoteName = info.name
      this.registry.update(id, patch)
    } catch (error) {
      s.failures += 1
      s.error = errorText(error)
      if (error instanceof DeviceHttpError && error.status === 401 && /unknown-or-revoked-client/.test(error.code ?? '')) {
        s.status = 'revoked'
        this._closeTransport(s)
        return
      }
      if (error.code === 'HOSTKEY_MISMATCH') {
        s.status = 'error'
        s.nextCheckAt = Date.now() + 5 * 60_000
        this._closeTransport(s)
        return
      }
      s.status = s.failures >= OFFLINE_AFTER_FAILURES ? 'offline' : 'connecting'
      s.nextCheckAt = Date.now() + backoffMs(s.failures)
      this._closeTransport(s)
    }
  }

  // ── views ────────────────────────────────────────────────────────────────

  view(device) {
    const s = this._ensureState(device.id)
    const localDsh = localDshVersion()
    const remoteDsh = device.versions?.dsh ?? null
    return {
      id: device.id,
      name: device.name || device.remoteName || device.id.slice(0, 8),
      remoteName: device.remoteName ?? null,
      platform: device.platform ?? null,
      transport:
        device.transport.kind === 'ssh'
          ? { kind: 'ssh', target: device.transport.target, fingerprint: device.transport.fingerprint }
          : { kind: 'url', url: device.transport.url },
      status: s.status,
      error: s.error,
      addedAt: device.addedAt,
      lastSeenAt: device.lastSeenAt ?? null,
      versions: device.versions ?? null,
      outdated: !!(localDsh && remoteDsh && localDsh !== remoteDsh),
      protocolMismatch: !!(device.versions?.protocol && device.versions.protocol !== PROTOCOL_VERSION),
      sessions: s.sessions,
      sessionsAt: s.sessionsAt,
      uptimeSec: s.info?.uptimeSec ?? null,
      loadavg: s.info?.loadavg ?? null,
    }
  }

  /** Keep session lists near-live while a UI is polling (health checks stay at pollMs). */
  _refreshSessionsIfStale(maxAgeMs = 4000) {
    for (const d of this.registry.list()) {
      const s = this.state.get(d.id)
      if (!s || s.status !== 'online' || s.sessionsLoading || !s.client) continue
      if (Date.now() - (s.sessionsAt ?? 0) < maxAgeMs) continue
      s.sessionsLoading = true
      s.client
        .sessions()
        .then((r) => {
          s.sessions = r.items ?? []
          s.sessionsAt = Date.now()
        })
        .catch(() => {
          s.nextCheckAt = 0
        })
        .finally(() => {
          s.sessionsLoading = false
        })
    }
  }

  list() {
    this._refreshSessionsIfStale()
    return {
      devices: this.registry.list().map((d) => this.view(d)),
      self: { hostname: os.hostname(), platform: process.platform, dsh: localDshVersion(), plugin: PLUGIN_VERSION },
    }
  }

  // ── jobs ─────────────────────────────────────────────────────────────────

  _job(kind, run) {
    const job = { id: crypto.randomUUID(), kind, state: 'running', log: [], result: null, error: null, prompt: null, createdAt: Date.now() }
    const log = (line) => {
      const text = String(line).replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
      if (!text) return
      job.log.push(text)
      if (job.log.length > 400) job.log.splice(0, job.log.length - 400)
    }
    this.jobs.set(job.id, job)
    Promise.resolve()
      .then(() => run(log, job))
      .then(
        (result) => {
          if (job.state === 'running') {
            job.state = 'done'
            job.result = result ?? null
          }
        },
        (error) => {
          job.state = 'error'
          job.error = errorText(error)
          if (error.presented) job.prompt = { kind: 'hostkey', ...error.presented }
          log(`error: ${job.error}`)
        },
      )
    return this.jobView(job.id)
  }

  jobView(id) {
    const job = this.jobs.get(id)
    if (!job) return null
    return { id: job.id, kind: job.kind, state: job.state, log: job.log, result: job.result, error: job.error, prompt: job.prompt }
  }

  // ── pairing by code ──────────────────────────────────────────────────────

  async addByCode({ input, url, name }) {
    const parsed = parsePairingInput(input)
    const baseUrl = String(url || parsed.url || '').trim().replace(/\/+$/, '')
    if (!parsed.code) throw new Error('enter the pairing code shown by `dsh-device pair`')
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('the device URL is required (https://…)')
    if (/^http:\/\//i.test(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(baseUrl)) {
      throw new Error('use https:// for devices reached over a network (plain http is only allowed for loopback)')
    }
    const probe = await hello(baseUrl)
    if (probe.protocol !== PROTOCOL_VERSION) throw new Error(`device speaks protocol ${probe.protocol}, this desktop speaks ${PROTOCOL_VERSION}`)
    if (parsed.deviceId && parsed.deviceId !== probe.deviceId) throw new Error('this link was made for a different device')
    const key = generateClientKey()
    const paired = await pair(baseUrl, { code: parsed.code, label: this._label(), platform: process.platform, publicKey: key.publicKey })
    const view = this._save({ deviceId: probe.deviceId, name: name || probe.name, remoteName: probe.name, clientId: paired.clientId, key, transport: { kind: 'url', url: baseUrl } })
    this.refresh(probe.deviceId)
    return view
  }

  _label() {
    const host = os.hostname().replace(/\.local$/, '')
    return `${os.userInfo().username}@${host} (dsh desktop)`
  }

  _save({ deviceId, name, clientId, key, transport, remoteName }) {
    const existing = this.registry.get(deviceId)
    if (existing) this._teardown(deviceId)
    this.state.delete(deviceId)
    this.registry.writeKey(deviceId, key.privateKeyPem)
    const record = this.registry.upsert({
      id: deviceId,
      name: existing?.name || name || null,
      remoteName: remoteName ?? name ?? null,
      clientId,
      transport,
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      gatewayPort: existing?.gatewayPort ?? null,
    })
    this._ensureState(deviceId)
    // Callers hand over any live transport first, then call refresh().
    return this.view(record)
  }

  // ── pairing over SSH (with install) ──────────────────────────────────────

  /**
   * Start an SSH pairing job. Flow: connect (host key must be confirmed or
   * already in known_hosts) → install/update the device host if needed →
   * mint a code on the device → pair through the forwarded port.
   */
  addBySsh(params) {
    return this._job('ssh-pair', (log, job) => this._sshPair(params, log, job))
  }

  async _connectSsh({ target, port, username, identityFile, fingerprint }, log) {
    const resolved = resolveSshTarget(target, { port, username, identityFile })
    log(`connecting to ${resolved.username}@${resolved.host}:${resolved.port}${resolved.proxyJump ? ` via ${resolved.proxyJump}` : ''}`)
    if (fingerprint) return { ssh: await new SshConnection(resolved, { expectFingerprint: fingerprint }).connect(), resolved, fingerprint }
    try {
      await new SshConnection(resolved).connect()
      throw new Error('unexpected: unpinned connection succeeded')
    } catch (error) {
      if (error.code !== 'HOSTKEY_UNCONFIRMED') throw error
      if (!error.presented.known) throw error // the UI asks the user to confirm this fingerprint
      log(`host key ${error.presented.fingerprint} matches ~/.ssh/known_hosts`)
      const fp = error.presented.fingerprint
      return { ssh: await new SshConnection(resolved, { expectFingerprint: fp }).connect(), resolved, fingerprint: fp }
    }
  }

  async _remoteStatus(ssh) {
    const r = await ssh.exec(`[ -x ${REMOTE_CLI} ] && ${REMOTE_CLI} status --json`, { timeoutMs: 30_000 })
    if (r.code !== 0) return null
    try {
      return JSON.parse(r.stdout.trim().split('\n').pop())
    } catch {
      return null
    }
  }

  async _install(ssh, log, { port } = {}) {
    const tarball = fs.readdirSync(ASSETS).find((f) => /^dsh-device-host-.*\.tgz$/.test(f))
    if (!tarball) throw new Error('dsh-devices assets are missing the dsh-device-host tarball (run `npm run build`)')
    const dshVersion = localDshVersion()
    log(`installing the device host (dsh ${dshVersion ?? 'latest'}) — this can take a few minutes`)
    const home = (await ssh.exec('printf %s "$HOME"')).stdout.trim()
    const incoming = `${home}/.dsh-device/incoming`
    await ssh.exec(`mkdir -p ${shq(incoming)}`)
    await ssh.upload([
      [path.join(ASSETS, 'install-host.sh'), `${incoming}/install-host.sh`],
      [path.join(ASSETS, tarball), `${incoming}/${tarball}`],
    ])
    const args = [`--plugin ${shq(`${incoming}/${tarball}`)}`]
    if (dshVersion) args.push(`--dsh-version ${shq(dshVersion)}`)
    if (port) args.push(`--port ${Number(port)}`)
    let result = null
    const r = await ssh.exec(`sh ${shq(`${incoming}/install-host.sh`)} ${args.join(' ')} 2>&1`, {
      timeoutMs: 20 * 60_000,
      onLine: (line) => {
        if (line.startsWith('DSH_DEVICE_INSTALL_RESULT ')) {
          try {
            result = JSON.parse(line.slice('DSH_DEVICE_INSTALL_RESULT '.length))
          } catch {}
        } else log(line)
      },
    })
    if (r.code !== 0 || !result?.ok) throw new Error(result?.error || `installer exited with code ${r.code}`)
    return result
  }

  async _sshPair({ target, port, username, identityFile, fingerprint, name, install = true, hostPort }, log, job) {
    const { ssh, fingerprint: fp } = await this._connectSsh({ target, port, username, identityFile, fingerprint }, log)
    let keep = false
    try {
      let status = await this._remoteStatus(ssh)
      const localDsh = localDshVersion()
      const needsInstall = !status
      const needsUpdate = status && ((localDsh && status.versions?.dsh && status.versions.dsh !== localDsh) || (PLUGIN_VERSION && status.versions?.plugin && status.versions.plugin !== PLUGIN_VERSION))
      if (needsInstall || needsUpdate) {
        if (!install) {
          job.prompt = { kind: 'install', installed: !!status, versions: status?.versions ?? null }
          throw new Error(needsInstall ? 'the device host is not installed on this machine' : 'the device host needs an update')
        }
        if (needsUpdate) log(`updating device host (${status.versions?.dsh} → ${localDsh})`)
        await this._install(ssh, log, { port: hostPort })
        status = await this._remoteStatus(ssh)
      } else log(`device host ${status.versions?.plugin ?? '?'} already installed (dsh ${status.versions?.dsh ?? '?'})`)
      if (!status?.running) {
        log('starting the device host service')
        await ssh.exec(`${REMOTE_CLI} service start`, { timeoutMs: 60_000 })
        for (let i = 0; i < 60 && !status?.running; i++) {
          await new Promise((r) => setTimeout(r, 1000))
          status = await this._remoteStatus(ssh)
        }
        if (!status?.running) throw new Error('the device host did not start; check `dsh-device service logs` on the device')
      }
      const remotePort = Number(new URL(status.origin).port)
      log(`minting a one-time pairing code on the device`)
      const minted = await ssh.exec(`${REMOTE_CLI} pair --json --via ssh --ttl 120s --label ${shq(this._label())}`, { timeoutMs: 30_000 })
      if (minted.code !== 0) throw new Error(minted.stderr.trim() || 'could not mint a pairing code')
      const code = JSON.parse(minted.stdout.trim().split('\n').pop())
      const forward = await ssh.forwardLocal(remotePort)
      try {
        const baseUrl = `http://127.0.0.1:${forward.port}`
        const probe = await hello(baseUrl)
        if (probe.deviceId !== code.deviceId) throw new Error('device identity changed during pairing')
        const key = generateClientKey()
        const paired = await pair(baseUrl, { code: code.code, label: this._label(), platform: process.platform, publicKey: key.publicKey })
        log(`paired as ${paired.clientId}`)
        const view = this._save({
          deviceId: probe.deviceId,
          name: name || probe.name,
          remoteName: probe.name,
          clientId: paired.clientId,
          key,
          transport: { kind: 'ssh', target, port: port || undefined, username: username || undefined, identityFile: identityFile || undefined, fingerprint: fp, remotePort },
        })
        // Hand the live connection to the device's runtime state.
        const s = this._ensureState(probe.deviceId)
        s.ssh = ssh
        s.forward = forward
        keep = true
        ssh.onClose = () => {
          if (s.ssh === ssh) this._closeTransport(s)
        }
        this.refresh(probe.deviceId)
        return { device: view }
      } catch (error) {
        forward.close()
        throw error
      }
    } finally {
      if (!keep) ssh.end()
    }
  }

  /** Re-run the installer on an SSH device (version alignment). */
  update(id) {
    const device = this.registry.get(id)
    if (!device) throw new Error('unknown device')
    if (device.transport.kind !== 'ssh') throw new Error('only SSH devices can be updated from here; run the installer on the device')
    return this._job('update', async (log) => {
      const s = this._ensureState(id)
      const t = device.transport
      const { ssh } = await this._connectSsh({ target: t.target, port: t.port, username: t.username, identityFile: t.identityFile, fingerprint: t.fingerprint }, log)
      try {
        await this._install(ssh, log, { port: t.remotePort })
        log('restarting the device host')
        await ssh.exec(`${REMOTE_CLI} service restart`, { timeoutMs: 60_000 })
      } finally {
        ssh.end()
      }
      this._closeTransport(s)
      s.client = null
      this.refresh(id)
      return { ok: true }
    })
  }

  // ── other operations ─────────────────────────────────────────────────────

  rename(id, name) {
    const d = this.registry.update(id, { name: String(name ?? '').trim().slice(0, 80) || null })
    if (!d) throw new Error('unknown device')
    return this.view(d)
  }

  async remove(id, { revoke = true } = {}) {
    const device = this.registry.get(id)
    if (!device) throw new Error('unknown device')
    const s = this._ensureState(id)
    let revoked = false
    if (revoke && s.status !== 'revoked') {
      try {
        s.baseUrl = await Promise.race([this._transport(device, s), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))])
        await this._client(device, s).unpair()
        revoked = true
      } catch (error) {
        this.logger.warn?.(`[dsh-devices] could not revoke on ${id}: ${errorText(error)}`)
      }
    }
    await this._teardown(id)
    this.state.delete(id)
    this.registry.remove(id)
    return { removed: true, revoked }
  }

  /** Start (or reuse) the device's local gateway and return an entry URL. */
  async open(id, { next } = {}) {
    const device = this.registry.get(id)
    if (!device) throw new Error('unknown device')
    const s = this._ensureState(id)
    if (s.status === 'revoked') throw new Error('this desktop was unpaired on the device; pair it again')
    s.baseUrl = await this._transport(device, s)
    const client = this._client(device, s)
    await client.token()
    if (!s.gateway) {
      s.gateway = new DeviceGateway({
        deviceId: id,
        baseUrl: () => s.baseUrl,
        token: async (opts) => {
          s.baseUrl = await this._transport(this.registry.get(id), s)
          return client.token(opts)
        },
        preferredPort: device.gatewayPort ?? undefined,
      })
      await s.gateway.start()
      if (device.gatewayPort !== s.gateway.port) this.registry.update(id, { gatewayPort: s.gateway.port })
    }
    return { url: s.gateway.entryUrl(next), origin: s.gateway.origin }
  }
}
