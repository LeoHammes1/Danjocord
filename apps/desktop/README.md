# @danjocord/desktop

A casca Electron entra no **M6** (ver o documento de arquitetura, §7 e roadmap):

- janela custom + tray (fechar = esconder, voz continua)
- push-to-talk global via **uiohook-napi** (o `globalShortcut` do Electron não
  separa keydown/keyup e consome a tecla — não serve para PTT)
- picker de Go Live próprio (`session.setDisplayMediaRequestHandler` + `desktopCapturer`)
- OAuth por loopback (RFC 8252), tokens no `safeStorage`
- `backgroundThrottling: false` na BrowserWindow
- electron-builder + auto-update via GitHub Releases

Até lá, o desenvolvimento acontece no navegador com `apps/client` (mesmo bundle).
