# dsh-remote-vps — devices remotos para o DeepSeek Harness

Rode o agente do **DeepSeek Harness (dsh)** na sua VPS e use-o pelo **DSH desktop do Mac**,
como no Zeron: os chats da VPS aparecem **na mesma lista** dos chats locais, marcados com o
ícone de remoto, e abrem na mesma janela. O agente, as ferramentas, os terminais e os
arquivos ficam na VPS; o Mac só mostra e envia comandos (não pesa no Mac).

```
 Mac (DSH desktop + dsh-devices)                    VPS (systemd: dsh-device-host)
 ┌──────────────────────────────────┐   SSH :22      ┌──────────────────────────────────┐
 │ Barra lateral                    │ ─────────────▶ │ dsh web  --profile device-host   │
 │  📁 projeto-local                │  túnel até     │   127.0.0.1:3180 (só loopback)   │
 │     chat local                   │  127.0.0.1     │ plugin dsh-device-host           │
 │  🛰 projeto-na-vps  · VPS        │                │  • pareamento (código único)     │
 │     chat remoto  ← abre inline   │ ◀── eventos ── │  • tokens curtos, revogáveis     │
 │ gateway local por device         │   (WebSocket)  │  • túnel autenticado p/ a UI     │
 └──────────────────────────────────┘                │  • o AGENTE RODA AQUI            │
                                                     └──────────────────────────────────┘
```

Dois pacotes:

| Pacote | Onde roda | O que faz |
|---|---|---|
| `dsh-device-host` | VPS | Identidade do device, pareamento, tokens, túnel autenticado para a UI do DSH da VPS, CLI `dsh-device`, link direto/modo embutido. |
| `dsh-devices` | Mac (DSH desktop) | Lista de devices com status, pareamento por **SSH** (instala tudo na VPS) ou por **código**, chats remotos na barra lateral, conversa remota inline. |

## Instalação

Gere os pacotes (na VPS ou em qualquer máquina com Node ≥ 22.19):

```sh
npm run build        # → dist/dsh-devices-0.1.12.tgz, dist/dsh-device-host-0.1.12.tgz, dist/install-*.sh
```

### 1. No Mac: instalar o `dsh-devices`

**Pelo próprio app (mais simples):**

1. Baixe **`dsh-devices-0.1.12.tgz`** da página de *Releases* do repositório (no navegador, logado no GitHub).
2. No DeepSeek Harness: **Plug-ins → Adicionar plug-in**. No campo, cole o **caminho completo** do
   arquivo baixado, por exemplo `/Users/SEU_USUARIO/Downloads/dsh-devices-0.1.12.tgz`
   (no Finder: clique com o botão direito no arquivo, segure **Option** → *Copiar "…" como Nome de Caminho*).
3. **Instalar**. O plug-in aparece em **Plug-ins instalados** desligado: **ligue a chave** do
   `dsh-devices`. Pronto: aparece **Devices** na barra lateral (não precisa reiniciar o app).

**Para atualizar depois** (ex.: 0.1.11 → 0.1.12): baixe o `.tgz` novo e repita **Adicionar
plug-in** com o caminho dele — o DSH troca a versão na hora, sem reiniciar, e o plug-in continua
ligado. Atenção: **não apague o `.tgz` antigo antes disso** (o gerenciador do DSH ainda procura o
arquivo de onde a versão atual veio). Se já apagou, remova o `dsh-devices` em Plug-ins e instale o
novo. As VPS se atualizam sozinhas em seguida (veja *Atualização automática*).

O pacote não tem dependências (o `ssh2` vai embutido), então não baixa nada do npm nem pede
aprovação de scripts. O campo "endereço do repositório GitHub" do app só funciona com repositório
público (o app consulta o GitHub sem credenciais).

**Pelo Terminal:**

Direto do GitHub (usa o Node do próprio DSH desktop para gerar o pacote):

```sh
git clone https://github.com/JulioDevEnviagora/dsh-remote-vps.git ~/dsh-remote-vps
sh ~/dsh-remote-vps/deploy/install-desktop.sh
```

