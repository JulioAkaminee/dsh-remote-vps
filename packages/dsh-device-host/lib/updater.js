// Self-update: a paired desktop hands over the installer and the new
// device-host package; the device installs them itself (no SSH needed) and
// keeps the version it had until the new one answers — otherwise it goes back.
//
// The runner lives outside this service (a transient systemd unit when
// available), because installing restarts the service and systemd stops every
// process of its control group.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const TARBALL_NAME = /^dsh-device-host-(\d+\.\d+\.\d+(?:[-.][\w.]+)?)\.tgz$/
const MAX_BYTES = 20 * 1024 * 1024
const STALE_MS = 20 * 60_000

/**
 * The installation root (`~/.dsh-device`) of a device host installed by
 * install-host.sh: its package lives in `<root>/runtime/node_modules/dsh-device-host`.
 * A host run from a checkout (development) has none, unless DSH_DEVICE_ROOT says so.
 */
export function runtimeRoot(pluginDir, env = process.env) {
  if (env.DSH_DEVICE_ROOT) return env.DSH_DEVICE_ROOT
  let real = pluginDir
  try {
    real = fs.realpathSync(pluginDir)
  } catch {}
  const m = /^(.*)[\\/]runtime[\\/]node_modules[\\/]dsh-device-host[\\/]?$/.exec(real)
  return m ? m[1] : null
}

/** POSIX sh runner: back up, install, keep or roll back, report. Arguments are positional. */
export const RUNNER = `#!/bin/sh
# dsh-device-host self-update runner (written by the device host).
# usage: run-update.sh ROOT DIR TARBALL DSH_VERSION PORT FROM TO STARTED
ROOT="$1"; DIR="$2"; TGZ="$3"; DSH_VERSION="$4"; PORT="$5"; FROM="$6"; TO="$7"; STARTED="$8"
STATUS="$ROOT/update-status.json"; LOG="$DIR/update.log"
# The device host wrote update.lock for this run; it goes when the run ends, however it ends.
trap 'rm -f "$ROOT/update.lock" "$ROOT/update.runner.pid"' EXIT
echo $$ > "$ROOT/update.runner.pid"
export DSH_DEVICE_ROOT="$ROOT"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { echo "$(now) $*" >> "$LOG"; }
status() {
  msg=$(printf '%s' "$2" | tr -d '"\\\\' | tr '\\n' ' ')
  printf '{"state":"%s","from":"%s","to":"%s","startedAt":"%s","finishedAt":"%s","error":"%s","log":"%s"}\\n' "$1" "$FROM" "$TO" "$STARTED" "$3" "$msg" "$LOG" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
}
restart_host() {
  # Only the service that runs this installation (its ExecStart points into $ROOT/runtime).
  if systemctl --user cat dsh-device-host 2>/dev/null | grep -qF "$ROOT/runtime/"; then
    systemctl --user restart dsh-device-host >> "$LOG" 2>&1
  elif [ -f "$ROOT/host.pid" ]; then
    kill "$(cat "$ROOT/host.pid")" 2>/dev/null; sleep 1
    NODE=$(sed -n 's/.*exec "\\([^"]*\\)".*/\\1/p' "$ROOT/bin/dsh" | head -n 1)
    ( set -a; [ -f "$ROOT/env" ] && . "$ROOT/env"; set +a
      nohup "$NODE" "$ROOT/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile device-host --no-open --host 127.0.0.1 --port "$PORT" >> "$ROOT/host.log" 2>&1 &
      echo $! > "$ROOT/host.pid" )
  fi
}
say "updating $FROM -> $TO (dsh $DSH_VERSION)"
rm -rf "$ROOT/runtime.prev"
# Hard links make the backup instant and small: npm replaces a changed package by
# extracting new files, so the old ones stay intact behind the links. What npm
# rewrites in place (manifests, its hidden lockfile) and the host package itself
# are copied for real.
if cp -al "$ROOT/runtime" "$ROOT/runtime.prev" 2>> "$LOG"; then
  for f in package.json package-lock.json node_modules/.package-lock.json; do
    if [ -f "$ROOT/runtime/$f" ]; then rm -f "$ROOT/runtime.prev/$f"; cp -p "$ROOT/runtime/$f" "$ROOT/runtime.prev/$f"; fi
  done
  if [ -d "$ROOT/runtime/node_modules/dsh-device-host" ]; then
    rm -rf "$ROOT/runtime.prev/node_modules/dsh-device-host"
    cp -a "$ROOT/runtime/node_modules/dsh-device-host" "$ROOT/runtime.prev/node_modules/dsh-device-host" 2>> "$LOG"
  fi
else
  rm -rf "$ROOT/runtime.prev"
  cp -a "$ROOT/runtime" "$ROOT/runtime.prev" 2>> "$LOG" || { status failed "could not back up the current version" "$(now)"; exit 1; }
fi
RESULT=$(DSH_DEVICE_FORCE_PORT=1 sh "$DIR/install-host.sh" --plugin "$TGZ" --dsh-version "$DSH_VERSION" --port "$PORT" 2>&1 | tee -a "$LOG" | grep '^DSH_DEVICE_INSTALL_RESULT ' | tail -n 1)
# Done only when the host that answers is the new one (an old process still shutting down can answer too).
case "$RESULT" in
  *'"ok":true'*'"plugin":"'"$TO"'"'*)
    rm -rf "$ROOT/runtime.prev"
    say "updated to $TO"
    status done "" "$(now)"
    exit 0 ;;
esac
say "the new version did not come up: restoring $FROM"
rm -rf "$ROOT/runtime.broken"
mv "$ROOT/runtime" "$ROOT/runtime.broken" 2>> "$LOG"
mv "$ROOT/runtime.prev" "$ROOT/runtime" 2>> "$LOG"
restart_host
rm -rf "$ROOT/runtime.broken"
status failed "the new version did not start; $FROM was restored" "$(now)"
exit 1
`

