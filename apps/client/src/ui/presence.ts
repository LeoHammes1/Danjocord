/**
 * Presença e identidade PRÓPRIA (M10, itens 55 e 56).
 *
 * O M0–M9 tinha um booleano: `online` era "existe um socket vivo". O M10 troca
 * isso por quatro valores declarados pelo cliente, e a diferença não é
 * cosmética — um indicador que só sabe dizer "a aba está aberta" mente sobre a
 * única coisa que ele promete contar, que é se a pessoa está disponível AGORA.
 * Numa guild de dez amigos com o app na bandeja, todo mundo fica verde 24 h.
 *
 * Três coisas moram aqui, e o fio que as une é "isto é sobre MIM":
 *
 * 1. o status declarado (op 3 do gateway) e o AUTO-AUSENTE — é o auto-ausente
 *    que faz o verde voltar a significar alguma coisa;
 * 2. o menu que troca o status (entregue PRONTO para a sidebar, que este
 *    módulo não edita — ver `presenceMenuItems`);
 * 3. o apelido da guild (item 55), que é o outro campo "meu" e abre pelo mesmo
 *    menu.
 *
 * O QUE NÃO MORA AQUI, de propósito:
 *
 * - a presença dos OUTROS. Ela chega por PRESENCE_UPDATE e vive no
 *   `state.presences` do main.ts; este módulo só oferece o `statusOf()` para
 *   quem precisar ler aquele mapa sem repetir o `?? "offline"` em cada tela.
 * - a decisão de silenciar som no "não perturbe". Quem decide se um som toca é
 *   `sound/policy.ts`, sempre — a regra exata a acrescentar lá está no
 *   relatório do pacote. Duplicar a decisão aqui seria criar a segunda regra
 *   que diverge da primeira na próxima correção (a lição do M8).
 *
 * O status NÃO persiste no servidor (convenção do repo: presença é efêmera e
 * morre com a sessão), mas persiste LOCALMENTE: quem se põe invisível espera
 * continuar invisível depois do F5, e não voltar visível sozinho.
 */
import { User, displayName, type PresenceStatus } from "@danjocord/protocol";
import { API, getAccessToken, refresh } from "../auth.js";
import type { UiContext, UiState } from "./context.js";
import { createDialog, el, type DialogShell } from "./dialog.js";
import { icon } from "./icons.js";

// ---------------------------------------------------------------------------
// Vocabulário
// ---------------------------------------------------------------------------

/** Ordem de exibição — do mais presente ao menos, e é a ordem das seções da lista de membros. */
export const STATUS_ORDER: readonly PresenceStatus[] = ["online", "idle", "dnd", "offline"];

/**
 * Rótulo de quem está OLHANDO para outra pessoa. "offline" aqui é sempre
 * offline: quem está invisível aparece exatamente como quem fechou o app — é o
 * que "invisível" promete, e o fio nem carrega o quinto valor (ver o comentário
 * do `PresenceStatus` no protocolo).
 */
export const STATUS_LABEL: Record<PresenceStatus, string> = {
  online: "Disponível",
  idle: "Ausente",
  dnd: "Não perturbe",
  offline: "Offline",
};

/**
 * Rótulo do MEU status. Só difere no offline: para mim aquilo é uma escolha
 * ("Invisível"), e chamá-la de "Offline" no meu próprio menu faria parecer que
 * o app caiu.
 */
const MY_STATUS_LABEL: Record<PresenceStatus, string> = { ...STATUS_LABEL, offline: "Invisível" };

/**
 * A linha de baixo de cada opção do menu. Existe porque duas das quatro fazem
 * algo que NÃO se vê: "não perturbe" cala notificação e "invisível" esconde de
 * todo mundo. Sem a frase, a pessoa descobre o efeito por acidente.
 */
const STATUS_HINT: Record<PresenceStatus, string> = {
  online: "",
  idle: "Marcado automaticamente após 10 min sem uso.",
  dnd: "Silencia os sons de mensagem e menção.",
  offline: "Ninguém vê que você está aqui.",
};

