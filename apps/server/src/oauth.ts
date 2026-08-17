import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import type { Db } from "./db/index.js";
import { idToString, nextId } from "./db/snowflake.js";
import type { Store } from "./store.js";
import type { Sessions } from "./sessions.js";

/**
 * OAuth do Discord (doc §5): o backend é o confidential client E usa PKCE
 * (S256) — cinto e suspensório, como recomendado hoje pelo RFC 9700. O
 * navegador nunca vê tokens do Discord: o access token vive só o tempo do
 * callback (um GET /users/@me), é revogado em seguida, e o que sai daqui é um
 * one-time code NOSSO, que o cliente troca por sessão em POST /auth/session.
 *
 * O scope é só "identify" — não queremos nada do Discord além de id, nome e
 * avatar; a autorização de verdade é a allowlist local.
 */

/** state → code_verifier pendente. Em memória de propósito: um fluxo OAuth não sobrevive a restart. */
interface PendingAuth {
  codeVerifier: string;
  expiresAt: number;
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

export function registerOAuthRoutes(app: FastifyInstance, db: Db, store: Store, sessions: Sessions): void {
  void store; // a assinatura é contrato do integrador; o fluxo fala direto com o Db
  const pending = new Map<string, PendingAuth>();
  const redirectUri = config.publicBaseUrl + "/auth/discord/callback";

  app.get("/auth/discord/start", async (_req, reply) => {
    if (!config.discordClientId) {
      return reply.code(503).send({
        error: "OAuth do Discord não configurado — defina DISCORD_CLIENT_ID e DISCORD_CLIENT_SECRET (doc §5)",
      });
    }

    // Faxina preguiçosa: com ~10 usuários não vale um timer só para isto.
    const now = Date.now();
    for (const [state, entry] of pending) {
      if (entry.expiresAt <= now) pending.delete(state);
    }

    const state = randomBytes(32).toString("base64url");
    // 32 bytes → 43 chars de [A-Za-z0-9_-], dentro do alfabeto e tamanho do RFC 7636
    const codeVerifier = randomBytes(32).toString("base64url");
    pending.set(state, { codeVerifier, expiresAt: now + config.oauthStateTtlMs });

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
    if (!entry || entry.expiresAt <= Date.now()) {
      return reply.redirect(config.appUrl + "/?auth_error=state", 302);
    }

    if (q.code === undefined) {
      // a pessoa cancelou na tela do Discord (error=access_denied) ou o redirect veio malformado
      app.log.error({ discordError: q.error ?? null }, "callback OAuth sem authorization code");
      return reply.redirect(config.appUrl + "/?auth_error=discord", 302);
    }

    const accessToken = await exchangeCode(app, q.code, entry.codeVerifier, redirectUri);
    if (accessToken === null) {
      return reply.redirect(config.appUrl + "/?auth_error=discord", 302);
    }

    const discordUser = await fetchDiscordUser(app, accessToken);
    if (discordUser === null) {
      await revokeDiscordToken(app, accessToken);
      return reply.redirect(config.appUrl + "/?auth_error=discord", 302);
    }

    // Allowlist ANTES de qualquer escrita: quem não foi convidado não deixa
    // rastro no banco — nem usuário, nem sessão.
    const allowed = db.prepare("SELECT 1 FROM allowlist WHERE discord_id = ?").get(discordUser.id) !== undefined;
    if (!allowed) {
      await revokeDiscordToken(app, accessToken);
      app.log.warn({ discordId: discordUser.id }, "login OAuth recusado: fora da allowlist");
      return reply.redirect(config.appUrl + "/?auth_error=not_allowed", 302);
    }

    // Upsert por discord_id: re-login atualiza nome/avatar, mas o NOSSO id é
    // estável (mensagens antigas continuam apontando para o mesmo autor).
    const displayName = discordUser.global_name ?? discordUser.username;
    const avatarUrl =
      discordUser.avatar != null
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : null;
    db.prepare(
      "INSERT INTO users (id, discord_id, username, avatar_url, created_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username, avatar_url = excluded.avatar_url",
    ).run(nextId(), discordUser.id, displayName, avatarUrl, Date.now());
    // o upsert acima garante a linha; INTEGER volta como BigInt (defaultSafeIntegers)
    const row = db.prepare("SELECT id FROM users WHERE discord_id = ?").get(discordUser.id) as { id: bigint };

    // O token do Discord já cumpriu o papel dele (um /users/@me) — revoga.
    await revokeDiscordToken(app, accessToken);

    const otc = sessions.issueOtc(idToString(row.id));
    // fragment (#) e não query (?): o fragment nunca é enviado ao servidor,
    // então o OTC não aparece no access log do Fastify nem em Referer
    return reply.redirect(config.appUrl + "/#otc=" + otc, 302);
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
