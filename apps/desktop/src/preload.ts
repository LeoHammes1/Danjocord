import { contextBridge, ipcRenderer } from "electron";

/**
 * A PONTE (contrato do M6): superfície EXATA que o bundle web consome via
 * window.danjocord (o pacote B declara o tipo em apps/client/src/desktop.d.ts).
 * Nada de expor ipcRenderer cru — cada método fala com UM canal validado no
 * main; payloads são primitivos.
 *
 * serverUrl chega por additionalArguments (process.argv) — síncrono e sem
 * round-trip de IPC no boot do renderer.
 */

interface DanjocordDesktop {
  isDesktop: true;
  serverUrl: string;
  secretGet(key: string): Promise<string | null>;
  secretSet(key: string, value: string | null): Promise<void>;
  /** grava vários numa transação só — o trio de sessão não pode ir pela metade */
  secretSetMany(entries: [string, string | null][]): Promise<void>;
  oauthLogin(inviteCode?: string | null): Promise<string>;
  pttSetKey(keycode: number | null): Promise<void>;
  pttCaptureNextKey(): Promise<{ keycode: number; label: string }>;
  onPtt(cb: (down: boolean) => void): void;
}

const SERVER_URL_FLAG = "--danjocord-server-url=";
const serverUrl =
  process.argv.find((a) => a.startsWith(SERVER_URL_FLAG))?.slice(SERVER_URL_FLAG.length) ?? "http://localhost:8080";

const bridge: DanjocordDesktop = {
  isDesktop: true,
  serverUrl,
  secretGet(key) {
    return ipcRenderer.invoke("secret:get", key) as Promise<string | null>;
  },
  secretSet(key, value) {
    return ipcRenderer.invoke("secret:set", key, value) as Promise<void>;
  },
  secretSetMany(entries) {
    return ipcRenderer.invoke("secret:set-many", entries) as Promise<void>;
  },
  oauthLogin(inviteCode) {
    return ipcRenderer.invoke("oauth:login", inviteCode ?? null) as Promise<string>;
  },
  pttSetKey(keycode) {
    return ipcRenderer.invoke("ptt:set-key", keycode) as Promise<void>;
  },
  pttCaptureNextKey() {
    return ipcRenderer.invoke("ptt:capture-next") as Promise<{ keycode: number; label: string }>;
  },
  onPtt(cb) {
    ipcRenderer.on("ptt", (_ev, down: unknown) => cb(down === true));
  },
};

contextBridge.exposeInMainWorld("danjocord", bridge);