/** Status de UM usuário no mapa que vem do gateway. Ausente = offline (a ausência é o offline). */
export function statusOf(state: Pick<UiState, "presences">, userId: string): PresenceStatus {
  return state.presences.get(userId) ?? "offline";
}

// ---------------------------------------------------------------------------
// O MEU status
// ---------------------------------------------------------------------------

/**
 * ~10 min sem interação = ausente. O número é o do Discord, e é longo de
 * propósito: um limite curto marcaria "ausente" quem só está lendo o chat.
 */
const IDLE_AFTER_MS = 10 * 60_000;

/**
 * UM timer só, e ele NÃO é reagendado a cada evento de entrada (mexer o mouse
 * dispara centenas por minuto — reagendar um timeout em cada um seria trabalho
 * puro para nada). O evento só carimba o instante; o tique compara. A latência
 * de virar ausente é, no pior caso, um tique — irrelevante numa janela de 10 min,
 * e a VOLTA continua imediata, que é a metade que a pessoa percebe.
 */
const IDLE_TICK_MS = 30_000;

/**
 * Eventos que contam como "a pessoa está aí". `pointermove` entra (mover o
 * mouse sobre a janela é uso), `scroll` não precisa entrar porque só rola quem
 * usou roda, tecla ou ponteiro antes.
 */
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

const STATUS_KEY = "danjocord_status";

export interface PresenceHooks {
  /**
   * Manda o status para o servidor (op 3). É um gancho e não um campo do
   * `UiActions` porque o gateway pertence ao main.ts: este módulo decide QUAL
   * é o status, nunca como ele viaja.
   */
  declare(status: PresenceStatus): void;
  /** repinta o que mostra o MEU status (o painel do usuário, na sidebar) */
  repaint?: () => void;
}

let hooks: PresenceHooks | null = null;
let mounted = false;

/** o que o usuário ESCOLHEU (o auto-ausente não escreve aqui — ver `myStatus`) */
let chosen: PresenceStatus = loadChosen();
/** o auto-ausente está valendo agora? */
let autoIdle = false;
let lastActivityAt = Date.now();

function loadChosen(): PresenceStatus {
  try {
    const raw = localStorage.getItem(STATUS_KEY);
    if (raw !== null && (STATUS_ORDER as readonly string[]).includes(raw)) return raw as PresenceStatus;
  } catch {
    // localStorage bloqueado (modo privado): o default resolve
  }
  return "online";
}

/**
 * O status que este cliente declara AGORA.
 *
 * O auto-ausente é uma CAMADA sobre a escolha, não uma escrita nela: só o
 * "disponível" vira "ausente" sozinho. "Não perturbe" e "invisível" são
 * decisões deliberadas — rebaixá-las por inatividade desfaria em silêncio o que
 * a pessoa pediu (e "invisível virando ausente" a mostraria para a guild
 * inteira, que é o oposto exato do combinado).
 */
export function myStatus(): PresenceStatus {
  return chosen === "online" && autoIdle ? "idle" : chosen;
}

/** Rótulo pronto para o painel do usuário ("Invisível" quando sou eu). */
export function myStatusLabel(): string {
  return MY_STATUS_LABEL[myStatus()];
}

/**
 * Liga o rastreio de inatividade e declara o status inicial. Uma vez só, no
 * boot — depois de o UiContext existir.
 */
export function mountPresence(next: PresenceHooks): void {
  if (mounted) return;
  mounted = true;
  hooks = next;

  for (const type of ACTIVITY_EVENTS) {
    // capture: o diálogo modal e o popover do card param a propagação de
    // alguns eventos; na fase de captura a atividade chega aqui de qualquer jeito
    window.addEventListener(type, noteActivity, { passive: true, capture: true });
  }
  // trocar de aba e VOLTAR conta como interação; ir embora não zera nada — é
  // justamente ficando escondido que a aba precisa envelhecer para "ausente"
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") noteActivity();
  });
  window.setInterval(tick, IDLE_TICK_MS);

  declare();
}

