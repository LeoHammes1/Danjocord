/**
 * O miolo PURO das mensagens (M11b). Nada aqui toca `document`.
 *
 * Existe pela mesma razão do `sound/catalog.ts` do M8 e do `mentions.ts` do
 * protocolo: as decisões que valem a pena testar (agrupamento, tamanho
 * reservado de uma imagem, aplicação de um delta de reação, qual link vira
 * cartão) não podem ficar presas dentro de uma função que só roda com um DOM
 * na frente. O `ui/messages.ts` importa daqui e cuida só dos nós.
 *
 * O `apps/client` não tem jsdom (regra do marco: não instalar dependência), e
 * `node --test` roda TypeScript direto — então o que não estiver neste arquivo
 * simplesmente não tem como ser testado.
 */
import type { MessageReaction } from "@danjocord/protocol";
import { parseMarkdown, type MdNode } from "./markdown.js";

// ---------------------------------------------------------------------------
// Agrupamento
// ---------------------------------------------------------------------------

/**
 * Janela de agrupamento: mensagens do mesmo autor dentro dela viram um bloco
 * só. 7 min é o valor do Discord — curto o bastante para "voltei depois do
 * almoço" abrir bloco novo, longo o bastante para uma conversa não virar
 * parede de nomes.
 */
export const GROUP_WINDOW_MS = 7 * 60_000;

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** O que o agrupamento precisa saber de uma mensagem — e nada além disso. */
export interface GroupFacts {
  ts: number;
  author: string;
  /** mensagem de sistema (entrou/saiu): quebra o bloco pelos DOIS lados */
  system: boolean;
  /**
   * M11b (item 86): a mensagem cita outra. Reply NUNCA é continuação — a
   * citação aparece acima do texto e, colapsada num bloco, ficaria pendurada
   * sem avatar nem nome, parecendo pertencer à mensagem de cima.
   */
  reply: boolean;
}

export interface GroupDecision {
  /** mostrar o separador de data */
  newDay: boolean;
  /** colapsar avatar e cabeçalho (continuação do bloco de cima) */
  cont: boolean;
}

/**
 * A regra do agrupamento, inteira e sem DOM. O `regroupAt` do ui/messages.ts é
 * só quem lê o `dataset` dos dois vizinhos e aplica o resultado em duas
 * classes — e é por isso que ele pode ser chamado a cada prepend, append e
 * trim da janela de DOM (paginação do M2) sem custo.
 *
 * `prev === null` = primeira mensagem da janela de DOM: sempre mostra a data
 * (sem isso o topo do histórico paginado ficaria sem régua nenhuma).
 */
export function groupDecision(prev: GroupFacts | null, node: GroupFacts): GroupDecision {
  const newDay = prev === null || !sameDay(prev.ts, node.ts);
  const cont =
    !newDay &&
    !node.system &&
    !node.reply &&
    prev !== null &&
    !prev.system &&
    prev.author === node.author &&
    node.ts - prev.ts < GROUP_WINDOW_MS;
  return { newDay, cont };
}

// ---------------------------------------------------------------------------
// Anexos: o espaço RESERVADO (item 89)
// ---------------------------------------------------------------------------

/** Teto do quadro da imagem na timeline (o original pode ser 4000px de lado). */
export const ATTACHMENT_MAX_W = 400;
export const ATTACHMENT_MAX_H = 300;

/** Quadro de quem não teve dimensão lida — ver `Attachment.width` no protocolo. */
export const ATTACHMENT_FALLBACK: Readonly<Box> = { w: 240, h: 180 };

export interface Box {
  w: number;
  h: number;
}

/**
 * Caixa em que a imagem cabe, preservando a proporção. É o número que vira
 * `width` + `aspect-ratio` no CSS ANTES de a imagem existir — sem ele a
 * timeline pula quando cada imagem carrega, e quem estava lendo perde a linha
 * (o `#messages` tem `overflow-anchor: none` por causa da paginação, então o
 * navegador não corrige nada sozinho).
 *
 * Dimensão ausente ou absurda cai no quadro padrão: o servidor lê o cabeçalho,
 * mas o protocolo admite `null` para formato válido de dimensão ilegível.
 */
export function fitBox(
  width: number | null,
  height: number | null,
  maxW = ATTACHMENT_MAX_W,
  maxH = ATTACHMENT_MAX_H,
): Box {
  if (width === null || height === null || !Number.isFinite(width) || !Number.isFinite(height)) {
    return { ...ATTACHMENT_FALLBACK };
  }
  if (width <= 0 || height <= 0) return { ...ATTACHMENT_FALLBACK };
  // imagem menor que o teto NÃO é ampliada: um sticker de 60px esticado para
  // 400 vira uma mancha, e a proporção original é a informação que ela tem
  const escala = Math.min(1, maxW / width, maxH / height);
  return { w: Math.round(width * escala), h: Math.round(height * escala) };
}

// ---------------------------------------------------------------------------
// Reações (item 87)
// ---------------------------------------------------------------------------

