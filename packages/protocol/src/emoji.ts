/**
 * Validação de emoji de reação (M11b, item 87) — módulo PURO, no molde do
 * `mentions.ts` do M11a: texto entrando e um booleano saindo, sem Zod, sem
 * fio, sem banco. É o que permite testá-lo sem subir nada, e é o que permite
 * cliente e servidor recusarem exatamente a MESMA coisa.
 *
 * Por que uma validação séria para "uma reação":
 *
 * Uma reação é uma linha de texto que aparece embaixo da mensagem de outra
 * pessoa, sem timeout de chat, sem edição, sem paginação e sem moderação. Se
 * `emoji` fosse string livre, "reagir" seria um segundo canal de mensagens —
 * com 20 slots por mensagem para escrever o que quisesse, e ninguém para
 * apagar. Daí a regra: UM grapheme cluster pictográfico, e nada mais.
 *
 * A regra em quatro linhas:
 *   1. no máximo 8 bytes em UTF-8;
 *   2. exatamente UM grapheme cluster (o que o usuário chama de "um caractere");
 *   3. o primeiro codepoint é pictográfico ou um indicador regional (bandeira);
 *   4. o que vier depois só pode ser seletor de variação, tom de pele, ou o
 *      segundo indicador regional do par.
 *
 * O que isso deixa de fora, de propósito:
 *   - sequências ZWJ (👨‍👩‍👧, 18 bytes): passam de 8 bytes e o ZWJ é recusado
 *     explicitamente. São o caminho por onde uma "reação" viraria um desenho
 *     arbitrariamente grande de renderizar;
 *   - keycaps (#️⃣): o primeiro codepoint é `#`, que não é pictográfico — a
 *     regra 3 pega, e a 1 pegaria de qualquer jeito nos casos maiores;
 *   - texto, espaço, controle, emoji duplicado ("😀😀" cabe em 8 bytes, mas
 *     são dois clusters).
 */

/** Seletores de variação: texto (FE0E) e emoji (FE0F). */
const VARIATION_SELECTORS = new Set([0xfe0e, 0xfe0f]);

/** Tons de pele (EMOJI MODIFIER FITZPATRICK TYPE-1-2 .. TYPE-6). */
const SKIN_TONE_MIN = 0x1f3fb;
const SKIN_TONE_MAX = 0x1f3ff;

/** Indicadores regionais: um PAR deles forma uma bandeira (🇧🇷). */
const REGIONAL_MIN = 0x1f1e6;
const REGIONAL_MAX = 0x1f1ff;

/** ZERO WIDTH JOINER — o que cola emojis em sequências compostas. */
const ZWJ = 0x200d;

/** Teto em bytes UTF-8. 8 é o que cabe: base + tom de pele, ou um par de bandeira. */
export const MAX_EMOJI_BYTES = 8;

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/**
 * Segmentador de grapheme clusters. Instanciado UMA vez (o construtor do
 * Intl.Segmenter é caro e isto roda por reação recebida). O locale não muda o
 * resultado para grapheme, mas passar um explícito evita depender do locale do
 * processo — que em servidor é o que estiver no ambiente.
 */
const graphemes = new Intl.Segmenter("pt-BR", { granularity: "grapheme" });

const utf8 = new TextEncoder();

function isRegional(cp: number): boolean {
  return cp >= REGIONAL_MIN && cp <= REGIONAL_MAX;
}

/**
 * A string é um emoji de reação aceitável?
 *
 * Devolve booleano e não lança: quem chama (a rota) transforma em 400 com uma
 * frase, e o cliente usa a mesma função para não deixar o pad oferecer o que o
 * servidor vai recusar.
 */
export function isValidReactionEmoji(value: string): boolean {
  if (value.length === 0) return false;
  // 1. teto de bytes ANTES de qualquer coisa: é a checagem barata, e é a que
  // limita o pior caso de tudo que vem depois
  if (utf8.encode(value).length > MAX_EMOJI_BYTES) return false;

  // 2. um grapheme cluster e só um — "😀😀" cabe nos 8 bytes e não pode passar
  const segments = [...graphemes.segment(value)];
  if (segments.length !== 1) return false;

  const points = [...value].map((ch) => ch.codePointAt(0) ?? 0);
  const [first, ...rest] = points;
  if (first === undefined) return false;

  // 3. a cabeça manda: pictográfico (😀) ou indicador regional (metade de 🇧🇷)
  const flag = isRegional(first);
  if (!flag && !PICTOGRAPHIC.test(String.fromCodePoint(first))) return false;

  // 4. a cauda é fechada: nada de ZWJ, nada de um segundo emoji colado
  let regionalSeen = flag ? 1 : 0;
  for (const cp of rest) {
    if (cp === ZWJ) return false;
    if (VARIATION_SELECTORS.has(cp)) continue;
    if (cp >= SKIN_TONE_MIN && cp <= SKIN_TONE_MAX) continue;
    if (isRegional(cp) && regionalSeen === 1) {
      regionalSeen = 2; // fecha a bandeira; um terceiro cai no return abaixo
      continue;
    }
    return false;
  }
  // meio par de bandeira (🇧 sozinho) renderiza como uma letra em caixa — não é emoji
  if (flag && regionalSeen !== 2) return false;
  return true;
}
