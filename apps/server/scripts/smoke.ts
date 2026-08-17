/**
 * Smoke test do gateway: sobe nada — assume o servidor rodando em
 * http://localhost:8080. Percorre o caminho feliz inteiro do M0:
 * Hello → Identify → Ready → Heartbeat/ACK → POST mensagem → MESSAGE_CREATE.
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

const timeout = setTimeout(() => fail("timeout de 15s"), 15_000);

const steps: string[] = [];
function step(name: string) {
  steps.push(name);
  console.log(`ok: ${name}`);
}

const ws = new WebSocket(WS_URL);
let ackReceived = false;
let channelId: string | null = null;
const nonce = `smoke-${Date.now()}`;

ws.on("message", async (data) => {
  const msg = ServerMessage.parse(JSON.parse(String(data)));

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
    const text = msg.d.channels.find((c) => c.type === "text") ?? fail("sem canal de texto no snapshot");
    channelId = text.id;
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
    const history = await fetch(`${BASE}/api/channels/${channelId}/messages?limit=5`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((r) => r.json());
    if (!Array.isArray(history) || history.length < 1) fail("histórico vazio após enviar mensagem");
    step(`histórico (${history.length} mensagens)`);
    clearTimeout(timeout);
    console.log(`\nSMOKE OK — ${steps.length} passos`);
    // Nada de process.exit() aqui: no Windows ele dispara assertion do libuv
    // com sockets ainda fechando. Fecha o WS e deixa o event loop drenar
    // (o keep-alive do fetch solta sozinho em ~4s).
    process.exitCode = 0;
    ws.close(1000);
  }
});

ws.on("error", (err) => fail(`erro de socket: ${String(err)}`));
