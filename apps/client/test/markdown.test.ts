/**
 * Markdown do chat (M11a, itens 78 e 79).
 *
 * O que se testa aqui NÃO é "o negrito ficou negrito" — é o conjunto de coisas
 * que, quando erradas, não aparecem no dia em que se escreve o parser:
 *
 *   - marcador não fechado comendo o resto da mensagem;
 *   - texto que PARECE HTML virando HTML;
 *   - `javascript:` chegando a um href;
 *   - uma mensagem esquisita (4000 asteriscos) travando a aba de quem só
 *     estava lendo o canal.
 *
 * O grosso roda contra `parseMarkdown`, que é puro — o Node não tem DOM. A
 * parte que só existe no DOM (atributos do link, a pílula clicável) roda contra
 * um `document` de mentira, minúsculo, definido no fim do arquivo: ele
 * implementa as SEIS chamadas que o renderizador faz e nada mais. Não é um
 * jsdom pela metade; é a fronteira do módulo escrita como código.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { EVERYONE_KEYWORD, isSafeHref, parseMarkdown, renderMarkdown, type MdNode } from "../src/ui/markdown.js";

// ---------------------------------------------------------------------------
// Atalhos de leitura
// ---------------------------------------------------------------------------

const md = (s: string, opts = {}): MdNode[] => parseMarkdown(s, opts);

/** Só os tipos de nó, em ordem — para asserção de FORMA sem escrever a árvore. */
const kinds = (nodes: MdNode[]): string[] => nodes.map((n) => n.kind);

/** Todo o texto visível, como o olho lê (o que entra no `textContent` no fim). */
function flat(nodes: MdNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.kind === "text") out += n.text;
    else if (n.kind === "code" || n.kind === "codeblock") out += n.text;
    else if (n.kind === "link") out += n.text;
    else if (n.kind === "mention") out += `@${n.label}`;
    else if (n.kind === "br") out += "\n";
    else out += flat(n.children);
  }
  return out;
}

/** Membros de mentira: o gancho `mentionOf` que o main.ts vai montar do state. */
const membros = (...nomes: string[]) => ({
  mentionOf: (nome: string): { id: string; label: string } | null => {
    const hit = nomes.find((n) => n.toLowerCase() === nome.toLowerCase());
    return hit === undefined ? null : { id: `id-${hit.toLowerCase()}`, label: hit };
  },
});

// ---------------------------------------------------------------------------
// Ênfase
// ---------------------------------------------------------------------------

test("os marcadores do subconjunto", () => {
  assert.deepEqual(md("**a**"), [{ kind: "strong", children: [{ kind: "text", text: "a" }] }]);
  assert.deepEqual(md("*a*"), [{ kind: "em", children: [{ kind: "text", text: "a" }] }]);
  assert.deepEqual(md("_a_"), [{ kind: "em", children: [{ kind: "text", text: "a" }] }]);
  assert.deepEqual(md("~~a~~"), [{ kind: "strike", children: [{ kind: "text", text: "a" }] }]);
  assert.deepEqual(md("__a__"), [{ kind: "underline", children: [{ kind: "text", text: "a" }] }]);
});

test("marcador NÃO fechado fica literal e não come o resto da mensagem", () => {
  assert.deepEqual(md("**oi"), [{ kind: "text", text: "**oi" }]);
  assert.deepEqual(md("~~oi"), [{ kind: "text", text: "~~oi" }]);
  // o caso que dói: o texto DEPOIS do marcador solto continua inteiro
  assert.equal(flat(md("**oi tudo bem? mensagem inteira aqui")), "**oi tudo bem? mensagem inteira aqui");
  assert.equal(flat(md("um *dois **tres")), "um *dois **tres");
});

test("aninhamento", () => {
  assert.deepEqual(md("**negrito com *italico* dentro**"), [
    {
      kind: "strong",
      children: [
        { kind: "text", text: "negrito com " },
        { kind: "em", children: [{ kind: "text", text: "italico" }] },
        { kind: "text", text: " dentro" },
      ],
    },
  ]);
  // três asteriscos são um marcador só (negrito + itálico), não "dois e sobra um"
  assert.deepEqual(kinds(md("***a***")), ["strong"]);
  assert.equal(flat(md("***a***")), "a");
});

