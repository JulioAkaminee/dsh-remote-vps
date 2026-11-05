import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DeviceManager } from '../../packages/dsh-devices/lib/manager.js'
import { DeviceGateway } from '../../packages/dsh-devices/lib/gateway.js'

function fixture() {
  const devices = new Map(['a', 'b'].map(id => [id, { id, name: id, gatewaySecret: 'x'.repeat(32) }]))
  const manager = new DeviceManager({ registry: {
    get: id => devices.get(id),
    update: (id, patch) => Object.assign(devices.get(id), patch),
  } })
  manager._transport = async () => 'http://127.0.0.1:9'
  manager._client = () => ({ token: async () => 'token' })
  return manager
}

test('manager: concurrent opens wait for one listening gateway without blocking another VPS', async () => {
  const manager = fixture()
  const start = DeviceGateway.prototype.start
  let release
  const gate = new Promise(resolve => { release = resolve })
  let entered
  const entering = new Promise(resolve => { entered = resolve })
  let starts = 0
  DeviceGateway.prototype.start = async function () {
    if (this.deviceId === 'a') { starts++; entered(); await gate }
    return start.call(this)
  }
  try {
    const first = manager.open('a', { next: '/?first' })
    await entering
    let secondSettled = false
    const second = manager.open('a', { next: '/?second' }).then(value => { secondSettled = true; return value })
    const other = await manager.open('b')
    assert.ok(Number(new URL(other.url).port) > 0)
    await new Promise(resolve => setImmediate(resolve))
    const premature = secondSettled
    release()
    const [a, b] = await Promise.all([first, second])
    assert.equal(premature, false, 'must not return a URL before listen completes')
    assert.equal(starts, 1)
    assert.equal(a.origin, b.origin)
    assert.ok(Number(new URL(a.url).port) > 0)
    assert.equal(new URL(b.url).search, '?second')
  } finally {
    release()
    DeviceGateway.prototype.start = start
    await manager.dispose()
  }
})

test('manager: teardown waits for a starting gateway and closes it', async () => {
  const manager = fixture()
  const start = DeviceGateway.prototype.start
  let release
  const gate = new Promise(resolve => { release = resolve })
  let entered
  const entering = new Promise(resolve => { entered = resolve })
  let gateway
  DeviceGateway.prototype.start = async function () {
    gateway = this
    entered()
    await gate
    return start.call(this)
  }
  try {
    const opening = manager.open('a')
    await entering
    const stopping = manager.dispose()
    release()
    await Promise.allSettled([opening, stopping])
    assert.equal(gateway.server, null)
    assert.equal(manager.state.get('a').gateway, null)
  } finally {
    release()
    DeviceGateway.prototype.start = start
    await manager.dispose()
  }
})

test('manager: disposal cancels opens still acquiring a token', async () => {
  const manager = fixture()
  let release
  let entered
  const gate = new Promise(resolve => { release = resolve })
  const entering = new Promise(resolve => { entered = resolve })
  manager._client = () => ({ token: async () => { entered(); await gate; return 'token' } })
  const opening = manager.open('a')
  await entering
  await manager.dispose()
  release()
  try {
    await assert.rejects(opening, /opening cancelled/)
    assert.equal(manager.state.get('a').gateway, null)
  } finally {
    await manager.dispose()
  }
})

test('manager: a failed gateway start can be retried', async () => {
  const manager = fixture()
  const start = DeviceGateway.prototype.start
  let attempts = 0
  DeviceGateway.prototype.start = async function () {
    if (++attempts === 1) throw new Error('listen failed')
    return start.call(this)
  }
  try {
    await assert.rejects(manager.open('a'), /listen failed/)
    const result = await manager.open('a')
    assert.ok(Number(new URL(result.url).port) > 0)
    assert.equal(attempts, 2)
  } finally {
    DeviceGateway.prototype.start = start
    await manager.dispose()
  }
})
