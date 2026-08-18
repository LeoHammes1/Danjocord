/**
 * Testes do M3+M4 (voz e vídeo, doc §3.6/§3.4): a superfície de sinalização
 * do mediasoup no servidor funciona SEM cliente WebRTC real. O truque:
 * produce aceita rtpParameters mínimos forjados — opus para o áudio; VP8
 * simulcast com 3 ssrcs distintos para a webcam do M4 (o ortc do mediasoup
 * valida a ESTRUTURA, não o fluxo — nenhum pacote RTP existe aqui) e consume usa as
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
  /** câmera ligada (M4) — derivado no servidor: existe producer de vídeo vivo */
  self_video: boolean;
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
  /** "audio" | "video" (M4) — o cliente decide como consumir por aqui */
  kind: string;
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

let videoSsrcSeq = 0;
/**
 * rtpParameters de VP8 SIMULCAST forjados (M4, doc §3.4): 3 encodings com
 * ssrcs distintos = 3 camadas espaciais aos olhos do mediasoup — o consumer
 * nasce type "simulcast" e aceita setPreferredLayers. Como no áudio, o ortc
 * valida a ESTRUTURA; nenhum pacote RTP flui. O mid é único por chamada:
 * mic e webcam dividem o MESMO send transport (contrato M4) e o RtpListener
 * do worker rejeita mid repetido no transport.
 */