Para atualizar depois: `cd ~/dsh-remote-vps && git pull && sh deploy/install-desktop.sh`.
Os pacotes prontos também estão nas *Releases* do repositório.

Ou, com os arquivos de `dist/`, copie `dsh-devices-0.1.12.tgz` e `install-desktop.sh` para o Mac e rode:

```sh
sh install-desktop.sh ./dsh-devices-0.1.12.tgz            # detecta o profile do app
sh install-desktop.sh ./dsh-devices-0.1.12.tgz --profile NOME
```

Ou, direto do Mac, puxando da VPS por SSH:

```sh
ssh root@SUA_VPS 'cat /root/Projetos/dsh-remote-vps/dist/dsh-devices-0.1.12.tgz' > /tmp/dsh-devices.tgz
ssh root@SUA_VPS 'cat /root/Projetos/dsh-remote-vps/dist/install-desktop.sh' | sh -s /tmp/dsh-devices.tgz
```

Reinicie o DeepSeek Harness. Aparece **Devices** na barra lateral.
(Alternativa: página **Plugins** do app → instalar a partir do caminho `~/.dsh-devices/dsh-devices`.)
Para remover: `sh install-desktop.sh --uninstall`.

### 2. Adicionar a VPS

**Já salva no computador:** se a VPS já está salva no *Remote access* do DSH desktop
(`~/.dsh/remote/machines.json`, do `dsh-tauri-remote`), ela aparece sozinha em **Devices →
"Saved on this computer"** e na lista do diálogo *Add device*. Um clique em **Add** pareia,
reaproveitando endereço, login e a chave do servidor que você já aceitou (sem confirmar de novo).

**Por SSH (recomendado, nenhuma porta nova):** Devices → *Add device* → SSH → `root@IP` (ou um
alias do `~/.ssh/config`). Na primeira vez você confirma a impressão digital da chave do servidor.
O plugin instala sozinho na VPS: Node (se faltar), `@deepseek-ai/dsh` **na mesma versão do Mac**,
o `dsh-device-host`, o profile `device-host` e o serviço systemd. Depois pareia e conecta.
Usa o seu ssh-agent e as suas chaves (chaves com senha: use o ssh-agent).

**Por código (como o `t3 pair`):** na VPS, `dsh-device pair --url https://endereco-da-vps`
mostra um código `XXXX-XXXX` (5 min, uso único) e um link `dsh-device://…`. No Mac: Devices →
*Add device* → Pairing code → cole o link. Exige que o Mac alcance a VPS por HTTPS
(Tailscale, Cloudflare Tunnel ou proxy reverso apontando para `127.0.0.1:3180`).

Instalação manual na VPS (sem o Mac): `sh install-host.sh --plugin ./dsh-device-host-0.1.12.tgz`.

**VPS com host antigo pareada por código** (anterior à 0.1.10, que não se atualiza sozinha): o Mac
mostra **Atualizar por SSH…** — adicione a mesma VPS por SSH; o host novo é instalado, os chats
continuam e as próximas atualizações passam a ser automáticas.

### 3. Modelos na VPS: conta ou chave

O agente roda na VPS, então quem precisa de acesso ao DeepSeek é **a VPS**. Se faltar, o chat
remoto mostra um aviso no topo com:

- **Usar a conta deste computador**: copia o login da sua conta DeepSeek do DSH desktop para o
  device (o login por conta não funciona direto na VPS, porque abre o navegador do sistema). O
  device passa a usar o mesmo login: sair no device não desconecta o Mac; sair no Mac também
  desconecta o device.
- **Usar a chave deste computador**: copia a chave DeepSeek do seu DSH desktop para o cofre de
  credenciais do device (passa só pelo canal autenticado; o navegador nunca vê a chave);
- **colar uma chave** (`sk-…`) e salvar;
- **Configurações do device**: abre as Configurações completas do DSH da VPS (Models, conta
  DeepSeek, etc.) dentro da própria janela.

O mesmo fica no card do device em **Devices** e em **⋯ → Modelos e conta…**. Devices com host
antigo mostram **Atualizar device**.

## Uso

