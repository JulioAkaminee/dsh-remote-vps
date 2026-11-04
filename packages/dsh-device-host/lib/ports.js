// Listening TCP ports on this device (dev servers an agent started), and the
// raw tunnel a paired desktop uses to reach one of them from its own
// localhost — "localhost:5173" on the VPS becomes "localhost:5173" on the Mac.
//
// Only preview candidates are listed: ports ≥ 1024 outside the kernel's
// ephemeral range, not machine infrastructure (sshd, docker-proxy…), plus any
// port opened by a process the agent started (a descendant of this DSH
// process: `fromAgent`) or running inside one of the device's workspaces
// (`inWorkspace`, e.g. `nohup npm run dev &`) — the ones desktops forward
// automatically.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { PORT_TUNNEL_PROTOCOL } from './protocol.js'

/** Decode a /proc/net/tcp{,6} hex address ("0100007F:1F90") into { address, port }. */
export function decodeProcAddress(hex) {
  const [addrHex, portHex] = String(hex).split(':')
  const port = parseInt(portHex, 16)
  if (!addrHex || !Number.isFinite(port)) return null
  if (addrHex.length === 8) {
    const n = parseInt(addrHex, 16)
    return { address: [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.'), port }
  }
  if (addrHex.length === 32) {
    // Four little-endian 32-bit words.
    const bytes = []
    for (let w = 0; w < 4; w++) {
      const word = addrHex.slice(w * 8, w * 8 + 8)
      for (let b = 3; b >= 0; b--) bytes.push(word.slice(b * 2, b * 2 + 2))
    }
    const groups = []
    for (let i = 0; i < 16; i += 2) groups.push(parseInt(`${bytes[i]}${bytes[i + 1]}`, 16))
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
      return { address: `::ffff:${bytes.slice(12).map((x) => parseInt(x, 16)).join('.')}`, port }
    }
    // RFC 5952: compress the longest run (≥ 2) of zero groups.
    let best = { start: -1, len: 0 }
    for (let i = 0; i < 8; ) {
      if (groups[i] !== 0) {
        i++
        continue
      }
      let j = i
      while (j < 8 && groups[j] === 0) j++
      if (j - i > best.len) best = { start: i, len: j - i }
      i = j
    }
    const hex = groups.map((g) => g.toString(16))
    const address =
      best.len >= 2 ? `${hex.slice(0, best.start).join(':')}::${hex.slice(best.start + best.len).join(':')}` : hex.join(':')
    return { address, port }
  }
  return null
}

/**
 * Parse /proc/net/tcp text: listening sockets with their owner uid and inode.
 * @returns {{ address: string, port: number, uid: number, inode: string }[]}
 */
export function parseProcNetTcp(text) {
  const out = []
  for (const line of String(text).split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 10 || cols[3] !== '0A') continue // 0A = LISTEN
    const local = decodeProcAddress(cols[1])
    if (!local) continue
    out.push({ ...local, uid: Number(cols[7]), inode: cols[9] })
  }
  return out
}

/** Services that listen for the machine, not for a project: never offered as previews. */
const INFRASTRUCTURE = /^(sshd|systemd.*|init|docker-proxy|dockerd|containerd.*|cloudflared|tailscaled|zerotier-one|rpcbind|cupsd|avahi-daemon|chronyd|ntpd|master|exim4?|postfix|dnsmasq|named|unbound|snapd|polkitd|dbus-daemon|redis-server|mysqld|mariadbd|postgres|mongod|memcached)$/

const TOOLING = /(^|[\s/@-])(mcp|modelcontextprotocol|language-?server|lsp|tsserver|inspector|debugpy|pnpm|npm-cli)(\b|[\s/@-])/i

/** The kernel's ephemeral range: random listeners (debuggers, tooling, forwards) live there. */
function ephemeralRange() {
  try {
    const [lo, hi] = fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number)
    if (lo > 0 && hi >= lo) return [lo, hi]
  } catch {}
  return [32768, 60999]
}

/** Parent pid of a process (Linux /proc). */
function parentPid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    // "pid (comm with spaces) state ppid …"
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(rest[1]) || 0
  } catch {
    return 0
  }
}

/** Whether `pid` descends from `ancestor` (e.g. a dev server the agent started from DSH's terminal). */
export function descendsFrom(pid, ancestor, parentOf = parentPid) {
  let p = pid
  for (let i = 0; i < 64 && p > 1; i++) {
    p = parentOf(p)
    if (p === ancestor) return true
  }
  return false
}

/**
 * Keep what a person would preview: ports ≥ 1024 outside the ephemeral range,
 * not machine infrastructure — plus anything the agent's own processes opened.
 */
