/**
 * Mensagens do canal (M7). Substitui o messageEl/appendActions/startEdit do
 * main.ts: a lista deixa de ser "uma linha por mensagem, nome repetido" e vira
 * o bloco do Discord — avatar + nome + horário na PRIMEIRA mensagem de cada
 * bloco, e só o texto nas continuações.
 *
 * Duas decisões estruturais mandam no arquivo inteiro:
 *
 *  1. TODA mensagem nasce com o desenho COMPLETO (separador de data, avatar,
 *     cabeçalho) e o que decide o que aparece é uma CLASSE: `.msg--day` mostra
 *     o separador, `.msg--cont` colapsa avatar/cabeçalho. Assim o `regroupAt`
 *     é só um par de classList.toggle — ele nunca precisa reconstruir nó nem
 *     conhecer o objeto Message de novo. Isso importa porque a janela de DOM
 *     (paginação do M2) mexe nas DUAS pontas da lista: quem era continuação
 *     vira início de bloco quando o vizinho de cima é trimado, e o prepend faz
 *     o contrário. Reagrupar é barato e acontece o tempo todo.
 *
 *  2. O separador de data mora DENTRO da mensagem, não como irmão dela. Um
 *     irmão contaria em `childElementCount` (o teto da janela), poderia ser o
 *     `firstElementChild` que o trim remove e apareceria no `querySelector`
 *     que produz o cursor `before` da paginação — três lugares do main.ts que
 *     passariam a mentir. Dentro do nó, o separador nasce e morre junto com a
 *     mensagem e nada disso muda. (É por isso que não existe um
 *     `ensureDateSeparators`: o dia é reavaliado dentro do próprio regroupAt.)
 *
 * O módulo não fala com a rede: PATCH e DELETE entram como callbacks
 * (MessageActions), porque o `api()` com renovação de token vive no main.ts.
 */
import { isStaff } from "@danjocord/protocol";
import { typingLabel } from "../typing.js";
import { avatarColor, avatarEl } from "./avatar.js";
import { icon, type IconName } from "./icons.js";
import type { Message, UiContext } from "./context.js";

/**
 * Janela de agrupamento: mensagens do mesmo autor dentro dela viram um bloco
 * só. 7 min é o valor do Discord — curto o bastante para "voltei depois do
 * almoço" abrir bloco novo, longo o bastante para uma conversa não virar
 * parede de nomes.
 */
const GROUP_WINDOW_MS = 7 * 60_000;

/** Membro que não está no Map (histórico anterior à janela de Resume). */
const UNKNOWN_AUTHOR = "Usuário desconhecido";

/**
 * As mutações que o módulo dispara. Recebidas por parâmetro (e não importadas)
 * porque quem sabe renovar token e falar REST é o main.ts — a UI só pede.
 * `editMessage` resolve com a mensagem ATUALIZADA que o servidor devolveu.
 */
export interface MessageActions {
  editMessage(msg: Message, content: string): Promise<Message>;
  deleteMessage(msg: Message): Promise<void>;
}

/**
 * Ponto ÚNICO de confirmação destrutiva do módulo. Ainda é o confirm() nativo
 * (o modal próprio é o item 99 do ROADMAP), mas já devolve Promise: trocar por
 * um modal significa reescrever só esta função.
 */
function askConfirm(question: string): Promise<boolean> {
  return Promise.resolve(confirm(question));
}

// ---------------------------------------------------------------------------
// Datas: o M0–M6 mostrava só `toLocaleTimeString()` (com segundos), então uma
// mensagem de ontem às 14:32 e uma de hoje às 14:32 eram idênticas na tela.
// ---------------------------------------------------------------------------

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/**
 * "hoje" / "ontem" / null (qualquer outro dia). O ontem sai de setDate(-1) e
 * não de "menos 86 400 000 ms": em fuso com horário de verão o dia tem 23 ou
 * 25 horas e a subtração cairia no dia errado.
 */
function relativeDay(ts: number): "hoje" | "ontem" | null {
  const day = startOfDay(ts);
  const today = startOfDay(Date.now());
  if (day === today) return "hoje";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return day === yesterday.getTime() ? "ontem" : null;
}

