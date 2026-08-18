/**
 * Testes do REST do soundboard (M9): upload de binário cru, limites
 * server-side, permissão de renomear/apagar, o GET de áudio (mime GUARDADO,
 * cache imutável) e a rota de tocar (403 fora da voz, cooldown por usuário e
 * teto por canal). Banco em ":memory:", Fastify de verdade via app.inject(),
 * Gateway sem attach (broadcast vira no-op, e o espião captura o que sairia).
 *
 * O canal de voz do usuário entra por injeção (`voiceChannelOf`): a rota
 * pergunta ao módulo de voz no wiring real, e aqui o teste controla a resposta
 * sem subir um worker do mediasoup.
 *
 * Cada teste usa um usuário PRÓPRIO onde há rate limit: as janelas são por
 * chave, e reaproveitar "alice" faria um teste comer a cota do outro.
 *
 * O runner é o node:test nativo; src importa com sufixo ".js" (NodeNext) e o
 * type stripping do Node não remapeia ".js" → ".ts" — daí os hooks do tsx e os
 * imports dinâmicos, como nas outras suítes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { register } from "tsx/esm/api";
import type { Sound } from "@danjocord/protocol";

register();

// o config lê process.env no import — ajustar ANTES de importar src
process.env.DANJOCORD_DEV_AUTH = "1";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { idFromString } = await import("../src/db/snowflake.js");
const { Store } = await import("../src/store.js");
const { Gateway } = await import("../src/gateway.js");
const { registerSoundRoutes } = await import("../src/sounds/routes.js");
const { seedSounds } = await import("../src/sounds/seed.js");
const { MAX_SOUNDS, MAX_SOUND_BYTES, MAX_GAIN, MIN_GAIN, UPLOAD_LIMIT } = await import("../src/sounds/limits.js");

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "soundboard");

const db = openDb(":memory:");
const store = new Store(db);
const gateway = new Gateway(store);
const app = Fastify();

/** Canal de voz que o SERVIDOR enxerga para cada usuário — o teste controla. */
const emVoz = new Map<string, string>();
registerSoundRoutes(app, store, gateway, { voiceChannelOf: (userId) => emVoz.get(userId) ?? null });

// Espião do fan-out (mesmo padrão do messages.test.ts): os testes afirmam O QUE
// seria broadcastado; a entrega em sockets é papel do smoke.
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

/** Bearer dev.<nome> — devAuth ligado acima cria o usuário no primeiro uso. */
function auth(username: string): Record<string, string> {
  return { authorization: `Bearer dev.${username}` };
}

function makeWav(ms: number, { rate = 44_100, bits = 16 } = {}): Buffer {
  const byteRate = (rate * bits) / 8; // mono
  const dataLen = Math.round((byteRate * ms) / 1000);
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "latin1");
  buf.write("fmt ", 12, "latin1");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(bits / 8, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36, "latin1");
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

interface UploadOptions {
  name?: string;
  gain?: string;
  contentType?: string;
  payload?: Buffer;
}

async function upload(username: string, opts: UploadOptions = {}) {
  const query = new URLSearchParams();
  if (opts.name !== undefined) query.set("name", opts.name);
  if (opts.gain !== undefined) query.set("gain", opts.gain);
  return app.inject({
    method: "POST",
    url: `/api/sounds?${query.toString()}`,
    headers: { ...auth(username), "content-type": opts.contentType ?? "application/octet-stream" },
    payload: opts.payload ?? makeWav(500),
  });
}

/** Sobe um som e devolve o registro (falha o teste se o upload não passar). */
async function uploadOk(username: string, name: string, opts: UploadOptions = {}): Promise<Sound> {
  const res = await upload(username, { name, ...opts });
  assert.equal(res.statusCode, 201, `setup: upload de "${name}" deveria dar 201, deu ${res.statusCode}`);
  return res.json() as Sound;
}

// ---------------------------------------------------------------------------
// Seed dos embutidos
// ---------------------------------------------------------------------------

