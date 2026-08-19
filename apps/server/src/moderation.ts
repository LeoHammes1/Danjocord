import type { FastifyInstance, FastifyReply } from "fastify";
import {
  CreateInviteBody,
  ModerationReasonBody,
  TimeoutBody,
  UpdateMeBody,
  UpdateRoleBody,
  displayName,
  roleRank,
  type Invite,
  type User,
} from "@danjocord/protocol";
import { authFromHeader } from "./auth.js";
import { config } from "./config.js";
import { canonicalId, idFromString } from "./db/snowflake.js";
import type { Gateway } from "./gateway.js";
import type { Guild } from "./guild.js";
import { SlidingWindow } from "./limits.js";
import type { Store } from "./store.js";

/**
 * REST de convites e moderação (M10, roadmap §5). Arquivo próprio, no molde do
 * `sounds/routes.ts` do M9: o `routes.ts` é a superfície de MENSAGENS, e
 * misturar as duas faria um arquivo em que ninguém acha a regra de cargo.
 *
 * Duas coisas separam este módulo do resto do REST do projeto:
 *
 *   1. É a primeira superfície com HIERARQUIA. Toda ação sobre outra pessoa
 *      passa por `moderationProblem()` — uma função só, para que "ninguém mexe
 *      no dono" e "admin não mexe em admin" não virem seis `if` divergentes.
 *   2. Tem a ÚNICA rota pública do servidor (`GET /api/invites/:code`). Ela
 *      responde a quem não tem sessão nenhuma, então o que ela conta é
 *      deliberadamente pobre e o que ela custa é limitado por janela.
 *
 * Kick e ban derrubam o acesso pelos TRÊS caminhos que existem, porque cada um
 * cobre um furo diferente:
 *   - `revokeSessionsOfDiscordId` mata o refresh (senão o token rotativo
 *     renovaria o acesso para sempre — a allowlist só é lida no login);
 *   - `closeUserSessions` fecha os WebSockets abertos (o gateway valida o token
 *     uma vez, no Identify — roadmap 114);
 *   - `disconnectFromVoice` tira do canal de voz.
 */

/** Dependências que não moram no banco nem no gateway. */
export interface ModerationDeps {
  /**
   * Tira o alvo de qualquer canal de voz. Vem do módulo de voz pelo wiring do
   * index.ts — esta camada não conhece o mediasoup.
   */
  disconnectFromVoice: (userId: string) => Promise<void>;
}

/**
 * Rate limit da rota PÚBLICA de preview. É a única rota sem autenticação do
 * projeto, e adivinhar código por força bruta não pode ser barato — mesmo o
 * espaço sendo grande (56^10), uma rota pública que consulta o banco sem freio
 * é DoS de graça para qualquer um com um `for`.
 *
 * A chave é o `req.ip`, que é o peer REAL do socket. Atrás do Traefik isso é o
 * IP do proxy, e a janela vira global em vez de por visitante — de propósito:
 * o `x-forwarded-for` é escrito pelo cliente e um atacante rotacionaria valores
 * falsos para furar a janela, que é exatamente o que ela existe para impedir.
 * Com ≤10 amigos, um teto global de 30/min não atrapalha ninguém.
 */
export const PREVIEW_LIMIT = 30;
export const PREVIEW_WINDOW_MS = 60_000;

/**
 * Forma aceitável de um código, checada ANTES de tocar no banco: o alfabeto do
 * `guild.ts` cabe aqui, e um path de 4 KB vira 404 sem virar query.
 */
const CODE_SHAPE = /^[0-9A-Za-z]{1,32}$/;