test("par vazio não vira nó vazio", () => {
  assert.deepEqual(md("****"), [{ kind: "text", text: "****" }]);
});

test("sublinhado no meio de palavra é literal (`snake_case` não italiza)", () => {
  assert.deepEqual(md("snake_case_word"), [{ kind: "text", text: "snake_case_word" }]);
  // mas com borda o marcador vale
  assert.deepEqual(kinds(md("um _italico_ aqui")), ["text", "em", "text"]);
});

test("escape com barra invertida neutraliza o marcador", () => {
  assert.deepEqual(md("\\*nao marcador\\*"), [{ kind: "text", text: "*nao marcador*" }]);
  assert.deepEqual(md("\\`nao codigo\\`"), [{ kind: "text", text: "`nao codigo`" }]);
  assert.deepEqual(md("\\> nao citacao"), [{ kind: "text", text: "> nao citacao" }]);
  assert.deepEqual(md("\\\\ barra"), [{ kind: "text", text: "\\ barra" }]);
  // barra antes de caractere comum continua sendo barra (comportamento do Discord)
  assert.deepEqual(md("C:\\Users\\leo"), [{ kind: "text", text: "C:\\Users\\leo" }]);
});

// ---------------------------------------------------------------------------
// Código
// ---------------------------------------------------------------------------

test("dentro de código inline NADA é interpretado", () => {
  const nodes = md("`**a** https://x.com @todos`", membros("leo"));
  assert.deepEqual(nodes, [{ kind: "code", text: "**a** https://x.com @todos" }]);
});

test("bloco de código com e sem linguagem", () => {
  assert.deepEqual(md("```js\nconst a = 1;\n```"), [{ kind: "codeblock", lang: "js", text: "const a = 1;" }]);
  assert.deepEqual(md("```\nsem lang\n```"), [{ kind: "codeblock", lang: null, text: "sem lang" }]);
  // a linguagem não colore nada, mas não pode quebrar o parse
  assert.deepEqual(md("```c++\nx\n```"), [{ kind: "codeblock", lang: "c++", text: "x" }]);
});

test("dentro de bloco de código NADA é interpretado", () => {
  const nodes = md("```\n@todos **x** https://x.com\n> nao citacao\n```", membros("leo"));
  assert.deepEqual(nodes, [{ kind: "codeblock", lang: null, text: "@todos **x** https://x.com\n> nao citacao" }]);
});

test("cerca aberta e nunca fechada fica literal", () => {
  assert.deepEqual(md("```aberto sem fim"), [{ kind: "text", text: "```aberto sem fim" }]);
  assert.equal(flat(md("``` e o resto da mensagem continua aqui")), "``` e o resto da mensagem continua aqui");
  assert.deepEqual(md("crase solta ` fim"), [{ kind: "text", text: "crase solta ` fim" }]);
});

test("bloco de código não gera <br> em volta", () => {
  // a quebra que só existia para a cerca começar na linha dela não vira linha em branco
  assert.deepEqual(kinds(md("texto\n```js\ncode\n```\ndepois")), ["text", "codeblock", "text"]);
});

// ---------------------------------------------------------------------------
// Citação
// ---------------------------------------------------------------------------

test("citação pega a linha inteira e junta linhas seguidas", () => {
  assert.deepEqual(md("> citacao\n> segunda\nnormal"), [
    {
      kind: "quote",
      children: [
        { kind: "text", text: "citacao" },
        { kind: "br" },
        { kind: "text", text: "segunda" },
      ],
    },
    { kind: "text", text: "normal" },
  ]);
});

