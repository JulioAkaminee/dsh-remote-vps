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


    Object.assign(en, {
      settingsNav: 'Devices', settingsTitle: 'Devices', settingsSub: 'How remote devices show up and behave on this computer.',
      setNotify: 'Notify when a remote turn finishes', setNotifyHint: 'Uses the app’s system notifications.',
      notifyNever: 'Never', notifyBackground: 'Only when the app is in the background', notifyAlways: 'Always',
      setSidebar: 'Show remote chats in the sidebar', setSidebarHint: 'Device workspaces appear below your local ones, marked as remote.',
      setPerGroup: 'Sessions per remote workspace', setPerGroupHint: 'The rest stays behind “Show more”.', allSessions: 'All',
      setPreload: 'Preload a device’s interface on hover', setPreloadHint: 'Opening a remote chat becomes instant; uses a bit more memory.',
      setDefault: 'Default for new sessions', setDefaultHint: 'Where “New session” starts. You can always switch with the device picker.',
      manageDevices: 'Manage devices', showMore: 'Show {n} more sessions', showLess: 'Show fewer', notifyDone: 'Finished on {device}',
      notifyTest: 'Send a test notification', notifyTestBody: 'Notifications from your devices will look like this.', remoteBadge: 'Remote · {device}',
      on: 'On', off: 'Off',
      openFiles: 'Files', openInEditor: 'Open in {editor}', editorTitle: 'Open in {editor} on this computer (Remote-SSH)',
      setEditor: 'Editor for remote files', setEditorHint: 'Opens device folders and files in this computer’s editor over Remote-SSH.',
      notInstalled: 'not installed', editorHost: 'SSH host for editors', editorHostMenu: 'SSH host for editors…',
      editorHostHint: 'An alias from ~/.ssh/config, or user@host, that this computer’s editor uses to reach the device.',
      editorHostNeeded: '{device} was paired with a code; tell this computer’s editor how to reach it over SSH.', editorOpening: 'Opening in {editor}…',
      thisMac: 'This computer', chooseDevice: 'Where should this session run?', addDeviceMenu: 'Add device…',
      modelMissing: '{device} has no DeepSeek access yet (API key or account), so its chats have no models.',
      modelOk: 'DeepSeek API key configured', modelSource: 'source: {source}',
      useMacKey: 'Use this computer’s key', pasteKey: 'Paste key', changeKey: 'Change key', removeKey: 'Remove key',
      saveKey: 'Save key', keyPlaceholder: 'sk-…', keySaved: 'Key saved on {device}.', deviceSettings: 'Device settings',
      loadingDevice: 'Loading {device}…', loadFailed: 'Could not load {device}’s interface.', retry: 'Try again',
      unreachable: 'Could not reach {device}.', comesBack: 'It looks offline. This reloads by itself when the device answers again.',
      loadFailedHint: 'The device did not finish loading its interface in time.',
      panelOpening: 'Opening {panel} on {device}…', panelSlow: 'The device is taking a while to answer; it keeps trying.',
      panelFailed: 'Could not open {panel} on {device}.', panelTimeout: 'The device did not answer in time. Try again, or open it in a window.',
      panelOldHost: '{device} cannot open {panel} here yet.', panelOldHostHint: 'It runs an older device host ({version}). Update it once and its panels open right here.',
      panelOldHostManual: 'It runs an older device host ({version}) and was paired with a code. Add it again over SSH: the new host is installed and its chats stay. Or open it in a window for now.',
      updateViaSsh: 'Update over SSH…', newSessionRow: 'New session',
      needsUpdate: 'This device runs an older device host ({remote}); update it to manage its key from here.', updateNow: 'Update device',
      updateWarn: 'Updating restarts the device host; running turns on it stop.',
      modelLabel: 'Models', keyHint: 'Stored on the device (its credential store). It never stays on this computer.',
    })
    Object.assign(ptBR, {
      settingsNav: 'Devices', settingsTitle: 'Devices', settingsSub: 'Como os devices remotos aparecem e se comportam neste computador.',
      setNotify: 'Avisar quando um turno remoto terminar', setNotifyHint: 'Usa as notificações do sistema do app.',
      notifyNever: 'Nunca', notifyBackground: 'Só quando o app estiver em segundo plano', notifyAlways: 'Sempre',
      setSidebar: 'Mostrar chats remotos na barra lateral', setSidebarHint: 'Os workspaces dos devices aparecem abaixo dos locais, marcados como remotos.',
      setPerGroup: 'Sessões por workspace remoto', setPerGroupHint: 'O resto fica em “Mostrar mais”.', allSessions: 'Todas',
      setPreload: 'Pré-carregar a interface do device ao passar o mouse', setPreloadHint: 'Abrir um chat remoto fica instantâneo; usa um pouco mais de memória.',
      setDefault: 'Padrão para novas sessões', setDefaultHint: 'Onde a “Nova sessão” começa. Você sempre pode trocar pelo seletor de device.',
      manageDevices: 'Gerenciar devices', showMore: 'Mostrar mais {n} sessões', showLess: 'Mostrar menos', notifyDone: 'Terminou em {device}',
      notifyTest: 'Enviar notificação de teste', notifyTestBody: 'As notificações dos seus devices vão aparecer assim.', remoteBadge: 'Remoto · {device}',
      on: 'Ligado', off: 'Desligado',
      openFiles: 'Arquivos', openInEditor: 'Abrir no {editor}', editorTitle: 'Abrir no {editor} deste computador (Remote-SSH)',
      setEditor: 'Editor para arquivos remotos', setEditorHint: 'Abre pastas e arquivos do device no editor deste computador via Remote-SSH.',
      notInstalled: 'não instalado', editorHost: 'Host SSH para editores', editorHostMenu: 'Host SSH para editores…',
      editorHostHint: 'Um alias do ~/.ssh/config, ou usuário@host, que o editor deste computador usa para chegar ao device.',
      editorHostNeeded: '{device} foi pareado por código; diga como o editor deste computador chega nele por SSH.', editorOpening: 'Abrindo no {editor}…',
      thisMac: 'Este computador', chooseDevice: 'Onde esta sessão vai rodar?', addDeviceMenu: 'Adicionar device…',
      modelMissing: '{device} ainda não tem acesso ao DeepSeek (chave da API ou conta), então os chats dele ficam sem modelos.',
      modelOk: 'Chave da API do DeepSeek configurada', modelSource: 'origem: {source}',
      useMacKey: 'Usar a chave deste computador', pasteKey: 'Colar chave', changeKey: 'Trocar chave', removeKey: 'Remover chave',
      saveKey: 'Salvar chave', keyPlaceholder: 'sk-…', keySaved: 'Chave salva em {device}.', deviceSettings: 'Configurações do device',
      loadingDevice: 'Carregando {device}…', loadFailed: 'Não consegui carregar a interface de {device}.', retry: 'Tentar de novo',
      unreachable: 'Não consegui falar com {device}.', comesBack: 'Ele parece offline. Isto recarrega sozinho quando o device responder de novo.',
      loadFailedHint: 'O device não terminou de carregar a interface a tempo.',
      panelOpening: 'Abrindo {panel} de {device}…', panelSlow: 'O device está demorando para responder; continuo tentando.',
      panelFailed: 'Não consegui abrir {panel} de {device}.', panelTimeout: 'O device não respondeu a tempo. Tente de novo ou abra numa janela.',
      panelOldHost: '{device} ainda não abre {panel} aqui.', panelOldHostHint: 'Ele usa um device host antigo ({version}). Atualize uma vez e os painéis dele abrem aqui mesmo.',
      panelOldHostManual: 'Ele usa um device host antigo ({version}) e foi pareado por código. Adicione de novo por SSH: o host novo é instalado e os chats continuam. Ou, por enquanto, abra numa janela.',
      updateViaSsh: 'Atualizar por SSH…', newSessionRow: 'Nova sessão',
      needsUpdate: 'Este device roda um device host antigo ({remote}); atualize para gerenciar a chave por aqui.', updateNow: 'Atualizar device',
      updateWarn: 'Atualizar reinicia o device host; turnos rodando nele param.',
      modelLabel: 'Modelos', keyHint: 'Fica guardada no device (no cofre de credenciais dele). Não fica neste computador.',
    })
    Object.assign(zh, {
      settingsNav: '设备', settingsTitle: '设备', settingsSub: '远程设备在本机上的显示与行为。', setNotify: '远程轮次完成时通知', setNotifyHint: '使用应用的系统通知。',
      notifyNever: '从不', notifyBackground: '仅在应用处于后台时', notifyAlways: '始终', setSidebar: '在侧边栏显示远程会话', setSidebarHint: '设备的工作区显示在本地工作区下方，并标记为远程。',
      setPerGroup: '每个远程工作区显示的会话数', setPerGroupHint: '其余会话折叠在“显示更多”中。', allSessions: '全部', setPreload: '悬停时预加载设备界面',
      setPreloadHint: '打开远程会话会更快，但会占用更多内存。', setDefault: '新会话默认位置', setDefaultHint: '“新会话”从哪里开始。随时可以用设备选择器切换。',
      manageDevices: '管理设备', showMore: '显示另外 {n} 个会话', showLess: '收起', notifyDone: '已在 {device} 完成', notifyTest: '发送测试通知',
      notifyTestBody: '来自设备的通知会这样显示。', remoteBadge: '远程 · {device}', on: '开', off: '关',
      openFiles: '文件', openInEditor: '在 {editor} 中打开', editorTitle: '在本机的 {editor} 中打开（Remote-SSH）', setEditor: '远程文件编辑器',
      setEditorHint: '通过 Remote-SSH 在本机编辑器中打开设备上的文件夹和文件。', notInstalled: '未安装', editorHost: '编辑器使用的 SSH 主机', editorHostMenu: '编辑器使用的 SSH 主机…',
      editorHostHint: '本机编辑器通过 SSH 连接设备时使用的 ~/.ssh/config 别名或 user@host。', editorHostNeeded: '{device} 通过配对码配对；请告诉本机编辑器如何通过 SSH 连接它。',
      editorOpening: '正在用 {editor} 打开…',
      thisMac: '本机', chooseDevice: '会话在哪里运行？', addDeviceMenu: '添加设备…', modelMissing: '{device} 还没有 DeepSeek API Key，会话没有可用模型。',
      modelOk: '已配置 DeepSeek API Key', modelSource: '来源：{source}', useMacKey: '使用本机的 Key', pasteKey: '粘贴 Key', changeKey: '更换 Key',
      removeKey: '移除 Key', saveKey: '保存 Key', keyPlaceholder: 'sk-…', keySaved: '已保存到 {device}。', deviceSettings: '设备设置', modelLabel: '模型',
      unreachable: '无法连接 {device}。', comesBack: '设备似乎已离线。设备恢复响应后会自动重新加载。', loadFailedHint: '设备未能及时加载完界面。',
      panelOpening: '正在打开 {device} 的{panel}…', panelSlow: '设备响应较慢，仍在重试。', panelFailed: '无法打开 {device} 的{panel}。',
      panelTimeout: '设备没有及时响应。请重试，或在窗口中打开。', panelOldHost: '{device} 暂时无法在这里打开{panel}。',
      panelOldHostHint: '它运行的是旧版设备主机（{version}）。更新一次后，其面板即可在此打开。', panelOldHostManual: '它运行的是旧版设备主机（{version}），且通过配对码配对。通过 SSH 重新添加即可安装新版主机，会话会保留；或暂时在窗口中打开。',
      updateViaSsh: '通过 SSH 更新…', newSessionRow: '新建会话', reconnect: '重新连接', reconnecting: '正在重新连接 {device}…',
      newSessionHere: '在此新建会话', addFolderMenu: '添加文件夹…', addFolderTo: '在 {device} 上添加文件夹', splitProjects: '拆分为项目…', removeWorkspace: '删除工作区',
      removeWorkspaceHint: '这会从工作区列表中移除“{name}”。文件夹和会话仍保留在设备上；其会话将显示在“未分组”下。', renameWorkspace: '重命名工作区', workspaceName: '工作区名称',
      ungrouped: '未分组', defaultWorkspace: '默认工作区', foldersTitle: '在 {device} 上添加文件夹', foldersHint: '每个文件夹在侧边栏中成为一个分组；在其中开始的会话会留在该分组。',
      splitTitle: '将“{folder}”拆分为项目', splitHint: '勾选 {folder} 中的项目文件夹。每个都会成为独立分组，该项目的新会话会留在其中。已在 {folder} 中的会话保持不变。',
      addThisFolder: '添加“{name}”', addFolders: '添加 {n} 个文件夹', folderUp: '上一级', folderHome: '主文件夹', folderOpen: '打开文件夹', folderPath: '文件夹路径（输入后按回车）', alreadyAdded: '已添加', projectTag: '项目',
      foldersLoading: '正在读取文件夹…', foldersEmpty: '这里没有文件夹。', foldersTruncated: '仅显示前 500 个文件夹。', pickProjects: '勾选这里的 {n} 个项目文件夹', newFolder: '新建文件夹',
      newFolderPlaceholder: '新文件夹名称', createFolder: '创建文件夹', folderAdded: '已在 {device} 上添加“{name}”', foldersAdded: '已在 {device} 上添加 {n} 个文件夹',
      errFolderNotFound: '该文件夹已不存在。', errFolderUnreadable: '设备无法读取该文件夹。', errFolderName: '请使用简单的文件夹名（不含斜杠）。', errFolderExists: '此处已存在同名文件夹。',
      errNameConflict: '已有其他工作区使用该名称。', errWorkspaceGone: '该工作区已不存在；列表已刷新。',
      newIn: '在 {workspace} 中新建会话', emptyOffline: '离线 — 设备恢复响应后会话会重新出现',
      keyHint: '保存在设备上（设备的凭据存储），不会留在本机。',
    })

    Object.assign(en, {
      moreActions: 'More actions', sessionActions: 'Session actions', renameSession: 'Rename…', renameTitle: 'Rename session', sessionName: 'Session name',
      pin: 'Pin', unpin: 'Unpin', archive: 'Archive', unarchive: 'Unarchive', pinned: 'Pinned',
      archiveRunning: 'This session is running on {device}. Stop it and archive?', stopAndArchive: 'Stop and archive',
      archivedTitle: 'Archived on {device}', archivedMenu: 'Archived chats ({n})', noArchived: 'No archived chats.',
      searchMenu: 'Search chats…', searchTitle: 'Search remote chats', searchPlaceholder: 'Search titles and messages on your devices',
      searchNoResults: 'No matches.', searchInTitles: 'Titles', searchInMessages: 'Messages', searching: 'Searching…',
      pluginsMenu: 'Plugins', automationsMenu: 'Automations', portsMenu: 'Ports & previews', syncMenu: 'Sync with this computer…',
      accountMenu: 'Models & account…', needsYou: 'Needs you', needsApproval: 'Needs your approval: {tool}', needsAnswer: 'Has a question for you',
      notifyNeedsYou: 'Needs you on {device}', setNotifyAttention: 'Notify when a remote chat needs you',
      setNotifyAttentionHint: 'Approvals and questions from agents on your devices.',
      portsTitle: 'Ports & previews — {device}', portsHint: 'Dev servers running on {device}. Forwarded ports open on this computer at localhost.',
      portsEmpty: 'No dev servers are listening on {device} right now. Start one (npm run dev…) and it shows up here.',
      portForward: 'Forward', portStop: 'Stop', portOpen: 'Open in browser', portCopy: 'Copy URL', portCopied: 'Copied',
      portAuto: 'Forward new ports automatically', portToast: 'Port {remote} on {device} → localhost:{local}',
      portEnsure: 'Forwarding port {port} from {device}… click the link again.', notForwarded: 'not forwarded',
      syncTitle: 'Sync with {device}',
      syncHint: 'Copy what you customised on this computer to {device}: instructions, skills, MCP servers, agent presets and plugins. Desktop-only plugins stay here.',
      syncLoading: 'Comparing with {device}…', syncNothing: 'Nothing customised on this computer to copy yet.',
      syncGroup_instructions: 'Instructions (AGENTS.md)', syncGroup_skill: 'Skills', syncGroup_mcp: 'MCP servers', syncGroup_preset: 'Agent presets', syncGroup_plugin: 'Plugins',
      syncStatus_new: 'new', syncStatus_changed: 'changed', syncStatus_same: 'up to date', syncStatus_unsupported: 'not supported', syncStatus_conflict: 'exists on device',
      'syncReason_desktop-only': 'desktop only', 'syncReason_local-folder': 'installed from a local folder', 'syncReason_no-source': 'no installable source',
      'syncReason_too-large': 'too large', 'syncReason_no-plugin-manager': 'the device has no plugin manager', 'syncReason_already-on-device': 'a row with this id already exists on the device',
      syncWarn_secrets: 'includes env/headers (may contain secrets)', 'syncWarn_local-path': 'refers to paths on this computer',
      syncRun: 'Sync {n} item(s)', syncDone: 'Synced {ok} of {n} item(s).', syncShowSame: 'Show {n} up-to-date item(s)', syncAllSame: 'Everything is already on the device.',
      syncPluginsNote: 'Plugins are installed with the device’s plugin manager; some need a device host restart.',
      accountTitle: 'Models & account — {device}', accountSignedIn: 'DeepSeek account signed in on {device}', accountSignedOut: 'No DeepSeek account on {device}',
      useMacAccount: 'Use this computer’s account', signOutDevice: 'Sign out on the device', accountShared: 'Signed in on {device} with this computer’s account.',
      accountNote: 'The device uses this computer’s sign-in. Signing out on the device keeps this computer signed in; signing out on this computer also stops the device.',
      modelReadyAccount: 'Using your DeepSeek account', addApiKey: 'Add an API key', hostOutdatedFeature: 'Update {device} to use this.',
      reconnect: 'Reconnect', reconnecting: 'Reconnecting to {device}…', newIn: 'New session in {workspace}',
      newSessionHere: 'New session here', addFolderMenu: 'Add a folder…', addFolderTo: 'Add a folder on {device}', splitProjects: 'Split into projects…',
      removeWorkspace: 'Remove workspace', removeWorkspaceHint: 'This removes “{name}” from the workspace list. The folder and its chats stay on the device; its chats appear under Ungrouped.',
      renameWorkspace: 'Rename workspace', workspaceName: 'Workspace name', ungrouped: 'Ungrouped', defaultWorkspace: 'Default workspace',
      foldersTitle: 'Add a folder on {device}', foldersHint: 'Each folder becomes a group in the sidebar, like your local workspaces; chats started in it stay there.',
      splitTitle: 'Split “{folder}” into projects', splitHint: 'Tick the project folders inside {folder}. Each becomes its own group and new chats of that project stay in it. Chats already in {folder} stay there.',
      addThisFolder: 'Add “{name}”', addFolders: 'Add {n} folders', folderUp: 'Up one folder', folderHome: 'Home folder', folderOpen: 'Open folder', folderPath: 'Folder path (type one and press Enter)',
      alreadyAdded: 'added', projectTag: 'project', foldersLoading: 'Reading folders…', foldersEmpty: 'No folders here.', foldersTruncated: 'Showing the first 500 folders.',
      pickProjects: 'Tick the {n} project folders here', newFolder: 'New folder', newFolderPlaceholder: 'New folder name', createFolder: 'Create folder',
      folderAdded: '“{name}” added on {device}', foldersAdded: '{n} folders added on {device}',
      errFolderNotFound: 'That folder no longer exists on the device.', errFolderUnreadable: 'The device cannot read that folder.', errFolderName: 'Use a simple folder name (no slashes).',
      errFolderExists: 'A folder with that name already exists here.', errNameConflict: 'Another workspace already has that name.', errWorkspaceGone: 'That workspace is gone; the list was refreshed.',
      emptyOffline: 'Offline — its chats come back when it answers',
      deviceSection: 'Device', waitingCount: '{n} waiting for you', archived: 'Archived', undo: 'Undo', failed: 'failed',
      updating: 'Updating the device host on {device}…', updated: '{device} is up to date.',
      setAutoUpdate: 'Update devices automatically', setAutoUpdateHint: 'Keeps each device’s host and dsh in step with this computer. A device installs the update itself and goes back to the previous version if the new one does not start.',
      autoUpdateAuto: 'When the device is idle', autoUpdateAsk: 'Ask first', autoUpdateNever: 'Never',
      setUnload: 'Free memory of idle devices', setUnloadHint: 'Unloads a device’s interface on this computer after it has not been on screen for a while; it reloads quickly when you come back.',
      unloadMinutes: 'After {n} minutes', unloadNever: 'Never',
      setHealthAlerts: 'Warn about device health', setHealthAlertsHint: 'Disk almost full, memory almost exhausted or a device overloaded.',
      updateAvailable: 'Update available for {device}', updateNow2: 'Update', updatedTo: '{device} updated to {version}.', updateFailed: 'Could not update {device}: {error}',
      updatingTag: 'Updating…', updateFailedTag: 'Update failed',
      cpu: 'CPU', memory: 'Memory', disk: 'Disk', ofSize: '{used} of {total}',
      healthDisk: '{device}: disk almost full ({free} free)', healthMemory: '{device}: memory almost exhausted ({percent}% in use)', healthCpu: '{device} is overloaded (CPU {percent}%)',
      tagDisk: 'Disk almost full', tagMemory: 'Memory high', tagCpu: 'Overloaded',
      apiKeyName: 'DeepSeek API key', accountName: 'DeepSeek account', configured: 'Configured', notConfigured: 'Not set',
      signedIn: 'Signed in', notSignedIn: 'Not signed in', noModels: 'No models', setUpModels: 'Set up models', yourDevices: 'Your devices',
    })
    Object.assign(ptBR, {
      moreActions: 'Mais ações', sessionActions: 'Ações da sessão', renameSession: 'Renomear…', renameTitle: 'Renomear sessão', sessionName: 'Nome da sessão',
      pin: 'Fixar', unpin: 'Desafixar', archive: 'Arquivar', unarchive: 'Desarquivar', pinned: 'Fixado',
      archiveRunning: 'Esta sessão está rodando em {device}. Parar e arquivar?', stopAndArchive: 'Parar e arquivar',
      archivedTitle: 'Arquivados em {device}', archivedMenu: 'Chats arquivados ({n})', noArchived: 'Nenhum chat arquivado.',
      searchMenu: 'Buscar chats…', searchTitle: 'Buscar nos chats remotos', searchPlaceholder: 'Busque títulos e mensagens nos seus devices',
      searchNoResults: 'Nada encontrado.', searchInTitles: 'Títulos', searchInMessages: 'Mensagens', searching: 'Buscando…',
      pluginsMenu: 'Plug-ins', automationsMenu: 'Tarefas de automação', portsMenu: 'Portas e previews', syncMenu: 'Sincronizar com este computador…',
      accountMenu: 'Modelos e conta…', needsYou: 'Precisa de você', needsApproval: 'Precisa da sua aprovação: {tool}', needsAnswer: 'Tem uma pergunta para você',
      notifyNeedsYou: 'Precisa de você em {device}', setNotifyAttention: 'Avisar quando um chat remoto precisar de você',
      setNotifyAttentionHint: 'Aprovações e perguntas dos agentes nos seus devices.',
      portsTitle: 'Portas e previews — {device}', portsHint: 'Servidores de desenvolvimento rodando em {device}. As portas encaminhadas abrem neste computador em localhost.',
      portsEmpty: 'Nenhum servidor escutando em {device} agora. Inicie um (npm run dev…) e ele aparece aqui.',
      portForward: 'Encaminhar', portStop: 'Parar', portOpen: 'Abrir no navegador', portCopy: 'Copiar URL', portCopied: 'Copiado',
      portAuto: 'Encaminhar portas novas automaticamente', portToast: 'Porta {remote} de {device} → localhost:{local}',
      portEnsure: 'Encaminhando a porta {port} de {device}… clique no link de novo.', notForwarded: 'não encaminhada',
      syncTitle: 'Sincronizar com {device}',
      syncHint: 'Copie para {device} o que você personalizou neste computador: instruções, skills, servidores MCP, presets de agente e plug-ins. Plug-ins só de desktop ficam aqui.',
      syncLoading: 'Comparando com {device}…', syncNothing: 'Ainda não há nada personalizado neste computador para copiar.',
      syncGroup_instructions: 'Instruções (AGENTS.md)', syncGroup_skill: 'Skills', syncGroup_mcp: 'Servidores MCP', syncGroup_preset: 'Presets de agente', syncGroup_plugin: 'Plug-ins',
      syncStatus_new: 'novo', syncStatus_changed: 'alterado', syncStatus_same: 'em dia', syncStatus_unsupported: 'não suportado', syncStatus_conflict: 'já existe no device',
      'syncReason_desktop-only': 'só para desktop', 'syncReason_local-folder': 'instalado de uma pasta local', 'syncReason_no-source': 'sem origem instalável',
      'syncReason_too-large': 'grande demais', 'syncReason_no-plugin-manager': 'o device não tem gerenciador de plug-ins', 'syncReason_already-on-device': 'já existe uma linha com este id no device',
      syncWarn_secrets: 'inclui env/headers (pode conter segredos)', 'syncWarn_local-path': 'aponta para caminhos deste computador',
      syncRun: 'Sincronizar {n} item(ns)', syncDone: '{ok} de {n} item(ns) sincronizados.', syncShowSame: 'Mostrar {n} item(ns) em dia', syncAllSame: 'Tudo já está no device.',
      syncPluginsNote: 'Os plug-ins são instalados pelo gerenciador de plug-ins do device; alguns pedem reiniciar o device host.',
      accountTitle: 'Modelos e conta — {device}', accountSignedIn: 'Conta DeepSeek conectada em {device}', accountSignedOut: 'Nenhuma conta DeepSeek em {device}',
      useMacAccount: 'Usar a conta deste computador', signOutDevice: 'Sair no device', accountShared: 'Conectado em {device} com a conta deste computador.',
      accountNote: 'O device usa o login deste computador. Sair no device mantém este computador conectado; sair neste computador também desconecta o device.',
      modelReadyAccount: 'Usando a sua conta DeepSeek', addApiKey: 'Adicionar chave da API', hostOutdatedFeature: 'Atualize {device} para usar isto.',
      reconnect: 'Reconectar', reconnecting: 'Reconectando a {device}…', newIn: 'Nova sessão em {workspace}',
      newSessionHere: 'Nova sessão aqui', addFolderMenu: 'Adicionar pasta…', addFolderTo: 'Adicionar pasta em {device}', splitProjects: 'Separar em projetos…',
      removeWorkspace: 'Remover espaço de trabalho', removeWorkspaceHint: 'Isto tira “{name}” da lista de espaços de trabalho. A pasta e os chats continuam no device; os chats aparecem em Desagrupado.',
      renameWorkspace: 'Renomear espaço de trabalho', workspaceName: 'Nome do espaço de trabalho', ungrouped: 'Desagrupado', defaultWorkspace: 'Espaço de trabalho padrão',
      foldersTitle: 'Adicionar pasta em {device}', foldersHint: 'Cada pasta vira um grupo na barra lateral, como os seus espaços de trabalho locais; os chats começados nela ficam nele.',
      splitTitle: 'Separar “{folder}” em projetos', splitHint: 'Marque as pastas de projeto dentro de {folder}. Cada uma vira um grupo e os chats novos daquele projeto ficam nele. Os chats que já estão em {folder} continuam lá.',
      addThisFolder: 'Adicionar “{name}”', addFolders: 'Adicionar {n} pastas', folderUp: 'Subir uma pasta', folderHome: 'Pasta inicial', folderOpen: 'Abrir pasta', folderPath: 'Caminho da pasta (digite um e tecle Enter)',
      alreadyAdded: 'adicionada', projectTag: 'projeto', foldersLoading: 'Lendo as pastas…', foldersEmpty: 'Nenhuma pasta aqui.', foldersTruncated: 'Mostrando as primeiras 500 pastas.',
      pickProjects: 'Marcar as {n} pastas de projeto daqui', newFolder: 'Nova pasta', newFolderPlaceholder: 'Nome da nova pasta', createFolder: 'Criar pasta',
      folderAdded: '“{name}” adicionada em {device}', foldersAdded: '{n} pastas adicionadas em {device}',
      errFolderNotFound: 'Essa pasta não existe mais no device.', errFolderUnreadable: 'O device não consegue ler essa pasta.', errFolderName: 'Use um nome de pasta simples (sem barras).',
      errFolderExists: 'Já existe uma pasta com esse nome aqui.', errNameConflict: 'Outro espaço de trabalho já tem esse nome.', errWorkspaceGone: 'Esse espaço de trabalho não existe mais; a lista foi atualizada.',
      emptyOffline: 'Offline — os chats voltam quando ele responder',
      deviceSection: 'Device', waitingCount: '{n} esperando por você', archived: 'Arquivada', undo: 'Desfazer', failed: 'falhou',
      updating: 'Atualizando o device host de {device}…', updated: '{device} está atualizado.',
      setAutoUpdate: 'Atualizar devices automaticamente', setAutoUpdateHint: 'Mantém o device host e o dsh de cada device na mesma versão deste computador. O device instala sozinho e volta para a versão anterior se a nova não subir.',
      autoUpdateAuto: 'Quando o device estiver ocioso', autoUpdateAsk: 'Perguntar antes', autoUpdateNever: 'Nunca',
      setUnload: 'Liberar memória de devices parados', setUnloadHint: 'Descarrega a interface de um device neste computador quando ela fica um tempo fora da tela; ela recarrega rápido quando você volta.',
      unloadMinutes: 'Depois de {n} minutos', unloadNever: 'Nunca',
      setHealthAlerts: 'Avisar sobre a saúde dos devices', setHealthAlertsHint: 'Disco quase cheio, memória quase esgotada ou device sobrecarregado.',
      updateAvailable: 'Atualização disponível para {device}', updateNow2: 'Atualizar', updatedTo: '{device} atualizado para {version}.', updateFailed: 'Não foi possível atualizar {device}: {error}',
      updatingTag: 'Atualizando…', updateFailedTag: 'Falha na atualização',
      cpu: 'CPU', memory: 'Memória', disk: 'Disco', ofSize: '{used} de {total}',
      healthDisk: '{device}: disco quase cheio ({free} livres)', healthMemory: '{device}: memória quase esgotada ({percent}% em uso)', healthCpu: '{device} está sobrecarregado (CPU {percent}%)',
      tagDisk: 'Disco quase cheio', tagMemory: 'Memória alta', tagCpu: 'Sobrecarregado',
      apiKeyName: 'Chave da API DeepSeek', accountName: 'Conta DeepSeek', configured: 'Configurada', notConfigured: 'Não configurada',
      signedIn: 'Conectada', notSignedIn: 'Não conectada', noModels: 'Sem modelos', setUpModels: 'Configurar modelos', yourDevices: 'Seus devices',
    })
    Object.assign(zh, {
      moreActions: '更多操作', sessionActions: '会话操作', renameSession: '重命名…', renameTitle: '重命名会话', sessionName: '会话名称',
      pin: '置顶', unpin: '取消置顶', archive: '归档', unarchive: '取消归档', pinned: '已置顶',
      archiveRunning: '该会话正在 {device} 上运行。停止并归档？', stopAndArchive: '停止并归档',
      archivedTitle: '{device} 上的归档', archivedMenu: '已归档会话（{n}）', noArchived: '没有归档的会话。',
      searchMenu: '搜索会话…', searchTitle: '搜索远程会话', searchPlaceholder: '在你的设备上搜索标题和消息',
      searchNoResults: '没有匹配项。', searchInTitles: '标题', searchInMessages: '消息', searching: '搜索中…',
      pluginsMenu: '插件', automationsMenu: '自动化任务', portsMenu: '端口与预览', syncMenu: '与本机同步…',
      accountMenu: '模型与账号…', needsYou: '需要你处理', needsApproval: '需要你批准：{tool}', needsAnswer: '有问题要问你',
      notifyNeedsYou: '{device} 需要你处理', setNotifyAttention: '远程会话需要你处理时通知', setNotifyAttentionHint: '来自设备上代理的审批和提问。',
      portsTitle: '端口与预览 — {device}', portsHint: '{device} 上运行的开发服务器。转发的端口在本机 localhost 上打开。',
      portsEmpty: '{device} 上暂时没有监听中的开发服务器。启动一个（npm run dev…）后会显示在这里。',
      portForward: '转发', portStop: '停止', portOpen: '在浏览器中打开', portCopy: '复制地址', portCopied: '已复制',
      portAuto: '自动转发新端口', portToast: '{device} 的端口 {remote} → localhost:{local}', portEnsure: '正在转发 {device} 的端口 {port}… 请再次点击链接。', notForwarded: '未转发',
      syncTitle: '与 {device} 同步', syncHint: '把你在本机上的自定义复制到 {device}：指令、技能、MCP 服务器、代理预设和插件。仅桌面端插件不会复制。',
      syncLoading: '正在与 {device} 比较…', syncNothing: '本机还没有可复制的自定义内容。',
      syncGroup_instructions: '指令（AGENTS.md）', syncGroup_skill: '技能', syncGroup_mcp: 'MCP 服务器', syncGroup_preset: '代理预设', syncGroup_plugin: '插件',
      syncStatus_new: '新增', syncStatus_changed: '已更改', syncStatus_same: '已是最新', syncStatus_unsupported: '不支持', syncStatus_conflict: '设备上已存在',
      'syncReason_desktop-only': '仅限桌面端', 'syncReason_local-folder': '从本地文件夹安装', 'syncReason_no-source': '没有可安装的来源',
      'syncReason_too-large': '太大', 'syncReason_no-plugin-manager': '设备没有插件管理器', 'syncReason_already-on-device': '设备上已有相同 id 的条目',
      syncWarn_secrets: '包含 env/headers（可能含有密钥）', 'syncWarn_local-path': '引用了本机路径', syncRun: '同步 {n} 项', syncDone: '已同步 {ok}/{n} 项。', syncShowSame: '显示 {n} 个已是最新的项', syncAllSame: '设备上已全部是最新。',
      syncPluginsNote: '插件由设备的插件管理器安装；部分需要重启设备主机。',
      accountTitle: '模型与账号 — {device}', accountSignedIn: '{device} 已登录 DeepSeek 账号', accountSignedOut: '{device} 没有登录 DeepSeek 账号',
      useMacAccount: '使用本机的账号', signOutDevice: '在设备上退出', accountShared: '已用本机账号登录 {device}。',
      accountNote: '设备使用本机的登录。在设备上退出不影响本机；在本机退出会同时让设备失效。',
      modelReadyAccount: '正在使用你的 DeepSeek 账号', addApiKey: '添加 API Key', hostOutdatedFeature: '请更新 {device} 后使用。', deviceSection: '设备', waitingCount: '{n} 个等待你处理', archived: '已归档', undo: '撤销', failed: '失败',
      updating: '正在更新 {device} 的设备主机…', updated: '{device} 已是最新。',
      setAutoUpdate: '自动更新设备', setAutoUpdateHint: '让每台设备的主机和 dsh 与本机保持同一版本。设备自行安装，新版本无法启动时会恢复旧版本。',
      autoUpdateAuto: '设备空闲时', autoUpdateAsk: '先询问', autoUpdateNever: '从不',
      setUnload: '释放空闲设备的内存', setUnloadHint: '设备界面一段时间不在屏幕上时在本机卸载，回来时会快速重新加载。', unloadMinutes: '{n} 分钟后', unloadNever: '从不',
      setHealthAlerts: '设备状况提醒', setHealthAlertsHint: '磁盘快满、内存快用完或设备过载。',
      updateAvailable: '{device} 有可用更新', updateNow2: '更新', updatedTo: '{device} 已更新到 {version}。', updateFailed: '无法更新 {device}：{error}',
      updatingTag: '更新中…', updateFailedTag: '更新失败', cpu: 'CPU', memory: '内存', disk: '磁盘', ofSize: '{used} / {total}',
      healthDisk: '{device}：磁盘快满了（剩余 {free}）', healthMemory: '{device}：内存快用完了（已用 {percent}%）', healthCpu: '{device} 过载（CPU {percent}%）',
      tagDisk: '磁盘快满', tagMemory: '内存高', tagCpu: '过载', apiKeyName: 'DeepSeek API Key', accountName: 'DeepSeek 账号', configured: '已配置', notConfigured: '未设置', signedIn: '已登录', notSignedIn: '未登录',
      noModels: '没有模型', setUpModels: '设置模型', yourDevices: '你的设备',
    })

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
      if (!res.ok) {
        const error = new Error((body && body.error) || `HTTP ${res.status}`)
        error.code = (body && body.code) || null
        error.status = res.status
        throw error
      }
      return body
    }
    const post = (path, value) => api(path, { method: 'POST', body: JSON.stringify(value ?? {}) })

    // ── shared store (sidebar root, main panels and Devices page) ───────────
    /** The "Group by" picked in DSH's sidebar view options (stored by DSH in the browser). */
    const NATIVE_VIEW_KEY = 'dsh.workspace.view.v5'
    function nativeGroupBy() {
      try {
        const v = JSON.parse(localStorage.getItem(NATIVE_VIEW_KEY) || 'null')
        const g = v && (v.groupBy ?? (v.state && v.state.groupBy))
        return g === 'flat' || g === 'workspace-tree' ? g : 'workspace'
      } catch {
        return 'workspace'
      }
    }
    /** Follow it: remote chats group the way the local ones do. */
    function watchNativeGroupBy() {
      const check = () => {
        const g = nativeGroupBy()
        if (g !== store.groupBy) setStore({ groupBy: g })
      }
      const timer = setInterval(check, 1200)
      const onStorage = (e) => e.key === NATIVE_VIEW_KEY && check()
      window.addEventListener('storage', onStorage)
      // The view-options menu writes it on a click: check right after one, too.
      const onClick = () => setTimeout(check, 50)
      document.addEventListener('click', onClick, true)
      return () => {
        clearInterval(timer)
        window.removeEventListener('storage', onStorage)
        document.removeEventListener('click', onClick, true)
      }
    }

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
      localKey: null,
      openAdd: false,
      settings: readSettings(),
      editors: [],
      askEditorHost: null,
      toast: null,
      localAccount: null,
      /** open dialog: { kind: 'rename'|'sync'|'ports'|'archived'|'account'|'confirm-archive', deviceId?, sessionId?, title? } */
      dialog: null,
      /** device picker anchored to a pill: { rect, current } */
      picker: null,
      /** remote turns that finished since their chat was last open ("deviceId:sessionId" → true), like DSH's completion dot */
      unread: readUnread(),
      /** query typed in DSH's own sidebar search */
      nativeSearch: '',
      /** DSH's own sidebar "Group by" (its view options): 'workspace' | 'workspace-tree' | 'flat' */
      groupBy: nativeGroupBy(),
      expanded: {},
      localUntil: 0,
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
    async function refreshLocalKey() {
      try {
        const r = await api('/devices/local-model-key')
        if (store.localKey !== !!r.available) setStore({ localKey: !!r.available })
      } catch {}
      try {
        const r = await api('/devices/local-account')
        if (store.localAccount !== !!r.available) setStore({ localAccount: !!r.available })
      } catch {}
    }
    async function refreshDevices() {
      try {
        const data = await api('/devices')
        setStore({ data, loaded: true, error: null })
        afterData()
      } catch (e) {
        setStore({ error: e.message })
      }
    }
    /** Push port maps into the embedded device UIs; announce ports forwarded automatically. */
    const knownForwards = new Map()
    const primedPorts = new Set()
    /** Warn once when a device's disk, memory or CPU crosses into trouble (CPU only when it lasts). */
    const healthAlerted = new Map()
    const cpuStreak = new Map()
    function checkHealth() {
      if (store.settings.healthAlerts === false) return
      const focused = document.visibilityState === 'visible' && document.hasFocus()
      for (const d of store.data.devices || []) {
        if (d.status !== 'online' || !d.health) continue
        const issues = healthIssues(d.health)
        const at = d.health.at
        const streak = cpuStreak.get(d.id) || { at: null, n: 0 }
        if (issues.some((i) => i.key === 'cpu')) {
          if (streak.at !== at) cpuStreak.set(d.id, { at, n: streak.n + 1 })
        } else cpuStreak.set(d.id, { at, n: 0 })
        for (const key of ['disk', 'memory', 'cpu']) {
          const k = `${d.id}:${key}`
          const issue = issues.find((i) => i.key === key)
          const lasting = key !== 'cpu' || (cpuStreak.get(d.id) || {}).n >= 3
          if (!issue || !lasting) {
            if (!issue) healthAlerted.delete(k)
            continue
          }
          const before = healthAlerted.get(k)
          if (before === issue.level || (before === 'critical' && issue.level === 'warning')) continue
          healthAlerted.set(k, issue.level)
          const text =
            key === 'disk'
              ? fill(appT('healthDisk'), { device: d.name, free: formatBytes(d.health.disk.free) })
              : key === 'memory'
                ? fill(appT('healthMemory'), { device: d.name, percent: Math.round(d.health.memory.percent) })
                : fill(appT('healthCpu'), { device: d.name, percent: Math.round(d.health.cpu.percent) })
          showToast(text, { icon: Icon('IconWarningOutlineRegular'), holdMs: 8000, kind: 'health' })
          if (!focused || issue.level === 'critical') sendNotification({ key: `${k}:${issue.level}:${at}`, title: d.name, body: text })
        }
      }
    }

    const lastStatus = new Map()
    function afterData() {
      try {
        frames.syncPorts()
      } catch {}
      // A device that answers again brings back any of its UIs that had given up.
      for (const d of store.data.devices || []) {
        const before = lastStatus.get(d.id)
        lastStatus.set(d.id, d.status)
        if (before && before !== 'online' && d.status === 'online') {
          try {
            frames.deviceBack(d.id)
          } catch {}
        }
      }
      try {
        checkHealth()
      } catch {}
      // Forget read marks of devices and sessions that are gone (only once a device's list is known).
      const devices = store.data.devices || []
      let pruned = null
      for (const key of Object.keys(store.unread)) {
        const [deviceId, sessionId] = key.split(':')
        const d = devices.find((x) => x.id === deviceId)
        const gone = !d || (d.sessionsAt && Array.isArray(d.sessions) && !d.sessions.some((s) => s.sessionId === sessionId))
        if (gone) {
          pruned = pruned || { ...store.unread }
          delete pruned[key]
        }
      }
      if (pruned) {
        try {
          localStorage.setItem('dsh-devices.unread', JSON.stringify(pruned))
        } catch {}
        store.unread = pruned
      }
      for (const d of store.data.devices || []) {
        if (!d.portsKnown) continue
        // The first port list of a device (app start) is recorded silently.
        const first = !primedPorts.has(d.id)
        primedPorts.add(d.id)
        for (const p of d.ports || []) {
          const key = `${d.id}:${p.port}`
          if (!p.localPort) {
            knownForwards.delete(key)
            continue
          }
          if (knownForwards.get(key) === p.localPort) continue
          knownForwards.set(key, p.localPort)
          if (!first) {
            pushNote({
              id: `port-${key}-${p.localPort}`,
              title: fill(appT('portToast'), { remote: p.port, device: d.name, local: p.localPort }),
              body: p.label || '',
              actions: [{ label: appT('portOpen'), run: () => openForwarded(p.localPort) }],
            })
          }
        }
      }
    }
    // Live updates: one long-poll that the host answers as soon as anything changes.
    let watching = false
    async function watchLoop() {
      if (watching) return
      watching = true
      let failures = 0
      while (store.listeners.size > 0) {
        try {
          const data = await api(`/devices/watch?v=${encodeURIComponent(store.data.version ?? 0)}`)
          failures = 0
          setStore({ data, loaded: true, error: null })
          handleNotifications(data.notifications)
          afterData()
        } catch (e) {
          failures += 1
          if (failures > 1) setStore({ error: e.message })
          await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** failures)))
        }
      }
      watching = false
    }
    function startPolling() {
      refreshDevices().then(() => handleNotifications(store.data.notifications))
      refreshLocalKey()
      watchLoop()
      pollTimer = setInterval(refreshLocalKey, 60_000)
    }
    function stopPolling() {
      clearInterval(pollTimer)
      pollTimer = null
    }

    // ── editors on this computer ─────────────────────────────────────────────
    let editorsLoaded = false
    async function loadEditors() {
      if (editorsLoaded) return
      editorsLoaded = true
      try {
        const r = await api('/devices/editors')
        setStore({ editors: r.editors || [] })
        frames.broadcastConfig()
      } catch {
        editorsLoaded = false
      }
    }
    function currentEditor() {
      const list = store.editors || []
      return list.find((e) => e.id === store.settings.editor) || list.find((e) => e.installed) || list[0] || { id: 'vscode', label: 'VS Code' }
    }
    let toastSeq = 0
    const toastQueue = []
    /**
     * DSH's own toast (bottom centre, one at a time): `{ icon, tone, actions: [{ label, onClick }], holdMs, kind }`.
     * A showing "needs you" notice is not replaced by a lesser toast: that one waits its turn.
     */
    function showToast(text, options = {}) {
      toastSeq += 1
      const next = { seq: toastSeq, text, ...options }
      if (store.toast && store.toast.kind === 'attention' && next.kind !== 'attention') {
        toastQueue.push(next)
        return
      }
      setStore({ toast: next })
    }
    function toastDone(seq) {
      if (!store.toast || store.toast.seq !== seq) return
      setStore({ toast: toastQueue.shift() || null })
    }
    async function openInEditor(deviceId, { path: target, sessionId } = {}) {
      const device = (store.data.devices || []).find((d) => d.id === deviceId)
      const editor = currentEditor()
      try {
        await post('/devices/open-editor', { id: deviceId, path: target, sessionId, editor: editor.id })
        showToast(fill(appT('editorOpening'), { editor: editor.label }))
      } catch (e) {
        if (device && !device.editorHost) setStore({ askEditorHost: { deviceId, path: target, sessionId } })
        else showToast(e.message)
      }
    }

    // ── notifications for finished remote turns ──────────────────────────────
    const seenNotes = new Set()
    let notesPrimed = false
    function handleNotifications(list) {
      if (!Array.isArray(list)) return
      if (!notesPrimed) {
        for (const n of list) seenNotes.add(n.id)
        notesPrimed = true
        return
      }
      for (const n of list) {
        if (seenNotes.has(n.id)) continue
        seenNotes.add(n.id)
        if (n.kind !== 'attention' && !/abort|cancel|interrupt/i.test(n.reason || '') && !chatVisible(n.deviceId, n.sessionId)) setUnread(`${n.deviceId}:${n.sessionId}`, true)
        maybeNotify(n)
      }
    }
    function maybeNotify(n) {
      const device = (store.data.devices || []).find((d) => d.id === n.deviceId)
      const focused = document.visibilityState === 'visible' && document.hasFocus()
      const open = () => device && openRemote(appCtx, device, n.sessionId)
      if (n.kind === 'attention') {
        if (store.settings.notifyAttention === false) return
        const title = n.title || nt('session.untitled', null, appT('untitled'))
        // DSH's own words for the state ("Waiting for approval"), then where.
        const what = n.pendingKind === 'approval' ? nt('status.waitingApproval', null, 'Waiting for approval') : nt('status.waitingAnswer', null, 'Waiting for answer')
        // Looking at this very chat already: nothing to say.
        if (focused && store.activePanel === CHAT_PANEL_ID && store.selection && store.selection.deviceId === n.deviceId && store.embedded[n.deviceId] === n.sessionId) return
        pushNote({ id: n.id, kind: 'attention', title, body: `${what} · ${n.deviceName}`, actions: [{ label: appT('open'), run: open }] })
        if (!focused) {
          const detail = n.pendingKind === 'approval' ? fill(appT('needsApproval'), { tool: n.toolName || '' }) : appT('needsAnswer')
          sendNotification({ key: n.id, title, body: `${fill(appT('notifyNeedsYou'), { device: n.deviceName })} — ${detail}`, onClick: open })
        }
        return
      }
      if (n.kind === 'update') {
        if (n.ok) showToast(fill(appT('updatedTo'), { device: n.deviceName, version: n.to || '' }), { tone: 'success', holdMs: 5000 })
        else {
          showToast(fill(appT('updateFailed'), { device: n.deviceName, error: n.error || '' }), { icon: Icon('IconWarningOutlineRegular'), holdMs: 8000 })
          if (!focused) sendNotification({ key: n.id, title: n.deviceName, body: fill(appT('updateFailed'), { device: n.deviceName, error: n.error || '' }) })
        }
        return
      }
      if (n.kind === 'update-available') {
        showToast(fill(appT('updateAvailable'), { device: n.deviceName }), {
          icon: Icon('IconDownloadOutlineRegular'),
          holdMs: 10_000,
          actions: [{ label: appT('updateNow2'), onClick: () => (setStore({ toast: null }), device && startDeviceUpdate(device)) }],
        })
        return
      }
      const mode = store.settings.notify
      if (mode === 'never') return
      if (/abort|cancel|interrupt/i.test(n.reason || '')) return
      if (mode === 'background' && focused) return
      const title = n.title || appT('untitled')
      const body = fill(appT('notifyDone'), { device: n.deviceName })
      sendNotification({ key: n.id, title, body, onClick: open })
    }

    /** A notice with an action (attention, a forwarded port), as a DSH toast that stays a little longer. */
    const shownNotes = new Set()
    function pushNote(note) {
      if (shownNotes.has(note.id)) return
      shownNotes.add(note.id)
      showToast(note.body ? `${note.title} — ${note.body}` : note.title, {
        kind: note.kind || 'info',
        icon: note.kind === 'attention' ? Icon('IconWarningOutlineRegular') : Icon('IconGlobeOutlineRegular'),
        actions: (note.actions || []).map((a) => ({ label: a.label, onClick: () => (setStore({ toast: null }), a.run()) })),
        holdMs: note.kind === 'attention' ? 10_000 : 6000,
      })
    }
    async function openForwarded(localPort) {
      try {
        await post('/devices/open-forwarded', { url: `http://localhost:${localPort}/` })
      } catch (e) {
        showToast(e.message)
      }
    }
    function hashId(text) {
      let h = 0
      for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) | 0
      return Math.abs(h) % 2147483647 || 1
    }
    /** System notification through the desktop app when available, the browser otherwise. */
    async function sendNotification({ key, title, body, onClick }) {
      const tauri = window.__TAURI_INTERNALS__
      if (tauri && typeof tauri.invoke === 'function') {
        try {
          const granted = (await tauri.invoke('plugin:notifications|is_permission_granted')) || (await tauri.invoke('plugin:notifications|request_permission')) === 'granted'
          if (granted) {
            await tauri.invoke('plugin:notifications|notify', { options: { id: hashId(key), title, body } })
            return true
          }
        } catch {}
      }
      try {
        if (typeof Notification === 'undefined') return false
        if (Notification.permission === 'default') await Notification.requestPermission()
        if (Notification.permission !== 'granted') return false
        const note = new Notification(title, { body, tag: key })
        note.onclick = () => {
          window.focus()
          onClick && onClick()
        }
        window.__dshDevicesLastNotification = { title, body }
        return true
      } catch {
        return false
      }
    }
    // Function (hoisted), not a const: the store object above reads settings at module start.
    function settingsDefaults() {
      return { notify: 'background', notifyAttention: true, showInSidebar: true, sessionsPerGroup: 5, preload: true, defaultDevice: 'local', editor: '', unloadAfter: 10, healthAlerts: true }
    }
    function readSettings() {
      try {
        return { ...settingsDefaults(), ...JSON.parse(localStorage.getItem('dsh-devices.settings') || '{}') }
      } catch {
        return settingsDefaults()
      }
    }
    function setSetting(key, value) {
      const next = { ...store.settings, [key]: value }
      try {
        localStorage.setItem('dsh-devices.settings', JSON.stringify(next))
      } catch {}
      setStore({ settings: next })
    }
    function readUnread() {
      try {
        return JSON.parse(localStorage.getItem('dsh-devices.unread') || '{}')
      } catch {
        return {}
      }
    }
    function setUnread(key, on) {
      if (!!store.unread[key] === !!on) return
      const next = { ...store.unread }
      if (on) next[key] = true
      else delete next[key]
      try {
        localStorage.setItem('dsh-devices.unread', JSON.stringify(next))
      } catch {}
      setStore({ unread: next })
    }
    /** The window came back: the remote chat on screen is read. */
    function clearVisibleUnread() {
      if (document.visibilityState !== 'visible' || store.activePanel !== CHAT_PANEL_ID || !store.selection) return
      const { deviceId } = store.selection
      const sessionId = store.selection.sessionId || store.embedded[deviceId]
      if (sessionId) setUnread(`${deviceId}:${sessionId}`, false)
    }
    /** Whether this remote chat is on screen right now. */
    function chatVisible(deviceId, sessionId) {
      return store.activePanel === CHAT_PANEL_ID && !!store.selection && store.selection.deviceId === deviceId && (store.selection.sessionId === sessionId || store.embedded[deviceId] === sessionId) && document.visibilityState === 'visible'
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
        const status = document.createElement('div')
        status.className = 'dshdev-chat-status dshdev-frame-overlay'
        status.style.display = 'none'
        host.appendChild(status)
        this.status = status
        this.statusRoot = ReactDOMClient.createRoot(status)
        document.body.appendChild(host)
        this.host = host
        window.addEventListener('message', (event) => this.onMessage(event))
        window.addEventListener('resize', () => this.layout())
        // Desktop dialogs (Settings, our prompts) must stay above the embedded device UI.
        const lift = () => {
          let open = false
          for (const dialog of document.querySelectorAll('[role=dialog]')) {
            if (host.contains(dialog)) continue
            open = true
            let el = dialog
            while (el && el !== document.body) {
              const cs = getComputedStyle(el)
              if (cs.position === 'fixed') {
                if (!(Number(cs.zIndex) > 4)) el.style.zIndex = '20'
                break
              }
              el = el.parentElement
            }
          }
          // Dim the device UI like the rest of the window while a desktop dialog is open.
          host.style.filter = open ? 'brightness(0.62)' : ''
        }
        let queued = false
        new MutationObserver(() => {
          if (queued) return
          queued = true
          requestAnimationFrame(() => {
            queued = false
            lift()
          })
        }).observe(document.body, { childList: true, subtree: true })
        return host
      },
      onMessage(event) {
        const msg = event.data
        if (!msg || msg.source !== 'dsh-device-host') return
        for (const [deviceId, f] of this.byDevice) {
          if (f.iframe.contentWindow !== event.source) continue
          if (msg.type === 'ready') this.onReady(deviceId, { announced: true })
          if (msg.type === 'panel' && typeof msg.panel === 'string') this.panelAnswered(deviceId, msg.panel, !!msg.ok, msg.error)
          if (msg.type === 'unreachable') this.markUnreachable(deviceId, String(msg.error || ''))
          if (msg.type === 'open-editor') openInEditor(deviceId, { path: msg.path, sessionId: msg.sessionId })
          if (msg.type === 'ensure-port' && Number(msg.port) > 0) {
            const device = (store.data.devices || []).find((d) => d.id === deviceId)
            post('/devices/port-forward', { id: deviceId, port: Number(msg.port) })
              .then(() => {
                showToast(fill(appT('portEnsure'), { port: msg.port, device: device ? device.name : '' }))
                return refreshDevices()
              })
              .catch((e) => showToast(e.message))
          }
          if (msg.type === 'pick-device' && msg.rect) {
            const r = f.iframe.getBoundingClientRect()
            openDevicePicker({ rect: { left: r.left + msg.rect.left, top: r.top + msg.rect.top, right: r.left + msg.rect.right, bottom: r.top + msg.rect.bottom }, current: deviceId })
          }
          if (msg.type === 'session') {
            store.embedded = { ...store.embedded, [deviceId]: msg.sessionId || null }
            // (a device panel stays selected: the device reports its current session on boot too)
            if (store.selection && store.selection.deviceId === deviceId && msg.sessionId) store.selection = { ...store.selection, sessionId: msg.sessionId }
            emit()
            if (msg.sessionId && chatVisible(deviceId, msg.sessionId)) setUnread(`${deviceId}:${msg.sessionId}`, false)
          }
        }
      },
      /** The device UI is up (it said so, or an older host had time to boot): show it, run what waited. */
      onReady(deviceId, { announced }) {
        const f = this.byDevice.get(deviceId)
        if (!f) return
        // The gateway's "unreachable" page fires load too: only the device UI itself clears that.
        if (!announced && f.unreachable) return
        f.ready = true
        f.unreachable = false
        if (announced) this.sendConfig(deviceId)
        this.markLoaded(deviceId)
        for (const m of f.pending.splice(0)) this.send(deviceId, m)
        const entry = this.panels.get(deviceId)
        if (entry && entry.mode === 'legacy' && entry.state === 'opening') this.legacyOpened(deviceId, entry)
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
      /** Boot a device's UI in the background so opening it later is instant. */
      async preload(deviceId, device) {
        if (this.byDevice.has(deviceId) || this.preloading?.has(deviceId)) return
        this.preloading = this.preloading || new Set()
        this.preloading.add(deviceId)
        try {
          await this.show(deviceId, device, null, { background: true })
        } finally {
          this.preloading.delete(deviceId)
        }
      },
      /** Address of a device UI that boots straight into `command` (a session, a new session, or a panel). */
      srcFor(root, device, command) {
        const params = new URLSearchParams({ 'dsh-embed': '1', 'dsh-device': device ? device.name : '' })
        if (command && command.type === 'open-session' && command.sessionId) params.set('dsh-session', command.sessionId)
        if (command && command.type === 'new-session') params.set('dsh-new', command.workspaceId || '1')
        if (command && command.type === 'open-panel' && command.ack) params.set('dsh-panel', command.panel)
        if (command && command.files) params.set('dsh-files', '1')
        return `${root}?${params.toString()}`
      },
      /** What the desktop shows for `deviceId` right now, as a boot command (used when its UI reloads). */
      currentCommand(deviceId) {
        const sel = store.selection
        if (!sel || sel.deviceId !== deviceId) return store.embedded[deviceId] ? { type: 'open-session', sessionId: store.embedded[deviceId] } : null
        const device = deviceById(deviceId)
        if (sel.panel) return device && device.panels === 'ack' ? { type: 'open-panel', panel: sel.panel, ack: true } : null
        const sessionId = sel.sessionId || store.embedded[deviceId]
        return sessionId ? { type: 'open-session', sessionId } : null
      },

      // ── device panels (Plugins, Automations…) ──
      /** deviceId -> { id, state: 'opening' | 'open' | 'failed' | 'unsupported', mode, error, startedAt } */
      panels: new Map(),
      /** Open one of the device's own panels, and keep the user posted until it is on screen. */
      openPanel(device, panel) {
        const id = device.id
        this.clearPanel(id)
        const mode = device.panels || (hasFeature(device, 'panels') ? 'ack' : 'legacy')
        const entry = { id: panel, state: mode === 'none' ? 'unsupported' : 'opening', mode, error: null, startedAt: Date.now(), timers: [] }
        this.panels.set(id, entry)
        if (mode === 'none') {
          // Too old to open it: keep its UI behind the explanation.
          this.show(id, device, null).catch(() => {})
          this.renderStatus()
          return
        }
        this.armPanel(id, entry)
        const f = this.byDevice.get(id)
        if (mode === 'legacy' && f && f.ready) this.legacyOpened(id, entry)
        this.show(id, device, { type: 'open-panel', panel, ack: mode === 'ack' }).catch((e) => {
          if (this.panels.get(id) !== entry) return
          entry.state = 'failed'
          entry.error = e.message
          this.renderStatus()
        })
        this.renderStatus()
      },
      /** (Re)start a panel's clock: a "slow" note at 10 s, and a verdict if no answer comes. */
      armPanel(deviceId, entry) {
        for (const timer of entry.timers) clearTimeout(timer)
        entry.timers = []
        entry.state = 'opening'
        entry.error = null
        entry.startedAt = Date.now()
        entry.timers.push(setTimeout(() => this.renderStatus(), 10_000))
        entry.timers.push(
          setTimeout(() => {
            if (this.panels.get(deviceId) !== entry || entry.state !== 'opening') return
            // An older host never answers: by now it has opened the panel, or never will.
            if (entry.mode === 'ack') {
              entry.state = 'failed'
              entry.error = 'timeout'
            } else entry.state = 'open'
            this.renderStatus()
          }, entry.mode === 'ack' ? 75_000 : 20_000),
        )
      },
      /** An older host opens the panel soon after it gets the request, without saying so. */
      legacyOpened(deviceId, entry) {
        entry.timers.push(
          setTimeout(() => {
            if (this.panels.get(deviceId) !== entry || entry.state !== 'opening') return
            entry.state = 'open'
            this.renderStatus()
          }, 1500),
        )
      },
      panelAnswered(deviceId, panel, ok, error) {
        const entry = this.panels.get(deviceId)
        if (!entry || entry.id !== panel || entry.state === 'unsupported') return
        entry.state = ok ? 'open' : 'failed'
        entry.error = ok ? null : String(error || '')
        for (const timer of entry.timers) clearTimeout(timer)
        this.renderStatus()
      },
      clearPanel(deviceId) {
        const entry = this.panels.get(deviceId)
        if (!entry) return
        for (const timer of entry.timers) clearTimeout(timer)
        this.panels.delete(deviceId)
        if (this.active === deviceId) this.renderStatus()
      },
      /** The panel state to show over the active device UI (only while that panel is selected). */
      shownPanel() {
        const id = this.active
        const entry = id && this.panels.get(id)
        const sel = store.selection
        if (!entry || !sel || sel.deviceId !== id || sel.panel !== entry.id) return null
        return entry.state === 'open' ? null : entry
      },

      /** Show `deviceId` and run `command` in it: { type: 'open-session', sessionId } | { type: 'new-session', workspaceId } | { type: 'open-panel', panel, ack } */
      async show(deviceId, device, command, { background = false } = {}) {
        this.ensureHost()
        // One iframe per device even when several opens race (e.g. "Files" = open + show files).
        this.creating = this.creating || new Map()
        if (!this.byDevice.has(deviceId) && this.creating.has(deviceId)) {
          await this.creating.get(deviceId)
        }
        let f = this.byDevice.get(deviceId)
        if (!f) {
          let release
          this.creating.set(deviceId, new Promise((r) => (release = r)))
          let root
          try {
            root = await deviceRoot(deviceId)
          } catch (error) {
            this.creating.delete(deviceId)
            release()
            throw error
          }
          const iframe = document.createElement('iframe')
          iframe.title = device ? device.name : deviceId
          iframe.allow = 'clipboard-read; clipboard-write'
          iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;display:none;background:transparent;visibility:hidden'
          iframe.src = this.srcFor(root, device, command)
          this.host.appendChild(iframe)
          f = { iframe, root, ready: false, pending: [], createdAt: Date.now(), lastVisibleAt: background ? 0 : Date.now() }
          // (sessions, new sessions and answered panels ride on the address; the rest waits for "ready")
          const onAddress = command && (command.type === 'open-session' || command.type === 'new-session' || (command.type === 'open-panel' && command.ack))
          if (command && !onAddress) f.pending.push(command)
          this.byDevice.set(deviceId, f)
          iframe.addEventListener('load', () => {
            if (iframe.src === 'about:blank') return
            // The device UI announces readiness itself; this covers older hosts (never the
            // gateway's "unreachable" page, which also fires load).
            setTimeout(() => {
              if (!f.ready && f.iframe.src !== 'about:blank' && this.byDevice.get(deviceId) === f) this.onReady(deviceId, { announced: false })
            }, 8000)
          })
          this.watch(deviceId)
          this.creating.delete(deviceId)
          release()
        } else if (command) this.send(deviceId, command)
        if (background) return
        f.lastVisibleAt = Date.now()
        this.active = deviceId
        for (const [id, x] of this.byDevice) x.iframe.style.display = id === deviceId ? 'block' : 'none'
        this.renderStatus()
        this.layout()
      },
      sendConfig(deviceId) {
        const editor = currentEditor()
        const f = this.byDevice.get(deviceId)
        if (!f || !f.iframe.contentWindow) return
        try {
          f.iframe.contentWindow.postMessage({ source: 'dsh-devices', type: 'config', editorLabel: editor.label, editorTitle: appT('editorTitle') }, '*')
        } catch {}
        f.portsSent = null
        this.syncPorts()
      },
      /** Tell each embedded device UI where its dev-server ports are reachable from here. */
      syncPorts() {
        for (const [deviceId, f] of this.byDevice) {
          if (!f.ready || !f.iframe.contentWindow) continue
          const device = (store.data.devices || []).find((d) => d.id === deviceId)
          const map = (device && device.portMap) || {}
          const text = JSON.stringify(map)
          if (f.portsSent === text) continue
          f.portsSent = text
          try {
            f.iframe.contentWindow.postMessage({ source: 'dsh-devices', type: 'ports', map }, '*')
          } catch {}
        }
      },
      broadcastConfig() {
        for (const id of this.byDevice.keys()) this.sendConfig(id)
      },
      reload(deviceId) {
        const f = this.byDevice.get(deviceId)
        if (!f) return
        f.ready = false
        f.loaded = false
        f.pending = []
        // Boot into what is on screen now (not into what the frame first opened).
        const command = this.currentCommand(deviceId)
        const src = this.srcFor(f.root, deviceById(deviceId), command)
        f.unreachable = false
        // The panel on screen comes back with the UI (on an older host, as a request once it is ready).
        const entry = this.panels.get(deviceId)
        const sel = store.selection
        if (entry && entry.state !== 'unsupported' && sel && sel.deviceId === deviceId && sel.panel === entry.id) {
          this.armPanel(deviceId, entry)
          if (entry.mode === 'legacy') f.pending.push({ type: 'open-panel', panel: entry.id })
        }
        f.iframe.style.visibility = 'hidden'
        f.iframe.src = 'about:blank'
        setTimeout(() => {
          f.iframe.src = src
          this.watch(deviceId)
        }, 50)
        this.renderStatus()
      },
      /** The device UI is up: show it. */
      markLoaded(deviceId) {
        const f = this.byDevice.get(deviceId)
        if (!f) return
        f.loaded = true
        f.failed = false
        f.slow = false
        f.error = null
        clearTimeout(f.timer)
        clearTimeout(f.slowTimer)
        f.iframe.style.visibility = 'visible'
        this.renderStatus()
      },
      /** The gateway could not reach the device for the page itself: say so now, offer a retry. */
      markUnreachable(deviceId, error) {
        const f = this.byDevice.get(deviceId)
        if (!f) return
        f.ready = false
        f.loaded = false
        f.failed = true
        f.unreachable = true
        f.error = error
        clearTimeout(f.timer)
        clearTimeout(f.slowTimer)
        f.iframe.style.visibility = 'hidden'
        // A panel is not on screen any more either; it opens again when the device answers.
        const entry = this.panels.get(deviceId)
        if (entry && (entry.state === 'opening' || entry.state === 'open')) entry.state = 'waiting'
        this.renderStatus()
      },
      /**
       * Give the device UI time: a first load over a slow link brings ~5 MB from the
       * device. Past 10 s say it is slow; only past a minute call it failed.
       */
      watch(deviceId) {
        const f = this.byDevice.get(deviceId)
        if (!f) return
        clearTimeout(f.timer)
        clearTimeout(f.slowTimer)
        f.failed = false
        f.slow = false
        f.error = null
        f.startedAt = Date.now()
        f.slowTimer = setTimeout(() => {
          if (f.loaded) return
          f.slow = true
          this.renderStatus()
        }, 10_000)
        f.timer = setTimeout(() => {
          if (f.loaded) return
          f.failed = true
          this.renderStatus()
        }, 60_000)
      },
      /** A device came back: reload any of its UIs that had given up. */
      deviceBack(deviceId) {
        const f = this.byDevice.get(deviceId)
        if (f && f.failed && !f.loaded) this.reload(deviceId)
      },
      renderStatus() {
        if (!this.status) return
        const id = this.active
        const f = id && this.byDevice.get(id)
        const device = id && deviceById(id)
        const name = device ? device.name : 'device'
        const panel = this.shownPanel()
        if (!f || (f.loaded && !panel)) {
          this.status.style.display = 'none'
          this.statusRoot.render(null)
          return
        }
        this.status.style.display = 'flex'
        const panelName = panel ? panelLabel(panel.id) : ''
        const reboot = () => {
          entries.delete(id)
          this.drop(id)
          const d = deviceById(id)
          if (!d) return
          if (panel) this.openPanel(d, panel.id)
          else this.show(id, d, this.currentCommand(id)).catch(() => {})
        }
        const windowButton = device ? h(ModalButton, { variant: 'outline', onClick: () => openInWindow(device, { panel: panel ? panel.id : null }).catch(() => {}) }, appT('openWindow')) : null
        const shimmer = (text) => (P.TextShimmer ? h(P.TextShimmer, null, text) : h('div', null, text))
        let body
        if (panel && panel.state === 'unsupported') {
          const version = (device && device.versions && device.versions.plugin) || '?'
          body = [
            h('div', { key: 't', className: 'dshdev-frame-status-title' }, fill(appT('panelOldHost'), { device: name, panel: panelName })),
            h('div', { key: 'd', className: 'dshdev-frame-status-detail' }, fill(device && device.canUpdate ? appT('panelOldHostHint') : appT('panelOldHostManual'), { version })),
            h(
              'div',
              { key: 'a', className: 'dshdev-frame-status-actions' },
              device && device.canUpdate ? h(ModalButton, { variant: 'primary', testid: 'dsh-devices-panel-update', disabled: !!device.updating, onClick: () => startDeviceUpdate(device) }, device.updating ? appT('updatingTag') : appT('updateNow')) : null,
              device && !device.canUpdate ? h(ModalButton, { variant: 'primary', testid: 'dsh-devices-panel-update-ssh', onClick: () => updateOverSsh(device) }, appT('updateViaSsh')) : null,
              windowButton,
            ),
          ]
        } else if (panel && panel.state === 'failed' && !(f.failed && !f.loaded)) {
          body = [
            h('div', { key: 't', className: 'dshdev-frame-status-title' }, fill(appT('panelFailed'), { device: name, panel: panelName })),
            h('div', { key: 'd', className: 'dshdev-frame-status-detail' }, panel.error === 'timeout' ? appT('panelTimeout') : panel.error || ''),
            h('div', { key: 'a', className: 'dshdev-frame-status-actions' }, h(ModalButton, { variant: 'primary', testid: 'dsh-devices-panel-retry', onClick: reboot }, appT('retry')), windowButton),
          ]
        } else if (f.failed && !f.loaded) {
          const offline = device && device.status !== 'online'
          body = [
            h('div', { key: 't', className: 'dshdev-frame-status-title' }, fill(f.error ? appT('unreachable') : appT('loadFailed'), { device: name })),
            h('div', { key: 'd', className: 'dshdev-frame-status-detail' }, offline ? appT('comesBack') : f.error || appT('loadFailedHint')),
            h('div', { key: 'a', className: 'dshdev-frame-status-actions' }, h(ModalButton, { variant: 'primary', testid: 'dsh-devices-frame-retry', onClick: reboot }, appT('retry')), windowButton),
          ]
        } else {
          const slow = panel ? Date.now() - panel.startedAt > 9_000 : f.slow
          body = [
            h('div', { key: 't' }, shimmer(panel ? fill(appT('panelOpening'), { device: name, panel: panelName }) : fill(appT('loadingDevice'), { device: name }))),
            slow ? h('div', { key: 'd', className: 'dshdev-frame-status-detail' }, appT('panelSlow')) : null,
            slow ? h('div', { key: 'a', className: 'dshdev-frame-status-actions' }, h(ModalButton, { variant: 'outline', testid: 'dsh-devices-slow-retry', onClick: reboot }, appT('retry')), windowButton) : null,
          ]
        }
        const state = f.failed && !f.loaded ? (f.error ? 'unreachable' : 'failed') : panel ? panel.state : 'loading'
        this.statusRoot.render(h('div', { className: 'dshdev-frame-status', 'data-testid': 'dsh-devices-frame-status', 'data-state': state }, body))
      },
      /** Free memory: a device UI off screen for longer than `idleMs` is unloaded (its gateway entry stays, so it reloads fast). */
      unloadIdle(idleMs) {
        if (!idleMs) return
        const now = Date.now()
        for (const [id, f] of [...this.byDevice]) {
          // Only the UI on screen stays (even while the window is in the background). Any other one
          // goes after the idle time; the chat panel loads it again when it is shown.
          if (store.activePanel === CHAT_PANEL_ID && this.active === id) {
            f.lastVisibleAt = now
            continue
          }
          if (now - (f.lastVisibleAt || f.createdAt || now) > idleMs) this.unload(id)
        }
      },
      unload(deviceId) {
        const f = this.byDevice.get(deviceId)
        if (!f) return
        clearTimeout(f.timer)
        clearTimeout(f.slowTimer)

        try {
          f.iframe.src = 'about:blank'
        } catch {}
        f.iframe.remove()
        this.byDevice.delete(deviceId)
        if (this.active === deviceId) this.active = null
        emit()
      },
      drop(deviceId) {
        const f = this.byDevice.get(deviceId)
        if (f) {
          clearTimeout(f.timer)
          clearTimeout(f.slowTimer)
          f.iframe.remove()
        }
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
        let r = el.getBoundingClientRect()
        if (r.height < 40 || r.width < 40) {
          // Defensive: never collapse to an invisible strip.
          const parent = el.closest('[data-testid=dsh-devices-chat]')?.parentElement || el.parentElement
          if (parent) r = parent.getBoundingClientRect()
        }
        Object.assign(this.host.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
      },
    }

    function openRemote(ctx, device, sessionId) {
      frames.clearPanel(device.id)
      if (sessionId) setUnread(`${device.id}:${sessionId}`, false)
      setStore({ selection: { deviceId: device.id, sessionId: sessionId || null } })
      try {
        ctx.layout.selectPanel(CHAT_PANEL_ID)
      } catch {}
      frames.show(device.id, device, sessionId ? { type: 'open-session', sessionId } : null).catch((e) => setStore({ error: fill(en.openFailed, { error: e.message }) }))
    }

    function newRemote(ctx, device, workspaceId) {
      frames.clearPanel(device.id)
      setStore({ selection: { deviceId: device.id, sessionId: null } })
      try {
        ctx.layout.selectPanel(CHAT_PANEL_ID)
      } catch {}
      frames.show(device.id, device, { type: 'new-session', workspaceId }).catch((e) => setStore({ error: e.message }))
    }

    // ── styles ──────────────────────────────────────────────────────────────
    const CSS = `
/* Every value below mirrors a DSH stylesheet (Plugins page, Settings rows,
   Models cards, sidebar rows) so plugin surfaces look like the app's own. */
.dshdev-remote-root{display:block}
[class*="_list"]:has([data-dshdev-search] [data-dshdev-result]) [class*="_searchStatus"]{display:none}
[class*="_list"]:has(> .dshdev-remote-root [data-dshdev-device]) > [class*="_emptyState"]{display:none}
.dshdev-remote-root .dshdev-devname{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-left:6px;white-space:nowrap}
/* DSH's collapsed sidebar (rail) shows icons only: the device sections wait for the wide sidebar. */
[class*="_root"][class*="_rail"] .dshdev-remote-root{display:none}
.dshdev-device-section{position:relative;margin-top:10px}
.dshdev-device-header{cursor:pointer;user-select:none;outline:none}
.dshdev-device-header:focus-visible{box-shadow:inset 0 0 0 var(--dsw-focus-ring-width,2px) var(--dsw-focus-ring-color,#4176e6)}
.dshdev-device-header .dshdev-device-label{display:inline-flex;align-items:center;gap:6px;max-width:none;flex:1 1 auto;min-width:0;margin-right:auto}
.dshdev-device-icon{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary)}
.dshdev-device-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshdev-device-state{flex:none;font-size:12px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}
.dshdev-device-state[data-dshdev-state=error],.dshdev-device-state[data-dshdev-state=revoked]{color:var(--dsw-alias-state-warn-label,#b45309)}
.dshdev-device-waiting{display:inline-flex;align-items:center;flex:none}
.dshdev-device-chevron{flex:none;opacity:0;transition:opacity .12s,transform .18s;color:var(--dsw-alias-label-tertiary)}
.dshdev-device-chevron.dshdev-collapsed{transform:rotate(-90deg);opacity:1}
.dshdev-device-header:hover .dshdev-device-chevron,.dshdev-device-header:focus-visible .dshdev-device-chevron{opacity:1}
.dshdev-device-header .dshdev-device-actions{flex:none;max-width:none}
.dshdev-folders{display:flex;flex-direction:column;gap:10px}
.dshdev-folders-bar{display:flex;align-items:center;gap:6px;min-height:28px}
.dshdev-folders-up{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;background:none;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.dshdev-folders-up:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dshdev-folders-up:disabled{opacity:.4;cursor:default}
.dshdev-folders-path{flex:1;min-width:0;box-sizing:border-box;height:30px;padding:0 10px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:none;outline:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshdev-folders-path:focus{border-color:var(--dsw-focus-ring-color,#4176e6)}
.dshdev-folders-list{display:flex;flex-direction:column;gap:2px;max-height:320px;overflow-y:auto;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:4px}
.dshdev-folders-empty,.dshdev-folders-note{padding:12px;font-size:13px;color:var(--dsw-alias-label-tertiary)}
.dshdev-folders-note{padding:0}
.dshdev-folders-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.dshdev-folder-row{display:flex;align-items:center;gap:6px;border-radius:var(--dsw-radius-md);padding:0 4px 0 8px;min-height:34px}
.dshdev-folder-row:hover,.dshdev-folder-picked{background:var(--dsw-alias-interactive-bg-hover)}
.dshdev-folder-check{display:inline-flex;align-items:center;justify-content:center;width:20px;flex:none;color:var(--dsw-alias-label-tertiary)}
.dshdev-folder-check label{gap:0}.dshdev-folder-check label>span:not(:first-child){display:none}
.dshdev-folder-open{display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:34px;border:none;background:none;padding:0 4px;font:inherit;font-size:14px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left}
.dshdev-folder-open>svg{flex:none;color:var(--dsw-alias-label-tertiary)}
.dshdev-folder-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshdev-folder-chevron{margin-left:auto;display:inline-flex;color:var(--dsw-alias-label-caption)}
.dshdev-folders-new{display:flex;align-items:center;gap:8px}.dshdev-folders-new input{flex:1}
.dshdev-device-header button:disabled{opacity:.4;cursor:default}
.dshdev-device-header button:disabled:hover{background:none}
.dshdev-device-off .dshdev-device-name{color:var(--dsw-alias-label-tertiary)}
.dshdev-device-empty{color:var(--dsw-alias-label-tertiary)}
.dshdev-fb-section{display:flex;align-items:center;gap:4px;height:36px;padding-left:4px;color:var(--dsw-alias-label-tertiary);font-size:13px}
.dshdev-remote-root .dshdev-dim{opacity:.55}
.dshdev-remote-mark{display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}
.dshdev-group-status{display:inline-flex;align-items:center;margin-left:4px;flex:none}
[class*="_projectRow"]:hover > .dshdev-group-status{display:none}
.dshdev-fb-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.dshdev-fb-dot.warning{background:var(--dsw-alias-state-warn-label,#d97706)}.dshdev-fb-dot.done{background:var(--dsw-alias-state-success-primary,#16a34a)}.dshdev-fb-dot.ongoing{background:var(--dsw-focus-ring-color,#4176e6)}
.dshdev-fb-menu-root{display:inline-flex}
.dshdev-fb-menu{position:fixed;z-index:80;min-width:220px;padding:4px;border-radius:var(--dsw-radius-lg,12px);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#fff));box-shadow:0 12px 32px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary)}
.dshdev-fb-item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:0;border-radius:var(--dsw-radius-sm,6px);padding:6px 10px;font:inherit;font-size:13px;color:inherit;cursor:pointer}
.dshdev-fb-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dshdev-fb-item:disabled{opacity:.5}.dshdev-fb-item.danger{color:var(--dsw-alias-state-error-primary)}
.dshdev-fb-item-icon{display:inline-flex;width:16px;color:var(--dsw-alias-label-secondary)}
.dshdev-fb-sep{height:.5px;margin:4px 6px;background:var(--dsw-alias-border-l2)}
.dshdev-fb-label{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:6px 10px 2px}
.dshdev-fb-switch{position:relative;width:36px;height:20px;border-radius:10px;border:0;background:var(--dsw-alias-border-l3);cursor:pointer;padding:0}
.dshdev-fb-switch.on{background:var(--dsw-alias-button-primary-fill,#111)}
.dshdev-fb-switch span{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:8px;background:#fff;transition:left .15s}.dshdev-fb-switch.on span{left:18px}
.dshdev-fb-segmented{display:flex;gap:4px;padding:3px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}
.dshdev-fb-segmented button{flex:1;background:none;border:0;border-radius:var(--dsw-radius-sm);padding:5px 12px;font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshdev-fb-segmented button[aria-selected=true]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dshdev-fb-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:80;display:flex;gap:10px;align-items:center;padding:8px 14px;border-radius:10px;font-size:13px;line-height:18px;color:#fff;background:rgba(17,17,17,.9)}
.dshdev-fb-toast button{background:none;border:0;color:#8ab4ff;font:inherit;cursor:pointer;padding:0}
.dshdev-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
/* fallback rows when the sidebar's own classes cannot be found */
.dshdev-fb-group{padding:0 0 4px}
.dshdev-fb-project,.dshdev-fb-session{display:flex;align-items:center;height:32px;padding:0 8px;border-radius:var(--dsw-radius-lg,12px);font-size:14px;cursor:pointer;color:var(--dsw-alias-label-primary);gap:6px;user-select:none;position:relative}
.dshdev-fb-project:hover,.dshdev-fb-session:hover,.dshdev-fb-selected{background:var(--dsw-alias-interactive-bg-hover)}
.dshdev-fb-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:0 6px 0 4px}
.dshdev-fb-time{font-size:10px;color:var(--dsw-alias-label-tertiary)}
.dshdev-fb-slot,.dshdev-fb-folder,.dshdev-fb-chevron{display:inline-flex;width:20px;justify-content:center;color:var(--dsw-alias-label-tertiary)}
.dshdev-fb-arrow{transition:transform .15s}.dshdev-fb-arrow-open{transform:rotate(90deg)}
.dshdev-fb-actions{display:none;margin-left:auto;gap:2px}
.dshdev-fb-project:hover .dshdev-fb-actions,.dshdev-fb-session:hover .dshdev-fb-actions,.dshdev-fb-menuopen .dshdev-fb-actions{display:inline-flex}
.dshdev-fb-session:hover .dshdev-fb-time{display:none}
.dshdev-fb-iconbtn{background:none;border:0;padding:4px;border-radius:var(--dsw-radius-sm,6px);color:inherit;cursor:pointer;display:inline-flex}
.dshdev-fb-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshdev-fb-pin{display:inline-flex;color:var(--dsw-alias-label-tertiary)}
.dshdev-hover{display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px}
.dshdev-hover-title{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dshdev-hover-sub{color:var(--dsw-alias-label-tertiary)}
.dshdev-hover-status{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary)}
.dshdev-more{display:block;background:none;border:0;padding:6px 8px 6px 36px;font:inherit;font-size:12px;color:var(--dsw-alias-label-tertiary);cursor:pointer;text-align:left}
.dshdev-more:hover{color:var(--dsw-alias-label-secondary)}
.dshdev-menu-labelled{display:inline-flex;align-items:baseline;gap:6px;min-width:0}
.dshdev-pill{margin-right:6px}
.dshdev-menu-suffix{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshdev-menu-caption{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);padding:8px 10px 4px;border-top:.5px solid var(--dsw-alias-border-l2);margin-top:4px}
.dshdev-menu-item{display:flex;align-items:center;gap:8px;width:100%;background:none;border:0;padding:6px 10px;font:inherit;color:inherit;cursor:pointer}

/* modal content */
.dshdev-modal{width:min(540px,calc(100vw - 48px))!important;max-width:none!important}
.dshdev-modal.dshdev-modal-sm{width:min(440px,calc(100vw - 48px))!important}
.dshdev-modal.dshdev-modal-lg{width:min(660px,calc(100vw - 48px))!important}
.dshdev-modal-body{display:flex;flex-direction:column;gap:12px;min-width:0}
.dshdev-form{display:flex;flex-direction:column;gap:16px;width:100%;min-width:0;box-sizing:border-box}
.dshdev-form *{box-sizing:border-box}
.dshdev-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dshdev-field-label{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.dshdev-field-input{width:100%;box-sizing:border-box;height:36px;border-radius:var(--dsw-radius-md,10px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-module-platform,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;padding:0 12px;outline:none}
.dshdev-field-input:focus{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dshdev-field-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dshdev-grid{display:grid;grid-template-columns:96px minmax(0,1fr);gap:12px}
.dshdev-span2{grid-column:1 / -1}
.dshdev-hint-text{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshdev-empty-text{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}
.dshdev-error-text{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshdev-success-text{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-state-business-primary));margin:0;font-size:12px;line-height:18px}
.dshdev-link-button{align-self:flex-start;box-sizing:border-box;border-radius:var(--dsw-radius-sm);height:28px;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:0 0;border:none;align-items:center;padding:0 10px;margin-left:-10px;font-size:12px;line-height:18px;display:inline-flex}
.dshdev-link-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshdev-inline-link{background:none;border:0;padding:0;margin-top:6px;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-link,var(--dsw-focus-ring-color));cursor:pointer}
.dshdev-inline-link:hover{text-decoration:underline}
.dshdev-footer-switch{display:inline-flex;align-items:center;gap:10px;margin-right:auto;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dshdev-disclosure{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;background:none;border:0;padding:2px 0;font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshdev-disclosure:hover{color:var(--dsw-alias-label-primary)}
.dshdev-disclosure-chevron{transition:transform .15s}.dshdev-disclosure-chevron.open{transform:rotate(90deg)}
.dshdev-steps{margin:0;padding:12px 14px 12px 32px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);font-size:13px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.dshdev-steps code,.dshdev-fp{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}
.dshdev-steps code{padding:1px 6px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-fill-tsp-secondary);white-space:nowrap}
.dshdev-fp{padding:8px 10px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l3);word-break:break-all;margin-top:6px}
.dshdev-log{max-height:220px;overflow:auto;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:17px;background:var(--dsw-alias-bg-module-platform);border-radius:var(--dsw-radius-lg);padding:10px 12px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}
.dshdev-options{display:flex;flex-direction:column;gap:6px}
.dshdev-option{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);padding:8px 12px;color:inherit;font:inherit;font-size:13px;cursor:pointer}
.dshdev-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshdev-option.on{border-color:transparent;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));background:var(--dsw-alias-interactive-bg-hover)}
.dshdev-option:disabled{opacity:.6;cursor:default}
.dshdev-option-icon{display:inline-flex;color:var(--dsw-alias-label-secondary)}
.dshdev-option-text{display:flex;flex-direction:column;min-width:0;flex:1;line-height:18px}
.dshdev-option-title{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshdev-option-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshdev-archived-list{display:flex;flex-direction:column}
.dshdev-archived-row{position:relative}
.dshdev-archived-row .dshdev-archived-actions{display:inline-flex}

/* Plugins-page cards (pages and dialogs) */
.dshdev-cards{flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;display:flex}
.dshdev-card2{border-radius:var(--dsw-radius-xl);min-width:0;margin:0 -8px;list-style:none;position:relative}
.dshdev-card2-link:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshdev-card2-head{align-items:center;gap:14px;padding:8px;display:flex}
.dshdev-card2-icon{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);width:48px;height:48px;color:var(--dsw-alias-label-secondary);flex:none;justify-content:center;align-items:center;display:inline-flex;box-sizing:border-box}
.dshdev-modal-body .dshdev-card2-icon{width:36px;height:36px;border-radius:var(--dsw-radius-md)}
.dshdev-card2-main{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dshdev-card2-titlerow{flex-wrap:wrap;align-items:center;gap:8px;min-width:0;display:flex}
.dshdev-card2-title,.dshdev-card2-open{text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px;overflow:hidden}
.dshdev-card2-open{max-width:100%;color:inherit;font:inherit;font-weight:500;text-align:left;cursor:pointer;background:0 0;border:0;padding:0}
.dshdev-card2-open:after{content:"";border-radius:var(--dsw-radius-xl);position:absolute;inset:0}
.dshdev-card2-open:focus-visible{outline:none}
.dshdev-card2-open:focus-visible:after{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dshdev-card2-desc{color:var(--dsw-alias-label-tertiary);-webkit-line-clamp:1;-webkit-box-orient:vertical;font-size:13px;line-height:18px;display:-webkit-box;overflow:hidden}
.dshdev-card2-error{color:var(--dsw-alias-state-error-primary)}
.dshdev-card2-health{color:var(--dsw-alias-label-secondary)}
.dshdev-card2-end{z-index:1;flex:none;align-items:center;gap:8px;display:inline-flex;position:relative}
.dshdev-status-tag{height:18px;padding:0 7px;font-size:10px;line-height:1}
.dshdev-icon-button{border-radius:var(--dsw-radius-sm);width:28px;height:28px;color:var(--dsw-alias-label-caption);cursor:pointer;background:0 0;border:0;justify-content:center;align-items:center;display:inline-flex;flex:none}
.dshdev-icon-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshdev-icon-button:disabled{opacity:.5;cursor:default}
.dshdev-icon-button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dshdev-device-glyph{display:inline-flex;color:var(--dsw-alias-label-secondary)}
.dshdev-device-glyph.online{color:var(--dsw-alias-label-primary)}
.dshdev-port-number{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:13px}
.dshdev-skeleton{display:block;background:var(--dsw-alias-bg-skeleton,var(--dsw-alias-fill-tsp-secondary));border-radius:var(--dsw-radius-xs);animation:2s cubic-bezier(.36,0,.64,1) infinite dshdev-skeleton}
.dshdev-card2-icon.dshdev-skeleton{border-color:transparent;border-radius:var(--dsw-radius-lg)}
.dshdev-skeleton-title{width:min(144px,60%);height:12px;margin:4px 0}
.dshdev-skeleton-desc{width:min(280px,85%);height:12px;margin:3px 0}
@keyframes dshdev-skeleton{0%{opacity:1}40%{opacity:.6}80%,to{opacity:1}}
@media (prefers-reduced-motion:reduce){.dshdev-skeleton{animation:none}}
.dshdev-groups{display:flex;flex-direction:column;gap:16px}
.dshdev-group2{flex-direction:column;gap:8px;display:flex}
.dshdev-group2-head{align-items:center;gap:8px;display:flex}
.dshdev-group2-title{flex:1;margin:0;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}
.dshdev-modal-body .dshdev-group2-title{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary)}

/* Devices page = Plugins page */
.dshdev-page2{box-sizing:border-box;height:100%;color:var(--dsw-alias-label-primary);flex-direction:column;align-items:center;gap:32px;padding:0 clamp(24px,4vw,48px) 48px;display:flex;overflow:auto}
.dshdev-page2>*{width:100%;max-width:960px}
.dshdev-page2-head{box-sizing:border-box;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:16px;padding-top:calc(28px + var(--dsh-frame-top-clearance,0px));display:flex}
.dshdev-page2-heading{min-width:0;max-width:100%}
.dshdev-page2-title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.dshdev-page2-intro{color:var(--dsw-alias-label-secondary);margin:4px 0 0;font-size:13px;line-height:20px;max-width:620px}
.dshdev-page2-toolbar{white-space:nowrap;flex:none;justify-content:flex-end;align-items:center;gap:16px;display:flex}
.dshdev-page2-add{border-radius:var(--dsw-radius-md);height:32px;padding:0 12px;font-size:13px;line-height:20px}

/* Settings rows and selector, as in General settings */
.dshdev-section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;display:flex}
.dshdev-srow{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:24px;padding:16px 0;display:flex}
.dshdev-srow-text{min-width:0;flex:1}
.dshdev-srow-title{font-size:14px;line-height:20px}
.dshdev-srow-desc{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}
.dshdev-srow-control{display:flex;align-items:center;gap:8px;flex-shrink:0}
.dshdev-selector{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex;max-width:280px}
.dshdev-selector:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshdev-selector-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshdev-selector-chevron{flex:none}

/* credentials, as the provider cards of Models settings */
.dshdev-cred{display:flex;flex-direction:column;gap:10px}
.dshdev-cred-list{flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;display:flex}
.dshdev-cred-card{border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));background:var(--dsw-alias-settings-card-fill,transparent);border-radius:var(--dsw-radius-xl);flex-direction:column;gap:12px;padding:12px 14px;display:flex}
.dshdev-cred-head{align-items:center;gap:10px;display:flex;flex-wrap:wrap}
.dshdev-cred-identity{align-items:center;gap:6px;min-width:0;display:inline-flex}
.dshdev-cred-name{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.dshdev-cred-tag{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);flex:none;padding:1px 6px;font-size:11px;line-height:16px}
.dshdev-cred-dot{box-sizing:border-box;border-radius:50%;flex:none;width:8px;height:8px;display:inline-block;background:var(--dsw-alias-state-error-primary)}
.dshdev-cred-dot.ok{background:var(--dsw-alias-state-success-primary)}
.dshdev-cred-status{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dshdev-cred-status.ok{color:var(--dsw-alias-state-success-primary)}
.dshdev-cred-actions{align-items:center;gap:4px;margin-left:auto;display:inline-flex;flex-wrap:wrap}
.dshdev-small-button{box-sizing:border-box;border-radius:var(--dsw-radius-sm);height:28px;font:inherit;cursor:pointer;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);background:0 0;justify-content:center;align-items:center;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex;white-space:nowrap}
.dshdev-small-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-interactive-bg-hover))}
.dshdev-small-button.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.dshdev-small-button.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshdev-small-button.danger{border-color:transparent;color:var(--dsw-alias-state-error-primary)}
.dshdev-small-button.danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover))}
.dshdev-small-button:disabled{opacity:.4;cursor:default}
.dshdev-key-editor{display:flex;align-items:center;gap:8px}
.dshdev-key-editor .dshdev-field-input{flex:1;min-width:160px}

/* callout above a remote chat (no models yet), in the style of DSH's composer notices */
.dshdev-callout{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dshdev-callout-dot{width:8px;height:8px;border-radius:50%;flex:none;margin-top:6px;background:var(--dsw-alias-state-warn-label,#d97706)}
.dshdev-callout-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}
.dshdev-callout-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none}

/* the embedded remote chat */
.dshdev-chat-wrap{display:flex;flex-direction:column;width:100%;height:100%}
.dshdev-chat-banner{padding:calc(var(--dsh-frame-top-clearance,0px) + 10px) 16px 10px;background:var(--dsw-alias-bg-base)}
.dshdev-chat-banner .dshdev-callout{max-width:880px;margin:0 auto}
.dshdev-chat-panel{position:relative;width:100%;flex:1;min-height:0}
.dshdev-chat-status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:24px;text-align:center}
.dshdev-context{display:flex;align-items:center;gap:8px;padding:calc(var(--dsh-frame-top-clearance,0px) + 8px) 16px 8px;background:var(--dsw-alias-bg-base);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dshdev-context-label{border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-fill-tsp-secondary);height:22px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;align-items:center;gap:4px;padding:0 6px 0 4px;font-size:12px;line-height:22px;display:inline-flex}
.dshdev-context-panel{font-weight:500}
.dshdev-frame-status{display:flex;flex-direction:column;align-items:center;gap:12px;max-width:440px}
.dshdev-frame-status-actions{display:flex;gap:8px;margin-top:4px}
.dshdev-frame-overlay{z-index:2;background:var(--dsw-alias-bg-base,#fff)}
.dshdev-frame-status-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;font-weight:500}
.dshdev-frame-status-detail{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
`
    /**
     * Install (or refresh) this version's styles. A plugin update swaps the
     * module without reloading the page, so a <style> left by the previous
     * version must be replaced, not reused.
     */
    function ensureStyles() {
      let style = document.getElementById('dshdev-styles')
      if (!style) {
        style = document.createElement('style')
        style.id = 'dshdev-styles'
        document.head.appendChild(style)
      }
      if (style.textContent !== CSS) style.textContent = CSS
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

    /** The "remote" mark: a small server with a signal arc, drawn with DSH's icon stroke. */
    function RemoteIcon({ size = 16, className }) {
      const sw = (Number(P.ICON_REGULAR_STROKE) || 1.2) * (16 / Math.max(12, size))
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: sw, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, className },
        h('rect', { x: 1.75, y: 6.75, width: 9.5, height: 7, rx: 1.75 }),
        h('path', { d: 'M4.25 10.25h.01M6.75 10.25h2.5' }),
        h('path', { d: 'M10.4 3.9a3 3 0 0 1 2.7 2.7M10.4 1.75a5.1 5.1 0 0 1 4.85 4.85' }),
      )
    }

    /** Show a device workspace's file tree (DSH's own Files tab) inline. */
    function openRemoteFiles(ctx, device, group) {
      const latest = group.sessions && group.sessions[0]
      setStore({ selection: { deviceId: device.id, sessionId: latest ? latest.sessionId : null } })
      try {
        ctx.layout.selectPanel(CHAT_PANEL_ID)
      } catch {}
      // One command: switch the session first, then open its Files tab.
      const command = latest ? { type: 'open-session', sessionId: latest.sessionId, files: true } : { type: 'new-session', workspaceId: group.workspaceId, files: true }
      frames.show(device.id, device, command).catch((e) => setStore({ error: e.message }))
    }

    // ── DSH primitives, with plain stand-ins if a future build lacks one ────
    function Icon(name, props, fallback) {
      const C = P[name]
      return C ? h(C, props || {}) : fallback ? fallback() : null
    }
    function Dot({ state }) {
      return P.StateDot ? h(P.StateDot, { state }) : h('span', { className: `dshdev-fb-dot ${state}`, 'aria-hidden': true })
    }
    function MenuItem({ icon, onSelect, disabled, danger, children }) {
      if (P.MenuItemButton) return h(P.MenuItemButton, { icon, onSelect, disabled, danger }, children)
      return h('button', { type: 'button', role: 'menuitem', className: cx('dshdev-fb-item', danger && 'danger'), disabled, onClick: onSelect }, icon ? h('span', { className: 'dshdev-fb-item-icon' }, icon) : null, h('span', null, children))
    }
    function NativeMenu(props) {
      return P.Menu ? h(P.Menu, props) : h(FallbackMenu, props)
    }
    function FallbackMenu({ open, anchor, items, children, onSelect, onClose, getAnchorRect, align }) {
      const ref = useRef(null)
      const [rect, setRect] = useState(null)
      useLayoutEffect(() => {
        if (open) setRect((getAnchorRect ? getAnchorRect() : ref.current && ref.current.getBoundingClientRect()) || null)
      }, [open])
      useEffect(() => {
        if (!open) return undefined
        const down = (e) => {
          if (!(e.target.closest && e.target.closest('[data-dshdev-fb-menu]'))) onClose && onClose()
        }
        const key = (e) => e.key === 'Escape' && onClose && onClose()
        document.addEventListener('pointerdown', down, true)
        document.addEventListener('keydown', key, true)
        return () => {
          document.removeEventListener('pointerdown', down, true)
          document.removeEventListener('keydown', key, true)
        }
      }, [open])
      const left = rect ? Math.max(8, Math.min(align === 'end' ? rect.right - 240 : rect.left, window.innerWidth - 248)) : 0
      return h(
        'span',
        { ref, className: 'dshdev-fb-menu-root', 'data-dshdev-fb-menu': '1' },
        anchor || null,
        open && rect
          ? h(
              'div',
              { role: 'menu', className: 'dshdev-fb-menu', style: { left, top: rect.bottom + 4 } },
              items
                ? items.map((it) =>
                    it.type === 'separator'
                      ? h('div', { key: it.id, className: 'dshdev-fb-sep', role: 'separator' })
                      : it.type === 'label'
                        ? h('div', { key: it.id, className: 'dshdev-fb-label' }, it.text)
                        : h(MenuItem, { key: it.id, icon: it.icon, disabled: it.disabled, danger: it.danger, onSelect: () => onSelect && onSelect(it.id) }, it.label),
                  )
                : children,
            )
          : null,
      )
    }
    function NativeSwitch({ checked, onChange, label, disabled }) {
      if (P.Switch) return h(P.Switch, { checked: !!checked, onChange, label, disabled })
      return h('button', { type: 'button', role: 'switch', 'aria-checked': !!checked, 'aria-label': label, disabled, className: cx('dshdev-fb-switch', checked && 'on'), onClick: () => onChange(!checked) }, h('span', null))
    }
    function Segmented({ value, options, onChange, label, disabled }) {
      if (P.SegmentedControl) return h(P.SegmentedControl, { value, options, onChange, label, disabled })
      return h(
        'div',
        { className: 'dshdev-fb-segmented', role: 'tablist', 'aria-label': label },
        options.map((o) => h('button', { key: o.value, type: 'button', role: 'tab', 'aria-selected': value === o.value, disabled, onClick: () => onChange(o.value) }, o.label)),
      )
    }
    function FallbackToast({ text, actions, holdMs = 3000, onDone }) {
      useEffect(() => {
        const timer = setTimeout(onDone, holdMs + 1000)
        return () => clearTimeout(timer)
      }, [])
      return h('div', { className: 'dshdev-fb-toast', role: 'alert' }, text, (actions || []).map((a) => h('button', { key: a.label, type: 'button', onClick: a.onClick }, a.label)))
    }

    // ── native look: DSH's own row classes, words and statuses ──────────────
    const cx = (...parts) => parts.filter(Boolean).join(' ')

    /**
     * CSS-module prefixes of the sidebar rows ("YDXeBa_" in "YDXeBa_sessionRow")
     * and of the list ("bhn1Oq_" in "bhn1Oq_sessionOverflowButton"), read from the
     * live sidebar or its stylesheets: remote rows are then styled by DSH itself.
     */
    let prefixCache = null
    function discoverPrefixes() {
      if (prefixCache && (prefixCache.found.row && prefixCache.found.list ? true : Date.now() - prefixCache.at < 2000)) return prefixCache.found
      const found = scanPrefixes()
      prefixCache = { at: Date.now(), found }
      return found
    }
    function scanPrefixes() {
      const found = { row: null, list: null }
      const live = document.querySelector('[class*="regionArea"] [class*="_sessionRow"], [class*="regionArea"] [class*="_projectRow"]')
      if (live) {
        const c = [...live.classList].find((x) => /_(sessionRow|projectRow)$/.test(x))
        if (c) found.row = c.replace(/(sessionRow|projectRow)$/, '')
      }
      const listEl = document.querySelector('[class*="regionArea"] [class*="_sessionOverflowButton"], [class*="regionArea"] [class*="_searchInput"], [class*="regionArea"] [class*="_groupSection"]')
      if (listEl) {
        const c = [...listEl.classList].find((x) => /_(sessionOverflowButton|searchInput|groupSection)$/.test(x))
        if (c) found.list = c.replace(/(sessionOverflowButton|searchInput|groupSection)$/, '')
      }
      if (!found.row || !found.list) {
        for (const sheet of document.styleSheets) {
          let rules
          try {
            rules = sheet.cssRules
          } catch {
            continue
          }
          for (const rule of rules) {
            const text = rule.cssText || ''
            if (!found.row) {
              const m = text.match(/\.([A-Za-z0-9-]+_)sessionRow\b/)
              if (m && text.includes(`.${m[1]}projectRow`)) found.row = m[1]
            }
            if (!found.list) {
              const m = text.match(/\.([A-Za-z0-9-]+_)sessionOverflowButton\b/) || text.match(/\.([A-Za-z0-9-]+_)groupSection\b/)
              if (m) found.list = m[1]
            }
            if (found.row && found.list) break
          }
          if (found.row && found.list) break
        }
      }
      return found
    }

    const FALLBACK_CLASSES = {
      native: false, group: 'dshdev-fb-group', project: 'dshdev-fb-project', session: 'dshdev-fb-session', selected: 'dshdev-fb-selected',
      menuOpen: 'dshdev-fb-menuopen', slot: 'dshdev-fb-slot', folder: 'dshdev-fb-folder', folderActive: '', chevron: 'dshdev-fb-chevron', arrow: 'dshdev-fb-arrow',
      arrowOpen: 'dshdev-fb-arrow-open', projectText: 'dshdev-fb-title', title: 'dshdev-fb-title', time: 'dshdev-fb-time', pinIndicator: 'dshdev-fb-pin',
      actions: 'dshdev-fb-actions', iconButton: 'dshdev-fb-iconbtn', hidden: 'dshdev-visually-hidden', hoverContent: 'dshdev-hover', hoverTitle: 'dshdev-hover-title',
      hoverTime: 'dshdev-hover-sub', hoverStatus: 'dshdev-hover-status', hoverPath: 'dshdev-hover-sub', searchRow: 'dshdev-fb-session', searchHeading: 'dshdev-fb-heading',
      searchTitle: 'dshdev-fb-title', searchMeta: 'dshdev-fb-time', searchWorkspace: '', searchSnippet: 'dshdev-hover-sub', overflow: 'dshdev-more',
    }

    function rowClasses() {
      const { row, list } = discoverPrefixes()
      if (!row) return FALLBACK_CLASSES
      const r = (n) => `${row}${n}`
      return {
        native: true,
        group: list ? `${list}groupSection` : FALLBACK_CLASSES.group,
        project: r('projectRow'),
        session: r('sessionRow'),
        selected: r('selected'),
        menuOpen: r('menuOpen'),
        slot: r('slot'),
        folder: r('folder'),
        folderActive: r('folderActive'),
        chevron: r('chevron'),
        arrow: r('arrow'),
        arrowOpen: r('arrowOpen'),
        projectText: r('projectText'),
        title: r('title'),
        time: r('time'),
        pinIndicator: r('pinIndicator'),
        actions: r('rowActions'),
        iconButton: r('iconButton'),
        hidden: r('visuallyHidden'),
        hoverContent: r('hoverContent'),
        hoverTitle: r('hoverTitle'),
        hoverTime: r('hoverTime'),
        hoverStatus: r('hoverStatus'),
        hoverPath: r('hoverPath'),
        searchRow: r('searchResultRow'),
        searchHeading: r('searchResultHeading'),
        searchTitle: r('searchResultTitle'),
        searchMeta: r('searchResultMeta'),
        searchWorkspace: r('searchResultWorkspace'),
        searchSnippet: r('searchResultSnippet'),
        overflow: list ? `${list}sessionOverflowButton` : FALLBACK_CLASSES.overflow,
      }
    }

    /** DSH's own sidebar words (namespace "workspace"), our copy as the fallback. */
    let nativeT = null
    function nt(key, vars, fallback) {
      try {
        if (nativeT) {
          const v = nativeT(key, vars)
          if (typeof v === 'string' && v && v !== key && !v.includes(`workspace.${key}`)) return v
        }
      } catch {}
      return fallback !== undefined ? fill(fallback, vars) : key
    }
    const UNIT_FALLBACK = { minutes: '{n}min', hours: '{n}h', days: '{n}d', months: '{n}mo', years: '{n}y' }
    /** Compact relative time, as the sidebar shows it ("now", "5min"). */
    function timeLabel(ts) {
      if (!ts) return ''
      const when = typeof ts === 'number' ? ts : Date.parse(ts)
      try {
        const { unit, n } = P.relativeTime(when, Date.now())
        return unit === 'now' ? nt('time.now', null, 'now') : nt(`time.${unit}`, { n }, UNIT_FALLBACK[unit] || '{n}')
      } catch {
        return shortAgo(ts, appT)
      }
    }
    function hoverTimeLabel(ts) {
      if (!ts) return ''
      const label = timeLabel(ts)
      try {
        if (P.relativeTime(typeof ts === 'number' ? ts : Date.parse(ts), Date.now()).unit === 'now') return label
      } catch {}
      return nt('time.ago', { t: label }, '{t} ago')
    }

    /** "3.1 GB" in the app's language. */
    function formatBytes(n) {
      if (!Number.isFinite(n)) return '?'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let v = n
      let i = 0
      while (v >= 1000 && i < units.length - 1) {
        v /= 1000
        i += 1
      }
      const digits = v < 10 && i > 0 ? 1 : 0
      try {
        return `${new Intl.NumberFormat(document.documentElement.lang || undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v)} ${units[i]}`
      } catch {
        return `${v.toFixed(digits)} ${units[i]}`
      }
    }
    /** "CPU 12% · Memory 3.1 of 8 GB · Disk 41 of 80 GB" */
    function healthSummary(health, t) {
      if (!health) return null
      const parts = []
      if (health.cpu) parts.push(`${t('cpu')} ${Math.round(health.cpu.percent)}%`)
      if (health.memory && health.memory.total) parts.push(`${t('memory')} ${fill(t('ofSize'), { used: formatBytes(health.memory.used), total: formatBytes(health.memory.total) })}`)
      if (health.disk && health.disk.total) parts.push(`${t('disk')} ${fill(t('ofSize'), { used: formatBytes(health.disk.used), total: formatBytes(health.disk.total) })}`)
      return parts.join(' · ')
    }
    /** What is wrong with a device right now: disk, memory, CPU — warning or critical. */
    function healthIssues(health) {
      if (!health) return []
      const out = []
      const d = health.disk
      if (d && d.total) {
        if (d.percent >= 95 || d.free < 1e9) out.push({ key: 'disk', level: 'critical' })
        else if (d.percent >= 90 || d.free < 3e9) out.push({ key: 'disk', level: 'warning' })
      }
      const m = health.memory
      if (m && m.total) {
        if (m.percent >= 95) out.push({ key: 'memory', level: 'critical' })
        else if (m.percent >= 90) out.push({ key: 'memory', level: 'warning' })
      }
      const c = health.cpu
      if (c) {
        const perCore = ((health.load && health.load[0]) || 0) / Math.max(1, c.cores)
        if (c.percent >= 95 || perCore >= 2) out.push({ key: 'cpu', level: c.percent >= 99 || perCore >= 3 ? 'critical' : 'warning' })
      }
      return out
    }

    /** The sidebar status of a remote session, worded and coloured like a local one. */
    function remoteStatus(s, deviceId) {
      if (s.pending && s.pending.kind === 'approval') return { state: 'warning', label: nt('status.waitingApproval', null, 'Waiting for approval'), trailing: nt('status.compact.approval', null, 'Approval') }
      if (s.pending) return { state: 'warning', label: nt('status.waitingAnswer', null, 'Waiting for answer'), trailing: nt('status.compact.answer', null, 'Answer') }
      if (s.running) return { state: 'ongoing', label: nt('status.running', null, 'Running') }
      if (store.unread[`${deviceId}:${s.sessionId}`]) return { state: 'done', label: nt('status.completed', null, 'Completed') }
      return { state: 'idle', label: nt('status.idle', null, 'Idle') }
    }

    // ── sidebar: remote groups below the local workspaces ───────────────────
    /** A workspace's name as DSH shows it (its default workspace in the reader's language). */
    function workspaceTitle(title, p) {
      if (title === 'default-workspace') return nt('workspace.defaultName', null, appT('defaultWorkspace'))
      return title || (p ? p.split('/').filter(Boolean).pop() : '') || '?'
    }
    const pinFirst = (list) => list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.pinned && b.pinned ? (a.pinRank ?? 0) - (b.pinRank ?? 0) : 0))
    /** The nearest other workspace folder that contains `p` (DSH's "workspace tree" parent). */
    function parentFolder(p, paths) {
      let best = null
      for (const c of paths) {
        if (!c || c === p) continue
        const prefix = c.endsWith('/') ? c : `${c}/`
        if (p.startsWith(prefix) && (!best || c.length > best.length)) best = c
      }
      return best
    }
    /**
     * A device's chats grouped like DSH's sidebar: one group per workspace of the device
     * (in its order, empty ones too), then Ungrouped. In "workspace-tree" a workspace inside
     * another one's folder follows it, one level deeper.
     */
    function deviceGroups(device, mode = 'workspace') {
      const workspaces = device.workspaces || []
      const groups = workspaces.map((w) => ({ key: w.id, workspaceId: w.id, title: workspaceTitle(w.title, w.path), path: w.path || null, sessions: [], depth: 0, parentKey: null }))
      const byId = new Map(groups.map((g) => [g.key, g]))
      const stray = []
      for (const s of device.sessions || []) {
        let g = s.workspaceId ? byId.get(s.workspaceId) : null
        if (!g && s.workspaceId) {
          // (a workspace the list does not have yet)
          g = { key: s.workspaceId, workspaceId: s.workspaceId, title: workspaceTitle(s.workspaceTitle, s.cwd), path: s.cwd || null, sessions: [], depth: 0, parentKey: null }
          byId.set(g.key, g)
          groups.push(g)
        }
        if (g) g.sessions.push(s)
        else stray.push(s)
      }
      for (const g of groups) pinFirst(g.sessions)
      let out = groups
      if (mode === 'workspace-tree') {
        const paths = groups.map((g) => g.path).filter(Boolean)
        const keyByPath = new Map(groups.filter((g) => g.path).map((g) => [g.path, g.key]))
        for (const g of groups) {
          const parent = g.path ? parentFolder(g.path, paths) : null
          g.parentKey = parent ? keyByPath.get(parent) : null
        }
        const children = new Map()
        for (const g of groups) if (g.parentKey) children.set(g.parentKey, [...(children.get(g.parentKey) || []), g])
        out = []
        const visit = (g, depth) => {
          g.depth = depth
          out.push(g)
          for (const c of children.get(g.key) || []) visit(c, depth + 1)
        }
        for (const g of groups) if (!g.parentKey) visit(g, 0)
      }
      if (stray.length) out.push({ key: '_ungrouped', workspaceId: null, title: nt('group.ungrouped', null, appT('ungrouped')), path: null, sessions: pinFirst(stray), depth: 0, parentKey: null, ungrouped: true })
      return out
    }

    function StatusDots({ cls, status }) {
      return h(React.Fragment, null, h(Dot, { state: status.state }), h('span', { className: cls.hidden }, status.label))
    }

    function RemoteMark({ size = 14 }) {
      return h('span', { className: 'dshdev-remote-mark' }, h(RemoteIcon, { size }))
    }

    function RemoteSessionHover({ cls, device, s, status, t }) {
      return h(
        'div',
        { className: cls.hoverContent },
        h('div', { className: cls.hoverTitle }, s.title || nt('session.untitled', null, t('untitled'))),
        h('div', { className: cls.hoverTime }, hoverTimeLabel(s.updatedAt)),
        h('div', { className: cls.hoverStatus }, h(RemoteMark, { size: 12 }), h('span', null, [device.name, s.workspaceTitle].filter(Boolean).join(' · '))),
        status.state !== 'idle' ? h('div', { className: cls.hoverStatus }, h(Dot, { state: status.state }), h('span', null, status.label)) : null,
      )
    }

    function TipButton({ label, cls, onClick, children, action, className, disabled }) {
      const button = h('button', { type: 'button', className: className || cls.iconButton, 'aria-label': label, 'data-dshdev-action': action, disabled, onClick }, children)
      return P.Tooltip ? h(P.Tooltip, { label, side: 'bottom', align: 'end', delayMs: 500, portal: true }, button) : button
    }

    function RemoteSessionRow({ ctx, t, cls, device, s, selected, online }) {
      const [menuOpen, setMenuOpen] = useState(false)
      const status = remoteStatus(s, device.id)
      const title = s.title || nt('session.untitled', null, t('untitled'))
      const supported = hasFeature(device, 'session-actions')
      const pinLabel = s.pinned ? nt('menu.unpinSession', null, t('unpin')) : nt('menu.pinSession', null, t('pin'))
      const pinIcon = (size) => Icon(s.pinned ? 'IconPinFillRegular' : 'IconPinOutlineRegular', size ? { size } : {})
      const act = (fn) => () => {
        setMenuOpen(false)
        fn()
      }
      const items = [
        h(MenuItem, { key: 'pin', icon: pinIcon(), disabled: !supported, onSelect: act(() => sessionAction(device, s.sessionId, s.pinned ? 'unpin' : 'pin')) }, pinLabel),
        h(MenuItem, { key: 'rename', icon: Icon('IconEditOutlineRegular'), disabled: !supported, onSelect: act(() => setStore({ dialog: { kind: 'rename', deviceId: device.id, sessionId: s.sessionId, title: s.title || '' } })) }, nt('rename', null, t('rename'))),
        h(MenuItem, { key: 'files', icon: Icon('IconFolderOpenOutlineRegular'), disabled: !online, onSelect: act(() => openRemoteFiles(ctx, device, { sessions: [s], workspaceId: s.workspaceId })) }, t('openFiles')),
        h(MenuItem, { key: 'editor', icon: Icon('IconCodeOutlineRegular'), onSelect: act(() => openInEditor(device.id, { sessionId: s.sessionId })) }, fill(t('openInEditor'), { editor: currentEditor().label })),
        h(MenuItem, { key: 'archive', icon: Icon('IconArchiveOutlineRegular'), disabled: !supported, onSelect: act(() => sessionAction(device, s.sessionId, 'archive')) }, nt('menu.archiveSession', null, t('archive'))),
      ]
      const row = h(
        'div',
        {
          className: cx(cls.session, selected && cls.selected, menuOpen && cls.menuOpen, !online && 'dshdev-dim'),
          role: 'treeitem',
          'aria-selected': !!selected,
          'data-dshdev-session': s.sessionId,
          'data-dshdev-pending': s.pending ? s.pending.kind : undefined,
          'data-dshdev-pinned': s.pinned ? '1' : undefined,
          'data-dshdev-state': status.state,
          onClick: () => openRemote(ctx, device, s.sessionId),
          onContextMenu: (e) => {
            e.preventDefault()
            setMenuOpen(true)
          },
          onMouseEnter: () => prefetchDevice(device),
        },
        h('span', { className: cls.slot }, status.state !== 'idle' ? h(StatusDots, { cls, status }) : null),
        h(
          'span',
          {
            className: cls.title,
            onDoubleClick: supported
              ? (e) => {
                  e.stopPropagation()
                  setStore({ dialog: { kind: 'rename', deviceId: device.id, sessionId: s.sessionId, title: s.title || '' } })
                }
              : undefined,
          },
          title,
        ),
        h('span', { className: cls.time, 'data-dshdev-time': '1', 'aria-hidden': status.trailing ? true : undefined }, status.trailing || (s.running ? '' : timeLabel(s.updatedAt))),
        s.pinned ? h('span', { className: cls.pinIndicator, role: 'img', 'aria-label': nt('row.pinned', null, t('pinned')), title: nt('row.pinned', null, t('pinned')) }, Icon('IconPinFillRegular', { size: 14 })) : null,
        h(
          'span',
          { className: cls.actions, onClick: (e) => e.stopPropagation() },
          h(NativeMenu, {
            open: menuOpen,
            onClose: () => setMenuOpen(false),
            portal: true,
            closeOnPointerLeave: true,
            anchor: h(
              'button',
              { type: 'button', className: cls.iconButton, 'aria-label': `${t('sessionActions')} — ${title}`, 'aria-haspopup': 'menu', 'data-dshdev-action': 'session-more', onClick: () => setMenuOpen((v) => !v) },
              Icon('IconEllipsisOutlineRegular'),
            ),
            children: items,
          }),
          supported ? h(TipButton, { cls, label: nt('actions.archive', null, t('archive')), action: 'archive', onClick: () => sessionAction(device, s.sessionId, 'archive') }, Icon('IconArchiveOutlineRegular', { size: 14 })) : null,
          supported ? h(TipButton, { cls, label: s.pinned ? nt('actions.unpin', null, t('unpin')) : nt('actions.pin', null, t('pin')), action: 'pin', onClick: () => sessionAction(device, s.sessionId, s.pinned ? 'unpin' : 'pin') }, pinIcon(14)) : null,
        ),
      )
      if (!P.HoverCard) return row
      return h(P.HoverCard, {
        anchor: row,
        content: h(RemoteSessionHover, { cls, device, s, status, t }),
        openDelayMs: 800,
        grouped: true,
        disabled: menuOpen,
        copyText: s.title || undefined,
        copyLabel: nt('copy', null, 'Copy'),
        copiedLabel: nt('hover.copied', null, 'Copied'),
      })
    }

    function deviceMenuItems(device, t, group) {
      const online = device.status === 'online'
      const archived = (device.archived || []).length
      const ports = (device.ports || []).length
      const old = (f) => (hasFeature(device, f) ? '' : ` (${t('outdated')})`)
      return [
        { id: 'new', icon: Icon('IconNewChatOutlineRegular'), label: fill(t('newRemote'), { device: device.name }), disabled: !online },
        ...(group
          ? [
              { id: 'files', icon: Icon('IconFolderOpenOutlineRegular'), label: t('openFiles'), disabled: !online },
              { id: 'editor', icon: Icon('IconCodeOutlineRegular'), label: fill(t('openInEditor'), { editor: currentEditor().label }) },
            ]
          : []),
        { id: 'search', icon: Icon('IconSearchOutlineRegular'), label: t('searchMenu') },
        ...(group ? [] : [{ id: 'add-folder', icon: Icon('IconProjectAddOutlineRegular'), label: `${t('addFolderMenu')}${old('workspaces')}`, disabled: !online }]),
        { type: 'separator', id: 'sep-1' },
        { id: 'plugins', icon: Icon('IconCordisPluginOutlineRegular'), label: t('pluginsMenu'), disabled: !online },
        { id: 'automations', icon: Icon('IconAlarmClockOutlineRegular'), label: t('automationsMenu'), disabled: !online },
        { id: 'ports', icon: Icon('IconGlobeOutlineRegular'), label: `${t('portsMenu')}${ports ? ` (${ports})` : old('ports')}`, disabled: !online },
        { id: 'sync', icon: Icon('IconRefreshOutlineRegular'), label: `${t('syncMenu')}${old('sync')}`, disabled: !online },
        { id: 'account', icon: Icon('IconUserOutlineRegular'), label: t('accountMenu'), disabled: !online },
        ...(archived ? [{ id: 'archived', icon: Icon('IconArchiveOutlineRegular'), label: fill(t('archivedMenu'), { n: archived }) }] : []),
        { type: 'separator', id: 'sep-2' },
        ...(!online && device.status !== 'revoked' ? [{ id: 'reconnect', icon: Icon('IconRefreshOutlineRegular'), label: t('reconnect') }] : []),
        ...(device.outdated && device.canUpdate && !group ? [{ id: 'update', icon: Icon('IconDownloadOutlineRegular'), label: device.updating ? t('updatingTag') : t('updateNow'), disabled: !!device.updating || !online }] : []),
        { id: 'settings', icon: Icon('IconSettingsOutlineRegular'), label: t('deviceSettings'), disabled: !online },
        { id: 'manage', icon: h(DevicesIcon, { size: 16 }), label: t('manageDevices') },
      ]
    }

    function runDeviceAction(id, device, group) {
      const ctx = appCtx
      const t = appT
      if (id === 'new') newRemote(ctx, device, group ? group.workspaceId : null)
      if (id === 'search') focusNativeSearch()
      if (id === 'files') openRemoteFiles(ctx, device, group || { sessions: device.sessions || [], workspaceId: null })
      if (id === 'editor') {
        const first = group && group.sessions[0]
        openInEditor(device.id, { path: group && group.path ? group.path : first && first.cwd, sessionId: first && first.sessionId })
      }
      if (id === 'plugins') openDevicePanel(device, 'plugins')
      if (id === 'automations') openDevicePanel(device, 'schedules')
      if (id === 'ports' || id === 'sync' || id === 'account' || id === 'archived') setStore({ dialog: { kind: id, deviceId: device.id } })
      if (id === 'settings') openDeviceSettings(device)
      if (id === 'add-folder') openFolders(device)
      if (id === 'reconnect') {
        post('/devices/refresh', { id: device.id })
          .then(() => setTimeout(() => refreshDevices(), 1200))
          .catch(() => {})
        showToast(fill(t('reconnecting'), { device: device.name }), { icon: Icon('IconRefreshOutlineRegular') })
      }
      if (id === 'update') startDeviceUpdate(device)
      if (id === 'manage') {
        try {
          ctx.layout.selectPanel(PANEL_ID)
        } catch {}
      }
    }

    function RemoteGroupHover({ cls, device, g, t }) {
      const waiting = g.sessions.filter((s) => s.pending).length
      return h(
        'div',
        { className: cls.hoverContent },
        h('div', { className: cls.hoverTitle }, g.title),
        g.path ? h('div', { className: cls.hoverPath || cls.hoverTime }, g.path.replace(/^\/(root|home\/[^/]+)(?=\/|$)/, '~')) : null,
        h('div', { className: cls.hoverStatus }, h(RemoteMark, { size: 12 }), h('span', null, device.name)),
        waiting ? h('div', { className: cls.hoverStatus }, h(Dot, { state: 'warning' }), h('span', null, fill(t('waitingCount'), { n: waiting }))) : null,
      )
    }

    /** The menu of a remote workspace: its own actions, then the device's panels. */
    function workspaceMenuItems(device, t, g) {
      const online = device.status === 'online'
      const manage = !!g.workspaceId && hasFeature(device, 'workspaces')
      return [
        ...(g.workspaceId ? [{ id: 'new', icon: Icon('IconNewChatOutlineRegular'), label: t('newSessionHere'), disabled: !online }] : []),
        { id: 'files', icon: Icon('IconFolderOpenOutlineRegular'), label: t('openFiles'), disabled: !online },
        { id: 'editor', icon: Icon('IconCodeOutlineRegular'), label: fill(t('openInEditor'), { editor: currentEditor().label }) },
        ...(manage
          ? [
              { type: 'separator', id: 'sep-ws' },
              { id: 'split', icon: Icon('IconProjectAddOutlineRegular'), label: t('splitProjects'), disabled: !online },
              { id: 'rename-ws', icon: Icon('IconEditOutlineRegular'), label: nt('rename', null, t('rename')), disabled: !online },
              { id: 'remove-ws', icon: Icon('IconTrashOutlineRegular'), label: nt('delete.workspace', null, t('removeWorkspace')), danger: true, disabled: !online },
            ]
          : []),
        { type: 'separator', id: 'sep-dev' },
        { type: 'label', id: 'device', text: device.name },
        { id: 'plugins', icon: Icon('IconCordisPluginOutlineRegular'), label: t('pluginsMenu'), disabled: !online },
        { id: 'automations', icon: Icon('IconAlarmClockOutlineRegular'), label: t('automationsMenu'), disabled: !online },
      ]
    }
    function runWorkspaceAction(id, device, g) {
      const ctx = appCtx
      if (id === 'new') newRemote(ctx, device, g.workspaceId)
      if (id === 'files') openRemoteFiles(ctx, device, g)
      if (id === 'editor') {
        const first = g.sessions[0]
        openInEditor(device.id, { path: g.path || (first && first.cwd), sessionId: first && first.sessionId })
      }
      if (id === 'split') openFolders(device, { path: g.path, split: true })
      if (id === 'rename-ws') setStore({ dialog: { kind: 'rename-ws', deviceId: device.id, workspaceId: g.workspaceId, title: g.title } })
      if (id === 'remove-ws') setStore({ dialog: { kind: 'remove-ws', deviceId: device.id, workspaceId: g.workspaceId, title: g.title } })
      if (id === 'plugins') openDevicePanel(device, 'plugins')
      if (id === 'automations') openDevicePanel(device, 'schedules')
    }
    /** The folder browser of a device (add workspaces; split a folder into its projects). */
    function openFolders(device, { path, split = false } = {}) {
      if (!hasFeature(device, 'workspaces')) {
        showToast(fill(appT('hostOutdatedFeature'), { device: device.name }), { icon: Icon('IconWarningOutlineRegular') })
        return
      }
      setStore({ dialog: { kind: 'folders', deviceId: device.id, path: path || null, split } })
    }

    function RemoteGroupHover({ cls, device, g, t }) {
      const waiting = g.sessions.filter((s) => s.pending).length
      return h(
        'div',
        { className: cls.hoverContent },
        h('div', { className: cls.hoverTitle }, g.title),
        g.path ? h('div', { className: cls.hoverPath || cls.hoverTime }, g.path.replace(/^\/(root|home\/[^/]+)(?=\/|$)/, '~')) : null,
        h('div', { className: cls.hoverStatus }, h(RemoteMark, { size: 12 }), h('span', null, device.name)),
        waiting ? h('div', { className: cls.hoverStatus }, h(Dot, { state: 'warning' }), h('span', null, fill(t('waitingCount'), { n: waiting }))) : null,
      )
    }

    function RemoteGroup({ ctx, t, cls, device, g, st, chatActive, perGroup }) {
      const [menuOpen, setMenuOpen] = useState(false)
      const ckey = `${device.id}:${g.key}`
      const collapsed = !!st.collapsed[ckey]
      const online = device.status === 'online'
      const waiting = g.sessions.filter((s) => s.pending).length
      const active = chatActive && st.selection && st.selection.deviceId === device.id && g.sessions.some((s) => s.sessionId === (st.selection.sessionId || st.embedded[device.id]))
      const header = h(
        'div',
        {
          className: cx(cls.project, menuOpen && cls.menuOpen, !online && 'dshdev-dim'),
          role: 'treeitem',
          'aria-expanded': !collapsed,
          'data-dshdev-group': ckey,
          onClick: () => toggleCollapsed(ckey),
          onContextMenu: (e) => {
            e.preventDefault()
            setMenuOpen(true)
          },
          onMouseEnter: () => prefetchDevice(device),
        },
        h('span', { className: cx(cls.slot, cls.folder, active && cls.folderActive) }, Icon(collapsed ? 'IconFolderCloseRegular' : 'IconFolderOpenRegular', {}, () => h(RemoteIcon, { size: 16 }))),
        h('span', { className: cx(cls.slot, cls.chevron) }, Icon('IconTriangleRightFillRegular', { className: cx(cls.arrow, !collapsed && cls.arrowOpen) })),
        h('span', { className: cls.projectText }, h('span', { className: cls.title }, g.title)),
        waiting && collapsed ? h('span', { className: 'dshdev-group-status', title: fill(t('waitingCount'), { n: waiting }), 'data-dshdev-waiting': waiting }, h(Dot, { state: 'warning' })) : null,
        h(
          'span',
          { className: cls.actions, onClick: (e) => e.stopPropagation() },
          h(NativeMenu, {
            open: menuOpen,
            onClose: () => setMenuOpen(false),
            items: workspaceMenuItems(device, t, g),
            onSelect: (id) => {
              setMenuOpen(false)
              runWorkspaceAction(id, device, g)
            },
            portal: true,
            closeOnPointerLeave: true,
            anchor: h(
              'button',
              { type: 'button', className: cls.iconButton, 'aria-label': `${t('moreActions')} — ${g.title}`, 'aria-haspopup': 'menu', 'data-dshdev-action': 'more', onClick: () => setMenuOpen((v) => !v) },
              Icon('IconEllipsisOutlineRegular'),
            ),
          }),
          g.workspaceId ? h(TipButton, { cls, label: fill(t('newIn'), { workspace: g.title }), action: 'new', disabled: !online, onClick: () => online && newRemote(ctx, device, g.workspaceId) }, Icon('IconNewChatOutlineRegular')) : null,
        ),
      )
      const rows = collapsed ? [] : perGroup && !st.expanded[ckey] ? g.sessions.slice(0, perGroup) : g.sessions
      return h(
        'div',
        { className: cls.group, 'data-dshdev-workspace': ckey, 'data-dshdev-depth': g.depth || 0, style: g.depth ? { '--dsh-workspace-indent': `${g.depth * 12}px` } : undefined },
        P.HoverCard ? h(P.HoverCard, { anchor: header, content: h(RemoteGroupHover, { cls, device, g, t }), openDelayMs: 800, grouped: true, disabled: menuOpen, copyText: g.path || undefined, copyLabel: nt('copy', null, 'Copy'), copiedLabel: nt('hover.copied', null, 'Copied') }) : header,
        rows.map((s) => {
          const selected = chatActive && st.selection && st.selection.deviceId === device.id && (st.selection.sessionId === s.sessionId || (!st.selection.sessionId && st.embedded[device.id] === s.sessionId))
          return h(RemoteSessionRow, { key: s.sessionId, ctx, t, cls, device, s, selected, online })
        }),
        !collapsed && g.sessions.length === 0 && g.workspaceId
          ? h(
              'div',
              { className: cx(cls.session, 'dshdev-device-empty', !online && 'dshdev-dim'), role: 'treeitem', 'data-dshdev-empty-workspace': g.workspaceId, onClick: () => online && newRemote(ctx, device, g.workspaceId) },
              h('span', { className: cls.slot }, Icon('IconNewChatOutlineRegular', { size: 14 })),
              h('span', { className: cls.title }, t('newSessionRow')),
            )
          : null,
        !collapsed && perGroup && g.sessions.length > perGroup
          ? h(
              'button',
              { type: 'button', className: cls.overflow, 'aria-expanded': !!st.expanded[ckey], 'data-dshdev-more': ckey, onClick: () => setStore({ expanded: { ...st.expanded, [ckey]: !st.expanded[ckey] } }) },
              st.expanded[ckey] ? nt('sessions.collapse', null, t('showLess')) : nt('sessions.expand', { n: g.sessions.length - perGroup, count: g.sessions.length - perGroup }, fill(t('showMore'), { n: g.sessions.length - perGroup })),
            )
          : null,
      )
    }

    /** How a device is doing, in a word for its sidebar header ('' when all is well). */
    function deviceHeaderState(device, t) {
      if (device.updating) return { text: t('updatingTag'), busy: true, dot: 'ongoing' }
      if (device.status === 'online') return { text: '', busy: false, dot: 'done' }
      if (device.status === 'connecting') return { text: t('status_connecting'), busy: true, dot: 'ongoing' }
      if (device.status === 'revoked') return { text: t('status_revoked'), busy: false, dot: 'warning' }
      if (device.status === 'error') return { text: t('status_error'), busy: false, dot: 'warning' }
      return { text: t('status_offline'), busy: false, dot: 'idle' }
    }

    function RemoteDeviceHover({ cls, device, t }) {
      const state = deviceHeaderState(device, t)
      const online = device.status === 'online'
      const where = device.transport && device.transport.kind === 'ssh' ? `SSH · ${device.transport.target}` : device.transport ? device.transport.url : null
      const versions = device.versions ? [device.versions.dsh ? `dsh ${device.versions.dsh}` : null, device.versions.plugin ? `host ${device.versions.plugin}` : null].filter(Boolean).join(' · ') : null
      return h(
        'div',
        { className: cls.hoverContent },
        h('div', { className: cls.hoverTitle }, device.name),
        where ? h('div', { className: cls.hoverPath || cls.hoverTime }, where) : null,
        h('div', { className: cls.hoverStatus }, h(Dot, { state: state.dot }), h('span', null, [t(`status_${device.status}`), versions].filter(Boolean).join(' · '))),
        !online && device.lastSeenAt ? h('div', { className: cls.hoverTime }, fill(t('lastSeen'), { when: timeLabel(device.lastSeenAt) })) : null,
        !online && device.error ? h('div', { className: cls.hoverTime }, device.error) : null,
        device.pendingCount ? h('div', { className: cls.hoverStatus }, h(Dot, { state: 'warning' }), h('span', null, fill(t('waitingCount'), { n: device.pendingCount }))) : null,
        online && device.health ? h('div', { className: cls.hoverStatus }, h(Dot, { state: healthIssues(device.health).length ? 'warning' : 'done' }), h('span', null, healthSummary(device.health, t))) : null,
      )
    }

    /** One device in the sidebar: a section header like DSH's "Workspaces", then its workspaces. */
    function RemoteDevice({ ctx, t, cls, device, st, chatActive, perGroup }) {
      const [menuOpen, setMenuOpen] = useState(false)
      const key = `device:${device.id}`
      const collapsed = !!st.collapsed[key]
      const online = device.status === 'online'
      const state = deviceHeaderState(device, t)
      const mode = st.groupBy || 'workspace'
      const groups = deviceGroups(device, mode)
      const waiting = device.pendingCount || (device.sessions || []).filter((s) => s.pending).length
      const list = discoverPrefixes().list
      const headerButton = list ? `${list}iconButton` : 'dshdev-fb-iconbtn'
      const toggle = () => toggleCollapsed(key)
      const header = h(
        'div',
        {
          className: cx(list ? `${list}sectionHeader` : 'dshdev-fb-section', 'dshdev-device-header', menuOpen && 'dshdev-menu-open'),
          role: 'button',
          tabIndex: 0,
          'aria-expanded': !collapsed,
          'aria-label': [device.name, state.text].filter(Boolean).join(' — '),
          'data-dshdev-device-header': device.id,
          onClick: toggle,
          onKeyDown: (e) => {
            if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
            e.preventDefault()
            toggle()
          },
          onContextMenu: (e) => {
            e.preventDefault()
            setMenuOpen(true)
          },
          onMouseEnter: () => prefetchDevice(device),
        },
        h(
          'span',
          { className: cx(list && `${list}sectionLabel`, list && `${list}wide`, 'dshdev-device-label') },
          h('span', { className: 'dshdev-device-icon' }, h(RemoteIcon, { size: 14 })),
          h('span', { className: 'dshdev-device-name' }, device.name),
          state.text
            ? h('span', { className: 'dshdev-device-state', 'data-dshdev-state': device.updating ? 'updating' : device.status }, state.busy && P.TextShimmer ? h(P.TextShimmer, null, state.text) : state.text)
            : null,
          waiting && (collapsed || !online) ? h('span', { className: 'dshdev-device-waiting', title: fill(t('waitingCount'), { n: waiting }), 'data-dshdev-waiting': waiting }, h(Dot, { state: 'warning' })) : null,
          Icon('IconChevronDownOutlineRegular', { size: 12, className: cx('dshdev-device-chevron', collapsed && 'dshdev-collapsed') }),
        ),
        h(
          'div',
          { className: cx(list && `${list}headerActions`, 'dshdev-device-actions'), onClick: (e) => e.stopPropagation() },
          hasFeature(device, 'workspaces')
            ? h(TipButton, { cls, className: headerButton, label: fill(t('addFolderTo'), { device: device.name }), action: 'device-add-folder', disabled: !online, onClick: () => online && openFolders(device) }, Icon('IconProjectAddOutlineRegular', { size: 14 }))
            : null,
          h(TipButton, { cls, className: headerButton, label: fill(t('newRemote'), { device: device.name }), action: 'device-new', disabled: !online, onClick: () => online && newRemote(ctx, device, null) }, Icon('IconNewChatOutlineRegular', { size: 14 })),
          h(NativeMenu, {
            open: menuOpen,
            onClose: () => setMenuOpen(false),
            items: deviceMenuItems(device, t, null),
            onSelect: (id) => {
              setMenuOpen(false)
              runDeviceAction(id, device, null)
            },
            portal: true,
            align: 'end',
            anchor: h(
              'button',
              { type: 'button', className: headerButton, 'aria-label': `${t('moreActions')} — ${device.name}`, 'aria-haspopup': 'menu', 'data-dshdev-action': 'device-more', onClick: () => setMenuOpen((v) => !v) },
              Icon('IconEllipsisOutlineRegular', { size: 14 }),
            ),
          }),
        ),
      )
      let body = null
      if (!collapsed) {
        const all = device.sessions || []
        if (mode === 'flat' && all.length) {
          // "Single list": the device's chats straight under its header, like DSH's flat list.
          const fkey = `${device.id}:_flat`
          const list = pinFirst([...all])
          const shown = perGroup && !st.expanded[fkey] ? list.slice(0, perGroup) : list
          body = h(
            'div',
            { className: cls.group, 'data-dshdev-flat': device.id },
            shown.map((s) => {
              const selected = chatActive && st.selection && st.selection.deviceId === device.id && (st.selection.sessionId === s.sessionId || (!st.selection.sessionId && st.embedded[device.id] === s.sessionId))
              return h(RemoteSessionRow, { key: s.sessionId, ctx, t, cls, device, s, selected, online })
            }),
            perGroup && list.length > perGroup
              ? h(
                  'button',
                  { type: 'button', className: cls.overflow, 'aria-expanded': !!st.expanded[fkey], 'data-dshdev-more': fkey, onClick: () => setStore({ expanded: { ...st.expanded, [fkey]: !st.expanded[fkey] } }) },
                  st.expanded[fkey] ? nt('sessions.collapse', null, t('showLess')) : nt('sessions.expand', { n: list.length - perGroup, count: list.length - perGroup }, fill(t('showMore'), { n: list.length - perGroup })),
                )
              : null,
          )
        } else if (groups.length) {
          // In the tree, a collapsed workspace hides the ones inside it.
          const hidden = new Set()
          body = []
          for (const g of groups) {
            if (g.parentKey && (hidden.has(g.parentKey) || st.collapsed[`${device.id}:${g.parentKey}`])) {
              hidden.add(g.key)
              continue
            }
            body.push(h(RemoteGroup, { key: `${device.id}:${g.key}`, ctx, t, cls, device, g, st, chatActive, perGroup }))
          }
        } else
          body = h(
            'div',
            {
              className: cx(cls.session, 'dshdev-device-empty', !online && 'dshdev-dim'),
              role: 'treeitem',
              'data-dshdev-empty': device.id,
              onClick: () => online && newRemote(ctx, device, null),
            },
            h('span', { className: cls.slot }, online ? Icon('IconNewChatOutlineRegular', { size: 14 }) : null),
            h('span', { className: cls.title }, online ? t('newSessionRow') : t('emptyOffline')),
          )
      }
      return h(
        'div',
        { className: cx('dshdev-device-section', !online && 'dshdev-device-off'), 'data-dshdev-device': device.id, 'data-dshdev-status': device.status },
        P.HoverCard ? h(P.HoverCard, { anchor: header, content: h(RemoteDeviceHover, { cls, device, t }), openDelayMs: 800, grouped: true, disabled: menuOpen }) : header,
        body,
      )
    }

    /** While DSH's own sidebar search has a query, remote chats answer it with DSH's result rows. */
    function RemoteSearchResults({ ctx, t, cls, st, query }) {
      const [remote, setRemote] = useState({ q: '', results: [] })
      const q = query.trim()
      useEffect(() => {
        if (q.length < 2) {
          setRemote({ q, results: [] })
          return
        }
        let live = true
        const timer = setTimeout(async () => {
          try {
            const r = await api(`/devices/search?q=${encodeURIComponent(q)}`)
            if (live) setRemote({ q, results: r.results || [] })
          } catch {
            if (live) setRemote({ q, results: [] })
          }
        }, 300)
        return () => {
          live = false
          clearTimeout(timer)
        }
      }, [q])
      const needle = q.toLowerCase()
      const hits = []
      const seen = new Set()
      for (const d of st.data.devices || []) {
        for (const s of d.sessions || []) {
          if (!(s.title || '').toLowerCase().includes(needle)) continue
          seen.add(`${d.id}:${s.sessionId}`)
          hits.push({ device: d, s, snippet: null })
        }
      }
      for (const r of remote.q === q ? remote.results : []) {
        const d = (st.data.devices || []).find((x) => x.id === r.deviceId)
        if (!d) continue
        for (const it of r.items || []) {
          const k = `${d.id}:${it.sessionId}`
          if (seen.has(k)) continue
          seen.add(k)
          const s = (d.sessions || []).find((x) => x.sessionId === it.sessionId) || { sessionId: it.sessionId, title: it.title }
          hits.push({ device: d, s, snippet: it.snippet })
        }
      }
      if (hits.length === 0) return null
      const chatActive = st.activePanel === CHAT_PANEL_ID
      return h(
        'div',
        { role: 'group', 'aria-label': t('remote'), 'data-dshdev-search': q },
        hits.slice(0, 40).map(({ device, s, snippet }) => {
          const status = remoteStatus(s, device.id)
          const selected = chatActive && st.selection && st.selection.deviceId === device.id && st.selection.sessionId === s.sessionId
          return h(
            'div',
            {
              key: `${device.id}:${s.sessionId}`,
              className: cx(cls.searchRow, selected && cls.selected),
              role: 'treeitem',
              'aria-selected': !!selected,
              'data-dshdev-session': s.sessionId,
              'data-dshdev-result': s.sessionId,
              onClick: () => openRemote(ctx, device, s.sessionId),
            },
            h(
              'span',
              { className: cls.searchHeading },
              h('span', { className: cls.slot }, status.state !== 'idle' ? h(StatusDots, { cls, status }) : h(RemoteMark, null)),
              h('span', { className: cls.searchTitle }, s.title || nt('session.untitled', null, t('untitled'))),
            ),
            snippet ? h('span', { className: cls.searchSnippet }, snippet) : null,
            h('span', { className: cls.searchMeta }, h('span', { className: cls.searchWorkspace }, [s.workspaceTitle, device.name].filter(Boolean).join(' · '))),
          )
        }),
      )
    }

    function RemoteSidebar({ ctx, t }) {
      const st = useStore()
      const [cls, setCls] = useState(rowClasses)
      useEffect(() => {
        const timer = setTimeout(() => setCls(rowClasses()), 1500)
        return () => clearTimeout(timer)
      }, [st.data.devices.length])
      const devices = st.data.devices || []
      if (devices.length === 0 || !st.settings.showInSidebar) return null
      if (st.nativeSearch && st.nativeSearch.trim()) return h(RemoteSearchResults, { ctx, t, cls, st, query: st.nativeSearch })
      const chatActive = st.activePanel === CHAT_PANEL_ID
      const perGroup = Number(st.settings.sessionsPerGroup) || 0
      return h(
        'div',
        { className: 'dshdev-remote-root', role: 'group', 'aria-label': t('remote') },
        devices.map((device) => h(RemoteDevice, { key: device.id, ctx, t, cls, device, st, chatActive, perGroup })),
      )
    }

    let prefetchTimer = null
    function prefetchDevice(device) {
      if (!store.settings.preload || !device || device.status !== 'online' || frames.byDevice.has(device.id)) return
      clearTimeout(prefetchTimer)
      prefetchTimer = setTimeout(() => frames.preload(device.id, device).catch(() => {}), 150)
    }

    /** Open DSH's own sidebar search (remote chats answer it too). */
    function focusNativeSearch() {
      const input = document.querySelector('[class*="regionArea"] input[class*="_searchInput"]')
      if (input) {
        input.focus()
        return
      }
      const button = document.querySelector('[class*="regionArea"] [class*="_searchButton"]') || document.querySelector('[class*="_searchButton"]')
      if (button) button.click()
      setTimeout(() => document.querySelector('input[class*="_searchInput"]')?.focus(), 80)
    }

    /** Follow the query typed in DSH's sidebar search box (only while its results are showing). */
    function watchNativeSearch() {
      let timer = null
      const current = () => {
        const input = document.querySelector('[class*="regionArea"] input[class*="_searchInput"]') || document.querySelector('input[class*="_searchInput"]')
        if (!input || input.offsetParent === null) return ''
        // DSH swaps its tree for a results tree while searching.
        const list = input.closest('[class*="_list"]') || document
        return list.querySelector('[class*="_searchTree"], [class*="_searchStatus"]') ? input.value : ''
      }
      let queued = false
      const read = () => {
        if (queued) return
        queued = true
        requestAnimationFrame(() => {
          queued = false
          const value = current()
          if (value !== store.nativeSearch) setStore({ nativeSearch: value })
        })
      }
      const onInput = (e) => {
        if (e.target && e.target.matches && e.target.matches('input[class*="_searchInput"]')) read()
      }
      document.addEventListener('input', onInput, true)
      // Opening, clearing or closing the search swaps DSH's result tree in and out.
      const observer = new MutationObserver(read)
      observer.observe(document.body, { childList: true, subtree: true })
      return () => {
        clearTimeout(timer)
        document.removeEventListener('input', onInput, true)
        observer.disconnect()
      }
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

    // ── "where should this session run?" device menu ────────────────────────
    let appCtx = null
    function startLocalSession() {
      store.localUntil = Date.now() + 5000
      try {
        const ws = appCtx.get ? appCtx.get('uiWorkspace') : appCtx.uiWorkspace
        if (ws && typeof ws.startSession === 'function') ws.startSession()
        else appCtx.layout.selectPanel(null)
      } catch {
        try {
          appCtx.layout.selectPanel(null)
        } catch {}
      }
    }
    /** Open the device picker anchored to `rect` (a pill on the new-session page, or one inside a device UI). */
    function openDevicePicker({ rect, current = null }) {
      const r = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.right - rect.left, height: rect.bottom - rect.top, x: rect.left, y: rect.top }
      setStore({ picker: { rect: r, current } })
    }
    let appT = (k) => k

    function LaptopIcon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 2.5, y: 3, width: 11, height: 7.5, rx: 1.3, stroke: 'currentColor' }),
        h('path', { d: 'M1 12.5h14', stroke: 'currentColor', strokeLinecap: 'round' }),
      )
    }

    /** A device picker pill before the composer's workspace chooser on the new-session page. */
    function mountDevicePill(ctx, t) {
      const laptop = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="3" width="11" height="7.5" rx="1.3" stroke="currentColor"/><path d="M1 12.5h14" stroke="currentColor" stroke-linecap="round"/></svg>'
      const chevron = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2.5 4l2.5 2.5L7.5 4" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      const place = () => {
        if ((store.data.devices || []).length === 0) {
          document.querySelectorAll('[data-dsh-devices=device-pill]').forEach((el) => el.remove())
          return
        }
        for (const chooser of document.querySelectorAll('button[aria-haspopup="menu"]:not([data-dsh-devices])')) {
          if (![...chooser.classList].some((c) => /_workspace$/.test(c))) continue
          const prev = chooser.previousElementSibling
          if (prev && prev.getAttribute('data-dsh-devices') === 'device-pill') continue
          const pill = document.createElement('button')
          pill.type = 'button'
          pill.className = `${chooser.className} dshdev-pill`
          pill.setAttribute('data-dsh-devices', 'device-pill')
          pill.setAttribute('aria-haspopup', 'menu')
          pill.setAttribute('aria-label', t('chooseDevice'))
          const labelCls = chooser.querySelector('[class*="_workspaceLabel"]')?.className || ''
          pill.innerHTML = `${laptop}<span class="${labelCls}"></span>${chevron}`
          pill.querySelector('span').textContent = t('thisMac')
          pill.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            openDevicePicker({ rect: pill.getBoundingClientRect(), current: null })
          })
          chooser.parentElement.insertBefore(pill, chooser)
          // A fresh local new-session page: honour the default device, unless the user just chose this computer.
          const def = store.settings.defaultDevice
          if (def && def !== 'local' && Date.now() > store.localUntil) {
            const device = (store.data.devices || []).find((d) => d.id === def && d.status === 'online')
            if (device) setTimeout(() => newRemote(ctx, device, null), 0)
          }
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
      const unsub = subscribe(() => place())
      place()
      return () => {
        observer.disconnect()
        unsub()
        document.querySelectorAll('[data-dsh-devices=device-pill]').forEach((el) => el.remove())
      }
    }

    // ── DeepSeek access on a device: API key and account ───────────────────
    function SmallButton({ children, onClick, disabled, primary, danger, testid }) {
      return h('button', { type: 'button', className: cx('dshdev-small-button', primary && 'primary', danger && 'danger'), onClick, disabled, 'data-testid': testid }, children)
    }
    /** A credential line like the provider cards of DSH's Models settings. */
    function CredentialRow({ ok, name, tag, status, actions, testid }) {
      return h(
        'li',
        { className: 'dshdev-cred-card', 'data-testid': testid },
        h(
          'div',
          { className: 'dshdev-cred-head' },
          h('span', { className: 'dshdev-cred-identity' }, h('span', { className: cx('dshdev-cred-dot', ok ? 'ok' : 'missing') }), h('span', { className: 'dshdev-cred-name' }, name), tag ? h('span', { className: 'dshdev-cred-tag' }, tag) : null),
          status ? h('span', { className: cx('dshdev-cred-status', ok && 'ok') }, status) : null,
          h('span', { className: 'dshdev-cred-actions' }, actions),
        ),
      )
    }

    function ModelKeyPanel({ device, t, variant = 'card', onSaved, onUpdate }) {
      const st = useStore()
      const [editing, setEditing] = useState(false)
      const [value, setValue] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [ok, setOk] = useState(null)
      const model = device.model
      if (device.status !== 'online') return null
      if (!model) {
        if (variant === 'banner') return null
        return h(
          'div',
          { className: 'dshdev-callout' },
          h('span', { className: 'dshdev-callout-dot' }),
          h('div', { className: 'dshdev-callout-main' }, h('div', { className: 'dshdev-callout-text' }, fill(t('needsUpdate'), { remote: (device.versions && device.versions.plugin) || '?' })), device.canUpdate ? h('div', { className: 'dshdev-hint-text' }, t('updateWarn')) : null),
          h('div', { className: 'dshdev-callout-actions' }, device.canUpdate ? h(SmallButton, { primary: true, onClick: () => onUpdate && onUpdate(device) }, t('updateNow')) : null),
        )
      }
      const run = async (fn, success) => {
        setBusy(true)
        setError(null)
        setOk(null)
        try {
          await fn()
          if (success) setOk(success)
          await refreshDevices()
          if (onSaved) onSaved()
          return true
        } catch (e) {
          setError(friendlyError(e, device))
          return false
        } finally {
          setBusy(false)
        }
      }
      const saveKey = (payload) =>
        run(() => post('/devices/model-key', { id: device.id, ...payload }), fill(t('keySaved'), { device: device.name })).then((done) => {
          if (done) {
            setEditing(false)
            setValue('')
          }
        })
      const saveTyped = () => value.trim() && saveKey({ apiKey: value.trim() })
      const removeKey = () => run(() => post('/devices/model-key/clear', { id: device.id }))
      const shareAccount = () => run(() => post('/devices/account', { id: device.id }), fill(t('accountShared'), { device: device.name }))
      const signOut = () => run(() => post('/devices/account/clear', { id: device.id }))
      const account = model.account || null
      const accountOk = !!(account && account.signedIn)
      const canAccount = hasFeature(device, 'account') && !!account && account.available !== false
      const ready = model.ready ?? model.configured
      const offerAccount = canAccount && st.localAccount && !accountOk
      const offerKey = st.localKey && !model.configured
      const editor = editing
        ? h(
            'div',
            { className: 'dshdev-key-editor' },
            h(NativeField, { value, onChange: setValue, onEnter: saveTyped, label: t('pasteKey'), placeholder: t('keyPlaceholder'), type: 'password', autoFocus: true, disabled: busy }),
            h(SmallButton, { primary: true, disabled: busy || !value.trim(), onClick: saveTyped }, t('saveKey')),
            h(SmallButton, { onClick: () => setEditing(false) }, nt('cancel', null, t('cancel'))),
          )
        : null
      const feedback = h(React.Fragment, null, error ? h('p', { className: 'dshdev-error-text', role: 'alert' }, error) : null, ok ? h('p', { className: 'dshdev-success-text', role: 'status' }, ok) : null)
      if (variant === 'banner') {
        if (ready && !editing) return null
        return h(
          'div',
          { className: 'dshdev-callout', role: 'alert', 'data-testid': `model-key-${device.id}` },
          h('span', { className: 'dshdev-callout-dot' }),
          h('div', { className: 'dshdev-callout-main' }, h('div', { className: 'dshdev-callout-text' }, fill(t('modelMissing'), { device: device.name })), editor, feedback),
          editing
            ? null
            : h(
                'div',
                { className: 'dshdev-callout-actions' },
                offerAccount ? h(SmallButton, { primary: true, disabled: busy, onClick: shareAccount, testid: 'use-mac-account' }, t('useMacAccount')) : null,
                offerKey ? h(SmallButton, { primary: !offerAccount, disabled: busy, onClick: () => saveKey({ fromDesktop: true }) }, t('useMacKey')) : null,
                h(SmallButton, { onClick: () => setEditing(true) }, t('pasteKey')),
                h(SmallButton, { onClick: () => openDeviceSettings(device) }, t('deviceSettings')),
              ),
        )
      }
      return h(
        'div',
        { className: 'dshdev-cred', 'data-testid': ready ? `model-ok-${device.id}` : `model-key-${device.id}` },
        h(
          'ul',
          { className: 'dshdev-cred-list' },
          h(CredentialRow, {
            ok: model.configured,
            name: t('apiKeyName'),
            tag: model.configured && model.source ? model.source : null,
            status: model.configured ? t('configured') : t('notConfigured'),
            testid: 'cred-key',
            actions: h(
              React.Fragment,
              null,
              offerKey ? h(SmallButton, { primary: !offerAccount, disabled: busy, onClick: () => saveKey({ fromDesktop: true }) }, t('useMacKey')) : null,
              h(SmallButton, { disabled: busy, onClick: () => setEditing(true) }, model.configured ? t('changeKey') : t('pasteKey')),
              model.configured ? h(SmallButton, { danger: true, disabled: busy, onClick: removeKey }, t('removeKey')) : null,
            ),
          }),
          canAccount
            ? h(CredentialRow, {
                ok: accountOk,
                name: t('accountName'),
                status: accountOk ? t('signedIn') : t('notSignedIn'),
                testid: accountOk ? `account-ok-${device.id}` : 'cred-account',
                actions: h(
                  React.Fragment,
                  null,
                  offerAccount ? h(SmallButton, { primary: true, disabled: busy, onClick: shareAccount, testid: 'use-mac-account' }, t('useMacAccount')) : null,
                  accountOk ? h(SmallButton, { disabled: busy, onClick: signOut }, t('signOutDevice')) : null,
                ),
              })
            : null,
        ),
        editor,
        h('p', { className: 'dshdev-hint-text' }, canAccount ? `${t('keyHint')} ${t('accountNote')}` : t('keyHint')),
        feedback,
        h('button', { type: 'button', className: 'dshdev-link-button', onClick: () => openDeviceSettings(device) }, t('deviceSettings')),
      )
    }

    function openDeviceSettings(device) {
      setStore({ selection: { deviceId: device.id, sessionId: store.embedded[device.id] || null } })
      try {
        appCtx.layout.selectPanel(CHAT_PANEL_ID)
      } catch {}
      frames.show(device.id, device, { type: 'open-settings' }).catch(() => {})
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
        const anchor = document.querySelector('button[aria-haspopup="menu"][aria-expanded="true"]:not([data-dsh-devices])')
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
          const workspaces = device.workspaces && device.workspaces.length ? device.workspaces : deviceGroups(device).filter((g) => g.workspaceId).map((g) => ({ id: g.workspaceId, title: g.title }))
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
      // Shown with no device UI (unloaded, or the app came back to this panel): load it again.
      useEffect(() => {
        if (st.activePanel !== CHAT_PANEL_ID || !device || device.status !== 'online' || frames.byDevice.has(device.id)) return
        // (an open already in flight is creating it)
        if (frames.creating && frames.creating.has(device.id)) return
        if (st.selection.panel) {
          frames.openPanel(device, st.selection.panel)
          return
        }
        const sessionId = st.selection.sessionId || st.embedded[device.id]
        frames.show(device.id, device, sessionId ? { type: 'open-session', sessionId } : null).catch(() => {})
      }, [st.activePanel, device && device.id, device && device.status, frames.byDevice.has(device ? device.id : '')])
      let status = null
      if (!device) status = st.loaded ? null : ''
      else if (device.status === 'offline' || device.status === 'error' || device.status === 'revoked') status = fill(t('deviceOffline'), { device: device.name })
      else if (!frames.byDevice.has(device.id)) status = fill(t('connecting'), { device: device.name })
      const banner = device && device.status === 'online' && device.model && !(device.model.ready ?? device.model.configured)
      const panel = device && st.selection && st.selection.panel
      const panelName = panel ? panelLabel(panel) : ''
      const connecting = device && device.status !== 'offline' && device.status !== 'error' && device.status !== 'revoked'
      return h(
        'div',
        { className: 'dshdev-chat-wrap', 'data-testid': 'dsh-devices-chat', style: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 } },
        panel
          ? h(
              'div',
              { className: 'dshdev-context', 'data-testid': 'dsh-devices-panel-context' },
              h('span', { className: 'dshdev-context-label' }, h(RemoteIcon, { size: 14 }), h('span', null, device.name)),
              h('span', { className: 'dshdev-context-panel' }, panelName),
            )
          : null,
        banner ? h('div', { className: 'dshdev-chat-banner' }, h(ModelKeyPanel, { device, t, variant: 'banner', onSaved: () => frames.reload(device.id) })) : null,
        h(EditorHostDialog, { t }),
        h(
          'div',
          { className: 'dshdev-chat-panel', ref, style: { position: 'relative', width: '100%', flex: '1 1 auto', minHeight: 0 } },
          status ? h('div', { className: 'dshdev-chat-status' }, connecting && P.TextShimmer ? h(P.TextShimmer, null, status) : status) : null,
        ),
      )
    }

    // ── Settings → Devices, built like DSH's own sections ───────────────────
    function SettingsRow({ title, description, children, extra, testid }) {
      return h(
        'div',
        { className: 'dshdev-srow', 'data-testid': testid },
        h('div', { className: 'dshdev-srow-text' }, h('div', { className: 'dshdev-srow-title' }, title), description ? h('div', { className: 'dshdev-srow-desc' }, description) : null, extra || null),
        h('div', { className: 'dshdev-srow-control' }, children),
      )
    }
    /** DSH's settings selector: a pill that opens its menu. */
    function SettingsSelect({ value, options, onChange, label }) {
      const [open, setOpen] = useState(false)
      const active = options.find(([v]) => String(v) === String(value))
      return h(NativeMenu, {
        open,
        onClose: () => setOpen(false),
        items: options.map(([v, text]) => ({ id: String(v), label: text })),
        selectedId: String(value),
        onSelect: (id) => {
          setOpen(false)
          onChange(id)
        },
        align: 'end',
        portal: true,
        anchor: h(
          'button',
          { type: 'button', className: 'dshdev-selector', 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-label': label, onClick: () => setOpen((v) => !v) },
          h('span', { className: 'dshdev-selector-label' }, active ? active[1] : String(value)),
          Icon('IconChevronDownOutlineRegular', { className: 'dshdev-selector-chevron' }),
        ),
      })
    }
    function SettingsSwitch({ checked, onChange, label }) {
      return h(NativeSwitch, { checked, onChange, label })
    }

    function DevicesSettings({ t, close }) {
      ensureStyles()
      const st = useStore()
      useEffect(() => {
        loadEditors()
      }, [])
      const cfg = st.settings
      const devices = st.data.devices || []
      return h(
        'div',
        { className: 'dshdev-section', 'data-testid': 'dsh-devices-settings' },
        h(
          SettingsRow,
          {
            title: t('setNotify'),
            description: t('setNotifyHint'),
            extra:
              cfg.notify !== 'never'
                ? h('button', { type: 'button', className: 'dshdev-inline-link', onClick: () => sendNotification({ key: `test-${Date.now()}`, title: t('settingsTitle'), body: t('notifyTestBody') }) }, t('notifyTest'))
                : null,
          },
          h(SettingsSelect, {
            label: t('setNotify'),
            value: cfg.notify,
            onChange: async (v) => {
              setSetting('notify', v)
              if (v !== 'never' && typeof Notification !== 'undefined' && Notification.permission === 'default' && !window.__TAURI_INTERNALS__) {
                try {
                  await Notification.requestPermission()
                } catch {}
              }
            },
            options: [['background', t('notifyBackground')], ['always', t('notifyAlways')], ['never', t('notifyNever')]],
          }),
        ),
        h(SettingsRow, { title: t('setNotifyAttention'), description: t('setNotifyAttentionHint') }, h(SettingsSwitch, { label: t('setNotifyAttention'), checked: cfg.notifyAttention !== false, onChange: (v) => setSetting('notifyAttention', v) })),
        h(SettingsRow, { title: t('setSidebar'), description: t('setSidebarHint') }, h(SettingsSwitch, { label: t('setSidebar'), checked: cfg.showInSidebar, onChange: (v) => setSetting('showInSidebar', v) })),
        h(
          SettingsRow,
          { title: t('setPerGroup'), description: t('setPerGroupHint') },
          h(SettingsSelect, { label: t('setPerGroup'), value: cfg.sessionsPerGroup, onChange: (v) => setSetting('sessionsPerGroup', Number(v)), options: [[3, '3'], [5, '5'], [10, '10'], [20, '20'], [0, t('allSessions')]] }),
        ),
        h(SettingsRow, { title: t('setPreload'), description: t('setPreloadHint') }, h(SettingsSwitch, { label: t('setPreload'), checked: cfg.preload, onChange: (v) => setSetting('preload', v) })),
        h(
          SettingsRow,
          { title: t('setUnload'), description: t('setUnloadHint') },
          h(SettingsSelect, {
            label: t('setUnload'),
            value: cfg.unloadAfter ?? 10,
            onChange: (v) => setSetting('unloadAfter', Number(v)),
            options: [[5, fill(t('unloadMinutes'), { n: 5 })], [10, fill(t('unloadMinutes'), { n: 10 })], [30, fill(t('unloadMinutes'), { n: 30 })], [0, t('unloadNever')]],
          }),
        ),
        h(
          SettingsRow,
          { title: t('setAutoUpdate'), description: t('setAutoUpdateHint'), testid: 'dsh-devices-auto-update' },
          h(SettingsSelect, {
            label: t('setAutoUpdate'),
            value: (st.data.prefs && st.data.prefs.autoUpdate) || 'auto',
            onChange: async (v) => {
              try {
                await post('/devices/prefs', { autoUpdate: v })
                await refreshDevices()
              } catch (e) {
                showToast(e.message, { icon: Icon('IconWarningOutlineRegular') })
              }
            },
            options: [['auto', t('autoUpdateAuto')], ['ask', t('autoUpdateAsk')], ['never', t('autoUpdateNever')]],
          }),
        ),
        h(SettingsRow, { title: t('setHealthAlerts'), description: t('setHealthAlertsHint') }, h(SettingsSwitch, { label: t('setHealthAlerts'), checked: cfg.healthAlerts !== false, onChange: (v) => setSetting('healthAlerts', v) })),
        h(
          SettingsRow,
          { title: t('setEditor'), description: t('setEditorHint') },
          h(SettingsSelect, {
            label: t('setEditor'),
            value: cfg.editor || currentEditor().id,
            onChange: (v) => {
              setSetting('editor', v)
              frames.broadcastConfig()
            },
            options: (st.editors.length ? st.editors : [{ id: 'vscode', label: 'VS Code', installed: true }]).map((e) => [e.id, e.installed ? e.label : `${e.label} (${t('notInstalled')})`]),
          }),
        ),
        h(
          SettingsRow,
          { title: t('setDefault'), description: t('setDefaultHint') },
          h(SettingsSelect, { label: t('setDefault'), value: cfg.defaultDevice, onChange: (v) => setSetting('defaultDevice', v), options: [['local', t('thisMac')], ...devices.map((d) => [d.id, d.name])] }),
        ),
        h(
          SettingsRow,
          { title: t('manageDevices'), description: t('subtitle') },
          h(
            ModalButton,
            {
              variant: 'outline',
              onClick: () => {
                if (close) close()
                try {
                  appCtx.layout.selectPanel(PANEL_ID)
                } catch {}
              },
            },
            t('open'),
          ),
        ),
      )
    }

    function EditorHostDialog({ t }) {
      const st = useStore()
      const ask = st.askEditorHost
      const device = ask && (st.data.devices || []).find((d) => d.id === ask.deviceId)
      const [value, setValue] = useState('')
      const [error, setError] = useState(null)
      useEffect(() => {
        setValue(device ? device.editorHost || '' : '')
        setError(null)
      }, [ask && ask.deviceId])
      if (!ask || !device) return null
      const close = () => setStore({ askEditorHost: null })
      const save = async () => {
        try {
          await post('/devices/editor-host', { id: device.id, host: value })
          await refreshDevices()
          close()
          if (ask.path || ask.sessionId) openInEditor(device.id, { path: ask.path, sessionId: ask.sessionId })
        } catch (e) {
          setError(e.message)
        }
      }
      return h(NativeModal, {
        t,
        title: t('editorHost'),
        description: device.transport.kind === 'url' ? fill(t('editorHostNeeded'), { device: device.name }) : t('editorHostHint'),
        onClose: close,
        footer: h(React.Fragment, null, h(ModalButton, { variant: 'outline', onClick: close }, nt('cancel', null, t('cancel'))), h(ModalButton, { variant: 'primary', disabled: !value.trim(), onClick: save }, t('save'))),
        children: h(
          React.Fragment,
          null,
          h(NativeField, { value, onChange: setValue, onEnter: save, label: t('editorHost'), placeholder: 'vps-julio  /  root@203.0.113.10', autoFocus: true }),
          h('p', { className: 'dshdev-hint-text' }, t('editorHostHint')),
          error ? h('p', { className: 'dshdev-error-text', role: 'alert' }, error) : null,
        ),
      })
    }

    // ── Devices page, laid out like DSH's Plugins page ──────────────────────
    function TextInput({ value, onChange, placeholder, autoFocus, type, ariaLabel, onEnter }) {
      return h(NativeField, { value, onChange, placeholder, autoFocus, type, label: ariaLabel || placeholder, onEnter })
    }

    function Field({ label, hint, children }) {
      return h('div', { className: 'dshdev-field' }, h('label', { className: 'dshdev-field-label' }, label), children, hint ? h('div', { className: 'dshdev-hint-text' }, hint) : null)
    }

    function Btn(props) {
      const { children, ...rest } = props
      return P.Button ? h(P.Button, { size: 'sm', variant: 'outline', ...rest }, children) : h('button', rest, children)
    }

    const STATUS_TAG_TONE = { online: 'success', connecting: 'neutral', offline: 'quiet', error: 'danger', revoked: 'danger' }

    function deviceCardMenu(device, t) {
      const online = device.status === 'online'
      const archived = (device.archived || []).length
      return [
        { id: 'refresh', icon: Icon('IconRefreshOutlineRegular'), label: t('refresh') },
        { id: 'window', icon: Icon('IconRightUpOutlineRegular'), label: t('openWindow'), disabled: !online },
        { type: 'separator', id: 's1' },
        { id: 'plugins', icon: Icon('IconCordisPluginOutlineRegular'), label: t('pluginsMenu'), disabled: !online },
        { id: 'automations', icon: Icon('IconAlarmClockOutlineRegular'), label: t('automationsMenu'), disabled: !online },
        { id: 'ports', icon: Icon('IconGlobeOutlineRegular'), label: t('portsMenu'), disabled: !online },
        { id: 'sync', icon: Icon('IconRefreshOutlineRegular'), label: t('syncMenu'), disabled: !online },
        { id: 'account', icon: Icon('IconUserOutlineRegular'), label: t('accountMenu'), disabled: !online },
        ...(archived ? [{ id: 'archived', icon: Icon('IconArchiveOutlineRegular'), label: fill(t('archivedMenu'), { n: archived }) }] : []),
        { type: 'separator', id: 's2' },
        { id: 'settings', icon: Icon('IconSettingsOutlineRegular'), label: t('deviceSettings'), disabled: !online },
        { id: 'editorHost', icon: Icon('IconCodeOutlineRegular'), label: t('editorHostMenu') },
        { id: 'rename', icon: Icon('IconEditOutlineRegular'), label: t('rename') },
        ...(device.transport.kind === 'ssh' ? [{ id: 'update', icon: Icon('IconDownloadOutlineRegular'), label: t('update') }] : []),
        { id: 'remove', icon: Icon('IconTrashOutlineRegular'), label: t('remove'), danger: true },
      ]
    }

    function DeviceCard({ device, t, onOpen, onAction }) {
      const [menuOpen, setMenuOpen] = useState(false)
      const online = device.status === 'online'
      const via = device.transport.kind === 'ssh' ? fill(t('viaSsh'), { target: device.transport.target }) : fill(t('viaUrl'), { url: device.transport.url })
      const when = online
        ? device.uptimeSec != null
          ? fill(t('up'), { when: duration(device.uptimeSec) })
          : null
        : fill(t('lastSeen'), { when: device.lastSeenAt ? timeLabel(device.lastSeenAt) : t('never') })
      const noModels = online && device.model && !(device.model.ready ?? device.model.configured)
      const issues = online ? healthIssues(device.health) : []
      const ISSUE_TAG = { disk: 'tagDisk', memory: 'tagMemory', cpu: 'tagCpu' }
      const failedUpdate = !device.updating && device.lastUpdate && device.lastUpdate.state === 'failed'
      const tags = h(
        React.Fragment,
        null,
        h(NativeTag, { tone: STATUS_TAG_TONE[device.status] || 'neutral' }, t(`status_${device.status}`)),
        device.updating ? h(NativeTag, { tone: 'info' }, t('updatingTag')) : null,
        failedUpdate ? h('span', { title: device.lastUpdate.error || '' }, h(NativeTag, { tone: 'danger' }, t('updateFailedTag'))) : null,
        device.pendingCount ? h(NativeTag, { tone: 'warning' }, fill(t('waitingCount'), { n: device.pendingCount })) : null,
        ...issues.map((i) => h(NativeTag, { key: i.key, tone: i.level === 'critical' ? 'danger' : 'warning' }, t(ISSUE_TAG[i.key]))),
        noModels ? h(NativeTag, { tone: 'warning' }, t('noModels')) : null,
        device.outdated && !device.updating ? h(NativeTag, { tone: 'info' }, t('outdated')) : null,
      )
      const healthLine = online ? healthSummary(device.health, t) : null
      const description = h(
        React.Fragment,
        null,
        healthLine ? h('span', { className: 'dshdev-card2-health', 'data-testid': `health-${device.id}` }, healthLine, ' · ') : null,
        [via, device.versions ? `dsh ${device.versions.dsh || '?'}` : null, when].filter(Boolean).join(' · '),
        device.error && !online ? h('span', { className: 'dshdev-card2-error' }, ` — ${device.error}`) : null,
      )
      const end = h(
        React.Fragment,
        null,
        noModels ? h(Btn, { variant: 'outline', onClick: () => onAction('account', device) }, t('setUpModels')) : null,
        device.outdated && device.canUpdate ? h(Btn, { variant: 'outline', disabled: !!device.updating, onClick: () => onAction('update', device) }, device.updating ? t('updatingTag') : t('updateNow')) : null,
        device.outdated && !device.canUpdate ? h(Btn, { variant: 'outline', 'data-testid': `update-ssh-${device.id}`, onClick: () => onAction('update-ssh', device) }, t('updateViaSsh')) : null,
        h(Btn, { variant: 'primary', disabled: !online, onClick: () => onOpen(device) }, t('open')),
        true
          ? h(NativeMenu, {
              open: menuOpen,
              onClose: () => setMenuOpen(false),
              items: deviceCardMenu(device, t),
              onSelect: (id) => {
                setMenuOpen(false)
                onAction(id, device)
              },
              align: 'end',
              portal: true,
              anchor: h('button', { type: 'button', className: 'dshdev-icon-button', 'aria-label': `${t('more')} — ${device.name}`, 'aria-haspopup': 'menu', onClick: () => setMenuOpen((v) => !v) }, Icon('IconEllipsisOutlineRegular')),
            })
          : null,
      )
      return h(
        'div',
        { 'data-testid': `device-${device.id}` },
        h(Card, {
          icon: h('span', { className: cx('dshdev-device-glyph', online && 'online') }, h(RemoteIcon, { size: 22 })),
          title: device.name,
          tags,
          description,
          end,
          onOpen: online ? () => onOpen(device) : undefined,
        }),
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
        // A saved machine connects right away; a guessed address waits for the user to check it.
        if (preset && preset.target && preset.autoStart !== false) startSsh()
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
      const submit = () => canSubmit && (tab === 'ssh' ? startSsh() : pairCode())
      const option = ({ key, selected, onClick, icon, title, meta, tag }) =>
        h(
          'button',
          { key, type: 'button', role: 'option', 'aria-selected': selected, className: cx('dshdev-option', selected && 'on'), disabled: busy, onClick },
          h('span', { className: 'dshdev-option-icon' }, icon),
          h('span', { className: 'dshdev-option-text' }, h('span', { className: 'dshdev-option-title' }, title), meta ? h('span', { className: 'dshdev-option-meta' }, meta) : null),
          tag || null,
        )

      const body = h(
        'div',
        { className: 'dshdev-form' },
        h(Segmented, { label: t('addTitle'), value: tab, disabled: busy, onChange: setTab, options: [{ value: 'ssh', label: t('tabSsh') }, { value: 'code', label: t('tabCode') }] }),
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
                      { className: 'dshdev-options', role: 'listbox', 'aria-label': t('suggestions') },
                      saved.map((m) =>
                        option({
                          key: `saved:${m.id}`,
                          selected: savedId === m.id,
                          onClick: () => {
                            setSavedId(m.id)
                            setTarget(m.target)
                            setName(m.name)
                          },
                          icon: h(RemoteIcon, { size: 16 }),
                          title: m.name,
                          meta: m.target,
                          tag: m.pairedDeviceId ? h(NativeTag, { tone: 'quiet' }, t('alreadyAdded')) : m.fingerprint ? h(NativeTag, { tone: 'success' }, t('trusted')) : null,
                        }),
                      ),
                      hosts.map((x) =>
                        option({
                          key: `alias:${x.alias}`,
                          selected: !savedId && target === x.alias,
                          onClick: () => {
                            setSavedId(null)
                            setTarget(x.alias)
                            if (!name) setName(x.alias)
                          },
                          icon: Icon('IconBrowseOutlineRegular', { size: 16 }) || h(RemoteIcon, { size: 16 }),
                          title: x.alias,
                          meta: x.host ? `${x.user ? `${x.user}@` : ''}${x.host}${x.port && x.port !== 22 ? `:${x.port}` : ''}` : '',
                          tag: h(NativeTag, { tone: 'quiet' }, t('fromSshConfig')),
                        }),
                      ),
                    ),
                  )
                : null,
              h(
                Field,
                { label: saved.length || hosts.length ? `${t('orType')} — ${t('sshTarget')}` : t('sshTarget'), hint: t('sshTargetHint') },
                h(TextInput, { value: savedId ? '' : target, onChange: (v) => (setTarget(v), setSavedId(null)), onEnter: submit, placeholder: 'root@203.0.113.10', autoFocus: !preset && !saved.length && !hosts.length }),
              ),
              h(
                'button',
                { type: 'button', className: 'dshdev-disclosure', 'aria-expanded': advanced, onClick: () => setAdvanced(!advanced) },
                Icon('IconChevronRightOutlineRegular', { className: cx('dshdev-disclosure-chevron', advanced && 'open') }),
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
              h(Field, { label: t('codeInput'), hint: t('codeHint') }, h(TextInput, { value: code, onChange: setCode, onEnter: submit, placeholder: 'dsh-device://pair?…  /  K7QF-2M9X', autoFocus: true })),
              linkMode ? null : h(Field, { label: t('codeUrl'), hint: t('codeUrlHint') }, h(TextInput, { value: url, onChange: setUrl, onEnter: submit, placeholder: 'https://vps.example.ts.net' })),
            ),
        h(Field, { label: t('deviceName') }, h(TextInput, { value: name, onChange: setName, onEnter: submit, placeholder: 'VPS' })),
        job ? h(JobView, { job, t }) : null,
        hostPrompt
          ? h(
              'div',
              { className: 'dshdev-callout' },
              h('span', { className: 'dshdev-callout-dot' }),
              h(
                'div',
                { className: 'dshdev-callout-main' },
                h('div', { className: 'dshdev-callout-text', style: { fontWeight: 500 } }, t('hostKeyTitle')),
                h('div', { className: 'dshdev-hint-text' }, t('hostKeyBody')),
                h('div', { className: 'dshdev-fp', 'data-testid': 'hostkey-fingerprint' }, hostPrompt.fingerprint),
              ),
            )
          : null,
        error ? h('p', { className: 'dshdev-error-text', role: 'alert' }, error) : null,
        success ? h('p', { className: 'dshdev-success-text', role: 'status' }, success) : null,
      )

      const footer = h(
        React.Fragment,
        null,
        h(ModalButton, { variant: 'outline', onClick: onClose }, finished ? t('done') : nt('cancel', null, t('cancel'))),
        hostPrompt
          ? h(ModalButton, { variant: 'primary', onClick: () => startSsh(hostPrompt.fingerprint) }, t('trust'))
          : finished
            ? null
            : h(ModalButton, { variant: 'primary', disabled: !canSubmit, onClick: submit }, busy ? t('working') : tab === 'ssh' ? t('connect') : t('pair')),
      )
      return h(NativeModal, { t, title: t('addTitle'), description: t('addDescription'), onClose, footer, wide: true, children: body })
    }

    function SimpleDialog({ title, description, children, footer, onClose, t, wide }) {
      return h(NativeModal, { t, title, description, onClose, footer, wide, children })
    }

    async function openInWindow(device, { panel } = {}) {
      const root = await deviceRoot(device.id)
      const params = new URLSearchParams({ 'dsh-device': device.name })
      if (panel && device.panels === 'ack') params.set('dsh-panel', panel)
      const url = `${root}?${params.toString()}`
      const tauri = window.__TAURI_INTERNALS__
      if (tauri && typeof tauri.invoke === 'function') {
        try {
          await tauri.invoke('remote_open_window', { machineId: device.id, url })
          return
        } catch {}
      }
      window.open(url, '_blank', 'noopener')
    }

    function SkeletonCards() {
      return h(
        'ul',
        { className: 'dshdev-cards', 'aria-hidden': true },
        [0, 1, 2].map((i) =>
          h(
            'li',
            { key: i, className: 'dshdev-card2' },
            h(
              'div',
              { className: 'dshdev-card2-head' },
              h('span', { className: 'dshdev-card2-icon dshdev-skeleton' }),
              h('div', { className: 'dshdev-card2-main' }, h('span', { className: 'dshdev-skeleton dshdev-skeleton-title' }), h('span', { className: 'dshdev-skeleton dshdev-skeleton-desc' })),
            ),
          ),
        ),
      )
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

      const onOpen = (device, session) => {
        const latest = session || (device.sessions || [])[0]
        if (latest) openRemote(ctx, device, latest.sessionId)
        else newRemote(ctx, device, null)
      }
      useEffect(() => {
        if (st.openAdd) {
          const preset = typeof st.openAdd === 'object' ? st.openAdd.preset : undefined
          setStore({ openAdd: false })
          setAdding(preset ? { preset } : {})
        }
      }, [st.openAdd])

      async function onAction(kind, device) {
        setNotice(null)
        try {
          if (kind === 'refresh') await post('/devices/refresh', { id: device.id })
          if (kind === 'window') await openInWindow(device)
          if (kind === 'settings') openDeviceSettings(device)
          if (kind === 'editorHost') setStore({ askEditorHost: { deviceId: device.id } })
          if (kind === 'plugins') openDevicePanel(device, 'plugins')
          if (kind === 'automations') openDevicePanel(device, 'schedules')
          if (kind === 'ports' || kind === 'sync' || kind === 'account' || kind === 'archived') setStore({ dialog: { kind, deviceId: device.id } })
          if (kind === 'rename') {
            setRenameValue(device.name)
            setRenaming(device)
          }
          if (kind === 'remove') setRemoving(device)
          if (kind === 'update') setUpdateJob(await post('/devices/update', { id: device.id }))
          if (kind === 'update-ssh') setAdding({ preset: sshPresetFor(device) })
          refreshDevices()
        } catch (e) {
          setNotice(e.message)
        }
      }

      const saveRename = async () => {
        const name = renameValue.trim()
        if (!name || !renaming || saveRename.busy) return
        saveRename.busy = true
        try {
          await post('/devices/rename', { id: renaming.id, name })
          setRenaming(null)
          refreshDevices()
        } catch (e) {
          setNotice(e.message)
        } finally {
          saveRename.busy = false
        }
      }
      const devices = st.data.devices || []
      const saved = (st.data.saved || []).filter((m) => !m.pairedDeviceId)
      return h(
        'div',
        { className: 'dshdev-page2', 'data-testid': 'dsh-devices-page' },
        h(
          'div',
          { className: 'dshdev-page2-head' },
          h('div', { className: 'dshdev-page2-heading' }, h('h1', { className: 'dshdev-page2-title' }, t('title')), h('p', { className: 'dshdev-page2-intro' }, t('subtitle'))),
          h(
            'div',
            { className: 'dshdev-page2-toolbar' },
            h(IconButton, { label: t('refresh'), onClick: () => post('/devices/refresh', {}).then(refreshDevices) }, Icon('IconRefreshOutlineRegular')),
            P.Button ? h(P.Button, { variant: 'primary', icon: Icon('IconPlusOutlineRegular'), onClick: () => setAdding({}), className: 'dshdev-page2-add' }, t('add')) : h(ModalButton, { variant: 'primary', onClick: () => setAdding({}) }, t('add')),
          ),
        ),
        notice || st.error ? h('p', { className: 'dshdev-error-text', role: 'alert' }, notice || st.error) : null,
        updateJob ? h(JobView, { job: updateJob, t }) : null,
        h(
          'section',
          { className: 'dshdev-group2' },
          h('div', { className: 'dshdev-group2-head' }, h('h2', { className: 'dshdev-group2-title' }, t('yourDevices'))),
          !st.loaded ? h(SkeletonCards) : devices.length ? h('ul', { className: 'dshdev-cards' }, devices.map((d) => h(DeviceCard, { key: d.id, device: d, t, onOpen, onAction }))) : h('p', { className: 'dshdev-empty-text' }, t('empty')),
        ),
        saved.length
          ? h(
              'section',
              { className: 'dshdev-group2', 'data-testid': 'dsh-devices-saved' },
              h('div', { className: 'dshdev-group2-head' }, h('h2', { className: 'dshdev-group2-title' }, t('savedServers'))),
              h(
                'ul',
                { className: 'dshdev-cards' },
                saved.map((m) =>
                  h(Card, {
                    key: m.id,
                    icon: h('span', { className: 'dshdev-device-glyph' }, h(RemoteIcon, { size: 22 })),
                    title: m.name,
                    tags: m.fingerprint ? h(NativeTag, { tone: 'success' }, t('hostKeyKnown')) : null,
                    description: `SSH · ${m.target}`,
                    end: h(Btn, { variant: 'primary', onClick: () => setAdding({ preset: m }) }, t('addSaved')),
                  }),
                ),
              ),
            )
          : null,
        adding ? h(AddDialog, { t, preset: adding.preset, onClose: () => setAdding(false), onDone: refreshDevices }) : null,
        h(EditorHostDialog, { t }),
        renaming
          ? h(NativeModal, {
              t,
              title: t('rename'),
              onClose: () => setRenaming(null),
              footer: h(
                React.Fragment,
                null,
                h(ModalButton, { variant: 'outline', onClick: () => setRenaming(null) }, nt('cancel', null, t('cancel'))),
                h(ModalButton, { variant: 'primary', disabled: !renameValue.trim(), onClick: saveRename }, t('save')),
              ),
              children: h(NativeField, { value: renameValue, onChange: setRenameValue, label: t('renamePrompt'), autoFocus: true, onEnter: saveRename }),
            })
          : null,
        removing
          ? h(NativeModal, {
              t,
              title: fill(t('removeTitle'), { name: removing.name }),
              description: t('removeBody'),
              onClose: () => setRemoving(null),
              footer: h(
                React.Fragment,
                null,
                h(ModalButton, { variant: 'outline', onClick: () => setRemoving(null) }, nt('cancel', null, t('cancel'))),
                h(
                  ModalButton,
                  {
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
                  },
                  t('remove'),
                ),
              ),
            })
          : null,
      )
    }

    // ── device & session actions: dialogs, like DSH's own ───────────────────
    function deviceById(id) {
      return (store.data.devices || []).find((d) => d.id === id) || null
    }
    function hasFeature(device, feature) {
      return !!device && Array.isArray(device.features) && device.features.includes(feature)
    }
    function friendlyError(e, device) {
      if (e && e.code === 'HOST_OUTDATED') return fill(appT('hostOutdatedFeature'), { device: device ? device.name : '' })
      return (e && e.message) || String(e)
    }

    /** Show one of the device's own panels (Plugins, Automations…) inline, with its loading state. */
    function openDevicePanel(device, panel) {
      setStore({ selection: { deviceId: device.id, sessionId: null, panel } })
      try {
        appCtx.layout.selectPanel(CHAT_PANEL_ID)
      } catch {}
      frames.openPanel(device, panel)
    }
    /**
     * A device paired with a code and too old to update itself: adding it again over SSH
     * installs the current host (same machine, same chats) and lets later updates happen from here.
     */
    function sshPresetFor(device) {
      let host = ''
      try {
        const u = new URL(device.transport && device.transport.url)
        if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) host = u.hostname
      } catch {}
      return { target: host ? `root@${host}` : '', name: device.name, autoStart: false }
    }
    function updateOverSsh(device) {
      setStore({ openAdd: { preset: sshPresetFor(device) } })
      try {
        appCtx.layout.selectPanel(PANEL_ID)
      } catch {}
    }
    function panelLabel(panel) {
      return panel === 'plugins' ? appT('pluginsMenu') : panel === 'schedules' ? appT('automationsMenu') : panel
    }

    async function sessionAction(device, sessionId, action, extra = {}) {
      try {
        await post('/devices/session-action', { id: device.id, sessionId, action, ...extra })
        await refreshDevices()
        if (action === 'archive') {
          // DSH's own "Archived · Undo" toast.
          showToast(nt('toast.archived', null, appT('archived')), {
            icon: Icon('IconArchiveOutlineRegular'),
            actions: [{ label: nt('toast.archivedUndo', null, appT('undo')), onClick: () => (setStore({ toast: null }), sessionAction(device, sessionId, 'unarchive')) }],
            holdMs: 5000,
          })
        }
        return true
      } catch (e) {
        if (action === 'archive' && /session-active/.test(e.message)) setStore({ dialog: { kind: 'confirm-archive', deviceId: device.id, sessionId } })
        else showToast(friendlyError(e, device), { icon: Icon('IconWarningOutlineRegular') })
        return false
      }
    }

    /** DSH's modal with its own footer buttons. */
    function NativeModal({ t, title, description, onClose, footer, children, wide, testid }) {
      if (!P.Modal) return h('div', { role: 'dialog', 'data-testid': testid }, h('h2', null, title), description ? h('p', null, description) : null, children, footer)
      return h(P.Modal, { open: true, onClose, title, description, closeLabel: nt('close', null, t('close')), footer, className: `dshdev-modal ${wide ? 'dshdev-modal-lg' : 'dshdev-modal-sm'}` }, h('div', { className: 'dshdev-modal-body', 'data-testid': testid }, children))
    }
    function ModalButton({ variant = 'outline', disabled, onClick, children, testid }) {
      return P.Button ? h(P.Button, { variant, disabled, onClick, 'data-testid': testid }, children) : h('button', { type: 'button', disabled, onClick, 'data-testid': testid }, children)
    }
    /** A text field styled like DSH's rename field. */
    function NativeField({ value, onChange, onEnter, label, placeholder, type, autoFocus, disabled }) {
      const composing = useRef(false)
      const prefix = (discoverPrefixes().list || '')
      return h('input', {
        className: cx('dshdev-field-input', prefix && `${prefix}renameInput`),
        value,
        type: type || 'text',
        placeholder,
        disabled,
        'aria-label': label,
        'data-modal-autofocus': autoFocus ? true : undefined,
        autoFocus,
        spellCheck: false,
        autoCapitalize: 'off',
        autoComplete: 'off',
        onFocus: autoFocus ? (e) => e.target.select() : undefined,
        onChange: (e) => onChange(e.target.value),
        onCompositionStart: () => (composing.current = true),
        onCompositionEnd: () => (composing.current = false),
        onKeyDown: (e) => {
          if (e.key === 'Enter' && !composing.current && onEnter) {
            e.preventDefault()
            onEnter()
          }
        },
      })
    }

    function RenameDialog({ t, dialog, onClose }) {
      const device = deviceById(dialog.deviceId)
      const [value, setValue] = useState(dialog.title || '')
      const [busy, setBusy] = useState(false)
      if (!device) return null
      const trimmed = value.trim()
      const save = async () => {
        if (!trimmed || busy) return
        setBusy(true)
        const ok = await sessionAction(device, dialog.sessionId, 'rename', { title: trimmed })
        setBusy(false)
        if (ok) onClose()
      }
      return h(NativeModal, {
        t,
        title: nt('rename.session.title', null, t('renameTitle')),
        onClose: () => !busy && onClose(),
        footer: h(React.Fragment, null, h(ModalButton, { variant: 'outline', disabled: busy, onClick: onClose }, nt('cancel', null, t('cancel'))), h(ModalButton, { variant: 'primary', disabled: busy || !trimmed, onClick: save }, nt('rename', null, t('rename')))),
        children: h(NativeField, { value, onChange: setValue, onEnter: save, label: t('sessionName'), autoFocus: true, disabled: busy }),
      })
    }

    function ConfirmArchiveDialog({ t, dialog, onClose }) {
      const device = deviceById(dialog.deviceId)
      if (!device) return null
      return h(NativeModal, {
        t,
        title: nt('menu.archiveSession', null, t('archive')),
        description: fill(t('archiveRunning'), { device: device.name }),
        onClose,
        footer: h(
          React.Fragment,
          null,
          h(ModalButton, { variant: 'outline', onClick: onClose }, nt('cancel', null, t('cancel'))),
          h(ModalButton, { variant: 'primary', onClick: () => (onClose(), sessionAction(device, dialog.sessionId, 'archive', { force: true })) }, t('stopAndArchive')),
        ),
      })
    }

    /** Friendly words for the device's folder/workspace errors. */
    function folderError(e, t) {
      const code = (e && e.code) || ''
      const known = { 'folder-not-found': 'errFolderNotFound', 'folder-unreadable': 'errFolderUnreadable', 'not-a-folder': 'errFolderUnreadable', 'invalid-folder-name': 'errFolderName', 'folder-exists': 'errFolderExists', 'name-conflict': 'errNameConflict', 'workspace-not-found': 'errWorkspaceGone' }
      if (code === 'HOST_OUTDATED') return friendlyError(e)
      return known[code] ? t(known[code]) : (e && e.message) || String(e)
    }

    /**
     * Folders of a device, to add as workspaces (one group per project folder in the
     * sidebar). "Split" opens on a folder with its project folders already ticked.
     */
    function FoldersDialog({ t, dialog, onClose }) {
      const st = useStore()
      const device = (st.data.devices || []).find((d) => d.id === dialog.deviceId)
      const [listing, setListing] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [picked, setPicked] = useState(() => new Set())
      const [newName, setNewName] = useState('')
      const [busy, setBusy] = useState(false)
      const [splitAt, setSplitAt] = useState(dialog.split ? dialog.path : null)
      const [typed, setTyped] = useState(null)
      const load = async (where, { preselect } = {}) => {
        setLoading(true)
        setError(null)
        try {
          const q = new URLSearchParams({ id: dialog.deviceId })
          if (where) q.set('path', where)
          const r = await api(`/devices/folders?${q}`)
          setListing(r)
          setTyped(null)
          const next = new Set()
          if (preselect === 'projects') for (const f of r.folders || []) if (!f.workspaceId && f.project && f.project.length) next.add(f.path)
          if (typeof preselect === 'string' && preselect.startsWith('/')) next.add(preselect)
          setPicked(next)
        } catch (e) {
          setError(folderError(e, t))
        } finally {
          setLoading(false)
        }
      }
      useEffect(() => {
        load(dialog.path || undefined, { preselect: dialog.split ? 'projects' : undefined })
      }, [])
      if (!device) return null
      const home = listing && listing.home
      const shortPath = (p) => (p && home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p || '')
      const current = listing ? listing.path : dialog.path || ''
      const currentName = current.split('/').filter(Boolean).pop() || current
      const toggle = (p) => {
        const next = new Set(picked)
        if (next.has(p)) next.delete(p)
        else next.add(p)
        setPicked(next)
      }
      const add = async (paths) => {
        if (!paths.length || busy) return
        setBusy(true)
        setError(null)
        try {
          const r = await post('/devices/workspace-action', { id: device.id, action: 'create', paths })
          const ok = (r.results || []).filter((x) => x.workspace)
          const failed = (r.results || []).filter((x) => x.error)
          await refreshDevices()
          // Show the device (and its new groups) right away.
          const collapsed = { ...store.collapsed }
          delete collapsed[`device:${device.id}`]
          for (const x of ok) delete collapsed[`${device.id}:${x.workspace.id}`]
          setStore({ collapsed })
          if (failed.length && !ok.length) {
            setError(failed.map((x) => `${shortPath(x.path)}: ${x.error}`).join(' · '))
            return
          }
          const only = ok.length === 1 ? ok[0].workspace : null
          showToast(only ? fill(t('folderAdded'), { name: workspaceTitle(only.title, only.path), device: device.name }) : fill(t('foldersAdded'), { n: ok.length, device: device.name }), {
            icon: Icon('IconProjectAddOutlineRegular'),
            actions: only ? [{ label: t('newSessionRow'), onClick: () => (setStore({ toast: null }), newRemote(appCtx, device, only.id)) }] : undefined,
            holdMs: 5000,
          })
          onClose()
        } catch (e) {
          setError(folderError(e, t))
        } finally {
          setBusy(false)
        }
      }
      const create = async () => {
        const name = newName.trim()
        if (!name || busy || !listing) return
        setBusy(true)
        setError(null)
        try {
          const r = await post('/devices/folders', { id: device.id, path: listing.path, name })
          setNewName('')
          await load(listing.path, { preselect: r.path })
        } catch (e) {
          setError(folderError(e, t))
        } finally {
          setBusy(false)
        }
      }
      const folders = (listing && listing.folders) || []
      const projects = folders.filter((f) => !f.workspaceId && f.project && f.project.length)
      const cls = rowClasses()
      const pickedList = [...picked]
      const split = splitAt && listing && listing.path === splitAt
      return h(NativeModal, {
        t,
        wide: true,
        testid: 'dsh-devices-folders',
        title: split ? fill(t('splitTitle'), { folder: currentName }) : fill(t('foldersTitle'), { device: device.name }),
        description: split ? fill(t('splitHint'), { folder: currentName }) : t('foldersHint'),
        onClose: () => !busy && onClose(),
        footer: h(
          React.Fragment,
          null,
          h(ModalButton, { variant: 'outline', disabled: busy, onClick: onClose }, nt('cancel', null, t('cancel'))),
          listing && !listing.workspaceId && !pickedList.length
            ? h(ModalButton, { variant: 'primary', testid: 'dsh-devices-folders-add-current', disabled: busy || loading, onClick: () => add([listing.path]) }, fill(t('addThisFolder'), { name: currentName }))
            : h(ModalButton, { variant: 'primary', testid: 'dsh-devices-folders-add', disabled: busy || loading || !pickedList.length, onClick: () => add(pickedList) }, pickedList.length === 1 ? fill(t('addThisFolder'), { name: pickedList[0].split('/').pop() }) : fill(t('addFolders'), { n: pickedList.length })),
        ),
        children: h(
          'div',
          { className: 'dshdev-folders' },
          h(
            'div',
            { className: 'dshdev-folders-bar' },
            h(TipButton, { cls, className: 'dshdev-folders-up', label: t('folderUp'), action: 'folder-up', disabled: !listing || !listing.parent || busy, onClick: () => listing && listing.parent && load(listing.parent) }, Icon('IconArrowUpOutlineRegular', { size: 14 }, () => '↑')),
            // The path is a field too: type or paste one (~ is the home folder) and press Enter.
            h('input', {
              className: cx('dshdev-folders-path', (discoverPrefixes().list || '') && `${discoverPrefixes().list}renameInput`),
              title: current,
              'aria-label': t('folderPath'),
              'data-testid': 'dsh-devices-folders-path',
              value: typed !== null ? typed : shortPath(current),
              disabled: busy,
              spellCheck: false,
              onChange: (e) => setTyped(e.target.value),
              onBlur: () => setTyped(null),
              onKeyDown: (e) => {
                if (e.key === 'Escape' && typed !== null) {
                  e.stopPropagation()
                  setTyped(null)
                }
                if (e.key !== 'Enter' || typed === null) return
                e.preventDefault()
                const v = typed.trim()
                const full = v === '~' ? home : v.startsWith('~/') && home ? `${home}${v.slice(1)}` : v
                if (full && full.startsWith('/')) load(full)
              },
            }),
            listing && listing.workspaceId ? h(NativeTag, { tone: 'neutral' }, t('alreadyAdded')) : null,
            h(TipButton, { cls, className: 'dshdev-folders-up', label: t('folderHome'), action: 'folder-home', disabled: busy, onClick: () => load(undefined) }, Icon('IconHomeOutlineRegular', { size: 14 }, () => '~')),
          ),
          error ? h('div', { className: 'dshdev-folders-error', role: 'alert' }, error) : null,
          h(
            'div',
            { className: 'dshdev-folders-list', role: 'tree', 'aria-busy': loading },
            loading && !listing
              ? h('div', { className: 'dshdev-folders-empty' }, P.TextShimmer ? h(P.TextShimmer, null, t('foldersLoading')) : t('foldersLoading'))
              : folders.length === 0
              ? h('div', { className: 'dshdev-folders-empty' }, t('foldersEmpty'))
              : folders.map((f) =>
                  h(
                    'div',
                    { key: f.path, className: cx('dshdev-folder-row', picked.has(f.path) && 'dshdev-folder-picked'), role: 'treeitem', 'data-dshdev-folder': f.name },
                    f.workspaceId
                      ? h('span', { className: 'dshdev-folder-check' }, Icon('IconCheckOutlineRegular', { size: 14 }, () => '✓'))
                      : P.Checkbox
                      ? h('span', { className: 'dshdev-folder-check', onClick: (e) => e.stopPropagation() }, h(P.Checkbox, { checked: picked.has(f.path), onChange: () => toggle(f.path), label: f.name }))
                      : h('input', { type: 'checkbox', className: 'dshdev-folder-check', checked: picked.has(f.path), onChange: () => toggle(f.path), 'aria-label': f.name }),
                    h(
                      'button',
                      { type: 'button', className: 'dshdev-folder-open', disabled: busy, onClick: () => load(f.path), title: t('folderOpen') },
                      Icon('IconFolderCloseRegular', { size: 16 }),
                      h('span', { className: 'dshdev-folder-name' }, f.name),
                      f.project && f.project.length ? h(NativeTag, { tone: 'info' }, t('projectTag')) : null,
                      f.workspaceId ? h(NativeTag, { tone: 'neutral' }, t('alreadyAdded')) : null,
                      h('span', { className: 'dshdev-folder-chevron' }, Icon('IconChevronRightOutlineRegular', { size: 14 }, () => '›')),
                    ),
                  ),
                ),
          ),
          listing && listing.truncated ? h('div', { className: 'dshdev-folders-note' }, t('foldersTruncated')) : null,
          projects.length > 1 && !split
            ? h('button', { type: 'button', className: 'dshdev-inline-link', 'data-testid': 'dsh-devices-folders-projects', onClick: () => (setSplitAt(listing.path), setPicked(new Set(projects.map((f) => f.path)))) }, fill(t('pickProjects'), { n: projects.length }))
            : null,
          h(
            'div',
            { className: 'dshdev-folders-new' },
            h(NativeField, { value: newName, onChange: setNewName, onEnter: create, label: t('newFolder'), placeholder: t('newFolderPlaceholder'), disabled: busy || !listing }),
            h(ModalButton, { variant: 'outline', testid: 'dsh-devices-folders-create', disabled: busy || !newName.trim() || !listing, onClick: create }, t('createFolder')),
          ),
        ),
      })
    }

    function RenameWorkspaceDialog({ t, dialog, onClose }) {
      const device = deviceById(dialog.deviceId)
      const [value, setValue] = useState(dialog.title || '')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      if (!device) return null
      const trimmed = value.trim()
      const save = async () => {
        if (!trimmed || busy) return
        setBusy(true)
        setError(null)
        try {
          await post('/devices/workspace-action', { id: device.id, action: 'rename', workspaceId: dialog.workspaceId, title: trimmed })
          await refreshDevices()
          onClose()
        } catch (e) {
          setError(folderError(e, t))
        } finally {
          setBusy(false)
        }
      }
      return h(NativeModal, {
        t,
        title: nt('rename.workspace.title', null, t('renameWorkspace')),
        onClose: () => !busy && onClose(),
        footer: h(React.Fragment, null, h(ModalButton, { variant: 'outline', disabled: busy, onClick: onClose }, nt('cancel', null, t('cancel'))), h(ModalButton, { variant: 'primary', testid: 'dsh-devices-rename-ws', disabled: busy || !trimmed, onClick: save }, nt('rename', null, t('rename')))),
        children: h(React.Fragment, null, h(NativeField, { value, onChange: setValue, onEnter: save, label: t('workspaceName'), autoFocus: true, disabled: busy }), error ? h('div', { className: 'dshdev-folders-error', role: 'alert' }, error) : null),
      })
    }

    function RemoveWorkspaceDialog({ t, dialog, onClose }) {
      const device = deviceById(dialog.deviceId)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      if (!device) return null
      const remove = async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          await post('/devices/workspace-action', { id: device.id, action: 'remove', workspaceId: dialog.workspaceId })
          await refreshDevices()
          onClose()
        } catch (e) {
          setError(folderError(e, t))
        } finally {
          setBusy(false)
        }
      }
      return h(NativeModal, {
        t,
        title: nt('delete.workspace', null, t('removeWorkspace')),
        description: nt('delete.desc', { name: dialog.title }, fill(t('removeWorkspaceHint'), { name: dialog.title })),
        onClose: () => !busy && onClose(),
        footer: h(React.Fragment, null, h(ModalButton, { variant: 'outline', disabled: busy, onClick: onClose }, nt('cancel', null, t('cancel'))), h(ModalButton, { variant: 'primary', testid: 'dsh-devices-remove-ws', disabled: busy, onClick: remove }, nt('delete.workspace', null, t('removeWorkspace')))),
        children: error ? h('div', { className: 'dshdev-folders-error', role: 'alert' }, error) : null,
      })
    }

    /** Archived remote chats, as DSH lists archived results: a row with an Unarchive button. */
    function ArchivedDialog({ t, dialog, onClose }) {
      const st = useStore()
      const device = (st.data.devices || []).find((d) => d.id === dialog.deviceId)
      const cls = rowClasses()
      if (!device) return null
      const items = device.archived || []
      return h(NativeModal, {
        t,
        title: fill(t('archivedTitle'), { device: device.name }),
        onClose,
        testid: 'dsh-devices-archived',
        footer: h(ModalButton, { variant: 'outline', onClick: onClose }, nt('close', null, t('close'))),
        children: items.length
          ? h(
              'div',
              { className: 'dshdev-archived-list', role: 'tree' },
              items.map((s) =>
                h(
                  'div',
                  { key: s.sessionId, className: cx(cls.searchRow, 'dshdev-archived-row'), role: 'treeitem', 'data-dshdev-archived': s.sessionId },
                  h('span', { className: cls.searchHeading }, h('span', { className: cls.slot }, h(RemoteMark, null)), h('span', { className: cls.searchTitle }, s.title || nt('session.untitled', null, t('untitled')))),
                  h('span', { className: cls.searchMeta }, h('span', { className: cls.searchWorkspace }, [s.workspaceTitle, timeLabel(s.updatedAt)].filter(Boolean).join(' · '))),
                  h(
                    'span',
                    { className: cx(cls.actions, 'dshdev-archived-actions') },
                    h(TipButton, { cls, label: nt('actions.unarchive', null, t('unarchive')), action: 'unarchive', onClick: () => sessionAction(device, s.sessionId, 'unarchive') }, Icon('IconUnarchiveOutlineRegular', { size: 14 })),
                  ),
                ),
              ),
            )
          : h('p', { className: 'dshdev-empty-text' }, t('noArchived')),
      })
    }

    /** A card like the rows of DSH's Plugins page. */
    function Card({ icon, title, tags, description, end, testid, onOpen }) {
      return h(
        'li',
        { className: cx('dshdev-card2', onOpen && 'dshdev-card2-link'), 'data-testid': testid },
        h(
          'div',
          { className: 'dshdev-card2-head' },
          icon ? h('span', { className: 'dshdev-card2-icon' }, icon) : null,
          h(
            'div',
            { className: 'dshdev-card2-main' },
            h('div', { className: 'dshdev-card2-titlerow' }, onOpen ? h('button', { type: 'button', className: 'dshdev-card2-open', onClick: onOpen }, title) : h('span', { className: 'dshdev-card2-title' }, title), tags || null),
            description ? h('div', { className: 'dshdev-card2-desc' }, description) : null,
          ),
          end ? h('div', { className: 'dshdev-card2-end' }, end) : null,
        ),
      )
    }
    function IconButton({ label, onClick, children, disabled, testid }) {
      const button = h('button', { type: 'button', className: 'dshdev-icon-button', 'aria-label': label, disabled, onClick, 'data-testid': testid }, children)
      return P.Tooltip ? h(P.Tooltip, { label, side: 'bottom', align: 'end', delayMs: 500, portal: true }, button) : button
    }
    function NativeTag({ tone = 'outline', children }) {
      return P.Tag ? h(P.Tag, { tone, className: 'dshdev-status-tag' }, children) : h('span', { className: 'dshdev-status-tag' }, children)
    }

    function PortsDialog({ t, dialog, onClose }) {
      const st = useStore()
      const device = (st.data.devices || []).find((d) => d.id === dialog.deviceId)
      const [error, setError] = useState(null)
      useEffect(() => {
        api(`/devices/ports?id=${encodeURIComponent(dialog.deviceId)}`)
          .then(() => refreshDevices())
          .catch((e) => setError(friendlyError(e, device)))
      }, [dialog.deviceId])
      if (!device) return null
      const ports = device.ports || []
      const act = async (path, body) => {
        setError(null)
        try {
          await post(path, { id: device.id, ...body })
          await refreshDevices()
        } catch (e) {
          setError(friendlyError(e, device))
        }
      }
      const copy = async (url) => {
        try {
          if (P.writeClipboard) await P.writeClipboard(url)
          else await navigator.clipboard.writeText(url)
          showToast(nt('hover.copied', null, t('portCopied')), { tone: 'success' })
        } catch {}
      }
      return h(NativeModal, {
        t,
        title: fill(t('portsTitle'), { device: device.name }),
        description: fill(t('portsHint'), { device: device.name }),
        onClose,
        wide: true,
        testid: 'dsh-devices-ports',
        footer: h(
          React.Fragment,
          null,
          h(
            'label',
            { className: 'dshdev-footer-switch' },
            h(NativeSwitch, { checked: device.autoForwardPorts !== false, label: t('portAuto'), onChange: (v) => act('/devices/port-auto', { on: v }) }),
            h('span', null, t('portAuto')),
          ),
          h(ModalButton, { variant: 'outline', onClick: onClose }, nt('close', null, t('close'))),
        ),
        children: h(
          React.Fragment,
          null,
          ports.length === 0 ? h('p', { className: 'dshdev-empty-text' }, fill(t('portsEmpty'), { device: device.name })) : null,
          ports.length
            ? h(
                'ul',
                { className: 'dshdev-cards' },
                ports.map((p) => {
                  const url = p.localPort ? `http://localhost:${p.localPort}/` : null
                  return h(
                    'div',
                    { key: p.port, 'data-dshdev-port': p.port },
                    h(Card, {
                      icon: Icon('IconGlobeOutlineRegular'),
                      title: h(React.Fragment, null, h('span', { className: 'dshdev-port-number' }, `:${p.port}`), ' ', p.label || ''),
                      tags: url ? h(NativeTag, { tone: 'success' }, `localhost:${p.localPort}`) : null,
                      description: [url ? null : t('notForwarded'), p.cwd ? p.cwd.replace(/^\/(root|home\/[^/]+)(?=\/|$)/, '~') : null].filter(Boolean).join(' · ') || ' ',
                      end: h(
                        React.Fragment,
                        null,
                        url ? h(IconButton, { label: t('portOpen'), onClick: () => openForwarded(p.localPort), testid: `port-open-${p.port}` }, Icon('IconRightUpOutlineRegular')) : null,
                        url ? h(IconButton, { label: t('portCopy'), onClick: () => copy(url) }, Icon('IconCopyOutlineRegular')) : null,
                        h(NativeSwitch, { checked: !!url, label: url ? t('portStop') : t('portForward'), onChange: (on) => act(on ? '/devices/port-forward' : '/devices/port-close', { port: p.port }) }),
                      ),
                    }),
                  )
                }),
              )
            : null,
          error ? h('p', { className: 'dshdev-error-text', role: 'alert' }, error) : null,
        ),
      })
    }

    const SYNC_GROUPS = ['instructions', 'skill', 'mcp', 'preset', 'plugin']
    const SYNC_ICONS = { instructions: () => Icon('IconListPenOutlineRegular'), skill: () => Icon('IconSkillOutlineRegular'), mcp: () => Icon('IconApiOutlineRegular'), preset: () => Icon('IconAgentPresetOutlineRegular'), plugin: () => Icon('IconCordisPluginOutlineRegular') }
    /** The device's report line for one plan item. */
    function reportFor(report, item) {
      if (!report) return null
      return (
        report.find((r) => {
          if (r.kind === 'instructions') return item.key === `instructions:${r.name}`
          if (r.kind === 'skill') return r.root ? item.key === `skill:${r.root}:${r.name}` : item.kind === 'skill' && item.key.endsWith(`:${r.name}`)
          if (r.kind === 'row') return item.key === `row:${r.name}`
          if (r.kind === 'plugin') return item.key === `plugin:${r.name}`
          return false
        }) || null
      )
    }
    const STATUS_TONE = { new: 'info', changed: 'warning', same: 'quiet', unsupported: 'neutral', conflict: 'neutral' }

    function SyncDialog({ t, dialog, onClose }) {
      const device = deviceById(dialog.deviceId)
      const [plan, setPlan] = useState(null)
      const [picked, setPicked] = useState({})
      const [error, setError] = useState(null)
      const [job, setJob] = useState(null)
      const [showSame, setShowSame] = useState(false)
      useEffect(() => {
        api(`/devices/sync-plan?id=${encodeURIComponent(dialog.deviceId)}`).then(
          (p) => {
            setPlan(p)
            setPicked(Object.fromEntries((p.items || []).filter((i) => i.selected).map((i) => [i.key, true])))
          },
          (e) => setError(friendlyError(e, device)),
        )
      }, [dialog.deviceId])
      useEffect(() => {
        if (!job || job.state !== 'running') return
        const timer = setInterval(async () => {
          try {
            setJob(await api(`/devices/job?id=${encodeURIComponent(job.id)}`))
          } catch {}
        }, 800)
        return () => clearInterval(timer)
      }, [job && job.id, job && job.state])
      if (!device) return null
      const RANK = { new: 0, changed: 0, conflict: 1, unsupported: 1, same: 2 }
      const allItems = ((plan && plan.items) || []).slice().sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3))
      const sameCount = allItems.filter((i) => i.status === 'same' && !picked[i.key]).length
      const items = showSame ? allItems : allItems.filter((i) => i.status !== 'same' || picked[i.key])
      const keys = Object.keys(picked).filter((k) => picked[k])
      const run = async () => {
        setError(null)
        try {
          setJob(await post('/devices/sync', { id: device.id, keys }))
        } catch (e) {
          setError(friendlyError(e, device))
        }
      }
      const report = job && job.state === 'done' && job.result ? job.result.report || [] : null
      const body = !plan
        ? error
          ? null
          : h('p', { className: 'dshdev-empty-text' }, P.TextShimmer ? h(P.TextShimmer, null, fill(t('syncLoading'), { device: device.name })) : fill(t('syncLoading'), { device: device.name }))
        : allItems.length === 0 || (items.length === 0 && sameCount === 0)
          ? h('p', { className: 'dshdev-empty-text' }, t('syncNothing'))
          : h(
              'div',
              { className: 'dshdev-groups', 'data-testid': 'dsh-devices-sync' },
              SYNC_GROUPS.filter((g) => items.some((i) => i.kind === g)).map((g) =>
                h(
                  'section',
                  { key: g, className: 'dshdev-group2' },
                  h('h3', { className: 'dshdev-group2-title' }, t(`syncGroup_${g}`)),
                  h(
                    'ul',
                    { className: 'dshdev-cards' },
                    items
                      .filter((i) => i.kind === g)
                      .map((i) => {
                        const blocked = i.status === 'unsupported' || i.status === 'conflict'
                        const result = reportFor(report, i)
                        const tag = result
                          ? h(NativeTag, { tone: result.ok ? 'success' : 'danger' }, result.ok ? '✓' : t('failed'))
                          : h(NativeTag, { tone: STATUS_TONE[i.status] || 'outline' }, t(`syncStatus_${i.status}`))
                        return h(
                          'div',
                          { key: i.key, 'data-dshdev-sync': i.key },
                          h(Card, {
                            icon: (SYNC_ICONS[i.kind] || SYNC_ICONS.plugin)(),
                            title: i.label,
                            tags: tag,
                            description: [i.detail, i.reason ? t(`syncReason_${i.reason}`) : null, ...(i.warn || []).map((w) => t(`syncWarn_${w}`)), result && !result.ok ? result.detail : null].filter(Boolean).join(' · '),
                            end: P.Checkbox
                              ? h(P.Checkbox, { checked: !!picked[i.key], disabled: blocked || !!job, label: '', title: i.label, onChange: (v) => setPicked({ ...picked, [i.key]: v }) })
                              : h('input', { type: 'checkbox', checked: !!picked[i.key], disabled: blocked || !!job, onChange: (e) => setPicked({ ...picked, [i.key]: e.target.checked }) }),
                          }),
                        )
                      }),
                  ),
                ),
              ),
              items.length === 0 ? h('p', { className: 'dshdev-empty-text' }, t('syncAllSame')) : null,
              sameCount && !showSame ? h('button', { type: 'button', className: 'dshdev-link-button', onClick: () => setShowSame(true) }, fill(t('syncShowSame'), { n: sameCount })) : null,
            )
      return h(NativeModal, {
        t,
        title: fill(t('syncTitle'), { device: device.name }),
        description: fill(t('syncHint'), { device: device.name }),
        onClose,
        wide: true,
        footer: h(
          React.Fragment,
          null,
          h(ModalButton, { variant: 'outline', onClick: onClose }, report ? t('done') : nt('cancel', null, t('cancel'))),
          report ? null : h(ModalButton, { variant: 'primary', disabled: keys.length === 0 || !!job, onClick: run, testid: 'dsh-devices-sync-run' }, job ? t('working') : fill(t('syncRun'), { n: keys.length })),
        ),
        children: h(
          React.Fragment,
          null,
          body,
          items.some((i) => i.kind === 'plugin') ? h('p', { className: 'dshdev-hint-text' }, t('syncPluginsNote')) : null,
          job ? h(JobView, { job, t }) : null,
          report ? h('p', { className: 'dshdev-success-text', role: 'status' }, fill(t('syncDone'), { ok: report.filter((r) => r.ok).length, n: report.length })) : null,
          error || (job && job.state === 'error') ? h('p', { className: 'dshdev-error-text', role: 'alert' }, error || job.error) : null,
        ),
      })
    }

    function AccountDialog({ t, dialog, onClose }) {
      const st = useStore()
      const device = (st.data.devices || []).find((d) => d.id === dialog.deviceId)
      if (!device) return null
      return h(NativeModal, {
        t,
        title: fill(t('accountTitle'), { device: device.name }),
        onClose,
        wide: true,
        testid: 'dsh-devices-account',
        footer: h(ModalButton, { variant: 'outline', onClick: onClose }, nt('close', null, t('close'))),
        children: h(ModelKeyPanel, { device, t, variant: 'card', onUpdate: startDeviceUpdate }),
      })
    }

    /** Update a device host from anywhere (the Devices page follows its own job log). */
    async function startDeviceUpdate(device) {
      try {
        await post('/devices/update', { id: device.id })
        // The outcome arrives as an "update" notice (one toast, shown by maybeNotify).
        showToast(fill(appT('updating'), { device: device.name }), { icon: Icon('IconDownloadOutlineRegular'), holdMs: 5000 })
        refreshDevices()
      } catch (e) {
        showToast(e.message, { icon: Icon('IconWarningOutlineRegular') })
      }
    }

    /** "Where should this session run?" — DSH's menu, anchored to the pill that opened it. */
    function DevicePicker({ t }) {
      const st = useStore()
      const p = st.picker
      if (!p) return null
      const devices = st.data.devices || []
      const items = [
        { type: 'label', id: 'title', text: t('chooseDevice') },
        { id: 'local', icon: h(LaptopIcon), label: t('thisMac') },
        ...devices.map((d) => {
          const meta = d.status === 'online' ? (d.model && !(d.model.ready ?? d.model.configured) ? t('modelLabel') + ' ⚠' : null) : t(`status_${d.status}`)
          return { id: `device:${d.id}`, icon: h(RemoteIcon, { size: 16 }), label: meta ? h('span', { className: 'dshdev-menu-labelled' }, d.name, h('span', { className: 'dshdev-menu-suffix' }, meta)) : d.name, disabled: d.status !== 'online' }
        }),
        { type: 'separator', id: 'sep' },
        { id: 'add', icon: Icon('IconPlusOutlineRegular'), label: t('addDeviceMenu') },
      ]
      const rect = p.rect
      return h(NativeMenu, {
        open: true,
        portal: true,
        autoFocus: true,
        items,
        selectedId: p.current ? `device:${p.current}` : 'local',
        getAnchorRect: () => rect,
        onClose: () => setStore({ picker: null }),
        onSelect: (id) => {
          setStore({ picker: null })
          if (id === 'local') startLocalSession()
          else if (id === 'add') {
            setStore({ openAdd: true })
            try {
              appCtx.layout.selectPanel(PANEL_ID)
            } catch {}
          } else if (id.startsWith('device:')) {
            const d = deviceById(id.slice(7))
            if (d) newRemote(appCtx, d, null)
          }
        },
      })
    }

    function Overlays({ t }) {
      const st = useStore()
      const dialog = st.dialog
      const closeDialog = () => setStore({ dialog: null })
      let dialogEl = null
      if (dialog) {
        const props = { t, dialog, onClose: closeDialog, key: `${dialog.kind}:${dialog.deviceId || ''}:${dialog.sessionId || ''}` }
        if (dialog.kind === 'rename') dialogEl = h(RenameDialog, props)
        if (dialog.kind === 'confirm-archive') dialogEl = h(ConfirmArchiveDialog, props)
        if (dialog.kind === 'archived') dialogEl = h(ArchivedDialog, props)
        if (dialog.kind === 'ports') dialogEl = h(PortsDialog, props)
        if (dialog.kind === 'sync') dialogEl = h(SyncDialog, props)
        if (dialog.kind === 'account') dialogEl = h(AccountDialog, props)
        if (dialog.kind === 'folders') dialogEl = h(FoldersDialog, props)
        if (dialog.kind === 'rename-ws') dialogEl = h(RenameWorkspaceDialog, props)
        if (dialog.kind === 'remove-ws') dialogEl = h(RemoveWorkspaceDialog, props)
      }
      const toast = st.toast
      const toastEl =
        toast && !P.Toast
          ? h(FallbackToast, { key: toast.seq, text: toast.text, actions: toast.actions, holdMs: toast.holdMs, onDone: () => toastDone(toast.seq) })
          : toast
          ? h(P.Toast, {
              key: toast.seq,
              text: toast.text,
              icon: toast.icon,
              tone: toast.tone,
              actions: toast.actions,
              holdMs: toast.holdMs,
              onDone: () => toastDone(toast.seq),
            })
          : null
      return h(React.Fragment, null, h(DevicePicker, { t }), dialogEl, toastEl ? h('span', { 'data-dsh-devices': 'toast', 'data-dshdev-toast': toast.kind || 'info', hidden: true }) : null, toastEl)
    }

    function mountOverlays(t) {
      ensureStyles()
      const el = document.createElement('div')
      el.setAttribute('data-dsh-devices', 'overlays')
      document.body.appendChild(el)
      const root = ReactDOMClient.createRoot(el)
      root.render(h(Overlays, { t }))
      return () => {
        root.unmount()
        el.remove()
      }
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
      try {
        nativeT = ctx.locale.bind('workspace')
      } catch {}
      ensureStyles()
      appCtx = ctx
      appT = t
      loadEditors()
      ctx.effect(() => mountDevicePill(ctx, t), 'dsh-devices: device picker')
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ ctx, t }) }, DevicesPage))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: CHAT_PANEL_ID, locale: NS, inject: () => ({ t }) }, RemoteChatPanel))
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({ name: 'settings.section', id: 'dsh-devices', order: 60, label: () => t('settingsNav'), locale: NS, inject: () => ({ t }) }, DevicesSettings),
      )
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
      ctx.effect(() => watchNativeSearch(), 'dsh-devices: sidebar search')
      ctx.effect(() => watchNativeGroupBy(), 'dsh-devices: sidebar group by')
      ctx.effect(() => {
        const idleMs = () => {
          const s = store.settings
          if (Number(s.unloadAfterMs) > 0) return Number(s.unloadAfterMs) // tests
          const minutes = s.unloadAfter === undefined ? 10 : Number(s.unloadAfter)
          return minutes > 0 ? minutes * 60_000 : 0
        }
        const timer = setInterval(() => frames.unloadIdle(idleMs()), Number(store.settings.unloadAfterMs) > 0 ? 1000 : 30_000)
        return () => clearInterval(timer)
      }, 'dsh-devices: free idle device UIs')
      ctx.effect(() => {
        document.addEventListener('visibilitychange', clearVisibleUnread)
        window.addEventListener('focus', clearVisibleUnread)
        return () => {
          document.removeEventListener('visibilitychange', clearVisibleUnread)
          window.removeEventListener('focus', clearVisibleUnread)
        }
      }, 'dsh-devices: read marks')
      ctx.effect(() => mountOverlays(t), 'dsh-devices: menus, dialogs and notices')
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
    /** Internals for the unit tests' smoke render (not an API). */
    exports.__test = {
      store,
      setStore,
      healthIssues,
      healthSummary,
      formatBytes,
      frames,
      deviceMenuItems,
      components: { RemoteSidebar, RemoteDevice, RemoteGroup, RemoteSessionRow, RemoteSearchResults, DevicesPage, DeviceCard, DevicesSettings, ModelKeyPanel, RemoteChatPanel, Overlays, DevicePicker, AddDialog },
      deviceGroups,
      workspaceMenuItems,
      dialogs: { RenameDialog, ConfirmArchiveDialog, ArchivedDialog, PortsDialog, SyncDialog, AccountDialog, FoldersDialog, RenameWorkspaceDialog, RemoveWorkspaceDialog },
    }
    return module.exports
  },
})
