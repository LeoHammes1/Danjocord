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
| `src/updater.ts` | auto-update (M14): feed `generic` no NOSSO servidor (artefatos no PVC, nada no GitHub), autenticado por tíquete; a checagem é disparada pelo renderer, depois do login |
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

O workflow de release por tag `v*` é o
`.github/workflows/desktop-release.yml`.

**O artefato não fica no GitHub** (M14). O instalador não fica num Release: o
workflow compila com `--publish never` e faz POST dos artefatos em
`https://danjocord.leohammes.dev/api/updates/publish`, que os guarda no PVC do
pod. O `publish` do package.json é `generic` apontando para o nosso feed — é ele
que faz o electron-builder gerar o `latest.yml` e carimbar o `app-update.yml` de
dentro do app.

O feed exige um **tíquete** (o `.exe` leva os sons proprietários dentro), e o
tíquete só sai para quem tem sessão. Por isso a checagem sai do `ready` do main e
passa a ser disparada pelo renderer depois do login
(`apps/client/src/ui/updates.ts` → canal `update:check`).

Custo declarado: o pod serve os bytes, e é o mesmo nó que carrega a mídia. Ver
`apps/server/src/updates/store.ts`.
