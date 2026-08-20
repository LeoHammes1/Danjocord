/**
 * Correções da auditoria de segurança do M12.
 *
 * Cada teste aqui é a prova de um furo que EXISTIA e foi reproduzido antes de
 * ser fechado — não são testes de "a validação valida". A ordem é a gravidade.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "tsx/esm/api";

register();

process.env.DANJOCORD_DEV_AUTH = "1";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { canonicalId } = await import("../src/db/snowflake.js");
const { Store } = await import("../src/store.js");
const { Gateway } = await import("../src/gateway.js");
const { Guild } = await import("../src/guild.js");
const { Sessions } = await import("../src/sessions.js");
const { registerRoutes } = await import("../src/routes.js");
const { registerModerationRoutes } = await import("../src/moderation.js");
const { UpdateMeBody } = await import("@danjocord/protocol");

const db = openDb(":memory:");
const store = new Store(db);
const gateway = new Gateway(store);
const guild = new Guild(db, store);
const sessions = new Sessions(db, store);
const app = Fastify();
registerRoutes(app, store, gateway);
registerModerationRoutes(app, store, gateway, guild, sessions, { disconnectFromVoice: async () => undefined });
await app.ready();

const CANAL = "1"; // 'geral', do seed da migration 001

// ---------------------------------------------------------------------------
// ALTA — o quarto caminho do ban
// ---------------------------------------------------------------------------

test("ALTA: o access token de quem foi banido para de valer no REST na hora", async () => {
  // O usuário precisa de discord_id para ser banível (o ban é por discord_id)
  const vitima = store.upsertDiscordUser("900000000000000001", "vitima", null).user;
  guild.addToAllowlist("900000000000000001", null);
  const { access_token } = sessions.create(vitima.id);
  const auth = { authorization: `Bearer ${access_token}` };

  // antes do ban o token funciona — senão o teste provaria nada
  const antes = await app.inject({ method: "GET", url: `/api/channels/${CANAL}/messages?limit=1`, headers: auth });
  assert.equal(antes.statusCode, 200, "o token deveria valer ANTES do ban");

  guild.ban("900000000000000001", null, null);
  assert.equal(store.isMember(vitima.id), false, "o ban deveria tirar o pertencimento");

  // O MESMO header, sem renovar nada. Antes da correção isto devolvia 200 por
  // até 15 min (o TTL do access), porque o JWT é stateless e a linha em `users`
  // continua existindo de propósito.
  for (const [metodo, url] of [
    ["GET", `/api/channels/${CANAL}/messages?limit=1`],
    ["GET", `/api/users/${vitima.id}`],
    ["POST", "/api/invites"],
  ] as const) {
    const r = await app.inject({ method: metodo, url, headers: auth, ...(metodo === "POST" ? { payload: {} } : {}) });
    assert.equal(r.statusCode, 401, `${metodo} ${url} deveria ser 401 depois do ban, veio ${r.statusCode}`);
  }
});

test("ALTA: o banido não consegue mais fabricar o convite que o traria de volta", async () => {
  const vitima = store.upsertDiscordUser("900000000000000002", "exadmin", null).user;
  guild.addToAllowlist("900000000000000002", null);
  store.setRole(vitima.id, "admin");
  const { access_token } = sessions.create(vitima.id);
  const auth = { authorization: `Bearer ${access_token}` };

  const podia = await app.inject({ method: "POST", url: "/api/invites", headers: auth, payload: {} });
  assert.equal(podia.statusCode, 201, "admin deveria poder criar convite ANTES do ban");

  guild.ban("900000000000000002", null, null);

  // era a escalada: convite sem validade e sem max_uses, e volta com OUTRA
  // conta do Discord (que não está banida — o ban é por discord_id)
  const agora = await app.inject({ method: "POST", url: "/api/invites", headers: auth, payload: {} });
  assert.equal(agora.statusCode, 401, "o banido não pode mais criar convite");
});

test("usuário de dev (discord_id NULL) continua entrando — a correção não pode quebrar o dev-auth", async () => {
  const r = await app.inject({
    method: "GET",
    url: `/api/channels/${CANAL}/messages?limit=1`,
    headers: { authorization: "Bearer dev.alguem" },
  });
  assert.equal(r.statusCode, 200);
});

// ---------------------------------------------------------------------------
// ALTA — ReDoS no parser de <meta> do preview de link
// ---------------------------------------------------------------------------

test("ALTA: página hostil de 512 KB não trava o event loop no parser de <meta>", async () => {
  const { extractMeta } = await import("../src/links/html.js");
  // É o que um atacante serve: só inícios de tag, nenhum `>`, nenhum </head>.
  // Cabe inteiro no teto de 512 KB do fetch. Com o regex antigo
  // (`/<meta\s+([^>]*)>/gi`) isto levava ~40 s de event loop TRAVADO — e o
  // Node é single-thread, então era o servidor inteiro parado.
  // Os DOIS payloads, porque são regexes diferentes e eu já caí nessa: medir só
  // um deu "linear" para um parser que levava 4 minutos no outro.
  //   (a) muitos inícios de tag  -> quebrava o `readMetaTags`  (40 s)
  //   (b) um RUN de nome sem `=` -> quebrava o `readAttributes` (250 s)
  // O (b) é o pior, e sobreviveu à primeira correção justamente porque o teste
  // dele usava `'a="'.repeat(n)` — que TEM `=`, então nada retrocede.
  const hostis = [
    "<meta ".repeat((512 * 1024) / 6),
    "<meta " + "a".repeat(512 * 1024) + ">",
    '<meta ' + 'a="'.repeat((512 * 1024) / 3) + ">",
  ];
  const t0 = process.hrtime.bigint();
  for (const h of hostis) extractMeta(h);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // 500 ms é folgado: o medido depois da correção é sub-milissegundo. O teto
  // existe para pegar a VOLTA do comportamento quadrático, não para cronometrar
  // a máquina de quem roda o teste.
  assert.ok(ms < 500, `parser levou ${ms.toFixed(0)} ms — o comportamento quadrático voltou`);
});

test("o parser de <meta> continua lendo o que precisa ler", async () => {
  const { extractMeta } = await import("../src/links/html.js");
  const pagina =
    "<html><head><title>Titulo</title>" +
    "<META NAME='description' CONTENT='desc'>" + // maiúscula e aspas simples
    '<meta property="og:title" content="OG">' +
    '<meta property="og:title" content="duplicata">' + // a primeira vence
    "<metadata foo=bar>" + // NÃO é meta tag
    "</head></html>";
  const meta = extractMeta(pagina);
  assert.equal(meta.title, "OG", "og:title vence o <title>");
  assert.equal(meta.description, "desc");
});

// ---------------------------------------------------------------------------
// O limitador não pode ser o próximo vazamento
// ---------------------------------------------------------------------------

test("SlidingWindow não cresce sem fim com chaves que nunca repetem", async () => {
  const { SlidingWindow } = await import("../src/limits.js");
  // As duas rotas anônimas do servidor são chaveadas por IP, e numa enxurrada
  // distribuída cada IP aparece UMA vez. Como o `prune` só apaga a chave que é
  // tocada de novo, sem teto o mapa nunca encolhia: medido, 70 000 IPs = 70 000
  // chaves vivas para sempre. Foi encontrado tentando refutar a correção do
  // OAuth — o limitador que eu tinha acabado de acrescentar era o vazamento.
  const w = new SlidingWindow(20, 60_000);
  for (let i = 0; i < 60_000; i++) {
    const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    if (w.retryAfterMs(ip) === 0) w.record(ip);
  }
  const chaves = (w as unknown as { hits: Map<string, number[]> }).hits.size;
  assert.ok(chaves <= 20_000, `mapa cresceu para ${chaves} chaves — o teto não segurou`);
});

test("...e continua limitando quem insiste do mesmo IP", async () => {
  const { SlidingWindow } = await import("../src/limits.js");
  const w = new SlidingWindow(3, 60_000);
  let bloqueadas = 0;
  for (let i = 0; i < 10; i++) {
    if (w.retryAfterMs("mesmo-ip") > 0) bloqueadas++;
    else w.record("mesmo-ip");
  }
  assert.equal(bloqueadas, 7, "3 deveriam passar e 7 apanhar");
});

// ---------------------------------------------------------------------------
// BAIXA — cache de preview de link crescendo para sempre
// ---------------------------------------------------------------------------

test("BAIXA: entrada vencida do cache de preview é apagada, a viva fica", () => {
  const agora = Date.now();
  // a assinatura é (preview sem fetched_at, ttlMs, now) — o expires_at é
  // calculado lá dentro
  const salvar = (url: string, ttlMs: number): void => {
    store.saveLinkPreview(
      { url, ok: false, title: null, description: null, site_name: null, error: "falhou", expires_at: 0 },
      ttlMs,
      agora,
    );
  };

  // O cache NEGATIVO também grava: bastava colar URLs que falham para encher a
  // tabela. `getLinkPreview` ignorava a linha vencida, mas nada a removia.
  for (let i = 0; i < 50; i++) salvar(`https://vencida-${i}.example.com/`, -1); // ttl negativo = ja vencida
  salvar("https://viva.example.com/", 600_000);

  const apagadas = store.deleteExpiredLinkPreviews(agora);
  assert.equal(apagadas, 50, "as 50 vencidas deveriam sair");
  assert.notEqual(store.getLinkPreview("https://viva.example.com/", agora), null, "a viva tem de ficar");
  assert.equal(store.deleteExpiredLinkPreviews(agora), 0, "nada sobrou para apagar");
});

// ---------------------------------------------------------------------------
// CORS: o desktop é cross-origin SEMPRE, inclusive em produção
// ---------------------------------------------------------------------------

test("preflight da origem do desktop é respondido; origem estranha não", async () => {
  const { default: cors } = await import("@fastify/cors");
  // reproduz a produção: devAuth DESLIGADO, lista fechada
  const prod = Fastify();
  await prod.register(cors, {
    origin: ["app://bundle"],
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["authorization", "content-type"],
  });
  prod.post("/auth/session", async () => ({ ok: true }));
  await prod.ready();

  const preflight = (origem: string) =>
    prod.inject({
      method: "OPTIONS",
      url: "/auth/session",
      headers: {
        origin: origem,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

  // era exatamente isto que faltava: o OAuth ia até o fim e o POST seguinte
  // apanhava, com o navegador dizendo "Login concluído" e o app "Falha no login"
  const desktop = await preflight("app://bundle");
  assert.equal(desktop.headers["access-control-allow-origin"], "app://bundle");
  assert.match(String(desktop.headers["access-control-allow-methods"] ?? ""), /POST/);

  const estranha = await preflight("https://atacante.example");
  assert.equal(
    estranha.headers["access-control-allow-origin"],
    undefined,
    "origem fora da lista não pode receber ACAO",
  );
});

// ---------------------------------------------------------------------------
// ALTA — o rate limit por IP virava balde global atrás do proxy
// ---------------------------------------------------------------------------

test("ALTA: com trustProxy, dois visitantes atrás do MESMO proxy têm baldes separados", async () => {
  // Era a pior consequência de todas as correções desta auditoria: eu pus um
  // rate limit no /auth/discord/start chaveado por `req.ip`, mas atrás do
  // Traefik `req.ip` é o proxy — então 21 requisições anônimas por minuto
  // trancavam o LOGIN DE TODO MUNDO, web e desktop. A única porta do servidor.
  const { SlidingWindow } = await import("../src/limits.js");
  const proxied = Fastify({ trustProxy: 1 });
  const janela = new SlidingWindow(3, 60_000);
  proxied.get("/limitada", async (req, reply) => {
    if (janela.retryAfterMs(req.ip) > 0) return reply.code(429).send({ ip: req.ip });
    janela.record(req.ip);
    return { ip: req.ip };
  });
  await proxied.ready();

  // o proxy acrescenta o IP real ao XFF; o socket é sempre ele mesmo
  const comoProxy = (ipReal: string) =>
    proxied.inject({ method: "GET", url: "/limitada", headers: { "x-forwarded-for": ipReal } });

  for (let i = 0; i < 3; i++) {
    const r = await comoProxy("203.0.113.7");
    assert.equal(r.statusCode, 200, "o primeiro visitante tem 3 vagas");
    assert.equal(r.json().ip, "203.0.113.7", "req.ip tem de ser o visitante, não o proxy");
  }
  assert.equal((await comoProxy("203.0.113.7")).statusCode, 429, "o 4º dele apanha");

  // e o vizinho, atrás do MESMO proxy, não pode herdar a punição
  assert.equal((await comoProxy("198.51.100.9")).statusCode, 200, "outro visitante não pode estar trancado");
});

test("ALTA: enxurrada anônima não tranca o login — o teto despeja o mais antigo", async () => {
  // A 1ª versão respondia 503 no teto, o que era lockout com outra roupa. E a
  // janela por `req.ip` que eu tinha posto era pior ainda: o cluster faz SNAT
  // (externalTrafficPolicy Cluster), então TODOS compartilhavam um balde e 21
  // requisições anônimas por minuto trancavam o login de todo mundo.
  process.env.DISCORD_CLIENT_ID = "test-client-id";
  process.env.DISCORD_CLIENT_SECRET = "test-client-secret";
  const { registerOAuthRoutes } = await import("../src/oauth.js");
  const oauthApp = Fastify();
  registerOAuthRoutes(oauthApp, store, sessions, guild);
  await oauthApp.ready();

  const start = () => oauthApp.inject({ method: "GET", url: "/auth/discord/start" });

  // enxurrada: muito mais que qualquer uso legítimo
  let naoRedirecionou = 0;
  for (let i = 0; i < 600; i++) {
    const r = await start();
    if (r.statusCode !== 302) naoRedirecionou++;
  }
  assert.equal(naoRedirecionou, 0, "nenhuma requisição pode ser recusada — era o lockout");

  // e o login de um humano DEPOIS da enxurrada continua funcionando
  const humano = await start();
  assert.equal(humano.statusCode, 302, "o login legítimo tem de continuar passando");
  assert.match(String(humano.headers.location ?? ""), /discord\.com\/oauth2\/authorize/);
});

test("...e o XFF que o CLIENTE escreve não fura a janela", async () => {
  // é a objeção que o comentário antigo levantava, e ela é correta para XFF
  // cru. Com contagem de saltos o proxy-addr descarta o que o cliente pôs e
  // usa o que o salto confiável ACRESCENTOU — que o cliente não controla.
  const proxied = Fastify({ trustProxy: 1 });
  proxied.get("/eco", async (req) => ({ ip: req.ip }));
  await proxied.ready();

  const r = await proxied.inject({
    method: "GET",
    url: "/eco",
    // o cliente inventa dois saltos na frente; só o último (o real) vale
    headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8, 203.0.113.7" },
  });
  assert.equal(r.json().ip, "203.0.113.7", "só o endereço do salto confiável conta");
});

// ---------------------------------------------------------------------------
// BAIXA — id fora do int64
// ---------------------------------------------------------------------------

test("BAIXA: id acima do int64 vira 404, e não RangeError não tratado (500)", async () => {
  // 9223372036854775807 é o teto; os dois abaixo passavam no regex de 20
  // dígitos, chegavam ao bind do better-sqlite3 e estouravam
  for (const id of ["9223372036854775808", "99999999999999999999"]) {
    assert.equal(canonicalId(id), null, `${id} não pode ser canonizado`);
    const r = await app.inject({ method: "GET", url: `/api/channels/${id}/messages`, headers: { authorization: "Bearer dev.alguem" } });
    assert.notEqual(r.statusCode, 500, `${id} devolveu 500`);
  }
  // o teto exato continua válido — a correção não pode comer id legítimo
  assert.equal(canonicalId("9223372036854775807"), "9223372036854775807");
  assert.equal(canonicalId("1"), "1");
  assert.equal(canonicalId("01"), "1", "a canonização de zero à esquerda tem de sobreviver");
});

// ---------------------------------------------------------------------------
// BAIXA — esquema do avatar_override
// ---------------------------------------------------------------------------

test("BAIXA: avatar_override só aceita https", () => {
  for (const u of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://x.com/a.png",
    "http://x.com/a.png", // conteúdo misto numa página https: não carrega
  ]) {
    assert.equal(UpdateMeBody.safeParse({ avatar_override: u }).success, false, `${u} não pode passar`);
  }
  assert.equal(UpdateMeBody.safeParse({ avatar_override: "https://cdn.discordapp.com/avatars/1/a.png" }).success, true);
  assert.equal(UpdateMeBody.safeParse({ avatar_override: null }).success, true, "null limpa o override");
});
