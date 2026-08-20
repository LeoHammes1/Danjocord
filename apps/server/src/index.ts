import { readFileSync } from "node:fs";
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
import { registerAttachmentRoutes } from "./attachments/routes.js";
import { ORPHAN_SWEEP_INTERVAL_MS, ORPHAN_TTL_MS } from "./attachments/limits.js";
import { registerLinkRoutes } from "./links/routes.js";
import { registerReactionRoutes } from "./reactions.js";
import { registerSearchRoutes } from "./search.js";
import { registerSoundRoutes } from "./sounds/routes.js";
import { seedSounds } from "./sounds/seed.js";
import { announce } from "./system.js";
import { Voice } from "./voice.js";

// Sem segredo real em produção, todo JWT emitido seria forjável — aborta já.
// Checa o env cru: JWT_SECRET="" passaria pelo ?? do config e não é pego pela
// comparação com o default.
if (!config.devAuth && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  console.error("JWT_SECRET ausente ou curto demais (mínimo 32 chars) em produção — abortando");
  process.exit(1);
}

/**
 * TLS opcional, para TESTE EM REDE LOCAL.
 *
 * Não é para produção — lá o Traefik termina o TLS e o pod fala HTTP puro.
 * Existe por um motivo específico: `getUserMedia` (microfone, câmera, Go Live)
 * só funciona em CONTEXTO SEGURO, e `http://192.168.x.x` não é um. Sem isto,
 * abrir o app no notebook dá chat funcionando e voz simplesmente ausente —
 * `navigator.mediaDevices` vem `undefined` e nem erro aparece.
 *
 * Um certificado auto-assinado resolve: o navegador reclama uma vez, a pessoa
 * aceita, e a origem passa a valer como segura. O WebSocket vira `wss://`
 * sozinho (o cliente deriva do protocolo da API).
 */
function tlsOptions(): { key: Buffer; cert: Buffer } | null {
  const cert = process.env.TLS_CERT_PATH;
  const key = process.env.TLS_KEY_PATH;
  if (!cert || !key) return null;
  try {
    return { cert: readFileSync(cert), key: readFileSync(key) };
  } catch (err) {
    console.error(`TLS_CERT_PATH/TLS_KEY_PATH definidos mas ilegíveis (${String(err)}) — abortando`);
    process.exit(1);
  }
}

// spread condicional e NAO um ternario entre duas chamadas: o tipo do Fastify
// muda com `https`, e a uniao dos dois instanciadores quebra o addHook
const tls = tlsOptions();
/**
 * `trustProxy` (auditoria M12, rodada 2) — sem ele, `req.ip` é o peer do
 * SOCKET, que atrás do Traefik é o IP do proxy. Todo rate limit chaveado por
 * `req.ip` virava então um balde ÚNICO compartilhado por todo mundo.
 *
 * Para o `GET /api/invites/:code` isso era decisão consciente e documentada (um
 * teto global de 30/min não atrapalha dez amigos, e impede força bruta de
 * código). Mas eu copiei o mesmo padrão para o `/auth/discord/start` sem
 * reexaminar o trade-off, e lá a consequência é oposta: é a ÚNICA porta de
 * autenticação, então 21 requisições por minuto de qualquer anônimo trancavam
 * o login de TODOS — web e desktop.
 *
 * O comentário original recusava o `x-forwarded-for` por ser escrito pelo
 * cliente, e essa objeção é correta para XFF cru. `trustProxy` com CONTAGEM DE
 * SALTOS resolve: o proxy-addr descarta o que o cliente escreveu e devolve o
 * endereço que o salto confiável ACRESCENTOU — que o cliente não controla.
 *
 * 1 salto = só o Traefik. Mudou a topologia (um CDN na frente, por exemplo),
 * muda `TRUST_PROXY_HOPS` junto — contagem errada volta a confiar em XFF do
 * cliente, que é pior que não confiar em nenhum.
 */
const app = Fastify({
  logger: true,
  trustProxy: config.trustProxyHops,
  ...(tls === null ? {} : { https: tls }),
});

