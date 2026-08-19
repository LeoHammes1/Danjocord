import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { openDb } from "./db/index.js";
import { Store } from "./store.js";
import { Gateway } from "./gateway.js";
import { registerRoutes } from "./routes.js";
import { registerModerationRoutes } from "./moderation.js";
import { Guild } from "./guild.js";
import { bootstrapOwner } from "./bootstrap.js";
import { Sessions } from "./sessions.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerOAuthRoutes } from "./oauth.js";
import { registerStaticClient } from "./static-client.js";
import { registerSoundRoutes } from "./sounds/routes.js";
import { seedSounds } from "./sounds/seed.js";
import { Voice } from "./voice.js";

// Sem segredo real em produção, todo JWT emitido seria forjável — aborta já.
// Checa o env cru: JWT_SECRET="" passaria pelo ?? do config e não é pego pela
// comparação com o default.
if (!config.devAuth && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  console.error("JWT_SECRET ausente ou curto demais (mínimo 32 chars) em produção — abortando");
  process.exit(1);
}

const app = Fastify({ logger: true });

// A mesma origem serve SPA + API e os tokens vivem no localStorage: um XSS no
// render de mensagens roubaria a sessão — a CSP é a contenção. Em dev o
// cliente vem do vite (:5173), então isto só governa API e cliente estático.
app.addHook("onSend", async (_req, reply) => {
  reply.header("x-content-type-options", "nosniff");
  reply.header(
    "content-security-policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://cdn.discordapp.com data:; " +
      "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
});

// Em produção o Traefik serve tudo na mesma origem; o CORS aberto existe só
// para o vite dev server (localhost:5173) falar com o backend (localhost:8080).
// methods explícito: o default do @fastify/cors é só GET/HEAD/POST, o que faz
// o navegador barrar PATCH/DELETE depois do preflight (pego em verificação de UI).
if (config.devAuth) {
  await app.register(cors, { origin: true, methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"] });
}

const db = openDb();
const store = new Store(db);
const gateway = new Gateway(store);
// UMA instância: os OTCs do fluxo OAuth vivem em memória dentro dela
const sessions = new Sessions(db, store);
// M10: quem entra, quem sai e quem fez o quê (allowlist + convites + bans + log)
const guild = new Guild(db);

// Bootstrap do primeiro dono (roadmap 116) ANTES de aceitar qualquer conexão:
// num deploy limpo a allowlist nasce vazia, o OAuth recusa todo mundo e não
// existe admin para convidar — o servidor subiria trancado por fora. Roda com
// o log do Fastify porque a única saída de um deploy trancado é ler o log.
bootstrapOwner(store, guild, (msg) => app.log.warn(msg));

// usuário novo (dev ou OAuth) aparece na sidebar de todo mundo na hora;
// atribuição pós-construção porque Store e Gateway não se conhecem
store.onUserCreated = (u) => gateway.broadcast("MEMBER_ADD", u);

// soundboard (M9): os 9 embutidos entram no banco no primeiro boot — depois
// disso o banco é a ÚNICA fonte do catálogo (embutido = som sem uploader)
const seeded = seedSounds(store, (msg) => {
  app.log.warn(msg);
});
if (seeded > 0) app.log.info(`soundboard: ${seeded} sons embutidos semeados`);

// --- voz (M3, doc §3.6): o mediasoup vive aqui, atrás da sinalização op 20/21 ---
const voice = await Voice.create(store).catch((err: unknown) => {
  // fail-fast com diagnóstico: o EADDRINUSE clássico aqui é porta RTC presa
  // (em Windows, faixas reservadas invisíveis do WSL2 — ver config.rtcPort)
  console.error(`voz não subiu (RTC_PORT=${config.rtcPort}):`, err);
  process.exit(1);
});
// As assinaturas são textualmente idênticas, mas o TS não prova equivalência
// de Extract<> condicional entre dois genéricos independentes (TS2719) — o
// cast declara o que a estrutura já garante.
voice.broadcast = gateway.broadcast.bind(gateway) as typeof voice.broadcast;
gateway.onVoiceRequest = (ctx, m, p) => voice.handleRequest(ctx, m, p);
gateway.onSessionGone = (ctx) => voice.sessionGone(ctx);
gateway.voiceStatesProvider = () => voice.voiceStates();
gateway.soundsProvider = () => store.listSounds();

registerRoutes(app, store, gateway);
// o canal onde o som toca é o que o SERVIDOR vê, nunca o que o cliente diz —
// a rota pergunta ao módulo de voz e responde 403 para quem está fora
registerSoundRoutes(app, store, gateway, { voiceChannelOf: (userId) => voice.channelOfUser(userId) });
// M10: kick e ban precisam derrubar as sessões de gateway (o gateway valida o
// token uma vez, no Identify — roadmap 114) e tirar o alvo da voz; as duas
// capacidades entram por aqui, e o módulo de moderação não conhece nem o ws
// nem o mediasoup
registerModerationRoutes(app, store, gateway, guild, {
  disconnectFromVoice: (userId) => voice.removeUserFromVoice(userId),
});
registerAuthRoutes(app, store, sessions);
// o callback de MEMBER_UPDATE só dispara no primeiro login do dono configurado
// (bootstrap): o cargo muda depois do MEMBER_ADD, e sem o aviso a sidebar de
// quem já estava conectado mostraria o dono como membro comum até um F5
registerOAuthRoutes(app, store, sessions, guild, (user) => gateway.broadcast("MEMBER_UPDATE", user));
await registerStaticClient(app);

await app.listen({ host: config.host, port: config.port });
gateway.attach(app.server);

app.log.info(`gateway em ws://${config.host}:${config.port}/gateway`);
if (config.devAuth) {
  app.log.warn("auth de desenvolvimento LIGADA (token: dev.<username>) — nunca usar em produção");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    voice.close();
    gateway.close();
    await app.close();
    db.close();
    process.exit(0);
  });
}
