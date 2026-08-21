/**
 * A URL do feed de atualização (M14).
 *
 * Uma função de três linhas com um teste inteiro em volta, e o motivo é o modo
 * de falha: se a barra final sumir, NADA reclama. O electron-updater resolve
 * cada arquivo com `new URL(nome, base)`, e sem a barra o último segmento é
 * SUBSTITUÍDO em vez de estendido — `/api/updates/feed?t=x` vira
 * `/api/updates/latest.yml`, que não é rota do servidor e cai no fallback de
 * SPA. O cliente recebe 200 com o index.html, tenta ler como YAML e relata "não
 * consegui parsear o latest.yml". Ninguém liga esse erro a uma barra.
 *
 * O segundo teste é o outro metade do mecanismo: a QUERY carrega a credencial,
 * e o `newUrlFromBase` do electron-updater a propaga da base para cada arquivo.
 * O teste replica essa propagação em vez de confiar nela de memória.
 *
 * Roda contra o `dist` construído (este pacote é CommonJS) — mesmo arranjo do
 * csp.test.js.
 */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { feedUrl } = require("../dist/updater.js");

const SERVIDOR = "https://danjocord.leohammes.dev";
const TICKET = "abc-123_XYZ";

/**
 * O que o `newUrlFromBase` do electron-updater faz: resolve o nome contra a
 * base e reimpõe a query da base (o `new URL` não a propaga sozinho).
 */
function resolverComoOUpdater(base, nome) {
  const b = new URL(base);
  const r = new URL(nome, b);
  r.search = b.search;
  return r;
}

test("a barra final põe os arquivos DENTRO de /api/updates/feed/", () => {
  const base = feedUrl(SERVIDOR, TICKET);
  assert.ok(base.endsWith(`/api/updates/feed/?ticket=${TICKET}`), base);

  for (const nome of ["latest.yml", "Danjocord-Setup-1.2.0.exe"]) {
    const url = resolverComoOUpdater(base, nome);
    assert.equal(
      url.pathname,
      `/api/updates/feed/${nome}`,
      "sem a barra final o último segmento é substituído e a rota nunca é alcançada",
    );
  }
});

test("a query (o tíquete) sobrevive a cada arquivo resolvido", () => {
  const base = feedUrl(SERVIDOR, TICKET);
  const url = resolverComoOUpdater(base, "latest.yml");
  assert.equal(url.searchParams.get("ticket"), TICKET, "é ela que autentica — sem ela o feed responde 401");
});

test("o tíquete é escapado, e uma barra a mais no serverUrl não vira duas", () => {
  // o serverUrl vem de um JSON carimbado no build (ou de env), e uma barra
  // sobrando ali daria `//api/updates/...` — caminho diferente, 404 do servidor
  assert.ok(feedUrl(`${SERVIDOR}/`, TICKET).startsWith(`${SERVIDOR}/api/updates/feed/`));
  assert.match(feedUrl(SERVIDOR, "a b&c=d").split("?ticket=")[1], /^a%20b%26c%3Dd$/);
});
