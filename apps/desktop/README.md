# @danjocord/desktop

Casca Electron do M6 (doc §7): **toda a UI/mídia vive no bundle web de
`apps/client`** — o main só dá superpoderes de SO. A ponte para o renderer é
`window.danjocord` (contrato do M6, exposto pelo `src/preload.ts`).

## Módulos (processo main)

| Arquivo | Papel |
| --- | --- |
| `src/main.ts` | boot, janela única, tray (fechar = esconder), single-instance, `app://`, auto-update, IPC validado |
| `src/preload.ts` | a ponte `window.danjocord` (contextBridge; superfície exata do contrato) |
| `src/ptt.ts` | push-to-talk global via **uiohook-napi** (`globalShortcut` não serve: sem keyup e consome a tecla); start lazy, para com `pttSetKey(null)` |
| `src/oauth-loopback.ts` | OAuth RFC 8252: `http.Server` em `127.0.0.1:0` → navegador externo → `?otc=` em query no `/danjocord-callback`; timeout 120 s |
| `src/secrets.ts` | `secretGet/Set` com `safeStorage` num JSON em `userData/secrets.json` (fallback documentado: texto plano + warn quando o cofre do SO não existe) |
| `src/updater.ts` | auto-update (M14): feed `generic` no NOSSO servidor, autenticado por tíquete; a checagem é disparada pelo renderer, depois do login |
| `src/picker.ts` + `src/picker.html` + `src/picker-preload.ts` | picker de Go Live: `setDisplayMediaRequestHandler` + `desktopCapturer`; no Windows a fonte vai com `audio: "loopback"`; Esc/fechar nega o pedido |
| `scripts/bundle-renderer.mjs` | build do cliente com `VITE_API_BASE` baked + cópia para `renderer-dist/` (servido via `app://` em produção) |
| `scripts/copy-static.mjs` | copia `picker.html` para `dist/` (tsc não copia .html) |

## Dev

```bash
pnpm --filter @danjocord/client dev      # vite em :5173 (e o server em :8080)
pnpm --filter @danjocord/desktop dev     # compila e abre o Electron (DANJOCORD_DEV=1)
```

Em dev a janela carrega `http://localhost:5173` e `serverUrl` da ponte é
`http://localhost:8080`. Em produção o main serve `renderer-dist/` pelo scheme
privilegiado `app://` e o `serverUrl` vem do carimbo
`renderer-dist/danjocord-server-url.json` gravado pelo bundle-renderer
(`DANJOCORD_SERVER_URL`, default `https://danjocord.leohammes.dev`).

## Release

```bash
pnpm --filter @danjocord/desktop dist    # bundle-renderer + tsc + electron-builder (NSIS)
```

O publish aponta para o GitHub (LeoHammes1/Danjocord) e o workflow de release
por tag `v*` é o `.github/workflows/desktop-release.yml`.

**O feed de atualização NÃO é o GitHub** (M14). Este repo é privado, e a API do
GitHub responde 404 — não 401 — a repo privado sem credencial; embutir um token
no instalador seria entregá-lo a quem tiver o `.exe`. O feed é o próprio
servidor, `https://danjocord.leohammes.dev/api/updates/feed/`, autenticado por
um tíquete que só sai para quem tem sessão. Por isso a checagem sai do `ready`
do main e passa a ser disparada pelo renderer depois do login
(`apps/client/src/ui/updates.ts` → canal `update:check`).

O servidor não serve os bytes: ele devolve um 302 para a URL pré-assinada que a
API do GitHub emite. É o mesmo nó que carrega a mídia (mediasoup, hostPort
40000/UDP), e um release novo poria dez `electron-updater` baixando ~100 MB pela
placa que carrega a voz. Ver `apps/server/src/updates/github.ts`.
