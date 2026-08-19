/**
 * Testes da busca no histórico (M11b, item 91).
 *
 * Duas frentes, e a primeira é a que costuma quebrar em produção: a SINTAXE do
 * FTS5. `MATCH` não recebe uma string de busca, recebe uma expressão — `"`,
 * `*`, `AND`, `(`, `-`, `^`, `NEAR` têm significado. Procurar por qualquer um
 * deles com o texto cru vira erro de SQL na cara do usuário.
 *
 * A segunda é o que o índice NÃO pode devolver: mensagem apagada (um índice que
 * lembra do que foi apagado é o vazamento mais bobo possível) e mensagem de
 * sistema (conteúdo vazio, só polui). Os dois casos dependem dos triggers da
 * migration 006 — e o do apagado é um UPDATE, não um DELETE, que é justamente
 * a armadilha.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "tsx/esm/api";
import type { Message, SearchHit } from "@danjocord/protocol";

register();

process.env.DANJOCORD_DEV_AUTH = "1";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { Gateway } = await import("../src/gateway.js");
const { registerRoutes } = await import("../src/routes.js");
const { registerSearchRoutes, sanitizeFtsQuery } = await import("../src/search.js");
const { announce } = await import("../src/system.js");
const { SEARCH_HIT_OPEN, SEARCH_HIT_CLOSE } = await import("@danjocord/protocol");

const db = openDb(":memory:");
const store = new Store(db);
const gateway = new Gateway(store);
const app = Fastify();
registerRoutes(app, store, gateway);
registerSearchRoutes(app, store);

const GERAL = "1";
const OUTRO = "9";
db.prepare("INSERT INTO channels (id, type, name, position) VALUES (9, 'text', 'outro', 9)").run();

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
  assert.equal(res.statusCode, 201, `setup: POST deveria dar 201, deu ${res.statusCode} (${res.body})`);
  return res.json() as Message;
}

async function search(username: string, query: string, extra = ""): Promise<SearchHit[]> {
  const res = await app.inject({
    method: "GET",
    url: `/api/search?q=${encodeURIComponent(query)}${extra}`,
    headers: auth(username),
  });
  assert.equal(res.statusCode, 200, `busca por "${query}" deveria dar 200, deu ${res.statusCode} (${res.body})`);
  return (res.json() as { hits: SearchHit[] }).hits;
}

// ---------------------------------------------------------------------------
// O saneador da consulta (puro)
// ---------------------------------------------------------------------------

test("sanitize: cada palavra vira uma frase entre aspas (nada é interpretado como sintaxe)", () => {
  assert.equal(sanitizeFtsQuery("carregador"), '"carregador"');
  assert.equal(sanitizeFtsQuery("meu carregador"), '"meu" "carregador"');
});

test("sanitize: os operadores do FTS5 viram texto comum", () => {
  // "AND" e "OR" são operadores; entre aspas, viram palavras a procurar
  assert.equal(sanitizeFtsQuery("AND"), '"AND"');
  assert.equal(sanitizeFtsQuery("a AND b"), '"a" "AND" "b"');
  // parêntese e afins ficam DENTRO das aspas: lá são separadores de token para
  // o tokenizador do FTS5, não sintaxe da expressão
  assert.equal(sanitizeFtsQuery("NEAR(a b)"), '"NEAR(a" "b)"');
});

test("sanitize: aspas do usuário somem (é o único caractere que fecha o quoting)", () => {
  assert.equal(sanitizeFtsQuery('"'), "");
  assert.equal(sanitizeFtsQuery('a" OR "b'), '"a" "OR" "b"');
});

test("sanitize: palavra sem letra nem dígito é descartada (viraria uma frase vazia)", () => {
  assert.equal(sanitizeFtsQuery("*"), "");
  assert.equal(sanitizeFtsQuery("("), "");
  assert.equal(sanitizeFtsQuery("^ - : ( ) *"), "");
  assert.equal(sanitizeFtsQuery(""), "");
  assert.equal(sanitizeFtsQuery("   "), "");
});

test("sanitize: consulta absurdamente longa é aparada", () => {
  const muitas = sanitizeFtsQuery(Array.from({ length: 100 }, (_, i) => `palavra${i}`).join(" "));
  assert.equal(muitas.split(" ").length, 12);
});

// ---------------------------------------------------------------------------
// A rota, com os caracteres que quebrariam o SQL
// ---------------------------------------------------------------------------

test("busca com aspas, *, AND, parêntese e string vazia NÃO explode", async () => {
  await post("ana", GERAL, "achei o carregador na mochila");
  for (const q of ['"', "*", "AND", "(", ")", "", "   ", '"AND"', "a*b", "-x", "^y", "NEAR(a b)", "a:b"]) {
    const res = await app.inject({
      method: "GET",
      url: `/api/search?q=${encodeURIComponent(q)}`,
      headers: auth("ana"),
    });
    assert.equal(res.statusCode, 200, `q=${JSON.stringify(q)} deveria dar 200, deu ${res.statusCode} (${res.body})`);
  }
});

test("busca acha a mensagem e devolve o trecho com os marcadores", async () => {
  const message = await post("bruno", GERAL, "o churrasco vai ser no sábado de manhã");
  const hits = await search("bruno", "churrasco");

  const hit = hits.find((h) => h.message.id === message.id);
  assert.ok(hit, "a mensagem deveria aparecer");
  assert.ok(hit.snippet.includes(SEARCH_HIT_OPEN), "o trecho tem que marcar o acerto");
  assert.ok(hit.snippet.includes(SEARCH_HIT_CLOSE));
  assert.match(hit.snippet.replaceAll(SEARCH_HIT_OPEN, "").replaceAll(SEARCH_HIT_CLOSE, ""), /churrasco/);
});

test("busca ignora acentos nos dois sentidos (remove_diacritics 2)", async () => {
  const message = await post("carla", GERAL, "a reunião é sobre orçamento");
  assert.ok((await search("carla", "reuniao")).some((h) => h.message.id === message.id));
  assert.ok((await search("carla", "orçamento")).some((h) => h.message.id === message.id));
});

test("duas palavras exigem as DUAS (AND implícito)", async () => {
  const alvo = await post("dora", GERAL, "pizza de calabresa hoje");
  await post("dora", GERAL, "pizza de mussarela amanhã");

  const hits = await search("dora", "pizza calabresa");
  assert.equal(hits.filter((h) => h.message.id === alvo.id).length, 1);
  assert.equal(hits.length, 1, "só a que tem as duas palavras");
});

test("filtro por canal", async () => {
  const noGeral = await post("elias", GERAL, "assunto-unico-do-geral");
  const noOutro = await post("elias", OUTRO, "assunto-unico-do-geral também aqui");

  const todos = await search("elias", "assunto-unico-do-geral");
  assert.equal(todos.length, 2);

  const soGeral = await search("elias", "assunto-unico-do-geral", `&channel_id=${GERAL}`);
  assert.deepEqual(
    soGeral.map((h) => h.message.id),
    [noGeral.id],
  );
  assert.ok(!soGeral.some((h) => h.message.id === noOutro.id));
});

// ---------------------------------------------------------------------------
// O que NÃO pode aparecer
// ---------------------------------------------------------------------------

test("mensagem APAGADA some do índice (o apagar é UPDATE, não DELETE)", async () => {
  const message = await post("fabio", GERAL, "palavraquevaisumir");
  assert.equal((await search("fabio", "palavraquevaisumir")).length, 1);

  const del = await app.inject({
    method: "DELETE",
    url: `/api/channels/${GERAL}/messages/${message.id}`,
    headers: auth("fabio"),
  });
  assert.equal(del.statusCode, 204);

  assert.deepEqual(await search("fabio", "palavraquevaisumir"), [], "um índice que lembra do apagado é vazamento");
});

test("mensagem de SISTEMA não aparece na busca", async () => {
  // o announce cria uma mensagem de sistema (conteúdo vazio) assinada pelo
  // sujeito do evento; ela existe na tabela e não pode existir no índice
  const membro = await post("gabi", GERAL, "só para existir um usuário");
  const sistema = announce(store, gateway, "member_join", membro.author_id);
  assert.ok(sistema, "setup: o announce deveria ter criado a mensagem");

  const emTodas = await search("gabi", "existir");
  assert.ok(!emTodas.some((h) => h.message.id === sistema.id));
  // e o histórico continua trazendo a mensagem de sistema (ela só não é buscável)
  const historico = await app.inject({
    method: "GET",
    url: `/api/channels/${GERAL}/messages?limit=100`,
    headers: auth("gabi"),
  });
  assert.ok((historico.json() as Message[]).some((m) => m.id === sistema.id));
});

test("editar a mensagem troca o texto no índice (o antigo não é mais achável)", async () => {
  const message = await post("heitor", GERAL, "textoantigo aqui");
  assert.equal((await search("heitor", "textoantigo")).length, 1);

  const patch = await app.inject({
    method: "PATCH",
    url: `/api/channels/${GERAL}/messages/${message.id}`,
    headers: auth("heitor"),
    payload: { content: "textonovo aqui" },
  });
  assert.equal(patch.statusCode, 200);

  assert.deepEqual(await search("heitor", "textoantigo"), [], "o texto antigo não pode continuar buscável");
  assert.equal((await search("heitor", "textonovo")).length, 1);
});

// ---------------------------------------------------------------------------
// Contrato da rota
// ---------------------------------------------------------------------------

test("o resultado carrega a MENSAGEM inteira (com anexos e reações hidratados)", async () => {
  const message = await post("ivo", GERAL, "mensagem-completa-na-busca");
  const hit = (await search("ivo", "mensagem-completa-na-busca"))[0];
  assert.ok(hit);
  assert.equal(hit.message.id, message.id);
  assert.deepEqual(hit.message.attachments, []);
  assert.deepEqual(hit.message.reactions, []);
  assert.equal(hit.message.reply_to, null);
});

test("sem autenticação é 401; canal inexistente é 404", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/search?q=oi" })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/search?q=oi&channel_id=4242", headers: auth("ivo") })).statusCode,
    404,
  );
});

test("a migration REINDEXA o histórico que já existe (banco com conversa dentro)", async () => {
  // A 006 roda em bancos que já têm meses de conversa — se o índice nascesse
  // vazio, a busca só acharia o que fosse escrito DEPOIS do deploy, e ninguém
  // perceberia (a busca "funciona", só não acha nada antigo).
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const dir = mkdtempSync(join(tmpdir(), "danjocord-fts-"));
  const path = join(dir, "reindex.db");
  try {
    const primeiro = openDb(path);
    const loja = new Store(primeiro);
    loja.createMessage("1", loja.findOrCreateDevUser("velho").id, "assunto antigo do historico");

    // desfaz a 006 INTEIRA e deixa a mensagem no banco — é o estado exato de um
    // banco do M11a no instante anterior ao deploy. Desfazer só o índice não
    // serviria: o `openDb` reaplica a migration completa, e o ALTER TABLE
    // esbarraria na coluna que ficou.
    primeiro.exec(
      "DROP TRIGGER messages_fts_ai; DROP TRIGGER messages_fts_au_content;" +
        " DROP TRIGGER messages_fts_au_deleted; DROP TRIGGER messages_fts_ad;" +
        " DROP TABLE messages_fts;" +
        " DROP TABLE reactions; DROP TABLE attachments; DROP TABLE link_previews;" +
        " ALTER TABLE messages DROP COLUMN reply_to_id;",
    );
    primeiro.prepare("DELETE FROM migrations WHERE name = '006_chat_rich.sql'").run();
    primeiro.close();

    // reabrir aplica a 006 de novo, agora com histórico dentro
    const segundo = openDb(path);
    const relojoada = new Store(segundo);
    const hits = relojoada.searchMessages('"antigo"');
    assert.equal(hits.length, 1, "a mensagem anterior à migration tem que estar buscável");
    assert.match(hits[0]?.message.content ?? "", /assunto antigo/);
    segundo.close();
  } finally {
    // faxina de melhor esforço: no Windows o -wal/-shm às vezes segue preso ao
    // processo por um instante depois do close, e o teste não pode falhar por
    // causa de um arquivo temporário
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* o SO limpa o tmp */
    }
  }
});

test("limit é respeitado e clampado", async () => {
  for (let i = 0; i < 6; i += 1) await post("joana", GERAL, `repetida-limite numero ${i}`);
  assert.equal((await search("joana", "repetida-limite", "&limit=3")).length, 3);
  // limite não numérico cai no padrão em vez de virar erro de SQL
  assert.ok((await search("joana", "repetida-limite", "&limit=abc")).length >= 6);
});
