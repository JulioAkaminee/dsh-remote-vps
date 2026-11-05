// dsh-device-host browser half: lets a desktop show this device's chats
// inline, next to its local ones.
//
// URL parameters (removed from the address bar after use):
//   ?dsh-embed=1          embedded mode: hide this UI's own sidebar
//   ?dsh-session=<id>     open that session once the UI is ready
//   ?dsh-new=<wsId|1>     start a new session (in that workspace)
//   ?dsh-device=<name>    prefix the window title with the device name
//   ?dsh-panel=<id>       open that panel (Plugins, Automations…) once the UI is ready
// Messages from the embedding desktop (window.parent):
//   { source: 'dsh-devices', type: 'open-session', sessionId, files? }
//   { source: 'dsh-devices', type: 'new-session', workspaceId?, files? }
//   { source: 'dsh-devices', type: 'open-panel', panel }     plugins | schedules | … (answered with 'panel')
//   { source: 'dsh-devices', type: 'open-settings' | 'open-files' }
//   { source: 'dsh-devices', type: 'config', editorLabel, editorTitle }
//   { source: 'dsh-devices', type: 'ports', map: { "<device port>": <desktop port> } }
// Messages to the desktop:
//   { source: 'dsh-device-host', type: 'ready' | 'session', sessionId? }
//   { source: 'dsh-device-host', type: 'open-editor', path?, sessionId?, kind }
//   { source: 'dsh-device-host', type: 'pick-device', rect }
//   { source: 'dsh-device-host', type: 'ensure-port', port }
//   { source: 'dsh-device-host', type: 'panel', panel, ok, error? }   after an open-panel (or ?dsh-panel=)
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

    // Hover previews stay inside this device's authenticated gateway. No history scan,
    // prefetch, desktop paths, or arbitrary URL fetching is involved.
    const IMAGE_LIMIT = 4 * 1024 * 1024
    const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    function imagePath(value, cwd) {
      if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)) return null
      if (/^(?:~|\/\/|[a-z][a-z\d+.-]*:)/i.test(value)) return null
      if (!/\.(?:png|jpe?g|gif|webp)$/i.test(value)) return null
      if (!value.startsWith('/')) {
        if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.startsWith('//')) return null
        value = `${cwd}/${value}`
      }
      const parts = []
      for (const part of value.split('/')) {
        if (part === '..') parts.pop()
        else if (part && part !== '.') parts.push(part)
      }
      return '/' + parts.join('/')
    }
    function imageFileUrl(path) {
      const url = new URL('api/file?path=' + encodeURIComponent(path), document.baseURI)
      return url.origin === window.location.origin ? url.href : null
    }
    function imageTarget(target, cwd) {
      const el = target?.closest?.('button[class*="_fileLink"], a[href]')
      if (!el) return null
      let path
      if (el.tagName === 'BUTTON') {
        if (!el.closest('[data-tool="read_image"]')) return null
        path = el.textContent
        // Tool summaries may show original relative arguments even when the recorded
        // canonical file differs. That hidden metadata is not available in this DOM.
        if (!path?.startsWith('/') || path.startsWith('//')) return null
      } else {
        const href = el.getAttribute('href')
        if (!href) return null
        // Only the exact local file endpoint may be an HTTP URL.
        const url = new URL(href, document.baseURI)
        const api = new URL('api/file', document.baseURI)
        if (url.origin === window.location.origin && url.origin === api.origin && url.pathname === api.pathname) {
          path = url.searchParams.get('path')
        } else if (/^file:\/\/\//i.test(href)) {
          if (url.hostname) return null
          try { path = decodeURIComponent(url.pathname) } catch { return null }
        } else {
          if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href) || href.includes('?')) return null
          try { path = decodeURIComponent(href.replace(/#L\d+(?:-L?\d+)?$/, '')) } catch { return null }
        }
      }
      path = imagePath(path, cwd)
      return path ? { el, path } : null
    }
    async function readHoverImage(url, signal) {
      const response = await fetch(url, { signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
      const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      const reader = response.body?.getReader()
      try {
        if (!response.ok || !IMAGE_MIMES.has(mime)) throw new Error('Image unavailable')
        if (Number(response.headers.get('content-length')) > IMAGE_LIMIT) throw new Error('Image exceeds 4 MiB')
        if (!reader) throw new Error('Image stream unavailable')
        const chunks = []
        let size = 0
        for (;;) {
          if (signal.aborted) throw new Error('Image cancelled')
          const { done, value } = await reader.read()
          if (signal.aborted) throw new Error('Image cancelled')
          if (done) break
          size += value.byteLength
          if (size > IMAGE_LIMIT) throw new Error('Image exceeds 4 MiB')
          chunks.push(value)
        }
        return new Blob(chunks, { type: mime })
      } finally {
        if (reader) {
          try { await reader.cancel() } catch {}
          reader.releaseLock()
        }
      }
    }
    function mountImageHover(ctx) {
      const cache = new Map()
      let cacheBytes = 0
      let active = null, popup = null, delay = null, request = null, expiry = null, generation = 0, disposed = false
      const selection = ctx.uiWorkspace?.selection
      const session = () => {
        const value = selection?.getSnapshot?.()
        return (typeof value === 'string' ? value : value?.sessionId ?? value?.id) || currentSessionId()
      }
      const cwd = (id) => ctx.uiWorkspace?.sessions?.list?.getSnapshot?.()?.byId?.[id]?.cwd
      const evict = (key) => {
        const entry = cache.get(key)
        if (!entry) return
        cache.delete(key)
        cacheBytes -= entry.size
        URL.revokeObjectURL(entry.url)
      }
      const prune = () => {
        for (const [key, entry] of cache) if (entry.until <= Date.now()) evict(key)
        clearTimeout(expiry)
        expiry = cache.size ? setTimeout(prune, Math.max(1, Math.min(...Array.from(cache.values(), (entry) => entry.until)) - Date.now())) : null
      }
      const cancel = () => {
        generation++
        clearTimeout(delay)
        delay = null
        request?.abort()
        request = null
        active = null
        popup?.remove()
        popup = null
      }
      const position = (el) => {
        if (!popup) return
        const r = el.getBoundingClientRect()
        const width = popup.offsetWidth, height = popup.offsetHeight
        popup.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`
        popup.style.top = `${Math.max(8, Math.min(r.bottom + 8, window.innerHeight - height - 8))}px`
      }
      const show = async (item, id, seq, selected) => {
        if (disposed || seq !== generation || selected !== session() || !item.el.isConnected) return
        const url = imageFileUrl(item.path)
        if (!url) return
        popup = document.createElement('div')
        popup.setAttribute('data-dsh-image-hover', '')
        popup.setAttribute('data-state', 'loading')
        popup.setAttribute('role', 'status')
        popup.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:hidden;padding:8px;border:1px solid #6666;border-radius:8px;background:var(--dsw-alias-background-primary,#202124);color:var(--dsw-alias-label-primary,#fff);box-shadow:0 4px 20px #0004;font:12px/1.4 sans-serif'
        popup.textContent = 'Loading image…'
        document.body.appendChild(popup)
        position(item.el)
        const key = `${id}\n${url}`
        let controller, timeout
        const valid = () => !disposed && seq === generation && selected === session() && item.el.isConnected
        try {
          prune()
          let entry = cache.get(key)
          if (!entry) {
            controller = new AbortController()
            request = controller
            timeout = setTimeout(() => controller.abort(), 8000)
            const blob = await readHoverImage(url, controller.signal)
            if (!valid() || controller.signal.aborted) return
            entry = { url: URL.createObjectURL(blob), size: blob.size, until: Date.now() + 30_000 }
            cache.set(key, entry)
            cacheBytes += entry.size
            while (cache.size > 8 || cacheBytes > 8 * 1024 * 1024) evict(cache.keys().next().value)
            prune()
          } else {
            cache.delete(key)
            cache.set(key, entry)
          }
          if (!valid()) return
          const img = document.createElement('img')
          img.alt = item.path.split('/').pop()
          img.style.cssText = 'display:block;max-width:min(320px,calc(100vw - 32px));max-height:min(240px,calc(100vh - 32px));object-fit:contain'
          img.onload = () => { if (valid()) position(item.el) }
          img.onerror = () => {
            evict(key)
            if (valid()) { popup.textContent = 'Image unavailable'; popup.setAttribute('data-state', 'error'); position(item.el) }
          }
          img.src = entry.url
          popup.textContent = ''
          popup.appendChild(img)
          popup.setAttribute('data-state', 'ready')
          position(item.el)
        } catch (error) {
          if (valid()) {
            popup.textContent = controller?.signal.aborted ? 'Image preview timed out' : error.message === 'Image exceeds 4 MiB' ? error.message : 'Image unavailable'
            popup.setAttribute('data-state', 'error')
            position(item.el)
          }
        } finally {
          clearTimeout(timeout)
          if (request === controller) request = null
        }
      }
      const enter = (event) => {
        if (disposed || event.pointerType === 'touch') return
        let item, id
        try {
          id = event.target?.closest?.('[data-conversation-session]')?.dataset.conversationSession
          if (!id) return
          item = imageTarget(event.target, cwd(id))
        } catch { return }
        if (!item || active?.el === item.el) return
        cancel()
        active = item
        const seq = generation, selected = session()
        delay = setTimeout(() => { delay = null; void show(item, id, seq, selected) }, 200)
      }
      const leave = (event) => {
        if (active?.el.contains(event.target) && !active.el.contains(event.relatedTarget)) cancel()
      }
      const keydown = (event) => { if (event.key === 'Escape') cancel() }
      const visibility = () => { if (document.hidden) cancel() }
      const bindings = [[document, 'pointerover', enter], [document, 'pointerout', leave], [document, 'focusin', enter], [document, 'focusout', leave], [document, 'keydown', keydown], [document, 'scroll', cancel], [document, 'visibilitychange', visibility], [window, 'blur', cancel], [window, 'resize', cancel]]
      for (const [target, event, handler] of bindings) target.addEventListener(event, handler, true)
      let lastSession = session()
      const off = selection?.subscribe?.(() => {
        const id = session()
        if (id === lastSession) return
        lastSession = id
        cancel()
        for (const key of cache.keys()) evict(key)
        prune()
      })
      return () => {
        disposed = true
        cancel()
        clearTimeout(expiry)
        if (typeof off === 'function') off()
        for (const [target, event, handler] of bindings) target.removeEventListener(event, handler, true)
        for (const key of cache.keys()) evict(key)
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
    /** Whether this DSH tells which main panel is on screen (if not, a quiet selectPanel is trusted). */
    function knowsActivePanel(ctx) {
      try {
        const layout = ctx.get ? ctx.get('layout') : ctx.layout
        return typeof layout?.panelInfo?.getSnapshot === 'function'
      } catch {
        return false
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

    /** Run `fn` until it stops throwing (the UI may still be booting), for up to `timeoutMs`. */
    function retry(fn, label, { onDone, onFail, timeoutMs = 10_000 } = {}) {
      const deadline = Date.now() + timeoutMs
      const run = () => {
        try {
          const r = fn()
          if (r && typeof r.then === 'function') {
            r.then(
              () => onDone && onDone(),
              (e) => {
                console.warn(`[dsh-device-host] ${label}`, e)
                if (onFail) onFail(e)
              },
            )
          } else if (onDone) onDone()
        } catch (error) {
          if (Date.now() < deadline) setTimeout(run, 250)
          else {
            console.warn(`[dsh-device-host] ${label}`, error)
            if (onFail) onFail(error)
          }
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
      const panelParam = params.get('dsh-panel')
      for (const k of ['dsh-embed', 'dsh-session', 'dsh-new', 'dsh-device', 'dsh-files', 'dsh-panel']) params.delete(k)
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
      // Each navigation supersedes the previous one: a slow one still retrying (e.g. a
      // panel waiting for its plugin) must not pull the UI back after a newer click.
      let navSeq = 0
      const openSession = (id) => {
        const seq = ++navSeq
        retry(
          () => {
            if (seq !== navSeq) return undefined
            leavePanel()
            return ctx.uiWorkspace.openSession(id)
          },
          `open session ${id}`,
          { timeoutMs: 30_000 },
        )
      }
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
        const seq = ++navSeq
        const specific = !!workspaceId && workspaceId !== '1'
        const started = Date.now()
        const run = () => {
          if (seq !== navSeq) return undefined
          if (!ctx.uiWorkspace) throw new Error('workspace UI not ready')
          leavePanel()
          if (specific && !workspaceKnown(workspaceId) && Date.now() - started < 10_000) {
            setTimeout(() => retry(run, 'new session'), 250)
            return undefined
          }
          // DSH's own "+" of a workspace: startSession(workspaceId). With a target it never falls
          // back to the current or most recent workspace (that would start the chat in another project).
          return specific ? ctx.uiWorkspace.startSession(workspaceId) : ctx.uiWorkspace.startSession()
        }
        retry(run, 'new session', { timeoutMs: 30_000 })
      }
      // Tell the desktop how it went, so it can show the panel, or say why not. A panel
      // registers when its plugin has loaded, which can take a while over a slow link.
      const openPanel = (panel) => {
        const seq = ++navSeq
        retry(
          () => {
            if (seq !== navSeq) return
            selectPanel(ctx, panel)
            if (knowsActivePanel(ctx) && activePanel(ctx) !== panel) throw new Error(`panel ${panel} did not open`)
          },
          `open panel ${panel}`,
          {
            timeoutMs: 60_000,
            onDone: () => seq === navSeq && postToDesktop({ type: 'panel', panel, ok: true }),
            onFail: (e) => seq === navSeq && postToDesktop({ type: 'panel', panel, ok: false, error: String((e && e.message) || e) }),
          },
        )
      }

      // Files after the session switch: opening the tab first would land on the previous surface.
      const openFilesSoon = () => setTimeout(() => openFiles(ctx), 700)
      if (panelParam && /^[\w.-]{1,64}$/.test(panelParam)) openPanel(panelParam)
      else if (sessionId) openSession(sessionId)
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
        ctx.effect(() => mountImageHover(ctx), 'dsh-device-host: image hover')
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
