import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { openDb } from "./db/index.js";
import { Store } from "./store.js";
import { Gateway } from "./gateway.js";
import { registerRoutes } from "./routes.js";

const app = Fastify({ logger: true });

// Em produção o Traefik serve tudo na mesma origem; o CORS aberto existe só
// para o vite dev server (localhost:5173) falar com o backend (localhost:8080).
if (config.devAuth) {
  await app.register(cors, { origin: true });
}

const db = openDb();
const store = new Store(db);
const gateway = new Gateway(store);

registerRoutes(app, store, gateway);

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
