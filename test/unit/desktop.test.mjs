// Unit tests for the desktop side: SSH config resolution, known_hosts, the
// per-device gateway's security checks and forwarding, and the protocol copy.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('protocol.js is identical in both packages', () => {
  const a = fs.readFileSync(path.join(root, 'packages/dsh-device-host/lib/protocol.js'))
  const b = fs.readFileSync(path.join(root, 'packages/dsh-devices/lib/protocol.js'))
  assert.ok(a.equals(b))
})

test('ssh: ~/.ssh/config aliases, wildcards, Include and known_hosts (hashed)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdev-home-'))
  fs.mkdirSync(path.join(home, '.ssh', 'conf.d'), { recursive: true })
  fs.writeFileSync(
    path.join(home, '.ssh', 'config'),
    ['Include conf.d/*.conf', 'Host vps', '  HostName 203.0.113.10', '  User deploy', '  Port 2222', '  IdentityFile ~/.ssh/vps_key', 'Host *', '  User fallback', ''].join('\n'),
  )
  fs.writeFileSync(path.join(home, '.ssh', 'conf.d', 'a.conf'), 'Host jumpbox\n  HostName 198.51.100.7\n')
  const blob = crypto.randomBytes(51)
  const salt = crypto.randomBytes(20)
  const hashed = crypto.createHmac('sha1', salt).update('[203.0.113.10]:2222').digest('base64')
  fs.writeFileSync(path.join(home, '.ssh', 'known_hosts'), `|1|${salt.toString('base64')}|${hashed} ssh-ed25519 ${blob.toString('base64')}\n`)
  const prev = process.env.HOME
  process.env.HOME = home
  try {
    const { resolveSshTarget, listSshAliases, knownHostsHas, fingerprint } = await import(`../../packages/dsh-devices/lib/ssh.js?home=${Date.now()}`)
    const r = resolveSshTarget('vps')
    assert.deepEqual([r.host, r.port, r.username], ['203.0.113.10', 2222, 'deploy'])
    assert.equal(r.identityFiles[0], path.join(home, '.ssh', 'vps_key'))
    assert.equal(resolveSshTarget('jumpbox').host, '198.51.100.7')
    assert.equal(resolveSshTarget('jumpbox').username, 'fallback')
    const direct = resolveSshTarget('root@192.0.2.5:2200')
    assert.deepEqual([direct.host, direct.port, direct.username], ['192.0.2.5', 2200, 'root'])
    assert.deepEqual(listSshAliases().sort(), ['jumpbox', 'vps'])
    assert.equal(knownHostsHas('203.0.113.10', 2222, blob), true)
    assert.equal(knownHostsHas('203.0.113.10', 22, blob), false)
    assert.match(fingerprint(blob), /^SHA256:[A-Za-z0-9+/]+$/)
  } finally {
    process.env.HOME = prev
  }
})

