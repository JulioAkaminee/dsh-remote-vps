// dsh-devices — control remote DSH devices from this desktop.
//
// Host half: device registry, one live connection per device (SSH tunnel or
// HTTPS), health checks, pairing jobs, and per-device local gateways that
// show each device's own DSH UI. The browser half (./client) renders the
// Devices panel. All routes below are exact routes on DSH's authenticated
// /api channel, so only this desktop's owner browser reaches them.

import { detectEditors } from './editors.js'
import { DeviceManager } from './manager.js'
import { listSshAliases, resolveSshTarget } from './ssh.js'

export const name = 'dsh-devices'
export const inject = ['connection']

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function fail(error, status = 400) {
  return json({ error: String(error?.message ?? error) }, status)
}

async function body(request) {
  try {
    const text = await request.text()
    return text ? JSON.parse(text) : {}
  } catch {
    throw new Error('invalid JSON body')
  }
}

export function apply(ctx, config) {
  const pollMs = Number(config?.pollMs) > 0 ? Number(config.pollMs) : undefined
  const manager = new DeviceManager({
    pollMs,
    credentials: () => ctx.get('credentials'),
    logger: { info: (...a) => console.log('[dsh-devices]', ...a), warn: (...a) => console.warn('[dsh-devices]', ...a) },
  })
  manager.start()
  ctx.effect(() => () => manager.dispose(), 'dsh-devices: manager')

  // Wake-from-sleep: a stalled interval means the machine was suspended.
  ctx.effect(() => {
    let last = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      if (now - last > 30_000) manager.refresh()
      last = now
    }, 5000)
    return () => clearInterval(timer)
  }, 'dsh-devices: wake detector')

  const routes = [
    ['GET', '/devices', async () => json(manager.list())],
    [
      'GET',
      '/devices/watch',
      async (request) => {
        // Long-poll: answers as soon as anything changes (or after 25 s).
        const v = Number(new URL(request.url).searchParams.get('v') ?? 0)
        await manager.waitForChange(v, 25_000, request.signal)
        return json(manager.list())
      },
    ],
    [
      'GET',
      '/devices/ssh-hosts',
      async () => {
        const hosts = listSshAliases().map((alias) => {
          try {
            const r = resolveSshTarget(alias)
            return { alias, host: r.host, user: r.username, port: r.port }
          } catch {
            return { alias }
          }
        })
        return json({ hosts, saved: manager.savedMachines() })
      },
    ],
    [
      'GET',
      '/devices/job',
      async (request) => {
        const id = new URL(request.url).searchParams.get('id')
        const job = id && manager.jobView(id)
        return job ? json(job) : fail('unknown job', 404)
      },
    ],
    ['POST', '/devices/pair-code', async (request) => json({ device: await manager.addByCode(await body(request)) })],
    [
      'POST',
      '/devices/pair-ssh',
      async (request) => {
        const b = await body(request)
        if (!b.target) return fail('target is required (ssh alias or user@host)')
        return json(manager.addBySsh(b))
      },
    ],
    ['POST', '/devices/open', async (request) => {
      const b = await body(request)
      return json(await manager.open(b.id, { next: b.next }))
    }],
    ['POST', '/devices/rename', async (request) => {
      const b = await body(request)
      return json({ device: manager.rename(b.id, b.name) })
    }],
    ['POST', '/devices/remove', async (request) => {
      const b = await body(request)
      return json(await manager.remove(b.id, { revoke: b.revoke !== false }))
    }],
    ['POST', '/devices/refresh', async (request) => {
      const b = await body(request)
      manager.refresh(b.id)
      return json({ ok: true })
    }],
    ['GET', '/devices/editors', async () => json({ editors: detectEditors() })],
    ['POST', '/devices/open-editor', async (request) => {
      const b = await body(request)
      try {
        return json(await manager.openInEditor(b.id, { path: b.path, sessionId: b.sessionId, editor: b.editor }))
      } catch (error) {
        return json({ error: error.message, code: error.code ?? null }, error.code === 'NO_EDITOR_HOST' ? 409 : 400)
      }
    }],
    ['POST', '/devices/editor-host', async (request) => {
      const b = await body(request)
      return json({ device: manager.setEditorHost(b.id, b.host) })
    }],
    ['GET', '/devices/local-model-key', async () => json({ available: !!(await manager.localModelKey()) })],
    ['POST', '/devices/model-key', async (request) => {
      const b = await body(request)
      return json(await manager.setModelKey(b.id, { apiKey: b.apiKey, fromDesktop: b.fromDesktop === true }))
    }],
    ['POST', '/devices/model-key/clear', async (request) => {
      const b = await body(request)
      return json(await manager.clearModelKey(b.id))
    }],
    ['POST', '/devices/update', async (request) => {
      const b = await body(request)
      return json(manager.update(b.id))
    }],
  ]

  // One registration per path, dispatching on method.
  const byPath = new Map()
  for (const [method, path, handler] of routes) {
    if (!byPath.has(path)) byPath.set(path, new Map())
    byPath.get(path).set(method, handler)
  }
  for (const [path, handlers] of byPath) {
    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path: `/api${path}`,
          methods: [...handlers.keys()],
          requestBody: 'buffered',
          fetch: async (request) => {
            const handler = handlers.get(request.method)
            if (!handler) return fail('method not allowed', 405)
            try {
              return await handler(request)
            } catch (error) {
              return fail(error, error.status && error.status >= 400 && error.status < 600 ? error.status : 400)
            }
          },
        }),
      `dsh-devices: /api${path}`,
    )
  }
}
