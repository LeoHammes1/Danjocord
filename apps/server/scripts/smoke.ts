/**
 * Smoke test do gateway: sobe nada — assume o servidor rodando em
 * http://localhost:8080. Percorre o caminho feliz de M0+M2:
 * Hello → Identify → Ready → Heartbeat/ACK → POST mensagem → MESSAGE_CREATE
 * → PATCH → MESSAGE_UPDATE → DELETE → MESSAGE_DELETE → typing → TYPING_START.
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
let meId: string | null = null;
let messageId: string | null = null;
const nonce = `smoke-${Date.now()}`;
const EDITED = "mensagem do smoke test (editada)";

// O Dispatch pode chegar ANTES da resposta REST que o provocou (fan-out não
// espera o flush do HTTP). Cada handler guarda a promise do seu passo REST e
// o handler do evento seguinte espera por ela — os passos saem em ordem.
let restPending: Promise<void> | null = null;

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
    meId = msg.d.user.id;
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
    messageId = msg.d.id;
    const history = await fetch(`${BASE}/api/channels/${channelId}/messages?limit=5`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((r) => r.json());
    if (!Array.isArray(history) || history.length < 1) fail("histórico vazio após enviar mensagem");
    step(`histórico (${history.length} mensagens)`);
    // M2: edita a mensagem recém-criada — o gateway deve ecoar MESSAGE_UPDATE
    restPending = (async () => {
      const patch = await fetch(`${BASE}/api/channels/${channelId}/messages/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ content: EDITED }),
      });
      if (patch.status !== 200) fail(`PATCH mensagem devolveu ${patch.status}`);
      step("patch mensagem 200");
    })();
    return;
  }
  if (msg.op === Op.Dispatch && msg.t === "MESSAGE_UPDATE") {
    if (msg.d.id !== messageId) return; // edição de outra sessão
    await restPending;
    if (msg.d.content !== EDITED) fail(`MESSAGE_UPDATE sem o conteúdo editado (veio "${msg.d.content}")`);
    if (typeof msg.d.edited_at !== "number") fail("MESSAGE_UPDATE sem edited_at preenchido");
    step("message_update com conteúdo novo");
    restPending = (async () => {
      const del = await fetch(`${BASE}/api/channels/${channelId}/messages/${messageId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (del.status !== 204) fail(`DELETE mensagem devolveu ${del.status}`);
      step("delete mensagem 204");
    })();
    return;
  }
  if (msg.op === Op.Dispatch && msg.t === "MESSAGE_DELETE") {
    if (msg.d.id !== messageId) return;
    await restPending;
    if (msg.d.channel_id !== channelId) fail("MESSAGE_DELETE com channel_id errado");
    step("message_delete");
    // typing não persiste nada — o smoke só confere o fan-out do evento
    restPending = (async () => {
      const typing = await fetch(`${BASE}/api/channels/${channelId}/typing`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (typing.status !== 204) fail(`POST typing devolveu ${typing.status}`);
      step("post typing 204");
    })();
    return;
  }
  if (msg.op === Op.Dispatch && msg.t === "TYPING_START") {
    // TYPING_START vai para todos (inclusive quem digita — o cliente é que
    // ignora o próprio); aqui o eco é exatamente o que se quer verificar
    if (msg.d.user_id !== meId || msg.d.channel_id !== channelId) return;
    await restPending;
    step("typing_start com o user_id certo");
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
