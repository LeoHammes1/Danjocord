# Danjocord

Um servidor de Discord simplificado — **uma única guild, self-hosted, para até
10 amigos** — construído para estudar, na prática, a arquitetura de streaming
de voz e vídeo em tempo real (WebRTC/SFU com mediasoup).

📡 **[Documento de arquitetura completo](https://claude.ai/code/artifact/849196ea-4925-4066-9ec7-615454afb8d8)** —
decisões, diagramas, roadmap M0–M7 e repositórios de referência.

## Stack

| Camada | Escolha |
|---|---|
| Backend | Node.js + TypeScript, monólito (Fastify + ws) |
| Mídia | mediasoup (SFU embutido no processo) — a partir do M3 |
| Banco | SQLite (WAL, better-sqlite3) |
| Protocolo | Gateway WebSocket estilo Discord: `{op, d, s, t}`, heartbeat, resume |
| Cliente | Electron (casca fina, M6); durante o dev, o mesmo bundle roda no navegador |
| Deploy | Cluster k3s, pod pinado no nó do Brasil (`deploy/danjocord.yaml`) |

## Estrutura

```
packages/protocol   schemas Zod compartilhados (envelope do gateway, entidades, REST)
apps/server         backend: gateway + REST + SQLite
apps/client         cliente web de referência (Vite, vanilla por enquanto)
apps/desktop        casca fina Electron: tray, PTT global, picker de Go Live, auto-update (M6)
deploy/             manifest k8s de referência
```

## Desenvolvimento

Caminho padrão — **Docker** (não precisa de Node/pnpm na máquina):

```bash
docker compose watch
```

Sobe tudo (server :8080 + cliente :5173) e sincroniza o código ao salvar
(`sync` do compose watch — file-watching confiável mesmo em host Windows).
Mudou dependência no `pnpm-lock.yaml`? O compose faz rebuild sozinho.

Alternativa local, sem Docker:

```bash
pnpm install
pnpm build        # compila o protocol (os apps importam o dist)
pnpm dev          # protocol (tsc -w) + server (:8080) + client (:5173)
```

Abra http://localhost:5173 — em dev o login pede só um username (`POST
/auth/dev`, sem passar pelo Discord; ver [Login](#login)). Abra duas abas com
usernames diferentes para ver mensagens, presença e o render otimista.

Smoke test do protocolo (com o servidor rodando):

```bash
pnpm smoke
```

## Login

Em produção o acesso é **OAuth do Discord + allowlist** (doc §5). Em dev nada
disso é necessário: com `DANJOCORD_DEV_AUTH=1` (o default fora de produção),
`POST /auth/dev` emite uma sessão completa só com um username.

1. Crie um app em https://discord.com/developers/applications e, em
   **OAuth2 → Redirects**, cadastre:
   - `https://danjocord.leohammes.dev/auth/discord/callback` (produção)
   - `http://localhost:8080/auth/discord/callback` (dev)
2. Envs do servidor: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` e
   `JWT_SECRET` (no cluster vêm do Secret `danjocord-credentials`, populado
   pelo `apply-secrets.sh` do KubeCluster), mais `PUBLIC_BASE_URL` e `APP_URL`
   (`https://danjocord.leohammes.dev` em produção; em dev os defaults já
   apontam para localhost).
3. **Primeiro dono** (`DANJOCORD_OWNER_DISCORD_ID`): num deploy limpo a
   allowlist nasce **vazia** — o OAuth recusa todo mundo e não existe admin
   para criar convite, então o servidor sobe saudável e trancado por fora. Com
   esta env definida, o boot põe esse `discord_id` na allowlist **só quando a
   allowlist está vazia**, e o primeiro login dele vira `owner`. Reiniciar
   depois disso não mexe em nada; trocar o valor não promove ninguém numa guild
   que já existe.

   Sem a env e com a allowlist vazia, o servidor **avisa no log** no boot
   (senão ninguém descobre por que o login recusa todo mundo). O caminho
   "o primeiro que logar vira dono" está descartado de propósito: o Ingress é
   público.

