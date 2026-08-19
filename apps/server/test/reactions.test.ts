/**
 * Testes das reações (M11b, item 87): idempotência, os dois tetos, emoji
 * inválido, reação em mensagem apagada, timeout de chat e os eventos que saem
 * no fan-out.
 *
 * Banco ":memory:", Fastify de verdade via app.inject(), Gateway sem attach com
 * espião no broadcast (o mesmo padrão do `messages.test.ts`): os testes afirmam
 * O QUE seria espalhado; a entrega em sockets é papel do smoke.
 *
 * Cada teste usa um usuário PRÓPRIO onde há rate limit (20 reações por 10 s por
 * pessoa) — reaproveitar um nome faria um teste comer a cota do outro.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "tsx/esm/api";
import type { Message, ReactionData } from "@danjocord/protocol";

register();

process.env.DANJOCORD_DEV_AUTH = "1";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { Gateway } = await import("../src/gateway.js");
const { registerRoutes } = await import("../src/routes.js");
const { registerReactionRoutes } = await import("../src/reactions.js");
const { MAX_REACTIONS_PER_MESSAGE, MAX_REACTIONS_PER_USER_PER_MESSAGE } = await import("../src/store.js");

const db = openDb(":memory:");
const store = new Store(db);
const gateway = new Gateway(store);
const app = Fastify();
registerRoutes(app, store, gateway);
registerReactionRoutes(app, store, gateway);

const CANAL = "1";

const events: { t: string; d: unknown }[] = [];
(gateway as unknown as { broadcast: (t: string, d: unknown) => void }).broadcast = (t, d) => {
  events.push({ t, d });
};
function findAll<T>(t: string): T[] {
  return events.filter((e) => e.t === t).map((e) => e.d as T);
}
function reset(): void {
  events.length = 0;
}

function auth(username: string): Record<string, string> {
  return { authorization: `Bearer dev.${username}` };
}

async function createMessage(username: string, content = "reaja aqui"): Promise<Message> {
  const res = await app.inject({
    method: "POST",
    url: `/api/channels/${CANAL}/messages`,
    headers: auth(username),
    payload: { content },
  });
  assert.equal(res.statusCode, 201, `setup: POST deveria dar 201, deu ${res.statusCode}`);
  return res.json() as Message;
}

function reactionUrl(messageId: string, emoji: string): string {
  // o emoji vai percent-encoded no caminho (é o que um cliente faria)
  return `/api/channels/${CANAL}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`;
}

async function react(username: string, messageId: string, emoji: string, method: "PUT" | "DELETE" = "PUT") {
  return app.inject({ method, url: reactionUrl(messageId, emoji), headers: auth(username) });
}

/** Relê a mensagem pela paginação — é o caminho que o cliente usa. */
async function reload(username: string, messageId: string): Promise<Message> {
  const res = await app.inject({
    method: "GET",
    url: `/api/channels/${CANAL}/messages?limit=100`,
    headers: auth(username),
  });
  const found = (res.json() as Message[]).find((m) => m.id === messageId);
  assert.ok(found, "a mensagem deveria estar no histórico");
  return found;
}

// ---------------------------------------------------------------------------
// Caminho feliz
// ---------------------------------------------------------------------------

test("PUT põe a reação, emite REACTION_ADD e ela viaja na mensagem", async () => {
  const message = await createMessage("ana");
  reset();

  const res = await react("ana", message.id, "🎉");
  assert.equal(res.statusCode, 204);

  const eventos = findAll<ReactionData>("REACTION_ADD");
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0]?.emoji, "🎉");
  assert.equal(eventos[0]?.message_id, message.id);
  assert.equal(eventos[0]?.channel_id, CANAL);

  const recarregada = await reload("ana", message.id);
  assert.deepEqual(recarregada.reactions, [{ emoji: "🎉", user_ids: [message.author_id] }]);
});

test("reação duplicada é IDEMPOTENTE: 204, sem evento e sem duplicar", async () => {
  const message = await createMessage("bruno");
  await react("bruno", message.id, "🔥");
  reset();

  const segunda = await react("bruno", message.id, "🔥");
  assert.equal(segunda.statusCode, 204, "clique duplo não pode virar erro");
  assert.equal(findAll("REACTION_ADD").length, 0, "o evento repetido pintaria a reação duas vezes na tela");

  const recarregada = await reload("bruno", message.id);
  assert.equal(recarregada.reactions[0]?.user_ids.length, 1);
});

test("DELETE tira a reação e emite REACTION_REMOVE; tirar de novo é 204 sem evento", async () => {
  const message = await createMessage("carla");
  await react("carla", message.id, "👍");
  reset();

  assert.equal((await react("carla", message.id, "👍", "DELETE")).statusCode, 204);
  assert.equal(findAll<ReactionData>("REACTION_REMOVE").length, 1);

  reset();
  assert.equal((await react("carla", message.id, "👍", "DELETE")).statusCode, 204);
  assert.equal(findAll("REACTION_REMOVE").length, 0);

  const recarregada = await reload("carla", message.id);
  assert.deepEqual(recarregada.reactions, []);
});

test("várias pessoas no MESMO emoji agregam numa entrada só, na ordem em que reagiram", async () => {
  const message = await createMessage("dora");
  await react("dora", message.id, "😀");
  await react("elias", message.id, "😀");
  await react("fabio", message.id, "😀");

  const recarregada = await reload("dora", message.id);
  assert.equal(recarregada.reactions.length, 1);
  assert.equal(recarregada.reactions[0]?.user_ids.length, 3);
  // `user_ids` viaja inteiro (e não um `me` por destinatário) porque o fan-out
  // manda o MESMO JSON para todas as sessões — ver o comentário no protocolo
  assert.equal(recarregada.reactions[0]?.user_ids[0], message.author_id);
});

