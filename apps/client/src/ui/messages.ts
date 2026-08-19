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
 *
 * ---------------------------------------------------------------------------
 * M11b transformou a "linha de texto" em mensagem RICA. Nada disso trocou a
 * estrutura `.msg` / `.msg-row` / `.msg-body`, e é de propósito: a janela de
 * DOM da paginação conta `childElementCount`, tira o cursor `before` de
 * `.msg:not(.pending)` e reagrupa pelas duas pontas — qualquer nó novo teria
 * que ser INTERNO para não mentir em nenhum dos três.
 *
 *  - **citação** (86): `.msg-reply` é o PRIMEIRO filho do `.msg-body`, acima do
 *    cabeçalho. E ela mudou o agrupamento: `data-reply` no nó faz o
 *    `regroupAt` recusar a continuação (ver `groupDecision` no core), porque
 *    uma citação colapsada dentro de um bloco fica pendurada sem avatar nem
 *    nome e parece pertencer à mensagem de cima.
 *  - **reações** (87): `.msg-reactions` nasce SEMPRE (vazio e `hidden`), para o
 *    delta do gateway não precisar descobrir onde inserir a barra. Aplicar o
 *    delta NÃO recria a mensagem: recriar recarregaria a imagem do anexo e
 *    perderia o cartão de link já buscado.
 *  - **anexos** (89): a caixa é reservada por `fitBox` ANTES de a imagem
 *    existir. Sem isso a lista pula quando cada imagem carrega — e o
 *    `#messages` tem `overflow-anchor: none` (paginação), então o navegador
 *    não corrige nada sozinho.
 *  - **cartão de link** (90): buscado só quando a mensagem chega perto da tela
 *    (IntersectionObserver) e memorizado por URL. Carregar 100 mensagens não
 *    pode virar 100 requisições — o servidor limita a 30/min por usuário.
 *  - **menu de ações** (84): a toolbar de hover ganhou responder/reagir/mais, e
 *    o menu é alcançável por TECLADO — as setas andam pelas mensagens e o
 *    Enter abre o menu na mensagem focada. Antes disto, chegar no botão de
 *    apagar exigia tabular por todas as mensagens acima.
 *
 * O que NÃO existe aqui: fixar mensagem (não há nada disso no servidor) e
 * imagem no cartão de link (o `LinkPreview` do protocolo não tem o campo, de
 * propósito — buscar a imagem no site de origem vazaria o IP de cada amigo,
 * que é exatamente o que o unfurl no servidor existe para evitar).
 */
import {
  displayName,
  isStaff,
  type Attachment,
  type LinkPreview,
  type MessageReaction,
  type MessageType,
  type ReactionData,
} from "@danjocord/protocol";
import { typingLabel } from "../typing.js";
import { avatarColor, avatarEl } from "./avatar.js";
import { openEmojiPicker } from "./emoji.js";
import { icon, type IconName } from "./icons.js";
import { isSafeHref, renderMarkdown, type MarkdownOptions } from "./markdown.js";
import {
  applyReactionDelta,
  displayDomain,
  excerptText,
  firstLink,
  fitBox,
  groupDecision,
  messageLink,
  reactionLabel,
  startOfDay,
  type GroupFacts,
} from "./messages-core.js";
import { attachmentObjectUrl, fetchLinkPreview, sendReactionRequest } from "./messages-net.js";
import { openUserControls } from "./user-controls.js";
import type { Message, UiContext, User } from "./context.js";

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

  /**
   * M11b (item 86): "responder a esta". É o ÚNICO gancho novo do marco, e é
   * assim de propósito — reagir, baixar a imagem do anexo e buscar o cartão de
   * link falam com a rede direto de `ui/messages-net.ts` (o mesmo molde de
   * `ui/upload.ts`, `ui/invites.ts` e `sound/soundboard.ts`), porque cada
   * gancho a mais é um passo que o integrador pode esquecer — e um recurso que
   * some da tela sem erro nenhum.
   *
   * Responder é a exceção porque não é rede: quem entra em modo de resposta é
   * o COMPOSER, e só o main.ts fala com ele. Sem o gancho, o botão e o item de
   * menu simplesmente não aparecem.
   */
  replyTo?(msg: Message): void;
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

// `startOfDay`/`sameDay` vivem no messages-core.ts: o agrupamento depende deles
// e é lá que ele é testado sem DOM.

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

/**
 * Os três ícones que o M11b precisou e que o `ui/icons.ts` não tem.
 *
 * Ficam AQUI, e não lá, por uma razão de processo: `icons.ts` é arquivo
 * compartilhado e este marco tem mais de um pacote editando o cliente ao mesmo
 * tempo — dois agentes acrescentando entradas na mesma tabela é conflito
 * garantido. A convenção é a de lá e sem exceção: geometria à mão,
 * `currentColor`, `aria-hidden` (o nome acessível é o do BOTÃO), nunca emoji
 * como ícone. Mover os três para `icons.ts` depois é recortar e colar.
 */
type LocalIcon = "smile" | "reply" | "more";

const SVG_NS = "http://www.w3.org/2000/svg";

function localIcon(name: LocalIcon, size = 16): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const [tag, attrs] of LOCAL_SHAPES[name]) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.append(shape);
  }
  return svg;
}

const TRACO = {
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
} as const;

const LOCAL_SHAPES: Record<LocalIcon, [tag: "path" | "circle", attrs: Record<string, string>][]> = {
  // rosto: círculo, dois olhos cheios e o arco do sorriso
  smile: [
    ["circle", { cx: "12", cy: "12", r: "9", ...TRACO }],
    ["circle", { cx: "9", cy: "10", r: "1.3", fill: "currentColor" }],
    ["circle", { cx: "15", cy: "10", r: "1.3", fill: "currentColor" }],
    ["path", { d: "M8 14.5a5 5 0 0 0 8 0", ...TRACO }],
  ],
  // seta curvando para a esquerda e subindo — a de "responder" do Discord
  reply: [
    ["path", { d: "M9.5 7 5 11.5 9.5 16", ...TRACO }],
    ["path", { d: "M5 11.5h7.5a6 6 0 0 1 6 6V19", ...TRACO }],
  ],
  // ⋯ : três pontos cheios (o "mais ações" de toda toolbar)
  more: [
    ["circle", { cx: "5.5", cy: "12", r: "1.8", fill: "currentColor" }],
    ["circle", { cx: "12", cy: "12", r: "1.8", fill: "currentColor" }],
    ["circle", { cx: "18.5", cy: "12", r: "1.8", fill: "currentColor" }],
  ],
};

