/**
 * Não lidas e navegação do histórico (M11a — itens 80, 81 e 83).
 *
 * Três coisas que parecem separadas e são a MESMA: quanto falta ler (badge no
 * canal), ONDE a leitura parou (separador de "novas mensagens") e como voltar
 * ao presente quando a janela de DOM perdeu o fundo (botão "pular para o
 * presente"). As três leem o mesmo contador por canal, e é por isso que moram
 * num módulo só.
 *
 * DECISÕES DE ESTRUTURA
 *
 *  1. **Nenhuma chamada a `document` no topo do arquivo.** Os outros módulos de
 *     ui/ resolvem os elementos num `const el = {…}` de módulo; aqui não dá: o
 *     núcleo de regras (qual id vira ack, onde entra o separador) é testado com
 *     `node --test`, e o Node não tem DOM. Os elementos são resolvidos no mount
 *     e o resto do arquivo trabalha sobre eles.
 *
 *  2. **O módulo não fala com a rede.** O `POST /api/channels/:id/ack` entra
 *     como callback no mount — quem sabe renovar token e falar REST é o
 *     main.ts (mesma regra do MessageActions do ui/messages.ts).
 *
 *  3. **O módulo não conhece o `state`.** Ele recebe o UiContext de getters
 *     vivos (ui/context.ts): precisa só de `me` (ninguém tem não-lida de si
 *     mesmo) e de `currentChannel`.
 *
 * O QUE O SERVIDOR MANDA — E O QUE ELE NÃO MANDA
 *
 * O READY traz `read_state[]` = `{channel_id, last_message_id, unread_count,
 * mention_count}`. Repare no que NÃO vem: `last_read_message_id`. Para a badge
 * isso não faz falta (a contagem já vem pronta), mas o separador precisa saber
 * ONDE a leitura parou. A saída é contar de baixo para cima: se há N não lidas
 * e o servidor já exclui as minhas da conta, a N-ésima mensagem de outra
 * pessoa, contada do fim para o começo, é a primeira não lida. É o
 * `primeiraNaoLida()` — puro e testado. O ack (nosso ou de outra sessão) traz
 * a marca de verdade e passa a alimentar o `proximaMarca()`.
 */
import type { ChannelReadState, Message, MessageAckData } from "@danjocord/protocol";
import type { UiContext } from "./context.js";
import { icon } from "./icons.js";

// ---------------------------------------------------------------------------
// Núcleo de regras — PURO. Nada daqui até o próximo separador toca no DOM,
// e é por isso que o test/unread.test.ts existe.
// ---------------------------------------------------------------------------

/** Debounce do ack: rolar a lista não pode virar um POST por quadro. */
const ACK_DEBOUNCE_MS = 500;

/** Acima disto a badge vira "99+" — o número real fica no texto do leitor de tela. */
const BADGE_MAX = 99;

/**
 * Id de mensagem de verdade (snowflake). O render otimista usa o nonce
 * (uuid) como `data-id` até o Dispatch voltar, e mandar isso num ack seria
 * pedir ao servidor que marcasse como lida uma mensagem que ele nem conhece.
 */
export function isSnowflake(id: string): boolean {
  return /^\d+$/.test(id);
}

/**
 * `a > b` para snowflakes. BigInt e não Number: o id tem 64 bits e passa de
 * `Number.MAX_SAFE_INTEGER` — e não é comparação de string, porque "9" > "10"
 * lexicograficamente (ids de comprimentos diferentes decidiriam errado).
 */
export function idMaior(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b);
}

/**
 * A marca só ANDA PARA FRENTE. Devolve o id a enviar, ou null quando não há
 * o que enviar. (O servidor também recusa retrocesso — isto aqui evita o
 * round-trip inútil, não substitui a garantia dele.)
 */
export function proximaMarca(atual: string | null, proposto: string): string | null {
  if (!isSnowflake(proposto)) return null;
  if (atual !== null && !idMaior(proposto, atual)) return null;
  return proposto;
}

/** O que o `decideAck` responde. */
export type AckDecisao = "envia" | "espera-foco" | "ignora";

