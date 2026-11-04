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
npm run build        # → dist/dsh-devices-0.1.4.tgz, dist/dsh-device-host-0.1.4.tgz, dist/install-*.sh
```

### 1. No Mac: instalar o `dsh-devices`

**Pelo próprio app (mais simples):**

1. Baixe **`dsh-devices-0.1.4.tgz`** da página de *Releases* do repositório (no navegador, logado no GitHub).
2. No DeepSeek Harness: **Plug-ins → Adicionar plug-in**. No campo, cole o **caminho completo** do
   arquivo baixado, por exemplo `/Users/SEU_USUARIO/Downloads/dsh-devices-0.1.4.tgz`
   (no Finder: clique com o botão direito no arquivo, segure **Option** → *Copiar "…" como Nome de Caminho*).
3. **Instalar**. Pronto: aparece **Devices** na barra lateral.

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

Ou, com os arquivos de `dist/`, copie `dsh-devices-0.1.4.tgz` e `install-desktop.sh` para o Mac e rode:

```sh
sh install-desktop.sh ./dsh-devices-0.1.4.tgz            # detecta o profile do app
sh install-desktop.sh ./dsh-devices-0.1.4.tgz --profile NOME
```

Ou, direto do Mac, puxando da VPS por SSH:

```sh
ssh root@SUA_VPS 'cat /root/Projetos/dsh-remote-vps/dist/dsh-devices-0.1.4.tgz' > /tmp/dsh-devices.tgz
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

Instalação manual na VPS (sem o Mac): `sh install-host.sh --plugin ./dsh-device-host-0.1.4.tgz`.

### 3. Chave do modelo na VPS

O agente roda na VPS, então a chave DeepSeek é a **da VPS**. Se faltar, o chat remoto mostra um
aviso no topo com:

- **Usar a chave deste computador**: copia a chave DeepSeek do seu DSH desktop para o cofre de
  credenciais do device (passa só pelo canal autenticado; o navegador nunca vê a chave);
- **colar uma chave** (`sk-…`) e salvar;
- **Configurações do device**: abre as Configurações completas do DSH da VPS (Models, conta
  DeepSeek, etc.) dentro da própria janela.

O mesmo fica no card do device em **Devices**. Devices com host antigo mostram **Atualizar device**.

## Uso

- **Chats juntos:** os workspaces da VPS aparecem abaixo dos locais, com o ícone de remoto e o
  nome do device. Clique num chat remoto: ele abre na área principal desta janela. Voltar para
  um chat local e para o remoto é instantâneo (a UI do device fica viva em segundo plano).
- **Onde a sessão roda:** na tela de nova sessão, antes de *Escolha o espaço de trabalho*, há o
  seletor de device (**Este computador ▾**). Escolha a VPS e a nova sessão abre nela, inline;
  dentro dela, a pílula com o nome do device volta para este computador.
- **Novo chat remoto:** no seletor de workspace do campo de mensagem (*Choose workspace*), a seção
  **On your devices** lista os workspaces de cada VPS e *New on <VPS>…*; escolha um e o chat
  começa na VPS. Ou passe o mouse no workspace remoto da barra lateral → **+**.
- **Devices:** status (online/offline, uptime, versão), renomear, atualizar o device (alinha a
  versão do dsh com a do Mac), remover (também despareia na VPS), abrir em janela separada.
- Se o Mac dormir ou a rede cair, a sessão continua na VPS; o plugin reconecta sozinho
  (verificação a cada 15 s, espera crescente com jitter, revalidação ao acordar).

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

## Desenvolvimento e testes

```sh
npm test                  # testes unitários (protocolo, store, auth, túnel, gateway, ssh config)
sh test/devenv.sh start   # "VPS" (3181) + "Mac" (3281) + modelos simulados (4598/4599)
node test/e2e-ui.mjs      # teste de interface ponta a ponta (Chromium headless)
sh test/devenv.sh stop
```

O teste ponta a ponta verifica: chat local respondido pelo agente do desktop; chats locais e
remotos na mesma lista; chat remoto abre inline (sem nova janela) e é respondido pelo agente
**da VPS**; a UI embutida esconde a própria barra lateral; troca local ↔ remoto instantânea;
novo chat remoto aparece na barra lateral.

Estrutura:

```
packages/dsh-device-host/   plugin da VPS (lib/index.js, auth, store, tunnel, client.js; bin/dsh-device.mjs)
packages/dsh-devices/       plugin do Mac (lib/index.js, manager, ssh, gateway, device-client, client.js)
deploy/                     install-host.sh (VPS), install-desktop.sh (Mac)
scripts/                    build.mjs, make-profile.mjs
test/                       unit/, e2e-ui.mjs, devenv.sh, mock-llm.mjs
docs/                       ARQUITETURA.md
```

## Limitações conhecidas

- A conversa remota é renderizada pela UI do próprio DSH da VPS embutida na janela (por isso
  arquivos, terminal e aprovações funcionam completos). O seletor de chats é o do Mac; a busca
  da barra lateral do Mac ainda não procura nos chats remotos.
- O status dos chats remotos (rodando/concluído) atualiza a cada ~3–4 s.
- Pareamento por código exige HTTPS até a VPS; por SSH não exige nada além do SSH.
- Testado com dsh 0.2.1-rc.5 (Linux). O app desktop precisa expor o profile em `~/.dsh/profiles`.
