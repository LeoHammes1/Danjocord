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

# app desktop (M6) — precisa do `pnpm dev` (server + vite) em outro terminal:
pnpm --filter @danjocord/desktop dev   # DANJOCORD_DEV=1 → Electron carrega o vite (:5173)
pnpm --filter @danjocord/desktop dist  # instalador NSIS local (bundla o cliente com a API de produção)

# allowlist (doc §5) — rodar de apps/server; usa o build (dist) e o mesmo
# DB_PATH do servidor (em produção: kubectl exec no pod):
node scripts/allowlist.ts <add|remove|list> [discord_id] [--by <discord_id>]
```

A imagem do ghcr é publicada pelo `.github/workflows/release.yml` a cada push
na main (amd64 — o pod pina no nó x86). Após publicar: `rollout restart` do
deployment no cluster.

## App desktop (M6)

`apps/desktop` é casca fina (doc §7/§8): TODA a UI/mídia vem do bundle de
`apps/client` (dev: vite; produção: scheme `app://` servindo `renderer-dist`,
gerado por `scripts/bundle-renderer.mjs`). O main só dá superpoderes de SO,
expostos ao renderer pela ponte `window.danjocord` (preload + contextBridge;
tipo em `apps/client/src/desktop.d.ts`):

- **Tray**: fechar esconde a janela (voz continua); sair só pelo menu.
- **PTT global**: `uiohook-napi` no main (decisão acima); o cliente mostra a
  seção de PTT no rodapé de voz apenas quando `window.danjocord` existe.
- **Picker de Go Live**: `setDisplayMediaRequestHandler` + janelinha própria
  com `desktopCapturer`; áudio de sistema (`loopback`) no Windows. O
  `voice.ts` do cliente não muda — é o mesmo `getDisplayMedia`.
- **OAuth loopback**: `oauthLogin()` sobe um `http.Server` em 127.0.0.1:porta
  aleatória e abre o navegador em `/auth/discord/start?redirect_port=<porta>`;
  o callback do servidor redireciona para
  `http://127.0.0.1:<porta>/danjocord-callback` com **query** (`?otc=`/
  `?auth_error=`) — query e não fragment porque o listener local precisa ler o
  valor; o fluxo web continua com fragment (`#otc=`) e nada mudou nele
  (`apps/server/src/oauth.ts`; testes em
  `apps/server/test/oauth-loopback.test.ts`).
- **Segredos**: tokens via `safeStorage` num JSON em userData (o cliente troca
  localStorage pela ponte quando é desktop; web segue localStorage).

Release do desktop: tag `v*` → `.github/workflows/desktop-release.yml`
(windows-latest) gera o NSIS e publica no GitHub Release da tag (draft —
publicar manualmente); os apps instalados se atualizam via `electron-updater`
(`checkForUpdatesAndNotify` no ready, só empacotado).

## UI do cliente (M7)

`apps/client` é **TypeScript puro, sem framework** — DOM imperativo. A decisão
é deliberada (o projeto é para aprender WebRTC, não front) e não se reabre sem
o Leonardo pedir. A partir do M7 a organização é:

- `src/styles/` — CSS por área, agregado por `index.css` (que define a **ordem**
  do cascade). `tokens.css` é o único lugar com cor literal; todo o resto usa
  `var(--…)`. Paleta e escalas espelham o Discord.
  **Armadilha já paga uma vez**: `@media` não soma especificidade — regra
  responsiva em `layout.css` perde para regra solta de um arquivo importado
  depois. Os seletores responsivos são escopados em `#app` por isso.
- `src/ui/` — um módulo por área (`sidebar`, `members`, `messages`, `chrome`,
  `composer`, `avatar`, `icons`). Nenhum deles conhece o `state` global nem o
  `VoiceClient`: tudo entra pelo `UiContext` de `ui/context.ts`, cujos campos
  são **getters vivos** montados no `main.ts` (um snapshot congelaria o boot).
- `main.ts` é cola: estado, gateway, paginação e os call sites. Render não
  mora mais lá.
- Ícone é SVG inline de `ui/icons.ts` (`fill="currentColor"`), nunca emoji, e
  nunca via `innerHTML` — o cliente não usa `innerHTML` em lugar nenhum.
- Botão que reflete estado: o `aria-label` é **invariante** (o objeto:
  "Microfone") e o estado vai no `aria-pressed`; o verbo fica no `title`.

O agrupamento de mensagens convive com a janela de DOM da paginação: como o
trim corta nas **duas pontas**, toda inserção e todo trim precisa chamar
`regroupAt`/`regroupAll` — e, onde há compensação de scroll, **antes** de medir
a altura. Os comentários nos call sites do `main.ts` dizem em quais.

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
