/**
 * Testes do REST de anexos (M11b, item 89): upload de binário cru, os três
 * tetos (por arquivo, total da guild, rate limit), o GET de bytes (mime
 * GUARDADO, nosniff, cache imutável), a amarração com a mensagem e a faxina de
 * órfãos.
 *
 * Banco em ":memory:", Fastify de verdade via app.inject(), Gateway sem attach
 * (broadcast vira no-op) — o mesmo desenho do `sounds.test.ts` do M9, porque
 * esta é a mesma classe de superfície: bytes de usuário entrando no servidor.
 *
 * Cada teste usa um usuário PRÓPRIO onde há rate limit: as janelas são por
 * chave, e reaproveitar "alice" faria um teste comer a cota do outro.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "tsx/esm/api";
import type { Attachment, Message } from "@danjocord/protocol";

register();

process.env.DANJOCORD_DEV_AUTH = "1";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { Gateway } = await import("../src/gateway.js");
const { registerRoutes } = await import("../src/routes.js");
const { registerAttachmentRoutes } = await import("../src/attachments/routes.js");
const { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_TOTAL_BYTES, ORPHAN_TTL_MS, UPLOAD_LIMIT } = await import(
  "../src/attachments/limits.js"
);

const db = openDb(":memory:");
const store = new Store(db);
const gateway = new Gateway(store);
const app = Fastify();
registerRoutes(app, store, gateway);
registerAttachmentRoutes(app, store);

const CANAL = "1"; // 'geral', do seed da migration 001

function auth(username: string): Record<string, string> {
  return { authorization: `Bearer dev.${username}` };
}

/** PNG mínimo e VÁLIDO: assinatura + IHDR com as dimensões pedidas. */
function png(width = 4, height = 3, padding = 0): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head[24] = 8;
  head[25] = 6;
  return padding > 0 ? Buffer.concat([head, Buffer.alloc(padding)]) : head;
}

