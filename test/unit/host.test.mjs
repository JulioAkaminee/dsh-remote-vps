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
