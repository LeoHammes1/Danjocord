/**
 * Testes do M3 (voz, doc §3.6): a superfície de sinalização do mediasoup no
 * servidor funciona SEM cliente WebRTC real. O truque: produce aceita
 * rtpParameters mínimos de opus forjados (o ortc do mediasoup valida a
 * ESTRUTURA, não o fluxo — nenhum pacote RTP existe aqui) e consume usa as
 * rtpCapabilities do próprio router — que o join devolve — como se fossem as
 * do Device do cliente. Tudo entra por Voice.handleRequest, exatamente como o
 * gateway delega o op 20; os broadcasts são capturados por um espião em
 * voice.broadcast (no wiring real, é o gateway.broadcast). O worker do
 * mediasoup é REAL (binário prebuilt roda na máquina), com close() no
 * teardown para o subprocesso não segurar o event loop.
 *
 * O runner é o node:test nativo ("pnpm --filter @danjocord/server test"), mas
 * o código de src importa com sufixo ".js" (convenção NodeNext do build) e o
 * type stripping do Node NÃO remapeia ".js" → ".ts". Por isso registramos os
 * hooks do tsx e importamos src dinamicamente — este arquivo em si só pode
 * usar sintaxe apagável (nada de enum/parameter properties).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { register } from "tsx/esm/api";

register();

// o config lê process.env no import — ajustar ANTES de importar src.
// RTC_PORT alternativa à do servidor de dev (41000); ??= respeita override
// externo. NUNCA usar a faixa 39000–40500: em Windows o WSL2/Hyper-V reserva
// essas portas UDP de forma invisível ao netstat e o bind falha com
// EADDRINUSE fantasma (ver comentário em config.rtcPort).
process.env.RTC_PORT ??= "41100";
process.env.DANJOCORD_DEV_AUTH = "1";

const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { Voice } = await import("../src/voice.js");

const db = openDb(":memory:");
const store = new Store(db);

// Segundo canal de VOZ para os testes de cross-canal (o seed da migration só
// cria 1 = texto "geral" e 2 = voz "Voz").
db.prepare("INSERT INTO channels (id, type, name, position) VALUES (3, 'voice', 'Voz 2', 2)").run();

const voice = await Voice.create(store);
// o worker é um subprocesso: sem close() a suíte terminaria e o node ficaria vivo
after(() => voice.close());

// Espião do fan-out: os testes afirmam O QUE seria broadcastado, não a
// entrega em sockets (essa é papel do smoke, com WebSockets de verdade).
const events: { t: string; d: unknown }[] = [];
voice.broadcast = (t: string, d: unknown) => {
  events.push({ t, d });
};

// ---------------------------------------------------------------------------
// Formas no fio (snake_case, ids string) e utilitários
// ---------------------------------------------------------------------------

interface Ctx {
  userId: string;
  sessionId: string;
}
interface VoiceStateWire {
  user_id: string;
  channel_id: string | null;
  self_mute: boolean;
  self_deaf: boolean;
}
interface TransportWire {
  transport_id: string;
  ice_parameters: unknown;
  ice_candidates: unknown;
  dtls_parameters: unknown;
}
interface NewProducerWire {
  channel_id: string;
  user_id: string;
  producer_id: string;
}
interface ProducerClosedWire {
  channel_id: string;
  producer_id: string;
}
interface ConsumerWire {
  consumer_id: string;
  producer_id: string;
  kind: string;
  rtp_parameters: unknown;
}

function findAll<T>(t: string): T[] {
  return events.filter((e) => e.t === t).map((e) => e.d as T);
}

/** Descarta os broadcasts acumulados — cada teste afirma só sobre os seus. */
function reset(): void {
  events.length = 0;
}

/** Broadcasts disparados por observers do mediasoup podem sair um tick depois. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Cleanup de teste: leave é idempotente por contrato, mas nem erro pode derrubar o teardown. */
async function leaveQuietly(ctx: Ctx): Promise<void> {
  try {
    await voice.handleRequest(ctx, "leave", {});
  } catch {
    // teste falhou antes do join (ou já saiu) — irrelevante para o cleanup
  }
}

const alice = store.findOrCreateDevUser("alice");
const bob = store.findOrCreateDevUser("bob");
const carol = store.findOrCreateDevUser("carol");

let ssrcSeq = 0;
/**
 * rtpParameters mínimos que o produce aceita sem cliente real: um codec
 * casando com o mediaCodec do router (opus/48000/2, payloadType dinâmico 100)
 * e um encoding com ssrc único por chamada (o mediasoup rejeita ssrc repetido
 * no mesmo transport).
 */