const START_GRACE_MS = 60_000

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a recorded run is still going: it started less than a minute ago
 * (its runner may still be starting), or the pid it recorded lives. No
 * subprocess: this runs on every /info.
 */
export function runnerAlive(run, { root, now = Date.now() } = {}) {
  if (!run) return false
  if (run.startedAt && now - Date.parse(run.startedAt) < START_GRACE_MS) return true
  if (root) {
    try {
      if (pidAlive(fs.readFileSync(path.join(root, 'update.runner.pid'), 'utf8').trim())) return true
    } catch {}
  }
  return pidAlive(run.pid)
}

function systemdUser() {
  try {
    return spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 5000 }).status === 0
  } catch {
    return false
  }
}

export class Updater {
  /**
   * @param {{ root: string|null, version: string|null, port: () => number, logger?: any, spawnRunner?: (args: string[], useSystemd: boolean) => void, now?: () => number }} options
   */
  constructor({ root, version, port, logger = console, spawnRunner, now = Date.now, alive, env = process.env }) {
    this.root = root
    this.version = version
    this.port = port
    this.logger = logger
    this.now = now
    this.alive = alive ?? ((run) => runnerAlive(run, { root: this.root, now: this.now() }))
    // The runner (and install-host.sh) must act on this installation and this DSH_HOME.
    this.runnerEnv = { DSH_DEVICE_ROOT: root ?? '', DSH_HOME: env.DSH_HOME || path.join(os.homedir(), '.dsh'), PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: env.HOME || os.homedir() }
    /** Starts the runner; returns `{ unit }` or `{ pid }` so its liveness can be checked later. */
    this.spawnRunner = spawnRunner ?? ((args, useSystemd) => {
      if (useSystemd) {
        const unit = `dsh-device-update-${Date.now()}`
        // A transient unit starts with the user manager's environment: pass ours explicitly.
        const setenv = Object.entries(this.runnerEnv).map(([k, v]) => `--setenv=${k}=${v}`)
        const child = spawn('systemd-run', ['--user', '--collect', '--quiet', `--unit=${unit}`, ...setenv, '/bin/sh', ...args], { stdio: 'ignore', detached: true })
        child.on('error', (e) => this.logger.warn?.(`[dsh-device-host] update runner: ${e.message}`))
        child.unref()
        return { unit }
      }
      const child = spawn('/bin/sh', args, { stdio: 'ignore', detached: true, env: { ...process.env, ...this.runnerEnv } })
      child.on('error', (e) => this.logger.warn?.(`[dsh-device-host] update runner: ${e.message}`))
      child.unref()
      return { pid: child.pid }
    })
  }

  _lockFile() {
    return this.root ? path.join(this.root, 'update.lock') : null
  }

  _readLock() {
    try {
      return JSON.parse(fs.readFileSync(this._lockFile(), 'utf8'))
    } catch {
      return null
    }
  }

  supported() {
    if (!this.root) return false
    if (!this._supported || this.now() - this._supported.at > 60_000) this._supported = { at: this.now(), value: fs.existsSync(path.join(this.root, 'runtime')) }
    return this._supported.value
  }

  _statusFile() {
    return this.root ? path.join(this.root, 'update-status.json') : null
  }

