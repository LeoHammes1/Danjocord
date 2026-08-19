/**
 * Testes do M11a: estado de leitura (item 81), menções resolvidas no POST
 * (item 79) e mensagens de sistema (item 92).
 *
 * Mesmo molde do `messages.test.ts`: banco em ":memory:", Fastify de verdade
 * via `app.inject()` e um Gateway sem `attach` (nenhuma sessão WS conectada, os
 * fan-outs são no-op — o que interessa aqui é O QUE seria enviado, e isso é
 * capturado espionando os métodos).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "tsx/esm/api";
import { Message, type ChannelReadState, type User } from "@danjocord/protocol";

register();

process.env.DANJOCORD_DEV_AUTH = "1";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { Gateway } = await import("../src/gateway.js");
const { registerRoutes } = await import("../src/routes.js");
const { announce } = await import("../src/system.js");

const db = openDb(":memory:");
const store = new Store(db);
const gateway = new Gateway(store);
const app = Fastify();
registerRoutes(app, store, gateway);

// canais próprios desta suíte: contagem de não lidas é por canal, e um canal
// compartilhado com outro teste tornaria os números dependentes de ordem
db.prepare("INSERT INTO channels (id, type, name, position) VALUES (10, 'text', 'leitura', 10)").run();
db.prepare("INSERT INTO channels (id, type, name, position) VALUES (11, 'text', 'mencoes', 11)").run();

function auth(username: string): Record<string, string> {
  return { authorization: `Bearer dev.${username}` };
}

async function post(username: string, channelId: string, content: string): Promise<Message> {
  const res = await app.inject({
    method: "POST",
    url: `/api/channels/${channelId}/messages`,
    headers: auth(username),
    payload: { content },
  });
  assert.equal(res.statusCode, 201, "setup: POST deveria devolver 201");
  // valida contra o schema do fio: garante que `type`, `mentions` e
  // `mentions_everyone` de fato viajam (e não só existem no banco)
  return Message.parse(res.json());
}

async function ack(username: string, channelId: string, messageId: string): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: `/api/channels/${channelId}/ack`,
    headers: auth(username),
    payload: { message_id: messageId },
  });
  return res.statusCode;
}

function stateOf(user: User, channelId: string): ChannelReadState {
  const found = store.readStates(user.id).find((s) => s.channel_id === channelId);
  assert.ok(found, `canal ${channelId} deveria aparecer no read_state`);
  return found;
}

const alice = store.findOrCreateDevUser("alice");
const bob = store.findOrCreateDevUser("bob");

// ---------------------------------------------------------------------------
// Contagem
// ---------------------------------------------------------------------------

test("sem read_state: conta TUDO menos as próprias (a regra da ausência)", async () => {
  await post("bob", "10", "primeira");
  await post("bob", "10", "segunda");
  await post("alice", "10", "minha, não conta");

  const paraAlice = stateOf(alice, "10");
  assert.equal(paraAlice.unread_count, 2, "nunca ter dado ack significa não ter lido nada");
  assert.equal(paraAlice.mention_count, 0);
  assert.notEqual(paraAlice.last_message_id, null);

  // ninguém tem não-lida de si mesmo: para o bob, só a mensagem da alice conta
  assert.equal(stateOf(bob, "10").unread_count, 1);
});

test("canal de voz não entra no read_state, e canal vazio vem com last_message_id null", () => {
  const states = store.readStates(alice.id);
  assert.ok(!states.some((s) => s.channel_id === "2"), "canal de voz não tem o que contar");
  const vazio = states.find((s) => s.channel_id === "11");
  assert.ok(vazio);
  assert.equal(vazio.last_message_id, null);
  assert.equal(vazio.unread_count, 0);
});

test("ack zera a contagem, e mensagem nova depois dele volta a contar", async () => {
  const ultima = stateOf(alice, "10").last_message_id;
  assert.ok(ultima);
  assert.equal(await ack("alice", "10", ultima), 204);
  assert.equal(stateOf(alice, "10").unread_count, 0);

  await post("bob", "10", "chegou depois");
  assert.equal(stateOf(alice, "10").unread_count, 1);
});

test("ack é idempotente: repetir não muda a marca nem quebra", async () => {
  const ultima = stateOf(alice, "10").last_message_id;
  assert.ok(ultima);
  assert.equal(await ack("alice", "10", ultima), 204);
  const marca = store.lastReadMessageId(alice.id, "10");
  assert.equal(await ack("alice", "10", ultima), 204);
  assert.equal(store.lastReadMessageId(alice.id, "10"), marca);
  assert.equal(stateOf(alice, "10").unread_count, 0);
});

test("ack NÃO retrocede: clicar num canal antigo não 'desle' o que já foi lido", async () => {
  const antiga = await post("bob", "10", "vai ficar para trás");
  const nova = await post("bob", "10", "a mais nova");
  assert.equal(await ack("alice", "10", nova.id), 204);
  assert.equal(stateOf(alice, "10").unread_count, 0);

  assert.equal(await ack("alice", "10", antiga.id), 204, "o pedido é aceito…");
  assert.equal(store.lastReadMessageId(alice.id, "10"), nova.id, "…mas a marca não anda para trás");
  assert.equal(stateOf(alice, "10").unread_count, 0);
});

test("ack não passa da última mensagem do canal (id inventado é limitado ao teto)", async () => {
  const ultima = stateOf(alice, "10").last_message_id;
  assert.ok(ultima);
  // o maior snowflake possível: sem o teto, marcaria como lido tudo que ainda
  // vai ser escrito, e a badge nunca mais acenderia para este usuário
  assert.equal(await ack("alice", "10", "9223372036854775807"), 204);
  assert.equal(store.lastReadMessageId(alice.id, "10"), ultima);

  await post("bob", "10", "escrita depois do ack do futuro");
  assert.equal(stateOf(alice, "10").unread_count, 1, "o ack do futuro não pode engolir mensagem nova");
});

test("ack em canal sem mensagem nenhuma → 204 sem gravar nada", async () => {
  assert.equal(await ack("alice", "11", "9223372036854775807"), 204);
  assert.equal(store.lastReadMessageId(alice.id, "11"), null);
});

test("ack: sem auth 401, canal inexistente 404, corpo/id inválidos 400", async () => {
  const semAuth = await app.inject({ method: "POST", url: "/api/channels/10/ack", payload: { message_id: "1" } });
  assert.equal(semAuth.statusCode, 401);

  const canalErrado = await app.inject({
    method: "POST",
    url: "/api/channels/2/ack", // canal de VOZ
    headers: auth("alice"),
    payload: { message_id: "1" },
  });
  assert.equal(canalErrado.statusCode, 404);

  const semCorpo = await app.inject({ method: "POST", url: "/api/channels/10/ack", headers: auth("alice") });
  assert.equal(semCorpo.statusCode, 400);

  const idTorto = await app.inject({
    method: "POST",
    url: "/api/channels/10/ack",
    headers: auth("alice"),
    payload: { message_id: "abc" },
  });
  assert.equal(idTorto.statusCode, 400, "id não-numérico é 400, nunca BigInt() explodindo em 500");
});

test("MESSAGE_ACK vai só para as sessões do PRÓPRIO usuário", async () => {
  const enviados: { userId: string; t: string; d: unknown }[] = [];
  const originalToUser = gateway.dispatchToUser.bind(gateway);
  const originalBroadcast = gateway.broadcast.bind(gateway);
  (gateway as { dispatchToUser: (u: string, t: string, d: unknown) => void }).dispatchToUser = (userId, t, d) => {
    enviados.push({ userId, t, d });
  };
  let broadcasts = 0;
  (gateway as { broadcast: (t: string, d: unknown) => void }).broadcast = (t) => {
    if (t === "MESSAGE_ACK") broadcasts += 1;
  };
  try {
    const msg = await post("bob", "10", "para dar ack");
    assert.equal(await ack("alice", "10", msg.id), 204);
    const evt = enviados.find((e) => e.t === "MESSAGE_ACK");
    assert.ok(evt, "o ack deveria emitir MESSAGE_ACK");
    assert.equal(evt.userId, alice.id, "só para quem leu — o resto da guild não tem o que fazer com isso");
    assert.deepEqual(evt.d, { channel_id: "10", last_read_message_id: msg.id });
    assert.equal(broadcasts, 0, "MESSAGE_ACK não pode ir para a guild inteira");
  } finally {
    (gateway as { dispatchToUser: typeof originalToUser }).dispatchToUser = originalToUser;
    (gateway as { broadcast: typeof originalBroadcast }).broadcast = originalBroadcast;
  }
});

// ---------------------------------------------------------------------------
// Menções (item 79)
// ---------------------------------------------------------------------------

test("menção é resolvida no POST e viaja na mensagem", async () => {
  const msg = await post("bob", "11", "bom dia @alice");
  assert.deepEqual(msg.mentions, [alice.id]);
  assert.equal(msg.mentions_everyone, false);
  assert.equal(msg.type, "user");

  // e sobrevive à releitura do histórico (veio da tabela, não do parse de novo)
  const res = await app.inject({ method: "GET", url: "/api/channels/11/messages?limit=10", headers: auth("alice") });
  const doHistorico = (res.json() as Message[]).find((m) => m.id === msg.id);
  assert.ok(doHistorico);
  assert.deepEqual(doHistorico.mentions, [alice.id]);
});

test("mention_count conta só a MINHA menção, e não a dos outros", async () => {
  const inicio = stateOf(alice, "11");
  const ultimaLida = inicio.last_message_id;
  assert.ok(ultimaLida);
  assert.equal(await ack("alice", "11", ultimaLida), 204);
  assert.equal(await ack("bob", "11", ultimaLida), 204);

  await post("bob", "11", "isto é para @alice");
  await post("bob", "11", "e isto é para @carol"); // nome inexistente: não menciona ninguém
  await post("alice", "11", "aqui a @alice menciona a si mesma");

  const paraAlice = stateOf(alice, "11");
  assert.equal(paraAlice.unread_count, 2, "as duas do bob; a própria da alice não conta");
  assert.equal(paraAlice.mention_count, 1, "a menção dentro da própria mensagem não conta para mim");

  const paraBob = stateOf(bob, "11");
  assert.equal(paraBob.mention_count, 0, "menção alheia não acende a badge de ninguém mais");
});

test("@todos conta como menção para quem não escreveu", async () => {
  const ultima = stateOf(alice, "11").last_message_id;
  assert.ok(ultima);
  assert.equal(await ack("alice", "11", ultima), 204);

  const msg = await post("bob", "11", "reunião agora @todos");
  assert.equal(msg.mentions_everyone, true);
  assert.deepEqual(msg.mentions, []);
  assert.equal(stateOf(alice, "11").mention_count, 1);
  assert.equal(stateOf(bob, "11").mention_count, 0, "quem escreveu não se menciona");

  // relido do BANCO: a coluna é INTEGER e o driver devolve BigInt — se o
  // booleano do fio saísse cru dali, o Zod recusaria a mensagem no cliente
  const res = await app.inject({ method: "GET", url: "/api/channels/11/messages?limit=5", headers: auth("alice") });
  const doHistorico = (res.json() as unknown[]).map((m) => Message.parse(m)).find((m) => m.id === msg.id);
  assert.ok(doHistorico);
  assert.equal(doHistorico.mentions_everyone, true);
});

test("menção dentro de bloco de código não conta (mesma regra dos dois lados)", async () => {
  const ultima = stateOf(alice, "11").last_message_id;
  assert.ok(ultima);
  assert.equal(await ack("alice", "11", ultima), 204);

  const msg = await post("bob", "11", "roda `ping @alice` aí");
  assert.deepEqual(msg.mentions, []);
  assert.equal(stateOf(alice, "11").mention_count, 0);
});

test("mensagem apagada some da contagem", async () => {
  const ultima = stateOf(alice, "11").last_message_id;
  assert.ok(ultima);
  assert.equal(await ack("alice", "11", ultima), 204);

  const msg = await post("bob", "11", "vou ser apagada, @alice");
  assert.equal(stateOf(alice, "11").unread_count, 1);
  assert.equal(stateOf(alice, "11").mention_count, 1);

  const del = await app.inject({ method: "DELETE", url: `/api/channels/11/messages/${msg.id}`, headers: auth("bob") });
  assert.equal(del.statusCode, 204);
  assert.equal(stateOf(alice, "11").unread_count, 0, "o que não aparece no histórico não pode acender badge");
  assert.equal(stateOf(alice, "11").mention_count, 0);
});

test("editar NÃO recalcula menções (quem foi notificado não desnotifica)", async () => {
  const msg = await post("bob", "11", "texto sem menção");
  const res = await app.inject({
    method: "PATCH",
    url: `/api/channels/11/messages/${msg.id}`,
    headers: auth("bob"),
    payload: { content: "agora com @alice" },
  });
  assert.equal(res.statusCode, 200);
  const editada = Message.parse(res.json());
  assert.deepEqual(editada.mentions, [], "a menção entra pelo próximo POST, não pela edição");
});

// ---------------------------------------------------------------------------
// Mensagens de sistema (item 92)
// ---------------------------------------------------------------------------

test("mensagem de sistema entra na paginação como qualquer outra", async () => {
  const carol = store.findOrCreateDevUser("carol");
  const criada = announce(store, gateway, "member_join", carol.id);
  assert.ok(criada, "announce deveria criar a mensagem");
  // vai para o primeiro canal de texto (o "geral" do seed), não para o último
  assert.equal(criada.channel_id, "1");
  assert.equal(criada.type, "member_join");
  assert.equal(criada.content, "", "a frase é montada na tela — o nome exibido muda com o apelido");
  assert.equal(criada.author_id, carol.id, "o autor é o sujeito do evento");

  const res = await app.inject({ method: "GET", url: "/api/channels/1/messages?limit=50", headers: auth("alice") });
  assert.equal(res.statusCode, 200);
  const historico = (res.json() as unknown[]).map((m) => Message.parse(m));
  const noHistorico = historico.find((m) => m.id === criada.id);
  assert.ok(noHistorico, "sem estar na tabela `messages` ela não apareceria na paginação");
  assert.equal(noHistorico.type, "member_join");
});

test("mensagem de sistema conta como não lida para os outros, mas não para o sujeito", () => {
  const dave = store.findOrCreateDevUser("dave");
  const antesAlice = stateOf(alice, "1").unread_count;
  const criada = announce(store, gateway, "member_leave", dave.id);
  assert.ok(criada);
  assert.equal(stateOf(alice, "1").unread_count, antesAlice + 1);
  assert.equal(stateOf(dave, "1").mention_count, 0, "aviso do servidor não menciona ninguém");
});

test("announce('user') é no-op: mensagem normal nasce do POST do dono dela", () => {
  assert.equal(announce(store, gateway, "user", alice.id), null);
});

test("cliente não forja mensagem de sistema: type != 'user' → 400 explícito", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/channels/10/messages",
    headers: auth("bob"),
    payload: { content: "eu entrei sozinho", type: "member_join" },
  });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /servidor/);
});

// ---------------------------------------------------------------------------
// Autor que já saiu (item 85) — o que faz a mensagem de sistema ser legível
// ---------------------------------------------------------------------------

test("GET /api/users/:id resolve autor fora da lista de membros", async () => {
  const res = await app.inject({ method: "GET", url: `/api/users/${bob.id}`, headers: auth("alice") });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as User).id, bob.id);

  const fantasma = await app.inject({
    method: "GET",
    url: "/api/users/4611686018427387904",
    headers: auth("alice"),
  });
  assert.equal(fantasma.statusCode, 404);

  const semAuth = await app.inject({ method: "GET", url: `/api/users/${bob.id}` });
  assert.equal(semAuth.statusCode, 401);
});

/**
 * Quem entra na guild NÃO herda o backlog (M11a, achado da verificação).
 *
 * A regra de contagem diz "sem read_state, conta tudo" — correto para quem
 * sempre esteve aqui e nunca abriu um canal, e péssimo para quem acabou de
 * chegar por convite (M10) numa guild com histórico: veria "342 novas" num
 * canal onde nunca houve nada dirigido a ele, e nunca zeraria isso lendo.
 */
test("membro novo nasce com os canais LIDOS — o convidado não herda o backlog", async () => {
  db.prepare("INSERT INTO channels (id, type, name, position) VALUES (12, 'text', 'backlog', 12)").run();
  for (let i = 0; i < 5; i++) await post("alice", "12", `histórico ${i}`);

  // sem o gancho, a regra da ausência conta tudo — é o comportamento esperado
  const semSeed = store.findOrCreateDevUser("sem-seed");
  db.prepare("DELETE FROM read_state WHERE user_id = ?").run(BigInt(semSeed.id));
  assert.equal(stateOf(semSeed, "12").unread_count, 5, "sem read_state a regra conta tudo");

  // com o gancho de entrada, o recém-chegado começa zerado
  const novato = store.findOrCreateDevUser("recem-chegado");
  store.markAllReadOnJoin(novato.id);
  assert.equal(stateOf(novato, "12").unread_count, 0, "entrar não é ter perdido o que veio antes");
  assert.equal(stateOf(novato, "12").mention_count, 0);

  // e o que chega DEPOIS conta normalmente
  await post("alice", "12", "essa é depois de você chegar");
  assert.equal(stateOf(novato, "12").unread_count, 1);
});
