/**
 * Pad do soundboard (M9) — a grade no rodapé de voz, o upload e a edição.
 *
 * Nada disto existe no index.html: o `mountSoundboard()` cria tudo em JS e
 * pendura em dois pontos do rodapé de voz (`.voice-footer-actions` e o próprio
 * `#voice-footer`). Não é preferência de estilo — o index.html tem dono único
 * (o integrador) e o pad inteiro é deste módulo; o preço é este bloco de
 * construção no `build()`, e o ganho é que a área de som cabe num arquivo só.
 *
 * A divisão com `sound/soundboard.ts` é a mesma do M8: LÁ mora o catálogo, o
 * cache de buffers, a política de "toca ou não toca" e as rotas; AQUI só mora
 * o DOM e o que o dedo faz. Este arquivo não decide se um som toca — ele
 * relata o evento e a política responde.
 *
 * Como no M7, o módulo não conhece o `state` do main.ts nem o VoiceClient:
 * tudo entra pelo UiContext (getters vivos montados no main.ts).
 */
import { isStaff, type Sound, type VoiceSoundboardData } from "@danjocord/protocol";
import {
  analyzeAudioFile,
  deleteSound,
  ensureBuffer,
  fetchSounds,
  getSound,
  getSoundboardPrefs,
  isUserSilenced,
  listSounds,
  MAX_BYTES,
  MAX_DURATION_MS,
  MAX_NAME_LENGTH,
  nameFromFile,
  playFromEvent,
  PLAY_COOLDOWN_MS,
  preloadCatalog,
  previewBuffer,
  removeSound,
  renameSound,
  requestPlay,
  setCatalog,
  setSoundboardEnabled,
  setSoundboardVolume,
  setUserSilenced,
  SoundboardError,
  stopAllSounds,
  stopPreview,
  subscribeCatalog,
  subscribeSoundboardPrefs,
  upsertSound,
  uploadSound,
  type SoundAnalysis,
  type SoundboardPrefs,
} from "../sound/soundboard.js";
import type { UiContext } from "./context.js";
import { icon } from "./icons.js";

/** quanto tempo o anel de "quem tocou" e o brilho do pad ficam de pé */
const FLASH_MS = 900;
/** quanto tempo uma mensagem de status fica visível antes de sumir sozinha */
const STATUS_MS = 4000;
/** teclas 1..9 acionam os nove primeiros sons enquanto o pad está aberto */
const HOTKEYS = 9;

let ctx: UiContext | null = null;
let mounted = false;
/** o pad está aberto? é estado VISUAL do rodapé, por isso mora aqui e não no UiState */
let open = false;

// ---------------------------------------------------------------------------
// Helpers de DOM (os mesmos do ui/settings.ts — o cliente não usa innerHTML)
// ---------------------------------------------------------------------------

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function button(className: string, label: string): HTMLButtonElement {
  const btn = make("button", className, label);
  btn.type = "button";
  return btn;
}

// ---------------------------------------------------------------------------
// Nós fixos do pad
// ---------------------------------------------------------------------------

const toggle = button("icon-btn", "");
const panel = make("div");
const grid = make("div", "sb-grid");
const empty = make(
  "p",
  "sb-empty",
  "Nenhum som ainda. Suba o primeiro — ele fica disponível para todo mundo do servidor.",
);
const status = make("p", "sb-status");
const addBtn = button("sb-add", "");

// ---------------------------------------------------------------------------
// Status (uma linha só, para erro e para "fulano tocou X")
// ---------------------------------------------------------------------------

let statusTimer: number | undefined;

/**
 * `action` é o botão de "silenciar esta pessoa" (ROADMAP 27), e ele nasce
 * JUNTO do "fulano tocou X" de propósito: o momento em que alguém quer calar
 * um som é o momento em que o som acabou de tocar. Enterrar isso numa lista de
 * configurações é o mesmo que não ter.
 */
function setStatus(text: string, kind: "info" | "error", action: HTMLButtonElement | null = null): void {
  const label = make("span", "", text);
  if (action === null) status.replaceChildren(label);
  else status.replaceChildren(label, action);
  status.classList.toggle("is-error", kind === "error");
  status.hidden = text === "";
  if (statusTimer !== undefined) clearTimeout(statusTimer);
  if (text === "") return;
  statusTimer = window.setTimeout(() => {
    status.replaceChildren();
    status.hidden = true;
  }, STATUS_MS);
}

/** O botão que acompanha o "fulano tocou X" — alterna o silêncio daquela pessoa. */
function silenceAction(userId: string, username: string): HTMLButtonElement {
  const silenced = isUserSilenced(userId);
  const btn = button("sb-silence", silenced ? "voltar a ouvir" : "silenciar");
  btn.setAttribute("aria-label", silenced ? `Voltar a ouvir os sons de ${username}` : `Silenciar os sons de ${username}`);
  btn.addEventListener("click", () => {
    const next = !isUserSilenced(userId);
    setUserSilenced(userId, next);
    setStatus(
      next ? `você não vai mais ouvir os sons de ${username}` : `sons de ${username} liberados`,
      "info",
      silenceAction(userId, username),
    );
  });
  return btn;
}