export function isPreviewCandidate(entry, { ephemeral = ephemeralRange() } = {}) {
  if (entry.command && INFRASTRUCTURE.test(entry.command)) return false
  // MCP servers and other tooling DSH itself spawns are not previews.
  if (TOOLING.test(entry.label || '') || TOOLING.test(entry.argsText || '')) return false
  if (entry.port < 1024 && !entry.inWorkspace) return false
  if (entry.port >= ephemeral[0] && entry.port <= ephemeral[1]) return false
  return true
}

function scope(address) {
  if (address === '127.0.0.1' || address === '::1' || address.startsWith('127.') || address === '::ffff:127.0.0.1') return 'loopback'
  if (address === '0.0.0.0' || address === '::') return 'all'
  return 'address'
}

function readProc(pid) {
  let command = null
  let args = []
  let cwd = null
  try {
    args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
    command = args[0] ? path.basename(args[0]) : null
  } catch {}
  try {
    cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
  } catch {}
  return { command, args, cwd }
}

/** A short human label: "vite", "next dev", "python -m http.server"… */
export function describeCommand(args) {
  if (!args || args.length === 0) return null
  const base = path.basename(args[0])
  const rest = args.slice(1)
  if (/^(node|bun|deno|python[\d.]*|ruby|php|java)$/.test(base) && rest.length) {
    const script = rest.find((a) => !a.startsWith('-')) || rest[0]
    const name = path.basename(script)
    // node .../node_modules/.bin/vite → vite; node .../next/dist/bin/next dev → next dev
    const pkg = script.match(/node_modules\/(?:\.bin\/)?(@[^/]+\/[^/]+|[^/]+)/)
    const label = pkg ? pkg[1].replace(/^@[^/]+\//, '') : name
    const sub = rest.slice(rest.indexOf(script) + 1).find((a) => /^[a-z][\w:-]*$/i.test(a))
    return [label === 'bin' ? name : label, sub].filter(Boolean).join(' ').slice(0, 60)
  }
  return [base, rest.find((a) => /^[a-z][\w:-]*$/i.test(a))].filter(Boolean).join(' ').slice(0, 60)
}

/**
 * inode → pid of listening sockets. Walking every /proc/<pid>/fd is the costly
 * part, so owners are cached and the walk runs only for inodes not seen yet
 * (inodes nobody owns, e.g. in another PID namespace, are retried after a minute).
 */
const ownerCache = new Map()
const unownedUntil = new Map()
export function socketOwners(inodes, uid) {
  const now = Date.now()
  const result = new Map()
  const unknown = new Set()
  for (const inode of inodes) {
    const pid = ownerCache.get(inode)
    if (pid && fs.existsSync(`/proc/${pid}`)) result.set(inode, pid)
    else if ((unownedUntil.get(inode) ?? 0) < now) unknown.add(inode)
  }
  for (const inode of [...ownerCache.keys()]) if (!inodes.has(inode)) ownerCache.delete(inode)
  for (const inode of [...unownedUntil.keys()]) if (!inodes.has(inode)) unownedUntil.delete(inode)
  if (unknown.size === 0) return result
  let pids = []
  try {
    pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))
  } catch {}
  let found = 0
  for (const pid of pids) {
    if (found === unknown.size) break
    try {
      if (fs.statSync(`/proc/${pid}`).uid !== uid) continue
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        let link
        try {
          link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`)
        } catch {
          continue
        }
        const m = /^socket:\[(\d+)\]$/.exec(link)
        if (m && unknown.has(m[1]) && !result.has(m[1])) {
          result.set(m[1], Number(pid))
          ownerCache.set(m[1], Number(pid))
          found += 1
        }
      }
    } catch {}
  }
  for (const inode of unknown) if (!result.has(inode)) unownedUntil.set(inode, now + 60_000)
  return result
}

function inside(dir, roots) {
  if (!dir) return false
  return roots.some((root) => root && (dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`)))
}

function linuxPorts({ uid, excludePorts, excludePid, workspaces = [] }) {
  const sockets = []
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      sockets.push(...parseProcNetTcp(fs.readFileSync(file, 'utf8')))
    } catch {}
  }
  const mine = sockets.filter((s) => s.uid === uid && !excludePorts.has(s.port))
  if (mine.length === 0) return []
  const owner = socketOwners(new Set(mine.map((s) => s.inode)), uid)
  const byPort = new Map()
  for (const s of mine) {
    const pid = owner.get(s.inode) ?? null
    if (pid !== null && pid === excludePid) continue
    const prev = byPort.get(s.port)
    const entry = prev ?? { port: s.port, addresses: [], scope: 'loopback', pid, command: null, label: null, cwd: null }
    if (!entry.addresses.includes(s.address)) entry.addresses.push(s.address)
    const sc = scope(s.address)
    if (sc === 'all' || (sc === 'address' && entry.scope === 'loopback')) entry.scope = sc
    if (entry.pid === null && pid !== null) entry.pid = pid
    byPort.set(s.port, entry)
  }
  for (const entry of byPort.values()) {
    entry.fromAgent = false
    if (entry.pid === null) continue
    const proc = readProc(entry.pid)
    entry.command = proc.command
    entry.label = describeCommand(proc.args)
    entry.argsText = proc.args.join(' ').slice(0, 300)
    entry.cwd = proc.cwd
    entry.fromAgent = descendsFrom(entry.pid, excludePid)
    entry.inWorkspace = inside(proc.cwd, workspaces)
  }
  return [...byPort.values()]
}