  /** The last update: `{ state: running|done|failed, from, to, startedAt, finishedAt, error, log }`, and its log tail. */
  status({ withLog = false } = {}) {
    const file = this._statusFile()
    if (!file) return { state: 'none', supported: false }
    let st = null
    try {
      st = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return { state: 'none', supported: this.supported() }
    }
    // "running" holds while the runner lives. A runner that is gone without a
    // verdict (killed with the old service): the version now running tells how it ended.
    if (st.state === 'running' && !this.alive(this._readLock() || st)) {
      if (st.to && this.version === st.to) st = { ...st, state: 'done', finishedAt: st.finishedAt || new Date(this.now()).toISOString() }
      else st = { ...st, state: 'failed', error: st.error || 'the update stopped before it finished' }
    } else if (st.state === 'running' && this.now() - Date.parse(st.startedAt || 0) > STALE_MS * 3) {
      st = { ...st, state: 'failed', error: 'the update is taking too long' }
    }
    const out = { ...st, supported: this.supported() }
    if (withLog && st.log) {
      try {
        out.logTail = fs.readFileSync(st.log, 'utf8').split('\n').filter(Boolean).slice(-40)
      } catch {}
    }
    return out
  }

  /** Write the files and start the runner; answers right away (the service restarts during the install). */
  start({ installer, tarball, tarballName, dshVersion }) {
    if (!this.supported()) throw Object.assign(new Error('self-update-unsupported'), { status: 501 })
    // One run at a time: a live runner holds update.lock; a dead one's lock is stale.
    const lock = this._readLock()
    if (lock && this.alive(lock)) throw Object.assign(new Error('update-in-progress'), { status: 409 })
    if (lock) fs.rmSync(this._lockFile(), { force: true })
    const m = TARBALL_NAME.exec(String(tarballName ?? ''))
    if (!m) throw Object.assign(new Error('invalid-tarball-name'), { status: 400 })
    const pkg = Buffer.from(String(tarball ?? ''), 'base64')
    const script = Buffer.from(String(installer ?? ''), 'base64')
    if (pkg.length < 100 || pkg.length > MAX_BYTES || pkg[0] !== 0x1f || pkg[1] !== 0x8b) throw Object.assign(new Error('invalid-tarball'), { status: 400 })
    if (script.length < 100 || script.length > 1024 * 1024 || !script.toString('utf8', 0, 16).startsWith('#!/bin/sh')) throw Object.assign(new Error('invalid-installer'), { status: 400 })
    const version = String(dshVersion ?? '').trim() || 'latest'
    if (!/^[\w.+-]{1,64}$/.test(version)) throw Object.assign(new Error('invalid-dsh-version'), { status: 400 })
    const startedAt = new Date(this.now()).toISOString()
    const dir = path.join(this.root, 'updates', startedAt.replace(/[:.]/g, '-'))
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tgz = path.join(dir, m[0])
    fs.writeFileSync(tgz, pkg, { mode: 0o600 })
    fs.writeFileSync(path.join(dir, 'install-host.sh'), script, { mode: 0o700 })
    const runner = path.join(dir, 'run-update.sh')
    fs.writeFileSync(runner, RUNNER, { mode: 0o700 })
    const from = this.version || '?'
    const to = m[1]
    const status = { state: 'running', from, to, startedAt, finishedAt: '', error: '', log: path.join(dir, 'update.log') }
    // Taken before the runner starts (it removes the lock when it ends).
    fs.writeFileSync(this._lockFile(), JSON.stringify({ startedAt }) + '\n', { mode: 0o600 })
    fs.writeFileSync(this._statusFile(), JSON.stringify(status) + '\n', { mode: 0o600 })
    this._prune()
    let handle = {}
    try {
      handle = this.spawnRunner([runner, this.root, dir, tgz, version, String(this.port()), from, to, startedAt], systemdUser()) || {}
    } catch (error) {
      fs.rmSync(this._lockFile(), { force: true })
      throw error
    }
    // Remember how to tell whether this run is still going (unless it already finished).
    if (fs.existsSync(this._lockFile())) fs.writeFileSync(this._lockFile(), JSON.stringify({ startedAt, ...handle }) + '\n', { mode: 0o600 })
    return { started: true, from, to, startedAt }
  }

  /** Keep the last five update folders. */
  _prune() {
    try {
      const base = path.join(this.root, 'updates')
      const dirs = fs.readdirSync(base).sort()
      for (const d of dirs.slice(0, Math.max(0, dirs.length - 5))) fs.rmSync(path.join(base, d), { recursive: true, force: true })
    } catch {}
  }
}

export const _internals = { systemdUser, homedir: os.homedir }