function vp8SimulcastRtpParameters(): unknown {
  videoSsrcSeq += 1;
  const base = 33_330_000 + videoSsrcSeq * 10;
  return {
    mid: `v${videoSsrcSeq}`,
    codecs: [{ mimeType: "video/VP8", payloadType: 101, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
    headerExtensions: [],
    encodings: [{ ssrc: base + 1 }, { ssrc: base + 2 }, { ssrc: base + 3 }],
    rtcp: { cname: `teste-video-${videoSsrcSeq}` },
  };
}

async function produceVideo(ctx: Ctx, transportId: string): Promise<{ producer_id: string }> {
  return (await voice.handleRequest(ctx, "produce", {
    transport_id: transportId,
    kind: "video",
    rtp_parameters: vp8SimulcastRtpParameters(),
  })) as { producer_id: string };
}

/**
 * Acesso runtime a internos privados do Voice (private do TS é só
 * compile-time): o espião de observer.addProducer e a leitura de
 * consumer.paused não têm superfície pública — e criar uma só para teste
 * seria pior que este cast localizado.
 */
interface VoiceInternals {
  rooms: Map<string, { observer: { addProducer(o: { producerId: string }): Promise<void> } }>;
  sessions: Map<string, { consumers: Map<string, { paused: boolean }> }>;
}
const internals = voice as unknown as VoiceInternals;

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
      "opus 48000/2 segue no router (áudio do M3)",
    );
    assert.ok(
      caps.codecs.some((c) => /vp8/i.test(String(c.mimeType))),
      "VP8 90000 entrou nos mediaCodecs (webcam do M4)",
    );

    const updates = findAll<VoiceStateWire>("VOICE_STATE_UPDATE");
    assert.deepEqual(updates.at(-1), {
      user_id: alice.id,
      channel_id: "2",
      self_mute: false,
      self_deaf: false,
      self_video: false,
    });
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
    assert.deepEqual(news[0], { channel_id: "2", user_id: alice.id, producer_id: p.producer_id, kind: "audio" });
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
    assert.deepEqual(updates.at(-1), {
      user_id: carol.id,
      channel_id: "2",
      self_mute: true,
      self_deaf: false,
      self_video: false,
    });

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

// ---------------------------------------------------------------------------
// M4: vídeo (webcam VP8 simulcast, doc §3.4) — produce/consume de vídeo,
// close_producer, pause_consumer e set_preferred_layers.
// ---------------------------------------------------------------------------

test("produce de vídeo no MESMO send transport → VOICE_NEW_PRODUCER kind video e self_video true", async () => {
  const ctx: Ctx = { userId: alice.id, sessionId: "s-video" };
  try {
    await join(ctx, "2");
    const t = await createTransport(ctx, "send");
    // mic e webcam dividem o mesmo transport send (contrato M4)
    const audio = await produce(ctx, t.transport_id);
    reset();
    const video = await produceVideo(ctx, t.transport_id);
    assert.equal(typeof video.producer_id, "string");
    assert.notEqual(video.producer_id, audio.producer_id);
    await settle();
    const news = findAll<NewProducerWire>("VOICE_NEW_PRODUCER");
    assert.equal(news.length, 1, "um produce = um VOICE_NEW_PRODUCER");
    assert.deepEqual(news[0], { channel_id: "2", user_id: alice.id, producer_id: video.producer_id, kind: "video" });

    const mine = voice.voiceStates().find((s) => s.user_id === alice.id);
    assert.equal(mine?.self_video, true, "câmera ligada → self_video true no snapshot");
    assert.equal(mine?.channel_id, "2");
  } finally {
    await leaveQuietly(ctx);
  }
});

test("SEGUNDO produce de vídeo na mesma sessão → rejeita (1 webcam por sessão no M4)", async () => {
  const ctx: Ctx = { userId: alice.id, sessionId: "s-video-teto" };
  try {
    await join(ctx, "2");
    const t = await createTransport(ctx, "send");
    await produceVideo(ctx, t.transport_id);
    // o forjador gera ssrcs/mid novos a cada chamada: a rejeição aqui é o teto
    // de 1 vídeo, não colisão de ssrc no transport
    await assert.rejects(() => produceVideo(ctx, t.transport_id));
    // o teto é DE VÍDEO: áudio na mesma sessão continua passando
    const audio = await produce(ctx, t.transport_id);
    assert.equal(typeof audio.producer_id, "string", "o teto de vídeo não pode barrar o áudio");
  } finally {
    await leaveQuietly(ctx);
  }
});

test("produce de vídeo NÃO entra no audioLevelObserver (só áudio alimenta o speaking)", async () => {
  const ctx: Ctx = { userId: alice.id, sessionId: "s-observer" };
  try {
    await join(ctx, "2");
    // espião no observer da sala: registra os producerIds e delega ao real.
    // (Indiretamente o próprio produce já cobriria — addProducer de vídeo num
    // AudioLevelObserver REAL lança no worker e derrubaria o produce — mas o
    // espião torna a afirmação direta.) A sala fecha no leave e leva o espião.
    const room = internals.rooms.get("2");
    assert.ok(room, "sala do canal 2 deveria existir após o join");
    const added: string[] = [];
    const orig = room.observer.addProducer.bind(room.observer);
    room.observer.addProducer = (o) => {
      added.push(o.producerId);
      return orig(o);
    };

    const t = await createTransport(ctx, "send");
    const audio = await produce(ctx, t.transport_id);
    const video = await produceVideo(ctx, t.transport_id);
    assert.ok(added.includes(audio.producer_id), "áudio continua entrando no observer");
    assert.ok(!added.includes(video.producer_id), "vídeo no audioLevelObserver é bug (guard por kind)");
  } finally {
    await leaveQuietly(ctx);
  }
});

test("consume de vídeo por outro usuário devolve rtp_parameters de VP8", async () => {
  const a: Ctx = { userId: alice.id, sessionId: "s-vcons-a" };
  const b: Ctx = { userId: bob.id, sessionId: "s-vcons-b" };
  try {
    await join(a, "2");
    const ta = await createTransport(a, "send");
    const prod = await produceVideo(a, ta.transport_id);

    const joinB = await join(b, "2");
    const tb = await createTransport(b, "recv");
    const c = (await voice.handleRequest(b, "consume", {
      transport_id: tb.transport_id,
      producer_id: prod.producer_id,
      rtp_capabilities: joinB.rtp_capabilities,
    })) as ConsumerWire;
    assert.equal(typeof c.consumer_id, "string");
    assert.equal(c.producer_id, prod.producer_id);
    assert.equal(c.kind, "video");
    const rtp = c.rtp_parameters as { codecs?: { mimeType?: string }[] };
    assert.ok(Array.isArray(rtp?.codecs) && rtp.codecs.length > 0, "rtp_parameters prontos para o transport.consume");
    assert.ok(
      rtp.codecs.some((x) => /vp8/i.test(String(x.mimeType))),
      "o codec negociado do consumer é VP8",
    );
  } finally {
    await leaveQuietly(a);
    await leaveQuietly(b);
  }
});

test("set_preferred_layers: vídeo ok nas 3 camadas; áudio, alheio ou fora do range → rejeita", async () => {
  const a: Ctx = { userId: alice.id, sessionId: "s-camada-a" };
  const b: Ctx = { userId: bob.id, sessionId: "s-camada-b" };
  try {
    await join(a, "2");
    const ta = await createTransport(a, "send");
    const audioProd = await produce(a, ta.transport_id);
    const videoProd = await produceVideo(a, ta.transport_id);

    const joinB = await join(b, "2");
    const tb = await createTransport(b, "recv");
    const vc = (await voice.handleRequest(b, "consume", {
      transport_id: tb.transport_id,
      producer_id: videoProd.producer_id,
      rtp_capabilities: joinB.rtp_capabilities,
    })) as ConsumerWire;
    const ac = (await voice.handleRequest(b, "consume", {
      transport_id: tb.transport_id,
      producer_id: audioProd.producer_id,
      rtp_capabilities: joinB.rtp_capabilities,
    })) as ConsumerWire;

    // as 3 camadas do simulcast (doc §3.4: 150k/500k/1,5M) são selecionáveis
    for (const spatial of [0, 1, 2]) {
      const r = await voice.handleRequest(b, "set_preferred_layers", {
        consumer_id: vc.consumer_id,
        spatial_layer: spatial,
      });
      assert.deepEqual(r ?? {}, {}, `camada espacial ${spatial} deveria ser aceita`);
    }
    // consumer de ÁUDIO não tem camadas → erro claro, não sucesso silencioso
    await assert.rejects(() =>
      voice.handleRequest(b, "set_preferred_layers", { consumer_id: ac.consumer_id, spatial_layer: 1 }),
    );
    // consumer alheio: lookup no mapa DA SESSÃO — o A não enxerga o consumer do B
    await assert.rejects(() =>
      voice.handleRequest(a, "set_preferred_layers", { consumer_id: vc.consumer_id, spatial_layer: 1 }),
    );
    // Zod na entrada: fora do range 0–2 do M4 nem chega ao mediasoup
    await assert.rejects(() =>
      voice.handleRequest(b, "set_preferred_layers", { consumer_id: vc.consumer_id, spatial_layer: 3 }),
    );
  } finally {
    await leaveQuietly(a);
    await leaveQuietly(b);
  }
});

test("pause_consumer pausa e resume_consumer reativa (vídeo fora de tela, doc §8)", async () => {
  const a: Ctx = { userId: alice.id, sessionId: "s-pausa-a" };
  const b: Ctx = { userId: bob.id, sessionId: "s-pausa-b" };
  try {
    await join(a, "2");
    const ta = await createTransport(a, "send");
    const prod = await produceVideo(a, ta.transport_id);

    const joinB = await join(b, "2");
    const tb = await createTransport(b, "recv");
    const c = (await voice.handleRequest(b, "consume", {
      transport_id: tb.transport_id,
      producer_id: prod.producer_id,
      rtp_capabilities: joinB.rtp_capabilities,
    })) as ConsumerWire;

    const consumer = internals.sessions.get(b.sessionId)?.consumers.get(c.consumer_id);
    assert.ok(consumer, "consumer deveria estar no mapa da sessão do B");
    assert.equal(consumer.paused, true, "consumer nasce pausado (best practice mediasoup)");

    const r1 = await voice.handleRequest(b, "resume_consumer", { consumer_id: c.consumer_id });
    assert.deepEqual(r1 ?? {}, {});
    assert.equal(consumer.paused, false, "resume_consumer reativa");

    const r2 = await voice.handleRequest(b, "pause_consumer", { consumer_id: c.consumer_id });
    assert.deepEqual(r2 ?? {}, {}, "pause_consumer responde payload vazio");
    assert.equal(consumer.paused, true, "tile fora de tela → consumer pausado (economia real)");

    await voice.handleRequest(b, "resume_consumer", { consumer_id: c.consumer_id });
    assert.equal(consumer.paused, false, "o ciclo pausa→retoma é reversível");

    // consumer alheio: o A não pode pausar o consumer do B
    await assert.rejects(() => voice.handleRequest(a, "pause_consumer", { consumer_id: c.consumer_id }));
  } finally {
    await leaveQuietly(a);
    await leaveQuietly(b);
  }
});

test("close_producer desliga a câmera SEM sair da voz (broadcasts + estoque do join)", async () => {
  const a: Ctx = { userId: alice.id, sessionId: "s-cam-a" };
  const c: Ctx = { userId: carol.id, sessionId: "s-cam-c" };
  try {
    await join(a, "2");
    const t = await createTransport(a, "send");
    const audioProd = await produce(a, t.transport_id);
    const videoProd = await produceVideo(a, t.transport_id);
    assert.equal(voice.voiceStates().find((s) => s.user_id === alice.id)?.self_video, true, "sanidade: câmera ligada");

    reset();
    const r = await voice.handleRequest(a, "close_producer", { producer_id: videoProd.producer_id });
    assert.deepEqual(r ?? {}, {}, "close_producer responde payload vazio");
    await settle();
    assert.ok(
      findAll<ProducerClosedWire>("VOICE_PRODUCER_CLOSED").some(
        (e) => e.producer_id === videoProd.producer_id && e.channel_id === "2",
      ),
      "desligar a câmera broadcasta VOICE_PRODUCER_CLOSED",
    );
    const last = findAll<VoiceStateWire>("VOICE_STATE_UPDATE").at(-1);
    assert.ok(last, "close de kind video broadcasta VOICE_STATE_UPDATE");
    assert.equal(last.user_id, alice.id);
    assert.equal(last.channel_id, "2", "a câmera desligou mas o usuário CONTINUA em voz");
    assert.equal(last.self_video, false, "self_video volta a false");

    const mine = voice.voiceStates().find((s) => s.user_id === alice.id);
    assert.equal(mine?.channel_id, "2");
    assert.equal(mine?.self_video, false);

    // um terceiro entra depois: o estoque do join não pode oferecer o
    // producer fechado (consumi-lo daria erro no cliente)
    const joined = (await voice.handleRequest(c, "join", { channel_id: "2" })) as {
      producers?: { producer_id: string; kind?: string }[];
    };
    const stock = joined.producers ?? [];
    assert.ok(!stock.some((p) => p.producer_id === videoProd.producer_id), "o vídeo fechado some do estoque");
    assert.ok(
      stock.some((p) => p.producer_id === audioProd.producer_id && p.kind === "audio"),
      "o áudio segue no estoque, com kind (o cliente decide como consumir por ele)",
    );
  } finally {
    await leaveQuietly(a);
    await leaveQuietly(c);
  }
});

test("close_producer de producer ALHEIO → rejeita (e a câmera do dono segue ligada)", async () => {
  const a: Ctx = { userId: alice.id, sessionId: "s-alheio-a" };
  const b: Ctx = { userId: bob.id, sessionId: "s-alheio-b" };
  try {
    await join(a, "2");
    const t = await createTransport(a, "send");
    const videoProd = await produceVideo(a, t.transport_id);
    await join(b, "2");
    // lookup no mapa DA SESSÃO: producer do A não existe para o B
    await assert.rejects(() => voice.handleRequest(b, "close_producer", { producer_id: videoProd.producer_id }));
    // Zod na entrada: sem producer_id nem chega ao lookup
    await assert.rejects(() => voice.handleRequest(b, "close_producer", {}));
    assert.equal(
      voice.voiceStates().find((s) => s.user_id === alice.id)?.self_video,
      true,
      "o producer do A sobreviveu à tentativa do B",
    );
  } finally {
    await leaveQuietly(a);
    await leaveQuietly(b);
  }
});

// ---------------------------------------------------------------------------
// H.264 (delta 4K da revisão M4): o único codec além do VP8 no router — e o
// comportamento com assinante que NÃO o decodifica (SFU não transcodifica)
// ---------------------------------------------------------------------------

function h264SimulcastRtpParameters(): unknown {
  videoSsrcSeq += 1;
  const base = 44_440_000 + videoSsrcSeq * 10;
  return {
    mid: `vh${videoSsrcSeq}`,
    codecs: [
      {
        mimeType: "video/H264",
        payloadType: 103,
        clockRate: 90000,
        parameters: { "packetization-mode": 1, "profile-level-id": "42e01f", "level-asymmetry-allowed": 1 },
        rtcpFeedback: [],
      },
    ],
    headerExtensions: [],
    encodings: [{ ssrc: base + 1 }, { ssrc: base + 2 }, { ssrc: base + 3 }],
    rtcp: { cname: `h264-teste-${videoSsrcSeq}` },
  };
}

/** caps de um device VP8-only (build Chromium sem codecs proprietários). */
function vp8OnlyCaps(): unknown {
  return {
    codecs: [
      {
        kind: "audio",
        mimeType: "audio/opus",
        preferredPayloadType: 100,
        clockRate: 48000,
        channels: 2,
        parameters: {},
        rtcpFeedback: [],
      },
      {
        kind: "video",
        mimeType: "video/VP8",
        preferredPayloadType: 101,
        clockRate: 90000,
        parameters: {},
        rtcpFeedback: [
          { type: "nack", parameter: "" },
          { type: "nack", parameter: "pli" },
          { type: "ccm", parameter: "fir" },
          { type: "goog-remb", parameter: "" },
        ],
      },
    ],
    headerExtensions: [],
  };
}

test("produce H264 aceito; assinante VP8-only fica CEGO para o tile mas não MUDO", async () => {
  const a = { userId: alice.id, sessionId: "s-h264-a" };
  const b = { userId: bob.id, sessionId: "s-h264-b" };
  try {
    const joinA = await join(a, "2");
    const ta = await createTransport(a, "send");
    const audio = await produce(a, ta.transport_id);
    const video = (await voice.handleRequest(a, "produce", {
      transport_id: ta.transport_id,
      kind: "video",
      rtp_parameters: h264SimulcastRtpParameters(),
    })) as { producer_id: string };
    assert.equal(typeof video.producer_id, "string", "o router aceita produce H264 simulcast");

    await join(b, "2");
    const tb = await createTransport(b, "recv");

    // vídeo H264 para quem só decodifica VP8 → canConsume false → erro (o
    // cliente mostra warn; comportamento documentado — SFU não transcodifica)
    await assert.rejects(
      () =>
        voice.handleRequest(b, "consume", {
          transport_id: tb.transport_id,
          producer_id: video.producer_id,
          rtp_capabilities: vp8OnlyCaps(),
        }),
      /incompat/i,
      "canConsume deveria recusar H264 para caps VP8-only",
    );

    // o ÁUDIO do mesmo produtor continua consumível — cego, não mudo
    const ac = (await voice.handleRequest(b, "consume", {
      transport_id: tb.transport_id,
      producer_id: audio.producer_id,
      rtp_capabilities: vp8OnlyCaps(),
    })) as { kind: string };
    assert.equal(ac.kind, "audio", "áudio do produtor H264 segue consumível por VP8-only");

    // caps completas do router consomem o H264 normalmente
    const full = (await voice.handleRequest(b, "consume", {
      transport_id: tb.transport_id,
      producer_id: video.producer_id,
      rtp_capabilities: joinA.rtp_capabilities,
    })) as { kind: string; rtp_parameters: { codecs: { mimeType: string }[] } };
    assert.equal(full.kind, "video");
    assert.ok(
      full.rtp_parameters.codecs.some((c) => /h264/i.test(c.mimeType)),
      "consumer H264 sai com codec H264",
    );
  } finally {
    await leaveQuietly(a);
    await leaveQuietly(b);
  }
});
