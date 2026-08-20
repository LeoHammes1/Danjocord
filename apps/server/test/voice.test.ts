/**
 * Testes do M3+M4+M5 (voz, vídeo e screen share, doc §3.4–§3.6): a superfície
 * de sinalização do mediasoup no servidor funciona SEM cliente WebRTC real. O
 * truque: produce aceita rtpParameters mínimos forjados — opus para o áudio;
 * VP8 simulcast com 3 ssrcs distintos para a webcam do M4; VP8 de stream
 * ÚNICO para a tela do M5 (o ortc do mediasoup valida a ESTRUTURA, não o
 * fluxo — nenhum pacote RTP existe aqui) e consume usa as rtpCapabilities do
 * próprio router — que o join devolve — como se fossem as do Device do
 * cliente. Tudo entra por Voice.handleRequest, exatamente como o
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
  /** câmera ligada (M4) — derivado no servidor: existe producer source camera vivo */
  self_video: boolean;
  /** transmitindo tela (M5, badge AO VIVO) — derivado: existe producer source screen vivo */
  self_stream: boolean;
  /** silenciado por admin (M9) — derivado do conjunto de silenciados; NÃO é declarativo */
  server_mute: boolean;
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
  /** "mic" | "camera" | "screen" | "screen_audio" (M5) — screen vira badge, não consumo automático */
  source: string;
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
 * no mesmo transport). O mid também é único por chamada: no M5 mic e
 * screen_audio podem dividir o MESMO send transport, e o RtpListener do
 * worker rejeita mid repetido no transport.
 */
function opusRtpParameters(): unknown {
  ssrcSeq += 1;
  return {
    mid: `a${ssrcSeq}`,
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
    source: "mic", // M5: source é obrigatório — o microfone do M3 é "mic"
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
    source: "camera", // M5: a webcam do M4 é source "camera"
    rtp_parameters: vp8SimulcastRtpParameters(),
  })) as { producer_id: string };
}

/**
 * rtpParameters de VP8 de stream ÚNICO para a TELA (M5, doc §3.5): screen
 * content não paga simulcast — 1 encoding, 1 ssrc. O mid é único por chamada
 * pelo mesmo motivo dos demais forjadores (RtpListener rejeita repetição).
 */
