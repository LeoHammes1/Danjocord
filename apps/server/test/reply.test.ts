/**
 * Testes do reply (M11b, item 86).
 *
 * O teste que justifica o arquivo é o de CANAL CRUZADO: a citação viaja
 * RESOLVIDA (autor + trecho do conteúdo), então citar uma mensagem de outro
 * canal vazaria um pedaço daquele canal para dentro deste. É a única regra do
 * item que é de segurança, e não de UI.
 *
 * O segundo é o da mensagem apagada DEPOIS: a citação não pode sumir (isso
 * reescreveria a conversa de quem respondeu) nem continuar mostrando o texto
 * apagado. Ela vira "mensagem apagada" — `deleted: true`, sem autor e sem
 * trecho.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "tsx/esm/api";
import type { Message } from "@danjocord/protocol";

register();

process.env.DANJOCORD_DEV_AUTH = "1";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { Gateway } = await import("../src/gateway.js");
const { registerRoutes } = await import("../src/routes.js");

const db = openDb(":memory:");
const store = new Store(db);
const gateway = new Gateway(store);
const app = Fastify();
registerRoutes(app, store, gateway);

const GERAL = "1";
const OUTRO = "8";
db.prepare("INSERT INTO channels (id, type, name, position) VALUES (8, 'text', 'outro', 8)").run();

function auth(username: string): Record<string, string> {
  return { authorization: `Bearer dev.${username}` };
}

async function post(username: string, channelId: string, body: unknown) {
  return app.inject({
    method: "POST",
    url: `/api/channels/${channelId}/messages`,
    headers: auth(username),
    payload: body,
  });
}

async function postOk(username: string, channelId: string, body: unknown): Promise<Message> {
  const res = await post(username, channelId, body);
  assert.equal(res.statusCode, 201, `setup: POST deveria dar 201, deu ${res.statusCode} (${res.body})`);
  return res.json() as Message;
}

test("reply carrega a citação RESOLVIDA (autor e trecho) já no MESSAGE_CREATE", async () => {
  const original = await postOk("ana", GERAL, { content: "alguém viu meu carregador?" });
  const resposta = await postOk("bruno", GERAL, { content: "tá aqui", reply_to_id: original.id });

  assert.equal(resposta.reply_to?.message_id, original.id);
  assert.equal(resposta.reply_to?.channel_id, GERAL);
  assert.equal(resposta.reply_to?.author_id, original.author_id);
  assert.equal(resposta.reply_to?.excerpt, "alguém viu meu carregador?");
  assert.equal(resposta.reply_to?.deleted, false);
});

test("a citação também vem na paginação (mesmo caminho de hidratação)", async () => {
  const original = await postOk("carla", GERAL, { content: "pergunta" });
  const resposta = await postOk("dora", GERAL, { content: "resposta", reply_to_id: original.id });

  const historico = await app.inject({
    method: "GET",
    url: `/api/channels/${GERAL}/messages?limit=100`,
    headers: auth("carla"),
  });
  const lida = (historico.json() as Message[]).find((m) => m.id === resposta.id);
  assert.equal(lida?.reply_to?.excerpt, "pergunta");
});

test("trecho longo é APARADO pelo servidor e a quebra de linha vira espaço", async () => {
  const longo = `linha um\nlinha dois ${"x".repeat(400)}`;
  const original = await postOk("elias", GERAL, { content: longo });
  const resposta = await postOk("fabio", GERAL, { content: "ok", reply_to_id: original.id });

  const excerpt = resposta.reply_to?.excerpt ?? "";
  assert.ok(excerpt.length <= 120, `o trecho tem ${excerpt.length} caracteres`);
  assert.ok(!excerpt.includes("\n"), "a citação é UMA linha na tela");
  assert.match(excerpt, /^linha um linha dois/);
});

test("REPLY CRUZANDO CANAL é recusado (senão a citação vaza conteúdo entre canais)", async () => {
  const noOutro = await postOk("gabi", OUTRO, { content: "segredo do outro canal" });
  const res = await post("gabi", GERAL, { content: "olha só", reply_to_id: noOutro.id });

  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /outro canal/);

  // e nada foi criado no #geral
  const historico = await app.inject({
    method: "GET",
    url: `/api/channels/${GERAL}/messages?limit=100`,
    headers: auth("gabi"),
  });
  assert.equal(
    (historico.json() as Message[]).some((m) => m.content === "olha só"),
    false,
  );
});

test("citar mensagem inexistente é 400", async () => {
  const res = await post("heitor", GERAL, { content: "oi", reply_to_id: "123456789" });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /não existe/);
});

test("citar mensagem JÁ apagada é 400 (a tela de quem mandou estava velha)", async () => {
  const original = await postOk("ivo", GERAL, { content: "some" });
  await app.inject({
    method: "DELETE",
    url: `/api/channels/${GERAL}/messages/${original.id}`,
    headers: auth("ivo"),
  });

  const res = await post("joana", GERAL, { content: "resposta tardia", reply_to_id: original.id });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /apagada/);
});

test("citada apagada DEPOIS: a citação vira 'mensagem apagada', não some", async () => {
  const original = await postOk("kleber", GERAL, { content: "conteúdo que será apagado" });
  const resposta = await postOk("luiza", GERAL, { content: "respondendo", reply_to_id: original.id });

  await app.inject({
    method: "DELETE",
    url: `/api/channels/${GERAL}/messages/${original.id}`,
    headers: auth("kleber"),
  });

  const historico = await app.inject({
    method: "GET",
    url: `/api/channels/${GERAL}/messages?limit=100`,
    headers: auth("luiza"),
  });
  const lida = (historico.json() as Message[]).find((m) => m.id === resposta.id);

  assert.notEqual(lida?.reply_to, null, "a citação não pode sumir: isso reescreveria a conversa");
  assert.equal(lida?.reply_to?.deleted, true);
  assert.equal(lida?.reply_to?.author_id, null);
  assert.equal(lida?.reply_to?.excerpt, null, "o texto apagado não pode vazar pela citação");
});

test("mensagem sem reply tem reply_to null (o campo existe sempre)", async () => {
  const message = await postOk("marcos", GERAL, { content: "sem citação" });
  assert.equal(message.reply_to, null);
});

test("responder a uma resposta cita SÓ um nível (a corrente não viaja inteira)", async () => {
  const a = await postOk("nina", GERAL, { content: "A" });
  const b = await postOk("otavio", GERAL, { content: "B", reply_to_id: a.id });
  const c = await postOk("paula", GERAL, { content: "C", reply_to_id: b.id });

  assert.equal(c.reply_to?.message_id, b.id);
  assert.equal(c.reply_to?.excerpt, "B");
  // a citação de B (que aponta para A) NÃO viaja dentro de C
  assert.equal("reply_to" in (c.reply_to ?? {}), false);
});