/** Erro vindo das rotas já chega traduzido (sound/soundboard.ts); o resto é rede. */
function errorText(err: unknown): string {
  if (err instanceof SoundboardError) return err.message;
  if (err instanceof Error && err.message !== "") return err.message;
  return "algo deu errado";
}

// ---------------------------------------------------------------------------
// Cooldown VISÍVEL
//
// O servidor limita a 1 som a cada 2 s por usuário (e 5 a cada 10 s por canal)
// e responde 429 com `retry_after`. Duas coisas acontecem aqui: (a) depois de
// um aperto bem-sucedido o pad já se tranca por PLAY_COOLDOWN_MS — espelhar a
// regra do servidor evita pedir um 429 de propósito a cada dedada dupla; (b)
// quando o 429 vem mesmo assim (o teto do CANAL, que eu não tenho como
// prever), quem manda no relógio é o `retry_after` da resposta.
//
// A espera fica DESENHADA no botão que foi apertado — falhar em silêncio é o
// que faz a pessoa apertar mais forte.
// ---------------------------------------------------------------------------

let cooldownUntil = 0;
let cooldownTimer: number | undefined;
let cooldownPad: string | null = null;

function coolingMs(): number {
  return Math.max(0, cooldownUntil - performance.now());
}

function paintCooldown(): void {
  const left = coolingMs();
  for (const pad of grid.querySelectorAll<HTMLButtonElement>(".sb-pad")) {
    pad.disabled = left > 0;
    const wait = pad.querySelector(".sb-wait");
    const isTarget = left > 0 && pad.dataset["soundId"] === cooldownPad;
    if (isTarget) {
      const text = `${Math.ceil(left / 1000)}s`;
      if (wait === null) {
        const span = make("span", "sb-wait", text);
        span.setAttribute("aria-hidden", "true"); // o disabled já conta a história ao leitor de tela
        pad.append(span);
      } else {
        wait.textContent = text;
      }
    } else if (wait !== null) {
      wait.remove();
    }
  }
}

function startCooldown(ms: number, soundId: string | null): void {
  cooldownUntil = Math.max(cooldownUntil, performance.now() + ms);
  cooldownPad = soundId;
  paintCooldown();
  if (cooldownTimer !== undefined) return;
  cooldownTimer = window.setInterval(() => {
    if (coolingMs() > 0) {
      paintCooldown();
      return;
    }
    clearInterval(cooldownTimer);
    cooldownTimer = undefined;
    cooldownPad = null;
    paintCooldown();
  }, 200);
}

function cancelCooldown(): void {
  cooldownUntil = 0;
  cooldownPad = null;
  if (cooldownTimer !== undefined) {
    clearInterval(cooldownTimer);
    cooldownTimer = undefined;
  }
  paintCooldown();
}

// ---------------------------------------------------------------------------
// A grade
// ---------------------------------------------------------------------------

/**
 * Quem pode renomear/apagar. A REGRA é do servidor (autor ou admin; embutido
 * só admin) — aqui só se evita OFERECER o que seria recusado, que é diferente
 * de proteger: um cliente modificado continua batendo na rota e levando 403.
 */
function canManage(sound: Sound): boolean {
  const me = ctx?.state.me ?? null;
  if (me === null) return false;
  if (isStaff(me)) return true; // M10: cargo no lugar do booleano
  return sound.uploader_id === me.id;
}

function padCell(sound: Sound, index: number): HTMLElement {
  const cell = make("div", "sb-cell");

  const pad = button("sb-pad", "");
  pad.dataset["soundId"] = sound.id;
  pad.setAttribute("aria-label", `Tocar ${sound.name}`);
  pad.title = `Tocar ${sound.name}`;
  if (index < HOTKEYS) {
    const key = String(index + 1);
    const hint = make("span", "sb-key", key);
    hint.setAttribute("aria-hidden", "true"); // quem lê a tela recebe o atalho pelo aria-keyshortcuts
    pad.setAttribute("aria-keyshortcuts", key);
    pad.append(hint);
  }
  pad.append(make("span", "sb-name", sound.name));
  pad.addEventListener("click", () => void press(sound.id));
  cell.append(pad);

  if (canManage(sound)) {
    const edit = button("sb-edit icon-btn", "");
    edit.setAttribute("aria-label", `Editar ${sound.name}`);
    edit.title = "Renomear ou apagar";
    edit.append(icon("pencil", 14));
    edit.addEventListener("click", () => openDialog({ kind: "edit", sound }, edit));
    cell.append(edit);
  }
  return cell;
}