function vp8ScreenRtpParameters(): unknown {
  videoSsrcSeq += 1;
  const base = 55_550_000 + videoSsrcSeq * 10;
  return {
    mid: `s${videoSsrcSeq}`,
    codecs: [{ mimeType: "video/VP8", payloadType: 101, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
    headerExtensions: [],
    encodings: [{ ssrc: base + 1 }],
    rtcp: { cname: `teste-tela-${videoSsrcSeq}` },
  };
}

async function produceScreen(ctx: Ctx, transportId: string): Promise<{ producer_id: string }> {
  return (await voice.handleRequest(ctx, "produce", {
    transport_id: transportId,
    kind: "video",
    source: "screen",
    rtp_parameters: vp8ScreenRtpParameters(),
  })) as { producer_id: string };
}

/** Soundshare (M5): áudio de aba/sistema acompanhando a tela — kind audio, source screen_audio. */
async function produceScreenAudio(ctx: Ctx, transportId: string): Promise<{ producer_id: string }> {
  return (await voice.handleRequest(ctx, "produce", {
    transport_id: transportId,
    kind: "audio",
    source: "screen_audio",
    rtp_parameters: opusRtpParameters(),
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
  sessions: Map<
    string,
    {
      /** M9: o kick varre POR USUÁRIO — o teste forja a segunda sessão mexendo aqui */
      userId: string;
      consumers: Map<string, { paused: boolean; closed: boolean }>;
      /** M9: o teste de server mute confere producer.paused — enforcement real, não flag */
      producers: Map<string, { paused: boolean; closed: boolean; appData: { source?: string } }>;
    }
  >;
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
      self_stream: false,
      server_mute: false,
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
    assert.deepEqual(news[0], {
      channel_id: "2",
      user_id: alice.id,
      producer_id: p.producer_id,
      kind: "audio",
      source: "mic",
    });
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
      self_stream: false,
      server_mute: false,
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
    assert.deepEqual(news[0], {
      channel_id: "2",
      user_id: alice.id,
      producer_id: video.producer_id,
      kind: "video",
      source: "camera",
    });

    const mine = voice.voiceStates().find((s) => s.user_id === alice.id);
    assert.equal(mine?.self_video, true, "câmera ligada → self_video true no snapshot");
    assert.equal(mine?.self_stream, false, "câmera NÃO é tela: self_stream segue false (M5)");
    assert.equal(mine?.channel_id, "2");
  } finally {
    await leaveQuietly(ctx);
  }
});

test("SEGUNDO produce da mesma source SUBSTITUI o primeiro (restart, revisão M5 #3)", async () => {
  const ctx: Ctx = { userId: alice.id, sessionId: "s-video-restart" };
  try {
    await join(ctx, "2");
    const t = await createTransport(ctx, "send");
    const first = await produceVideo(ctx, t.transport_id);
    reset();
    // rejeitar deixava producer fantasma travando a source (e, na screen, o
    // canal): agora o antigo cai com VOICE_PRODUCER_CLOSED e o novo assume
    const second = await produceVideo(ctx, t.transport_id);
    assert.notEqual(second.producer_id, first.producer_id, "restart emite producer NOVO");
    const closed = findAll<ProducerClosedWire>("VOICE_PRODUCER_CLOSED");
    assert.ok(
      closed.some((c) => c.producer_id === first.producer_id),
      "o producer antigo foi fechado com o CLOSED de praxe",
    );
    // uma câmera viva só (a nova): self_video segue true
    assert.equal(voice.voiceStates().find((s) => s.user_id === alice.id)?.self_video, true);
    // áudio na mesma sessão continua passando (sources independentes)
    const audio = await produce(ctx, t.transport_id);
    assert.equal(typeof audio.producer_id, "string");
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
    assert.ok(added.includes(audio.producer_id), "mic continua entrando no observer");
    assert.ok(!added.includes(video.producer_id), "vídeo no audioLevelObserver é bug (guard por source, M5)");
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
      producers?: { producer_id: string; kind?: string; source?: string }[];
    };
    const stock = joined.producers ?? [];
    assert.ok(!stock.some((p) => p.producer_id === videoProd.producer_id), "o vídeo fechado some do estoque");
    assert.ok(
      stock.some((p) => p.producer_id === audioProd.producer_id && p.kind === "audio" && p.source === "mic"),
      "o áudio segue no estoque, com kind e source (o cliente decide como consumir por eles)",
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
// M5: screen share (Go Live, doc §3.5/§3.6) — produce source screen (stream
// único) e screen_audio (soundshare), política de 1 transmissão por CANAL,
// cascata tela→soundshare no close_producer e close_consumer (o viewer sob
// demanda parou de assistir: close LIBERA; pause deixaria alocado).
// ---------------------------------------------------------------------------

test("produce screen → VOICE_NEW_PRODUCER source screen e self_stream true (self_video intocado)", async () => {
  const ctx: Ctx = { userId: alice.id, sessionId: "s-tela" };
  try {
    await join(ctx, "2");
    const t = await createTransport(ctx, "send");
    reset();
    const screen = await produceScreen(ctx, t.transport_id);
    assert.equal(typeof screen.producer_id, "string");
    await settle();
    const news = findAll<NewProducerWire>("VOICE_NEW_PRODUCER");
    assert.equal(news.length, 1, "um produce = um VOICE_NEW_PRODUCER");
    assert.deepEqual(news[0], {
      channel_id: "2",
      user_id: alice.id,
      producer_id: screen.producer_id,
      kind: "video",
      source: "screen",
    });

    // o badge AO VIVO da lista do canal vive deste VOICE_STATE_UPDATE
    const last = findAll<VoiceStateWire>("VOICE_STATE_UPDATE").at(-1);
    assert.ok(last, "produce de screen broadcasta VOICE_STATE_UPDATE");
    assert.equal(last.user_id, alice.id);
    assert.equal(last.channel_id, "2");
    assert.equal(last.self_stream, true, "transmitindo → self_stream true");
    assert.equal(last.self_video, false, "tela NÃO é câmera: self_video segue false");

    const mine = voice.voiceStates().find((s) => s.user_id === alice.id);
    assert.equal(mine?.self_stream, true, "voiceStates (snapshot do READY) reflete a transmissão");
    assert.equal(mine?.self_video, false);

    // segunda tela na MESMA sessão → SUBSTITUI (restart, revisão M5 #3): o
    // fantasma de um produce cujo WS caiu não pode travar o palco do canal
    reset();
    const replay = await produceScreen(ctx, t.transport_id);
    assert.notEqual(replay.producer_id, screen.producer_id, "restart emite producer novo");
    assert.ok(
      findAll<ProducerClosedWire>("VOICE_PRODUCER_CLOSED").some((c) => c.producer_id === screen.producer_id),
      "a tela antiga caiu com o CLOSED de praxe",
    );
    assert.equal(voice.voiceStates().find((s) => s.user_id === alice.id)?.self_stream, true);
  } finally {
    await leaveQuietly(ctx);
  }
});

test("corrida: DUAS sessões produzem screen no mesmo canal ao mesmo tempo → exatamente 1 vence", async () => {
  const a: Ctx = { userId: alice.id, sessionId: "s-corrida-a" };
  const b: Ctx = { userId: bob.id, sessionId: "s-corrida-b" };
  try {
    await join(a, "2");
    await join(b, "2");
    const ta = await createTransport(a, "send");
    const tb = await createTransport(b, "send");
    // mesmo tick: a fila de operações é POR SESSÃO — a política 1-por-canal
    // atravessa sessões e depende da revalidação pós-await (revisão M5, q.1)
    const results = await Promise.allSettled([produceScreen(a, ta.transport_id), produceScreen(b, tb.transport_id)]);
    const wins = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(wins, 1, "exatamente uma transmissão vence a corrida");
    const streaming = voice.voiceStates().filter((s) => s.self_stream).length;
    assert.equal(streaming, 1, "o snapshot também vê um único palco ocupado");
  } finally {
    await leaveQuietly(a);
    await leaveQuietly(b);
  }
});

test("SEGUNDA sessão com screen no MESMO canal → erro 1-por-canal; canal diferente ok; encerrar libera", async () => {
  const a: Ctx = { userId: alice.id, sessionId: "s-palco-a" };
  const b: Ctx = { userId: bob.id, sessionId: "s-palco-b" };
  const c: Ctx = { userId: carol.id, sessionId: "s-palco-c" };
  try {
    await join(a, "2");
    const ta = await createTransport(a, "send");
    const screenA = await produceScreen(a, ta.transport_id);

    // política do doc §3.6: 1 transmissão por canal — a do A já ocupa o palco
    await join(b, "2");
    const tb = await createTransport(b, "send");
    await assert.rejects(() => produceScreen(b, tb.transport_id), /já existe uma transmissão/);

    // canal DIFERENTE tem palco próprio: a política é por canal, não global
    await join(c, "3");
    const tc = await createTransport(c, "send");
    const screenC = await produceScreen(c, tc.transport_id);
    assert.equal(typeof screenC.producer_id, "string", "a tela no canal vizinho passa");

    // A encerra → o palco do canal 2 libera (a regra conta producers VIVOS)
    await voice.handleRequest(a, "close_producer", { producer_id: screenA.producer_id });
    const screenB = await produceScreen(b, tb.transport_id);
    assert.equal(typeof screenB.producer_id, "string", "transmissão encerrada libera o canal");
  } finally {
    await leaveQuietly(a);
    await leaveQuietly(b);
    await leaveQuietly(c);
  }
});

test("screen_audio sem screen vivo → rejeita (soundshare acompanha a tela)", async () => {
  const ctx: Ctx = { userId: alice.id, sessionId: "s-soundshare-orfao" };
  try {
    await join(ctx, "2");
    const t = await createTransport(ctx, "send");
    await assert.rejects(() => produceScreenAudio(ctx, t.transport_id));
    // a regra é SÓ do screen_audio: o mic da mesma sessão continua passando
    const mic = await produce(ctx, t.transport_id);
    assert.equal(typeof mic.producer_id, "string", "a recusa do soundshare órfão não barra o mic");
  } finally {
    await leaveQuietly(ctx);
  }
});

test("screen_audio com screen vivo → ok, source no broadcast e FORA do audioLevelObserver", async () => {
  const ctx: Ctx = { userId: alice.id, sessionId: "s-soundshare" };
  try {
    await join(ctx, "2");
    // espião no observer da sala (mesmo padrão do teste de vídeo do M4): o
    // guard do M5 é por SOURCE — screen_audio é kind audio, e entrar no
    // observer deixaria o streamer "falando" para sempre na UI
    const room = internals.rooms.get("2");
    assert.ok(room, "sala do canal 2 deveria existir após o join");
    const added: string[] = [];
    const orig = room.observer.addProducer.bind(room.observer);
    room.observer.addProducer = (o) => {
      added.push(o.producerId);
      return orig(o);
    };

    const t = await createTransport(ctx, "send");
    const mic = await produce(ctx, t.transport_id);
    const screen = await produceScreen(ctx, t.transport_id);
    reset();
    const sa = await produceScreenAudio(ctx, t.transport_id);
    assert.equal(typeof sa.producer_id, "string");
    await settle();
    const news = findAll<NewProducerWire>("VOICE_NEW_PRODUCER");
    assert.equal(news.length, 1, "um produce = um VOICE_NEW_PRODUCER");
    assert.deepEqual(news[0], {
      channel_id: "2",
      user_id: alice.id,
      producer_id: sa.producer_id,
      kind: "audio",
      source: "screen_audio",
    });

    assert.ok(added.includes(mic.producer_id), "mic segue entrando no observer");
    assert.ok(
      !added.includes(sa.producer_id),
      "screen_audio no observer = streamer 'falando' para sempre (guard por source, não por kind)",
    );
    assert.ok(!added.includes(screen.producer_id), "vídeo continua fora do observer");

    // segundo soundshare na MESMA sessão → SUBSTITUI (restart, revisão M5 #3)
    reset();
    const replay = await produceScreenAudio(ctx, t.transport_id);
    assert.notEqual(replay.producer_id, sa.producer_id, "restart emite producer novo");
    assert.ok(
      findAll<ProducerClosedWire>("VOICE_PRODUCER_CLOSED").some((c) => c.producer_id === sa.producer_id),
      "o soundshare antigo caiu com o CLOSED de praxe",
    );
  } finally {
    await leaveQuietly(ctx);
  }
});

test("close_producer do screen derruba o screen_audio junto (dois CLOSED + self_stream false)", async () => {
  const a: Ctx = { userId: alice.id, sessionId: "s-fim-tx" };
  const c: Ctx = { userId: carol.id, sessionId: "s-fim-tx-c" };
  try {
    await join(a, "2");
    const t = await createTransport(a, "send");
    const mic = await produce(a, t.transport_id);
    const screen = await produceScreen(a, t.transport_id);
    const sa = await produceScreenAudio(a, t.transport_id);

    reset();
    const r = await voice.handleRequest(a, "close_producer", { producer_id: screen.producer_id });
    assert.deepEqual(r ?? {}, {}, "close_producer responde payload vazio");
    await settle();
    // defesa do servidor: soundshare órfão sem tela não faz sentido — fechar a
    // tela fecha TAMBÉM o screen_audio da sessão, com o CLOSED de ambos (e de
    // mais nada: o mic sobrevive)
    const closed = findAll<ProducerClosedWire>("VOICE_PRODUCER_CLOSED");
    assert.deepEqual(
      closed.map((e) => e.producer_id).sort(),
      [screen.producer_id, sa.producer_id].sort(),
      "exatamente dois VOICE_PRODUCER_CLOSED: tela e soundshare",
    );
    assert.ok(closed.every((e) => e.channel_id === "2"));

    const last = findAll<VoiceStateWire>("VOICE_STATE_UPDATE").at(-1);
    assert.ok(last, "fim da transmissão broadcasta VOICE_STATE_UPDATE");
    assert.equal(last.user_id, alice.id);
    assert.equal(last.self_stream, false, "o badge AO VIVO apaga");
    assert.equal(last.channel_id, "2", "encerrar a transmissão NÃO tira o usuário da voz");

    // quem entra depois só vê o mic no estoque — tela e soundshare sumiram
    const joined = (await voice.handleRequest(c, "join", { channel_id: "2" })) as {
      producers?: { producer_id: string }[];
    };
    assert.deepEqual(
      (joined.producers ?? []).map((p) => p.producer_id),
      [mic.producer_id],
      "tela e soundshare somem do estoque; o mic fica",
    );
  } finally {
    await leaveQuietly(a);
    await leaveQuietly(c);
  }
});

test("close_consumer fecha e libera (alheio → rejeita; segundo close → 'desconhecido')", async () => {
  const a: Ctx = { userId: alice.id, sessionId: "s-cc-a" };
  const b: Ctx = { userId: bob.id, sessionId: "s-cc-b" };
  try {
    await join(a, "2");
    const ta = await createTransport(a, "send");
    const screen = await produceScreen(a, ta.transport_id);

    const joinB = await join(b, "2");
    const tb = await createTransport(b, "recv");
    const c = (await voice.handleRequest(b, "consume", {
      transport_id: tb.transport_id,
      producer_id: screen.producer_id,
      rtp_capabilities: joinB.rtp_capabilities,
    })) as ConsumerWire;
    const live = internals.sessions.get(b.sessionId)?.consumers.get(c.consumer_id);
    assert.ok(live, "consumer deveria estar no mapa da sessão do B");

    // alheio: lookup no mapa DA SESSÃO — o A não fecha o consumer do B
    await assert.rejects(() => voice.handleRequest(a, "close_consumer", { consumer_id: c.consumer_id }));
    assert.ok(internals.sessions.get(b.sessionId)?.consumers.has(c.consumer_id), "a tentativa alheia não fechou nada");

    // "parar de assistir": close LIBERA o consumer no servidor — a economia
    // real dos viewers sob demanda (pause deixaria o recurso alocado)
    const r = await voice.handleRequest(b, "close_consumer", { consumer_id: c.consumer_id });
    assert.deepEqual(r ?? {}, {}, "close_consumer responde payload vazio");
    assert.equal(live.closed, true, "consumer.close() de verdade no worker, não só remoção do mapa");
    assert.ok(!internals.sessions.get(b.sessionId)?.consumers.has(c.consumer_id), "o mapa da sessão esquece o consumer");

    // segundo close do mesmo id: o mapa já não o conhece → erro claro
    await assert.rejects(() => voice.handleRequest(b, "close_consumer", { consumer_id: c.consumer_id }), /desconhecido/);
    // Zod na entrada: sem consumer_id nem chega ao lookup
    await assert.rejects(() => voice.handleRequest(b, "close_consumer", {}));
  } finally {
    await leaveQuietly(a);
    await leaveQuietly(b);
  }
});

test("estoque do join carrega o source de TODOS os producers", async () => {
  const a: Ctx = { userId: alice.id, sessionId: "s-estoque-a" };
  const b: Ctx = { userId: bob.id, sessionId: "s-estoque-b" };
  try {
    await join(a, "2");
    const t = await createTransport(a, "send");
    // os 4 sources num só streamer (bate no teto de 4 producers por sessão)
    const mic = await produce(a, t.transport_id);
    const cam = await produceVideo(a, t.transport_id);
    const screen = await produceScreen(a, t.transport_id);
    const sa = await produceScreenAudio(a, t.transport_id);

    const joined = (await voice.handleRequest(b, "join", { channel_id: "2" })) as {
      producers?: { user_id: string; producer_id: string; kind?: string; source?: string }[];
    };
    const stock = new Map((joined.producers ?? []).map((p) => [p.producer_id, p]));
    assert.equal(stock.size, 4, "os 4 producers do A chegam no estoque");
    const expected: [string, string, string][] = [
      [mic.producer_id, "audio", "mic"],
      [cam.producer_id, "video", "camera"],
      [screen.producer_id, "video", "screen"],
      [sa.producer_id, "audio", "screen_audio"],
    ];
    for (const [id, kind, source] of expected) {
      const entry = stock.get(id);
      assert.equal(entry?.kind, kind, `estoque do ${source}: kind ${kind}`);
      assert.equal(entry?.source, source, `estoque carrega source ${source} (o cliente decide o fluxo por ele)`);
      assert.equal(entry?.user_id, alice.id, "o estoque anuncia o dono certo");
    }
  } finally {
    await leaveQuietly(a);
    await leaveQuietly(b);
  }
});

test("source×kind incompatível ou source ausente → Zod rejeita antes do mediasoup", async () => {
  const ctx: Ctx = { userId: alice.id, sessionId: "s-source-kind" };
  try {
    await join(ctx, "2");
    const t = await createTransport(ctx, "send");
    // screen é captura de VÍDEO — kind audio com ela é bug de cliente
    await assert.rejects(() =>
      voice.handleRequest(ctx, "produce", {
        transport_id: t.transport_id,
        kind: "audio",
        source: "screen",
        rtp_parameters: opusRtpParameters(),
      }),
    );
    // e o espelho: mic é áudio — kind video idem
    await assert.rejects(() =>
      voice.handleRequest(ctx, "produce", {
        transport_id: t.transport_id,
        kind: "video",
        source: "mic",
        rtp_parameters: vp8SimulcastRtpParameters(),
      }),
    );
    // source virou OBRIGATÓRIO no M5 — produce sem ele é payload inválido
    await assert.rejects(
      () =>
        voice.handleRequest(ctx, "produce", {
          transport_id: t.transport_id,
          kind: "audio",
          rtp_parameters: opusRtpParameters(),
        }),
      /inválid/,
    );
    // source fora do enum do protocolo
    await assert.rejects(
      () =>
        voice.handleRequest(ctx, "produce", {
          transport_id: t.transport_id,
          kind: "video",
          source: "desktop",
          rtp_parameters: vp8ScreenRtpParameters(),
        }),
      /inválid/,
    );
    // a sessão sai ilesa das rejeições: um produce válido continua passando
    const ok = await produce(ctx, t.transport_id);
    assert.equal(typeof ok.producer_id, "string", "as rejeições de schema não sujam a sessão");
  } finally {
    await leaveQuietly(ctx);
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
      source: "camera", // a captura ≥1080p que prefere H.264 é a webcam (doc §3.5)
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

// ---------------------------------------------------------------------------
// M9: moderação de voz (roadmap 34 e 37). Os dois únicos métodos do op 20 que
// exigem admin — e o server mute é o único estado do VoiceState com
// enforcement REAL no mediasoup (producer.pause()), não declarativo.
// ---------------------------------------------------------------------------

const admin = store.findOrCreateDevUser("admin");
// M10: a migration 004 trocou o booleano is_admin por users.role — quem
// concede o cargo agora é o Store (o CLI scripts/admin.ts faz o mesmo)
store.setRole(admin.id, "admin");
const dave = store.findOrCreateDevUser("dave");

/** producer de mic vivo de uma sessão (é nele que o server mute morde). */
function micProducerOf(sessionId: string): { paused: boolean; closed: boolean } | undefined {
  const session = internals.sessions.get(sessionId);
  if (!session) return undefined;
  for (const producer of session.producers.values()) {
    if (producer.appData.source === "mic" && !producer.closed) return producer;
  }
  return undefined;
}

function producerOf(sessionId: string, source: string): { paused: boolean; closed: boolean } | undefined {
  const session = internals.sessions.get(sessionId);
  if (!session) return undefined;
  for (const producer of session.producers.values()) {
    if (producer.appData.source === source && !producer.closed) return producer;
  }
  return undefined;
}

/** O admin não precisa estar em voz para moderar — a sessão dele é só identidade. */
const adminCtx: Ctx = { userId: admin.id, sessionId: "s-admin" };

test("server_mute e disconnect_user exigem admin (não-admin é recusado nos dois)", async () => {
  const naoAdmin: Ctx = { userId: bob.id, sessionId: "s-nao-admin" };
  await assert.rejects(
    () => voice.handleRequest(naoAdmin, "server_mute", { user_id: dave.id, muted: true }),
    /admin/,
    "qualquer um silenciando qualquer um seria pior que não ter moderação",
  );
  await assert.rejects(() => voice.handleRequest(naoAdmin, "disconnect_user", { user_id: dave.id }), /admin/);
  // Zod na entrada, como todo o resto do op 20
  await assert.rejects(() => voice.handleRequest(adminCtx, "server_mute", { user_id: dave.id }));
  await assert.rejects(() => voice.handleRequest(adminCtx, "server_mute", { user_id: dave.id, muted: "sim" }));
  await assert.rejects(() => voice.handleRequest(adminCtx, "disconnect_user", {}));
  // usuário que não existe não pode entrar na lista de silenciados (lixo eterno)
  await assert.rejects(
    () => voice.handleRequest(adminCtx, "server_mute", { user_id: "4611686018427387904", muted: true }),
    /desconhecido/,
  );
});

test("server_mute PAUSA o producer de verdade e broadcasta server_mute true", async () => {
  const alvo: Ctx = { userId: dave.id, sessionId: "s-mute-alvo" };
  try {
    await join(alvo, "2");
    const t = await createTransport(alvo, "send");
    await produce(alvo, t.transport_id);
    const mic = micProducerOf(alvo.sessionId);
    assert.ok(mic, "sanidade: o dave tem um producer de mic");
    assert.equal(mic.paused, false, "producer nasce tocando quando ninguém silenciou");

    reset();
    const r = await voice.handleRequest(adminCtx, "server_mute", { user_id: dave.id, muted: true });
    assert.deepEqual(r ?? {}, {}, "server_mute responde payload vazio");
    assert.equal(mic.paused, true, "enforcement REAL: o worker para de encaminhar o RTP do mic");

    const last = findAll<VoiceStateWire>("VOICE_STATE_UPDATE").at(-1);
    assert.ok(last, "server_mute broadcasta VOICE_STATE_UPDATE");
    assert.equal(last.user_id, dave.id);
    assert.equal(last.channel_id, "2", "silenciar NÃO tira da voz");
    assert.equal(last.server_mute, true);
    assert.equal(voice.voiceStates().find((s) => s.user_id === dave.id)?.server_mute, true);

    // liberar volta a soltar o áudio
    reset();
    await voice.handleRequest(adminCtx, "server_mute", { user_id: dave.id, muted: false });
    assert.equal(mic.paused, false, "unmute retoma o producer");
    assert.equal(findAll<VoiceStateWire>("VOICE_STATE_UPDATE").at(-1)?.server_mute, false);
  } finally {
    await voice.handleRequest(adminCtx, "server_mute", { user_id: dave.id, muted: false });
    await leaveQuietly(alvo);
  }
});

test("ARMADILHA (auditoria M12): o silenciado NÃO escapa pelo screen_audio", async () => {
  // O bypass: abrir um Go Live com um canvas 1×1 e alimentar o `screen_audio`
  // com o track do MICROFONE. Antes da correção o servidor pausava só o
  // producer de `mic`, então essa segunda trilha de áudio saía inteira — para
  // todos que abrissem a transmissão, com o badge de silenciado aceso e sem
  // acender o anel de "falando" (o observer só recebe `mic`).
  //
  // No desktop Windows nem exigia cliente modificado: o picker manda
  // `audio: "loopback"`, que é o áudio do SISTEMA.
  const alvo: Ctx = { userId: dave.id, sessionId: "s-mute-screenaudio" };
  try {
    await join(alvo, "2");
    const t = await createTransport(alvo, "send");
    await produce(alvo, t.transport_id); // mic
    await produceScreen(alvo, t.transport_id); // a tela que o soundshare exige
    await produceScreenAudio(alvo, t.transport_id);

    const mic = producerOf(alvo.sessionId, "mic");
    const screenAudio = producerOf(alvo.sessionId, "screen_audio");
    const screen = producerOf(alvo.sessionId, "screen");
    assert.ok(mic && screenAudio && screen, "sanidade: os três producers existem");
    assert.equal(screenAudio.paused, false, "sanidade: sem mute, o soundshare toca");

    await voice.handleRequest(adminCtx, "server_mute", { user_id: dave.id, muted: true });
    assert.equal(mic.paused, true, "o mic pausa, como sempre pausou");
    assert.equal(screenAudio.paused, true, "e o screen_audio TAMBÉM — era o buraco");
    assert.equal(screen.paused, false, "o VÍDEO da tela continua: silenciar não é derrubar o Go Live");

    // e um producer de áudio NOVO, criado já silenciado, nasce pausado
    await voice.handleRequest(alvo, "close_producer", { producer_id: (screenAudio as unknown as { id: string }).id });
    await produceScreenAudio(alvo, t.transport_id);
    assert.equal(producerOf(alvo.sessionId, "screen_audio")?.paused, true, "re-produzir já silenciado não solta o áudio");

    // liberar volta a soltar os dois
    await voice.handleRequest(adminCtx, "server_mute", { user_id: dave.id, muted: false });
    assert.equal(mic.paused, false);
    assert.equal(producerOf(alvo.sessionId, "screen_audio")?.paused, false);
  } finally {
    await voice.handleRequest(adminCtx, "server_mute", { user_id: dave.id, muted: false });
    await leaveQuietly(alvo);
  }
});

test("ARMADILHA: sair e voltar (ou refazer o producer) NÃO burla o server mute", async () => {
  const alvo: Ctx = { userId: dave.id, sessionId: "s-mute-fuga" };
  const volta: Ctx = { userId: dave.id, sessionId: "s-mute-volta" };
  try {
    await join(alvo, "2");
    const t = await createTransport(alvo, "send");
    await produce(alvo, t.transport_id);
    await voice.handleRequest(adminCtx, "server_mute", { user_id: dave.id, muted: true });
    assert.equal(micProducerOf(alvo.sessionId)?.paused, true, "sanidade: silenciado");

    // 1) refazer o producer da MESMA source (restart do M5): o novo nasce pausado
    await produce(alvo, t.transport_id);
    assert.equal(micProducerOf(alvo.sessionId)?.paused, true, "producer novo não pode nascer solto");

    // 2) sair da voz e voltar por OUTRA sessão — o caminho óbvio de fuga
    await voice.handleRequest(alvo, "leave", {});
    await join(volta, "2");
    const t2 = await createTransport(volta, "send");
    await produce(volta, t2.transport_id);
    assert.equal(
      micProducerOf(volta.sessionId)?.paused,
      true,
      "o silêncio é do USUÁRIO: sair e voltar não pode devolver o microfone",
    );
    assert.equal(voice.voiceStates().find((s) => s.user_id === dave.id)?.server_mute, true);

    // e o unmute vale para a sessão nova, sem o admin ter que repetir nada
    await voice.handleRequest(adminCtx, "server_mute", { user_id: dave.id, muted: false });
    assert.equal(micProducerOf(volta.sessionId)?.paused, false);
  } finally {
    await voice.handleRequest(adminCtx, "server_mute", { user_id: dave.id, muted: false });
    await leaveQuietly(alvo);
    await leaveQuietly(volta);
  }
});

test("server_mute de quem está FORA da voz vale quando ele entra", async () => {
  const alvo: Ctx = { userId: dave.id, sessionId: "s-mute-fora" };
  try {
    assert.ok(!voice.voiceStates().some((s) => s.user_id === dave.id), "sanidade: dave fora da voz");
    reset();
    await voice.handleRequest(adminCtx, "server_mute", { user_id: dave.id, muted: true });
    assert.equal(events.length, 0, "não há sessão para anunciar — nada é broadcastado");

    await join(alvo, "2");
    const t = await createTransport(alvo, "send");
    await produce(alvo, t.transport_id);
    assert.equal(micProducerOf(alvo.sessionId)?.paused, true, "o mute esperava por ele na porta");
    assert.equal(
      findAll<VoiceStateWire>("VOICE_STATE_UPDATE")
        .filter((u) => u.user_id === dave.id)
        .at(-1)?.server_mute,
      true,
      "o VOICE_STATE_UPDATE do join já anuncia o silêncio",
    );
  } finally {
    await voice.handleRequest(adminCtx, "server_mute", { user_id: dave.id, muted: false });
    await leaveQuietly(alvo);
  }
});

test("disconnect_user tira o alvo da voz e não encosta em quem está junto", async () => {
  const s1: Ctx = { userId: carol.id, sessionId: "s-kick-1" };
  const s2: Ctx = { userId: carol.id, sessionId: "s-kick-2" };
  const vizinho: Ctx = { userId: bob.id, sessionId: "s-kick-vizinho" };
  try {
    await join(s1, "2");
    await join(s2, "3"); // expulsa a s1 (invariante do M3) — sobra a s2
    await join(vizinho, "2");
    assert.equal(voice.voiceStates().filter((s) => s.user_id === carol.id).length, 1);

    reset();
    const r = await voice.handleRequest(adminCtx, "disconnect_user", { user_id: carol.id });
    assert.deepEqual(r ?? {}, {}, "disconnect_user responde payload vazio");
    await settle();
    assert.ok(!voice.voiceStates().some((s) => s.user_id === carol.id), "o alvo saiu da voz");
    const last = findAll<VoiceStateWire>("VOICE_STATE_UPDATE")
      .filter((u) => u.user_id === carol.id)
      .at(-1);
    assert.equal(last?.channel_id, null, "a saída viaja como channel_id null, igual a um leave");
    assert.ok(
      voice.voiceStates().some((s) => s.user_id === bob.id),
      "quem estava no canal continua lá — o kick é cirúrgico",
    );
    // a sessão derrubada perdeu o direito de mexer em voz
    await assert.rejects(() => voice.handleRequest(s2, "create_transport", { direction: "send" }));
    // repetir é inofensivo (não há o que derrubar)
    await voice.handleRequest(adminCtx, "disconnect_user", { user_id: carol.id });
  } finally {
    await leaveQuietly(s1);
    await leaveQuietly(s2);
    await leaveQuietly(vizinho);
  }
});

test("ARMADILHA (auditoria M12): a MESMA sessão não consome o mesmo producer duas vezes", async () => {
  // O único freio era o teto de 64 por sessão, e nada impedia pedir 64 cópias
  // do MESMO stream. Cada consumer é um encaminhamento REAL no worker, com ssrc
  // próprio: numa transmissão de tela isso multiplica a saída do nó por 64 para
  // uma entrada só. Repetir o consume nunca foi uso legítimo — o cliente guarda
  // o consumer que recebeu, e o `producerclose` limpa o mapa sozinho.
  const erin = store.findOrCreateDevUser("erin");
  const dono: Ctx = { userId: dave.id, sessionId: "s-dedupe-dono" };
  const espiao: Ctx = { userId: erin.id, sessionId: "s-dedupe-espiao" };
  try {
    await join(dono, "2");
    const joinE = await join(espiao, "2");
    const td = await createTransport(dono, "send");
    const prod = await produceScreen(dono, td.transport_id);
    const te = await createTransport(espiao, "recv");

    const pedir = (): Promise<unknown> =>
      voice.handleRequest(espiao, "consume", {
        transport_id: te.transport_id,
        producer_id: prod.producer_id,
        rtp_capabilities: joinE.rtp_capabilities,
      });

    const primeiro = (await pedir()) as { consumer_id: string };
    assert.ok(primeiro.consumer_id, "o primeiro consume é legítimo");
    await assert.rejects(pedir, /já consome este producer/, "o segundo tem de ser recusado");

    // e depois de fechar, pode consumir de novo — o dedupe não pode virar
    // prisão para quem legitimamente reabre a transmissão
    await voice.handleRequest(espiao, "close_consumer", { consumer_id: primeiro.consumer_id });
    const denovo = (await pedir()) as { consumer_id: string };
    assert.ok(denovo.consumer_id, "depois do close, consumir de novo é legítimo");
  } finally {
    await leaveQuietly(espiao);
    await leaveQuietly(dono);
  }
});

test("ARMADILHA (auditoria M12): dois admins se desconectando NÃO travam as filas", async () => {
  // O `disconnect_user` rodava dentro da fila do ATOR e esperava a fila do
  // ALVO. Dois staff cruzados fechavam o ciclo: a fila A espera a B, que espera
  // a A. As duas morriam PARA SEMPRE — nem `leave` respondia — e como kick/ban
  // do REST chamam `removeUserFromVoice`, a requisição HTTP de expulsão ficava
  // pendurada. O caso especial que existia cobria só o admin se desconectando a
  // si mesmo, nunca o cruzado.
  const admin2 = store.findOrCreateDevUser("admin2");
  store.setRole(admin2.id, "admin");
  const a: Ctx = { userId: admin.id, sessionId: "s-dl-a" };
  const b: Ctx = { userId: admin2.id, sessionId: "s-dl-b" };
  try {
    await join(a, "2");
    await join(b, "2");

    // cruzados, sem ceder o event loop entre um e outro
    const pa = voice.handleRequest(a, "disconnect_user", { user_id: admin2.id });
    const pb = voice.handleRequest(b, "disconnect_user", { user_id: admin.id });

    const prazo = new Promise((_, rej) => setTimeout(() => rej(new Error("DEADLOCK: as filas travaram")), 4000));
    await Promise.race([Promise.all([pa, pb]), prazo]);

    // e as filas continuam vivas depois: um leave posterior responde
    const depois = Promise.race([
      voice.handleRequest(a, "leave", {}),
      new Promise((_, rej) => setTimeout(() => rej(new Error("fila morta: leave não respondeu")), 3000)),
    ]);
    await depois;
  } finally {
    // Limpeza COM PRAZO. Sem isto, quando a regressão volta o `leaveQuietly`
    // também cai na fila morta e trava — o arquivo inteiro pendura em vez de
    // dar um teste vermelho. Aconteceu ao verificar esta correção: o runner
    // ficou preso até o timeout externo, sem imprimir nada.
    const comPrazo = (p: Promise<unknown>): Promise<unknown> =>
      Promise.race([p, new Promise((r) => setTimeout(r, 2000))]);
    await comPrazo(leaveQuietly(a));
    await comPrazo(leaveQuietly(b));
  }
});

test("disconnect_user com DUAS sessões de voz do MESMO usuário derruba as duas", async () => {
  // Pelo join, duas sessões de voz do mesmo usuário não coexistem (a segunda
  // expulsa a primeira). O cenário é forjado a partir de duas sessões REAIS,
  // trocando o dono da segunda: é o que aconteceria se algum caminho futuro
  // relaxasse aquele invariante — e o kick tem que varrer POR USUÁRIO, não
  // parar na primeira sessão que encontrar.
  const s1: Ctx = { userId: dave.id, sessionId: "s-duas-1" };
  const s2: Ctx = { userId: carol.id, sessionId: "s-duas-2" };
  try {
    await join(s1, "2");
    await join(s2, "3");
    const segunda = internals.sessions.get(s2.sessionId);
    assert.ok(segunda, "sanidade: a segunda sessão está no mapa");
    segunda.userId = dave.id; // agora são duas sessões vivas do MESMO usuário
    assert.equal(voice.voiceStates().filter((s) => s.user_id === dave.id).length, 2);

    await voice.handleRequest(adminCtx, "disconnect_user", { user_id: dave.id });
    await settle();
    assert.ok(!voice.voiceStates().some((s) => s.user_id === dave.id), "nenhuma sessão do alvo sobreviveu");
    assert.ok(!internals.sessions.has(s1.sessionId), "a sessão do canal 2 caiu");
    assert.ok(!internals.sessions.has(s2.sessionId), "e a do canal 3 também");
  } finally {
    await leaveQuietly(s1);
    await leaveQuietly(s2);
  }
});

test("admin pode se desconectar (a fila da própria sessão não pode travar)", async () => {
  const eu: Ctx = { userId: admin.id, sessionId: "s-admin-em-voz" };
  try {
    await join(eu, "2");
    assert.ok(voice.voiceStates().some((s) => s.user_id === admin.id));
    // sem o desvio, enfileirar o kick na PRÓPRIA sessão esperaria por si mesmo
    // (deadlock) e este teste travaria em vez de falhar
    await voice.handleRequest(eu, "disconnect_user", { user_id: admin.id });
    assert.ok(!voice.voiceStates().some((s) => s.user_id === admin.id), "o admin saiu");
  } finally {
    await leaveQuietly(eu);
  }
});
