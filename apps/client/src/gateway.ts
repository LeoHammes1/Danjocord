import { Op, ServerMessage, type DispatchEvent, type DispatchName } from "@danjocord/protocol";

export type GatewayStatus = "connecting" | "online" | "resuming" | "offline";

type DispatchPayload<T extends DispatchName> = Extract<DispatchEvent, { t: T }>["d"];

interface GatewayEvents {
  status: (status: GatewayStatus) => void;
  dispatch: <T extends DispatchName>(t: T, d: DispatchPayload<T>) => void;
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
  private ackPending = false;
  private reconnectAttempts = 0;
  private closedByUser = false;
  /** correlação da sinalização de voz (M3): `req` incremental → promise pendente */
  private reqSeq = 0;
  private readonly pendingRequests = new Map<
    number,
    { resolve: (p: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly events: GatewayEvents,
  ) {}

  connect(): void {
    this.closedByUser = false;
    this.events.status(this.sessionId ? "resuming" : "connecting");
    this.ws = new WebSocket(this.url);

    this.ws.addEventListener("message", (ev) => {
      const msg = ServerMessage.parse(JSON.parse(String(ev.data)));
      this.onMessage(msg);
    });

    this.ws.addEventListener("close", () => {
      this.stopHeartbeat();
      // requests de voz em voo morrem com o socket: rejeitar já é melhor que
      // deixar cada um esperar o próprio timeout de 10s (contrato do M3)
      this.rejectPending(new Error("gateway desconectado"));
      this.events.status("offline");
      if (!this.closedByUser) this.scheduleReconnect();
    });
  }

  disconnect(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
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
        if (msg.t === "READY" || msg.t === "RESUMED") this.events.status("online");
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

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }
}
