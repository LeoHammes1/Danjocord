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
   * Autenticação de desenvolvimento (até o OAuth do Discord chegar no M1):
   * um token "dev.<username>" cria/loga o usuário <username>.
   * Ligada por padrão fora de produção; NUNCA ligar em produção.
   */
  devAuth: (env.DANJOCORD_DEV_AUTH ?? (env.NODE_ENV === "production" ? "0" : "1")) === "1",
} as const;
