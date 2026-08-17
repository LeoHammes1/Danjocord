/**
 * Testes do M2 (mensagens): PATCH/DELETE com autorização, soft delete, typing,
 * paginação por cursor e o hook onUserCreated — banco em ":memory:", Fastify
 * de verdade via app.inject() e Gateway sem attach (nenhuma sessão WS
 * conectada, então os broadcasts são no-op; o fan-out real fica no smoke).
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
import type { Message, User } from "@danjocord/protocol";

register();

// o config lê process.env no import — ajustar ANTES de importar src
process.env.DANJOCORD_DEV_AUTH = "1";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { idFromString } = await import("../src/db/snowflake.js");
const { Store } = await import("../src/store.js");
const { Gateway } = await import("../src/gateway.js");
const { registerRoutes } = await import("../src/routes.js");

const db = openDb(":memory:");
const store = new Store(db);
const gateway = new Gateway(store);
const app = Fastify();
registerRoutes(app, store, gateway);

// Canal de texto extra, isolado, para o teste de paginação (o seed da
// migration cria só o 1 = texto e o 2 = voz); também serve de "canal errado"
// nos testes de escopo do PATCH.
db.prepare("INSERT INTO channels (id, type, name, position) VALUES (3, 'text', 'paginado', 9)").run();

/** Bearer dev.<nome> — devAuth ligado no topo do arquivo cria o usuário no 1º uso. */
function auth(username: string): Record<string, string> {
  return { authorization: `Bearer dev.${username}` };
}

async function createMessage(username: string, channelId: string, content: string): Promise<Message> {
  const res = await app.inject({
    method: "POST",
    url: `/api/channels/${channelId}/messages`,
    headers: auth(username),
    payload: { content },
  });
  assert.equal(res.statusCode, 201, "setup: POST mensagem deveria devolver 201");
  return res.json() as Message;
}

async function fetchHistory(username: string, channelId: string, query = "limit=100"): Promise<Message[]> {
  const res = await app.inject({
    method: "GET",
    url: `/api/channels/${channelId}/messages?${query}`,
    headers: auth(username),
  });
  assert.equal(res.statusCode, 200);
  return res.json() as Message[];
}

test("PATCH edita a própria mensagem: 200, edited_at preenchido, histórico atualizado", async () => {
  const msg = await createMessage("alice", "1", "original");

  const res = await app.inject({
    method: "PATCH",
    url: `/api/channels/1/messages/${msg.id}`,
    headers: auth("alice"),
    payload: { content: "editado" },
  });
  assert.equal(res.statusCode, 200);
  const updated = res.json() as Message;
  assert.equal(updated.id, msg.id);
  assert.equal(updated.channel_id, "1");
  assert.equal(updated.content, "editado");
  assert.equal(typeof updated.edited_at, "number", "edição deveria preencher edited_at");

  const inHistory = (await fetchHistory("alice", "1")).find((m) => m.id === msg.id);
  assert.ok(inHistory, "mensagem editada deveria continuar no histórico");
  assert.equal(inHistory.content, "editado");
});

test("PATCH em mensagem alheia → 403 (só o autor edita)", async () => {
  const msg = await createMessage("alice", "1", "da alice");
  const res = await app.inject({
    method: "PATCH",
    url: `/api/channels/1/messages/${msg.id}`,
    headers: auth("bob"),
    payload: { content: "invasão" },
  });
  assert.equal(res.statusCode, 403);
  // conteúdo intacto após a tentativa
  const inHistory = (await fetchHistory("alice", "1")).find((m) => m.id === msg.id);
  assert.ok(inHistory);
  assert.equal(inHistory.content, "da alice");
});

test("PATCH com corpo inválido → 400 (Zod na entrada, convenção do repo)", async () => {
  const msg = await createMessage("alice", "1", "válida");
  const res = await app.inject({
    method: "PATCH",
    url: `/api/channels/1/messages/${msg.id}`,
    headers: auth("alice"),
    payload: { content: "" },
  });
  assert.equal(res.statusCode, 400);
});

test("PATCH via canal errado → 404 (mensagem não pertence ao canal do path)", async () => {
  const msg = await createMessage("alice", "1", "no canal 1");
  const res = await app.inject({
    method: "PATCH",
    url: `/api/channels/3/messages/${msg.id}`,
    headers: auth("alice"),
    payload: { content: "outro canal" },
  });
  assert.equal(res.statusCode, 404);
});

