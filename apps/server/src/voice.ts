import { createWorker, type types } from "mediasoup";
import {
  VoiceCloseConsumerParams,
  VoiceCloseProducerParams,
  VoiceConnectTransportParams,
  VoiceConsumeParams,
  VoiceCreateTransportParams,
  VoiceJoinParams,
  VoicePauseConsumerParams,
  VoiceProduceParams,
  VoiceRestartIceParams,
  VoiceResumeConsumerParams,
  VoiceSetPreferredLayersParams,
  VoiceUpdateStateParams,
  type DispatchEvent,
  type DispatchName,
  type ProducerSource,
  type VoiceState,
} from "@danjocord/protocol";
import type { z } from "zod";
import { config } from "./config.js";
import type { Store } from "./store.js";

// Tetos por sessão (revisão M3 #7): a guild tem ≤10 pessoas — números acima
// disto são bug de cliente ou abuso, e o worker não deve pagar por eles.
// PRODUCERS = 4 casa exato com as sources do M5: mic + camera + screen +
// screen_audio, cada uma única por sessão.
const MAX_TRANSPORTS_PER_SESSION = 4;
const MAX_PRODUCERS_PER_SESSION = 4;
const MAX_CONSUMERS_PER_SESSION = 64;

/**
 * Servidor de voz (M3, doc §3.6; M4 soma vídeo/simulcast, doc §3.4; M5 soma
 * screen share/soundshare, doc §3.5): mediasoup embutido no processo. Worker
 * único → Router por canal de voz (lazy) → WebRtcTransport send/recv por
 * sessão → Producer/Consumer (áudio, webcam e tela pelo MESMO send
 * transport). Cada producer carrega a `source` semântica (mic/camera/screen/
 * screen_audio) no appData — as políticas do M5 (1 transmissão por canal,
 * soundshare atrelado à tela, observer só de mic) decidem por ela. A
 * sinalização entra pelo gateway (op 20, delegada via handleRequest) e os
 * eventos saem por broadcast (op 0).
 *
 * Invariantes de cleanup (a alma do módulo): TODO caminho de saída — leave
 * explícito, join implícito por cima, sessão de gateway morta, transporte
 * morto, close() do processo — passa por doLeave(), que fecha producers →
 * consumers → transports, atualiza o conjunto de speaking e broadcasta o
 * VOICE_STATE_UPDATE com channel_id null. Nada vaza fora dele.
 */

/**
 * Opus 48 kHz estéreo (M3) + VP8 e H.264 (M4, doc §3.4/§3.5). VP8 é o default
 * universal (simulcast batido, encode por software em qualquer lugar); H.264
 * entra para capturas ≥1080p/4K — o encode por HARDWARE é o que torna 4K
 * viável (VP8 4K em software derrete CPU). O cliente escolhe o codec no
 * produce pela resolução real; level-asymmetry permite o encoder subir de
 * nível (4K = 5.1) sem renegociar o profile-level-id anunciado.
 * RouterRtpCodecCapability (e não RtpCodecCapability): variante sem
 * preferredPayloadType obrigatório — o router escolhe sozinho.
 */
const MEDIA_CODECS: types.RouterRtpCodecCapability[] = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48_000, channels: 2 },
  { kind: "video", mimeType: "video/VP8", clockRate: 90_000 },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90_000,
    parameters: { "packetization-mode": 1, "profile-level-id": "42e01f", "level-asymmetry-allowed": 1 },
  },
];

/** ICE 'disconnected' pode ser blip de rede: janela para reconectar antes do leave forçado */
const DEAD_TRANSPORT_GRACE_MS = 15_000;

/** limiar de "está falando" do audioLevelObserver, em dBFS (contrato do M3) */
const SPEAKING_THRESHOLD_DB = -55;

/** teto de entradas no evento 'volumes' — a guild tem ≤10 usuários; 16 dá folga */
const SPEAKING_MAX_ENTRIES = 16;

/** identidade de quem pediu (vem do gateway, nunca do payload do cliente) */
interface VoiceCtx {
  userId: string;
  sessionId: string;
}

/** sala por canal de voz: router + observer + índices para consume/cleanup */
interface VoiceRoom {
  channelId: string;
  router: types.Router;
  observer: types.AudioLevelObserver;
  /** producers vivos do canal (id → producer) — consume valida "mesmo canal" por aqui */
  producers: Map<string, types.Producer>;
  /** sessionIds presentes — quando esvazia, o router fecha (o worker fica) */
  sessions: Set<string>;
  /** user_ids acima do limiar AGORA — broadcast só quando este conjunto muda */
  speaking: Set<string>;
}