test("citação interpreta markdown dentro, e `>` no meio da linha não é citação", () => {
  assert.deepEqual(kinds((md("> **negrito**")[0] as { children: MdNode[] }).children), ["strong"]);
  assert.deepEqual(md("um > dois"), [{ kind: "text", text: "um > dois" }]);
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

test("http e https viram link", () => {
  assert.deepEqual(md("https://x.com"), [{ kind: "link", href: "https://x.com", text: "https://x.com" }]);
  assert.deepEqual(md("http://x.com"), [{ kind: "link", href: "http://x.com", text: "http://x.com" }]);
  assert.deepEqual(kinds(md("HTTPS://EXEMPLO.COM/A")), ["link"], "esquema em maiúsculas também");
});

test("nenhum outro esquema vira link — um teste por esquema", () => {
  for (const url of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///c:/windows",
    "ftp://x.com",
    "//evil.com",
  ]) {
    assert.deepEqual(kinds(md(url)), ["text"], `${url} não pode virar link`);
    assert.equal(isSafeHref(url), false, `${url} não passa no portão do href`);
  }
  assert.equal(isSafeHref("https://x.com"), true);
  assert.equal(isSafeHref("http://x.com"), true);
  // esquema partido por quebra de linha é o truque clássico de burlar o filtro
  assert.equal(isSafeHref("java\nscript:alert(1)"), false);
});

test("a pontuação que fecha a frase não entra no link", () => {
  assert.deepEqual(md("veja https://x.com/a. fim"), [
    { kind: "text", text: "veja " },
    { kind: "link", href: "https://x.com/a", text: "https://x.com/a" },
    { kind: "text", text: ". fim" },
  ]);
  for (const p of [",", ";", ":", "!", "?"]) {
    const nodes = md(`https://x.com/a${p}`);
    assert.deepEqual(nodes[0], { kind: "link", href: "https://x.com/a", text: "https://x.com/a" }, `sufixo ${p}`);
  }
  // marcador colado também fica de fora: o negrito continua funcionando
  assert.deepEqual(kinds(md("**https://x.com**")), ["strong"]);
});

test("parênteses: entram quando balanceados, saem quando não", () => {
  assert.deepEqual(md("https://pt.wikipedia.org/wiki/Cafe_(bebida)"), [
    { kind: "link", href: "https://pt.wikipedia.org/wiki/Cafe_(bebida)", text: "https://pt.wikipedia.org/wiki/Cafe_(bebida)" },
  ]);
  assert.deepEqual(md("(veja https://x.com/a)"), [
    { kind: "text", text: "(veja " },
    { kind: "link", href: "https://x.com/a", text: "https://x.com/a" },
    { kind: "text", text: ")" },
  ]);
});

test("URL com acento sobrevive inteira", () => {
  const url = "https://pt.wikipedia.org/wiki/Café";
  assert.deepEqual(md(url), [{ kind: "link", href: url, text: url }]);
});

test("esquema sem host não é link", () => {
  assert.deepEqual(md("https://"), [{ kind: "text", text: "https://" }]);
  assert.deepEqual(md("http://."), [{ kind: "text", text: "http://." }]);
});

// ---------------------------------------------------------------------------
// HTML aparente
// ---------------------------------------------------------------------------

test("texto que parece HTML sai como TEXTO visível", () => {
  const nodes = md("<script>alert(1)</script>");
  assert.deepEqual(nodes, [{ kind: "text", text: "<script>alert(1)</script>" }]);
  assert.equal(flat(md("<img src=x onerror=alert(1)>")), "<img src=x onerror=alert(1)>");
  assert.equal(flat(md("<b>oi</b>")), "<b>oi</b>");
});

test("o módulo não usa innerHTML em lugar nenhum", () => {
  // regra do projeto (CLAUDE.md): a sanitização aqui é ESTRUTURAL, e ela só
  // vale enquanto ninguém "otimizar" o renderizador com uma string de HTML
  const src = readFileSync(new URL("../src/ui/markdown.ts", import.meta.url), "utf8")
    // os comentários FALAM de innerHTML (é a decisão do arquivo); o que não
    // pode existir é a chamada
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  for (const proibido of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
    assert.equal(src.includes(proibido), false, `${proibido} apareceu no código do markdown.ts`);
  }
});

// ---------------------------------------------------------------------------
// Quebras de linha e entradas degeneradas
// ---------------------------------------------------------------------------

test("quebra de linha vira <br>", () => {
  assert.deepEqual(md("a\nb"), [{ kind: "text", text: "a" }, { kind: "br" }, { kind: "text", text: "b" }]);
  assert.deepEqual(kinds(md("a\r\nb")), ["text", "br", "text"], "CRLF de colagem no Windows não vira dois <br>");
});

test("string vazia, só espaços, só quebras", () => {
  assert.deepEqual(md(""), []);
  assert.deepEqual(md("   "), [{ kind: "text", text: "   " }]);
  assert.deepEqual(md("\n"), [{ kind: "br" }]);
  assert.deepEqual(md("\n\n\n"), [{ kind: "br" }, { kind: "br" }, { kind: "br" }]);
  assert.deepEqual(md("\n", membros("leo")), [{ kind: "br" }]);
});

test("entrada gigante não trava a aba", () => {
  // 4000 caracteres é o teto de uma mensagem. As entradas abaixo são as que
  // matam parser ingênuo: cada abertura procurando um fechamento que não existe
  // é O(n²) — 16 milhões de passos para uma mensagem que ninguém leu.
  const casos: Array<[string, string]> = [
    ["asteriscos", "*".repeat(4000)],
    ["asteriscos com texto", "*a".repeat(2000)],
    ["tils", "~".repeat(4000)],
    ["sublinhados", "_".repeat(4000)],
    ["crases", "`".repeat(4000)],
    ["cercas", "```".repeat(1333)],
    ["arrobas", "@a".repeat(2000)],
    ["citações", "> a\n".repeat(1000)],
    ["urls", "https://x.com/a ".repeat(250)],
    ["mistura", "*_~`@>".repeat(666)],
  ];
  for (const [nome, entrada] of casos) {
    const t0 = process.hrtime.bigint();
    const nodes = parseMarkdown(entrada, membros("leo"));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(Array.isArray(nodes), nome);
    assert.ok(ms < 500, `${nome} levou ${ms.toFixed(1)}ms — o parser voltou a ser quadrático`);
  }
});

// ---------------------------------------------------------------------------
// Menções (item 79)
// ---------------------------------------------------------------------------

test("menção casa pelo gancho e vira nó com o id resolvido", () => {
  assert.deepEqual(md("oi @leo", membros("leo")), [
    { kind: "text", text: "oi " },
    { kind: "mention", id: "id-leo", label: "leo", everyone: false },
  ]);
});

test("a borda é explícita: `@leo` não casa dentro de `@leonardo`", () => {
  const dois = membros("leo", "leonardo");
  assert.deepEqual(md("@leonardo", dois), [{ kind: "mention", id: "id-leonardo", label: "leonardo", everyone: false }]);
  assert.deepEqual(md("@leo", dois), [{ kind: "mention", id: "id-leo", label: "leo", everyone: false }]);
  // sem o membro "leonardo", `@leonardo` NÃO menciona o leo
  assert.deepEqual(md("@leonardo", membros("leo")), [{ kind: "text", text: "@leonardo" }]);
});

test("borda à esquerda: e-mail não menciona ninguém", () => {
  assert.deepEqual(md("contato@leo", membros("leo")), [{ kind: "text", text: "contato@leo" }]);
  assert.deepEqual(md("x@todos", membros()), [{ kind: "text", text: "x@todos" }]);
});

test("pontuação depois do nome fica fora da pílula", () => {
  assert.deepEqual(md("@leo.", membros("leo")), [
    { kind: "mention", id: "id-leo", label: "leo", everyone: false },
    { kind: "text", text: "." },
  ]);
  assert.deepEqual(kinds(md("@leo, oi", membros("leo"))), ["mention", "text"]);
});

test("apelido com espaço casa antes do nome curto", () => {
  const nodes = md("oi @leo hammes tudo bem", membros("leo", "leo hammes"));
  assert.deepEqual(nodes, [
    { kind: "text", text: "oi " },
    { kind: "mention", id: "id-leo hammes", label: "leo hammes", everyone: false },
    { kind: "text", text: " tudo bem" },
  ]);
});

test("@todos liga mentions_everyone", () => {
  assert.deepEqual(md(`@${EVERYONE_KEYWORD}`, membros("leo")), [
    { kind: "mention", id: null, label: EVERYONE_KEYWORD, everyone: true },
  ]);
  // um membro que se chame literalmente "todos" é mencionado como PESSOA — é o
  // desempate do parseMentions do protocolo
  assert.deepEqual(md("@todos", membros("todos")), [
    { kind: "mention", id: "id-todos", label: "todos", everyone: false },
  ]);
});

test("menção dentro de código não é menção", () => {
  assert.deepEqual(md("`@todos`", membros("leo")), [{ kind: "code", text: "@todos" }]);
  assert.deepEqual(md("`@leo`", membros("leo")), [{ kind: "code", text: "@leo" }]);
});

test("sem o gancho, `@nome` fica texto (mas `@todos` continua valendo)", () => {
  assert.deepEqual(md("@leo"), [{ kind: "text", text: "@leo" }]);
  assert.deepEqual(kinds(md("@todos")), ["mention"]);
});

// ---------------------------------------------------------------------------
// Render (DOM de mentira)
// ---------------------------------------------------------------------------

test("o link renderizado leva href, target e rel", () => {
  withFakeDom(() => {
    const a = only(renderMarkdown("https://x.com/a"), "a");
    assert.equal(a.getAttribute("href"), "https://x.com/a");
    assert.equal(a.getAttribute("target"), "_blank");
    // noopener: sem ele a página aberta pode navegar a nossa pelo window.opener
    assert.equal(a.getAttribute("rel"), "noopener noreferrer");
    assert.equal(a.textContent, "https://x.com/a");
    assert.equal(a.className, "md-link");
  });
});

test("href de esquema proibido não vira <a> nem quando a árvore diz que é link", () => {
  withFakeDom(() => {
    // o parser nunca produz isto; o portão do renderizador é a segunda tranca
    const frag = renderMarkdown("javascript:alert(1)");
    assert.equal(all(frag, "a").length, 0);
    assert.equal(frag.textContent, "javascript:alert(1)");
  });
});

test("nenhum <a> renderizado escapa do portão do href — lote adversarial", () => {
  // Veio de uma auditoria adversarial que jogou 25 payloads no parser. O achado
  // que importou: `https://\u0000evil` PASSA pelo parser (o esquema é https,
  // então vira nó de link) e é o `isSafeHref` do RENDERIZADOR que o barra, por
  // causa do byte de controle. Ou seja, as duas trancas não são redundantes —
  // cada uma pega um conjunto diferente, e é por isso que a asserção certa é
  // sobre o DOM produzido, e não sobre a árvore.
  withFakeDom(() => {
    for (const p of [
      "java\tscript:alert(1)",
      "\u0001javascript:alert(1)",
      " javascript:alert(1)",
      "https://\u0000evil",
      "http\u0000s://x",
      "https:javascript:alert(1)",
      "httpss://x.com",
      "\u202ejavascript:alert(1)",
      'https://x.com"onmouseover=alert(1)//',
      "[a](javascript:alert(1))",
      "![a](javascript:alert(1))",
      "**javascript:alert(1)**",
      "> <script>alert(1)</script>",
      "`</code><img src=x onerror=alert(1)>`",
      "```\n</code></pre><script>alert(1)</script>\n```",
    ]) {
      const frag = renderMarkdown(p);
      for (const a of all(frag, "a")) {
        const href = a.getAttribute("href") ?? "";
        assert.ok(isSafeHref(href), `href inseguro no DOM, vindo de ${JSON.stringify(p)}: ${JSON.stringify(href)}`);
      }
      // nenhum payload pode ter criado elemento executável
      for (const tag of ["script", "img", "iframe"]) {
        assert.equal(all(frag, tag).length, 0, `${JSON.stringify(p)} criou um <${tag}>`);
      }
    }
  });
});

test("HTML digitado vira texto no DOM, e não elemento", () => {
  withFakeDom(() => {
    const frag = renderMarkdown("<script>alert(1)</script>");
    assert.equal(all(frag, "script").length, 0, "nenhum <script> foi criado");
    assert.equal(frag.textContent, "<script>alert(1)</script>");
  });
});

test("a pílula clicável é BOTÃO e chama o callback com o id", () => {
  withFakeDom(() => {
    const cliques: string[] = [];
    const frag = renderMarkdown("oi @leo", {
      ...membros("leo"),
      onMentionClick: (id: string) => cliques.push(id),
    });
    const b = only(frag, "button");
    assert.equal(b.type, "button");
    assert.equal(b.textContent, "@leo");
    assert.equal(b.className, "md-mention");
    b.click();
    assert.deepEqual(cliques, ["id-leo"]);
  });
});

test("a pílula do EU tem classe própria — é como se acha onde foi chamado", () => {
  withFakeDom(() => {
    const frag = renderMarkdown("@leo e @ana", {
      ...membros("leo", "ana"),
      highlightSelf: "id-ana",
    });
    const pills = all(frag, "span").filter((e) => e.className.startsWith("md-mention"));
    assert.deepEqual(
      pills.map((p) => [p.textContent, p.className]),
      [
        ["@leo", "md-mention"],
        ["@ana", "md-mention md-mention--self"],
      ],
    );
    // @todos é para todo mundo: destaque sempre
    const todos = only(renderMarkdown("@todos"), "span");
    assert.equal(todos.className, "md-mention md-mention--self");
  });
});

test("bloco de código vira <pre><code> com a linguagem em data-lang", () => {
  withFakeDom(() => {
    const pre = only(renderMarkdown("```ts\nconst a = 1;\n```"), "pre");
    const code = only(pre, "code");
    assert.equal(code.getAttribute("data-lang"), "ts");
    assert.equal(code.textContent, "const a = 1;");
  });
});

test("a árvore inteira vira os elementos esperados", () => {
  withFakeDom(() => {
    // sem <br> antes do blockquote: bloco já quebra a linha, e um <br> ali
    // seria uma linha em branco que ninguém digitou
    const frag = renderMarkdown("**a** *b* ~~c~~ __d__ `e`\n> f");
    assert.deepEqual(tags(frag), ["strong", "em", "s", "u", "code", "blockquote"]);
    assert.deepEqual(tags(renderMarkdown("a\nb")), ["br"]);
  });
});

// ---------------------------------------------------------------------------
// O `document` de mentira
// ---------------------------------------------------------------------------

/**
 * Implementa só o que `renderMarkdown` usa: createElement, createTextNode,
 * createDocumentFragment, appendChild, setAttribute, className/type/textContent
 * e addEventListener. Um TextNode aqui é uma string — no DOM de verdade
 * `append`/`appendChild` de string dá no mesmo, e a diferença não muda nada do
 * que este arquivo verifica.
 */
class FakeEl {
  tag: string;
  className = "";
  type = "";
  attrs = new Map<string, string>();
  kids: Array<FakeEl | string> = [];
  listeners: Array<[string, () => void]> = [];

  constructor(tag: string) {
    this.tag = tag;
  }

  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }

  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }

  appendChild(n: FakeEl | string): FakeEl | string {
    this.kids.push(n);
    return n;
  }

  addEventListener(type: string, fn: () => void): void {
    this.listeners.push([type, fn]);
  }

  click(): void {
    for (const [type, fn] of this.listeners) if (type === "click") fn();
  }

  set textContent(v: string) {
    this.kids = v === "" ? [] : [v];
  }

  get textContent(): string {
    return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join("");
  }
}