test("DELETE da própria mensagem → 204; some do histórico mas a linha fica (soft delete)", async () => {
  const msg = await createMessage("alice", "1", "vou sumir");
  const res = await app.inject({
    method: "DELETE",
    url: `/api/channels/1/messages/${msg.id}`,
    headers: auth("alice"),
  });
  assert.equal(res.statusCode, 204);

  const ids = (await fetchHistory("alice", "1")).map((m) => m.id);
  assert.ok(!ids.includes(msg.id), "mensagem apagada não deveria aparecer no histórico");

  // soft delete de verdade: a linha continua no banco, com deleted_at marcado
  const row = db.prepare("SELECT deleted_at FROM messages WHERE id = ?").get(idFromString(msg.id)) as
    | { deleted_at: bigint | null }
    | undefined;
  assert.ok(row, "soft delete não pode remover a linha do banco");
  assert.notEqual(row.deleted_at, null, "deleted_at deveria estar preenchido");
});

test("DELETE de mensagem alheia sem admin → 403", async () => {
  const msg = await createMessage("alice", "1", "protegida");
  const res = await app.inject({
    method: "DELETE",
    url: `/api/channels/1/messages/${msg.id}`,
    headers: auth("bob"),
  });
  assert.equal(res.statusCode, 403);
  const ids = (await fetchHistory("alice", "1")).map((m) => m.id);
  assert.ok(ids.includes(msg.id), "mensagem deveria sobreviver ao 403");
});

test("DELETE de mensagem alheia COM admin → 204 (moderação)", async () => {
  const msg = await createMessage("bob", "1", "vai ser moderada");

  // is_admin não tem rota própria neste milestone — vira admin por SQL direto,
  // como o dono faria via sqlite3 no pod (migration 002)
  const root = store.findOrCreateDevUser("root");
  db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(idFromString(root.id));
  assert.equal(store.isAdmin(root.id), true);

  // no fio, is_admin: true aparece; usuário comum não carrega true
  const rootWire = store.getUserById(idFromString(root.id));
  assert.ok(rootWire);
  assert.equal(rootWire.is_admin, true);
  const bob = store.findOrCreateDevUser("bob");
  assert.ok(bob.is_admin !== true, "não-admin nunca vem com is_admin: true");

  const res = await app.inject({
    method: "DELETE",
    url: `/api/channels/1/messages/${msg.id}`,
    headers: auth("root"),
  });
  assert.equal(res.statusCode, 204);
  const ids = (await fetchHistory("root", "1")).map((m) => m.id);
  assert.ok(!ids.includes(msg.id));
});

test("PATCH/DELETE em mensagem apagada ou inexistente → 404", async () => {
  const msg = await createMessage("alice", "1", "efêmera");
  const del = await app.inject({ method: "DELETE", url: `/api/channels/1/messages/${msg.id}`, headers: auth("alice") });
  assert.equal(del.statusCode, 204);

  const patchDeleted = await app.inject({
    method: "PATCH",
    url: `/api/channels/1/messages/${msg.id}`,
    headers: auth("alice"),
    payload: { content: "necromancia" },
  });
  assert.equal(patchDeleted.statusCode, 404, "apagada não é editável (nem pelo autor)");

  const deleteTwice = await app.inject({
    method: "DELETE",
    url: `/api/channels/1/messages/${msg.id}`,
    headers: auth("alice"),
  });
  assert.equal(deleteTwice.statusCode, 404, "apagar duas vezes → 404 na segunda");

  // id de formato válido que nunca existiu
  const ghost = "4611686018427387904";
  const patchGhost = await app.inject({
    method: "PATCH",
    url: `/api/channels/1/messages/${ghost}`,
    headers: auth("alice"),
    payload: { content: "x" },
  });
  assert.equal(patchGhost.statusCode, 404);
  const deleteGhost = await app.inject({
    method: "DELETE",
    url: `/api/channels/1/messages/${ghost}`,
    headers: auth("alice"),
  });
  assert.equal(deleteGhost.statusCode, 404);
});

test("POST typing → 204 (sem corpo, sem persistência)", async () => {
  const res = await app.inject({ method: "POST", url: "/api/channels/1/typing", headers: auth("alice") });
  assert.equal(res.statusCode, 204);
});