function renderGrid(): void {
  const sounds = listSounds();
  grid.replaceChildren(...sounds.map((s, i) => padCell(s, i)));
  empty.hidden = sounds.length > 0;
  paintCooldown();
}

// ---------------------------------------------------------------------------
// Tocar
// ---------------------------------------------------------------------------

/**
 * Apertar NÃO toca nada aqui. O som (o meu inclusive) sai do `VOICE_SOUNDBOARD`
 * que volta pelo gateway, para existir UM caminho de reprodução só — igual para
 * quem apertou e para quem ouviu. É o que evita a regra "e no meu cliente o eco
 * próprio funciona diferente", que é onde bugs de soundboard moram.
 */
async function press(soundId: string): Promise<void> {
  if (coolingMs() > 0) return;
  startCooldown(PLAY_COOLDOWN_MS, soundId);
  try {
    await requestPlay(soundId);
  } catch (err) {
    // 429 tem a verdade sobre o relógio; qualquer outro erro libera o pad na
    // hora — travar 2 s depois de uma falha seria punir duas vezes
    if (err instanceof SoundboardError && err.retryAfter !== null) {
      startCooldown(err.retryAfter * 1000, soundId);
    } else {
      cancelCooldown();
    }
    setStatus(errorText(err), "error");
  }
}

const flashTimers = new Map<string, number>();

function flash(selector: string, className: string, key: string): void {
  const nodes = [...document.querySelectorAll<HTMLElement>(selector)];
  for (const node of nodes) node.classList.add(className);
  const previous = flashTimers.get(key);
  if (previous !== undefined) clearTimeout(previous);
  flashTimers.set(
    key,
    window.setTimeout(() => {
      flashTimers.delete(key);
      for (const node of nodes) node.classList.remove(className);
    }, FLASH_MS),
  );
}

/**
 * "Quem tocou" (ROADMAP 28) na MESMA linguagem visual do `.speaking`: o anel
 * em volta do avatar na lista de participantes. Os nós são da sidebar (que não
 * é minha), mas o `data-voice-user` é contrato público dela — é por ele que o
 * `updateSpeaking` já acha as mesmas linhas. Um re-render da lista no meio dos
 * 900 ms apaga o anel; é transitório e não vale acoplar os dois módulos.
 */
function ringUser(userId: string): void {
  flash(`[data-voice-user="${CSS.escape(userId)}"]`, "sb-hit", `user:${userId}`);
}

/**
 * VOICE_SOUNDBOARD do gateway. Ver e OUVIR são decisões diferentes: quem eu
 * silenciei continua aparecendo (senão o pad fica "com fantasma" — som que
 * todo mundo comenta e eu não vejo de onde veio), só não sai áudio.
 */
export function handleSoundboardEvent(ev: VoiceSoundboardData): void {
  const c = ctx;
  if (c === null) return;
  if (ev.channel_id !== c.state.voiceChannelId) return; // canal alheio: não me diz respeito

  playFromEvent(ev, {
    meId: c.state.me?.id ?? null,
    deafened: c.state.selfDeaf,
    voiceChannelId: c.state.voiceChannelId,
  });

  ringUser(ev.user_id);
  flash(`.sb-pad[data-sound-id="${CSS.escape(ev.sound_id)}"]`, "sb-flash", `sound:${ev.sound_id}`);

  const mine = ev.user_id === c.state.me?.id;
  const who = mine ? "Você" : (c.state.members.get(ev.user_id)?.username ?? `user-${ev.user_id.slice(-4)}`);
  const name = getSound(ev.sound_id)?.name ?? "um som";
  const muted = !mine && isUserSilenced(ev.user_id);
  setStatus(
    `${who} tocou ${name}${muted ? " (silenciado)" : ""}`,
    "info",
    mine ? null : silenceAction(ev.user_id, who),
  );
}

// ---------------------------------------------------------------------------
// Abrir/fechar o pad
// ---------------------------------------------------------------------------

function setOpen(next: boolean): void {
  open = next;
  panel.hidden = !next;
  toggle.setAttribute("aria-expanded", String(next));
  toggle.title = next ? "Fechar o soundboard" : "Abrir o soundboard";
  if (!next) return;
  // Pad vazio ao abrir: ou a guild não tem som nenhum, ou o catálogo do READY
  // não chegou até aqui. O GET custa uma requisição e resolve o segundo caso —
  // e é barato porque o teto da guild é 100 registros sem bytes.
  if (listSounds().length === 0) {
    void fetchSounds()
      .then(setCatalog)
      .catch((err: unknown) => console.warn("soundboard: falha ao listar os sons", err));
  }
  // ABRIR é o sinal de intenção: é aqui que se paga o download dos bytes (ver
  // o cabeçalho de sound/soundboard.ts). Idempotente — o que já está em cache
  // não é baixado de novo.
  preloadCatalog();
}

// ---------------------------------------------------------------------------
// Construção
// ---------------------------------------------------------------------------