4. Depois disso, quem entra entra **por convite** (link `/invite/<código>`,
   criado por admin+ na UI) — a allowlist deixa de ser o caminho normal. A CLI
   continua existindo para operar o servidor de fora (de `apps/server`; em dev,
   rode `pnpm --filter @danjocord/server build` antes — o script abre o banco
   pelo código compilado):

   ```bash
   node scripts/allowlist.ts add 123456789012345678 --by 987654321098765432
   node scripts/allowlist.ts remove 123456789012345678
   node scripts/allowlist.ts list

   node scripts/admin.ts grant <user_id>    # cargo admin
   node scripts/admin.ts revoke <user_id>   # cargo member
   node scripts/admin.ts owner <user_id>    # transfere o cargo de dono
   node scripts/admin.ts list
   ```

   As CLIs respeitam o mesmo `DB_PATH` do servidor. Em produção:
   `kubectl -n production exec deploy/danjocord -- node scripts/allowlist.ts list`.

   Elas rodam em **outro processo**, direto no banco: não emitem eventos (quem
   está com o app aberto vê o estado antigo até dar F5) e não derrubam sessão
   de gateway na hora — quem cobre isso é a revalidação de pertencimento no
   heartbeat (~41 s). Kick e ban **pela UI** derrubam na hora.

## App desktop (Electron, M6)

`apps/desktop` é uma **casca fina** (doc §7): toda a UI e a mídia são o MESMO
bundle web de `apps/client` — o main do Electron só adiciona os superpoderes
de SO que o navegador não dá:

- **Bandeja**: fechar a janela esconde (a voz continua); sair de verdade só
  pelo menu do tray.
- **Push-to-talk global** via `uiohook-napi` no main (o `globalShortcut` não
  serve — não separa keydown/keyup e consome a tecla). A tecla é configurável
  no rodapé de voz, só no desktop.
- **Picker de Go Live**: o main intercepta o `getDisplayMedia` com uma
  janelinha própria de telas/janelas (`desktopCapturer`); no Windows o áudio
  de sistema vai junto (loopback nativo).
- **Login OAuth por loopback**: o navegador externo faz o fluxo do Discord e
  volta para `http://127.0.0.1:<porta>/danjocord-callback` (um `http.Server`
  efêmero do app — ver `?redirect_port` em `apps/server/src/oauth.ts`).
- **Tokens no `safeStorage`** (cifrados pelo SO) em vez de localStorage.

Dev (com `pnpm dev` — server + vite — rodando em outro terminal):

```bash
pnpm --filter @danjocord/desktop dev   # DANJOCORD_DEV=1 → carrega http://localhost:5173
```

Release: criar e subir uma tag `v*`:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

O workflow `.github/workflows/desktop-release.yml` gera o instalador NSIS em
`windows-latest` e sobe os artefatos no GitHub Release da tag (nasce como
draft — publicar o release para os apps instalados se atualizarem via
`electron-updater`).

## Estado do roadmap

- [x] **M0 — Fundação**: monorepo, gateway (Hello/Identify/Ready, heartbeat,
  Resume com replay), REST mínimo de mensagens, SQLite com migrations,
  cliente de referência. *Falta: imagem ghcr + aplicar `deploy/danjocord.yaml`.*
- [x] **M1 — Identidade**: OAuth do Discord + allowlist + sessões próprias
  (JWT de acesso curto + refresh rotativo na tabela `sessions`), CLI de
  allowlist, cliente estático servido pelo próprio server em produção
- [x] **M2 — Chat completo**: typing, edição/exclusão (autor + admin), MEMBER_ADD
  ao vivo, paginação com scroll infinito e janela de DOM, CLI de admin
- [x] **M3 — Voz**: mediasoup embutido (router por canal, sinalização op 20/21),
  Opus DTX+FEC, mute/deafen, indicador de "quem fala" (audioLevelObserver),
  cleanup serializado por sessão. Dev usa porta RTC 41000 (Windows/WSL2 reserva
  ~39000–40500 de forma invisível); produção usa 40000 via manifest.
- [x] **M4 — Vídeo**: webcam até 4K com simulcast adaptativo de 3 camadas
  (VP8 default; H.264 preferido ≥1080p pelo encode de hardware), camada por
  tamanho de tile, grade com preview local, colapso pausa consumers no servidor
- [x] **M5 — Go Live**: screen share até 4K (`contentHint='detail'`, H.264 ≥1080p),
  1 transmissão por canal, viewers sob demanda (`close_consumer` devolve a banda),
  soundshare, badge AO VIVO, semântica de restart no produce
- [x] **M6 — App Electron**: casca fina servindo o mesmo bundle web (scheme
  `app://`), tray, push-to-talk global (uiohook-napi), picker próprio de Go
  Live com áudio de sistema no Windows, OAuth por loopback (`?redirect_port`),
  tokens no safeStorage, sons de join/leave (web também), auto-update por
  GitHub Releases (tag `v*` → `desktop-release.yml`)
- [ ] **M7 — Estudo avançado**