Tudo o que o plugin mostra usa os componentes e os estilos do próprio DSH — as mesmas linhas,
menus, cartões de detalhe, avisos (toasts), diálogos, seletores e interruptores do app, e as
mesmas palavras (em pt-BR quando o app está em português). Um chat remoto se comporta como um
local: ponto laranja e *Aprovação* quando espera você, ponto de concluído até ser aberto,
alfinete quando fixado, ⋯/arquivar/fixar ao passar o mouse, renomear com duplo clique.

- **Chats juntos, uma seção por VPS:** abaixo dos workspaces locais, cada device tem o seu
  cabeçalho, igual ao *Workspaces* do DSH: ícone de remoto, nome, estado (*Conectando…*,
  *Offline*, *Atualizando…*; nada quando está tudo bem), **+** (nova sessão) e **⋯** (o menu do
  device). Clique no cabeçalho para recolher a VPS inteira; passe o mouse para ver endereço,
  versões, CPU/memória/disco e há quanto tempo foi vista. Embaixo ficam os workspaces da VPS com
  as pastas e as linhas do próprio DSH (sem repetir o nome do device em cada linha). VPS sem chats
  mostra a linha **Nova sessão**. Clique num chat remoto: ele abre na área principal desta janela.
  Voltar para um chat local e para o remoto é instantâneo (a UI do device fica viva em segundo plano).
- **Onde a sessão roda:** na tela de nova sessão, antes de *Escolha o espaço de trabalho*, há o
  seletor de device (**Este computador ▾**). Escolha a VPS e a nova sessão abre nela, inline;
  dentro dela, a pílula com o nome do device volta para este computador.
- **Novo chat remoto:** no seletor de workspace do campo de mensagem (*Choose workspace*), a seção
  **On your devices** lista os workspaces de cada VPS e *New on <VPS>…*; escolha um e o chat
  começa na VPS. Ou passe o mouse no workspace remoto da barra lateral → **+**.
- **Devices:** status (online/offline, uptime, versão), renomear, atualizar o device (alinha a
  versão do dsh com a do Mac), remover (também despareia na VPS), abrir em janela separada.
- **Ao vivo:** a VPS avisa o Mac quando uma sessão muda (long-poll), e o Mac avisa a interface
  do mesmo jeito — o status "rodando" e as sessões novas aparecem na hora, sem polling.
- **Notificação** quando um turno remoto termina (notificações do sistema pelo app; configurável).
- **Abrir rápido:** passar o mouse num chat remoto pré-carrega a interface do device; o endereço
  do gateway é estável por device, então o cache da interface sobrevive a reinícios.
- **Cabeçalho do chat remoto** mostra o selo *Remoto · <device>*.
- **Arquivos como no DSH:** o painel direito do chat remoto é o do próprio DSH — árvore de
  arquivos, pré-visualização e terminal **da VPS**. Na barra lateral do Mac, o workspace remoto
  tem o atalho **Arquivos** (abre a árvore direto).
- **Abrir no editor deste computador:** onde o DSH mostra "Abrir em…" (cabeçalho da sessão, topo
  da árvore e da pré-visualização) aparece **VS Code / Cursor / Windsurf**, que abre a pasta ou o
  arquivo da VPS no editor do Mac via **Remote-SSH** (`vscode://vscode-remote/ssh-remote+<host>/…`).
  O host SSH é o do pareamento; devices pareados por código pedem o host uma vez. O editor
  é escolhido em Configurações → Devices.
- **Precisa de você:** quando o agente da VPS pede uma **aprovação** ou faz uma **pergunta**, o
  chat remoto fica marcado com *Precisa de você* na barra lateral (o grupo mostra quantos), e
  aparece um aviso no canto com **Abrir** — mais uma notificação do sistema se o app estiver em
  segundo plano. Funciona com o chat fechado: quem detecta é a VPS.
