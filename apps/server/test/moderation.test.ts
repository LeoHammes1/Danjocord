/**
 * Testes do M10 (convites + moderação): o resgate de convite e suas cinco
 * formas de falhar, as regras de cargo, kick × ban, timeout de chat, o
 * preview PÚBLICO (o que ele conta e o que ele custa), o log de moderação e o
 * bootstrap do primeiro dono.
 *
 * Banco em ":memory:", Fastify de verdade via app.inject(), Gateway sem attach
 * (nenhum socket conectado — os broadcasts viram no-op e o espião captura o
 * que sairia; a entrega real é papel do smoke).
 *
 * Por que os usuários aqui NÃO são os `dev.<nome>` das outras suítes: usuário
 * de desenvolvimento tem `discord_id` NULL, não passa por allowlist e por isso
 * não pode ser expulso nem banido — testar moderação com ele testaria o
 * caminho errado. Cada membro é criado com discord_id e uma sessão real
 * (`Sessions.create`), que é também o que permite afirmar que kick e ban
 * revogam o refresh.
 *
 * Mesmo esquema das outras suítes: hooks do tsx + import dinâmico de src (o
 * sufixo ".js" do NodeNext não é remapeado pelo type stripping) — este arquivo
 * só pode usar sintaxe apagável.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "tsx/esm/api";
import type { Ban, Invite, ModLogEntry, Role, User } from "@danjocord/protocol";

register();

// o config lê process.env no import — ajustar ANTES de importar src
process.env.DANJOCORD_DEV_AUTH = "1";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { idFromString } = await import("../src/db/snowflake.js");
const { Store } = await import("../src/store.js");
const { Gateway } = await import("../src/gateway.js");
const { Guild } = await import("../src/guild.js");
const { Sessions } = await import("../src/sessions.js");
const { config } = await import("../src/config.js");
const { bootstrapOwner, claimOwner } = await import("../src/bootstrap.js");
const { registerModerationRoutes, PREVIEW_LIMIT } = await import("../src/moderation.js");
const { registerRoutes } = await import("../src/routes.js");

const db = openDb(":memory:");
const store = new Store(db);
const gateway = new Gateway(store);
const guild = new Guild(db);
const sessions = new Sessions(db, store);
const app = Fastify();

/** Quem a moderação mandou tirar da voz (o wiring real chama o mediasoup). */
const tiradosDaVoz: string[] = [];
registerModerationRoutes(app, store, gateway, guild, {
  disconnectFromVoice: async (userId) => {
    tiradosDaVoz.push(userId);
  },
});
// as rotas de mensagem entram no MESMO app: o timeout de chat é uma regra do
// POST de mensagem, e testá-la exige a rota de verdade
registerRoutes(app, store, gateway);

// Espião do fan-out (mesmo padrão do messages.test.ts).
const events: { t: string; d: unknown }[] = [];
(gateway as unknown as { broadcast: (t: string, d: unknown) => void }).broadcast = (t, d) => {
  events.push({ t, d });
};
function findAll<T>(t: string): T[] {
  return events.filter((e) => e.t === t).map((e) => e.d as T);
}

/** Espião do caminho ATIVO de derrubar sessão (o WebSocket aberto). */
const sessoesFechadas: string[] = [];
const closeOriginal = gateway.closeUserSessions.bind(gateway);
(gateway as unknown as { closeUserSessions: (id: string, reason: string) => number }).closeUserSessions = (
  userId,
  reason,
) => {
  sessoesFechadas.push(userId);
  return closeOriginal(userId, reason);
};

function reset(): void {
  events.length = 0;
  tiradosDaVoz.length = 0;
  sessoesFechadas.length = 0;
}

// ---------------------------------------------------------------------------
// Membros de teste
// ---------------------------------------------------------------------------

let proximoDiscordId = 900_000_000_000_000_001n;

interface Membro {
  user: User;
  discordId: string;
  headers: Record<string, string>;
}