async function upload(
  username: string,
  { filename = "foto.png", payload = png(), contentType = "application/octet-stream" } = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/attachments?filename=${encodeURIComponent(filename)}`,
    headers: { ...auth(username), "content-type": contentType },
    payload,
  });
}

async function uploadOk(username: string, options?: Parameters<typeof upload>[1]): Promise<Attachment> {
  const res = await upload(username, options);
  assert.equal(res.statusCode, 201, `setup: upload deveria dar 201, deu ${res.statusCode} (${res.body})`);
  return res.json() as Attachment;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

test("upload devolve o anexo com mime e dimensões MEDIDAS pelo servidor", async () => {
  const attachment = await uploadOk("ana", { payload: png(800, 600) });
  assert.equal(attachment.mime, "image/png");
  assert.equal(attachment.width, 800);
  assert.equal(attachment.height, 600);
  assert.equal(attachment.filename, "foto.png");
  assert.ok(Number(attachment.id) > 0);
});

test("o Content-Type do request NÃO decide o tipo — quem decide são os magic bytes", async () => {
  // sobe um PNG dizendo que é JPEG: o servidor grava image/png mesmo assim
  const attachment = await uploadOk("bruno", { contentType: "image/jpeg" });
  assert.equal(attachment.mime, "image/png");
});

test(".exe renomeado para .png é 400 (a extensão não vale nada)", async () => {
  const exe = Buffer.concat([Buffer.from("MZ\x90\x00"), Buffer.alloc(500, 0x41)]);
  const res = await upload("carla", { filename: "gato.png", payload: exe });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /formato não reconhecido/);
});

test("upload sem autenticação é 401", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/attachments?filename=a.png",
    headers: { "content-type": "application/octet-stream" },
    payload: png(),
  });
  assert.equal(res.statusCode, 401);
});

test("nome de arquivo com caminho ou controle é recusado", async () => {
  for (const filename of ["../../etc/passwd", "pasta/foto.png", "a\\b.png"]) {
    const res = await upload("dora", { filename });
    assert.equal(res.statusCode, 400, `"${filename}" deveria ser recusado`);
  }
});

test("corpo vazio é 400", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/attachments?filename=a.png",
    headers: { ...auth("elias"), "content-type": "application/octet-stream" },
    payload: Buffer.alloc(0),
  });
  assert.equal(res.statusCode, 400);
});

test("teto POR ARQUIVO: acima de 8 MB o Fastify corta antes da rota", async () => {
  const gigante = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
  png(1, 1).copy(gigante, 0); // começa como PNG válido: o que barra é o tamanho
  const res = await upload("fabio", { payload: gigante });
  assert.equal(res.statusCode, 413);
});

test("teto TOTAL da guild: quando enche, o erro é 507 e diz o que fazer", async () => {
  // o teto real é 512 MB — encher de verdade num teste seria escrever meio giga
  // no banco. O que interessa é o RAMO: com a guild cheia, ninguém sobe mais.
  const original = store.totalAttachmentBytes.bind(store);
  store.totalAttachmentBytes = () => MAX_ATTACHMENTS_TOTAL_BYTES;
  try {
    const res = await upload("gabi");
    assert.equal(res.statusCode, 507);
    assert.match((res.json() as { error: string }).error, /apague mensagens com anexo/);
  } finally {
    store.totalAttachmentBytes = original;
  }
});

test("rate limit: a TENTATIVA conta, não só o sucesso", async () => {
  const exe = Buffer.from("MZ\x90\x00lixo");
  // todas as tentativas falham no provador, e ainda assim consomem cota
  for (let i = 0; i < UPLOAD_LIMIT; i += 1) {
    const res = await upload("heitor", { payload: exe });
    assert.equal(res.statusCode, 400, `tentativa ${i + 1} deveria ser 400 (arquivo inválido)`);
  }
  const bloqueado = await upload("heitor");
  assert.equal(bloqueado.statusCode, 429, "mandar lixo repetidamente não pode sair de graça");
  assert.ok(Number(bloqueado.headers["retry-after"]) >= 1);
});

// ---------------------------------------------------------------------------
// GET dos bytes
// ---------------------------------------------------------------------------

test("GET devolve o mime GUARDADO, nosniff, cache imutável e inline", async () => {
  const attachment = await uploadOk("ivo", { payload: png(10, 10) });
  const res = await app.inject({ method: "GET", url: `/api/attachments/${attachment.id}`, headers: auth("ivo") });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/png");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.match(String(res.headers["cache-control"]), /immutable/);
  assert.match(String(res.headers["content-disposition"]), /^inline;/);
  assert.equal(res.rawPayload.length, png(10, 10).length);
});

test("GET de anexo inexistente é 404, e sem autenticação é 401", async () => {
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/attachments/99999", headers: auth("ivo") })).statusCode,
    404,
  );
  assert.equal((await app.inject({ method: "GET", url: "/api/attachments/1" })).statusCode, 401);
});

// ---------------------------------------------------------------------------
// Amarração com a mensagem
// ---------------------------------------------------------------------------

async function postMessage(username: string, body: unknown) {
  return app.inject({ method: "POST", url: `/api/channels/${CANAL}/messages`, headers: auth(username), payload: body });
}

test("a mensagem carrega os anexos amarrados", async () => {
  const attachment = await uploadOk("joana", { payload: png(64, 64) });
  const res = await postMessage("joana", { content: "olha isso", attachment_ids: [attachment.id] });
  assert.equal(res.statusCode, 201);

  const message = res.json() as Message;
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0]?.id, attachment.id);
  assert.equal(message.attachments[0]?.width, 64);

  // e continua vindo na paginação (o mesmo caminho de hidratação)
  const historico = await app.inject({
    method: "GET",
    url: `/api/channels/${CANAL}/messages?limit=5`,
    headers: auth("joana"),
  });
  const primeiro = (historico.json() as Message[]).find((m) => m.id === message.id);
  assert.equal(primeiro?.attachments.length, 1);
});

test("mensagem SÓ com imagem (sem texto) é válida; sem texto e sem anexo, não", async () => {
  const attachment = await uploadOk("kleber");
  const comImagem = await postMessage("kleber", { content: "", attachment_ids: [attachment.id] });
  assert.equal(comImagem.statusCode, 201);

  const vazia = await postMessage("kleber", { content: "   " });
  assert.equal(vazia.statusCode, 400);
  assert.match((vazia.json() as { error: string }).error, /mensagem vazia/);
});

test("não dá para pendurar anexo de OUTRA pessoa", async () => {
  const daLuiza = await uploadOk("luiza");
  const res = await postMessage("marcos", { content: "meu agora", attachment_ids: [daLuiza.id] });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /de outra pessoa/);
  // e o anexo da Luiza continua solto, esperando a mensagem dela
  assert.equal(store.attachmentOwnership(daLuiza.id)?.attached, false);
});

test("anexo já usado não pode ser reaproveitado numa segunda mensagem", async () => {
  const attachment = await uploadOk("nina");
  assert.equal((await postMessage("nina", { content: "1", attachment_ids: [attachment.id] })).statusCode, 201);
  const segunda = await postMessage("nina", { content: "2", attachment_ids: [attachment.id] });
  assert.equal(segunda.statusCode, 400);
});

test("id de anexo inexistente é 400 (e a mensagem NÃO é criada)", async () => {
  const antes = (await app.inject({
    method: "GET",
    url: `/api/channels/${CANAL}/messages?limit=100`,
    headers: auth("otavio"),
  })).json() as Message[];
  const res = await postMessage("otavio", { content: "oi", attachment_ids: ["123456789"] });
  assert.equal(res.statusCode, 400);
  const depois = (await app.inject({
    method: "GET",
    url: `/api/channels/${CANAL}/messages?limit=100`,
    headers: auth("otavio"),
  })).json() as Message[];
  assert.equal(depois.length, antes.length, "a mensagem não pode ter sido criada");
});

// ---------------------------------------------------------------------------
// Ciclo de vida dos bytes
// ---------------------------------------------------------------------------

test("apagar a mensagem apaga os BLOBs (senão eles ocupam o PVC para sempre)", async () => {
  const attachment = await uploadOk("paula", { payload: png(20, 20) });
  const message = (await postMessage("paula", { content: "tchau", attachment_ids: [attachment.id] })).json() as Message;

  assert.equal(
    (await app.inject({ method: "GET", url: `/api/attachments/${attachment.id}`, headers: auth("paula") })).statusCode,
    200,
  );

  const del = await app.inject({
    method: "DELETE",
    url: `/api/channels/${CANAL}/messages/${message.id}`,
    headers: auth("paula"),
  });
  assert.equal(del.statusCode, 204);

  const depois = await app.inject({
    method: "GET",
    url: `/api/attachments/${attachment.id}`,
    headers: auth("paula"),
  });
  assert.equal(depois.statusCode, 404, "o BLOB tem que ter ido junto com a mensagem");
});

test("faxina de órfãos: o solto e velho vai embora; o amarrado fica", async () => {
  const orfao = await uploadOk("rita");
  const usado = await uploadOk("rita");
  await postMessage("rita", { content: "com anexo", attachment_ids: [usado.id] });

  // ainda dentro do prazo: nada é apagado
  assert.equal(store.deleteOrphanAttachments(ORPHAN_TTL_MS), 0);
  assert.equal(store.attachmentOwnership(orfao.id) !== null, true);

  // "faz mais de 15 minutos" — o relógio entra por parâmetro em vez de a suíte
  // ter que dormir
  // >= 1 e não == 1: os testes anteriores deixaram outros órfãos no mesmo
  // banco, e é exatamente esse acúmulo que a faxina existe para varrer
  const removidos = store.deleteOrphanAttachments(ORPHAN_TTL_MS, Date.now() + ORPHAN_TTL_MS + 1);
  assert.ok(removidos >= 1, `a faxina deveria ter apagado algo, apagou ${removidos}`);
  assert.equal(store.attachmentOwnership(orfao.id), null, "o órfão tinha que sumir");
  assert.notEqual(store.attachmentOwnership(usado.id), null, "o amarrado não pode ser tocado");
});