function hhmm(ts: number): string {
  return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Rótulo do separador. O ano só aparece quando não é o corrente. */
function dayLabel(ts: number): string {
  const rel = relativeDay(ts);
  if (rel === "hoje") return "Hoje";
  if (rel === "ontem") return "Ontem";
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long" };
  if (new Date(ts).getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return new Date(ts).toLocaleDateString("pt-BR", opts);
}

/** Carimbo do cabeçalho do bloco: "Hoje às 14:32", "12/03/2026 14:32". */
function stampLabel(ts: number): string {
  const rel = relativeDay(ts);
  if (rel !== null) return `${rel === "hoje" ? "Hoje" : "Ontem"} às ${hhmm(ts)}`;
  return `${new Date(ts).toLocaleDateString("pt-BR")} ${hhmm(ts)}`;
}

/** Data completa — vai no `title` dos horários, que são sempre abreviados. */
function fullLabel(ts: number): string {
  return new Date(ts).toLocaleString("pt-BR", { dateStyle: "full", timeStyle: "short" });
}

// ---------------------------------------------------------------------------
// Construção do elemento
// ---------------------------------------------------------------------------

/** Nome de exibição do autor; membro ausente NÃO vira "?" (era o M0). */
export function authorName(ctx: UiContext, id: string): string {
  return ctx.state.members.get(id)?.username ?? UNKNOWN_AUTHOR;
}

function iconButton(name: IconName, label: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-btn";
  btn.setAttribute("aria-label", label); // o SVG é aria-hidden: o nome vem daqui
  btn.title = label;
  btn.append(icon(name, 16));
  return btn;
}

/**
 * Avatar do bloco (40px, sem bolinha de presença — quem mostra presença é a
 * lista de membros). Sai do ui/avatar.ts compartilhado, e não de um desenho
 * próprio, porque é lá que mora o fallback do CDN do Discord caducado.
 * A classe extra é só a alça para o `.msg--cont` escondê-lo.
 */
function messageAvatarEl(ctx: UiContext, authorId: string): HTMLElement {
  const user = ctx.state.members.get(authorId);
  // autor fora do Map: um usuário sintético, para o avatar cair no "?" em vez
  // de o chamador ter que desenhar um caso especial
  const av = avatarEl(user ?? { id: authorId, username: "?", avatar_url: null }, 40);
  av.classList.add("msg-avatar");
  return av;
}

function timeEl(className: string, ts: number, text: string): HTMLElement {
  const t = document.createElement("time");
  t.className = className;
  t.dateTime = new Date(ts).toISOString();
  t.textContent = text;
  t.title = fullLabel(ts);
  return t;
}

/**
 * Separador de dia. Nasce em toda mensagem porque o rótulo depende SÓ dela —
 * quem decide se ele aparece é a classe `.msg--day`, posta pelo regroupAt.
 * (Um app aberto atravessando a meia-noite mantém o "Hoje" antigo até o
 * próximo render daquela mensagem; trocar isso exigiria um timer só para
 * reescrever texto que ninguém está olhando.)
 */
function daySeparatorEl(ts: number): HTMLElement {
  const sep = document.createElement("div");
  sep.className = "msg-sep";
  const label = document.createElement("span");
  label.className = "msg-sep-label";
  label.textContent = dayLabel(ts);
  sep.append(label);
  return sep;
}

/**
 * Uma mensagem. Nasce SEMPRE como início de bloco e com o separador de data
 * escondido; quem colapsa é o regroupAt, chamado depois da inserção.
 *
 * `pending` = render otimista: ainda não existe no servidor, então não ganha
 * as ações (não há id real para editar/apagar).
 */
export function messageEl(msg: Message, ctx: UiContext, actions: MessageActions, pending = false): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = pending ? "msg pending" : "msg";
  // data-id é a âncora do MESSAGE_UPDATE/DELETE e o cursor `before` da
  // paginação; no pending é o nonce (uuid), que nunca colide com snowflake
  wrap.dataset.id = msg.id;
  // autor e horário no dataset: é o que permite ao regroupAt comparar dois
  // vizinhos sem precisar dos objetos Message originais (que o main.ts não
  // guarda — a fonte da verdade da lista é o próprio DOM)
  wrap.dataset.author = msg.author_id;
  wrap.dataset.ts = String(msg.created_at);

  const row = document.createElement("div");
  row.className = "msg-row";

  // gutter de largura FIXA: o horário da continuação aparece no hover e o
  // texto não pode andar por causa disso
  const gutter = document.createElement("div");
  gutter.className = "msg-gutter";
  gutter.append(messageAvatarEl(ctx, msg.author_id), timeEl("msg-minitime", msg.created_at, hhmm(msg.created_at)));

  const body = document.createElement("div");
  body.className = "msg-body";

  const head = document.createElement("div");
  head.className = "msg-head";
  const name = document.createElement("span");
  name.className = "msg-author";
  const user = ctx.state.members.get(msg.author_id);
  if (user === undefined) {
    name.textContent = UNKNOWN_AUTHOR;
    name.classList.add("msg-author-unknown");
  } else {
    name.textContent = user.username;
    // cor determinística por id (mesma do avatar): é o que faz um bloco ser
    // reconhecido antes de a pessoa ler o nome
    name.style.color = avatarColor(msg.author_id);
  }
  head.append(name, timeEl("msg-time", msg.created_at, stampLabel(msg.created_at)));

  const content = document.createElement("span");
  content.className = "msg-content";
  content.textContent = msg.content;
  body.append(head, content);

  if (msg.edited_at != null) {
    const edited = document.createElement("span");
    edited.className = "msg-edited";
    edited.textContent = " (editado)";
    edited.title = `Editado em ${fullLabel(msg.edited_at)}`;
    body.append(edited);
  }

  row.append(gutter, body);
  if (!pending) appendActions(wrap, row, msg, ctx, actions);
  wrap.append(daySeparatorEl(msg.created_at), row);
  return wrap;
}

// ---------------------------------------------------------------------------
// Agrupamento
// ---------------------------------------------------------------------------

/**
 * Reavalia UM elemento contra o vizinho de cima e ajusta separador de data e
 * continuação. Aceita `Element | null` para o main.ts poder passar
 * `firstElementChild`/`nextElementSibling` direto; qualquer coisa que não seja
 * uma `.msg` (o botão `.load-retry`, por exemplo) é ignorada.
 *
 * PRECISA ser chamado depois de toda inserção e de todo trim — a lista é a
 * única fonte de verdade do agrupamento. Os pontos exatos estão documentados
 * no relatório de integração.
 */
export function regroupAt(node: Element | null): void {
  if (!(node instanceof HTMLElement) || !node.classList.contains("msg")) return;
  const prev = node.previousElementSibling;
  const prevMsg = prev instanceof HTMLElement && prev.classList.contains("msg") ? prev : null;
  const ts = Number(node.dataset.ts ?? "0");
  const prevTs = prevMsg === null ? 0 : Number(prevMsg.dataset.ts ?? "0");
  // primeira mensagem da janela de DOM sempre mostra a data: sem ela o topo do
  // histórico paginado ficaria sem régua nenhuma
  const newDay = prevMsg === null || !sameDay(prevTs, ts);
  const cont =
    !newDay && prevMsg !== null && prevMsg.dataset.author === node.dataset.author && ts - prevTs < GROUP_WINDOW_MS;
  node.classList.toggle("msg--day", newDay);
  node.classList.toggle("msg--cont", cont);
}

/**
 * regroupAt em toda a lista. Para os lotes (loadLatest, prepend de página) —
 * um por um seria o mesmo trabalho com mais chamadas do lado do main.ts.
 * Custa O(n) sobre no máximo MAX_RENDERED (600) nós e não lê layout, então
 * não força reflow.
 */
export function regroupAll(container: HTMLElement): void {
  for (const child of container.children) regroupAt(child);
}

export function findMessageEl(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`.msg[data-id="${id}"]`);
}