// A mesma origem serve SPA + API e os tokens vivem no localStorage: um XSS no
// render de mensagens roubaria a sessão — a CSP é a contenção. Em dev o
// cliente vem do vite (:5173), então isto só governa API e cliente estático.
app.addHook("onSend", async (_req, reply) => {
  reply.header("x-content-type-options", "nosniff");
  reply.header(
    "content-security-policy",
    // M11b: `blob:` no img-src por causa dos anexos (item 89). O
    // `GET /api/attachments/:id` exige `Authorization: Bearer`, e um
    // `<img src>` não manda header nenhum — o cliente busca com `fetch`,
    // envolve num Blob e usa `URL.createObjectURL`. A alternativa seria pôr o
    // token na URL da imagem, que é o oposto do que o projeto faz desde o M1.
    "default-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' https://cdn.discordapp.com data: blob:; " +
      "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
});

// Em produção o Traefik serve tudo na mesma origem; o CORS aberto existe só
// para o vite dev server (localhost:5173) falar com o backend (localhost:8080).
//
// A lista de métodos é EXPLÍCITA porque o default do @fastify/cors é só
// GET/HEAD/POST — e ela já se provou uma armadilha DUAS vezes: no M2 faltavam
// PATCH e DELETE (as mensagens), e no M11b faltava PUT (as reações). Toda vez o
// sintoma é o mesmo e engana: `Failed to fetch` no console, sem status HTTP,
// porque o navegador barra no preflight e a requisição nem sai. Método novo na
// API entra AQUI junto — em produção não aparece, e o bug só existe em dev.
// E em PRODUÇÃO ele também é necessário, por um motivo que só apareceu quando o
// app desktop foi rodado de verdade contra o cluster (M12): o renderer do
// Electron é servido pelo scheme `app://`, que é uma ORIGEM PRÓPRIA. Toda
// chamada dele à API é cross-origin — o cliente web é same-origin e não precisa
// de nada disso, mas o desktop precisa, sempre.
//
// O sintoma era cruel de diagnosticar: o OAuth ia até o fim, o navegador dizia
// "Login concluído ✓", e o app dizia "Falha no login" — porque quem apanhava
// era o `POST /auth/session` DEPOIS do OTC já ter voltado. Sem estas linhas o
// desktop nunca conseguiu falar com produção.
//
// `origin: true` (reflete qualquer origem) fica SÓ em dev. Em produção é uma
// lista fechada com a origem do desktop e mais nada.
const DESKTOP_ORIGIN = "app://bundle";
await app.register(cors, {
  origin: config.devAuth ? true : [DESKTOP_ORIGIN],
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  // explícito porque o preflight do desktop manda os dois: Bearer no
  // authorization e o content-type dos POSTs de JSON e de corpo binário
  allowedHeaders: ["authorization", "content-type"],
});

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
store.onUserCreated = (u) => {
  // entrar não é ter perdido o que veio antes: os canais nascem lidos para o
  // recém-chegado. Antes do announce, senão o próprio "fulano entrou" já
  // apareceria como não-lido para ele mesmo.
  store.markAllReadOnJoin(u.id);
  gateway.broadcast("MEMBER_ADD", u);
  // M11a (item 92): o "fulano entrou" vai DEPOIS do MEMBER_ADD, e a ordem
  // importa — a mensagem é assinada pelo recém-chegado, e quem a receber antes
  // de conhecer o autor desenharia um avatar de desconhecido
  announce(store, gateway, "member_join", u.id);
};

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
// M11b: reações, anexos, busca e preview de link. Cada um em módulo próprio
// pelo mesmo motivo do M9/M10 — `routes.ts` é a superfície de MENSAGENS, e
// misturar tudo faria um arquivo em que ninguém acha a regra que procura.
registerReactionRoutes(app, store, gateway);
registerAttachmentRoutes(app, store);
registerSearchRoutes(app, store);
// sem deps: em produção valem o DNS de verdade e a política de SSRF de verdade
// (as injeções de `links/fetch.ts` existem só para o teste)
registerLinkRoutes(app, store);
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

/**
 * Faxina dos anexos órfãos (M11b, item 89).
 *
 * O upload de anexo tem duas etapas (sobe o arquivo, depois manda a mensagem
 * que o referencia) e a segunda pode simplesmente não acontecer: quem escolhe
 * a imagem e fecha a aba deixa 8 MB no PVC sem nenhuma mensagem apontando para
 * eles. Ninguém nunca vai abrir o banco procurando linhas com `message_id`
 * nulo, então a faxina é do processo.
 *
 * Roda no BOOT (limpa o que ficou de uma queda) e a cada 5 minutos. `unref`
 * para o timer não segurar o processo no shutdown — mesmo padrão do sweeper de
 * sessões do gateway.
 */
function sweepOrphanAttachments(): void {
  const removed = store.deleteOrphanAttachments(ORPHAN_TTL_MS);
  if (removed > 0) app.log.info(`anexos: ${removed} órfãos apagados`);
  // Pega carona no mesmo timer (auditoria M12): o cache de preview de link
  // NUNCA era limpo. O `getLinkPreview` filtra por `expires_at > now`, então a
  // linha vencida deixa de ser USADA — mas continua no arquivo, e o PVC é um
  // só. O schema já previa isto: `expires_at` existe desde a migration 006 e
  // até tem índice (`idx_link_previews_expires`); faltava alguém apagar.
  // Cada URL distinta que qualquer membro cola vira uma linha, inclusive as que
  // FALHAM (o cache negativo também grava).
  const previews = store.deleteExpiredLinkPreviews();
  if (previews > 0) app.log.info(`preview de link: ${previews} entradas vencidas apagadas`);
}
sweepOrphanAttachments();
const orphanSweeper = setInterval(sweepOrphanAttachments, ORPHAN_SWEEP_INTERVAL_MS);
orphanSweeper.unref();

await app.listen({ host: config.host, port: config.port });
gateway.attach(app.server);

app.log.info(`gateway em ws://${config.host}:${config.port}/gateway`);
if (config.devAuth) {
  app.log.warn("auth de desenvolvimento LIGADA (token: dev.<username>) — nunca usar em produção");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    clearInterval(orphanSweeper);
    voice.close();
    gateway.close();
    await app.close();
    db.close();
    process.exit(0);
  });
}