- **Agrupar por pasta / projeto, como no DSH:** os chats da VPS seguem o mesmo **Agrupar por**
  da barra lateral do DSH (o botão de ajustes ao lado da busca): *Espaço de trabalho* (um grupo por
  pasta), *Árvore de espaços de trabalho* (pastas de projeto aninhadas dentro da pasta-mãe) ou
  *Lista única*. Cada chat fica no espaço de trabalho cuja pasta é a pasta dele — a mesma regra do
  DSH (antes, chats de `/root/Projetos/app` podiam aparecer dentro de "Projetos").
  - **Adicionar pasta** (ícone de pasta + no cabeçalho da VPS, ou ⋯ → *Adicionar pasta…*): navega
    pelas pastas da VPS (ou cole o caminho, ex. `/root/Projetos/app`), cria pasta nova, marca uma ou
    várias e adiciona cada uma como espaço de trabalho — um grupo na barra lateral.
  - **Separar em projetos…** (⋯ de um espaço de trabalho como "Projetos"): lista as subpastas e já
    marca as que parecem projeto (git, package.json, pyproject…); cada uma vira um grupo e os chats
    novos daquele projeto ficam nele. Os chats antigos continuam onde estavam.
  - No ⋯ do espaço de trabalho: *Nova sessão aqui*, Arquivos, Abrir no editor, Renomear, Excluir
    da lista (a pasta e os chats ficam na VPS; os chats vão para *Desagrupado*). Espaços vazios
    mostram **Nova sessão**.
- **Menu ⋯ do device** (no cabeçalho da VPS; o ⋯ de cada workspace remoto tem o mesmo, mais
  Arquivos e Abrir no editor): nova sessão, **Buscar chats…**, **Plug-ins** e **Tarefas de
  automação** do device (as páginas do próprio DSH da VPS, inline), **Portas e previews**,
  **Sincronizar com este computador…**, **Modelos e conta…**, chats arquivados, configurações do
  device — e **Reconectar** quando está offline, **Atualizar device** quando há versão nova.
- **Abrindo painéis com estado claro:** ao escolher Plug-ins ou Tarefas de automação aparece
  *Abrindo Plug-ins de <VPS>…*; se a VPS demorar (primeira abertura numa conexão lenta traz uns
  5 MB), *O device está demorando para responder; continuo tentando*. Se der errado, a tela diz o
  motivo com **Tentar de novo** e **Abrir em nova janela**; numa VPS com host antigo, explica e
  oferece **Atualizar device** (ou **Atualizar por SSH…**).
- **Buscar, renomear, fixar, arquivar:** como num chat local — **⋯** (ou botão direito) num chat
  remoto → Fixar, Renomear, Arquivos, Abrir no editor, Arquivar; ou os botões de arquivar e fixar
  ao passar o mouse; duplo clique no título renomeia. Arquivar mostra o *Desfazer* do DSH; os
  arquivados voltam por **⋯ → Chats arquivados**. A **busca da barra lateral do DSH** também
  encontra os chats remotos (títulos e conteúdo das mensagens), no mesmo formato de resultado.
- **Previews de portas:** um servidor de desenvolvimento que o agente sobe na VPS (ex.:
  `localhost:5173`) é encaminhado para o **localhost deste computador** — na mesma porta quando
  ela está livre — e aparece um aviso com **Abrir no navegador**. Links `localhost:<porta>` dentro
  do chat remoto apontam para a porta encaminhada, e a aba **Navegador** do painel direito do
  device também abre. Em **⋯ → Portas e previews** dá para encaminhar outras portas, copiar a URL,
  parar, e desligar o encaminhamento automático. Por SSH vai direto pelo túnel SSH; devices por
  código usam um túnel autenticado do device host.
- **Adicionar plug-ins na VPS:** o painel Plug-ins da VPS usa o gerenciador do próprio DSH, que
  precisa do `pnpm`. O host garante um: se a VPS não tem pnpm, a instalação/atualização coloca o
  pnpm 11.7.0 (o mesmo do DSH desktop) em `~/.dsh-device/tools`, e o host instala sozinho ao subir
  se ainda faltar; se a VPS já tem um pnpm, ele é mantido.
- **Sincronizar com este computador:** copia para a VPS o que você personalizou no Mac —
  instruções (`~/.dsh/AGENTS.md`, `~/.agents/AGENTS.md`), skills (`~/.dsh/skills`,
  `~/.agents/skills`), servidores MCP, presets de agente e plug-ins de terceiros (instalados pelo
  gerenciador de plug-ins do DSH da VPS). Mostra o que é novo, alterado ou já em dia; plug-ins só
  de desktop (janelas, bandeja, pet…) e o próprio dsh-devices ficam no Mac. Arquivos da VPS que
  seriam sobrescritos ganham backup.