function isLocalIcon(name: IconName | LocalIcon): name is LocalIcon {
  return name === "smile" || name === "reply" || name === "more";
}

function iconButton(name: IconName | LocalIcon, label: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-btn";
  btn.setAttribute("aria-label", label); // o SVG é aria-hidden: o nome vem daqui
  btn.title = label;
  btn.append(isLocalIcon(name) ? localIcon(name) : icon(name, 16));
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
 * A `Message` de cada nó renderizado (M11b). WeakMap e não Map pelo mesmo
 * motivo do EDITORS: nó que sai da janela de DOM é coletado com a entrada.
 *
 * Não é uma segunda fonte da verdade — é a MESMA mensagem que desenhou o nó,
 * guardada para quem precisa dela depois do render (o menu de ações, o delta
 * de reação, o "copiar texto"). Quando um delta chega, a entrada é
 * SUBSTITUÍDA por um objeto novo (nunca remendada): o main.ts pode ter
 * passado o mesmo objeto para outro lugar.
 */
const MESSAGES = new WeakMap<HTMLElement, Message>();

/** A Message que desenhou este nó, se ele ainda estiver na janela de DOM. */
export function messageOf(wrap: HTMLElement): Message | undefined {
  return MESSAGES.get(wrap);
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
  // M11b (item 84): alvo de foco PROGRAMÁTICO. -1 = fora da ordem de tabulação
  // (600 mensagens não podem virar 600 paradas de Tab) e focável pelas setas —
  // ver "navegação por teclado" no fim do arquivo. A mensagem de sistema também
  // ganha: ela é conteúdo que se lê, e pular por cima dela quebraria a leitura.
  wrap.tabIndex = -1;
  wrap.addEventListener("keydown", (ev) => onMessageKeydown(ev, wrap, ctx, actions));

  // mensagem de sistema (item 92): mesmo invólucro (dataset, separador de data,
  // id) e miolo completamente outro — ver systemRowEl
  if (msg.type !== "user") {
    wrap.classList.add("msg--system");
    wrap.append(daySeparatorEl(msg.created_at), systemRowEl(msg, msg.type, ctx));
    return wrap;
  }

  // a Message fica pendurada no NÓ (WeakMap, como o EDITORS): o delta de reação
  // e o menu de ações precisam dela depois, e o main.ts não guarda os objetos
  // (a fonte da verdade da lista é o DOM). Nó fora da janela = entrada coletada.
  MESSAGES.set(wrap, msg);
  // o agrupamento precisa saber disto sem o objeto Message — ver factsOf
  if (msg.reply_to != null) wrap.dataset.reply = "1";

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

  // --- M11b, na ordem em que aparecem embaixo do texto ---------------------
  // A citação vai no TOPO do corpo (acima do cabeçalho): é o que o Discord faz
  // e o que faz sentido — ela contextualiza a mensagem antes de ela ser lida.
  if (msg.reply_to != null) body.prepend(replyQuoteEl(msg.reply_to, ctx));
  const anexos = attachmentsEl(msg);
  if (anexos !== null) body.append(anexos);
  // os dois containers nascem VAZIOS de propósito: o cartão de link chega
  // depois (busca preguiçosa) e a barra de reações é reescrita por delta —
  // com o lugar já reservado, nenhum dos dois precisa saber onde inserir.
  // Vazios não ocupam altura (`:empty { display: none }` no chat.css).
  const embeds = document.createElement("div");
  embeds.className = "msg-embeds";
  const reacoes = document.createElement("div");
  reacoes.className = "msg-reactions";
  body.append(embeds, reacoes);

  row.append(gutter, body);
  if (!pending) appendActions(wrap, row, msg, ctx, actions);
  wrap.append(daySeparatorEl(msg.created_at), row);
  renderReactions(wrap, ctx);
  // pending não busca preview: a mensagem ainda não existe no servidor e o
  // reenvio recriaria o nó — buscar duas vezes o mesmo link só gastaria cota
  if (!pending) mountLinkPreview(wrap, msg);
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
  // a REGRA está no messages-core.ts (pura e testada); aqui só se lê o dataset
  // dos dois vizinhos e se aplicam duas classes — é isso que deixa esta função
  // barata o bastante para rodar a cada prepend, append e trim da paginação
  const { newDay, cont } = groupDecision(prevMsg === null ? null : factsOf(prevMsg), factsOf(node));
  node.classList.toggle("msg--day", newDay);
  node.classList.toggle("msg--cont", cont);
}

/**
 * Os fatos do agrupamento, lidos do próprio nó. Tudo vem de `dataset` e de
 * classe — nunca do objeto Message — porque o trim da janela de DOM pode ter
 * apagado o vizinho de cima há muito tempo, e o que sobrou dele na tela é a
 * única fonte de verdade que os dois lados compartilham.
 */
function factsOf(node: HTMLElement): GroupFacts {
  return {
    ts: Number(node.dataset.ts ?? "0"),
    author: node.dataset.author ?? "",
    system: node.classList.contains("msg--system"),
    // M11b (item 86): `data-reply` é posto no messageEl e só some com o nó
    reply: node.dataset.reply === "1",
  };
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

/**
 * Quem pode apagar: o autor OU staff. Editar continua sendo só do autor —
 * exatamente as regras do servidor (`isStaff` mora no protocolo desde o M10
 * para que os dois lados decidam pela MESMA função; a de verdade é a de lá).
 */
function canDelete(msg: Message, ctx: UiContext): boolean {
  return msg.author_id === ctx.state.me?.id || (ctx.state.me !== null && isStaff(ctx.state.me));
}

/**
 * A toolbar de hover (item 84). Até o M11a ela tinha só editar e apagar, e
 * quem não é autor nem staff não recebia toolbar NENHUMA — reagir, responder e
 * copiar não existiam, então não havia o que oferecer. Agora toda mensagem de
 * usuário tem barra.
 *
 * Os botões continuam na ordem de tabulação (o CSS os esconde por `opacity`,
 * não por `display`, desde o M7). O caminho NOVO de teclado — setas entre
 * mensagens + Enter para abrir o menu — é adicional, e não substituto: o
 * módulo não pode depender de o main.ts chamar nada para continuar acessível.
 */
function appendActions(
  wrap: HTMLElement,
  row: HTMLElement,
  msg: Message,
  ctx: UiContext,
  actions: MessageActions,
): void {
  const own = msg.author_id === ctx.state.me?.id;
  const bar = document.createElement("div");
  bar.className = "msg-actions";
  // aria-label no container: o leitor de tela anuncia "ações da mensagem" ao
  // entrar no grupo, em vez de despejar cinco botões sem contexto
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Ações da mensagem");

  const react = iconButton("smile", "Reagir");
  react.setAttribute("aria-haspopup", "dialog");
  react.setAttribute("aria-expanded", "false");
  react.onclick = () => openReactionPicker(react, wrap, ctx);
  bar.append(react);
  if (actions.replyTo !== undefined) {
    const reply = iconButton("reply", "Responder");
    reply.onclick = () => actions.replyTo?.(msg);
    bar.append(reply);
  }
  if (own) {
    const edit = iconButton("pencil", "Editar mensagem");
    const open = (): void => startEdit(wrap, msg, ctx, actions);
    edit.onclick = open;
    // o MESMO gancho que o botão usa fica guardado no nó, para o ↑ do composer
    // (item 93) abrir a edição sem ter o objeto Message — ver openEditor
    EDITORS.set(wrap, open);
    bar.append(edit);
  }
  if (canDelete(msg, ctx)) {
    const del = iconButton("trash", "Apagar mensagem");
    del.classList.add("msg-action-danger");
    del.onclick = () => void confirmDelete(wrap, msg, actions);
    bar.append(del);
  }
  const more = iconButton("more", "Mais ações");
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", "false");
  more.onclick = () => toggleActionMenu(more, wrap, ctx, actions);
  bar.append(more);

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
  //
  // M11b: reconstrói a partir da Message GUARDADA NO NÓ, e não da capturada
  // quando o editor abriu. Reações chegam por delta enquanto o editor está
  // aberto, e o objeto de captura não as tem — cancelar uma edição apagaria da
  // tela as reações que apareceram no meio. (O caminho do MESSAGE_UPDATE
  // continua usando a mensagem do SERVIDOR, que é a autoridade: ela vem
  // hidratada com as reações.)
  const cancel = (): void => void replaceMessage(wrap, MESSAGES.get(wrap) ?? msg, ctx, actions);
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
        // (pela Message do nó, pelo mesmo motivo do `cancel` acima)
        if (wrap.isConnected) replaceMessage(wrap, MESSAGES.get(wrap) ?? msg, ctx, actions);
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

// ===========================================================================
// M11b — a mensagem rica
// ===========================================================================

/**
 * Aviso efêmero, para as ações que não deixam rastro na tela: "link copiado",
 * "a mensagem original não está carregada", "não foi possível reagir".
 *
 * É UM nó só (criado na primeira vez) com `role="status"`, e ele nunca é
 * escondido por `hidden` nem por `visibility`: os dois tiram o texto da árvore
 * de acessibilidade, e aí a região viva não anuncia mudança nenhuma — o
 * recurso existiria só para quem enxerga. Some por `opacity`, que não tira.
 */
let toastEl: HTMLElement | null = null;
let toastTimer = 0;

function announce(text: string): void {
  if (toastEl === null) {
    toastEl = document.createElement("div");
    toastEl.className = "msg-toast";
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");
    document.body.append(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.add("msg-toast--on");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove("msg-toast--on"), 2400);
}

/** Folga em px para considerar a lista "colada no fundo". */
const FUNDO_PX = 24;

/**
 * Roda `fn` preservando o "colado no fundo".
 *
 * Tudo que chega DEPOIS do render (cartão de link, primeira pílula de reação)
 * cresce a mensagem e empurra o resto para baixo. Quem estava lendo o presente
 * veria a última linha sair da tela — e o `#messages` tem `overflow-anchor:
 * none` por causa da paginação (M2), então o navegador não corrige sozinho.
 * Quem NÃO estava no fundo não é arrastado: o crescimento acontece abaixo do
 * ponto de leitura dele e a linha que ele lê fica onde está.
 */
function withStick(lista: HTMLElement | null, fn: () => void): void {
  const colado = lista !== null && lista.scrollHeight - lista.scrollTop - lista.clientHeight <= FUNDO_PX;
  fn();
  if (colado && lista !== null) lista.scrollTop = lista.scrollHeight;
}

/** O container de mensagens a que este nó pertence (ou null, fora do DOM). */
function listOf(wrap: HTMLElement): HTMLElement | null {
  const pai = wrap.parentElement;
  return pai instanceof HTMLElement ? pai : null;
}

// ---------------------------------------------------------------------------
// Citação (item 86)
// ---------------------------------------------------------------------------

/**
 * A citação que aparece ACIMA da mensagem. Autor + trecho, uma linha só.
 *
 * O trecho vem RESOLVIDO do servidor (`MessageReference`), e é por isso que
 * uma resposta a uma mensagem de três meses atrás desenha certo sem carregar
 * nada: a citação não depende de a original estar na janela de DOM.
 *
 * Citada apagada NÃO some — vira "mensagem apagada" (o campo `deleted` do
 * protocolo existe para isso). Sumir reescreveria a conversa de quem
 * respondeu: a resposta continuaria lá, pendurada em nada.
 */
function replyQuoteEl(ref: NonNullable<Message["reply_to"]>, ctx: UiContext): HTMLElement {
  if (ref.deleted || ref.author_id === null) {
    const gone = document.createElement("div");
    gone.className = "msg-reply msg-reply--gone";
    const texto = document.createElement("span");
    texto.className = "msg-reply-excerpt";
    texto.textContent = "mensagem apagada";
    gone.append(texto);
    return gone;
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-reply";

  const autorId = ref.author_id;
  const user = authorOf(ctx, autorId);
  const av = avatarEl(user ?? { id: autorId, username: "?", avatar_url: null }, 16);
  av.classList.add("msg-reply-avatar");

  const nome = document.createElement("span");
  nome.className = "msg-reply-author";
  nome.textContent = authorName(ctx, autorId);
  if (user !== undefined) nome.style.color = avatarColor(autorId);

  // trecho em texto CRU (sem markdown): a citação é uma linha elidida por CSS,
  // e um bloco de código ou uma pílula de menção dentro dela quebrariam a
  // altura da linha inteira. O texto que a pessoa digitou é o que identifica
  // a mensagem — a formatação está logo acima, na original.
  const trecho = document.createElement("span");
  trecho.className = "msg-reply-excerpt";
  const cru = excerptText(ref.excerpt ?? "");
  trecho.textContent = cru === "" ? "(sem texto)" : cru;

  btn.append(av, nome, trecho);
  btn.setAttribute("aria-label", `Ir para a mensagem de ${nome.textContent}: ${trecho.textContent}`);
  btn.title = "Ir para a mensagem citada";
  btn.onclick = () => jumpToQuoted(btn, ref.message_id);
  return btn;
}

/**
 * Rola até a original e a realça por um instante. Se ela NÃO está na janela de
 * DOM (histórico não carregado, ou trimada por uma das duas pontas), não
 * finge que rolou: pisca a citação e diz o que aconteceu. O trecho continua
 * ali — que é a parte que o M11b garante mostrar de qualquer jeito.
 */
function jumpToQuoted(from: HTMLElement, messageId: string): void {
  const wrap = from.closest<HTMLElement>(".msg");
  const lista = wrap === null ? null : listOf(wrap);
  if (lista !== null && scrollToMessage(lista, messageId)) return;
  from.classList.add("msg-reply--nojump");
  window.setTimeout(() => from.classList.remove("msg-reply--nojump"), 1200);
  announce("A mensagem original não está carregada aqui.");
}

/** Quanto tempo o realce de "cheguei aqui" fica na mensagem. */
const FLASH_MS = 2000;

/**
 * Rola até uma mensagem e a realça. Devolve false quando ela não está na
 * janela de DOM — quem chama decide o que dizer.
 *
 * O realce sai sozinho: é uma classe com animação no CSS, removida por timer.
 * Exportado porque a busca (item 91) quer exatamente isto.
 */
export function scrollToMessage(container: HTMLElement, messageId: string): boolean {
  const alvo = findMessageEl(container, messageId);
  if (alvo === null) return false;
  alvo.scrollIntoView({ block: "center" });
  alvo.classList.remove("msg--flash");
  // leitura forçada de layout para reiniciar a animação quando a MESMA
  // mensagem é alvo duas vezes seguidas (sem isso o segundo clique não pisca)
  void alvo.offsetWidth;
  alvo.classList.add("msg--flash");
  window.setTimeout(() => alvo.classList.remove("msg--flash"), FLASH_MS);
  return true;
}

// ---------------------------------------------------------------------------
// Reações (item 87)
// ---------------------------------------------------------------------------

/**
 * Pedidos de reação em voo, para o clique duplo não virar dois pedidos.
 *
 * WeakSet de BOTÕES e não `disabled`: desabilitar o botão que está com o foco
 * joga o foco no `<body>` e quem navega por teclado perde o lugar na lista.
 * `aria-busy` conta a mesma coisa sem mexer no foco.
 */
const REAGINDO = new WeakSet<HTMLElement>();

/**
 * (Re)desenha a barra de reações a partir da Message guardada no nó.
 *
 * A barra é reescrita inteira em vez de remendada: são no máximo 20 pílulas
 * (teto do servidor) e reconstruir é o que garante que contagem, realce de
 * "eu reagi" e o rótulo de quem reagiu nunca fiquem desencontrados entre si.
 */
function renderReactions(wrap: HTMLElement, ctx: UiContext): void {
  const bar = wrap.querySelector<HTMLElement>(".msg-reactions");
  const msg = MESSAGES.get(wrap);
  if (bar === null || msg === undefined) return;
  if (msg.reactions.length === 0) {
    bar.replaceChildren(); // vazio some por `:empty` — sem faixa em branco
    return;
  }
  const meId = ctx.state.me?.id ?? null;
  const nodes: HTMLElement[] = msg.reactions.map((r) => reactionPill(wrap, r, ctx, meId));
  // o "+" só aparece quando JÁ existe alguma reação: numa mensagem sem nenhuma
  // ele seria um botão permanente em cada linha da timeline. Sem reações, o
  // caminho é o "Reagir" da toolbar (e o menu, pelo teclado).
  nodes.push(addReactionBtn(wrap, ctx));
  bar.replaceChildren(...nodes);
}

function reactionPill(wrap: HTMLElement, r: MessageReaction, ctx: UiContext, meId: string | null): HTMLButtonElement {
  const minha = meId !== null && r.user_ids.includes(meId);
  const b = document.createElement("button");
  b.type = "button";
  b.className = minha ? "reaction reaction--mine" : "reaction";
  // o objeto do botão é a reação; o ESTADO ("eu reagi") vai no aria-pressed —
  // convenção do M7 para todo botão que reflete estado
  b.setAttribute("aria-pressed", String(minha));

  // "Você" no lugar do meu nome: a ordem é a de quem reagiu, e o pronome é o
  // que faz o rótulo ser lido como frase
  const nomes = r.user_ids.map((id) => (id === meId ? "Você" : authorName(ctx, id)));
  const rotulo = reactionLabel(r.emoji, nomes);
  b.title = rotulo;
  b.setAttribute("aria-label", rotulo);

  const glifo = document.createElement("span");
  glifo.className = "reaction-emoji";
  glifo.textContent = r.emoji;
  const n = document.createElement("span");
  n.className = "reaction-count";
  n.textContent = String(r.user_ids.length);
  b.append(glifo, n);

  b.onclick = () => void sendReaction(b, wrap, r.emoji, !minha);
  return b;
}

function addReactionBtn(wrap: HTMLElement, ctx: UiContext): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "reaction reaction--add";
  b.setAttribute("aria-label", "Adicionar reação");
  b.setAttribute("aria-haspopup", "dialog");
  b.setAttribute("aria-expanded", "false");
  b.title = "Adicionar reação";
  b.append(localIcon("smile", 16));
  b.onclick = () => openReactionPicker(b, wrap, ctx);
  return b;
}

/**
 * Abre o seletor de emoji do outro pacote (`ui/emoji.ts`). Ele não sabe nada de
 * mensagem: devolve o `Emoji` escolhido e o que fazer com ele é daqui.
 */
function openReactionPicker(anchor: HTMLElement, wrap: HTMLElement, ctx: UiContext): void {
  openEmojiPicker({
    anchor,
    label: "Reagir",
    onPick: (emoji) => {
      const msg = MESSAGES.get(wrap);
      if (msg === undefined) return;
      const meId = ctx.state.me?.id ?? null;
      // escolher no seletor um emoji que eu JÁ pus ALTERNA para tirar — é o
      // mesmo gesto da pílula. O contrário (mandar um PUT que o servidor
      // responde 204 sem evento) pareceria um clique que não fez nada.
      const jaMinha = meId !== null && msg.reactions.some((r) => r.emoji === emoji.char && r.user_ids.includes(meId));
      void sendReaction(anchor, wrap, emoji.char, !jaMinha);
    },
  });
}

/**
 * Põe ou tira a MINHA reação. Não há render otimista, e é a mesma decisão do
 * soundboard do M9: todo mundo — inclusive quem clicou — pinta pelo eco do
 * gateway (`REACTION_ADD` / `REACTION_REMOVE`). Um caminho só significa zero
 * chance de a minha tela divergir da dos outros, e zero código de desfazer.
 */
async function sendReaction(btn: HTMLElement, wrap: HTMLElement, emoji: string, add: boolean): Promise<void> {
  const msg = MESSAGES.get(wrap);
  if (msg === undefined || REAGINDO.has(btn)) return;
  REAGINDO.add(btn);
  btn.setAttribute("aria-busy", "true");
  try {
    await sendReactionRequest(msg.channel_id, msg.id, emoji, add);
  } catch {
    // 409 (teto de reações), 403 (timeout de chat), 429 ou rede: o servidor é
    // quem manda, e o que está na tela continua sendo o que ele mandou por último
    announce("Não foi possível reagir.");
  } finally {
    REAGINDO.delete(btn);
    btn.removeAttribute("aria-busy");
  }
}

/**
 * Aplica um `REACTION_ADD` / `REACTION_REMOVE` do gateway (M11b).
 *
 * Só mexe na BARRA — nunca recria a mensagem. Recriar recarregaria a imagem do
 * anexo (novo `<img src>` = nova decodificação), perderia o cartão de link já
 * buscado e mataria um editor inline aberto. O delta é idempotente (ver
 * `applyReactionDelta` no core), então evento repetido não pinta duas vezes.
 *
 * Mensagem fora da janela de DOM: nada a fazer, e é o caso COMUM — o payload
 * é um delta pequeno justamente porque quase sempre vai ser descartado.
 */
export function applyReaction(container: HTMLElement, d: ReactionData, add: boolean, ctx: UiContext): void {
  const wrap = findMessageEl(container, d.message_id);
  if (wrap === null) return;
  const msg = MESSAGES.get(wrap);
  if (msg === undefined || msg.channel_id !== d.channel_id) return;
  MESSAGES.set(wrap, { ...msg, reactions: applyReactionDelta(msg.reactions, d.emoji, d.user_id, add) });
  // a primeira pílula cresce a mensagem em ~28px: quem estava no fundo continua
  withStick(listOf(wrap), () => renderReactions(wrap, ctx));
}

// ---------------------------------------------------------------------------
// Anexos (item 89)
// ---------------------------------------------------------------------------

function attachmentsEl(msg: Message): HTMLElement | null {
  if (msg.attachments.length === 0) return null;
  const box = document.createElement("div");
  box.className = "msg-attachments";
  for (const att of msg.attachments) box.append(attachmentEl(att));
  return box;
}

/**
 * Uma imagem. O quadro é RESERVADO por `fitBox` antes de qualquer byte chegar:
 * `--att-w` e `--att-ratio` viram largura e `aspect-ratio` no CSS, então a
 * altura final já está no layout desde o primeiro frame. Sem isso a timeline
 * pula a cada imagem carregada e quem está lendo perde a linha.
 *
 * O `src` é uma URL `blob:` — ver `ui/messages-net.ts` para o porquê.
 */
function attachmentEl(att: Attachment): HTMLElement {
  const { w, h } = fitBox(att.width, att.height);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "attachment";
  btn.style.setProperty("--att-w", `${w}px`);
  btn.style.setProperty("--att-ratio", `${w} / ${h}`);
  btn.setAttribute("aria-label", `Abrir imagem ${att.filename}`);
  btn.title = att.filename;

  const img = document.createElement("img");
  img.className = "attachment-img";
  // alt = nome do arquivo: é a única descrição que existe (ninguém digita alt
  // ao arrastar uma print), e diz mais do que um "imagem" genérico
  img.alt = att.filename;
  img.decoding = "async";
  btn.append(img);

  void attachmentObjectUrl(att).then(
    (url) => {
      img.src = url;
      // guardado no nó: o lightbox reusa a MESMA URL já baixada — abrir em
      // tamanho grande não pode custar um segundo download
      btn.dataset.src = url;
    },
    () => falharAnexo(btn, att.filename),
  );
  btn.onclick = () => {
    const url = btn.dataset.src;
    if (url !== undefined) openLightbox(att, url);
  };
  return btn;
}

/** Falha de download: o quadro (que já ocupa o espaço certo) vira um aviso. */
function falharAnexo(btn: HTMLButtonElement, filename: string): void {
  btn.classList.add("attachment--erro");
  btn.disabled = true;
  const aviso = document.createElement("span");
  aviso.className = "attachment-erro";
  aviso.textContent = `imagem indisponível — ${filename}`;
  btn.replaceChildren(aviso);
}

/**
 * Lightbox (item 89). Um nó só, reusado: abrir e fechar imagem é frequente, e
 * criar/destruir o overlay a cada vez só geraria lixo.
 *
 * Não usa o `ui/dialog.ts` de propósito: aquela casca desenha cabeçalho, corpo
 * e rodapé (é um painel de configuração), e as regras `.dialog-*` moram num
 * arquivo importado DEPOIS do chat.css — sobrescrevê-las daqui perderia todo
 * empate de especificidade (a armadilha anotada no CLAUDE.md). O que importa
 * dela — Esc, fundo inerte, foco de volta — está reproduzido abaixo.
 */
interface Lightbox {
  overlay: HTMLElement;
  img: HTMLImageElement;
  legenda: HTMLElement;
}
let lightbox: Lightbox | null = null;
let lightboxVolta: HTMLElement | null = null;

function ensureLightbox(): Lightbox {
  if (lightbox !== null) return lightbox;
  const overlay = document.createElement("div");
  overlay.className = "lightbox";
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const fechar = document.createElement("button");
  fechar.type = "button";
  fechar.className = "icon-btn lightbox-close";
  fechar.setAttribute("aria-label", "Fechar");
  fechar.title = "Fechar";
  fechar.append(icon("close", 20));
  fechar.onclick = () => closeLightbox();

  const img = document.createElement("img");
  img.className = "lightbox-img";

  const legenda = document.createElement("div");
  legenda.className = "lightbox-caption";

  overlay.append(fechar, img, legenda);
  // pointerdown e não click: arrastar de dentro da imagem para fora e soltar
  // fecharia com click (o evento sobe até o ancestral comum) — a mesma
  // correção que o ui/dialog.ts já tinha
  overlay.addEventListener("pointerdown", (ev) => {
    if (ev.target === overlay) closeLightbox();
  });
  overlay.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeLightbox();
      return;
    }
    // só o botão de fechar é focável aqui: a armadilha de Tab é não deixar o
    // foco sair, e com um controle só isso é prender o Tab no lugar
    if (ev.key === "Tab") ev.preventDefault();
  });

  document.body.append(overlay);
  lightbox = { overlay, img, legenda };
  return lightbox;
}

function openLightbox(att: Attachment, src: string): void {
  const lb = ensureLightbox();
  lightboxVolta = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  lb.img.src = src;
  lb.img.alt = att.filename;
  lb.legenda.textContent = att.filename;
  lb.overlay.setAttribute("aria-label", att.filename);
  lb.overlay.hidden = false;
  const app = document.getElementById("app");
  if (app !== null) app.inert = true; // o app inteiro sai do foco e do leitor de tela
  lb.overlay.querySelector<HTMLElement>(".lightbox-close")?.focus();
}

function closeLightbox(): void {
  if (lightbox === null || lightbox.overlay.hidden) return;
  lightbox.overlay.hidden = true;
  // a URL do blob NÃO é revogada aqui: ela é do cache do ui/messages-net.ts e
  // a mesma imagem continua na timeline atrás do overlay
  lightbox.img.removeAttribute("src");
  const app = document.getElementById("app");
  if (app !== null) app.inert = false;
  if (lightboxVolta !== null && lightboxVolta.isConnected) lightboxVolta.focus();
  lightboxVolta = null;
}

// ---------------------------------------------------------------------------
// Cartão de link (item 90)
// ---------------------------------------------------------------------------

/**
 * Preview já resolvido, por URL. `null` = não há cartão (o servidor respondeu
 * `ok:false`, ou a rede falhou). O cache NEGATIVO é tão importante quanto o
 * positivo: sem ele, toda vez que a mensagem voltasse à janela de DOM o
 * cliente pediria de novo um link que já se sabe que não vira cartão.
 *
 * A chave é a URL, então o mesmo link colado dez vezes custa uma requisição.
 */
const PREVIEWS = new Map<string, LinkPreview | null>();
/** requisições em voo, para dez mensagens com o mesmo link pedirem UMA vez */
const PREVIEWS_EM_VOO = new Map<string, Promise<LinkPreview | null>>();
/** o que buscar quando ESTE nó aparecer na tela */
const PREVIEW_ALVO = new WeakMap<Element, string>();

let previewObserver: IntersectionObserver | null = null;

/**
 * Margem de antecipação: começa a buscar um pouco antes de a mensagem entrar
 * na tela, para o cartão não aparecer com atraso visível ao rolar devagar.
 */
const PREVIEW_MARGEM = "200px";

/**
 * Nós que o observador já viu DENTRO do documento. Existe para uma coisa só:
 * distinguir "ainda não foi anexado" de "foi trimado pela janela de DOM".
 *
 * A observação é agendada no `messageEl`, quando o nó ainda é órfão (o main.ts
 * anexa logo depois) — e a primeira entrega do observador chega com
 * `isIntersecting: false`. Sem esta distinção, essa primeira entrega seria
 * lida como "saiu do documento" e o cartão nunca seria buscado.
 */
const PREVIEW_VISTO = new WeakSet<Element>();

function ensurePreviewObserver(): IntersectionObserver {
  previewObserver ??= new IntersectionObserver(
    (entradas) => {
      for (const e of entradas) {
        if (e.target.isConnected) PREVIEW_VISTO.add(e.target);
        // trimado pela paginação sem nunca ter aparecido: para de observar.
        // O observador é um singleton de módulo (portanto sempre alcançável) e
        // segura os alvos — sem isto, uma sessão longa rolando um canal cheio
        // de links acumularia milhares de nós que já saíram da tela.
        else if (PREVIEW_VISTO.has(e.target)) {
          previewObserver?.unobserve(e.target);
          PREVIEW_ALVO.delete(e.target);
          continue;
        }
        if (!e.isIntersecting) continue;
        previewObserver?.unobserve(e.target);
        const url = PREVIEW_ALVO.get(e.target);
        if (url === undefined) continue;
        PREVIEW_ALVO.delete(e.target);
        void fetchPreview(e.target as HTMLElement, url);
      }
    },
    { rootMargin: PREVIEW_MARGEM },
  );
  return previewObserver;
}

/**
 * Agenda a busca do cartão. PREGUIÇOSA de propósito: um `loadLatest` traz 50
 * mensagens, e buscar o preview de todas de uma vez estouraria o limite do
 * servidor (30/min por usuário) para pintar cartões que ninguém está olhando.
 *
 * Quem é observado é a `.msg` inteira, e não o `.msg-embeds`: o container do
 * cartão nasce vazio, e `:empty { display: none }` faz um elemento sem caixa —
 * que NUNCA intersecta nada, então o observador jamais dispararia.
 */
/** Peneira barata antes de reparsear: quase nenhuma mensagem tem link. */
const TEM_URL = /https?:\/\//i;

function mountLinkPreview(wrap: HTMLElement, msg: Message): void {
  // o `firstLink` reparseia o markdown (é o mesmo scanner que desenhou o <a>,
  // e essa igualdade vale o custo) — mas um `loadLatest` são 50 mensagens de
  // até 4000 caracteres, e reparsear todas para descobrir que 48 não têm link
  // nenhum é trabalho que dá para não fazer
  if (msg.content === "" || !TEM_URL.test(msg.content)) return;
  const url = firstLink(msg.content);
  if (url === null || !isSafeHref(url)) return;
  const slot = wrap.querySelector<HTMLElement>(".msg-embeds");
  if (slot === null) return;

  const cache = PREVIEWS.get(url);
  if (cache !== undefined) {
    // já resolvido nesta sessão (mensagem que voltou à janela de DOM, ou o
    // mesmo link em outra mensagem): pinta na hora, sem rede e sem observador
    if (cache !== null && cache.ok) slot.append(linkCardEl(cache, url));
    return;
  }
  PREVIEW_ALVO.set(wrap, url);
  ensurePreviewObserver().observe(wrap);
}

async function fetchPreview(wrap: HTMLElement, url: string): Promise<void> {
  let voo = PREVIEWS_EM_VOO.get(url);
  if (voo === undefined) {
    // o catch é aqui, e não no chamador: a promessa é COMPARTILHADA por todas
    // as mensagens com este link, e uma rejeição solta viraria unhandled
    voo = fetchLinkPreview(url).catch(() => null);
    PREVIEWS_EM_VOO.set(url, voo);
    void voo.then((r) => {
      PREVIEWS.set(url, r);
      PREVIEWS_EM_VOO.delete(url);
    });
  }
  const preview = await voo;
  // falha, `ok:false` ou nó já fora da janela de DOM: sem cartão e sem espaço
  // vazio — um cartão em branco é pior que nenhum cartão
  if (preview === null || !preview.ok || !wrap.isConnected) return;
  const slot = wrap.querySelector<HTMLElement>(".msg-embeds");
  if (slot === null || slot.childElementCount > 0) return;
  withStick(listOf(wrap), () => slot.append(linkCardEl(preview, url)));
}

/**
 * O cartão. Discreto de propósito: faixa lateral, nome do site, título e duas
 * linhas de descrição.
 *
 * Sem imagem — e não é esquecimento: o `LinkPreview` do protocolo não tem o
 * campo porque uma `image_url` remota faria o navegador de cada amigo buscar o
 * arquivo no site de origem, que é exatamente o IP que o unfurl no servidor
 * existe para não vazar. (A CSP do cliente também só aceita imagem própria.)
 *
 * O `href` é a URL COMO ESTÁ NA MENSAGEM, e não a normalizada que voltou do
 * servidor: o cartão tem que levar ao mesmo lugar que o link do texto acima.
 */
function linkCardEl(preview: LinkPreview, href: string): HTMLElement {
  const a = document.createElement("a");
  a.className = "link-card";
  // setAttribute e não `a.href`, como no ui/markdown.ts: a propriedade resolve
  // para absoluto e a gente quer no DOM o que a pessoa escreveu
  a.setAttribute("href", href);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer");

  const site = preview.site_name ?? displayDomain(preview.url) ?? displayDomain(href);
  if (site !== null) {
    const s = document.createElement("span");
    s.className = "link-card-site";
    s.textContent = site;
    a.append(s);
  }
  if (preview.title !== null) {
    const t = document.createElement("span");
    t.className = "link-card-title";
    t.textContent = preview.title;
    a.append(t);
  }
  if (preview.description !== null) {
    const d = document.createElement("span");
    d.className = "link-card-desc";
    d.textContent = preview.description;
    a.append(d);
  }
  return a;
}

// ---------------------------------------------------------------------------
// Menu de ações (item 84)
// ---------------------------------------------------------------------------

interface MenuAberto {
  raiz: HTMLElement;
  anchor: HTMLElement;
  itens: HTMLButtonElement[];
}
let menuAberto: MenuAberto | null = null;

interface MenuItem {
  label: string;
  danger?: boolean;
  run: () => void;
}

/** Distância entre o menu e a borda da tela (e do âncora). */
const MENU_FOLGA = 8;

function toggleActionMenu(anchor: HTMLElement, wrap: HTMLElement, ctx: UiContext, actions: MessageActions): void {
  if (menuAberto !== null && menuAberto.anchor === anchor) {
    closeActionMenu();
    return;
  }
  openActionMenu(anchor, wrap, ctx, actions);
}

/**
 * Monta e abre o menu. Ele é um `role="menu"` de verdade — setas, Home/End,
 * Esc e foco de volta — porque este é o caminho em que TODAS as ações
 * (inclusive apagar) são alcançáveis sem mouse: da mensagem focada, Enter abre
 * aqui.
 *
 * O que NÃO está no menu: fixar mensagem. Não existe nada disso no servidor, e
 * um item que não faz nada é pior que a ausência dele.
 */
function openActionMenu(anchor: HTMLElement, wrap: HTMLElement, ctx: UiContext, actions: MessageActions): void {
  const msg = MESSAGES.get(wrap);
  if (msg === undefined) return; // mensagem de sistema: não há ação nenhuma
  closeActionMenu();

  const own = msg.author_id === ctx.state.me?.id;
  const itens: MenuItem[] = [];
  if (actions.replyTo !== undefined) {
    itens.push({ label: "Responder", run: () => actions.replyTo?.(msg) });
  }
  // o seletor abre ancorado no MESMO botão que abriu o menu (que já fechou):
  // o painel aparece onde o olho está
  itens.push({ label: "Reagir…", run: () => openReactionPicker(anchor, wrap, ctx) });
  if (msg.content !== "") {
    itens.push({ label: "Copiar texto", run: () => void copyText(msg.content, "Texto copiado.") });
  }
  itens.push({ label: "Copiar link da mensagem", run: () => void copyText(linkOf(msg), "Link copiado.") });
  if (own) {
    itens.push({ label: "Editar mensagem", run: () => startEdit(wrap, msg, ctx, actions) });
  }
  if (canDelete(msg, ctx)) {
    itens.push({ label: "Apagar mensagem", danger: true, run: () => void confirmDelete(wrap, msg, actions) });
  }

  const raiz = document.createElement("div");
  raiz.className = "msg-menu";
  raiz.setAttribute("role", "menu");
  raiz.setAttribute("aria-label", "Ações da mensagem");

  const botoes = itens.map((item) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = item.danger === true ? "menu-item danger" : "menu-item";
    b.setAttribute("role", "menuitem");
    // -1 em todos: quem navega aqui são as setas (padrão de menu do ARIA), e o
    // Tab tem que SAIR do menu, não passear por dentro dele
    b.tabIndex = -1;
    b.textContent = item.label;
    b.onclick = () => {
      closeActionMenu();
      item.run();
    };
    return b;
  });
  raiz.append(...botoes);
  raiz.addEventListener("keydown", onMenuKeydown);
  document.body.append(raiz);

  menuAberto = { raiz, anchor, itens: botoes };
  // só quem se declara "abre um menu" ganha o estado: pelo teclado o âncora
  // pode ser a própria `.msg`, e um `aria-expanded` num div de mensagem é
  // ruído para quem usa leitor de tela
  if (anchor.hasAttribute("aria-haspopup")) anchor.setAttribute("aria-expanded", "true");
  posicionarMenu(raiz, anchor);
  botoes[0]?.focus();

  // pointerdown no documento fecha ao clicar fora. Registrado no próximo tick
  // para o clique que ABRIU o menu não o fechar em seguida; em captura, para
  // fechar antes de o alvo lá fora reagir. A checagem evita registrar um
  // listener órfão quando o menu fecha (Esc, por exemplo) antes deste tick.
  window.setTimeout(() => {
    if (menuAberto !== null) document.addEventListener("pointerdown", onMenuPointerDown, true);
  }, 0);
}