/** Cria um membro de verdade: allowlist + linha em `users` + sessão emitida. */
function membro(username: string, role: Role = "member"): Membro {
  const discordId = (proximoDiscordId++).toString();
  guild.addToAllowlist(discordId, null);
  const { user } = store.upsertDiscordUser(discordId, username, null);
  if (role !== "member") store.setRole(user.id, role);
  const pair = sessions.create(user.id);
  const atual = store.getUserById(idFromString(user.id));
  assert.ok(atual, "setup: usuário recém-criado deveria existir");
  return {
    user: atual,
    discordId,
    headers: { authorization: `Bearer ${pair.access_token}` },
  };
}

/** Quantas sessões de refresh VIVAS o usuário tem (o outro caminho do acesso). */
function sessoesVivas(userId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL")
    .get(idFromString(userId)) as { n: bigint };
  return Number(row.n);
}

function acoesDoLog(): string[] {
  return guild.listModLog(200).map((e) => e.action);
}

// A guild precisa de um dono desde o começo: quase toda regra de cargo se
// define em relação a ele.
const dono = membro("dono", "owner");

// ---------------------------------------------------------------------------
// Convites — o preview PÚBLICO (item 47)
// ---------------------------------------------------------------------------

test("preview público: convite válido devolve o mínimo — e SÓ o mínimo", async () => {
  const invite = guild.createInvite(dono.user.id, {});
  const res = await app.inject({ method: "GET", url: `/api/invites/${invite.code}` });

  assert.equal(res.statusCode, 200);
  const body = res.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["guild_name", "inviter_name", "valid"]);
  assert.equal(body["valid"], true);
  assert.equal(body["guild_name"], config.guildName);
  assert.equal(body["inviter_name"], "dono");
  // o que NÃO pode vazar: um código circula em grupo de WhatsApp, e usos
  // restantes ou lista de membros transformariam um vazamento em raio-x
  const cru = res.body;
  assert.ok(!cru.includes(dono.user.id), "id de ninguém no preview");
  assert.ok(!cru.includes("uses"), "contagem de usos no preview");
  assert.ok(!cru.includes("expires"), "validade no preview");
});

test("preview público: inexistente é 404 e nunca 410", async () => {
  const res = await app.inject({ method: "GET", url: "/api/invites/naoexisteX" });
  assert.equal(res.statusCode, 404);
  // 410 diria a quem chuta código que ele acertou um que já existiu
  assert.notEqual(res.statusCode, 410);
});

test("preview público: revogado, expirado e esgotado se distinguem no 410", async () => {
  const revogado = guild.createInvite(dono.user.id, {});
  guild.revokeInvite(revogado.code);

  const expirado = guild.createInvite(dono.user.id, { expiresInS: 60 });
  db.prepare("UPDATE invites SET expires_at = ? WHERE code = ?").run(Date.now() - 1_000, expirado.code);

  const esgotado = guild.createInvite(dono.user.id, { maxUses: 1 });
  const gastou = membro("gastou-o-convite");
  guild.removeFromAllowlist(gastou.discordId); // fora da guild para poder resgatar
  assert.equal(guild.redeemInvite(esgotado.code, gastou.discordId).ok, true);

  for (const [code, problema] of [
    [revogado.code, "revoked"],
    [expirado.code, "expired"],
    [esgotado.code, "exhausted"],
  ] as const) {
    const res = await app.inject({ method: "GET", url: `/api/invites/${code}` });
    assert.equal(res.statusCode, 410, `${problema} deveria ser 410`);
    const body = res.json() as Record<string, unknown>;
    // só o problema: nem quantos usos restam, nem quem convidou
    assert.deepEqual(Object.keys(body), ["problem"]);
    assert.equal(body["problem"], problema);
  }
});

test("preview público: rate limit por IP — a TENTATIVA conta, não só o acerto", async () => {
  // app próprio: a janela é criada por registro de rota, e reaproveitar a do
  // app principal faria esta suíte comer a cota das outras
  const appLimitado = Fastify();
  registerModerationRoutes(appLimitado, store, gateway, guild, {
    disconnectFromVoice: async () => undefined,
  });
  const invite = guild.createInvite(dono.user.id, {});

  // códigos MALFORMADOS: nem chegam ao banco, e ainda assim gastam a cota —
  // é o chute mais barato, e é justamente ele que não pode ser de graça
  for (let i = 0; i < PREVIEW_LIMIT; i += 1) {
    const res = await appLimitado.inject({ method: "GET", url: `/api/invites/${"a".repeat(33)}` });
    assert.equal(res.statusCode, 404, `tentativa ${i} deveria ser 404`);
  }

  const bloqueado = await appLimitado.inject({ method: "GET", url: `/api/invites/${invite.code}` });
  assert.equal(bloqueado.statusCode, 429, "código VÁLIDO barrado depois da cota de tentativas");
  assert.ok(Number(bloqueado.headers["retry-after"]) >= 1);
  assert.equal(typeof (bloqueado.json() as { retry_after: number }).retry_after, "number");
});

