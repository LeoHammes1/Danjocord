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
      this.events.status("offline");
      if (!this.closedByUser) this.scheduleReconnect();
    });
  }

  disconnect(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    this.ws?.close(1000);
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
      case Op.VoiceResponse:
        return; // M3
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
