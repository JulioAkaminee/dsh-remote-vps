#!/usr/bin/env node
// Build distributable tarballs:
//   dist/dsh-device-host-<v>.tgz   the device host plugin (also embedded below)
//   dist/dsh-devices-<v>.tgz       the desktop plugin, with the host tarball and
//                                  installer in assets/ for SSH provisioning
//   dist/install-host.sh           standalone installer for the device

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const host = path.join(root, 'packages', 'dsh-device-host')
const desktop = path.join(root, 'packages', 'dsh-devices')
const assets = path.join(desktop, 'assets')
const dist = path.join(root, 'dist')
const npm = process.env.NPM || 'npm'

const a = fs.readFileSync(path.join(host, 'lib', 'protocol.js'))
const b = fs.readFileSync(path.join(desktop, 'lib', 'protocol.js'))
if (!a.equals(b)) throw new Error('protocol.js differs between packages; copy packages/dsh-device-host/lib/protocol.js over')

fs.mkdirSync(dist, { recursive: true })
fs.mkdirSync(assets, { recursive: true })
for (const f of fs.readdirSync(assets)) if (f.endsWith('.tgz')) fs.rmSync(path.join(assets, f))
for (const f of fs.readdirSync(dist)) fs.rmSync(path.join(dist, f), { recursive: true, force: true })

const pack = (dir, dest) => {
  const out = execFileSync(npm, ['pack', '--silent', '--pack-destination', dest], { cwd: dir, encoding: 'utf8' })
  return out.trim().split('\n').pop()
}

const hostTgz = pack(host, assets)
fs.copyFileSync(path.join(root, 'deploy', 'install-host.sh'), path.join(assets, 'install-host.sh'))
fs.chmodSync(path.join(assets, 'install-host.sh'), 0o755)
fs.copyFileSync(path.join(assets, hostTgz), path.join(dist, hostTgz))
fs.copyFileSync(path.join(root, 'deploy', 'install-host.sh'), path.join(dist, 'install-host.sh'))
fs.copyFileSync(path.join(root, 'deploy', 'install-desktop.sh'), path.join(dist, 'install-desktop.sh'))

const desktopTgz = pack(desktop, dist)
console.log(`built:\n  dist/${hostTgz}\n  dist/${desktopTgz}\n  dist/install-host.sh\n  dist/install-desktop.sh`)