// ---------------------------------------------------------------------------
// Convites — resgate (a porta que abre sozinha)
// ---------------------------------------------------------------------------

test("resgate: convite válido entra na allowlist, incrementa usos e loga", async () => {
  const invite = guild.createInvite(dono.user.id, { maxUses: 5 });
  const novato = "900000000000000900";

  const resultado = guild.redeemInvite(invite.code, novato);
  assert.equal(resultado.ok, true);
  assert.equal(guild.isAllowed(novato), true);
  assert.equal(guild.getInvite(invite.code)?.uses, 1);
  assert.ok(acoesDoLog().includes("invite_use"));
});

test("resgate: banido perde de qualquer convite válido, sempre", async () => {
  const invite = guild.createInvite(dono.user.id, {});
  const banido = "900000000000000901";
  guild.ban(banido, dono.user.id, "spam");

  const resultado = guild.redeemInvite(invite.code, banido);
  assert.equal(resultado.ok, false);
  assert.equal(resultado.ok === false ? resultado.problem : null, "banned");
  assert.equal(guild.isAllowed(banido), false, "ban vence o convite — nada entrou na allowlist");
  assert.equal(guild.getInvite(invite.code)?.uses, 0, "convite intacto: nem o uso foi consumido");
});

test("resgate: dois resgates simultâneos no ÚLTIMO uso — só um entra", async () => {
  const invite = guild.createInvite(dono.user.id, { maxUses: 1 });
  const a = "900000000000000902";
  const b = "900000000000000903";

  // Promise.all expressa a intenção; o better-sqlite3 é SÍNCRONO, então quem
  // de fato serializa é a transação do redeemInvite. O contrato que este teste
  // fixa é o resultado: "checa/checa/incrementa/incrementa" — duas pessoas
  // entrando com um convite de uso único — não pode acontecer nunca.
  const [r1, r2] = await Promise.all([
    Promise.resolve(guild.redeemInvite(invite.code, a)),
    Promise.resolve(guild.redeemInvite(invite.code, b)),
  ]);

  const vitorias = [r1, r2].filter((r) => r.ok).length;
  assert.equal(vitorias, 1, "exatamente um resgate vence");
  const perdedor = [r1, r2].find((r) => !r.ok);
  assert.equal(perdedor?.ok === false ? perdedor.problem : null, "exhausted");
  assert.equal(guild.getInvite(invite.code)?.uses, 1, "o contador nunca passa do teto");
  assert.equal([a, b].filter((id) => guild.isAllowed(id)).length, 1);
});

// ---------------------------------------------------------------------------
// Convites — REST de admin
// ---------------------------------------------------------------------------

test("POST /api/invites: member não cria, admin cria e o log registra", async () => {
  const zé = membro("ze-comum");
  const admin = membro("admin-convida", "admin");

  const recusado = await app.inject({ method: "POST", url: "/api/invites", headers: zé.headers, payload: {} });
  assert.equal(recusado.statusCode, 403);

  const criado = await app.inject({
    method: "POST",
    url: "/api/invites",
    headers: admin.headers,
    payload: { max_uses: 3, expires_in_s: 3600 },
  });
  assert.equal(criado.statusCode, 201);
  const invite = criado.json() as Invite;
  assert.equal(invite.created_by, admin.user.id);
  assert.equal(invite.max_uses, 3);
  assert.equal(invite.uses, 0);
  assert.ok(acoesDoLog().includes("invite_create"));

  const listado = await app.inject({ method: "GET", url: "/api/invites", headers: admin.headers });
  assert.equal(listado.statusCode, 200);
  assert.ok((listado.json() as Invite[]).some((i) => i.code === invite.code));
  // a lista completa é de admin: um member veria quem convidou quem
  const listaProibida = await app.inject({ method: "GET", url: "/api/invites", headers: zé.headers });
  assert.equal(listaProibida.statusCode, 403);
});

