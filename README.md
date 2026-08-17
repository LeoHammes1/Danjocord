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

Abra http://localhost:5173 — o login de desenvolvimento pede só um username
(token `dev.<username>`; o OAuth do Discord chega no M1). Abra duas abas com
usernames diferentes para ver mensagens, presença e o render otimista.

Smoke test do protocolo (com o servidor rodando):

```bash
pnpm smoke
```

## Estado do roadmap

- [x] **M0 — Fundação**: monorepo, gateway (Hello/Identify/Ready, heartbeat,
  Resume com replay), REST mínimo de mensagens, SQLite com migrations,
  cliente de referência. *Falta: imagem ghcr + aplicar `deploy/danjocord.yaml`.*
- [ ] **M1 — Identidade**: OAuth do Discord + allowlist + sessões próprias
- [ ] **M2 — Chat** completo (typing, edição, MEMBER_ADD, paginação na UI)
- [ ] **M3 — Voz** (mediasoup, áudio)
- [ ] **M4 — Vídeo** (simulcast)
- [ ] **M5 — Go Live** (screen share)
- [ ] **M6 — App Electron**
- [ ] **M7 — Estudo avançado**
