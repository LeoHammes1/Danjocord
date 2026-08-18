import { Device } from "mediasoup-client";

/**
 * Flag de teste com dupla persistência, de propósito: (a) o boot() do main.ts
 * limpa a query string antes de qualquer join, então ler na hora do clique já
 * seria tarde; (b) o vite dá full reload a cada edição, e a recarga nasce com
 * a URL limpa — sessionStorage (por aba) mantém o flag vivo entre reloads sem
 * vazar para outras abas.
 */
const FAKE_AUDIO = (() => {
  if (new URLSearchParams(location.search).get("fakeaudio") === "1") {
    sessionStorage.setItem("danjocord_fakeaudio", "1");
  }
  return sessionStorage.getItem("danjocord_fakeaudio") === "1";
})();
import type {
  Consumer,
  DtlsParameters,
  IceCandidate,
  IceParameters,
  Producer,
  RtpCapabilities,
  RtpParameters,
  Transport,
} from "mediasoup-client/types";

/**
 * Cliente de voz (M3, doc §3.6) + vídeo (M4, doc §3.4) sobre mediasoup-client.
 * Este módulo cuida SÓ de mídia e sinalização: quem está em qual canal / quem
 * fala agora é estado de UI, alimentado pelos dispatches VOICE_* no main.ts. A
 * comunicação com o servidor passa inteira pelo request() do gateway (op
 * 20/21), injetado no construtor como função — e não como instância, porque o
 * AuthGateway do main.ts é descartado e recriado a cada renovação de token.
 *
 * Fluxo do join: request("join") → Device.load(rtp_capabilities do router) →
 * create_transport send+recv (com connect/produce pendurados nos eventos do
 * mediasoup-client) → getUserMedia → produce(opus DTX+FEC) → consome os
 * producers que já existiam no canal.
 *
 * Vídeo (M4): toggleCamera produz simulcast de 3 camadas — VP8 por padrão,
 * H.264 preferido em capturas ≥1080p (encode por hardware, até 4K) — no MESMO send
 * transport; consumeVideo entrega um <video> à UI (onVideoTile) e o consumer
 * só acorda quando a UI declara o tile visível (setTileVisibility) — grade
 * colapsada = pause_consumer no servidor, economia real de banda (doc §8).
 *
 * Screen share (M5, doc §3.5/§3.6): toggleStream captura a tela (até 4K@30,
 * contentHint "detail" — nitidez de texto vence fps) e produz source "screen"
 * SEM simulcast (+ "screen_audio" se o navegador entregou o som da aba);
 * viewers são SOB DEMANDA: ninguém consome a tela ao ser anunciada —
 * watchStream consome quando o usuário clica em "Assistir" (UM stream por
 * vez) e stopWatching devolve a banda com close_consumer (o servidor LIBERA
 * o consumer; pause só o deixaria alocado).
 *
 * Controles de saída e de captura (M9, itens 33–40): o áudio de cada consumer
 * deixou de tocar solto num <audio> e passa por uma cadeia WebAudio
 * (MediaStreamSource → GainNode do usuário → GainNode mestre → destino), que é
 * o que torna possível volume por usuário (0..200%) e mute LOCAL. O deafen
 * virou REAL — pause_consumer em todos os consumers de áudio, não só mudar o
 * elemento — e a captura ficou configurável (dispositivo de entrada/saída,
 * echoCancellation/noiseSuppression/autoGainControl, medidor de nível do
 * próprio mic). getConnectionStats() lê o getStats() dos dois transports.
 *
 * Métodos no fio (m do op 20), casando com os schemas Voice*Params do
 * protocolo: "join", "create_transport", "connect_transport", "produce",
 * "consume", "resume_consumer", "restart_ice", "update_state", "leave",
 * "close_producer", "pause_consumer", "set_preferred_layers",
 * "close_consumer". O M9 NÃO acrescentou método nenhum: o deafen real reusa
 * pause_consumer/resume_consumer, que já existiam para os tiles de vídeo.
 */

/** Assinatura do GatewayClient.request — o main.ts injeta um delegador. */
export type VoiceRequestFn = (m: string, p?: unknown) => Promise<unknown>;

/**
 * Processamento do microfone (M9, item 39). Os três eram fixos em `true` dentro
 * do captureAudio; agora são estado, porque num headset bom o AGC "bombeia" e a
 * supressão de ruído come o começo das palavras — quem sabe o que faz precisa
 * poder desligar.
 */
export interface AudioProcessing {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

/**
 * Dispositivos disponíveis (M9, item 38). **Os `label` vêm VAZIOS enquanto o
 * navegador não tiver concedido permissão de mídia** — é regra dele, não bug:
 * antes do primeiro getUserMedia a lista existe, mas anônima. A UI deve pedir
 * permissão (ou entrar na voz) antes de mostrar o seletor.
 */
export interface VoiceDevices {
  audioInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
}

/** Veredito resumido de getConnectionStats — os limiares estão em qualityOf(). */
export type ConnectionQuality = "boa" | "media" | "ruim" | "desconhecida";

/**
 * Qualidade da conexão de mídia (M9, item 40). **Metade do getStats é
 * CUMULATIVA** (bytes, pacotes, perdas contam desde o início da sessão): o que
 * vale é a DIFERENÇA entre duas amostras, e é isso que estes campos são —
 * exceto rtt e jitter, que já são instantâneos. Por isso a PRIMEIRA chamada
 * volta com os campos de taxa/perda em null: não há amostra anterior com que
 * comparar. Chame a cada 1–2 s.
 */
export interface ConnectionStats {
  /** ida-e-volta até o servidor, em ms (remote-inbound-rtp; cai no par ICE) */
  rttMs: number | null;
  /** variação de chegada dos pacotes que RECEBEMOS, em ms — jitter alto = voz picotada */
  jitterMs: number | null;
  /** % dos nossos pacotes que o servidor NÃO recebeu (o que ele reporta de volta) */
  sendLossPct: number | null;
  /** % dos pacotes do servidor que não chegaram aqui */
  recvLossPct: number | null;
  /** taxa de subida no intervalo entre as duas amostras */
  sendKbps: number | null;
  /** taxa de descida no intervalo entre as duas amostras */
  recvKbps: number | null;
  quality: ConnectionQuality;
}

/**
 * Simulcast de 3 camadas ADAPTATIVO (doc §3.4 + requisito de até 4K): a
 * câmera sempre envia as três e o servidor escolhe qual repassar por
 * assinante (set_preferred_layers). As camadas escalam da CAPTURA REAL —
 * 4K: 2160p@10M / 1080p@2,5M / 540p@800k; 720p: 720p@1,5M / 360p@500k /
 * 180p@150k. A ordem do array É a ordem das camadas espaciais no mediasoup.
 */
function simulcastEncodingsFor(height: number): { maxBitrate: number; scaleResolutionDownBy?: number }[] {
  const top =
    height >= 2000 ? 10_000_000
    : height >= 1300 ? 6_000_000
    : height >= 1000 ? 3_500_000
    : height >= 700 ? 1_500_000
    : 800_000;
  return [
    { maxBitrate: Math.max(150_000, Math.round(top / 12)), scaleResolutionDownBy: 4 },
    { maxBitrate: Math.max(400_000, Math.round(top / 4)), scaleResolutionDownBy: 2 },
    { maxBitrate: top },
  ];
}

/**
 * Origem do producer no fio (M5) — espelha o ProducerSource do protocolo. O
 * kind virou detalhe de transporte: a ROTA de consumo é decidida pelo source
 * (mic → <audio>; camera → tile; screen/screen_audio → viewers sob demanda).
 */
type ProducerSourceWire = "mic" | "camera" | "screen" | "screen_audio";

/**
 * Linha do getStats que nos interessa (M9, item 40). O RTCStatsReport do
 * lib.dom é um `ReadonlyMap<string, any>`: os campos por tipo não são tipados,
 * então declaramos só o punhado que lemos, todo opcional — o resto de cada
 * relatório continua sendo ignorado sem drama.
 */
interface StatsRow {
  type?: string;
  bytesSent?: number;
  packetsSent?: number;
  bytesReceived?: number;
  packetsReceived?: number;
  packetsLost?: number;
  /** segundos (RTCP) — vira ms na saída */
  jitter?: number;
  roundTripTime?: number;
  currentRoundTripTime?: number;
  /** candidate-pair: só o par "succeeded" é o caminho em uso */
  state?: string;
}

/** uma casa decimal — porcentagem de perda com 12 dígitos não ajuda ninguém */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Veredito de qualidade (item 40). Limiares pensados para VOZ, que é o uso
 * dominante: acima de ~300 ms de ida-e-volta a conversa começa a atropelar, e
 * ~5% de perda já picota mesmo com o FEC do Opus. `worstLoss` é a pior das
 * duas direções; `anyLoss` diz se ALGUMA medida de perda existe — sem rtt e
 * sem perda não há o que julgar (primeira amostra, ou transport recém-nascido).
 */
function qualityOf(rttMs: number | null, worstLoss: number, anyLoss: number | null): ConnectionQuality {
  if (rttMs === null && anyLoss === null) return "desconhecida";
  if ((rttMs !== null && rttMs > 300) || worstLoss > 5) return "ruim";
  if ((rttMs !== null && rttMs > 150) || worstLoss > 2) return "media";
  return "boa";
}

/** Respostas do servidor (blobs do mediasoup viajam como unknown, doc §3.6). */
interface JoinResponse {
  rtp_capabilities: unknown;
  /** producers que JÁ existiam no canal — o recém-chegado consome todos */
  producers?: { user_id: string; producer_id: string; kind?: string; source?: string }[];
}
interface CreateTransportResponse {
  transport_id: string;
  ice_parameters: unknown;
  ice_candidates: unknown;
  dtls_parameters: unknown;
}
interface ConsumeResponse {
  consumer_id: string;
  producer_id: string;
  kind: string;
  rtp_parameters: unknown;
}

export class VoiceClient {
  /** UI re-renderiza (canal/estado/mute/deafen/câmera mudou) — atribuído pelo main.ts */
  onChange?: () => void;
  /**
   * UI recebe (el) ou remove (null) um tile de vídeo REMOTO — atribuído pelo
   * main.ts. O preview local não passa por aqui: é o próprio cameraTrack num
   * <video> mudo montado pela UI (ninguém consome a si mesmo).
   */
  onVideoTile?: (userId: string, producerId: string, el: HTMLVideoElement | null) => void;
  /**
   * UI recebe um tile-placeholder quando o consume de vídeo falhou DE VEZ —
   * hoje só rtp_capabilities incompatíveis (assinante sem o codec do
   * produtor, ex. build Chromium sem H.264; rev. M4 #2). A remoção sai pelo
   * onVideoTile normal (el null) quando o producer fechar ou a voz cair.
   */
  onVideoTileFailed?: (userId: string, producerId: string, reason: string) => void;
  /**
   * UI recebe (el) ou remove (null) o <video> GRANDE do stream assistido (M5)
   * — atribuído pelo main.ts. UM por vez: um el novo nunca chega sem o null
   * do anterior antes. O estado de "assistindo" vive AQUI; o main.ts só
   * renderiza o painel com o que este callback entrega.
   */
  onStreamView?: (userId: string, el: HTMLVideoElement | null) => void;

  private channel: string | null = null;
  private phase: "idle" | "connecting" | "connected" = "idle";
  private selfMute = false;
  private selfDeaf = false;
  /** mute imposto pelo deafen (para desfazer no un-deafen); null = mute manual */
  private mutedBeforeDeafen: boolean | null = null;

  // --- push-to-talk (M6, só desktop) ---
  /** modo PTT ligado: o mic só abre com a tecla segurada (setPttPressed) */
  private pttOn = false;
  /** a tecla de PTT está segurada AGORA — alimentado pelo onPtt da ponte, via main.ts */
  private pttDown = false;

  private device: Device | null = null;
  private sendTransport: Transport | null = null;
  private recvTransport: Transport | null = null;
  private producer: Producer | null = null;
  private micTrack: MediaStreamTrack | null = null;
  /** gancho de teste ?fakeaudio=1 — guardado para parar oscilador e contexto */
  private fakeAudio: { ctx: AudioContext; osc: OscillatorNode } | null = null;

  // (o flag em si é lido no load do módulo — ver FAKE_AUDIO no topo)

  // --- câmera (M4) ---
  /** producer de vídeo simulcast — no MESMO send transport do áudio */
  private videoProducer: Producer | null = null;
  private camTrack: MediaStreamTrack | null = null;
  /** gancho de teste (mesmo FAKE_AUDIO): cancela o requestAnimationFrame do canvas */
  private fakeVideo: { stop: () => void } | null = null;
  /** trava de reentrância: clique duplo no 📷 durante o prompt de permissão */
  private cameraStarting = false;

