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
 *
 * ---------------------------------------------------------------------------
 * M11a acrescentou quatro coisas, todas presas às duas decisões acima:
 *
 *  - **markdown e menções** (78/79): o `.msg-content` deixou de ser
 *    `textContent` e passa pelo `renderMarkdown`. Nada disso toca `dataset`
 *    nem a estrutura `.msg`/`.msg-row`/`.msg-body`, então o `regroupAt` e a
 *    janela de DOM continuam valendo — só a ALTURA da mensagem mudou (bloco de
 *    código e citação são mais altos), o que importa em quem compensa scroll.
 *  - **mensagens de sistema** (92): `type != "user"` vira uma linha discreta.
 *    Ela É uma `.msg` (com dataset, separador de data e id) porque a paginação
 *    conta nós e tira cursor do DOM — um nó "de fora" mentiria nos dois. O que
 *    ela não tem é avatar, cabeçalho, toolbar e agrupamento.
 *  - **mensagem que falhou** (82): o nó FICA, em vermelho, com Reenviar e
 *    Descartar. A classe `.pending` continua nele de propósito (ver markFailed).
 *  - **editar a última com ↑** (93): `lastOwnMessage` + `openEditor`, para o
 *    composer não precisar do objeto Message (que ninguém guarda — a fonte da
 *    verdade da lista é o DOM).
 */
import { displayName, isStaff, type MessageType } from "@danjocord/protocol";
import { typingLabel } from "../typing.js";
import { avatarColor, avatarEl } from "./avatar.js";
import { icon, type IconName } from "./icons.js";
import { renderMarkdown, type MarkdownOptions } from "./markdown.js";
import { openUserControls } from "./user-controls.js";
import type { Message, UiContext, User } from "./context.js";

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

/**
 * Autores que NÃO estão (mais) em `state.members` — o caso garantido do
 * `member_leave`: a mensagem "fulano saiu do servidor" é assinada por alguém
 * que acabou de sair da lista, e sem isto ela vira "Usuário desconhecido"
 * justamente na linha que existe para dizer quem era.
 *
 * Mora aqui, e não em `state.members`, porque pôr a pessoa de volta no Map
 * seria ressuscitá-la na lista de membros e na de participantes de voz. É
 * cache derivado do servidor (`GET /api/users/:id`), não uma segunda verdade:
 * `state.members` SEMPRE ganha na leitura, então um apelido novo vindo por
 * MEMBER_UPDATE nunca perde para uma cópia velha guardada aqui.
 */
const strayAuthors = new Map<string, User>();

/**
 * Guarda um autor resolvido fora da lista de membros. Quem faz o GET é o
 * main.ts (o `api()` com renovação de token é dele); depois de guardar, chame
 * `refreshAuthor` para as mensagens já renderizadas trocarem de nome.
 */
export function rememberAuthor(user: User): void {
  strayAuthors.set(user.id, user);
}

/** O usuário do autor: membro atual, senão o cache de quem saiu, senão nada. */
export function authorOf(ctx: UiContext, id: string): User | undefined {
  return ctx.state.members.get(id) ?? strayAuthors.get(id);
}

/**
 * Nome de exibição do autor; membro ausente NÃO vira "?" (era o M0).
 * `displayName` (e não `username`) desde o M10: o apelido é o nome da pessoa
 * NESTA guild, e mostrar o do Discord aqui enquanto a lista de membros mostra
 * o apelido é a mesma pessoa com dois nomes na mesma tela.
 */
export function authorName(ctx: UiContext, id: string): string {
  const user = authorOf(ctx, id);
  return user === undefined ? UNKNOWN_AUTHOR : displayName(user);
}

/**
 * Esta mensagem é para mim? A resposta vem do SERVIDOR (`mentions` resolvido
 * no POST + `mentions_everyone`), nunca de uma releitura do texto: a regra que
 * conta a menção no banco é o `parseMentions` do protocolo, e um segundo
 * parser na tela é a forma mais fácil de a badge e o realce discordarem.
 *
 * Exportada porque o som de menção (M8) e a faixa lateral daqui precisam da
 * MESMA resposta — o `mentionsMe()` de regex do main.ts sai por esta.
 */
export function mentionsMe(msg: Message, meId: string | null): boolean {
  if (meId === null || msg.author_id === meId) return false; // ninguém se menciona
  return msg.mentions_everyone || msg.mentions.includes(meId);
}

