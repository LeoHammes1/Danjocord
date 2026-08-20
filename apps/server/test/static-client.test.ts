/**
 * Testes do cliente estático em produção.
 *
 * POR QUE ELES EXISTEM: este módulo não tinha cobertura nenhuma, e é ele que
 * decide o que NÃO cai no fallback de SPA. A troca do `@fastify/static` da 8.x
 * para a 10.x (quatro advisories, sem correção na linha 8) atravessa DUAS
 * majors justamente no plugin que serve estas rotas — sem teste, "funcionou"
 * seria opinião.
 *
 * Os três comportamentos abaixo estão documentados em `static-client.ts` e cada
 * um paga um bug concreto:
 *   1. arquivo do build é servido com o MIME certo;
 *   2. rota desconhecida devolve o index.html (o roteamento é do cliente);
 *   3. `/api`, `/auth`, `/gateway`, `/healthz` e `/assets/` NUNCA caem no
 *      fallback — um bundle de hash antigo (aba aberta durante um deploy) tem
 *      de receber 404, e não um index.html com MIME de HTML, que no navegador
 *      vira um erro críptico de módulo ES.
 *
 * O diretório vem por parâmetro e mora no tmp: criar `apps/server/client-dist`
 * de verdade atropelaria o build local de quem tivesse um.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import { register } from "tsx/esm/api";

register();

const { default: Fastify } = await import("fastify");
const { registerStaticClient } = await import("../src/static-client.js");

// --- build falso, com a mesma forma do que o vite gera ----------------------
const raiz = mkdtempSync(join(tmpdir(), "danjocord-client-"));
mkdirSync(join(raiz, "assets"));
writeFileSync(join(raiz, "index.html"), "<!doctype html><title>Danjocord</title>");
writeFileSync(join(raiz, "assets", "index-ABC123.js"), "export const x = 1;\n");
after(() => rmSync(raiz, { recursive: true, force: true }));

const app = Fastify();
registerStaticClient(app, raiz);
// rota de backend real, para provar que o fallback não a engole
app.get("/healthz", async () => ({ ok: true }));
await app.ready();

test("serve o arquivo do build com o MIME certo", async () => {
  const r = await app.inject({ method: "GET", url: "/assets/index-ABC123.js" });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers["content-type"] as string, /javascript/);
  assert.equal(r.body, "export const x = 1;\n");
});

test("serve o index.html na raiz", async () => {
  const r = await app.inject({ method: "GET", url: "/" });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers["content-type"] as string, /html/);
  assert.match(r.body, /Danjocord/);
});

test("rota desconhecida cai no fallback de SPA (index.html, 200)", async () => {
  for (const url of ["/canal/123", "/qualquer/coisa/funda", "/convite/abc"]) {
    const r = await app.inject({ method: "GET", url });
    assert.equal(r.statusCode, 200, `${url} deveria cair no fallback`);
    assert.match(r.headers["content-type"] as string, /html/, `${url} deveria vir como HTML`);
    assert.match(r.body, /Danjocord/);
  }
});

test("query string não confunde o fallback", async () => {
  const r = await app.inject({ method: "GET", url: "/canal/1?msg=42" });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /Danjocord/);
});

test("ARMADILHA: /assets/ inexistente é 404, NUNCA o index.html", async () => {
  // é o bundle de hash antigo depois de um deploy. Devolver index.html com
  // content-type de HTML faz o navegador estourar um erro de módulo ES que não
  // aponta para lugar nenhum.
  const r = await app.inject({ method: "GET", url: "/assets/index-VELHO999.js" });
  assert.equal(r.statusCode, 404);
  assert.doesNotMatch(String(r.headers["content-type"] ?? ""), /html/);
});

test("prefixos do backend não caem no fallback", async () => {
  for (const url of ["/api/naoexiste", "/auth/naoexiste", "/gateway/x"]) {
    const r = await app.inject({ method: "GET", url });
    assert.equal(r.statusCode, 404, `${url} deveria ser 404`);
    assert.doesNotMatch(String(r.headers["content-type"] ?? ""), /html/, `${url} não pode virar HTML`);
  }
});

test("rota real do backend continua respondendo (o fallback não a engole)", async () => {
  const r = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true });
});

test("sem client-dist o módulo se desliga e não registra rota nenhuma", async () => {
  const vazio = Fastify();
  registerStaticClient(vazio, join(raiz, "nao-existe"));
  await vazio.ready();
  const r = await vazio.inject({ method: "GET", url: "/qualquer" });
  assert.equal(r.statusCode, 404); // é o dev: quem serve o cliente é o vite
});