test("paginação por before percorre as ~120 mensagens em ordem, sem duplicata", async () => {
  const alice = store.findOrCreateDevUser("alice");
  // direto no store: 120 POSTs via inject só deixariam o teste lento
  const created: string[] = [];
  for (let i = 0; i < 120; i++) {
    created.push(store.createMessage("3", alice.id, `m${i}`).id);
  }

  const seen: string[] = [];
  let before: string | null = null;
  for (let pages = 0; ; pages++) {
    assert.ok(pages < 10, "paginação não terminou — cursor before não avança?");
    const query = before === null ? "limit=50" : `limit=50&before=${before}`;
    const page = await fetchHistory("alice", "3", query);
    assert.ok(page.length <= 50, "página maior que o limit pedido");
    seen.push(...page.map((m) => m.id));
    // contrato do cursor: página menor que o limit significa fim do histórico
    if (page.length < 50) break;
    const last = page.at(-1);
    assert.ok(last);
    before = last.id;
  }

  // desc (mais novas primeiro), completa e sem duplicata — tudo numa comparação
  assert.deepEqual(seen, [...created].reverse());
});

test("ids de path não-numéricos → 404 (nada de BigInt() explodindo em 500)", async () => {
  const cases: { method: "PATCH" | "DELETE" | "POST"; url: string }[] = [
    { method: "PATCH", url: "/api/channels/abc/messages/123" },
    { method: "PATCH", url: "/api/channels/1/messages/abc" },
    { method: "DELETE", url: "/api/channels/abc/messages/123" },
    { method: "DELETE", url: "/api/channels/1/messages/abc" },
    { method: "POST", url: "/api/channels/abc/typing" },
  ];
  for (const c of cases) {
    const res = await app.inject({
      method: c.method,
      url: c.url,
      headers: auth("alice"),
      ...(c.method === "PATCH" ? { payload: { content: "x" } } : {}),
    });
    assert.equal(res.statusCode, 404, `${c.method} ${c.url} deveria ser 404`);
  }
});

test("onUserCreated dispara só na CRIAÇÃO de usuário (dev e discord)", () => {
  const calls: User[] = [];
  store.onUserCreated = (u: User) => calls.push(u);
  try {
    const novo = store.findOrCreateDevUser("novato");
    assert.equal(calls.length, 1, "usuário dev novo deveria disparar o hook");
    assert.equal(calls[0]?.id, novo.id);

    store.findOrCreateDevUser("novato");
    assert.equal(calls.length, 1, "usuário existente não é criação");

    const first = store.upsertDiscordUser("111222333444555666", "fulano", null);
    assert.equal(first.created, true);
    assert.equal(calls.length, 2, "usuário OAuth novo deveria disparar o hook");
    assert.equal(calls[1]?.id, first.user.id);
    assert.equal(first.user.username, "fulano");

    const again = store.upsertDiscordUser("111222333444555666", "fulano-renomeado", "https://cdn.discordapp.com/a.png");
    assert.equal(again.created, false);
    assert.equal(again.user.id, first.user.id, "upsert preserva a identidade (mesmo snowflake)");
    assert.equal(calls.length, 2, "upsert de usuário existente não é criação");
  } finally {
    // o hook é campo público opcional — some para não vazar nos outros testes
    delete store.onUserCreated;
  }
});

// --- regressões da revisão do M2 ---

test("limit fracionário não vira 500 (SQLITE_MISMATCH no LIMIT)", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/channels/1/messages?limit=2.5",
    headers: { authorization: "Bearer dev.regressao" },
  });
  assert.equal(res.statusCode, 200, "fracionário cai no default, nunca em 500");
  assert.ok(Array.isArray(res.json()));
});

test("broadcasts saem com ids canônicos mesmo com zeros à esquerda no path", async () => {
  const events: { t: string; d: unknown }[] = [];
  const original = gateway.broadcast.bind(gateway);
  (gateway as { broadcast: (t: string, d: unknown) => void }).broadcast = (t, d) => {
    events.push({ t, d });
  };
  try {
    const auth = { authorization: "Bearer dev.regressao" };
    const created = await app.inject({
      method: "POST",
      url: "/api/channels/01/messages", // "01" precisa canonizar para "1"
      headers: { ...auth, "content-type": "application/json" },
      payload: { content: "alvo de delete" },
    });
    assert.equal(created.statusCode, 201);
    const msg = created.json() as Message;
    assert.equal(msg.channel_id, "1", "MESSAGE_CREATE com channel_id canônico");

    const del = await app.inject({
      method: "DELETE",
      url: `/api/channels/01/messages/0${msg.id}`, // ids do path com zeros
      headers: auth,
    });
    assert.equal(del.statusCode, 204);
    const evt = events.find((e) => e.t === "MESSAGE_DELETE")?.d as { id: string; channel_id: string } | undefined;
    assert.ok(evt, "MESSAGE_DELETE broadcastado");
    assert.equal(evt.id, msg.id, "id canônico (sem o zero do path)");
    assert.equal(evt.channel_id, "1", "channel_id canônico");
  } finally {
    (gateway as { broadcast: typeof original }).broadcast = original;
  }
});
