// dsh-device-host — makes this DSH instance a remote device that a desktop
// DSH can pair with and control. The agent, its tools, terminals and session
// storage all run here; the desktop only renders and sends commands.
//
// Routes (all under /device/v1 on this instance's web listener):
//   GET    /hello            public identity probe
//   POST   /pair             one-time code -> client record (rate limited)
//   POST   /token            signed proof of the client key -> access token
//   GET    /info             device facts and versions            (token)
//   GET    /sessions         session rows for the device sidebar  (token)
//   GET    /workspaces       workspace rows                       (token)
//   GET    /watch            long-poll change feed                (token)
//   GET|PUT|DELETE /model-key DeepSeek API key on this device      (token)
//   GET|PUT|DELETE /account   DeepSeek account sign-in here        (token)
//   POST   /session-action   rename / pin / archive a session     (token)
//   GET    /search           message-content search               (token)
//   GET|POST /sync           customisations copied from a desktop (token)
//   GET    /ports            listening dev servers                (token)
//   UPGRADE /port-tunnel     raw TCP to one of them               (token)
//   GET|POST /self-update    install a new device host, roll back (token)
//   DELETE /clients/self     unpair the calling client            (token)
//   *      /t/...            tunnel to this instance's DSH web UI (token)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostAuth, parsePublicKey } from './auth.js'
import { HealthSampler } from './health.js'
import { readJsonBody, remoteAddress, sendError, sendJson } from './http-util.js'
import { PendingTracker } from './pending.js'
import { handlePortTunnel, PortWatcher } from './ports.js'
import {
  ACCOUNT_GRANT_KEY,
  DEVICE_BASE,
  HOST_FEATURES,
  MODEL_KEY_REF,
  PROTOCOL_VERSION,
  ROUTES,
  SELF_UPDATE_FEATURE,
  TOKEN_HEADER,
  TUNNEL_UPGRADE_PATHS,
  WATCH_MAX_MS,
} from './protocol.js'
import { RevisionFeed } from './revision.js'
import { HostStore } from './store.js'
import { DeviceSync } from './sync.js'
import { LocalTunnel } from './tunnel.js'
import { runtimeRoot, Updater } from './updater.js'

export const name = 'dsh-device-host'
export const inject = ['webServer', 'connection']

const here = path.dirname(fileURLToPath(import.meta.url))

function readVersion(pkgFile) {
  try {
    return JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version ?? null
  } catch {
    return null
  }
}

export const PLUGIN_VERSION = readVersion(path.join(here, '..', 'package.json'))

/** DSH version of the running process, read next to the launched bin. */
function dshVersion() {
  const bin = process.argv[1]
  if (!bin) return null
  for (const candidate of [path.join(path.dirname(bin), '..', 'package.json'), path.join(path.dirname(bin), 'package.json')]) {
    const v = readVersion(candidate)
    if (v) return v
  }
  return null
}

function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  return {
    name: typeof config.name === 'string' && config.name.trim() ? config.name.trim() : undefined,
    storeDir: typeof config.storeDir === 'string' && config.storeDir ? config.storeDir : undefined,
    publicUrl: typeof config.publicUrl === 'string' && config.publicUrl ? config.publicUrl : undefined,
  }
}