/**
 * Aplica um delta de reação (REACTION_ADD / REACTION_REMOVE) sobre a lista
 * agregada da mensagem, devolvendo uma lista NOVA.
 *
 * Três propriedades que os testes trancam:
 *
 *  - **idempotente**: o mesmo evento aplicado duas vezes dá o mesmo resultado.
 *    Isso importa porque o servidor ecoa o evento para QUEM apertou também (é
 *    o mesmo JSON para todas as sessões, decisão do `MessageReaction` no
 *    protocolo) e um MESSAGE_UPDATE pode reentregar a mensagem inteira no meio.
 *  - **ordem estável**: um emoji entra no FIM e só sai quando fica sem
 *    ninguém. A barra de reações não pode se reordenar embaixo do cursor de
 *    quem está clicando.
 *  - **sem mutação**: a `Message` guardada no nó é substituída, não remendada
 *    — objeto compartilhado remendado é como uma tela fica dessincronizada de
 *    outra que aponta para o mesmo lugar.
 */
export function applyReactionDelta(
  reactions: readonly MessageReaction[],
  emoji: string,
  userId: string,
  add: boolean,
): MessageReaction[] {
  const out: MessageReaction[] = [];
  let achou = false;
  for (const r of reactions) {
    if (r.emoji !== emoji) {
      out.push(r);
      continue;
    }
    achou = true;
    const tem = r.user_ids.includes(userId);
    if (add) {
      out.push(tem ? r : { emoji, user_ids: [...r.user_ids, userId] });
      continue;
    }
    if (!tem) {
      out.push(r);
      continue;
    }
    const restantes = r.user_ids.filter((id) => id !== userId);
    // emoji sem ninguém some da barra: uma pílula "0" não existe
    if (restantes.length > 0) out.push({ emoji, user_ids: restantes });
  }
  if (!achou && add) out.push({ emoji, user_ids: [userId] });
  return out;
}

/** Quantos nomes cabem no rótulo antes de virar "e mais N". */
const MAX_NOMES = 6;

/**
 * "Você e Ana reagiram com 😀". É o `title` E o `aria-label` da pílula: a
 * contagem sozinha diz que três pessoas concordaram, mas não com quem se
 * concorda — e essa é a metade útil da reação.
 *
 * Os nomes chegam já resolvidos e na ordem em que reagiram (com "Você" no
 * lugar do próprio usuário, se for o caso) — quem resolve nome é o
 * `authorName` do ui/messages.ts, que sabe do cache de quem saiu da guild.
 */
export function reactionLabel(emoji: string, names: readonly string[]): string {
  if (names.length === 0) return `Reagir com ${emoji}`;
  const verbo = names.length === 1 ? "reagiu" : "reagiram";
  let lista: string;
  if (names.length > MAX_NOMES) {
    const extras = names.length - MAX_NOMES;
    lista = `${names.slice(0, MAX_NOMES).join(", ")} e mais ${extras}`;
  } else if (names.length === 1) {
    lista = names[0] as string;
  } else {
    lista = `${names.slice(0, -1).join(", ")} e ${names.at(-1) as string}`;
  }
  return `${lista} ${verbo} com ${emoji}`;
}

// ---------------------------------------------------------------------------
// Preview de link (item 90)
// ---------------------------------------------------------------------------

/**
 * O primeiro link http(s) da mensagem, ou null.
 *
 * Reusa o parser do `ui/markdown.ts` de propósito em vez de uma regex própria:
 * é o MESMO scanner que desenha o `<a>` na tela, então o cartão é sempre do
 * link que a pessoa vê — e link dentro de bloco de código não vira cartão,
 * porque para o parser ele nem é link.
 */
export function firstLink(content: string): string | null {
  return procurarLink(parseMarkdown(content));
}

function procurarLink(nodes: readonly MdNode[]): string | null {
  for (const n of nodes) {
    if (n.kind === "link") return n.href;
    if (n.kind === "strong" || n.kind === "em" || n.kind === "underline" || n.kind === "strike" || n.kind === "quote") {
      const achado = procurarLink(n.children);
      if (achado !== null) return achado;
    }
  }
  return null;
}

/**
 * O domínio para o rodapé do cartão. `www.` sai porque ele não distingue nada
 * e come metade do espaço de uma linha que é curta de propósito.
 * URL impossível de parsear devolve null — e aí o cartão usa só o site_name.
 */
export function displayDomain(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/**
 * Trecho da citação (item 86) com teto de tamanho e sem quebra de linha.
 *
 * O servidor já apara, mas a citação é UMA linha na tela: uma quebra faria a
 * segunda linha aparecer cortada pelo `text-overflow`, e o texto de uma
 * mensagem de 4000 caracteres não pode entrar inteiro num nó que vai ser
 * elidido por CSS de qualquer jeito.
 */
export const EXCERPT_MAX = 140;

export function excerptText(raw: string): string {
  const uma = raw.replace(/\s+/gu, " ").trim();
  if (uma.length <= EXCERPT_MAX) return uma;
  return `${uma.slice(0, EXCERPT_MAX - 1)}…`;
}

/**
 * Link permanente da mensagem (item 84, "copiar link").
 *
 * O formato espelha o do Discord (`/channels/<canal>/<mensagem>`), mas mora no
 * FRAGMENTO: este cliente é uma página só, servida por `app://` no desktop e
 * por um caminho estático na web — um path de verdade daria 404 nos dois.
 *
 * Ninguém CONSOME este link ainda (não há roteador; abrir o fragmento não rola
 * até a mensagem). Ele já é útil como referência colável entre amigos, e o dia
 * em que o roteador existir o formato não muda.
 */
export function messageLink(origin: string, path: string, channelId: string, messageId: string): string {
  return `${origin}${path}#/channels/${channelId}/${messageId}`;
}
