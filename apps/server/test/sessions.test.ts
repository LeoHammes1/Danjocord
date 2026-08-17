/**
 * Testes de sessões (M1): create/verify, rotação, detecção de reuso, OTC e
 * logout — banco em ":memory:", sem servidor de pé.
 *
 * O runner é o node:test nativo ("pnpm --filter @danjocord/server test"), mas
 * o código de src importa com sufixo ".js" (convenção NodeNext do build) e o
 * type stripping do Node NÃO remapeia ".js" → ".ts". Por isso registramos os
 * hooks do tsx e importamos src dinamicamente — este arquivo em si só pode
 * usar sintaxe apagável (nada de enum/parameter properties).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "tsx/esm/api";

register();

// o config lê process.env no import — ajustar ANTES de importar src
process.env.DANJOCORD_DEV_AUTH = "1";

const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { Sessions } = await import("../src/sessions.js");
const { authenticate } = await import("../src/auth.js");
const { config } = await import("../src/config.js");

const db = openDb(":memory:");
const store = new Store(db);
const sessions = new Sessions(db, store);

test("create → authenticate reconhece o JWT de acesso", () => {
  const user = store.findOrCreateDevUser("alice");
  const pair = sessions.create(user.id);
  assert.equal(pair.expires_in, config.accessTokenTtlSec);
  assert.equal(pair.user.id, user.id);

  const seen = authenticate(store, pair.access_token);
  assert.ok(seen, "JWT recém-emitido deveria autenticar");
  assert.equal(seen.id, user.id);
  assert.equal(seen.username, "alice");

  // lixo e assinatura errada não passam
  assert.equal(authenticate(store, "não-é-um-jwt"), null);
  // caminho dev preservado (devAuth ligado no topo do arquivo)
  assert.ok(authenticate(store, "dev.alice"));
});

test("rotate devolve par novo e o refresh antigo passa a ser inválido", () => {
  const user = store.findOrCreateDevUser("bob");
  const pair1 = sessions.create(user.id);
  const pair2 = sessions.rotate(pair1.refresh_token);
  assert.ok(pair2 !== null && pair2 !== "reused", "rotação de refresh válido deveria emitir par novo");
  assert.notEqual(pair2.refresh_token, pair1.refresh_token);
  assert.ok(authenticate(store, pair2.access_token), "access token novo deveria autenticar");
  // o antigo já foi rotacionado: apresentá-lo de novo é reuso, não rotação
  assert.equal(sessions.rotate(pair1.refresh_token), "reused");
});

test("reuso do refresh antigo revoga a família inteira", () => {
  const user = store.findOrCreateDevUser("carol");
  const pair1 = sessions.create(user.id);
  const pair2 = sessions.rotate(pair1.refresh_token);
  assert.ok(pair2 !== null && pair2 !== "reused");

  // "ladrão" (ou o dono — impossível distinguir) reapresenta o token velho
  assert.equal(sessions.rotate(pair1.refresh_token), "reused");
  // a geração mais nova morreu junto: a família inteira foi revogada
  assert.equal(sessions.rotate(pair2.refresh_token), "reused");
});

test("logout revoga a família", () => {
  const user = store.findOrCreateDevUser("dave");
  const pair = sessions.create(user.id);
  assert.equal(sessions.revokeByRefresh(pair.refresh_token), true);
  const dead = sessions.rotate(pair.refresh_token);
  assert.ok(dead === "reused" || dead === null, "refresh não deveria rotacionar após logout");
  // token desconhecido: nada a revogar
  assert.equal(sessions.revokeByRefresh("token-inexistente"), false);
});

test("otc é de uso único", () => {
  const user = store.findOrCreateDevUser("erin");
  const otc = sessions.issueOtc(user.id);
  assert.equal(sessions.consumeOtc(otc), user.id);
  assert.equal(sessions.consumeOtc(otc), null, "segundo consumo do mesmo otc deveria falhar");
  assert.equal(sessions.consumeOtc("otc-inexistente"), null);
});

// Os testes com relógio mockado ficam por último: mexer no Date.now afeta o
// gerador de snowflakes, e assim nenhum teste "de tempo real" roda depois de
// um salto de relógio.

test("otc expira depois de otcTtlMs", (t) => {
  const user = store.findOrCreateDevUser("frank");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const otc = sessions.issueOtc(user.id);
  t.mock.timers.tick(config.otcTtlMs + 1);
  assert.equal(sessions.consumeOtc(otc), null, "otc expirado não deveria ser aceito");
});

test("refresh expirado nunca rotaciona", (t) => {
  const user = store.findOrCreateDevUser("grace");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const pair = sessions.create(user.id);
  t.mock.timers.tick(config.refreshTokenTtlMs + 1);
  assert.equal(sessions.rotate(pair.refresh_token), null);
});

test("TTL do refresh é deslizante: a rotação re-ancora expires_at", (t) => {
  const user = store.findOrCreateDevUser("heidi");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const pair1 = sessions.create(user.id);

  // quase no fim da vida do primeiro refresh, rotaciona…
  t.mock.timers.tick(config.refreshTokenTtlMs - 60_000);
  const pair2 = sessions.rotate(pair1.refresh_token);
  assert.ok(pair2 !== null && pair2 !== "reused");

  // …e o novo sobrevive além do expires_at original — TTL contado da rotação
  t.mock.timers.tick(config.refreshTokenTtlMs - 60_000);
  const pair3 = sessions.rotate(pair2.refresh_token);
  assert.ok(pair3 !== null && pair3 !== "reused", "refresh rotacionado deveria valer um TTL inteiro de novo");
});

test("remover da allowlist corta a rotação (kick, doc §5)", () => {
  // usuário "vindo do OAuth": tem discord_id e entrada na allowlist
  const discordId = "999888777666555444";
  db.prepare(
    "INSERT INTO users (id, discord_id, username, avatar_url, created_at) VALUES (?, ?, 'dave', NULL, ?)",
  ).run(4444n, discordId, Date.now());
  db.prepare("INSERT INTO allowlist (discord_id, invited_by, created_at) VALUES (?, NULL, ?)").run(
    discordId,
    Date.now(),
  );

  const pair1 = sessions.create("4444");
  const pair2 = sessions.rotate(pair1.refresh_token);
  assert.ok(pair2 !== null && pair2 !== "reused", "na allowlist, rotação normal");

  // o dono remove o amigo da lista: a PRÓXIMA rotação morre e revoga a família
  db.prepare("DELETE FROM allowlist WHERE discord_id = ?").run(discordId);
  assert.equal(sessions.rotate(pair2.refresh_token), null, "fora da allowlist não renova");
  assert.equal(sessions.rotate(pair2.refresh_token), "reused", "família ficou revogada");

  // usuário dev (discord_id NULL) não passa por allowlist — segue rotacionando
  const dev = store.findOrCreateDevUser("eve");
  const devPair = sessions.create(dev.id);
  assert.ok(sessions.rotate(devPair.refresh_token) !== null, "dev não é afetado por allowlist");
});
