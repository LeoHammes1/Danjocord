import type { FastifyInstance } from "fastify";
import { CreateMessageBody, UpdateMessageBody } from "@danjocord/protocol";
import type { Store } from "./store.js";
import type { Gateway } from "./gateway.js";
import { authenticate } from "./auth.js";

/**
 * Superfície REST mínima (doc §4: mutações entram por REST; o gateway só faz
 * o fan-out do Dispatch resultante).
 */

/**
 * Valida E canoniza um id vindo de path/query: "01" vira "1". Sem isto, o id
 * cru do caminho ecoaria nos broadcasts e nenhum cliente casaria o data-id —
 * dessincronização silenciosa de todo mundo (achado de revisão do M2).
 * null = inválido (rota responde 404).
 */
function pathId(raw: string | undefined): string | null {
  if (raw === undefined || !/^\d{1,20}$/.test(raw)) return null;
  return BigInt(raw).toString();
}

export function registerRoutes(app: FastifyInstance, store: Store, gateway: Gateway): void {
  app.get("/healthz", async () => ({ ok: true }));

  app.post("/api/channels/:channelId/messages", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });

    const channelId = pathId((req.params as { channelId: string }).channelId);
    if (channelId === null || !store.channelExists(channelId, "text")) {
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

    const channelId = pathId((req.params as { channelId: string }).channelId);
    if (channelId === null || !store.channelExists(channelId)) {
      return reply.code(404).send({ error: "canal não encontrado" });
    }

    const q = req.query as { before?: string; limit?: string };
    const before = q.before !== undefined ? pathId(q.before) : null;
    // só dígitos: Number("2.5") sobreviveria ao clamp e viraria REAL no LIMIT
    // do SQLite → 500 SQLITE_MISMATCH (achado de revisão do M2)
    const limit = q.limit !== undefined && /^\d{1,3}$/.test(q.limit) ? Number(q.limit) : 50;
    return store.listMessages(channelId, before, limit);
  });

  app.patch("/api/channels/:channelId/messages/:messageId", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });

    const params = req.params as { channelId: string; messageId: string };
    const channelId = pathId(params.channelId);
    const messageId = pathId(params.messageId);
    if (channelId === null || messageId === null) {
      return reply.code(404).send({ error: "mensagem não encontrada" });
    }
    // getMessage já filtra apagada/canal errado — os três casos são o mesmo 404
    const message = store.getMessage(channelId, messageId);
    if (!message) return reply.code(404).send({ error: "mensagem não encontrada" });
    // editar é SÓ do autor — admin apaga, mas não reescreve a fala dos outros
    if (message.author_id !== user.id) {
      return reply.code(403).send({ error: "só o autor pode editar" });
    }

    const body = UpdateMessageBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "corpo inválido" });

    const updated = store.updateMessage(messageId, body.data.content);
    gateway.broadcast("MESSAGE_UPDATE", updated);
    return reply.code(200).send(updated);
  });

  app.delete("/api/channels/:channelId/messages/:messageId", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });

    const params = req.params as { channelId: string; messageId: string };
    const channelId = pathId(params.channelId);
    const messageId = pathId(params.messageId);
    if (channelId === null || messageId === null) {
      return reply.code(404).send({ error: "mensagem não encontrada" });
    }
    const message = store.getMessage(channelId, messageId);
    if (!message) return reply.code(404).send({ error: "mensagem não encontrada" });
    // autor apaga o que é seu; admin apaga qualquer coisa (moderação, doc §5)
    if (message.author_id !== user.id && !store.isAdmin(user.id)) {
      return reply.code(403).send({ error: "sem permissão para apagar" });
    }

    store.softDeleteMessage(messageId);
    // ids da LINHA, não do path: são os canônicos que os clientes conhecem
    gateway.broadcast("MESSAGE_DELETE", { id: message.id, channel_id: message.channel_id });
    return reply.code(204).send();
  });

  app.post("/api/channels/:channelId/typing", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });

    const channelId = pathId((req.params as { channelId: string }).channelId);
    if (channelId === null || !store.channelExists(channelId, "text")) {
      return reply.code(404).send({ error: "canal de texto não encontrado" });
    }

    // efêmero de propósito: nada persiste — broadcast para todos (o cliente
    // ignora o próprio user_id) e o indicador expira sozinho (~10s) lá
    gateway.broadcast("TYPING_START", { channel_id: channelId, user_id: user.id });
    return reply.code(204).send();
  });
}

function authFromHeader(header: string | undefined, store: Store) {
  if (!header?.startsWith("Bearer ")) return null;
  return authenticate(store, header.slice("Bearer ".length));
}