test("DELETE /api/invites/:code: o criador revoga o seu; estranho não revoga", async () => {
  const admin = membro("admin-revoga", "admin");
  const outro = membro("outro-comum");
  const criado = await app.inject({ method: "POST", url: "/api/invites", headers: admin.headers, payload: {} });
  const invite = criado.json() as Invite;

  const proibido = await app.inject({
    method: "DELETE",
    url: `/api/invites/${invite.code}`,
    headers: outro.headers,
  });
  assert.equal(proibido.statusCode, 403);

  const ok = await app.inject({ method: "DELETE", url: `/api/invites/${invite.code}`, headers: admin.headers });
  assert.equal(ok.statusCode, 204);
  assert.notEqual(guild.getInvite(invite.code)?.revoked_at, null);
  assert.ok(acoesDoLog().includes("invite_revoke"));

  // revogar de novo é no-op idempotente, não erro
  const denovo = await app.inject({ method: "DELETE", url: `/api/invites/${invite.code}`, headers: admin.headers });
  assert.equal(denovo.statusCode, 204);
});

// ---------------------------------------------------------------------------
// Cargos
// ---------------------------------------------------------------------------

test("cargos: o owner é intocável — por admin e por ele mesmo", async () => {
  const admin = membro("admin-ousado", "admin");

  for (const url of [`/api/members/${dono.user.id}/kick`, `/api/members/${dono.user.id}/ban`]) {
    const res = await app.inject({ method: "POST", url, headers: admin.headers, payload: {} });
    assert.equal(res.statusCode, 403, `${url} contra o dono`);
  }
  const rebaixa = await app.inject({
    method: "PATCH",
    url: `/api/members/${dono.user.id}/role`,
    headers: admin.headers,
    payload: { role: "member" },
  });
  assert.equal(rebaixa.statusCode, 403);

  // nem o próprio dono se rebaixa: a guild nunca fica sem dono
  const auto = await app.inject({
    method: "PATCH",
    url: `/api/members/${dono.user.id}/role`,
    headers: dono.headers,
    payload: { role: "member" },
  });
  assert.equal(auto.statusCode, 403);
  assert.equal(store.hasOwner(), true);
});

test("cargos: admin não mexe em admin; o owner mexe", async () => {
  const a = membro("admin-a", "admin");
  const b = membro("admin-b", "admin");

  const entrePares = await app.inject({
    method: "PATCH",
    url: `/api/members/${b.user.id}/role`,
    headers: a.headers,
    payload: { role: "member" },
  });
  assert.equal(entrePares.statusCode, 403);
  const kickEntrePares = await app.inject({
    method: "POST",
    url: `/api/members/${b.user.id}/kick`,
    headers: a.headers,
    payload: {},
  });
  assert.equal(kickEntrePares.statusCode, 403);

  reset();
  const peloDono = await app.inject({
    method: "PATCH",
    url: `/api/members/${b.user.id}/role`,
    headers: dono.headers,
    payload: { role: "member" },
  });
  assert.equal(peloDono.statusCode, 200);
  assert.equal((peloDono.json() as User).role, "member");
  assert.equal(findAll<User>("MEMBER_UPDATE").at(-1)?.role, "member");
  assert.ok(acoesDoLog().includes("role_change"));
});

