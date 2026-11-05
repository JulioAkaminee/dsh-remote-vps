#!/usr/bin/env node
// dsh-device — manage this machine as a DSH remote device.
//
//   dsh-device pair [--ttl 5m] [--label NAME] [--url BASE_URL] [--json]
//   dsh-device connections [--all] [--json]
//   dsh-device revoke <client-id>
//   dsh-device status [--json]
//   dsh-device name [NEW_NAME]
//   dsh-device service install|uninstall|start|stop|restart|status|logs [--port N]
//   dsh-device doctor

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPairingLink, formatCode, PROTOCOL_VERSION, ROUTES } from '../lib/protocol.js'
import { dshHome, HostStore } from '../lib/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
const SERVICE = 'dsh-device-host'
const DEFAULT_PORT = 3180

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2)
      if (inline !== undefined) flags[k] = inline
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]
      else flags[k] = true
    } else positional.push(a)
  }
  return { positional, flags }
}

/** "90s", "5m", "1h", or bare seconds. */
function parseDuration(text, fallbackMs) {
  if (text === undefined || text === true) return fallbackMs
  const m = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i)
  if (!m) throw new Error(`invalid duration: ${text}`)
  const n = Number(m[1])
  const unit = (m[2] ?? 's').toLowerCase()
  return Math.round(n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit])
}

function fmtAge(iso) {
  if (!iso) return 'never'
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function probe(origin, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(`${origin}${ROUTES.hello}`, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode === 200, status: res.statusCode, body: JSON.parse(body) })
        } catch {
          resolve({ ok: false, status: res.statusCode })
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (error) => resolve({ ok: false, error: error.message }))
  })
}

function systemctl(...args) {
  return spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' })
}

function hasSystemdUser() {
  const r = systemctl('show-environment')
  return r.status === 0
}

function unitPath() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', `${SERVICE}.service`)
}

