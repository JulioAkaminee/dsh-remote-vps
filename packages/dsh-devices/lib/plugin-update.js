// Self-update for this desktop plugin.
//
// DSH's "Add plugin" dialog refuses a package that is already installed, so a
// newer build cannot be installed over the old one through the app. The plugin
// therefore does what the installer does: read the newest release, unpack it
// into ~/.dsh-devices/dsh-devices and point the profile's dependency at that
// folder (`link:`). Restarting DSH loads the new code.
//
// Only this desktop's own copy is touched; devices and their pairing are not.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'JulioDevEnviagora/dsh-remote-vps'
const CHECK_TTL = 10 * 60 * 1000
const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

let cache = null

function readVersion(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).version ?? null
  } catch {
    return null
  }
}

export function installedVersion() {
  return readVersion(path.join(PKG, 'package.json'))
}

export function parseVersion(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** -1, 0 or 1; versions that do not parse compare as equal. */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  return 0
}

/** Where this copy lives, and where an update would be unpacked. */
export function installPlan({ profileDir = null, root = process.env.DSH_DEVICES_ROOT || path.join(os.homedir(), '.dsh-devices') } = {}) {
  const target = path.join(root, 'dsh-devices')
  let real = PKG
  try {
    real = fs.realpathSync(PKG)
  } catch {}
  const managed = real === target || real.startsWith(target + path.sep)
  return {
    profileDir,
    packageDir: real,
    root,
    target,
    managed,
    link: profileDir ? path.join(profileDir, 'node_modules', 'dsh-devices') : null,
  }
}

const emptyCheck = (installed, plan, now) => ({
  installed,
  latest: null,
  available: false,
  canUpdate: !!plan.profileDir,
  mode: plan.managed ? 'managed' : plan.profileDir ? 'copy' : 'unknown',
  url: null,
  reason: null,
  checkedAt: now,
})

/** Ask GitHub for the newest release. Cached for ten minutes unless forced. */
export async function checkForUpdate({ profileDir = null, root, fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  if (!force && cache && now - cache.at < CHECK_TTL) return cache.value
  const plan = installPlan({ profileDir, root })
  const value = emptyCheck(installedVersion(), plan, now)
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-devices' },
    })
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    const release = await res.json()
    value.latest = String(release.tag_name ?? '').replace(/^v/, '') || null
    const asset = (release.assets ?? []).find((a) => /^dsh-devices-.*\.tgz$/.test(String(a.name)))
    value.url = asset?.browser_download_url ?? null
    value.available = !!(value.latest && value.url && compareVersions(value.latest, value.installed) > 0)
  } catch (error) {
    value.reason = String(error?.message ?? error)
  }
  cache = { at: now, value }
  return value
}

export function cachedUpdate() {
  return cache ? cache.value : null
}

/** Download the newest release and swap it in where the profile looks. */
export async function applyUpdate({ profileDir, root, fetchImpl = fetch, logger = console } = {}) {
  if (!profileDir) throw new Error('the profile directory is unknown; reinstall the plugin once')
  const check = await checkForUpdate({ profileDir, root, fetchImpl, force: true })
  if (check.reason) throw new Error(check.reason)
  if (!check.url) throw new Error(check.latest ? 'the newest release has no plugin package' : 'no release found')
  if (!check.available) throw new Error(`already at ${check.installed}`)

  const plan = installPlan({ profileDir, root })
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-devices-update-'))
  try {
    const res = await fetchImpl(check.url)
    if (!res.ok) throw new Error(`download failed (${res.status})`)
    const tgz = path.join(work, 'update.tgz')
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()))

    const unpacked = path.join(work, 'pkg')
    fs.mkdirSync(unpacked, { recursive: true })
    execFileSync('tar', ['-xzf', tgz, '-C', unpacked, '--strip-components=1'])

    const version = readVersion(path.join(unpacked, 'package.json'))
    if (!version || compareVersions(version, check.latest) !== 0) throw new Error('the download is not the expected version')
    if (!fs.existsSync(path.join(unpacked, 'lib', 'index.js'))) throw new Error('the download is missing its files')

    fs.mkdirSync(plan.root, { recursive: true })
    const stage = path.join(plan.root, 'dsh-devices.new')
    const previous = path.join(plan.root, 'dsh-devices.old')
    fs.rmSync(stage, { recursive: true, force: true })
    fs.rmSync(previous, { recursive: true, force: true })
    fs.cpSync(unpacked, stage, { recursive: true })

    const hadTarget = fs.existsSync(plan.target)
    if (hadTarget) fs.renameSync(plan.target, previous)
    try {
      fs.renameSync(stage, plan.target)
    } catch (error) {
      if (hadTarget) fs.renameSync(previous, plan.target)
      throw error
    }
    fs.rmSync(previous, { recursive: true, force: true })

    // Same wiring the installer does: the profile depends on the folder.
    const manifestFile = path.join(profileDir, 'package.json')
    const manifest = fs.existsSync(manifestFile)
      ? JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
      : { name: path.basename(profileDir), private: true }
    manifest.dependencies = { ...(manifest.dependencies ?? {}), 'dsh-devices': `link:${plan.target}` }
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

    if (plan.link) {
      fs.mkdirSync(path.dirname(plan.link), { recursive: true })
      fs.rmSync(plan.link, { recursive: true, force: true })
      fs.symlinkSync(plan.target, plan.link, 'dir')
    }

    cache = null
    logger?.info?.(`[dsh-devices] plugin updated to ${version} at ${plan.target}`)
    return { version, restart: true, target: plan.target }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}
