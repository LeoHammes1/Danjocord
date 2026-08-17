import type { FastifyInstance } from "fastify";
import { CreateMessageBody } from "@danjocord/protocol";
import type { Store } from "./store.js";
import type { Gateway } from "./gateway.js";
import { authenticate } from "./auth.js";

/**
 * Superfície REST mínima (doc §4: mutações entram por REST; o gateway só faz
 * o fan-out do Dispatch resultante).
 */
export function registerRoutes(app: FastifyInstance, store: Store, gateway: Gateway): void {
  app.get("/healthz", async () => ({ ok: true }));

  app.post("/api/channels/:channelId/messages", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });

    const { channelId } = req.params as { channelId: string };
    // id não-numérico faria BigInt() lançar dentro do store → 500; 404 antes
    if (!/^\d+$/.test(channelId) || !store.channelExists(channelId, "text")) {
      return reply.code(404).send({ error: "canal de texto não encontrado" });
    }

    const body = CreateMessageBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "corpo inválido" });

    const message = store.createMessage(channelId, user.id, body.data.content);
    // o nonce só ecoa no evento — o cliente usa para reconciliar o render otimista
    gateway.broadcast("MESSAGE_CREATE", body.data.nonce ? { ...message, nonce: body.data.nonce } : message);
    return reply.code(201).send(message);
  });

  app.get("/api/channels/:channelId/messages", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });

    const { channelId } = req.params as { channelId: string };
    if (!/^\d+$/.test(channelId) || !store.channelExists(channelId)) {
      return reply.code(404).send({ error: "canal não encontrado" });
    }

    const q = req.query as { before?: string; limit?: string };
    const before = q.before && /^\d+$/.test(q.before) ? q.before : null;
    const limit = q.limit ? Number(q.limit) : 50;
    return store.listMessages(channelId, before, Number.isFinite(limit) ? limit : 50);
  });
}

function authFromHeader(header: string | undefined, store: Store) {
  if (!header?.startsWith("Bearer ")) return null;
  return authenticate(store, header.slice("Bearer ".length));
}