const fakeDocument = {
  createElement: (tag: string): FakeEl => new FakeEl(tag),
  createTextNode: (t: string): string => t,
  createDocumentFragment: (): FakeEl => new FakeEl("#fragment"),
};

function withFakeDom(fn: () => void): void {
  const anyGlobal = globalThis as unknown as { document?: unknown };
  const before = anyGlobal.document;
  anyGlobal.document = fakeDocument;
  try {
    fn();
  } finally {
    anyGlobal.document = before;
  }
}

function all(root: unknown, tag: string): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl): void => {
    for (const k of el.kids) {
      if (typeof k === "string") continue;
      if (k.tag === tag) out.push(k);
      walk(k);
    }
  };
  walk(root as FakeEl);
  return out;
}

function only(root: unknown, tag: string): FakeEl {
  const hits = all(root, tag);
  assert.equal(hits.length, 1, `esperava exatamente um <${tag}>, achei ${hits.length}`);
  return hits[0] as FakeEl;
}

/** Todas as tags criadas, em ordem de profundidade — a forma do DOM em uma linha. */
function tags(root: unknown): string[] {
  const out: string[] = [];
  const walk = (el: FakeEl): void => {
    for (const k of el.kids) {
      if (typeof k === "string") continue;
      out.push(k.tag);
      walk(k);
    }
  };
  walk(root as FakeEl);
  return out;
}