/** Locate the dsh CLI entry this device should run. */
function resolveDshBin(explicit) {
  const candidates = [
    explicit,
    process.env.DSH_BIN,
    path.join(os.homedir(), '.dsh-device', 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(here, '..', '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(here, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ].filter(Boolean)
  return candidates.find((c) => fs.existsSync(c))
}

const commands = {
  async pair({ flags }) {
    const store = new HostStore()
    const device = store.device()
    const ttlMs = parseDuration(flags.ttl, 5 * 60_000)
    const label = typeof flags.label === 'string' ? flags.label : null
    const via = flags.via === 'ssh' ? 'ssh' : 'code'
    const { code, expiresAt } = store.createCode({ ttlMs, label, via })
    const runtime = store.runtime()
    const url = typeof flags.url === 'string' ? flags.url.replace(/\/+$/, '') : undefined
    const link = buildPairingLink({ url, code, deviceId: device.id })
    if (flags.json) {
      process.stdout.write(
        JSON.stringify({
          code: formatCode(code),
          expiresAt,
          deviceId: device.id,
          name: device.name || os.hostname(),
          origin: runtime?.origin ?? null,
          link,
          protocol: PROTOCOL_VERSION,
        }) + '\n',
      )
      return
    }
    const minutes = Math.max(1, Math.round(ttlMs / 60000))
    console.log('')
    console.log(`  Pairing code:   ${formatCode(code)}`)
    console.log(`  Valid for:      ${minutes} min, single use`)
    console.log(`  Device:         ${device.name || os.hostname()} (${device.id})`)
    if (url) console.log(`  Pairing link:   ${link}`)
    console.log('')
    console.log('  On your desktop DSH: Devices -> Add device -> Pairing code.')
    if (!url) {
      console.log('  The desktop also needs this device\'s URL. Pass --url https://... to embed it in a')
      console.log('  link (Tailscale, Cloudflare Tunnel or any HTTPS proxy in front of the device port).')
      console.log('  Pairing over SSH needs no code at all: Devices -> Add device -> SSH.')
    }
    if (!runtime) console.log('\n  Note: the device host is not running; start it with `dsh-device service start`.')
    console.log('')
  },

  async connections({ flags }) {
    const store = new HostStore()
    const clients = store.clients().filter((c) => flags.all || !c.revokedAt)
    if (flags.json) {
      process.stdout.write(JSON.stringify({ clients: clients.map(({ publicKey, ...rest }) => rest) }) + '\n')
      return
    }
    if (clients.length === 0) {
      console.log('No paired desktops. Create a code with `dsh-device pair`.')
      return
    }
    for (const c of clients) {
      const state = c.revokedAt ? `revoked ${fmtAge(c.revokedAt)}` : `last seen ${fmtAge(c.lastSeenAt)}`
      console.log(`${c.id}  ${c.label.padEnd(28)} ${String(c.platform ?? '').padEnd(8)} via ${c.pairedVia.padEnd(4)}  paired ${fmtAge(c.createdAt)}, ${state}`)
    }
  },

  async revoke({ positional }) {
    const id = positional[1]
    if (!id) throw new Error('usage: dsh-device revoke <client-id>')
    const store = new HostStore()
    const matches = store.clients().filter((c) => c.id === id || c.id.startsWith(id))
    if (matches.length !== 1) throw new Error(matches.length ? `ambiguous id: ${id}` : `no client ${id}`)
    store.revokeClient(matches[0].id)
    console.log(`Revoked ${matches[0].id} (${matches[0].label}). Its access ends on its next request.`)
  },

  async name({ positional }) {
    const store = new HostStore()
    if (positional[1]) {
      const r = store.setDeviceName(positional.slice(1).join(' '))
      console.log(`Device name: ${r.name}`)
    } else console.log(store.device().name || os.hostname())
  },

  async status({ flags }) {
    const store = new HostStore()
    const device = store.device()
    const runtime = store.runtime()
    const live = runtime?.origin ? await probe(runtime.origin) : { ok: false }
    const service = hasSystemdUser() ? systemctl('is-active', SERVICE).stdout.trim() : 'no-systemd'
    const clients = store.clients().filter((c) => !c.revokedAt)
    const out = {
      deviceId: device.id,
      name: device.name || os.hostname(),
      dshHome: dshHome(),
      service,
      running: live.ok,
      origin: runtime?.origin ?? null,
      pid: runtime?.pid ?? null,
      versions: runtime?.versions ?? { plugin: pkg.version },
      pairedClients: clients.length,
      pendingCodes: store.pendingCodes().length,
    }
    if (flags.json) return void process.stdout.write(JSON.stringify(out) + '\n')
    console.log(`Device:   ${out.name} (${out.deviceId})`)
    console.log(`Host:     ${out.running ? `running at ${out.origin} (pid ${out.pid})` : 'not running'}`)
    console.log(`Service:  ${out.service}`)
    console.log(`Versions: plugin ${out.versions.plugin ?? '?'}, dsh ${out.versions.dsh ?? '?'}, node ${out.versions.node ?? process.versions.node}`)
    console.log(`Paired:   ${out.pairedClients} desktop(s)`)
  },

  async service({ positional, flags }) {
    const action = positional[1] ?? 'status'
    if (!hasSystemdUser()) throw new Error('systemd --user is not available on this machine')
    const unit = unitPath()
    switch (action) {
      case 'install': {
        const port = Number(flags.port ?? DEFAULT_PORT)
        const node = flags.node ?? process.execPath
        const dshBin = resolveDshBin(flags['dsh-bin'])
        if (!dshBin) throw new Error('cannot find @deepseek-ai/dsh; pass --dsh-bin <path to lib/bin.js>')
        const deviceRoot = process.env.DSH_DEVICE_ROOT || path.join(os.homedir(), '.dsh-device')
        const envFile = path.join(deviceRoot, 'env')
        // The agent's commands and DSH's plugin manager (pnpm in bin/) run with this PATH;
        // ~/.dsh-device/env can still override it.
        const servicePath = [path.join(deviceRoot, 'bin'), path.dirname(node), path.join(os.homedir(), '.local', 'bin'), '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin']
          .filter((p, i, all) => all.indexOf(p) === i)
          .join(':')
        const body = [
          '[Unit]',
          'Description=DSH device host (remote DeepSeek Harness)',
          'After=network-online.target',
          'Wants=network-online.target',
          '',
          '[Service]',
          'Type=simple',
          `ExecStart=${node} ${dshBin} --profile device-host --no-open --host 127.0.0.1 --port ${port}`,
          `Environment=DSH_HOME=${dshHome()}`,
          'Environment=NODE_ENV=production',
          `Environment=PATH=${servicePath}`,
          `EnvironmentFile=-${envFile}`,
          'Restart=always',
          'RestartSec=3',
          '',
          '[Install]',
          'WantedBy=default.target',
          '',
        ].join('\n')
        fs.mkdirSync(path.dirname(unit), { recursive: true })
        fs.writeFileSync(unit, body)
        execFileSync('systemctl', ['--user', 'daemon-reload'])
        execFileSync('systemctl', ['--user', 'enable', '--now', SERVICE])
        // Keep user services running without an open login session.
        spawnSync('loginctl', ['enable-linger', os.userInfo().username])
        console.log(`Installed and started ${SERVICE} on 127.0.0.1:${port}`)
        return
      }
      case 'uninstall':
        systemctl('disable', '--now', SERVICE)
        fs.rmSync(unit, { force: true })
        systemctl('daemon-reload')
        console.log(`Removed ${SERVICE}`)
        return
      case 'start':
      case 'stop':
      case 'restart': {
        const r = systemctl(action, SERVICE)
        if (r.status !== 0) throw new Error(r.stderr.trim() || `systemctl ${action} failed`)
        console.log(`${action}: ok`)
        return
      }
      case 'status':
        process.stdout.write(systemctl('status', '--no-pager', SERVICE).stdout)
        return
      case 'logs':
        spawnSync('journalctl', ['--user', '-u', SERVICE, '-n', String(flags.n ?? 100), '--no-pager'], { stdio: 'inherit' })
        return
      default:
        throw new Error(`unknown service action: ${action}`)
    }
  },

  async doctor() {
    const checks = []
    const add = (ok, label, detail = '') => checks.push({ ok, label, detail })
    const [major, minor] = process.versions.node.split('.').map(Number)
    add(major > 22 || (major === 22 && minor >= 19), 'node >= 22.19', process.versions.node)
    const dshBin = resolveDshBin()
    add(!!dshBin, 'dsh runtime found', dshBin ?? 'not found')
    const profileDir = path.join(dshHome(), 'profiles', 'device-host')
    add(fs.existsSync(path.join(profileDir, 'package.json')), 'device-host profile', profileDir)
    const systemd = hasSystemdUser()
    add(systemd, 'systemd --user available')
    if (systemd) add(systemctl('is-active', SERVICE).stdout.trim() === 'active', `${SERVICE} service active`)
    const runtime = new HostStore().runtime()
    const live = runtime?.origin ? await probe(runtime.origin) : { ok: false, error: 'no runtime file' }
    add(live.ok, 'device host answering', runtime?.origin ?? live.error)
    for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.label}${c.detail ? `  (${c.detail})` : ''}`)
    if (checks.some((c) => !c.ok)) process.exitCode = 1
  },

  async version() {
    console.log(pkg.version)
  },
}
commands.clients = commands.connections
commands['--version'] = commands.version

function usage() {
  console.log(`dsh-device ${pkg.version} — this machine as a DSH remote device

  pair [--ttl 5m] [--label NAME] [--url BASE_URL] [--json]   mint a one-time pairing code
  connections [--all] [--json]                               list paired desktops
  revoke <client-id>                                         end a desktop's access
  status [--json]                                            device and host status
  name [NEW_NAME]                                            show or set the device name
  service install|uninstall|start|stop|restart|status|logs   manage the systemd user service
  doctor                                                     check the installation`)
}

const args = parseArgs(process.argv.slice(2))
const command = args.positional[0]
if (!command || command === 'help' || args.flags.help) usage()
else if (!commands[command]) {
  console.error(`unknown command: ${command}\n`)
  usage()
  process.exitCode = 2
} else {
  try {
    await commands[command](args)
  } catch (error) {
    console.error(`dsh-device: ${error.message}`)
    process.exitCode = 1
  }
}
