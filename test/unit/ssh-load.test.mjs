// The vendored ssh2 must come through whatever shape the host gives an ES
// module — a bare default export failed on macOS with "Client is not a
// constructor", which is what made every SSH device request fail.

import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveSshTarget, SshConnection, sshTransport } from '../../packages/dsh-devices/lib/ssh.js'

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
