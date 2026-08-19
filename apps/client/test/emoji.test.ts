/**
 * Emoji (M11b, item 88).
 *
 * O que se testa aqui não é "o 😄 é o smile" — isso é a tabela, e a tabela é
 * dado. O que se testa é o **teclado**: as quatro funções puras decidem quando
 * uma listinha aparece por cima do que a pessoa está escrevendo, e errar aí é
 * um bug que aparece em toda mensagem digitada. Os casos abaixo são os que dão
 * errado quando ninguém olha:
 *
 *   - `:` sozinho abrindo o painel a cada dois-pontos digitado;
 *   - `foo:` e `12:30` e `http://` abrindo painel onde não há atalho nenhum;
 *   - atalho abrindo DENTRO de bloco de código, oferecendo um emoji que o
 *     renderizador do M11a vai mostrar como texto literal;
 *   - a substituição comendo o resto da frase quando o cursor está no meio;
 *   - busca sem acento não achando palavra com acento (e vice-versa).
 *
 * Tudo aqui é puro: `ui/emoji.ts` não toca em DOM na carga do módulo (o painel
 * nasce dentro de `garantirPainel()`), então o Node importa o arquivo inteiro
 * sem precisar de um `document` de mentira como o teste de markdown precisou.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CATEGORIAS, EMOJIS } from "../src/ui/emoji-data.js";
import { activeShortcode, applyShortcode, emojiByName, searchEmoji, type Emoji } from "../src/ui/emoji.js";

/** Atalho de leitura: só os nomes, para asserção sem escrever objeto. */
const nomes = (lista: Emoji[]): string[] => lista.map((e) => e.name);

/** Falha cedo e com nome: um teste que morre em `undefined.char` não ensina nada. */
function exigir(nome: string): Emoji {
  const e = emojiByName(nome);
  if (e === null) throw new Error(`a tabela precisa ter :${nome}: — os testes abaixo o usam`);
  return e;
}

const smile = exigir("smile");

/**
 * U+200D escrito por codePoint e não como caractere: o ZWJ é INVISÍVEL, e um
 * teste cujo dado não aparece na revisão é um teste que ninguém confere.
 */
const ZWJ = String.fromCodePoint(0x200d);

// ---------------------------------------------------------------------------
// A tabela
// ---------------------------------------------------------------------------

test("o catálogo cabe no orçamento combinado", () => {
  // 300–500 é a faixa decidida no pacote: menos que isso deixa buraco óbvio,
  // mais que isso é bundle que todo mundo baixa para usar trinta
  assert.ok(EMOJIS.length >= 300, `poucos emoji: ${EMOJIS.length}`);
  assert.ok(EMOJIS.length <= 500, `emoji demais: ${EMOJIS.length}`);
});

test("nome e caractere são únicos", () => {
  const vistosNome = new Set<string>();
  const vistosChar = new Set<string>();
  for (const e of EMOJIS) {
    assert.ok(!vistosNome.has(e.name), `nome repetido: ${e.name}`);
    // caractere repetido não é só desperdício: a grade mostraria o mesmo glifo
    // duas vezes e a busca ficaria com duas respostas certas para uma pergunta
    assert.ok(!vistosChar.has(e.char), `caractere repetido: ${e.name}`);
    vistosNome.add(e.name);
    vistosChar.add(e.char);
  }
});

test("o nome serve como `:atalho:` e como id de DOM", () => {
  // o seletor monta `id="ep-op-<name>"` e o autocomplete casa `:<name>` contra
  // o charset do atalho — um nome com espaço ou dois-pontos quebraria os dois
  for (const e of EMOJIS) {
    assert.match(e.name, /^[a-z0-9_+-]+$/, `nome inválido: ${e.name}`);
    for (const a of e.aliases) assert.match(a, /^[a-z0-9_+-]+$/, `apelido inválido: ${a}`);
  }
});

test("nada de sequência ZWJ nem tom de pele", () => {
  // decisão da tabela: essas sequências caem em dois quadrados na fonte de
  // sistema de alguém, e um emoji quebrado é pior que um emoji ausente
  for (const e of EMOJIS) {
    assert.ok(!e.char.includes(ZWJ), `ZWJ em ${e.name}`);
    assert.ok(!/[\u{1F3FB}-\u{1F3FF}]/u.test(e.char), `tom de pele em ${e.name}`);
  }
});

test("todo emoji tem categoria conhecida e ao menos uma palavra-chave", () => {
  const ids = new Set(CATEGORIAS.map((c) => c.id));
  for (const e of EMOJIS) {
    assert.ok(ids.has(e.categoria), `categoria desconhecida em ${e.name}`);
    // sem palavra em português o emoji só é encontrável por quem já sabe o
    // nome em inglês — que é exatamente quem não precisa do seletor
    assert.ok(e.keywords.length > 0, `sem palavras-chave: ${e.name}`);
  }
});

