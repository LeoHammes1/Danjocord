/**
 * Cão de guarda do handshake do gateway.
 *
 * POR QUE EXISTE: o `ServerMessage.parse` é envolto em try/catch para que um
 * frame desconhecido não derrube o handler (roadmap 115). Ignorar é o certo
 * para Dispatch — mas se o engolido for o READY o cliente fica MUDO E VIVO: o
 * servidor considera a sessão autenticada e responde os heartbeats, então não
 * há close, não há reconexão, e a tela fica em "Conectando…" para SEMPRE.
 * Nenhum outro mecanismo percebe isso; só o timer.
 *
 * O WebSocket é falso e o relógio é simulado — o teste não abre socket nem
 * espera 20 s de verdade.
 */
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { GatewayClient } from "../src/gateway.js";

/** Mínimo do WebSocket que o GatewayClient usa, com o que foi enviado gravado. */
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  enviados: unknown[] = [];
  fechadoCom: { code: number; reason: string } | null = null;
  private ouvintes = new Map<string, ((ev: unknown) => void)[]>();
  // campo explícito, e não `constructor(public url)`: o type stripping do Node
  // recusa parameter property (a mesma pedra que o ByteLru do M9 pagou)
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(tipo: string, fn: (ev: unknown) => void): void {
    const lista = this.ouvintes.get(tipo) ?? [];
    lista.push(fn);
    this.ouvintes.set(tipo, lista);
  }
  send(data: string): void {
    this.enviados.push(JSON.parse(data));
  }
  close(code = 1000, reason = ""): void {
    this.fechadoCom = { code, reason };
    this.readyState = 3;
    for (const fn of this.ouvintes.get("close") ?? []) fn({ code, reason });
  }
  /** o servidor mandando um frame para o cliente */
  recebe(msg: unknown): void {
    for (const fn of this.ouvintes.get("message") ?? []) fn({ data: JSON.stringify(msg) });
  }
}

function conecta(): { ws: FakeWebSocket; estados: string[] } {
  FakeWebSocket.instances = [];
  const estados: string[] = [];
  const gw = new GatewayClient("ws://teste/gateway", "tok", {
    status: (s) => estados.push(s),
    dispatch: () => {},
    closed: () => {},
  });
  gw.connect();
  const ws = FakeWebSocket.instances[0];
  assert.ok(ws, "o cliente deveria ter aberto um socket");
  return { ws, estados };
}

const original = globalThis.WebSocket;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket = FakeWebSocket;
process.on("exit", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = original;
});

test("READY engolido: o cão de guarda fecha com 4900 em vez de deixar pendurado", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ws, estados } = conecta();

  // Hello chega e o cliente Identifica normalmente
  ws.recebe({ op: 10, d: { heartbeat_interval: 41_250 } });
  assert.equal((ws.enviados[0] as { op: number }).op, 2, "deveria ter mandado Identify");

  // ...e o READY simplesmente NÃO chega (foi engolido pelo try/catch do parse)
  t.mock.timers.tick(19_000);
  assert.equal(ws.fechadoCom, null, "não pode desistir antes da hora");
  assert.ok(!estados.includes("online"), "não deveria ter ficado online");

  t.mock.timers.tick(2_000);
  assert.deepEqual(ws.fechadoCom, { code: 4900, reason: "handshake sem READY" });
  // 4900 != 1000: o handler de close reconecta (o 1000 seria saída deliberada)
  assert.ok(estados.includes("offline"), "o close deveria ter emitido offline");
});

test("READY normal desarma o cão de guarda — socket não é fechado depois", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ws, estados } = conecta();

  ws.recebe({ op: 10, d: { heartbeat_interval: 41_250 } });
  // payload MÍNIMO que o ServerMessage aceita de verdade — a primeira versão
  // deste fixture faltava campos e era engolida pelo try/catch, fazendo o teste
  // falhar exatamente pelo bug que ele existe para pegar. Bom sinal.
  ws.recebe({
    op: 0,
    s: 1,
    t: "READY",
    d: {
      session_id: "s1",
      user: { id: "1", username: "leo", nickname: null, avatar_url: null, role: "owner", muted_until: null },
      channels: [],
      members: [],
      voice_states: [],
      presences: [],
      sounds: [],
      read_state: [],
    },
  });

  assert.ok(estados.includes("online"), "READY deveria ter ligado o online");
  t.mock.timers.tick(60_000);
  assert.equal(ws.fechadoCom, null, "o cão de guarda não podia mais morder");
});

test("RESUMED também desarma (reconexão com replay não é handshake incompleto)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { ws, estados } = conecta();

  ws.recebe({ op: 10, d: { heartbeat_interval: 41_250 } });
  ws.recebe({ op: 0, s: 7, t: "RESUMED", d: {} });

  assert.ok(estados.includes("online"));
  t.mock.timers.tick(60_000);
  assert.equal(ws.fechadoCom, null);
});
