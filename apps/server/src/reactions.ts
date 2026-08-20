import type { FastifyInstance, FastifyReply } from "fastify";
import { isValidReactionEmoji } from "@danjocord/protocol";
import { authFromHeader } from "./auth.js";
import { canonicalId } from "./db/snowflake.js";
import type { Gateway } from "./gateway.js";
import { SlidingWindow, tooManyRequests } from "./limits.js";
import { MAX_REACTIONS_PER_MESSAGE, MAX_REACTIONS_PER_USER_PER_MESSAGE, type Store } from "./store.js";

/**
 * REST das reações (M11b, item 87).
 *
 * A forma das rotas espelha a do Discord — `.../reactions/:emoji/@me` com PUT e
 * DELETE — e não é enfeite: pôr e tirar a PRÓPRIA reação são operações
 * idempotentes sobre um recurso identificado por (mensagem, emoji, eu), e é
 * exatamente isso que PUT e DELETE significam. Clicar duas vezes no mesmo pad
 * não pode virar dois estados diferentes.
 *
 * O `@me` no caminho é literal de propósito: não existe "tirar a reação de
 * outra pessoa" neste projeto. Se um dia existir (moderação apagando uma
 * reação ofensiva), ela entra como outra rota, e não como um parâmetro que a
 * autorização precise lembrar de conferir.
 */

/**
 * Reagir é barato de fazer e caro de espalhar: cada PUT vira um evento para
 * TODAS as sessões da guild. 20 em 10 s é folgado para quem está brincando com
 * a barra de reações e fecha a porta para o laço automatizado.
 */
export const REACTION_LIMIT = 20;
export const REACTION_WINDOW_MS = 10_000;

export function registerReactionRoutes(app: FastifyInstance, store: Store, gateway: Gateway): void {
  const window = new SlidingWindow(REACTION_LIMIT, REACTION_WINDOW_MS);

  const path = "/api/channels/:channelId/messages/:messageId/reactions/:emoji/@me";

  app.put(path, async (req, reply) => {
    const ctx = resolve(req.headers.authorization, req.params, reply, store);
    if (ctx === null) return reply;

    const wait = window.retryAfterMs(ctx.userId);
    if (wait > 0) return tooManyRequests(reply, wait, "muitas reações seguidas");
    window.record(ctx.userId);

    const result = store.addReaction(ctx.messageId, ctx.userId, ctx.emoji);
    if (!result.ok) {
      return reply.code(409).send({
        error:
          result.reason === "too_many_emojis"
            ? `esta mensagem já tem ${MAX_REACTIONS_PER_MESSAGE} reações diferentes`
            : `você já reagiu ${MAX_REACTIONS_PER_USER_PER_MESSAGE} vezes nesta mensagem`,
      });
    }
    // idempotente: reagir de novo com o mesmo emoji responde 204 e NÃO emite
    // evento — senão um clique duplo pintaria a reação duas vezes na tela de
    // quem já a tinha aplicado
    if (result.created) {
      gateway.broadcast("REACTION_ADD", {
        message_id: ctx.messageId,
        channel_id: ctx.channelId,
        user_id: ctx.userId,
        emoji: ctx.emoji,
      });
    }
    return reply.code(204).send();
  });

  app.delete(path, async (req, reply) => {
    const ctx = resolve(req.headers.authorization, req.params, reply, store);
    if (ctx === null) return reply;

    // sem rate limit no DELETE: tirar reação não cria nada, e limitar a saída
    // deixaria alguém preso a uma reação que quer desfazer

    const removed = store.removeReaction(ctx.messageId, ctx.userId, ctx.emoji);
    if (removed) {
      gateway.broadcast("REACTION_REMOVE", {
        message_id: ctx.messageId,
        channel_id: ctx.channelId,
        user_id: ctx.userId,
        emoji: ctx.emoji,
      });
    }
    // 204 mesmo quando não existia: o estado final é o pedido ("eu não reajo
    // mais com isto"), e é o que DELETE promete
    return reply.code(204).send();
  });
}

interface ReactionContext {
  userId: string;
  channelId: string;
  messageId: string;
  emoji: string;
}

/**
 * Autenticação + as quatro validações que PUT e DELETE compartilham. Devolve
 * null quando já respondeu — o padrão do `staff()`/`target()` do M10.
 *
 * A ordem importa: 401 antes de qualquer coisa, e a existência da mensagem
 * antes do emoji, para que um emoji inválido numa mensagem que não existe não
 * conte como "esta mensagem existe".
 */
function resolve(
  authorization: string | undefined,
  rawParams: unknown,
  reply: FastifyReply,
  store: Store,
): ReactionContext | null {
  const user = authFromHeader(authorization, store);
  if (!user) {
    void reply.code(401).send({ error: "não autenticado" });
    return null;
  }

  // Timeout de chat (M10, item 53) vale AQUI também. Reagir é a única forma
  // nova de escrever no canal que o M11b cria — se ela ficasse de fora, quem
  // está de castigo continuaria "falando" com emojis embaixo das mensagens dos
  // outros, e o castigo viraria enfeite.
  const mutedUntil = store.mutedUntil(user.id);
  if (mutedUntil !== null) {
    void reply.code(403).send({ error: "você está silenciado neste servidor", muted_until: mutedUntil });
    return null;
  }

  const params = rawParams as { channelId: string; messageId: string; emoji: string };
  const channelId = canonicalId(params.channelId);
  const messageId = canonicalId(params.messageId);
  if (channelId === null || messageId === null) {
    void reply.code(404).send({ error: "mensagem não encontrada" });
    return null;
  }
  // `getMessage` filtra canal errado E apagada: reagir em mensagem apagada é
  // 404, não 204 — a reação não teria onde aparecer, e aceitar em silêncio
  // deixaria linhas em `reactions` apontando para o nada
  const message = store.getMessage(channelId, messageId);
  if (!message) {
    void reply.code(404).send({ error: "mensagem não encontrada" });
    return null;
  }

  const emoji = params.emoji;
  if (typeof emoji !== "string" || !isValidReactionEmoji(emoji)) {
    void reply.code(400).send({
      error: "reação inválida — mande UM emoji (nada de texto, sequências compostas ou vários emojis)",
    });
    return null;
  }

  return { userId: user.id, channelId, messageId, emoji };
}