export function registerModerationRoutes(
  app: FastifyInstance,
  store: Store,
  gateway: Gateway,
  guild: Guild,
  deps: ModerationDeps,
): void {
  const previewWindow = new SlidingWindow(PREVIEW_LIMIT, PREVIEW_WINDOW_MS);

  // -------------------------------------------------------------------------
  // Helpers de autorização
  // -------------------------------------------------------------------------

  /** Autentica e exige cargo de moderação (admin ou owner). null = já respondeu. */
  function staff(authorization: string | undefined, reply: FastifyReply): User | null {
    const user = authFromHeader(authorization, store);
    if (!user) {
      void reply.code(401).send({ error: "não autenticado" });
      return null;
    }
    if (user.role === "member") {
      void reply.code(403).send({ error: "só administradores podem fazer isso" });
      return null;
    }
    return user;
  }

  /**
   * Alvo de uma ação de moderação: precisa existir E ainda pertencer à guild.
   * Quem já saiu responde 404 — a linha em `users` fica para sempre (mensagens
   * antigas apontam para ela), mas ela não é mais um membro.
   */
  function target(rawId: string | undefined, reply: FastifyReply): User | null {
    const id = canonicalId(rawId);
    const user = id === null ? null : store.getUserById(idFromString(id));
    if (!user || !store.isMember(user.id)) {
      void reply.code(404).send({ error: "esta pessoa não está mais na guild" });
      return null;
    }
    return user;
  }

  // -------------------------------------------------------------------------
  // Convites (itens 43–45)
  // -------------------------------------------------------------------------

  app.post("/api/invites", async (req, reply) => {
    const actor = staff(req.headers.authorization, reply);
    if (!actor) return reply;

    const body = CreateInviteBody.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "validade ou limite de usos fora da faixa aceita" });
    }
    // objeto montado campo a campo: com exactOptionalPropertyTypes, mandar
    // `{expiresInS: undefined}` NÃO é o mesmo que omitir, e omitir é o que
    // significa "sem limite" no createInvite
    const opts: { expiresInS?: number; maxUses?: number } = {};
    if (body.data.expires_in_s !== undefined) opts.expiresInS = body.data.expires_in_s;
    if (body.data.max_uses !== undefined) opts.maxUses = body.data.max_uses;

    const invite = guild.createInvite(actor.id, opts);
    guild.log({ actorId: actor.id, action: "invite_create", detail: describeInvite(invite) });
    return reply.code(201).send(invite);
  });

  app.get("/api/invites", async (req, reply) => {
    const actor = staff(req.headers.authorization, reply);
    if (!actor) return reply;
    // a lista COMPLETA, revogados e vencidos inclusive: a UI mostra o histórico
    // ("este link você matou ontem"), e filtrar aqui esconderia o único lugar
    // onde dá para auditar o que já circulou
    return guild.listInvites();
  });

  app.delete("/api/invites/:code", async (req, reply) => {
    const actor = authFromHeader(req.headers.authorization, store);
    if (!actor) return reply.code(401).send({ error: "não autenticado" });

    const code = (req.params as { code: string }).code;
    const invite = CODE_SHAPE.test(code) ? guild.getInvite(code) : null;
    if (!invite) return reply.code(404).send({ error: "convite não encontrado" });
    // admin+ revoga qualquer um; quem criou revoga o seu mesmo depois de ser
    // rebaixado — o link é dele e continuaria valendo em nome dele
    if (actor.role === "member" && invite.created_by !== actor.id) {
      return reply.code(403).send({ error: "só quem criou o convite, ou um administrador, pode revogá-lo" });
    }

    // revogar de novo é no-op: o botão pode ser apertado duas vezes, e só a
    // revogação de VERDADE entra no log (senão o log vira eco de cliques)
    if (guild.revokeInvite(invite.code)) {
      guild.log({ actorId: actor.id, action: "invite_revoke", detail: `convite ${invite.code}` });
    }
    return reply.code(204).send();
  });

  /**
   * PREVIEW PÚBLICO — a única rota sem autenticação do servidor. Quem clica no
   * link ainda não tem conta aqui: precisa saber se vale a pena fazer login no
   * Discord antes de fazê-lo.
   *
   * O que ela conta é o mínimo: nome da guild e quem convidou. Usos restantes,
   * validade, número de membros ou qualquer id transformariam um código vazado
   * num raio-x do servidor — e um código é justamente a coisa que circula em
   * grupo de WhatsApp.
   *
   * Os três motivos de morte (410) VIAJAM, e é de propósito: a landing precisa
   * dizer "expirou, peça outro" em vez de "não vale" (item 47). "Não existe" é
   * 404 e nunca 410 — misturar os dois diria a quem chuta código que ele
   * acertou um que já existiu. E "banido" NUNCA aparece aqui: a rota é pública
   * e não sabe quem está do outro lado; quem descobre isso é o OAuth.
   */
  app.get("/api/invites/:code", async (req, reply) => {
    // a TENTATIVA consome a cota, antes de qualquer validação: o custo que se
    // quer limitar é o de tentar, e código malformado é o chute mais barato
    const wait = previewWindow.retryAfterMs(req.ip);
    if (wait > 0) {
      const seconds = wait / 1000;
      reply.header("retry-after", String(Math.max(1, Math.ceil(seconds))));
      return reply.code(429).send({ error: "muitas tentativas", retry_after: Number(seconds.toFixed(3)) });
    }
    previewWindow.record(req.ip);

    const code = (req.params as { code: string }).code;
    if (!CODE_SHAPE.test(code)) return reply.code(404).send({ error: "convite não encontrado" });

    const problem = guild.inviteProblem(code);
    if (problem === "unknown") return reply.code(404).send({ error: "convite não encontrado" });
    if (problem !== null) return reply.code(410).send({ problem });

    const invite = guild.getInvite(code);
    if (!invite) return reply.code(404).send({ error: "convite não encontrado" });
    const inviter = store.getUserById(idFromString(invite.created_by));
    return reply.code(200).send({
      valid: true,
      guild_name: config.guildName,
      // criador apagado do banco não pode derrubar um link bom
      inviter_name: inviter ? displayName(inviter) : "alguém",
    });
  });

  // -------------------------------------------------------------------------
  // Membros (itens 49, 50, 51, 53)
  // -------------------------------------------------------------------------

  app.post("/api/members/:id/kick", async (req, reply) => {
    const actor = staff(req.headers.authorization, reply);
    if (!actor) return reply;
    const victim = target((req.params as { id: string }).id, reply);
    if (!victim) return reply;
    const denial = moderationProblem(actor, victim);
    if (denial !== null) return reply.code(403).send({ error: denial });

    const body = ModerationReasonBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "motivo inválido (até 500 caracteres)" });

    const discordId = store.discordIdOf(victim.id);
    if (discordId === null) {
      // usuário de desenvolvimento: não passa por allowlist, então "expulsar"
      // não teria efeito nenhum — dizer isso é melhor que fingir que funcionou
      return reply.code(409).send({ error: "usuário de desenvolvimento não passa pela allowlist" });
    }

    // a allowlist é escrita ANTES de derrubar: uma reconexão que corra em
    // paralelo com isto encontra a porta já fechada (Identify e heartbeat
    // consultam store.isMember)
    guild.removeFromAllowlist(discordId);
    guild.log({
      actorId: actor.id,
      action: "kick",
      targetUserId: victim.id,
      targetDiscordId: discordId,
      detail: body.data.reason ?? null,
    });
    await evict(victim, discordId, "expulso da guild");
    return reply.code(204).send();
  });

  app.post("/api/members/:id/ban", async (req, reply) => {
    const actor = staff(req.headers.authorization, reply);
    if (!actor) return reply;
    const victim = target((req.params as { id: string }).id, reply);
    if (!victim) return reply;
    const denial = moderationProblem(actor, victim);
    if (denial !== null) return reply.code(403).send({ error: denial });

    const body = ModerationReasonBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "motivo inválido (até 500 caracteres)" });

    const discordId = store.discordIdOf(victim.id);
    if (discordId === null) {
      return reply.code(409).send({ error: "usuário de desenvolvimento não pode ser banido" });
    }

    // ban É kick + a linha em `bans`: sem sair da allowlist, o login passaria
    // pelo primeiro portão antes de bater no segundo — e `isMember` já trata
    // ban como veto absoluto, então os dois juntos fecham os dois caminhos
    guild.ban(discordId, actor.id, body.data.reason ?? null);
    guild.removeFromAllowlist(discordId);
    guild.log({
      actorId: actor.id,
      action: "ban",
      targetUserId: victim.id,
      targetDiscordId: discordId,
      detail: body.data.reason ?? null,
    });
    await evict(victim, discordId, "banido da guild");
    return reply.code(204).send();
  });

  app.post("/api/members/:id/timeout", async (req, reply) => {
    const actor = staff(req.headers.authorization, reply);
    if (!actor) return reply;
    const victim = target((req.params as { id: string }).id, reply);
    if (!victim) return reply;
    const denial = moderationProblem(actor, victim);
    if (denial !== null) return reply.code(403).send({ error: denial });

    const body = TimeoutBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "minutos fora da faixa (0 a 10080)" });

    const minutes = body.data.minutes;
    // 0 LIMPA (é o "desmutar" do cliente, sem uma rota a mais). O vencimento
    // normal não passa por aqui: expira sozinho na leitura, sem job nenhum.
    const until = minutes === 0 ? null : Date.now() + minutes * 60_000;
    store.setMutedUntil(victim.id, until);
    const updated = store.getUserById(idFromString(victim.id));
    if (!updated) return reply.code(404).send({ error: "esta pessoa não está mais na guild" });

    const reason = body.data.reason ?? null;
    guild.log({
      actorId: actor.id,
      action: minutes === 0 ? "timeout_clear" : "timeout",
      targetUserId: victim.id,
      targetDiscordId: store.discordIdOf(victim.id),
      detail: minutes === 0 ? reason : `${minutes} min${reason === null ? "" : ` — ${reason}`}`,
    });
    gateway.broadcast("MEMBER_UPDATE", updated);
    return reply.code(200).send(updated);
  });

  app.patch("/api/members/:id/role", async (req, reply) => {
    const actor = staff(req.headers.authorization, reply);
    if (!actor) return reply;
    const victim = target((req.params as { id: string }).id, reply);
    if (!victim) return reply;
    const denial = moderationProblem(actor, victim);
    if (denial !== null) return reply.code(403).send({ error: denial });

    const body = UpdateRoleBody.safeParse(req.body);
    if (!body.success) {
      // "owner" cai aqui de propósito: transferir a guild mexe em duas linhas e
      // não pode falhar pela metade — fica fora do M10 (ver o schema)
      return reply.code(400).send({ error: "cargo inválido — só 'admin' ou 'member'" });
    }
    // só se dá um cargo ESTRITAMENTE abaixo do próprio. É o que impede um admin
    // de fabricar outro admin que ele mesmo nunca poderá rebaixar (a regra de
    // cima já o proíbe de mexer em iguais); auto-promoção já morreu na primeira
    // linha do moderationProblem, porque ninguém age sobre si mesmo.
    if (roleRank(body.data.role) >= roleRank(actor.role)) {
      return reply.code(403).send({ error: "você só pode dar um cargo abaixo do seu" });
    }
    if (victim.role === body.data.role) return reply.code(200).send(victim);

    const updated = store.setRole(victim.id, body.data.role);
    if (!updated) return reply.code(404).send({ error: "esta pessoa não está mais na guild" });
    // A invariante "a guild nunca fica sem dono" já é garantida duas vezes: o
    // alvo owner é barrado lá em cima e o cargo owner não entra no schema.
    // Esta checagem existe para o dia em que uma das duas mudar — sair com 500
    // é melhor que sair com uma guild sem dono, que não tem conserto pela UI.
    if (!store.hasOwner()) throw new Error("moderação: a guild ficaria sem owner — mudança abortada");

    guild.log({
      actorId: actor.id,
      action: "role_change",
      targetUserId: victim.id,
      targetDiscordId: store.discordIdOf(victim.id),
      detail: body.data.role,
    });
    gateway.broadcast("MEMBER_UPDATE", updated);
    return reply.code(200).send(updated);
  });

  // -------------------------------------------------------------------------
  // Bans (item 50)
  // -------------------------------------------------------------------------

  app.get("/api/bans", async (req, reply) => {
    const actor = staff(req.headers.authorization, reply);
    if (!actor) return reply;
    return guild.listBans();
  });

  app.delete("/api/bans/:discordId", async (req, reply) => {
    const actor = staff(req.headers.authorization, reply);
    if (!actor) return reply;

    const discordId = (req.params as { discordId: string }).discordId;
    // id do DISCORD (não o nosso snowflake): a tabela é indexada por ele para
    // que banir funcione até para quem nunca criou linha em `users`
    if (!/^\d{1,20}$/.test(discordId)) return reply.code(404).send({ error: "banimento não encontrado" });
    if (!guild.unban(discordId)) return reply.code(404).send({ error: "banimento não encontrado" });

    // desbanir NÃO readmite: a pessoa volta a poder USAR um convite, e é isso.
    // Readmitir aqui seria uma porta que ninguém pediu para abrir.
    guild.log({ actorId: actor.id, action: "unban", targetDiscordId: discordId });
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // Identidade própria (item 55) e log (item 57)
  // -------------------------------------------------------------------------

  app.patch("/api/users/@me", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });

    // "" e null significam a MESMA coisa aqui — limpar. O schema recusa string
    // vazia (o apelido tem 1..32), então a normalização vem antes dele: um
    // campo de texto esvaziado é o gesto óbvio de "quero remover meu apelido",
    // e 400 nesse gesto seria um beco sem saída na UI.
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const patchInput: Record<string, unknown> = { ...raw };
    if (typeof raw["nickname"] === "string" && raw["nickname"].trim() === "") patchInput["nickname"] = null;

    const body = UpdateMeBody.safeParse(patchInput);
    if (!body.success) return reply.code(400).send({ error: "apelido inválido (1 a 32 caracteres)" });

    const patch: { nickname?: string | null; avatarOverride?: string | null } = {};
    if (body.data.nickname !== undefined) patch.nickname = body.data.nickname;
    if (body.data.avatar_override !== undefined) patch.avatarOverride = body.data.avatar_override;

    const updated = store.updateGuildIdentity(user.id, patch);
    if (!updated) return reply.code(404).send({ error: "usuário não encontrado" });
    // apelido não é moderação: não entra no mod_log de propósito — o log
    // responde "quem me expulsou", não "quem trocou de apelido"
    gateway.broadcast("MEMBER_UPDATE", updated);
    return reply.code(200).send(updated);
  });

  app.get("/api/mod-log", async (req, reply) => {
    const actor = staff(req.headers.authorization, reply);
    if (!actor) return reply;
    const raw = (req.query as { limit?: string }).limit;
    // só dígitos: o clamp do listModLog cuida do resto (mesma defesa do
    // ?limit= das mensagens, onde um fracionário virava SQLITE_MISMATCH)
    const limit = raw !== undefined && /^\d{1,3}$/.test(raw) ? Number(raw) : 100;
    return guild.listModLog(limit);
  });

  // -------------------------------------------------------------------------

  /**
   * Tira o acesso pelos três caminhos e avisa a guild. Chamado por kick e ban.
   *
   * O MEMBER_REMOVE sai DEPOIS de fechar as sessões do alvo: assim quem foi
   * expulso não recebe um evento dizendo que ele mesmo saiu (a conexão dele já
   * caiu com um close code próprio, que é a mensagem certa).
   */
  async function evict(victim: User, discordId: string, reason: string): Promise<void> {
    guild.revokeSessionsOfDiscordId(discordId);
    gateway.closeUserSessions(victim.id, reason);
    // rede de segurança: o closeUserSessions já dispara o onSessionGone (que
    // faz o leave da voz); isto cobre uma sessão de voz que tenha sobrevivido
    // sem sessão de gateway. É idempotente.
    await deps.disconnectFromVoice(victim.id);
    gateway.broadcast("MEMBER_REMOVE", { user_id: victim.id });
  }
}

