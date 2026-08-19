/**
 * Markdown do chat (M11a — itens 78 e 79 do ROADMAP).
 *
 * Até aqui o conteúdo da mensagem entrava por `textContent` puro: um link
 * colado ficava texto morto e `**negrito**` aparecia cru. Este módulo troca
 * aquela linha por um `DocumentFragment`.
 *
 * TRÊS decisões mandam no arquivo inteiro:
 *
 *  1. **Nada de `innerHTML`.** O parser produz NÓS do DOM, nunca string de
 *     HTML. É isso que torna a sanitização ESTRUTURAL em vez de textual: não
 *     existe um caminho para injetar tag, porque em momento nenhum se monta
 *     HTML como texto. Não há lista de tags proibidas para manter, não há
 *     escape para esquecer — o `<script>` que a pessoa digitou vira um
 *     `TextNode` com esse conteúdo, que é exatamente o que se quer ver.
 *
 *  2. **Parse e render são duas funções.** `parseMarkdown` é PURA (não toca
 *     em `document`) e devolve uma árvore de dados; `renderMarkdown` só
 *     traduz essa árvore para nós. Sem essa separação o módulo seria
 *     intestável no `node --test` — o Node não tem DOM. Toda a regra
 *     (precedência, marcador não fechado, o que vira link) vive no lado puro,
 *     que é o lado coberto por teste.
 *
 *  3. **O parser não conhece a lista de membros.** Quem sabe se `@leo` é
 *     alguém é o gancho `mentionOf` (o main.ts liga ele no `state.members`).
 *     O módulo só acha os CANDIDATOS no texto e pergunta. É o mesmo desenho
 *     do `sound/policy.ts`: a decisão num lugar só, e o call site sem `if`.
 *
 * Subconjunto suportado (o do Discord, sem inventar): `**negrito**`,
 * `*itálico*`/`_itálico_`, `~~riscado~~`, `__sublinhado__`, `` `código` ``,
 * bloco com três crases (linguagem opcional, sem colorir), `> citação`,
 * autolink http/https, quebra de linha, escape com `\` e menções.
 *
 * Complexidade: o scanner é uma passada linear; o casamento de marcadores usa
 * uma tabela pré-computada de "próxima ocorrência do MESMO marcador" (também
 * linear), então não há a busca aninhada que deixaria o parser quadrático.
 * Uma mensagem de 4000 asteriscos passa por aqui sem travar a aba — tem teste.
 */

import { EVERYONE_KEYWORD } from "@danjocord/protocol";

// ---------------------------------------------------------------------------
// Contrato público
// ---------------------------------------------------------------------------

export interface MarkdownOptions {
  /**
   * Resolve um candidato a menção. Recebe o nome COMO FOI DIGITADO (sem o `@`)
   * e devolve o usuário, ou `null` se ninguém casa — nesse caso o texto fica
   * literal. Quem implementa (main.ts) compara com `nickname` E `username`,
   * SEM distinção de maiúsculas — é o mesmo conjunto de chaves que o
   * `parseMentions` do protocolo monta no servidor. Comparar diferente aqui é
   * a única forma de a pílula e a contagem de menções discordarem.
   */
  mentionOf?: (nome: string) => { id: string; label: string } | null;
  /** clique na pílula (abre o card do membro, ui/user-controls.ts). */
  onMentionClick?: (userId: string) => void;
  /**
   * Meu id. A pílula do EU ganha destaque próprio — é a única forma de a
   * pessoa achar onde foi chamada rolando o histórico. `@todos` conta como
   * menção a mim por definição (ela é para todo mundo).
   */
  highlightSelf?: string;
}

/**
 * A árvore. Deliberadamente burra: só o que o renderizador precisa para criar
 * um nó. Nada aqui referencia `Node`, `Element` ou `document`.
 */
