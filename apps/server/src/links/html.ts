/**
 * Extração dos metadados de uma página (M11b, item 90): título, descrição e
 * nome do site. Módulo PURO — HTML entrando, três strings saindo.
 *
 * É regex e não um parser de DOM porque o projeto não instala dependência (e
 * escrever um parser de HTML tolerante a erro é um projeto inteiro, não um
 * item de marco). A escolha é segura AQUI por um motivo específico: nada do
 * que sai daqui vira HTML de novo. O cliente recebe texto puro e monta nós do
 * DOM (o cliente não usa `innerHTML` em lugar nenhum — regra do M7), então uma
 * extração imprecisa produz um título feio, nunca um script executado.
 *
 * O que sai daqui é, ainda assim, tratado como HOSTIL: vem de um site que
 * qualquer pessoa pode ter escolhido. Por isso tudo passa por `clean()` —
 * limite de tamanho, sem caractere de controle, sem quebra de linha.
 */

/** Tetos do texto exibido. Cabem num card de preview; o resto é ruído. */
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 400;
const MAX_SITE_NAME = 100;

export interface PageMeta {
  title: string | null;
  description: string | null;
  siteName: string | null;
}

/**
 * Lê os metadados. A ordem de preferência é a do Open Graph primeiro porque é
 * o que o autor do site escolheu MOSTRAR quando alguém compartilha a página —
 * o `<title>` costuma carregar sufixo de seção e nome do site repetido.
 */
export function extractMeta(html: string): PageMeta {
  // o que interessa mora no `<head>`; cortar ali evita varrer o corpo inteiro
  // e evita cair num `<title>` de SVG embutido no meio da página
  const headEnd = /<\/head\s*>/i.exec(html)?.index;
  const head = headEnd === undefined ? html : html.slice(0, headEnd);

  const metas = readMetaTags(head);
  const title =
    metas.get("og:title") ?? metas.get("twitter:title") ?? readTitleTag(head) ?? null;
  const description =
    metas.get("og:description") ?? metas.get("twitter:description") ?? metas.get("description") ?? null;
  const siteName = metas.get("og:site_name") ?? metas.get("application-name") ?? null;

  return {
    title: clean(title, MAX_TITLE),
    description: clean(description, MAX_DESCRIPTION),
    siteName: clean(siteName, MAX_SITE_NAME),
  };
}

/**
 * Todas as `<meta>` do trecho, indexadas pelo `property` (Open Graph) ou pelo
 * `name` (o resto), em minúsculas. A PRIMEIRA ocorrência vence: página que
 * repete `og:title` está tentando confundir alguém, e o primeiro é o que um
 * navegador usaria.
 */
function readMetaTags(head: string): Map<string, string> {
  const out = new Map<string, string>();
  const tag = /<meta\s+([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(head)) !== null) {
    const attrs = readAttributes(match[1] ?? "");
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    const value = attrs.get("content");
    if (key === "" || value === undefined) continue;
    if (!out.has(key)) out.set(key, value);
  }
  return out;
}

/** Atributos de uma tag: aspas duplas, simples ou sem aspas — os três casos. */
function readAttributes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const attr = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attr.exec(raw)) !== null) {
    const name = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!out.has(name)) out.set(name, decodeEntities(value));
  }
  return out;
}

function readTitleTag(head: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);
  return match?.[1] === undefined ? null : decodeEntities(match[1]);
}

/**
 * Entidades HTML mais comuns. Não é a tabela inteira (são ~2000 nomes) porque
 * uma entidade desconhecida sobrevivendo como `&hellip;` no título é um
 * defeito cosmético — enquanto uma tabela de 2000 linhas é um arquivo que
 * ninguém revisa.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // fora do plano Unicode (ou negativo) o fromCodePoint lança — devolver o
      // texto original é melhor que derrubar a busca inteira por um `&#99999999;`
      if (!Number.isFinite(code) || code <= 0 || code > 0x10_ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Saneamento final do texto que vai para a tela de todo mundo: sem caractere
 * de controle (inclusive os marcadores de trecho da busca e os de direção de
 * texto, que viram um título que se escreve ao contrário), espaço em branco
 * colapsado, e teto de tamanho. String vazia vira null — "sem título" e
 * "título em branco" são a mesma coisa para quem lê.
 */
function clean(value: string | null | undefined, max: number): string | null {
  if (value === undefined || value === null) return null;
  const stripped = [...value]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      // controle vira ESPAÇO (e não some): o `\n` de um título em duas linhas
      // separa palavras — apagá-lo grudaria "PrimeiraSegunda"
      if (code < 0x20 || code === 0x7f) return " ";
      // marcas de direção e de formatação invisíveis (U+200B..U+200F, U+202A..
      // U+202E, U+2066..U+2069): servem para disfarçar texto, e nada mais.
      // Estas SOMEM, porque não separam palavra nenhuma.
      if (code >= 0x200b && code <= 0x200f) return "";
      if (code >= 0x202a && code <= 0x202e) return "";
      if (code >= 0x2066 && code <= 0x2069) return "";
      return ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped === "") return null;
  return stripped.length > max ? `${stripped.slice(0, max - 1).trimEnd()}…` : stripped;
}