test("seed: os 9 embutidos entram no banco no primeiro boot, e só nele", () => {
  const inseridos = seedSounds(store);
  assert.equal(inseridos, 9, "os 9 .ogg de assets/soundboard deveriam ser semeados");
  const catalogo = store.listSounds();
  assert.equal(catalogo.length, 9);
  for (const som of catalogo) {
    assert.equal(som.uploader_id, null, "embutido não tem dono");
    assert.equal(som.mime, "audio/ogg");
    assert.ok(som.duration_ms > 0 && som.duration_ms < 5000, `${som.name}: duração medida no boot`);
    assert.ok(som.gain > 0 && som.gain <= 1, `${som.name}: ganho do M8 preservado`);
  }
  assert.deepEqual(catalogo[0]?.name, "Fanfarra", "a ordem do seed é a ordem da listagem");

  // idempotência pelo VAZIO, não por nome: rodar de novo com a tabela cheia não
  // duplica (nem ressuscita um embutido que o dono apagou de propósito)
  assert.equal(seedSounds(store), 0);
  assert.equal(store.listSounds().length, 9);
});

test("GET /api/sounds exige auth e devolve metadados (nunca os bytes)", async () => {
  const semAuth = await app.inject({ method: "GET", url: "/api/sounds" });
  assert.equal(semAuth.statusCode, 401);

  const res = await app.inject({ method: "GET", url: "/api/sounds", headers: auth("alice") });
  assert.equal(res.statusCode, 200);
  const lista = res.json() as Sound[];
  assert.equal(lista.length, 9);
  for (const som of lista) {
    assert.ok(!("bytes" in som), "o BLOB não pode viajar na listagem (100 sons × 512 KB)");
    assert.equal(typeof som.id, "string", "id é string no fio (snowflake não cabe em number)");
  }
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

test("POST /api/sounds grava o binário cru, MEDE a duração e broadcasta SOUND_CREATE", async () => {
  reset();
  const som = await uploadOk("uploader1", "Buzinaço", { gain: "0.7" });
  assert.equal(som.name, "Buzinaço");
  assert.equal(som.mime, "audio/wav", "mime vem do CONTAINER, não do Content-Type do request");
  assert.equal(som.duration_ms, 500, "duração medida pelo servidor");
  assert.equal(som.gain, 0.7);
  assert.equal(som.size_bytes, makeWav(500).length);
  const dono = store.listMembers().find((m) => m.username === "uploader1");
  assert.equal(som.uploader_id, dono?.id, "o dono é quem subiu, não o que o payload disser");

  const criados = findAll<Sound>("SOUND_CREATE");
  assert.equal(criados.length, 1, "um upload = um SOUND_CREATE");
  assert.deepEqual(criados[0], som, "o evento carrega o registro inteiro (o cliente não precisa refazer GET)");
});

test("upload aceita o mime do arquivo como Content-Type (o navegador manda file.type)", async () => {
  const som = await uploadOk("uploader2", "Com mime", { contentType: "audio/wav" });
  assert.equal(som.mime, "audio/wav");
  // e o CONTEÚDO é que manda: ogg enviado como audio/wav vira audio/ogg
  const ogg = readFileSync(join(assetsDir, "ping.ogg"));
  const mentiroso = await uploadOk("uploader2", "Mentiroso", { contentType: "audio/wav", payload: ogg });
  assert.equal(mentiroso.mime, "audio/ogg", "o Content-Type do request nunca decide nada");
});

test("upload de .png renomeado para .ogg → 400 (magic bytes, não extensão)", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096, 7)]);
  const res = await upload("uploader3", { name: "Foto", contentType: "audio/ogg", payload: png });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /formato não reconhecido/);
});

test("upload acima de 5 s → 400 com a duração medida na mensagem", async () => {
  const res = await upload("uploader4", { name: "Musicona", payload: makeWav(6000, { rate: 8000, bits: 8 }) });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /6\.0 s.*teto é 5 s/);
});

test("upload acima de 512 KB é cortado ANTES de virar Buffer na memória (413)", async () => {
  // 512 KB + folga; o bodyLimit do parser aborta o stream
  const gigante = makeWav(7000);
  assert.ok(gigante.length > MAX_SOUND_BYTES, "sanidade: o WAV de 4 s passa de 512 KB");
  const res = await upload("uploader5", { name: "Gigante", payload: gigante });
  assert.equal(res.statusCode, 413);
});

test("upload com corpo vazio → 400 (nada de som de 0 byte na tabela)", async () => {
  const res = await upload("uploader6", { name: "Vazio", payload: Buffer.alloc(0) });
  assert.equal(res.statusCode, 400);
});

