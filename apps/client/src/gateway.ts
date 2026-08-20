import {
  CloseCode,
  Op,
  ServerMessage,
  type DispatchEvent,
  type DispatchName,
  type PresenceStatus,
} from "@danjocord/protocol";

export type GatewayStatus = "connecting" | "online" | "resuming" | "offline";

type DispatchPayload<T extends DispatchName> = Extract<DispatchEvent, { t: T }>["d"];

interface GatewayEvents {
  status: (status: GatewayStatus) => void;
  dispatch: <T extends DispatchName>(t: T, d: DispatchPayload<T>) => void;
  /**
   * Close code do socket, cru. Existe porque "offline" não distingue os casos
   * que exigem ações OPOSTAS: 4004 quer renovar o token e reconectar, 4016 quer
   * parar de tentar e voltar ao login, e uma queda de rede quer só o backoff.
   * Antes disto o main.ts alcançava o `ws` privado por um cast para enxergar o
   * 4004 — e o 4016, que nem era observado, virava laço infinito.
   */
  closed: (code: number, reason: string) => void;
}

/**
 * Cliente do gateway (doc §4): Hello→Identify, heartbeat com jitter,
 * detecção de ACK perdido (conexão zumbi) e Resume com replay.
 * Espelha o WebSocketShard do discord.js em versão mínima.
 */