function build(): boolean {
  // a fileira de ações é filha do #voice-footer: pendurar nela põe o pad no
  // rodapé sem este módulo precisar conhecer a estrutura inteira de lá
  const actions = document.querySelector<HTMLElement>(".voice-footer-actions");
  const leave = document.getElementById("voice-leave");
  if (actions === null) return false;

  toggle.id = "soundboard-toggle";
  toggle.setAttribute("aria-label", "Soundboard");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "soundboard");
  toggle.title = "Abrir o soundboard";
  toggle.append(icon("volume"));
  toggle.addEventListener("click", () => setOpen(!open));
  // antes do "Sair", que é o único irreversível do rodapé e mora na ponta
  if (leave !== null) leave.before(toggle);
  else actions.append(toggle);

  panel.id = "soundboard";
  panel.hidden = true;

  const head = make("div", "sb-head");
  const title = make("span", "sb-title", "Sons");
  addBtn.setAttribute("aria-label", "Adicionar som");
  addBtn.title = "Adicionar som";
  addBtn.append(icon("plus", 14), make("span", "", "adicionar"));
  addBtn.addEventListener("click", () => openDialog({ kind: "upload" }, addBtn));
  head.append(title, addBtn);

  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", "Sons do servidor");

  status.id = "soundboard-status";
  // polite: o pad fala o tempo todo ("fulano tocou X") e interromper a leitura
  // de outra coisa por causa disso seria pior que não anunciar
  status.setAttribute("aria-live", "polite");
  status.hidden = true;

  panel.append(head, grid, empty, status);
  // logo abaixo da fileira de botões, ANTES do bloco de push-to-talk: o pad é
  // parte dos controles da chamada, não um apêndice do rodapé
  actions.after(panel);

  // arrastar um arquivo em cima do pad abre o diálogo já com ele — o caminho
  // mais curto entre "achei um som" e "está no servidor"
  panel.addEventListener("dragover", (ev) => {
    if (!hasFile(ev)) return;
    ev.preventDefault();
    panel.classList.add("sb-dragging");
  });
  // relatedTarget e não `target === panel`: o dragleave dispara ao passar por
  // cada filho, e comparar o alvo deixaria o realce aceso depois de o arquivo
  // sair da área sem ser solto
  panel.addEventListener("dragleave", (ev) => {
    const to = ev.relatedTarget;
    if (to instanceof Node && panel.contains(to)) return;
    panel.classList.remove("sb-dragging");
  });
  panel.addEventListener("drop", (ev) => {
    panel.classList.remove("sb-dragging");
    const file = fileFrom(ev);
    if (file === null) return;
    ev.preventDefault();
    openDialog({ kind: "upload" }, addBtn);
    void takeFile(file);
  });

  document.addEventListener("keydown", onHotkey);
  return true;
}

/**
 * Teclas 1..9 (ROADMAP 26). Só com o pad aberto, e nunca por cima de quem está
 * escrevendo: o composer é um <textarea> e um "1" ali é um "1", não uma buzina.
 * O `#app` inert significa que há um diálogo modal na frente (o meu ou o de
 * configurações) — teclado do fundo não responde.
 */
function onHotkey(ev: KeyboardEvent): void {
  if (!open || ev.repeat) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
  if (active instanceof HTMLElement && active.isContentEditable) return;
  if (document.getElementById("app")?.inert === true) return;
  const n = Number(ev.key);
  if (!Number.isInteger(n) || n < 1 || n > HOTKEYS) return;
  const sound = listSounds()[n - 1];
  if (sound === undefined) return;
  ev.preventDefault();
  void press(sound.id);
}

/**
 * Liga o pad. Chamar UMA vez, depois do DOM e antes do primeiro render (o
 * mesmo contrato do mountSidebar).
 */
export function mountSoundboard(context: UiContext): void {
  if (mounted) return;
  ctx = context;
  if (!build()) return; // rodapé de voz ausente (index.html mudou): sem pad, sem quebrar
  mounted = true;
  // o catálogo muda por evento do gateway; quem redesenha é a inscrição, não
  // o render de voz — assim um VOICE_STATE_UPDATE não recria 100 botões
  subscribeCatalog(renderGrid);
  renderGrid();
}

let lastMeId: string | null = null;

/**
 * Chamar do `renderVoiceUi()` do main.ts. NÃO redesenha a grade de propósito
 * (ver o comentário do mountSoundboard): aqui só se cuida do que depende do
 * estado de voz.
 */
export function renderSoundboard(): void {
  const c = ctx;
  if (c === null || !mounted) return;
  // saber quem eu sou é o que decide o lápis de editar em cada pad; antes do
  // READY não sei, e o catálogo pode já ter sido desenhado sem ele
  const meId = c.state.me?.id ?? null;
  if (meId !== lastMeId) {
    lastMeId = meId;
    renderGrid();
  }
  const inVoice = c.state.voiceChannelId !== null;
  // sair da voz fecha o pad e cala o que estiver tocando: o som é do canal, e
  // eu não estou mais nele
  if (!inVoice && open) setOpen(false);
  if (!inVoice) stopAllSounds();
  // ensurdecer com um som no ar tem que calar AGORA — a política já barra os
  // próximos, mas o que já começou continuaria até o fim
  if (c.state.selfDeaf) stopAllSounds();
}

