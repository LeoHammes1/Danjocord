/** PoC temporario de auditoria — apagar depois. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { register } from "tsx/esm/api";
register();
process.env.DANJOCORD_DEV_AUTH = "1";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { registerLinkRoutes } = await import("../src/links/routes.js");
const { blockedAddressReason } = await import("../src/links/guard.js");
const { extractMeta } = await import("../src/links/html.js");
const { fetchHtmlForPreview } = await import("../src/links/fetch.js");

const db = openDb(":memory:");
const store = new Store(db);
const app = Fastify();
app.get("/healthz", async () => ({ ok: true }));
registerLinkRoutes(app, store, {
  fetchDeps: { allowAnyPort: true, blockedAddressReason: (ip) => (ip === "127.0.0.1" ? null : blockedAddressReason(ip)) },
});

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });
const evil = (attrs: number) => "<meta " + "a".repeat(attrs) + ">";

async function serveBody(body: string): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("1) o html chega inteiro em extractMeta e o custo e do regex", async () => {
  for (const kb of [30, 60]) {
    const base = await serveBody(evil(kb * 1024));
    const fetched = await fetchHtmlForPreview(`${base}/x`, {
      allowAnyPort: true, blockedAddressReason: (ip) => (ip === "127.0.0.1" ? null : blockedAddressReason(ip)),
    });
    const t = Date.now();
    extractMeta(fetched.html);
    console.log(`attrs=${kb} KB -> html recebido = ${fetched.html.length} chars, extractMeta = ${Date.now() - t} ms`);
  }
});

test("2) /healthz concorrente fica sem resposta durante o bloqueio", async () => {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  const base = await serveBody(evil(60 * 1024));

  // healthz sozinho, para referencia
  let t = Date.now();
  await fetch(`http://127.0.0.1:${port}/healthz`);
  console.log(`healthz ocioso: ${Date.now() - t} ms`);

  const attack = fetch(`http://127.0.0.1:${port}/api/link-preview?url=${encodeURIComponent(base + "/x")}`,
    { headers: { authorization: "Bearer dev.atacante" } });
  await new Promise((r) => setTimeout(r, 150)); // deixa o fetch do alvo comecar
  t = Date.now();
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  const healthMs = Date.now() - t;
  const res = await attack;
  console.log(`healthz DURANTE o ataque: ${healthMs} ms (status ${health.status}); ataque status=${res.status}`);
  await app.close();
});