  // --- transmissão de tela (M5, doc §3.5) ---
  /** producer da tela (source "screen") — stream único, SEM simulcast */
  private streamProducer: Producer | null = null;
  /** producer do soundshare (source "screen_audio") — só existe com a tela viva */
  private streamAudioProducer: Producer | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private screenAudioTrack: MediaStreamTrack | null = null;
  /** gancho de teste (mesmo FAKE_AUDIO): cancela o requestAnimationFrame da "tela" */
  private fakeScreen: { stop: () => void } | null = null;
  /** trava de reentrância: clique duplo no 🖥️ durante o seletor de tela */
  private streamStarting = false;

  // --- assistir stream (M5, viewers sob demanda — doc §3.6) ---
  /**
   * producer_id remoto → dono e origem (screen/screen_audio), alimentado
   * pelos eventos (VOICE_NEW_PRODUCER via registerStreamProducer) e pelo
   * estoque do join. NADA aqui é consumido ao chegar — é o índice que o
   * clique em "Assistir" usa para achar o producer certo.
   */
  private readonly remoteStreams = new Map<string, { userId: string; source: "screen" | "screen_audio" }>();
  /** stream assistido (UM por vez): <video> grande + consumers (tela e soundshare) */
  private watching: {
    userId: string;
    screenProducerId: string;
    video: HTMLVideoElement;
    stream: MediaStream;
    /** producer_id → consumer — o soundshare entra aqui quando consumido */
    consumers: Map<string, Consumer>;
  } | null = null;
  /** trava de reentrância: clique duplo em "Assistir" durante a sinalização */
  private watchStarting = false;

  /**
   * producer_id → consumer de ÁUDIO e a cadeia que o toca (M9). O <audio> não
   * é mais quem faz o som: ele é uma BOMBA (ver ensureChain) e fica sempre
   * mudo; quem toca é `chain`. Continua guardado para cleanup e para o
   * fallback de quando o WebAudio não sobe.
   */
  private readonly consumers = new Map<
    string,
    {
      consumer: Consumer;
      audio: HTMLAudioElement;
      /** dono do producer — chave do volume/mute por usuário (item 33/36) */
      userId: string;
      /** null = WebAudio indisponível; o volume cai no próprio elemento */
      chain: { source: MediaStreamAudioSourceNode; gain: GainNode } | null;
      /** pausado NO SERVIDOR (deafen real, item 35) — nasce true se entrarmos ensurdecidos */
      paused: boolean;
    }
  >();
  /** producer_id → consumer de VÍDEO + <video> entregue à UI + estado do tile (M4) */
  private readonly videoConsumers = new Map<
    string,
    { consumer: Consumer; video: HTMLVideoElement; userId: string; desiredLayer: number | null; visible: boolean }
  >();
  /** producer_id → user_id de vídeos que NÃO dá para consumir (codec) — a UI mostra placeholder (rev. M4 #2) */
  private readonly failedVideoTiles = new Map<string, string>();
  /** consumes em voo — dedup entre o lote do join e um VOICE_NEW_PRODUCER cruzado */
  private readonly consuming = new Set<string>();
  /** VOICE_NEW_PRODUCER chegado durante o join — drenado quando conectar (rev. M3 #4); o M5 carrega source e user_id junto */
  private pendingProducers: { producerId: string; userId: string; source: ProducerSourceWire }[] = [];

  // --- saída de áudio: cadeia WebAudio compartilhada (M9, itens 33/35/36) ---
  /**
   * UM AudioContext para TODA a voz — separado do de `sound/player.ts` de
   * propósito: aquele é do módulo de som (com destravamento por gesto e
   * preload) e não expõe o contexto. Dois contextos custam um device de saída
   * cada; em troca, nenhum dos dois mexe no estado do outro.
   */
  private audioCtx: AudioContext | null = null;
  /** nó mestre — é ele que o deafen zera NA HORA (o pause_consumer é assíncrono) */
  private masterGain: GainNode | null = null;
  /** WebAudio já falhou uma vez: não adianta tentar de novo a cada consumer */
  private audioGraphFailed = false;
  /** user_id → volume 0..2 (1 = 100%). Preferência: NÃO some no teardown. */
  private readonly userVolumes = new Map<string, number>();
  /** usuários que EU silenciei localmente (item 33). Preferência: sobrevive ao leave. */
  private readonly userLocalMutes = new Set<string>();
  /** dispositivo de SAÍDA escolhido (item 38); null = default do sistema */
  private outputDeviceId: string | null = null;
  /** dispositivos de ENTRADA escolhidos (item 38); null = default do sistema */
  private micDeviceId: string | null = null;
  private cameraDeviceId: string | null = null;
  /** item 39: era fixo em true dentro do captureAudio */
  private processing: AudioProcessing = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  /** medidor do próprio mic (item 39) — um por vez; o stop devolvido desmonta */
  private levelWatch: {
    cb: (level: number) => void;
    analyser: AnalyserNode;
    /** dreno mudo: sem caminho até o destino o grafo não é "puxado" (ver onLocalLevel) */
    sink: GainNode;
    source: MediaStreamAudioSourceNode | null;
    /** o parâmetro do getFloatTimeDomainData exige o buffer NÃO compartilhado */
    data: Float32Array<ArrayBuffer>;
    timer: number;
  } | null = null;
  /** amostra anterior do getStats (item 40) — o delta é o que vale; ver ConnectionStats */
  private statsSample: {
    epoch: number;
    at: number;
    sendBytes: number;
    sendPackets: number;
    sendLost: number;
    recvBytes: number;
    recvPackets: number;
    recvLost: number;
  } | null = null;
  /**
   * Mute imposto por um ADMIN (item 34). O enforcement de verdade é no
   * servidor (ele pausa o nosso producer); isto aqui é o espelho local — o mic
   * fecha de fato e a UI sabe que desmutar não adianta.
   */
  private serverMute = false;

  /**
   * Geração da sessão de mídia: todo await no join/consume captura o valor e
   * compara na volta — um leave/re-join no meio invalida a continuação antiga
   * (sem isso, trocar de canal durante um join em voo misturaria transports
   * de dois canais).
   */
  private epoch = 0;

  constructor(private readonly request: VoiceRequestFn) {}

  get channelId(): string | null {
    return this.channel;
  }
  get connected(): boolean {
    return this.phase === "connected";
  }
  get muted(): boolean {
    return this.selfMute;
  }
  get deafened(): boolean {
    return this.selfDeaf;
  }
  /**
   * Um admin me silenciou (item 34). Enquanto for true o microfone fica
   * fechado por baixo do mute próprio: a UI deve mostrar o botão de mic
   * travado, senão o usuário fica clicando em "desmutar" sem efeito nenhum.
   */
  get serverMuted(): boolean {
    return this.serverMute;
  }
  /** dispositivos escolhidos (item 38) — null = default do sistema */
  get inputDeviceIds(): { audio: string | null; video: string | null } {
    return { audio: this.micDeviceId, video: this.cameraDeviceId };
  }
  get outputDevice(): string | null {
    return this.outputDeviceId;
  }
  /** cópia: o chamador não altera o estado interno por referência */
  get audioProcessing(): AudioProcessing {
    return { ...this.processing };
  }
  get cameraOn(): boolean {
    return this.videoProducer !== null;
  }
  /** track local da câmera — a UI monta o preview com ele (nunca passa pelo servidor) */
  get cameraTrack(): MediaStreamTrack | null {
    return this.camTrack;
  }
  /** transmitindo a tela (M5) — o botão 🖥️ acende por aqui; o badge AO VIVO vem do self_stream */
  get streamOn(): boolean {
    return this.streamProducer !== null;
  }
  /** user_id do stream que estamos assistindo (M5) — null = nenhum */
  get watchingUserId(): string | null {
    return this.watching?.userId ?? null;
  }

  /** producer de TELA anunciado de um usuário — o clique em "Assistir" da UI acha o id por aqui. */
  streamProducerIdOf(userId: string): string | null {
    for (const [producerId, info] of this.remoteStreams) {
      if (info.userId === userId && info.source === "screen") return producerId;
    }
    return null;
  }

  /**
   * Entra num canal de voz. Se já estamos em OUTRO canal, a mídia local cai
   * antes — o servidor faz o leave implícito no join, não precisa de request
   * "leave" separado. Idempotente para o MESMO canal.
   */
  async join(channelId: string): Promise<void> {
    if (this.channel === channelId && this.phase !== "idle") return;
    this.teardown();
    const epoch = ++this.epoch;
    this.channel = channelId;
    this.phase = "connecting";
    this.onChange?.();

    try {
      const joined = (await this.request("join", { channel_id: channelId })) as JoinResponse;
      if (epoch !== this.epoch) return;

      // Device é de uso único (load() só aceita uma vez) — um novo por join
      const device = new Device();
      await device.load({ routerRtpCapabilities: joined.rtp_capabilities as RtpCapabilities });
      if (epoch !== this.epoch) return;
      this.device = device;

      // padrão local-var → checa epoch → fecha se stale → SÓ ENTÃO atribui
      // (revisão M3 #5): atribuir antes de checar poluía o campo do join novo
      // e deixava uma RTCPeerConnection viva vazando ICE
      const send = await this.createTransport("send", device);
      if (epoch !== this.epoch) {
        send.close();
        return;
      }
      this.sendTransport = send;
      const recv = await this.createTransport("recv", device);
      if (epoch !== this.epoch) {
        recv.close();
        return;
      }
      this.recvTransport = recv;

      const track = await this.captureAudio();
      if (epoch !== this.epoch) {
        track.stop(); // join morreu durante o prompt de permissão do mic
        return;
      }
      this.micTrack = track;

      // DTX: silêncio quase não gasta banda; FEC: resiliência a perda (doc §3.6)
      const producer = await send.produce({
        track,
        codecOptions: { opusDtx: true, opusFec: true },
        appData: { source: "mic" }, // M5: origem no fio (o handler de "produce" repassa)
      });
      if (epoch !== this.epoch) {
        producer.close();
        return;
      }
      // microfone desplugado / permissão revogada pela UI do navegador —
      // paridade com o trackended da câmera (rev. M4 #4): sem isto a sessão
      // de voz fica "viva" e muda até um leave manual. A recuperação tenta o
      // default uma vez antes de desistir (recoverMic).
      producer.on("trackended", () => {
        if (this.producer !== producer) return;
        void this.recoverMic(producer);
      });
      this.producer = producer;
      // mute/deafen sobrevivem à troca de canal (como no Discord)
      this.applyMute();

      this.phase = "connected";
      this.onChange?.();
      // o servidor assume join com flags zerados — só avisa se entramos "sujos"
      if (this.selfMute || this.selfDeaf) void this.pushState();

      // quem já estava no canal antes de nós: mic/camera consomem já; TELA e
      // soundshare NÃO — viram só estado em remoteStreams (viewers sob
      // demanda, doc §3.6: quem não clicou em "Assistir" não gasta banda)
      for (const p of joined.producers ?? []) {
        const source = (p.source ?? (p.kind === "video" ? "camera" : "mic")) as ProducerSourceWire;
        if (source === "screen" || source === "screen_audio") {
          this.remoteStreams.set(p.producer_id, { userId: p.user_id, source });
          continue;
        }
        const task =
          source === "camera"
            ? this.consumeVideo(p.user_id, p.producer_id)
            : this.consume(p.producer_id, p.user_id);
        void task.catch((err: unknown) => console.warn("voz: consume inicial falhou", err));
      }
      // e quem produziu DURANTE o nosso join (a janela inclui o prompt de
      // microfone, que dura segundos) ficou na fila — drena agora (rev. M3 #4);
      // tela na fila segue a mesma política do estoque: só atualiza o estado
      for (const pend of this.pendingProducers.splice(0)) {
        if (pend.source === "screen" || pend.source === "screen_audio") {
          this.remoteStreams.set(pend.producerId, { userId: pend.userId, source: pend.source });
          continue;
        }
        const task =
          pend.source === "camera"
            ? this.consumeVideo(pend.userId, pend.producerId)
            : this.consume(pend.producerId, pend.userId);
        void task.catch((err: unknown) => console.warn("voz: consume pendente falhou", err));
      }
    } catch (err) {
      // falhou no meio: não fica "meio dentro" — zera tudo e propaga para a
      // UI. O join pode ter COMPLETADO no servidor (o mic negado vem depois):
      // um leave de melhor esforço apaga o fantasma que ficaria no canal até
      // a gateway session morrer (revisão M3 #3)
      if (epoch === this.epoch) {
        this.leaveLocal();
        void this.request("leave", {}).catch(() => undefined);
      }
      throw err;
    }
  }