/**
 * A REGRA DO ACK, num lugar só.
 *
 * "Li até aqui" exige duas coisas ao mesmo tempo: a mensagem estar na tela E a
 * janela estar em foco. Marcar como lido com a janela no tray (que é onde este
 * app passa a maior parte do tempo — ele tem ícone na bandeja) é o erro que faz
 * a pessoa perder mensagem: ela volta ao computador e a badge já sumiu sem
 * ninguém ter lido nada.
 *
 * Fora de foco a proposta NÃO é descartada — vira "espera-foco": o candidato
 * fica guardado e o próximo `focus` da janela o envia. Sem isso, quem deixa a
 * janela aberta atrás de um jogo nunca marcaria nada como lido.
 */
export function decideAck(focada: boolean, marcaAtual: string | null, proposto: string): AckDecisao {
  if (proximaMarca(marcaAtual, proposto) === null) return "ignora";
  return focada ? "envia" : "espera-foco";
}

/** Uma linha da janela de DOM, do jeito que o `primeiraNaoLida` precisa dela. */
export interface LinhaLida {
  id: string;
  authorId: string;
}

/**
 * Qual mensagem abre o bloco de não lidas, dado o que está renderizado.
 *
 * `janela` vem em ordem de tela (mais antiga primeiro). A contagem anda de
 * baixo para cima e PULA as minhas, porque o `unread_count` do servidor já as
 * exclui — contar as minhas jogaria a linha para cima de mensagens já lidas.
 *
 * Quando a janela acaba antes da conta fechar, toda ela é não lida e a linha
 * vai para o topo do que está carregado (é o caso de voltar depois de uma
 * semana: a linha fica acima de tudo, e o resto aparece ao rolar para cima).
 *
 * IMPRECISÃO CONHECIDA: mensagem de autor bloqueado (item 54) conta no
 * servidor e não existe no DOM, então a linha sobe uma posição por mensagem
 * escondida. Preferi isso a pedir ao servidor uma contagem que respeite uma
 * lista de bloqueio que só existe no cliente.
 */
export function primeiraNaoLida(
  janela: readonly LinhaLida[],
  naoLidas: number,
  meuId: string | null,
): string | null {
  if (naoLidas <= 0 || janela.length === 0) return null;
  let restam = naoLidas;
  for (let i = janela.length - 1; i >= 0; i--) {
    const linha = janela[i]!;
    if (linha.authorId === meuId) continue;
    restam -= 1;
    if (restam === 0) return linha.id;
  }
  return janela[0]!.id;
}

/** O que a badge de um canal mostra. `null` = canal sem badge nenhuma. */
export interface RotuloBadge {
  /** o que aparece na tela (curto: "3", "99+") */
  texto: string;
  /** o que o leitor de tela lê (o número de verdade, com substantivo) */
  leitura: string;
  /** menção manda na cor: "alguém falou comigo" não pode parecer "tem coisa nova" */
  mencao: boolean;
}

/**
 * A badge mostra a contagem de MENÇÕES quando há alguma, e a de não lidas
 * quando não há. São duas perguntas diferentes ("quanto falta ler" × "quantas
 * são para mim") e uma badge só — mostrar a menor das duas seria esconder a
 * urgente atrás da rotineira.
 */
export function rotuloBadge(naoLidas: number, mencoes: number): RotuloBadge | null {
  if (naoLidas <= 0) return null;
  const mencao = mencoes > 0;
  const n = mencao ? mencoes : naoLidas;
  return {
    texto: n > BADGE_MAX ? `${BADGE_MAX}+` : String(n),
    leitura: mencao
      ? `${mencoes} ${mencoes === 1 ? "menção" : "menções"}`
      : `${naoLidas} ${naoLidas === 1 ? "mensagem não lida" : "mensagens não lidas"}`,
    mencao,
  };
}

/**
 * "Esta mensagem é para mim?" — a MESMA resposta que o `mentionsMe` do
 * ui/messages.ts dá para pintar a faixa lateral e tocar o som de menção.
 *
 * É uma cópia de três linhas, e não um import, por um motivo mecânico: o
 * messages.ts importa `../typing.js`, que usa parameter properties no
 * construtor — sintaxe que o *type stripping* do Node recusa. Importar de lá
 * tornaria este módulo (e o núcleo de regras acima) impossível de carregar no
 * `node --test`, que é justamente o que o mantém testado.
 *
 * O risco de divergir é baixo porque NENHUM dos dois lados interpreta texto: a
 * lista de menções já vem RESOLVIDA pelo servidor (`parseMentions` no POST). O
 * dia em que isto virar mais que um `includes`, os dois viram uma função só no
 * @danjocord/protocol.
 */