/** Troca o nó pelo render novo e reagrupa as duas pontas da costura. */
function replaceMessage(target: Element, msg: Message, ctx: UiContext, actions: MessageActions): HTMLElement {
  const fresh = messageEl(msg, ctx, actions);
  target.replaceWith(fresh);
  regroupAt(fresh);
  // o vizinho de baixo pode ter deixado de ser (ou passado a ser) continuação
  regroupAt(fresh.nextElementSibling);
  return fresh;
}

// ---------------------------------------------------------------------------
// Ações: editar e apagar (as regras são as MESMAS do servidor)
// ---------------------------------------------------------------------------

function appendActions(
  wrap: HTMLElement,
  row: HTMLElement,
  msg: Message,
  ctx: UiContext,
  actions: MessageActions,
): void {
  const own = msg.author_id === ctx.state.me?.id;
  // apagar: autor OU admin; editar: só o autor (espelha as regras do servidor)
  // M10: o booleano virou cargo — `isStaff` mora no protocolo para cliente e
  // servidor decidirem pela MESMA regra (a de verdade é a do servidor)
  const canDelete = own || (ctx.state.me !== null && isStaff(ctx.state.me));
  if (!own && !canDelete) return;
  const bar = document.createElement("div");
  bar.className = "msg-actions";
  if (own) {
    const edit = iconButton("pencil", "Editar mensagem");
    edit.onclick = () => startEdit(wrap, msg, ctx, actions);
    bar.append(edit);
  }
  const del = iconButton("trash", "Apagar mensagem");
  del.classList.add("msg-action-danger");
  del.onclick = () => void confirmDelete(wrap, msg, actions);
  bar.append(del);
  row.append(bar);
}

