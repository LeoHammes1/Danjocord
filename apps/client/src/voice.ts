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
 * Cliente de voz (M3, doc §3.6) sobre mediasoup-client. Este módulo cuida SÓ
 * de mídia e sinalização: quem está em qual canal / quem fala agora é estado
 * de UI, alimentado pelos dispatches VOICE_* no main.ts. A comunicação com o
 * servidor passa inteira pelo request() do gateway (op 20/21), injetado no
 * construtor como função — e não como instância, porque o AuthGateway do
 * main.ts é descartado e recriado a cada renovação de token.
 *
 * Fluxo do join: request("join") → Device.load(rtp_capabilities do router) →
 * create_transport send+recv (com connect/produce pendurados nos eventos do
 * mediasoup-client) → getUserMedia → produce(opus DTX+FEC) → consome os
 * producers que já existiam no canal.
 *
 * Métodos no fio (m do op 20), casando com os schemas Voice*Params do
 * protocolo: "join", "create_transport", "connect_transport", "produce",
 * "consume", "resume_consumer", "restart_ice", "update_state", "leave".
 */

/** Assinatura do GatewayClient.request — o main.ts injeta um delegador. */
export type VoiceRequestFn = (m: string, p?: unknown) => Promise<unknown>;

/** Respostas do servidor (blobs do mediasoup viajam como unknown, doc §3.6). */
interface JoinResponse {
  rtp_capabilities: unknown;
  /** producers que JÁ existiam no canal — o recém-chegado consome todos */
  producers?: { user_id: string; producer_id: string }[];
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
  /** UI re-renderiza (canal/estado/mute/deafen mudou) — atribuído pelo main.ts */
  onChange?: () => void;

  private channel: string | null = null;
  private phase: "idle" | "connecting" | "connected" = "idle";
  private selfMute = false;
  private selfDeaf = false;
  /** mute imposto pelo deafen (para desfazer no un-deafen); null = mute manual */
  private mutedBeforeDeafen: boolean | null = null;

  private device: Device | null = null;
  private sendTransport: Transport | null = null;
  private recvTransport: Transport | null = null;
  private producer: Producer | null = null;
  private micTrack: MediaStreamTrack | null = null;
  /** gancho de teste ?fakeaudio=1 — guardado para parar oscilador e contexto */
  private fakeAudio: { ctx: AudioContext; osc: OscillatorNode } | null = null;

  // (o flag em si é lido no load do módulo — ver FAKE_AUDIO no topo)