export function ehParaMim(msg: Message, meuId: string | null): boolean {
  if (meuId === null || msg.author_id === meuId) return false; // ninguém se menciona
  return msg.mentions_everyone || msg.mentions.includes(meuId);
}

/** Frase da barra de "pular para o presente". */
export function fraseDetached(novas: number): string {
  if (novas <= 0) return "Você está lendo mensagens antigas";
  return novas === 1 ? "1 mensagem nova desde que você parou" : `${novas} mensagens novas desde que você parou`;
}

// ---------------------------------------------------------------------------
// Estado do módulo (contagem por canal + onde está o separador)
// ---------------------------------------------------------------------------

interface CanalNaoLido {
  naoLidas: number;
  mencoes: number;
  /**
   * Última marca CONFIRMADA (ack meu ou de outra sessão minha). Começa null
   * porque o READY não manda `last_read_message_id` — ver o cabeçalho.
   */
  marca: string | null;
}

const canais = new Map<string, CanalNaoLido>();

function canal(id: string): CanalNaoLido {
  let c = canais.get(id);
  if (c === undefined) {
    c = { naoLidas: 0, mencoes: 0, marca: null };
    canais.set(id, c);
  }
  return c;
}

/**
 * Separador de "novas mensagens".
 *
 * QUANDO ELE SOME: ao TROCAR de canal, e não quando a leitura alcança as
 * mensagens. É a regra do Discord, e o motivo é o uso real: quem abre um canal
 * com 12 não lidas rola para cima para ler desde o começo — se a linha sumisse
 * no instante do ack (que acontece já, porque a janela está no fundo e em
 * foco), a pessoa perderia a única referência de onde parou justamente quando
 * foi usá-la. A linha é um marcador da VISITA, não do contador.
 *
 * `pendente` = o canal acabou de ser aberto e a posição ainda não foi
 * calculada; `contagem` é o número de não lidas congelado na abertura, para o
 * ack (que vem logo atrás e zera o contador) não apagar a linha antes de ela
 * nascer.
 */
let divisorCanal: string | null = null;
let divisorId: string | null = null;
let divisorPendente = false;
let divisorContagem = 0;

// ---------------------------------------------------------------------------
// Mount: elementos, callbacks e os listeners de foco
// ---------------------------------------------------------------------------

export interface UnreadOptions {
  /** `POST /api/channels/:id/ack {message_id}` — só o main.ts fala REST. */
  ack(channelId: string, messageId: string): Promise<void>;
  /** clique na barra: recarregar o fim do canal e colar o scroll no fundo. */
  pularParaOPresente(): void;
}

let ctx: UiContext | null = null;
let opts: UnreadOptions | null = null;
let elChannels: HTMLElement | null = null;
let barra: HTMLButtonElement | null = null;
let barraTexto: HTMLElement | null = null;

function meuId(): string | null {
  return ctx?.state.me?.id ?? null;
}

/**
 * Barra flutuante do item 83. Mora dentro do `#composer` (com
 * `position: relative` posto pelo unread.css) e não dentro do `#messages`: ali
 * ela seria um filho da lista, e a janela de DOM do M2 conta filhos
 * (`MAX_RENDERED`), remove o `lastElementChild` no trim e tira o cursor da
 * paginação do primeiro `.msg` — três lugares que passariam a mentir por causa
 * de um botão. Presa ao composer, ela flutua acima dele sem participar de nada.
 */
function montaBarra(): void {
  const composer = document.getElementById("composer");
  if (composer === null) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "jump-bar";
  btn.hidden = true;
  const texto = document.createElement("span");
  texto.className = "jump-bar-text";
  const acao = document.createElement("span");
  acao.className = "jump-bar-action";
  acao.textContent = "Pular para o presente";
  // o nome acessível do botão é a soma dos dois textos ("N mensagens novas…,
  // Pular para o presente") — nada de aria-label, que substituiria a contagem
  btn.append(texto, acao, icon("chevron", 16));
  btn.addEventListener("click", () => opts?.pularParaOPresente());
  composer.append(btn);
  barra = btn;
  barraTexto = texto;
}

