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
| Cliente | Electron (M6); durante o dev, o mesmo bundle roda no navegador |
| Deploy | Cluster k3s, pod pinado no nó do Brasil (`deploy/danjocord.yaml`) |

## Estrutura

```
packages/protocol   schemas Zod compartilhados (envelope do gateway, entidades, REST)
apps/server         backend: gateway + REST + SQLite
apps/client         cliente web de referência (Vite, vanilla por enquanto)
apps/desktop        casca Electron (chega no M6)
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
3. Só passa do OAuth quem está na allowlist. Administre pela CLI (de
   `apps/server`; em dev, rode `pnpm --filter @danjocord/server build` antes —
   o script abre o banco pelo código compilado):

   ```bash
   node scripts/allowlist.ts add 123456789012345678 --by 987654321098765432
   node scripts/allowlist.ts remove 123456789012345678
   node scripts/allowlist.ts list
   ```

   A CLI respeita o mesmo `DB_PATH` do servidor. Em produção:
   `kubectl -n production exec deploy/danjocord -- node scripts/allowlist.ts list`.

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
- [ ] **M6 — App Electron**
- [ ] **M7 — Estudo avançado**