async function confirmDelete(wrap: HTMLElement, msg: Message, actions: MessageActions): Promise<void> {
  // a lista é capturada ANTES do await: se o broadcast trocar o nó enquanto o
  // usuário lê a pergunta, ainda dá para achar a mensagem viva pelo id
  const list = wrap.parentElement;
  if (!(await askConfirm("Apagar esta mensagem?"))) return;
  try {
    await actions.deleteMessage(msg);
  } catch {
    // 403/404/rede: a mensagem fica; o estado real volta pelo broadcast
    return;
  }
  const live = list === null ? wrap : findMessageEl(list, msg.id);
  if (live === null) return; // o MESSAGE_DELETE chegou primeiro
  const next = live.nextElementSibling;
  live.remove();
  regroupAt(next); // quem estava embaixo pode virar início de bloco
}

/** Rascunho do editor inline aberto nesta mensagem, ou null. */
export function editDraftOf(wrap: HTMLElement): string | null {
  return wrap.querySelector<HTMLInputElement>(".edit-input")?.value ?? null;
}

/**
 * Edição inline. O comportamento é o do M2 e não muda: Esc cancela
 * reconstruindo a mensagem original, Enter salva, Enter com texto igual ou
 * vazio equivale a cancelar, e um segundo Enter não vira um segundo PATCH.
 *
 * `draft` existe para o main.ts reabrir o editor depois de um MESSAGE_UPDATE
 * ter trocado o nó sob o cursor — sem ele o texto digitado se perderia.
 */
export function startEdit(
  wrap: HTMLElement,
  msg: Message,
  ctx: UiContext,
  actions: MessageActions,
  draft?: string,
): void {
  if (wrap.querySelector(".edit-input") !== null) return; // já em edição
  const content = wrap.querySelector(".msg-content");
  if (content === null) return;
  const list = wrap.parentElement;

  const box = document.createElement("div");
  box.className = "edit-box";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "edit-input";
  input.maxLength = 4000;
  input.value = draft ?? msg.content;
  input.setAttribute("aria-label", "Editar mensagem");
  const hint = document.createElement("span");
  hint.className = "edit-hint";
  hint.textContent = "Esc para cancelar · Enter para salvar";
  box.append(input, hint);
  content.replaceWith(box);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  // cancelar = reconstruir o elemento do zero (mais simples que restaurar spans)
  const cancel = (): void => void replaceMessage(wrap, msg, ctx, actions);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      cancel();
      return;
    }
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const next = input.value.trim();
    if (next === "" || next === msg.content) {
      cancel();
      return;
    }
    input.disabled = true; // evita Enter duplo virar dois PATCHes
    void actions.editMessage(msg, next).then(
      (updated) => {
        // lookup por id (não pelo container): o broadcast pode ter chegado antes
        const live = list === null ? null : findMessageEl(list, msg.id);
        if (live !== null) replaceMessage(live, updated, ctx, actions);
      },
      () => {
        // 403/404/rede: restaura o original, se o broadcast já não o refez
        if (wrap.isConnected) replaceMessage(wrap, msg, ctx, actions);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Indicador de digitação
// ---------------------------------------------------------------------------

/**
 * Escreve "fulano está digitando…" no nó passado (#typing, que é aria-live).
 * Recebe os IDS e resolve os nomes aqui — é o mesmo `authorName` das
 * mensagens, então um autor desconhecido diz a mesma coisa nos dois lugares.
 * Os pontinhos são decorativos e ficam aria-hidden: o leitor de tela anuncia
 * a frase, não a animação.
 */
export function renderTyping(target: HTMLElement, ctx: UiContext, typers: string[]): void {
  const label = typingLabel(typers.map((id) => authorName(ctx, id)));
  if (label === "") {
    target.replaceChildren();
    return;
  }
  const dots = document.createElement("span");
  dots.className = "typing-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i++) dots.append(document.createElement("span"));
  const text = document.createElement("span");
  text.className = "typing-text";
  text.textContent = label;
  target.replaceChildren(dots, text);
}
