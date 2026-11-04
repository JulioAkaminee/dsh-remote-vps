// Port previews on this computer: a dev server listening on a device port
// (say 5173, started by the agent on the VPS) is served on this computer's
// localhost — on the same port number when it is free — so the browser, the
// editor or the device's own Browser tab can open "localhost:5173".

import net from 'node:net'

export class PortForwards {
  /**
   * @param {{ connect: (deviceId: string, remotePort: number) => Promise<import('node:stream').Duplex>, onChange?: () => void, logger?: any }} options
   */
  constructor({ connect, onChange = () => {}, logger = console }) {
    this.connect = connect
    this.onChange = onChange
    this.logger = logger
    /** @type {Map<string, { deviceId: string, remotePort: number, localPort: number, server: net.Server, sockets: Set<net.Socket>, auto: boolean, createdAt: number, errors: number }>} */
    this.forwards = new Map()
    /** Ports the user closed: auto-forwarding leaves them alone until they disappear. */
    this.dismissed = new Set()
  }

  static key(deviceId, remotePort) {
    return `${deviceId}:${Number(remotePort)}`
  }

  get(deviceId, remotePort) {
    return this.forwards.get(PortForwards.key(deviceId, remotePort)) ?? null
  }

  /** Serve a device port locally; returns the local port. Concurrent calls share one listener. */
  async forward(deviceId, remotePort, { auto = false } = {}) {
    const port = Number(remotePort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port')
    const key = PortForwards.key(deviceId, port)
    const existing = this.forwards.get(key)
    if (existing) {
      if (!auto) existing.auto = false
      return existing.localPort
    }
    if (!auto) this.dismissed.delete(key)
    this.pending = this.pending || new Map()
    if (this.pending.has(key)) {
      const local = await this.pending.get(key)
      if (!auto) {
        const e = this.forwards.get(key)
        if (e) e.auto = false
      }
      return local
    }
    const job = this._open(deviceId, port, auto).finally(() => this.pending.delete(key))
    this.pending.set(key, job)
    return job
  }

  async _open(deviceId, port, auto) {
    const key = PortForwards.key(deviceId, port)
    const sockets = new Set()
    const entry = { deviceId, remotePort: port, localPort: 0, servers: [], sockets, auto, createdAt: Date.now(), errors: 0 }
    const onConnection = (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => {})
      socket.pause()
      this.connect(deviceId, port).then(
        (stream) => {
          if (socket.destroyed) return stream.destroy()
          stream.on('error', () => socket.destroy())
          socket.on('error', () => stream.destroy())
          stream.on('close', () => socket.destroy())
          socket.on('close', () => stream.destroy())
          socket.pipe(stream)
          stream.pipe(socket)
          socket.resume()
        },
        () => {
          entry.errors += 1
          socket.destroy()
        },
      )
    }
    const listen = (p, host) =>
      new Promise((resolve, reject) => {
        const server = net.createServer(onConnection)
        server.once('error', reject)
        server.listen({ port: p, host, ipv6Only: host === '::1' }, () => {
          server.off('error', reject)
          server.on('error', (e) => this.logger.warn?.(`[dsh-devices] port ${port} forward: ${e.message}`))
          resolve(server)
        })
      })
    // "localhost" may resolve to ::1 first (macOS, Node ≥ 17 servers): hold the port on both
    // loopbacks, so a local server on either one counts as taken. Same number as on the
    // device when it is free here, else a free one.
    const bindPair = async (p) => {
      const v4 = await listen(p, '127.0.0.1')
      const actual = v4.address().port
      try {
        const v6 = await listen(actual, '::1')
        return { port: actual, servers: [v4, v6] }
      } catch (error) {
        if (error.code === 'EADDRINUSE') {
          v4.close()
          throw error
        }
        return { port: actual, servers: [v4] } // no IPv6 loopback here
      }
    }
    let bound = null
    for (const candidate of [port, 0, 0, 0]) {
      try {
        bound = await bindPair(candidate)
        break
      } catch (error) {
        if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error
      }
    }
    if (!bound) throw new Error(`no free local port for device port ${port}`)
    entry.localPort = bound.port
    entry.servers = bound.servers
    this.forwards.set(key, entry)
    this.onChange()
    return entry.localPort
  }

  close(deviceId, remotePort, { dismiss = true } = {}) {
    const key = PortForwards.key(deviceId, remotePort)
    const entry = this.forwards.get(key)
    if (dismiss) this.dismissed.add(key)
    if (!entry) return false
    for (const s of entry.sockets) s.destroy()
    for (const server of entry.servers) server.close()
    this.forwards.delete(key)
    this.onChange()
    return true
  }

  closeDevice(deviceId) {
    for (const entry of [...this.forwards.values()]) if (entry.deviceId === deviceId) this.close(deviceId, entry.remotePort, { dismiss: false })
    for (const key of [...this.dismissed]) if (key.startsWith(`${deviceId}:`)) this.dismissed.delete(key)
  }

  /**
   * Follow a device's port list: forward new agent-started ports
   * automatically, stop automatic forwards whose server went away.
   */
  async reconcile(deviceId, ports, { auto }) {
    const live = new Set((ports ?? []).map((p) => Number(p.port)))
    for (const entry of [...this.forwards.values()]) {
      if (entry.deviceId === deviceId && entry.auto && !live.has(entry.remotePort)) this.close(deviceId, entry.remotePort, { dismiss: false })
    }
    for (const key of [...this.dismissed]) {
      const [id, p] = key.split(':')
      if (id === deviceId && !live.has(Number(p))) this.dismissed.delete(key)
    }
    if (!auto) return
    // Automatic forwarding is for servers the agent started (`fromAgent`); other ports wait for a click.
    for (const p of ports ?? []) {
      if (p.fromAgent === false && !p.inWorkspace) continue
      const port = Number(p.port)
      const key = PortForwards.key(deviceId, port)
      if (this.forwards.has(key) || this.dismissed.has(key)) continue
      await this.forward(deviceId, port, { auto: true }).catch((e) => this.logger.warn?.(`[dsh-devices] auto-forward ${port}: ${e.message}`))
    }
  }

  /** Device port → local port, for one device. */
  map(deviceId) {
    const out = {}
    for (const entry of this.forwards.values()) if (entry.deviceId === deviceId) out[String(entry.remotePort)] = entry.localPort
    return out
  }

  list(deviceId) {
    return [...this.forwards.values()]
      .filter((e) => e.deviceId === deviceId)
      .map((e) => ({ remotePort: e.remotePort, localPort: e.localPort, auto: e.auto, connections: e.sockets.size }))
  }

  dispose() {
    for (const entry of [...this.forwards.values()]) this.close(entry.deviceId, entry.remotePort, { dismiss: false })
  }
}
