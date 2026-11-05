// The plugin's own update: version comparison, where an update lands, and the
// swap itself (a fake release served in memory, a real tar and a real profile).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { applyUpdate, cachedUpdate, checkForUpdate, compareVersions, installPlan, parseVersion } from '../../packages/dsh-devices/lib/plugin-update.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dshdev-update-test-'))

test('plugin update: versions compare the way releases do', () => {
  assert.equal(compareVersions('0.1.12', '0.1.13'), -1)
  assert.equal(compareVersions('v0.1.13', '0.1.13'), 0)
  assert.equal(compareVersions('0.2.0', '0.1.99'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.deepEqual(parseVersion('v10.2.3-beta.1'), [10, 2, 3])
  assert.equal(compareVersions('not-a-version', '1.0.0'), 0)
})

test('plugin update: the plan names the managed folder and the profile link', () => {
  const plan = installPlan({ profileDir: '/p', root: '/root/.dsh-devices' })
  assert.equal(plan.target, '/root/.dsh-devices/dsh-devices')
  assert.equal(plan.link, '/p/node_modules/dsh-devices')
  assert.equal(plan.profileDir, '/p')
})

/** A release as GitHub would describe it, with a real tarball behind the URL. */
function fakeRelease(version = '9.9.9') {
  const work = tmp()
  const pkg = path.join(work, 'package')
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'dsh-devices', version }, null, 2))
  fs.writeFileSync(path.join(pkg, 'lib', 'index.js'), 'export const name = "dsh-devices"\n')
  const tgz = path.join(work, 'dsh-devices-9.9.9.tgz')
  execFileSync('tar', ['-czf', tgz, '-C', work, 'package'])
  const bytes = fs.readFileSync(tgz)
  const url = `https://example.test/dsh-devices-${version}.tgz`
  const fetchImpl = async (target) => {
    if (String(target).includes('api.github.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ tag_name: `v${version}`, assets: [{ name: `dsh-devices-${version}.tgz`, browser_download_url: url }] }),
      }
    }
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
  }
  return { fetchImpl, url, work }
}

test('plugin update: a release newer than this copy is offered, then installed into the profile', async () => {
  const home = tmp()
  const profile = path.join(home, 'profiles', 'tauri-main')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'profile', private: true, dependencies: {} }))
  const root = path.join(home, '.dsh-devices')
  const { fetchImpl } = fakeRelease()

  const check = await checkForUpdate({ profileDir: profile, root, fetchImpl, force: true })
  assert.equal(check.available, true)
  assert.equal(check.latest, '9.9.9')
  assert.equal(check.canUpdate, true)

  const result = await applyUpdate({ profileDir: profile, root, fetchImpl })
  assert.equal(result.version, '9.9.9')
  assert.equal(result.restart, true)

  const installed = JSON.parse(fs.readFileSync(path.join(root, 'dsh-devices', 'package.json'), 'utf8'))
  assert.equal(installed.version, '9.9.9')
  assert.equal(fs.existsSync(path.join(root, 'dsh-devices', 'lib', 'index.js')), true)
  assert.equal(fs.existsSync(path.join(root, 'dsh-devices.new')), false)

  const manifest = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['dsh-devices'], `link:${path.join(root, 'dsh-devices')}`)
  assert.equal(fs.realpathSync(path.join(profile, 'node_modules', 'dsh-devices')), fs.realpathSync(path.join(root, 'dsh-devices')))

  // The cached offer is cleared, so the next look starts from scratch.
  assert.equal(cachedUpdate(), null)
  fs.rmSync(home, { recursive: true, force: true })
})

test('plugin update: without a profile it refuses instead of guessing', async () => {
  const { fetchImpl } = fakeRelease()
  await assert.rejects(() => applyUpdate({ profileDir: null, fetchImpl }), /profile directory is unknown/)
})