/** tudo que uma sessão de gateway criou em voz — o mapa do cleanup total */
interface VoiceSession {
  sessionId: string;
  userId: string;
  room: VoiceRoom;
  selfMute: boolean;
  selfDeaf: boolean;
  transports: Map<string, types.WebRtcTransport>;
  producers: Map<string, types.Producer>;
  consumers: Map<string, types.Consumer>;
  /** timers de transporte moribundo (ICE disconnected), por transport.id */
  deadTimers: Map<string, NodeJS.Timeout>;
}

/**
 * Valida o `p` de um método com o schema do protocolo. O ZodError cru é um
 * JSON enorme — para o fio (op 21, campo error) uma frase curta basta. Issues
 * "custom" vêm dos superRefine do protocolo (ex.: kind×source do produce do
 * M5) e já são frases curtas em pt-BR — essas viajam como estão, porque são
 * mais úteis que a genérica.
 */
function parseParams<T>(schema: z.ZodType<T>, method: string, p: unknown): T {
  const result = schema.safeParse(p);
  if (!result.success) {
    const custom = result.error.issues.find((issue) => issue.code === "custom");
    throw new Error(custom?.message ?? `parâmetros inválidos para "${method}"`);
  }
  return result.data;
}

/** source gravada no appData pelo produce — nunca vem de payload de cliente */
function producerSource(producer: types.Producer): ProducerSource | undefined {
  return (producer.appData as { source?: ProducerSource }).source;
}

export class Voice {
  /** sessão de voz por gateway session — UMA por sessionId, por contrato */
  private readonly sessions = new Map<string, VoiceSession>();
  /** salas vivas por channel_id (routers lazy) */
  private readonly rooms = new Map<string, VoiceRoom>();
  /** criação de sala em andamento — dois joins simultâneos compartilham a promise */
  private readonly roomPending = new Map<string, Promise<VoiceRoom>>();

  /**
   * Fan-out de eventos — atribuído pelo integrador (gateway.broadcast).
   * O Voice não conhece o Gateway de propósito; só este funil de saída.
   */
  broadcast!: <T extends DispatchName>(t: T, d: Extract<DispatchEvent, { t: T }>["d"]) => void;

  private constructor(
    private readonly store: Store,
    private readonly worker: types.Worker,
    private readonly webRtcServer: types.WebRtcServer,
  ) {}

  /**
   * Sobe o worker (portas RTC presas em config.rtcPort) e UM WebRtcServer com
   * UDP e TCP na mesma porta — é a única porta que o firewall/hostPort expõe;
   * todos os transports de todos os routers se penduram nele.
   */
  static async create(store: Store): Promise<Voice> {
    const worker = await createWorker({
      logLevel: "warn",
      rtcMinPort: config.rtcPort,
      rtcMaxPort: config.rtcPort,
    });
    // 'died' é irrecuperável (crash do processo C++): a voz fica fora do ar
    // até o processo reiniciar. Único console.error do módulo — condição fatal.
    worker.on("died", () => {
      console.error("mediasoup worker morreu — voz indisponível até reiniciar o servidor");
    });
    const webRtcServer = await worker.createWebRtcServer({
      listenInfos: [
        // announcedAddress: ICE-lite anuncia ISTO nos candidatos, não a interface
        { protocol: "udp", ip: config.rtcListenIp, announcedAddress: config.rtcAnnouncedIp, port: config.rtcPort },
        { protocol: "tcp", ip: config.rtcListenIp, announcedAddress: config.rtcAnnouncedIp, port: config.rtcPort },
      ],
    });
    return new Voice(store, worker, webRtcServer);
  }

  /**
   * Dispatcher da sinalização (op 20 → op 21 via gateway.onVoiceRequest):
   * valida o `p` com o schema do método e executa. Exceção daqui vira
   * { ok: false, error } no gateway — mensagens curtas em pt-BR de propósito.
   */
  async handleRequest(ctx: VoiceCtx, m: string, p: unknown): Promise<unknown> {
    // SERIALIZAÇÃO por gateway session (revisão M3, achados 1 e 6): dois joins
    // — ou um leave no meio de um join — da MESMA sessão intercalados nos
    // awaits do worker deixavam router/sessão órfãos permanentes (reproduzido).
    // Cada sessão processa uma operação de voz por vez, em ordem de chegada.
    return this.chainOp(ctx.sessionId, () => this.dispatch(ctx, m, p));
  }

  private readonly opChains = new Map<string, Promise<unknown>>();

