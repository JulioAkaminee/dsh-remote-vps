// Unit tests for the device host: protocol helpers, durable store, auth, tunnel.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HostAuth } from '../../packages/dsh-device-host/lib/auth.js'
import { buildPairingLink, formatCode, normalizeCode, parsePairingInput, tokenSigningPayload } from '../../packages/dsh-device-host/lib/protocol.js'
import { generateCode, HostStore } from '../../packages/dsh-device-host/lib/store.js'
import { LocalTunnel } from '../../packages/dsh-device-host/lib/tunnel.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dshdev-unit-'))

function clientKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  return { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') }
}

function sign(privateKey, fields) {
  return crypto.sign(null, Buffer.from(tokenSigningPayload(fields)), privateKey).toString('base64url')
}

test('protocol: codes normalize, format and round-trip through pairing links', () => {
  assert.equal(normalizeCode(' k7qf-2m9x '), 'K7QF2M9X')
  assert.equal(normalizeCode('IO-LO'), '1010', 'Crockford look-alikes map to digits')
  assert.equal(formatCode('k7qf2m9x'), 'K7QF-2M9X')
  const link = buildPairingLink({ url: 'https://vps.example.ts.net', code: 'k7qf2m9x', deviceId: 'abc' })
  assert.deepEqual(parsePairingInput(link), { code: 'K7QF2M9X', url: 'https://vps.example.ts.net', deviceId: 'abc' })
  assert.deepEqual(parsePairingInput('K7QF-2M9X'), { code: 'K7QF2M9X' })
  for (let i = 0; i < 50; i++) assert.match(generateCode(), /^[0-9A-HJKMNP-TV-Z]{8}$/)
})

