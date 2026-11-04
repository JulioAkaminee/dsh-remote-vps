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
import { editorUri, openUrl, pickEditor } from './editors.js'
import { PortForwards } from './ports.js'
import { ACCOUNT_GRANT_KEY, MODEL_KEY_REF, parsePairingInput, PROTOCOL_VERSION } from './protocol.js'
import { DeviceRegistry } from './registry.js'
import { listSavedMachines, resolveSshTarget, shq, SshConnection } from './ssh.js'
import { buildBundle, collectLocal, planSync } from './sync-plan.js'

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

/**
 * Oldest device host this desktop plugin works fully with. Desktop-only
 * releases keep it, so devices are not asked to update for nothing.
 * (0.1.4: model-key routes.)
 */
export const MIN_HOST_VERSION = '0.1.4'

/** Version of the dsh runtime this desktop runs; remote devices are aligned to it. */
export function localDshVersion() {
  const bin = process.argv[1]
  if (bin) {
    const v = readVersion(path.join(path.dirname(bin), '..', 'package.json'))
    if (v) return v
  }
  return process.env.DSH_DEVICES_DSH_VERSION || null
}

/** Compare dotted versions ("0.1.10" > "0.1.9"); prerelease tails are ignored. */
export function compareVersions(a, b) {
  const pa = String(a ?? '').split('-')[0].split('.').map((n) => Number(n) || 0)
  const pb = String(b ?? '').split('-')[0].split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
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
  constructor({ registry = new DeviceRegistry(), logger = console, pollMs = POLL_MS, credentials = () => undefined, local = {} } = {}) {
    this.registry = registry
    /** This desktop's credential service (to reuse its DeepSeek key on a device). */
    this.credentials = credentials
    /** This desktop's own composition, for "Sync with device": loader rows, profile dir, plugin manager. */
    this.local = { loaderEntries: () => [], profileDir: () => null, pluginManager: () => null, ...local }
    /** Device dev-server ports served on this computer's localhost. */
    this.ports = new PortForwards({ connect: (id, port) => this._portStream(id, port), onChange: () => this._changed(), logger })
    this.logger = logger
    this.pollMs = pollMs
    /** @type {Map<string, any>} device id -> runtime state */
    this.state = new Map()
    /** @type {Map<string, any>} */
    this.jobs = new Map()
    /** Bumped whenever anything a UI shows changes; long-polling browsers wait on it. */
    this.version = 1
    /** @type {Set<() => void>} */
    this.versionWaiters = new Set()
    /** Recent finished turns on devices, for desktop notifications. */
    this.notifications = []
    this._savedCache = null
    this.timer = null
    this.disposed = false
  }

  // ── change notification for long-polling UIs ─────────────────────────────

  _changed() {
    this.version += 1
    for (const wake of [...this.versionWaiters]) wake()
  }

  /** Resolve when `version` moves past `v` (or after `timeoutMs`). */
  waitForChange(v, timeoutMs = 25_000, signal) {
    if (Number(v) !== this.version || this.disposed) return Promise.resolve()
    return new Promise((resolve) => {
      let timer
      const done = () => {
        clearTimeout(timer)
        this.versionWaiters.delete(done)
        signal?.removeEventListener?.('abort', done)
        resolve()
      }
      this.versionWaiters.add(done)
      timer = setTimeout(done, timeoutMs)
      signal?.addEventListener?.('abort', done, { once: true })
    })
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
    for (const wake of [...this.versionWaiters]) wake()
    this.ports.dispose()
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
    s.watchToken = null
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
    // Devices without the live feed (older hosts) still refresh their sessions every few seconds.
    if (now - (this._lastSessionSweep ?? 0) > 8000) {
      this._lastSessionSweep = now
      this._refreshSessionsIfStale(8000)
    }
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
    const ssh = new SshConnection(resolved, { expectFingerprint: t.fingerprint, ...this._savedSecrets(t.savedMachineId) })
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
      const [sessions, workspaces] = await Promise.all([client.sessions().catch(() => null), client.workspaces().catch(() => null)])
      s.info = info
      if (sessions) {
        s.sessions = sessions.items ?? []
        s.archived = sessions.archived ?? []
        s.sessionsAt = Date.now()
      }
      if (workspaces) s.workspaces = workspaces.items ?? []
      const wasOnline = s.status === 'online'
      s.status = 'online'
      s.error = null
      s.failures = 0
      s.nextCheckAt = Date.now() + this.pollMs
      s.features = Array.isArray(info.features) ? info.features : []
      if (s.features.includes('watch') && !s.watchToken) this._startWatch(id, s)
      if (!wasOnline) this._changed()
      const patch = { lastSeenAt: new Date().toISOString(), versions: info.versions, platform: info.platform }
      if (info.name && info.name !== device.remoteName) patch.remoteName = info.name
      this.registry.update(id, patch)
    } catch (error) {
      s.failures += 1
      s.error = errorText(error)
      s.watchToken = null
      queueMicrotask(() => this._changed())
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

  // ── live session feed (device long-poll) ─────────────────────────────────

  _startWatch(id, s) {
    const token = {}
    s.watchToken = token
    s.w = { boot: undefined, rev: undefined, turns: undefined, att: undefined, failures: 0 }
    this._watchLoop(id, s, token).catch(() => {})
  }

  async _watchLoop(id, s, token) {
    while (!this.disposed && s.watchToken === token) {
      const device = this.registry.get(id)
      if (!device || s.status !== 'online' || !s.client) break
      try {
        const r = await s.client.watch({ boot: s.w.boot, rev: s.w.rev, turns: s.w.turns, att: s.w.att, timeout: 25_000 })
        if (s.watchToken !== token) break
        const firstOfBoot = s.w.boot !== r.boot
        s.w.boot = r.boot
        s.w.rev = r.rev
        s.w.turns = r.turnSeq
        if (r.attSeq !== undefined) s.w.att = r.attSeq
        s.w.failures = 0
        let changed = false
        if (Array.isArray(r.items)) {
          s.sessions = r.items
          s.sessionsAt = Date.now()
          changed = true
        }
        if (Array.isArray(r.archived)) s.archived = r.archived
        if (Array.isArray(r.workspaces)) s.workspaces = r.workspaces
        if (Array.isArray(r.ports)) {
          s.ports = r.ports
          await this.ports.reconcile(id, r.ports, { auto: device.autoForwardPorts !== false })
          changed = true
        }
        if (!firstOfBoot) for (const te of r.turnEnds ?? []) changed = this._recordTurnEnd(device, s, te) || changed
        if (!firstOfBoot) for (const a of r.attention ?? []) changed = this._recordAttention(device, s, a) || changed
        if (changed) this._changed()
      } catch (error) {
        if (s.watchToken !== token) break
        if (error instanceof DeviceHttpError && error.status === 404) {
          s.watchToken = null // older host without the feed: plain polling continues
          break
        }
        s.w.failures += 1
        await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** s.w.failures)))
        if (s.w.failures >= 2) this.refresh(id)
      }
    }
  }

  _recordTurnEnd(device, s, te) {
    if (!te?.sessionId) return false
    const session = (s.sessions ?? []).find((x) => x.sessionId === te.sessionId)
    this.notifications.push({
      id: `${device.id}:${s.w.boot}:${te.seq}`,
      kind: 'done',
      deviceId: device.id,
      deviceName: device.name || device.remoteName || device.id.slice(0, 8),
      sessionId: te.sessionId,
      title: session?.title ?? null,
      reason: te.reason || '',
      at: te.at ?? Date.now(),
    })
    if (this.notifications.length > 30) this.notifications.splice(0, this.notifications.length - 30)
    return true
  }

  /** A remote session started waiting for the user (approval or question). */
  _recordAttention(device, s, a) {
    if (!a?.sessionId) return false
    const session = (s.sessions ?? []).find((x) => x.sessionId === a.sessionId)
    this.notifications.push({
      id: `${device.id}:${s.w.boot}:a${a.seq}`,
      kind: 'attention',
      deviceId: device.id,
      deviceName: device.name || device.remoteName || device.id.slice(0, 8),
      sessionId: a.sessionId,
      title: session?.title ?? null,
      pendingKind: a.kind,
      toolName: a.toolName ?? null,
      at: a.at ?? Date.now(),
    })
    if (this.notifications.length > 30) this.notifications.splice(0, this.notifications.length - 30)
    return true
  }

  // ── views ────────────────────────────────────────────────────────────────

  view(device) {
    const s = this._ensureState(device.id)
    const localDsh = localDshVersion()
    const remoteDsh = device.versions?.dsh ?? null
    const remotePlugin = device.versions?.plugin ?? null
    const hostBehind = !!(remotePlugin && compareVersions(remotePlugin, MIN_HOST_VERSION) < 0)
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
      outdated: !!(localDsh && remoteDsh && localDsh !== remoteDsh) || hostBehind || !!(PLUGIN_VERSION && remotePlugin && compareVersions(remotePlugin, PLUGIN_VERSION) < 0),
      hostBehind,
      canUpdate: device.transport.kind === 'ssh',
      protocolMismatch: !!(device.versions?.protocol && device.versions.protocol !== PROTOCOL_VERSION),
      sessions: s.sessions,
      sessionsAt: s.sessionsAt,
      archived: s.archived ?? [],
      pendingCount: (s.sessions ?? []).filter((x) => x.pending).length,
      workspaces: (s.workspaces ?? []).map((w) => ({ id: w.id, title: w.title, path: w.path })),
      uptimeSec: s.info?.uptimeSec ?? null,
      model: s.info?.model ?? null,
      features: s.features ?? [],
      live: !!s.watchToken,
      editorHost: this.editorHost(device),
      loadavg: s.info?.loadavg ?? null,
      autoForwardPorts: device.autoForwardPorts !== false,
      portsKnown: Array.isArray(s.ports),
      ports: (s.ports ?? []).map((p) => ({ port: p.port, label: p.label ?? p.command ?? null, cwd: p.cwd ?? null, scope: p.scope ?? null, fromAgent: p.fromAgent !== false || !!p.inWorkspace, localPort: this.ports.get(device.id, p.port)?.localPort ?? null })),
      portMap: this.ports.map(device.id),
    }
  }

  _requireFeature(device, s, feature) {
    if (!(s.features ?? []).includes(feature)) {
      throw Object.assign(new Error(`${device.name || device.remoteName || 'this device'} runs an older device host; update it to use this`), { code: 'HOST_OUTDATED', status: 409 })
    }
  }

  async _ready(id) {
    const device = this.registry.get(id)
    if (!device) throw new Error('unknown device')
    const s = this._ensureState(id)
    s.baseUrl = await this._transport(device, s)
    return { device, s, client: this._client(device, s) }
  }

  // ── sessions: rename, pin, archive, search ───────────────────────────────

  async sessionAction(id, { sessionId, action, title, force } = {}) {
    const { device, s, client } = await this._ready(id)
    this._requireFeature(device, s, 'session-actions')
    const r = await client.sessionAction({ sessionId, action, title, force: force === true })
    const fresh = await client.sessions().catch(() => null)
    if (fresh) {
      s.sessions = fresh.items ?? []
      s.archived = fresh.archived ?? []
      s.sessionsAt = Date.now()
    }
    this._changed()
    return r
  }

  async search(id, q) {
    const { device, s, client } = await this._ready(id)
    if (!(s.features ?? []).includes('search')) return { items: [], unsupported: true }
    return client.search(String(q ?? '').slice(0, 200))
  }

  // ── DeepSeek account sign-in on a device ─────────────────────────────────

  async _localGrant() {
    const credentials = this.credentials()
    if (!credentials || typeof credentials.readRecord !== 'function') return null
    try {
      const record = await credentials.readRecord(ACCOUNT_GRANT_KEY)
      if (record?.kind === 'grant' && typeof record.payload?.token === 'string' && record.payload.token) return record.payload
    } catch {}
    return null
  }

  /** Whether this desktop is signed in to a DeepSeek account it could share. */
  async localAccount() {
    return { available: !!(await this._localGrant()) }
  }

  async shareAccount(id) {
    const { device, s, client } = await this._ready(id)
    this._requireFeature(device, s, 'account')
    const grant = await this._localGrant()
    if (!grant) throw new Error('this computer is not signed in to a DeepSeek account')
    const account = await client.setAccount(grant)
    if (s.info?.model) s.info = { ...s.info, model: { ...s.info.model, account, ready: true } }
    this._changed()
    this.refresh(id)
    return { account }
  }

  async clearAccount(id) {
    const { device, s, client } = await this._ready(id)
    this._requireFeature(device, s, 'account')
    const account = await client.clearAccount()
    if (s.info?.model) s.info = { ...s.info, model: { ...s.info.model, account, ready: !!s.info.model.configured } }
    this._changed()
    this.refresh(id)
    return { account }
  }

  // ── "Sync with device" ───────────────────────────────────────────────────

  async _collectLocal() {
    let entries = []
    try {
      entries = [...(this.local.loaderEntries() ?? [])]
    } catch {}
    return collectLocal({ loaderEntries: entries, profileDir: this.local.profileDir(), pluginManager: this.local.pluginManager() })
  }

  /** What would be copied, with a status per item (new / changed / same / unsupported). */
  async syncPlan(id) {
    const { device, s, client } = await this._ready(id)
    this._requireFeature(device, s, 'sync')
    const [local, remote] = await Promise.all([this._collectLocal(), client.syncState()])
    return { items: planSync(local, remote, { profileDir: this.local.profileDir() }), device: { pluginManager: remote.pluginManager !== false, profile: remote.profile !== false } }
  }

  sync(id, keys) {
    const device = this.registry.get(id)
    if (!device) throw new Error('unknown device')
    const picked = Array.isArray(keys) ? keys.map(String) : []
    if (picked.length === 0) throw new Error('nothing selected')
    return this._job('sync', async (log) => {
      const { s, client } = await this._ready(id)
      this._requireFeature(device, s, 'sync')
      const local = await this._collectLocal()
      const bundle = buildBundle(local, picked, { profileDir: this.local.profileDir() })
      const count = bundle.instructions.length + bundle.skills.length + bundle.rows.length + bundle.plugins.length
      log(`sending ${count} item(s) to ${device.name || device.remoteName}`)
      if (bundle.plugins.length) log('installing plugins on the device can take a few minutes')
      // Files and rows in one request; each plugin (a tarball can be tens of MB) in its own,
      // so one large or failing package never blocks the rest.
      const report = []
      const send = async (part, label) => {
        try {
          const r = await client.syncApply({ ...part, from: this._label() })
          for (const line of r.log ?? []) log(line)
          report.push(...(r.report ?? []))
        } catch (error) {
          log(`failed ${label}: ${errorText(error)}`)
          for (const item of part.instructions ?? []) report.push({ kind: 'instructions', name: item.target, ok: false, detail: errorText(error) })
          for (const item of part.skills ?? []) report.push({ kind: 'skill', name: item.name, root: item.root, ok: false, detail: errorText(error) })
          for (const item of part.rows ?? []) report.push({ kind: 'row', name: item.id, ok: false, detail: errorText(error) })
          for (const item of part.plugins ?? []) report.push({ kind: 'plugin', name: item.name, ok: false, detail: errorText(error) })
        }
      }
      const { plugins, ...rest } = bundle
      if (rest.instructions.length || rest.skills.length || rest.rows.length) await send(rest, 'files')
      for (const plugin of plugins) await send({ plugins: [plugin] }, plugin.name)
      const failed = report.filter((x) => !x.ok)
      log(failed.length ? `${failed.length} item(s) failed` : 'done')
      this.refresh(id)
      return { report }
    })
  }

  // ── port previews ────────────────────────────────────────────────────────

  async _portStream(id, remotePort) {
    const { device, s, client } = await this._ready(id)
    if (device.transport.kind === 'ssh' && s.ssh && !s.ssh.closed) {
      try {
        return await s.ssh.openStream('127.0.0.1', remotePort)
      } catch (error) {
        // Dev servers bound to "localhost" may listen on ::1 only.
        try {
          return await s.ssh.openStream('::1', remotePort)
        } catch {}
        throw error
      }
    }
    return client.portTunnel(remotePort)
  }

  async listPorts(id) {
    const { device, s, client } = await this._ready(id)
    this._requireFeature(device, s, 'ports')
    const r = await client.ports()
    s.ports = r.items ?? []
    await this.ports.reconcile(id, s.ports, { auto: device.autoForwardPorts !== false })
    this._changed()
    return this.view(this.registry.get(id)).ports
  }

  async forwardPort(id, port) {
    const device = this.registry.get(id)
    if (!device) throw new Error('unknown device')
    const localPort = await this.ports.forward(id, Number(port))
    return { localPort, url: `http://localhost:${localPort}/` }
  }

  closePort(id, port) {
    return { closed: this.ports.close(id, Number(port)) }
  }

  setAutoForward(id, on) {
    const d = this.registry.update(id, { autoForwardPorts: !!on })
    if (!d) throw new Error('unknown device')
    if (on && this.state.get(id)?.ports) this.ports.reconcile(id, this.state.get(id).ports, { auto: true }).catch(() => {})
    this._changed()
    return this.view(d)
  }

  /** Open a forwarded dev server in this computer's browser. Only our own forwards. */
  async openForwarded(url) {
    let u
    try {
      u = new URL(String(url))
    } catch {
      throw new Error('invalid url')
    }
    const local = Number(u.port)
    const ours = [...this.ports.forwards.values()].some((e) => e.localPort === local)
    if (!/^https?:$/.test(u.protocol) || !['localhost', '127.0.0.1'].includes(u.hostname) || !ours) throw new Error('not a forwarded port')
    await openUrl(u.toString())
    return { opened: true }
  }

  /** Keep session lists near-live while a UI is polling (health checks stay at pollMs). */
  _refreshSessionsIfStale(maxAgeMs = 4000) {
    for (const d of this.registry.list()) {
      const s = this.state.get(d.id)
      if (!s || s.status !== 'online' || s.sessionsLoading || !s.client || s.watchToken) continue
      if (Date.now() - (s.sessionsAt ?? 0) < maxAgeMs) continue
      s.sessionsLoading = true
      Promise.all([s.client.sessions(), s.client.workspaces().catch(() => null)])
        .then(([r, w]) => {
          s.sessions = r.items ?? []
          s.sessionsAt = Date.now()
          if (w) s.workspaces = w.items ?? []
          this._changed()
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
      saved: this.savedMachines(),
      notifications: this.notifications,
      version: this.version,
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
          this._changed()
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
    this._savedCache = null
    this._changed()
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

  /** Secrets of a machine saved by dsh-tauri-remote, read at connect time (never stored here). */
  _savedSecrets(savedMachineId) {
    if (!savedMachineId) return {}
    const m = listSavedMachines({ withSecrets: true }).find((x) => x.id === savedMachineId)
    return m ? { password: m.password, passphrase: m.passphrase } : {}
  }

  /** Machines saved on this computer (dsh-tauri-remote), marked when already paired. */
  savedMachines() {
    const devices = this.registry.list()
    if (!this._savedCache || Date.now() - this._savedCache.at > 10_000) this._savedCache = { at: Date.now(), items: listSavedMachines() }
    return this._savedCache.items.map((m) => {
      const paired = devices.find(
        (d) => d.transport.kind === 'ssh' && (d.transport.savedMachineId === m.id || d.transport.target === m.target || d.transport.target === m.host),
      )
      return { ...m, pairedDeviceId: paired?.id ?? null }
    })
  }

  async _connectSsh({ target, port, username, identityFile, fingerprint, password, passphrase }, log) {
    const resolved = resolveSshTarget(target, { port, username, identityFile })
    log(`connecting to ${resolved.username}@${resolved.host}:${resolved.port}${resolved.proxyJump ? ` via ${resolved.proxyJump}` : ''}`)
    const secrets = { password, passphrase }
    if (fingerprint) return { ssh: await new SshConnection(resolved, { expectFingerprint: fingerprint, ...secrets }).connect(), resolved, fingerprint }
    try {
      await new SshConnection(resolved, secrets).connect()
      throw new Error('unexpected: unpinned connection succeeded')
    } catch (error) {
      if (error.code !== 'HOSTKEY_UNCONFIRMED') throw error
      if (!error.presented.known) throw error // the UI asks the user to confirm this fingerprint
      log(`host key ${error.presented.fingerprint} matches ~/.ssh/known_hosts`)
      const fp = error.presented.fingerprint
      return { ssh: await new SshConnection(resolved, { expectFingerprint: fp, ...secrets }).connect(), resolved, fingerprint: fp }
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

  async _sshPair({ target, port, username, identityFile, fingerprint, name, install = true, hostPort, savedMachineId }, log, job) {
    if (savedMachineId) {
      // A server already saved on this computer: reuse its address, credentials
      // and the host key the user accepted there.
      const m = listSavedMachines().find((x) => x.id === savedMachineId)
      if (!m) throw new Error('that saved server is no longer on this computer')
      target = m.target
      name = name || m.name
      if (!fingerprint && m.fingerprint) {
        fingerprint = m.fingerprint
        log(`using the host key you already accepted for ${m.name} (${m.fingerprint})`)
      }
    }
    const { ssh, fingerprint: fp } = await this._connectSsh({ target, port, username, identityFile, fingerprint, ...this._savedSecrets(savedMachineId) }, log)
    let keep = false
    try {
      let status = await this._remoteStatus(ssh)
      const localDsh = localDshVersion()
      const needsInstall = !status
      const needsUpdate =
        status &&
        ((localDsh && status.versions?.dsh && status.versions.dsh !== localDsh) ||
          !status.versions?.plugin ||
          compareVersions(status.versions.plugin, MIN_HOST_VERSION) < 0)
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
          transport: {
            kind: 'ssh',
            target,
            port: port || undefined,
            username: username || undefined,
            identityFile: identityFile || undefined,
            fingerprint: fp,
            remotePort,
            savedMachineId: savedMachineId || undefined,
          },
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
      const { ssh } = await this._connectSsh(
        { target: t.target, port: t.port, username: t.username, identityFile: t.identityFile, fingerprint: t.fingerprint, ...this._savedSecrets(t.savedMachineId) },
        log,
      )
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

  // ── model credential on the device ───────────────────────────────────────

  /** Whether this desktop has a DeepSeek API key it could hand to a device. */
  async localModelKey() {
    const credentials = this.credentials()
    try {
      if (credentials) {
        const r = await credentials.resolve(MODEL_KEY_REF)
        if (r?.value) return r.value
      }
    } catch {}
    return process.env[MODEL_KEY_REF] || null
  }

  /**
   * Store the DeepSeek API key on a device: typed by the user, or this
   * desktop's own key (resolved here, never sent to the browser).
   */
  async setModelKey(id, { apiKey, fromDesktop } = {}) {
    const device = this.registry.get(id)
    if (!device) throw new Error('unknown device')
    const s = this._ensureState(id)
    const key = fromDesktop ? await this.localModelKey() : String(apiKey ?? '').trim()
    if (!key) throw new Error(fromDesktop ? 'this desktop has no DeepSeek API key to share' : 'enter the API key')
    s.baseUrl = await this._transport(device, s)
    const model = await this._client(device, s).setModelKey(key)
    if (s.info) s.info = { ...s.info, model }
    this._changed()
    this.refresh(id)
    return { model }
  }

  async clearModelKey(id) {
    const device = this.registry.get(id)
    if (!device) throw new Error('unknown device')
    const s = this._ensureState(id)
    s.baseUrl = await this._transport(device, s)
    const model = await this._client(device, s).clearModelKey()
    if (s.info) s.info = { ...s.info, model }
    this._changed()
    this.refresh(id)
    return { model }
  }

  // ── open device files in an editor on this computer ──────────────────────

  /** SSH destination editors use for this device: explicit override, else the SSH pairing target. */
  editorHost(device) {
    if (device.editorHost) return device.editorHost
    return device.transport.kind === 'ssh' ? device.transport.target : null
  }

  setEditorHost(id, host) {
    const value = String(host ?? '').trim()
    if (value && /[\s/]/.test(value)) throw new Error('use an SSH alias or user@host')
    const d = this.registry.update(id, { editorHost: value || null })
    if (!d) throw new Error('unknown device')
    this._changed()
    return this.view(d)
  }

  /**
   * Open a folder or file of a device in a desktop editor (Remote-SSH).
   * `path` is an absolute device path; `sessionId` opens that session's folder.
   */
  async openInEditor(id, { path: devicePath, sessionId, editor } = {}) {
    const device = this.registry.get(id)
    if (!device) throw new Error('unknown device')
    const s = this._ensureState(id)
    let target = devicePath
    if (!target && sessionId) target = (s.sessions ?? []).find((x) => x.sessionId === sessionId)?.cwd
    if (!target) throw new Error('nothing to open: no folder for this session yet')
    const host = this.editorHost(device)
    if (!host) throw Object.assign(new Error('set this device’s SSH host for editors first'), { code: 'NO_EDITOR_HOST' })
    const chosen = pickEditor(editor)
    const url = editorUri(chosen, host, target)
    await openUrl(url)
    return { url, editor: chosen.id }
  }

  // ── other operations ─────────────────────────────────────────────────────

  rename(id, name) {
    const d = this.registry.update(id, { name: String(name ?? '').trim().slice(0, 80) || null })
    if (!d) throw new Error('unknown device')
    this._changed()
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
    this.ports.closeDevice(id)
    this.state.delete(id)
    this.registry.remove(id)
    this._savedCache = null
    this._changed()
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
      let secret = device.gatewaySecret
      if (!secret) {
        secret = crypto.randomBytes(24).toString('base64url')
        this.registry.update(id, { gatewaySecret: secret })
      }
      s.gateway = new DeviceGateway({
        secret,
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
