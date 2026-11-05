import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { test } from 'node:test'
import { DeviceGateway } from '../../packages/dsh-devices/lib/gateway.js'

async function fixture(t, options = {}) {
  const device = http.createServer()
  const sockets = new Set()
  device.on('connection', (s) => {
    sockets.add(s)
    s.on('error', () => {})
    s.on('close', () => sockets.delete(s))
  })
  device.listen(0, '127.0.0.1')
  await once(device, 'listening')
  const gateway = new DeviceGateway({ deviceId: 'test', baseUrl: () => `http://127.0.0.1:${device.address().port}`, token: async () => 'TOKEN', ...options })
  await gateway.start()
  t.after(async () => {
    await gateway.stop()
    for (const s of sockets) s.destroy()
    await new Promise((resolve) => device.close(resolve))
  })
  return { device, gateway }
}

function websocket(t, gateway) {
  const socket = net.connect(gateway.port, '127.0.0.1', () => {
    socket.write(`GET /${gateway.secret}/ws HTTP/1.1\r\nHost: 127.0.0.1:${gateway.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: desktop=secret\r\nX-Dsh-Device-Token: forged\r\n\r\n`)
  })
  socket.on('error', () => {})
  t.after(() => socket.destroy())
  return socket
}

function within(promise, message, ms = 1000) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })]).finally(() => clearTimeout(timer))
}

test('gateway destroys downstream when an upstream HTTP body is truncated', async (t) => {
  const { device, gateway } = await fixture(t)
  let upstreamSocket
  device.on('request', (_req, res) => {
    upstreamSocket = res.socket
    res.writeHead(200, { 'content-length': 100 })
    res.write('partial')
  })
  const req = http.get(gateway.root)
  t.after(() => req.destroy())
  const [res] = await once(req, 'response')
  res.on('error', () => {})
  const closed = new Promise((resolve) => res.once('close', resolve))
  await once(res, 'data')
  upstreamSocket.destroy()
  await within(closed, 'truncated response left downstream pending')
  assert.equal(res.complete, false)
  assert.equal(res.destroyed, true)
})

test('gateway bounds a silent WebSocket handshake and cancels upstream', async (t) => {
  const { device, gateway } = await fixture(t, { handshakeTimeoutMs: 40 })
  const incoming = once(device, 'upgrade')
  const client = websocket(t, gateway)
  let response = ''
  client.on('data', (chunk) => { response += chunk })
  const closed = once(client, 'close')
  const [, upstream] = await incoming
  upstream.resume()
  const upstreamClosed = once(upstream, 'end') // Upgraded server sockets may remain half-open after peer FIN.
  await within(closed, 'silent handshake left downstream pending')
  await within(upstreamClosed, 'timeout did not cancel upstream')
  assert.match(response, /^HTTP\/1\.1 504 /)
})

test('gateway cancels a pending handshake when downstream closes', async (t) => {
  const { device, gateway } = await fixture(t, { handshakeTimeoutMs: 10000 })
  const incoming = once(device, 'upgrade')
  const client = websocket(t, gateway)
  const [, upstream] = await incoming
  upstream.resume()
  const closed = once(upstream, 'end')
  client.destroy()
  await within(closed, 'downstream close did not cancel upstream')
})

test('gateway handshake deadline includes token acquisition', async (t) => {
  let resolveToken
  const { device, gateway } = await fixture(t, { handshakeTimeoutMs: 40, token: () => new Promise((resolve) => { resolveToken = resolve }) })
  let requests = 0
  device.on('upgrade', () => { requests++ })
  const client = websocket(t, gateway)
  client.resume()
  await within(once(client, 'close'), 'token acquisition was not bounded')
  resolveToken('TOKEN')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requests, 0)
})

test('gateway does not open upstream after downstream closes during token acquisition', async (t) => {
  let resolveToken
  let started
  const tokenStarted = new Promise((resolve) => { started = resolve })
  const { device, gateway } = await fixture(t, { token: () => new Promise((resolve) => { resolveToken = resolve; started() }) })
  let requests = 0
  device.on('upgrade', () => { requests++ })
  const connected = once(gateway.server, 'connection')
  const client = websocket(t, gateway)
  const [downstream] = await connected
  await tokenStarted
  const closed = once(downstream, 'close')
  client.destroy()
  await within(closed, 'pending token left downstream open')
  resolveToken('TOKEN')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requests, 0)
})

test('gateway does not apply the handshake deadline to HTTP streams', async (t) => {
  const { device, gateway } = await fixture(t, { handshakeTimeoutMs: 20 })
  let upstreamResponse
  device.on('request', (_req, res) => {
    upstreamResponse = res
    res.writeHead(200)
    res.write('first')
  })
  const req = http.get(gateway.root)
  t.after(() => req.destroy())
  const [res] = await once(req, 'response')
  let body = ''
  res.on('data', (chunk) => { body += chunk })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(res.destroyed, false)
  const ended = once(res, 'end')
  upstreamResponse.end('last')
  await within(ended, 'HTTP stream stopped')
  assert.equal(body, 'firstlast')
})

test('gateway retries WebSocket 401 once, isolates credentials, and leaves established streams untimed', async (t) => {
  const tokens = []
  const { device, gateway } = await fixture(t, { handshakeTimeoutMs: 40, token: async ({ force }) => force ? 'NEW' : 'OLD' })
  device.on('upgrade', (req, socket) => {
    tokens.push(req.headers['x-dsh-device-token'])
    assert.equal(req.headers.cookie, undefined)
    if (tokens.length === 1) return socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    socket.on('data', (data) => socket.write(data))
  })
  const client = websocket(t, gateway)
  const [response] = await once(client, 'data')
  assert.match(response.toString(), /^HTTP\/1\.1 101 /)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(client.destroyed, false)
  const echo = once(client, 'data')
  client.write('ping')
  assert.equal((await within(echo, 'established stream stopped'))[0].toString(), 'ping')
  assert.deepEqual(tokens, ['OLD', 'NEW'])
})

test('gateway does not retry a second WebSocket 401', async (t) => {
  const forces = []
  const { device, gateway } = await fixture(t, { token: async ({ force }) => { forces.push(force); return 'TOKEN' } })
  device.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'))
  const client = websocket(t, gateway)
  let response = ''
  client.on('data', (chunk) => { response += chunk })
  await within(once(client, 'close'), 'second 401 did not close')
  assert.match(response, /^HTTP\/1\.1 401 /)
  assert.deepEqual(forces, [false, true])
})