test('store: device identity is stable and files are private', () => {
  const dir = tmp()
  const a = new HostStore(dir).device()
  const b = new HostStore(dir).device()
  assert.equal(a.id, b.id)
  assert.equal(fs.statSync(path.join(dir, 'device.json')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
})

test('store: pairing codes are single use, expire, and are stored only as hashes', async () => {
  const store = new HostStore(tmp())
  const { code } = store.createCode({ label: 'mac' })
  assert.ok(!fs.readFileSync(store.codesFile, 'utf8').includes(code), 'plaintext code must not be persisted')
  assert.deepEqual(store.consumeCode('ZZZZ-ZZZZ'), { ok: false, reason: 'invalid' })
  assert.equal(store.consumeCode(formatCode(code).toLowerCase()).ok, true)
  assert.deepEqual(store.consumeCode(code), { ok: false, reason: 'used' })
  const short = store.createCode({ ttlMs: 10_000 })
  const doc = JSON.parse(fs.readFileSync(store.codesFile, 'utf8'))
  doc.codes.at(-1).expiresAt = new Date(Date.now() - 1000).toISOString()
  fs.writeFileSync(store.codesFile, JSON.stringify(doc))
  assert.deepEqual(store.consumeCode(short.code), { ok: false, reason: 'expired' })
})

test('auth: signed token requests, replay, staleness, device binding and revocation', () => {
  const store = new HostStore(tmp())
  const deviceId = store.device().id
  const key = clientKey()
  const client = store.addClient({ label: 'mac', platform: 'darwin', publicKey: key.publicKey })
  let now = Date.now()
  const auth = new HostAuth(store, { now: () => now })
  const fields = { deviceId, clientId: client.id, ts: now, nonce: crypto.randomBytes(18).toString('base64url') }
  const ok = auth.issueToken({ ...fields, sig: sign(key.privateKey, fields) }, deviceId)
  assert.equal(ok.ok, true)
  assert.equal(auth.authenticate(ok.token).id, client.id)
  assert.equal(auth.issueToken({ ...fields, sig: sign(key.privateKey, fields) }, deviceId).error, 'replayed-nonce')
  const other = { ...fields, deviceId: 'another-device', nonce: crypto.randomBytes(18).toString('base64url') }
  assert.equal(auth.issueToken({ ...other, sig: sign(key.privateKey, other) }, deviceId).error, 'bad-signature', 'signature bound to another device')
  const stale = { ...fields, ts: now - 10 * 60_000, nonce: crypto.randomBytes(18).toString('base64url') }
  assert.equal(auth.issueToken({ ...stale, sig: sign(key.privateKey, stale) }, deviceId).error, 'stale-signature')
  const forged = clientKey()
  const f2 = { ...fields, nonce: crypto.randomBytes(18).toString('base64url') }
  assert.equal(auth.issueToken({ ...f2, sig: sign(forged.privateKey, f2) }, deviceId).error, 'bad-signature')
  // Revocation through the store (as the CLI does) ends access on the next request.
  new HostStore(store.dir).revokeClient(client.id)
  assert.equal(auth.authenticate(ok.token), undefined)
  // Expiry.
  const store2 = new HostStore(tmp())
  const c2 = store2.addClient({ label: 'x', publicKey: key.publicKey })
  const auth2 = new HostAuth(store2, { now: () => now, tokenTtlMs: 1000 })
  const f3 = { deviceId: store2.device().id, clientId: c2.id, ts: now, nonce: crypto.randomBytes(18).toString('base64url') }
  const t3 = auth2.issueToken({ ...f3, sig: sign(key.privateKey, f3) }, f3.deviceId)
  now += 2000
  assert.equal(auth2.authenticate(t3.token), undefined)
})

test('auth: pairing locks after 10 failures in 10 minutes', () => {
  let now = Date.now()
  const auth = new HostAuth(new HostStore(tmp()), { now: () => now })
  for (let i = 0; i < 9; i++) auth.recordPairFailure()
  assert.equal(auth.pairingLocked(), false)
  auth.recordPairFailure()
  assert.equal(auth.pairingLocked(), true)
  now += 11 * 60_000
  assert.equal(auth.pairingLocked(), false)
})

test('tunnel: mints the DSH cookie once, rewrites host/origin, strips client credentials', async () => {
  const seen = []
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    if (req.url.startsWith('/?token=')) {
      res.writeHead(302, { location: './', 'set-cookie': 'dsh_s=SIGNED; Path=/; HttpOnly' })
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'leak=1' })
    res.end(`ok ${req.url}`)
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${upstream.address().port}`
  const tunnel = new LocalTunnel({ origin: () => origin, authenticatedUrl: (b) => `${b}?token=LAUNCH`, logger: { warn() {} } })
  const front = http.createServer((req, res) => tunnel.handleHttp(req, res, req.url))
  await new Promise((r) => front.listen(0, '127.0.0.1', r))
  const res = await new Promise((resolve) => {
    http.get(
      { host: '127.0.0.1', port: front.address().port, path: '/assets/x.js', headers: { cookie: 'mine=secret', 'x-dsh-device-token': 'tok', origin: 'http://127.0.0.1:9', host: 'gateway:1' } },
      (r) => {
        let body = ''
        r.on('data', (c) => (body += c))
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body }))
      },
    )
  })
  assert.equal(res.status, 200)
  assert.equal(res.body, 'ok /assets/x.js')
  assert.equal(res.headers['set-cookie'], undefined, 'upstream cookies never reach the client')
  const proxied = seen.find((s) => s.url === '/assets/x.js')
  assert.equal(proxied.headers.cookie, 'dsh_s=SIGNED')
  assert.equal(proxied.headers.host, new URL(origin).host)
  assert.equal(proxied.headers.origin, origin)
  assert.equal(proxied.headers['x-dsh-device-token'], undefined)
  assert.equal(seen.filter((s) => s.url.startsWith('/?token=')).length, 1)
  tunnel.dispose()
  front.close()
  upstream.close()
})

test('revision feed: coalesced bumps wake long-polls, turn ends are sequenced', async () => {
  const { RevisionFeed } = await import('../../packages/dsh-device-host/lib/revision.js')
  const feed = new RevisionFeed({ coalesceMs: 10 })
  assert.equal(await feed.wait(feed.rev + 5, 1000), true, 'stale revision answers immediately')
  const t0 = Date.now()
  assert.equal(await feed.wait(feed.rev, 50), false, 'times out when nothing changes')
  assert.ok(Date.now() - t0 >= 45)
  const rev = feed.rev
  const waiting = feed.wait(rev, 2000)
  feed.bump()
  feed.bump()
  feed.turnEnded('s1', 'completed')
  assert.equal(await waiting, true)
  assert.equal(feed.rev, rev + 1, 'bumps within the window coalesce into one revision')
  assert.deepEqual(feed.turnEndsSince(0).map((e) => [e.seq, e.sessionId, e.reason]), [[1, 's1', 'completed']])
  assert.deepEqual(feed.turnEndsSince(1), [])
  const abort = new AbortController()
  const aborted = feed.wait(feed.rev, 5000, abort.signal)
  abort.abort()
  assert.equal(await aborted, false)
  feed.dispose()
})

// ── "needs you", ports, sync ────────────────────────────────────────────────

test('pending: approvals and questions are folded from session events', async () => {
  const { PendingTracker } = await import('../../packages/dsh-device-host/lib/pending.js')
  let now = 1000
  const p = new PendingTracker({ now: () => now })
  assert.equal(p.get('s1'), null)
  let r = p.observe('s1', { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } })
  assert.equal(r.changed, true)
  assert.deepEqual(r.started, { kind: 'approval', toolName: 'bash' })
  assert.equal(p.get('s1').kind, 'approval')
  r = p.observe('s1', { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } })
  assert.equal(r.changed, true)
  assert.equal(p.get('s1'), null)
  // a question answered within the turn
  p.observe('s1', { type: 'tool/call', data: { name: 'ask_user_question', callId: 'c1' } })
  assert.equal(p.get('s1').kind, 'question')
  p.observe('s1', { type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: '{"answers":[]}' }] } } })
  assert.equal(p.get('s1'), null)
  // a question that outlives its turn ("continued") until the reply arrives
  p.observe('s2', { type: 'tool/call', data: { name: 'ask_user_question', callId: 'c2' } })
  p.observe('s2', { type: 'tool/result', data: { message: { toolCallId: 'c2', content: [{ type: 'text', text: '{"pending":true}' }] } } })
  p.observe('s2', { type: 'approval/asked', data: { id: 'a2', toolName: 'write' } })
  assert.equal(p.get('s2').kind, 'approval', 'approvals rank first')
  p.observe('s2', { type: 'turn/end', data: {} })
  assert.equal(p.get('s2').kind, 'question', 'turn end drops the approval, keeps the continued question')
  p.observe('s2', { type: 'user/message', data: { source: { kind: 'user-question-reply', callId: 'c2' } } })
  assert.equal(p.get('s2'), null)
  // unrelated events and tools change nothing
  assert.equal(p.observe('s3', { type: 'tool/call', data: { name: 'bash', callId: 'x' } }).changed, false)
  assert.deepEqual(p.sessions(), [])
  // stale continued questions expire
  p.observe('s4', { type: 'tool/call', data: { name: 'ask_user_question', callId: 'c4' } })
  p.observe('s4', { type: 'tool/result', data: { message: { toolCallId: 'c4', content: [{ type: 'text', text: '{"pending":true}' }] } } })
  now += 25 * 3600 * 1000
  assert.equal(p.get('s4'), null)
})

test('revision feed: attention events are sequenced and wake long-polls', async () => {
  const { RevisionFeed } = await import('../../packages/dsh-device-host/lib/revision.js')
  const feed = new RevisionFeed({ coalesceMs: 5 })
  const rev = feed.rev
  const waiting = feed.wait(rev, 1000)
  feed.needsAttention('s1', 'approval', 'bash')
  assert.equal(await waiting, true)
  assert.equal(feed.attSeq, 1)
  assert.deepEqual(feed.attentionSince(0).map((a) => [a.sessionId, a.kind, a.toolName]), [['s1', 'approval', 'bash']])
  assert.deepEqual(feed.attentionSince(1), [])
  feed.dispose()
})

test('ports: /proc/net/tcp parsing, labels, and the raw port tunnel', async () => {
  const { decodeProcAddress, describeCommand, handlePortTunnel, parseProcNetTcp } = await import('../../packages/dsh-device-host/lib/ports.js')
  assert.deepEqual(decodeProcAddress('0100007F:1435'), { address: '127.0.0.1', port: 5173 })
  assert.deepEqual(decodeProcAddress('00000000:0BB8'), { address: '0.0.0.0', port: 3000 })
  assert.deepEqual(decodeProcAddress('00000000000000000000000001000000:1435'), { address: '::1', port: 5173 })
  assert.deepEqual(decodeProcAddress('00000000000000000000000000000000:0050'), { address: '::', port: 80 })
  assert.deepEqual(decodeProcAddress('0000000000000000FFFF00000100007F:1F90'), { address: '::ffff:127.0.0.1', port: 8080 })
  const sample = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 100 0 0 10 0',
    '   1: 0100007F:1435 0100007F:C000 01 00000000:00000000 00:00000000 00000000  1000        0 4343 1 0000000000000000 20 4 30 10 -1',
  ].join('\n')
  assert.deepEqual(parseProcNetTcp(sample), [{ address: '127.0.0.1', port: 5173, uid: 1000, inode: '4242' }], 'only LISTEN sockets')
  assert.equal(describeCommand(['node', '/app/node_modules/.bin/vite']), 'vite')
  assert.equal(describeCommand(['node', '/app/node_modules/next/dist/bin/next', 'dev']), 'next dev')
  assert.equal(describeCommand(['python3', '-m', 'http.server', '8000']), 'http.server')
  assert.equal(describeCommand(['/usr/sbin/nginx']), 'nginx')
  const { descendsFrom, isPreviewCandidate } = await import('../../packages/dsh-device-host/lib/ports.js')
  const parents = { 50: 40, 40: 30, 30: 1, 60: 1 }
  assert.equal(descendsFrom(50, 30, (p) => parents[p] ?? 0), true, 'grandchild of the DSH process')
  assert.equal(descendsFrom(60, 30, (p) => parents[p] ?? 0), false)
  const eph = [32768, 60999]
  assert.equal(isPreviewCandidate({ port: 5173, command: 'node' }, { ephemeral: eph }), true)
  assert.equal(isPreviewCandidate({ port: 22, command: 'sshd' }, { ephemeral: eph }), false, 'system ports are not previews')
  assert.equal(isPreviewCandidate({ port: 8080, command: 'docker-proxy' }, { ephemeral: eph }), false, 'infrastructure is not a preview')
  assert.equal(isPreviewCandidate({ port: 41234, command: 'node' }, { ephemeral: eph }), false, 'random ephemeral listeners are skipped')
  assert.equal(isPreviewCandidate({ port: 41234, command: 'node', fromAgent: true }, { ephemeral: eph }), false, 'even when a DSH child opened them (MCP servers, tooling)')
  assert.equal(isPreviewCandidate({ port: 3001, command: 'node', label: 'mcp-server-github', fromAgent: true }, { ephemeral: eph }), false, 'MCP servers are not previews')
  assert.equal(isPreviewCandidate({ port: 5173, command: 'node', label: 'vite', fromAgent: true }, { ephemeral: eph }), true)
  assert.equal(isPreviewCandidate({ port: 80, command: 'python3', inWorkspace: true }, { ephemeral: eph }), true, 'a low port served from a workspace is a preview')

  // tunnel: device host side splices an upgraded request onto a local TCP port
  const net = await import('node:net')
  const echo = net.createServer((s) => s.pipe(s))
  await new Promise((r) => echo.listen(0, '127.0.0.1', r))
  const host = http.createServer()
  host.on('upgrade', (req, socket, head) => handlePortTunnel(req, socket, head, Number(new URL(req.url, 'http://x').searchParams.get('port'))))
  await new Promise((r) => host.listen(0, '127.0.0.1', r))
  const upgrade = (port, protocol = 'dsh-port-tunnel') =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: host.address().port, path: `/?port=${port}`, headers: { connection: 'Upgrade', upgrade: protocol } })
      req.on('upgrade', (res, socket) => resolve({ status: res.statusCode, socket }))
      req.on('response', (res) => resolve({ status: res.statusCode }))
      req.on('error', reject)
      req.end()
    })
  const ok = await upgrade(echo.address().port)
  assert.equal(ok.status, 101)
  const reply = await new Promise((resolve) => {
    ok.socket.once('data', (d) => resolve(String(d)))
    ok.socket.write('ping over the tunnel')
  })
  assert.equal(reply, 'ping over the tunnel')
  ok.socket.destroy()
  const closed = await new Promise((r) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port
      s.close(() => r(port))
    })
  })
  assert.equal((await upgrade(closed)).status, 502, 'nothing listening → 502')
  {
    // a client that resets mid-handshake must not crash the host (no unhandled 'error')
    const sock = net.connect(host.address().port, '127.0.0.1')
    sock.on('error', () => {})
    sock.write(`GET /?port=${closed} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: dsh-port-tunnel\r\n\r\n`)
    sock.resetAndDestroy()
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.equal((await upgrade(echo.address().port, 'websocket')).status, 400, 'other upgrade protocols are refused')
  host.close()
  echo.close()
})

test('sync: managed patch block, instructions, skills and rows applied on the device', async () => {
  const { DeviceSync, readBlockRows, writeBlock, BLOCK_BEGIN } = await import('../../packages/dsh-device-host/lib/sync.js')
  const { readSkill, skillHash, contentHash } = await import('../../packages/dsh-device-host/lib/protocol.js')
  // block rewrite keeps the user's own rows
  const base = '- id: web-runtime\n  config:\n    openBrowser: false\n'
  const one = writeBlock(base, [{ id: 'mcp-a', name: '@deepseek-ai/dsh-mcp-client', config: { name: 'a' } }])
  assert.ok(one.startsWith(base))
  assert.equal(readBlockRows(one).length, 1)
  const two = writeBlock(one, [{ id: 'mcp-a', name: '@deepseek-ai/dsh-mcp-client', config: { name: 'a' } }, { id: 'mcp-b', name: '@deepseek-ai/dsh-mcp-client' }])
  assert.equal(two.split(BLOCK_BEGIN).length, 2, 'one block only')
  assert.deepEqual(readBlockRows(two).map((r) => r.id), ['mcp-a', 'mcp-b'])
  assert.equal(writeBlock(two, []).trim(), base.trim(), 'an empty set removes the block')
  const fresh = writeBlock('# your patch layer for this profile\n[]\n', [{ id: 'mcp-a', name: 'x' }])
  assert.ok(!/^\[\]$/m.test(fresh), 'an empty flow list is replaced, not followed by block rows')
  assert.ok(/^\[\]$/m.test(writeBlock(fresh, [])), 'removing every row leaves a valid empty list')

  const home = tmp()
  const prevDsh = process.env.DSH_HOME
  const prevAgents = process.env.DSH_AGENTS_HOME
  process.env.DSH_HOME = path.join(home, 'dsh')
  process.env.DSH_AGENTS_HOME = path.join(home, 'agents')
  try {
    const profile = path.join(home, 'dsh', 'profiles', 'device-host')
    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), base)
    fs.mkdirSync(path.join(home, 'dsh'), { recursive: true })
    fs.writeFileSync(path.join(home, 'dsh', 'AGENTS.md'), 'device notes\n')
    const sync = new DeviceSync({ profileDir: () => profile, loaderRowIds: () => ['web-runtime', 'taken'], pluginManager: () => null, stateDir: path.join(home, 'state'), logger: console })
    const skillFiles = [
      { path: 'SKILL.md', data: Buffer.from('---\nname: deploy\n---\nShip it.\n') },
      { path: 'scripts/run.sh', data: Buffer.from('echo hi\n') },
    ]
    const report = await sync.apply({
      instructions: [{ target: 'dsh', content: 'from the desktop\n' }, { target: 'agents', content: 'shared\n' }],
      skills: [{ root: 'agents', name: 'deploy', files: skillFiles.map((f) => ({ path: f.path, data: f.data.toString('base64') })) }, { root: 'dsh', name: '../evil', files: [{ path: 'x', data: '' }] }],
      rows: [{ id: 'mcp-github', name: '@deepseek-ai/dsh-mcp-client', config: { name: 'github', command: 'npx' } }, { id: 'taken', name: '@deepseek-ai/dsh-mcp-client' }],
      plugins: [{ name: 'some-plugin', spec: 'some-plugin@1.0.0' }],
    }, { from: 'test' })
    const byKey = Object.fromEntries(report.map((r) => [`${r.kind}:${r.name}`, r]))
    assert.equal(byKey['instructions:dsh'].ok, true)
    assert.equal(byKey['instructions:agents'].ok, true)
    assert.equal(byKey['skill:deploy'].ok, true)
    assert.equal(byKey['skill:../evil'].ok, false, 'unsafe names are refused')
    assert.equal(byKey['row:mcp-github'].ok, true)
    assert.equal(byKey['row:taken'].ok, false, 'rows the device already has are not duplicated')
    assert.equal(byKey['plugin:some-plugin'].ok, false, 'no plugin manager → reported, not thrown')
    assert.equal(fs.readFileSync(path.join(home, 'dsh', 'AGENTS.md'), 'utf8'), 'from the desktop\n')
    assert.equal(fs.readFileSync(path.join(home, 'dsh', 'AGENTS.md.before-sync'), 'utf8'), 'device notes\n', 'the device’s own file is kept once')
    const written = readSkill(path.join(home, 'agents', 'skills'), 'deploy')
    assert.equal(skillHash(written.files), skillHash(skillFiles), 'same hash on both sides (marker excluded)')
    const patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
    assert.ok(patch.startsWith(base) && patch.includes('"mcp-github"'))
    const state = await sync.state()
    assert.equal(state.instructions.find((i) => i.target === 'dsh').hash, contentHash('from the desktop\n'))
    assert.deepEqual(state.skills.map((s) => [s.root, s.name, s.synced]), [['agents', 'deploy', true]])
    assert.deepEqual(state.rows.map((r) => r.id), ['mcp-github'])
    // a skill made on the device is set aside, not overwritten, and never left in the skills root
    fs.mkdirSync(path.join(home, 'dsh', 'skills', 'local'), { recursive: true })
    fs.writeFileSync(path.join(home, 'dsh', 'skills', 'local', 'SKILL.md'), 'mine')
    await sync.apply({ skills: [{ root: 'dsh', name: 'local', files: [{ path: 'SKILL.md', data: Buffer.from('theirs').toString('base64') }] }] })
    assert.deepEqual(fs.readdirSync(path.join(home, 'dsh', 'skills')), ['local'])
    assert.equal(fs.readFileSync(path.join(home, 'dsh', 'skills', 'local', 'SKILL.md'), 'utf8'), 'theirs')
    assert.equal(fs.readdirSync(path.join(home, 'dsh', '.dsh-devices-sync', 'backup')).length, 1)
  } finally {
    if (prevDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDsh
    if (prevAgents === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = prevAgents
  }
})

// ── health and self-update ──────────────────────────────────────────────────

test('health: /proc parsing, CPU from deltas, memory available, disk from statfs', async () => {
  const { HealthSampler, parseMeminfo, parseProcStat } = await import('../../packages/dsh-device-host/lib/health.js')
  assert.deepEqual(parseProcStat('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4'), { idle: 850, total: 1000 })
  assert.equal(parseProcStat('nothing'), null)
  const mem = parseMeminfo('MemTotal:       8000000 kB\nMemFree:         500000 kB\nMemAvailable:   2000000 kB\nSwapTotal:      1000000 kB\nSwapFree:        250000 kB\n')
  assert.deepEqual(mem, { total: 8000000 * 1024, available: 2000000 * 1024, swapTotal: 1000000 * 1024, swapFree: 250000 * 1024 })
  let now = 1_000_000
  let stat = 'cpu  100 0 50 800 50 0 0 0'
  const files = { '/proc/stat': () => stat, '/proc/meminfo': () => 'MemTotal: 1000 kB\nMemAvailable: 250 kB\n' }
  const sampler = new HealthSampler({ home: '/x', now: () => now, read: (f) => files[f](), statfs: () => ({ bsize: 4096, blocks: 1000, bavail: 100 }) })
  const first = sampler.sample()
  assert.equal(first.memory.percent, 75)
  assert.equal(first.disk.total, 4096 * 1000)
  assert.equal(first.disk.percent, 90)
  now += 15_000
  stat = 'cpu  400 0 150 1000 50 0 0 0' // +400 busy, +200 idle → 66.7 %
  assert.equal(sampler.sample().cpu.percent, 66.7)
})

test('self-update: validation, the runner keeps a good install and rolls a broken one back', async () => {
  const { spawnSync } = await import('node:child_process')
  const zlib = await import('node:zlib')
  const { Updater, runtimeRoot } = await import('../../packages/dsh-device-host/lib/updater.js')
  assert.equal(runtimeRoot('/home/u/.dsh-device/runtime/node_modules/dsh-device-host', {}), '/home/u/.dsh-device')
  assert.equal(runtimeRoot('/home/u/src/packages/dsh-device-host', {}), null)
  assert.equal(runtimeRoot('/anything', { DSH_DEVICE_ROOT: '/r' }), '/r')

  const root = tmp()
  fs.mkdirSync(path.join(root, 'runtime', 'node_modules', 'dsh-device-host'), { recursive: true })
  fs.writeFileSync(path.join(root, 'runtime', 'version.txt'), 'old\n')
  fs.writeFileSync(path.join(root, 'runtime', 'package.json'), '{"v":"old"}\n')
  fs.writeFileSync(path.join(root, 'runtime', 'node_modules', 'dsh-device-host', 'index.js'), 'old host\n')
  let lastArgs = null
  // The runner "lives" (this test process) until we run it by hand below.
  const updater = new Updater({ root, version: '0.1.9', port: () => 3999, logger: { warn() {} }, spawnRunner: (args) => ((lastArgs = args), { pid: process.pid }) })
  assert.equal(updater.supported(), true)
  const tarball = zlib.gzipSync(crypto.randomBytes(2048)).toString('base64')
  // Behaves like npm: changed files are extracted beside and renamed in, manifests are
  // rewritten in place, and the host package itself is rewritten.
  const installer = (ok) =>
    Buffer.from(
      `#!/bin/sh\n# fake installer\necho installing "$@"\nR="$(dirname "$0")/../../runtime"\nprintf 'new\\n' > "$R/version.txt.tmp" && mv "$R/version.txt.tmp" "$R/version.txt"\nprintf '{"v":"new"}\\n' > "$R/package.json"\nprintf 'new host\\n' > "$R/node_modules/dsh-device-host/index.js"\nV=$(basename "$2" .tgz | sed 's/^dsh-device-host-//')\necho "DSH_DEVICE_INSTALL_RESULT {\\"ok\\":${ok},\\"versions\\":{\\"plugin\\":\\"$V\\"}}"\n${'#'.repeat(100)}\n`,
    ).toString('base64')
  assert.throws(() => updater.start({ installer: installer(true), tarball, tarballName: 'evil.tgz' }), /invalid-tarball-name/)
  assert.throws(() => updater.start({ installer: installer(true), tarball: Buffer.from('x'.repeat(200)).toString('base64'), tarballName: 'dsh-device-host-0.2.0.tgz' }), /invalid-tarball/)
  assert.throws(() => updater.start({ installer: Buffer.from('rm -rf /'.repeat(20)).toString('base64'), tarball, tarballName: 'dsh-device-host-0.2.0.tgz' }), /invalid-installer/)

  // success: the new install stays, the backup goes
  const ok = updater.start({ installer: installer(true), tarball, tarballName: 'dsh-device-host-0.2.0.tgz', dshVersion: '0.2.1' })
  assert.deepEqual([ok.from, ok.to], ['0.1.9', '0.2.0'])
  assert.equal(updater.status().state, 'running')
  assert.throws(() => updater.start({ installer: installer(true), tarball, tarballName: 'dsh-device-host-0.2.0.tgz' }), /update-in-progress/)
  assert.equal(spawnSync('sh', lastArgs, { encoding: 'utf8' }).status, 0)
  assert.equal(updater.status().state, 'done')
  assert.equal(fs.readFileSync(path.join(root, 'runtime', 'version.txt'), 'utf8'), 'new\n')
  assert.equal(fs.existsSync(path.join(root, 'runtime.prev')), false)

  // failure: the previous install comes back
  fs.writeFileSync(path.join(root, 'runtime', 'version.txt'), 'good\n')
  fs.writeFileSync(path.join(root, 'runtime', 'package.json'), '{"v":"good"}\n')
  fs.writeFileSync(path.join(root, 'runtime', 'node_modules', 'dsh-device-host', 'index.js'), 'good host\n')
  updater.start({ installer: installer(false), tarball, tarballName: 'dsh-device-host-0.2.1.tgz', dshVersion: '0.2.1' })
  assert.equal(spawnSync('sh', lastArgs, { encoding: 'utf8' }).status, 1)
  const failed = updater.status({ withLog: true })
  assert.equal(failed.state, 'failed')
  assert.match(failed.error, /restored/)
  assert.equal(fs.readFileSync(path.join(root, 'runtime', 'version.txt'), 'utf8'), 'good\n', 'rolled back')
  assert.equal(fs.readFileSync(path.join(root, 'runtime', 'package.json'), 'utf8'), '{"v":"good"}\n', 'manifests rewritten in place come back too')
  assert.equal(fs.readFileSync(path.join(root, 'runtime', 'node_modules', 'dsh-device-host', 'index.js'), 'utf8'), 'good host\n', 'and the host package')
  assert.ok(failed.logTail.some((l) => /restoring 0\.1\.9/.test(l)))
  assert.equal(fs.existsSync(path.join(root, 'runtime.prev')), false)

  // a lock left by a runner that died is stale: a new update may start; a dead run without a verdict failed
  const twoMinutesAgo = new Date(Date.now() - 120_000).toISOString()
  fs.writeFileSync(path.join(root, 'update.lock'), JSON.stringify({ pid: 999999, startedAt: twoMinutesAgo }))
  fs.writeFileSync(path.join(root, 'update-status.json'), JSON.stringify({ state: 'running', from: '0.1.9', to: '0.2.5', startedAt: twoMinutesAgo }))
  assert.equal(updater.status().state, 'failed', 'the runner is gone and 0.2.5 is not running')
  const again = updater.start({ installer: installer(true), tarball, tarballName: 'dsh-device-host-0.2.6.tgz' })
  assert.equal(again.to, '0.2.6', 'a stale lock does not block')
  spawnSync('sh', lastArgs)
  assert.equal(fs.existsSync(path.join(root, 'update.lock')), false, 'the runner releases the lock when it ends')

  // a run that has just started is alive even before its runner wrote its pid (no double start)
  const { runnerAlive } = await import('../../packages/dsh-device-host/lib/updater.js')
  assert.equal(runnerAlive({ startedAt: new Date().toISOString() }, { root }), true)
  assert.equal(runnerAlive({ startedAt: twoMinutesAgo }, { root }), false)

  // a runner that died with the old service: the version now running tells how it ended
  const stale = new Updater({ root, version: '0.3.0', port: () => 3999, now: () => Date.now() + 60_000, spawnRunner() {} })
  fs.writeFileSync(path.join(root, 'update-status.json'), JSON.stringify({ state: 'running', from: '0.2.9', to: '0.3.0', startedAt: twoMinutesAgo }))
  assert.equal(stale.status().state, 'done')
})

