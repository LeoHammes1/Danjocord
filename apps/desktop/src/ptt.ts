import { UiohookKey, uIOhook, type UiohookKeyboardEvent } from "uiohook-napi";

/**
 * Push-to-talk GLOBAL (doc §7): hook de teclado de SO via uiohook-napi. O
 * globalShortcut do Electron NÃO serve para PTT — não separa keydown de keyup
 * e CONSOME a tecla (o jogo embaixo nunca a veria). O uiohook só OBSERVA:
 * a tecla continua chegando ao app em foco, que é exatamente o que PTT pede.
 *
 * Ciclo de vida: uIOhook.start() é LAZY — só no primeiro pttSetKey não-null
 * (ou numa captura); pttSetKey(null) para o hook de verdade (contrato do M6).
 * Sem tecla configurada e sem captura pendente, nenhum hook fica instalado —
 * zero overhead e zero paranoia de keylogger.
 *
 * Restrição: roda no MAIN (o renderer não pode ter hook global); o transporte
 * até a UI é o webContents.send("ptt", down) injetado via setPttEmitter.
 */

let emitter: ((down: boolean) => void) | null = null;
let hookRunning = false;
let configuredKeycode: number | null = null;
/** a tecla configurada está fisicamente pressionada AGORA (dedupe do auto-repeat) */
let isDown = false;

interface Capture {
  resolve: (v: { keycode: number; label: string }) => void;
  reject: (err: Error) => void;
}
let pendingCapture: Capture | null = null;

/** Quem recebe os eventos down/up (o main conecta ao webContents da janela). */
export function setPttEmitter(fn: (down: boolean) => void): void {
  emitter = fn;
}

// ---------------------------------------------------------------------------
// Labels legíveis para o botão de remap da UI
// ---------------------------------------------------------------------------

/** nomes do UiohookKey que merecem tradução/símbolo; o resto usa o nome cru */
const LABEL_OVERRIDES: Record<string, string> = {
  Space: "Espaço",
  Enter: "Enter",
  Backspace: "Backspace",
  Tab: "Tab",
  CapsLock: "Caps Lock",
  Escape: "Esc",
  PageUp: "Page Up",
  PageDown: "Page Down",
  ArrowLeft: "Seta ←",
  ArrowUp: "Seta ↑",
  ArrowRight: "Seta →",
  ArrowDown: "Seta ↓",
  Ctrl: "Ctrl esquerdo",
  CtrlRight: "Ctrl direito",
  Alt: "Alt",
  AltRight: "Alt direito",
  Shift: "Shift esquerdo",
  ShiftRight: "Shift direito",
  Meta: "Win",
  MetaRight: "Win direito",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Slash: "/",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Quote: "'",
  NumpadMultiply: "Numpad *",
  NumpadAdd: "Numpad +",
  NumpadSubtract: "Numpad -",
  NumpadDecimal: "Numpad .",
  NumpadDivide: "Numpad /",
};

/** keycode → label, construído uma vez a partir da tabela do uiohook */
const KEY_LABELS: Map<number, string> = (() => {
  const map = new Map<number, string>();
  for (const [name, code] of Object.entries(UiohookKey as unknown as Record<string, number>)) {
    if (typeof code !== "number") continue;
    if (!map.has(code)) map.set(code, LABEL_OVERRIDES[name] ?? name.replace(/^Numpad(\d)$/, "Numpad $1"));
  }
  return map;
})();

export function labelForKeycode(keycode: number): string {
  return KEY_LABELS.get(keycode) ?? `tecla ${keycode}`;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

function onKeydown(e: UiohookKeyboardEvent): void {
  if (pendingCapture !== null) {
    // modo captura consome o evento: a tecla capturada não vira PTT no mesmo press
    const cap = pendingCapture;
    pendingCapture = null;
    cap.resolve({ keycode: e.keycode, label: labelForKeycode(e.keycode) });
    stopIfIdle();
    return;
  }
  if (configuredKeycode === null || e.keycode !== configuredKeycode) return;
  if (isDown) return; // auto-repeat do SO: só a TRANSIÇÃO interessa
  isDown = true;
  emitter?.(true);
}

function onKeyup(e: UiohookKeyboardEvent): void {
  if (configuredKeycode === null || e.keycode !== configuredKeycode) return;
  if (!isDown) return; // keyup órfão (ex.: o keydown foi engolido por uma captura)
  isDown = false;
  emitter?.(false);
}

function ensureStarted(): void {
  if (hookRunning) return;
  uIOhook.on("keydown", onKeydown);
  uIOhook.on("keyup", onKeyup);
  uIOhook.start();
  hookRunning = true;
  console.log("[ptt] uiohook iniciado (hook global de teclado ativo)");
}

function stopIfIdle(): void {
  // "desligado" de verdade: sem tecla configurada E sem captura pendente,
  // o hook global sai da memória (contrato: pttSetKey(null) para o uiohook)
  if (!hookRunning || configuredKeycode !== null || pendingCapture !== null) return;
  uIOhook.stop();
  uIOhook.removeListener("keydown", onKeydown);
  uIOhook.removeListener("keyup", onKeyup);
  hookRunning = false;
  console.log("[ptt] uiohook parado (PTT desligado)");
}

export function pttSetKey(keycode: number | null): void {
  // trocar/desligar com a tecla segurada não pode deixar o mic aberto preso
  if (isDown) {
    isDown = false;
    emitter?.(false);
  }
  configuredKeycode = keycode;
  if (keycode === null) {
    stopIfIdle();
    return;
  }
  ensureStarted();
  console.log(`[ptt] tecla configurada: ${labelForKeycode(keycode)} (keycode ${keycode})`);
}

export function pttCaptureNextKey(): Promise<{ keycode: number; label: string }> {
  // uma captura nova substitui a anterior (dois cliques em "definir tecla")
  if (pendingCapture !== null) {
    pendingCapture.reject(new Error("captura substituída por outra"));
    pendingCapture = null;
  }
  ensureStarted();
  return new Promise((resolve, reject) => {
    pendingCapture = { resolve, reject };
  });
}

/** Encerramento limpo no quit — uiohook vivo segura o processo. */
export function pttShutdown(): void {
  if (pendingCapture !== null) {
    pendingCapture.reject(new Error("aplicativo encerrando"));
    pendingCapture = null;
  }
  configuredKeycode = null;
  isDown = false;
  if (hookRunning) {
    uIOhook.stop();
    hookRunning = false;
  }
}
