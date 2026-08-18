import { BrowserWindow, desktopCapturer, ipcMain, session } from "electron";
import * as path from "node:path";
import type { PickerSource } from "./picker-preload";

/**
 * Picker de Go Live (doc §7): o renderer chama getDisplayMedia normalmente
 * (zero mudança no voice.ts — contrato do M6) e o main intercepta via
 * session.setDisplayMediaRequestHandler, abrindo uma janelinha modal com os
 * thumbnails do desktopCapturer. Clique → resolve com a fonte; fechar/Esc →
 * nega o pedido (o getDisplayMedia do renderer rejeita como "cancelado",
 * NotAllowedError-like — o cliente já trata esse nome sem alarde).
 *
 * Áudio: no Windows o SO tem loopback nativo — a fonte vai com
 * audio: "loopback" (soundshare de verdade); nos demais, só vídeo.
 */

const THUMB = { width: 320, height: 180 } as const;

/** um picker por vez: pedido novo com janela aberta é negado na hora */
let pickerOpen = false;

export function registerScreenPicker(getParent: () => BrowserWindow | null): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      if (pickerOpen) {
        // dois getDisplayMedia concorrentes (clique duplo): o segundo já era
        callback({});
        return;
      }
      pickerOpen = true;
      void openPicker(getParent()).then(
        (source) => {
          pickerOpen = false;
          if (source === null) {
            callback({}); // sem video válido = pedido negado (docs do Electron)
            return;
          }
          console.log(`[picker] fonte escolhida: ${source.name}`);
          // audio "loopback": áudio de sistema nativo — só existe no Windows
          if (process.platform === "win32") callback({ video: source, audio: "loopback" });
          else callback({ video: source });
        },
        (err: unknown) => {
          pickerOpen = false;
          console.error("[picker] falha ao abrir o seletor de fontes", err);
          callback({});
        },
      );
    },
    // useSystemPicker ficaria bonito no macOS, mas o picker próprio é o
    // comportamento único e testável em todo SO — contrato do M6
    { useSystemPicker: false },
  );
  console.log("[picker] setDisplayMediaRequestHandler registrado (Go Live)");
}

/** Abre a janelinha e resolve com a fonte escolhida, ou null (cancelado). */
async function openPicker(parent: BrowserWindow | null): Promise<Electron.DesktopCapturerSource | null> {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: THUMB,
    fetchWindowIcons: true,
  });

  const win = new BrowserWindow({
    width: 720,
    height: 540,
    ...(parent !== null ? { parent } : {}),
    modal: parent !== null,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: "#14181e",
    title: "Transmitir — escolha uma fonte",
    webPreferences: {
      preload: path.join(__dirname, "picker-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // serialização para o renderer do picker: NativeImage não cruza a ponte —
  // thumbnails e ícones viram data URLs (imagens pequenas, custo ok)
  const serialized: PickerSource[] = sources.map((s) => ({
    id: s.id,
    name: s.name,
    // ids têm a forma "screen:x:y" / "window:x:y" — o prefixo é o tipo
    kind: s.id.startsWith("screen:") ? "screen" : "window",
    thumbnail_data_url: s.thumbnail.toDataURL(),
    app_icon_data_url: s.appIcon !== null && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
  }));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Electron.DesktopCapturerSource | null): void => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("picker:choose", onChoose);
      ipcMain.removeListener("picker:cancel", onCancel);
      if (!win.isDestroyed()) win.close();
      resolve(value);
    };

    const onChoose = (ev: Electron.IpcMainEvent, id: unknown): void => {
      // só o webContents DESTA janelinha manda aqui; e o id precisa casar com
      // uma fonte real da lista que nós mesmos geramos — payload validado
      if (ev.sender !== win.webContents || typeof id !== "string") return;
      const source = sources.find((s) => s.id === id);
      if (source === undefined) return;
      finish(source);
    };
    const onCancel = (ev: Electron.IpcMainEvent): void => {
      if (ev.sender !== win.webContents) return;
      finish(null);
    };

    ipcMain.on("picker:choose", onChoose);
    ipcMain.on("picker:cancel", onCancel);
    // fechar no X (ou Esc via cancel → close): pedido negado
    win.on("closed", () => finish(null));

    win.webContents.on("did-finish-load", () => {
      win.webContents.send("picker:sources", serialized);
      win.show();
    });
    void win.loadFile(path.join(__dirname, "picker.html")).catch((err: unknown) => {
      console.error("[picker] loadFile do picker.html falhou", err);
      finish(null);
    });
  });
}