// ---------------------------------------------------------------------------
// Catálogo: o que o integrador chama a partir dos dispatches
// ---------------------------------------------------------------------------

/** READY: `ready.sounds`. */
export function applySoundCatalog(sounds: readonly Sound[]): void {
  setCatalog(sounds);
}

/** SOUND_CREATE e SOUND_UPDATE — o mesmo caminho (o id manda). */
export function applySoundUpsert(sound: Sound): void {
  upsertSound(sound);
}

/** SOUND_DELETE. */
export function applySoundDelete(id: string): void {
  removeSound(id);
}

// ---------------------------------------------------------------------------
// Diálogo: adicionar som / editar som
//
// Um diálogo só, dois modos. A alternativa (menu de contexto para renomear +
// confirm nativo para apagar) espalharia foco e acessibilidade por três
// caminhos diferentes para três operações que são a mesma coisa: "mexer neste
// som". A armadilha de foco é a mesma do ui/settings.ts, pelos mesmos motivos.
//
// DÍVIDA CONHECIDA: o pacote de controles de voz do M9 extraiu essa casca para
// `ui/dialog.ts` (createDialog) enquanto este arquivo era escrito — os dois
// nasceram em paralelo. Esta é, portanto, a TERCEIRA cópia do overlay + inert +
// Esc + armadilha de Tab (settings.ts, dialog.ts e aqui). Migrar para a casca
// comum é uma tarefa de integração, não de última hora: falta a ela um título
// mutável (aqui ele alterna entre "Adicionar som" e "Editar som"), e trocar de
// casca sem poder ver a versão final do arquivo do outro pacote trocaria uma
// duplicação conhecida por um acoplamento não verificado. Está no relatório.
// ---------------------------------------------------------------------------

type DialogMode = { kind: "upload" } | { kind: "edit"; sound: Sound };

interface DialogNodes {
  overlay: HTMLElement;
  panel: HTMLElement;
  title: HTMLElement;
  drop: HTMLElement;
  file: HTMLInputElement;
  summary: HTMLElement;
  preview: HTMLButtonElement;
  swap: HTMLButtonElement;
  name: HTMLInputElement;
  counter: HTMLElement;
  error: HTMLElement;
  progress: HTMLElement;
  bar: HTMLElement;
  remove: HTMLButtonElement;
  submit: HTMLButtonElement;
}

const DIALOG_TITLE_ID = "sb-dialog-title";
/** `:disabled` e não `[disabled]`: é o que é focável AGORA (mesma nota do settings.ts) */
const FOCUSABLE = "button:not(:disabled), input:not(:disabled)";

let dlg: DialogNodes | null = null;
let mode: DialogMode = { kind: "upload" };
let pending: { file: File; analysis: SoundAnalysis } | null = null;
let busy = false;
/** o "Apagar" é de dois toques: o primeiro vira confirmação, o segundo apaga */
let confirmingDelete = false;
let returnFocusTo: HTMLElement | null = null;

function hasFile(ev: DragEvent): boolean {
  return [...(ev.dataTransfer?.types ?? [])].includes("Files");
}

function fileFrom(ev: DragEvent): File | null {
  return ev.dataTransfer?.files.item(0) ?? null;
}