test("cargos: ninguém se auto-promove nem fabrica um par", async () => {
  const admin = membro("admin-ambicioso", "admin");
  const comum = membro("comum-ambicioso");

  // sobre si mesmo: barrado antes de qualquer coisa
  const auto = await app.inject({
    method: "PATCH",
    url: `/api/members/${admin.user.id}/role`,
    headers: admin.headers,
    payload: { role: "admin" },
  });
  assert.equal(auto.statusCode, 403);

  // admin promovendo alguém a admin criaria um par que ele nunca poderia
  // rebaixar (a regra de cima já o proíbe de mexer em iguais)
  const par = await app.inject({
    method: "PATCH",
    url: `/api/members/${comum.user.id}/role`,
    headers: admin.headers,
    payload: { role: "admin" },
  });
  assert.equal(par.statusCode, 403);
  assert.equal(store.getRole(comum.user.id), "member");

  // o owner pode
  const peloDono = await app.inject({
    method: "PATCH",
    url: `/api/members/${comum.user.id}/role`,
    headers: dono.headers,
    payload: { role: "admin" },
  });
  assert.equal(peloDono.statusCode, 200);
  assert.equal(store.getRole(comum.user.id), "admin");

  // "owner" não é um cargo atribuível pela rota (transferência fica na CLI)
  const transferencia = await app.inject({
    method: "PATCH",
    url: `/api/members/${comum.user.id}/role`,
    headers: dono.headers,
    payload: { role: "owner" },
  });
  assert.equal(transferencia.statusCode, 400);
});

// ---------------------------------------------------------------------------
// Kick × ban
// ---------------------------------------------------------------------------

test("kick: derruba pelos três caminhos, some da lista e VOLTA com convite", async () => {
  const admin = membro("admin-kicka", "admin");
  const vitima = membro("vitima-kick");
  assert.equal(sessoesVivas(vitima.user.id), 1);
  reset();

  const res = await app.inject({
    method: "POST",
    url: `/api/members/${vitima.user.id}/kick`,
    headers: admin.headers,
    payload: { reason: "brincou demais" },
  });
  assert.equal(res.statusCode, 204);

  // 1) refresh revogado, 2) WebSocket fechado, 3) fora da voz
  assert.equal(sessoesVivas(vitima.user.id), 0, "refresh revogado");
  assert.deepEqual(sessoesFechadas, [vitima.user.id], "sessões de gateway fechadas na hora");
  assert.deepEqual(tiradosDaVoz, [vitima.user.id], "tirado do canal de voz");

  // caminho PASSIVO: é esta pergunta que o heartbeat e o Identify refazem
  assert.equal(store.isMember(vitima.user.id), false);
  assert.equal(guild.isAllowed(vitima.discordId), false);

  // some da lista de todo mundo — na hora, e também no próximo READY
  assert.deepEqual(findAll<{ user_id: string }>("MEMBER_REMOVE"), [{ user_id: vitima.user.id }]);
  assert.ok(!store.listMembers().some((m) => m.id === vitima.user.id), "kickado sai do listMembers");

  assert.equal(guild.listModLog(200)[0]?.action, "kick");
  assert.equal(guild.listModLog(200)[0]?.detail, "brincou demais");

  // e a diferença para o ban: um convite novo o traz de volta
  const invite = guild.createInvite(dono.user.id, {});
  assert.equal(guild.redeemInvite(invite.code, vitima.discordId).ok, true);
  assert.equal(store.isMember(vitima.user.id), true);
});

test("ban: mesmo efeito do kick, mas nenhum convite serve depois", async () => {
  const admin = membro("admin-bane", "admin");
  const vitima = membro("vitima-ban");
  reset();

  const res = await app.inject({
    method: "POST",
    url: `/api/members/${vitima.user.id}/ban`,
    headers: admin.headers,
    payload: { reason: "não dava mais" },
  });
  assert.equal(res.statusCode, 204);
  assert.equal(sessoesVivas(vitima.user.id), 0);
  assert.deepEqual(sessoesFechadas, [vitima.user.id]);
  assert.deepEqual(tiradosDaVoz, [vitima.user.id]);
  assert.equal(store.isMember(vitima.user.id), false);
  assert.deepEqual(findAll<{ user_id: string }>("MEMBER_REMOVE"), [{ user_id: vitima.user.id }]);

  const invite = guild.createInvite(dono.user.id, {});
  const tentativa = guild.redeemInvite(invite.code, vitima.discordId);
  assert.equal(tentativa.ok, false);
  assert.equal(tentativa.ok === false ? tentativa.problem : null, "banned");
  assert.equal(store.isMember(vitima.user.id), false, "continua fora mesmo com link bom na mão");

  // a lista de bans e o desbanimento (que NÃO readmite, só reabre a porta)
  const lista = await app.inject({ method: "GET", url: "/api/bans", headers: admin.headers });
  assert.equal(lista.statusCode, 200);
  assert.ok((lista.json() as Ban[]).some((b) => b.discord_id === vitima.discordId));

  const desbane = await app.inject({
    method: "DELETE",
    url: `/api/bans/${vitima.discordId}`,
    headers: admin.headers,
  });
  assert.equal(desbane.statusCode, 204);
  assert.equal(guild.isBanned(vitima.discordId), false);
  assert.equal(store.isMember(vitima.user.id), false, "desbanir não readmite — só volta a poder usar convite");
  assert.equal(guild.redeemInvite(invite.code, vitima.discordId).ok, true);

  const jaFoi = await app.inject({
    method: "DELETE",
    url: `/api/bans/${vitima.discordId}`,
    headers: admin.headers,
  });
  assert.equal(jaFoi.statusCode, 404);
});

