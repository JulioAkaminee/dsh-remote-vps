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

test('gateway: a page load to an unreachable device tells the desktop at once; a refused WebSocket token is renewed once', async () => {
  const { DeviceGateway } = await import('../../packages/dsh-devices/lib/gateway.js')
  const id = '00000000-0000-0000-0000-000000000000'
  // Nothing listens on this port any more: the device is down.
  const gone = net.createServer()
  await new Promise((r) => gone.listen(0, '127.0.0.1', r))
  const downPort = gone.address().port
  await new Promise((r) => gone.close(r))
  const gw = new DeviceGateway({ deviceId: id, baseUrl: () => `http://127.0.0.1:${downPort}`, token: async () => 'T' })
  await gw.start()
  const host = `127.0.0.1:${gw.port}`
  const page = await request(gw.port, { path: `/${gw.secret}/?dsh-embed=1`, headers: { host, 'sec-fetch-dest': 'iframe', accept: 'text/html' } })
  assert.equal(page.status, 502)
  assert.match(page.headers['content-type'], /text\/html/)
  assert.match(page.body, /type:'unreachable'/, 'the page posts "unreachable" to the embedding desktop')
  assert.doesNotMatch(page.body, /<\/script>[^]*<script>/, 'one inline script only')
  const call = await request(gw.port, { path: `/${gw.secret}/api/session/list`, headers: { host, 'sec-fetch-dest': 'empty' } })
  assert.equal(call.status, 502)
  assert.match(call.headers['content-type'], /text\/plain/, 'API calls keep a plain 502')
  await gw.stop()

  // No transport at all (SSH down): same page, with the reason, safely quoted.
  const gw2 = new DeviceGateway({ deviceId: id, baseUrl: () => 'http://127.0.0.1:1', token: async () => { throw new Error('ssh: timed out </script><b>x') } })
  await gw2.start()
  const page2 = await request(gw2.port, { path: `/${gw2.secret}/`, headers: { host: `127.0.0.1:${gw2.port}`, 'sec-fetch-dest': 'iframe' } })
  assert.equal(page2.status, 502)
  assert.match(page2.body, /ssh: timed out \\u003c\/script>\\u003cb>x/, 'the reason is escaped inside the script')
  await gw2.stop()

  // A WebSocket refused with 401 (the device restarted) is retried once with a fresh token.
  const tokens = []
  const device = http.createServer()
  device.on('upgrade', (req, socket) => {
    tokens.push(req.headers['x-dsh-device-token'])
    if (req.headers['x-dsh-device-token'] === 'OLD') return socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (d) => socket.write(d))
  })
  await new Promise((r) => device.listen(0, '127.0.0.1', r))
  const gw3 = new DeviceGateway({ deviceId: id, baseUrl: () => `http://127.0.0.1:${device.address().port}`, token: async ({ force } = {}) => (force ? 'NEW' : 'OLD') })
  await gw3.start()
  const host3 = `127.0.0.1:${gw3.port}`
  const reply = await new Promise((resolve, reject) => {
    const s = net.connect(gw3.port, '127.0.0.1', () => {
      s.write(`GET /${gw3.secret}/api/remote.mux HTTP/1.1\r\nHost: ${host3}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    })
    let buf = ''
    s.on('data', (d) => {
      buf += d.toString()
      if (buf.includes('\r\n\r\n')) {
        s.destroy()
        resolve(buf)
      }
    })
    s.on('error', reject)
  })
  assert.match(reply, /^HTTP\/1\.1 101/)
  assert.deepEqual(tokens, ['OLD', 'NEW'])
  await gw3.stop()
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

test('panels: how each device host opens its own panels (answers, opens silently, or cannot)', async () => {
  const { panelSupport } = await import('../../packages/dsh-devices/lib/manager.js')
  assert.equal(panelSupport(['watch', 'panels'], '0.1.11'), 'ack')
  assert.equal(panelSupport(['watch', 'ports'], '0.1.10'), 'legacy')
  assert.equal(panelSupport([], '0.1.8'), 'legacy')
  assert.equal(panelSupport(['watch'], '0.1.7'), 'none')
  assert.equal(panelSupport(undefined, '0.1.3'), 'none')
  assert.equal(panelSupport(undefined, null), 'none')
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

test('browser UI smoke render: every surface renders without recursion or throwing, with or without DSH primitives', async () => {
  const vm = await import('node:vm')
  const file = 'packages/dsh-devices/lib/client.js'
  const makeEl = () => ({ style: {}, dataset: {}, setAttribute() {}, removeAttribute() {}, appendChild() {}, addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [], classList: { add() {}, remove() {}, contains: () => false }, getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }), closest: () => null, contains: () => false })
  const run = (withPrimitives) => {
    const loaded = []
    const ls = new Map()
    const sandbox = {
      window: { __ModuleLoader__: { load: (m) => loaded.push(m) }, location: { search: '', pathname: '/', hash: '' }, addEventListener() {}, removeEventListener() {}, history: { replaceState() {} }, innerWidth: 1200, innerHeight: 800 },
      document: { getElementById: () => null, createElement: makeEl, head: makeEl(), body: makeEl(), documentElement: makeEl(), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, styleSheets: [], visibilityState: 'visible', hasFocus: () => true },
      localStorage: { getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v) },
      navigator: { platform: 'MacIntel', userAgent: '', clipboard: { writeText: async () => {} } },
      requestAnimationFrame: (f) => setTimeout(f, 0),
      MutationObserver: class { observe() {} disconnect() {} },
      ResizeObserver: class { observe() {} disconnect() {} },
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      URLSearchParams, URL, setTimeout, clearTimeout, setInterval, clearInterval, console,
    }
    sandbox.window.document = sandbox.document
    vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file })
    const Fragment = Symbol('Fragment')
    const react = {
      Fragment,
      createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.length ? children : props && props.children } }),
      useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
      useEffect() {},
      useLayoutEffect() {},
      useRef: (v) => ({ current: v ?? null }),
      useCallback: (f) => f,
      useSyncExternalStore: (sub, get) => get(),
    }
    // Primitive stubs render what they are given (anchor, content, children), so their props are walked too.
    const pass = (props) => [props.anchor, props.content, props.footer, props.children, props.icon]
    const P = withPrimitives
      ? new Proxy({}, { get: (_, name) => (name === 'relativeTime' ? () => ({ unit: 'minutes', n: 5 }) : name === 'ICON_REGULAR_STROKE' ? 1.2 : name === 'writeClipboard' ? async () => {} : (props) => pass(props || {})) })
      : {}
    const requireStub = (id) => (id === 'react' ? react : id === 'react-dom/client' ? { createRoot: () => ({ render() {}, unmount() {} }) } : id === '@deepseek-ai/dsh-client-ui-primitives' ? P : {})
    const mod = loaded[0].factory(requireStub)
    let renders = 0
    const render = (node, depth = 0) => {
      if (depth > 60) throw new Error('render recursion: depth > 60')
      if (node == null || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach((n) => render(n, depth))
      if (typeof node.type === 'function') {
        renders += 1
        return render(node.type(node.props || {}), depth + 1)
      }
      const props = node.props || {}
      render(props.children, depth + 1)
      for (const key of ['anchor', 'content', 'footer', 'icon', 'tags', 'end', 'title', 'description', 'extra', 'label']) if (props[key] && typeof props[key] === 'object') render(props[key], depth + 1)
      if (Array.isArray(props.items)) for (const it of props.items) if (it && typeof it === 'object') render([it.icon, it.label], depth + 1)
    }
    const { store, setStore, components: c, dialogs: d } = mod.__test
    const device = {
      id: 'd1', name: 'VPS', status: 'online', transport: { kind: 'ssh', target: 'vps' }, features: ['watch', 'session-actions', 'search', 'account', 'sync', 'ports', 'pending'],
      sessions: [
        { sessionId: 's1', title: 'Fix login', workspaceId: 'w1', workspaceTitle: 'app', cwd: '/srv/app', updatedAt: Date.now(), pending: { kind: 'approval', toolName: 'write' } },
        { sessionId: 's2', title: 'Pinned', workspaceId: 'w1', workspaceTitle: 'app', updatedAt: Date.now(), pinned: true, pinRank: 0 },
        { sessionId: 's3', title: 'Running', workspaceId: 'w1', workspaceTitle: 'app', updatedAt: Date.now(), running: true },
      ],
      archived: [{ sessionId: 's9', title: 'Old', workspaceTitle: 'app', updatedAt: Date.now() }],
      workspaces: [{ id: 'w1', title: 'app', path: '/srv/app' }],
      ports: [{ port: 5173, label: 'vite', localPort: 5173, fromAgent: true }, { port: 8080, label: 'api', localPort: null }],
      portMap: { 5173: 5173 }, portsKnown: true, pendingCount: 1, outdated: true, canUpdate: true, versions: { dsh: '0.2.1', plugin: '0.1.9' },
      model: { configured: false, ready: false, account: { available: true, signedIn: false } }, autoForwardPorts: true,
    }
    setStore({ data: { devices: [device], saved: [{ id: 'm1', name: 'Saved', target: 'root@1.2.3.4', fingerprint: 'SHA256:x' }], notifications: [], version: 1 }, loaded: true, localKey: true, localAccount: true, nativeSearch: '', unread: { 'd1:s3': true }, picker: { rect: { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }, current: null } })
    const t = (k) => k
    const ctx = { layout: { selectPanel() {} } }
    const cls = { native: false }
    render(react.createElement(c.RemoteSidebar, { ctx, t }))
    for (const variant of [{ status: 'offline', lastSeenAt: new Date().toISOString(), error: 'connect ECONNREFUSED' }, { status: 'connecting' }, { status: 'revoked' }, { updating: { startedAt: Date.now() } }, { sessions: [] }, { status: 'offline', sessions: [] }]) {
      render(react.createElement(c.RemoteDevice, { ctx, t, cls: {}, device: { ...device, ...variant }, st: store, chatActive: true, perGroup: 2 }))
    }
    render(react.createElement(c.RemoteDevice, { ctx, t, cls: {}, device, st: { ...store, collapsed: { 'device:d1': true } }, chatActive: false, perGroup: 0 }))
    const items = mod.__test.deviceMenuItems({ ...device, status: 'offline' }, t, null)
    assert.ok(items.some((i) => i.id === 'reconnect'), 'an offline device offers Reconnect')
    assert.ok(items.some((i) => i.id === 'update'), 'an outdated device offers its update in the device menu')
    assert.ok(items.find((i) => i.id === 'plugins').disabled, 'panels need the device online')
    // The overlay over a device UI: opening, slow, failed, unsupported, unreachable.
    const frames = mod.__test.frames
    let shown = null
    frames.status = { style: {} }
    frames.statusRoot = { render: (el) => (shown = el) }
    const iframe = { style: {}, contentWindow: {}, src: 'x', remove() {}, addEventListener() {} }
    const text = (node) => (node == null || typeof node !== 'object' ? (node == null || node === false ? '' : String(node)) : Array.isArray(node) ? node.map(text).join(' ') : typeof node.type === 'function' ? text(node.type(node.props || {})) : text(node.props && node.props.children))
    const stateOf = () => shown && shown.props && shown.props['data-state']
    frames.byDevice.set('d1', { iframe, root: 'http://gw/', ready: true, loaded: true, pending: [] })
    frames.active = 'd1'
    setStore({ selection: { deviceId: 'd1', sessionId: null, panel: 'plugins' } })
    frames.panels.set('d1', { id: 'plugins', state: 'opening', mode: 'ack', startedAt: Date.now(), timers: [] })
    frames.renderStatus()
    assert.equal(stateOf(), 'opening')
    assert.match(text(shown), /panelOpening/)
    frames.panels.get('d1').startedAt = Date.now() - 20_000
    frames.renderStatus()
    assert.match(text(shown), /panelSlow/, 'a slow device says so')
    frames.panelAnswered('d1', 'plugins', false, 'layout.selectPanel: main panel "plugins" is not registered')
    assert.equal(stateOf(), 'failed')
    assert.match(text(shown), /panelFailed[\s\S]*not registered/)
    frames.panelAnswered('d1', 'plugins', true)
    assert.equal(shown, null, 'an open panel hides the overlay')
    frames.panels.set('d1', { id: 'plugins', state: 'unsupported', mode: 'none', startedAt: Date.now(), timers: [] })
    setStore({ data: { ...store.data, devices: [{ ...device, panels: 'none' }] } })
    frames.renderStatus()
    assert.equal(stateOf(), 'unsupported')
    assert.match(text(shown), /panelOldHost[\s\S]*panelOldHostHint/, 'an old host that can be updated from here says how')
    frames.panels.set('d1', { id: 'plugins', state: 'opening', mode: 'ack', startedAt: Date.now(), timers: [] })
    frames.markUnreachable('d1', 'connect ECONNREFUSED 127.0.0.1:3181')
    assert.equal(stateOf(), 'unreachable')
    assert.match(text(shown), /unreachable[\s\S]*ECONNREFUSED/)
    frames.onReady('d1', { announced: false })
    assert.equal(stateOf(), 'unreachable', 'the older-host load fallback never hides "could not reach"')
    assert.equal(frames.panels.get('d1').state, 'waiting', 'the panel waits for the device to come back')
    setStore({ selection: { deviceId: 'd1', sessionId: 's1' } })
    frames.markLoaded('d1')
    assert.equal(shown, null, 'a loaded chat shows no overlay')
    frames.byDevice.clear()
    frames.panels.clear()
    frames.active = null
    render(react.createElement(c.RemoteSessionRow, { ctx, t, cls: {}, device, s: device.sessions[0], selected: true, online: true }))
    render(react.createElement(c.RemoteSearchResults, { ctx, t, cls: {}, st: { ...store, nativeSearch: 'fix' }, query: 'fix' }))
    render(react.createElement(c.DevicesPage, { ctx, t }))
    render(react.createElement(c.DevicesSettings, { t }))
    render(react.createElement(c.ModelKeyPanel, { device, t, variant: 'banner' }))
    render(react.createElement(c.ModelKeyPanel, { device, t, variant: 'card' }))
    render(react.createElement(c.ModelKeyPanel, { device: { ...device, model: undefined }, t, variant: 'card' }))
    render(react.createElement(c.RemoteChatPanel, { t }))
    render(react.createElement(c.DevicePicker, { t }))
    render(react.createElement(c.AddDialog, { t, onClose() {}, onDone() {} }))
    for (const [name, D] of Object.entries(d)) render(react.createElement(D, { t, dialog: { kind: name, deviceId: 'd1', sessionId: 's1', title: 'x' }, onClose() {} }))
    setStore({ toast: { seq: 1, text: 'hello', actions: [{ label: 'Open', onClick() {} }] } })
    render(react.createElement(c.Overlays, { t }))
    void cls
    return renders
  }
  assert.ok(run(true) > 20, 'renders with DSH primitives')
  assert.ok(run(false) > 20, 'renders with the plain stand-ins')
})

test('manager: automatic updates wait for an idle device, ask once, never repeat a failure soon', async () => {
  const { DeviceManager, PLUGIN_VERSION } = await import('../../packages/dsh-devices/lib/manager.js')
  const { DeviceRegistry } = await import('../../packages/dsh-devices/lib/registry.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdev-reg-'))
  const registry = new DeviceRegistry(dir)
  const id = '33333333-3333-3333-3333-333333333333'
  registry.upsert({ id, name: 'vps', clientId: 'cl_z', transport: { kind: 'url', url: 'http://127.0.0.1:9' }, versions: { plugin: '0.0.1', dsh: null } })
  const m = new DeviceManager({ registry, logger: { info() {}, warn() {} } })
  const s = m._ensureState(id)
  s.status = 'online'
  s.features = ['self-update']
  const calls = []
  m.update = (deviceId, opts) => calls.push([deviceId, opts])
  assert.equal(m.prefs().autoUpdate, 'auto', 'automatic by default')
  s.sessions = [{ sessionId: 'a', running: true }]
  m._maybeAutoUpdate(registry.get(id), s)
  assert.equal(calls.length, 0, 'a running turn waits')
  s.sessions = [{ sessionId: 'a', pending: { kind: 'approval' } }]
  m._maybeAutoUpdate(registry.get(id), s)
  assert.equal(calls.length, 0, 'a chat waiting for you waits too')
  s.sessions = []
  m._maybeAutoUpdate(registry.get(id), s)
  assert.deepEqual(calls, [[id, { auto: true }]], 'idle → updates itself')
  s.updateFailedAt = Date.now()
  m._maybeAutoUpdate(registry.get(id), s)
  assert.equal(calls.length, 1, 'a recent failure is not retried')
  s.updateFailedAt = 0
  m.setPrefs({ autoUpdate: 'ask' })
  calls.length = 0
  m._maybeAutoUpdate(registry.get(id), s)
  m._maybeAutoUpdate(registry.get(id), s)
  assert.equal(calls.length, 0)
  assert.equal(m.notifications.filter((n) => n.kind === 'update-available').length, 1, 'asks once per version')
  m.setPrefs({ autoUpdate: 'never' })
  m._maybeAutoUpdate(registry.get(id), s)
  assert.equal(calls.length, 0)
  assert.equal(new DeviceRegistry(dir).prefs().autoUpdate, 'never', 'the choice is saved')
  assert.throws(() => m.setPrefs({ autoUpdate: 'sometimes' }), /auto, ask or never/)
  registry.update(id, { versions: { plugin: PLUGIN_VERSION, dsh: null } })
  m.setPrefs({ autoUpdate: 'auto' })
  m._maybeAutoUpdate(registry.get(id), s)
  assert.equal(calls.length, 0, 'an up-to-date device is left alone')
  await m.dispose()
})

test('device health: alert thresholds and the summary line', async () => {
  const vm = await import('node:vm')
  const loaded = []
  const el = () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], classList: { add() {}, remove() {} } })
  const sandbox = {
    window: { __ModuleLoader__: { load: (m) => loaded.push(m) }, location: { search: '', pathname: '/', hash: '' }, addEventListener() {}, history: { replaceState() {} } },
    document: { getElementById: () => null, createElement: el, head: el(), body: el(), documentElement: { ...el(), lang: 'en' }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { platform: 'MacIntel', userAgent: '' },
    URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, console, Intl,
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'packages/dsh-devices/lib/client.js'), 'utf8'), sandbox)
  const react = { createElement: () => null, useState: (v) => [v, () => {}], useEffect() {}, useLayoutEffect() {}, useRef: () => ({ current: null }), useCallback: (f) => f, useSyncExternalStore: () => 0, Fragment: 'f' }
  const mod = loaded[0].factory((id) => (id === 'react' ? react : id === 'react-dom/client' ? { createRoot: () => ({ render() {}, unmount() {} }) } : {}))
  const { healthIssues, healthSummary, formatBytes } = mod.__test
  const GB = 1e9
  const keys = (h) => Array.from(healthIssues(h), (i) => `${i.key}:${i.level}`)
  assert.deepEqual(keys({ cpu: { cores: 4, percent: 20 }, load: [0.5], memory: { total: 8 * GB, used: 2 * GB, percent: 25 }, disk: { total: 80 * GB, free: 40 * GB, percent: 50 } }), [])
  assert.deepEqual(keys({ disk: { total: 80 * GB, free: 6 * GB, percent: 92.5 } }), ['disk:warning'])
  assert.deepEqual(keys({ disk: { total: 500 * GB, free: 0.5 * GB, percent: 89 } }), ['disk:critical'], 'under 1 GB free is critical whatever the size')
  assert.deepEqual(keys({ memory: { total: 8 * GB, percent: 96 } }), ['memory:critical'])
  assert.deepEqual(keys({ cpu: { cores: 2, percent: 50 }, load: [4.5] }), ['cpu:warning'], 'a long run queue is overload')
  assert.deepEqual(keys({ cpu: { cores: 2, percent: 99.5 }, load: [1] }), ['cpu:critical'])
  assert.equal(formatBytes(3.14e9), '3.1 GB')
  assert.equal(formatBytes(512), '512 B')
  const t = (k) => ({ cpu: 'CPU', memory: 'Memory', disk: 'Disk', ofSize: '{used} of {total}' })[k] ?? k
  assert.equal(healthSummary({ cpu: { cores: 4, percent: 12.4 }, memory: { total: 8e9, used: 3.1e9 }, disk: { total: 80e9, used: 41e9 } }, t), 'CPU 12% · Memory 3.1 GB of 8.0 GB · Disk 41 GB of 80 GB')
})

test('versions: prereleases order before releases; devices newer than this desktop are never downgraded', async () => {
  const { compareSemver, DeviceManager, PLUGIN_VERSION } = await import('../../packages/dsh-devices/lib/manager.js')
  const { DeviceRegistry } = await import('../../packages/dsh-devices/lib/registry.js')
  assert.equal(compareSemver('0.2.1-rc.4', '0.2.1-rc.5'), -1)
  assert.equal(compareSemver('0.2.1-rc.10', '0.2.1-rc.9'), 1)
  assert.equal(compareSemver('0.2.1', '0.2.1-rc.5'), 1)
  assert.equal(compareSemver('0.2.0', '0.2.1-rc.1'), -1)
  assert.equal(compareSemver('0.1.10', '0.1.10'), 0)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdev-reg-'))
  const registry = new DeviceRegistry(dir)
  const id = '44444444-4444-4444-4444-444444444444'
  const [maj, min, pat] = PLUGIN_VERSION.split('.').map(Number)
  registry.upsert({ id, name: 'newer', clientId: 'cl_n', transport: { kind: 'url', url: 'http://127.0.0.1:9' }, versions: { plugin: `${maj}.${min}.${pat + 1}`, dsh: null } })
  const m = new DeviceManager({ registry, logger: { info() {}, warn() {} } })
  const s = m._ensureState(id)
  Object.assign(s, { status: 'online', features: ['self-update'], sessions: [] })
  const calls = []
  m.update = (deviceId) => calls.push(deviceId)
  m._maybeAutoUpdate(registry.get(id), s)
  assert.equal(calls.length, 0, 'a newer device host is not downgraded')
  await m.dispose()
})