- **Atualização automática:** quando você atualiza o plugin no Mac (ou o app atualiza o dsh), cada
  VPS se atualiza sozinha assim que estiver ociosa — sem turno rodando nem chat esperando você. A
  própria VPS instala a nova versão (funciona por SSH ou por código), guarda a versão atual e, se a
  nova não subir, **volta sozinha** para a anterior. Nunca rebaixa um device mais novo que o Mac.
  Em Configurações → Devices dá para escolher *Quando o device estiver ocioso*, *Perguntar antes*
  ou *Nunca*; o card mostra *Atualizando…* e o resultado chega como aviso.
- **Saúde das VPS:** o card de cada device mostra CPU, memória e disco; o cartão do workspace
  remoto também. Disco quase cheio, memória quase esgotada ou CPU sobrecarregada (por um tempo)
  viram etiquetas no card e um aviso — notificação do sistema se o app estiver em segundo plano.
- **Memória do Mac:** a interface de um device que não está na tela é descarregada depois de 10
  minutos (configurável) e recarrega rápido quando você volta para o chat.
- **Configurações → Devices:** notificações (nunca / só em segundo plano / sempre), avisar quando
  um chat remoto precisar de você, mostrar ou esconder chats remotos na barra lateral, sessões por
  workspace remoto (o resto fica em *Mostrar mais*), pré-carregamento ao passar o mouse e
  **device padrão para novas sessões**.
