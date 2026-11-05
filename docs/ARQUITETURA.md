# Arquitetura

Inspirada no modelo de devices do Zeron: **o host roda o agente**; o desktop é só controle.

## O que copiamos do Zeron e como adaptamos

| Zeron | dsh-remote-vps | Motivo |
|---|---|---|
| O device host do chat roda o agente | A sessão DSH roda na VPS (`dsh-device-host`) | Fechar o Mac não para nada; o Mac não carrega o trabalho |
| Conexões só de saída até um edge (Cloudflare) | Túnel SSH até o loopback da VPS (ou HTTPS opcional) | A VPS já tem SSH: nenhuma porta nova, nenhum servidor de terceiros |
| Chats de vários devices numa só lista | Workspaces remotos inseridos na lista da barra lateral do DSH | Pedido do usuário: "chats juntos, só com a logo de remoto" |
| Presença por lease, detecção de socket mudo | Verificação a cada 15 s, offline após 2 falhas, backoff com jitter, revalidação ao acordar | Status confiável e reconexão automática |
| Catálogos consultados no host | Modelos, credenciais e workspaces são os da VPS (a UI é a do host) | É a máquina que executa |
| Login/identidade central (WorkOS) | Pareamento local: código único ou SSH; chave Ed25519 por device | Sem conta externa |
| **Evitado:** devices velhos para sempre na lista | "Remove" despareia dos dois lados; `dsh-device connections` mostra último acesso | |
| **Evitado:** versões divergentes em silêncio | Versão do dsh comparada a cada verificação; "Update device" alinha à do Mac | |
| **Evitado:** IPC local sem autenticação | Gateway local com segredo no caminho + checagem Host/Origin | |

## Fluxos

### Pareamento por SSH
1. Mac conecta (`ssh2`): agent + chaves, `~/.ssh/config`, um ProxyJump. Chave do servidor:
   confirmada pelo usuário (ou já no `known_hosts`) e fixada.
2. `~/.dsh-device/bin/dsh-device status --json` decide se instala/atualiza.
3. Instalação: SFTP do `install-host.sh` + tarball do host; o script instala Node (se preciso),
   `@deepseek-ai/dsh@<versão do Mac>`, cria o profile `device-host` e o serviço systemd.
4. `dsh-device pair --json --via ssh` gera um código; o Mac o usa pelo túnel (`forwardOut`)
   em `POST /device/v1/pair` com a sua chave pública Ed25519.

### Acesso
- `POST /device/v1/token` com assinatura Ed25519 de
  `dsh-device-token\n<deviceId>\n<clientId>\n<ts>\n<nonce>` → token opaco de 1 h (memória).
- Rotas autenticadas: `GET /info`, `GET /sessions`, `GET /workspaces`, `DELETE /clients/self`,
  e o túnel `/device/v1/t/*` (HTTP e o WebSocket `/api/remote.mux`).

### Túnel (VPS)
`/device/v1/t/<caminho>` é reenviado ao próprio listener do DSH como se viesse de um navegador
local: Host/Origin reescritos para `127.0.0.1:<porta>`, cookie de sessão do DSH (obtido trocando
o token de inicialização do processo com `ctx.connection.authenticatedUrl`) anexado; cookies do
cliente e o cabeçalho do token removidos; `Set-Cookie` nunca volta.

### Chats juntos (Mac)
- **Barra lateral:** uma raiz React própria é inserida dentro da lista de sessões do DSH
  (`[class*=regionArea] [role=tree]`), depois do último grupo local, e reposicionada por um
  `MutationObserver`. As linhas usam as **classes CSS do próprio DSH** (prefixo do CSS module
  descoberto em tempo de execução nas folhas de estilo), então herdam visual e hover; o ícone
  da pasta vira o ícone de remoto.
- **Conversa:** o painel `main` `dsh-devices-chat` (via `ctx.layout.selectPanel`) reserva a
  área; um contêiner fixo acima dela hospeda um iframe **por device** com a UI do DSH da VPS
  (`?dsh-embed=1`), sem a barra lateral dela. Trocar de chat no mesmo device usa `postMessage`
  (`open-session`, `new-session` → `ctx.uiWorkspace.openSession/openWorkspace`), sem recarregar.
  Os iframes ficam vivos ao voltar para chats locais.
- **Gateway por device:** `http://127.0.0.1:<porta>/<segredo>/` → túnel do device com token.
  O segredo no caminho funciona em qualquer webview (sem regras de cookie de terceiros) e cada
  device tem origem própria, então o `localStorage` dele não se mistura com o do Mac.

### Ferramentas do device (0.1.8)

- **Precisa de você:** o device host acompanha os eventos de sessão (`approval/asked` →
  `approval/decided`, `tool/call ask_user_question` → resultado ou resposta) e marca cada sessão
  com `pending`; o feed (`/device/v1/watch`) leva também `attention[]` sequenciado (como
  `turnEnds`), que vira aviso e notificação no Mac.
- **Painéis do device:** o Mac manda `{ type: 'open-panel', panel }` para a UI embutida, que chama
  `layout.selectPanel('plugins' | 'schedules')`; abrir um chat sai do painel.
