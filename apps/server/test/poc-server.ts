/** PoC temporario de auditoria — apagar depois. Servidor alvo, processo separado. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { register } from "tsx/esm/api";
register();
process.env.DANJOCORD_DEV_AUTH = "1";
const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { registerLinkRoutes } = await import("../src/links/routes.js");
const { blockedAddressReason } = await import("../src/links/guard.js");

const db = openDb(":memory:");
const app = Fastify();
app.get("/healthz", async () => ({ ok: true }));
registerLinkRoutes(app, new Store(db), {
  fetchDeps: { allowAnyPort: true, blockedAddressReason: (ip) => (ip === "127.0.0.1" ? null : blockedAddressReason(ip)) },
});

// site hostil, no MESMO processo so por conveniencia do PoC (responde antes do bloqueio)
const ATTRS = Number(process.env.POC_ATTRS ?? 100 * 1024);
const body = "<meta " + "a".repeat(ATTRS) + ">";
const evil = createServer((_r, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
});
await new Promise<void>((r) => evil.listen(0, "127.0.0.1", r));
await app.listen({ port: 0, host: "127.0.0.1" });
console.log(JSON.stringify({
  app: (app.server.address() as AddressInfo).port,
  evil: (evil.address() as AddressInfo).port,
  bytes: Buffer.byteLength(body),
}));