/**
 * Redeclara o status atual. O integrador chama isto a cada READY: o status
 * mora na SESSÃO de gateway e o servidor a cria com "online" — sem esta
 * chamada, quem estivesse invisível reapareceria verde a cada reconexão.
 */
export function syncPresence(): void {
  declare();
}

/** Troca de status pelo menu (ou por quem mais precisar). */
export function chooseStatus(next: PresenceStatus): void {
  // escolher É interagir: sem isto, quem estava ausente há uma hora e clicasse
  // em "Disponível" voltaria a "ausente" no tique seguinte
  lastActivityAt = Date.now();
  const before = myStatus();
  autoIdle = false;
  chosen = next;
  try {
    localStorage.setItem(STATUS_KEY, next);
  } catch {
    // sem storage a escolha vale só para esta aba — ainda melhor que recusar a troca
  }
  if (myStatus() !== before) declare();
  paintMenus();
  hooks?.repaint?.();
}

function declare(): void {
  hooks?.declare(myStatus());
}

function noteActivity(): void {
  lastActivityAt = Date.now();
  if (!autoIdle) return; // caminho quente: só carimba o instante
  autoIdle = false;
  declare();
  paintMenus();
  hooks?.repaint?.();
}

function tick(): void {
  if (autoIdle || chosen !== "online") return;
  if (Date.now() - lastActivityAt < IDLE_AFTER_MS) return;
  autoIdle = true;
  declare();
  paintMenus();
  hooks?.repaint?.();
}

// ---------------------------------------------------------------------------
// Menu de status (para o painel do usuário)
//
// Este módulo NÃO edita a sidebar: ele entrega os itens prontos, no mesmo
// molde do `soundMenuItem` do M8 e do `invitesMenuItem` do M10. A sidebar só
// os pendura no menu que ela já tem.
// ---------------------------------------------------------------------------

/** os rádios já criados, para repintar o `aria-checked` quando o status mudar */
const radios = new Set<HTMLButtonElement>();

function paintMenus(): void {
  for (const btn of radios) {
    if (!btn.isConnected) {
      radios.delete(btn); // menu descartado: não segurar o nó por nada
      continue;
    }
    btn.setAttribute("aria-checked", String(btn.dataset["status"] === chosen));
  }
}

/**
 * Os itens de status + "Editar apelido", prontos para entrar num `role="menu"`.
 *
 * São `menuitemradio` e não quatro botões soltos porque é isso que eles são:
 * um estado com quatro valores mutuamente exclusivos. O leitor de tela anuncia
 * "marcado" no atual, e o grupo tem nome próprio — sem ele a lista seria só
 * quatro palavras sem assunto no meio do menu.
 */
