// dsh-devices browser half.
//
// • Remote chats live in the same sidebar list as local ones: each device's
//   workspaces are appended below the local workspaces, using the sidebar's
//   own row styles, marked with a remote icon.
// • Selecting a remote chat shows it in the main area of this window. The
//   conversation is rendered by the device's own DSH UI (agent, tools, files,
//   terminal and approvals all run on the device), embedded without its
//   sidebar. Embedded device UIs stay alive, so switching between local and
//   remote chats is instant.
// • The "Devices" panel manages devices: add (SSH or pairing code), rename,
//   update, remove.
//
// Hand-written module in the DSH client module-loader format (no build step).
window.__ModuleLoader__.load({
  id: 'dsh-devices',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const ReactDOMClient = require('react-dom/client')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } = React

    const NS = 'dsh-devices'
    const PANEL_ID = 'dsh-devices'
    const CHAT_PANEL_ID = 'dsh-devices-chat'

    // ── copy ────────────────────────────────────────────────────────────────
    const en = {
      panel: 'Devices',
      title: 'Devices',
      subtitle: 'DSH running on your servers. Their chats appear in your sidebar next to local ones, marked as remote; agents, tools and terminals run on the device.',
      add: 'Add device',
      refresh: 'Refresh',
      empty: 'No devices yet. Add a server over SSH (DSH is installed for you) or pair one with a code from `dsh-device pair`.',
      open: 'Open',
      openWindow: 'Open in new window',
      more: 'More',
      rename: 'Rename',
      remove: 'Remove',
      update: 'Update device',
      updateHint: 'This device runs dsh {remote}; this desktop runs {local}.',
      status_online: 'Online',
      status_connecting: 'Connecting…',
      status_offline: 'Offline',
      status_error: 'Error',
      status_revoked: 'Unpaired on the device',
      lastSeen: 'last seen {when}',
      up: 'up {when}',
      never: 'never',
      sessions: 'Sessions',
      noSessions: 'No sessions yet.',
      untitled: 'Untitled session',
      running: 'running',
      viaSsh: 'SSH · {target}',
      viaUrl: 'URL · {url}',
      addTitle: 'Add a device',
      addDescription: 'The device runs the agent. Choose how this desktop reaches it.',
      tabSsh: 'SSH',
      tabCode: 'Pairing code',
      sshTarget: 'SSH host',
      sshTargetHint: 'An alias from ~/.ssh/config, or user@host[:port]. Uses your ssh-agent and keys.',
      advanced: 'Advanced',
      sshPort: 'Port',
      sshUser: 'User',
      sshKey: 'Identity file',
      deviceName: 'Name (optional)',
      connect: 'Connect',
      codeInput: 'Pairing link or code',
      codeHint: 'Run `dsh-device pair` on the device. Paste the dsh-device:// link, or type the code.',
      codeUrl: 'Device URL',
      codeUrlHint: 'HTTPS address of the device (Tailscale, Cloudflare Tunnel, reverse proxy).',
      pair: 'Pair',
      cancel: 'Cancel',
      close: 'Close',
      done: 'Done',
      working: 'Working…',
      hostKeyTitle: 'Confirm the server identity',
      hostKeyBody: 'First connection to this server. Check that this fingerprint matches the server (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub):',
      trust: 'Trust and continue',
      paired: 'Paired with {name}.',
      renamePrompt: 'Device name',
      removeTitle: 'Remove {name}?',
      removeBody: 'This desktop is unpaired on the device too, when it is reachable. Sessions on the device are kept.',
      save: 'Save',
      openFailed: 'Could not open the device: {error}',
      outdated: 'update available',
      remote: 'Remote',
      remoteOn: 'Remote · {device}',
      newRemote: 'New session on {device}',
      offlineShort: 'offline',
      connecting: 'Connecting to {device}…',
      deviceOffline: '{device} is offline. Its chats come back when it is reachable again.',
      now: 'now',
      savedServers: 'Saved on this computer',
      savedHint: 'Servers already saved in Remote access. Their address, login and accepted host key are reused.',
      savedTitle: 'Saved on this computer — ready to add',
      addSaved: 'Add',
      alreadyAdded: 'added',
      hostKeyKnown: 'host key already trusted',
      menuRemote: 'On your devices',
      menuNewOn: 'New on {device}…',
    }
    const zh = {
      panel: '设备', title: '设备', subtitle: '在你的服务器上运行的 DSH。它们的会话与本地会话一起显示在侧边栏，并标记为远程；代理、工具和终端都在设备上运行。',
      add: '添加设备', refresh: '刷新', empty: '还没有设备。通过 SSH 添加服务器（会自动安装 DSH），或用 `dsh-device pair` 生成的配对码配对。',
      open: '打开', openWindow: '在新窗口打开', more: '更多', rename: '重命名', remove: '移除', update: '更新设备',
      updateHint: '设备运行 dsh {remote}；本机运行 {local}。', status_online: '在线', status_connecting: '连接中…',
      status_offline: '离线', status_error: '错误', status_revoked: '已在设备上解除配对', lastSeen: '最后在线 {when}',
      up: '已运行 {when}', never: '从未', sessions: '会话', noSessions: '还没有会话。', untitled: '未命名会话',
      running: '运行中', viaSsh: 'SSH · {target}', viaUrl: 'URL · {url}', addTitle: '添加设备',
      addDescription: '代理在设备上运行。选择本机如何连接它。', tabSsh: 'SSH', tabCode: '配对码', sshTarget: 'SSH 主机',
      sshTargetHint: '~/.ssh/config 中的别名，或 user@host[:port]。使用 ssh-agent 与本机密钥。', advanced: '高级',
      sshPort: '端口', sshUser: '用户', sshKey: '密钥文件', deviceName: '名称（可选）', connect: '连接',
      codeInput: '配对链接或配对码', codeHint: '在设备上运行 `dsh-device pair`，粘贴 dsh-device:// 链接或输入配对码。',
      codeUrl: '设备地址', codeUrlHint: '设备的 HTTPS 地址（Tailscale、Cloudflare Tunnel 或反向代理）。', pair: '配对',
      cancel: '取消', close: '关闭', done: '完成', working: '处理中…', hostKeyTitle: '确认服务器身份',
      hostKeyBody: '首次连接此服务器。请确认指纹与服务器一致（ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub）：',
      trust: '信任并继续', paired: '已与 {name} 配对。', renamePrompt: '设备名称', removeTitle: '移除 {name}？',
      removeBody: '设备可达时，也会在设备上解除本机配对。设备上的会话会保留。', save: '保存',
      openFailed: '无法打开设备：{error}', outdated: '有更新', remote: '远程', remoteOn: '远程 · {device}',
      newRemote: '在 {device} 上新建会话', offlineShort: '离线', connecting: '正在连接 {device}…',
      deviceOffline: '{device} 离线。恢复连接后会话会重新出现。', now: '刚刚',
      savedServers: '本机已保存', savedHint: '已在远程访问中保存的服务器，将复用其地址、登录方式和已接受的主机密钥。',
      savedTitle: '本机已保存 — 可直接添加', addSaved: '添加', alreadyAdded: '已添加', hostKeyKnown: '主机密钥已信任',
      menuRemote: '你的设备', menuNewOn: '在 {device} 上新建…',
    }

    const ptBR = {
      panel: 'Devices', title: 'Devices',
      subtitle: 'O DSH rodando nos seus servidores. Os chats deles aparecem na barra lateral junto com os locais, marcados como remotos; agente, ferramentas e terminais rodam no device.',
      add: 'Adicionar device', refresh: 'Atualizar',
      empty: 'Nenhum device ainda. Adicione um servidor por SSH (o DSH é instalado para você) ou pareie com um código do `dsh-device pair`.',
      open: 'Abrir', openWindow: 'Abrir em nova janela', more: 'Mais', rename: 'Renomear', remove: 'Remover', update: 'Atualizar device',
      updateHint: 'Este device roda dsh {remote}; este desktop roda {local}.',
      status_online: 'Online', status_connecting: 'Conectando…', status_offline: 'Offline', status_error: 'Erro', status_revoked: 'Despareado no device',
      lastSeen: 'visto há {when}', up: 'ligado há {when}', never: 'nunca', sessions: 'Sessões', noSessions: 'Nenhuma sessão ainda.',
      untitled: 'Sessão sem título', running: 'rodando', viaSsh: 'SSH · {target}', viaUrl: 'URL · {url}',
      addTitle: 'Adicionar device', addDescription: 'O agente roda no device. Escolha como este computador chega até ele.',
      tabSsh: 'SSH', tabCode: 'Código de pareamento', sshTarget: 'Servidor SSH',
      sshTargetHint: 'Um alias do ~/.ssh/config ou usuário@host[:porta]. Usa seu ssh-agent e suas chaves.',
      advanced: 'Avançado: porta, usuário, chave', sshPort: 'Porta', sshUser: 'Usuário', sshKey: 'Arquivo de chave',
      deviceName: 'Nome (opcional)', connect: 'Conectar',
      codeInput: 'Link ou código de pareamento', codeHint: 'Cole o link dsh-device:// ou digite o código.',
      codeUrl: 'Endereço do device', codeUrlHint: 'Endereço HTTPS do device (Tailscale, Cloudflare Tunnel, proxy reverso).',
      pair: 'Parear', cancel: 'Cancelar', close: 'Fechar', done: 'Concluir', working: 'Trabalhando…',
      hostKeyTitle: 'Confirme a identidade do servidor',
      hostKeyBody: 'Primeira conexão com este servidor. Confira se a impressão digital bate com a do servidor (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub):',
      trust: 'Confiar e continuar', paired: 'Pareado com {name}.', renamePrompt: 'Nome do device',
      removeTitle: 'Remover {name}?', removeBody: 'Este computador também é despareado no device, se ele estiver acessível. As sessões no device são mantidas.',
      save: 'Salvar', openFailed: 'Não foi possível abrir o device: {error}', outdated: 'atualização disponível',
      remote: 'Remoto', remoteOn: 'Remoto · {device}', newRemote: 'Nova sessão em {device}', offlineShort: 'offline',
      connecting: 'Conectando a {device}…', deviceOffline: '{device} está offline. Os chats dele voltam quando ele estiver acessível.',
      now: 'agora', savedServers: 'Salvos neste computador',
      savedHint: 'Servidores já salvos no Acesso remoto. Endereço, login e chave aceita são reaproveitados.',
      savedTitle: 'Salvos neste computador — prontos para adicionar', addSaved: 'Adicionar', alreadyAdded: 'adicionado',
      hostKeyKnown: 'chave do servidor já confiável', menuRemote: 'Nos seus devices', menuNewOn: 'Nova em {device}…',
      suggestions: 'Sugestões', fromSshConfig: '~/.ssh/config', trusted: 'confiável',
      codeStep1: 'Na VPS, rode:', codeStep2: 'Cole aqui o link que aparecer (ou o código + o endereço HTTPS).',
      orType: 'ou digite',
    }
    en.suggestions = 'Suggestions'
    en.fromSshConfig = '~/.ssh/config'
    en.trusted = 'trusted'
    en.codeStep1 = 'On the VPS, run:'
    en.codeStep2 = 'Paste the link it prints here (or the code plus the HTTPS address).'
    en.orType = 'or type'
    en.advanced = 'Advanced: port, user, key'
    en.codeHint = 'Paste the dsh-device:// link, or type the code.'
    Object.assign(zh, { suggestions: '建议', fromSshConfig: '~/.ssh/config', trusted: '已信任', codeStep1: '在 VPS 上运行：', codeStep2: '把输出的链接粘贴到这里（或输入配对码和 HTTPS 地址）。', orType: '或输入', advanced: '高级：端口、用户、密钥' })

    function fill(text, vars) {
      return String(text).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ''))
    }

    function shortAgo(ts, t) {
      if (!ts) return ''
      const s = Math.max(0, Math.round((Date.now() - (typeof ts === 'number' ? ts : Date.parse(ts))) / 1000))
      if (s < 60) return t('now')
      if (s < 3600) return `${Math.round(s / 60)}min`
      if (s < 86400) return `${Math.round(s / 3600)}h`
      return `${Math.round(s / 86400)}d`
    }

    function duration(sec) {
      if (sec == null) return ''
      if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m`
      if (sec < 86400) return `${Math.round(sec / 3600)}h`
      return `${Math.round(sec / 86400)}d`
    }

    // ── API ─────────────────────────────────────────────────────────────────
    async function api(path, init) {
      const res = await fetch(`api${path}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(init && init.body ? { 'content-type': 'application/json' } : {}) },
        ...init,
      })
      let body = null
      try {
        body = await res.json()
      } catch {}
      if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`)
      return body
    }
    const post = (path, value) => api(path, { method: 'POST', body: JSON.stringify(value ?? {}) })

    // ── shared store (sidebar root, main panels and Devices page) ───────────
    const store = {
      data: { devices: [], self: null },
      loaded: false,
      error: null,
      /** @type {{ deviceId: string, sessionId: string|null } | null} */
      selection: null,
      /** deviceId -> session currently open inside that device's embedded UI */
      embedded: {},
      activePanel: null,
      collapsed: readCollapsed(),
      version: 0,
      listeners: new Set(),
    }
    function emit() {
      store.version += 1
      for (const l of store.listeners) l()
    }
    function setStore(patch) {
      Object.assign(store, patch)
      emit()
    }
    function subscribe(listener) {
      store.listeners.add(listener)
      if (store.listeners.size === 1) startPolling()
      return () => {
        store.listeners.delete(listener)
        if (store.listeners.size === 0) stopPolling()
      }
    }
    function useStore() {
      useSyncExternalStore(subscribe, () => store.version)
      return store
    }
    let pollTimer = null
    async function refreshDevices() {
      try {
        const data = await api('/devices')
        setStore({ data, loaded: true, error: null })
      } catch (e) {
        setStore({ error: e.message })
      }
    }
    function startPolling() {
      refreshDevices()
      pollTimer = setInterval(refreshDevices, 3000)
    }
    function stopPolling() {
      clearInterval(pollTimer)
      pollTimer = null
    }
    function readCollapsed() {
      try {
        return JSON.parse(localStorage.getItem('dsh-devices.collapsed') || '{}')
      } catch {
        return {}
      }
    }
    function toggleCollapsed(key) {
      const next = { ...store.collapsed, [key]: !store.collapsed[key] }
      try {
        localStorage.setItem('dsh-devices.collapsed', JSON.stringify(next))
      } catch {}
      setStore({ collapsed: next })
    }

    // ── embedded device UIs (kept alive across panel switches) ──────────────
    /** deviceId -> { root: string } gateway root for that device (ends with '/') */
    const entries = new Map()
    async function deviceRoot(deviceId, refresh = false) {
      if (!refresh && entries.has(deviceId)) return entries.get(deviceId)
      const r = await post('/devices/open', { id: deviceId, next: '/' })
      const root = r.url.replace(/\/?$/, '/')
      entries.set(deviceId, root)
      return root
    }

    const frames = {
      host: null,
      /** deviceId -> { iframe, root, ready, pending: [] } */
      byDevice: new Map(),
      active: null,
      placeholder: null,
      observer: null,
      ensureHost() {
        if (this.host) return this.host
        const host = document.createElement('div')
        host.id = 'dsh-devices-frames'
        host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;display:none;z-index:4;overflow:hidden;background:var(--dsw-alias-bg-base,#fff)'
        document.body.appendChild(host)
        this.host = host
        window.addEventListener('message', (event) => this.onMessage(event))
        window.addEventListener('resize', () => this.layout())
        return host
      },
      onMessage(event) {
        const msg = event.data
        if (!msg || msg.source !== 'dsh-device-host') return
        for (const [deviceId, f] of this.byDevice) {
          if (f.iframe.contentWindow !== event.source) continue
          if (msg.type === 'ready') {
            f.ready = true
            for (const m of f.pending.splice(0)) this.send(deviceId, m)
          }
          if (msg.type === 'session') {
            store.embedded = { ...store.embedded, [deviceId]: msg.sessionId || null }
            if (store.selection && store.selection.deviceId === deviceId && msg.sessionId) store.selection = { deviceId, sessionId: msg.sessionId }
            emit()
          }
        }
      },
      send(deviceId, msg) {
        const f = this.byDevice.get(deviceId)
        if (!f) return
        if (!f.ready) {
          f.pending.push(msg)
          return
        }
        f.iframe.contentWindow.postMessage({ source: 'dsh-devices', ...msg }, '*')
      },
      /** Show `deviceId` and run `command` in it: { type: 'open-session', sessionId } | { type: 'new-session', workspaceId } */
      async show(deviceId, device, command) {
        this.ensureHost()
        let f = this.byDevice.get(deviceId)
        if (!f) {
          const root = await deviceRoot(deviceId)
          const params = new URLSearchParams({ 'dsh-embed': '1', 'dsh-device': device ? device.name : '' })
          if (command && command.type === 'open-session' && command.sessionId) params.set('dsh-session', command.sessionId)
          if (command && command.type === 'new-session') params.set('dsh-new', command.workspaceId || '1')
          const iframe = document.createElement('iframe')
          iframe.title = device ? device.name : deviceId
          iframe.allow = 'clipboard-read; clipboard-write'
          iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;display:none;background:transparent'
          iframe.src = `${root}?${params.toString()}`
          this.host.appendChild(iframe)
          f = { iframe, root, ready: false, pending: [] }
          this.byDevice.set(deviceId, f)
          iframe.addEventListener('load', () => {
            // The device UI announces readiness itself; this covers older hosts.
            setTimeout(() => {
              if (!f.ready) {
                f.ready = true
                for (const m of f.pending.splice(0)) this.send(deviceId, m)
              }
            }, 8000)
          })
        } else if (command) this.send(deviceId, command)
        this.active = deviceId
        for (const [id, x] of this.byDevice) x.iframe.style.display = id === deviceId ? 'block' : 'none'
        this.layout()
      },
      drop(deviceId) {
        const f = this.byDevice.get(deviceId)
        if (f) f.iframe.remove()
        this.byDevice.delete(deviceId)
        entries.delete(deviceId)
      },
      attach(el) {
        this.ensureHost()
        this.placeholder = el
        this.observer?.disconnect()
        this.observer = new ResizeObserver(() => this.layout())
        this.observer.observe(el)
        this.layout()
      },
      detach(el) {
        if (this.placeholder === el) {
          this.placeholder = null
          this.observer?.disconnect()
          this.observer = null
          if (this.host) this.host.style.display = 'none'
        }
      },
      layout() {
        if (!this.host) return
        const el = this.placeholder
        if (!el || !el.isConnected || !this.active) {
          this.host.style.display = 'none'
          return
        }
        const r = el.getBoundingClientRect()
        Object.assign(this.host.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
      },
    }

    function openRemote(ctx, device, sessionId) {
      setStore({ selection: { deviceId: device.id, sessionId: sessionId || null } })
      try {
        ctx.layout.selectPanel(CHAT_PANEL_ID)
      } catch {}
      frames.show(device.id, device, sessionId ? { type: 'open-session', sessionId } : null).catch((e) => setStore({ error: fill(en.openFailed, { error: e.message }) }))
    }

    function newRemote(ctx, device, workspaceId) {
      setStore({ selection: { deviceId: device.id, sessionId: null } })
      try {
        ctx.layout.selectPanel(CHAT_PANEL_ID)
      } catch {}
      frames.show(device.id, device, { type: 'new-session', workspaceId }).catch((e) => setStore({ error: e.message }))
    }

    // ── styles ──────────────────────────────────────────────────────────────
    const CSS = `
