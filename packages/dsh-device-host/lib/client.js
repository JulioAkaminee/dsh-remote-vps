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
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const inject = ['uiWorkspace', 'slots']
    let React = null
    try {
      React = require('react')
    } catch {}

    /** "Remote · <device>" in the embedded session header (official header slot). */
    function mountHeaderBadge(ctx, deviceName) {
      if (!React || !ctx.slots) return () => {}
      const h = React.createElement
      function RemoteBadge() {
        return h(
          'span',
          {
            title: deviceName,
            style: {
              display: 'inline-flex', alignItems: 'center', gap: '6px', height: '24px', padding: '0 10px', borderRadius: '999px',
              fontSize: '12px', lineHeight: '24px', whiteSpace: 'nowrap', color: 'rgb(65,118,230)',
              background: 'color-mix(in srgb, rgb(65,118,230) 10%, transparent)', border: '1px solid color-mix(in srgb, rgb(65,118,230) 28%, transparent)',
            },
          },
          h(
            'svg',
            { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
            h('rect', { x: 1.5, y: 6.5, width: 10, height: 7.5, rx: 1.6, stroke: 'currentColor' }),
            h('path', { d: 'M4 10.25h.01M6.5 10.25h3', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
            h('path', { d: 'M10.2 3.6a3.3 3.3 0 0 1 3.3 3.3M10.2 1.6a5.3 5.3 0 0 1 5.3 5.3', stroke: 'currentColor', strokeLinecap: 'round' }),
          ),
          deviceName,
        )
      }
      try {
        return ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-device-remote-badge', order: -100 }, RemoteBadge),
        )
      } catch {
        return () => {}
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
          if (msg.type === 'open-settings') openSettings(ctx)
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
        if (deviceName) mountHeaderBadge(ctx, deviceName)
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
