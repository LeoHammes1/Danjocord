import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  ClientMessage,
  CloseCode,
  Op,
  type DispatchEvent,
  type DispatchName,
  type Sound,
  type User,
  type VoiceState,
} from "@danjocord/protocol";
import { config } from "./config.js";
import type { Store } from "./store.js";
import { authenticate } from "./auth.js";

/**
 * Gateway realtime (doc §4): um WebSocket por cliente, envelope {op, d, s, t},
 * heartbeat com detecção de zumbi, e Resume com replay via ring buffer.
 * Todo o estado vive em memória — um restart derruba as sessões (Invalid
 * Session → re-Identify com snapshot), por desenho.
 */

interface GatewaySession {
  id: string;
  user: User;
  /** token aceito no Identify; revalidado no Resume */
  token: string;
  seq: number;
  ring: { s: number; raw: string }[];
  ws: WebSocket | null;
  lastHeartbeatAt: number;
  disconnectedAt: number | null;
}

interface ConnState {
  session: GatewaySession | null;
  identifyTimer: NodeJS.Timeout | null;
}

export class Gateway {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sessions = new Map<string, GatewaySession>();
  private readonly sweeper: NodeJS.Timeout;

  /**
   * Delegação da sinalização de voz (op 20, M3): o módulo de voz resolve o
   * método e devolve o payload da resposta; exceção vira op 21 com ok=false.
   * Atribuído pelo wiring do index.ts — o gateway não conhece o mediasoup.
   */
  onVoiceRequest?: (ctx: { userId: string; sessionId: string }, m: string, p: unknown) => Promise<unknown>;
  /** Sessão saiu do mapa DE VEZ (resume expirou/invalidou) — hora de sair da voz. */
  onSessionGone?: (ctx: { userId: string; sessionId: string }) => void;
  /** Snapshot de quem está em voz, para o READY (atribuído pelo index.ts). */
  voiceStatesProvider?: () => VoiceState[];
  /** Catálogo do soundboard para o READY (M9) — metadados, os bytes vêm por REST. */
  soundsProvider?: () => Sound[];

  constructor(private readonly store: Store) {
    this.sweeper = setInterval(() => this.sweep(), 15_000);
    this.sweeper.unref();
    this.wss.on("connection", (ws) => this.onConnection(ws));
  }

