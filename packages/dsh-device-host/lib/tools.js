// Tools DSH expects next to it. Its plugin manager runs `pnpm` (lookups, installs,
// removals); the desktop app ships its own pnpm, a device does not. The installer
// puts one under ~/.dsh-device (tools/ + a bin/pnpm wrapper on the service PATH);
// this guard covers hosts started without it: it installs pnpm once, quietly.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** The pnpm the DSH desktop app ships (its plugin manager is tested with it). */
export const PNPM_VERSION = '11.7.0'

/** Whether an executable named `cmd` is on `envPath`. */
export function onPath(cmd, envPath = process.env.PATH ?? '') {
  for (const dir of String(envPath).split(path.delimiter)) {
    if (!dir) continue
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK)
      return true
    } catch {}
  }
  return false
}

export function pnpmPaths(root) {
  return {
    tools: path.join(root, 'tools'),
    cli: path.join(root, 'tools', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    bin: path.join(root, 'bin'),
    wrapper: path.join(root, 'bin', 'pnpm'),
  }
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

export function pnpmWrapper(node, cli) {
  return `#!/bin/sh\n# pnpm for DSH's plugin manager on this device (written by dsh-device-host)\nexec ${shq(node)} ${shq(cli)} "$@"\n`
}

function run(cmd, args, { env, timeoutMs = 5 * 60_000 } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, out: String(error && error.message) })
      return
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, out: out + String(error && error.message) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

export class PnpmGuard {
  /**
   * @param {{ root: string|null, node?: string, env?: NodeJS.ProcessEnv, logger?: any, runner?: typeof run, version?: string }} options
   */
  constructor({ root, node = process.execPath, env = process.env, logger = console, runner = run, version = PNPM_VERSION } = {}) {
    this.root = root
    this.node = node
    this.env = env
    this.logger = logger
    this.runner = runner
    this.version = version
    /** 'unknown' | 'ok' | 'installing' | 'missing' | 'failed' */
    this.status = 'unknown'
    this.source = null
    this.error = null
    this.pending = null
  }

  view() {
    return { status: this.status, source: this.source, error: this.error }
  }

  /** Put our pnpm first on this process's PATH (DSH's plugin manager spawns `pnpm` from it). */
  _usePath(bin) {
    const parts = String(this.env.PATH ?? '').split(path.delimiter).filter(Boolean)
    if (parts[0] !== bin) this.env.PATH = [bin, ...parts.filter((p) => p !== bin)].join(path.delimiter)
  }

  _wrap(p) {
    fs.mkdirSync(p.bin, { recursive: true })
    const body = pnpmWrapper(this.node, p.cli)
    let current = null
    try {
      current = fs.readFileSync(p.wrapper, 'utf8')
    } catch {}
    if (current !== body) fs.writeFileSync(p.wrapper, body, { mode: 0o755 })
    fs.chmodSync(p.wrapper, 0o755)
  }

  /** Make sure `pnpm` resolves for DSH; installs it under the device root once if needed. */
  ensure() {
    if (!this.pending) this.pending = this._ensure().finally(() => (this.pending = null))
    return this.pending
  }

  async _ensure() {
    if (this.root) {
      const p = pnpmPaths(this.root)
      if (fs.existsSync(p.cli)) {
        this._wrap(p)
        this._usePath(p.bin)
        this.status = 'ok'
        this.source = 'device'
        this.error = null
        return this.view()
      }
    }
    if (onPath('pnpm', this.env.PATH)) {
      this.status = 'ok'
      this.source = 'system'
      return this.view()
    }
    if (!this.root) {
      this.status = 'missing'
      return this.view()
    }
    const p = pnpmPaths(this.root)
    this.status = 'installing'
    this.logger.info?.(`[dsh-device-host] pnpm is missing: installing pnpm ${this.version} under ${p.tools} (DSH's plugin manager needs it)`)
    try {
      fs.mkdirSync(p.tools, { recursive: true })
      const pkg = path.join(p.tools, 'package.json')
      if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, '{\n  "name": "dsh-device-tools",\n  "private": true\n}\n')
    } catch (error) {
      this.status = 'failed'
      this.error = String((error && error.message) || error)
      return this.view()
    }
    const nodeDir = path.dirname(this.node)
    const npm = fs.existsSync(path.join(nodeDir, 'npm')) ? path.join(nodeDir, 'npm') : 'npm'
    const env = { ...this.env, PATH: [nodeDir, this.env.PATH].filter(Boolean).join(path.delimiter) }
    const r = await this.runner(npm, ['install', '--prefix', p.tools, '--no-audit', '--no-fund', '--loglevel=error', `pnpm@${this.version}`], { env })
    if (r.code !== 0 || !fs.existsSync(p.cli)) {
      this.status = 'failed'
      this.error = String(r.out || `npm exited with ${r.code}`).trim().split('\n').slice(-3).join(' ').slice(0, 400)
      this.logger.warn?.(`[dsh-device-host] could not install pnpm: ${this.error}`)
      return this.view()
    }
    this._wrap(p)
    this._usePath(p.bin)
    this.status = 'ok'
    this.source = 'device'
    this.error = null
    this.logger.info?.(`[dsh-device-host] pnpm ${this.version} ready for the plugin manager`)
    return this.view()
  }
}