/**
 * As opções do markdown, montadas por render a partir do contexto VIVO.
 *
 * `mentionOf` compara sem distinção de maiúsculas contra `nickname` E
 * `username` porque é EXATAMENTE o conjunto de chaves que o `parseMentions`
 * monta no servidor (packages/protocol/src/mentions.ts). Comparar diferente
 * aqui é a única forma de a pílula aparecer sem a notificação existir — ou o
 * contrário.
 *
 * O clique abre o card do membro chamando o `ui/user-controls.ts` direto, e não
 * por um callback do main.ts: é UI falando com UI (sem estado, sem rede), o
 * callback teria uma única implementação possível e não há ciclo de import
 * (user-controls não conhece este módulo).
 */
function markdownOptions(ctx: UiContext): MarkdownOptions {
  const me = ctx.state.me;
  return {
    mentionOf: (nome) => {
      const alvo = nome.toLowerCase();
      for (const u of ctx.state.members.values()) {
        if (u.username.toLowerCase() === alvo || u.nickname?.toLowerCase() === alvo) {
          return { id: u.id, label: displayName(u) };
        }
      }
      return null;
    },
    onMentionClick: (userId) => {
      openUserControls(userId);
    },
    // spread condicional e não `me?.id`: com exactOptionalPropertyTypes ligado,
    // `undefined` explícito não é aceito num campo opcional
    ...(me !== null ? { highlightSelf: me.id } : {}),
  };
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
  const user = authorOf(ctx, authorId);
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
 * O nome do autor no cabeçalho do bloco. Autor fora da lista NÃO vira "?"
 * (item 85): vira a frase, em itálico e sem cor própria — e a cor de quem se
 * conhece é determinística por id (a mesma do avatar), que é o que faz um
 * bloco ser reconhecido antes de a pessoa ler o nome.
 */
function authorNameEl(ctx: UiContext, authorId: string): HTMLElement {
  const name = document.createElement("span");
  name.className = "msg-author";
  const user = authorOf(ctx, authorId);
  if (user === undefined) {
    name.textContent = UNKNOWN_AUTHOR;
    name.classList.add("msg-author-unknown");
  } else {
    name.textContent = displayName(user);
    name.style.color = avatarColor(authorId);
  }
  return name;
}

/**
 * A frase de cada tipo de sistema. O verbo mora AQUI e não no `content` da
 * mensagem (que o servidor grava vazio de propósito) porque o sujeito é
 * resolvido na hora de mostrar: quem entrou pode ter trocado de apelido depois,
 * e uma frase gravada envelheceria junto com o nome.
 */
const SYSTEM_PHRASE: Record<Exclude<MessageType, "user">, string> = {
  member_join: "entrou no servidor",
  member_leave: "saiu do servidor",
};

const SYSTEM_ICON: Record<Exclude<MessageType, "user">, IconName> = {
  member_join: "join",
  member_leave: "leave",
};

/**
 * O miolo da mensagem de sistema (item 92): ícone + frase + horário, numa linha
 * só, centrada e discreta. Sem avatar, sem cabeçalho, sem toolbar e sem
 * edição — não há o que editar num evento, e um botão de apagar aqui apagaria
 * o rastro que é a razão de o recurso existir.
 *
 * Reusa `.msg-row` porque é dela que sai o realce de hover e o alinhamento com
 * o resto da lista; o `.msg--system` no pai troca o grid pela linha centrada.
 */
function systemRowEl(msg: Message, kind: Exclude<MessageType, "user">, ctx: UiContext): HTMLElement {
  const row = document.createElement("div");
  row.className = "msg-row msg-system";

  const mark = document.createElement("span");
  mark.className = `msg-system-icon msg-system-icon--${kind === "member_join" ? "in" : "out"}`;
  mark.append(icon(SYSTEM_ICON[kind], 16));

  const text = document.createElement("span");
  text.className = "msg-system-text";
  const who = authorNameEl(ctx, msg.author_id);
  who.classList.add("msg-system-name");
  // o espaço é um nó de texto próprio: sem ele o nome cola no verbo (o
  // .msg-content e seu `pre-wrap` não valem aqui)
  text.append(who, document.createTextNode(` ${SYSTEM_PHRASE[kind]}`));

  row.append(mark, text, timeEl("msg-system-time", msg.created_at, hhmm(msg.created_at)));
  return row;
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

  // mensagem de sistema (item 92): mesmo invólucro (dataset, separador de data,
  // id) e miolo completamente outro — ver systemRowEl
  if (msg.type !== "user") {
    wrap.classList.add("msg--system");
    wrap.append(daySeparatorEl(msg.created_at), systemRowEl(msg, msg.type, ctx));
    return wrap;
  }

  // faixa lateral de "isto é para mim": a decisão vem do servidor, e é a mesma
  // que dispara o som de menção — nunca duas leituras do texto
  if (mentionsMe(msg, ctx.state.me?.id ?? null)) wrap.classList.add("msg--mention");

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
  head.append(authorNameEl(ctx, msg.author_id), timeEl("msg-time", msg.created_at, stampLabel(msg.created_at)));

  // <div> e não <span>: citação e bloco de código são block-level, e o
  // conteúdo agora pode conter os dois (o markdown.css já força `display:block`
  // neles, mas um bloco dentro de um inline é o desenho errado)
  const content = document.createElement("div");
  content.className = "msg-content";
  // markdown (item 78): o `textContent` cru do M7 morreu aqui. Nenhuma string
  // de HTML é montada — o renderMarkdown devolve NÓS (ver ui/markdown.ts).
  content.append(renderMarkdown(msg.content, markdownOptions(ctx)));
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
  // Mensagem de sistema QUEBRA o bloco pelos dois lados (item 92): ela nunca é
  // continuação, e a mensagem embaixo dela também não pode ser — o caso comum
  // é "fulano entrou" seguido do próprio fulano falando, em que o autor casa e
  // o agrupamento esconderia o avatar de quem acabou de aparecer.
  const system = node.classList.contains("msg--system");
  const prevSystem = prevMsg !== null && prevMsg.classList.contains("msg--system");
  const cont =
    !newDay &&
    !system &&
    !prevSystem &&
    prevMsg !== null &&
    prevMsg.dataset.author === node.dataset.author &&
    ts - prevTs < GROUP_WINDOW_MS;
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

/**
 * Repinta nome, cor e avatar das mensagens JÁ renderizadas de um autor.
 *
 * Existe porque o nome do autor é resolvido no momento do render: quem chegou
 * depois (MEMBER_ADD, apelido novo por MEMBER_UPDATE, ou o `rememberAuthor` de
 * quem saiu) precisaria de um re-render da lista inteira para aparecer, e a
 * lista é a fonte da verdade da paginação — reconstruí-la custaria a janela de
 * DOM e a posição do scroll. Aqui só o pedaço que mudou é trocado, e por isso
 * nada disto mexe em `dataset`, classe ou ordem: `regroupAt` não é afetado.
 */
export function refreshAuthor(container: HTMLElement, ctx: UiContext, userId: string): void {
  const sel = `.msg[data-author="${CSS.escape(userId)}"]`;
  for (const node of container.querySelectorAll<HTMLElement>(sel)) {
    for (const old of node.querySelectorAll<HTMLElement>(".msg-author")) {
      const fresh = authorNameEl(ctx, userId);
      // a linha de sistema tem uma classe a mais no mesmo nó — preservá-la é
      // mais barato (e menos frágil) que o chamador saber de que tipo é o nó
      if (old.classList.contains("msg-system-name")) fresh.classList.add("msg-system-name");
      old.replaceWith(fresh);
    }
    const avatar = node.querySelector<HTMLElement>(".msg-avatar");
    if (avatar !== null) avatar.replaceWith(messageAvatarEl(ctx, userId));
  }
}

// ---------------------------------------------------------------------------
// Envio que falhou (item 82)
// ---------------------------------------------------------------------------

/**
 * O que fazer com uma mensagem que não saiu. Quem refaz o POST é o main.ts —
 * este módulo só sabe como a falha PARECE.
 */
export interface FailedActions {
  /** tentar de novo. O nó volta ao estado "enviando" antes de a função rodar. */
  onResend(): void;
  /** desistir: o nó sai da lista. O main.ts aproveita para limpar o `pending`. */
  onDiscard?(): void;
}

/**
 * Marca o render otimista como FALHO, no lugar onde ele já está.
 *
 * Até o M10 o catch do envio removia o nó e devolvia o texto ao composer: para
 * quem estava olhando, a mensagem simplesmente SUMIA da tela — o pior desfecho
 * possível, porque some também a dúvida de se ela foi ou não.
 *
 * A classe `.pending` CONTINUA no nó de propósito. Ela não é só opacidade: o
 * cursor `before` da paginação sai de `.msg:not(.pending)` no main.ts, e o
 * `data-id` daqui é um nonce (uuid), que o servidor não entende como cursor.
 * Tirá-la para "deixar de parecer pendente" faria a próxima página do
 * histórico ser pedida com um id inexistente. Quem devolve a opacidade é o
 * `.msg--failed` no CSS.
 */
export function markFailed(wrap: HTMLElement, actions: FailedActions): void {
  const body = wrap.querySelector(".msg-body");
  if (body === null || wrap.querySelector(".msg-failed") !== null) return;
  wrap.classList.add("msg--failed");

  const bar = document.createElement("div");
  bar.className = "msg-failed";
  // aria-live: quem não estava olhando para a linha precisa saber que ela falhou
  bar.setAttribute("role", "status");
  const label = document.createElement("span");
  label.className = "msg-failed-text";
  label.textContent = "Não foi possível enviar.";

  const resend = document.createElement("button");
  resend.type = "button";
  resend.className = "msg-failed-btn";
  resend.textContent = "Reenviar";
  resend.onclick = () => {
    markSending(wrap);
    actions.onResend();
  };

  const discard = document.createElement("button");
  discard.type = "button";
  discard.className = "msg-failed-btn msg-failed-btn--danger";
  discard.textContent = "Descartar";
  discard.onclick = () => {
    // o callback primeiro: o main.ts ainda precisa do nó (e do nonce) para
    // limpar o `state.pending` antes de ele sair do documento
    actions.onDiscard?.();
    discardMessage(wrap);
  };

  bar.append(label, resend, discard);
  body.append(bar);
}

/** Desfaz o markFailed — o nó volta a ser um envio em curso. */
export function markSending(wrap: HTMLElement): void {
  wrap.classList.remove("msg--failed");
  wrap.querySelector(".msg-failed")?.remove();
}

/** Tira a mensagem da lista, reagrupando quem ficou embaixo. */
export function discardMessage(wrap: HTMLElement): void {
  const next = wrap.nextElementSibling;
  wrap.remove();
  regroupAt(next);
}

// ---------------------------------------------------------------------------
// Editar a última com ↑ (item 93)
// ---------------------------------------------------------------------------

/**
 * "como abrir a edição DESTE nó", guardado no momento em que a toolbar é
 * montada. É a alternativa a duplicar o texto cru num `data-content`: com o
 * markdown, o `textContent` do nó já não é mais o que a pessoa digitou, e o
 * main.ts não guarda os objetos Message (a fonte da verdade da lista é o DOM).
 * WeakMap e não Map: nó removido da janela de DOM é coletado com a entrada.
 */
const EDITORS = new WeakMap<HTMLElement, () => void>();

/**
 * A última mensagem do canal que é MINHA e pode ser editada. Ignora o render
 * otimista (ainda não existe id no servidor) e as de sistema (não são de
 * ninguém para editar).
 */
export function lastOwnMessage(container: HTMLElement, meId: string): HTMLElement | null {
  for (let node = container.lastElementChild; node !== null; node = node.previousElementSibling) {
    if (!(node instanceof HTMLElement) || !node.classList.contains("msg")) continue;
    if (node.classList.contains("pending") || node.classList.contains("msg--system")) continue;
    if (node.dataset.author === meId) return node;
  }
  return null;
}

/** Abre a edição inline de um nó já renderizado. false = não há o que editar. */
export function openEditor(wrap: HTMLElement): boolean {
  const open = EDITORS.get(wrap);
  if (open === undefined) return false;
  open();
  return true;
}

/**
 * O ↑ do composer, inteiro: acha a minha última mensagem, rola até ela e abre
 * a edição. Devolve false quando não há nenhuma — e aí o composer deixa a tecla
 * seguir seu caminho normal (mover o cursor).
 *
 * Quem escuta a tecla é o ui/composer.ts (só ele sabe se o campo está vazio e
 * se o cursor está na primeira linha); este módulo só sabe qual nó é.
 */
export function editLastOwnMessage(container: HTMLElement, meId: string): boolean {
  const target = lastOwnMessage(container, meId);
  if (target === null) return false;
  // "nearest": se já está visível, nada rola — abrir a edição não pode dar um
  // pulo na lista de quem estava lendo o histórico logo acima
  target.scrollIntoView({ block: "nearest" });
  return openEditor(target);
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
    const open = (): void => startEdit(wrap, msg, ctx, actions);
    edit.onclick = open;
    // o MESMO gancho que o botão usa fica guardado no nó, para o ↑ do composer
    // (item 93) abrir a edição sem ter o objeto Message — ver openEditor
    EDITORS.set(wrap, open);
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