function buildDialog(): DialogNodes {
  const overlay = make("div");
  overlay.id = "soundboard-dialog";
  overlay.hidden = true;

  const dialogPanel = make("div", "sb-dialog");
  dialogPanel.setAttribute("role", "dialog");
  dialogPanel.setAttribute("aria-modal", "true");
  dialogPanel.setAttribute("aria-labelledby", DIALOG_TITLE_ID);
  dialogPanel.tabIndex = -1; // alvo do foco inicial: o leitor anuncia o título antes de tudo
  overlay.append(dialogPanel);

  const head = make("header", "sb-dialog-head");
  const title = make("h2", "", "Adicionar som");
  title.id = DIALOG_TITLE_ID;
  const close = button("icon-btn", "");
  close.setAttribute("aria-label", "Fechar");
  close.title = "Fechar";
  close.append(icon("close"));
  close.addEventListener("click", () => closeDialog());
  head.append(title, close);

  const body = make("div", "sb-dialog-body");

  // --- área de arrastar-e-soltar (só no modo upload)
  const drop = make("div", "sb-drop");
  const dropText = make("p", "sb-drop-text", "Arraste um arquivo aqui");
  // os números saem das constantes e não do teclado: o dia em que o servidor
  // mudar um limite, esta frase muda junto
  const dropHint = make(
    "p",
    "sb-drop-hint",
    `ogg, wav ou mp3 · até ${MAX_DURATION_MS / 1000} s · até ${Math.round(MAX_BYTES / 1024)} KB`,
  );
  const pick = button("sb-pick", "Escolher arquivo");
  const file = make("input");
  file.type = "file";
  file.accept = ".ogg,.wav,.mp3,audio/ogg,audio/wav,audio/mpeg";
  file.id = "sb-file";
  file.className = "sb-file-input";
  pick.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const chosen = file.files?.item(0) ?? null;
    if (chosen !== null) void takeFile(chosen);
  });
  drop.append(dropText, dropHint, pick, file);

  drop.addEventListener("dragover", (ev) => {
    if (!hasFile(ev)) return;
    ev.preventDefault();
    drop.classList.add("is-over");
  });
  drop.addEventListener("dragleave", (ev) => {
    const to = ev.relatedTarget;
    if (to instanceof Node && drop.contains(to)) return;
    drop.classList.remove("is-over");
  });
  drop.addEventListener("drop", (ev) => {
    drop.classList.remove("is-over");
    const dropped = fileFrom(ev);
    if (dropped === null) return;
    ev.preventDefault();
    void takeFile(dropped);
  });

  // --- resumo do arquivo escolhido + prévia
  const summary = make("div", "sb-summary");
  summary.hidden = true;
  const preview = button("sb-preview", "Ouvir prévia");
  preview.addEventListener("click", () => {
    if (pending === null) return;
    // o ganho sugerido É o que vai valer no servidor: a prévia tem que soar
    // como o som vai soar depois, senão ela não serve de conferência
    previewBuffer(pending.analysis.buffer, pending.analysis.gain);
  });

  // "Trocar arquivo" devolve o diálogo ao estado de escolha sem fechá-lo — e é
  // criado UMA vez: recriá-lo a cada paint tiraria o foco de quem chegou nele
  // pelo teclado
  const swap = button("sb-swap", "Trocar arquivo");
  swap.addEventListener("click", () => {
    stopPreview();
    pending = null;
    file.value = "";
    setDialogError("");
    paintDialog();
  });

  // --- nome
  const nameRow = make("div", "sb-field");
  const nameLabel = make("label", "", "Nome");
  const name = make("input");
  name.type = "text";
  name.id = "sb-name";
  name.maxLength = MAX_NAME_LENGTH;
  name.autocomplete = "off";
  nameLabel.htmlFor = name.id;
  const counter = make("span", "sb-counter");
  counter.setAttribute("aria-hidden", "true"); // o maxlength já é anunciado pelo campo
  name.addEventListener("input", () => paintDialog());
  nameRow.append(nameLabel, counter, name);

  const error = make("p", "sb-error");
  error.setAttribute("aria-live", "assertive");
  error.hidden = true;

  const progress = make("div", "sb-progress");
  progress.hidden = true;
  const bar = make("div", "sb-bar");
  progress.append(bar);

  body.append(drop, summary, nameRow, error, progress);
  summary.append(preview);

  const foot = make("footer", "sb-dialog-foot");
  const remove = button("sb-remove", "Apagar som");
  remove.addEventListener("click", () => void onDelete());
  const cancel = button("sb-cancel", "Cancelar");
  cancel.addEventListener("click", () => closeDialog());
  const submit = button("sb-submit", "Enviar");
  submit.addEventListener("click", () => void onSubmit());
  foot.append(remove, cancel, submit);

  dialogPanel.append(head, body, foot);

  overlay.addEventListener("keydown", onDialogKeydown);
  // pointerdown e não click: arrastar de dentro para fora e soltar no fundo
  // não pode fechar (mesma armadilha resolvida no settings.ts)
  overlay.addEventListener("pointerdown", (ev) => {
    if (ev.target === overlay) closeDialog();
  });

  document.body.append(overlay);
  return {
    overlay,
    panel: dialogPanel,
    title,
    drop,
    file,
    summary,
    preview,
    swap,
    name,
    counter,
    error,
    progress,
    bar,
    remove,
    submit,
  };
}

function ensureDialog(): DialogNodes {
  dlg ??= buildDialog();
  return dlg;
}

function onDialogKeydown(ev: KeyboardEvent): void {
  const d = dlg;
  if (d === null) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeDialog();
    return;
  }
  if (ev.key === "Enter" && ev.target === d.name && !d.submit.disabled) {
    ev.preventDefault();
    void onSubmit();
    return;
  }
  if (ev.key !== "Tab") return;
  const items = [...d.panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
  const first = items.at(0);
  const last = items.at(-1);
  if (first === undefined || last === undefined) return;
  const active = document.activeElement;
  if (ev.shiftKey && (active === first || active === d.panel)) {
    last.focus();
    ev.preventDefault();
  } else if (!ev.shiftKey && active === last) {
    first.focus();
    ev.preventDefault();
  }
}

