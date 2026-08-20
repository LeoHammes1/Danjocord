import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { User } from "@danjocord/protocol";
import { claimOwner } from "./bootstrap.js";
import { config } from "./config.js";
import type { Guild, InviteProblem } from "./guild.js";
import type { Store } from "./store.js";
import type { Sessions } from "./sessions.js";
import { SlidingWindow } from "./limits.js";

/**
 * OAuth do Discord (doc §5): o backend é o confidential client E usa PKCE
 * (S256) — cinto e suspensório, como recomendado hoje pelo RFC 9700. O
 * navegador nunca vê tokens do Discord: o access token vive só o tempo do
 * callback (um GET /users/@me), é revogado em seguida, e o que sai daqui é um
 * one-time code NOSSO, que o cliente troca por sessão em POST /auth/session.
 *
 * O scope é só "identify" — não queremos nada do Discord além de id, nome e
 * avatar; a autorização de verdade é a allowlist local.
 *
 * M6: o app desktop usa o MESMO fluxo com um twist loopback — /start aceita
 * ?redirect_port=<porta do http.Server efêmero do Electron> e o callback
 * devolve o resultado para http://127.0.0.1:<porta>/danjocord-callback em vez
 * do appUrl. O fluxo web (sem a porta) fica intocado.
 *
 * M10: /start aceita ?invite=<code>, e quem NÃO está na allowlist tenta o
 * convite antes de ser recusado — é a única exceção controlada ao "allowlist
 * antes de qualquer escrita". O código viaja DENTRO do `PendingAuth`, amarrado
 * ao state, e nunca em cookie nem na query do callback: se ele voltasse do
 * navegador, alguém no meio do caminho trocaria o convite depois que a pessoa
 * já autorizou no Discord — a autorização seria de um link e o resgate, de
 * outro.
 */

/** state → code_verifier pendente. Em memória de propósito: um fluxo OAuth não sobrevive a restart. */
interface PendingAuth {
  codeVerifier: string;
  expiresAt: number;
  /**
   * Presente = fluxo desktop (M6): o callback redireciona para o listener
   * loopback do app nesta porta, em vez do appUrl. (`| undefined` e não `?`:
   * exactOptionalPropertyTypes — o campo é sempre gravado, às vezes vazio.)
   */
  redirectPort: number | undefined;
  /**
   * M10: convite apresentado no /start. Vive AQUI, colado ao state, porque é
   * ele que amarra "o link que a pessoa clicou" a "a autorização que ela deu".
   * (`| undefined` e não `?`: exactOptionalPropertyTypes — o campo é sempre
   * gravado, às vezes vazio.)
   */
  inviteCode: string | undefined;
}

/** Resposta do /users/@me. O id é snowflake do DISCORD (string) — nunca confundir com os nossos. */
const DiscordUser = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  global_name: z.string().nullish(),
  avatar: z.string().nullish(),
});
type DiscordUser = z.infer<typeof DiscordUser>;

const DiscordTokenResponse = z.object({
  access_token: z.string().min(1),
});

const CallbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  /** ex.: access_denied quando a pessoa cancela na tela do Discord */
  error: z.string().optional(),
});

/**
 * Query do /auth/discord/start. redirect_port é o delta do M6: a porta do
 * listener loopback do app desktop. Faixa 1024..65535 (nunca porta
 * privilegiada); host e caminho do redirect são FIXOS (127.0.0.1 +
 * /danjocord-callback), então a query não abre redirect arbitrário.
 */
const StartQuery = z.object({
  redirect_port: z.coerce.number().int().min(1024).max(65535).optional(),
  /**
   * M10: código do convite. A forma é checada aqui só para não guardar lixo em
   * memória — quem decide se ele vale é o `redeemInvite`, no callback, depois
   * de saber QUEM está entrando (um código válido não vale para um banido).
   */
  invite: z.string().regex(/^[0-9A-Za-z]{1,32}$/).optional(),
});

/**
 * `InviteProblem` → código de `auth_error`. São códigos próprios (e não o
 * genérico `not_allowed`) porque a tela de login precisa dizer O QUE FAZER:
 * "peça um link novo" resolve um convite vencido e não resolve um ban.
 */
