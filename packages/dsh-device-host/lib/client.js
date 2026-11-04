// dsh-device-host browser half: lets a desktop show this device's chats
// inline, next to its local ones.
//
// URL parameters (removed from the address bar after use):
//   ?dsh-embed=1          embedded mode: hide this UI's own sidebar
//   ?dsh-session=<id>     open that session once the UI is ready
//   ?dsh-new=<wsId|1>     start a new session (in that workspace)
//   ?dsh-device=<name>    prefix the window title with the device name
// Messages from the embedding desktop (window.parent):
//   { source: 'dsh-devices', type: 'open-session', sessionId }
//   { source: 'dsh-devices', type: 'new-session', workspaceId? }
// Messages to the desktop:
//   { source: 'dsh-device-host', type: 'ready' | 'session', sessionId? }
window.__ModuleLoader__.load({
  id: 'dsh-device-host',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const inject = ['uiWorkspace']

    const EMBED_CSS = `
html.dsh-device-embed [class*="_sidebarCol"]{display:none!important}
html.dsh-device-embed [class*="_frame"]{grid-template-columns:minmax(0,1fr) auto!important;--dsh-frame-top-clearance:0px}
`

    function retry(fn, label) {
      let attempts = 0
      const run = () => {
        attempts += 1
        try {
          const r = fn()
          if (r && typeof r.catch === 'function') r.catch((e) => console.warn(`[dsh-device-host] ${label}`, e))
        } catch (error) {
          if (attempts < 40) setTimeout(run, 250)
          else console.warn(`[dsh-device-host] ${label}`, error)
        }
      }
      setTimeout(run, 0)
    }

    function apply(ctx) {
      const params = new URLSearchParams(window.location.search)
      const embedded = params.get('dsh-embed') === '1' || window.self !== window.top
      const sessionId = params.get('dsh-session')
      const startNew = params.get('dsh-new')
      const deviceName = params.get('dsh-device')
      for (const k of ['dsh-embed', 'dsh-session', 'dsh-new', 'dsh-device']) params.delete(k)
      const query = params.toString()
      if (query !== window.location.search.slice(1)) {
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
      }

      if (embedded) {
        document.documentElement.classList.add('dsh-device-embed')
        const style = document.createElement('style')
        style.id = 'dsh-device-embed'
        style.textContent = EMBED_CSS
        document.head.appendChild(style)
        ctx.effect(() => () => {
          style.remove()
          document.documentElement.classList.remove('dsh-device-embed')
        }, 'dsh-device-host: embed styles')
      }

      if (deviceName) {
        const base = document.title.replace(/^.* — /, '') || 'DeepSeek Harness'
        const set = () => {
          if (!document.title.startsWith(`${deviceName} — `)) document.title = `${deviceName} — ${base}`
        }
        set()
        const observer = new MutationObserver(set)
        const titleEl = document.querySelector('title')
        if (titleEl) observer.observe(titleEl, { childList: true })
        ctx.effect(() => () => observer.disconnect(), 'dsh-device-host: title')
      }

      const openSession = (id) => retry(() => ctx.uiWorkspace.openSession(id), `open session ${id}`)
      const newSession = (workspaceId) =>
        retry(() => (workspaceId && workspaceId !== '1' ? ctx.uiWorkspace.openWorkspace(workspaceId) : ctx.uiWorkspace.startSession()), 'new session')

      if (sessionId) openSession(sessionId)
      else if (startNew) newSession(startNew)

      if (embedded && window.parent !== window) {
        const post = (msg) => {
          try {
            window.parent.postMessage({ source: 'dsh-device-host', ...msg }, '*')
          } catch {}
        }
        const onMessage = (event) => {
          if (event.source !== window.parent) return
          const msg = event.data
          if (!msg || msg.source !== 'dsh-devices') return
          if (msg.type === 'open-session' && typeof msg.sessionId === 'string') openSession(msg.sessionId)
          if (msg.type === 'new-session') newSession(typeof msg.workspaceId === 'string' ? msg.workspaceId : undefined)
          if (msg.type === 'ping') post({ type: 'ready' })
        }
        window.addEventListener('message', onMessage)
        // Report the current session so the desktop can highlight its row.
        let last = null
        const timer = setInterval(() => {
          let current = null
          try {
            current = JSON.parse(localStorage.getItem('dsh.sessions.current') || 'null')
          } catch {
            current = localStorage.getItem('dsh.sessions.current')
          }
          const id = typeof current === 'string' ? current : current?.sessionId ?? current?.id ?? null
          if (id !== last) {
            last = id
            post({ type: 'session', sessionId: id })
          }
        }, 1000)
        post({ type: 'ready' })
        ctx.effect(() => () => {
          window.removeEventListener('message', onMessage)
          clearInterval(timer)
        }, 'dsh-device-host: embed bridge')
      }
    }

    exports.name = 'dsh-device-host'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