function setDialogError(text: string): void {
  const d = ensureDialog();
  d.error.textContent = text;
  d.error.hidden = text === "";
}

function paintDialog(): void {
  const d = ensureDialog();
  const upload = mode.kind === "upload";
  d.title.textContent = upload ? "Adicionar som" : "Editar som";
  d.drop.hidden = !upload || pending !== null;
  d.summary.hidden = !upload || pending === null;
  d.remove.hidden = upload;
  d.remove.textContent = confirmingDelete ? "Confirmar exclusão" : "Apagar som";
  d.remove.classList.toggle("is-confirming", confirmingDelete);
  d.submit.textContent = upload ? "Enviar" : "Salvar";

  const trimmed = d.name.value.trim();
  d.counter.textContent = `${[...trimmed].length}/${MAX_NAME_LENGTH}`;
  const nameOk = trimmed.length > 0 && [...trimmed].length <= MAX_NAME_LENGTH;
  d.submit.disabled = busy || !nameOk || (upload && pending === null);
  d.name.disabled = busy;
  d.preview.disabled = busy;
  d.swap.disabled = busy;
  d.remove.disabled = busy;
  d.progress.hidden = !busy;

  if (pending !== null) {
    const { analysis, file } = pending;
    const seconds = (analysis.durationMs / 1000).toFixed(2);
    const kb = Math.round(file.size / 1024);
    // o ganho aparece porque ele MUDA o que a pessoa vai ouvir: sem isso a
    // prévia soando diferente do arquivo original parece defeito
    d.summary.replaceChildren(
      make("p", "sb-summary-name", file.name),
      make("p", "sb-summary-meta", `${seconds} s · ${kb} KB · volume ajustado em ${analysis.gain.toFixed(2)}×`),
      d.preview,
      d.swap,
    );
  }
}

/** Arquivo escolhido (botão ou arrastado): valida, decodifica e mede o ganho. */
async function takeFile(file: File): Promise<void> {
  const d = ensureDialog();
  setDialogError("");
  try {
    const analysis = await analyzeAudioFile(file);
    pending = { file, analysis };
    if (d.name.value.trim() === "") d.name.value = nameFromFile(file);
    paintDialog();
  } catch (err) {
    pending = null;
    d.file.value = ""; // sem isto, escolher o MESMO arquivo de novo não dispara change
    setDialogError(errorText(err));
    paintDialog();
  }
}

async function onSubmit(): Promise<void> {
  const d = ensureDialog();
  const name = d.name.value.trim();
  if (busy || name === "") return;
  busy = true;
  setDialogError("");
  d.bar.style.width = "0%";
  paintDialog();
  try {
    if (mode.kind === "upload") {
      if (pending === null) return;
      const sound = await uploadSound(pending.file, name, pending.analysis.gain, (fraction) => {
        d.bar.style.width = `${Math.round(fraction * 100)}%`;
      });
      // upsert com a resposta do 201: o SOUND_CREATE do gateway repete o mesmo
      // registro e é idempotente — o pad não fica esperando o eco para mostrar
      // o que a própria pessoa acabou de subir
      upsertSound(sound);
      setStatus(`“${sound.name}” foi adicionado`, "info");
    } else {
      const sound = await renameSound(mode.sound.id, name);
      upsertSound(sound);
      setStatus(`renomeado para “${sound.name}”`, "info");
    }
    closeDialog();
  } catch (err) {
    setDialogError(errorText(err));
  } finally {
    busy = false;
    paintDialog();
  }
}

async function onDelete(): Promise<void> {
  if (mode.kind !== "edit" || busy) return;
  if (!confirmingDelete) {
    // exclusão é definitiva (o BLOB sai do banco) e o botão fica ao lado do
    // "Salvar": um toque só seria acidente esperando acontecer
    confirmingDelete = true;
    paintDialog();
    return;
  }
  busy = true;
  paintDialog();
  const id = mode.sound.id;
  const name = mode.sound.name;
  try {
    await deleteSound(id);
    removeSound(id);
    setStatus(`“${name}” foi apagado`, "info");
    closeDialog();
  } catch (err) {
    setDialogError(errorText(err));
  } finally {
    busy = false;
    paintDialog();
  }
}

function setBackgroundInert(inert: boolean): void {
  const app = document.getElementById("app");
  if (app !== null) app.inert = inert;
}

function openDialog(next: DialogMode, opener: HTMLElement): void {
  const d = ensureDialog();
  mode = next;
  pending = null;
  busy = false;
  confirmingDelete = false;
  d.file.value = "";
  d.name.value = next.kind === "edit" ? next.sound.name : "";
  setDialogError("");
  paintDialog();
  if (!d.overlay.hidden) {
    d.panel.focus();
    return;
  }
  returnFocusTo = opener;
  d.overlay.hidden = false;
  setBackgroundInert(true);
  d.panel.focus();
}