/**
 * Por que o ator NÃO pode agir sobre o alvo, ou null se pode. UMA função para
 * todas as ações de propósito: regra de cargo espalhada é regra que diverge, e
 * a divergência aqui é sempre a favor de quem não deveria poder.
 *
 * As três linhas são, em ordem:
 *   1. ninguém age sobre si mesmo — cobre auto-promoção, auto-kick e o resto;
 *   2. o dono é intocável, por qualquer um, inclusive por outro owner — é o que
 *      garante que a guild nunca fique sem dono;
 *   3. só se age sobre cargo ESTRITAMENTE inferior — é isto que faz "admin não
 *      expulsa/bane/rebaixa admin" e deixa só o owner mexendo em admin.
 */
export function moderationProblem(actor: User, victim: User): string | null {
  if (actor.id === victim.id) return "não dá para fazer isso consigo mesmo";
  if (victim.role === "owner") return "o dono da guild não pode ser moderado";
  if (roleRank(actor.role) <= roleRank(victim.role)) {
    return "seu cargo não permite fazer isso com esta pessoa";
  }
  return null;
}

/** Resumo humano do convite para o `detail` do log — nunca o código sozinho. */
function describeInvite(invite: Invite): string {
  const parts = [`convite ${invite.code}`];
  parts.push(invite.expires_at === null ? "sem validade" : `expira em ${new Date(invite.expires_at).toISOString()}`);
  parts.push(invite.max_uses === null ? "usos ilimitados" : `${invite.max_uses} uso(s)`);
  return parts.join(", ");
}