export class GatewayClient {
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private ackPending = false;
  private reconnectAttempts = 0;
  private closedByUser = false;
  /** correlação da sinalização de voz (M3): `req` incremental → promise pendente */
  private reqSeq = 0;
  private readonly pendingRequests = new Map<
    number,
    { resolve: (p: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  // Campos explícitos, e NÃO `constructor(private readonly url: string, …)`:
  // o type stripping do Node recusa parameter property, e enquanto isto era um
  // construtor abreviado a classe simplesmente não carregava no harness de
  // teste do cliente — foi por isso que o gateway ficou sem teste até agora.
  // Mesma pedra que o ByteLru do M9 pagou.
  private readonly url: string;
  private readonly token: string;
  private readonly events: GatewayEvents;

  constructor(url: string, token: string, events: GatewayEvents) {
    this.url = url;
    this.token = token;
    this.events = events;
  }

  connect(): void {
    this.closedByUser = false;
    this.events.status(this.sessionId ? "resuming" : "connecting");
    this.ws = new WebSocket(this.url);

    this.ws.addEventListener("message", (ev) => {
      // Frame que não casa com o schema NÃO pode derrubar o handler (roadmap
      // 115). Sem este try/catch a exceção subia do listener e a mensagem
      // sumia em silêncio — e quando a engolida era um HeartbeatAck, o
      // `ackPending` ficava presa e o PRÓPRIO cliente fechava o socket um
      // batimento depois com 4900. O sintoma era "conexão instável"; a causa
      // era schema. Ignorar o frame também é o que dá compatibilidade para
      // frente: servidor novo com evento que este cliente ainda não conhece
      // deixa de derrubar a sessão inteira.
      let msg: ReturnType<typeof ServerMessage.parse>;
      try {
        msg = ServerMessage.parse(JSON.parse(String(ev.data)));
      } catch (err) {
        console.warn("gateway: frame ignorado, não casa com o schema", err);
        return;
      }
      this.onMessage(msg);
    });

    // Cão de guarda do handshake. Ignorar um frame inválido é certo para
    // Dispatch, mas se o engolido for o READY o cliente fica MUDO e VIVO: o
    // servidor considera a sessão autenticada e responde os heartbeats
    // normalmente, então não há close, não há scheduleReconnect, e a tela fica
    // em "Conectando…" para sempre. Sem este timer não existe nada que perceba.
    //
    // Vale para qualquer causa de handshake incompleto, não só schema — READY
    // perdido no meio do caminho dá no mesmo. O 4900 preserva a sessão e cai no
    // handler de close, que reconecta com o backoff normal; e como `sessionId`
    // só é preenchido PELO READY, a tentativa seguinte re-Identifica em vez de
    // tentar um Resume que o servidor não reconheceria.
    this.armHandshakeWatchdog();

    this.ws.addEventListener("close", (ev) => {
      this.stopHeartbeat();
      this.clearHandshakeWatchdog();
      // requests de voz em voo morrem com o socket: rejeitar já é melhor que
      // deixar cada um esperar o próprio timeout de 10s (contrato do M3)
      this.rejectPending(new Error("gateway desconectado"));
      this.events.status("offline");
      this.events.closed(ev.code, ev.reason);
      if (this.closedByUser) return;
      // 4016 (NotAMember, M10 item 114): kick, ban, cargo revogado ou allowlist
      // mexida por fora. O servidor vai repetir o MESMO close a cada tentativa,
      // então reconectar produz um laço infinito preso em "Sem conexão —
      // tentando reconectar…". Quem decide o destino é o dono de `closed`.
      if (ev.code === CloseCode.NotAMember) return;
      this.scheduleReconnect();
    });
  }

  disconnect(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    this.clearHandshakeWatchdog();
    this.ws?.close(1000);
  }

  /**
   * Sinalização de voz (M3, doc §3.6): op 20 com id de correlação `req`
   * incremental; a resposta é o op 21 com o MESMO `req`. ok → resolve com `p`;
   * !ok → rejeita com Error(error). A promise nunca fica pendurada: timeout de
   * 10s e o close do socket rejeitam as pendências.
   */
  request(m: string, p?: unknown): Promise<unknown> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // sem socket aberto o send() abaixo seria descartado em silêncio e a
      // promise só morreria no timeout — falhar imediatamente é mais honesto
      return Promise.reject(new Error("gateway desconectado"));
    }
    this.reqSeq += 1;
    const req = this.reqSeq;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(req);
        reject(new Error(`voz: timeout em "${m}"`));
      }, 10_000);
      this.pendingRequests.set(req, { resolve, reject, timer });
      this.send({ op: Op.VoiceRequest, d: { req, m, p } });
    });
  }

  private rejectPending(err: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.op) {
      case Op.Hello: {
        if (this.sessionId && this.seq !== null) {
          this.send({ op: Op.Resume, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
        } else {
          this.send({ op: Op.Identify, d: { token: this.token } });
        }
        this.startHeartbeat(msg.d.heartbeat_interval);
        return;
      }
      case Op.HeartbeatAck: {
        this.ackPending = false;
        return;
      }
      case Op.InvalidSession: {
        // sessão morreu no servidor: esquece e re-Identifica na mesma conexão
        this.sessionId = null;
        this.seq = null;
        if (!msg.d.resumable) this.send({ op: Op.Identify, d: { token: this.token } });
        return;
      }
      case Op.Reconnect: {
        this.ws?.close(4900); // != 1000 para preservar a sessão e tentar Resume
        return;
      }
      case Op.Dispatch: {
        this.seq = msg.s;
        this.reconnectAttempts = 0;
        if (msg.t === "READY") this.sessionId = msg.d.session_id;
        // handshake completo: o cão de guarda cumpriu o papel e sai de cena
        if (msg.t === "READY" || msg.t === "RESUMED") {
          this.clearHandshakeWatchdog();
          this.events.status("online");
        }
        this.events.dispatch(msg.t, msg.d);
        return;
      }
      case Op.VoiceResponse: {
        const pending = this.pendingRequests.get(msg.d.req);
        if (pending === undefined) return; // resposta tardia de um req que já venceu o timeout
        this.pendingRequests.delete(msg.d.req);
        clearTimeout(pending.timer);
        if (msg.d.ok) pending.resolve(msg.d.p);
        else pending.reject(new Error(msg.d.error ?? "erro de voz"));
        return;
      }
    }
  }

  /**
   * Generoso de propósito: o handshake leva um segundo em rede normal, e o que
   * se quer aqui é não confundir rede lenta com sessão travada. 20 s ainda é
   * infinitamente melhor que "para sempre".
   */
  private static readonly HANDSHAKE_TIMEOUT_MS = 20_000;

  private armHandshakeWatchdog(): void {
    this.clearHandshakeWatchdog();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      console.warn("gateway: READY não chegou em 20s — reconectando");
      this.ws?.close(4900, "handshake sem READY");
    }, GatewayClient.HANDSHAKE_TIMEOUT_MS);
  }

  private clearHandshakeWatchdog(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    const beat = () => {
      if (this.ackPending) {
        // zumbi: servidor não respondeu o último batimento
        this.ws?.close(4900, "sem heartbeat ack");
        return;
      }
      this.ackPending = true;
      this.send({ op: Op.Heartbeat, d: this.seq });
      this.heartbeatTimer = setTimeout(beat, intervalMs);
    };
    // primeiro batimento com jitter, para não sincronizar todos os clientes
    this.heartbeatTimer = setTimeout(beat, intervalMs * Math.random());
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.ackPending = false;
  }

  private scheduleReconnect(): void {
    const base = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts);
    const delay = base * (0.5 + Math.random() / 2); // jitter
    this.reconnectAttempts += 1;
    setTimeout(() => this.connect(), delay);
  }

  /**
   * op 3 (M10, item 56): declara o status DESTA sessão. Sem socket aberto o
   * send descarta — e está certo: o status vive na sessão, e a próxima começa
   * em "online" até o cliente redeclarar (syncPresence no READY).
   */
  presence(status: PresenceStatus): void {
    this.send({ op: Op.PresenceUpdate, d: { status } });
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }
}