function closeDialog(): void {
  const d = dlg;
  if (d === null || d.overlay.hidden) return;
  stopPreview(); // fechar no meio da prévia não pode deixar o som tocando sozinho
  pending = null;
  busy = false;
  confirmingDelete = false;
  d.overlay.hidden = true;
  setBackgroundInert(false);
  // sem isto quem abriu pelo teclado volta com o foco no <body>, no fim do
  // documento (mesmo cuidado do menu da engrenagem e do diálogo de som)
  returnFocusTo?.focus();
  returnFocusTo = null;
}

// ---------------------------------------------------------------------------
// Seção pronta para o painel de configurações de som (ui/settings.ts)
//
// Devolve um nó que se REPINTA sozinho: ele se inscreve nas prefs do pad e no
// catálogo uma vez e vive enquanto o app viver. O diálogo de som é construído
// uma vez e reaberto, então não há vazamento — e a alternativa (expor um
// `paint()` para o settings.ts chamar) obrigaria o dono de lá a saber o que
// existe aqui dentro.
// ---------------------------------------------------------------------------

let section: HTMLElement | null = null;

function silencedList(): HTMLElement {
  const c = ctx;
  const box = make("div", "sb-silenced");
  const ids = getSoundboardPrefs().silenced;
  if (ids.length === 0) {
    box.append(
      make(
        "p",
        "sb-silenced-empty",
        "Ninguém silenciado. Para calar os sons de alguém, use o botão no pad quando essa pessoa tocar algo.",
      ),
    );
    return box;
  }
  for (const id of ids) {
    const row = make("div", "sb-silenced-row");
    const who = c?.state.members.get(id)?.username ?? `user-${id.slice(-4)}`;
    row.append(make("span", "sb-silenced-name", who));
    const undo = button("settings-test", "Voltar a ouvir");
    undo.setAttribute("aria-label", `Voltar a ouvir os sons de ${who}`);
    undo.addEventListener("click", () => setUserSilenced(id, false));
    row.append(undo);
    box.append(row);
  }
  return box;
}

/**
 * A seção do soundboard para o painel de som. Classes do `settings.css` de
 * propósito (`.settings-row`, `.settings-switch`, `.settings-test`): é a
 * linguagem visual daquele diálogo, e reinventá-la aqui faria a seção parecer
 * um enxerto.
 */
export function soundboardSettingsSection(): HTMLElement {
  if (section !== null) return section;
  const box = make("div", "sb-settings");

  // --- ligar/desligar
  const enabled = make("input", "settings-switch");
  enabled.type = "checkbox";
  enabled.id = "sb-enabled";
  enabled.addEventListener("change", () => setSoundboardEnabled(enabled.checked));
  const enabledRow = make("div", "settings-row");
  const enabledLabel = make("label", "settings-label", "Soundboard");
  enabledLabel.htmlFor = enabled.id;
  enabledRow.append(
    enabled,
    enabledLabel,
    make(
      "p",
      "settings-desc",
      "Os sons que qualquer pessoa do canal de voz toca pelo pad. Desligado, você continua vendo quem tocou — só não ouve.",
    ),
  );

  // --- volume próprio
  const volume = make("input");
  volume.type = "range";
  volume.id = "sb-volume";
  volume.min = "0";
  volume.max = "100";
  volume.step = "1";
  const value = make("span", "settings-value");
  value.setAttribute("aria-hidden", "true");
  const volumeRow = make("div", "settings-row settings-volume");
  const volumeLabel = make("label", "", "Volume do soundboard");
  volumeLabel.htmlFor = volume.id;
  volume.addEventListener("input", () => setSoundboardVolume(Number(volume.value) / 100));
  const test = button("settings-test", "Testar");
  test.setAttribute("aria-label", "Testar o volume do soundboard");
  test.addEventListener("click", () => {
    const first = listSounds()[0];
    if (first === undefined) {
      test.disabled = true;
      return;
    }
    void ensureBuffer(first.id).then((buffer) => {
      if (buffer !== null) previewBuffer(buffer, first.gain);
    });
  });
  volumeRow.append(volumeLabel, value, test, volume);

  // --- silenciados
  const silencedBox = make("div", "settings-row sb-silenced-row-wrap");
  const silencedTitle = make("p", "settings-label", "Silenciados");
  const silencedHost = make("div", "sb-silenced-host");
  silencedBox.append(silencedTitle, silencedHost);

  box.append(enabledRow, volumeRow, silencedBox);

  const paint = (prefs: SoundboardPrefs): void => {
    enabled.checked = prefs.enabled;
    const percent = Math.round(prefs.volume * 100);
    volume.value = String(percent);
    value.textContent = `${percent}%`;
    silencedHost.replaceChildren(silencedList());
  };
  subscribeSoundboardPrefs(paint);
  paint(getSoundboardPrefs());

  section = box;
  return box;
}