  /**
   * Reconciliação (revisão M3 #3): o servidor diz que estamos em voz mas
   * localmente estamos idle — acontece quando o WS caiu no meio de um join
   * que completou lá. Um leave de melhor esforço apaga o fantasma.
   */
  reconcile(serverChannelId: string | null): void {
    if (serverChannelId !== null && this.phase === "idle") {
      void this.request("leave", {}).catch(() => undefined);
    }
  }

  /**
   * VOICE_STATE_UPDATE null do PRÓPRIO usuário: kick real (transporte morto,
   * outra sessão entrou) ou só o eco do leave que NÓS pedimos? O eco chega
   * atrasado e, num sair-e-entrar rápido, mataria o join novo em voo
   * (reproduzido em verificação) — a janela de supressão o distingue.
   */
  onSelfRemoved(): void {
    if (Date.now() < this.suppressSelfNullUntil) return;
    if (this.channel !== null) this.leaveLocal();
  }

  private suppressSelfNullUntil = 0;

  /** Sai da voz: mídia local cai já; o "leave" no servidor é melhor esforço. */
  async leave(): Promise<void> {
    if (this.channel === null) return; // idempotente
    this.suppressSelfNullUntil = Date.now() + 5000;
    this.leaveLocal();
    try {
      await this.request("leave", {});
    } catch {
      // sessão pode nem estar em voz no servidor (leave por timeout lá) — ok
    }
  }

  /**
   * Derruba SÓ a mídia local, sem falar com o servidor. Usada quando o estado
   * do servidor já era (logout, sessão morta com re-Identify, kick por outra
   * sessão do mesmo usuário) — mandar "leave" seria redundante ou impossível.
   */
  leaveLocal(): void {
    this.teardown();
    this.epoch += 1; // invalida continuações async de join/consume em voo
    this.channel = null;
    this.phase = "idle";
    this.onChange?.();
  }

  /**
   * Consome um producer remoto: consume (o servidor cria PAUSADO — best
   * practice mediasoup) → recvTransport.consume → track na cadeia WebAudio do
   * dono → resume_consumer só com a cadeia montada.
   *
   * `userId` (M9) é quem produziu: é a chave do volume e do mute local. É
   * OPCIONAL só para não quebrar chamadores antigos — sem ele o áudio toca em
   * 100% e ignora o mute local do usuário, então o call site do
   * VOICE_NEW_PRODUCER deve passá-lo.
   */
  async consume(producerId: string, userId?: string): Promise<void> {
    if (this.phase === "connecting") {
      // producer nascido durante o nosso join: descartar seria mudez permanente
      // até um re-join (revisão M3 #4) — guarda e o fim do join drena
      if (!this.pendingProducers.some((p) => p.producerId === producerId)) {
        this.pendingProducers.push({ producerId, userId: userId ?? "", source: "mic" });
      }
      return;
    }
    const device = this.device;
    const recv = this.recvTransport;
    if (device === null || recv === null) return; // não estamos em voz
    // dedup: o lote do join e um VOICE_NEW_PRODUCER podem trazer o mesmo id
    if (this.consumers.has(producerId) || this.consuming.has(producerId)) return;
    this.consuming.add(producerId);
    const epoch = this.epoch;
    try {
      const r = (await this.request("consume", {
        transport_id: recv.id,
        producer_id: producerId,
        rtp_capabilities: device.rtpCapabilities,
      })) as ConsumeResponse;
      if (epoch !== this.epoch) return;

      const consumer = await recv.consume({
        id: r.consumer_id,
        producerId: r.producer_id,
        kind: r.kind as "audio" | "video",
        rtpParameters: r.rtp_parameters as RtpParameters,
      });
      if (epoch !== this.epoch) {
        consumer.close();
        return;
      }

      const stream = new MediaStream([consumer.track]);
      // ARMADILHA DO CHROMIUM (não "limpe" este elemento): um MediaStream que
      // veio de WebRTC só ANDA se estiver plugado num sink de mídia — se ele
      // existir apenas dentro do WebAudio, o MediaStreamAudioSourceNode entrega
      // SILÊNCIO (crbug 933677; o workaround é o mesmo dos samples oficiais do
      // WebRTC). Por isso o <audio> continua aqui, vivo e MUDO: ele bombeia os
      // pacotes, quem toca é a cadeia. Quando o WebAudio não sobe (chain null),
      // este mesmo elemento vira o tocador de verdade — daí ele nascer mudo e
      // o applyAudioLevels decidir depois.
      const audio = new Audio();
      audio.autoplay = true;
      audio.srcObject = stream;
      audio.muted = true;
      this.applyOutputDevice(audio);
      const owner = userId ?? "";
      const entry = {
        consumer,
        audio,
        userId: owner,
        chain: this.buildChain(stream, this.effectiveVolume(owner)),
        // quem entra ensurdecido nasce PAUSADO no servidor (item 35): nem RTP
        // vem, e o un-deafen resume junto com os outros
        paused: this.selfDeaf,
      };
      this.consumers.set(producerId, entry);
      this.applyAudioLevels(entry);
      // autoplay: o join nasceu de um clique, então costuma passar; se o
      // navegador barrar mesmo assim, só avisa — destrava na próxima interação
      audio.play().catch((err: unknown) => console.warn("voz: play() rejeitado", err));

      if (entry.paused) return; // ensurdecido: o resume é o un-deafen quem dá
      try {
        await this.request("resume_consumer", { consumer_id: consumer.id });
      } catch (err) {
        // consumer pausado para sempre seria um zumbi inaudível segurando um
        // <audio> — remove; um re-join reconstrói o consumo do canal inteiro
        this.closeConsumer(producerId);
        throw err;
      }
      // ensurdeceu DURANTE o resume: o sync do deafen já passou por aqui e não
      // viu este consumer (ou viu antes do resume) — repõe o estado desejado
      if (this.selfDeaf && this.consumers.get(producerId) === entry) {
        void this.setConsumerPaused(entry, true);
      }
    } finally {
      this.consuming.delete(producerId);
    }
  }

  /**
   * Consome um producer de VÍDEO (M4): mesmo fluxo do áudio, mas o track vai
   * num <video muted autoplay playsinline> entregue à UI via onVideoTile — e
   * SEM resume aqui: o consumer nasce pausado no servidor e só acorda quando
   * a UI declara o tile visível (setTileVisibility), a economia do doc §8.
   */
  async consumeVideo(userId: string, producerId: string): Promise<void> {
    if (this.phase === "connecting") {
      // mesma fila do áudio (rev. M3 #4): o fim do join drena com o source certo
      if (!this.pendingProducers.some((p) => p.producerId === producerId)) {
        this.pendingProducers.push({ producerId, userId, source: "camera" });
      }
      return;
    }
    const device = this.device;
    const recv = this.recvTransport;
    if (device === null || recv === null) return; // não estamos em voz
    // dedup: o lote do join e um VOICE_NEW_PRODUCER podem trazer o mesmo id
    if (this.videoConsumers.has(producerId) || this.consuming.has(producerId) || this.failedVideoTiles.has(producerId))
      return;
    this.consuming.add(producerId);
    const epoch = this.epoch;
    try {
      let r: ConsumeResponse;
      try {
        r = (await this.request("consume", {
          transport_id: recv.id,
          producer_id: producerId,
          rtp_capabilities: device.rtpCapabilities,
        })) as ConsumeResponse;
      } catch (err) {
        // canConsume=false no servidor: assinante sem o codec do produtor —
        // permanente, nenhum retry resolve. Sem isto o sintoma era invisível
        // (📷 aceso na lista, tile nenhum): a UI ganha um placeholder no
        // lugar do <video> (rev. M4 #2)
        if (epoch === this.epoch && err instanceof Error && err.message.includes("rtp_capabilities")) {
          console.warn("voz: vídeo sem codec em comum com o produtor", producerId);
          this.failedVideoTiles.set(producerId, userId);
          this.onVideoTileFailed?.(userId, producerId, "codec incompatível");
          return;
        }
        throw err;
      }
      if (epoch !== this.epoch) return;

      const consumer = await recv.consume({
        id: r.consumer_id,
        producerId: r.producer_id,
        kind: r.kind as "audio" | "video",
        rtpParameters: r.rtp_parameters as RtpParameters,
      });
      if (epoch !== this.epoch) {
        consumer.close();
        return;
      }

      // muted+autoplay+playsinline dispensa gesto do usuário em qualquer
      // navegador — o som da pessoa já chega pelo consumer de ÁUDIO dela
      const video = document.createElement("video");
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute("playsinline", ""); // Safari antigo lê o atributo, não a propriedade
      video.srcObject = new MediaStream([consumer.track]);
      this.videoConsumers.set(producerId, { consumer, video, userId, desiredLayer: null, visible: false });
      this.onVideoTile?.(userId, producerId, video);
    } finally {
      this.consuming.delete(producerId);
    }
  }

  /**
   * A UI declara se um tile está visível: visível → resume_consumer (+ a
   * camada preferida escolhida enquanto estava oculto); oculto (grade
   * colapsada) → pause_consumer — o servidor PARA de encaminhar RTP, economia
   * real de banda e não só display:none (doc §8).
   */
  async setTileVisibility(producerId: string, visible: boolean): Promise<void> {
    const entry = this.videoConsumers.get(producerId);
    if (entry === undefined || entry.visible === visible) return;
    // otimista ANTES do await: toggles rápidos se dedupam por aqui; se o
    // request falhar, o flag fica adiantado e o próximo toggle re-sincroniza
    entry.visible = visible;
    try {
      if (visible) {
        await this.request("resume_consumer", { consumer_id: entry.consumer.id });
        // revalidação pós-await: o tile pode ter morrido (teardown/producer
        // fechado) durante o resume — não sinaliza camada de consumer morto
        if (entry.desiredLayer !== null && this.videoConsumers.get(producerId) === entry) {
          await this.request("set_preferred_layers", {
            consumer_id: entry.consumer.id,
            spatial_layer: entry.desiredLayer,
          });
        }
      } else {
        await this.request("pause_consumer", { consumer_id: entry.consumer.id });
      }
    } catch (err) {
      // pausa/resume perdido não quebra a mídia — só custa banda até o
      // próximo toggle; consumer já morto no servidor responde erro inócuo
      console.warn("voz: visibilidade do tile falhou", err);
    }
  }

  /** Escolhe a camada espacial do simulcast por tile (relativa à captura: 0=/4, 1=/2, 2=inteira). */
  async setTileLayer(producerId: string, spatial: number): Promise<void> {
    const entry = this.videoConsumers.get(producerId);
    if (entry === undefined || entry.desiredLayer === spatial) return; // dedup — a UI repete sem custo
    entry.desiredLayer = spatial;
    if (!entry.visible) return; // pausado não gasta banda; aplica no próximo resume
    try {
      await this.request("set_preferred_layers", { consumer_id: entry.consumer.id, spatial_layer: spatial });
    } catch (err) {
      console.warn("voz: set_preferred_layers falhou", err);
    }
  }