test("kick/ban: alvo que já saiu é 404, não 500", async () => {
  const admin = membro("admin-404", "admin");
  const res = await app.inject({
    method: "POST",
    url: "/api/members/999999999999/kick",
    headers: admin.headers,
    payload: {},
  });
  assert.equal(res.statusCode, 404);
});

// ---------------------------------------------------------------------------
// Timeout de chat (item 53)
// ---------------------------------------------------------------------------

test("timeout: bloqueia o POST de mensagem, avisa quando acaba e expira sozinho", async () => {
  const admin = membro("admin-cala", "admin");
  const calado = membro("calado");
  reset();

  const antes = await app.inject({
    method: "POST",
    url: "/api/channels/1/messages",
    headers: calado.headers,
    payload: { content: "ainda posso falar" },
  });
  assert.equal(antes.statusCode, 201);

  const aplica = await app.inject({
    method: "POST",
    url: `/api/members/${calado.user.id}/timeout`,
    headers: admin.headers,
    payload: { minutes: 10, reason: "esfria a cabeça" },
  });
  assert.equal(aplica.statusCode, 200);
  const atualizado = aplica.json() as User;
  assert.ok(atualizado.muted_until !== null && atualizado.muted_until > Date.now());
  assert.equal(findAll<User>("MEMBER_UPDATE").at(-1)?.id, calado.user.id);
  assert.equal(guild.listModLog(200)[0]?.action, "timeout");

  const barrado = await app.inject({
    method: "POST",
    url: "/api/channels/1/messages",
    headers: calado.headers,
    payload: { content: "e agora?" },
  });
  assert.equal(barrado.statusCode, 403);
  const corpo = barrado.json() as { error: string; muted_until: number };
  assert.equal(corpo.muted_until, atualizado.muted_until, "a UI recebe QUANDO acaba, não só o não");

  // silenciado também não anuncia digitação: o indicador prometeria uma fala
  // que nunca chega
  const digitando = await app.inject({ method: "POST", url: "/api/channels/1/typing", headers: calado.headers });
  assert.equal(digitando.statusCode, 204);
  assert.equal(findAll<unknown>("TYPING_START").length, 0);

  // EXPIRA SOZINHO: não existe job de limpeza — é a leitura que decide
  db.prepare("UPDATE users SET muted_until = ? WHERE id = ?").run(Date.now() - 1, idFromString(calado.user.id));
  assert.equal(store.mutedUntil(calado.user.id), null);
  assert.equal(store.getUserById(idFromString(calado.user.id))?.muted_until, null, "vencido chega como null no fio");
  const depois = await app.inject({
    method: "POST",
    url: "/api/channels/1/messages",
    headers: calado.headers,
    payload: { content: "voltei" },
  });
  assert.equal(depois.statusCode, 201);
});