export type MdNode =
  | { kind: "text"; text: string }
  | { kind: "br" }
  | { kind: "strong"; children: MdNode[] }
  | { kind: "em"; children: MdNode[] }
  | { kind: "underline"; children: MdNode[] }
  | { kind: "strike"; children: MdNode[] }
  | { kind: "code"; text: string }
  | { kind: "codeblock"; lang: string | null; text: string }
  | { kind: "quote"; children: MdNode[] }
  | { kind: "link"; href: string; text: string }
  | { kind: "mention"; id: string | null; label: string; everyone: boolean };

/**
 * A palavra que liga `mentions_everyone` vem do PROTOCOLO, não daqui. É o
 * mesmo motivo de `roleRank`/`displayName` morarem lá (M10): o servidor conta
 * a menção e o cliente a pinta — com a palavra escrita nos dois lugares, o dia
 * em que ela mudar é o dia em que a pílula e a contagem discordam.
 */
export { EVERYONE_KEYWORD };

// ---------------------------------------------------------------------------
// Segurança de URL
// ---------------------------------------------------------------------------

/**
 * O portão do `href`. Em tese é redundante — o scanner só cria link quando o
 * texto começa com `http://` ou `https://`, então `javascript:` nunca chega
 * aqui. Existe assim mesmo porque é a única função que alguém vai ler antes
 * de mexer no scanner, e porque `renderMarkdown` pode um dia receber árvore
 * vinda de outro lugar. Defesa em profundidade custa cinco linhas.
 *
 * Só http e https passam. `javascript:`, `data:`, `vbscript:`, `file:` e
 * qualquer outro esquema são recusados — e o `\s` na primeira checagem barra o
 * truque clássico de partir o esquema com quebra de linha (`java\nscript:`).
 */
export function isSafeHref(href: string): boolean {
  // espaço/controle no meio do esquema é sempre ataque, nunca URL: barra o
  // truque clássico de partir `javascript:` com uma quebra de linha no meio
  if (/[\s\u0000-\u001f\u007f]/.test(href)) return false;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  if (m === null) return false;
  const scheme = (m[1] ?? "").toLowerCase();
  return scheme === "http" || scheme === "https";
}

// ---------------------------------------------------------------------------
// Léxico
// ---------------------------------------------------------------------------

/** O que o `\` pode neutralizar. Fora desta lista o `\` fica literal (como no Discord). */
const ESCAPABLE = "*_~`>\\@";

/** Marcadores de ênfase. Os de três caracteres são pares legítimos, não sobra de dois. */
type MarkKind = "***" | "**" | "*" | "___" | "__" | "_" | "~~";

type Tok =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "link"; href: string }
  | { t: "mention"; id: string | null; label: string; everyone: boolean }
  | { t: "mark"; v: MarkKind };

const WORD_RE = /[\p{L}\p{N}]/u;
/** caracteres que podem compor um nome de usuário/apelido dentro do texto */
const NAME_RE = /[\p{L}\p{N}_.-]/u;
const SCHEME_RE = /^https?:\/\//i;

/** onde a URL termina sem discussão: espaço e os delimitadores que ninguém digita dentro de link */
const URL_STOP = new Set([" ", "\t", "\n", "\r", "\u00a0", "<", ">", '"', "`", "|", "\\"]);
/** pontuação de fim de frase (e marcadores) que o olho lê como fora do link */
const URL_TRAIL = ".,;:!?'\"*_~";

function isWord(ch: string | undefined): boolean {
  return ch !== undefined && WORD_RE.test(ch);
}

function isName(ch: string | undefined): boolean {
  return ch !== undefined && NAME_RE.test(ch);
}