function lsofPorts({ excludePorts, excludePid }) {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-u', String(process.getuid?.() ?? ''), '-Fpcn'], { timeout: 5000 }, (error, stdout) => {
      if (error && !stdout) return resolve([])
      const byPort = new Map()
      let pid = null
      let command = null
      for (const line of String(stdout).split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1))
        else if (line.startsWith('c')) command = line.slice(1)
        else if (line.startsWith('n')) {
          const m = /^(.*):(\d+)$/.exec(line.slice(1))
          if (!m) continue
          const port = Number(m[2])
          if (excludePorts.has(port) || pid === excludePid) continue
          const address = m[1].replace(/^\[|\]$/g, '').replace(/^\*$/, '0.0.0.0')
          const entry = byPort.get(port) ?? { port, addresses: [], scope: 'loopback', pid, command, label: command, cwd: null, fromAgent: false }
          if (!entry.addresses.includes(address)) entry.addresses.push(address)
          if (scope(address) === 'all') entry.scope = 'all'
          byPort.set(port, entry)
        }
      }
      resolve([...byPort.values()])
    })
  })
}

/**
 * Listening TCP ports owned by this user, minus `excludePorts` and sockets of
 * `excludePid` (this DSH process). Sorted by port.
 */
export async function listListeningPorts({ excludePorts = [], excludePid = process.pid, workspaces = [], all = false } = {}) {
  const opts = { uid: process.getuid?.() ?? -1, excludePorts: new Set(excludePorts.map(Number)), excludePid, workspaces }
  const list = process.platform === 'linux' ? linuxPorts(opts) : await lsofPorts(opts)
  const ephemeral = ephemeralRange()
  return list.filter((e) => all || isPreviewCandidate(e, { ephemeral })).sort((a, b) => a.port - b.port)
}

/** Cached wrapper: long-polls and the watcher ask for it every few seconds. */
export class PortWatcher {
  constructor({ excludePorts = () => [], workspaces = () => [], ttlMs = 2500 } = {}) {
    this.excludePorts = excludePorts
    this.workspaces = workspaces
    this.ttlMs = ttlMs
    this.cache = null
    this.inflight = null
  }

  async list() {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.items
    if (!this.inflight) {
      this.inflight = listListeningPorts({ excludePorts: this.excludePorts(), workspaces: this.workspaces() })
        .catch(() => [])
        .then((items) => {
          this.cache = { at: Date.now(), items }
          this.inflight = null
          return items
        })
    }
    return this.inflight
  }

  /** Stable fingerprint for change detection. */
  static key(items) {
    return items.map((p) => `${p.port}:${p.pid ?? ''}:${p.fromAgent || p.inWorkspace ? 1 : 0}`).join(',')
  }
}

/**
 * Answer an authenticated `Upgrade: dsh-port-tunnel` request: connect to the
 * device's loopback port, then splice raw bytes both ways.
 */
export function handlePortTunnel(req, socket, head, port) {
  const refuse = (status, text) => {
    try {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    } catch {}
  }
  // The HTTP server drops its own socket error handler on upgrade: without one,
  // a client reset while the upstream connect is pending would crash the process.
  let upstream = null
  let clientGone = false
  socket.on('error', () => {
    clientGone = true
    upstream?.destroy()
  })
  socket.on('close', () => {
    clientGone = true
    upstream?.destroy()
  })
  if (String(req.headers.upgrade || '').toLowerCase() !== PORT_TUNNEL_PROTOCOL) return refuse(400, 'Bad Request')
  if (!Number.isInteger(port) || port < 1 || port > 65535) return refuse(400, 'Bad Request')
  const attempt = (hosts) => {
    if (clientGone) return
    const conn = net.connect({ host: hosts[0], port })
    upstream = conn
    let connected = false
    conn.once('connect', () => {
      connected = true
      if (clientGone) return conn.destroy()
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${PORT_TUNNEL_PROTOCOL}\r\nConnection: Upgrade\r\n\r\n`)
      if (head && head.length) conn.write(head)
      socket.pipe(conn)
      conn.pipe(socket)
      conn.on('close', () => socket.destroy())
    })
    conn.on('error', () => {
      if (connected) return socket.destroy()
      conn.destroy()
      // Dev servers bound to "localhost" may listen on ::1 only.
      if (hosts.length > 1) attempt(hosts.slice(1))
      else refuse(502, 'Bad Gateway')
    })
  }
  attempt(['127.0.0.1', '::1'])
}