// ---------------------------------------------------------------------------
// Emoji inválido
// ---------------------------------------------------------------------------

test("emoji inválido é 400: texto, emoji múltiplo e string gigante", async () => {
  const message = await createMessage("gabi");
  for (const invalido of ["oi", "a", "kkk", ":)", "😀😀", "👨‍👩‍👧", "x".repeat(500), "1"]) {
    const res = await react("gabi", message.id, invalido);
    // 414 no lugar de 400 para a string gigante é o servidor HTTP recusando o
    // caminho ANTES do roteamento — recusa mais barata ainda, e vale igual
    assert.ok(
      res.statusCode === 400 || res.statusCode === 414,
      `"${invalido.slice(0, 12)}" deveria ser recusado, foi ${res.statusCode}`,
    );
  }
  const recarregada = await reload("gabi", message.id);
  assert.deepEqual(recarregada.reactions, [], "nenhuma delas pode ter entrado");
});

// ---------------------------------------------------------------------------
// Tetos
// ---------------------------------------------------------------------------

test(`teto de ${MAX_REACTIONS_PER_USER_PER_MESSAGE} reações POR PESSOA por mensagem`, async () => {
  const message = await createMessage("heitor");
  const emojis = ["😀", "😁", "😂", "😃", "😄", "😅", "😆", "😇"];
  for (let i = 0; i < MAX_REACTIONS_PER_USER_PER_MESSAGE; i += 1) {
    assert.equal((await react("heitor", message.id, emojis[i] as string)).statusCode, 204, `a ${i + 1}ª deveria passar`);
  }
  const passouDoTeto = await react("heitor", message.id, emojis[MAX_REACTIONS_PER_USER_PER_MESSAGE] as string);
  assert.equal(passouDoTeto.statusCode, 409);
  assert.match((passouDoTeto.json() as { error: string }).error, /já reagiu/);
});

test(`teto de ${MAX_REACTIONS_PER_MESSAGE} emojis DISTINTOS por mensagem`, async () => {
  const message = await createMessage("ivo");
  // 20 emojis distintos, repartidos entre pessoas para não bater no teto pessoal
  const emojis = [...Array(MAX_REACTIONS_PER_MESSAGE + 1).keys()].map((i) => String.fromCodePoint(0x1f600 + i));
  for (let i = 0; i < MAX_REACTIONS_PER_MESSAGE; i += 1) {
    const quem = `teto${Math.floor(i / MAX_REACTIONS_PER_USER_PER_MESSAGE)}`;
    assert.equal((await react(quem, message.id, emojis[i] as string)).statusCode, 204, `emoji ${i + 1}`);
  }
  const extra = await react("tetoX", message.id, emojis[MAX_REACTIONS_PER_MESSAGE] as string);
  assert.equal(extra.statusCode, 409);
  assert.match((extra.json() as { error: string }).error, /reações diferentes/);

  // mas reagir com um emoji QUE JÁ EXISTE continua valendo: o teto é de
  // emojis distintos, não de reações
  assert.equal((await react("tetoY", message.id, emojis[0] as string)).statusCode, 204);
});

// ---------------------------------------------------------------------------
// Recusas
// ---------------------------------------------------------------------------

test("reagir em mensagem APAGADA é 404 (não teria onde aparecer)", async () => {
  const message = await createMessage("joana");
  await app.inject({
    method: "DELETE",
    url: `/api/channels/${CANAL}/messages/${message.id}`,
    headers: auth("joana"),
  });

  const res = await react("joana", message.id, "😀");
  assert.equal(res.statusCode, 404);
});

test("apagar a mensagem leva as reações junto", async () => {
  const message = await createMessage("kleber");
  await react("kleber", message.id, "😀");
  await react("luiza", message.id, "🔥");

  await app.inject({
    method: "DELETE",
    url: `/api/channels/${CANAL}/messages/${message.id}`,
    headers: auth("kleber"),
  });

  const sobrou = db.prepare("SELECT COUNT(*) AS n FROM reactions WHERE message_id = ?").get(BigInt(message.id)) as {
    n: bigint;
  };
  assert.equal(Number(sobrou.n), 0);
});

test("reagir em mensagem de outro CANAL (ou inexistente) é 404", async () => {
  db.prepare("INSERT OR IGNORE INTO channels (id, type, name, position) VALUES (7, 'text', 'outro', 7)").run();
  const noOutro = await app.inject({
    method: "POST",
    url: "/api/channels/7/messages",
    headers: auth("marcos"),
    payload: { content: "aqui" },
  });
  const message = noOutro.json() as Message;

  // mesma mensagem, canal errado no caminho
  assert.equal((await react("marcos", message.id, "😀")).statusCode, 404);
  assert.equal((await react("marcos", "999999999", "😀")).statusCode, 404);
});

test("sem autenticação é 401", async () => {
  const message = await createMessage("nina");
  const res = await app.inject({ method: "PUT", url: reactionUrl(message.id, "😀") });
  assert.equal(res.statusCode, 401);
});

test("quem está de timeout de chat não reage (reagir é escrever no canal)", async () => {
  const message = await createMessage("otavio");
  const calado = await createMessage("paulo");
  store.setMutedUntil(calado.author_id, Date.now() + 60_000);
  try {
    const res = await react("paulo", message.id, "😀");
    assert.equal(res.statusCode, 403);
    assert.match((res.json() as { error: string }).error, /silenciado/);
  } finally {
    store.setMutedUntil(calado.author_id, null);
  }
  // e volta a funcionar quando o castigo acaba
  assert.equal((await react("paulo", message.id, "😀")).statusCode, 204);
});
