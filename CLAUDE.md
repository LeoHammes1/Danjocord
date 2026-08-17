# CLAUDE.md

Guia para o Claude Code neste repositório.

## O que é

Danjocord: clone didático e minimalista de Discord — **uma guild, até 10
usuários (amigos), self-hosted**. O objetivo do projeto é **aprender a
arquitetura de streaming de voz/vídeo** (WebRTC/SFU); didática vence
conveniência quando as duas conflitam.

O documento de arquitetura (decisões, diagramas, roadmap M0–M7, repositórios
de referência) está publicado como artifact:
https://claude.ai/code/artifact/849196ea-4925-4066-9ec7-615454afb8d8

## Decisões já tomadas (não reabrir sem o Leonardo pedir)

- **Cliente**: Electron (executável tipo Discord; M6). Capacitor/mobile está
  fora do escopo. Durante o dev, `apps/client` roda no navegador.
- **Mídia**: mediasoup embutido no processo do servidor (M3+). LiveKit é o
  plano B documentado, não o caminho.
- **Banco**: SQLite WAL via better-sqlite3. O Postgres do cluster fica nos EUA
  (~150 ms) — não usar.
- **Protocolo**: gateway WebSocket estilo Discord — envelope `{op, d, s, t}`
  em **snake_case no fio**, opcodes espelhando o Discord, heartbeat, Resume
  com replay via ring buffer. Mutações (mensagens) entram por REST; o gateway
  só faz fan-out.
- **Push-to-talk global** (M6): via `uiohook-napi` — o `globalShortcut` do
  Electron NÃO serve (não separa keydown/keyup, consome a tecla).
- **Deploy**: cluster k3s do repo E:\Work\KubeCluster, pod pinado no nó
  `hostinger` (Brasil, IP 72.61.44.156), mídia via hostPort 40000/UDP,
  Ingress `danjocord.leohammes.dev`. Manifest: `deploy/danjocord.yaml`.
- **Ids**: snowflakes de 64 bits (época 2026-01-01). No SQLite são INTEGER
  (o driver devolve BigInt — `defaultSafeIntegers(true)`); **no fio são
  string**. Nunca deixar um id virar `number` em JS.

## Comandos

```bash
docker compose watch         # caminho padrão de dev: tudo em container, sync ao salvar
docker build --target runtime -t danjocord .   # a imagem de produção (ghcr/cluster)

# alternativa local sem Docker:
pnpm install && pnpm build   # build do protocol é pré-requisito dos apps
pnpm dev                     # protocol -w + server :8080 + client :5173
pnpm typecheck
pnpm smoke                   # e2e do gateway (precisa do server rodando)
pnpm --filter @danjocord/server test   # testes unitários (node --test)

# allowlist (doc §5) — rodar de apps/server; usa o build (dist) e o mesmo
# DB_PATH do servidor (em produção: kubectl exec no pod):
node scripts/allowlist.ts <add|remove|list> [discord_id] [--by <discord_id>]
```

A imagem do ghcr é publicada pelo `.github/workflows/release.yml` a cada push
na main (amd64 — o pod pina no nó x86). Após publicar: `rollout restart` do
deployment no cluster.

## Convenções

- TypeScript estrito (base em `tsconfig.base.json`); ESM em tudo.
- Todo payload que entra (WS ou REST) passa por schema Zod de
  `packages/protocol` — nada de `JSON.parse` cru virando objeto confiável.
- Auth (M1): OAuth do Discord + allowlist → sessão própria — JWT de acesso
  curto (HS256, iss/aud `danjocord`) + refresh opaco rotativo com detecção de
  reuso, na tabela `sessions`. A auth de desenvolvimento continua existindo:
  token `dev.<username>` e `POST /auth/dev` (só com `DANJOCORD_DEV_AUTH=1`,
  default fora de produção — NUNCA ligar em produção).
- Migrations: arquivos `NNN_nome.sql` em `apps/server/migrations`, aplicados
  em ordem no boot. Nunca editar migration aplicada; criar a próxima.
- Estado efêmero (presença, voice states, ring buffers) vive **em memória** —
  restart derruba sessões de gateway por desenho (clientes fazem re-Identify).