- Se o Mac dormir ou a rede cair, a sessão continua na VPS; o plugin reconecta sozinho
  (verificação a cada 15 s, espera crescente com jitter, revalidação ao acordar). O cabeçalho da
  VPS mostra *Conectando…*/*Offline*; quando ela volta, o chat aberto volta a funcionar e uma tela
  que tinha desistido de carregar recarrega sozinha. Se a VPS não responder ao abrir, aparece na
  hora *Não consegui falar com <VPS>* com **Tentar de novo** (em vez de uma tela em branco).

## CLI na VPS (`dsh-device`)

```
dsh-device pair [--ttl 5m] [--label NOME] [--url URL] [--json]   código de pareamento de uso único
dsh-device connections [--all] [--json]                          desktops pareados
dsh-device revoke <client-id>                                    corta o acesso de um desktop
dsh-device status [--json] | doctor                              estado e diagnóstico
dsh-device name [NOVO_NOME]                                      nome do device
dsh-device service install|start|stop|restart|status|logs        serviço systemd --user
```

## Segurança

- O DSH da VPS escuta **só em 127.0.0.1**. Pelo SSH não há porta nova; por código, o acesso
  externo é responsabilidade do HTTPS na frente (Tailscale/Cloudflare/proxy).
- **Pareamento:** código de 40 bits, uso único, expira em 5 min, guardado só como hash;
  10 falhas em 10 min travam o pareamento.
- **Acesso:** cada Mac gera uma chave **Ed25519 por device** (a privada nunca sai do Mac,
  `~/.dsh/devices/keys`, 0600). Para agir, assina um pedido preso ao id do device, com
  timestamp e nonce (sem replay), e recebe um **token de 1 h** que vive só na memória da VPS.
  Revogar (`dsh-device revoke` ou *Remove* no Mac) vale na requisição seguinte.
- **Túnel:** o cookie de sessão do DSH da VPS é gerado e usado **dentro** da VPS; nunca vai
  para o Mac. A VPS não imprime a URL com token nos logs.
- **SSH:** a chave do servidor é confirmada na primeira vez e **fixada**; se mudar, a conexão
  é recusada. Hosts já presentes no `~/.ssh/known_hosts` são reconhecidos.
- **Gateway local (Mac):** um por device, em `127.0.0.1`, com segredo aleatório no caminho,
  checagem de Host/Origin (anti DNS-rebinding e cross-site) e `Referrer-Policy: no-referrer`.
- **Atualização pelo device:** só um desktop pareado pode enviar uma atualização (mesmo token de
  acesso); o pacote e o instalador são validados, uma atualização por vez, e o processo de
  atualização roda fora do serviço (unidade transitória do systemd) para poder reverter.
- **Portas encaminhadas** escutam só em `127.0.0.1` no Mac e chegam só ao loopback da VPS; o túnel
  de portas exige o mesmo token de acesso. **Sincronizar** e **Usar a conta deste computador**
  só acontecem quando você clica; o login copiado vai pelo canal autenticado e nunca passa pelo
  navegador.

## Desenvolvimento e testes

```sh
npm test                  # unitários (protocolo, store, auth, túnel, gateway, ssh, sync, portas, render da UI)
sh test/devenv.sh start   # "VPS" (3181) + "Mac" (3281) + modelos simulados (4598/4599)
node test/e2e-ui.mjs              # chats juntos, inline, troca instantânea (Chromium headless)
node test/e2e-models-picker.mjs   # chave do modelo no device + seletor de device (HOST_KEY= no host)
node test/e2e-live.mjs            # feed ao vivo, notificação, Mostrar mais, Configurações, cache
node test/e2e-files-editor.mjs    # árvore/preview da VPS na janela + abrir no editor (Remote-SSH)
node test/e2e-device-tools.mjs    # painéis do device, sync, conta, precisa de você, portas, busca/arquivo
node test/e2e-health-memory.mjs   # saúde no card, liberar memória de devices parados, preferência de atualização
node test/e2e-reconnect.mjs       # VPS cai e volta com um chat aberto: estado na sidebar, chat e painéis voltam
node test/e2e-folders.mjs         # pastas da VPS como grupos: separar em projetos, criar, renomear, Agrupar por do DSH
sh test/devenv.sh stop
```

O teste ponta a ponta verifica: chat local respondido pelo agente do desktop; chats locais e
remotos na mesma lista; chat remoto abre inline (sem nova janela) e é respondido pelo agente
**da VPS**; a UI embutida esconde a própria barra lateral; troca local ↔ remoto instantânea;
novo chat remoto aparece na barra lateral.

Estrutura:

```
packages/dsh-device-host/   plugin da VPS (lib/index.js, auth, store, tunnel, pending, ports, sync, client.js; bin/dsh-device.mjs)
packages/dsh-devices/       plugin do Mac (lib/index.js, manager, ssh, gateway, ports, sync-plan, device-client, client.js)
deploy/                     install-host.sh (VPS), install-desktop.sh (Mac)
scripts/                    build.mjs, make-profile.mjs
test/                       unit/, e2e-ui.mjs, devenv.sh, mock-llm.mjs
docs/                       ARQUITETURA.md
```

## Limitações conhecidas

- A conversa remota é renderizada pela UI do próprio DSH da VPS embutida na janela (por isso
  arquivos, terminal e aprovações funcionam completos). As linhas remotas usam as classes de
  estilo da barra lateral do DSH, descobertas em tempo de execução; se uma versão futura do DSH
  mudá-las, o plugin cai num estilo próprio equivalente.
- Servidores que o agente sobe com `nohup … &` são encerrados pelo próprio DSH quando o comando
  termina; servidores longos rodam como *job* do DSH (o agente faz isso sozinho) e esses são
  encaminhados automaticamente, assim como qualquer servidor rodando dentro de um workspace.
- Plug-ins instalados de uma **pasta local** no Mac não são sincronizados (só de tarball, npm ou
  GitHub).
- Pareamento por código exige HTTPS até a VPS; por SSH não exige nada além do SSH.
- Testado com dsh 0.2.1-rc.5 e 0.2.2-rc.1 (Linux, Chromium). No macOS (WebKit do app) a interface
  ainda não foi verificada por nós; o fluxo de instalação pelo *Adicionar plug-in* foi verificado
  num DSH limpo. O app desktop precisa expor o profile em `~/.dsh/profiles`.
- A primeira abertura da interface de uma VPS baixa ~5 MB dela (depois fica em cache); numa
  conexão lenta isso leva alguns segundos, com o aviso de que está demorando.
