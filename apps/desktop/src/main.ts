import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, net, protocol, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { oauthLogin } from "./oauth-loopback";
import { registerScreenPicker } from "./picker";
import { labelForKeycode, pttCaptureNextKey, pttSetKey, pttShutdown, setPttEmitter } from "./ptt";
import { secretGet, secretSet, secretSetMany } from "./secrets";

/**
 * Processo main do Electron (M6, doc §7): casca fina — TODA a UI/mídia vive no
 * bundle web (apps/client); aqui só entram os superpoderes de SO: janela+tray,
 * protocolo app://, PTT global (ptt.ts), picker de Go Live (picker.ts), OAuth
 * por loopback (oauth-loopback.ts), segredos no safeStorage (secrets.ts) e
 * auto-update. A ponte para o renderer é o preload.ts (contextIsolation ON).
 */

const isDev = process.env.DANJOCORD_DEV === "1";
/** bundle do cliente copiado pelo scripts/bundle-renderer.mjs */
const RENDERER_DIST = path.join(__dirname, "..", "renderer-dist");
const ICON_PATH = path.join(__dirname, "..", "assets", "icon.png");
const DEV_URL = "http://localhost:5173";
const APP_URL = "app://bundle/";

// ---------------------------------------------------------------------------
// serverUrl da ponte: em dev é o server local; em produção é o MESMO valor
// baked no bundle pelo bundle-renderer (gravado em danjocord-server-url.json
// ao lado do bundle — assim ponte e VITE_API_BASE nunca divergem).
// ---------------------------------------------------------------------------

function resolveServerUrl(): string {
  if (isDev) return "http://localhost:8080";
  try {
    const baked = JSON.parse(readFileSync(path.join(RENDERER_DIST, "danjocord-server-url.json"), "utf8")) as {
      server_url?: unknown;
    };
    if (typeof baked.server_url === "string" && baked.server_url !== "") return baked.server_url;
  } catch {
    // bundle sem o carimbo (build antigo/manual) — cai nos fallbacks abaixo
  }
  return process.env.DANJOCORD_SERVER_URL ?? "https://danjocord.leohammes.dev";
}

const serverUrl = resolveServerUrl();

// ---------------------------------------------------------------------------
// Única instância: a segunda foca a janela da primeira e morre.
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------------------------------------------------------------------------
// app:// — scheme privilegiado servindo o bundle (produção). Precisa ser
// registrado ANTES do ready (exigência do Electron).
// ---------------------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function registerAppProtocol(): void {
  protocol.handle("app", (request) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("URL inválida", { status: 400 });
    }
    if (pathname === "/" || pathname === "") pathname = "/index.html";
    // normaliza e prende dentro do renderer-dist: "../" não escapa do bundle
    const file = path.normalize(path.join(RENDERER_DIST, pathname));
    if (file !== RENDERER_DIST && !file.startsWith(RENDERER_DIST + path.sep)) {
      return new Response("fora do bundle", { status: 403 });
    }
    // isFile: um path de diretório (app://bundle/assets/) não pode chegar ao
    // net.fetch — viraria rejeição feia em vez de um 404 honesto
    if (!existsSync(file) || !statSync(file).isFile()) {
      return new Response("não encontrado", { status: 404 });
    }
    // net.fetch de file:// resolve mime type e streaming por conta própria
    return net.fetch(pathToFileURL(file).toString());
  });
  console.log(`[app://] protocolo registrado — servindo ${RENDERER_DIST}`);
}

// ---------------------------------------------------------------------------
// Janela única + tray: fechar = esconder (a voz continua); sair de verdade só
// pelo menu do tray ou pelo auto-update.
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** true a partir do before-quit: o handler de close deixa a janela morrer */
let quitting = false;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    // frame nativo NESTE milestone (contrato); dark para não piscar branco
    backgroundColor: "#14181e",
    icon: nativeImage.createFromPath(ICON_PATH),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // heartbeat do gateway e medidor de áudio NÃO podem congelar com a
      // janela minimizada/escondida (voz continua no tray) — doc §7
      backgroundThrottling: false,
      // a ponte lê isto do process.argv no preload (sem IPC síncrono no boot)
      additionalArguments: [`--danjocord-server-url=${serverUrl}`],
    },
  });
  mainWindow = win;

  win.once("ready-to-show", () => win.show());

  // fechar = esconder: o app (e a voz) continuam vivos no tray
  win.on("close", (ev) => {
    if (quitting) return;
    ev.preventDefault();
    win.hide();
    console.log("[janela] escondida no tray (fechar ≠ sair; a voz continua)");
  });
  win.on("closed", () => {
    mainWindow = null;
  });

  // links externos (target=_blank etc.) vão para o navegador do SO, nunca
  // viram BrowserWindow com a nossa ponte carregada
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:") || url.startsWith("http:")) void shell.openExternal(url);
    return { action: "deny" };
  });
  // defesa: a janela só navega dentro do próprio app (dev server ou app://)
  win.webContents.on("will-navigate", (ev, url) => {
    const allowed = isDev ? url.startsWith(DEV_URL) : url.startsWith("app://");
    if (!allowed) ev.preventDefault();
  });

  if (isDev) {
    // vite pode ainda não ter subido — retry simples até aparecer
    win.webContents.on("did-fail-load", (_ev, code, desc) => {
      console.warn(`[janela] falha ao carregar ${DEV_URL} (${code} ${desc}) — retry em 1s (vite subiu?)`);
      setTimeout(() => {
        if (mainWindow !== null && !mainWindow.isDestroyed()) void mainWindow.loadURL(DEV_URL);
      }, 1000);
    });
    void win.loadURL(DEV_URL);
  } else {
    void win.loadURL(APP_URL);
  }
  console.log(`[janela] criada — carregando ${isDev ? DEV_URL : APP_URL}`);
}

function showMainWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray(): void {
  const icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Danjocord");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir", click: () => showMainWindow() },
      { type: "separator" },
      {
        label: "Sair de verdade",
        click: () => {
          app.quit(); // dispara before-quit → quitting=true → close passa
        },
      },
    ]),
  );
  // clique único reabre (contrato) — no Windows o clique padrão só foca o menu
  tray.on("click", () => showMainWindow());
  console.log("[tray] ícone na bandeja pronto (Abrir / Sair de verdade)");
}

// ---------------------------------------------------------------------------
// IPC — TODO canal validado: payloads primitivos, sender conferido contra a
// janela principal (o picker tem canais próprios em picker.ts).
// ---------------------------------------------------------------------------

function assertMainSender(ev: Electron.IpcMainInvokeEvent): void {
  if (mainWindow === null || ev.sender !== mainWindow.webContents) {
    throw new Error("IPC recusado: sender não é a janela principal");
  }
  // senderFrame (revisão M6 #2): ev.sender é a WebContents INTEIRA — um
  // <iframe> compartilharia a mesma e passaria no cheque acima. O cliente não
  // usa iframe hoje; a guarda existe para que continue verdade amanhã.
  if (ev.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("IPC recusado: sender não é o frame principal");
  }
}

function registerIpc(): void {
  ipcMain.handle("secret:get", (ev, key: unknown) => {
    assertMainSender(ev);
    if (typeof key !== "string" || key.length === 0 || key.length > 256) {
      throw new Error("secret:get — chave inválida");
    }
    return secretGet(key);
  });

  ipcMain.handle("secret:set", (ev, key: unknown, value: unknown) => {
    assertMainSender(ev);
    if (typeof key !== "string" || key.length === 0 || key.length > 256) {
      throw new Error("secret:set — chave inválida");
    }
    if (value !== null && (typeof value !== "string" || value.length > 64 * 1024)) {
      throw new Error("secret:set — valor inválido");
    }
    secretSet(key, value);
  });

  // escrita ATÔMICA do trio de sessão (revisão M6 #4): três secret:set
  // independentes podiam falhar pela metade e deixar no disco um access novo
  // com refresh velho — no próximo boot esse refresh obsoleto dispara a
  // detecção de reuso do servidor e derruba a família inteira. Ou grava tudo,
  // ou nada.
  ipcMain.handle("secret:set-many", (ev, entries: unknown) => {
    assertMainSender(ev);
    if (!Array.isArray(entries) || entries.length > 16) {
      throw new Error("secret:set-many — lista inválida");
    }
    const pairs: [string, string | null][] = [];
    for (const entry of entries as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 2) throw new Error("secret:set-many — par inválido");
      const [key, value] = entry as [unknown, unknown];
      if (typeof key !== "string" || key.length === 0 || key.length > 256) {
        throw new Error("secret:set-many — chave inválida");
      }
      if (value !== null && (typeof value !== "string" || value.length > 64 * 1024)) {
        throw new Error("secret:set-many — valor inválido");
      }
      pairs.push([key, value]);
    }
    secretSetMany(pairs);
  });

  ipcMain.handle("oauth:login", (ev) => {
    assertMainSender(ev);
    console.log("[oauth] login solicitado pelo renderer");
    return oauthLogin(serverUrl);
  });

  ipcMain.handle("ptt:set-key", (ev, keycode: unknown) => {
    assertMainSender(ev);
    if (keycode !== null && (typeof keycode !== "number" || !Number.isInteger(keycode) || keycode < 0 || keycode > 0xffff)) {
      throw new Error("ptt:set-key — keycode inválido");
    }
    pttSetKey(keycode as number | null);
  });

  ipcMain.handle("ptt:capture-next", (ev) => {
    assertMainSender(ev);
    return pttCaptureNextKey();
  });

  console.log("[ipc] canais registrados: secret:get/set, oauth:login, ptt:set-key/capture-next");
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

app.setAppUserModelId("dev.leohammes.danjocord"); // notificações/agrupamento no Windows

app.on("second-instance", () => showMainWindow());

app.on("before-quit", () => {
  quitting = true;
  pttShutdown(); // uiohook vivo seguraria o processo para sempre
});

// o tray mantém o app vivo com todas as janelas "fechadas" (escondidas);
// registrar o listener já suprime o quit default — de propósito
app.on("window-all-closed", () => {
  if (quitting) app.quit();
});

void app.whenReady().then(() => {
  console.log(`[boot] Danjocord desktop — dev=${String(isDev)} serverUrl=${serverUrl}`);
  if (!isDev) registerAppProtocol();
  registerIpc();
  registerScreenPicker(() => mainWindow);
  // keydown/keyup da tecla de PTT viajam main → renderer por aqui
  setPttEmitter((down) => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send("ptt", down);
  });
  createTray();
  createWindow();

  // auto-update (electron-updater): checa no boot e notifica; o publish
  // (GitHub LeoHammes1/Danjocord) já está no package.json. Só empacotado —
  // em dev não existe app-update.yml e a chamada só suja o log.
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().then(
      (r) => console.log("[updater] checagem concluída", r?.updateInfo?.version ?? "(sem update)"),
      (err: unknown) => console.warn("[updater] checagem falhou (sem rede? release sem artefatos?)", err),
    );
  } else {
    console.log("[updater] pulado — app não empacotado");
  }
});