function runLen(src: string, at: number, ch: string): number {
  let n = 0;
  while (src[at + n] === ch) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// Blocos: cercas de código e citação
// ---------------------------------------------------------------------------

const FENCE = "```";
/** `> ` no começo da linha. O espaço é opcional; `\>` não casa (o `\` está na frente). */
const QUOTE_RE = /^>[ \t]?(.*)$/;

type Seg = { code: false; text: string } | { code: true; lang: string | null; text: string };

/**
 * Separa o conteúdo em trechos literais e blocos de código, ANTES de qualquer
 * outra coisa. A cerca ganha de tudo — é o que garante "dentro de código nada
 * é interpretado" sem espalhar um `if (dentroDeCodigo)` pelo parser inteiro.
 *
 * Cerca aberta e nunca fechada NÃO vira bloco: o trecho segue literal e as
 * crases aparecem na tela. Comer o resto da mensagem porque alguém digitou
 * três crases é o pior erro possível aqui.
 */
function segments(content: string): Seg[] {
  const out: Seg[] = [];
  let i = 0;
  while (i < content.length) {
    const open = content.indexOf(FENCE, i);
    if (open === -1) break;
    const close = content.indexOf(FENCE, open + FENCE.length);
    if (close === -1) break;

    let before = content.slice(i, open);
    // a quebra que só existe para a cerca começar na própria linha não vira <br>
    if (before.endsWith("\n")) before = before.slice(0, -1);
    if (before !== "") out.push({ code: false, text: before });

    let body = content.slice(open + FENCE.length, close);
    let lang: string | null = null;
    const nl = body.indexOf("\n");
    if (nl !== -1) {
      const first = body.slice(0, nl);
      if (first !== "" && /^[A-Za-z0-9+#._-]{1,20}$/.test(first)) {
        lang = first.toLowerCase();
        body = body.slice(nl + 1);
      } else if (first === "") {
        body = body.slice(1);
      }
    }
    if (body.endsWith("\n")) body = body.slice(0, -1);
    out.push({ code: true, lang, text: body });

    i = close + FENCE.length;
    if (content[i] === "\n") i += 1;
  }
  if (i < content.length) out.push({ code: false, text: content.slice(i) });
  // conteúdo vazio ainda precisa de um trecho, senão `parseMarkdown("")` não
  // passa por lugar nenhum (e o resultado seria o mesmo, mas por acidente)
  if (out.length === 0) out.push({ code: false, text: content });
  return out;
}

// ---------------------------------------------------------------------------
// Scanner (uma passada, linear)
// ---------------------------------------------------------------------------

function scan(src: string, opts: MarkdownOptions): Tok[] {
  const out: Tok[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf !== "") {
      out.push({ t: "text", v: buf });
      buf = "";
    }
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;

    // 1. escape: `\*` é um asterisco, não um marcador
    if (c === "\\") {
      const n = src[i + 1];
      if (n !== undefined && ESCAPABLE.includes(n)) {
        buf += n;
        i += 2;
        continue;
      }
      buf += c;
      i += 1;
      continue;
    }

    // 2. código inline — precedência MÁXIMA entre os inline: o que está aqui
    //    dentro vira um token opaco, e por isso nem link nem negrito nem
    //    menção existem lá. Não é uma regra extra; é consequência do token.
    if (c === "`") {
      const run = runLen(src, i, "`");
      if (run <= 2) {
        const fence = "`".repeat(run);
        const close = src.indexOf(fence, i + run);
        if (close !== -1) {
          flush();
          out.push({ t: "code", v: src.slice(i + run, close) });
          i = close + run;
          continue;
        }
      }
      // crase sem par (ou run de 3 que sobrou de uma cerca não fechada): literal
      buf += src.slice(i, i + run);
      i += run;
      continue;
    }

    // 3. autolink
    if ((c === "h" || c === "H") && SCHEME_RE.test(src.slice(i, i + 8))) {
      const end = urlEnd(src, i);
      if (end > i) {
        flush();
        out.push({ t: "link", href: src.slice(i, end) });
        i = end;
        continue;
      }
    }

    // 4. menção
    if (c === "@") {
      const m = mentionAt(src, i, opts);
      if (m !== null) {
        flush();
        out.push(m.tok);
        i = m.end;
        continue;
      }
    }

    // 5. marcadores de ênfase
    const mk = markAt(src, i);
    if (mk !== null) {
      flush();
      out.push({ t: "mark", v: mk });
      i += mk.length;
      continue;
    }

    buf += c;
    i += 1;
  }
  flush();
  return out;
}

/**
 * Fim da URL. Duas correções sobre "vai até o espaço", que são o que faz o
 * link parecer certo em texto de gente:
 *
 *  - pontuação de fim de frase não entra ("veja https://x.com." → o ponto fica
 *    de fora), e marcador também não (`**https://x.com**` continua negrito);
 *  - parêntese/colchete/chave só entram se estiverem BALANCEADOS dentro da
 *    URL. É o que separa `.../Foo_(bar)` — que precisa do fecha-parêntese —
 *    de `(veja https://x.com)`, que não.
 */
function urlEnd(src: string, start: number): number {
  let end = start;
  while (end < src.length && !URL_STOP.has(src[end] as string)) end += 1;

  for (;;) {
    if (end <= start) break;
    const last = src[end - 1] as string;
    if (URL_TRAIL.includes(last)) {
      end -= 1;
      continue;
    }
    const open = last === ")" ? "(" : last === "]" ? "[" : last === "}" ? "{" : null;
    if (open !== null && !balanced(src, start, end, open, last)) {
      end -= 1;
      continue;
    }
    break;
  }

  const m = SCHEME_RE.exec(src.slice(start, end));
  // sobrou só o esquema (`https://` solto, ou `http://.`): não é link
  if (m === null || end - start <= (m[0] ?? "").length) return start;
  return end;
}

function balanced(src: string, start: number, end: number, open: string, close: string): boolean {
  let n = 0;
  for (let i = start; i < end; i += 1) {
    if (src[i] === open) n += 1;
    else if (src[i] === close) n -= 1;
  }
  return n >= 0;
}

/**
 * Marcador de ênfase começando em `i`, ou null.
 *
 * O sublinhado tem uma regra a mais: `snake_case` NÃO vira itálico. Um `_`
 * cercado por caracteres de palavra dos dois lados é literal — é a diferença
 * entre um marcador e o miolo de um identificador, e é o comportamento do
 * Discord. O asterisco não tem essa regra (lá `a*b*c` italiza mesmo).
 */
function markAt(src: string, i: number): MarkKind | null {
  const c = src[i];
  if (c === "~") return src[i + 1] === "~" ? "~~" : null;
  if (c !== "*" && c !== "_") return null;

  const run = Math.min(runLen(src, i, c), 3);
  const kind = c.repeat(run) as MarkKind;
  if (c === "_" && isWord(src[i - 1]) && isWord(src[i + run])) return null;
  return kind;
}

// ---------------------------------------------------------------------------
// Menções
// ---------------------------------------------------------------------------

/**
 * Tamanho máximo de um nome dentro do texto. Existe para limitar o número de
 * candidatos por `@` (o pior caso é uma palavra colada de 48 caracteres), e
 * não porque nome maior seja inválido — apelido de 50 letras é problema de
 * quem escolheu.
 */
const MENTION_MAX = 48;

/**
 * A borda DEPOIS do nome, igual à do `parseMentions` do protocolo: pula a
 * pontuação final (`.` e `-`) e exige que depois dela não venha caractere de
 * nome. É o que faz "@leo." no fim da frase mencionar o leo sem que "@leonardo"
 * mencione ele também.
 */
function borderAfter(src: string, end: number): boolean {
  let i = end;
  while (i < src.length && (src[i] === "." || src[i] === "-")) i += 1;
  return !isName(src[i]);
}

/**
 * Uma menção começando no `@` em `at`, ou null.
 *
 * A REGRA É A DO PROTOCOLO — `parseMentions` (packages/protocol/src/mentions.ts)
 * é quem decide, no POST, quais ids vão para `message_mentions`, e este arquivo
 * só precisa PINTAR o mesmo trecho. Divergir aqui produz o pior bug possível
 * do item 79: a pessoa vê a pílula destacada e não recebe notificação nenhuma,
 * ou o contrário. Por isso as três bordas são copiadas de lá:
 *
 *   - antes do `@`: início do texto ou caractere que não é de nome (senão
 *     "contato@leo" notificaria o leo, e todo e-mail viraria menção);
 *   - depois do nome: `borderAfter` acima;
 *   - casamento MAIS LONGO primeiro, para `@leo` não engolir `@leonardo`.
 *
 * A diferença de FORMA é só quem tem a lista: lá a função recebe os membros e
 * varre as chaves; aqui a lista está no main.ts e entra pelo gancho
 * `mentionOf`, então o parser oferece os candidatos (do mais longo para o mais
 * curto) e pergunta. Com o mesmo conjunto de chaves os dois casam o mesmo
 * trecho. O jeito de eliminar de vez a chance de divergir é o protocolo passar
 * a exportar as POSIÇÕES (um `mentionSpans`) e este arquivo consumi-las — está
 * no relatório do M11a.
 *
 * Apelido com espaço existe (item 55 do M10) e por isso o espaço entra na
 * varredura: "@leo hammes" é um candidato antes de "@leo".
 */
function mentionAt(src: string, at: number, opts: MarkdownOptions): { tok: Tok; end: number } | null {
  if (isName(src[at - 1])) return null;

  const resolve = opts.mentionOf;
  for (const cand of mentionCandidates(src, at)) {
    const hit = resolve?.(cand.name) ?? null;
    if (hit !== null) {
      return { tok: { t: "mention", id: hit.id, label: hit.label, everyone: false }, end: cand.end };
    }
    // `@todos` vem DEPOIS do gancho no mesmo comprimento — é o desempate do
    // protocolo: um membro que se chame literalmente "todos" é mencionado como
    // pessoa, não como a guild inteira.
    if (cand.name.toLowerCase() === EVERYONE_KEYWORD) {
      return { tok: { t: "mention", id: null, label: cand.name, everyone: true }, end: cand.end };
    }
  }
  return null;
}

/**
 * Candidatos a nome depois do `@`, do MAIS LONGO para o mais curto, e só os
 * que terminam numa borda válida. É a versão "não tenho a lista de chaves" do
 * casamento mais-longo-primeiro do protocolo.
 */
function mentionCandidates(src: string, at: number): Array<{ name: string; end: number }> {
  const from = at + 1;
  let stop = from;
  // o espaço entra na varredura por causa do apelido com espaço; o corte por
  // borda logo abaixo é que decide onde o nome pode de fato terminar
  while (stop < src.length && stop - from < MENTION_MAX && (isName(src[stop]) || src[stop] === " ")) stop += 1;

  const out: Array<{ name: string; end: number }> = [];
  for (let end = stop; end > from; end -= 1) {
    if (src[end - 1] === " ") continue; // nome não termina em espaço
    if (!borderAfter(src, end)) continue;
    out.push({ name: src.slice(from, end), end });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Casamento de marcadores
// ---------------------------------------------------------------------------

/**
 * Para cada token de marcador, o índice do PRÓXIMO marcador igual (ou -1).
 * Uma passada de trás para frente resolve a tabela toda; sem ela cada abertura
 * varreria o resto da mensagem atrás de um fechamento que talvez não exista, e
 * uma mensagem com muitos marcadores soltos viraria O(n²).
 */
function closers(toks: Tok[]): number[] {
  const next = new Array<number>(toks.length).fill(-1);
  const last = new Map<MarkKind, number>();
  for (let i = toks.length - 1; i >= 0; i -= 1) {
    const tk = toks[i] as Tok;
    if (tk.t !== "mark") continue;
    next[i] = last.get(tk.v) ?? -1;
    last.set(tk.v, i);
  }
  return next;
}

function wrapMark(kind: MarkKind, children: MdNode[]): MdNode {
  switch (kind) {
    case "*":
    case "_":
      return { kind: "em", children };
    case "**":
      return { kind: "strong", children };
    case "***":
      return { kind: "strong", children: [{ kind: "em", children }] };
    case "__":
      return { kind: "underline", children };
    case "___":
      return { kind: "underline", children: [{ kind: "em", children }] };
    case "~~":
      return { kind: "strike", children };
  }
}

function pushText(out: MdNode[], text: string): void {
  if (text === "") return;
  const last = out[out.length - 1];
  // juntar com o vizinho mantém a árvore (e o DOM) sem TextNodes picados
  if (last !== undefined && last.kind === "text") last.text += text;
  else out.push({ kind: "text", text });
}

/**
 * Monta a árvore da faixa de tokens [from, to).
 *
 * Marcador sem fechamento DENTRO da faixa vira texto literal — é o que impede
 * `**oi` de comer o resto da mensagem.
 *
 * A recursão é rasa por construção: um `*` casa sempre com a PRÓXIMA
 * ocorrência de `*`, então dentro da faixa que ele abriu não existe outro `*`.
 * A profundidade fica limitada ao número de marcadores diferentes (sete), não
 * ao tamanho da mensagem — não há entrada que estoure a pilha.
 */
function build(toks: Tok[], next: number[], from: number, to: number): MdNode[] {
  const out: MdNode[] = [];
  let i = from;
  while (i < to) {
    const tk = toks[i] as Tok;
    switch (tk.t) {
      case "text":
        pushText(out, tk.v);
        i += 1;
        continue;
      case "code":
        out.push({ kind: "code", text: tk.v });
        i += 1;
        continue;
      case "link":
        out.push({ kind: "link", href: tk.href, text: tk.href });
        i += 1;
        continue;
      case "mention":
        out.push({ kind: "mention", id: tk.id, label: tk.label, everyone: tk.everyone });
        i += 1;
        continue;
      case "mark": {
        const j = next[i] ?? -1;
        if (j !== -1 && j < to) {
          const children = build(toks, next, i + 1, j);
          // `****` (par vazio) não vira nó vazio: vira os quatro asteriscos
          if (children.length === 0) pushText(out, tk.v + tk.v);
          else out.push(wrapMark(tk.v, children));
          i = j + 1;
          continue;
        }
        pushText(out, tk.v);
        i += 1;
        continue;
      }
    }
  }
  return out;
}

function inline(src: string, opts: MarkdownOptions): MdNode[] {
  const toks = scan(src, opts);
  return build(toks, closers(toks), 0, toks.length);
}

// ---------------------------------------------------------------------------
// Parse (puro)
// ---------------------------------------------------------------------------

type Unit = { block: MdNode } | { inline: MdNode[] };

/**
 * A árvore da mensagem. PURA — não toca em `document`, e é por aqui que o
 * teste do Node entra.
 */
export function parseMarkdown(content: string, opts: MarkdownOptions = {}): MdNode[] {
  // \r\n vem de colagem no Windows; se sobrasse, viraria um <br> a mais
  const src = content.replace(/\r\n?/g, "\n");

  const units: Unit[] = [];
  for (const seg of segments(src)) {
    if (seg.code) {
      units.push({ block: { kind: "codeblock", lang: seg.lang, text: seg.text } });
      continue;
    }
    const lines = seg.text.split("\n");
    let i = 0;
    while (i < lines.length) {
      if (QUOTE_RE.test(lines[i] as string)) {
        // linhas de citação seguidas viram UM bloco só, como no Discord
        const children: MdNode[] = [];
        let first = true;
        while (i < lines.length) {
          const m = QUOTE_RE.exec(lines[i] as string);
          if (m === null) break;
          if (!first) children.push({ kind: "br" });
          children.push(...inline(m[1] ?? "", opts));
          first = false;
          i += 1;
        }
        units.push({ block: { kind: "quote", children } });
        continue;
      }
      units.push({ inline: inline(lines[i] as string, opts) });
      i += 1;
    }
  }

  // O <br> só existe ENTRE duas linhas de texto: citação e bloco de código já
  // quebram a linha por serem blocos, e um <br> ao lado deles seria uma linha
  // em branco que ninguém digitou.
  const out: MdNode[] = [];
  let prevInline = false;
  for (const u of units) {
    if ("block" in u) {
      out.push(u.block);
      prevInline = false;
      continue;
    }
    if (prevInline) out.push({ kind: "br" });
    out.push(...u.inline);
    prevInline = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Render (DOM)
// ---------------------------------------------------------------------------

/**
 * O conteúdo de uma mensagem, pronto para entrar no `.msg-content`.
 *
 * Substitui `content.textContent = msg.content` — e é a única função que os
 * call sites precisam conhecer.
 */
export function renderMarkdown(content: string, opts: MarkdownOptions = {}): DocumentFragment {
  const frag = document.createDocumentFragment();
  appendNodes(frag, parseMarkdown(content, opts), opts);
  return frag;
}

function appendNodes(parent: Node, nodes: MdNode[], opts: MarkdownOptions): void {
  for (const n of nodes) parent.appendChild(nodeEl(n, opts));
}

function elWith(tag: string, className: string, children: MdNode[], opts: MarkdownOptions): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  appendNodes(el, children, opts);
  return el;
}

function nodeEl(node: MdNode, opts: MarkdownOptions): Node {
  switch (node.kind) {
    case "text":
      return document.createTextNode(node.text);
    case "br":
      return document.createElement("br");
    case "strong":
      return elWith("strong", "md-strong", node.children, opts);
    case "em":
      return elWith("em", "md-em", node.children, opts);
    case "underline":
      return elWith("u", "md-underline", node.children, opts);
    case "strike":
      return elWith("s", "md-strike", node.children, opts);
    case "code": {
      const el = document.createElement("code");
      el.className = "md-code";
      el.textContent = node.text;
      return el;
    }
    case "codeblock": {
      const pre = document.createElement("pre");
      pre.className = "md-codeblock";
      const code = document.createElement("code");
      code.textContent = node.text;
      // a linguagem NÃO colore nada (isso é outro item); fica no DOM para o dia
      // em que colorir, e para quem inspeciona
      if (node.lang !== null) code.setAttribute("data-lang", node.lang);
      pre.appendChild(code);
      return pre;
    }
    case "quote":
      return elWith("blockquote", "md-quote", node.children, opts);
    case "link":
      return linkEl(node.href, node.text);
    case "mention":
      return mentionEl(node, opts);
  }
}

function linkEl(href: string, text: string): Node {
  // segundo portão: árvore com href de esquema proibido vira TEXTO, não link
  if (!isSafeHref(href)) return document.createTextNode(text);
  const a = document.createElement("a");
  a.className = "md-link";
  // setAttribute e não `a.href`: a propriedade resolve para absoluto e a gente
  // quer no DOM exatamente o que a pessoa escreveu
  a.setAttribute("href", href);
  a.setAttribute("target", "_blank");
  // noopener: sem isso a página aberta ganha `window.opener` e pode navegar a
  // nossa. noreferrer: o link de um amigo não precisa saber de onde veio.
  a.setAttribute("rel", "noopener noreferrer");
  a.textContent = text;
  return a;
}

function mentionEl(
  node: { id: string | null; label: string; everyone: boolean },
  opts: MarkdownOptions,
): Node {
  const label = `@${node.label}`;
  const self = node.everyone || (node.id !== null && node.id === opts.highlightSelf);
  const cls = `md-mention${self ? " md-mention--self" : ""}`;
  const click = opts.onMentionClick;

  // Pílula clicável é BOTÃO, não span com onclick: teclado e leitor de tela
  // ganham de graça o que um span exigiria fingir com role/tabindex. Sem
  // handler (ou sem id, como no @todos) é um span mesmo — não há o que clicar.
  if (node.id !== null && click !== undefined) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    const id = node.id;
    b.addEventListener("click", () => {
      click(id);
    });
    return b;
  }

  const s = document.createElement("span");
  s.className = cls;
  s.textContent = label;
  return s;
}