function onMenuPointerDown(ev: PointerEvent): void {
  if (menuAberto === null) return;
  const alvo = ev.target;
  if (alvo instanceof Node && (menuAberto.raiz.contains(alvo) || menuAberto.anchor.contains(alvo))) return;
  closeActionMenu();
}

function onMenuKeydown(ev: KeyboardEvent): void {
  const aberto = menuAberto;
  if (aberto === null) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeActionMenu();
    return;
  }
  if (ev.key === "Tab") {
    // Tab não navega DENTRO de um menu: ele fecha e o foco segue o fluxo
    // normal da página — é o que o padrão do ARIA manda
    closeActionMenu();
    return;
  }
  const i = aberto.itens.indexOf(document.activeElement as HTMLButtonElement);
  const ultimo = aberto.itens.length - 1;
  let alvo = -1;
  if (ev.key === "ArrowDown") alvo = i >= ultimo ? 0 : i + 1;
  else if (ev.key === "ArrowUp") alvo = i <= 0 ? ultimo : i - 1;
  else if (ev.key === "Home") alvo = 0;
  else if (ev.key === "End") alvo = ultimo;
  if (alvo < 0) return;
  ev.preventDefault();
  aberto.itens[alvo]?.focus();
}

/** Fecha o menu de ações, se houver um aberto. */
export function closeActionMenu(): void {
  const aberto = menuAberto;
  if (aberto === null) return;
  menuAberto = null;
  document.removeEventListener("pointerdown", onMenuPointerDown, true);
  aberto.raiz.remove();
  if (aberto.anchor.hasAttribute("aria-haspopup")) aberto.anchor.setAttribute("aria-expanded", "false");
  // o foco volta para quem abriu — a não ser que ele já tenha saído do DOM
  // (a mensagem pode ter sido apagada pelo próprio item do menu)
  if (aberto.anchor.isConnected) aberto.anchor.focus();
}

