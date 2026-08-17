import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { openDb } from "./db/index.js";
import { Store } from "./store.js";
import { Gateway } from "./gateway.js";
import { registerRoutes } from "./routes.js";
import { Sessions } from "./sessions.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerOAuthRoutes } from "./oauth.js";
import { registerStaticClient } from "./static-client.js";

// Sem segredo real em produção, todo JWT emitido seria forjável — aborta já.
// Checa o env cru: JWT_SECRET="" passaria pelo ?? do config e não é pego pela
// comparação com o default.
if (!config.devAuth && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  console.error("JWT_SECRET ausente ou curto demais (mínimo 32 chars) em produção — abortando");
  process.exit(1);
}

const app = Fastify({ logger: true });

// A mesma origem serve SPA + API e os tokens vivem no localStorage: um XSS no
// render de mensagens roubaria a sessão — a CSP é a contenção. Em dev o
// cliente vem do vite (:5173), então isto só governa API e cliente estático.
app.addHook("onSend", async (_req, reply) => {
  reply.header("x-content-type-options", "nosniff");
  reply.header(
    "content-security-policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://cdn.discordapp.com data:; " +
      "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
});

// Em produção o Traefik serve tudo na mesma origem; o CORS aberto existe só
// para o vite dev server (localhost:5173) falar com o backend (localhost:8080).
if (config.devAuth) {
  await app.register(cors, { origin: true });
}

const db = openDb();
const store = new Store(db);
const gateway = new Gateway(store);
// UMA instância: os OTCs do fluxo OAuth vivem em memória dentro dela
const sessions = new Sessions(db, store);

registerRoutes(app, store, gateway);
registerAuthRoutes(app, store, sessions);
registerOAuthRoutes(app, db, store, sessions);
await registerStaticClient(app);

await app.listen({ host: config.host, port: config.port });
gateway.attach(app.server);

app.log.info(`gateway em ws://${config.host}:${config.port}/gateway`);
if (config.devAuth) {
  app.log.warn("auth de desenvolvimento LIGADA (token: dev.<username>) — nunca usar em produção");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    gateway.close();
    await app.close();
    db.close();
    process.exit(0);
  });
}