export function presenceMenuItems(ctx: UiContext, opener: HTMLElement, onPick?: () => void): HTMLElement[] {
  const group = el("div", "menu-group");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Status");

  // rótulo VISUAL: o nome acessível do grupo já é o aria-label acima, e ler
  // "Status" duas vezes seguidas é ruído para quem ouve
  const label = el("p", "menu-label", "Status");
  label.setAttribute("aria-hidden", "true");
  group.append(label);

  for (const status of STATUS_ORDER) {
    const item = el("button", "menu-item status-item");
    item.type = "button";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(status === chosen));
    item.dataset["status"] = status;

    // a MESMA bolinha da lista de membros (classes de members.css): uma cor de
    // status é definida em um lugar só, senão o menu e a lista divergem
    const dot = el("span", `av-dot av-${status}`);
    dot.setAttribute("aria-hidden", "true");

    const text = el("span", "status-text");
    text.append(el("span", "status-name", MY_STATUS_LABEL[status]));
    // O nome acessível é o RÓTULO, e a frase de baixo vira descrição: sem
    // separar os dois, o leitor de tela anunciaria "Não perturbe silencia os
    // sons de mensagem e menção, item de menu de opção, marcado" — nome e
    // explicação colados numa frase só. O aria-label repete o texto visível
    // palavra por palavra (WCAG 2.5.3), não o substitui por outro.
    item.setAttribute("aria-label", MY_STATUS_LABEL[status]);
    const hint = STATUS_HINT[status];
    if (hint !== "") {
      const hintEl = el("span", "status-hint", hint);
      // id estável: `presenceMenuItems` roda uma vez, no mount da sidebar
      hintEl.id = `status-hint-${status}`;
      item.setAttribute("aria-describedby", hintEl.id);
      text.append(hintEl);
    }

    // o "✓" do item marcado é um SVG do ui/icons.ts (o cliente não usa emoji
    // nem glifo de texto como ícone) e nasce SEMPRE — quem o mostra ou esconde
    // é o CSS pelo `aria-checked`, então repintar o menu é trocar um atributo
    const check = el("span", "status-check");
    check.setAttribute("aria-hidden", "true");
    check.append(icon("check", 14));

    item.append(dot, text, check);
    item.addEventListener("click", () => {
      chooseStatus(status);
      onPick?.();
    });
    radios.add(item);
    group.append(item);
  }

  const sep = el("div", "menu-sep");
  sep.setAttribute("role", "separator");

  const nicknameItem = el("button", "menu-item");
  nicknameItem.type = "button";
  nicknameItem.setAttribute("role", "menuitem");
  nicknameItem.append(icon("pencil", 16), document.createTextNode("Editar apelido"));
  nicknameItem.addEventListener("click", () => {
    onPick?.();
    // o foco volta para quem ABRIU o menu, não para este item: o menu fecha
    // junto com o clique e um nó escondido não recebe foco
    openNicknameDialog(ctx, opener);
  });

  return [group, sep, nicknameItem];
}

// ---------------------------------------------------------------------------
// Apelido (item 55)
//
// REST próprio, no mesmo molde do `sound/soundboard.ts` (M9) e do
// `ui/invites.ts`: o `api()` do main.ts é privado e carrega a política de
// logout do app; aqui basta renovar UMA vez no 401 e falhar com uma frase
// legível dentro do diálogo.
// ---------------------------------------------------------------------------

async function patchMe(nickname: string | null): Promise<User> {
  const send = (): Promise<Response> =>
    fetch(API + "/api/users/@me", {
      method: "PATCH",
      headers: { authorization: `Bearer ${getAccessToken() ?? ""}`, "content-type": "application/json" },
      body: JSON.stringify({ nickname }),
    });

  let res = await send();
  if (res.status === 401) {
    const result = await refresh();
    if (result !== "ok") throw new Error("sessão expirada — recarregue a página");
    res = await send();
  }
  if (!res.ok) {
    // 400 é o único erro que a pessoa causa digitando; o resto não tem
    // conserto do lado dela e não merece um jargão na tela
    throw new Error(res.status === 400 ? "apelido inválido — use de 1 a 32 caracteres" : "não deu para salvar agora");
  }
  // schema Zod como em toda entrada do projeto: a resposta é o membro inteiro
  return User.parse(await res.json());
}

interface NicknameParts {
  shell: DialogShell;
  input: HTMLInputElement;
  error: HTMLElement;
  save: HTMLButtonElement;
  cancel: HTMLButtonElement;
}

let nickDialog: NicknameParts | null = null;
let saving = false;

/**
 * Diálogo de apelido. Campo vazio LIMPA (volta a usar o nome do Discord) — é
 * por isso que o corpo distingue `null` de campo ausente no protocolo: sem os
 * dois casos não existiria como remover um apelido, só como trocá-lo.
 */
export function openNicknameDialog(ctx: UiContext, opener?: HTMLElement): void {
  const parts = nickDialog ?? buildNicknameDialog(ctx);
  const me = ctx.state.me;
  parts.input.value = me?.nickname ?? "";
  // o placeholder é o nome do Discord: mostra o que vai valer se o campo ficar vazio
  parts.input.placeholder = me?.username ?? "";
  setError(parts, "");
  setSaving(parts, false);
  parts.shell.open(opener);
  // o diálogo INTEIRO é um campo: mandar o foco para ele (e não para o painel,
  // como faz o default da casca) poupa dois Tab de quem só quer digitar. O
  // título continua sendo anunciado — o painel é `aria-labelledby`.
  parts.input.focus();
  parts.input.select();
}

