/**
 * Testes do delta loopback do OAuth (M6, doc §5): /auth/discord/start aceita
 * ?redirect_port opcional (porta do http.Server efêmero do app desktop) e o
 * callback bifurca o destino do redirect — loopback 127.0.0.1 com QUERY para o
 * desktop, appUrl com fragment/query para o web (comportamento intocado).
 *
 * Tudo via app.inject, sem servidor de pé e sem rede. O caminho FELIZ completo
 * (troca do authorization code + /users/@me) exige o Discord real e não é
 * testável aqui; o branch de "callback sem code" erra ANTES de qualquer
 * chamada externa e exercita exatamente a mesma bifurcação de destino — é ele
 * que prova o contrato dos dois lados.
 *
 * Mesmo esquema das outras suítes: hooks do tsx + import dinâmico de src (o
 * sufixo ".js" do NodeNext não é remapeado pelo type stripping) — este arquivo
 * só pode usar sintaxe apagável. Sem relógio mockado de propósito: saltar o
 * Date.now aqui envenenaria o gerador de snowflakes das suítes seguintes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "tsx/esm/api";

register();

// o config lê process.env no import — ajustar ANTES de importar src. O client
// id/secret são fakes: /start só precisa deles para montar a URL do Discord.
process.env.DANJOCORD_DEV_AUTH = "1";
process.env.DISCORD_CLIENT_ID = "test-client-id";
process.env.DISCORD_CLIENT_SECRET = "test-client-secret";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { Sessions } = await import("../src/sessions.js");
const { registerOAuthRoutes } = await import("../src/oauth.js");
const { config } = await import("../src/config.js");

const db = openDb(":memory:");
const store = new Store(db);
const sessions = new Sessions(db, store);
// logger desligado (default): os branches de erro do callback logam via app.log
const app = Fastify();
registerOAuthRoutes(app, db, store, sessions);

/** GET /auth/discord/start com a query dada ("" = fluxo web). */
function start(qs: string) {
  return app.inject({ method: "GET", url: "/auth/discord/start" + qs });
}

/** Extrai o state da URL do Discord devolvida pelo /start. */
function stateOf(location: string | string[] | undefined): string {
  const state = new URL(String(location)).searchParams.get("state");
  assert.ok(state, "URL do Discord deveria carregar o state");
  return state;
}

test("start sem redirect_port: fluxo web intocado — 302 para o Discord com state e PKCE", async () => {
  const res = await start("");
  assert.equal(res.statusCode, 302);
  const url = new URL(String(res.headers.location));
  assert.equal(url.origin, "https://discord.com");
  assert.equal(url.pathname, "/oauth2/authorize");
  assert.ok(url.searchParams.get("state"));
  assert.equal(url.searchParams.get("client_id"), "test-client-id");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), config.publicBaseUrl + "/auth/discord/callback");
});

test("start com redirect_port válido: 302 para o Discord, e a porta NÃO vaza na URL", async () => {
  for (const port of ["1024", "54321", "65535"]) {
    const res = await start(`?redirect_port=${port}`);
    assert.equal(res.statusCode, 302, `redirect_port=${port} deveria ser aceito`);
    const url = new URL(String(res.headers.location));
    assert.equal(url.origin, "https://discord.com");
    assert.ok(url.searchParams.get("state"));
    // a porta é assunto NOSSO (fica no pending, junto do state) — o Discord não a vê
    assert.equal(url.searchParams.get("redirect_port"), null);
  }
});

test("start com redirect_port inválido: 400 (Zod barra fora de 1024..65535 e não-inteiros)", async () => {
  for (const bad of ["0", "80", "1023", "65536", "99999", "-1", "4.2", "abc", ""]) {
    const res = await start(`?redirect_port=${bad}`);
    assert.equal(res.statusCode, 400, `redirect_port=${JSON.stringify(bad)} deveria ser 400`);
  }
});

test("callback com state desconhecido: redirect para o appUrl com auth_error (comportamento atual)", async () => {
  const res = await app.inject({ method: "GET", url: "/auth/discord/callback?state=inexistente&code=x" });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, config.appUrl + "/?auth_error=state");
});

test("callback sem state nenhum: mesmo destino web de erro", async () => {
  const res = await app.inject({ method: "GET", url: "/auth/discord/callback" });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, config.appUrl + "/?auth_error=state");
});

test("fluxo desktop: cancelamento no Discord volta para o loopback com QUERY", async () => {
  const state = stateOf((await start("?redirect_port=54321")).headers.location);
  // a pessoa cancelou na tela do Discord: callback sem code, com error
  const cb = await app.inject({
    method: "GET",
    url: `/auth/discord/callback?state=${state}&error=access_denied`,
  });
  assert.equal(cb.statusCode, 302);
  // query e não fragment: o http.Server local do Electron precisa ler o valor
  assert.equal(cb.headers.location, "http://127.0.0.1:54321/danjocord-callback?auth_error=discord");
});

test("fluxo web: cancelamento no Discord continua indo para o appUrl", async () => {
  const state = stateOf((await start("")).headers.location);
  const cb = await app.inject({
    method: "GET",
    url: `/auth/discord/callback?state=${state}&error=access_denied`,
  });
  assert.equal(cb.statusCode, 302);
  assert.equal(cb.headers.location, config.appUrl + "/?auth_error=discord");
});

test("state é de uso único também no desktop — o retry perde a porta e cai no appUrl", async () => {
  const state = stateOf((await start("?redirect_port=50000")).headers.location);
  const url = `/auth/discord/callback?state=${state}&error=access_denied`;

  const first = await app.inject({ method: "GET", url });
  assert.equal(first.headers.location, "http://127.0.0.1:50000/danjocord-callback?auth_error=discord");

  // o state já foi consumido: o pending (e a porta junto) morreu — o retry só
  // pode ir para o appUrl; o listener do app desliga sozinho pelo timeout
  const second = await app.inject({ method: "GET", url });
  assert.equal(second.statusCode, 302);
  assert.equal(second.headers.location, config.appUrl + "/?auth_error=state");
});
