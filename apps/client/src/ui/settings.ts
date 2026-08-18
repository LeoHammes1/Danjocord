/**
 * Configurações de som (M8): o diálogo que a engrenagem do painel do usuário
 * abre.
 *
 * Até o M7 o volume era a constante `VOLUME = 0.08` cravada no sounds.ts e o
 * único jeito de calar o app era ENSURDECER — que também calava a voz dos
 * outros. Com 14 clipes (e um soundboard vindo no M9), "desligar os sons" virou
 * requisito de convivência, e desligar sem ficar surdo virou requisito de
 * convivência com a chamada.
 *
 * O módulo não guarda preferência nenhuma: lê por `getPrefs()`, escreve pelos
 * setters de `sound/prefs.ts` e se repinta pelo `subscribe()`. Estado próprio,
 * só o do diálogo — se está aberto e para onde o foco volta ao fechar.
 *
 * Sobre a acessibilidade daqui: o `inert` no `#app` é quem prende o foco de
 * verdade (o resto do app sai da ordem de tabulação, do mouse e do leitor de
 * tela de uma vez só); a armadilha de Tab abaixo existe para FECHAR o ciclo —
 * sem ela o Tab do último controle iria parar na barra do navegador, o que é
 * sair do diálogo do mesmo jeito.
 */
import {
  CATEGORIES,
  CATEGORY_LABEL,
  DEAFEN_SILENCES,
  getPrefs,
  isReady,
  previewSound,
  resetPrefs,
  setCategory,
  setMaster,
  setVolume,
  subscribe,
  type SoundCategory,
  type SoundName,
  type SoundPrefs,
} from "../sound/index.js";
import { icon } from "./icons.js";
import { soundboardSettingsSection } from "./soundboard.js";

/**
 * Uma linha por categoria: sem isto, "Sistema" e "Notificações" viram
 * adivinhação — o rótulo sozinho não diz o que se está desligando.
 */
const DESCRIPTION: Record<SoundCategory, string> = {
  voice: "Alguém entra ou sai do seu canal de voz, ou começa a transmitir a tela.",
  notify: "Mensagem em canal que você não está vendo, e menção ao seu nome em qualquer canal.",
  self: "A resposta às suas próprias ações: mutar, ensurdecer e o push-to-talk.",
  system: "Avisos de estado do app: a conexão caiu, a conexão voltou, algo falhou.",
};

/**
 * O clipe que representa a categoria no botão "Testar". Escolhidos por serem o
 * caso ARQUETÍPICO de cada uma (o que a pessoa mais vai ouvir na vida real),
 * não o mais bonitinho: é isso que faz o teste valer como calibragem.
 */
const PREVIEW: Record<SoundCategory, SoundName> = {
  voice: "voice-join",
  notify: "message",
  self: "self-mute",
  system: "disconnected",
};

/**
 * O som do slider. `message` de propósito: é o som que chega SEM eu pedir, o
 * que interrompe. Se o volume dele está confortável, o resto está.
 */
const VOLUME_PREVIEW: SoundName = "message";

/** espera o slider PARAR antes de tocar (ver o listener de `change`) */
const VOLUME_PREVIEW_DELAY_MS = 250;

const TITLE_ID = "sound-settings-title";

/**
 * `:disabled` (pseudo-classe) e não `[disabled]` (atributo): o `<fieldset>`
 * desabilita os descendentes SEM marcar atributo em nenhum deles, e a
 * armadilha de Tab precisa enxergar exatamente o que é focável agora.
 */
const FOCUSABLE = "button:not(:disabled), input:not(:disabled)";

interface Dialog {
  overlay: HTMLElement;
  panel: HTMLElement;
  master: HTMLInputElement;
  /** tudo o que a chave geral desliga de uma vez — daí ser um fieldset */
  group: HTMLFieldSetElement;
  volume: HTMLInputElement;
  volumeValue: HTMLElement;
  toggles: Map<SoundCategory, HTMLInputElement>;
  locked: HTMLElement;
}