/** Abaixo do âncora, alinhado à direita dele, preso dentro da janela. */
function posicionarMenu(raiz: HTMLElement, anchor: HTMLElement): void {
  const a = anchor.getBoundingClientRect();
  const m = raiz.getBoundingClientRect();
  let top = a.bottom + MENU_FOLGA;
  // sem espaço embaixo (mensagem no fim da lista): abre para cima
  if (top + m.height > window.innerHeight - MENU_FOLGA) top = Math.max(MENU_FOLGA, a.top - m.height - MENU_FOLGA);
  const left = Math.max(MENU_FOLGA, Math.min(a.right - m.width, window.innerWidth - m.width - MENU_FOLGA));
  raiz.style.top = `${top}px`;
  raiz.style.left = `${left}px`;
}

/**
 * Link permanente da mensagem. `origin` + `pathname` saem da janela para o
 * link funcionar na web e no desktop (onde o esquema é `app://`).
 */
function linkOf(msg: Message): string {
  return messageLink(window.location.origin, window.location.pathname, msg.channel_id, msg.id);
}

/**
 * Copiar. A API de área de transferência só existe em contexto seguro (https,
 * localhost, `app://`) e pode ser negada por permissão — a falha é DITA, não
 * engolida: senão o clique não faz nada e ninguém sabe por quê.
 */