  /**
   * Liga/desliga a webcam (M4). Ligar = captura + produce simulcast de 3
   * camadas no MESMO send transport do áudio (o servidor broadcasta
   * VOICE_NEW_PRODUCER kind video + self_video true); desligar =
   * close_producer no servidor (broadcast VOICE_PRODUCER_CLOSED + self_video
   * false) e track.stop() local. O preview local é a UI que monta, com
   * cameraTrack — o dono nunca consome o próprio producer.
   */
  async toggleCamera(): Promise<void> {
    if (this.videoProducer !== null) {
      const producerId = this.videoProducer.id;
      this.stopCameraLocal();
      this.onChange?.();
      try {
        await this.request("close_producer", { producer_id: producerId });
      } catch (err) {
        // melhor esforço, como o leave: se falhar, o producer fantasma cai
        // na cascata do doLeave quando a sessão sair da voz
        console.warn("voz: close_producer falhou", err);
      }
      return;
    }
    if (this.phase !== "connected" || this.sendTransport === null) return; // câmera só com a voz de pé
    if (this.cameraStarting) return; // clique duplo durante o prompt de permissão
    const send = this.sendTransport;
    this.cameraStarting = true;
    const epoch = this.epoch;
    try {
      const track = await this.captureVideo();
      // padrão local-var do M3 #5: recurso stale fecha ANTES de qualquer
      // atribuição — leave/re-join no meio do prompt da câmera não vaza track
      if (epoch !== this.epoch) {
        track.stop();
        if (this.fakeVideo !== null) {
          // o canvas fake é sempre NOSSO aqui (cameraStarting trava reentrância)
          this.fakeVideo.stop();
          this.fakeVideo = null;
        }
        return;
      }
      // atribuído antes do produce DE PROPÓSITO: se o teardown intercalar com
      // o await abaixo, ele já sabe parar este track (e o check de epoch na
      // volta fecha o producer órfão)
      this.camTrack = track;
      // camadas derivadas da CAPTURA REAL (a constraint pede até 4K; a câmera
      // entrega o que tem) — e codec pela resolução: ≥1080p prefere H.264,
      // cujo encode por hardware é o que torna 4K viável (VP8 4K em software
      // derrete CPU; doc §3.5). min(w,h): portrait não superclassifica tier.
      const settings = track.getSettings();
      const height = Math.min(settings.width ?? 640, settings.height ?? 360);
      // caps de ENVIO, não de recepção (revisão M4 #3): um device que só
      // DECODIFICA H.264 tem o codec nas recv caps e o produce com ele
      // lançaria — a câmera falharia inteira em vez de cair para VP8
      const h264 =
        height >= 1000
          ? this.device?.sendRtpCapabilities.codecs?.find((c) => c.mimeType.toLowerCase() === "video/h264")
          : undefined;
      let producer: Producer;
      try {
        producer = await send.produce({
          track,
          encodings: simulcastEncodingsFor(height),
          ...(h264 !== undefined && { codec: h264 }),
          // rampa inicial de 500 kbps: sem isso o BWE começa conservador e a
          // primeira camada útil demora segundos para destravar (doc §3.4)
          codecOptions: { videoGoogleStartBitrate: 500 },
          appData: { source: "camera" }, // M5: origem no fio (o handler de "produce" repassa)
        });
      } catch (err) {
        // produce recusado (2º producer de vídeo, transport caindo): a câmera
        // não pode ficar acesa falando com ninguém
        if (epoch === this.epoch) this.stopCameraLocal();
        throw err;
      }
      if (epoch !== this.epoch) {
        producer.close(); // o teardown já parou track e canvas; sobra só o producer órfão
        return;
      }
      // webcam desplugada / permissão revogada pela UI do navegador (revisão
      // M4 #4): sem isto o self_video ficaria fantasma para todos e o botão
      // aceso — o mesmo caminho do desligar manual resolve
      producer.on("trackended", () => {
        if (this.videoProducer !== producer) return;
        const producerId = producer.id;
        this.stopCameraLocal();
        this.onChange?.();
        void this.request("close_producer", { producer_id: producerId }).catch(() => undefined);
      });
      this.videoProducer = producer;
      this.onChange?.();
    } finally {
      this.cameraStarting = false;
    }
  }

  /**
   * Liga/desliga a transmissão de tela (M5, doc §3.5). Ligar = getDisplayMedia
   * (até 4K@30) → contentHint "detail" no track de vídeo (nitidez de texto
   * vence fps) → produce source "screen" SEM simulcast — o viewer assiste num
   * painel grande, então camadas só pagariam encode extra de screen content —
   * com maxBitrate por tier da captura REAL; se o navegador entregou áudio
   * (aba/sistema), ele vira um produce source "screen_audio". Desligar =
   * close_producer da TELA — o servidor derruba o soundshare junto (contrato
   * M5) — e tracks.stop() local.
   */
  async toggleStream(): Promise<void> {
    if (this.streamProducer !== null) {
      const producerId = this.streamProducer.id;
      // local primeiro (tela E soundshare): a UI reage já; o servidor fecha o
      // par inteiro a partir do close_producer da tela
      this.stopStreamLocal();
      this.onChange?.();
      try {
        await this.request("close_producer", { producer_id: producerId });
      } catch (err) {
        // melhor esforço, como a câmera: o fantasma cai na cascata do doLeave
        console.warn("voz: close_producer da tela falhou", err);
      }
      return;
    }
    if (this.phase !== "connected" || this.sendTransport === null) return; // transmitir só com a voz de pé
    if (this.streamStarting) return; // clique duplo durante o seletor de tela
    const send = this.sendTransport;
    this.streamStarting = true;
    const epoch = this.epoch;
    try {
      const capture = await this.captureScreen();
      // padrão local-var do M3 #5: recurso stale fecha ANTES de qualquer
      // atribuição — leave/re-join no meio do seletor não vaza track
      if (epoch !== this.epoch) {
        capture.video.stop();
        capture.audio?.stop();
        if (this.fakeScreen !== null) {
          // o canvas fake é sempre NOSSO aqui (streamStarting trava reentrância)
          this.fakeScreen.stop();
          this.fakeScreen = null;
        }
        return;
      }
      // atribuídos antes do produce DE PROPÓSITO (padrão da câmera): se o
      // teardown intercalar com os awaits, ele já sabe parar estes tracks
      this.screenTrack = capture.video;
      this.screenAudioTrack = capture.audio;
      // tier de bitrate pela captura REAL — min(w,h): portrait não
      // superclassifica; tela 4K de texto precisa de bitrate alto para o
      // "detail" não virar borrão (contrato M5)
      const settings = capture.video.getSettings();
      const dim = Math.min(settings.width ?? 1280, settings.height ?? 720);
      const maxBitrate =
        dim >= 2000 ? 12_000_000
        : dim >= 1300 ? 8_000_000
        : dim >= 1000 ? 5_000_000
        : 2_500_000;
      // mesmo critério de codec da câmera (revisão M5 #1): ≥1080p prefere
      // H.264 — encode por hardware é o que torna tela 4K viável; VP8 4K em
      // software derrete CPU e, com contentHint detail, o sacrifício sai todo
      // em fps. Caps de ENVIO (um device que só decodifica H.264 cai no VP8).
      const h264 =
        dim >= 1000
          ? this.device?.sendRtpCapabilities.codecs?.find((c) => c.mimeType.toLowerCase() === "video/h264")
          : undefined;
      let producer: Producer;
      try {
        producer = await send.produce({
          track: capture.video,
          // stream ÚNICO, sem simulcast (contrato M5): o viewer assiste em
          // painel grande — camadas não pagam o custo de encode de screen content
          encodings: [{ maxBitrate }],
          ...(h264 !== undefined && { codec: h264 }),
          appData: { source: "screen" },
        });
      } catch (err) {
        // produce recusado (já existe transmissão neste canal — política
        // §3.6 —, transport caindo): a captura não fica acesa no vácuo
        if (epoch === this.epoch) this.stopStreamLocal();
        throw err;
      }
      if (epoch !== this.epoch) {
        producer.close(); // o teardown já parou os tracks; sobra só o producer órfão
        return;
      }
      // botão "Parar compartilhamento" do NAVEGADOR (mesmo padrão do
      // trackended da câmera, rev. M4 #4): sem isto o badge AO VIVO ficaria
      // fantasma para todos — o caminho é o mesmo do desligar manual
      producer.on("trackended", () => {
        if (this.streamProducer !== producer) return;
        const producerId = producer.id;
        this.stopStreamLocal();
        this.onChange?.();
        void this.request("close_producer", { producer_id: producerId }).catch(() => undefined);
      });
      this.streamProducer = producer;
      this.onChange?.();

      // soundshare: só quando o usuário marcou "compartilhar áudio" no
      // seletor (aba/sistema) — o navegador decide se entrega o track
      if (this.screenAudioTrack !== null) {
        try {
          const audioProducer = await send.produce({
            track: this.screenAudioTrack,
            // SEM DTX de propósito: áudio de mídia é contínuo — DTX cortaria
            // o ataque de cada som depois de silêncio (o mic usa DTX; §3.5)
            appData: { source: "screen_audio" },
          });
          if (epoch !== this.epoch) {
            audioProducer.close(); // o teardown já parou o track; a cascata do leave limpa o servidor
            return;
          }
          if (this.streamProducer !== producer) {
            // a tela caiu durante o produce do áudio (trackended): soundshare
            // órfão sem tela não faz sentido — fecha e sinaliza
            audioProducer.close();
            void this.request("close_producer", { producer_id: audioProducer.id }).catch(() => undefined);
            return;
          }
          this.streamAudioProducer = audioProducer;
        } catch (err) {
          // soundshare recusado mas a TELA vive: transmite mudo, só avisa
          console.warn("voz: produce do soundshare falhou — transmitindo sem áudio", err);
          this.screenAudioTrack?.stop();
          this.screenAudioTrack = null;
        }
      }
    } finally {
      this.streamStarting = false;
    }
  }

  /**
   * Registra um producer de tela/soundshare REMOTO (VOICE_NEW_PRODUCER com
   * source screen/screen_audio — o main.ts NÃO consome esses, só delega o
   * anúncio para cá). Se o soundshare do usuário que JÁ assistimos chegar
   * atrasado (viewer clicou entre o anúncio da tela e o do áudio), pluga o
   * som no stream aberto.
   */
  registerStreamProducer(userId: string, producerId: string, source: "screen" | "screen_audio"): void {
    if (this.phase === "connecting") {
      // mesma fila do join (rev. M3 #4): o drain só atualiza o estado
      if (!this.pendingProducers.some((p) => p.producerId === producerId)) {
        this.pendingProducers.push({ producerId, userId, source });
      }
      return;
    }
    if (this.phase !== "connected") return; // fora de voz o anúncio não interessa
    this.remoteStreams.set(producerId, { userId, source });
    if (source === "screen_audio" && this.watching !== null && this.watching.userId === userId) {
      void this.consumeStreamAudio(producerId).catch((err: unknown) =>
        console.warn("voz: consume do soundshare falhou", err),
      );
    }
  }

  /**
   * Assiste a transmissão de um usuário (M5): consome o vídeo source "screen"
   * (consume + resume — o consumer de stream não usa pause: parar de assistir
   * é CLOSE, a economia real) e o soundshare do MESMO usuário se anunciado,
   * entregando UM <video> grande à UI via onStreamView. UM stream por vez:
   * assistir outro derruba o atual primeiro (close_consumer).
   */
  async watchStream(producerId: string, userId: string): Promise<void> {
    if (this.watching?.screenProducerId === producerId) return; // já assistindo este
    const device = this.device;
    const recv = this.recvTransport;
    if (this.phase !== "connected" || device === null || recv === null) return;
    if (this.watchStarting) return; // clique duplo durante a sinalização
    this.stopWatching(); // UM por vez: o atual sai (close_consumer + painel) antes do novo
    this.watchStarting = true;
    const epoch = this.epoch;
    try {
      const r = (await this.request("consume", {
        transport_id: recv.id,
        producer_id: producerId,
        rtp_capabilities: device.rtpCapabilities,
      })) as ConsumeResponse;
      if (epoch !== this.epoch) return; // leave no meio: a cascata do servidor limpa
      const consumer = await recv.consume({
        id: r.consumer_id,
        producerId: r.producer_id,
        kind: r.kind as "audio" | "video",
        rtpParameters: r.rtp_parameters as RtpParameters,
      });
      if (epoch !== this.epoch) {
        consumer.close();
        return;
      }
      const stream = new MediaStream([consumer.track]);
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute("playsinline", ""); // Safari antigo lê o atributo, não a propriedade
      // NÃO muted (contrato M5): o soundshare toca por ESTE <video>. Autoplay
      // sem mute pode ser barrado sem gesto recente — a UI trata o play()
      // rejeitado (warn + botão de unmute). Deafen silencia o stream também, e
      // o M9 acrescenta o volume/mute local do dono (teto de 100%: o volume de
      // um elemento não passa de 1 — a cadeia WebAudio é só para os consumers)
      const volume = this.effectiveVolume(userId);
      video.muted = this.selfDeaf || volume === 0;
      video.volume = Math.min(1, volume);
      this.applyOutputDevice(video); // saída escolhida (item 38)
      video.srcObject = stream;
      const watching = {
        userId,
        screenProducerId: producerId,
        video,
        stream,
        consumers: new Map<string, Consumer>([[producerId, consumer]]),
      };
      this.watching = watching;
      try {
        await this.request("resume_consumer", { consumer_id: consumer.id });
      } catch (err) {
        // consumer pausado para sempre = painel preto — desfaz tudo e propaga
        if (this.watching === watching) this.clearWatch(true);
        throw err;
      }
      if (this.watching !== watching) return; // teardown/producer fechado durante o resume
      this.onStreamView?.(userId, video);
      // soundshare do mesmo usuário, se anunciado — melhor esforço: a tela
      // sem áudio ainda vale, o erro só é logado
      const audioProducerId = this.streamAudioProducerIdOf(userId);
      if (audioProducerId !== null) {
        void this.consumeStreamAudio(audioProducerId).catch((err: unknown) =>
          console.warn("voz: consume do soundshare falhou", err),
        );
      }
    } finally {
      this.watchStarting = false;
    }
  }

