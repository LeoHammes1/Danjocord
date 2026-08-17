const env = process.env;

export const config = {
  host: env.HOST ?? "0.0.0.0",
  port: Number(env.PORT ?? 8080),
  dbPath: env.DB_PATH ?? "./data/danjocord.db",

  /** intervalo de heartbeat anunciado no Hello (mesmo valor clássico do Discord) */
  heartbeatIntervalMs: Number(env.HEARTBEAT_INTERVAL_MS ?? 41_250),
  /** por quanto tempo uma sessão desconectada aceita Resume */
  resumeWindowMs: Number(env.RESUME_WINDOW_MS ?? 120_000),
  /** tamanho do ring buffer de eventos por sessão (janela de replay do Resume) */
  ringBufferSize: Number(env.RING_BUFFER_SIZE ?? 512),

  /**
   * Autenticação de desenvolvimento: um token "dev.<username>" cria/loga o
   * usuário <username> (e POST /auth/dev emite sessão completa para ele).
   * Ligada por padrão fora de produção; NUNCA ligar em produção.
   */
  devAuth: (env.DANJOCORD_DEV_AUTH ?? (env.NODE_ENV === "production" ? "0" : "1")) === "1",

  // --- identidade / sessões (M1, doc §5) ---
  /** segredo do JWT de acesso (HS256). Obrigatório em produção. */
  jwtSecret: env.JWT_SECRET ?? "dev-secret-trocar-em-producao",
  /** vida do JWT de acesso (curto de propósito) */
  accessTokenTtlSec: Number(env.ACCESS_TOKEN_TTL_SEC ?? 900),
  /** vida deslizante do refresh token opaco */
  refreshTokenTtlMs: Number(env.REFRESH_TOKEN_TTL_DAYS ?? 30) * 86_400_000,
  /** one-time code do redirect OAuth → troca por sessão em POST /auth/session */
  otcTtlMs: 60_000,
  /** state + code_verifier guardados server-side durante o fluxo OAuth */
  oauthStateTtlMs: 600_000,

  // --- OAuth do Discord (M1) ---
  discordClientId: env.DISCORD_CLIENT_ID ?? "",
  discordClientSecret: env.DISCORD_CLIENT_SECRET ?? "",
  /** origem pública do backend (redirect_uri do OAuth aponta para cá) */
  publicBaseUrl: env.PUBLIC_BASE_URL ?? "http://localhost:8080",
  /** para onde o navegador volta com o one-time code (dev: o vite) */
  appUrl: env.APP_URL ?? (env.NODE_ENV === "production" ? (env.PUBLIC_BASE_URL ?? "") : "http://localhost:5173"),
} as const;