  /** Prende o gateway no upgrade HTTP do servidor, em /gateway. */
  attach(server: Server): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path !== "/gateway") {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
    });
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const session of this.sessions.values()) session.ws?.close(1001);
    this.wss.close();
  }

  /** Envia um Dispatch a UMA sessão, com sequence próprio e registro no ring buffer. */
  dispatch<T extends DispatchName>(session: GatewaySession, t: T, d: Extract<DispatchEvent, { t: T }>["d"]): void {
    this.dispatchRaw(session, t, d);
  }

  /** Fan-out para todas as sessões (o "processo da guild" degenerado, doc §3.7). */
  broadcast<T extends DispatchName>(t: T, d: Extract<DispatchEvent, { t: T }>["d"]): void {
    for (const session of this.sessions.values()) this.dispatchRaw(session, t, d);
  }

  private dispatchRaw(session: GatewaySession, t: DispatchName, d: unknown): void {
    session.seq += 1;
    const raw = JSON.stringify({ op: Op.Dispatch, s: session.seq, t, d });
    session.ring.push({ s: session.seq, raw });
    if (session.ring.length > config.ringBufferSize) session.ring.shift();
    if (session.ws?.readyState === WebSocket.OPEN) session.ws.send(raw);
  }

  onlineUserIds(): Set<string> {
    const ids = new Set<string>();
    for (const s of this.sessions.values()) if (s.ws) ids.add(s.user.id);
    return ids;
  }

  // -------------------------------------------------------------------------

  private onConnection(ws: WebSocket): void {
    const state: ConnState = { session: null, identifyTimer: null };

    this.send(ws, { op: Op.Hello, d: { heartbeat_interval: config.heartbeatIntervalMs } });
    state.identifyTimer = setTimeout(() => {
      if (!state.session) ws.close(CloseCode.NotAuthenticated, "identify timeout");
    }, 15_000);

    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        ws.close(CloseCode.DecodeError, "json inválido");
        return;
      }
      const msg = ClientMessage.safeParse(parsed);
      if (!msg.success) {
        ws.close(CloseCode.DecodeError, "payload fora do protocolo");
        return;
      }
      this.onMessage(ws, state, msg.data);
    });

    ws.on("close", () => {
      if (state.identifyTimer) clearTimeout(state.identifyTimer);
      const session = state.session;
      if (session && session.ws === ws) {
        session.ws = null;
        session.disconnectedAt = Date.now();
        this.broadcastPresenceIfOffline(session.user.id);
      }
    });
  }

  private onMessage(ws: WebSocket, state: ConnState, msg: ClientMessage): void {
    switch (msg.op) {
      case Op.Heartbeat: {
        const session = state.session;
        if (session) session.lastHeartbeatAt = Date.now();
        this.send(ws, { op: Op.HeartbeatAck });
        return;
      }

      case Op.Identify: {
        if (state.session) {
          ws.close(CloseCode.AlreadyAuthenticated);
          return;
        }
        const user = authenticate(this.store, msg.d.token);
        if (!user) {
          ws.close(CloseCode.AuthenticationFailed, "token inválido");
          return;
        }
        if (state.identifyTimer) clearTimeout(state.identifyTimer);

        const session: GatewaySession = {
          id: randomUUID(),
          user,
          token: msg.d.token,
          seq: 0,
          ring: [],
          ws,
          lastHeartbeatAt: Date.now(),
          disconnectedAt: null,
        };
        this.sessions.set(session.id, session);
        state.session = session;

        const wasOnline = this.onlineUserIdsExcept(session).has(user.id);
        this.dispatch(session, "READY", {
          session_id: session.id,
          user,
          channels: this.store.listChannels(),
          members: this.store.listMembers(),
          voice_states: this.voiceStatesProvider?.() ?? [],
          sounds: this.soundsProvider?.() ?? [],
        });
        if (!wasOnline) {
          for (const other of this.sessions.values()) {
            if (other !== session) this.dispatch(other, "PRESENCE_UPDATE", { user_id: user.id, online: true });
          }
        }
        return;
      }

      case Op.Resume: {
        if (state.session) {
          ws.close(CloseCode.AlreadyAuthenticated);
          return;
        }
        const session = this.sessions.get(msg.d.session_id);
        // token revalidado: session_id sozinho não é credencial (doc §4)
        if (!session || session.token !== msg.d.token) {
          this.send(ws, { op: Op.InvalidSession, d: { resumable: false } });
          return;
        }
        const oldest = session.ring[0];
        const seqTooOld = oldest !== undefined && msg.d.seq < oldest.s - 1;
        if (msg.d.seq > session.seq || seqTooOld) {
          // fora da janela de replay: joga a sessão fora; o cliente re-Identifica
          this.sessions.delete(session.id);
          this.onSessionGone?.({ userId: session.user.id, sessionId: session.id });
          this.send(ws, { op: Op.InvalidSession, d: { resumable: false } });
          return;
        }
        session.ws?.terminate();
        session.ws = ws;
        session.disconnectedAt = null;
        session.lastHeartbeatAt = Date.now();
        if (state.identifyTimer) clearTimeout(state.identifyTimer);
        state.session = session;

        for (const evt of session.ring) {
          if (evt.s > msg.d.seq) ws.send(evt.raw);
        }
        this.dispatch(session, "RESUMED", {});
        return;
      }

      case Op.VoiceRequest: {
        const session = state.session;
        if (!session) {
          ws.close(CloseCode.NotAuthenticated);
          return;
        }
        const handler = this.onVoiceRequest;
        if (!handler) {
          this.send(ws, { op: Op.VoiceResponse, d: { req: msg.d.req, ok: false, error: "voz indisponível" } });
          return;
        }
        void handler({ userId: session.user.id, sessionId: session.id }, msg.d.m, msg.d.p).then(
          (result) => this.send(ws, { op: Op.VoiceResponse, d: { req: msg.d.req, ok: true, p: result } }),
          (err: unknown) =>
            this.send(ws, {
              op: Op.VoiceResponse,
              d: { req: msg.d.req, ok: false, error: err instanceof Error ? err.message : "erro de voz" },
            }),
        );
        return;
      }
    }
  }

  /** Zumbis: sem heartbeat por 2× o intervalo → derruba o socket (a sessão fica p/ Resume). */
  private sweep(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.ws) {
        if (now - session.lastHeartbeatAt > config.heartbeatIntervalMs * 2) {
          session.ws.close(CloseCode.SessionTimeout, "sem heartbeat");
        }
      } else if (session.disconnectedAt !== null && now - session.disconnectedAt > config.resumeWindowMs) {
        this.sessions.delete(session.id);
        this.onSessionGone?.({ userId: session.user.id, sessionId: session.id });
        this.broadcastPresenceIfOffline(session.user.id);
      }
    }
  }

  private broadcastPresenceIfOffline(userId: string): void {
    if (this.onlineUserIds().has(userId)) return;
    for (const session of this.sessions.values()) {
      this.dispatch(session, "PRESENCE_UPDATE", { user_id: userId, online: false });
    }
  }

  private onlineUserIdsExcept(except: GatewaySession): Set<string> {
    const ids = new Set<string>();
    for (const s of this.sessions.values()) if (s !== except && s.ws) ids.add(s.user.id);
    return ids;
  }

  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }
}