function request(port, { method = 'GET', path: p = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('gateway: secret path, Host/Origin checks, token injection, WebSocket relay', async () => {
  const { DeviceGateway } = await import('../../packages/dsh-devices/lib/gateway.js')
  const seen = []
  const device = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'x=1', 'x-frame-options': 'DENY' })
    res.end(`device ${req.url}`)
  })
  device.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, headers: req.headers, upgrade: true })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (d) => socket.write(d))
  })
  await new Promise((r) => device.listen(0, '127.0.0.1', r))
  const gw = new DeviceGateway({ deviceId: '00000000-0000-0000-0000-000000000000', baseUrl: () => `http://127.0.0.1:${device.address().port}`, token: async () => 'TOKEN' })
  await gw.start()
  const host = `127.0.0.1:${gw.port}`
  const prefix = `/${gw.secret}`

  assert.equal((await request(gw.port, { path: '/', headers: { host } })).status, 404, 'no secret, no access')
  assert.equal((await request(gw.port, { path: `/${'A'.repeat(gw.secret.length)}/`, headers: { host } })).status, 404)
  assert.equal((await request(gw.port, { path: `${prefix}/`, headers: { host: 'evil.example' } })).status, 403, 'DNS rebinding refused')
  const redirect = await request(gw.port, { path: `${prefix}?a=1`, headers: { host } })
  assert.equal(redirect.status, 308)
  assert.equal(redirect.headers.location, `${prefix}/?a=1`)
  assert.equal((await request(gw.port, { method: 'POST', path: `${prefix}/api`, headers: { host, origin: 'http://evil.example' } })).status, 403)

  const ok = await request(gw.port, { path: `${prefix}/assets/a.js?v=1`, headers: { host, cookie: 'desktop=secret' } })
  assert.equal(ok.status, 200)
  assert.equal(ok.body, 'device /device/v1/t/assets/a.js?v=1')
  assert.equal(ok.headers['set-cookie'], undefined)
  assert.equal(ok.headers['x-frame-options'], undefined, 'the desktop may frame the device UI')
  assert.equal(ok.headers['referrer-policy'], 'no-referrer')
  const fwd = seen.at(-1)
  assert.equal(fwd.headers['x-dsh-device-token'], 'TOKEN')
  assert.equal(fwd.headers.cookie, undefined, 'desktop cookies never reach the device')

  // WebSocket upgrade relayed to the device tunnel path.
  const echoed = await new Promise((resolve, reject) => {
    const s = net.connect(gw.port, '127.0.0.1', () => {
      s.write(`GET ${prefix}/api/remote.mux HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    })
    let buf = ''
    s.on('data', (d) => {
      buf += d.toString()
      if (buf.includes('\r\n\r\n') && !buf.includes('ping')) s.write('ping')
      if (buf.includes('ping')) {
        s.destroy()
        resolve(buf)
      }
    })
    s.on('error', reject)
  })
  assert.match(echoed, /^HTTP\/1\.1 101/)
  assert.equal(seen.find((x) => x.upgrade).url, '/device/v1/t/api/remote.mux')
  await gw.stop()
  device.close()
})

test('ssh: machines saved by dsh-tauri-remote are listed with their accepted host key, secrets only on request', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdev-dshhome-'))
  fs.mkdirSync(path.join(home, 'remote'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'remote', 'machines.json'),
    JSON.stringify({ version: 1, enabled: true, machines: { m1: { id: 'm1', name: 'VPS', host: '203.0.113.10', port: 2222, user: 'root', password: 'pw' }, bad: { id: 'bad' } } }),
  )
  fs.writeFileSync(path.join(home, 'remote', 'known-hosts.json'), JSON.stringify([{ machineId: 'm1', fingerprint: 'SHA256:abc' }]))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { listSavedMachines } = await import(`../../packages/dsh-devices/lib/ssh.js?saved=${Date.now()}`)
    const [m, ...rest] = listSavedMachines()
    assert.equal(rest.length, 0, 'invalid records are skipped')
    assert.deepEqual([m.name, m.target, m.fingerprint, m.hasPassword], ['VPS', 'root@203.0.113.10:2222', 'SHA256:abc', true])
    assert.equal(m.password, undefined, 'no secrets unless asked')
    assert.equal(listSavedMachines({ withSecrets: true })[0].password, 'pw')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

test('versions: device hosts older than the desktop plugin are detected', async () => {
  const { compareVersions } = await import('../../packages/dsh-devices/lib/manager.js')
  assert.equal(compareVersions('0.1.3', '0.1.4'), -1)
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1)
  assert.equal(compareVersions('0.2.1-rc.5', '0.2.1'), 0)
  assert.equal(compareVersions('1.0', '1.0.0'), 0)
})

test('manager: long-poll waiters wake on change and time out otherwise', async () => {
  const { DeviceManager } = await import('../../packages/dsh-devices/lib/manager.js')
  const { DeviceRegistry } = await import('../../packages/dsh-devices/lib/registry.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdev-reg-'))
  const m = new DeviceManager({ registry: new DeviceRegistry(dir) })
  const v = m.version
  const t0 = Date.now()
  await m.waitForChange(v, 40)
  assert.ok(Date.now() - t0 >= 35, 'no change: waits for the timeout')
  const waiting = m.waitForChange(m.version, 5000)
  m._changed()
  await waiting
  assert.equal(m.version, v + 1)
  await m.waitForChange(v, 5000) // stale version answers immediately
  await m.dispose()
})

test('browser modules load: factories run without throwing (catches TDZ/syntax slips)', async () => {
  const vm = await import('node:vm')
  for (const file of ['packages/dsh-devices/lib/client.js', 'packages/dsh-device-host/lib/client.js']) {
    const loaded = []
    const store = new Map()
    const el = () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], classList: { add() {}, remove() {} } })
    const sandbox = {
      window: { __ModuleLoader__: { load: (m) => loaded.push(m) }, location: { search: '', pathname: '/', hash: '' }, addEventListener() {}, history: { replaceState() {} } },
      document: { getElementById: () => null, createElement: el, head: el(), body: el(), documentElement: el(), querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
      localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
      navigator: { platform: 'MacIntel', userAgent: '' },
      URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, console,
    }
    sandbox.window.document = sandbox.document
    vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file })
    assert.equal(loaded.length, 1, `${file} registers one module`)
    const react = { createElement: () => null, useState: (v) => [typeof v === 'function' ? v() : v, () => {}], useEffect() {}, useLayoutEffect() {}, useRef: () => ({ current: null }), useCallback: (f) => f, useSyncExternalStore: () => 0, Fragment: 'f' }
    const requireStub = (id) => (id === 'react' ? react : id === 'react-dom/client' ? { createRoot: () => ({ render() {}, unmount() {} }) } : {})
    const exportsObj = loaded[0].factory(requireStub)
    assert.equal(typeof exportsObj.apply, 'function', `${file} exports apply`)
    assert.ok(Array.isArray(exportsObj.inject))
  }
})

test('manager: an older device host without the live feed falls back to polling', async () => {
  const { DeviceManager } = await import('../../packages/dsh-devices/lib/manager.js')
  const { DeviceRegistry } = await import('../../packages/dsh-devices/lib/registry.js')
  const { DeviceHttpError } = await import('../../packages/dsh-devices/lib/device-client.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdev-reg-'))
  const registry = new DeviceRegistry(dir)
  registry.upsert({ id: '11111111-1111-1111-1111-111111111111', name: 'old', clientId: 'cl_x', transport: { kind: 'url', url: 'http://127.0.0.1:9' } })
  const m = new DeviceManager({ registry })
  const s = m._ensureState('11111111-1111-1111-1111-111111111111')
  s.status = 'online'
  let watchCalls = 0
  let sessionCalls = 0
  s.client = {
    watch: async () => {
      watchCalls += 1
      throw new DeviceHttpError(404, 'not-found')
    },
    sessions: async () => {
      sessionCalls += 1
      return { items: [{ sessionId: 'a', title: 'A' }] }
    },
    workspaces: async () => ({ items: [] }),
  }
  m._startWatch('11111111-1111-1111-1111-111111111111', s)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(watchCalls, 1)
  assert.equal(s.watchToken, null, 'feed disabled after 404')
  m._refreshSessionsIfStale(0)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(sessionCalls, 1, 'plain session polling resumes')
  assert.equal(s.sessions[0].title, 'A')
  await m.dispose()
})

test('editors: Remote-SSH URIs for device paths', async () => {
  const { editorUri, EDITORS } = await import('../../packages/dsh-devices/lib/editors.js')
  const vscode = EDITORS.find((e) => e.id === 'vscode')
  const cursor = EDITORS.find((e) => e.id === 'cursor')
  assert.equal(editorUri(vscode, 'vps-julio', '/root/Projetos/cenora'), 'vscode://vscode-remote/ssh-remote+vps-julio/root/Projetos/cenora')
  assert.equal(editorUri(cursor, 'root@203.0.113.10', '/srv/app/a b.ts'), 'cursor://vscode-remote/ssh-remote+root@203.0.113.10/srv/app/a%20b.ts')
  assert.throws(() => editorUri(vscode, '', '/x'), /SSH host/)
  assert.throws(() => editorUri(vscode, 'h', 'relative/path'), /absolute/)
})

// ── sync plan, port forwards, attention ─────────────────────────────────────

test('sync plan: MCP rows, own presets, plugins, skills and instructions vs the device', async () => {
  const { buildBundle, classifySpec, collectLocal, collectRows, isDesktopOnly, planSync } = await import('../../packages/dsh-devices/lib/sync-plan.js')
  const { contentHash, skillHash, readSkill } = await import('../../packages/dsh-devices/lib/protocol.js')
  const entries = [
    { options: { id: 'mcp-github', name: '@deepseek-ai/dsh-mcp-client', config: { name: 'github', command: 'npx', env: { GITHUB_TOKEN: 'x' } } } },
    { options: { id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard', plugins: [] } } },
    { options: { id: 'preset-mine', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'mine', plugins: [] } } },
    { options: { id: 'mcp-off', name: '@deepseek-ai/dsh-mcp-client', disabled: true, config: { name: 'off' } } },
    { options: { id: 'web-runtime', name: '@deepseek-ai/dsh-web-runtime', config: {} } },
  ]
  const rows = collectRows(entries, '- id: preset-mine\n  name: "@deepseek-ai/dsh-agent-preset"\n')
  assert.deepEqual(rows.map((r) => [r.id, r.kind]), [['mcp-github', 'mcp'], ['preset-mine', 'preset']], 'every enabled MCP server, only presets this profile defines')
  assert.equal(isDesktopOnly('dsh-tauri-tray'), true)
  assert.equal(isDesktopOnly('@acme/dsh-pet'), true)
  assert.equal(isDesktopOnly('dsh-devices'), true)
  assert.equal(isDesktopOnly('dsh-plugin-jira'), false)

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdev-sync-'))
  const prev = [process.env.DSH_HOME, process.env.DSH_AGENTS_HOME]
  process.env.DSH_HOME = path.join(home, 'dsh')
  process.env.DSH_AGENTS_HOME = path.join(home, 'agents')
  try {
    fs.mkdirSync(path.join(home, 'dsh', 'skills', 'deploy'), { recursive: true })
    fs.writeFileSync(path.join(home, 'dsh', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\n')
    fs.mkdirSync(path.join(home, 'agents', 'skills'), { recursive: true })
    fs.writeFileSync(path.join(home, 'agents', 'skills', 'notes.md'), '---\nname: notes\n---\n')
    fs.writeFileSync(path.join(home, 'dsh', 'AGENTS.md'), 'Always answer in Portuguese.\n')
    const tgz = path.join(home, 'jira-1.2.0.tgz')
    fs.writeFileSync(tgz, 'not really a tarball')
    fs.mkdirSync(path.join(home, 'src-plugin'))
    assert.deepEqual(classifySpec(`file:${tgz}`), { kind: 'tarball', file: tgz, size: 20 })
    assert.equal(classifySpec(path.join(home, 'src-plugin')).kind, 'folder')
    assert.equal(classifySpec('github:acme/dsh-x#v1').kind, 'remote')
    assert.equal(classifySpec('link:../x').kind, 'link')
    const pluginManager = {
      listBundles: async () => [
        { name: 'dsh-plugin-jira', installed: true, availability: 'profile', official: false, version: '1.2.0', source: `file:${tgz}` },
        { name: 'dsh-plugin-npm', installed: true, availability: 'profile', official: false, version: '2.0.0', source: 'dsh-plugin-npm@2.0.0' },
        { name: 'dsh-plugin-dev', installed: true, availability: 'profile', official: false, version: '0.0.1', source: path.join(home, 'src-plugin') },
        { name: 'dsh-tauri-pet', installed: true, availability: 'profile', official: false, version: '1.0.0', source: 'dsh-tauri-pet@1' },
        { name: '@deepseek-ai/dsh-web-app', installed: true, availability: 'installation', official: true },
      ],
    }
    const profileDir = path.join(home, 'dsh', 'profiles', 'desktop')
    fs.mkdirSync(profileDir, { recursive: true })
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- insert:\n    - id: preset-mine\n      name: "@deepseek-ai/dsh-agent-preset"\n')
    const local = await collectLocal({ loaderEntries: entries, profileDir, pluginManager })
    const mcpHash = local.rows.find((r) => r.id === 'mcp-github').hash
    const device = {
      instructions: [{ target: 'dsh', exists: true, hash: contentHash('old\n') }, { target: 'agents', exists: false }],
      skills: [{ root: 'dsh', name: 'deploy', hash: skillHash(readSkill(path.join(home, 'dsh', 'skills'), 'deploy').files) }],
      rows: [{ id: 'mcp-github', hash: mcpHash }],
      rowIds: ['mcp-github', 'preset-mine'],
      plugins: [{ name: 'dsh-plugin-npm', version: '1.0.0' }],
      pluginManager: true,
    }
    const plan = planSync(local, device)
    const status = Object.fromEntries(plan.map((i) => [i.key, [i.status, i.reason ?? null, i.selected]]))
    assert.deepEqual(status['instructions:dsh'], ['changed', null, true])
    assert.deepEqual(status['skill:dsh:deploy'], ['same', null, false])
    assert.deepEqual(status['skill:agents:notes.md'], ['new', null, true])
    assert.deepEqual(status['row:mcp-github'], ['same', null, false])
    assert.deepEqual(status['row:preset-mine'], ['conflict', 'already-on-device', false])
    assert.deepEqual(status['plugin:dsh-plugin-jira'], ['new', null, true])
    assert.deepEqual(status['plugin:dsh-plugin-npm'], ['changed', null, true])
    assert.deepEqual(status['plugin:dsh-plugin-dev'], ['unsupported', 'local-folder', false])
    assert.deepEqual(status['plugin:dsh-tauri-pet'], ['unsupported', 'desktop-only', false])
    assert.deepEqual(plan.find((i) => i.key === 'row:mcp-github').warn, ['secrets'])
    const bundle = buildBundle(local, ['instructions:dsh', 'skill:agents:notes.md', 'row:mcp-github', 'plugin:dsh-plugin-jira', 'plugin:dsh-plugin-npm', 'plugin:dsh-tauri-pet'])
    assert.equal(bundle.instructions[0].content, 'Always answer in Portuguese.\n')
    assert.deepEqual(bundle.skills.map((s) => [s.root, s.name, s.flat]), [['agents', 'notes.md', true]])
    assert.equal(bundle.rows[0].config.command, 'npx')
    assert.deepEqual(bundle.plugins.map((p) => [p.name, !!p.tarball, p.spec ?? null]), [['dsh-plugin-jira', true, null], ['dsh-plugin-npm', false, 'dsh-plugin-npm@2.0.0']], 'desktop-only plugins are never sent')
  } finally {
    ;[process.env.DSH_HOME, process.env.DSH_AGENTS_HOME] = prev
    if (prev[0] === undefined) delete process.env.DSH_HOME
    if (prev[1] === undefined) delete process.env.DSH_AGENTS_HOME
  }
})

test('port forwards: same port when free, another when taken, auto follow and close', async () => {
  const net = await import('node:net')
  const { PortForwards } = await import('../../packages/dsh-devices/lib/ports.js')
  // a "device" dev server, reached through a fake tunnel
  const devServer = net.createServer((s) => s.end('hello from the device'))
  await new Promise((r) => devServer.listen(0, '127.0.0.1', r))
  const freePort = await new Promise((r) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => r(p))
    })
  })
  let changes = 0
  const fwd = new PortForwards({ connect: async () => net.connect(devServer.address().port, '127.0.0.1'), onChange: () => changes++, logger: { warn() {} } })
  const local = await fwd.forward('dev1', freePort)
  assert.equal(local, freePort, 'same number as on the device when free')
  const read = (port) =>
    new Promise((resolve, reject) => {
      const c = net.connect(port, '127.0.0.1')
      let data = ''
      c.on('data', (d) => (data += d))
      c.on('end', () => resolve(data))
      c.on('error', reject)
    })
  assert.equal(await read(local), 'hello from the device')
  // the device port number is taken here (by the dev server itself): another local port
  const other = await fwd.forward('dev1', devServer.address().port)
  assert.notEqual(other, devServer.address().port)
  assert.equal(await read(other), 'hello from the device')
  assert.deepEqual(fwd.map('dev1'), { [freePort]: freePort, [devServer.address().port]: other })
  // concurrent forwards of one port share a single listener
  const [c1, c2] = await Promise.all([fwd.forward('dev2', freePort), fwd.forward('dev2', freePort)])
  assert.equal(c1, c2)
  assert.equal(fwd.list('dev2').length, 1)
  fwd.closeDevice('dev2')
  // a local server on [::1] only also makes the port "taken" (localhost may resolve to ::1)
  const v6 = net.createServer()
  const v6ok = await new Promise((r) => {
    v6.once('error', () => r(false))
    v6.listen({ port: 0, host: '::1', ipv6Only: true }, () => r(true))
  })
  if (v6ok) {
    const taken = v6.address().port
    const got = await fwd.forward('dev3', taken)
    assert.notEqual(got, taken, 'a port held on ::1 here is not reused')
    fwd.closeDevice('dev3')
    v6.close()
  }
  // reconcile: manual forwards stay when the port vanishes; automatic ones follow the list
  const freePort2 = await new Promise((r) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => r(p))
    })
  })
  await fwd.reconcile('dev1', [{ port: freePort }], { auto: true })
  assert.ok(fwd.get('dev1', devServer.address().port), 'manual forwards stay')
  await fwd.reconcile('dev1', [{ port: freePort }, { port: freePort2 }], { auto: true })
  assert.equal(fwd.get('dev1', freePort2).auto, true, 'a new device port is forwarded automatically')
  await fwd.reconcile('dev1', [{ port: freePort }], { auto: true })
  assert.equal(fwd.get('dev1', freePort2), null, 'and closed when its server goes away')
  // closing dismisses it: auto-forwarding leaves it alone until it disappears and comes back
  fwd.close('dev1', freePort)
  await fwd.reconcile('dev1', [{ port: freePort }], { auto: true })
  assert.equal(fwd.get('dev1', freePort), null)
  await fwd.reconcile('dev1', [], { auto: true })
  await fwd.reconcile('dev1', [{ port: freePort }], { auto: true })
  assert.ok(fwd.get('dev1', freePort), 'forwarded again after it came back')
  await fwd.reconcile('dev1', [{ port: freePort2 }], { auto: false })
  assert.equal(fwd.get('dev1', freePort2), null, 'auto off: nothing new is forwarded')
  await fwd.reconcile('dev1', [{ port: freePort2, fromAgent: false }], { auto: true })
  assert.equal(fwd.get('dev1', freePort2), null, 'ports the agent did not open wait for a click')
  await fwd.reconcile('dev1', [{ port: freePort2, fromAgent: false, inWorkspace: true }], { auto: true })
  assert.ok(fwd.get('dev1', freePort2), 'a server running in a workspace is forwarded automatically')
  assert.ok(changes > 0)
  fwd.dispose()
  devServer.close()
})

test('manager: attention events and port lists from the live feed', async () => {
  const { DeviceManager } = await import('../../packages/dsh-devices/lib/manager.js')
  const { DeviceRegistry } = await import('../../packages/dsh-devices/lib/registry.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdev-reg-'))
  const registry = new DeviceRegistry(dir)
  const id = '22222222-2222-2222-2222-222222222222'
  registry.upsert({ id, name: 'vps', clientId: 'cl_y', transport: { kind: 'url', url: 'http://127.0.0.1:9' }, autoForwardPorts: false })
  const m = new DeviceManager({ registry })
  const s = m._ensureState(id)
  s.status = 'online'
  s.features = ['watch', 'pending', 'ports']
  const responses = [
    { boot: 'b1', rev: 2, turnSeq: 0, turnEnds: [], attSeq: 0, attention: [], items: [{ sessionId: 's1', title: 'Fix login' }], ports: [] },
    {
      boot: 'b1',
      rev: 3,
      turnSeq: 0,
      turnEnds: [],
      attSeq: 1,
      attention: [{ seq: 1, sessionId: 's1', kind: 'approval', toolName: 'bash', at: 5 }],
      items: [{ sessionId: 's1', title: 'Fix login', pending: { kind: 'approval', toolName: 'bash' } }],
      ports: [{ port: 5173, label: 'vite', pid: 9 }],
    },
  ]
  const seen = []
  s.client = {
    watch: async (q) => {
      seen.push(q)
      if (responses.length) return responses.shift()
      await new Promise((r) => setTimeout(r, 5000))
      return { boot: 'b1', rev: 3, turnSeq: 0, turnEnds: [], attSeq: 1, attention: [] }
    },
  }
  m._startWatch(id, s)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(seen[1].att, 0, 'the attention cursor is sent back')
  const note = m.notifications.find((n) => n.kind === 'attention')
  assert.deepEqual([note.sessionId, note.pendingKind, note.toolName, note.title], ['s1', 'approval', 'bash', 'Fix login'])
  const view = m.view(registry.get(id))
  assert.equal(view.pendingCount, 1)
  assert.deepEqual(view.ports.map((p) => [p.port, p.label, p.localPort]), [[5173, 'vite', null]], 'auto-forward off: listed, not forwarded')
  assert.equal(view.portsKnown, true)
  s.watchToken = null
  await m.dispose()
})
