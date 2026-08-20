/**
 * CSP do renderer do desktop (auditoria M12).
 *
 * Roda contra o `dist` construído, e não contra o `.ts`: este pacote é
 * CommonJS (sem `"type": "module"`), então o type stripping do Node não carrega
 * um `.ts` com `export`. O `pnpm test` daqui constrói antes — é o preço de o
 * desktop ser o único pacote em CJS, e é barato.
 *
 * O que se testa NÃO é "a string tem as palavras certas". É o conjunto de
 * coisas que, quando erradas, fazem o navegador DESCARTAR a diretiva EM
 * SILÊNCIO — que é o pior modo de falha possível para uma CSP: ela parece
 * estar lá, some do comportamento, e ninguém percebe até virar incidente.
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { rendererCsp } = require("../dist/csp.js");

/** `"a 'self' b; c d"` → `Map { a => ["'self'","b"], c => ["d"] }` */
function directives(csp) {
  const out = new Map();
  for (const parte of csp.split(";")) {
    const bits = parte.trim().split(/\s+/).filter(Boolean);
    if (bits.length === 0) continue;
    out.set(bits[0], bits.slice(1));
  }
  return out;
}

const PROD = "https://danjocord.leohammes.dev";
const DEV = "http://localhost:8080";

test("cada diretiva é bem formada — o navegador descarta em silêncio se não for", () => {
  for (const url of [PROD, DEV]) {
    const d = directives(rendererCsp(url));
    for (const [nome, valores] of d) {
      assert.match(nome, /^[a-z-]+$/, `nome de diretiva estranho: ${nome}`);
      for (const v of valores) {
        // origem com barra no fim é inválida e derruba a diretiva INTEIRA
        assert.doesNotMatch(v, /^https?:\/\/.*\/$/, `origem com barra no fim em ${nome}: ${v}`);
        assert.notEqual(v, "", `valor vazio em ${nome}`);
      }
    }
    // sem diretiva repetida: a segunda é ignorada, e é sempre a que se quis
    const nomes = rendererCsp(url).split(";").map((p) => p.trim().split(/\s+/)[0]);
    assert.equal(new Set(nomes).size, nomes.length, "diretiva repetida");
  }
});

test("img-src não abre para host arbitrário — era por aí que o avatar vazava IP", () => {
  const img = directives(rendererCsp(PROD)).get("img-src");
  assert.ok(img, "img-src tem de existir");
  assert.ok(!img.includes("*"), "curinga em img-src anula o ponto da diretiva");
  assert.ok(!img.includes("https:"), "esquema solto aceita QUALQUER host https");
  // o avatar padrão vem do CDN do Discord; o resto é do próprio bundle
  assert.deepEqual(img, ["'self'", "https://cdn.discordapp.com", "data:", "blob:"]);
});

test("connect-src nomeia a API e o WebSocket do gateway", () => {
  // no web isto é `'self'` porque a origem é a mesma; aqui o renderer é
  // app://bundle e a API está noutro host — precisa ser nomeada, e o
  // connect-src governa o WebSocket também
  const prod = directives(rendererCsp(PROD)).get("connect-src");
  assert.ok(prod.includes(PROD), "a API tem de estar no connect-src");
  assert.ok(prod.includes("wss://danjocord.leohammes.dev"), "o gateway (wss) também");

  const dev = directives(rendererCsp(DEV)).get("connect-src");
  assert.ok(dev.includes(DEV) && dev.includes("ws://localhost:8080"), "em dev, http e ws");
});

test("barra no fim da serverUrl não vaza para a diretiva", () => {
  const comBarra = directives(rendererCsp(PROD + "/")).get("connect-src");
  const semBarra = directives(rendererCsp(PROD)).get("connect-src");
  assert.deepEqual(comBarra, semBarra, "a barra tinha de ser aparada");
});

test("as trancas de sempre continuam fechadas", () => {
  const d = directives(rendererCsp(PROD));
  assert.deepEqual(d.get("default-src"), ["'self'"]);
  assert.deepEqual(d.get("base-uri"), ["'none'"]);
  assert.deepEqual(d.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(d.get("object-src"), ["'none'"]);
  // script-src ausente é intencional: o default-src 'self' já o cobre, e
  // duplicar seria mais um lugar para divergir
  assert.equal(d.has("script-src"), false);
});