test("timeout: minutes 0 libera e registra timeout_clear", async () => {
  const admin = membro("admin-libera", "admin");
  const alvo = membro("alvo-libera");
  await app.inject({
    method: "POST",
    url: `/api/members/${alvo.user.id}/timeout`,
    headers: admin.headers,
    payload: { minutes: 60 },
  });

  const libera = await app.inject({
    method: "POST",
    url: `/api/members/${alvo.user.id}/timeout`,
    headers: admin.headers,
    payload: { minutes: 0 },
  });
  assert.equal(libera.statusCode, 200);
  assert.equal((libera.json() as User).muted_until, null);
  assert.equal(guild.listModLog(200)[0]?.action, "timeout_clear");

  const fora = await app.inject({
    method: "POST",
    url: `/api/members/${alvo.user.id}/timeout`,
    headers: admin.headers,
    payload: { minutes: 99_999 },
  });
  assert.equal(fora.statusCode, 400, "teto de 7 dias — acima disso a ferramenta é kick ou ban");
});

// ---------------------------------------------------------------------------
// Identidade própria (item 55)
// ---------------------------------------------------------------------------

test("PATCH /api/users/@me: apelido entra, sobrevive ao re-login e volta a sair", async () => {
  const eu = membro("nome-do-discord");

  const põe = await app.inject({
    method: "PATCH",
    url: "/api/users/@me",
    headers: eu.headers,
    payload: { nickname: "Zé da Guild" },
  });
  assert.equal(põe.statusCode, 200);
  assert.equal((põe.json() as User).nickname, "Zé da Guild");
  assert.equal(findAll<User>("MEMBER_UPDATE").at(-1)?.nickname, "Zé da Guild");

  // o upsert do OAuth roda a cada login e reescreve username/avatar — o
  // apelido mora em coluna separada justamente para sobreviver a isto
  store.upsertDiscordUser(eu.discordId, "outro-nome-do-discord", null);
  const depoisDoLogin = store.getUserById(idFromString(eu.user.id));
  assert.equal(depoisDoLogin?.username, "outro-nome-do-discord");
  assert.equal(depoisDoLogin?.nickname, "Zé da Guild");

  // campo esvaziado = limpar (o schema recusaria "" sozinho; a rota normaliza)
  const limpa = await app.inject({
    method: "PATCH",
    url: "/api/users/@me",
    headers: eu.headers,
    payload: { nickname: "   " },
  });
  assert.equal(limpa.statusCode, 200);
  assert.equal((limpa.json() as User).nickname, null);

  const longo = await app.inject({
    method: "PATCH",
    url: "/api/users/@me",
    headers: eu.headers,
    payload: { nickname: "x".repeat(33) },
  });
  assert.equal(longo.statusCode, 400);
});

// ---------------------------------------------------------------------------
// Log de moderação (item 57)
// ---------------------------------------------------------------------------

test("mod_log: cada ação deixou rastro, e ele é de admin", async () => {
  const acoes = new Set(acoesDoLog());
  for (const esperada of [
    "invite_create",
    "invite_revoke",
    "invite_use",
    "kick",
    "ban",
    "unban",
    "timeout",
    "timeout_clear",
    "role_change",
  ]) {
    assert.ok(acoes.has(esperada), `o log deveria conter "${esperada}"`);
  }

  const comum = membro("comum-curioso");
  const proibido = await app.inject({ method: "GET", url: "/api/mod-log", headers: comum.headers });
  assert.equal(proibido.statusCode, 403);

  const permitido = await app.inject({ method: "GET", url: "/api/mod-log?limit=5", headers: dono.headers });
  assert.equal(permitido.statusCode, 200);
  const entradas = permitido.json() as ModLogEntry[];
  assert.equal(entradas.length, 5, "?limit respeitado");
  // mais novo primeiro: o id é snowflake e é o próprio cursor
  assert.ok(entradas[0] !== undefined && entradas[1] !== undefined);
  assert.ok(entradas[0].created_at >= entradas[1].created_at);
});

