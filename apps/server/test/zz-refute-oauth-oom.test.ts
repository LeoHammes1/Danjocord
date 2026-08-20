/** Refutação do achado: flood anônimo em /auth/discord/start enche `pending`? */
import { test } from "node:test";
import { register } from "tsx/esm/api";
register();

process.env.DISCORD_CLIENT_ID = "test-client-id";
process.env.DISCORD_CLIENT_SECRET = "test-client-secret";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { Guild } = await import("../src/guild.js");
const { Sessions } = await import("../src/sessions.js");
const { registerOAuthRoutes } = await import("../src/oauth.js");

const db = openDb(":memory:");
const store = new Store(db);
const app = Fastify();
registerOAuthRoutes(app, store, new Sessions(db, store), new Guild(db));

test("flood do achado: 2000 GETs anonimos seguidos", async () => {
  const codes: Record<number, number> = {};
  const states = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const res = await app.inject({
      method: "GET",
      url: "/auth/discord/start",
      headers: { "x-forwarded-for": `203.0.113.${i % 254}`, "x-real-ip": `198.51.100.${i % 254}` },
    });
    codes[res.statusCode] = (codes[res.statusCode] ?? 0) + 1;
    if (res.statusCode === 302) {
      states.add(String(new URL(String(res.headers.location)).searchParams.get("state")));
    }
  }
  console.log("status:", JSON.stringify(codes));
  console.log("entradas de estado OAuth criadas:", states.size);
  const r = await app.inject({ method: "GET", url: "/auth/discord/start" });
  console.log("recusa:", r.statusCode, r.body.slice(0, 90), "| retry-after:", r.headers["retry-after"]);
});