async function copyText(text: string, ok: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    announce(ok);
  } catch {
    announce("Não foi possível copiar.");
  }
}

// ---------------------------------------------------------------------------
// Navegação por teclado entre mensagens (item 84)
// ---------------------------------------------------------------------------

/**
 * Antes do M11b, chegar ao botão de apagar de uma mensagem no meio do
 * histórico exigia tabular por todos os botões (e por todas as pílulas de
 * menção) de todas as mensagens acima dela — com até 600 nós na janela de DOM,
 * isso é "não dá para apagar".
 *
 * A saída NÃO foi pôr as mensagens na ordem de tabulação (seriam 600 paradas
 * de Tab, o mesmo problema ao contrário): cada `.msg` tem `tabindex="-1"` e é
 * alcançada pelas SETAS. O Tab continua fazendo exatamente o que sempre fez —
 * nada do que funcionava parou de funcionar.
 *
 *   ↑ / ↓        mensagem anterior / seguinte
 *   Home / End   primeira / última da janela de DOM
 *   Enter        abre o menu de ações da mensagem focada
 *   Shift+F10    idem (o atalho de "menu de contexto" do Windows)
 *
 * O listener é do PRÓPRIO nó (e não do container): assim o módulo não depende
 * de o main.ts chamar nada para ser acessível — um passo de integração
 * esquecido não pode virar uma regressão de acessibilidade.
 */