function authErrorFor(problem: InviteProblem): string {
  switch (problem) {
    case "unknown":
      return "invite_invalid";
    case "revoked":
      return "invite_revoked";
    case "expired":
      return "invite_expired";
    case "exhausted":
      return "invite_exhausted";
    case "banned":
      return "banned";
  }
}

export function registerOAuthRoutes(
  app: FastifyInstance,
  store: Store,
  sessions: Sessions,
  guild: Guild,
  /**
   * Avisa a guild que um membro mudou. Só é usado quando o bootstrap do dono
   * promove alguém no primeiro login — o oauth não conhece o gateway, e o
   * wiring do index.ts liga isto ao broadcast de MEMBER_UPDATE.
   */
  onMemberUpdate: (user: User) => void = () => undefined,
): void {
  const pending = new Map<string, PendingAuth>();

  /**
   * Teto de fluxos de OAuth simultâneos. Uma guild de 10 amigos não chega perto
   * disto nem com todo mundo logando ao mesmo tempo em duas máquinas; o número
   * existe para que o crescimento tenha FIM, não para apertar o uso normal.
   * Cada entrada é pequena (dois base64url de 43 chars e três campos), então
   * 5 000 são alguns megabytes — longe do `limits: { memory: 1Gi }` do pod.
   */
  const MAX_PENDING_AUTH = 5_000;

  /**
   * 20 inícios de login por minuto por IP. Um humano hesitante faz três ou
   * quatro; o desktop faz um por clique no botão. Deixa folga para uma casa
   * inteira atrás do mesmo NAT e ainda assim torna o enchimento do mapa caro.
   */
  const startWindow = new SlidingWindow(20, 60_000);
  const redirectUri = config.publicBaseUrl + "/auth/discord/callback";

  app.get("/auth/discord/start", async (req, reply) => {
    if (!config.discordClientId) {
      return reply.code(503).send({
        error: "OAuth do Discord não configurado — defina DISCORD_CLIENT_ID e DISCORD_CLIENT_SECRET (doc §5)",
      });
    }

    const parsedQuery = StartQuery.safeParse(req.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: "query inválida — redirect_port entre 1024 e 65535, invite alfanumérico de até 32 chars" });
    }

    // Rate limit por IP (auditoria de segurança do M12). Esta rota é ANÔNIMA —
    // não precisa de conta, convite nem token — e cada acerto grava uma entrada
    // que vive 10 min. Sem freio, qualquer pessoa na internet enche a memória do
    // pod (`limits: { memory: 1Gi }`, `replicas: 1`, `strategy: Recreate`: o
    // OOMKill derruba todas as chamadas). Como no GET público de convite, a
    // TENTATIVA consome a cota — é o custo de tentar que se quer limitar.
    const espera = startWindow.retryAfterMs(req.ip);
    if (espera > 0) {
      reply.header("retry-after", String(Math.max(1, Math.ceil(espera / 1000))));
      return reply.code(429).send({ error: "muitas tentativas", retry_after: Number((espera / 1000).toFixed(3)) });
    }
    startWindow.record(req.ip);

    // Faxina preguiçosa: com ~10 usuários não vale um timer só para isto.
    //
    // O `break` importa e não é otimização prematura: sem ele isto é O(n) a
    // CADA requisição de uma rota anônima, o que faz o custo do ataque crescer
    // ao quadrado. Como o TTL é constante, `expiresAt` cresce junto com a ordem
    // de inserção do Map — então a primeira entrada viva garante que todas as
    // seguintes também estão, e a varredura vira O(1) amortizado.
    const now = Date.now();
    for (const [state, entry] of pending) {
      if (entry.expiresAt > now) break;
      pending.delete(state);
    }

    // Teto duro, depois da faxina: o rate limit por IP já segura o caso normal,
    // mas uma botnet distribuída passa por ele. Recusar o fluxo NOVO é melhor
    // que derrubar o pod para todo mundo — inclusive para quem já está em
    // chamada, já que o processo é o mesmo.
    if (pending.size >= MAX_PENDING_AUTH) {
      app.log.warn({ pendentes: pending.size }, "fluxos de OAuth pendentes no teto — recusando novos");
      return reply.code(503).send({ error: "servidor ocupado — tente de novo em alguns minutos" });
    }

    const state = randomBytes(32).toString("base64url");
    // 32 bytes → 43 chars de [A-Za-z0-9_-], dentro do alfabeto e tamanho do RFC 7636
    const codeVerifier = randomBytes(32).toString("base64url");
    pending.set(state, {
      codeVerifier,
      expiresAt: now + config.oauthStateTtlMs,
      redirectPort: parsedQuery.data.redirect_port,
      inviteCode: parsedQuery.data.invite,
    });

    const url = new URL("https://discord.com/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.discordClientId);
    url.searchParams.set("scope", "identify");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", createHash("sha256").update(codeVerifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("redirect_uri", redirectUri);
    return reply.redirect(url.toString(), 302);
  });

  app.get("/auth/discord/callback", async (req, reply) => {
    const parsed = CallbackQuery.safeParse(req.query);
    const q = parsed.success ? parsed.data : {};

    // state é de uso único: consome ANTES de validar qualquer outra coisa,
    // para que um retry do mesmo callback nunca ande duas vezes no fluxo.
    const entry = q.state !== undefined ? pending.get(q.state) : undefined;
    if (q.state !== undefined) pending.delete(q.state);

    // Para onde devolver o resultado (otc OU auth_error):
    // - fluxo desktop (entry com redirectPort): listener loopback do app, com
    //   QUERY (?otc=/?auth_error=) DE PROPÓSITO — o http.Server local precisa
    //   LER o valor, e fragment nunca é enviado ao servidor HTTP; em 127.0.0.1
    //   não há access log de terceiros para vazar.
    // - fluxo web (sem porta, inclusive state desconhecido): comportamento de
    //   sempre — fragment (#) para o OTC, que assim não aparece no access log
    //   do Fastify nem em Referer, e query só para o erro.
    const dest = (kind: "otc" | "auth_error", value: string): string =>
      entry?.redirectPort !== undefined
        ? `http://127.0.0.1:${entry.redirectPort}/danjocord-callback?${kind}=${value}`
        : kind === "otc"
          ? config.appUrl + "/#otc=" + value
          : config.appUrl + "/?auth_error=" + value;

    if (!entry || entry.expiresAt <= Date.now()) {
      return reply.redirect(dest("auth_error", "state"), 302);
    }

    if (q.code === undefined) {
      // a pessoa cancelou na tela do Discord (error=access_denied) ou o redirect veio malformado
      app.log.error({ discordError: q.error ?? null }, "callback OAuth sem authorization code");
      return reply.redirect(dest("auth_error", "discord"), 302);
    }

    const accessToken = await exchangeCode(app, q.code, entry.codeVerifier, redirectUri);
    if (accessToken === null) {
      return reply.redirect(dest("auth_error", "discord"), 302);
    }

    const discordUser = await fetchDiscordUser(app, accessToken);
    if (discordUser === null) {
      await revokeDiscordToken(app, accessToken);
      return reply.redirect(dest("auth_error", "discord"), 302);
    }

    // BAN NA FRENTE DE TUDO (M10): quem está banido perde mesmo estando na
    // allowlist (o CLI pode readicionar sem saber) e mesmo com um convite
    // válido na mão. É a mesma ordem que o redeemInvite usa por dentro —
    // repetida aqui porque quem está banido nem chega a tentar um convite.
    if (guild.isBanned(discordUser.id)) {
      await revokeDiscordToken(app, accessToken);
      app.log.warn({ discordId: discordUser.id }, "login OAuth recusado: banido");
      return reply.redirect(dest("auth_error", "banned"), 302);
    }

    // Allowlist ANTES de qualquer escrita: quem não foi convidado não deixa
    // rastro no banco — nem usuário, nem sessão. O convite (M10) é a ÚNICA
    // exceção controlada deste ponto: ele entra na allowlist e, aí sim, o
    // fluxo segue igual ao de quem já estava.
    if (!guild.isAllowed(discordUser.id)) {
      const code = entry.inviteCode;
      if (code === undefined) {
        await revokeDiscordToken(app, accessToken);
        app.log.warn({ discordId: discordUser.id }, "login OAuth recusado: fora da allowlist");
        return reply.redirect(dest("auth_error", "not_allowed"), 302);
      }
      // transacional lá dentro: dois logins simultâneos no ÚLTIMO uso não furam
      // o max_uses (a corrida clássica de resgate — ver guild.redeemInvite)
      const redeemed = guild.redeemInvite(code, discordUser.id);
      if (!redeemed.ok) {
        await revokeDiscordToken(app, accessToken);
        app.log.warn({ discordId: discordUser.id, problem: redeemed.problem }, "login OAuth recusado: convite");
        return reply.redirect(dest("auth_error", authErrorFor(redeemed.problem)), 302);
      }
      app.log.info({ discordId: discordUser.id, code }, "convite resgatado — entrou na guild");
    }

    // Upsert por discord_id (vive no Store desde o M2): re-login atualiza
    // nome/avatar, mas o NOSSO id é estável (mensagens antigas continuam
    // apontando para o mesmo autor). Usuário novo dispara store.onUserCreated
    // → MEMBER_ADD, sem este fluxo conhecer o gateway.
    const displayName = discordUser.global_name ?? discordUser.username;
    const avatarUrl =
      discordUser.avatar != null
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : null;
    const { user } = store.upsertDiscordUser(discordUser.id, displayName, avatarUrl);

    // Bootstrap do dono (roadmap 116): num deploy limpo a linha em `users` só
    // nasce AGORA, no primeiro login — é por isto que a promoção acontece aqui
    // e não no boot. Não faz nada quando a guild já tem dono, nem para quem não
    // é o id configurado.
    const promoted = claimOwner(store, guild, discordUser.id);
    if (promoted) {
      app.log.info({ discordId: discordUser.id }, "bootstrap: primeiro login do dono — cargo owner aplicado");
      onMemberUpdate(promoted);
    }

    // O token do Discord já cumpriu o papel dele (um /users/@me) — revoga.
    await revokeDiscordToken(app, accessToken);

    const otc = sessions.issueOtc(user.id);
    // fragment vs query: a escolha vive no dest() lá em cima — web usa
    // fragment (fora de access log/Referer), loopback usa query (o listener
    // local precisa ler)
    return reply.redirect(dest("otc", otc), 302);
  });
}

