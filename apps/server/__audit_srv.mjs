process.env.DANJOCORD_DEV_AUTH = "1";
process.env.NODE_ENV = "test";
import { createServer } from "node:http";
import Fastify from "fastify";
import { openDb } from "./dist/db/index.js";
import { Store } from "./dist/store.js";
import { registerLinkRoutes } from "./dist/links/routes.js";
import { blockedAddressReason } from "./dist/links/guard.js";

const N = Number(process.argv[2] ?? 120000);
const BODY = "<meta " + "a".repeat(N) + ">";

const evil = createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(BODY);
});
await new Promise((r) => evil.listen(0, "127.0.0.1", r));

const app = Fastify();
app.get("/healthz", async () => ({ ok: true }));
registerLinkRoutes(app, new Store(openDb(":memory:")), {
  fetchDeps: { allowAnyPort: true, blockedAddressReason: (ip) => (ip === "127.0.0.1" ? null : blockedAddressReason(ip)) },
});
await app.listen({ port: 0, host: "127.0.0.1" });
console.log(JSON.stringify({ app: app.server.address().port, evil: evil.address().port, bytes: Buffer.byteLength(BODY) }));