test("nome inválido → 400 (vazio, só espaço, > 32 e com caractere de controle)", async () => {
  // tentativa recusada TAMBÉM consome cota de upload (de propósito: mandar lixo
  // repetido não pode ser de graça) — por isso um usuário por caso
  const quebraLinha = "quebra" + String.fromCharCode(10) + "linha";
  const invalidos = ["", "   ", "x".repeat(33), quebraLinha, String.fromCharCode(7) + "sino"];
  for (const [i, name] of invalidos.entries()) {
    const res = await upload(`nomeruim${i}`, { name });
    assert.equal(res.statusCode, 400, `nome ${JSON.stringify(name)} deveria ser recusado`);
  }
  // sem name nenhum também
  const semNome = await app.inject({
    method: "POST",
    url: "/api/sounds",
    headers: { ...auth("semnome"), "content-type": "application/octet-stream" },
    payload: makeWav(200),
  });
  assert.equal(semNome.statusCode, 400);
  // e o nome é APARADO antes de gravar
  const aparado = await uploadOk("uploader7", "  Espaçoso  ");
  assert.equal(aparado.name, "Espaçoso");
});

test("gain do cliente é CLAMPADO (sugestão, não ordem)", async () => {
  const alto = await uploadOk("uploader8", "Estouro", { gain: "50" });
  assert.equal(alto.gain, MAX_GAIN, "gain 50 viraria grito na guild inteira");
  const zero = await uploadOk("uploader8", "Mudo", { gain: "0" });
  assert.equal(zero.gain, MIN_GAIN);
  const lixo = await upload("uploader8", { name: "Lixo", gain: "muito alto" });
  assert.equal(lixo.statusCode, 400, "ganho não numérico é payload inválido");
  const ausente = await uploadOk("uploader8", "Sem ganho");
  assert.equal(ausente.gain, 1, "sem ganho declarado = 1.0");
});

test("rate limit de upload: o arquivo seguinte ao teto, no mesmo minuto → 429 com retry_after", async () => {
  // O teto sai da CONSTANTE, não de um número repetido aqui: quando ele mudou
  // de 5 para 12 na integração do M9, um literal quebrou este teste sem que
  // nada estivesse errado no servidor.
  // usuário só deste teste: as janelas são por chave
  for (let i = 0; i < UPLOAD_LIMIT; i++) {
    await uploadOk("spammer", `Som ${i}`);
  }
  const res = await upload("spammer", { name: "Um além do teto" });
  assert.equal(res.statusCode, 429);
  const body = res.json() as { retry_after: number };
  assert.ok(body.retry_after > 0, "429 diz quando tentar de novo");
  assert.ok(Number(res.headers["retry-after"]) >= 1, "e também no header, para quem só olha protocolo");
});

test("teto de 100 sons da guild → 409, checado antes de ler o corpo", async () => {
  const antes = store.listSounds();
  const enchendo = MAX_SOUNDS - antes.length;
  const bytes = makeWav(100);
  for (let i = 0; i < enchendo; i++) {
    store.createSound({ name: `Enchendo ${i}`, uploaderId: null, mime: "audio/wav", bytes, durationMs: 100, gain: 1 });
  }
  assert.equal(store.countSounds(), MAX_SOUNDS);

  const res = await upload("uploader9", { name: "Um a mais" });
  assert.equal(res.statusCode, 409);
  assert.match((res.json() as { error: string }).error, /100 sons/);

  // limpa o enchimento (os testes seguintes contam o catálogo)
  for (const som of store.listSounds()) {
    if (som.name.startsWith("Enchendo ")) store.deleteSound(som.id);
  }
  assert.equal(store.countSounds(), antes.length);
});

// ---------------------------------------------------------------------------
// Bytes: GET /api/sounds/:id/audio
// ---------------------------------------------------------------------------

test("GET de áudio devolve os bytes com o mime GUARDADO e cache imutável", async () => {
  const wav = makeWav(300);
  const som = await uploadOk("donoaudio", "Audível", { payload: wav });

  const res = await app.inject({ method: "GET", url: `/api/sounds/${som.id}/audio`, headers: auth("alice") });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "audio/wav", "content-type do BANCO, jamais do request");
  assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(res.headers["x-content-type-options"], "nosniff", "sem nosniff, um mime esquisito viraria sniffing");
  assert.deepEqual(res.rawPayload, wav, "os bytes voltam intactos");

  // id inexistente e id não-numérico → 404 (nada de BigInt() explodindo em 500)
  const fantasma = await app.inject({
    method: "GET",
    url: "/api/sounds/4611686018427387904/audio",
    headers: auth("alice"),
  });
  assert.equal(fantasma.statusCode, 404);
  const lixo = await app.inject({ method: "GET", url: "/api/sounds/abc/audio", headers: auth("alice") });
  assert.equal(lixo.statusCode, 404);
  const semAuth = await app.inject({ method: "GET", url: `/api/sounds/${som.id}/audio` });
  assert.equal(semAuth.statusCode, 401);
});

