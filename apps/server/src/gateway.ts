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
  type PresenceStatus,
  type PresenceUpdateData,
  type Sound,
  type User,
  type VoiceState,
} from "@danjocord/protocol";
import { config } from "./config.js";
import { SlidingWindow } from "./limits.js";
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
  /** soma dos bytes de `ring` — teto próprio, ver MAX_RING_BYTES (auditoria M12) */
  ringBytes: number;
  ws: WebSocket | null;
  lastHeartbeatAt: number;
  disconnectedAt: number | null;
  /**
   * M10 (item 56): status DECLARADO por esta sessão (op 3). Nasce "online" no
   * Identify. Vive só aqui — presença é efêmera e nunca toca o banco, como
   * voice states e ring buffers.
   */
  status: PresenceStatus;
}

/**
 * Prioridade de status quando o MESMO usuário tem várias sessões (desktop +
 * navegador, aba antiga ainda no Resume): vence o mais "presente". Sem uma
 * ordem, quem abrisse uma segunda aba e a deixasse ausente apareceria ausente
 * enquanto digita na primeira.
 */
const STATUS_RANK: Record<PresenceStatus, number> = { online: 3, idle: 2, dnd: 1, offline: 0 };

interface ConnState {
  session: GatewaySession | null;
  identifyTimer: NodeJS.Timeout | null;
}

export class Gateway {
  /**
   * `maxPayload` explícito porque o default do `ws` é 100 MiB, e ele vale
   * ANTES do Identify — qualquer pessoa na internet abre o socket e manda o
   * frame. O pod tem `limits: { memory: 1Gi }` no manifest, então ~3 frames
   * simultâneos bastam para o OOMKill; com `replicas: 1` e `strategy: Recreate`
   * isso derruba todas as chamadas de voz, em laço, sem credencial nenhuma.
   *
   * 256 KiB é folgado para o que trafega aqui: mensagem entra por REST, e o
   * maior frame do gateway é a sinalização de voz (o `join` volta ~3,7 KB com
   * as rtp_capabilities; o `produce` de simulcast é da mesma ordem).
   */
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  private readonly sessions = new Map<string, GatewaySession>();

  /**
   * Tetos de sessão (auditoria M12, rodada 2). Nenhum existia: o
   * `sessions.set` do Identify não perguntava quantas aquele usuário já tinha,
   * nem quantas havia no total. Um membro autenticado abria K WebSockets com o
   * MESMO token e cada um ganhava ring buffer próprio.
   *
   * 8 por usuário cobre folgado o uso real (desktop + navegador + celular, com
   * abas duplicadas e sessões velhas ainda dentro da janela de Resume). O teto
   * global existe porque 10 amigos × 8 = 80, e qualquer número muito acima
   * disso é ataque, não uso.
   */
  private static readonly MAX_SESSIONS_PER_USER = 8;
  private static readonly MAX_SESSIONS_TOTAL = 200;

  /**
   * Teto do ring buffer em BYTES, além do teto em entradas.
   *
   * `config.ringBufferSize` limitava só a CONTAGEM (512 entradas), e cada
   * entrada guarda o JSON já serializado. Com mensagens no tamanho máximo
   * (`CreateMessageBody`, 4000 chars) isso dá ~2 MB por sessão — e o
   * `dispatchRaw` serializa POR sessão, porque o `s` é o sequence de cada uma,
   * então N sessões são N cópias distintas e não uma compartilhada.
   *
   * 256 KB por sessão × 200 sessões = 50 MB no pior caso absoluto, contra o
   * `limits: { memory: 1Gi }` do pod. O Resume perde replay quando o buffer
   * corta por bytes, mas perder replay é um F5; perder o pod é a chamada toda.
   */
  private static readonly MAX_RING_BYTES = 256 * 1024;

  /**
   * Freio da sinalização de voz (op 20). O `chainOp` serializa por sessão mas
   * NÃO limita taxa: o `join` repetido no mesmo canal é o op mais lucrativo do
   * projeto — cada um dispara o leave implícito, fecha o router quando a sala
   * esvazia, recria router + audioLevelObserver, e ainda faz DOIS broadcasts de
   * VOICE_STATE_UPDATE para a guild inteira. Um frame de 57 bytes vira trabalho
   * de milissegundos no worker e fan-out para todo mundo — amplificação medida
   * na auditoria em ~58 Mbps de saída para 0,87 Mbps de entrada.
   *
   * 60/s é ordens de grandeza acima de qualquer uso humano (entrar na voz,
   * criar dois transports, produzir, consumir os pares) e ainda assim tira o
   * multiplicador da mão de quem manda em laço.
   */
  private static readonly VOICE_OPS_PER_SESSION = 60;
  private static readonly VOICE_OPS_WINDOW_MS = 1_000;
  private readonly voiceOps = new SlidingWindow(
    Gateway.VOICE_OPS_PER_SESSION,
    Gateway.VOICE_OPS_WINDOW_MS,
  );