  /**
   * Para de assistir (M5): fecha os consumers do stream localmente E no
   * servidor via close_consumer — é AQUI que a banda do viewer zera de
   * verdade (pause deixaria o consumer alocado; close libera, contrato M5).
   */
  stopWatching(): void {
    this.clearWatch(true);
  }

  /** soundshare anunciado de um usuário (par do streamProducerIdOf, privado). */
  private streamAudioProducerIdOf(userId: string): string | null {
    for (const [producerId, info] of this.remoteStreams) {
      if (info.userId === userId && info.source === "screen_audio") return producerId;
    }
    return null;
  }

  /**
   * Consome o soundshare para DENTRO do stream assistido: o track de áudio
   * entra no MESMO MediaStream do <video> grande (sem retocar o srcObject).
   */
  private async consumeStreamAudio(producerId: string): Promise<void> {
    const device = this.device;
    const recv = this.recvTransport;
    const target = this.watching;
    if (device === null || recv === null || target === null) return;
    // dedup (watchStream × anúncio atrasado podem pedir o mesmo id)
    if (target.consumers.has(producerId) || this.consuming.has(producerId)) return;
    this.consuming.add(producerId);
    const epoch = this.epoch;
    try {
      const r = (await this.request("consume", {
        transport_id: recv.id,
        producer_id: producerId,
        rtp_capabilities: device.rtpCapabilities,
      })) as ConsumeResponse;
      if (epoch !== this.epoch) return; // leave: a cascata do servidor limpa
      if (this.watching !== target) {
        // trocou/parou de assistir durante o consume: a sessão segue VIVA, o
        // consumer recém-criado não cai sozinho — revalidação pós-await com
        // close do recurso (padrão M3), aqui via close_consumer
        void this.request("close_consumer", { consumer_id: r.consumer_id }).catch(() => undefined);
        return;
      }
      const consumer = await recv.consume({
        id: r.consumer_id,
        producerId: r.producer_id,
        kind: r.kind as "audio" | "video",
        rtpParameters: r.rtp_parameters as RtpParameters,
      });
      if (epoch !== this.epoch) {
        consumer.close();
        return;
      }
      if (this.watching !== target) {
        consumer.close();
        void this.request("close_consumer", { consumer_id: consumer.id }).catch(() => undefined);
        return;
      }
      target.consumers.set(producerId, consumer);
      target.stream.addTrack(consumer.track);
      // ensurdecido (M9, item 35): nasce pausado no servidor — nenhum RTP de
      // soundshare atravessa a rede à toa. O un-deafen resume junto com o resto
      if (this.selfDeaf) {
        consumer.pause();
        return;
      }
      try {
        await this.request("resume_consumer", { consumer_id: consumer.id });
      } catch (err) {
        // som pausado para sempre não serve — remove só o áudio; a tela segue
        target.consumers.delete(producerId);
        consumer.close();
        void this.request("close_consumer", { consumer_id: consumer.id }).catch(() => undefined);
        throw err;
      }
    } finally {
      this.consuming.delete(producerId);
    }
  }

  /**
   * Derruba o stream assistido. signal=true → close_consumer no servidor
   * (parar de assistir com a sessão viva); false → só local (teardown/producer
   * fechado: o servidor já fechou — ou vai fechar — os consumers sozinho).
   */
  private clearWatch(signal: boolean): void {
    const w = this.watching;
    if (w === null) return;
    // o campo esvazia ANTES dos callbacks (mesmo padrão do teardown de tiles):
    // nenhum re-render disparado pelo onStreamView enxerga entrada morta
    this.watching = null;
    for (const consumer of w.consumers.values()) {
      consumer.close();
      if (signal) void this.request("close_consumer", { consumer_id: consumer.id }).catch(() => undefined);
    }
    w.consumers.clear();
    w.video.pause();
    w.video.srcObject = null;
    this.onStreamView?.(w.userId, null);
  }

  /** Desliga a transmissão SÓ localmente: producers, tracks e canvas fake — sem sinalizar. */
  private stopStreamLocal(): void {
    this.streamProducer?.close();
    this.streamProducer = null;
    this.streamAudioProducer?.close();
    this.streamAudioProducer = null;
    this.screenTrack?.stop(); // apaga o indicador de "compartilhando tela" do navegador
    this.screenTrack = null;
    this.screenAudioTrack?.stop();
    this.screenAudioTrack = null;
    if (this.fakeScreen !== null) {
      this.fakeScreen.stop();
      this.fakeScreen = null;
    }
  }

  /**
   * VOICE_PRODUCER_CLOSED: normalmente é um consumer nosso que morreu; mas se
   * o id é do NOSSO producer de áudio, o servidor nos tirou da voz (outra
   * sessão deste usuário entrou, transporte dado como morto) — derruba tudo
   * localmente, senão o mic fica aberto falando com ninguém.
   */
  handleProducerClosed(producerId: string): void {
    if (this.producer !== null && this.producer.id === producerId) {
      this.leaveLocal();
      return;
    }
    // NOSSA câmera fechada pelo servidor (na prática o eco do close_producer
    // chega depois de stopCameraLocal e cai no no-op abaixo; este ramo cobre
    // um close server-side com a câmera ainda acesa) — só o vídeo cai
    if (this.videoProducer !== null && this.videoProducer.id === producerId) {
      this.stopCameraLocal();
      this.onChange?.();
      return;
    }
    // NOSSA tela fechada pelo servidor (close server-side com a transmissão
    // ainda acesa): tela e soundshare caem JUNTOS — soundshare órfão sem tela
    // não faz sentido (espelho local da defesa do servidor, contrato M5)
    if (this.streamProducer !== null && this.streamProducer.id === producerId) {
      this.stopStreamLocal();
      this.onChange?.();
      return;
    }
    // só o NOSSO soundshare (o servidor fecha o par tela+áudio — o evento da
    // tela cuida do resto; este ramo é o eco do áudio chegando primeiro)
    if (this.streamAudioProducer !== null && this.streamAudioProducer.id === producerId) {
      this.streamAudioProducer.close();
      this.streamAudioProducer = null;
      this.screenAudioTrack?.stop();
      this.screenAudioTrack = null;
      return;
    }
    // stream REMOTO fechado: sai do índice do "Assistir"; se era o que
    // estávamos assistindo, o painel cai NA HORA (onStreamView null) — sem
    // close_consumer: o worker já matou os consumers pela cascata do producer
    this.remoteStreams.delete(producerId);
    const w = this.watching;
    if (w !== null) {
      if (w.screenProducerId === producerId) {
        this.clearWatch(false);
        return;
      }
      const audioConsumer = w.consumers.get(producerId);
      if (audioConsumer !== undefined) {
        // só o soundshare acabou: o som para, a tela continua no painel
        w.consumers.delete(producerId);
        audioConsumer.close();
        return;
      }
    }
    this.closeConsumer(producerId);
  }

  /** Mute só de microfone — independente do deafen (que o implica). */
  async toggleMute(): Promise<void> {
    this.selfMute = !this.selfMute;
    this.mutedBeforeDeafen = null; // toque manual quebra o vínculo com o deafen
    this.applyMute();
    this.onChange?.();
    await this.pushState();
  }

  /** Deafen implica mute (como no Discord); un-deafen desfaz só o mute que ele impôs. */
  async toggleDeafen(): Promise<void> {
    if (this.selfDeaf) {
      this.selfDeaf = false;
      if (this.mutedBeforeDeafen !== null) this.selfMute = this.mutedBeforeDeafen;
      this.mutedBeforeDeafen = null;
    } else {
      this.selfDeaf = true;
      this.mutedBeforeDeafen = this.selfMute;
      this.selfMute = true;
    }
    this.applyMute();
    // O DEAFEN É REAL (M9, item 35): até o M8 ele só fazia `audio.muted = true`
    // e o servidor continuava mandando TODO o RTP — quem se ensurdecia "para
    // economizar" não economizava nada. Agora a economia é de verdade: os
    // consumers de áudio são PAUSADOS no servidor, que para de encaminhar.
    //
    // O silêncio local vem antes e é SÍNCRONO (ganho mestre em 0, elementos
    // mudos): pausar é assíncrono e o RTP em voo ainda tocaria no meio-tempo —
    // este é o cinto de segurança, não o mecanismo.
    this.applyMasterGain();
    for (const entry of this.consumers.values()) this.applyAudioLevels(entry);
    // o soundshare toca pelo <video> do stream assistido — silencia junto (M5).
    // Via applyUserLevels e não `video.muted = selfDeaf`: sair do deafen não
    // pode "desmutar" alguém que eu tinha silenciado localmente (item 33)
    if (this.watching !== null) this.applyUserLevels(this.watching.userId);
    this.syncDeafenConsumers();
    this.onChange?.();
    await this.pushState();
  }

  /**
   * Aplica o deafen aos consumers (item 35). Cada um vai por conta própria: um
   * pause/resume que falhe não pode levar os outros junto — o pior caso é UM
   * usuário continuar gastando banda até o próximo toggle, e o ganho mestre
   * garante que ninguém é OUVIDO enquanto ensurdecido.
   */
  private syncDeafenConsumers(): void {
    const deaf = this.selfDeaf;
    for (const entry of this.consumers.values()) void this.setConsumerPaused(entry, deaf);
    // o soundshare do stream assistido também é RTP que chega (M5): pausar
    // aqui é o mesmo dinheiro. Bookkeeping no próprio Consumer do
    // mediasoup-client (`consumer.paused`), cujo pause local já desliga o
    // track — instantâneo, enquanto o pause do servidor está em voo.
    const w = this.watching;
    if (w === null) return;
    for (const consumer of w.consumers.values()) {
      if (consumer.kind !== "audio" || consumer.paused === deaf) continue;
      if (deaf) consumer.pause();
      else consumer.resume();
      void this.request(deaf ? "pause_consumer" : "resume_consumer", { consumer_id: consumer.id }).catch(
        (err: unknown) => console.warn("voz: deafen do soundshare falhou", err),
      );
    }
  }

  /**
   * Pausa/religa UM consumer no servidor. Otimista ANTES do await (padrão do
   * setTileVisibility): toggles rápidos se dedupam pelo campo; se o request
   * falhar, o flag fica adiantado e o próximo toggle re-sincroniza.
   */
  private async setConsumerPaused(
    entry: { consumer: Consumer; paused: boolean },
    paused: boolean,
  ): Promise<void> {
    if (entry.paused === paused) return;
    entry.paused = paused;
    try {
      await this.request(paused ? "pause_consumer" : "resume_consumer", { consumer_id: entry.consumer.id });
    } catch (err) {
      // consumer já morto no servidor responde erro inócuo; o resto não muda
      console.warn("voz: pause/resume de consumer falhou", err);
    }
  }

  /**
   * Liga/desliga o modo push-to-talk (M6, só desktop). Ligado, o track do mic
   * fica enabled SÓ com a tecla segurada — e o mute manual vence tudo (mutado
   * é mutado; tecla nenhuma abre o mic). O estado VISUAL de mute NÃO muda:
   * PTT é outra dimensão — mic fechado entre presses não é "mutado", e a UI
   * indica isso pelo rótulo do toggle. SEM sinalização update_state por press
   * DE PROPÓSITO: o "falando" dos outros vem do audioLevelObserver do
   * servidor, que enxerga o áudio real (track desabilitado = silêncio). E SEM
   * onChange aqui: o chamador (main.ts) atualiza só o rótulo do PTT — um
   * re-render completo recriaria os tiles de vídeo a cada aperto de tecla.
   */
  setPttMode(on: boolean): void {
    if (this.pttOn === on) return;
    this.pttOn = on;
    if (!on) this.pttDown = false; // desligar o modo não pode deixar o mic preso fechado
    this.applyMute();
  }

  /** Tecla de PTT desceu/subiu (onPtt da ponte). Só mexe no track — nada de UI/sinalização. */
  setPttPressed(down: boolean): void {
    if (this.pttDown === down) return;
    this.pttDown = down;
    if (this.pttOn) this.applyMute();
  }