// ---------------------------------------------------------------------------
// Permissões de renomear e apagar
// ---------------------------------------------------------------------------

test("PATCH: autor renomeia; terceiro não; admin sim — com SOUND_UPDATE no fio", async () => {
  const som = await uploadOk("dono1", "Nome velho");

  const terceiro = await app.inject({
    method: "PATCH",
    url: `/api/sounds/${som.id}`,
    headers: auth("intruso"),
    payload: { name: "Invasão" },
  });
  assert.equal(terceiro.statusCode, 403);
  assert.equal(store.getSound(som.id)?.name, "Nome velho", "o 403 não pode ter renomeado nada");

  reset();
  const autor = await app.inject({
    method: "PATCH",
    url: `/api/sounds/${som.id}`,
    headers: auth("dono1"),
    payload: { name: "Nome novo" },
  });
  assert.equal(autor.statusCode, 200);
  assert.equal((autor.json() as Sound).name, "Nome novo");
  assert.deepEqual(findAll<Sound>("SOUND_UPDATE").at(-1), autor.json(), "SOUND_UPDATE carrega o registro atualizado");

  // admin (is_admin por SQL direto, como o dono faria no pod — migration 002)
  const root = store.findOrCreateDevUser("root");
  db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").run(idFromString(root.id));
  const admin = await app.inject({
    method: "PATCH",
    url: `/api/sounds/${som.id}`,
    headers: auth("root"),
    payload: { name: "Moderado" },
  });
  assert.equal(admin.statusCode, 200, "admin mexe em som alheio (mesma regra do DELETE de mensagem do M2)");

  // corpo inválido e som inexistente
  const ruim = await app.inject({
    method: "PATCH",
    url: `/api/sounds/${som.id}`,
    headers: auth("root"),
    payload: { name: "" },
  });
  assert.equal(ruim.statusCode, 400);
  const fantasma = await app.inject({
    method: "PATCH",
    url: "/api/sounds/4611686018427387904",
    headers: auth("root"),
    payload: { name: "x" },
  });
  assert.equal(fantasma.statusCode, 404);
});

test("DELETE: autor apaga o seu; terceiro 403; admin apaga qualquer um (SOUND_DELETE)", async () => {
  const meu = await uploadOk("dono2", "Meu som");

  const terceiro = await app.inject({ method: "DELETE", url: `/api/sounds/${meu.id}`, headers: auth("intruso") });
  assert.equal(terceiro.statusCode, 403);
  assert.ok(store.getSound(meu.id), "o 403 não pode ter apagado");

  reset();
  const autor = await app.inject({ method: "DELETE", url: `/api/sounds/${meu.id}`, headers: auth("dono2") });
  assert.equal(autor.statusCode, 204);
  assert.equal(store.getSound(meu.id), null, "delete é de verdade: o BLOB sai do PVC");
  assert.deepEqual(findAll<{ id: string }>("SOUND_DELETE"), [{ id: meu.id }]);

  // apagar duas vezes → 404 na segunda
  const denovo = await app.inject({ method: "DELETE", url: `/api/sounds/${meu.id}`, headers: auth("dono2") });
  assert.equal(denovo.statusCode, 404);

  // som de terceiro: só admin
  const alheio = await uploadOk("dono3", "De outro");
  const admin = await app.inject({ method: "DELETE", url: `/api/sounds/${alheio.id}`, headers: auth("root") });
  assert.equal(admin.statusCode, 204);
});

test("som EMBUTIDO (sem dono) só o admin apaga/renomeia", async () => {
  const embutido = store.listSounds().find((s) => s.uploader_id === null);
  assert.ok(embutido, "sanidade: os embutidos do seed continuam lá");

  const qualquerUm = await app.inject({
    method: "DELETE",
    url: `/api/sounds/${embutido.id}`,
    headers: auth("curioso"),
  });
  assert.equal(qualquerUm.statusCode, 403, "uploader_id null não faz de todo mundo dono");

  const admin = await app.inject({
    method: "PATCH",
    url: `/api/sounds/${embutido.id}`,
    headers: auth("root"),
    payload: { name: "Fanfarrão" },
  });
  assert.equal(admin.statusCode, 200);
});

