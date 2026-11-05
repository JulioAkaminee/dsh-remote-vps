// How the device is doing: CPU, memory, swap, disk and the heaviest
// processes, sampled when a desktop asks (its health check, every ~15 s).

import fs from 'node:fs'
import os from 'node:os'

/** First "cpu " line of /proc/stat → cumulative idle and total jiffies. */
export function parseProcStat(text) {
  const line = String(text)
    .split('\n')
    .find((l) => l.startsWith('cpu '))
  if (!line) return null
  const v = line.trim().split(/\s+/).slice(1).map(Number)
  if (v.length < 4 || v.some((n) => !Number.isFinite(n))) return null
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = v
  return { idle: idle + iowait, total: user + nice + system + idle + iowait + irq + softirq + steal }
}

/** /proc/meminfo → bytes. */
export function parseMeminfo(text) {
  const kb = {}
  for (const line of String(text).split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line)
    if (m) kb[m[1]] = Number(m[2]) * 1024
  }
  if (!kb.MemTotal) return null
  return {
    total: kb.MemTotal,
    available: kb.MemAvailable ?? (kb.MemFree ?? 0) + (kb.Buffers ?? 0) + (kb.Cached ?? 0),
    swapTotal: kb.SwapTotal ?? 0,
    swapFree: kb.SwapFree ?? 0,
  }
}

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0)

function topMemoryProcesses(limit = 3) {
  const out = []
  let pids = []
  try {
    pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))
  } catch {
    return out
  }
  for (const pid of pids) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
      const name = /^Name:\s+(.+)$/m.exec(status)?.[1]
      const rss = Number(/^VmRSS:\s+(\d+)\s*kB/m.exec(status)?.[1] ?? 0) * 1024
      if (name && rss) out.push({ pid: Number(pid), name, rss })
    } catch {}
  }
  return out.sort((a, b) => b.rss - a.rss).slice(0, limit)
}

export class HealthSampler {
  constructor({ home = os.homedir(), now = Date.now, read = (f) => fs.readFileSync(f, 'utf8'), statfs = (p) => fs.statfsSync(p) } = {}) {
    this.home = home
    this.now = now
    this.read = read
    this.statfs = statfs
    this.lastCpu = null
    this.cpuPercent = null
    this.topCache = null
  }

  _cpu(cores) {
    let stat = null
    try {
      stat = parseProcStat(this.read('/proc/stat'))
    } catch {}
    const at = this.now()
    if (stat && this.lastCpu && at - this.lastCpu.at >= 1000) {
      const total = stat.total - this.lastCpu.total
      const idle = stat.idle - this.lastCpu.idle
      if (total > 0) this.cpuPercent = Math.max(0, Math.min(100, Math.round((1 - idle / total) * 1000) / 10))
    }
    if (stat && (!this.lastCpu || at - this.lastCpu.at >= 1000)) this.lastCpu = { ...stat, at }
    // First sample (or no /proc): estimate from the load average.
    if (this.cpuPercent === null) this.cpuPercent = Math.min(100, Math.round((os.loadavg()[0] / Math.max(1, cores)) * 1000) / 10)
    return this.cpuPercent
  }

  sample() {
    const cores = os.cpus().length || 1
    let mem = null
    try {
      mem = parseMeminfo(this.read('/proc/meminfo'))
    } catch {}
    const total = mem ? mem.total : os.totalmem()
    const available = mem ? mem.available : os.freemem()
    let disk = null
    try {
      const s = this.statfs(this.home)
      const diskTotal = Number(s.bsize) * Number(s.blocks)
      const free = Number(s.bsize) * Number(s.bavail)
      disk = { path: this.home, total: diskTotal, free, used: diskTotal - free, percent: pct(diskTotal - free, diskTotal) }
    } catch {}
    if (!this.topCache || this.now() - this.topCache.at > 60_000) this.topCache = { at: this.now(), list: process.platform === 'linux' ? topMemoryProcesses() : [] }
    return {
      at: new Date(this.now()).toISOString(),
      cpu: { cores, percent: this._cpu(cores) },
      load: os.loadavg().map((n) => Math.round(n * 100) / 100),
      memory: { total, available, used: total - available, percent: pct(total - available, total) },
      swap: mem && mem.swapTotal ? { total: mem.swapTotal, used: mem.swapTotal - mem.swapFree, percent: pct(mem.swapTotal - mem.swapFree, mem.swapTotal) } : null,
      disk,
      top: this.topCache.list,
    }
  }
}