- **Sessões:** `POST /device/v1/session-action` usa `sessionController.rename` e o
  `workspaceRegistry` (pin/unpin/archive/unarchive); `GET /device/v1/search` usa a busca por
  conteúdo do DSH (`session-query-sqlite`, ligada com `openAt: first-search` no device).
- **Conta:** `PUT /device/v1/account` grava o registro `deepseek-account-platform/default` (o
  mesmo `{ version, token, issuer }` do Mac) no cofre de credenciais do device.
- **Portas:** o device lista portas TCP em escuta do usuário (`/proc/net/tcp*`), filtra
  infraestrutura e a faixa efêmera e marca as abertas por processos do agente (`fromAgent`) ou
  dentro de um workspace (`inWorkspace`). O Mac escuta em `127.0.0.1:<mesma porta ou livre>` e
  liga cada conexão por `forwardOut` (SSH) ou por `Upgrade: dsh-port-tunnel`
  (`/device/v1/port-tunnel`, autenticado) até o loopback da VPS. A UI embutida recebe o mapa de
  portas e reescreve links `localhost:<porta>`.
- **Sincronizar:** o Mac lê suas instruções, skills, linhas de MCP/preset (pelo `loader`) e
  plug-ins (pelo `pluginManager`), compara por hash com `GET /device/v1/sync` e envia só o
  escolhido; o device grava arquivos (com backup), mantém as linhas num bloco gerenciado do
  `cordis.patch.yml` do perfil e instala plug-ins pelo `pluginManager.installBundle`.

### Atualização, saúde e memória (0.1.10)

- **Autoatualização:** `POST /device/v1/self-update` recebe o instalador e o pacote (base64). O
  device grava tudo em `~/.dsh-device/updates/<data>/`, cria `update.lock` e roda `run-update.sh`
  numa unidade transitória (`systemd-run --user`, com `DSH_HOME`/`DSH_DEVICE_ROOT` explícitos),
  porque reiniciar o serviço mata todo o seu cgroup. O runner faz backup de `runtime/` (hard links +
  cópia real do que o npm reescreve no lugar), roda `install-host.sh` (porta fixa) e só declara
  sucesso se o host que responde é a versão nova; senão restaura o backup e reinicia o serviço
  dono daquela instalação. `GET` devolve `update-status.json` + o fim do log; o Mac acompanha por ele.
- **Quando o Mac atualiza:** a cada verificação de saúde, se o device estiver atrás (host ou dsh
  mais antigos — semver com prerelease) e ocioso, conforme a preferência `autoUpdate`
  (`auto`/`ask`/`never`, salva em `devices.json`). Falhas esperam 6 h; o mesmo alvo não é repetido.
  Hosts antigos sem `self-update` usam o caminho por SSH.
- **Saúde:** `/info` traz `health` (CPU por delta de `/proc/stat`, memória por `MemAvailable`, swap,
  disco por `statfs` do home, processos que mais usam memória); o Mac calcula avisos (disco ≥ 90% ou
  < 3 GB, memória ≥ 90%, CPU ≥ 95% por ~45 s).
- **Memória do Mac:** uma interface de device fora da tela por mais que `unloadAfter` minutos é
  removida (a entrada do gateway fica em cache); o painel do chat a recria ao ser mostrado.

### Sidebar, painéis e reconexão (0.1.11)

- **Sidebar:** cada device é uma seção com cabeçalho nas classes do próprio `WorkspaceBrowser`
  (`sectionHeader`/`sectionLabel`/`headerActions`/`iconButton`, descobertas em tempo de execução);
  os workspaces remotos usam as linhas de projeto/sessão do DSH (pasta aberta/fechada), sem o
  nome do device repetido e sem marca por linha (a seção diz onde roda; a busca ainda marca).
  Estado no cabeçalho a partir de `status`/`updating`; recolher em `collapsed['device:<id>']`.
- **Painéis do device:** o host 0.1.11 anuncia `panels` em `features`. O Mac abre o painel pelo
  endereço (`?dsh-panel=<id>`, quando a UI ainda não existe) ou por `open-panel`; a UI do device
  tenta `layout.selectPanel` até 60 s (o painel só existe quando o plugin dele carrega) e responde
  `{type:'panel', ok, error?}`. Cada navegação nova cancela uma anterior ainda tentando. O Mac
  mantém por device `{id, state: opening|open|failed|unsupported}` e cobre a UI com a camada de
  estado até o painel estar na tela. Hosts 0.1.8–0.1.10 (`legacy`) recebem o pedido sem resposta;
  hosts anteriores (`none`) recebem a explicação com Atualizar/Atualizar por SSH/Abrir em janela.
- **Carregamento e falhas:** uma UI de device ganha 10 s antes de “demorando” e 60 s antes de
  “falhou”. O gateway responde a uma navegação sem device (conexão recusada, sem transporte/token)
  com uma página que avisa o Mac (`{type:'unreachable'}`), e um WebSocket recusado com 401 é
  repetido uma vez com token novo (device reiniciado). Quando um device volta a `online`, as UIs
  dele que tinham desistido recarregam, abrindo o que está selecionado agora (chat ou painel).
- **Instalador:** se o dsh pedido pelo Mac não existe no npm (E404), o host é atualizado mantendo
  o dsh atual do device.