function buildNicknameDialog(ctx: UiContext): NicknameParts {
  const shell = createDialog({
    id: "nickname-dialog",
    title: "Editar apelido",
    onClose: () => {
      saving = false;
    },
  });

  const form = el("form", "nick-form");
  const label = el("label", "nick-label", "Apelido nesta guild");
  const input = el("input", "nick-input");
  input.type = "text";
  input.maxLength = 32;
  input.autocomplete = "off";
  input.id = "nickname-input";
  label.htmlFor = input.id;

  const hint = el(
    "p",
    "nick-hint",
    "Vale só aqui — seu nome no Discord não muda. Deixe vazio para voltar a usá-lo.",
  );
  hint.id = "nickname-hint";
  input.setAttribute("aria-describedby", hint.id);

  const error = el("p", "nick-error");
  // status e não alert: a mensagem aparece depois de uma ação da própria
  // pessoa, e o leitor a anuncia sem interromper o que estiver falando
  error.setAttribute("role", "status");
  error.hidden = true;

  form.append(label, input, hint, error);

  const cancel = el("button", "nick-btn", "Cancelar");
  cancel.type = "button";
  // "button" e não "submit": o rodapé do diálogo vive FORA do <form> (o layout
  // da casca é fixo), então quem submete é o listener de clique abaixo
  const save = el("button", "nick-btn nick-btn-primary", "Salvar");
  save.type = "button";

  const parts: NicknameParts = { shell, input, error, save, cancel };

  cancel.addEventListener("click", () => shell.close());
  // o submit do <form> dá o Enter de graça (e sem um listener de tecla que
  // brigaria com o Esc da casca)
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void submitNickname(ctx, parts);
  });
  save.addEventListener("click", () => void submitNickname(ctx, parts));

  shell.body.append(form);
  shell.foot.append(cancel, save);
  nickDialog = parts;
  return parts;
}

async function submitNickname(ctx: UiContext, parts: NicknameParts): Promise<void> {
  if (saving) return;
  const typed = parts.input.value.trim();
  const next = typed === "" ? null : typed;
  if (next !== null && [...next].length > 32) {
    setError(parts, "no máximo 32 caracteres");
    return;
  }
  // nada mudou: fechar em silêncio é melhor que gastar uma requisição para
  // receber de volta exatamente o que já está na tela
  if (next === (ctx.state.me?.nickname ?? null)) {
    parts.shell.close();
    return;
  }

  setSaving(parts, true);
  try {
    await patchMe(next);
    // o estado NÃO é escrito daqui: o servidor manda MEMBER_UPDATE e o main.ts
    // aplica — inclusive para as outras abas desta mesma pessoa. Um atalho
    // local aqui faria a minha aba divergir das outras no primeiro erro.
    parts.shell.close();
  } catch (err) {
    setSaving(parts, false);
    setError(parts, err instanceof Error ? err.message : "não deu para salvar agora");
    parts.input.focus();
  }
}

function setSaving(parts: NicknameParts, value: boolean): void {
  saving = value;
  parts.input.disabled = value;
  parts.save.disabled = value;
  parts.cancel.disabled = value;
  parts.save.textContent = value ? "Salvando…" : "Salvar";
  // desabilitar o controle focado joga o foco no <body>, e de lá a armadilha
  // de Tab da casca não vê mais nada — a casca sabe consertar isso
  parts.shell.keepFocus();
}

function setError(parts: NicknameParts, message: string): void {
  parts.error.textContent = message;
  parts.error.hidden = message === "";
}

/**
 * Nome exibido de um id que pode não estar na lista ainda (mensagem antiga de
 * quem saiu, voice state chegando antes do MEMBER_ADD). O `displayName` do
 * protocolo é a fonte única do "apelido ganha do username"; isto aqui só
 * acrescenta o fallback, que era copiado em cinco arquivos.
 */
export function memberName(state: Pick<UiState, "members">, userId: string): string {
  const member = state.members.get(userId);
  return member === undefined ? `user-${userId.slice(-4)}` : displayName(member);
}