test('folders: chats group by the workspace that IS their folder; folders list with project hints; workspaces are added, renamed, removed', async () => {
  const { owningWorkspace, parentWorkspacePath, listFolders, makeFolder, workspaceAction } = await import('../../packages/dsh-device-host/lib/folders.js')
  // DSH's rule, not "first workspace whose path is a prefix".
  const parent = { id: 'w-parent', path: '/root/Projetos', title: 'Projetos', sessionIds: ['s-root'] }
  const child = { id: 'w-child', path: '/root/Projetos/cenora', title: 'cenora', sessionIds: ['s-cenora'] }
  const workspaces = [parent, child]
  assert.equal(owningWorkspace({ sessionId: 's-cenora', cwd: '/root/Projetos/cenora' }, workspaces).id, 'w-child', 'membership wins')
  assert.equal(owningWorkspace({ sessionId: 's-new', cwd: '/root/Projetos/cenora' }, [{ ...parent, sessionIds: undefined }, { ...child, sessionIds: undefined }]).id, 'w-child', 'else the exact folder')
  assert.equal(owningWorkspace({ sessionId: 's-sub', cwd: '/root/Projetos/other' }, workspaces), null, 'a parent folder does not collect its subfolders (Ungrouped)')
  assert.equal(owningWorkspace({ sessionId: 's-x', cwd: null }, workspaces), null)
  assert.equal(parentWorkspacePath('/root/Projetos/cenora/api', ['/root', '/root/Projetos', '/root/Projetos/cenora']), '/root/Projetos/cenora')
  assert.equal(parentWorkspacePath('/srv/x', ['/root/Projetos']), null)

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdev-folders-'))
  fs.mkdirSync(path.join(home, 'Projetos', 'cenora', '.git'), { recursive: true })
  fs.mkdirSync(path.join(home, 'Projetos', 'site'), { recursive: true })
  fs.writeFileSync(path.join(home, 'Projetos', 'site', 'package.json'), '{}')
  fs.mkdirSync(path.join(home, 'Projetos', 'notas'))
  fs.mkdirSync(path.join(home, 'Projetos', '.cache'))
  fs.writeFileSync(path.join(home, 'Projetos', 'README.md'), 'x')
  const root = path.join(home, 'Projetos')
  const level = listFolders(root, { workspaces: [{ id: 'w1', path: path.join(root, 'cenora') }], home })
  assert.equal(level.path, root)
  assert.equal(level.parent, home)
  assert.deepEqual(level.folders.map((f) => f.name), ['cenora', 'notas', 'site'], 'folders only, sorted, hidden ones skipped')
  assert.deepEqual(level.folders.find((f) => f.name === 'cenora').project, ['.git'])
  assert.equal(level.folders.find((f) => f.name === 'cenora').workspaceId, 'w1')
  assert.deepEqual(level.folders.find((f) => f.name === 'site').project, ['package.json'])
  assert.deepEqual(level.folders.find((f) => f.name === 'notas').project, [])
  assert.ok(listFolders(root, { home, showHidden: true }).folders.some((f) => f.name === '.cache'))
  assert.equal(listFolders(undefined, { home }).path, home, 'no path: the home folder')
  assert.throws(() => listFolders(path.join(root, 'missing'), { home }), /folder-not-found/)

  assert.equal(makeFolder(root, 'novo'), path.join(root, 'novo'))
  assert.ok(fs.statSync(path.join(root, 'novo')).isDirectory())
  assert.throws(() => makeFolder(root, 'novo'), /folder-exists/)
  for (const bad of ['', '..', '.', 'a/b', 'x\\y', 'a\0b']) assert.throws(() => makeFolder(root, bad), /invalid-folder-name/, bad)
  assert.throws(() => makeFolder(path.join(root, 'nope'), 'x'), /folder-not-found/)

  // Through a registry shaped like DSH's.
  const made = []
  const registry = {
    items: [{ id: 'w1', path: path.join(root, 'cenora'), title: 'cenora', async setTitle(t) { this.title = t } }],
    list() { return this.items },
    async resolveByPath(p) { return this.items.find((w) => w.path === p) },
    async create(p) {
      const w = { id: `w${this.items.length + 1}`, path: p, title: path.basename(p), async setTitle(t) { this.title = t } }
      this.items.push(w)
      made.push(p)
      return w
    },
    async delete(id) {
      const n = this.items.length
      this.items = this.items.filter((w) => w.id !== id)
      return this.items.length < n
    },
  }
  const r = await workspaceAction(registry, { action: 'create', paths: [path.join(root, 'cenora'), path.join(root, 'site'), path.join(root, 'README.md')] })
  assert.deepEqual(r.results.map((x) => [path.basename(x.path), x.created ?? null, x.error ?? null]), [['cenora', false, null], ['site', true, null], ['README.md', null, 'not-a-folder']])
  assert.deepEqual(made, [path.join(root, 'site')])
  await assert.rejects(workspaceAction(registry, { action: 'create', path: 'relative/path' }), /invalid-path/)
  await assert.rejects(workspaceAction(registry, { action: 'rename', workspaceId: 'w2', title: 'cenora' }), /name-conflict/)
  assert.equal((await workspaceAction(registry, { action: 'rename', workspaceId: 'w2', title: 'Site da loja' })).workspace.title, 'Site da loja')
  assert.deepEqual(await workspaceAction(registry, { action: 'remove', workspaceId: 'w2' }), { removed: true })
  await assert.rejects(workspaceAction(registry, { action: 'remove', workspaceId: 'w2' }), /workspace-not-found/)
  await assert.rejects(workspaceAction(null, { action: 'create', path: root }), /workspaces-unavailable/)
  fs.rmSync(home, { recursive: true, force: true })
})