let dialog: Dialog | null = null;
let unsubscribe: (() => void) | null = null;
/** atraso do preview do slider — precisa morrer junto com o diálogo */
let previewTimer: number | undefined;
/** para onde o foco volta ao fechar — a engrenagem, salvo quem abriu dizer outra coisa */
let returnFocusTo: HTMLElement | null = null;

// ---------------------------------------------------------------------------
// Construção (uma vez, na primeira abertura)
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

/** Chave liga/desliga: continua sendo um checkbox de verdade — só o desenho muda. */
function switchInput(id: string): HTMLInputElement {
  const input = make("input", "settings-switch");
  input.type = "checkbox";
  input.id = id;
  return input;
}

/**
 * Toca ignorando a política (o clique NO som já é a intenção) e reavalia o
 * aviso de áudio travado: é justamente aqui que o silêncio precisa de
 * explicação — um "Testar" mudo sem motivo parece bug do app.
 */
function preview(name: SoundName): void {
  previewSound(name);
  if (dialog !== null) dialog.locked.hidden = isReady();
}

function testButton(label: string, name: SoundName): HTMLButtonElement {
  const btn = make("button", "settings-test", "Testar");
  btn.type = "button";
  // quatro botões "Testar" iguais não dizem nada em leitor de tela; o nome
  // acessível começa pelo texto visível para não contradizê-lo (WCAG 2.5.3)
  btn.setAttribute("aria-label", `Testar som de ${label}`);
  btn.addEventListener("click", () => preview(name));
  return btn;
}

function row(control: HTMLInputElement, labelText: string, desc: string, test: HTMLButtonElement | null): HTMLElement {
  const el = make("div", "settings-row");
  const label = make("label", "settings-label", labelText);
  label.htmlFor = control.id;
  el.append(control, label, make("p", "settings-desc", desc));
  if (test !== null) el.append(test);
  return el;
}