  /**
   * Freio da presença (op 3). Mesma família do op 20: um frame de 30 bytes
   * vira um dispatch POR SESSÃO, com `seq`, `JSON.stringify` e entrada no ring
   * de cada uma. Presença muda no ritmo de quem sai para o café — 10/s é folga
   * de sobra e ainda tira o multiplicador de quem manda em laço.
   */
  private readonly presenceOps = new SlidingWindow(10, 1_000);
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
    // irmão do listener por socket: erro no SERVIDOR (falha de handshake, por
    // exemplo) também é 'error' sem ouvinte, e também mataria o processo
    this.wss.on("error", () => undefined);
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

  /**
   * Avisa todo mundo que o servidor vai sair (roadmap 120). O op 7 existia no
   * protocolo E no cliente desde o M2 — o servidor é que nunca o mandava, então
   * todo deploy chegava aos clientes como uma queda de rede qualquer.
   *
   * O que isto NÃO faz, e é honesto dizer: com `replicas: 1` e `strategy:
   * Recreate`, o pod some inteiro e o worker do mediasoup vai junto. A chamada
   * cai de qualquer jeito. O ganho é o cliente SABER que é planejado — ele
   * fecha com 4900 (preserva a sessão), não pinta a faixa de erro e volta
   * imediatamente, em vez de escalar o backoff até 30 s achando que a rede
   * caiu. Numa janela de deploy de ~20 s, isso é a diferença entre "voltou
   * sozinho" e "ficou meio minuto parado depois de o servidor já estar de pé".
   */
  notifyReconnect(): number {
    let avisadas = 0;
    for (const session of this.sessions.values()) {
      if (session.ws?.readyState !== WebSocket.OPEN) continue;
      this.send(session.ws, { op: Op.Reconnect });
      avisadas += 1;
    }
    return avisadas;
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

  /**
   * Fan-out só para as sessões do PRÓPRIO usuário (M11a: MESSAGE_ACK).
   *
   * É o primeiro evento do projeto que não é da guild inteira, e por um motivo
   * concreto: quem tem o desktop e uma aba abertos não pode ver a badge sumir
   * num e continuar acesa no outro. Aos outros membros, o que eu já li não diz
   * nada — e "fulano leu sua mensagem" é justamente o recurso que ninguém
   * pediu.
   */
  dispatchToUser<T extends DispatchName>(userId: string, t: T, d: Extract<DispatchEvent, { t: T }>["d"]): void {
    for (const session of this.sessions.values()) {
      if (session.user.id === userId) this.dispatchRaw(session, t, d);
    }
  }

  private dispatchRaw(session: GatewaySession, t: DispatchName, d: unknown): void {
    session.seq += 1;
    const raw = JSON.stringify({ op: Op.Dispatch, s: session.seq, t, d });
    session.ring.push({ s: session.seq, raw });
    session.ringBytes += raw.length;
    // Dois tetos: entradas (janela de replay do Resume) e BYTES. O de bytes é
    // da auditoria M12 — sem ele, 512 mensagens no tamanho máximo davam ~2 MB
    // por sessão, e o dispatchRaw serializa POR sessão (o `s` é o sequence de
    // cada uma), então K sessões eram K cópias e não uma compartilhada.
    while (
      session.ring.length > config.ringBufferSize ||
      (session.ringBytes > Gateway.MAX_RING_BYTES && session.ring.length > 1)
    ) {
      const saiu = session.ring.shift();
      if (saiu === undefined) break;
      session.ringBytes -= saiu.raw.length;
    }
    if (session.ws?.readyState === WebSocket.OPEN) session.ws.send(raw);
  }

  onlineUserIds(): Set<string> {
    const ids = new Set<string>();
    for (const s of this.sessions.values()) if (s.ws) ids.add(s.user.id);
    return ids;
  }

  /**
   * Status efetivo de um usuário: o mais "presente" entre as sessões dele com
   * socket vivo. Sem socket vivo (ou tendo declarado invisível em todas) =
   * "offline" — do ponto de vista de quem olha, é a mesma coisa.
   */
  presenceOf(userId: string): PresenceStatus {
    let best: PresenceStatus = "offline";
    for (const s of this.sessions.values()) {
      if (!s.ws || s.user.id !== userId) continue;
      if (STATUS_RANK[s.status] > STATUS_RANK[best]) best = s.status;
    }
    return best;
  }

  /** Snapshot para o READY: só quem NÃO está offline (a ausência é o offline). */
  presences(): PresenceUpdateData[] {
    const out: PresenceUpdateData[] = [];
    for (const userId of this.onlineUserIds()) {
      const status = this.presenceOf(userId);
      if (status !== "offline") out.push({ user_id: userId, status });
    }
    return out;
  }

  /**
   * Derruba TODAS as sessões de gateway de um usuário — o lado ATIVO do furo do
   * kickado (roadmap 114). O gateway valida o token uma vez, no Identify, e
   * nunca mais: sem isto, quem foi expulso continuaria lendo o chat e ouvindo a
   * voz até resolver fechar a aba.
   *
   * A sessão sai do mapa ANTES do close: assim o `onSessionGone` tira o alvo da
   * voz na hora, e um Resume com o mesmo session_id não encontra nada para
   * retomar. Devolve quantas caíram (o chamador loga).
   */
  closeUserSessions(userId: string, reason: string, code: number = CloseCode.NotAMember): number {
    let closed = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.user.id !== userId) continue;
      this.dropSession(session, reason, code);
      closed += 1;
    }
    return closed;
  }

  /** Fim de linha de uma sessão: fora do mapa, fora da voz, socket fechado. */
  private dropSession(session: GatewaySession, reason: string, code: number): void {
    if (this.sessions.get(session.id) !== session) return;
    this.sessions.delete(session.id);
    this.onSessionGone?.({ userId: session.user.id, sessionId: session.id });
    const ws = session.ws;
    ws?.close(code, reason);
    session.ws = null;
    // ARMADILHA (auditoria M12): `close()` é o handshake GRACIOSO — o servidor
    // manda o close frame e só destrói o socket quando o cliente responde, ou
    // depois do closeTimeout do `ws`, que são 30 SEGUNDOS. Um cliente que
    // simplesmente ignora o frame continua mandando dados nesse intervalo, e o
    // `Receiver` segue emitindo 'message'. Para o kickado isso era meia janela
    // de moderação: dava para seguir mandando op 20 e op 3 com a sessão já
    // morta. O guard no onMessage fecha a porta lógica; este timer garante que
    // o socket também morre, em vez de ficar meio minuto de pé.
    if (ws) setTimeout(() => ws.terminate(), 2_000).unref();
    this.broadcastPresence(session.user.id);
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

    // CRÍTICO: sem este listener, QUALQUER erro de socket vira exceção não
    // tratada e derruba o PROCESSO — no Node, um evento 'error' sem ouvinte é
    // `throw`. Não é teórico: eu derrubei o pod de produção mandando um frame
    // de 300 KiB (o `maxPayload` recusa e emite 'error'), sem autenticação
    // nenhuma. Um `ws.close()` já é feito pelo próprio `ws` nesses casos; o que
    // faltava era alguém ouvindo.
    //
    // Vale para todo o resto também: ECONNRESET, UTF-8 inválido, violação de
    // frame. O `maxPayload` que eu adicionei antes só tornou o gatilho trivial.
    ws.on("error", () => {
      // Corpo VAZIO de propósito, e não por preguiça: o `ws` já fecha o socket
      // sozinho nesses casos, e o `close` acima faz a limpeza da sessão. O que
      // faltava era existir um ouvinte. Também não se loga: isto é a porta
      // aberta na internet, e um erro por frame daria a quem inunda o poder de
      // encher o disco de log junto.
    });

    ws.on("close", () => {
      if (state.identifyTimer) clearTimeout(state.identifyTimer);
      const session = state.session;
      if (session && session.ws === ws) {
        session.ws = null;
        session.disconnectedAt = Date.now();
        this.broadcastPresence(session.user.id);
      }
    });
  }

  private onMessage(ws: WebSocket, state: ConnState, msg: ClientMessage): void {
    // GUARD DA SESSÃO MORTA (auditoria M12). `state.session` é a referência que
    // esta CONEXÃO guardou no Identify; o `dropSession` tira a sessão do mapa
    // mas não tem como reescrever essa referência. Sem esta checagem, um
    // kickado/banido que ignore o close frame continuava sendo atendido pelos
    // handlers de op 3 e op 20 durante os 30 s do closeTimeout do `ws` — só o
    // op 1 revalidava pertencimento. O mapa é a fonte da verdade sobre quem
    // ainda existe; a referência guardada não é.
    if (state.session !== null && this.sessions.get(state.session.id) !== state.session) {
      state.session = null;
      ws.terminate();
      return;
    }
    switch (msg.op) {
      case Op.Heartbeat: {
        const session = state.session;
        if (session) {
          // REVALIDAÇÃO PASSIVA (roadmap 114, o segundo lado do furo). O token
          // foi conferido uma única vez, no Identify; sem esta linha, uma
          // mudança feita FORA deste processo — `scripts/allowlist.ts remove`,
          // um ban aplicado por outro pod, o banco editado à mão — não
          // alcançaria a sessão aberta, e o expulso seguiria lendo o chat e
          // ouvindo a voz. O caminho ativo (closeUserSessions) cobre o kick
          // pela UI; este cobre todo o resto, a ~1 query por 41 s por sessão.
          //
          // NÃO revalidamos o JWT aqui de propósito: ele expira em 15 min e a
          // conexão dura horas — reautenticar no heartbeat derrubaria toda
          // chamada longa. O que se revalida é PERTENCIMENTO, que é o que muda.
          if (!this.store.isMember(session.user.id)) {
            this.dropSession(session, "não é mais membro da guild", CloseCode.NotAMember);
            return;
          }
          session.lastHeartbeatAt = Date.now();
        }
        this.send(ws, { op: Op.HeartbeatAck });
        return;
      }

      case Op.PresenceUpdate: {
        const session = state.session;
        if (!session) {
          ws.close(CloseCode.NotAuthenticated);
          return;
        }
        // Só anuncia se a presença EFETIVA mudou (auditoria M12). O handler
        // era `status = ...; broadcastPresence(...)` incondicional, e o
        // broadcast percorre TODAS as sessões incrementando `seq`, fazendo
        // `JSON.stringify` e empurrando no ring de cada uma. Medido com 121
        // sessões: um frame de 30 bytes gerava 121 dispatches, e 50 frames
        // IDÊNTICOS (status já era o mesmo) geravam 6050.
        //
        // "Efetiva" e não "desta sessão" porque o STATUS_RANK faz o mais
        // presente vencer: quem tem duas abas e põe UMA como ausente não muda
        // nada para os outros — e não deve gerar evento nenhum.
        // A checagem de mudança sozinha não basta: alternar online/idle força
        // broadcast a cada frame. Presença é humana — 10/s já é absurdo — e o
        // silêncio no estouro é deliberado: negar em silêncio um op que não tem
        // resposta no protocolo é melhor que inventar um erro para ele.
        if (this.presenceOps.retryAfterMs(session.id) > 0) return;
        this.presenceOps.record(session.id);

        const antes = this.presenceOf(session.user.id);
        session.status = msg.d.status;
        if (this.presenceOf(session.user.id) !== antes) this.broadcastPresence(session.user.id);
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
        // M10: quem já não pertence à guild não entra nem com token válido —
        // o JWT de 15 min sobrevive ao kick, e sem esta linha o expulso
        // reconectaria e continuaria dentro até o token vencer
        if (!this.store.isMember(user.id)) {
          ws.close(CloseCode.NotAMember, "não é membro da guild");
          return;
        }
        if (state.identifyTimer) clearTimeout(state.identifyTimer);

        // TETOS DE SESSÃO (auditoria M12). Sem eles, um membro autenticado abria
        // K WebSockets com o MESMO token e cada um ganhava ring buffer próprio —
        // e o fan-out serializa POR sessão, então o custo por mensagem postada
        // crescia com K. Reproduzido com K=120.
        //
        // Derruba a MAIS ANTIGA em vez de recusar a nova: recusar puniria quem
        // acabou de abrir o app (e deixaria vivas as sessões velhas, que são
        // justamente as candidatas a lixo). É também o que a intuição espera —
        // fazer login num quarto dispositivo desconecta o primeiro.
        const doUsuario = [...this.sessions.values()].filter((s) => s.user.id === user.id);
        while (doUsuario.length >= Gateway.MAX_SESSIONS_PER_USER) {
          const maisAntiga = doUsuario.shift();
          if (maisAntiga) this.dropSession(maisAntiga, "limite de sessões", CloseCode.SessionTimeout);
        }
        // Teto global: só é alcançável em ataque (10 amigos × 8 = 80), e aqui
        // recusar é o certo — a alternativa seria derrubar a sessão de OUTRA
        // pessoa para acomodar quem está inundando.
        if (this.sessions.size >= Gateway.MAX_SESSIONS_TOTAL) {
          ws.close(CloseCode.SessionTimeout, "servidor com sessões demais");
          return;
        }

        const session: GatewaySession = {
          id: randomUUID(),
          user,
          token: msg.d.token,
          seq: 0,
          ring: [],
          ringBytes: 0,
          ws,
          lastHeartbeatAt: Date.now(),
          disconnectedAt: null,
          // Status DECLARADO no Identify quando o cliente manda (auditoria
          // M12): sem isso a sessão nascia "online" e o broadcast logo abaixo
          // contava isso à guild ANTES de o op 3 poder chegar — quem estava
          // invisível piscava verde a cada reconexão. Ausente = "online",
          // que é o comportamento de sempre.
          status: msg.d.status ?? "online",
        };

        // presença ANTES de a sessão entrar no mapa: é a comparação com o
        // depois que decide se algo mudou (abrir a segunda aba não reanuncia)
        const before = this.presenceOf(user.id);
        this.sessions.set(session.id, session);
        state.session = session;

        this.dispatch(session, "READY", {
          session_id: session.id,
          user,
          channels: this.store.listChannels(),
          members: this.store.listMembers(),
          voice_states: this.voiceStatesProvider?.() ?? [],
          presences: this.presences(),
          sounds: this.soundsProvider?.() ?? [],
          // M11a (item 81): não lidas por canal já resolvidas — sem isto o
          // cliente faria uma requisição por canal só para acender uma bolinha
          read_state: this.store.readStates(user.id),
        });
        if (this.presenceOf(user.id) !== before) this.broadcastPresence(user.id, session);
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
        // mesma revalidação do Identify: o Resume é uma segunda porta de
        // entrada, e uma porta que não checa é uma porta aberta
        if (!this.store.isMember(session.user.id)) {
          this.dropSession(session, "não é mais membro da guild", CloseCode.NotAMember);
          // dropSession fecha o socket ANTIGO da sessão; este aqui é o socket
          // NOVO que pediu o Resume e ainda não foi adotado por ela
          ws.close(CloseCode.NotAMember, "não é mais membro da guild");
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
        // a queda já anunciou offline (ws = null); voltar tem que reanunciar,
        // senão quem retomou a sessão fica fantasma na lista dos outros
        this.broadcastPresence(session.user.id);
        return;
      }

      case Op.VoiceRequest: {
        const session = state.session;
        if (!session) {
          ws.close(CloseCode.NotAuthenticated);
          return;
        }
        // Freio do op 20 (auditoria M12), ANTES de qualquer outra coisa.
        //
        // O `chainOp` serializa por sessão mas não limita TAXA, e o `join`
        // repetido recria router + observer e faz dois broadcasts para a guild
        // — 57 bytes de entrada viravam fan-out para todo mundo.
        //
        // A ORDEM foi corrigida por um teste: com a checagem de `handler` na
        // frente, um servidor sem o módulo de voz ligado respondia "voz
        // indisponível" a um laço infinito sem NUNCA frear. O limite é sobre a
        // taxa de FRAMES, não sobre o que eles conseguem fazer.
        //
        // A chave é a SESSÃO e não o usuário: derrubar a cota de alguém por
        // causa de outra aba dele seria pior que o ataque.
        if (this.voiceOps.retryAfterMs(session.id) > 0) {
          this.send(ws, {
            op: Op.VoiceResponse,
            d: { req: msg.d.req, ok: false, error: "muitas operações de voz — desacelere" },
          });
          return;
        }
        this.voiceOps.record(session.id);

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
        this.broadcastPresence(session.user.id);
      }
    }
  }

  /**
   * Anuncia o status EFETIVO do usuário (recalculado das sessões vivas), nunca
   * o que uma sessão declarou isoladamente: com duas abas abertas, fechar uma
   * não pode dizer "offline" enquanto a outra continua conectada.
   * `except` pula uma sessão que já recebeu o estado por outro caminho (o READY).
   */
  private broadcastPresence(userId: string, except?: GatewaySession): void {
    const status = this.presenceOf(userId);
    for (const session of this.sessions.values()) {
      if (session !== except) this.dispatch(session, "PRESENCE_UPDATE", { user_id: userId, status });
    }
  }

  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }
}