// ---------------------------------------------------------------------------
// Tocar
// ---------------------------------------------------------------------------

test("POST /api/voice/soundboard fora da voz → 403 (sem isso qualquer sessão faz barulho)", async () => {
  const som = store.listSounds()[0];
  assert.ok(som);
  const forinha = store.findOrCreateDevUser("forinha");
  emVoz.delete(forinha.id);

  reset();
  const res = await app.inject({
    method: "POST",
    url: "/api/voice/soundboard",
    headers: auth("forinha"),
    payload: { sound_id: som.id },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(events.length, 0, "403 não pode ter broadcastado nada");
});

test("tocar em voz → 204 e VOICE_SOUNDBOARD com o canal que o SERVIDOR vê", async () => {
  const som = store.listSounds()[0];
  assert.ok(som);
  const tocador = store.findOrCreateDevUser("tocador");
  emVoz.set(tocador.id, "2");

  reset();
  const res = await app.inject({
    method: "POST",
    url: "/api/voice/soundboard",
    headers: auth("tocador"),
    payload: { sound_id: som.id },
  });
  assert.equal(res.statusCode, 204);
  assert.deepEqual(findAll("VOICE_SOUNDBOARD"), [{ user_id: tocador.id, channel_id: "2", sound_id: som.id }]);

  // som inexistente → 404; corpo fora do schema → 400
  const fantasma = await app.inject({
    method: "POST",
    url: "/api/voice/soundboard",
    headers: auth("tocador"),
    payload: { sound_id: "4611686018427387904" },
  });
  assert.equal(fantasma.statusCode, 404);
  const ruim = await app.inject({
    method: "POST",
    url: "/api/voice/soundboard",
    headers: auth("tocador"),
    payload: { som: som.id },
  });
  assert.equal(ruim.statusCode, 400);
});

test("cooldown POR USUÁRIO: dois sons colados → 429 com retry_after", async () => {
  const som = store.listSounds()[0];
  assert.ok(som);
  const apressado = store.findOrCreateDevUser("apressado");
  emVoz.set(apressado.id, "2");

  const primeiro = await app.inject({
    method: "POST",
    url: "/api/voice/soundboard",
    headers: auth("apressado"),
    payload: { sound_id: som.id },
  });
  assert.equal(primeiro.statusCode, 204);

  reset();
  const segundo = await app.inject({
    method: "POST",
    url: "/api/voice/soundboard",
    headers: auth("apressado"),
    payload: { sound_id: som.id },
  });
  assert.equal(segundo.statusCode, 429);
  const body = segundo.json() as { retry_after: number };
  assert.ok(body.retry_after > 0 && body.retry_after <= 2, `retry_after fora do cooldown: ${body.retry_after}`);
  assert.equal(events.length, 0, "o 429 não broadcasta som nenhum");
});

test("teto POR CANAL: 5 pessoas tocam, a 6ª leva 429 mesmo sem cooldown próprio", async () => {
  const som = store.listSounds()[0];
  assert.ok(som);
  // canal exclusivo deste teste (a janela é por chave, como a de usuário)
  const canal = "77";
  const nomes = ["banda1", "banda2", "banda3", "banda4", "banda5"];
  for (const nome of nomes) {
    const u = store.findOrCreateDevUser(nome);
    emVoz.set(u.id, canal);
    const res = await app.inject({
      method: "POST",
      url: "/api/voice/soundboard",
      headers: auth(nome),
      payload: { sound_id: som.id },
    });
    assert.equal(res.statusCode, 204, `${nome} deveria conseguir tocar`);
  }

  const sexto = store.findOrCreateDevUser("banda6");
  emVoz.set(sexto.id, canal);
  const res = await app.inject({
    method: "POST",
    url: "/api/voice/soundboard",
    headers: auth("banda6"),
    payload: { sound_id: som.id },
  });
  assert.equal(res.statusCode, 429, "o canal encheu, ainda que este usuário nunca tenha tocado");
  assert.ok((res.json() as { retry_after: number }).retry_after > 0);

  // e o teto é POR CANAL: em outro canal o mesmo usuário toca na hora
  emVoz.set(sexto.id, "88");
  const outro = await app.inject({
    method: "POST",
    url: "/api/voice/soundboard",
    headers: auth("banda6"),
    payload: { sound_id: som.id },
  });
  assert.equal(outro.statusCode, 204);
});