test("sem token: toda rota de moderação responde 401", async () => {
  for (const [method, url] of [
    ["GET", "/api/invites"],
    ["POST", "/api/invites"],
    ["GET", "/api/bans"],
    ["GET", "/api/mod-log"],
    ["PATCH", "/api/users/@me"],
    ["POST", `/api/members/${dono.user.id}/kick`],
  ] as const) {
    const res = await app.inject({ method, url, payload: {} });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
});

// ---------------------------------------------------------------------------
// Bootstrap do primeiro dono (roadmap 116)
// ---------------------------------------------------------------------------

/**
 * O `config` congela `process.env` no import, e os três cenários do bootstrap
 * diferem justamente numa env. Trocar o campo no objeto é o caminho honesto
 * aqui: ele é um literal (não `Object.freeze`), e o `as const` só o torna
 * readonly para o compilador.
 */
function comOwnerEnv<T>(valor: string, fn: () => T): T {
  const anterior = config.ownerDiscordId;
  Object.assign(config, { ownerDiscordId: valor });
  try {
    return fn();
  } finally {
    Object.assign(config, { ownerDiscordId: anterior });
  }
}

test("bootstrap: com env e allowlist vazia, o dono entra — e o primeiro login o promove", () => {
  const db2 = openDb(":memory:");
  const store2 = new Store(db2);
  const guild2 = new Guild(db2);
  const avisos: string[] = [];
  const donoId = "123456789012345678";

  comOwnerEnv(donoId, () => {
    bootstrapOwner(store2, guild2, (m) => avisos.push(m));
    assert.equal(guild2.isAllowed(donoId), true, "entrou na allowlist");
    assert.equal(store2.hasOwner(), false, "ainda não há linha em users — o cargo vem no login");

    // o primeiro login: é aqui que a linha nasce e o cargo é aplicado
    const { user } = store2.upsertDiscordUser(donoId, "leonardo", null);
    const promovido = claimOwner(store2, guild2, donoId);
    assert.equal(promovido?.id, user.id);
    assert.equal(promovido?.role, "owner");
    assert.equal(store2.hasOwner(), true);

    // segundo login não faz nada (e o log não ganha uma linha por entrada)
    const antes = guild2.listModLog(200).length;
    assert.equal(claimOwner(store2, guild2, donoId), null);
    assert.equal(guild2.listModLog(200).length, antes);
  });

  assert.ok(avisos.every((m) => !m.includes("VAZIA")), "com a env definida não há aviso de guild trancada");
  db2.close();
});

test("bootstrap: sem env e allowlist vazia, avisa que ninguém consegue entrar", () => {
  const db2 = openDb(":memory:");
  const store2 = new Store(db2);
  const guild2 = new Guild(db2);
  const avisos: string[] = [];

  comOwnerEnv("", () => bootstrapOwner(store2, guild2, (m) => avisos.push(m)));

  assert.equal(avisos.length, 1, "o servidor sobe saudável e trancado — o aviso é a única pista");
  assert.ok(avisos[0]?.includes("DANJOCORD_OWNER_DISCORD_ID"));
  assert.equal(guild2.allowlistCount(), 0);
  db2.close();
});

test("bootstrap: com allowlist já populada, não promove ninguém", () => {
  const db2 = openDb(":memory:");
  const store2 = new Store(db2);
  const guild2 = new Guild(db2);
  const avisos: string[] = [];
  guild2.addToAllowlist("111111111111111111", null);

  comOwnerEnv("222222222222222222", () => {
    bootstrapOwner(store2, guild2, (m) => avisos.push(m));
    // trocar a env não pode promover ninguém numa guild que já existe
    assert.equal(guild2.isAllowed("222222222222222222"), false);
    assert.equal(guild2.allowlistCount(), 1);

    // e nem o login do id configurado, se já houver dono
    store2.upsertDiscordUser("111111111111111111", "primeiro", null);
    store2.setRole(store2.getUserByDiscordId("111111111111111111")?.id ?? "0", "owner");
    store2.upsertDiscordUser("222222222222222222", "pretendente", null);
    assert.equal(claimOwner(store2, guild2, "222222222222222222"), null);
    assert.equal(store2.getUserByDiscordId("222222222222222222")?.role, "member");
  });

  assert.deepEqual(avisos, []);
  db2.close();
});

test("bootstrap: env com lixo é ignorada com aviso, e não trava o boot", () => {
  const db2 = openDb(":memory:");
  const store2 = new Store(db2);
  const guild2 = new Guild(db2);
  const avisos: string[] = [];

  comOwnerEnv("não-é-um-id", () => bootstrapOwner(store2, guild2, (m) => avisos.push(m)));

  assert.equal(avisos.length, 1);
  assert.ok(avisos[0]?.includes("inválido"));
  assert.equal(guild2.allowlistCount(), 0);
  db2.close();
});
