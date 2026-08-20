/**
 * Correções da auditoria de segurança do M12.
 *
 * Cada teste aqui é a prova de um furo que EXISTIA e foi reproduzido antes de
 * ser fechado — não são testes de "a validação valida". A ordem é a gravidade.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "tsx/esm/api";

register();

process.env.DANJOCORD_DEV_AUTH = "1";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { canonicalId } = await import("../src/db/snowflake.js");
const { Store } = await import("../src/store.js");
const { Gateway } = await import("../src/gateway.js");
const { Guild } = await import("../src/guild.js");
const { Sessions } = await import("../src/sessions.js");
const { registerRoutes } = await import("../src/routes.js");
const { registerModerationRoutes } = await import("../src/moderation.js");
const { UpdateMeBody } = await import("@danjocord/protocol");

const db = openDb(":memory:");
const store = new Store(db);
const gateway = new Gateway(store);
const guild = new Guild(db, store);
const sessions = new Sessions(db, store);
const app = Fastify();
registerRoutes(app, store, gateway);
registerModerationRoutes(app, store, gateway, guild, sessions, { disconnectFromVoice: async () => undefined });
await app.ready();

const CANAL = "1"; // 'geral', do seed da migration 001

// ---------------------------------------------------------------------------
// ALTA — o quarto caminho do ban
// ---------------------------------------------------------------------------

test("ALTA: o access token de quem foi banido para de valer no REST na hora", async () => {
  // O usuário precisa de discord_id para ser banível (o ban é por discord_id)
  const vitima = store.upsertDiscordUser("900000000000000001", "vitima", null).user;
  guild.addToAllowlist("900000000000000001", null);
  const { access_token } = sessions.create(vitima.id);
  const auth = { authorization: `Bearer ${access_token}` };

  // antes do ban o token funciona — senão o teste provaria nada
  const antes = await app.inject({ method: "GET", url: `/api/channels/${CANAL}/messages?limit=1`, headers: auth });
  assert.equal(antes.statusCode, 200, "o token deveria valer ANTES do ban");

  guild.ban("900000000000000001", null, null);
  assert.equal(store.isMember(vitima.id), false, "o ban deveria tirar o pertencimento");

  // O MESMO header, sem renovar nada. Antes da correção isto devolvia 200 por
  // até 15 min (o TTL do access), porque o JWT é stateless e a linha em `users`
  // continua existindo de propósito.
  for (const [metodo, url] of [
    ["GET", `/api/channels/${CANAL}/messages?limit=1`],
    ["GET", `/api/users/${vitima.id}`],
    ["POST", "/api/invites"],
  ] as const) {
    const r = await app.inject({ method: metodo, url, headers: auth, ...(metodo === "POST" ? { payload: {} } : {}) });
    assert.equal(r.statusCode, 401, `${metodo} ${url} deveria ser 401 depois do ban, veio ${r.statusCode}`);
  }
});

test("ALTA: o banido não consegue mais fabricar o convite que o traria de volta", async () => {
  const vitima = store.upsertDiscordUser("900000000000000002", "exadmin", null).user;
  guild.addToAllowlist("900000000000000002", null);
  store.setRole(vitima.id, "admin");
  const { access_token } = sessions.create(vitima.id);
  const auth = { authorization: `Bearer ${access_token}` };

  const podia = await app.inject({ method: "POST", url: "/api/invites", headers: auth, payload: {} });
  assert.equal(podia.statusCode, 201, "admin deveria poder criar convite ANTES do ban");

  guild.ban("900000000000000002", null, null);

  // era a escalada: convite sem validade e sem max_uses, e volta com OUTRA
  // conta do Discord (que não está banida — o ban é por discord_id)
  const agora = await app.inject({ method: "POST", url: "/api/invites", headers: auth, payload: {} });
  assert.equal(agora.statusCode, 401, "o banido não pode mais criar convite");
});

test("usuário de dev (discord_id NULL) continua entrando — a correção não pode quebrar o dev-auth", async () => {
  const r = await app.inject({
    method: "GET",
    url: `/api/channels/${CANAL}/messages?limit=1`,
    headers: { authorization: "Bearer dev.alguem" },
  });
  assert.equal(r.statusCode, 200);
});

// ---------------------------------------------------------------------------
// ALTA — ReDoS no parser de <meta> do preview de link
// ---------------------------------------------------------------------------

test("ALTA: página hostil de 512 KB não trava o event loop no parser de <meta>", async () => {
  const { extractMeta } = await import("../src/links/html.js");
  // É o que um atacante serve: só inícios de tag, nenhum `>`, nenhum </head>.
  // Cabe inteiro no teto de 512 KB do fetch. Com o regex antigo
  // (`/<meta\s+([^>]*)>/gi`) isto levava ~40 s de event loop TRAVADO — e o
  // Node é single-thread, então era o servidor inteiro parado.
  const hostil = "<meta ".repeat((512 * 1024) / 6);
  const t0 = process.hrtime.bigint();
  extractMeta(hostil);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // 500 ms é folgado: o medido depois da correção é sub-milissegundo. O teto
  // existe para pegar a VOLTA do comportamento quadrático, não para cronometrar
  // a máquina de quem roda o teste.
  assert.ok(ms < 500, `parser levou ${ms.toFixed(0)} ms — o comportamento quadrático voltou`);
});

test("o parser de <meta> continua lendo o que precisa ler", async () => {
  const { extractMeta } = await import("../src/links/html.js");
  const pagina =
    "<html><head><title>Titulo</title>" +
    "<META NAME='description' CONTENT='desc'>" + // maiúscula e aspas simples
    '<meta property="og:title" content="OG">' +
    '<meta property="og:title" content="duplicata">' + // a primeira vence
    "<metadata foo=bar>" + // NÃO é meta tag
    "</head></html>";
  const meta = extractMeta(pagina);
  assert.equal(meta.title, "OG", "og:title vence o <title>");
  assert.equal(meta.description, "desc");
});

// ---------------------------------------------------------------------------
// BAIXA — id fora do int64
// ---------------------------------------------------------------------------

test("BAIXA: id acima do int64 vira 404, e não RangeError não tratado (500)", async () => {
  // 9223372036854775807 é o teto; os dois abaixo passavam no regex de 20
  // dígitos, chegavam ao bind do better-sqlite3 e estouravam
  for (const id of ["9223372036854775808", "99999999999999999999"]) {
    assert.equal(canonicalId(id), null, `${id} não pode ser canonizado`);
    const r = await app.inject({ method: "GET", url: `/api/channels/${id}/messages`, headers: { authorization: "Bearer dev.alguem" } });
    assert.notEqual(r.statusCode, 500, `${id} devolveu 500`);
  }
  // o teto exato continua válido — a correção não pode comer id legítimo
  assert.equal(canonicalId("9223372036854775807"), "9223372036854775807");
  assert.equal(canonicalId("1"), "1");
  assert.equal(canonicalId("01"), "1", "a canonização de zero à esquerda tem de sobreviver");
});

// ---------------------------------------------------------------------------
// BAIXA — esquema do avatar_override
// ---------------------------------------------------------------------------

test("BAIXA: avatar_override só aceita https", () => {
  for (const u of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://x.com/a.png",
    "http://x.com/a.png", // conteúdo misto numa página https: não carrega
  ]) {
    assert.equal(UpdateMeBody.safeParse({ avatar_override: u }).success, false, `${u} não pode passar`);
  }
  assert.equal(UpdateMeBody.safeParse({ avatar_override: "https://cdn.discordapp.com/avatars/1/a.png" }).success, true);
  assert.equal(UpdateMeBody.safeParse({ avatar_override: null }).success, true, "null limpa o override");
});
