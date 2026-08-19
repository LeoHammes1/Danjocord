// .env da raiz do monorepo, quando existe. Só o `docker compose` lê esse
// arquivo sozinho; `pnpm dev` (tsx, fora do Docker) não — e o sintoma é um 503
// em /auth/discord/start com o .env preenchido ali do lado, o que não sugere
// nada. Vale para credenciais de dev; produção passa tudo por env de verdade.
//
// `loadEnvFile` NÃO sobrescreve o que já está em process.env: shell, container
// e Secret do k8s vencem o arquivo, que só preenche lacunas. É o que mantém os
// testes (que setam process.env antes de importar isto) imunes ao arquivo.
//
// O caminho sobe três níveis a partir DESTE módulo, e não do cwd, para valer
// igual em src/ e em dist/ — os dois ficam um nível abaixo de apps/server.
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // sem .env é o caso normal (produção, CI, clone recém-feito)
}

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

  // --- mídia / mediasoup (M3, doc §3.6 e §9) ---
  /**
   * porta ÚNICA do WebRtcServer (UDP e TCP) — a que o firewall/hostPort expõe.
   * Default 41000 e não 40000: em Windows com Docker Desktop, o WSL2/Hyper-V
   * reserva faixas de UDP invisíveis ao netstat (~39000–40500 nesta máquina) e
   * o bind falha com EADDRINUSE fantasma. Produção fixa 40000 via env no
   * manifest (deploy/danjocord.yaml) — no Linux do cluster não há o problema.
   */
  rtcPort: Number(env.RTC_PORT ?? 41_000),
  /** interface local do worker */
  rtcListenIp: env.RTC_LISTEN_IP ?? "0.0.0.0",
  /**
   * endereço anunciado nos candidatos ICE (ICE-lite anuncia ISTO, não a
   * interface): produção = IP público do nó (72.61.44.156); dev = 127.0.0.1
   */
  rtcAnnouncedIp: env.ANNOUNCED_IP ?? "127.0.0.1",
  /**
   * bitrate máximo de entrada por transport send: áudio Opus (~64k) + webcam
   * em simulcast adaptativo (4K: ~13,3 Mbps somando as 3 camadas) + Go Live
   * de tela em até 4K (~12 Mbps, stream único com contentHint detail) + folga.
   * A política de camadas por tile e os viewers sob demanda (cliente) LIMITAM
   * mas não eliminam o egress: pior caso documentado (revisão M5 #4) — um Go
   * Live 4K@12M com os 9 amigos assistindo = ~108 Mbps de uplink do nó, sem
   * downgrade por assinante (stream único, sem simulcast; o BWE do streamer
   * adapta ao caminho streamer→servidor, não aos viewers). Risco aceito para
   * ≤10 usuários; se doer, os remédios são baixar o tier de 12M ou capar
   * viewers simultâneos por producer.
   */
  rtcMaxIncomingBitrate: Number(env.RTC_MAX_INCOMING_BITRATE ?? 30_000_000),
  /** intervalo do audioLevelObserver — orçamento de "quem fala" < 200 ms (doc §8) */
  rtcSpeakingIntervalMs: Number(env.RTC_SPEAKING_INTERVAL_MS ?? 150),

  // --- OAuth do Discord (M1) ---
  discordClientId: env.DISCORD_CLIENT_ID ?? "",
  discordClientSecret: env.DISCORD_CLIENT_SECRET ?? "",
  /** origem pública do backend (redirect_uri do OAuth aponta para cá) */
  publicBaseUrl: env.PUBLIC_BASE_URL ?? "http://localhost:8080",
  /** para onde o navegador volta com o one-time code (dev: o vite) */
  appUrl: env.APP_URL ?? (env.NODE_ENV === "production" ? (env.PUBLIC_BASE_URL ?? "") : "http://localhost:5173"),

  // --- convites e moderação (M10, doc §5 / roadmap 43–57) ---
  /** nome da guild — a landing pública do convite mostra ISTO e mais nada de dentro */
  guildName: env.GUILD_NAME ?? "Danjocord",
  /**
   * Bootstrap do primeiro dono (roadmap 116). Num deploy limpo a allowlist
   * nasce VAZIA: o OAuth recusa todo mundo e não existe admin para convidar —
   * o servidor sobe trancado por fora. Com esta env definida, o boot insere
   * ESTE discord_id na allowlist (só quando a allowlist está vazia) e o
   * primeiro login dele vira `owner`.
   *
   * O caminho alternativo óbvio — "o primeiro que logar vira dono" — está
   * DESCARTADO de propósito: o Ingress é público, e quem passasse na frente
   * levaria o servidor junto.
   */
  ownerDiscordId: env.DANJOCORD_OWNER_DISCORD_ID ?? "",
} as const;
