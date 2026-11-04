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