  /** producer_id → consumer + <audio> (fora do DOM; guardado para cleanup/deafen) */
  private readonly consumers = new Map<string, { consumer: Consumer; audio: HTMLAudioElement }>();
  /** consumes em voo — dedup entre o lote do join e um VOICE_NEW_PRODUCER cruzado */
  private readonly consuming = new Set<string>();
  /** VOICE_NEW_PRODUCER chegado durante o join — drenado quando conectar (rev. M3 #4) */
  private pendingProducers: string[] = [];

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
      });
      if (epoch !== this.epoch) {
        producer.close();
        return;
      }
      this.producer = producer;
      // mute/deafen sobrevivem à troca de canal (como no Discord)
      this.applyMute();

      this.phase = "connected";
      this.onChange?.();
      // o servidor assume join com flags zerados — só avisa se entramos "sujos"
      if (this.selfMute || this.selfDeaf) void this.pushState();

      // quem já estava no canal antes de nós: consome todos (os novos chegam
      // depois via VOICE_NEW_PRODUCER, tratado no main.ts)
      for (const p of joined.producers ?? []) {
        void this.consume(p.producer_id).catch((err: unknown) => console.warn("voz: consume inicial falhou", err));
      }
      // e quem produziu DURANTE o nosso join (a janela inclui o prompt de
      // microfone, que dura segundos) ficou na fila — drena agora (rev. M3 #4)
      for (const id of this.pendingProducers.splice(0)) {
        void this.consume(id).catch((err: unknown) => console.warn("voz: consume pendente falhou", err));
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
   * practice mediasoup) → recvTransport.consume → track num <audio autoplay>
   * → resume_consumer só com o track já plugado.
   */
  async consume(producerId: string): Promise<void> {
    if (this.phase === "connecting") {
      // producer nascido durante o nosso join: descartar seria mudez permanente
      // até um re-join (revisão M3 #4) — guarda e o fim do join drena
      if (!this.pendingProducers.includes(producerId)) this.pendingProducers.push(producerId);
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

      // <audio> fora do DOM toca normalmente; fica guardado para deafen/cleanup
      const audio = new Audio();
      audio.autoplay = true;
      audio.srcObject = new MediaStream([consumer.track]);
      audio.muted = this.selfDeaf; // quem entra ensurdecido não ouve o novo também
      this.consumers.set(producerId, { consumer, audio });
      // autoplay: o join nasceu de um clique, então costuma passar; se o
      // navegador barrar mesmo assim, só avisa — destrava na próxima interação
      audio.play().catch((err: unknown) => console.warn("voz: play() rejeitado", err));

      try {
        await this.request("resume_consumer", { consumer_id: consumer.id });
      } catch (err) {
        // consumer pausado para sempre seria um zumbi inaudível segurando um
        // <audio> — remove; um re-join reconstrói o consumo do canal inteiro
        this.closeConsumer(producerId);
        throw err;
      }
    } finally {
      this.consuming.delete(producerId);
    }
  }

  /**
   * VOICE_PRODUCER_CLOSED: normalmente é um consumer nosso que morreu; mas se
   * o id é do NOSSO producer, o servidor nos tirou da voz (outra sessão deste
   * usuário entrou, transporte dado como morto) — derruba tudo localmente,
   * senão o mic fica aberto falando com ninguém.
   */
  handleProducerClosed(producerId: string): void {
    if (this.producer !== null && this.producer.id === producerId) {
      this.leaveLocal();
      return;
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
    // deafen local = silenciar os <audio> — os consumers continuam vivos (o
    // servidor nem sabe; un-deafen volta a ouvir sem re-sinalizar nada)
    for (const { audio } of this.consumers.values()) audio.muted = this.selfDeaf;
    this.onChange?.();
    await this.pushState();
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
      // produce local → registra no servidor e recebe o id definitivo de volta
      transport.on("produce", ({ kind, rtpParameters }, callback, errback) => {
        this.request("produce", { transport_id: transport.id, kind, rtp_parameters: rtpParameters }).then(
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
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const track = stream.getAudioTracks()[0];
    if (track === undefined) throw new Error("voz: getUserMedia sem track de áudio");
    return track;
  }

  private applyMute(): void {
    // o mute REAL é client-side: track.enabled=false gera silêncio e o DTX
    // para de mandar pacotes — o servidor só replica flags via update_state
    // (não há pauseProducer no servidor neste milestone, contrato do M3)
    const track = this.producer?.track;
    if (track != null) track.enabled = !this.selfMute;
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
    if (entry === undefined) return;
    this.consumers.delete(producerId);
    entry.consumer.close();
    entry.audio.pause();
    entry.audio.srcObject = null;
  }

  /** Fecha TODA a mídia local (transports fecham producers/consumers em cadeia). */
  private teardown(): void {
    this.pendingProducers = [];
    for (const { consumer, audio } of this.consumers.values()) {
      consumer.close();
      audio.pause();
      audio.srcObject = null;
    }
    this.consumers.clear();
    this.consuming.clear();
    this.producer?.close();
    this.producer = null;
    this.sendTransport?.close();
    this.sendTransport = null;
    this.recvTransport?.close();
    this.recvTransport = null;
    this.micTrack?.stop(); // apaga o indicador de "mic em uso" do navegador
    this.micTrack = null;
    if (this.fakeAudio !== null) {
      this.fakeAudio.osc.stop();
      void this.fakeAudio.ctx.close().catch(() => {
        // contexto já fechado — nada a fazer
      });
      this.fakeAudio = null;
    }
    this.device = null;
  }
}