  private chainOp<T>(sessionId: string, op: () => Promise<T> | T): Promise<T> {
    const prev = this.opChains.get(sessionId) ?? Promise.resolve();
    // o erro da operação anterior pertence a quem a pediu — a fila continua
    const next = prev.catch(() => undefined).then(op);
    this.opChains.set(sessionId, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.opChains.get(sessionId) === next) this.opChains.delete(sessionId);
      });
    return next;
  }

  private async dispatch(ctx: VoiceCtx, m: string, p: unknown): Promise<unknown> {
    // o fio é snake_case, mas normalizar camelCase ("createTransport") custa
    // uma regex e elimina uma classe inteira de quebra boba na integração
    const method = m.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    switch (method) {
      case "join":
        return this.join(ctx, parseParams(VoiceJoinParams, method, p));
      case "create_transport":
        return this.createTransport(ctx, parseParams(VoiceCreateTransportParams, method, p));
      case "connect_transport":
        return this.connectTransport(ctx, parseParams(VoiceConnectTransportParams, method, p));
      case "produce":
        return this.produce(ctx, parseParams(VoiceProduceParams, method, p));
      case "close_producer":
        return this.closeProducer(ctx, parseParams(VoiceCloseProducerParams, method, p));
      case "consume":
        return this.consume(ctx, parseParams(VoiceConsumeParams, method, p));
      case "resume_consumer":
        return this.resumeConsumer(ctx, parseParams(VoiceResumeConsumerParams, method, p));
      case "pause_consumer":
        return this.pauseConsumer(ctx, parseParams(VoicePauseConsumerParams, method, p));
      case "close_consumer":
        return this.closeConsumer(ctx, parseParams(VoiceCloseConsumerParams, method, p));
      case "set_preferred_layers":
        return this.setPreferredLayers(ctx, parseParams(VoiceSetPreferredLayersParams, method, p));
      case "restart_ice":
        return this.restartIce(ctx, parseParams(VoiceRestartIceParams, method, p));
      case "update_state":
        return this.updateState(ctx, parseParams(VoiceUpdateStateParams, method, p));
      case "leave": {
        // idempotente: leave sem estar em voz é um no-op, não um erro
        const session = this.sessions.get(ctx.sessionId);
        if (session) this.doLeave(session);
        return {};
      }
      default:
        throw new Error(`método de voz desconhecido: "${m}"`);
    }
  }

  /** Sessão de gateway saiu do mapa DE VEZ (resume expirou) → leave se estava em voz. */
  sessionGone(ctx: VoiceCtx): void {
    // pela MESMA fila das requests: um sessionGone no meio de um join em voo
    // esperaria o join registrar e só então faria o leave completo
    void this.chainOp(ctx.sessionId, () => {
      const session = this.sessions.get(ctx.sessionId);
      if (session) this.doLeave(session);
    });
  }

  /** Snapshot para o READY (o integrador chama ao montar o ReadyData). */
  voiceStates(): VoiceState[] {
    return [...this.sessions.values()].map((s) => this.toVoiceState(s));
  }

  /** Shutdown do processo: derruba todas as sessões e o worker (cascata fecha o resto). */
  close(): void {
    // cópia: doLeave remove do mapa durante a iteração
    for (const session of [...this.sessions.values()]) this.doLeave(session);
    // fechar o worker fecha WebRtcServer, routers e observers em cadeia
    this.worker.close();
  }

  // -------------------------------------------------------------------------
  // Métodos de sinalização
  // -------------------------------------------------------------------------

  private async join(ctx: VoiceCtx, p: VoiceJoinParams): Promise<unknown> {
    // id não-numérico faria BigInt() lançar no store — mesma defesa das rotas REST
    if (!/^\d{1,20}$/.test(p.channel_id) || !this.store.channelExists(p.channel_id, "voice")) {
      throw new Error("canal de voz inexistente");
    }

    // UMA sessão de voz por usuário E por gateway session: qualquer presença
    // anterior — outra aba do mesmo usuário, ou esta sessão em outro canal —
    // sai antes (leave implícito, com todos os broadcasts de praxe)
    for (const other of [...this.sessions.values()]) {
      if (other.userId === ctx.userId || other.sessionId === ctx.sessionId) this.doLeave(other);
    }

    const room = await this.getOrCreateRoom(p.channel_id);
    // revalidações pós-await (revisão M3): a fila serializa ESTA sessão, mas
    // outra sessão do mesmo usuário pode ter entrado durante a criação do
    // router (kick re-executado), e o room pode ter fechado se o último
    // ocupante saiu nesse meio-tempo
    for (const other of [...this.sessions.values()]) {
      if (other.userId === ctx.userId || other.sessionId === ctx.sessionId) this.doLeave(other);
    }
    if (room.router.closed) throw new Error("canal fechou durante o join — tente de novo");
    const session: VoiceSession = {
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      room,
      selfMute: false,
      selfDeaf: false,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      deadTimers: new Map(),
    };
    this.sessions.set(ctx.sessionId, session);
    room.sessions.add(ctx.sessionId);
    this.broadcast("VOICE_STATE_UPDATE", this.toVoiceState(session));

    // producers já ativos vão na resposta: VOICE_NEW_PRODUCER só alcançou quem
    // estava conectado na hora do produce — o recém-chegado recebe o estoque
    // aqui, no mesmo formato do evento (o cliente filtra o próprio user_id).
    // O source (M5) viaja junto: telas do estoque NÃO são consumidas no join,
    // só atualizam o estado — viewers assistem sob demanda (doc §3.6).
    const producers = [...room.producers.values()].map((producer) => ({
      channel_id: room.channelId,
      user_id: (producer.appData as { userId?: string }).userId ?? "",
      producer_id: producer.id,
      kind: producer.kind,
      // todo producer nasce com source no appData (o produce exige) — o
      // fallback casado com o kind é inalcançável, só acalma o type system
      source: producerSource(producer) ?? (producer.kind === "audio" ? "mic" : "camera"),
    }));
    return { rtp_capabilities: room.router.rtpCapabilities, producers };
  }

  private async createTransport(ctx: VoiceCtx, p: VoiceCreateTransportParams): Promise<unknown> {
    const session = this.mustSession(ctx);
    // teto por sessão (revisão M3 #7): um cliente com bug/malícia em loop de
    // create_transport alocaria estado ICE/DTLS sem limite no worker
    if (session.transports.size >= MAX_TRANSPORTS_PER_SESSION) {
      throw new Error("limite de transports da sessão atingido");
    }
    const transport = await session.room.router.createWebRtcTransport({
      webRtcServer: this.webRtcServer,
      enableUdp: true,
      enableTcp: true,
      // TCP só como fallback de firewall hostil — UDP primeiro sempre
      preferUdp: true,
      appData: { direction: p.direction },
    });
    try {
      // revalidação pós-await (revisão M3 #2, reproduzido): se o doLeave desta
      // sessão rodou durante a criação, registrar aqui penduraria um transport
      // vivo num objeto morto — nada o fecharia até o router do canal cair
      if (this.sessions.get(ctx.sessionId) !== session) {
        throw new Error("sessão saiu da voz durante a operação");
      }
      if (p.direction === "send") {
        // teto de entrada por transport — dimensionado para opus + simulcast
        // de vídeo do M4 (o integrador ajusta o valor em config §9)
        await transport.setMaxIncomingBitrate(config.rtcMaxIncomingBitrate);
      }
      if (this.sessions.get(ctx.sessionId) !== session) {
        throw new Error("sessão saiu da voz durante a operação");
      }
    } catch (err) {
      transport.close();
      throw err;
    }
    session.transports.set(transport.id, transport);
    this.watchTransport(session, transport);
    return {
      transport_id: transport.id,
      ice_parameters: transport.iceParameters,
      ice_candidates: transport.iceCandidates,
      dtls_parameters: transport.dtlsParameters,
    };
  }

  private async connectTransport(ctx: VoiceCtx, p: VoiceConnectTransportParams): Promise<unknown> {
    const session = this.mustSession(ctx);
    // lookup no mapa DA SESSÃO: um transport_id alheio responde erro, não vaza
    const transport = session.transports.get(p.transport_id);
    if (!transport) throw new Error("transport desconhecido");
    // dtls_parameters é blob do mediasoup-client — o worker valida o formato
    await transport.connect({ dtlsParameters: p.dtls_parameters as types.DtlsParameters });
    return {};
  }

  private async produce(ctx: VoiceCtx, p: VoiceProduceParams): Promise<unknown> {
    const session = this.mustSession(ctx);
    // REGRAS POR SOURCE (M5, doc §3.5/§3.6) — o pareamento kind×source já foi
    // validado pelo schema do protocolo; aqui entram as políticas:
    // cada source é única por sessão (mic e camera como no M3/M4; screen e
    // screen_audio idem). Vem ANTES do teto genérico: uma sessão cheia
    // repetindo source merece o erro específico, não o do limite.
    const hasSource = (src: ProducerSource): boolean =>
      [...session.producers.values()].some((pr) => producerSource(pr) === src);
    // Semântica de RESTART (revisão M5 #3): produce de source que a sessão já
    // tem FECHA o antigo e substitui, em vez de rejeitar. Rejeitar deixava um
    // producer fantasma (WS caído entre o request e a resposta do produce)
    // travando a source para sempre — e, no caso da screen, o PALCO DO CANAL
    // inteiro (política 1-por-canal). Repor é sempre o que o dono quer; o
    // fantasma morre com os VOICE_PRODUCER_CLOSED de praxe.
    const existingSame = [...session.producers.values()].find((pr) => producerSource(pr) === p.source);
    if (existingSame !== undefined) {
      this.closeOneProducer(session, existingSame);
      if (p.source === "screen") {
        // a cascata do closeProducer: soundshare não sobrevive sem a tela
        const soundshare = [...session.producers.values()].find((pr) => producerSource(pr) === "screen_audio");
        if (soundshare !== undefined) this.closeOneProducer(session, soundshare);
      }
    }
    // com as 4 sources únicas o teto é inalcançável — fica como defesa em
    // profundidade contra drift futuro (revisão M3 #7)
    if (session.producers.size >= MAX_PRODUCERS_PER_SESSION) {
      throw new Error("limite de producers da sessão atingido");
    }
    // política do doc §3.6: UMA transmissão de tela por CANAL — qualquer
    // outra sessão da sala com screen viva barra esta (a própria sessão já
    // foi barrada acima, então tudo que a sala tem aqui é alheio)
    if (p.source === "screen" && this.roomHasScreen(session.room)) {
      throw new Error("já existe uma transmissão neste canal");
    }
    // soundshare acompanha a tela (doc §3.5): screen_audio sem screen viva na
    // MESMA sessão seria um producer órfão sem sentido
    if (p.source === "screen_audio" && !hasSource("screen")) {
      throw new Error("compartilhar áudio exige uma transmissão de tela ativa");
    }
    const transport = session.transports.get(p.transport_id);
    if (!transport) throw new Error("transport desconhecido");
    if ((transport.appData as { direction?: string }).direction !== "send") {
      throw new Error("produce exige um transport send");
    }
    const producer = await transport.produce({
      kind: p.kind,
      rtpParameters: p.rtp_parameters as types.RtpParameters,
      // appData.{userId,source} é o elo producer→usuário/política: observer,
      // VOICE_NEW_PRODUCER e as regras do M5 mapeiam por aqui (nunca confiar
      // em payload de cliente para isso)
      appData: { userId: session.userId, source: p.source },
    });
    // registro SÓ depois do observer aceitar (revisão M3 #8): registrar antes
    // deixaria, num addProducer falho, um producer vivo, invisível e sem
    // broadcast; e a revalidação pós-await (#2/#9) fecha o recurso se o
    // doLeave desta sessão intercalou com os awaits
    try {
      if (this.sessions.get(ctx.sessionId) !== session) {
        throw new Error("sessão saiu da voz durante a operação");
      }
      // revalidação pós-await (padrão M3): a fila serializa ESTA sessão, mas
      // OUTRA sessão pode ter começado uma transmissão durante o
      // transport.produce — sem re-checar, o canal ficaria com duas telas.
      // (screen_audio não precisa do espelho: a screen da própria sessão só
      // some por caminhos serializados na mesma fila ou pelo doLeave, que a
      // checagem de identidade acima já cobre.)
      if (p.source === "screen" && this.roomHasScreen(session.room)) {
        throw new Error("já existe uma transmissão neste canal");
      }
      // GUARD (contrato M4→M5): o audioLevelObserver alimenta o "quem fala" —
      // SÓ source "mic" entra nele; screen_audio no observer deixaria o
      // streamer "falando" para sempre enquanto a mídia da tela tocar
      if (p.source === "mic") {
        await session.room.observer.addProducer({ producerId: producer.id });
        if (this.sessions.get(ctx.sessionId) !== session) {
          throw new Error("sessão saiu da voz durante a operação");
        }
      }
    } catch (err) {
      producer.close();
      throw err;
    }
    session.producers.set(producer.id, producer);
    session.room.producers.set(producer.id, producer);
    // broadcast simples para todos (inclusive o dono): o cliente filtra o
    // próprio user_id — ninguém consome a si mesmo; kind diz COMO consumir e
    // source diz SE consumir (screen/screen_audio são sob demanda, M5)
    this.broadcast("VOICE_NEW_PRODUCER", {
      channel_id: session.room.channelId,
      user_id: session.userId,
      producer_id: producer.id,
      kind: producer.kind,
      source: p.source,
    });
    // câmera ligou → self_video mudou; tela ligou → self_stream (badge AO
    // VIVO) mudou — ambos derivados de "producer da source vivo"; a lista de
    // participantes vive do VOICE_STATE_UPDATE
    if (p.source === "camera" || p.source === "screen") {
      this.broadcast("VOICE_STATE_UPDATE", this.toVoiceState(session));
    }
    return { producer_id: producer.id };
  }

  /** Alguma sessão da sala transmite tela AGORA? (política 1-por-canal, doc §3.6) */
  private roomHasScreen(room: VoiceRoom): boolean {
    for (const pr of room.producers.values()) {
      if (producerSource(pr) === "screen" && !pr.closed) return true;
    }
    return false;
  }

  /**
   * M4: fecha UM producer sem sair da voz (desligar a câmera; M5 soma parar a
   * transmissão de tela). O close() cascateia nos consumers remotos (o worker
   * os mata; o handler de 'producerclose' de cada sessão limpa o mapa) e o
   * VOICE_PRODUCER_CLOSED avisa os clientes — o mesmo par de efeitos do
   * doLeave, mas cirúrgico. M5: fechar a screen fecha TAMBÉM o screen_audio
   * da mesma sessão, se existir (defesa: soundshare órfão sem tela não faz
   * sentido), com o VOICE_PRODUCER_CLOSED de ambos e o VOICE_STATE_UPDATE de
   * self_stream=false. Síncrono de ponta a ponta: sem await, sem janela para
   * revalidar.
   */
  private closeProducer(ctx: VoiceCtx, p: VoiceCloseProducerParams): unknown {
    const session = this.mustSession(ctx);
    // lookup no mapa DA SESSÃO: producer alheio responde erro, não fecha nada
    const producer = session.producers.get(p.producer_id);
    if (!producer) throw new Error("producer desconhecido");
    const source = producerSource(producer);
    this.closeOneProducer(session, producer);
    if (source === "screen") {
      // o cliente normal fecha só a tela e conta com esta cascata; um cliente
      // que fechar os dois recebe "producer desconhecido" no segundo — inócuo
      const soundshare = [...session.producers.values()].find((pr) => producerSource(pr) === "screen_audio");
      if (soundshare !== undefined) this.closeOneProducer(session, soundshare);
    }
    if (source === "camera" || source === "screen") {
      // câmera desligou → self_video false; tela parou → self_stream false —
      // a lista de participantes atualiza por aqui, não pelo PRODUCER_CLOSED
      this.broadcast("VOICE_STATE_UPDATE", this.toVoiceState(session));
    } else if (source === "mic") {
      // espelho do doLeave: fechou o mic enquanto "falava" → corrige o
      // conjunto já, sem esperar o tick do observer (screen_audio nunca entra
      // no observer, então fechá-lo não mexe no speaking)
      const stillHasMic = [...session.producers.values()].some((pr) => producerSource(pr) === "mic");
      if (!stillHasMic && session.room.speaking.has(session.userId)) {
        const next = new Set(session.room.speaking);
        next.delete(session.userId);
        this.setSpeaking(session.room, next);
      }
    }
    return {};
  }

  /** Fecha um producer e broadcasta o VOICE_PRODUCER_CLOSED dele (miolo do closeProducer). */
  private closeOneProducer(session: VoiceSession, producer: types.Producer): void {
    session.producers.delete(producer.id);
    session.room.producers.delete(producer.id);
    producer.close();
    this.broadcast("VOICE_PRODUCER_CLOSED", {
      channel_id: session.room.channelId,
      producer_id: producer.id,
    });
  }

  private async consume(ctx: VoiceCtx, p: VoiceConsumeParams): Promise<unknown> {
    const session = this.mustSession(ctx);
    if (session.consumers.size >= MAX_CONSUMERS_PER_SESSION) {
      throw new Error("limite de consumers da sessão atingido");
    }
    const transport = session.transports.get(p.transport_id);
    if (!transport) throw new Error("transport desconhecido");
    // o mapa do room é a fronteira do canal: producer de OUTRO canal (ou já
    // fechado) simplesmente não está aqui → erro
    const producer = session.room.producers.get(p.producer_id);
    if (!producer) throw new Error("producer inexistente neste canal");
    const rtpCapabilities = p.rtp_capabilities as types.RtpCapabilities;
    if (!session.room.router.canConsume({ producerId: producer.id, rtpCapabilities })) {
      throw new Error("rtp_capabilities incompatíveis com o producer");
    }
    // paused: true é a prática recomendada do mediasoup — evita perder os
    // primeiros pacotes/keyframe; o cliente dá resume_consumer depois de
    // plugar o track no <audio>
    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: true,
    });
    // revalidação pós-await (revisão M3 #2) — recurso não entra em sessão morta
    if (this.sessions.get(ctx.sessionId) !== session) {
      consumer.close();
      throw new Error("sessão saiu da voz durante a operação");
    }
    session.consumers.set(consumer.id, consumer);
    // producer fechou → o worker mata o consumer sozinho; só tira do mapa
    // para não acumular referência morta (o cliente sabe pelo
    // VOICE_PRODUCER_CLOSED e fecha o lado dele)
    consumer.on("producerclose", () => session.consumers.delete(consumer.id));
    return {
      consumer_id: consumer.id,
      producer_id: producer.id,
      kind: consumer.kind,
      rtp_parameters: consumer.rtpParameters,
    };
  }

  private async resumeConsumer(ctx: VoiceCtx, p: VoiceResumeConsumerParams): Promise<unknown> {
    const session = this.mustSession(ctx);
    const consumer = session.consumers.get(p.consumer_id);
    if (!consumer) throw new Error("consumer desconhecido");
    await consumer.resume();
    return {};
  }

  /**
   * M4 (doc §8): tile de vídeo saiu de tela → pausa o consumer — o worker
   * PARA de encaminhar RTP deste assinante (economia real de egress, não é
   * esconder na UI). resume_consumer religa. Espelho exato do resumeConsumer:
   * nada é registrado após o await, então não há o que revalidar.
   */
  private async pauseConsumer(ctx: VoiceCtx, p: VoicePauseConsumerParams): Promise<unknown> {
    const session = this.mustSession(ctx);
    const consumer = session.consumers.get(p.consumer_id);
    if (!consumer) throw new Error("consumer desconhecido");
    await consumer.pause();
    return {};
  }

  /**
   * M5 (doc §3.6): o viewer PAROU de assistir uma transmissão — libera o
   * consumer no servidor de vez. Diferente do pause (que deixa o consumer
   * alocado para religar barato), o close devolve os recursos: é a economia
   * real do modelo "viewers sob demanda". Lookup no mapa DA SESSÃO (alheio =
   * erro), como todos os métodos de consumer. Síncrono de ponta a ponta
   * (padrão M3): sem await, nada a revalidar.
   */
  private closeConsumer(ctx: VoiceCtx, p: VoiceCloseConsumerParams): unknown {
    const session = this.mustSession(ctx);
    const consumer = session.consumers.get(p.consumer_id);
    if (!consumer) throw new Error("consumer desconhecido");
    session.consumers.delete(consumer.id);
    consumer.close();
    return {};
  }

  /**
   * M4 (doc §3.4): camada de simulcast que ESTE assinante quer — 0/1/2 na
   * escala 150k/500k/1,5M do produce do cliente. Por consumer, de propósito:
   * cada assinante dimensiona pelo tamanho do SEU tile, sem afetar os demais.
   */
  private async setPreferredLayers(ctx: VoiceCtx, p: VoiceSetPreferredLayersParams): Promise<unknown> {
    const session = this.mustSession(ctx);
    const consumer = session.consumers.get(p.consumer_id);
    if (!consumer) throw new Error("consumer desconhecido");
    // áudio não tem camadas — pedir camada nele é bug de cliente, erro claro
    if (consumer.kind !== "video") throw new Error("set_preferred_layers exige um consumer de vídeo");
    await consumer.setPreferredLayers({ spatialLayer: p.spatial_layer });
    return {};
  }

  private async restartIce(ctx: VoiceCtx, p: VoiceRestartIceParams): Promise<unknown> {
    const session = this.mustSession(ctx);
    const transport = session.transports.get(p.transport_id);
    if (!transport) throw new Error("transport desconhecido");
    const iceParameters = await transport.restartIce();
    return { ice_parameters: iceParameters };
  }

  private updateState(ctx: VoiceCtx, p: VoiceUpdateStateParams): unknown {
    const session = this.mustSession(ctx);
    session.selfMute = p.self_mute;
    session.selfDeaf = p.self_deaf;
    // só flags declarativos: o mute REAL é o cliente desligar o track
    // (track.enabled) — pause/resume de producer server-side NÃO é deste
    // milestone, de propósito
    this.broadcast("VOICE_STATE_UPDATE", this.toVoiceState(session));
    return {};
  }

  // -------------------------------------------------------------------------
  // Salas (router por canal, lazy)
  // -------------------------------------------------------------------------

  private async getOrCreateRoom(channelId: string): Promise<VoiceRoom> {
    const existing = this.rooms.get(channelId);
    // router.closed cobre a corrida rara "canal esvaziou entre o get e o uso"
    if (existing && !existing.router.closed) return existing;
    let pending = this.roomPending.get(channelId);
    if (!pending) {
      pending = this.createRoom(channelId).then(
        (room) => {
          this.rooms.set(channelId, room);
          this.roomPending.delete(channelId);
          return room;
        },
        (err: unknown) => {
          this.roomPending.delete(channelId);
          throw err;
        },
      );
      this.roomPending.set(channelId, pending);
    }
    return pending;
  }

  private async createRoom(channelId: string): Promise<VoiceRoom> {
    const router = await this.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    const observer = await router.createAudioLevelObserver({
      // default de maxEntries é 1 (só o mais alto) — queremos TODOS os que falam
      maxEntries: SPEAKING_MAX_ENTRIES,
      threshold: SPEAKING_THRESHOLD_DB,
      interval: config.rtcSpeakingIntervalMs,
    });
    const room: VoiceRoom = {
      channelId,
      router,
      observer,
      producers: new Map(),
      sessions: new Set(),
      speaking: new Set(),
    };
    // 'volumes' traz os producers ACIMA do limiar no último intervalo — o
    // conjunto novo substitui o anterior por inteiro; 'silence' esvazia.
    // setSpeaking só broadcasta quando o conjunto de fato muda.
    observer.on("volumes", (volumes) => {
      const next = new Set<string>();
      for (const { producer } of volumes) {
        const userId = (producer.appData as { userId?: string }).userId;
        if (userId !== undefined) next.add(userId);
      }
      this.setSpeaking(room, next);
    });
    observer.on("silence", () => this.setSpeaking(room, new Set()));
    return room;
  }

  private setSpeaking(room: VoiceRoom, next: Set<string>): void {
    const unchanged = next.size === room.speaking.size && [...next].every((id) => room.speaking.has(id));
    if (unchanged) return;
    room.speaking = next;
    // ordenado para o payload ser determinístico (facilita teste e diff)
    this.broadcast("VOICE_SPEAKING", { channel_id: room.channelId, speaking: [...next].sort() });
  }

  // -------------------------------------------------------------------------
  // Saúde do transporte e saída
  // -------------------------------------------------------------------------

  private watchTransport(session: VoiceSession, transport: types.WebRtcTransport): void {
    // DTLS 'failed'/'closed' é terminal — não há recuperação, a sessão sai já
    transport.on("dtlsstatechange", (state) => {
      if (state === "failed" || state === "closed") this.doLeave(session);
    });
    // ICE 'disconnected' pode ser um blip (troca de rede, sleep): dá uma
    // janela de DEAD_TRANSPORT_GRACE_MS; 'connected'/'completed' (voltou, ou
    // via restart_ice) cancela o timer; estourou → leave
    transport.on("icestatechange", (state) => {
      if (state === "disconnected") {
        if (session.deadTimers.has(transport.id)) return; // timer já corre
        const timer = setTimeout(() => this.doLeave(session), DEAD_TRANSPORT_GRACE_MS);
        timer.unref(); // não segura o processo vivo no shutdown
        session.deadTimers.set(transport.id, timer);
      } else if (state === "connected" || state === "completed") {
        const timer = session.deadTimers.get(transport.id);
        if (timer !== undefined) {
          clearTimeout(timer);
          session.deadTimers.delete(transport.id);
        }
      }
    });
  }

  /**
   * O ÚNICO caminho de saída — leave explícito, join implícito por cima,
   * sessionGone, transporte morto e close() convergem todos aqui.
   * Idempotente: eventos atrasados de transport (após a saída) não fazem nada.
   */
  private doLeave(session: VoiceSession): void {
    // a checagem de identidade (e não só de presença) cobre o caso de a MESMA
    // gateway session ter re-entrado: o objeto antigo não pode derrubar o novo
    if (this.sessions.get(session.sessionId) !== session) return;
    this.sessions.delete(session.sessionId);

    for (const timer of session.deadTimers.values()) clearTimeout(timer);
    session.deadTimers.clear();

    const room = session.room;

    // producers primeiro: quem consome este usuário fica sabendo que acabou
    for (const producer of session.producers.values()) {
      room.producers.delete(producer.id);
      producer.close();
      this.broadcast("VOICE_PRODUCER_CLOSED", { channel_id: room.channelId, producer_id: producer.id });
    }
    session.producers.clear();

    for (const consumer of session.consumers.values()) consumer.close();
    session.consumers.clear();

    for (const transport of session.transports.values()) transport.close();
    session.transports.clear();

    room.sessions.delete(session.sessionId);

    // saiu falando? corrige o conjunto já, sem esperar o próximo tick do observer
    if (room.speaking.has(session.userId)) {
      const next = new Set(room.speaking);
      next.delete(session.userId);
      this.setSpeaking(room, next);
    }

    this.broadcast("VOICE_STATE_UPDATE", {
      user_id: session.userId,
      channel_id: null, // null no fio = saiu de voz
      self_mute: session.selfMute,
      self_deaf: session.selfDeaf,
      self_video: false, // os producers (câmera inclusa) já caíram todos acima
      self_stream: false, // idem para a tela (M5) — a cascata fechou tudo
    });

    // canal esvaziou → o router fecha (observer e transports caem em cascata);
    // o worker fica — a sala renasce lazy no próximo join
    if (room.sessions.size === 0) {
      if (this.rooms.get(room.channelId) === room) this.rooms.delete(room.channelId);
      room.router.close();
    }
  }

  private mustSession(ctx: VoiceCtx): VoiceSession {
    const session = this.sessions.get(ctx.sessionId);
    if (!session) throw new Error("sessão não está em voz — faça join primeiro");
    return session;
  }

  private toVoiceState(session: VoiceSession): VoiceState {
    const producers = [...session.producers.values()];
    return {
      user_id: session.userId,
      channel_id: session.room.channelId,
      self_mute: session.selfMute,
      self_deaf: session.selfDeaf,
      // DERIVADOS, nunca declarados (contrato M4→M5): câmera ligada = producer
      // source "camera" vivo; transmitindo (badge AO VIVO) = source "screen"
      // vivo — os flags não conseguem mentir sobre a mídia
      self_video: producers.some((pr) => producerSource(pr) === "camera" && !pr.closed),
      self_stream: producers.some((pr) => producerSource(pr) === "screen" && !pr.closed),
    };
  }
}
