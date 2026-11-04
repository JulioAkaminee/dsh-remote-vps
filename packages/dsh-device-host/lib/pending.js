// Which sessions are waiting for the user, folded from the session events the
// agent writes on this device:
//   approval/asked { id, toolName, reason? }  → waiting for an approval
//   approval/decided { id }                   → answered
//   tool/call  { name: 'ask_user_question', callId } → waiting for an answer
//   tool/result { message.toolCallId }        → answered, unless the result is a
//                                               "pending" marker (the question
//                                               outlives the turn, "continued")
//   user/message { source.kind: 'user-question-reply', source.callId } → answered
//   turn/end                                  → approvals and unanswered,
//                                               non-continued questions end with it

const QUESTION_TOOL = 'ask_user_question'
/** Continued questions older than this are dropped (the user moved on). */
const CONTINUED_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** The tool's outcome is unknown (e.g. the host restarted mid-call): the question may still be open. */
const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

function isPendingResult(data) {
  if (data?.error?.code === TOOL_OUTCOME_UNKNOWN) return true
  const content = data?.message?.content
  if (!Array.isArray(content)) return false
  const text = content.find((block) => block?.type === 'text')
  if (!text) return false
  try {
    const parsed = JSON.parse(text.text)
    return !!parsed && typeof parsed === 'object' && parsed.pending === true
  } catch {
    return false
  }
}

export class PendingTracker {
  constructor({ now = Date.now } = {}) {
    this.now = now
    /** @type {Map<string, Map<string, { kind: 'approval'|'question', toolName: string|null, since: number, continued?: boolean }>>} */
    this.bySession = new Map()
  }

  _entries(sessionId) {
    let m = this.bySession.get(sessionId)
    if (!m) {
      m = new Map()
      this.bySession.set(sessionId, m)
    }
    return m
  }

  _drop(sessionId, key) {
    const m = this.bySession.get(sessionId)
    if (!m || !m.delete(key)) return false
    if (m.size === 0) this.bySession.delete(sessionId)
    return true
  }

  /**
   * Fold one session event.
   * @returns {{ changed: boolean, started?: { kind: string, toolName: string|null } }}
   */
  observe(sessionId, event) {
    if (!sessionId || !event || typeof event.type !== 'string') return { changed: false }
    const data = event.data ?? {}
    switch (event.type) {
      case 'approval/asked': {
        if (!data.id) return { changed: false }
        const entry = { kind: 'approval', toolName: typeof data.toolName === 'string' ? data.toolName : null, since: this.now() }
        this._entries(sessionId).set(`a:${data.id}`, entry)
        return { changed: true, started: { kind: entry.kind, toolName: entry.toolName } }
      }
      case 'approval/decided':
        return { changed: !!data.id && this._drop(sessionId, `a:${data.id}`) }
      case 'tool/call': {
        if (data.name !== QUESTION_TOOL || !data.callId) return { changed: false }
        this._entries(sessionId).set(`q:${data.callId}`, { kind: 'question', toolName: QUESTION_TOOL, since: this.now() })
        return { changed: true, started: { kind: 'question', toolName: QUESTION_TOOL } }
      }
      case 'tool/result': {
        const callId = data.message?.toolCallId
        const entry = callId && this.bySession.get(sessionId)?.get(`q:${callId}`)
        if (!entry) return { changed: false }
        if (isPendingResult(data)) {
          entry.continued = true
          return { changed: false }
        }
        return { changed: this._drop(sessionId, `q:${callId}`) }
      }
      case 'user/message': {
        const source = data.source
        if (source?.kind !== 'user-question-reply' || !source.callId) return { changed: false }
        return { changed: this._drop(sessionId, `q:${source.callId}`) }
      }
      case 'turn/end': {
        const m = this.bySession.get(sessionId)
        if (!m) return { changed: false }
        let changed = false
        for (const [key, entry] of [...m]) {
          if (entry.kind === 'question' && entry.continued) continue
          m.delete(key)
          changed = true
        }
        if (m.size === 0) this.bySession.delete(sessionId)
        return { changed }
      }
      default:
        return { changed: false }
    }
  }

  /** The session no longer exists here (deleted, or its agent is gone). */
  forget(sessionId) {
    return this.bySession.delete(sessionId)
  }

  /** What one session waits for: the oldest approval first, else the oldest question. */
  get(sessionId) {
    const m = this.bySession.get(sessionId)
    if (!m) return null
    const cutoff = this.now() - CONTINUED_MAX_AGE_MS
    let best = null
    for (const [key, entry] of [...m]) {
      if (entry.continued && entry.since < cutoff) {
        m.delete(key)
        continue
      }
      const rank = entry.kind === 'approval' ? 0 : 1
      if (!best || rank < best.rank || (rank === best.rank && entry.since < best.entry.since)) best = { rank, entry }
    }
    if (m.size === 0) this.bySession.delete(sessionId)
    if (!best) return null
    return { kind: best.entry.kind, toolName: best.entry.toolName, since: best.entry.since, count: m.size }
  }

  /** Session ids currently waiting. */
  sessions() {
    return [...this.bySession.keys()].filter((id) => this.get(id))
  }
}