/** Troca o authorization code por um access token. null = falhou (já logado). */
async function exchangeCode(
  app: FastifyInstance,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<string | null> {
  try {
    // URLSearchParams como body já define o Content-Type application/x-www-form-urlencoded
    const res = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: config.discordClientId,
        client_secret: config.discordClientSecret,
        code_verifier: codeVerifier,
      }),
    });
    if (!res.ok) {
      app.log.error({ status: res.status, body: await res.text() }, "OAuth: troca do authorization code falhou");
      return null;
    }
    const parsed = DiscordTokenResponse.safeParse(await res.json());
    if (!parsed.success) {
      // não logar o body aqui: uma resposta 200 pode conter tokens válidos
      app.log.error({ issues: parsed.error.issues }, "OAuth: resposta do token endpoint fora do esperado");
      return null;
    }
    return parsed.data.access_token;
  } catch (err) {
    app.log.error({ err }, "OAuth: falha de rede na troca do authorization code");
    return null;
  }
}

/** Busca a identidade no /users/@me. null = falhou (já logado). */
async function fetchDiscordUser(app: FastifyInstance, accessToken: string): Promise<DiscordUser | null> {
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      app.log.error({ status: res.status, body: await res.text() }, "OAuth: GET /users/@me falhou");
      return null;
    }
    const parsed = DiscordUser.safeParse(await res.json());
    if (!parsed.success) {
      app.log.error({ issues: parsed.error.issues }, "OAuth: resposta do /users/@me fora do esperado");
      return null;
    }
    return parsed.data;
  } catch (err) {
    app.log.error({ err }, "OAuth: falha de rede no /users/@me");
    return null;
  }
}

/** Revogação best-effort: o login já deu certo (ou já foi recusado) — erro aqui só loga. */
async function revokeDiscordToken(app: FastifyInstance, accessToken: string): Promise<void> {
  try {
    const res = await fetch("https://discord.com/api/oauth2/token/revoke", {
      method: "POST",
      body: new URLSearchParams({
        token: accessToken,
        client_id: config.discordClientId,
        client_secret: config.discordClientSecret,
      }),
    });
    if (!res.ok) {
      app.log.warn({ status: res.status }, "OAuth: revogação do token do Discord falhou");
    }
  } catch (err) {
    app.log.warn({ err }, "OAuth: revogação do token do Discord falhou");
  }
}