.dshdev-page{height:100%;overflow:auto;padding:calc(var(--dsh-frame-top-clearance,0px) + 28px) 32px 40px;box-sizing:border-box;color:var(--dsw-alias-label-primary)}
.dshdev-inner{max-width:880px;margin:0 auto}
.dshdev-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}
.dshdev-head h1{font-size:20px;line-height:28px;font-weight:600;margin:0}
.dshdev-sub{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin-top:4px;max-width:560px}
.dshdev-actions{display:flex;gap:8px;flex-shrink:0}
.dshdev-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);padding:28px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;text-align:center}
.dshdev-card{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);margin-bottom:12px;background:var(--dsw-alias-bg-base)}
.dshdev-row{display:flex;align-items:center;gap:12px;padding:14px 16px}
.dshdev-main{flex:1;min-width:0}
.dshdev-name{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;line-height:20px}
.dshdev-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshdev-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:2px}
.dshdev-tag{font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);font-weight:500}
.dshdev-tag.warn{border-color:var(--dsw-alias-state-warn-label,#d97706);color:var(--dsw-alias-state-warn-label,#d97706)}
.dshdev-sessions{border-top:1px solid var(--dsw-alias-border-l1);padding:6px 8px 8px}
.dshdev-sessions-title{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));padding:6px 8px}
.dshdev-session{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:0;border-radius:8px;padding:7px 8px;color:inherit;font:inherit;cursor:pointer}
.dshdev-session:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshdev-session:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.dshdev-s-title{flex:1;min-width:0;font-size:13px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshdev-s-meta{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshdev-none{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:4px 8px 8px}
.dshdev-menu{position:relative}
.dshdev-pop{position:absolute;right:0;top:calc(100% + 4px);z-index:20;min-width:190px;padding:4px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base)));box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18))}
.dshdev-pop button{display:block;width:100%;text-align:left;background:none;border:0;border-radius:6px;padding:7px 10px;color:inherit;font:inherit;font-size:13px;cursor:pointer}
.dshdev-pop button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshdev-pop button.danger{color:var(--dsw-alias-state-error-primary)}
.dshdev-modal{width:min(540px,calc(100vw - 48px))!important;max-width:none!important}
.dshdev-modal.dshdev-modal-sm{width:min(440px,calc(100vw - 48px))!important}
.dshdev-form{display:flex;flex-direction:column;gap:16px;width:100%;min-width:0;box-sizing:border-box}
.dshdev-form *{box-sizing:border-box}
.dshdev-field{min-width:0}
.dshdev-disclosure{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;background:none;border:0;padding:2px 0;font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshdev-disclosure:hover{color:var(--dsw-alias-label-primary)}
.dshdev-chev{display:inline-block;width:10px;font-size:11px}
.dshdev-span2{grid-column:1 / -1}
.dshdev-steps{margin:0;padding:10px 12px 10px 30px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));font-size:13px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.dshdev-steps code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));white-space:nowrap}
.dshdev-tag.ok{border-color:var(--dsw-alias-state-business-primary,#16a34a);color:var(--dsw-alias-state-business-primary,#16a34a)}
.dshdev-saved-text{display:flex;flex-direction:column;min-width:0;flex:1;line-height:18px}
.dshdev-saved-text .dshdev-s-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshdev-field label{display:block;font-size:12px;font-weight:500;margin-bottom:6px;color:var(--dsw-alias-label-secondary)}
.dshdev-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-top:6px;overflow-wrap:anywhere}
.dshdev-grid{display:grid;grid-template-columns:96px minmax(0,1fr);gap:12px}
.dshdev-tabs{display:flex;gap:4px;padding:3px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));align-self:stretch}
.dshdev-tabs button{flex:1}
.dshdev-tabs button{background:none;border:0;border-radius:7px;padding:5px 12px;font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshdev-tabs button[aria-selected=true]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.dshdev-log{max-height:220px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:17px;background:var(--dsw-alias-interactive-bg-hover);border-radius:8px;padding:10px;white-space:pre-wrap;word-break:break-word}
.dshdev-fp{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;padding:10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);word-break:break-all}
.dshdev-ok{color:var(--dsw-alias-state-business-primary);font-size:13px}
.dshdev-text{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dshdev-input{width:100%;box-sizing:border-box;height:36px;border-radius:10px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.18));background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit;font-size:13px;padding:0 12px;transition:border-color .12s,box-shadow .12s}
.dshdev-input::placeholder{color:var(--dsw-alias-label-tertiary,#9aa0a6)}
.dshdev-input:focus{outline:none;border-color:var(--dsw-focus-ring-color,#4176e6);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-focus-ring-color,#4176e6) 22%,transparent)}
.dshdev-remote-root{display:block}
[class*="_list"]:has(> .dshdev-remote-root [data-dshdev-device]) > [class*="_emptyState"]{display:none}
.dshdev-remote-root .dshdev-devname{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-left:6px;white-space:nowrap}
.dshdev-remote-root .dshdev-dim{opacity:.55}
.dshdev-remote-root .dshdev-remote-mark{display:inline-flex;color:var(--dsw-alias-label-tertiary)}
.dshdev-remote-root .dshdev-remote-folder{display:inline-flex;color:rgb(65,118,230)}
/* fallback row styles when the sidebar's own classes cannot be discovered */
.dshdev-fb-group{padding:0 0 4px}
.dshdev-fb-project,.dshdev-fb-session{display:flex;align-items:center;height:32px;padding:0 8px;border-radius:12px;font-size:14px;cursor:pointer;color:var(--dsw-alias-label-primary);gap:6px;user-select:none}
.dshdev-fb-project:hover,.dshdev-fb-session:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshdev-fb-session.dshdev-fb-selected{background:var(--dsw-alias-interactive-bg-hover)}
.dshdev-fb-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0 6px 0 4px}
.dshdev-fb-time{font-size:10px;color:var(--dsw-alias-label-tertiary)}
.dshdev-fb-slot{display:inline-flex;width:20px;justify-content:center;color:var(--dsw-alias-label-tertiary)}
.dshdev-fb-actions{display:none;margin-left:auto}
.dshdev-fb-project:hover .dshdev-fb-actions{display:inline-flex}
.dshdev-fb-iconbtn{background:none;border:0;padding:2px;border-radius:6px;color:inherit;cursor:pointer;display:inline-flex}
.dshdev-saved{display:flex;flex-direction:column;gap:6px}
.dshdev-saved-item{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:10px;padding:8px 12px;color:inherit;font:inherit;font-size:13px;cursor:pointer;transition:background .12s,border-color .12s}
.dshdev-saved-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshdev-saved-item.on{border-color:var(--dsw-focus-ring-color,#4176e6);background:var(--dsw-alias-interactive-bg-hover);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-focus-ring-color,#4176e6) 18%,transparent)}
.dshdev-saved-item:disabled{opacity:.6;cursor:default}
.dshdev-saved-name{font-weight:600;white-space:nowrap}
.dshdev-saved-item .dshdev-s-meta{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.dshdev-menu-caption{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);padding:8px 10px 4px;border-top:1px solid var(--dsw-alias-border-l1);margin-top:4px}
.dshdev-menu-suffix{color:var(--dsw-alias-label-tertiary);margin-left:6px;font-size:12px}
.dshdev-menu-item{display:flex;align-items:center;gap:8px;width:100%;background:none;border:0;padding:6px 10px;font:inherit;color:inherit;cursor:pointer}
.dshdev-chat-panel{position:relative;width:100%;height:100%}
.dshdev-chat-status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:13px;padding:24px;text-align:center}
`
    function ensureStyles() {
      if (document.getElementById('dshdev-styles')) return
      const style = document.createElement('style')
      style.id = 'dshdev-styles'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ── icons ───────────────────────────────────────────────────────────────
    function DevicesIcon({ size }) {
      return h(
        'svg',
        { width: size || 16, height: size || 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 3, y: 4, width: 18, height: 6.5, rx: 1.8 }),
        h('rect', { x: 3, y: 13.5, width: 18, height: 6.5, rx: 1.8 }),
        h('path', { d: 'M7 7.25h.01M7 16.75h.01M11 7.25h6M11 16.75h6' }),
      )
    }

    /** The "remote" mark: a small server with a signal arc. */
    function RemoteIcon({ size = 16 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 1.5, y: 6.5, width: 10, height: 7.5, rx: 1.6, fill: 'currentColor', opacity: 0.16 }),
        h('rect', { x: 1.5, y: 6.5, width: 10, height: 7.5, rx: 1.6, stroke: 'currentColor', strokeWidth: 1 }),
        h('path', { d: 'M4 10.25h.01M6.5 10.25h3', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        h('path', { d: 'M10.2 3.6a3.3 3.3 0 0 1 3.3 3.3M10.2 1.6a5.3 5.3 0 0 1 5.3 5.3', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round' }),
      )
    }

    function PlusIcon() {
      return P.IconPlusOutlineRegular ? h(P.IconPlusOutlineRegular, { size: 16 }) : h('span', null, '+')
    }

    // ── native sidebar class discovery ──────────────────────────────────────
    /** Find the CSS-module prefixes the sidebar uses for rows ("XyZ_sessionRow"). */
    function discoverClasses() {
      const found = { row: null, list: null }
      const scan = (text) => {
        if (!found.row) {
          const m = text.match(/\.([A-Za-z0-9-]+_)sessionRow\b/)
          if (m && text.includes(`.${m[1]}projectRow`)) found.row = m[1]
        }
        if (!found.list) {
          const m = text.match(/\.([A-Za-z0-9-]+_)groupSection\b/)
          if (m) found.list = m[1]
        }
      }
      const live = document.querySelector('[class*="regionArea"] [class*="_sessionRow"], [class*="regionArea"] [class*="_projectRow"]')
      if (live) {
        const c = [...live.classList].find((x) => /_(sessionRow|projectRow)$/.test(x))
        if (c) found.row = c.replace(/(sessionRow|projectRow)$/, '')
      }
      const group = document.querySelector('[class*="regionArea"] [class*="_groupSection"]')
      if (group) found.list = [...group.classList].find((x) => x.endsWith('_groupSection')).replace(/groupSection$/, '')
      if (!found.row || !found.list) {
        for (const sheet of document.styleSheets) {
          let rules
          try {
            rules = sheet.cssRules
          } catch {
            continue
          }
          for (const rule of rules) {
            scan(rule.cssText || '')
            if (found.row && found.list) break
          }
          if (found.row && found.list) break
        }
      }
      return found
    }

    function rowClasses() {
      const { row, list } = discoverClasses()
      if (!row) {
        return {
          group: 'dshdev-fb-group', project: 'dshdev-fb-project', session: 'dshdev-fb-session', selected: 'dshdev-fb-selected',
          slot: 'dshdev-fb-slot', folder: 'dshdev-fb-slot', chevron: null, projectText: 'dshdev-fb-title', title: 'dshdev-fb-title',
          time: 'dshdev-fb-time', actions: 'dshdev-fb-actions', iconButton: 'dshdev-fb-iconbtn',
        }
      }
      return {
        group: list ? `${list}groupSection` : 'dshdev-fb-group',
        project: `${row}projectRow`,
        session: `${row}sessionRow`,
        selected: `${row}selected`,
        slot: `${row}slot`,
        folder: `${row}slot ${row}folder`,
        chevron: `${row}slot ${row}chevron`,
        projectText: `${row}projectText`,
        title: `${row}title`,
        time: `${row}time`,
        actions: `${row}rowActions`,
        iconButton: `${row}iconButton`,
      }
    }

    // ── sidebar: remote groups below the local workspaces ───────────────────
    function groupSessions(device) {
      const groups = new Map()
      for (const s of device.sessions || []) {
        const key = s.workspaceId || s.cwd || '_'
        if (!groups.has(key)) {
          const title = s.workspaceTitle || (s.cwd ? s.cwd.split('/').filter(Boolean).pop() : null) || device.name
          groups.set(key, { key, workspaceId: s.workspaceId || null, title, sessions: [] })
        }
        groups.get(key).sessions.push(s)
      }
      return [...groups.values()]
    }

    function RemoteSidebar({ ctx, t }) {
      const st = useStore()
      const [cls, setCls] = useState(rowClasses)
      useEffect(() => {
        const timer = setTimeout(() => setCls(rowClasses()), 1500)
        return () => clearTimeout(timer)
      }, [st.data.devices.length])
      const devices = st.data.devices || []
      if (devices.length === 0) return null
      const chatActive = st.activePanel === CHAT_PANEL_ID
      const out = []
      for (const device of devices) {
        const online = device.status === 'online'
        const groups = groupSessions(device)
        if (groups.length === 0) groups.push({ key: '_device', workspaceId: null, title: device.name, sessions: [], deviceOnly: true })
        for (const g of groups) {
          const ckey = `${device.id}:${g.key}`
          const collapsed = !!st.collapsed[ckey]
          const label = fill(t('remoteOn'), { device: device.name })
          out.push(
            h(
              'div',
              { key: ckey, className: cls.group, 'data-dshdev-device': device.id },
              h(
                'div',
                {
                  className: `${cls.project}${online ? '' : ' dshdev-dim'}`,
                  role: 'treeitem',
                  'aria-expanded': !collapsed,
                  title: `${g.title} — ${label}${online ? '' : ` (${t('offlineShort')})`}`,
                  onClick: () => toggleCollapsed(ckey),
                },
                h('span', { className: cls.folder }, h('span', { className: 'dshdev-remote-folder' }, h(RemoteIcon, { size: 16 }))),
                cls.chevron ? h('span', { className: cls.chevron }, P.IconChevronRightOutlineRegular ? h(P.IconChevronRightOutlineRegular, { size: 14 }) : '›') : null,
                h(
                  'span',
                  { className: cls.projectText },
                  h(
                    'span',
                    { className: cls.title },
                    g.deviceOnly ? device.name : g.title,
                    g.deviceOnly ? null : h('span', { className: 'dshdev-devname' }, device.name),
                    online ? null : h('span', { className: 'dshdev-devname' }, t('offlineShort')),
                  ),
                ),
                h(
                  'span',
                  { className: cls.actions },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: cls.iconButton,
                      'aria-label': fill(t('newRemote'), { device: device.name }),
                      title: fill(t('newRemote'), { device: device.name }),
                      disabled: !online,
                      onClick: (e) => {
                        e.stopPropagation()
                        newRemote(ctx, device, g.workspaceId)
                      },
                    },
                    h(PlusIcon),
                  ),
                ),
              ),
              collapsed
                ? null
                : g.sessions.map((s) => {
                    const selected =
                      chatActive &&
                      st.selection &&
                      st.selection.deviceId === device.id &&
                      (st.selection.sessionId === s.sessionId || (!st.selection.sessionId && st.embedded[device.id] === s.sessionId))
                    return h(
                      'div',
                      {
                        key: s.sessionId,
                        className: `${cls.session}${selected ? ` ${cls.selected}` : ''}${online ? '' : ' dshdev-dim'}`,
                        role: 'treeitem',
                        'aria-selected': !!selected,
                        'data-dshdev-session': s.sessionId,
                        title: `${s.title || t('untitled')} — ${label}`,
                        onClick: () => openRemote(ctx, device, s.sessionId),
                      },
                      h('span', { className: cls.slot }, s.running ? h(P.StateDot || 'span', { state: 'ongoing' }) : h('span', { className: 'dshdev-remote-mark' }, h(RemoteIcon, { size: 14 }))),
                      h('span', { className: cls.title }, s.title || t('untitled')),
                      h('span', { className: cls.time }, s.running ? '' : shortAgo(s.updatedAt, t)),
                    )
                  }),
            ),
          )
        }
      }
      return h('div', { className: 'dshdev-remote-root', role: 'group', 'aria-label': t('remote') }, out)
    }

    /** Mount RemoteSidebar in its own React root right below the local session tree. */
    function mountSidebar(ctx, t) {
      ensureStyles()
      const container = document.createElement('div')
      container.className = 'dshdev-remote-root'
      container.setAttribute('data-dsh-devices', 'sidebar')
      const root = ReactDOMClient.createRoot(container)
      root.render(h(RemoteSidebar, { ctx, t }))
      const place = () => {
        const region = document.querySelector('[class*="regionArea"]')
        if (!region) return
        // The local list (a tree, or its empty state) fills the scroll body; the
        // remote groups go inside it, after the last local group, so both scroll
        // together as one list.
        const body = region.querySelector('[class*="_treeBody"]')
        const list = (body && body.querySelector(':scope > [class*="_list"]')) || region.querySelector('[role=tree]')
        const parent = list || body || region
        if (container.parentElement !== parent || parent.lastElementChild !== container) parent.appendChild(container)
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
      return () => {
        observer.disconnect()
        root.unmount()
        container.remove()
      }
    }

    // ── the composer's workspace chooser also lists device workspaces ───────
    /**
     * When the "Choose workspace" menu opens, append the workspaces of every
     * online device (remote icon + device name) and a "New on <device>…" entry.
     * Picking one starts the chat on that device, inline in this window.
     */
    function mountWorkspaceMenu(ctx, t) {
      const svgRemote = (size) =>
        `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.5" y="6.5" width="10" height="7.5" rx="1.6" fill="currentColor" opacity="0.16"/><rect x="1.5" y="6.5" width="10" height="7.5" rx="1.6" stroke="currentColor"/><path d="M4 10.25h.01M6.5 10.25h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M10.2 3.6a3.3 3.3 0 0 1 3.3 3.3M10.2 1.6a5.3 5.3 0 0 1 5.3 5.3" stroke="currentColor" stroke-linecap="round"/></svg>`
      const svgPlus = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
      const isWorkspaceChooser = (button) => !!button && [...button.classList].some((c) => /_workspace$/.test(c))
      const enhance = (menu) => {
        if (menu.dataset.dshdevEnhanced) return
        const anchor = document.querySelector('button[aria-haspopup="menu"][aria-expanded="true"]')
        if (!isWorkspaceChooser(anchor)) return
        menu.dataset.dshdevEnhanced = '1'
        const online = (store.data.devices || []).filter((d) => d.status === 'online')
        if (online.length === 0) return
        const viewport = menu.querySelector('[class*="_viewport_"]') || menu
        const sample = menu.querySelector('[role=menuitem]')
        const wrapCls = sample && sample.parentElement ? sample.parentElement.className : ''
        const itemCls = sample ? [...sample.classList].filter((c) => !/_selected_/.test(c)).join(' ') : 'dshdev-menu-item'
        const iconCls = (sample && sample.querySelector('[class*="_itemIcon_"]')?.className) || ''
        const labelCls = (sample && sample.querySelector('[class*="_itemLabel_"]')?.className) || ''
        const section = document.createElement('div')
        section.setAttribute('data-dsh-devices', 'workspace-menu')
        section.setAttribute('role', 'group')
        section.setAttribute('aria-label', t('menuRemote'))
        const caption = document.createElement('div')
        caption.className = 'dshdev-menu-caption'
        caption.textContent = t('menuRemote')
        section.appendChild(caption)
        const add = (icon, label, suffix, onPick) => {
          const wrap = document.createElement('div')
          wrap.className = wrapCls
          const item = document.createElement('button')
          item.type = 'button'
          item.setAttribute('role', 'menuitem')
          item.className = itemCls
          item.innerHTML = `<span class="${iconCls}" style="color:rgb(65,118,230)">${icon}</span><span class="${labelCls}"></span>`
          item.lastChild.textContent = label
          if (suffix) {
            const sfx = document.createElement('span')
            sfx.className = 'dshdev-menu-suffix'
            sfx.textContent = suffix
            item.lastChild.appendChild(sfx)
          }
          item.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            anchor.click() // close the native menu
            onPick()
          })
          wrap.appendChild(item)
          section.appendChild(wrap)
        }
        for (const device of online) {
          const workspaces = device.workspaces && device.workspaces.length ? device.workspaces : groupSessions(device).filter((g) => g.workspaceId).map((g) => ({ id: g.workspaceId, title: g.title }))
          for (const w of workspaces) add(svgRemote(16), w.title, device.name, () => newRemote(ctx, device, w.id))
          add(svgPlus, fill(t('menuNewOn'), { device: device.name }), '', () => newRemote(ctx, device, null))
        }
        viewport.appendChild(section)
      }
      const observer = new MutationObserver(() => {
        for (const menu of document.querySelectorAll('[role=menu]:not([data-dshdev-enhanced])')) enhance(menu)
      })
      observer.observe(document.body, { childList: true, subtree: true })
      return () => observer.disconnect()
    }

    // ── main area: the embedded remote conversation ─────────────────────────
    function RemoteChatPanel({ t }) {
      const st = useStore()
      const ref = useRef(null)
      useLayoutEffect(() => {
        const el = ref.current
        frames.attach(el)
        return () => frames.detach(el)
      }, [])
      useEffect(() => {
        frames.layout()
      })
      const device = st.selection && (st.data.devices || []).find((d) => d.id === st.selection.deviceId)
      let status = null
      if (!device) status = st.loaded ? null : '…'
      else if (device.status === 'offline' || device.status === 'error' || device.status === 'revoked') status = fill(t('deviceOffline'), { device: device.name })
      else if (!frames.byDevice.has(device.id)) status = fill(t('connecting'), { device: device.name })
      return h('div', { className: 'dshdev-chat-panel', ref, 'data-testid': 'dsh-devices-chat' }, status ? h('div', { className: 'dshdev-chat-status' }, status) : null)
    }

    // ── Devices page (management) ───────────────────────────────────────────
    function TextInput({ value, onChange, placeholder, list, autoFocus, type, ariaLabel }) {
      return h('input', {
        className: 'dshdev-input', value, type: type || 'text', placeholder, list, autoFocus,
        'aria-label': ariaLabel || placeholder, spellCheck: false, autoCapitalize: 'off', autoComplete: 'off',
        onChange: (e) => onChange(e.target.value),
      })
    }

    function Field({ label, hint, children }) {
      return h('div', { className: 'dshdev-field' }, h('label', null, label), children, hint ? h('div', { className: 'dshdev-hint' }, hint) : null)
    }

    function dotState(status) {
      if (status === 'online') return 'done'
      if (status === 'connecting' || status === 'running') return 'ongoing'
      if (status === 'offline') return 'idle'
      return 'error'
    }

    function Dot({ status }) {
      return P.StateDot ? h(P.StateDot, { state: dotState(status) }) : h('span', { style: { width: 8, height: 8, borderRadius: 4, background: status === 'online' ? '#22c55e' : '#9ca3af', display: 'inline-block' } })
    }

    function Btn(props) {
      const { children, ...rest } = props
      return P.Button ? h(P.Button, { size: 'sm', variant: 'outline', ...rest }, children) : h('button', rest, children)
    }

    function DeviceCard({ device, t, self, onOpen, onAction }) {
      const [menu, setMenu] = useState(false)
      const ref = useRef(null)
      useEffect(() => {
        if (!menu) return
        const close = (e) => {
          if (ref.current && !ref.current.contains(e.target)) setMenu(false)
        }
        document.addEventListener('pointerdown', close)
        return () => document.removeEventListener('pointerdown', close)
      }, [menu])
      const via = device.transport.kind === 'ssh' ? fill(t('viaSsh'), { target: device.transport.target }) : fill(t('viaUrl'), { url: device.transport.url })
      const statusText =
        device.status === 'online'
          ? `${t('status_online')}${device.uptimeSec != null ? ` · ${fill(t('up'), { when: duration(device.uptimeSec) })}` : ''}`
          : `${t(`status_${device.status}`)} · ${fill(t('lastSeen'), { when: device.lastSeenAt ? shortAgo(device.lastSeenAt, t) : t('never') })}`
      const versions = device.versions ? `dsh ${device.versions.dsh || '?'}` : ''
      const sessions = (device.sessions || []).slice(0, 6)
      const item = (key, label, cls) => h('button', { role: 'menuitem', className: cls, onClick: () => (setMenu(false), onAction(key, device)) }, label)
      return h(
        'div',
        { className: 'dshdev-card', 'data-testid': `device-${device.id}` },
        h(
          'div',
          { className: 'dshdev-row' },
          h(Dot, { status: device.status }),
          h(
            'div',
            { className: 'dshdev-main' },
            h(
              'div',
              { className: 'dshdev-name' },
              h('span', null, device.name),
              device.outdated ? h('span', { className: 'dshdev-tag warn', title: fill(t('updateHint'), { remote: device.versions && device.versions.dsh, local: self && self.dsh }) }, t('outdated')) : null,
            ),
            h('div', { className: 'dshdev-meta' }, [statusText, via, versions].filter(Boolean).join('  ·  ')),
            device.error && device.status !== 'online' ? h('div', { className: 'dshdev-err' }, device.error) : null,
          ),
          h(Btn, { variant: 'primary', disabled: device.status !== 'online', onClick: () => onOpen(device) }, t('open')),
          h(
            'div',
            { className: 'dshdev-menu', ref },
            h(Btn, { variant: 'ghost', 'aria-label': t('more'), 'aria-expanded': menu, onClick: () => setMenu(!menu) }, P.IconEllipsisOutlineRegular ? h(P.IconEllipsisOutlineRegular, { size: 16 }) : '⋯'),
            menu
              ? h(
                  'div',
                  { className: 'dshdev-pop', role: 'menu' },
                  item('refresh', t('refresh')),
                  item('window', t('openWindow')),
                  item('rename', t('rename')),
                  device.transport.kind === 'ssh' ? item('update', t('update')) : null,
                  item('remove', t('remove'), 'danger'),
                )
              : null,
          ),
        ),
        sessions.length
          ? h(
              'div',
              { className: 'dshdev-sessions' },
              h('div', { className: 'dshdev-sessions-title' }, t('sessions')),
              sessions.map((s) =>
                h(
                  'button',
                  { key: s.sessionId, className: 'dshdev-session', onClick: () => onOpen(device, s) },
                  s.running ? h(Dot, { status: 'running' }) : h('span', { className: 'dshdev-remote-mark', style: { display: 'inline-flex', color: 'var(--dsw-alias-label-tertiary)' } }, h(RemoteIcon, { size: 14 })),
                  h('span', { className: 'dshdev-s-title' }, s.title || t('untitled')),
                  h('span', { className: 'dshdev-s-meta' }, [s.workspaceTitle || (s.cwd ? s.cwd.split('/').filter(Boolean).pop() : ''), s.running ? t('running') : shortAgo(s.updatedAt, t)].filter(Boolean).join(' · ')),
                ),
              ),
            )
          : null,
      )
    }

    function JobView({ job, t }) {
      const ref = useRef(null)
      useEffect(() => {
        if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
      }, [job && job.log.length])
      if (!job) return null
      return h('div', { ref, className: 'dshdev-log', 'aria-live': 'polite' }, job.log.join('\n') || t('working'))
    }

    function AddDialog({ t, onClose, onDone, preset }) {
      const [tab, setTab] = useState('ssh')
      const [target, setTarget] = useState(preset ? preset.target : '')
      const [savedId, setSavedId] = useState(preset ? preset.id : null)
      const [saved, setSaved] = useState([])
      const [port, setPort] = useState('')
      const [user, setUser] = useState('')
      const [identity, setIdentity] = useState('')
      const [name, setName] = useState(preset ? preset.name : '')
      const [code, setCode] = useState('')
      const [url, setUrl] = useState('')
      const [advanced, setAdvanced] = useState(false)
      const [hosts, setHosts] = useState([])
      const [job, setJob] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [success, setSuccess] = useState(null)

      useEffect(() => {
        api('/devices/ssh-hosts').then((r) => {
          setHosts((r.hosts || []).map((x) => (typeof x === 'string' ? { alias: x } : x)))
          setSaved(r.saved || [])
        }, () => {})
        if (preset) startSsh()
      }, [])

      useEffect(() => {
        if (!job || job.state !== 'running') return
        const timer = setInterval(async () => {
          try {
            const next = await api(`/devices/job?id=${encodeURIComponent(job.id)}`)
            setJob(next)
            if (next.state === 'done') {
              setBusy(false)
              const d = next.result && next.result.device
              setSuccess(fill(t('paired'), { name: d ? d.name : '' }))
              onDone()
            } else if (next.state === 'error') {
              setBusy(false)
              if (!(next.prompt && next.prompt.kind === 'hostkey')) setError(next.error)
            }
          } catch (e) {
            setBusy(false)
            setError(e.message)
          }
        }, 700)
        return () => clearInterval(timer)
      }, [job && job.id, job && job.state])

      const linkMode = code.trim().startsWith('dsh-device://')

      async function startSsh(fingerprint) {
        setError(null)
        setSuccess(null)
        setBusy(true)
        try {
          const started = await post('/devices/pair-ssh', {
            target: target.trim(),
            port: port ? Number(port) : undefined,
            username: user.trim() || undefined,
            identityFile: identity.trim() || undefined,
            name: name.trim() || undefined,
            fingerprint,
            savedMachineId: savedId || undefined,
          })
          setJob(started)
        } catch (e) {
          setBusy(false)
          setError(e.message)
        }
      }

      async function pairCode() {
        setError(null)
        setSuccess(null)
        setBusy(true)
        try {
          const r = await post('/devices/pair-code', { input: code.trim(), url: linkMode ? undefined : url.trim(), name: name.trim() || undefined })
          setSuccess(fill(t('paired'), { name: r.device.name }))
          onDone()
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy(false)
        }
      }

      const hostPrompt = job && job.state === 'error' && job.prompt && job.prompt.kind === 'hostkey' ? job.prompt : null
      const finished = !!success
      const canSubmit = !busy && !finished && (tab === 'ssh' ? target.trim() : code.trim() && (linkMode || url.trim()))

      const body = h(
        'div',
        { className: 'dshdev-form' },
        h(
          'div',
          { className: 'dshdev-tabs', role: 'tablist' },
          h('button', { role: 'tab', 'aria-selected': tab === 'ssh', onClick: () => setTab('ssh'), disabled: busy }, t('tabSsh')),
          h('button', { role: 'tab', 'aria-selected': tab === 'code', onClick: () => setTab('code'), disabled: busy }, t('tabCode')),
        ),
        tab === 'ssh'
          ? h(
              React.Fragment,
              null,
              saved.length || hosts.length
                ? h(
                    Field,
                    { label: t('suggestions'), hint: saved.length ? t('savedHint') : null },
                    h(
                      'div',
                      { className: 'dshdev-saved', role: 'listbox', 'aria-label': t('suggestions') },
                      saved.map((m) =>
                        h(
                          'button',
                          {
                            key: `saved:${m.id}`,
                            type: 'button',
                            role: 'option',
                            'aria-selected': savedId === m.id,
                            className: `dshdev-saved-item${savedId === m.id ? ' on' : ''}`,
                            disabled: busy,
                            onClick: () => {
                              setSavedId(m.id)
                              setTarget(m.target)
                              setName(m.name)
                            },
                          },
                          h('span', { className: 'dshdev-remote-mark', style: { color: 'rgb(65,118,230)' } }, h(RemoteIcon, { size: 16 })),
                          h('span', { className: 'dshdev-saved-text' }, h('span', { className: 'dshdev-saved-name' }, m.name), h('span', { className: 'dshdev-s-meta' }, m.target)),
                          m.pairedDeviceId ? h('span', { className: 'dshdev-tag' }, t('alreadyAdded')) : m.fingerprint ? h('span', { className: 'dshdev-tag ok' }, t('trusted')) : null,
                        ),
                      ),
                      hosts.map((x) => {
                        const value = x.alias
                        const selected = !savedId && target === value
                        return h(
                          'button',
                          {
                            key: `alias:${value}`,
                            type: 'button',
                            role: 'option',
                            'aria-selected': selected,
                            className: `dshdev-saved-item${selected ? ' on' : ''}`,
                            disabled: busy,
                            onClick: () => {
                              setSavedId(null)
                              setTarget(value)
                              if (!name) setName(value)
                            },
                          },
                          h('span', { className: 'dshdev-remote-mark' }, h(RemoteIcon, { size: 16 })),
                          h('span', { className: 'dshdev-saved-text' }, h('span', { className: 'dshdev-saved-name' }, value), h('span', { className: 'dshdev-s-meta' }, x.host ? `${x.user ? `${x.user}@` : ''}${x.host}${x.port && x.port !== 22 ? `:${x.port}` : ''}` : '')),
                          h('span', { className: 'dshdev-tag' }, t('fromSshConfig')),
                        )
                      }),
                    ),
                  )
                : null,
              h(
                Field,
                { label: saved.length || hosts.length ? `${t('orType')} — ${t('sshTarget')}` : t('sshTarget'), hint: t('sshTargetHint') },
                h(TextInput, { value: savedId ? '' : target, onChange: (v) => (setTarget(v), setSavedId(null)), placeholder: 'root@203.0.113.10', autoFocus: !preset && !saved.length && !hosts.length }),
              ),
              h(
                'button',
                { type: 'button', className: 'dshdev-disclosure', 'aria-expanded': advanced, onClick: () => setAdvanced(!advanced) },
                h('span', { className: 'dshdev-chev', 'aria-hidden': true }, advanced ? '▾' : '▸'),
                t('advanced'),
              ),
              advanced
                ? h(
                    'div',
                    { className: 'dshdev-grid' },
                    h(Field, { label: t('sshPort') }, h(TextInput, { value: port, onChange: setPort, placeholder: '22' })),
                    h(Field, { label: t('sshUser') }, h(TextInput, { value: user, onChange: setUser, placeholder: 'root' })),
                    h('div', { className: 'dshdev-span2' }, h(Field, { label: t('sshKey') }, h(TextInput, { value: identity, onChange: setIdentity, placeholder: '~/.ssh/id_ed25519' }))),
                  )
                : null,
            )
          : h(
              React.Fragment,
              null,
              h(
                'ol',
                { className: 'dshdev-steps' },
                h('li', null, t('codeStep1'), ' ', h('code', null, 'dsh-device pair --url https://…')),
                h('li', null, t('codeStep2')),
              ),
              h(Field, { label: t('codeInput'), hint: t('codeHint') }, h(TextInput, { value: code, onChange: setCode, placeholder: 'dsh-device://pair?…  /  K7QF-2M9X', autoFocus: true })),
              linkMode ? null : h(Field, { label: t('codeUrl'), hint: t('codeUrlHint') }, h(TextInput, { value: url, onChange: setUrl, placeholder: 'https://vps.example.ts.net' })),
            ),
        h(Field, { label: t('deviceName') }, h(TextInput, { value: name, onChange: setName, placeholder: 'VPS' })),
        job ? h(JobView, { job, t }) : null,
        hostPrompt
          ? h(
              'div',
              null,
              h('div', { className: 'dshdev-text', style: { fontWeight: 600, marginBottom: 6 } }, t('hostKeyTitle')),
              h('div', { className: 'dshdev-text', style: { marginBottom: 8 } }, t('hostKeyBody')),
              h('div', { className: 'dshdev-fp', 'data-testid': 'hostkey-fingerprint' }, hostPrompt.fingerprint),
            )
          : null,
        error ? h('div', { className: 'dshdev-err', role: 'alert' }, error) : null,
        success ? h('div', { className: 'dshdev-ok', role: 'status' }, success) : null,
      )

      const footer = h(
        React.Fragment,
        null,
        h(Btn, { variant: 'outline', onClick: onClose }, finished ? t('done') : t('cancel')),
        hostPrompt
          ? h(Btn, { variant: 'primary', onClick: () => startSsh(hostPrompt.fingerprint) }, t('trust'))
          : finished
            ? null
            : h(Btn, { variant: 'primary', disabled: !canSubmit, onClick: () => (tab === 'ssh' ? startSsh() : pairCode()) }, busy ? t('working') : tab === 'ssh' ? t('connect') : t('pair')),
      )

      if (P.Modal) return h(P.Modal, { open: true, onClose, title: t('addTitle'), description: t('addDescription'), closeLabel: t('close'), footer, className: 'dshdev-modal' }, body)
      return h('div', { role: 'dialog', style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'grid', placeItems: 'center', zIndex: 50 } }, h('div', { style: { background: 'var(--dsw-alias-bg-base,#fff)', padding: 20, borderRadius: 12 } }, h('h2', null, t('addTitle')), body, h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 } }, footer)))
    }

    function SimpleDialog({ title, description, children, footer, onClose, t }) {
      if (P.Modal) return h(P.Modal, { open: true, onClose, title, description, closeLabel: t('close'), footer, className: 'dshdev-modal dshdev-modal-sm' }, children)
      return h('div', { role: 'dialog' }, h('h2', null, title), h('p', null, description), children, footer)
    }

    async function openInWindow(device) {
      const root = await deviceRoot(device.id)
      const url = `${root}?${new URLSearchParams({ 'dsh-device': device.name }).toString()}`
      const tauri = window.__TAURI_INTERNALS__
      if (tauri && typeof tauri.invoke === 'function') {
        try {
          await tauri.invoke('remote_open_window', { machineId: device.id, url })
          return
        } catch {}
      }
      window.open(url, '_blank', 'noopener')
    }

    function DevicesPage({ ctx, t }) {
      ensureStyles()
      const st = useStore()
      const [adding, setAdding] = useState(false)
      const [renaming, setRenaming] = useState(null)
      const [removing, setRemoving] = useState(null)
      const [renameValue, setRenameValue] = useState('')
      const [notice, setNotice] = useState(null)
      const [updateJob, setUpdateJob] = useState(null)

      useEffect(() => {
        if (!updateJob || updateJob.state !== 'running') return
        const timer = setInterval(async () => {
          try {
            const next = await api(`/devices/job?id=${encodeURIComponent(updateJob.id)}`)
            setUpdateJob(next)
            if (next.state !== 'running') refreshDevices()
          } catch {}
        }, 1000)
        return () => clearInterval(timer)
      }, [updateJob && updateJob.id, updateJob && updateJob.state])

      const onOpen = (device, session) => openRemote(ctx, device, session ? session.sessionId : null)

      async function onAction(kind, device) {
        setNotice(null)
        try {
          if (kind === 'refresh') await post('/devices/refresh', { id: device.id })
          if (kind === 'window') await openInWindow(device)
          if (kind === 'rename') {
            setRenameValue(device.name)
            setRenaming(device)
          }
          if (kind === 'remove') setRemoving(device)
          if (kind === 'update') setUpdateJob(await post('/devices/update', { id: device.id }))
          refreshDevices()
        } catch (e) {
          setNotice(e.message)
        }
      }

      const devices = st.data.devices || []
      return h(
        'div',
        { className: 'dshdev-page', 'data-testid': 'dsh-devices-page' },
        h(
          'div',
          { className: 'dshdev-inner' },
          h(
            'div',
            { className: 'dshdev-head' },
            h('div', null, h('h1', null, t('title')), h('div', { className: 'dshdev-sub' }, t('subtitle'))),
            h('div', { className: 'dshdev-actions' }, h(Btn, { variant: 'outline', onClick: () => post('/devices/refresh', {}).then(refreshDevices) }, t('refresh')), h(Btn, { variant: 'primary', onClick: () => setAdding({}) }, t('add'))),
          ),
          notice || st.error ? h('div', { className: 'dshdev-err', role: 'alert', style: { marginBottom: 12 } }, notice || st.error) : null,
          updateJob ? h('div', { style: { marginBottom: 12 } }, h(JobView, { job: updateJob, t })) : null,
          (st.data.saved || []).some((m) => !m.pairedDeviceId)
            ? h(
                'div',
                { className: 'dshdev-card', 'data-testid': 'dsh-devices-saved' },
                h('div', { className: 'dshdev-sessions-title', style: { padding: '12px 16px 2px' } }, t('savedTitle')),
                (st.data.saved || [])
                  .filter((m) => !m.pairedDeviceId)
                  .map((m) =>
                    h(
                      'div',
                      { key: m.id, className: 'dshdev-row', style: { paddingTop: 8, paddingBottom: 8 } },
                      h('span', { className: 'dshdev-remote-mark', style: { display: 'inline-flex', color: 'rgb(65,118,230)' } }, h(RemoteIcon, { size: 16 })),
                      h('div', { className: 'dshdev-main' }, h('div', { className: 'dshdev-name' }, m.name), h('div', { className: 'dshdev-meta' }, [`SSH · ${m.target}`, m.fingerprint ? t('hostKeyKnown') : null].filter(Boolean).join('  ·  '))),
                      h(Btn, { variant: 'primary', onClick: () => setAdding({ preset: m }) }, t('addSaved')),
                    ),
                  ),
              )
            : null,
          st.loaded && devices.length === 0 && !(st.data.saved || []).length ? h('div', { className: 'dshdev-empty' }, t('empty')) : null,
          devices.map((d) => h(DeviceCard, { key: d.id, device: d, t, self: st.data.self, onOpen, onAction })),
        ),
        adding ? h(AddDialog, { t, preset: adding.preset, onClose: () => setAdding(false), onDone: refreshDevices }) : null,
        renaming
          ? h(SimpleDialog, {
              t,
              title: t('rename'),
              onClose: () => setRenaming(null),
              footer: h(
                React.Fragment,
                null,
                h(Btn, { variant: 'outline', onClick: () => setRenaming(null) }, t('cancel')),
                h(Btn, { variant: 'primary', onClick: async () => { await post('/devices/rename', { id: renaming.id, name: renameValue }); setRenaming(null); refreshDevices() } }, t('save')),
              ),
              children: h(Field, { label: t('renamePrompt') }, h(TextInput, { value: renameValue, onChange: setRenameValue, autoFocus: true })),
            })
          : null,
        removing
          ? h(SimpleDialog, {
              t,
              title: fill(t('removeTitle'), { name: removing.name }),
              description: t('removeBody'),
              onClose: () => setRemoving(null),
              footer: h(
                React.Fragment,
                null,
                h(Btn, { variant: 'outline', onClick: () => setRemoving(null) }, t('cancel')),
                h(Btn, {
                  variant: 'primary',
                  onClick: async () => {
                    const d = removing
                    setRemoving(null)
                    try {
                      await post('/devices/remove', { id: d.id })
                      frames.drop(d.id)
                    } catch (e) {
                      setNotice(e.message)
                    }
                    refreshDevices()
                  },
                }, t('remove')),
              ),
            })
          : null,
      )
    }

    // ── plugin ──────────────────────────────────────────────────────────────
    const inject = ['slots', 'locale', 'layout']
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-devices: dictionaries')
      // Language packs (the desktop app may run in Portuguese).
      for (const tag of ['pt-BR', 'pt']) {
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, tag, ptBR)
          } catch {
            return () => {}
          }
        }, `dsh-devices: ${tag} dictionary`)
      }
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ ctx, t }) }, DevicesPage))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: CHAT_PANEL_ID, locale: NS, inject: () => ({ t }) }, RemoteChatPanel))
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('panel') }, DevicesIcon),
      )
      // Track the selected main panel so remote rows show their selected state
      // and the embedded device UI hides while a local chat is open.
      ctx.effect(() => {
        const sync = () => {
          const snap = ctx.layout.panelInfo.getSnapshot()
          const active = snap ? snap.activePanelId : null
          if (active !== store.activePanel) {
            store.activePanel = active
            emit()
          }
          if (active !== CHAT_PANEL_ID && frames.host) frames.host.style.display = 'none'
          else frames.layout()
        }
        sync()
        return ctx.layout.panelInfo.subscribe(sync)
      }, 'dsh-devices: panel tracking')
      ctx.effect(() => mountWorkspaceMenu(ctx, t), 'dsh-devices: workspace chooser')
      // The remote groups sit in the sidebar's own list; poll while mounted.
      ctx.effect(() => {
        const unmount = mountSidebar(ctx, t)
        const unsubscribe = subscribe(() => {})
        return () => {
          unsubscribe()
          unmount()
        }
      }, 'dsh-devices: sidebar remote groups')
    }

    exports.name = 'dsh-devices'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
