// dsh-device-host browser half: lets a desktop show this device's chats
// inline, next to its local ones.
//
// URL parameters (removed from the address bar after use):
//   ?dsh-embed=1          embedded mode: hide this UI's own sidebar
//   ?dsh-session=<id>     open that session once the UI is ready
//   ?dsh-new=<wsId|1>     start a new session (in that workspace)
//   ?dsh-device=<name>    prefix the window title with the device name
// Messages from the embedding desktop (window.parent):
//   { source: 'dsh-devices', type: 'open-session', sessionId, files? }
//   { source: 'dsh-devices', type: 'new-session', workspaceId?, files? }
//   { source: 'dsh-devices', type: 'open-panel', panel }     plugins | schedules | …
//   { source: 'dsh-devices', type: 'open-settings' | 'open-files' }
//   { source: 'dsh-devices', type: 'config', editorLabel, editorTitle }
//   { source: 'dsh-devices', type: 'ports', map: { "<device port>": <desktop port> } }
// Messages to the desktop:
//   { source: 'dsh-device-host', type: 'ready' | 'session', sessionId? }
//   { source: 'dsh-device-host', type: 'open-editor', path?, sessionId?, kind }
//   { source: 'dsh-device-host', type: 'pick-device', rect }
//   { source: 'dsh-device-host', type: 'ensure-port', port }
window.__ModuleLoader__.load({
  id: 'dsh-device-host',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const inject = ['uiWorkspace', 'slots']
    // `layout` and `sidebarRight` are read lazily with ctx.get (optional services).
    let React = null
    let P = {}
    try {
      React = require('react')
    } catch {}
    try {
      P = require('@deepseek-ai/dsh-client-ui-primitives') || {}
    } catch {}

    // ── "Open in <editor>" on the desktop (Remote-SSH), where DSH puts "Open in…" ──
    let editorLabel = 'Editor'
    let editorTitle = 'Open in the editor on your computer (Remote-SSH)'
    const labelListeners = new Set()
    function setEditorLabel(label, title) {
      if (title) editorTitle = title
      if (!label || label === editorLabel) return
      editorLabel = label
      for (const l of labelListeners) l(label)
    }
    function postToDesktop(msg) {
      try {
        window.parent.postMessage({ source: 'dsh-device-host', ...msg }, '*')
      } catch {}
    }
    function currentSessionId() {
      try {
        const v = JSON.parse(localStorage.getItem('dsh.sessions.current') || 'null')
        return typeof v === 'string' ? v : v?.sessionId ?? v?.id ?? undefined
      } catch {
        return undefined
      }
    }
    function EditorIcon() {
      const h = React.createElement
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M11.5 1.8 6 7.2 3.2 5 1.8 5.8v4.4l1.4.8L6 8.8l5.5 5.4 2.7-1.3V3.1z', stroke: 'currentColor', strokeWidth: 1.1, strokeLinejoin: 'round' }),
        h('path', { d: 'M11.5 5.2 8.3 8l3.2 2.8z', fill: 'currentColor', opacity: 0.3 }),
      )
    }
    function OpenInEditorButton(props) {
      const h = React.createElement
      const [label, setLabel] = React.useState(editorLabel)
      React.useEffect(() => {
        labelListeners.add(setLabel)
        return () => labelListeners.delete(setLabel)
      }, [])
      const cwd = typeof props.useSessions === 'function' && props.sessionId ? props.useSessions((st) => st?.byId?.[props.sessionId]?.cwd) : undefined
      const target = props.absolutePath || cwd
      const title = editorTitle.replace('{editor}', label)
      const onClick = (e) => {
        e?.stopPropagation?.()
        postToDesktop({ type: 'open-editor', path: target || undefined, sessionId: props.sessionId || currentSessionId(), kind: props.kind })
      }
      const inner = [h(EditorIcon, { key: 'i' }), h('span', { key: 't', style: { marginLeft: 6, whiteSpace: 'nowrap' } }, label)]
      return P.Button
        ? h(P.Button, { size: 'sm', variant: 'ghost', title, 'aria-label': title, 'data-dsh-open-editor': props.kind, onClick, style: { whiteSpace: 'nowrap', flexShrink: 0 } }, inner)
        : h('button', { type: 'button', title, 'aria-label': title, 'data-dsh-open-editor': props.kind, onClick, style: { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 0, font: 'inherit', fontSize: 12, cursor: 'pointer', color: 'inherit', padding: '4px 8px', borderRadius: 8 } }, inner)
    }
    function mountOpenInEditor(ctx) {
      if (!React || !ctx.slots) return
      const seats = [
        ['conversation.session.header.utilities', 'session'],
        ['sidebar.right.tab.files.actions', 'folder'],
        ['sidebar.right.tab.document.actions', 'file'],
      ]
      for (const [slot, kind] of seats) {
        const Component = (props) => React.createElement(OpenInEditorButton, { ...props, kind })
        try {
          ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id: 'dsh-device-open-editor', order: -20 }, Component))
        } catch {}
      }
    }
    // ── dev-server links: "localhost:<device port>" → this desktop's forwarded port ──
    let portMap = {}
    const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'])
    function rewriteLoopbackUrl(href) {
      let url
      try {
        url = new URL(href, window.location.href)
      } catch {
        return null
      }
      if (!/^https?:$/.test(url.protocol) || !LOOPBACK.has(url.hostname)) return null
      const remotePort = url.port || (url.protocol === 'https:' ? '443' : '80')
      // The device UI itself is served from the desktop's loopback gateway: leave it alone.
      if (url.origin === window.location.origin) return null
      const local = portMap[remotePort]
      if (!local) return { url: null, remotePort: Number(remotePort) }
      url.hostname = 'localhost'
      url.port = String(local)
      return { url: url.toString(), remotePort: Number(remotePort) }
    }
    function mountLinkRewrite() {
      const onClick = (event) => {
        const a = event.target && event.target.closest ? event.target.closest('a[href]') : null
        if (!a) return
        const r = rewriteLoopbackUrl(a.getAttribute('href'))
        if (!r) return
        if (r.url) a.setAttribute('href', r.url)
        else postToDesktop({ type: 'ensure-port', port: r.remotePort })
      }
      document.addEventListener('click', onClick, true)
      document.addEventListener('auxclick', onClick, true)
      return () => {
        document.removeEventListener('click', onClick, true)
        document.removeEventListener('auxclick', onClick, true)
      }
    }

    function selectPanel(ctx, panel) {
      const layout = ctx.get ? ctx.get('layout') : ctx.layout
      if (!layout || typeof layout.selectPanel !== 'function') throw new Error('layout not ready')
      layout.selectPanel(panel)
    }
    function activePanel(ctx) {
      try {
        const layout = ctx.get ? ctx.get('layout') : ctx.layout
        return layout?.panelInfo?.getSnapshot?.()?.activePanelId ?? null
      } catch {
        return null
      }
    }

    function openFiles(ctx) {
      retry(() => {
        const sr = ctx.get ? ctx.get('sidebarRight') : ctx.sidebarRight
        if (!sr || typeof sr.openTab !== 'function') throw new Error('right sidebar not ready')
        sr.openTab('files')
      }, 'open files')
    }

    /**
     * "<device>" next to the session mode label ("Standard mode") in the
     * embedded session header, drawn like that label.
     */
    const BADGE_CSS = `.dsh-device-badge{border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-fill-tsp-secondary);max-width:180px;height:22px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;align-items:center;gap:4px;padding:0 6px 0 4px;font-size:12px;line-height:22px;display:inline-flex;overflow:hidden;flex:none}.dsh-device-badge svg{opacity:.7;flex:none}@container (width<=540px){.dsh-device-badge{display:none}}`
    function mountHeaderBadge(ctx, deviceName) {
      if (!React || !ctx.slots) return () => {}
      const h = React.createElement
      const style = document.createElement('style')
      style.textContent = BADGE_CSS
      document.head.appendChild(style)
      function RemoteBadge() {
        return h(
          'span',
          { className: 'dsh-device-badge', title: deviceName, 'data-dsh-device-badge': '1' },
          h(
            'svg',
            { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
            h('rect', { x: 1.75, y: 6.75, width: 9.5, height: 7, rx: 1.75 }),
            h('path', { d: 'M4.25 10.25h.01M6.75 10.25h2.5' }),
            h('path', { d: 'M10.4 3.9a3 3 0 0 1 2.7 2.7M10.4 1.75a5.1 5.1 0 0 1 4.85 4.85' }),
          ),
          deviceName,
        )
      }
      let off = () => {}
      try {
        off = ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register({ name: 'conversation.session.header.actions', id: 'dsh-device-remote-badge', order: -100 }, RemoteBadge),
        )
      } catch {}
      return () => {
        off()
        style.remove()
      }
    }

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

    /** Open this UI's Settings (its sidebar is hidden while embedded). */
    function openSettings(ctx) {
      const dialogs = () => document.querySelectorAll('[role=dialog]').length
      const before = dialogs()
      try {
        const shortcuts = ctx.get ? ctx.get('shortcuts') : undefined
        const entries = shortcuts?.catalog?.getSnapshot?.() ?? []
        const binding = entries.find((e) => e.id === 'settings.open')?.binding
        if (binding?.code) {
          const mods = new Set(binding.modifiers ?? [])
          const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
          const primary = mods.has('primary')
          const init = {
            code: binding.code,
            key: binding.code === 'Comma' ? ',' : binding.code.replace(/^Key/, '').toLowerCase(),
            metaKey: mods.has('meta') || (primary && mac),
            ctrlKey: mods.has('ctrl') || mods.has('control') || (primary && !mac),
            altKey: mods.has('alt'),
            shiftKey: mods.has('shift'),
            bubbles: true,
            cancelable: true,
          }
          ;(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', init))
        }
      } catch {}
      // Fallback: the hidden sidebar's own Settings control.
      setTimeout(() => {
        if (dialogs() > before) return
        const trigger = document.querySelector('[data-slot="sidebar.settings"] button')
        if (!trigger) return
        trigger.click()
        setTimeout(() => {
          if (dialogs() > before) return
          const item = [...document.querySelectorAll('[role=menuitem]')].find((el) => /settings|configura|设置|ajustes|preferen/i.test(el.textContent || ''))
          if (item) item.click()
        }, 250)
      }, 300)
    }

    /** While embedded: a device pill before the workspace chooser lets the desktop switch devices. */
    function mountDevicePill(ctx, deviceName) {
      const icon = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="color:rgb(65,118,230)"><rect x="1.5" y="6.5" width="10" height="7.5" rx="1.6" fill="currentColor" opacity="0.16"/><rect x="1.5" y="6.5" width="10" height="7.5" rx="1.6" stroke="currentColor"/><path d="M4 10.25h.01M6.5 10.25h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M10.2 3.6a3.3 3.3 0 0 1 3.3 3.3M10.2 1.6a5.3 5.3 0 0 1 5.3 5.3" stroke="currentColor" stroke-linecap="round"/></svg>'
      const chevron = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2.5 4l2.5 2.5L7.5 4" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      const place = () => {
        for (const chooser of document.querySelectorAll('button[aria-haspopup="menu"]:not([data-dsh-device-pill])')) {
          if (![...chooser.classList].some((c) => /_workspace$/.test(c))) continue
          const prev = chooser.previousElementSibling
          if (prev && prev.getAttribute('data-dsh-device-pill') === '1') continue
          const pill = document.createElement('button')
          pill.type = 'button'
          pill.className = chooser.className
          pill.style.marginRight = '6px'
          pill.setAttribute('data-dsh-device-pill', '1')
          pill.setAttribute('aria-haspopup', 'menu')
          const labelCls = chooser.querySelector('[class*="_workspaceLabel"]')?.className || ''
          pill.innerHTML = `${icon}<span class="${labelCls}"></span>${chevron}`
          pill.querySelector('span').textContent = deviceName
          pill.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            const r = pill.getBoundingClientRect()
            window.parent.postMessage({ source: 'dsh-device-host', type: 'pick-device', rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }, '*')
          })
          chooser.parentElement.insertBefore(pill, chooser)
        }
      }
      let queued = false
      const observer = new MutationObserver(() => {
        if (queued) return
        queued = true
        requestAnimationFrame(() => {
          queued = false
          place()
        })
      })
      observer.observe(document.body, { childList: true, subtree: true })
      place()
      return () => observer.disconnect()
    }

    function apply(ctx) {
      const params = new URLSearchParams(window.location.search)
      const embedded = params.get('dsh-embed') === '1' || window.self !== window.top
      const sessionId = params.get('dsh-session')
      const startNew = params.get('dsh-new')
      const deviceName = params.get('dsh-device')
      const filesAfter = params.get('dsh-files') === '1'
      for (const k of ['dsh-embed', 'dsh-session', 'dsh-new', 'dsh-device', 'dsh-files']) params.delete(k)
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

      // A device panel (Plugins, Automations…) may cover the chat: leave it first.
      const leavePanel = () => {
        if (activePanel(ctx) === null) return
        try {
          selectPanel(ctx, null)
        } catch {}
      }
      const openSession = (id) =>
        retry(() => {
          leavePanel()
          return ctx.uiWorkspace.openSession(id)
        }, `open session ${id}`)
      // A freshly booted UI loads its workspace list asynchronously: wait for the
      // workspace to be known before opening it (else DSH reports "unknown workspace").
      const workspaceKnown = (id) => {
        try {
          return !!ctx.uiWorkspace?.workspaces?.list?.getSnapshot?.()?.items?.some((w) => w.workspaceId === id)
        } catch {
          return false
        }
      }
      const newSession = (workspaceId) => {
        const specific = !!workspaceId && workspaceId !== '1'
        const started = Date.now()
        const run = () => {
          if (!ctx.uiWorkspace) throw new Error('workspace UI not ready')
          leavePanel()
          if (specific && !workspaceKnown(workspaceId) && Date.now() - started < 10_000) {
            setTimeout(() => retry(run, 'new session'), 250)
            return undefined
          }
          return specific && workspaceKnown(workspaceId) ? ctx.uiWorkspace.openWorkspace(workspaceId) : ctx.uiWorkspace.startSession()
        }
        retry(run, 'new session')
      }
      const openPanel = (panel) => retry(() => selectPanel(ctx, panel), `open panel ${panel}`)

      // Files after the session switch: opening the tab first would land on the previous surface.
      const openFilesSoon = () => setTimeout(() => openFiles(ctx), 700)
      if (sessionId) openSession(sessionId)
      else if (startNew) newSession(startNew)
      if (filesAfter && (sessionId || startNew)) openFilesSoon()

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
          if (msg.type === 'open-session' && typeof msg.sessionId === 'string') {
            openSession(msg.sessionId)
            if (msg.files) openFilesSoon()
          }
          if (msg.type === 'new-session') {
            newSession(typeof msg.workspaceId === 'string' ? msg.workspaceId : undefined)
            if (msg.files) openFilesSoon()
          }
          if (msg.type === 'ping') post({ type: 'ready' })
          if (msg.type === 'open-settings') openSettings(ctx)
          if (msg.type === 'open-files') openFiles(ctx)
          if (msg.type === 'open-panel' && typeof msg.panel === 'string' && /^[\w.-]{1,64}$/.test(msg.panel)) openPanel(msg.panel)
          if (msg.type === 'config' && typeof msg.editorLabel === 'string') setEditorLabel(msg.editorLabel, msg.editorTitle)
          if (msg.type === 'ports' && msg.map && typeof msg.map === 'object') portMap = { ...msg.map }
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
        ctx.effect(() => mountDevicePill(ctx, deviceName || 'Device'), 'dsh-device-host: device pill')
        if (deviceName) ctx.effect(() => mountHeaderBadge(ctx, deviceName), 'dsh-device-host: header badge')
        mountOpenInEditor(ctx)
        ctx.effect(() => mountLinkRewrite(), 'dsh-device-host: dev-server links')
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
