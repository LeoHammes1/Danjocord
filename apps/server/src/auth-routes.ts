import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import type { Sessions } from "./sessions.js";
import type { Store } from "./store.js";

/**
 * Rotas de autenticação (doc §5). O fluxo normal é OAuth (oauth-routes.ts) →
 * redirect com one-time code → POST /auth/session troca o código pelo par de
 * tokens. Refresh e logout operam só sobre o refresh token: o JWT de acesso
 * não é revogável — a vida curta (accessTokenTtlSec) é a mitigação.
 */

const SessionBody = z.object({ otc: z.string().min(1) });
const RefreshBody = z.object({ refresh_token: z.string().min(1) });
/** mesmo regex do caminho dev do auth.ts — as duas portas criam o mesmo usuário */
const DevBody = z.object({ username: z.string().regex(/^[a-z0-9_]{2,32}$/i) });

export function registerAuthRoutes(app: FastifyInstance, store: Store, sessions: Sessions): void {
  app.post("/auth/session", async (req, reply) => {
    const body = SessionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "corpo inválido" });
    const userId = sessions.consumeOtc(body.data.otc);
    if (userId === null) return reply.code(401).send({ error: "otc inválido" });
    return sessions.create(userId);
  });

  app.post("/auth/refresh", async (req, reply) => {
    const body = RefreshBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "corpo inválido" });
    const rotated = sessions.rotate(body.data.refresh_token);
    // "reused" já revogou a família inteira — o cliente descarta tudo e reloga
    if (rotated === "reused") return reply.code(401).send({ error: "reused" });
    if (rotated === null) return reply.code(401).send({ error: "refresh inválido" });
    return rotated;
  });

  app.post("/auth/logout", async (req, reply) => {
    const body = RefreshBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "corpo inválido" });
    // idempotente: token desconhecido também sai 204 — nada útil a vazar aqui
    sessions.revokeByRefresh(body.data.refresh_token);
    return reply.code(204).send();
  });

  // Login de desenvolvimento: sessão completa sem OAuth. É a porta de entrada
  // do cliente em dev e dos testes — e por isso 404 (não 403) quando
  // desligada: em produção a rota nem existe.
  app.post("/auth/dev", async (req, reply) => {
    if (!config.devAuth) return reply.code(404).send({ error: "não encontrado" });
    const body = DevBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "corpo inválido" });
    const user = store.findOrCreateDevUser(body.data.username.toLowerCase());
    return sessions.create(user.id);
  });
}