function onMessageKeydown(ev: KeyboardEvent, wrap: HTMLElement, ctx: UiContext, actions: MessageActions): void {
  const alvo = ev.target;
  // dentro do editor inline as setas são do CURSOR e o Enter salva
  if (alvo instanceof HTMLInputElement || alvo instanceof HTMLTextAreaElement) return;
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
  const lista = listOf(wrap);
  if (lista === null) return;

  if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
    const proxima = vizinhaMsg(wrap, ev.key === "ArrowDown");
    if (proxima === null) return; // ponta da janela: deixa a tecla rolar a lista
    ev.preventDefault();
    focusMessage(proxima);
    return;
  }
  // Home/End só quando o foco está no NÓ: num botão da toolbar eles podem
  // significar outra coisa para quem usa leitor de tela
  if ((ev.key === "Home" || ev.key === "End") && alvo === wrap) {
    const ponta = pontaMsg(lista, ev.key === "End");
    if (ponta === null) return;
    ev.preventDefault();
    focusMessage(ponta);
    return;
  }
  const abre = ev.key === "Enter" || (ev.key === "F10" && ev.shiftKey);
  if (abre && alvo === wrap) {
    ev.preventDefault();
    // ancora no "mais ações" quando ele existe (o menu abre onde o olho está);
    // sem toolbar (mensagem de sistema) não há menu — o openActionMenu recusa
    const mais = wrap.querySelector<HTMLElement>(".msg-actions .icon-btn:last-of-type");
    openActionMenu(mais ?? wrap, wrap, ctx, actions);
  }
}

function vizinhaMsg(wrap: HTMLElement, adiante: boolean): HTMLElement | null {
  let n: Element | null = adiante ? wrap.nextElementSibling : wrap.previousElementSibling;
  while (n !== null) {
    // pula o que não é mensagem (o botão `.load-retry` do main.ts mora na lista)
    if (n instanceof HTMLElement && n.classList.contains("msg")) return n;
    n = adiante ? n.nextElementSibling : n.previousElementSibling;
  }
  return null;
}

function pontaMsg(lista: HTMLElement, fim: boolean): HTMLElement | null {
  const todas = lista.querySelectorAll<HTMLElement>(":scope > .msg");
  return (fim ? todas.item(todas.length - 1) : todas.item(0)) ?? null;
}

function focusMessage(wrap: HTMLElement): void {
  wrap.focus({ preventScroll: true });
  // "nearest": mensagem que já está visível não faz a lista pular — quem lê o
  // histórico não pode ser arrastado por andar uma linha
  wrap.scrollIntoView({ block: "nearest" });
}
