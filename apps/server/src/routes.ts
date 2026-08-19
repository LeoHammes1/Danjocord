import type { FastifyInstance } from "fastify";
import { AckMessageBody, CreateMessageBody, UpdateMessageBody, parseMentions } from "@danjocord/protocol";
import type { Store } from "./store.js";
import type { Gateway } from "./gateway.js";
import { authFromHeader } from "./auth.js";
import { canonicalId as pathId, idFromString } from "./db/snowflake.js";

/**
 * Superfície REST mínima (doc §4: mutações entram por REST; o gateway só faz
 * o fan-out do Dispatch resultante).
 */

export function registerRoutes(app: FastifyInstance, store: Store, gateway: Gateway): void {
  app.get("/healthz", async () => ({ ok: true }));

  app.post("/api/channels/:channelId/messages", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });

    const channelId = pathId((req.params as { channelId: string }).channelId);
    if (channelId === null || !store.channelExists(channelId, "text")) {
      return reply.code(404).send({ error: "canal de texto não encontrado" });
    }

    // Timeout de chat (M10, item 53). Fica AQUI e não num hook global porque é
    // silêncio no TEXTO: quem está de castigo continua ouvindo e falando na
    // voz, lendo o histórico e apertando o soundboard — só não escreve.
    // Expira SOZINHO, na comparação com o relógio: não existe job de limpeza,
    // e um timeout vencido durante um restart simplesmente deixa de valer.
    const mutedUntil = store.mutedUntil(user.id);
    if (mutedUntil !== null) {
      return reply.code(403).send({
        error: `você está silenciado neste servidor até ${new Date(mutedUntil).toISOString()}`,
        // epoch ms junto: a UI mostra a hora no fuso de quem lê e conta o
        // relógio regressivo sem ter que interpretar a frase acima
        muted_until: mutedUntil,
      });
    }

    const body = CreateMessageBody.safeParse(req.body);
    if (!body.success) {
      // o `type` do corpo só aceita "user" (schema): mensagem de sistema nasce
      // no servidor, e a recusa é explícita para não parecer que foi gravada
      const forjado = (req.body as { type?: unknown } | undefined)?.type;
      if (forjado !== undefined && forjado !== "user") {
        return reply.code(400).send({ error: "só o servidor cria mensagem de sistema" });
      }
      // M11b: a regra "ou texto ou anexo" é um `superRefine` do schema, e a
      // frase dela é útil — repetir "corpo inválido" aqui esconderia o motivo
      // exato para quem está integrando
      const custom = body.error.issues.find((issue) => issue.code === "custom");
      return reply.code(400).send({ error: custom?.message ?? "corpo inválido" });
    }

    // Reply (M11b, item 86). Três recusas, e a do meio é a que importa:
    // citar mensagem de OUTRO canal vazaria conteúdo entre canais pelo trecho
    // que o servidor resolve na citação — quem não pode ler o canal #privado
    // leria um pedaço dele citado no #geral.
    let replyToId: string | undefined;
    if (body.data.reply_to_id !== undefined) {
      const wanted = pathId(body.data.reply_to_id);
      const info = wanted === null ? null : store.messageRefInfo(wanted);
      if (wanted === null || info === null) {
        return reply.code(400).send({ error: "a mensagem citada não existe" });
      }
      if (info.channelId !== channelId) {
        return reply.code(400).send({ error: "não dá para citar mensagem de outro canal" });
      }
      if (info.deleted) {
        // citar algo que JÁ estava apagado no momento do envio é diferente de
        // a citada ser apagada depois: o segundo caso vira "mensagem apagada"
        // na tela (e é para isso que a linha continua existindo); o primeiro é
        // um cliente com a tela desatualizada, e merece o aviso
        return reply.code(400).send({ error: "a mensagem citada foi apagada" });
      }
      replyToId = wanted;
    }

    // Anexos (M11b, item 89): os ids vêm do `POST /api/attachments`, e cada um
    // precisa ser MEU e ainda estar solto. Sem as duas checagens, bastaria
    // adivinhar um id (são snowflakes sequenciais no tempo) para pendurar a
    // imagem de outra pessoa numa mensagem própria — ou para republicar um
    // anexo que já está numa mensagem antiga.
    const attachmentIds: string[] = [];
    for (const rawId of body.data.attachment_ids ?? []) {
      const id = pathId(rawId);
      const owner = id === null ? null : store.attachmentOwnership(id);
      if (id === null || owner === null || owner.uploaderId !== user.id || owner.attached) {
        return reply.code(400).send({ error: "anexo inválido, já usado ou de outra pessoa" });
      }
      attachmentIds.push(id);
    }

    // Menções resolvidas AQUI, no POST (M11a, item 79), e não na leitura: é o
    // que transforma "quantas não lidas me mencionam" numa query. O parser é o
    // MESMO módulo que o cliente usa para pintar a pílula — duas
    // implementações divergiriam no primeiro nome com ponto.
    // `listMembers()` já devolve id/username/nickname, que é exatamente o
    // MentionCandidate; e só quem está na guild AGORA pode ser mencionado.
    const parsed = parseMentions(body.data.content, store.listMembers());
    const message = store.createMessage(channelId, user.id, body.data.content, {
      mentions: parsed.userIds,
      everyone: parsed.everyone,
      ...(replyToId === undefined ? {} : { replyToId }),
      ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
    });
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

  /**
   * "Li até aqui" (M11a, item 81). É a base do badge de não lidas, do separador
   * de "novas mensagens" e de qualquer notificação que não queira avisar duas
   * vezes pela mesma mensagem.
   *
   * Quem manda o id é o cliente, porque só ele sabe o que de fato apareceu na
   * tela — o servidor não distingue "a janela está no fundo do canal" de "a aba
   * está no tray há duas horas". As garantias (não retroceder, não passar da
   * última mensagem) moram no `store.markRead`, com o porquê de cada uma.
   */
  app.post("/api/channels/:channelId/ack", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });

    const channelId = pathId((req.params as { channelId: string }).channelId);
    if (channelId === null || !store.channelExists(channelId, "text")) {
      return reply.code(404).send({ error: "canal de texto não encontrado" });
    }

    const body = AckMessageBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "corpo inválido" });
    // mesma canonização dos ids de path: "01" e "1" são a mesma mensagem, e um
    // id não-numérico vira 400 em vez de BigInt() explodindo em 500
    const messageId = pathId(body.data.message_id);
    if (messageId === null) return reply.code(400).send({ error: "id de mensagem inválido" });

    const marked = store.markRead(user.id, channelId, messageId);
    // canal sem mensagem nenhuma: não há o que marcar, e 204 é a resposta certa
    // (o cliente não precisa tratar um caso que não é erro)
    if (marked !== null) {
      // SÓ as sessões do próprio usuário: quem tem o desktop e uma aba abertos
      // não pode ver a badge sumir num e continuar acesa no outro. O evento
      // sai mesmo quando a marca não andou — ele é o estado atual, não um
      // delta, e reenviá-lo é idempotente para quem recebe.
      gateway.dispatchToUser(user.id, "MESSAGE_ACK", { channel_id: channelId, last_read_message_id: marked });
    }
    return reply.code(204).send();
  });

  /**
   * Um usuário pelo id (M11a). Existe por causa do HISTÓRICO: a lista de
   * membros do READY tem só quem está na guild AGORA, e mensagem de quem foi
   * expulso — ou a própria mensagem de sistema "fulano saiu" (item 92) — ficaria
   * assinada por um autor que o cliente não sabe nomear (o "?" do item 85).
   *
   * A linha em `users` nunca é apagada justamente para isto. Responde a
   * qualquer membro autenticado: com uma guild de ≤10 amigos, quem já esteve
   * aqui não é segredo para quem está — e o que sai é o MESMO objeto que já
   * viaja no READY, nada além.
   */
  app.get("/api/users/:userId", async (req, reply) => {
    const me = authFromHeader(req.headers.authorization, store);
    if (!me) return reply.code(401).send({ error: "não autenticado" });

    const userId = pathId((req.params as { userId: string }).userId);
    const user = userId === null ? null : store.getUserById(idFromString(userId));
    if (!user) return reply.code(404).send({ error: "usuário não encontrado" });
    return user;
  });

  app.post("/api/channels/:channelId/typing", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });

    const channelId = pathId((req.params as { channelId: string }).channelId);
    if (channelId === null || !store.channelExists(channelId, "text")) {
      return reply.code(404).send({ error: "canal de texto não encontrado" });
    }

    // silenciado não anuncia digitação: o POST da mensagem vai ser recusado
    // logo em seguida, e o indicador prometeria aos outros uma fala que nunca
    // chega. 204 mesmo assim — o cliente não precisa tratar um erro aqui.
    if (store.mutedUntil(user.id) !== null) return reply.code(204).send();

    // efêmero de propósito: nada persiste — broadcast para todos (o cliente
    // ignora o próprio user_id) e o indicador expira sozinho (~10s) lá
    gateway.broadcast("TYPING_START", { channel_id: channelId, user_id: user.id });
    return reply.code(204).send();
  });
}