/** Liga o que não muda com o estado. Chamar UMA vez, depois do DOM existir. */
export function mountUnread(context: UiContext, options: UnreadOptions): void {
  if (ctx !== null) return;
  ctx = context;
  opts = options;
  elChannels = document.getElementById("channels");
  montaBarra();
  // a janela voltou ao foco: o que ficou represado enquanto ela estava atrás
  // do jogo/tray vira ack agora (é a outra metade do decideAck)
  window.addEventListener("focus", () => {
    if (pendentes.size > 0) agendaFlush(0);
  });
}

/** Logout: contadores, timers e barra voltam ao zero (o DOM já foi limpo). */
export function resetUnread(): void {
  canais.clear();
  pendentes.clear();
  enviados.clear();
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
  divisorCanal = null;
  divisorId = null;
  divisorPendente = false;
  divisorContagem = 0;
  setDetached(false, 0);
  repaintChannels();
}

// ---------------------------------------------------------------------------
// Entrada de estado (READY, MESSAGE_CREATE, MESSAGE_ACK)
// ---------------------------------------------------------------------------

/** READY: o snapshot do servidor é a verdade; o que havia em memória sai. */
export function applyReadState(estados: readonly ChannelReadState[]): void {
  canais.clear();
  for (const e of estados) {
    canais.set(e.channel_id, { naoLidas: e.unread_count, mencoes: e.mention_count, marca: null });
  }
  repaintChannels();
}

/**
 * MESSAGE_CREATE. Chamar DEPOIS do filtro de bloqueado (item 54): mensagem que
 * não vai aparecer na tela não pode acender badge.
 *
 * Vale para TODO canal, inclusive o aberto — quem zera a contagem do canal
 * aberto é o ack, e ele só acontece com a janela em foco e a lista no fundo.
 * Sem isso, mensagem que chega com o app no tray não contaria em lugar nenhum.
 */
export function noteMessage(msg: Message): void {
  const me = meuId();
  if (msg.author_id === me) return; // ninguém tem não-lida de si mesmo
  const c = canal(msg.channel_id);
  c.naoLidas += 1;
  if (ehParaMim(msg, me)) c.mencoes += 1;
  // a linha de "novas mensagens" ainda não foi posicionada (o loadLatest do
  // canal recém-aberto está em voo): a mensagem que chegou também é não lida,
  // então ela entra na conta congelada — senão a linha nasceria abaixo dela
  if (divisorPendente && msg.channel_id === divisorCanal) divisorContagem += 1;
  repaintChannels();
}

/**
 * MESSAGE_ACK — chega até para a sessão que pediu o ack (é estado, não delta:
 * reaplicar é idempotente). É o que impede a badge de sumir no desktop e ficar
 * acesa na aba.
 *
 * Zera a contagem porque o evento significa "uma sessão minha está lendo este
 * canal agora". Recalcular exigiria guardar o id de cada não lida; a diferença
 * só apareceria se uma mensagem chegasse entre o POST e o Dispatch, e o READY
 * do próximo boot corrige qualquer desvio.
 */
export function applyAck(data: MessageAckData): void {
  const c = canal(data.channel_id);
  c.naoLidas = 0;
  c.mencoes = 0;
  if (proximaMarca(c.marca, data.last_read_message_id) !== null) c.marca = data.last_read_message_id;
  repaintChannels();
}

/**
 * Troca de canal. Congela a contagem do canal que está sendo aberto: o ack
 * chega poucos milissegundos depois (janela em foco, lista no fundo) e zeraria
 * o contador antes de o separador ser posicionado.
 */
export function openedChannel(channelId: string | null): void {
  divisorCanal = channelId;
  divisorId = null;
  divisorPendente = channelId !== null;
  divisorContagem = channelId === null ? 0 : (canais.get(channelId)?.naoLidas ?? 0);
}

// ---------------------------------------------------------------------------
// Ack: "vi até aqui"
// ---------------------------------------------------------------------------

/** canal → maior id proposto ainda não enviado */
const pendentes = new Map<string, string>();
/** canal → última marca já mandada ao servidor (evita repetir o mesmo POST) */
const enviados = new Map<string, string>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function marcaDe(channelId: string): string | null {
  return enviados.get(channelId) ?? canais.get(channelId)?.marca ?? null;
}