function opusRtpParameters(): unknown {
  ssrcSeq += 1;
  return {
    mid: "0",
    codecs: [
      { mimeType: "audio/opus", payloadType: 100, clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [] },
    ],
    headerExtensions: [],
    encodings: [{ ssrc: 22_220_000 + ssrcSeq }],
    rtcp: { cname: `teste-${ssrcSeq}` },
  };
}

// atalhos de sinalização — sempre via handleRequest, o caminho que o gateway usa
async function join(ctx: Ctx, channelId: string): Promise<{ rtp_capabilities: unknown }> {
  return (await voice.handleRequest(ctx, "join", { channel_id: channelId })) as { rtp_capabilities: unknown };
}
async function createTransport(ctx: Ctx, direction: "send" | "recv"): Promise<TransportWire> {
  return (await voice.handleRequest(ctx, "create_transport", { direction })) as TransportWire;
}
async function produce(ctx: Ctx, transportId: string): Promise<{ producer_id: string }> {
  return (await voice.handleRequest(ctx, "produce", {
    transport_id: transportId,
    kind: "audio",
    rtp_parameters: opusRtpParameters(),
  })) as { producer_id: string };
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

test("join devolve as rtp_capabilities do router (opus) e broadcasta VOICE_STATE_UPDATE", async () => {
  const ctx: Ctx = { userId: alice.id, sessionId: "s-join" };
  reset();
  try {
    const res = await join(ctx, "2");
    const caps = res.rtp_capabilities as { codecs?: { mimeType?: string }[] };
    assert.ok(Array.isArray(caps?.codecs), "rtp_capabilities do router deveriam ter codecs");
    assert.ok(
      caps.codecs.some((c) => /opus/i.test(String(c.mimeType))),
      "o único mediaCodec configurado é opus 48000/2",
    );

    const updates = findAll<VoiceStateWire>("VOICE_STATE_UPDATE");
    assert.deepEqual(updates.at(-1), { user_id: alice.id, channel_id: "2", self_mute: false, self_deaf: false });
  } finally {
    await leaveQuietly(ctx);
  }
});

test("join em canal de TEXTO, canal inexistente ou p fora do schema → rejeita", async () => {
  const ctx: Ctx = { userId: alice.id, sessionId: "s-join-ruim" };
  await assert.rejects(() => voice.handleRequest(ctx, "join", { channel_id: "1" }));
  await assert.rejects(() => voice.handleRequest(ctx, "join", { channel_id: "999" }));
  // Zod na entrada (convenção do repo): campo errado nunca chega ao mediasoup
  await assert.rejects(() => voice.handleRequest(ctx, "join", { channel: "2" }));
  assert.equal(voice.voiceStates().length, 0, "join que falhou não pode deixar estado para trás");
});

test("método desconhecido → rejeita", async () => {
  await assert.rejects(() => voice.handleRequest({ userId: alice.id, sessionId: "s-m" }, "autotune", {}));
});

test("create_transport devolve transport_id + ice/dtls, nas duas direções", async () => {
  const ctx: Ctx = { userId: alice.id, sessionId: "s-transporte" };
  try {
    await join(ctx, "2");
    for (const direction of ["send", "recv"] as const) {
      const t = await createTransport(ctx, direction);
      assert.equal(typeof t.transport_id, "string", `transport_id (${direction}) é id string no fio`);
      assert.ok(t.ice_parameters, `ice_parameters ausente (${direction})`);
      assert.ok(
        Array.isArray(t.ice_candidates) && (t.ice_candidates as unknown[]).length > 0,
        `ice_candidates deveria ser lista não-vazia (${direction})`,
      );
      assert.ok(t.dtls_parameters, `dtls_parameters ausente (${direction})`);
    }
    // direção fora do enum do schema → Zod rejeita
    await assert.rejects(() => voice.handleRequest(ctx, "create_transport", { direction: "sideways" }));
  } finally {
    await leaveQuietly(ctx);
  }
});

test("produce devolve producer_id e broadcasta VOICE_NEW_PRODUCER", async () => {
  const ctx: Ctx = { userId: alice.id, sessionId: "s-produtor" };
  try {
    await join(ctx, "2");
    const t = await createTransport(ctx, "send");
    reset();
    const p = await produce(ctx, t.transport_id);
    assert.equal(typeof p.producer_id, "string");
    await settle();
    const news = findAll<NewProducerWire>("VOICE_NEW_PRODUCER");
    assert.equal(news.length, 1, "um produce = um VOICE_NEW_PRODUCER");
    assert.deepEqual(news[0], { channel_id: "2", user_id: alice.id, producer_id: p.producer_id });
  } finally {
    await leaveQuietly(ctx);
  }
});

test("consume de producer de OUTRO usuário no MESMO canal + resume_consumer", async () => {
  const a: Ctx = { userId: alice.id, sessionId: "s-cons-a" };
  const b: Ctx = { userId: bob.id, sessionId: "s-cons-b" };
  try {
    await join(a, "2");
    const ta = await createTransport(a, "send");
    const prod = await produce(a, ta.transport_id);

    const joinB = await join(b, "2");
    const tb = await createTransport(b, "recv");
    const c = (await voice.handleRequest(b, "consume", {
      transport_id: tb.transport_id,
      producer_id: prod.producer_id,
      rtp_capabilities: joinB.rtp_capabilities, // as caps do router fazem as vezes das do Device
    })) as ConsumerWire;
    assert.equal(typeof c.consumer_id, "string");
    assert.equal(c.producer_id, prod.producer_id);
    assert.equal(c.kind, "audio");
    const rtp = c.rtp_parameters as { codecs?: unknown[] };
    assert.ok(Array.isArray(rtp?.codecs) && rtp.codecs.length > 0, "rtp_parameters prontos para o transport.consume do cliente");

    // o consumer nasce paused: true no servidor (best practice mediasoup) —
    // resume_consumer é o cliente avisando que já plugou o track no <audio>
    const r = await voice.handleRequest(b, "resume_consumer", { consumer_id: c.consumer_id });
    assert.deepEqual(r ?? {}, {}, "resume_consumer responde payload vazio");

    // caps que não cobrem opus → canConsume false → rejeita
    await assert.rejects(() =>
      voice.handleRequest(b, "consume", {
        transport_id: tb.transport_id,
        producer_id: prod.producer_id,
        rtp_capabilities: { codecs: [] },
      }),
    );
  } finally {
    await leaveQuietly(a);
    await leaveQuietly(b);
  }
});

test("consume de producer de outro CANAL → rejeita", async () => {
  const a: Ctx = { userId: alice.id, sessionId: "s-x-a" };
  const c: Ctx = { userId: carol.id, sessionId: "s-x-c" };
  try {
    await join(a, "2");
    const ta = await createTransport(a, "send");
    const prod = await produce(a, ta.transport_id);

    const joinC = await join(c, "3"); // canal de voz vizinho (inserido no setup)
    const tc = await createTransport(c, "recv");
    await assert.rejects(() =>
      voice.handleRequest(c, "consume", {
        transport_id: tc.transport_id,
        producer_id: prod.producer_id,
        rtp_capabilities: joinC.rtp_capabilities,
      }),
    );
  } finally {
    await leaveQuietly(a);
    await leaveQuietly(c);
  }
});

test("leave fecha tudo (VOICE_PRODUCER_CLOSED + VOICE_STATE_UPDATE null) e é idempotente", async () => {
  const ctx: Ctx = { userId: alice.id, sessionId: "s-leave" };
  await join(ctx, "2");
  const t = await createTransport(ctx, "send");
  const prod = await produce(ctx, t.transport_id);

  reset();
  await voice.handleRequest(ctx, "leave", {});
  await settle();
  const closed = findAll<ProducerClosedWire>("VOICE_PRODUCER_CLOSED");
  assert.deepEqual(closed, [{ channel_id: "2", producer_id: prod.producer_id }]);
  const last = findAll<VoiceStateWire>("VOICE_STATE_UPDATE").at(-1);
  assert.ok(last, "leave broadcasta VOICE_STATE_UPDATE");
  assert.equal(last.user_id, alice.id);
  assert.equal(last.channel_id, null, "leave anuncia channel_id null");
  assert.equal(voice.voiceStates().length, 0, "leave não deixa estado para trás");

  // segundo leave: inofensivo — resolve e não broadcasta nada de novo
  reset();
  await voice.handleRequest(ctx, "leave", {});
  assert.equal(events.length, 0, "leave fora da voz é no-op");
});

test("sessionGone equivale a leave (sessão saiu do mapa do gateway de vez)", async () => {
  const ctx: Ctx = { userId: bob.id, sessionId: "s-gone" };
  await join(ctx, "2");
  const t = await createTransport(ctx, "send");
  const prod = await produce(ctx, t.transport_id);

  reset();
  voice.sessionGone(ctx);
  await settle();
  assert.ok(
    findAll<ProducerClosedWire>("VOICE_PRODUCER_CLOSED").some((e) => e.producer_id === prod.producer_id),
    "sessionGone fecha os producers da sessão",
  );
  const last = findAll<VoiceStateWire>("VOICE_STATE_UPDATE").at(-1);
  assert.ok(last && last.user_id === bob.id && last.channel_id === null, "sessionGone anuncia a saída");
  assert.equal(voice.voiceStates().length, 0);

  // repetir é inofensivo, como o segundo leave
  voice.sessionGone(ctx);
});

test("join do MESMO usuário por outra sessão expulsa a primeira", async () => {
  const s1: Ctx = { userId: alice.id, sessionId: "s-dupla-1" };
  const s2: Ctx = { userId: alice.id, sessionId: "s-dupla-2" };
  try {
    await join(s1, "2");
    const t1 = await createTransport(s1, "send");
    const prod1 = await produce(s1, t1.transport_id);

    reset();
    await join(s2, "2");
    await settle();
    // o producer da sessão antiga morreu junto com ela
    assert.ok(
      findAll<ProducerClosedWire>("VOICE_PRODUCER_CLOSED").some((e) => e.producer_id === prod1.producer_id),
      "a expulsão fecha o producer da sessão antiga",
    );
    // uma entrada só para a alice, na sessão nova
    const mine = voice.voiceStates().filter((s) => s.user_id === alice.id);
    assert.deepEqual(mine.map((s) => s.channel_id), ["2"], "exatamente um voice state por usuário");
    // a sessão expulsa perdeu o direito de mexer em voz
    await assert.rejects(() => voice.handleRequest(s1, "create_transport", { direction: "send" }));
  } finally {
    await leaveQuietly(s1);
    await leaveQuietly(s2);
  }
});

test("join noutro canal pela MESMA sessão faz leave implícito do anterior", async () => {
  const ctx: Ctx = { userId: bob.id, sessionId: "s-troca" };
  try {
    await join(ctx, "2");
    const t = await createTransport(ctx, "send");
    const prod = await produce(ctx, t.transport_id);

    reset();
    await join(ctx, "3");
    await settle();
    assert.ok(
      findAll<ProducerClosedWire>("VOICE_PRODUCER_CLOSED").some((e) => e.producer_id === prod.producer_id),
      "trocar de canal fecha o producer do canal antigo",
    );
    const mine = voice.voiceStates().filter((s) => s.user_id === bob.id);
    assert.deepEqual(mine.map((s) => s.channel_id), ["3"], "só o canal novo fica no estado");
    const updates = findAll<VoiceStateWire>("VOICE_STATE_UPDATE").filter((u) => u.user_id === bob.id);
    assert.equal(updates.at(-1)?.channel_id, "3", "o último VOICE_STATE_UPDATE anuncia o canal novo");
  } finally {
    await leaveQuietly(ctx);
  }
});

test("update_state broadcasta as flags (o mute REAL é client-side, pausando o track)", async () => {
  const ctx: Ctx = { userId: carol.id, sessionId: "s-flags" };
  try {
    await join(ctx, "2");
    reset();
    const r = await voice.handleRequest(ctx, "update_state", { self_mute: true, self_deaf: false });
    assert.deepEqual(r ?? {}, {});
    const updates = findAll<VoiceStateWire>("VOICE_STATE_UPDATE");
    assert.deepEqual(updates.at(-1), { user_id: carol.id, channel_id: "2", self_mute: true, self_deaf: false });

    const mine = voice.voiceStates().find((s) => s.user_id === carol.id);
    assert.equal(mine?.self_mute, true, "voiceStates reflete o mute");
    assert.equal(mine?.self_deaf, false);

    // Zod: flag não-booleana rejeita
    await assert.rejects(() => voice.handleRequest(ctx, "update_state", { self_mute: "sim", self_deaf: false }));
  } finally {
    await leaveQuietly(ctx);
  }
});

test("voiceStates() reflete o mundo (é o snapshot que o READY carrega)", async () => {
  const a: Ctx = { userId: alice.id, sessionId: "s-mundo-a" };
  const b: Ctx = { userId: bob.id, sessionId: "s-mundo-b" };
  const c: Ctx = { userId: carol.id, sessionId: "s-mundo-c" };
  try {
    assert.equal(voice.voiceStates().length, 0, "mundo começa vazio (testes anteriores limparam)");
    await join(a, "2");
    await join(b, "2");
    await join(c, "3");

    const byUser = new Map(voice.voiceStates().map((s) => [s.user_id, s.channel_id]));
    assert.equal(byUser.size, 3);
    assert.equal(byUser.get(alice.id), "2");
    assert.equal(byUser.get(bob.id), "2");
    assert.equal(byUser.get(carol.id), "3");

    await voice.handleRequest(a, "leave", {});
    assert.equal(voice.voiceStates().length, 2);
    assert.ok(!voice.voiceStates().some((s) => s.user_id === alice.id), "quem saiu some do snapshot");
  } finally {
    await leaveQuietly(a);
    await leaveQuietly(b);
    await leaveQuietly(c);
  }
});
