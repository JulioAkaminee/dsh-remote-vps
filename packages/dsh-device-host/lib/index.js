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
//   DELETE /clients/self     unpair the calling client            (token)
//   *      /t/...            tunnel to this instance's DSH web UI (token)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostAuth, parsePublicKey } from './auth.js'
import { readJsonBody, remoteAddress, sendError, sendJson } from './http-util.js'
import { DEVICE_BASE, PROTOCOL_VERSION, ROUTES, TOKEN_HEADER, TUNNEL_UPGRADE_PATHS } from './protocol.js'
import { HostStore } from './store.js'
import { LocalTunnel } from './tunnel.js'

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

  const info = () => ({
    ...hello(),
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    versions: { plugin: PLUGIN_VERSION, dsh: dshVersion(), node: process.versions.node, protocol: PROTOCOL_VERSION },
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

  const listSessions = async () => {
    const controller = ctx.get('sessionController')
    if (!controller) return { items: [], available: false }
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 10_000)
    try {
      const value = await controller.list({}, abort.signal)
      const workspaces = ctx.get('workspaceRegistry')?.list?.() ?? []
      const items = (value?.items ?? [])
        .filter((row) => !row.parentSessionId && row.origin !== 'subagent' && !row.blank)
        .map((row) => {
          const ws = workspaces.find((w) => row.cwd && (row.cwd === w.path || row.cwd.startsWith(w.path + path.sep)))
          return {
            sessionId: row.sessionId,
            title: sessionTitle(row.projections?.values) ?? null,
            cwd: row.cwd ?? null,
            workspaceId: ws?.id ?? null,
            workspaceTitle: ws?.title ?? null,
            running: !!row.running,
            live: !!row.agentAvailable,
            updatedAt: row.updatedAt ?? null,
          }
        })
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      return { items, available: true }
    } finally {
      clearTimeout(timer)
    }
  }

  const listWorkspaces = () => {
    const registry = ctx.get('workspaceRegistry')
    const list = registry?.list?.() ?? []
    return list.map((w) => ({ id: w.id, path: w.path, title: w.title, updatedAt: w.updatedAt }))
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
      sendJson(res, 200, info())
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
