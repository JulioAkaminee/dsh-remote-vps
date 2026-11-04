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