/**
 * Zera a contagem de um canal SEM esperar o servidor. Não é otimismo por
 * economia: `noteMessage` incrementa e repinta na mesma volta em que o main.ts
 * propõe o ack, e adiar o zero até a resposta faria a badge do canal que a
 * pessoa está LENDO piscar a cada mensagem. O que o servidor confirma depois é
 * a marca, não a contagem.
 */
function zeraContagem(channelId: string): void {
  const c = canal(channelId);
  c.naoLidas = 0;
  c.mencoes = 0;
  repaintChannels();
}

function agendaFlush(delay: number): void {
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, delay);
}

function flush(): void {
  flushTimer = undefined;
  if (!document.hasFocus()) return; // perdeu o foco entre o agendamento e agora
  for (const [channelId, proposto] of [...pendentes]) {
    pendentes.delete(channelId);
    const alvo = proximaMarca(marcaDe(channelId), proposto);
    if (alvo === null) continue;
    enviados.set(channelId, alvo);
    zeraContagem(channelId); // o caminho do flush-por-foco passa só por aqui
    void opts?.ack(channelId, alvo).catch(() => {
      // falhou (rede, deploy): destrava o id para a próxima proposta tentar de
      // novo. A contagem fica em zero de propósito — a pessoa LEU; o que se
      // perdeu foi o registro, e o READY do próximo boot o reconstrói.
      if (enviados.get(channelId) === alvo) enviados.delete(channelId);
    });
  }
}

/**
 * "Esta mensagem está na tela." Pode ser chamada à vontade: proposta menor que
 * a marca é descartada aqui mesmo, sem POST.
 */
export function ackVisivel(channelId: string, messageId: string): void {
  if (ctx === null) return;
  const decisao = decideAck(document.hasFocus(), marcaDe(channelId), messageId);
  if (decisao === "ignora") return;
  const atual = pendentes.get(channelId);
  if (atual === undefined || idMaior(messageId, atual)) pendentes.set(channelId, messageId);
  if (decisao === "envia") {
    zeraContagem(channelId); // a badge some já; o POST é que espera o debounce
    agendaFlush(ACK_DEBOUNCE_MS);
  }
  // "espera-foco": fica guardado; o listener de focus do mount despacha
}

/**
 * O mesmo ack, tirando o id do DOM: a ÚLTIMA mensagem renderizada do canal.
 * Existe para o main.ts não repetir o seletor (e para o `.pending`, cujo
 * data-id é o nonce do render otimista, ficar de fora num lugar só).
 */
export function ackDoFundo(channelId: string, container: HTMLElement): void {
  const ultima = [...container.querySelectorAll<HTMLElement>(".msg:not(.pending)")].pop();
  const id = ultima?.dataset.id;
  if (id !== undefined) ackVisivel(channelId, id);
}

// ---------------------------------------------------------------------------
// Badge na lista de canais (item 80)
// ---------------------------------------------------------------------------

/**
 * Pinta a badge e o negrito num item de canal RECÉM-CRIADO.
 *
 * É o gancho que o ui/sidebar.ts chama no `channelItem` — o módulo é de outro
 * dono e ele se re-renderiza sozinho (colapsar uma categoria faz
 * `replaceChildren` na lista inteira), então não adianta o unread.ts pintar
 * "por fora" e esperar que o desenho sobreviva.
 */
export function applyChannelUnread(btn: HTMLElement, channelId: string): void {
  const c = canais.get(channelId);
  const rotulo = rotuloBadge(c?.naoLidas ?? 0, c?.mencoes ?? 0);
  btn.classList.toggle("has-unread", rotulo !== null);
  const antiga = btn.querySelector<HTMLElement>(".unread-badge");
  if (rotulo === null) {
    antiga?.remove();
    return;
  }
  const badge = antiga ?? document.createElement("span");
  if (antiga === null) {
    badge.className = "unread-badge";
    btn.append(badge);
  }
  badge.classList.toggle("unread-badge--mention", rotulo.mencao);
  const numero = document.createElement("span");
  // o número é decorativo para o leitor de tela: sozinho ele viraria "geral 3"
  numero.setAttribute("aria-hidden", "true");
  numero.textContent = rotulo.texto;
  const leitura = document.createElement("span");
  leitura.className = "sr-only";
  leitura.textContent = rotulo.leitura;
  badge.replaceChildren(numero, leitura);
}

