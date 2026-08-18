/**
 * Smoke test do gateway: sobe nada — assume o servidor rodando em
 * http://localhost:8080. Percorre o caminho feliz de M0+M2:
 * Hello → Identify → Ready → Heartbeat/ACK → POST mensagem → MESSAGE_CREATE
 * → PATCH → MESSAGE_UPDATE → DELETE → MESSAGE_DELETE → typing → TYPING_START.
 *
 * Ato de voz (M3+M4): depois do texto, um SEGUNDO socket (user dev de apoio)
 * entra em cena e a sinalização mediasoup roda fim-a-fim: ambos join →
 * A produce áudio (source mic) → B recebe VOICE_NEW_PRODUCER e consome → A
 * liga a "câmera" (produce de VÍDEO VP8 simulcast forjado, 3 ssrcs, source
 * camera) → B consome, escolhe camada (set_preferred_layers), pausa e retoma
 * o consumer → A desliga a câmera (close_producer; self_video volta a false
 * SEM sair da voz).
 *
 * Ato Go Live (M5): A transmite a "tela" (produce source screen — os params
 * que o cliente real geraria do canvas fake: VP8 de stream ÚNICO, sem
 * simulcast) → B recebe VOICE_NEW_PRODUCER source screen e o
 * VOICE_STATE_UPDATE com self_stream true (badge AO VIVO) → B assiste
 * (consume + resume, viewer sob demanda) → B para de assistir
 * (close_consumer: LIBERA o consumer no servidor; pause deixaria alocado) →
 * A encerra (close_producer) → B recebe VOICE_PRODUCER_CLOSED + self_stream
 * false. Depois: A muta → A sai.
 * Sem mídia real — Node puro não tem WebRTC, então DTLS/RTP nunca fluem;
 * o smoke prova a SINALIZAÇÃO, os testes de unidade provam a API do worker.
 *
 *   pnpm --filter @danjocord/server smoke
 */
import WebSocket from "ws";
import { Op, ServerMessage } from "@danjocord/protocol";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:8080";
const WS_URL = BASE.replace(/^http/, "ws") + "/gateway";
const TOKEN = "dev.smoke";

function fail(msg: string): never {
  console.error(`FALHOU: ${msg}`);
  process.exit(1);
}

// 30s: o ato de voz soma um segundo socket e os round-trips de áudio, vídeo
// e Go Live (cada um é localhost — segundos de folga sobram)
const timeout = setTimeout(() => fail("timeout de 30s"), 30_000);

const steps: string[] = [];
function step(name: string) {
  steps.push(name);
  console.log(`ok: ${name}`);
}

const ws = new WebSocket(WS_URL);
let ackReceived = false;
let channelId: string | null = null;
let voiceChannelId: string | null = null;
let meId: string | null = null;
let messageId: string | null = null;
const nonce = `smoke-${Date.now()}`;
const EDITED = "mensagem do smoke test (editada)";

// O Dispatch pode chegar ANTES da resposta REST que o provocou (fan-out não
// espera o flush do HTTP). Cada handler guarda a promise do seu passo REST e
// o handler do evento seguinte espera por ela — os passos saem em ordem.
let restPending: Promise<void> | null = null;

