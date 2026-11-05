// The vendored ssh2 must come through whatever shape the host gives an ES
// module — a bare default export failed on macOS with "Client is not a
// constructor", which is what made every SSH device request fail.

import assert from 'node:assert/strict'
import test from 'node:test'

import { pickSsh2, resolveSshTarget, SshConnection, sshTransport } from '../../packages/dsh-devices/lib/ssh.js'

test('ssh: the vendored client is a constructor in this host', () => {
  const t = sshTransport()
  assert.equal(t.client, true, `ssh2 did not load (${t.shape})`)
  assert.equal(t.utils, true)
})

test('ssh: a connection can be built for a host string', () => {
  const target = resolveSshTarget('root@127.0.0.1:2222')
  assert.deepEqual([target.host, target.port, target.username], ['127.0.0.1', 2222, 'root'])
  const conn = new SshConnection(target)
  assert.equal(conn.closed, false)
})

test('ssh: the shape macOS hands over is understood', () => {
  // What the app exposed there: the named exports, a `default` that is not the
  // exports object, and the exports object under a literal `module.exports`.
  const Client = function Client() {}
  const utils = { parseKey() {} }
  const mac = { Client, default: {}, 'module.exports': { Client, utils } }
  const picked = pickSsh2(mac)
  assert.equal(picked.Client, Client)
  assert.equal(picked.utils, utils)

  // Nested default (a host that wraps twice) resolves too.
  assert.equal(pickSsh2({ default: { default: { Client, utils } } }).utils, utils)

  // Only a Client: still usable, key parsing degrades instead of blocking SSH.
  assert.equal(pickSsh2({ Client }).Client, Client)
  assert.equal(pickSsh2({ default: {} }), null)
})
