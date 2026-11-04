// Change feed for the device's session list: a revision counter bumped by
// session events (coalesced), long-poll waiters, and a small ring of recent
// turn ends so the desktop can notify about finished turns precisely.

export class RevisionFeed {
  /**
   * @param {{ coalesceMs?: number, maxTurnEnds?: number, now?: () => number }} [options]
   */
  constructor({ coalesceMs = 200, maxTurnEnds = 50, now = Date.now } = {}) {
    this.rev = 1
    this.coalesceMs = coalesceMs
    this.maxTurnEnds = maxTurnEnds
    this.now = now
    /** @type {{ seq: number, sessionId: string, reason: string, at: number }[]} */
    this.turnEnds = []
    this.turnSeq = 0
    /** Sessions that started waiting for the user. @type {{ seq: number, sessionId: string, kind: string, toolName: string|null, at: number }[]} */
    this.attention = []
    this.attSeq = 0
    /** @type {Set<() => void>} */
    this.waiters = new Set()
    this._timer = null
    this.disposed = false
  }

  /** Mark the session list as changed; waiters wake after a short coalescing window. */
  bump() {
    if (this.disposed || this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      this.rev += 1
      for (const wake of [...this.waiters]) wake()
    }, this.coalesceMs)
  }

  /** Record a finished turn (and bump). */
  turnEnded(sessionId, reason) {
    this.turnSeq += 1
    this.turnEnds.push({ seq: this.turnSeq, sessionId, reason: reason || '', at: this.now() })
    if (this.turnEnds.length > this.maxTurnEnds) this.turnEnds.splice(0, this.turnEnds.length - this.maxTurnEnds)
    this.bump()
  }

  /** Turn ends after `since` (a turn sequence number). */
  turnEndsSince(since) {
    const s = Number(since)
    return Number.isFinite(s) ? this.turnEnds.filter((e) => e.seq > s) : []
  }

  /** Record that a session now waits for the user (and bump). */
  needsAttention(sessionId, kind, toolName) {
    this.attSeq += 1
    this.attention.push({ seq: this.attSeq, sessionId, kind, toolName: toolName || null, at: this.now() })
    if (this.attention.length > this.maxTurnEnds) this.attention.splice(0, this.attention.length - this.maxTurnEnds)
    this.bump()
  }

  /** Attention events after `since`. */
  attentionSince(since) {
    const s = Number(since)
    return Number.isFinite(s) ? this.attention.filter((e) => e.seq > s) : []
  }

  /**
   * Resolve when the revision differs from `rev`, or after `timeoutMs`.
   * @returns {Promise<boolean>} whether it changed
   */
  wait(rev, timeoutMs, signal) {
    if (this.disposed || Number(rev) !== this.rev) return Promise.resolve(Number(rev) !== this.rev)
    return new Promise((resolve) => {
      let timer
      const done = (changed) => {
        clearTimeout(timer)
        this.waiters.delete(wake)
        signal?.removeEventListener?.('abort', abort)
        resolve(changed)
      }
      const wake = () => done(true)
      const abort = () => done(false)
      this.waiters.add(wake)
      timer = setTimeout(() => done(false), Math.max(0, timeoutMs))
      signal?.addEventListener?.('abort', abort, { once: true })
    })
  }

  dispose() {
    this.disposed = true
    clearTimeout(this._timer)
    for (const wake of [...this.waiters]) wake()
    this.waiters.clear()
  }
}