ws.on("message", async (data) => {
  const msg = ServerMessage.parse(JSON.parse(String(data)));

  // respostas de voz (op 21) do socket A — correlação por req, ver ato de voz
  if (msg.op === Op.VoiceResponse) {
    settleVoiceResponse(msg.d);
    return;
  }
  if (msg.op === Op.Hello) {
    step(`hello (heartbeat_interval=${msg.d.heartbeat_interval})`);
    ws.send(JSON.stringify({ op: Op.Identify, d: { token: TOKEN } }));
    return;
  }
  if (msg.op === Op.HeartbeatAck) {
    ackReceived = true;
    step("heartbeat ack");
    return;
  }
  if (msg.op === Op.Dispatch && msg.t === "READY") {
    step(`ready (user=${msg.d.user.username}, ${msg.d.channels.length} canais)`);
    meId = msg.d.user.id;
    const text = msg.d.channels.find((c) => c.type === "text") ?? fail("sem canal de texto no snapshot");
    channelId = text.id;
    // o canal de voz (id 2 do seed) fica guardado para o ato de voz do final
    const voiceCh = msg.d.channels.find((c) => c.type === "voice") ?? fail("sem canal de voz no snapshot");
    voiceChannelId = voiceCh.id;
    ws.send(JSON.stringify({ op: Op.Heartbeat, d: msg.s }));
    const res = await fetch(`${BASE}/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ content: "mensagem do smoke test", nonce }),
    });
    if (res.status !== 201) fail(`POST mensagem devolveu ${res.status}`);
    step("post mensagem 201");
    return;
  }
  if (msg.op === Op.Dispatch && msg.t === "MESSAGE_CREATE") {
    if (msg.d.nonce !== nonce) return; // mensagem de outra sessão
    if (!ackReceived) fail("MESSAGE_CREATE chegou antes do heartbeat ack");
    step("message_create com nonce ecoado");
    messageId = msg.d.id;
    const history = await fetch(`${BASE}/api/channels/${channelId}/messages?limit=5`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((r) => r.json());
    if (!Array.isArray(history) || history.length < 1) fail("histórico vazio após enviar mensagem");
    step(`histórico (${history.length} mensagens)`);
    // M2: edita a mensagem recém-criada — o gateway deve ecoar MESSAGE_UPDATE
    restPending = (async () => {
      const patch = await fetch(`${BASE}/api/channels/${channelId}/messages/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ content: EDITED }),
      });
      if (patch.status !== 200) fail(`PATCH mensagem devolveu ${patch.status}`);
      step("patch mensagem 200");
    })();
    return;
  }
  if (msg.op === Op.Dispatch && msg.t === "MESSAGE_UPDATE") {
    if (msg.d.id !== messageId) return; // edição de outra sessão
    await restPending;
    if (msg.d.content !== EDITED) fail(`MESSAGE_UPDATE sem o conteúdo editado (veio "${msg.d.content}")`);
    if (typeof msg.d.edited_at !== "number") fail("MESSAGE_UPDATE sem edited_at preenchido");
    step("message_update com conteúdo novo");
    restPending = (async () => {
      const del = await fetch(`${BASE}/api/channels/${channelId}/messages/${messageId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (del.status !== 204) fail(`DELETE mensagem devolveu ${del.status}`);
      step("delete mensagem 204");
    })();
    return;
  }
  if (msg.op === Op.Dispatch && msg.t === "MESSAGE_DELETE") {
    if (msg.d.id !== messageId) return;
    await restPending;
    if (msg.d.channel_id !== channelId) fail("MESSAGE_DELETE com channel_id errado");
    step("message_delete");
    // typing não persiste nada — o smoke só confere o fan-out do evento
    restPending = (async () => {
      const typing = await fetch(`${BASE}/api/channels/${channelId}/typing`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (typing.status !== 204) fail(`POST typing devolveu ${typing.status}`);
      step("post typing 204");
    })();
    return;
  }
  if (msg.op === Op.Dispatch && msg.t === "TYPING_START") {
    // TYPING_START vai para todos (inclusive quem digita — o cliente é que
    // ignora o próprio); aqui o eco é exatamente o que se quer verificar
    if (msg.d.user_id !== meId || msg.d.channel_id !== channelId) return;
    await restPending;
    step("typing_start com o user_id certo");
    // fim do ato de texto (M0+M2) — o de voz (M3) continua num segundo socket
    voiceAct().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
  }
});

ws.on("error", (err) => fail(`erro de socket: ${String(err)}`));

// ---------------------------------------------------------------------------
// Ato de voz (M3): sinalização mediasoup fim-a-fim com dois usuários.
// ---------------------------------------------------------------------------

/** Formas no fio dos payloads de voz (snake_case, ids string). */
interface VoiceStateWire {
  user_id: string;
  channel_id: string | null;
  self_mute: boolean;
  self_deaf: boolean;
  /** câmera ligada (M4) — derivado no servidor: existe producer source camera vivo */
  self_video: boolean;
  /** transmitindo tela (M5, badge AO VIVO) — derivado: existe producer source screen vivo */
  self_stream: boolean;
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

/**
 * rtpParameters mínimos de opus para o produce sem cliente WebRTC de verdade:
 * um codec casando com o mediaCodec do router (opus/48000/2, payloadType
 * dinâmico 100) e um encoding com ssrc — o ortc do mediasoup valida a
 * estrutura, não o fluxo. Nenhum pacote RTP vai existir neste smoke.
 */
function opusRtpParameters(): unknown {
  return {
    mid: "0",
    codecs: [
      { mimeType: "audio/opus", payloadType: 100, clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [] },
    ],
    headerExtensions: [],
    encodings: [{ ssrc: 424_242 }],
    rtcp: { cname: "smoke" },
  };
}

/**
 * rtpParameters de VP8 SIMULCAST forjados (M4, doc §3.4): 3 encodings com
 * ssrcs distintos = as 3 camadas espaciais da webcam. mid "1" porque o áudio
 * já ocupa o "0" no MESMO send transport (o RtpListener rejeita mid repetido).
 */
function vp8RtpParameters(): unknown {
  return {
    mid: "1",
    codecs: [{ mimeType: "video/VP8", payloadType: 101, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
    headerExtensions: [],
    encodings: [{ ssrc: 424_301 }, { ssrc: 424_302 }, { ssrc: 424_303 }],
    rtcp: { cname: "smoke" },
  };
}

/**
 * rtpParameters da TELA (M5, doc §3.5): o que o cliente real geraria do
 * canvas fake do Go Live — VP8 de stream ÚNICO (1 encoding; screen content
 * não paga simulcast). mid "2": áudio e câmera já ocupam "0" e "1" no MESMO
 * send transport.
 */
function vp8ScreenRtpParameters(): unknown {
  return {
    mid: "2",
    codecs: [{ mimeType: "video/VP8", payloadType: 101, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
    headerExtensions: [],
    encodings: [{ ssrc: 424_401 }],
    rtcp: { cname: "smoke" },
  };
}

// Correlação req→promise do op 20/21 — mapa ÚNICO para os dois sockets
// (o contador global garante req sem colisão entre eles).
let voiceReqSeq = 0;
const voicePending = new Map<number, { resolve: (p: unknown) => void; reject: (e: Error) => void }>();

function voiceRequest(sock: WebSocket, m: string, p?: unknown): Promise<unknown> {
  const req = ++voiceReqSeq;
  return new Promise((resolve, reject) => {
    voicePending.set(req, { resolve, reject });
    sock.send(JSON.stringify({ op: Op.VoiceRequest, d: { req, m, p } }));
  });
}

function settleVoiceResponse(d: { req: number; ok: boolean; p?: unknown; error?: string }): void {
  const pending = voicePending.get(d.req);
  if (!pending) return;
  voicePending.delete(d.req);
  if (d.ok) pending.resolve(d.p);
  else pending.reject(new Error(d.error ?? "erro de voz sem mensagem"));
}

interface BusEvent {
  t: string;
  d: unknown;
}

/**
 * Fila de Dispatches com espera: wait() resolve quando um evento casando com o
 * predicado chega — ou JÁ chegou (backlog), porque broadcast e resposta op 21
 * correm em paralelo e a ordem de chegada não é garantida. Evento casado é
 * consumido: o próximo wait igual pega o próximo evento.
 */
function makeEventBus() {
  const backlog: BusEvent[] = [];
  const waiters: { pred: (e: BusEvent) => boolean; resolve: (e: BusEvent) => void }[] = [];
  return {
    push(e: BusEvent): void {
      const i = waiters.findIndex((w) => w.pred(e));
      if (i >= 0) {
        const [hit] = waiters.splice(i, 1);
        hit?.resolve(e);
        return;
      }
      backlog.push(e);
    },
    wait(pred: (e: BusEvent) => boolean): Promise<BusEvent> {
      const i = backlog.findIndex(pred);
      if (i >= 0) {
        const [hit] = backlog.splice(i, 1);
        if (hit) return Promise.resolve(hit);
      }
      return new Promise((resolve) => {
        waiters.push({ pred, resolve });
      });
    },
  };
}

/**
 * Segundo cliente do ato de voz: Hello → Identify → READY. Devolve o socket,
 * o user_id e o bus de Dispatches em que o roteiro faz as esperas. Sem
 * heartbeat próprio: o ato dura segundos e o sweep de zumbi é de minutos.
 */
function connectSecond(
  token: string,
): Promise<{ sock: WebSocket; userId: string; bus: ReturnType<typeof makeEventBus> }> {
  return new Promise((resolve) => {
    const sock = new WebSocket(WS_URL);
    const bus = makeEventBus();
    sock.on("error", (err) => fail(`erro de socket (2º cliente): ${String(err)}`));
    sock.on("message", (data) => {
      const msg = ServerMessage.parse(JSON.parse(String(data)));
      if (msg.op === Op.Hello) {
        sock.send(JSON.stringify({ op: Op.Identify, d: { token } }));
        return;
      }
      if (msg.op === Op.VoiceResponse) {
        settleVoiceResponse(msg.d);
        return;
      }
      if (msg.op === Op.Dispatch) {
        if (msg.t === "READY") {
          resolve({ sock, userId: msg.d.user.id, bus });
          return; // o READY em si não vai ao bus — ninguém espera por ele
        }
        bus.push({ t: msg.t, d: msg.d });
      }
    });
  });
}

async function voiceAct(): Promise<void> {
  const channel = voiceChannelId ?? fail("ato de voz sem canal de voz");
  const b = await connectSecond("dev.smoke2");
  step(`segundo cliente pronto (user=${b.userId})`);

  // ambos entram no canal de voz do seed
  await voiceRequest(ws, "join", { channel_id: channel });
  step("A join voz");
  const joinB = (await voiceRequest(b.sock, "join", { channel_id: channel })) as { rtp_capabilities: unknown };
  step("B join voz");
  await b.bus.wait(
    (e) =>
      e.t === "VOICE_STATE_UPDATE" &&
      (e.d as VoiceStateWire).user_id === meId &&
      (e.d as VoiceStateWire).channel_id === channel,
  );
  step("B viu o VOICE_STATE_UPDATE do join do A");

  // A produz com rtpParameters forjados
  const ta = (await voiceRequest(ws, "create_transport", { direction: "send" })) as TransportWire;
  if (typeof ta.transport_id !== "string" || !ta.ice_parameters || !ta.ice_candidates || !ta.dtls_parameters)
    fail("create_transport sem os 4 campos");
  step("A create_transport send (4 campos)");
  const prod = (await voiceRequest(ws, "produce", {
    transport_id: ta.transport_id,
    kind: "audio",
    source: "mic", // M5: source obrigatório — o microfone é "mic"
    rtp_parameters: opusRtpParameters(),
  })) as { producer_id: string };
  if (typeof prod.producer_id !== "string") fail("produce sem producer_id");
  step("A produce");

  // B fica sabendo do producer novo e consome sob demanda
  const newProd = (await b.bus.wait((e) => e.t === "VOICE_NEW_PRODUCER")).d as NewProducerWire;
  if (newProd.producer_id !== prod.producer_id || newProd.user_id !== meId || newProd.channel_id !== channel)
    fail("VOICE_NEW_PRODUCER com ids errados");
  if (newProd.kind !== "audio") fail(`VOICE_NEW_PRODUCER do mic com kind errado ("${newProd.kind}")`);
  if (newProd.source !== "mic") fail(`VOICE_NEW_PRODUCER do mic com source errado ("${newProd.source}")`);
  step("B recebeu VOICE_NEW_PRODUCER kind audio source mic");
  const tb = (await voiceRequest(b.sock, "create_transport", { direction: "recv" })) as TransportWire;
  const cons = (await voiceRequest(b.sock, "consume", {
    transport_id: tb.transport_id,
    producer_id: newProd.producer_id,
    rtp_capabilities: joinB.rtp_capabilities,
  })) as ConsumerWire;
  if (cons.producer_id !== prod.producer_id || cons.kind !== "audio" || typeof cons.consumer_id !== "string")
    fail("consume com campos errados");
  if (!cons.rtp_parameters) fail("consume sem rtp_parameters");
  step("B consume");
  await voiceRequest(b.sock, "resume_consumer", { consumer_id: cons.consumer_id });
  step("B resume_consumer");

  // ---- ato de vídeo (M4): A liga a "câmera" no MESMO send transport ----
  const vprod = (await voiceRequest(ws, "produce", {
    transport_id: ta.transport_id,
    kind: "video",
    source: "camera", // M5: a webcam é source "camera"
    rtp_parameters: vp8RtpParameters(),
  })) as { producer_id: string };
  if (typeof vprod.producer_id !== "string") fail("produce de vídeo sem producer_id");
  step("A produce vídeo (simulcast 3 camadas)");

  const newVideo = (
    await b.bus.wait((e) => e.t === "VOICE_NEW_PRODUCER" && (e.d as NewProducerWire).kind === "video")
  ).d as NewProducerWire;
  if (newVideo.producer_id !== vprod.producer_id || newVideo.user_id !== meId || newVideo.channel_id !== channel)
    fail("VOICE_NEW_PRODUCER de vídeo com ids errados");
  if (newVideo.source !== "camera") fail(`VOICE_NEW_PRODUCER da câmera com source errado ("${newVideo.source}")`);
  step("B recebeu VOICE_NEW_PRODUCER kind video source camera");

  // consumir o VOICE_STATE_UPDATE do self_video true aqui mantém o bus limpo:
  // as esperas por "self_stream false" do Go Live não podem casar com este
  // evento antigo (self_stream é false nele também)
  const camOn = (
    await b.bus.wait(
      (e) =>
        e.t === "VOICE_STATE_UPDATE" && (e.d as VoiceStateWire).user_id === meId && (e.d as VoiceStateWire).self_video,
    )
  ).d as VoiceStateWire;
  if (camOn.channel_id !== channel) fail("VOICE_STATE_UPDATE do self_video true perdeu o canal");
  step("B recebeu VOICE_STATE_UPDATE self_video true");

  // B consome o vídeo no MESMO recv transport do áudio
  const vcons = (await voiceRequest(b.sock, "consume", {
    transport_id: tb.transport_id,
    producer_id: vprod.producer_id,
    rtp_capabilities: joinB.rtp_capabilities,
  })) as ConsumerWire;
  if (vcons.kind !== "video" || vcons.producer_id !== vprod.producer_id || typeof vcons.consumer_id !== "string")
    fail("consume de vídeo com campos errados");
  if (!vcons.rtp_parameters) fail("consume de vídeo sem rtp_parameters");
  step("B consume vídeo");

  // camada intermediária (500k, doc §3.4) — na UI real, escolhida pelo tamanho do tile
  await voiceRequest(b.sock, "set_preferred_layers", { consumer_id: vcons.consumer_id, spatial_layer: 1 });
  step("B set_preferred_layers spatial 1");

  // tile fora de tela → pausa (economia real, doc §8); visível de novo → retoma
  await voiceRequest(b.sock, "pause_consumer", { consumer_id: vcons.consumer_id });
  step("B pause_consumer");
  await voiceRequest(b.sock, "resume_consumer", { consumer_id: vcons.consumer_id });
  step("B resume_consumer (vídeo de volta)");

  // A desliga a câmera SEM sair da voz: producer fecha e self_video vai a false
  await voiceRequest(ws, "close_producer", { producer_id: vprod.producer_id });
  step("A close_producer (câmera desligada)");
  const vclosed = (
    await b.bus.wait((e) => e.t === "VOICE_PRODUCER_CLOSED" && (e.d as ProducerClosedWire).producer_id === vprod.producer_id)
  ).d as ProducerClosedWire;
  if (vclosed.channel_id !== channel) fail("VOICE_PRODUCER_CLOSED do vídeo com canal errado");
  step("B recebeu VOICE_PRODUCER_CLOSED do vídeo");
  const camOff = (
    await b.bus.wait(
      (e) =>
        e.t === "VOICE_STATE_UPDATE" &&
        (e.d as VoiceStateWire).user_id === meId &&
        !(e.d as VoiceStateWire).self_video,
    )
  ).d as VoiceStateWire;
  if (camOff.channel_id !== channel) fail("VOICE_STATE_UPDATE do self_video false deveria manter o canal");
  step("B recebeu VOICE_STATE_UPDATE self_video false (A segue em voz)");

  // ---- ato Go Live (M5): A transmite a tela; B assiste e para de assistir ----
  const sprod = (await voiceRequest(ws, "produce", {
    transport_id: ta.transport_id,
    kind: "video",
    source: "screen",
    rtp_parameters: vp8ScreenRtpParameters(),
  })) as { producer_id: string };
  if (typeof sprod.producer_id !== "string") fail("produce da tela sem producer_id");
  step("A produce screen (Go Live, VP8 stream único)");

  // screen NÃO dispara consumo automático no cliente — só o badge; aqui o B
  // confere o anúncio e o estado, e o "assistir" vem por decisão própria
  const newScreen = (
    await b.bus.wait((e) => e.t === "VOICE_NEW_PRODUCER" && (e.d as NewProducerWire).source === "screen")
  ).d as NewProducerWire;
  if (newScreen.producer_id !== sprod.producer_id || newScreen.user_id !== meId || newScreen.channel_id !== channel)
    fail("VOICE_NEW_PRODUCER da tela com ids errados");
  if (newScreen.kind !== "video") fail(`VOICE_NEW_PRODUCER da tela com kind errado ("${newScreen.kind}")`);
  step("B recebeu VOICE_NEW_PRODUCER source screen");
  const live = (
    await b.bus.wait(
      (e) =>
        e.t === "VOICE_STATE_UPDATE" && (e.d as VoiceStateWire).user_id === meId && (e.d as VoiceStateWire).self_stream,
    )
  ).d as VoiceStateWire;
  if (live.channel_id !== channel) fail("VOICE_STATE_UPDATE do self_stream true perdeu o canal");
  step("B recebeu VOICE_STATE_UPDATE self_stream true (AO VIVO)");

  // B "assiste": consume + resume no MESMO recv transport (viewer sob demanda)
  const scons = (await voiceRequest(b.sock, "consume", {
    transport_id: tb.transport_id,
    producer_id: sprod.producer_id,
    rtp_capabilities: joinB.rtp_capabilities,
  })) as ConsumerWire;
  if (scons.kind !== "video" || scons.producer_id !== sprod.producer_id || typeof scons.consumer_id !== "string")
    fail("consume da tela com campos errados");
  step("B consume tela (assistir)");
  await voiceRequest(b.sock, "resume_consumer", { consumer_id: scons.consumer_id });
  step("B resume_consumer da tela");

  // B "para de assistir": close_consumer LIBERA o consumer no servidor — a
  // economia real dos viewers sob demanda (pause deixaria o recurso alocado)
  await voiceRequest(b.sock, "close_consumer", { consumer_id: scons.consumer_id });
  step("B close_consumer (parar de assistir)");

  // A encerra a transmissão SEM sair da voz: producer fecha, badge apaga
  await voiceRequest(ws, "close_producer", { producer_id: sprod.producer_id });
  step("A close_producer da tela (fim do Go Live)");
  const sclosed = (
    await b.bus.wait(
      (e) => e.t === "VOICE_PRODUCER_CLOSED" && (e.d as ProducerClosedWire).producer_id === sprod.producer_id,
    )
  ).d as ProducerClosedWire;
  if (sclosed.channel_id !== channel) fail("VOICE_PRODUCER_CLOSED da tela com canal errado");
  step("B recebeu VOICE_PRODUCER_CLOSED da tela");
  const offAir = (
    await b.bus.wait(
      (e) =>
        e.t === "VOICE_STATE_UPDATE" &&
        (e.d as VoiceStateWire).user_id === meId &&
        !(e.d as VoiceStateWire).self_stream,
    )
  ).d as VoiceStateWire;
  if (offAir.channel_id !== channel) fail("VOICE_STATE_UPDATE do self_stream false deveria manter o canal");
  step("B recebeu VOICE_STATE_UPDATE self_stream false (A segue em voz)");

  // A muta (só flags — o mute de verdade é client-side, pausando o track)
  await voiceRequest(ws, "update_state", { self_mute: true, self_deaf: false });
  const muted = (
    await b.bus.wait(
      (e) =>
        e.t === "VOICE_STATE_UPDATE" && (e.d as VoiceStateWire).user_id === meId && (e.d as VoiceStateWire).self_mute,
    )
  ).d as VoiceStateWire;
  if (muted.channel_id !== channel) fail("VOICE_STATE_UPDATE do mute perdeu o canal");
  step("B recebeu VOICE_STATE_UPDATE (A mutado)");

  // A sai: o producer fecha e o estado do A vai a null
  await voiceRequest(ws, "leave", {});
  const closed = (await b.bus.wait((e) => e.t === "VOICE_PRODUCER_CLOSED")).d as ProducerClosedWire;
  if (closed.producer_id !== prod.producer_id) fail("VOICE_PRODUCER_CLOSED de outro producer");
  step("B recebeu VOICE_PRODUCER_CLOSED");
  await b.bus.wait(
    (e) =>
      e.t === "VOICE_STATE_UPDATE" &&
      (e.d as VoiceStateWire).user_id === meId &&
      (e.d as VoiceStateWire).channel_id === null,
  );
  step("B recebeu VOICE_STATE_UPDATE null (A saiu)");

  // higiene: B também sai — o servidor de dev continua de pé depois do smoke
  await voiceRequest(b.sock, "leave", {});
  step("B leave");

  clearTimeout(timeout);
  console.log(`\nSMOKE OK — ${steps.length} passos`);
  // Nada de process.exit() aqui: no Windows ele dispara assertion do libuv
  // com sockets ainda fechando. Fecha os WS e deixa o event loop drenar
  // (o keep-alive do fetch solta sozinho em ~4s).
  process.exitCode = 0;
  ws.close(1000);
  b.sock.close(1000);
}