  /**
   * Um admin silenciou (ou liberou) ESTA sessão (M9, item 34). Vem do
   * `server_mute` do nosso VOICE_STATE_UPDATE — quem manda é o servidor, que
   * pausa o producer de verdade; aqui o mic fecha e a UI passa a saber que
   * desmutar não resolve (`serverMuted`).
   */
  setServerMuted(on: boolean): void {
    if (this.serverMute === on) return;
    this.serverMute = on;
    this.applyMute();
    this.onChange?.();
  }

  // --- volume e mute por usuário (M9, itens 33 e 36) ------------------------

  /**
   * Volume de UM usuário: 0..2 (0% a 200%). Vale para todos os consumers dele
   * (mic hoje; o soundshare do Go Live entra no teto de 100% do elemento) e
   * para os PRÓXIMOS — ligar a câmera, sair e voltar, tudo herda o valor.
   * Persistência é da UI: aqui é estado vivo, não preferência salva.
   */
  setUserVolume(userId: string, volume: number): void {
    const clamped = Math.min(2, Math.max(0, volume));
    if (clamped === 1) this.userVolumes.delete(userId);
    else this.userVolumes.set(userId, clamped);
    this.applyUserLevels(userId);
  }

  /**
   * Mute LOCAL de um usuário (item 33): só EU paro de ouvir fulano — ninguém
   * mais fica sabendo (nada vai para o servidor; para silenciar para todos, o
   * caminho é o server mute do admin). O consumer segue vivo de propósito: o
   * contrato do item é "puro cliente", e voltar a ouvir precisa ser instantâneo.
   */
  setUserMuted(userId: string, muted: boolean): void {
    if (muted) this.userLocalMutes.add(userId);
    else this.userLocalMutes.delete(userId);
    this.applyUserLevels(userId);
  }

  /** volume vivo de um usuário (1 = 100%) — a UI lê daqui para desenhar o slider */
  getUserVolume(userId: string): number {
    return this.userVolumes.get(userId) ?? 1;
  }

  /** este usuário está silenciado só para mim? */
  isUserMuted(userId: string): boolean {
    return this.userLocalMutes.has(userId);
  }

  /** todos os mutes locais (para a UI persistir/mostrar de uma vez) */
  get locallyMutedUsers(): ReadonlySet<string> {
    return this.userLocalMutes;
  }

  // --- dispositivos (M9, item 38) -------------------------------------------

  /**
   * Dispositivos do sistema. **Os labels só aparecem depois de o usuário ter
   * concedido permissão de mídia** (ver VoiceDevices) — antes disso a lista
   * existe, mas anônima: a UI deve pedir para entrar na voz primeiro.
   */
  async listDevices(): Promise<VoiceDevices> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return {
      audioInputs: all.filter((d) => d.kind === "audioinput"),
      audioOutputs: all.filter((d) => d.kind === "audiooutput"),
      videoInputs: all.filter((d) => d.kind === "videoinput"),
    };
  }

  /**
   * Escolhe o microfone ou a câmera. Com a chamada EM CURSO a troca é por
   * `replaceTrack`: o producer continua o mesmo, ninguém do outro lado
   * renegocia nada e o áudio/vídeo não pisca. Fora da voz só guarda a escolha,
   * que o próximo join usa. `null` volta ao default do sistema.
   */
  async setInputDevice(kind: "audio" | "video", deviceId: string | null): Promise<void> {
    if (kind === "audio") {
      if (this.micDeviceId === deviceId) return;
      this.micDeviceId = deviceId;
      await this.replaceMicTrack();
      return;
    }
    if (this.cameraDeviceId === deviceId) return;
    this.cameraDeviceId = deviceId;
    await this.replaceCameraTrack();
  }

  /**
   * Escolhe a SAÍDA de áudio (item 38). Vai em dois lugares: no AudioContext,
   * por onde sai a voz de todo mundo (`AudioContext.setSinkId`, Chromium 110+
   * — ainda fora do lib.dom do TS, daí o cast), e nos elementos que tocam
   * sozinhos (o <video> do Go Live). Onde não houver suporte, degrada: a voz
   * continua saindo no dispositivo default, só não obedece a escolha.
   */
  async setOutputDevice(deviceId: string | null): Promise<void> {
    this.outputDeviceId = deviceId;
    for (const { audio } of this.consumers.values()) this.applyOutputDevice(audio);
    if (this.watching !== null) this.applyOutputDevice(this.watching.video);
    await this.applyOutputDeviceToContext();
  }

  // --- captura do microfone (M9, item 39) -----------------------------------

  /**
   * Liga/desliga o processamento do microfone. Eram três `true` fixos no
   * captureAudio; em headset com boa isolação o AGC bombeia e a supressão come
   * o ataque das palavras. Aplica na chamada em curso por `applyConstraints`
   * (não derruba nada); se o navegador recusar a mudança a quente, recaptura o
   * mic e troca por replaceTrack — mais caro, mas honesto.
   */
  async setAudioProcessing(options: Partial<AudioProcessing>): Promise<void> {
    this.processing = { ...this.processing, ...options };
    const track = this.micTrack;
    if (track === null || FAKE_AUDIO) return; // fora da voz vale para o próximo join
    try {
      await track.applyConstraints(this.audioConstraints());
    } catch (err) {
      console.warn("voz: applyConstraints recusado — recapturando o microfone", err);
      await this.replaceMicTrack();
    }
  }

  /**
   * Nível do PRÓPRIO microfone, 0..1, a ~20 fps (item 39: "teste de
   * microfone"). O valor é o RMS linear da janela: fala normal fica na casa de
   * 0,05..0,3 — quem decide a escala visual é a UI.
   *
   * É o que os OUTROS ouvem, não o que o microfone capta: mutado (ou fora do
   * press do PTT) o track está desabilitado e o nível é 0 — a UI de teste
   * precisa dizer isso, senão parece defeito.
   *
   * Devolve o stop. Só existe UM medidor por vez (chamar de novo troca) e
   * NADA fica vivo depois do stop — nem o intervalo, nem os nós.
   */
  onLocalLevel(cb: (level: number) => void): () => void {
    this.stopLocalLevel();
    const graph = this.ensureAudioGraph();
    if (graph === null) {
      cb(0);
      return () => undefined; // sem WebAudio não há medidor — e não é erro fatal
    }
    const analyser = graph.ctx.createAnalyser();
    analyser.fftSize = 1024;
    // dreno MUDO até o destino: um AnalyserNode pendurado no vazio pode não ser
    // "puxado" pelo grafo em alguns navegadores. O ganho 0 garante o pull sem
    // mandar o microfone para os alto-falantes — isso seria larsen imediato.
    const sink = graph.ctx.createGain();
    sink.gain.value = 0;
    analyser.connect(sink).connect(graph.ctx.destination);
    const watch: NonNullable<typeof this.levelWatch> = {
      cb,
      analyser,
      sink,
      source: null,
      data: new Float32Array(analyser.fftSize),
      timer: 0,
    };
    this.levelWatch = watch;
    this.attachLevelSource();
    // setInterval e não requestAnimationFrame: o rAF congela com a janela em
    // segundo plano (o painel de configurações pode estar num monitor
    // secundário) e é justamente o tipo de loop que fica vivo para sempre
    watch.timer = window.setInterval(() => {
      if (this.levelWatch !== watch) return; // trocado por outro medidor
      if (watch.source === null) {
        watch.cb(0); // sem microfone (fora da voz, ou captura falhando)
        return;
      }
      watch.analyser.getFloatTimeDomainData(watch.data);
      let sum = 0;
      for (const sample of watch.data) sum += sample * sample;
      watch.cb(Math.min(1, Math.sqrt(sum / watch.data.length)));
    }, 50);
    return () => {
      if (this.levelWatch === watch) this.stopLocalLevel();
    };
  }

  // --- qualidade da conexão (M9, item 40) -----------------------------------

  /**
   * Amostra o getStats dos DOIS transports e devolve o resumo. Ver
   * ConnectionStats para o que cada número é — em especial: taxas e perdas são
   * DELTAS entre esta chamada e a anterior, então a primeira volta com esses
   * campos em null. Retorna null fora da voz.
   *
   * UM chamador por vez (o painel de configurações): a amostra anterior é
   * única, e dois polls concorrentes dividiriam os deltas entre si.
   */
  async getConnectionStats(): Promise<ConnectionStats | null> {
    const send = this.sendTransport;
    const recv = this.recvTransport;
    if (this.phase !== "connected" || send === null || recv === null) return null;
    const epoch = this.epoch;
    const [sendReport, recvReport] = await Promise.all([send.getStats(), recv.getStats()]);
    if (epoch !== this.epoch) return null; // saiu da voz durante a amostragem

    let sendBytes = 0;
    let sendPackets = 0;
    let sendLost = 0;
    let rttMs: number | null = null;
    let pairRttMs: number | null = null;
    sendReport.forEach((raw) => {
      const s = raw as StatsRow;
      if (s.type === "outbound-rtp") {
        sendBytes += s.bytesSent ?? 0;
        sendPackets += s.packetsSent ?? 0;
      } else if (s.type === "remote-inbound-rtp") {
        // é o RECEPTOR (o servidor) contando o que perdeu do que MANDAMOS —
        // a única visão honesta da nossa subida, e vem no RTCP
        sendLost += s.packetsLost ?? 0;
        if (typeof s.roundTripTime === "number") rttMs = Math.round(s.roundTripTime * 1000);
      } else if (
        // plano B do rtt: o par ICE EM USO ("succeeded"). Os outros pares
        // ficam no relatório com medidas velhas — usar qualquer um mentiria
        s.type === "candidate-pair" &&
        s.state === "succeeded" &&
        typeof s.currentRoundTripTime === "number"
      ) {
        pairRttMs = Math.round(s.currentRoundTripTime * 1000);
      }
    });

    let recvBytes = 0;
    let recvPackets = 0;
    let recvLost = 0;
    let jitterMs: number | null = null;
    recvReport.forEach((raw) => {
      const s = raw as StatsRow;
      if (s.type !== "inbound-rtp") return;
      recvBytes += s.bytesReceived ?? 0;
      recvPackets += s.packetsReceived ?? 0;
      recvLost += s.packetsLost ?? 0;
      // o pior jitter entre os fluxos manda: é o que o ouvido percebe
      if (typeof s.jitter === "number") jitterMs = Math.max(jitterMs ?? 0, Math.round(s.jitter * 1000));
    });

    const prev = this.statsSample;
    const sample = { epoch, at: Date.now(), sendBytes, sendPackets, sendLost, recvBytes, recvPackets, recvLost };
    this.statsSample = sample;
    // amostra anterior de OUTRA sessão de mídia não serve: os contadores
    // zeraram no transport novo e o delta sairia negativo
    const elapsed = prev !== null && prev.epoch === epoch ? (sample.at - prev.at) / 1000 : 0;
    const kbps = (now: number, before: number): number | null =>
      elapsed > 0 ? Math.round(((now - before) * 8) / elapsed / 1000) : null;
    // perdas podem VOLTAR ATRÁS (pacote duplicado desconta) — delta negativo é 0
    const delta = (now: number, before: number): number => Math.max(0, now - before);

    let sendLossPct: number | null = null;
    let recvLossPct: number | null = null;
    if (prev !== null && elapsed > 0) {
      // subida: o denominador é o que MANDAMOS (os perdidos estão lá dentro)
      const sent = delta(sendPackets, prev.sendPackets);
      if (sent > 0) sendLossPct = round1((delta(sendLost, prev.sendLost) / sent) * 100);
      // descida: packetsReceived NÃO inclui os perdidos — o total é a soma
      const got = delta(recvPackets, prev.recvPackets);
      const lost = delta(recvLost, prev.recvLost);
      if (got + lost > 0) recvLossPct = round1((lost / (got + lost)) * 100);
    }

    const rtt = rttMs ?? pairRttMs;
    return {
      rttMs: rtt,
      jitterMs,
      sendLossPct,
      recvLossPct,
      sendKbps: prev !== null ? kbps(sendBytes, prev.sendBytes) : null,
      recvKbps: prev !== null ? kbps(recvBytes, prev.recvBytes) : null,
      quality: qualityOf(rtt, Math.max(sendLossPct ?? 0, recvLossPct ?? 0), sendLossPct ?? recvLossPct),
    };
  }

  // -------------------------------------------------------------------------

