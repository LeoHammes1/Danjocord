import { contextBridge, ipcRenderer } from "electron";

/**
 * Preload EXCLUSIVO da janelinha do picker de Go Live — não confundir com o
 * preload da janela principal (preload.ts): este só conecta a lista de fontes
 * e a escolha; nenhum canal de segredo/PTT/OAuth passa por aqui.
 */

/** espelho serializável do DesktopCapturerSource (thumbnails viram data URLs) */
export interface PickerSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnail_data_url: string;
  app_icon_data_url: string | null;
}

contextBridge.exposeInMainWorld("danjocordPicker", {
  // só o Windows manda o áudio do sistema junto (audio: "loopback" no
  // picker.ts) — a UI usa isto para avisar antes do clique (revisão M6 #3)
  systemAudio: process.platform === "win32",
  onSources(cb: (sources: PickerSource[]) => void): void {
    ipcRenderer.on("picker:sources", (_ev, sources: PickerSource[]) => cb(sources));
  },
  choose(id: string): void {
    ipcRenderer.send("picker:choose", id);
  },
  cancel(): void {
    ipcRenderer.send("picker:cancel");
  },
});