test('pnpm: a device gets one for DSH’s plugin manager — its own first, installed once when missing', async () => {
  const { execFileSync } = await import('node:child_process')
  const { PnpmGuard, pnpmPaths, pnpmWrapper, PNPM_VERSION } = await import('../../packages/dsh-device-host/lib/tools.js')
  const quiet = { info() {}, warn() {} }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdev-tools-'))
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdev-bare-')) // a PATH without pnpm
  // no device root (a linked dev host) and no pnpm: reported, nothing installed
  assert.equal((await new PnpmGuard({ root: null, env: { PATH: bare }, logger: quiet }).ensure()).status, 'missing')
  // a system pnpm is used when the device has none of its own
  fs.writeFileSync(path.join(bare, 'pnpm'), '#!/bin/sh\n', { mode: 0o755 })
  const sys = await new PnpmGuard({ root: null, env: { PATH: bare }, logger: quiet }).ensure()
  assert.equal(`${sys.status}/${sys.source}`, 'ok/system')
  fs.rmSync(path.join(bare, 'pnpm'))
  // missing on a device: installed once under its root, wrapped, first on PATH
  const calls = []
  const p = pnpmPaths(root)
  const fakeNpm = async (cmd, args) => {
    calls.push(args)
    fs.mkdirSync(path.dirname(p.cli), { recursive: true })
    fs.writeFileSync(p.cli, `console.log(${JSON.stringify(PNPM_VERSION)})\n`)
    return { code: 0, out: '' }
  }
  const env = { PATH: bare }
  const guard = new PnpmGuard({ root, env, logger: quiet, runner: fakeNpm, node: process.execPath })
  const [a, b] = await Promise.all([guard.ensure(), guard.ensure()])
  assert.equal(`${a.status}/${a.source}`, 'ok/device')
  assert.equal(a, b)
  assert.equal(calls.length, 1, 'installed once even when asked twice at once')
  assert.ok(calls[0].includes(`pnpm@${PNPM_VERSION}`) && calls[0].includes(p.tools))
  assert.equal(env.PATH.split(path.delimiter)[0], p.bin, 'DSH finds this pnpm first')
  assert.equal(fs.readFileSync(p.wrapper, 'utf8'), pnpmWrapper(process.execPath, p.cli))
  assert.equal(execFileSync(p.wrapper, ['--version'], { encoding: 'utf8' }).trim(), PNPM_VERSION, 'the wrapper runs it with this node')
  // next start: already there, nothing to install
  const env2 = { PATH: '/usr/bin' }
  const again = await new PnpmGuard({ root, env: env2, logger: quiet, runner: async () => assert.fail('no second install') }).ensure()
  assert.equal(`${again.status}/${again.source}`, 'ok/device')
  assert.ok(env2.PATH.startsWith(`${p.bin}${path.delimiter}`))
  // an install that fails says why
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdev-tools-'))
  const failed = await new PnpmGuard({ root: root2, env: { PATH: bare }, logger: quiet, runner: async () => ({ code: 1, out: 'npm ERR! code ENOTFOUND\nnpm ERR! network request failed' }) }).ensure()
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /network request failed/)
  for (const d of [root, root2, bare]) fs.rmSync(d, { recursive: true, force: true })
})