test("toda categoria declarada tem emoji", () => {
  for (const { id } of CATEGORIAS) {
    assert.ok(
      EMOJIS.some((e) => e.categoria === id),
      `categoria vazia desenharia um título solto na grade: ${id}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------------

test("nome exato ganha do nome que só começa igual", () => {
  // sem a escala de peso, `smile` viria depois de `smiley` só porque a tabela
  // os ordena assim — e o emoji mais óbvio ficaria no fim da lista
  assert.equal(searchEmoji("smile")[0]?.name, "smile");
  assert.equal(searchEmoji("grin")[0]?.name, "grin");
});

test("apelido é caminho de primeira classe", () => {
  assert.equal(searchEmoji("+1")[0]?.name, "thumbsup");
  assert.equal(searchEmoji("-1")[0]?.name, "thumbsdown");
  assert.equal(emojiByName("+1")?.name, "thumbsup");
  assert.equal(emojiByName("red_heart")?.name, "heart");
});

test("acento não separa quem procura do que existe", () => {
  // o caso do enunciado: quem digita sem acento acha a palavra com acento…
  assert.ok(nomes(searchEmoji("corac")).includes("heart"));
  // …e quem digita COM acento acha a mesma coisa
  assert.ok(nomes(searchEmoji("coração")).includes("heart"));
  // o outro lado: a palavra da tabela é que tem o acento (`caubói`, `auréola`)
  assert.ok(nomes(searchEmoji("cauboi")).includes("cowboy_hat_face"));
  assert.ok(nomes(searchEmoji("aureola")).includes("innocent"));
});

test("busca em português acha pelo sentido, não só pelo nome inglês", () => {
  assert.ok(nomes(searchEmoji("risada")).includes("rofl"));
  assert.ok(nomes(searchEmoji("joia")).includes("thumbsup"));
  assert.ok(nomes(searchEmoji("fogo")).includes("fire"));
  assert.ok(nomes(searchEmoji("cerveja")).includes("beer"));
});

test("vários termos são E, não OU", () => {
  const achados = nomes(searchEmoji("gato apaixonado"));
  assert.ok(achados.includes("heart_eyes_cat"), "o E deixou de fora quem casa com os dois termos");
  // e o ponto do teste: "apaixonado" sozinho traria heart_eyes e companhia —
  // com OU a lista viria cheia de coisa que não tem nada de gato
  assert.ok(nomes(searchEmoji("apaixonado")).includes("heart_eyes"));
  assert.ok(!achados.includes("heart_eyes"));
});

test("consulta vazia devolve vazio, e não o catálogo inteiro", () => {
  // quem quer tudo usa EMOJIS; uma função chamada `search` devolvendo 469
  // itens seria armadilha para o próximo que a usar num autocomplete
  assert.deepEqual(searchEmoji(""), []);
  assert.deepEqual(searchEmoji("   "), []);
  assert.deepEqual(searchEmoji(":"), []);
});

test("o limite é respeitado e nada casa quando nada casa", () => {
  assert.equal(searchEmoji("a", 5).length, 5);
  assert.deepEqual(searchEmoji("zzzqwerty"), []);
});

test("emojiByName aceita com e sem dois-pontos, e recusa o resto", () => {
  assert.equal(emojiByName("smile")?.char, smile.char);
  assert.equal(emojiByName(":smile:")?.char, smile.char);
  assert.equal(emojiByName("  SMILE ")?.char, smile.char);
  assert.equal(emojiByName("nao_existe_isso"), null);
  assert.equal(emojiByName(""), null);
  assert.equal(emojiByName(":"), null);
});

// ---------------------------------------------------------------------------
// `activeShortcode` — quando a listinha abre
// ---------------------------------------------------------------------------

test("`:smi` abre e acha o smile", () => {
  const alvo = activeShortcode(":smi", 4);
  assert.deepEqual(alvo, { start: 0, end: 4, query: "smi" });
  assert.equal(searchEmoji(alvo?.query ?? "")[0]?.name, "smile");
});

test("`:` sozinho não abre nada", () => {
  // se abrisse, o painel piscaria a cada dois-pontos digitado — inclusive no
  // meio de uma frase que nunca teve emoji nenhum
  assert.equal(activeShortcode(":", 1), null);
  assert.equal(activeShortcode("oi :", 4), null);
  // uma letra também não: o mínimo é 2 (mesmo número do Discord)
  assert.equal(activeShortcode(":s", 2), null);
});

test("`:` colado numa palavra não é atalho", () => {
  assert.equal(activeShortcode("foo:sm", 6), null);
  assert.equal(activeShortcode("12:30", 5), null);
  // o clássico: uma URL colada no meio da frase não pode abrir seletor
  assert.equal(activeShortcode("veja https://ex.com", 19), null);
});

test("pontuação e começo de linha abrem", () => {
  assert.deepEqual(activeShortcode("(:sm", 4), { start: 1, end: 4, query: "sm" });
  assert.deepEqual(activeShortcode("oi :sm", 6), { start: 3, end: 6, query: "sm" });
  assert.deepEqual(activeShortcode("linha\n:sm", 9), { start: 6, end: 9, query: "sm" });
});

test("atalho já fechado não reabre", () => {
  // cursor logo depois de `:smile:` — o que está atrás não é um nome em
  // construção, é um atalho pronto
  assert.equal(activeShortcode(":smile:", 7), null);
  assert.equal(activeShortcode(":smile: ", 8), null);
});

test("dentro de código não abre", () => {
  // mesma regra do ui/markdown.ts: o que está em código sai literal, então
  // oferecer um emoji ali seria oferecer algo que o renderizador desfaz
  assert.equal(activeShortcode("`:smi`", 5), null);
  assert.equal(activeShortcode("olha `x :smi y` aqui", 12), null);
  assert.equal(activeShortcode("```\n:smi\n```", 8), null);
  assert.equal(activeShortcode("```js\nconst a = :smi\n```", 20), null);
});

test("crase sem par NÃO é código — igual ao markdown.ts", () => {
  // divergir do parser criaria um terceiro entendimento de "isto é código"
  // dentro do mesmo cliente; ali a crase órfã aparece literal na tela
  assert.deepEqual(activeShortcode("` :smi", 6), { start: 2, end: 6, query: "smi" });
  assert.deepEqual(activeShortcode("crase escapada \\` :smi", 22), { start: 18, end: 22, query: "smi" });
});

test("depois de um bloco de código fechado volta a abrir", () => {
  const texto = "```\ncodigo\n```\n:smi";
  assert.deepEqual(activeShortcode(texto, texto.length), {
    start: texto.length - 4,
    end: texto.length,
    query: "smi",
  });
});

test("o cursor no meio do texto delimita o atalho", () => {
  // `end` é o CURSOR, não o fim da palavra: com o cursor depois de `:smi`, o
  // que se está escrevendo é `smi` — completar até o fim comeria o `le`
  const texto = "oi :smile tudo bem";
  assert.deepEqual(activeShortcode(texto, 7), { start: 3, end: 7, query: "smi" });
  // e o cursor ANTES do atalho não enxerga nada
  assert.equal(activeShortcode(texto, 2), null);
});

test("cursor fora dos limites não estoura", () => {
  // o cursor vem de `selectionStart`, que é do navegador — mas o mesmo texto
  // pode ter encolhido entre o evento e a chamada. Grampear é mais barato que
  // descobrir isso num `undefined` no meio do laço.
  assert.deepEqual(activeShortcode(":smi", 999), { start: 0, end: 4, query: "smi" });
  assert.equal(activeShortcode(":smi", -5), null);
});

// ---------------------------------------------------------------------------
// `applyShortcode` — o que sobra do texto
// ---------------------------------------------------------------------------

test("a substituição preserva o resto da frase", () => {
  const texto = "oi :smi tudo bem";
  const alvo = activeShortcode(texto, 7);
  assert.ok(alvo !== null);
  const r = applyShortcode(texto, alvo.start, alvo.end, smile);
  assert.equal(r.texto, `oi ${smile.char} tudo bem`);
  // cursor logo depois do glifo, antes do espaço que já existia
  assert.equal(r.texto.slice(0, r.cursor), `oi ${smile.char}`);
});

test("no fim do texto ganha um espaço, para a próxima palavra não grudar", () => {
  const r = applyShortcode(":smi", 0, 4, smile);
  assert.equal(r.texto, `${smile.char} `);
  assert.equal(r.cursor, r.texto.length);
});

test("espaço que já existe não vira dois", () => {
  const texto = ":smi fim";
  const r = applyShortcode(texto, 0, 4, smile);
  assert.equal(r.texto, `${smile.char} fim`);
  // e o cursor fica ANTES do espaço, não depois: quem vai continuar digitando
  // espera o cursor colado no que acabou de inserir
  assert.equal(r.cursor, smile.char.length);
});

test("a quebra de linha conta como espaço", () => {
  const r = applyShortcode(":smi\noutra linha", 0, 4, smile);
  assert.equal(r.texto, `${smile.char}\noutra linha`);
});

test("o cursor devolvido é índice de UTF-16, não de caracteres", () => {
  // o glifo tem 2 unidades (par surrogate) e `setSelectionRange` fala em
  // unidades: devolver 1 aqui deixaria o cursor NO MEIO do emoji
  assert.equal(smile.char.length, 2);
  const r = applyShortcode("a :smi", 2, 6, smile);
  assert.equal(r.cursor, "a ".length + 2 + 1);
});

test("o ciclo inteiro: digitar, achar, aplicar", () => {
  const texto = "manda um :thumb aí";
  const alvo = activeShortcode(texto, 15);
  assert.ok(alvo !== null);
  const escolhido = searchEmoji(alvo.query)[0];
  assert.ok(escolhido !== undefined);
  assert.equal(escolhido.name, "thumbsup");
  const r = applyShortcode(texto, alvo.start, alvo.end, escolhido);
  assert.equal(r.texto, `manda um ${escolhido.char} aí`);
});