/** "a, b e c" — o texto do rodapé é montado, não escrito (ver `deafenNote`). */
function joinList(items: string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} e ${items.at(-1) ?? ""}`;
}

/**
 * O aviso do deafen é DERIVADO do catálogo (DEAFEN_SILENCES), nunca digitado:
 * o dia em que uma categoria mudar de lado, esta frase muda junto. Texto e
 * comportamento discordando é a pior documentação possível.
 */
function deafenNote(): string {
  const silenced = DEAFEN_SILENCES.map((c) => CATEGORY_LABEL[c]);
  const kept = CATEGORIES.filter((c) => !DEAFEN_SILENCES.includes(c)).map((c) => CATEGORY_LABEL[c]);
  return (
    `Ensurdecer silencia ${joinList(silenced)} — é o que “não quero ouvir nada de fora” quer dizer. ` +
    `${joinList(kept)} continuam tocando: são a resposta às suas próprias ações e os avisos de estado.`
  );
}

function build(): Dialog {
  const overlay = make("div");
  overlay.id = "sound-settings";
  overlay.hidden = true;

  const panel = make("div", "settings-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", TITLE_ID);
  // alvo do foco inicial: não há "primeiro controle" óbvio aqui, e mandar o
  // foco para o diálogo faz o leitor de tela anunciar o título antes de tudo
  panel.tabIndex = -1;
  overlay.append(panel);

  // --- cabeçalho
  const head = make("header", "settings-head");
  const title = make("h2", "", "Configurações de som");
  title.id = TITLE_ID;
  const close = make("button", "icon-btn");
  close.type = "button";
  close.setAttribute("aria-label", "Fechar");
  close.title = "Fechar";
  close.append(icon("close"));
  close.addEventListener("click", () => closeSettings());
  head.append(title, close);

  const body = make("div", "settings-body");

  // --- chave geral: fica FORA do fieldset, senão ela se desabilitaria sozinha
  const master = switchInput("sound-master");
  master.addEventListener("change", () => setMaster(master.checked));
  body.append(
    row(master, "Ativar sons", "Desliga todos os sons de uma vez, sem perder as escolhas por categoria.", null),
  );

  const group = make("fieldset", "settings-group");
  group.append(make("legend", "sr-only", "Ajustes de som"));

  // --- volume
  const volume = make("input");
  volume.type = "range";
  volume.id = "sound-volume";
  volume.min = "0";
  volume.max = "100";
  volume.step = "1";
  const volumeValue = make("span", "settings-value");
  // o próprio range já anuncia o valor; este número é para os olhos
  volumeValue.setAttribute("aria-hidden", "true");
  const volumeRow = make("div", "settings-row settings-volume");
  const volumeLabel = make("label", "", "Volume geral");
  volumeLabel.htmlFor = volume.id;
  volumeRow.append(volumeLabel, volumeValue, volume);
  volume.addEventListener("input", () => setVolume(Number(volume.value) / 100));
  // O preview vai no `change` (soltar o mouse, mexer a seta) e não no `input`:
  // arrastando, o `input` dispara dezenas de vezes por segundo. E mesmo o
  // `change` se repete ~30x/s enquanto a seta do teclado fica pressionada —
  // daí o atraso: som que gagueja não calibra nada. Mesmo remédio do
  // anti-flapping da conexão (sound/index.ts), pelo mesmo motivo.
  volume.addEventListener("change", () => {
    if (previewTimer !== undefined) clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => preview(VOLUME_PREVIEW), VOLUME_PREVIEW_DELAY_MS);
  });
  group.append(volumeRow);

  // --- uma chave por categoria
  const toggles = new Map<SoundCategory, HTMLInputElement>();
  for (const cat of CATEGORIES) {
    const input = switchInput(`sound-cat-${cat}`);
    input.addEventListener("change", () => setCategory(cat, input.checked));
    toggles.set(cat, input);
    // o "Testar" NÃO segue a chave da categoria: querer ouvir o que se acabou
    // de desligar (para ter certeza de que era aquilo) é o uso normal do botão
    group.append(row(input, CATEGORY_LABEL[cat], DESCRIPTION[cat], testButton(CATEGORY_LABEL[cat], PREVIEW[cat])));
  }

  // M9: o pad entra DENTRO do mesmo fieldset de propósito — a chave geral de
  // som desliga o soundboard junto, e a política dele consulta a mesma pref.
  // Controle desabilitado e comportamento têm que concordar.
  group.append(soundboardSettingsSection());

  const locked = make(
    "p",
    "settings-locked",
    "O navegador só libera áudio depois de um clique na janela. Clique aqui dentro e teste de novo.",
  );
  locked.hidden = true;

  body.append(group, make("p", "settings-note", deafenNote()), locked);

  // --- rodapé
  const foot = make("footer", "settings-foot");
  const reset = make("button", "settings-reset", "Restaurar padrões");
  reset.type = "button";
  reset.addEventListener("click", () => resetPrefs()); // o subscribe repinta
  const done = make("button", "settings-done", "Concluir");
  done.type = "button";
  done.addEventListener("click", () => closeSettings());
  foot.append(reset, done);

  panel.append(head, body, foot);

  // Esc e a armadilha de Tab escutam no OVERLAY: o foco vive dentro dele
  // enquanto o diálogo está aberto (o `#app` está inert), então tudo bubbla
  // até aqui — e um listener no `document` fecharia diálogo de todo mundo.
  overlay.addEventListener("keydown", onKeydown);
  // pointerdown e não click: com click, arrastar de dentro do painel para fora
  // e soltar no fundo fecharia o diálogo (o click sobe até o ancestral comum)
  overlay.addEventListener("pointerdown", (ev) => {
    if (ev.target === overlay) closeSettings();
  });

  document.body.append(overlay);
  return { overlay, panel, master, group, volume, volumeValue, toggles, locked };
}

function ensureDialog(): Dialog {
  if (dialog === null) dialog = build();
  return dialog;
}

// ---------------------------------------------------------------------------
// Teclado
// ---------------------------------------------------------------------------