function sessionTitle(values) {
  if (!values || typeof values !== 'object') return undefined
  for (const key of ['title', 'sessionTitle', 'sessionListMetadata']) {
    const v = values[key]
    if (typeof v === 'string' && v.trim()) return v
    if (v && typeof v === 'object') {
      for (const inner of ['title', 'value', 'text', 'lastUserPrompt', 'firstPrompt']) {
        if (typeof v[inner] === 'string' && v[inner].trim()) return v[inner]
      }
    }
  }
  return undefined
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const store = new HostStore(config.storeDir)
  store.ensureDir()
  const device = store.device()
  const auth = new HostAuth(store)
  const startedAt = new Date()
  const logger = {
    info: (...a) => console.log('[dsh-device-host]', ...a),
    warn: (...a) => console.warn('[dsh-device-host]', ...a),
  }

  const deviceName = () => store.device().name || config.name || process.env.DSH_DEVICE_NAME || os.hostname()

  const tunnel = new LocalTunnel({
    origin: () => ctx.webServer.getOrigin(),
    authenticatedUrl: (base) => ctx.connection.authenticatedUrl(base),
    logger,
  })
  ctx.effect(() => () => tunnel.dispose(), 'dsh-device-host: tunnel')

  const hello = () => ({ protocol: PROTOCOL_VERSION, deviceId: device.id, name: deviceName() })

  // Change feed: session events bump a revision that long-polling desktops wait on.
  const feed = new RevisionFeed()
  ctx.effect(() => () => feed.dispose(), 'dsh-device-host: change feed')
  // Sessions waiting for the user (approvals, questions), folded from the same events.
  const pending = new PendingTracker()
  ctx.on('session/event', (session, event) => {
    const r = pending.observe(session?.id, event)
    if (r.started) feed.needsAttention(session.id, r.started.kind, r.started.toolName)
    if (event?.type === 'turn/end') feed.turnEnded(session?.id, event?.data?.reason?.kind)
    else feed.bump()
  })
  // Dev servers: re-scan listening ports while a desktop is watching, wake it on change.
  const ports = new PortWatcher({
    excludePorts: () => [Number(new URL(ctx.webServer.getOrigin()).port) || 0],
    workspaces: () => (ctx.get('workspaceRegistry')?.list?.() ?? []).map((w) => w.path).filter(Boolean),
  })
  let portsKey = null
  ctx.effect(() => {
    const timer = setInterval(async () => {
      if (feed.waiters.size === 0) return
      const key = PortWatcher.key(await ports.list())
      if (portsKey !== null && key !== portsKey) feed.bump()
      portsKey = key
    }, 3000)
    return () => clearInterval(timer)
  }, 'dsh-device-host: port watcher')
  const sync = new DeviceSync({
    profileDir: () => ctx.get('profileContext')?.dir ?? null,
    loaderRowIds: () => {
      try {
        return [...(ctx.get('loader')?.entries?.() ?? [])].map((e) => e?.options?.id).filter((id) => typeof id === 'string')
      } catch {
        return []
      }
    },
    pluginManager: () => ctx.get('pluginManager'),
    stateDir: store.dir,
    logger,
  })
  // Changes that arrive without a session event (workspaces, titles) surface within a minute.
  ctx.effect(() => {
    const timer = setInterval(() => feed.bump(), 60_000)
    return () => clearInterval(timer)
  }, 'dsh-device-host: periodic refresh')
  let sessionsCache = null

  const health = new HealthSampler()
  const updater = new Updater({
    root: runtimeRoot(path.join(here, '..')),
    version: PLUGIN_VERSION,
    port: () => Number(new URL(ctx.webServer.getOrigin()).port) || 3180,
    logger,
  })
  const info = () => ({
    ...hello(),
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    versions: { plugin: PLUGIN_VERSION, dsh: dshVersion(), node: process.versions.node, protocol: PROTOCOL_VERSION },
    features: updater.supported() ? [...HOST_FEATURES, SELF_UPDATE_FEATURE] : HOST_FEATURES,
    health: health.sample(),
    update: updater.status(),
    startedAt: startedAt.toISOString(),
    uptimeSec: Math.round(process.uptime()),
    loadavg: os.loadavg(),
    memory: { total: os.totalmem(), free: os.freemem() },
    publicUrl: config.publicUrl ?? null,
  })

  /** Authenticate a request by its access token, answering 401 otherwise. */
  const requireClient = (req, res) => {
    const client = auth.authenticate(req.headers[TOKEN_HEADER])
    if (!client) {
      sendError(res, 401, 'unauthorized')
      return undefined
    }
    return client
  }

  /** Session rows, cached per change-feed revision (and at most 10 s); waiting state is always fresh. */
  const listSessions = async () => {
    let value
    if (sessionsCache && sessionsCache.rev === feed.rev && Date.now() - sessionsCache.at < 10_000) value = sessionsCache.value
    else {
      const rev = feed.rev
      value = await listSessionsUncached()
      sessionsCache = { rev, at: Date.now(), value }
    }
    return { ...value, items: value.items.map((row) => ({ ...row, pending: pending.get(row.sessionId) })) }
  }

  const listSessionsUncached = async () => {
    const controller = ctx.get('sessionController')
    if (!controller) return { items: [], available: false }
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 10_000)
    try {
      const value = await controller.list({}, abort.signal)
      const registry = ctx.get('workspaceRegistry')
      const workspaces = registry?.list?.() ?? []
      const pinnedIds = [...(registry?.pinnedSessionIds ?? [])]
      const archivedIds = new Set(registry?.archivedSessionIds ?? [])
      const rows = (value?.items ?? [])
        .filter((row) => !row.parentSessionId && row.origin !== 'subagent' && !row.blank)
        .map((row) => {
          const ws = workspaces.find((w) => row.cwd && (row.cwd === w.path || row.cwd.startsWith(w.path + path.sep)))
          const pin = pinnedIds.indexOf(row.sessionId)
          return {
            sessionId: row.sessionId,
            title: sessionTitle(row.projections?.values) ?? null,
            cwd: row.cwd ?? null,
            workspaceId: ws?.id ?? null,
            workspaceTitle: ws?.title ?? null,
            running: !!row.running,
            live: !!row.agentAvailable,
            updatedAt: row.updatedAt ?? null,
            pinned: pin >= 0,
            ...(pin >= 0 ? { pinRank: pin } : {}),
          }
        })
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      const items = rows.filter((row) => !archivedIds.has(row.sessionId))
      const archived = rows
        .filter((row) => archivedIds.has(row.sessionId))
        .map(({ sessionId, title, workspaceTitle, cwd, updatedAt }) => ({ sessionId, title, workspaceTitle, cwd, updatedAt }))
      return { items, archived, available: true }
    } finally {
      clearTimeout(timer)
    }
  }

  const listWorkspaces = () => {
    const registry = ctx.get('workspaceRegistry')
    const list = registry?.list?.() ?? []
    return list.map((w) => ({ id: w.id, path: w.path, title: w.title, updatedAt: w.updatedAt }))
  }

  /** Whether a DeepSeek account is signed in here (never the token). */
  const accountStatus = async () => {
    const credentials = ctx.get('credentials')
    if (!credentials || typeof credentials.readRecord !== 'function') return { available: false, signedIn: false }
    try {
      const record = await credentials.readRecord(ACCOUNT_GRANT_KEY)
      const ok = record?.kind === 'grant' && typeof record.payload?.token === 'string' && !!record.payload.token
      return { available: true, signedIn: ok, issuer: ok ? record.payload.issuer ?? null : null }
    } catch {
      return { available: true, signedIn: false }
    }
  }

  /** Whether the agent here has a model credential (never the value). */
  const modelStatus = async () => {
    const credentials = ctx.get('credentials')
    const account = await accountStatus()
    let key
    if (!credentials) key = { configured: !!process.env[MODEL_KEY_REF], source: process.env[MODEL_KEY_REF] ? 'env' : null, writable: false }
    else {
      try {
        const info = await credentials.describe(MODEL_KEY_REF)
        key = { configured: !!info?.configured, source: info?.source ?? null, writable: info?.writable !== false }
      } catch {
        key = { configured: false, source: null, writable: true }
      }
    }
    return { ...key, account, ready: key.configured || account.signedIn }
  }

  const SESSION_ACTIONS = new Set(['rename', 'pin', 'unpin', 'archive', 'unarchive'])
  /** Rename / pin / archive one session through DSH's own controllers. */
  const sessionAction = async ({ sessionId, action, title, force }) => {
    if (typeof sessionId !== 'string' || !sessionId || !SESSION_ACTIONS.has(action)) throw Object.assign(new Error('invalid-action'), { status: 400 })
    if (action === 'rename') {
      const name = String(title ?? '').trim()
      if (!name || name.length > 200) throw Object.assign(new Error('invalid-title'), { status: 400 })
      const controller = ctx.get('sessionController')
      if (!controller?.rename) throw Object.assign(new Error('rename-unavailable'), { status: 501 })
      const r = await controller.rename({ sessionId, title: name })
      return { title: r?.title ?? name }
    }
    const registry = ctx.get('workspaceRegistry')
    if (!registry) throw Object.assign(new Error('workspaces-unavailable'), { status: 501 })
    try {
      if (action === 'pin') await registry.pinSession(sessionId)
      if (action === 'unpin') await registry.unpinSession(sessionId)
      if (action === 'archive') await registry.archiveSession(sessionId, force ? { stopActivity: true } : {})
      if (action === 'unarchive') await registry.unarchiveSession(sessionId)
    } catch (error) {
      const name = error?.name ?? ''
      if (/ActiveSession/.test(name)) throw Object.assign(new Error('session-active'), { status: 409 })
      if (/UnknownSession/.test(name)) throw Object.assign(new Error('session-not-found'), { status: 404 })
      if (/ArchivedSessionPin/.test(name)) throw Object.assign(new Error('session-archived'), { status: 409 })
      throw error
    }
    return {}
  }

  const routes = {
    async [ROUTES.hello](req, res) {
      if (req.method !== 'GET') return sendError(res, 405, 'method-not-allowed')
      sendJson(res, 200, hello())
    },

    async [ROUTES.pair](req, res) {
      if (req.method !== 'POST') return sendError(res, 405, 'method-not-allowed')
      if (auth.pairingLocked()) return sendError(res, 429, 'pairing-locked')
      const body = await readJsonBody(req)
      const client = body?.client ?? {}
      try {
        parsePublicKey(client.publicKey)
      } catch (error) {
        return sendError(res, 400, 'bad-public-key', error.message)
      }
      const consumed = store.consumeCode(body?.code)
      if (!consumed.ok) {
        auth.recordPairFailure()
        logger.warn(`pairing refused (${consumed.reason}) from ${remoteAddress(req)}`)
        return sendError(res, 401, `code-${consumed.reason}`)
      }
      const record = store.addClient({
        label: client.label || consumed.label,
        platform: client.platform,
        publicKey: client.publicKey,
        pairedVia: consumed.via,
      })
      logger.info(`paired client ${record.id} (${record.label}) via ${record.pairedVia}`)
      sendJson(res, 200, { clientId: record.id, device: hello() })
    },

    async [ROUTES.token](req, res) {
      if (req.method !== 'POST') return sendError(res, 405, 'method-not-allowed')
      const body = await readJsonBody(req)
      const result = auth.issueToken(body ?? {}, device.id)
      if (!result.ok) return sendError(res, result.status, result.error)
      sendJson(res, 200, { token: result.token, expiresAt: result.expiresAt, device: hello() })
    },

    async [ROUTES.info](req, res) {
      if (!requireClient(req, res)) return
      sendJson(res, 200, { ...info(), model: await modelStatus() })
    },

    async [ROUTES.sessions](req, res) {
      if (!requireClient(req, res)) return
      try {
        sendJson(res, 200, await listSessions())
      } catch (error) {
        sendError(res, 500, 'sessions-unavailable', error.message)
      }
    },

    async [ROUTES.workspaces](req, res) {
      if (!requireClient(req, res)) return
      sendJson(res, 200, { items: listWorkspaces() })
    },

    async [ROUTES.watch](req, res) {
      if (!requireClient(req, res)) return
      if (req.method !== 'GET') return sendError(res, 405, 'method-not-allowed')
      const url = new URL(req.url, 'http://device')
      const boot = startedAt.toISOString()
      const sameBoot = url.searchParams.get('boot') === boot
      const rev = sameBoot ? Number(url.searchParams.get('rev') ?? 0) : 0
      const since = sameBoot && url.searchParams.has('turns') ? Number(url.searchParams.get('turns')) : feed.turnSeq
      const attSince = sameBoot && url.searchParams.has('att') ? Number(url.searchParams.get('att')) : feed.attSeq
      const timeout = Math.min(WATCH_MAX_MS, Math.max(0, Number(url.searchParams.get('timeout') ?? 25_000) || 0))
      const abort = new AbortController()
      res.on('close', () => abort.abort())
      if (rev === feed.rev && feed.turnEndsSince(since).length === 0 && feed.attentionSince(attSince).length === 0) await feed.wait(rev, timeout, abort.signal)
      if (abort.signal.aborted) return
      const body = {
        boot,
        rev: feed.rev,
        turnSeq: feed.turnSeq,
        turnEnds: feed.turnEndsSince(since),
        attSeq: feed.attSeq,
        attention: feed.attentionSince(attSince),
      }
      if (rev !== feed.rev) {
        try {
          Object.assign(body, await listSessions(), { workspaces: listWorkspaces() })
        } catch (error) {
          body.error = error.message
        }
        try {
          body.ports = await ports.list()
          portsKey = PortWatcher.key(body.ports)
        } catch {}
      }
      sendJson(res, 200, body)
    },

    async [ROUTES.sessionAction](req, res) {
      const client = requireClient(req, res)
      if (!client) return
      if (req.method !== 'POST') return sendError(res, 405, 'method-not-allowed')
      const body = (await readJsonBody(req, 16 * 1024)) ?? {}
      const result = await sessionAction(body)
      sessionsCache = null
      feed.bump()
      logger.info(`session ${body.sessionId} ${body.action} by ${client.label}`)
      sendJson(res, 200, { ok: true, ...result })
    },

    async [ROUTES.search](req, res) {
      if (!requireClient(req, res)) return
      if (req.method !== 'GET') return sendError(res, 405, 'method-not-allowed')
      const q = String(new URL(req.url, 'http://device').searchParams.get('q') ?? '').trim().slice(0, 200)
      if (!q) return sendJson(res, 200, { items: [] })
      const controller = ctx.get('sessionController')
      if (!controller?.search) return sendError(res, 501, 'search-unavailable')
      const abort = new AbortController()
      res.on('close', () => abort.abort())
      const timer = setTimeout(() => abort.abort(), 15_000)
      try {
        const result = await controller.search({ query: q }, abort.signal)
        const titles = new Map(((await listSessions().catch(() => null))?.items ?? []).map((s) => [s.sessionId, s.title]))
        const items = (result?.items ?? []).slice(0, 50).map((item) => {
          const match = item.match ?? item.matches?.[0] ?? item.snippet ?? item.excerpt ?? null
          const snippet = typeof match === 'string' ? match : typeof match?.text === 'string' ? match.text : typeof match?.snippet === 'string' ? match.snippet : null
          return {
            sessionId: item.sessionId,
            title: titles.get(item.sessionId) ?? item.title ?? sessionTitle(item.projections?.values) ?? null,
            snippet: snippet ? snippet.replace(/\s+/g, ' ').slice(0, 240) : null,
          }
        })
        sendJson(res, 200, { items })
      } finally {
        clearTimeout(timer)
      }
    },

    async [ROUTES.account](req, res) {
      const client = requireClient(req, res)
      if (!client) return
      if (req.method === 'GET') return sendJson(res, 200, await accountStatus())
      const credentials = ctx.get('credentials')
      if (!credentials || typeof credentials.modifyRecord !== 'function') return sendError(res, 501, 'credentials-unavailable')
      if (req.method === 'PUT') {
        const body = await readJsonBody(req, 16 * 1024)
        const grant = body?.grant
        if (!grant || grant.version !== 1 || typeof grant.token !== 'string' || !grant.token || typeof grant.issuer !== 'string' || !/^https?:\/\//.test(grant.issuer)) {
          return sendError(res, 400, 'invalid-grant')
        }
        const payload = { version: 1, token: grant.token, issuer: grant.issuer }
        await credentials.modifyRecord(ACCOUNT_GRANT_KEY, async () => ({ kind: 'grant', payload }))
        logger.info(`DeepSeek account sign-in copied from ${client.label}`)
        feed.bump()
        return sendJson(res, 200, await accountStatus())
      }
      if (req.method === 'DELETE') {
        // Local only: the desktop the sign-in came from stays signed in.
        await credentials.deleteRecord(ACCOUNT_GRANT_KEY)
        logger.info(`DeepSeek account signed out on this device by ${client.label}`)
        feed.bump()
        return sendJson(res, 200, await accountStatus())
      }
      sendError(res, 405, 'method-not-allowed')
    },

    async [ROUTES.sync](req, res) {
      const client = requireClient(req, res)
      if (!client) return
      if (req.method === 'GET') return sendJson(res, 200, await sync.state())
      if (req.method !== 'POST') return sendError(res, 405, 'method-not-allowed')
      const bundle = await readJsonBody(req, 64 * 1024 * 1024)
      const lines = []
      const report = await sync.apply(bundle ?? {}, { from: client.label, log: (line) => lines.push(line) })
      logger.info(`sync from ${client.label}: ${report.filter((r) => r.ok).length}/${report.length} applied`)
      sendJson(res, 200, { report, log: lines, state: await sync.state() })
    },

    async [ROUTES.selfUpdate](req, res) {
      const client = requireClient(req, res)
      if (!client) return
      if (req.method === 'GET') return sendJson(res, 200, updater.status({ withLog: true }))
      if (req.method !== 'POST') return sendError(res, 405, 'method-not-allowed')
      const body = (await readJsonBody(req, 32 * 1024 * 1024)) ?? {}
      const started = updater.start(body)
      logger.info(`self-update ${started.from} -> ${started.to} requested by ${client.label}`)
      sendJson(res, 202, started)
    },

    async [ROUTES.ports](req, res) {
      if (!requireClient(req, res)) return
      if (req.method !== 'GET') return sendError(res, 405, 'method-not-allowed')
      sendJson(res, 200, { items: await ports.list() })
    },

    async [ROUTES.modelKey](req, res) {
      const client = requireClient(req, res)
      if (!client) return
      if (req.method === 'GET') return sendJson(res, 200, await modelStatus())
      const credentials = ctx.get('credentials')
      if (!credentials) return sendError(res, 501, 'credentials-unavailable')
      if (req.method === 'PUT') {
        const body = await readJsonBody(req, 8 * 1024)
        const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
        if (apiKey.length < 8 || apiKey.length > 512 || /\s/.test(apiKey)) return sendError(res, 400, 'invalid-api-key')
        await credentials.set(MODEL_KEY_REF, apiKey)
        logger.info(`model credential ${MODEL_KEY_REF} updated by ${client.label}`)
        return sendJson(res, 200, await modelStatus())
      }
      if (req.method === 'DELETE') {
        await credentials.unset(MODEL_KEY_REF)
        logger.info(`model credential ${MODEL_KEY_REF} removed by ${client.label}`)
        return sendJson(res, 200, await modelStatus())
      }
      sendError(res, 405, 'method-not-allowed')
    },

    async [ROUTES.self](req, res) {
      if (req.method !== 'DELETE') return sendError(res, 405, 'method-not-allowed')
      const client = requireClient(req, res)
      if (!client) return
      store.revokeClient(client.id)
      auth.revokeTokensFor(client.id)
      logger.info(`client ${client.id} (${client.label}) unpaired itself`)
      sendJson(res, 200, { ok: true })
    },
  }

  const guarded = (handler) => async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      if (!res.headersSent) sendError(res, error.status ?? 500, error.status ? error.message : 'internal-error')
      else res.destroy()
      if (!error.status) logger.warn(error)
    }
  }

  for (const [routePath, handler] of Object.entries(routes)) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: routePath, handler: guarded(handler) }),
      `dsh-device-host: ${routePath}`,
    )
  }

  // Tunnel: every HTTP path under /t/ is proxied to this instance's own UI.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        // The webserver matches a prefix P as `P` or `P/...`, so no trailing slash.
        path: ROUTES.tunnel,
        handler: guarded(async (req, res) => {
          if (!requireClient(req, res)) return
          const upstreamPath = req.url.slice(ROUTES.tunnel.length) || '/'
          await tunnel.handleHttp(req, res, upstreamPath)
        }),
      }),
    'dsh-device-host: tunnel http',
  )

  // Port previews: raw TCP to a loopback port of this device.
  ctx.effect(
    () =>
      ctx.webServer.registerUpgrade({
        path: ROUTES.portTunnel,
        handler: async (req, socket, head) => {
          const client = auth.authenticate(req.headers[TOKEN_HEADER])
          if (!client) {
            socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            return
          }
          const port = Number(new URL(req.url, 'http://device').searchParams.get('port'))
          handlePortTunnel(req, socket, head, port)
        },
      }),
    'dsh-device-host: port tunnel',
  )

  for (const upgradePath of TUNNEL_UPGRADE_PATHS) {
    ctx.effect(
      () =>
        ctx.webServer.registerUpgrade({
          path: `${ROUTES.tunnel}${upgradePath}`,
          handler: async (req, socket, head) => {
            const client = auth.authenticate(req.headers[TOKEN_HEADER])
            if (!client) {
              socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
              return
            }
            const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
            await tunnel.handleUpgrade(req, socket, head, `${upgradePath}${query}`)
          },
        }),
      `dsh-device-host: tunnel ${upgradePath}`,
    )
  }

  // Runtime facts for `dsh-device status`, refreshed until the listener is up.
  const publishRuntime = () => {
    try {
      const origin = ctx.webServer.getOrigin()
      store.writeRuntime({
        pid: process.pid,
        origin,
        deviceBase: DEVICE_BASE,
        deviceId: device.id,
        startedAt: startedAt.toISOString(),
        versions: { plugin: PLUGIN_VERSION, dsh: dshVersion(), node: process.versions.node },
      })
      return true
    } catch {
      return false
    }
  }
  ctx.effect(() => {
    if (publishRuntime()) return () => store.clearRuntime(process.pid)
    const timer = setInterval(() => publishRuntime() && clearInterval(timer), 500)
    return () => {
      clearInterval(timer)
      store.clearRuntime(process.pid)
    }
  }, 'dsh-device-host: runtime file')

  logger.info(`device ${device.id} (${deviceName()}) ready; routes under ${DEVICE_BASE}`)
}