/**
 * Atualiza as badges JÁ montadas, sem recriar a lista.
 *
 * Mesma razão do `updateSpeaking` do sidebar.ts: chega mensagem o tempo todo, e
 * um `renderChannels()` por mensagem derrubaria o foco do teclado e faria o
 * hover piscar. Quem chama é este módulo, sempre que a contagem muda — o
 * main.ts não precisa saber que isto existe.
 */
function repaintChannels(): void {
  if (elChannels === null) return;
  for (const btn of elChannels.querySelectorAll<HTMLElement>("[data-channel-id]")) {
    const id = btn.dataset.channelId;
    if (id !== undefined) applyChannelUnread(btn, id);
  }
}

// ---------------------------------------------------------------------------
// Separador de "novas mensagens" (item 80)
// ---------------------------------------------------------------------------

function linhaEl(): HTMLElement {
  const linha = document.createElement("div");
  linha.className = "unread-line";
  const label = document.createElement("span");
  label.className = "unread-line-label";
  label.textContent = "Novas mensagens";
  linha.append(label);
  return linha;
}

/** A janela de DOM na forma que o `primeiraNaoLida` entende. */
function janelaDoDom(container: HTMLElement): LinhaLida[] {
  const out: LinhaLida[] = [];
  for (const node of container.querySelectorAll<HTMLElement>(".msg:not(.pending)")) {
    const id = node.dataset.id;
    const authorId = node.dataset.author;
    if (id === undefined || authorId === undefined || !isSnowflake(id)) continue;
    out.push({ id, authorId });
  }
  return out;
}

/**
 * Põe (ou reencontra) a linha de "novas mensagens" na janela renderizada.
 *
 * Chamar nos MESMOS pontos em que o main.ts chama `regroupAll` — e, onde há
 * compensação de scroll, ANTES de medir a altura: a linha ocupa ~28px, e
 * inserir depois da medição faria o texto sob os olhos pular (é a mesma
 * armadilha do agrupamento do M7).
 *
 * A posição é calculada UMA vez por visita ao canal e depois só reencontrada
 * pelo id — é o que faz a linha ficar parada enquanto a pessoa lê, em vez de
 * escorregar para baixo a cada mensagem nova.
 */
export function syncUnreadDivider(container: HTMLElement): void {
  if (ctx === null) return;
  if (divisorCanal === null || divisorCanal !== ctx.state.currentChannel) {
    for (const linha of container.querySelectorAll(".unread-line")) linha.remove();
    return;
  }
  if (divisorPendente) {
    divisorPendente = false;
    divisorId = primeiraNaoLida(janelaDoDom(container), divisorContagem, meuId());
  }
  // o mesmo seletor do `findMessageEl` do ui/messages.ts, escrito aqui pela
  // razão do `ehParaMim` acima (importar aquele módulo tira este do node --test)
  const alvo =
    divisorId === null ? null : container.querySelector<HTMLElement>(`.msg[data-id="${divisorId}"]`);
  for (const linha of container.querySelectorAll<HTMLElement>(".unread-line")) {
    if (linha.parentElement !== alvo) linha.remove();
  }
  if (alvo === null || alvo.querySelector(".unread-line") !== null) return;
  // dentro da `.msg` e antes da `.msg-row`, pelo mesmo motivo do separador de
  // data (ui/messages.ts): irmão da mensagem, a linha contaria na janela de
  // DOM, poderia ser o nó que o trim remove e apareceria no seletor que produz
  // o cursor da paginação
  alvo.insertBefore(linhaEl(), alvo.querySelector(".msg-row"));
}

// ---------------------------------------------------------------------------
// "Pular para o presente" (item 83)
// ---------------------------------------------------------------------------

/**
 * A UI de um estado que já existe: com `view.detachedBottom` ligado, o
 * MESSAGE_CREATE é descartado DE PROPÓSITO (o append viraria buraco na
 * timeline) — e, até aqui, nada dizia isso na tela. A pessoa via a conversa
 * parar sem motivo.
 *
 * `novas` é quantas mensagens foram descartadas desde que o fundo se soltou;
 * zero é legítimo (o fundo se solta no trim de um prepend, sem mensagem nova).
 */
export function setDetached(on: boolean, novas: number): void {
  if (barra === null || barraTexto === null) return;
  barra.hidden = !on;
  if (!on) return;
  barraTexto.textContent = fraseDetached(novas);
  barra.classList.toggle("jump-bar--novas", novas > 0);
}