  private async createTransport(direction: "send" | "recv", device: Device): Promise<Transport> {
    const r = (await this.request("create_transport", { direction })) as CreateTransportResponse;
    const options = {
      id: r.transport_id,
      iceParameters: r.ice_parameters as IceParameters,
      iceCandidates: r.ice_candidates as IceCandidate[],
      dtlsParameters: r.dtls_parameters as DtlsParameters,
    };
    const transport = direction === "send" ? device.createSendTransport(options) : device.createRecvTransport(options);

    // o mediasoup-client só emite "connect" no primeiro produce/consume do
    // transport; o DTLS fecha do lado do servidor via connect_transport
    transport.on("connect", ({ dtlsParameters }, callback, errback) => {
      this.request("connect_transport", { transport_id: transport.id, dtls_parameters: dtlsParameters }).then(
        () => callback(),
        (err: unknown) => errback(err instanceof Error ? err : new Error(String(err))),
      );
    });

    if (direction === "send") {
      // produce local → registra no servidor e recebe o id definitivo de volta.
      // M5: o source viaja no payload (obrigatório no protocolo) — vem do
      // appData que cada produce local declara; o servidor valida kind×source
      // e aplica as políticas por origem (1 tela por canal etc., doc §3.6)
      transport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
        const source = (appData as { source?: ProducerSourceWire }).source;
        this.request("produce", { transport_id: transport.id, kind, source, rtp_parameters: rtpParameters }).then(
          (resp) => callback({ id: (resp as { producer_id: string }).producer_id }),
          (err: unknown) => errback(err instanceof Error ? err : new Error(String(err))),
        );
      });
    }

    // "failed" não se recupera sozinho (mudança de rede, NAT rebind perdido):
    // tenta um restart de ICE via gateway — a mídia sobrevive a quedas do WS,
    // então isto só dispara quando o CAMINHO DE MÍDIA em si quebrou
    transport.on("connectionstatechange", (s) => {
      if (s === "failed") void this.tryRestartIce(transport);
    });

    return transport;
  }

  private async tryRestartIce(transport: Transport): Promise<void> {
    const epoch = this.epoch;
    try {
      const r = (await this.request("restart_ice", { transport_id: transport.id })) as { ice_parameters: unknown };
      if (epoch !== this.epoch || transport.closed) return;
      await transport.restartIce({ iceParameters: r.ice_parameters as IceParameters });
    } catch (err) {
      // o servidor já não conhece o transporte (leave por timeout do lado de
      // lá, sessão morta): ficar com o mic aberto no vácuo é pior que sair
      console.warn("voz: restart de ICE falhou — saindo da voz", err);
      if (epoch === this.epoch) this.leaveLocal();
    }
  }

  /**
   * Track do microfone morreu (headset desplugado, permissão revogada).
   * Recaptura o dispositivo default UMA vez — cobre "troquei de fone" sem
   * derrubar a chamada; se nem isso der (permissão revogada, nenhum mic
   * restante), sai da voz: sessão sem microfone é um fantasma mudo no canal.
   */
  private async recoverMic(producer: Producer): Promise<void> {
    const epoch = this.epoch;
    let track: MediaStreamTrack;
    try {
      track = await this.captureAudio();
    } catch (err) {
      console.warn("voz: microfone perdido e a recaptura falhou — saindo da voz", err);
      if (epoch === this.epoch) void this.leave();
      return;
    }
    if (epoch !== this.epoch || this.producer !== producer) {
      track.stop(); // a voz caiu/trocou de canal durante a recaptura
      return;
    }
    // atribuído ANTES do replaceTrack (mesmo padrão do camTrack no
    // toggleCamera): se um teardown intercalar com o await, ele já sabe
    // parar o track novo
    this.micTrack?.stop();
    this.micTrack = track;
    try {
      await producer.replaceTrack({ track });
    } catch (err) {
      console.warn("voz: replaceTrack do microfone falhou — saindo da voz", err);
      if (epoch === this.epoch) void this.leave();
      return;
    }
    this.applyMute(); // o track novo nasce enabled — reimpõe mute/deafen
  }

  private async captureAudio(): Promise<MediaStreamTrack> {
    // gancho de TESTE: ?fakeaudio=1 troca o microfone por um tom de 440 Hz
    // (OscillatorNode → MediaStreamAudioDestinationNode). Permite validar o
    // caminho completo de mídia com duas abas sem microfone, sem prompt de
    // permissão e sem loop de eco na mesma máquina.
    if (FAKE_AUDIO) {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      osc.frequency.value = 440;
      const gain = ctx.createGain();
      gain.gain.value = 0.1; // tom contínuo em volume cheio machuca o ouvido
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain).connect(dest);
      osc.start();
      this.fakeAudio = { ctx, osc };
      const track = dest.stream.getAudioTracks()[0];
      if (track === undefined) throw new Error("voz: fake audio sem track");
      return track;
    }
    // M9: dispositivo e processamento vêm do estado (itens 38/39) — eram três
    // `true` fixos aqui e nenhum deviceId
    const stream = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints() });
    const track = stream.getAudioTracks()[0];
    if (track === undefined) throw new Error("voz: getUserMedia sem track de áudio");
    return track;
  }

  private async captureVideo(): Promise<MediaStreamTrack> {
    // gancho de TESTE: o mesmo ?fakeaudio=1 troca a webcam por um canvas
    // 640x360 animado (relógio sobre cor girando) via captureStream(15) —
    // valida o caminho de vídeo com duas abas sem câmera e sem prompt
    if (FAKE_AUDIO) {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("voz: canvas 2d indisponível para a câmera fake");
      const anim = { raf: 0 };
      const draw = (): void => {
        const now = new Date();
        // o matiz gira com os segundos: um frame congelado fica óbvio na hora
        const hue = (now.getSeconds() * 6 + now.getMilliseconds() * 0.006) % 360;
        ctx.fillStyle = `hsl(${hue}, 45%, 30%)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#fff";
        ctx.font = "48px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(now.toLocaleTimeString("pt-BR"), canvas.width / 2, canvas.height / 2);
        anim.raf = requestAnimationFrame(draw);
      };
      draw();
      const track = canvas.captureStream(15).getVideoTracks()[0];
      if (track === undefined) {
        cancelAnimationFrame(anim.raf); // sem track ninguém pararia o loop
        throw new Error("voz: câmera fake sem track");
      }
      this.fakeVideo = { stop: () => cancelAnimationFrame(anim.raf) };
      return track;
    }
    // "ideal" pede o TETO (até 4K, requisito do projeto) e o navegador entrega
    // o máximo que a câmera tem — as camadas de simulcast e o codec são
    // derivados depois, da resolução REAL do track (simulcastEncodingsFor)
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        // M9 (item 38): câmera escolhida, como `ideal` — webcam removida cai
        // no default em vez de estourar OverconstrainedError
        ...(this.cameraDeviceId !== null && { deviceId: { ideal: this.cameraDeviceId } }),
        width: { ideal: 3840 },
        height: { ideal: 2160 },
        frameRate: { ideal: 30 },
      },
    });
    const track = stream.getVideoTracks()[0];
    if (track === undefined) throw new Error("voz: getUserMedia sem track de vídeo");
    return track;
  }

  private async captureScreen(): Promise<{ video: MediaStreamTrack; audio: MediaStreamTrack | null }> {
    // gancho de TESTE: o mesmo ?fakeaudio=1 troca o getDisplayMedia por uma
    // "tela" canvas 1280x720 — texto GRANDE (prova o contentHint "detail" no
    // viewer) e um contador em movimento (frame congelado fica óbvio) — via
    // captureStream(15), sem seletor. SEM áudio: verificação silenciosa, nada
    // de oscilador novo (contrato M5).
    if (FAKE_AUDIO) {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("voz: canvas 2d indisponível para a tela fake");
      const anim = { raf: 0, count: 0 };
      const draw = (): void => {
        anim.count += 1;
        ctx.fillStyle = "#10141a";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "120px monospace";
        ctx.fillText("TELA FAKE", canvas.width / 2, 260);
        // o contador desliza em senoide: qualquer stutter/congelamento salta aos olhos
        const x = canvas.width / 2 + Math.sin(anim.count / 20) * 380;
        ctx.font = "80px monospace";
        ctx.fillText(String(anim.count), x, 500);
        anim.raf = requestAnimationFrame(draw);
      };
      draw();
      const track = canvas.captureStream(15).getVideoTracks()[0];
      if (track === undefined) {
        cancelAnimationFrame(anim.raf); // sem track ninguém pararia o loop
        throw new Error("voz: tela fake sem track");
      }
      track.contentHint = "detail"; // mesmo hint da captura real
      this.fakeScreen = { stop: () => cancelAnimationFrame(anim.raf) };
      return { video: track, audio: null };
    }
    // resolução ALTA / fps moderado (doc §3.5): tela é texto e UI — nitidez
    // importa mais que fluidez. audio: true pede o som da aba/sistema; o
    // navegador só entrega se o usuário marcar no seletor (senão: tela muda).
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } },
      audio: true,
    });
    const video = stream.getVideoTracks()[0];
    if (video === undefined) throw new Error("voz: getDisplayMedia sem track de vídeo");
    // contentHint "detail": sob pressão de banda o encoder preserva nitidez
    // (texto legível) e sacrifica fps — o oposto do "motion" da câmera (§3.5)
    video.contentHint = "detail";
    const audio = stream.getAudioTracks()[0] ?? null;
    return { video, audio };
  }

  /** Desliga a câmera SÓ localmente: producer, track e canvas fake — sem sinalizar. */
  private stopCameraLocal(): void {
    this.videoProducer?.close();
    this.videoProducer = null;
    this.camTrack?.stop(); // apaga o indicador de "câmera em uso" do navegador
    this.camTrack = null;
    if (this.fakeVideo !== null) {
      this.fakeVideo.stop();
      this.fakeVideo = null;
    }
  }

  // --- cadeia de saída de áudio (M9, itens 33/35/36) -----------------------

  /**
   * AudioContext + ganho mestre, criados na primeira necessidade (o join é um
   * clique, então o contexto nasce destravado). Volta null quando o WebAudio
   * não está disponível — aí o áudio cai no fallback pelo próprio <audio>, com
   * volume limitado a 100%. Falhou uma vez, não tenta de novo: seria um
   * `new AudioContext()` por consumer.
   */
  private ensureAudioGraph(): { ctx: AudioContext; master: GainNode } | null {
    if (this.audioGraphFailed) return null;
    let ctx = this.audioCtx;
    let master = this.masterGain;
    if (ctx === null || master === null) {
      try {
        ctx = new AudioContext();
        master = ctx.createGain();
        master.connect(ctx.destination);
      } catch (err) {
        console.warn("voz: WebAudio indisponível — volume por usuário desligado", err);
        this.audioGraphFailed = true;
        return null;
      }
      this.audioCtx = ctx;
      this.masterGain = master;
      this.applyMasterGain();
      void this.applyOutputDeviceToContext();
    }
    // o teardown suspende o contexto para soltar o dispositivo de saída; e a
    // janela em segundo plano por muito tempo suspende sozinha
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    return { ctx, master };
  }

  /**
   * MediaStreamSource → GainNode do usuário → mestre. null = sem WebAudio.
   * O ganho já NASCE no valor certo (e não em 1 com rampa depois): quem entra
   * silenciado localmente não pode soltar 15 ms de voz antes de calar.
   */
  private buildChain(
    stream: MediaStream,
    initialGain: number,
  ): { source: MediaStreamAudioSourceNode; gain: GainNode } | null {
    const graph = this.ensureAudioGraph();
    if (graph === null) return null;
    try {
      const source = graph.ctx.createMediaStreamSource(stream);
      const gain = graph.ctx.createGain();
      gain.gain.value = initialGain;
      source.connect(gain).connect(graph.master);
      return { source, gain };
    } catch (err) {
      console.warn("voz: cadeia WebAudio do consumer falhou — tocando pelo elemento", err);
      return null;
    }
  }

  /** ganho efetivo de um usuário: mute local vence o slider */
  private effectiveVolume(userId: string): number {
    if (this.userLocalMutes.has(userId)) return 0;
    return this.userVolumes.get(userId) ?? 1;
  }

  /** deafen: silêncio imediato de TUDO enquanto os pause_consumer voam */
  private applyMasterGain(): void {
    if (this.masterGain !== null) this.ramp(this.masterGain.gain, this.selfDeaf ? 0 : 1);
  }

  /**
   * Ganho nunca muda em degrau: mexer no `.value` seco estala (zipper noise).
   * ~15 ms de constante de tempo é rápido para o ouvido e suave para o alto-falante.
   */
  private ramp(param: AudioParam, value: number): void {
    const ctx = this.audioCtx;
    if (ctx === null) {
      param.value = value;
      return;
    }
    param.setTargetAtTime(value, ctx.currentTime, 0.015);
  }

  /** Reaplica volume/mute de UM usuário em tudo que já toca dele. */
  private applyUserLevels(userId: string): void {
    for (const entry of this.consumers.values()) {
      if (entry.userId === userId) this.applyAudioLevels(entry);
    }
    // o soundshare do Go Live toca pelo <video> grande: aqui o teto é 100% (o
    // volume do elemento não passa de 1) — a UI pode dizer isso no slider
    const w = this.watching;
    if (w !== null && w.userId === userId) {
      const volume = this.effectiveVolume(userId);
      w.video.muted = this.selfDeaf || volume === 0;
      w.video.volume = Math.min(1, volume);
    }
  }

  private applyAudioLevels(entry: { audio: HTMLAudioElement; chain: { gain: GainNode } | null; userId: string }): void {
    const volume = this.effectiveVolume(entry.userId);
    if (entry.chain !== null) {
      this.ramp(entry.chain.gain.gain, volume);
      entry.audio.muted = true; // o elemento é só a bomba (ver consume)
      return;
    }
    // fallback sem WebAudio: o elemento volta a ser o tocador — o volume trava
    // em 100% e o deafen entra como mute, do jeito que era até o M8
    entry.audio.muted = this.selfDeaf || volume === 0;
    entry.audio.volume = Math.min(1, volume);
  }

  /** Manda um elemento tocar no dispositivo escolhido (item 38); no-op sem escolha. */
  private applyOutputDevice(el: HTMLMediaElement): void {
    const id = this.outputDeviceId;
    // o typeof não é paranoia: onde setSinkId não existe (Firefox antigo) a
    // chamada estoura SÍNCRONA — não há promise para o .catch pegar
    if (id === null || typeof el.setSinkId !== "function") return;
    void el.setSinkId(id).catch((err: unknown) => console.warn("voz: setSinkId no elemento falhou", err));
  }

  /**
   * O mesmo para o AudioContext, por onde sai a voz de todos. `setSinkId` de
   * AudioContext existe no Chromium 110+ mas ainda não está no lib.dom do TS —
   * daí o cast e o `?.`: onde não houver, a voz sai no default (degrada, não quebra).
   */
  private async applyOutputDeviceToContext(): Promise<void> {
    const ctx = this.audioCtx;
    const id = this.outputDeviceId;
    if (ctx === null || id === null) return;
    const selectable = ctx as unknown as { setSinkId?: (sinkId: string) => Promise<void> };
    try {
      await selectable.setSinkId?.(id);
    } catch (err) {
      console.warn("voz: setSinkId no AudioContext falhou", err);
    }
  }

  // --- captura configurável (M9, itens 38 e 39) ----------------------------

  /**
   * Constraints do microfone: dispositivo escolhido + processamento. O
   * deviceId vai como `ideal`, NÃO `exact`, de propósito — com `exact`, um
   * fone desplugado faria o recoverMic falhar em vez de cair no default, que é
   * exatamente o caso que ele existe para cobrir.
   */
  private audioConstraints(): MediaTrackConstraints {
    return {
      ...(this.micDeviceId !== null && { deviceId: { ideal: this.micDeviceId } }),
      echoCancellation: this.processing.echoCancellation,
      noiseSuppression: this.processing.noiseSuppression,
      autoGainControl: this.processing.autoGainControl,
    };
  }

  /**
   * Troca o track do microfone na chamada em curso (mudança de dispositivo ou
   * de processamento). Mesmo padrão do recoverMic: atribui ANTES do
   * replaceTrack para que um teardown intercalado já saiba parar o track novo.
   */
  private async replaceMicTrack(): Promise<void> {
    const producer = this.producer;
    if (producer === null) return; // fora da voz: a escolha vale no próximo join
    const epoch = this.epoch;
    const previousFake = this.fakeAudio;
    const track = await this.captureAudio();
    if (epoch !== this.epoch || this.producer !== producer) {
      track.stop(); // a voz caiu/trocou de canal durante a captura
      return;
    }
    this.stopFakeAudio(previousFake); // no modo ?fakeaudio=1 o oscilador antigo vazaria
    const previous = this.micTrack;
    this.micTrack = track;
    try {
      await producer.replaceTrack({ track });
    } catch (err) {
      // o track ANTIGO ainda está no producer e vivo — desfazer aqui é o que
      // separa "a troca não deu" de "ficamos mudos" (por isso ele só para
      // DEPOIS do replaceTrack dar certo)
      if (this.epoch === epoch) this.micTrack = previous;
      track.stop();
      throw err;
    }
    previous?.stop(); // apaga o indicador do dispositivo velho
    this.applyMute(); // track novo nasce enabled — reimpõe mute/PTT/server mute
    this.attachLevelSource(); // o medidor estava lendo o track velho
  }

  /**
   * Idem para a câmera. As camadas de simulcast NÃO são recalculadas: elas
   * foram negociadas no produce e mexer nelas exigiria derrubar o producer —
   * trocar de câmera não vale um piscar de tela para todo mundo. Se a
   * resolução mudar muito, desligar e ligar a câmera renegocia.
   */
  private async replaceCameraTrack(): Promise<void> {
    const producer = this.videoProducer;
    if (producer === null) return; // câmera desligada: vale no próximo toggle
    const epoch = this.epoch;
    const previousFake = this.fakeVideo;
    const track = await this.captureVideo();
    if (epoch !== this.epoch || this.videoProducer !== producer) {
      track.stop();
      return;
    }
    if (previousFake !== null && this.fakeVideo !== previousFake) previousFake.stop();
    const previous = this.camTrack;
    this.camTrack = track;
    try {
      await producer.replaceTrack({ track });
    } catch (err) {
      // mesma regra do microfone: falhou, a câmera antiga continua no ar
      if (this.epoch === epoch) this.camTrack = previous;
      track.stop();
      throw err;
    }
    previous?.stop();
    this.onChange?.(); // o preview local é montado com o camTrack — precisa remontar
  }

  /** para o oscilador/contexto de um ?fakeaudio=1 antigo, se o novo já o substituiu */
  private stopFakeAudio(previous: { ctx: AudioContext; osc: OscillatorNode } | null): void {
    if (previous === null || this.fakeAudio === previous) return;
    previous.osc.stop();
    void previous.ctx.close().catch(() => undefined);
  }

  /** (re)liga o medidor de nível no track de mic ATUAL — chamado a cada troca de track */
  private attachLevelSource(): void {
    const watch = this.levelWatch;
    if (watch === null) return;
    if (watch.source !== null) {
      watch.source.disconnect();
      watch.source = null;
    }
    const track = this.micTrack;
    const ctx = this.audioCtx;
    if (track === null || ctx === null) return; // sem mic o medidor reporta 0
    try {
      // stream novo com o MESMO track: o node quer um MediaStream e o do
      // getUserMedia não fica guardado (só o track interessa)
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      source.connect(watch.analyser);
      watch.source = source;
    } catch (err) {
      console.warn("voz: medidor não conseguiu ler o microfone", err);
    }
  }

  /** desmonta o medidor: intervalo E nós (nada pode sobreviver ao stop) */
  private stopLocalLevel(): void {
    const watch = this.levelWatch;
    if (watch === null) return;
    this.levelWatch = null;
    window.clearInterval(watch.timer);
    watch.source?.disconnect();
    watch.analyser.disconnect();
    watch.sink.disconnect();
  }

  private applyMute(): void {
    // o mute REAL é client-side: track.enabled=false gera silêncio e o DTX
    // para de mandar pacotes — o servidor só replica flags via update_state
    // (não há pauseProducer no servidor neste milestone, contrato do M3).
    // PTT (M6): no modo PTT o mic só abre com a tecla segurada — a ordem dos
    // && é a hierarquia (mute manual vence a tecla). Chamado também no join e
    // no recoverMic: um track novo já nasce respeitando o PTT.
    // M9 (item 34): o server mute vem ANTES de tudo — quando um admin silencia,
    // o servidor pausa o nosso producer de verdade; fechar o track aqui só
    // evita que o cliente fique gastando encode falando com uma parede (e
    // deixa o indicador de mic honesto).
    const track = this.producer?.track;
    if (track != null) track.enabled = !this.serverMute && !this.selfMute && (!this.pttOn || this.pttDown);
  }

  private async pushState(): Promise<void> {
    if (this.channel === null) return;
    try {
      await this.request("update_state", { self_mute: this.selfMute, self_deaf: this.selfDeaf });
    } catch (err) {
      // flags dessincronizados não quebram a mídia; o próximo toggle re-envia
      console.warn("voz: update_state falhou", err);
    }
  }

  private closeConsumer(producerId: string): void {
    const entry = this.consumers.get(producerId);
    if (entry !== undefined) {
      this.consumers.delete(producerId);
      entry.consumer.close();
      // desconectar a cadeia é obrigatório: nó de WebAudio pendurado no mestre
      // segura o grafo (e o stream) vivo mesmo com o consumer fechado
      entry.chain?.source.disconnect();
      entry.chain?.gain.disconnect();
      entry.audio.pause();
      entry.audio.srcObject = null;
      return;
    }
    // tile de vídeo (M4): fecha o consumer, solta o stream e avisa a UI para
    // tirar o tile da grade (el null é o contrato de remoção do onVideoTile)
    const tile = this.videoConsumers.get(producerId);
    if (tile === undefined) {
      // placeholder de codec incompatível (rev. M4 #2): não há consumer, mas
      // a UI tem um tile — a remoção sai pelo mesmo contrato (el null)
      const failedUser = this.failedVideoTiles.get(producerId);
      if (failedUser !== undefined) {
        this.failedVideoTiles.delete(producerId);
        this.onVideoTile?.(failedUser, producerId, null);
      }
      return;
    }
    this.videoConsumers.delete(producerId);
    tile.consumer.close();
    tile.video.srcObject = null;
    this.onVideoTile?.(tile.userId, producerId, null);
  }

  /** Fecha TODA a mídia local (transports fecham producers/consumers em cadeia). */
  private teardown(): void {
    this.pendingProducers = [];
    for (const { consumer, audio, chain } of this.consumers.values()) {
      consumer.close();
      chain?.source.disconnect(); // nó solto segura o grafo e o stream vivos
      chain?.gain.disconnect();
      audio.pause();
      audio.srcObject = null;
    }
    this.consumers.clear();
    // tiles de vídeo: o mapa esvazia ANTES dos callbacks — nenhum re-render da
    // UI (disparado pelo onVideoTile) pode enxergar/sinalizar entrada morta
    const tiles = [...this.videoConsumers.entries()];
    this.videoConsumers.clear();
    for (const [producerId, tile] of tiles) {
      tile.consumer.close();
      tile.video.srcObject = null;
      this.onVideoTile?.(tile.userId, producerId, null);
    }
    // placeholders de codec incompatível saem pelo mesmo contrato (el null)
    const failed = [...this.failedVideoTiles.entries()];
    this.failedVideoTiles.clear();
    for (const [producerId, userId] of failed) this.onVideoTile?.(userId, producerId, null);
    // stream assistido (M5): SEM sinalizar (estamos saindo — a cascata do
    // servidor fecha os consumers); o onStreamView null derruba o painel
    this.clearWatch(false);
    this.remoteStreams.clear(); // o índice do "Assistir" é por canal — zera junto
    this.consuming.clear();
    this.producer?.close();
    this.producer = null;
    this.stopCameraLocal(); // câmera cai junto: producer de vídeo, track e canvas fake
    this.stopStreamLocal(); // transmissão idem: producers (tela+som), tracks e canvas fake
    this.sendTransport?.close();
    this.sendTransport = null;
    this.recvTransport?.close();
    this.recvTransport = null;
    this.micTrack?.stop(); // apaga o indicador de "mic em uso" do navegador
    this.micTrack = null;
    this.attachLevelSource(); // sem mic: o medidor (se houver) solta o node e reporta 0
    this.statsSample = null; // contadores do getStats zeram com os transports (item 40)
    if (this.fakeAudio !== null) {
      this.fakeAudio.osc.stop();
      void this.fakeAudio.ctx.close().catch(() => {
        // contexto já fechado — nada a fazer
      });
      this.fakeAudio = null;
    }
    // o AudioContext SOBREVIVE ao leave (recriar custa e perderia o setSinkId),
    // mas suspenso: contexto rodando segura o dispositivo de saída aberto — e o
    // ensureAudioGraph dá resume() no próximo consumer
    if (this.audioCtx !== null && this.levelWatch === null) {
      void this.audioCtx.suspend().catch(() => undefined);
    }
    this.device = null;
  }
}