function onKeydown(ev: KeyboardEvent): void {
  const d = dialog;
  if (d === null) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeSettings();
    return;
  }
  if (ev.key !== "Tab") return;
  const items = [...d.panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = items.at(0);
  const last = items.at(-1);
  if (first === undefined || last === undefined) return;
  const active = document.activeElement;
  // o painel em si (tabindex -1) é o foco recém-aberto: dali, Shift+Tab tem
  // que ir para o FIM da lista, senão o primeiro Shift+Tab escapa do diálogo
  if (ev.shiftKey && (active === first || active === d.panel)) {
    last.focus();
    ev.preventDefault();
  } else if (!ev.shiftKey && active === last) {
    first.focus();
    ev.preventDefault();
  }
}

// ---------------------------------------------------------------------------
// Pintura
// ---------------------------------------------------------------------------

function paint(d: Dialog, prefs: SoundPrefs): void {
  d.master.checked = prefs.master;
  d.group.disabled = !prefs.master;
  // atribuir `value` não dispara evento: repintar durante o próprio arrasto é
  // inofensivo, e é o que mantém as prefs como fonte única da verdade
  const percent = Math.round(prefs.volume * 100);
  d.volume.value = String(percent);
  d.volumeValue.textContent = `${percent}%`;
  for (const [cat, input] of d.toggles) input.checked = prefs.categories[cat];
  d.locked.hidden = isReady();
  // desabilitar um controle que está com o foco joga o foco no <body>, e de lá
  // o Tab não passaria mais pelo listener do overlay — a armadilha morreria
  // calada. Trazer o foco de volta para o painel custa uma linha.
  if (!d.panel.contains(document.activeElement)) d.panel.focus();
}

// ---------------------------------------------------------------------------
// Abrir e fechar
// ---------------------------------------------------------------------------

/** O `#app` inteiro sai de cena enquanto o diálogo está aberto (foco, mouse e leitor de tela). */
function setBackgroundInert(inert: boolean): void {
  const app = document.getElementById("app");
  if (app !== null) app.inert = inert;
}

/**
 * Abre o diálogo. `opener` é quem recebe o foco de volta ao fechar — por
 * padrão a engrenagem do painel do usuário, que é de onde ele sempre vem.
 * Quem abre a partir de um item de menu que vai SUMIR (o menu fecha junto)
 * deve passar a engrenagem, nunca o item.
 */
export function openSettings(opener?: HTMLElement): void {
  const d = ensureDialog();
  if (!d.overlay.hidden) {
    d.panel.focus();
    return;
  }
  returnFocusTo = opener ?? document.getElementById("user-settings");
  d.overlay.hidden = false;
  setBackgroundInert(true);
  // assinar só enquanto aberto: ninguém precisa repintar um diálogo fechado
  unsubscribe = subscribe((prefs) => paint(d, prefs));
  paint(d, getPrefs());
  d.panel.focus();
}

export function closeSettings(): void {
  const d = dialog;
  if (d === null || d.overlay.hidden) return;
  // o preview do slider tem 250ms de atraso: sem cancelar, fechar logo depois
  // de arrastar solta um clipe num diálogo que já não existe (revisão M8 #9)
  if (previewTimer !== undefined) {
    clearTimeout(previewTimer);
    previewTimer = undefined;
  }
  d.overlay.hidden = true;
  setBackgroundInert(false);
  unsubscribe?.();
  unsubscribe = null;
  // sem isto quem abriu pelo teclado volta com o foco no <body>, no fim do
  // documento — o mesmo cuidado que o menu da engrenagem já tem com o Esc
  returnFocusTo?.focus();
  returnFocusTo = null;
}

/**
 * Item pronto para o menu da engrenagem (sidebar.ts). Existe para o integrador
 * não precisar redigitar classe, `role` e rótulo.
 */
export function soundMenuItem(opener: HTMLElement, onPick?: () => void): HTMLButtonElement {
  const item = make("button", "menu-item");
  item.type = "button";
  item.setAttribute("role", "menuitem");
  item.append(icon("settings", 16), document.createTextNode("Configurações de som"));
  item.addEventListener("click", () => {
    onPick?.();
    openSettings(opener);
  });
  return item;
}
