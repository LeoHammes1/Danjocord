/**
 * Rate limit geral do REST (roadmap 117, segunda metade).
 *
 * O que estes testes protegem NÃO é "o 429 sai" — é o conjunto de decisões que
 * fazem um rate limit ser defesa em vez de arma. Em ordem de importância:
 *
 *   1. `/healthz` isento. O kubelet bate lá a cada 10 s; um 429 tira o pod dos
 *      Endpoints e depois o mata. É o teste que impede um deploy em laço.
 *   2. a chave não é o IP, e um `x-forwarded-for` diferente por requisição não
 *      cria balde novo. Medido em produção: o SNAT do kube-proxy faz TODO
 *      mundo chegar como 10.42.0.0, então chave por IP = um usuário trancando
 *      os outros nove. Esse bug já existiu aqui (o do `/auth/discord/start`).
 *   3. anônimo não gasta cota de ninguém.
 *   4. o corpo NÃO é lido quando o 429 sai — é o que torna o limite uma defesa
 *      contra upload grande, e não só contra contagem.
 *
 * Banco ":memory:", Fastify de verdade por `app.inject()`. Cada teste tem
 * USUÁRIO próprio: as janelas são por chave e reaproveitar nome faria um teste
 * comer a cota do outro. Onde a janela é do APP (e não do usuário), o teste
 * monta app próprio — mesmo motivo do `moderation.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "tsx/esm/api";

register();

process.env.DANJOCORD_DEV_AUTH = "1";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { Gateway } = await import("../src/gateway.js");
const { registerRoutes } = await import("../src/routes.js");
const { registerRateLimit, classeDaRota, ORCAMENTOS, MENSAGEM_LIMITE } = await import("../src/rate-limit.js");
const { tooManyRequests } = await import("../src/limits.js");

/** App com as rotas de mensagens + o limite geral. */
function montar(): { app: ReturnType<typeof Fastify>; store: InstanceType<typeof Store> } {
  const db = openDb(":memory:");
  const store = new Store(db);
  const gateway = new Gateway(store);
  // `trustProxy: 1` como em produção, e isto NÃO é detalhe: sem ele o
  // `app.inject` devolve 127.0.0.1 em `req.ip` faça o que fizer com o
  // `x-forwarded-for`, e o teste da chave abaixo passaria mesmo com a chave
  // trocada por IP — ou seja, não provaria nada. (Descoberto quebrando a
  // implementação de propósito para ver o teste reprovar; ele não reprovava.)
  const app = Fastify({ trustProxy: 1 });
  // a ordem do `index.ts`: o hook primeiro, senão o `onRoute` não vê as rotas
  registerRateLimit(app, store);
  registerRoutes(app, store, gateway);
  return { app, store };
}

const CANAL = "1"; // 'geral', do seed da migration 001

function auth(username: string): Record<string, string> {
  return { authorization: `Bearer dev.${username}` };
}

// ---------------------------------------------------------------------------
// A resposta 429, agora numa função só
// ---------------------------------------------------------------------------

test("o 429 mantém a forma que o cliente já entende", async () => {
  const app = Fastify();
  app.get("/x", async (_req, reply) => tooManyRequests(reply, 1200, "muitas coisas"));
  app.get("/y", async (_req, reply) => tooManyRequests(reply, 300, "muitas coisas"));

  const a = await app.inject({ method: "GET", url: "/x" });
  assert.equal(a.statusCode, 429);
  assert.equal(a.headers["retry-after"], "2", "o header é inteiro em segundos, ARREDONDADO PARA CIMA");
  assert.equal(a.json().retry_after, 1.2, "o corpo mantém a precisão — é o que os 4 call sites do cliente leem");

  const b = await app.inject({ method: "GET", url: "/y" });
  // "0" no header significaria "pode tentar já", o contrário do que a resposta
  // acabou de dizer
  assert.equal(b.headers["retry-after"], "1", "piso de 1 s");
  assert.equal(b.json().retry_after, 0.3);
  await app.close();
});

// ---------------------------------------------------------------------------
// A tabela: rota nova sem classe não sobe
// ---------------------------------------------------------------------------

test("rota fora da tabela derruba o BOOT, e não o primeiro acesso", async () => {
  const { app } = montar();
  assert.throws(
    () => {
      app.get("/api/inventada", async () => ({ ok: true }));
    },
    /não está na tabela de classes/,
    "o default silencioso seria uma rota nova nascendo ilimitada sem ninguém notar",
  );
  await app.close();
});

test("as rotas que existem hoje estão TODAS classificadas", async () => {
  // Este é o teste que faz a tabela envelhecer junto com o código: monta todos
  // os registradores de rota do projeto e deixa o `onRoute` falar.
  const { registerReactionRoutes } = await import("../src/reactions.js");
  const { registerAttachmentRoutes } = await import("../src/attachments/routes.js");
  const { registerSearchRoutes } = await import("../src/search.js");
  const { registerLinkRoutes } = await import("../src/links/routes.js");
  const { registerSoundRoutes } = await import("../src/sounds/routes.js");
  const { registerModerationRoutes } = await import("../src/moderation.js");
  const { registerAuthRoutes } = await import("../src/auth-routes.js");
  const { registerOAuthRoutes } = await import("../src/oauth.js");
  const { registerStaticClient } = await import("../src/static-client.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dirEstatico = mkdtempSync(join(tmpdir(), "danjo-rl-"));
  writeFileSync(join(dirEstatico, "index.html"), "<!doctype html>");
  writeFileSync(join(dirEstatico, "app.js"), "//");
  const { Sessions } = await import("../src/sessions.js");
  const { Guild } = await import("../src/guild.js");

  const db = openDb(":memory:");
  const store = new Store(db);
  const gateway = new Gateway(store);
  const sessions = new Sessions(db, store);
  const guild = new Guild(db);
  const app = Fastify();
  registerRateLimit(app, store);
  registerRoutes(app, store, gateway);
  registerReactionRoutes(app, store, gateway);
  registerAttachmentRoutes(app, store);
  registerSearchRoutes(app, store);
  registerLinkRoutes(app, store);
  // as assinaturas são as do `moderation.test.ts`/`sounds.test.ts`: o
  // `pnpm typecheck` NÃO olha test/, então argumento errado aqui passaria
  // silenciosamente e enfraqueceria justamente a garantia deste teste
  registerSoundRoutes(app, store, gateway, { voiceChannelOf: () => null });
  registerModerationRoutes(app, store, gateway, guild, { disconnectFromVoice: async () => undefined });
  registerAuthRoutes(app, store, sessions);
  // oauth e cliente estático entram porque as rotas deles existem em produção:
  // sem isto o teste dizia "todas as rotas" cobrindo só uma parte delas
  registerOAuthRoutes(app, store, sessions, guild);
  registerStaticClient(app, dirEstatico);

  await assert.doesNotReject(() => app.ready(), "alguma rota do projeto não está na tabela de classes");
  await app.close();
});

test("arquivo estático é reconhecido pelo config, não pelo caminho", () => {
  // o @fastify/static registra UMA rota por arquivo: elas não cabem na tabela,
  // e casar por string de caminho seria frágil
  assert.equal(classeDaRota("GET", "/assets/app-abc123.js", { rootPath: "/build" }), "isento");
  assert.equal(classeDaRota("HEAD", "/assets/qualquer.mp3", { rootPath: "/build" }), "isento");
  // e sem o rootPath a MESMA url derruba o boot
  assert.throws(() => classeDaRota("GET", "/assets/app-abc123.js", {}), /não está na tabela/);
});

test("HEAD é normalizado para GET (o Fastify cria o par sozinho)", () => {
  assert.equal(classeDaRota("HEAD", "/healthz", {}), "isento");
  assert.equal(classeDaRota("HEAD", "/api/channels/:channelId/messages", {}), "leitura");
});

// ---------------------------------------------------------------------------
// O isento mortal
// ---------------------------------------------------------------------------

test("/healthz nunca é limitado, nem com o dobro de qualquer janela", async () => {
  const { app } = montar();
  const rajada = ORCAMENTOS.leitura!.limite * 2;
  for (let i = 0; i < rajada; i++) {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(r.statusCode, 200, `a ${i + 1}ª probe falhou — isto tira o pod dos Endpoints em ~30 s`);
  }
  await app.close();
});

// ---------------------------------------------------------------------------
// A chave
// ---------------------------------------------------------------------------

test("x-forwarded-for diferente a cada requisição NÃO cria balde novo", async () => {
  // A lição do SNAT, cravada por escrito. Se alguém "melhorar" a chave para
  // `user.id + req.ip` ou para `req.ip`, este teste reprova — e é ele que
  // impede o retorno do bug que trancou o login de todo mundo.
  const { app } = montar();
  const limite = ORCAMENTOS.leitura!.limite;
  let ultima = 0;
  for (let i = 0; i <= limite; i++) {
    const r = await app.inject({
      method: "GET",
      url: `/api/channels/${CANAL}/messages?limit=1`,
      headers: { ...auth("xff"), "x-forwarded-for": `1.2.3.${i % 250}` },
    });
    ultima = r.statusCode;
  }
  assert.equal(ultima, 429, "trocar de IP a cada requisição não pode zerar a cota");
  await app.close();
});

test("um usuário não tranca o outro", async () => {
  const { app } = montar();
  const limite = ORCAMENTOS.leitura!.limite;
  for (let i = 0; i <= limite; i++) {
    await app.inject({ method: "GET", url: `/api/channels/${CANAL}/messages?limit=1`, headers: auth("gastador") });
  }
  const dele = await app.inject({
    method: "GET",
    url: `/api/channels/${CANAL}/messages?limit=1`,
    headers: auth("gastador"),
  });
  assert.equal(dele.statusCode, 429, "sanidade: o gastador estourou mesmo");

  const vizinho = await app.inject({
    method: "GET",
    url: `/api/channels/${CANAL}/messages?limit=1`,
    headers: auth("vizinho"),
  });
  assert.equal(vizinho.statusCode, 200, "a janela é POR USUÁRIO — janela global seria um trancando os outros nove");
  await app.close();
});

test("anônimo leva 401 e não gasta cota de ninguém", async () => {
  const { app } = montar();
  // muito acima de qualquer janela: se o anônimo entrasse num balde, ele
  // estaria estourado depois disto
  for (let i = 0; i < ORCAMENTOS.leitura!.limite * 3; i++) {
    const r = await app.inject({ method: "GET", url: `/api/channels/${CANAL}/messages?limit=1` });
    assert.equal(r.statusCode, 401);
  }
  const autenticado = await app.inject({
    method: "GET",
    url: `/api/channels/${CANAL}/messages?limit=1`,
    headers: auth("depoisdaenxurrada"),
  });
  assert.equal(autenticado.statusCode, 200, "enxurrada anônima não pode fechar a porta de quem tem credencial");
  await app.close();
});

// ---------------------------------------------------------------------------
// Os orçamentos
// ---------------------------------------------------------------------------

test("a sub-janela de mensagem morde antes da classe escrita", async () => {
  const { app } = montar();
  const codigos: number[] = [];
  for (let i = 0; i <= MENSAGEM_LIMITE; i++) {
    const r = await app.inject({
      method: "POST",
      url: `/api/channels/${CANAL}/messages`,
      headers: auth("tagarela"),
      payload: { content: `msg ${i}` },
    });
    codigos.push(r.statusCode);
  }
  assert.equal(codigos.filter((c) => c === 201).length, MENSAGEM_LIMITE, "o limite é a rajada, não o minuto");
  const ultima = await app.inject({
    method: "POST",
    url: `/api/channels/${CANAL}/messages`,
    headers: auth("tagarela"),
    payload: { content: "estourada" },
  });
  assert.equal(ultima.statusCode, 429);
  assert.equal(
    ultima.json().error,
    "muitas mensagens seguidas",
    "a frase diz QUAL classe estourou — senão um 429 no histórico e um no envio são indistinguíveis num relato de bug",
  );
  // e a classe `escrita`, que é mais folgada, ainda tem cota: editar continua
  // possível (o limite de rajada não é um mute)
  assert.ok(ORCAMENTOS.escrita!.limite > MENSAGEM_LIMITE);
  await app.close();
});

test("o corpo NÃO é lido quando o 429 sai", async () => {
  // `onRequest` roda ANTES do parser. É isto que faz o limite defender de
  // upload grande, e não só contar: em `preHandler` os megabytes já entraram.
  const { app } = montar();
  for (let i = 0; i <= MENSAGEM_LIMITE; i++) {
    await app.inject({
      method: "POST",
      url: `/api/channels/${CANAL}/messages`,
      headers: auth("gordo"),
      payload: { content: "x" },
    });
  }
  const gigante = await app.inject({
    method: "POST",
    url: `/api/channels/${CANAL}/messages`,
    headers: auth("gordo"),
    // acima do bodyLimit PADRÃO do Fastify (1 MiB): sem o hook isto é 413,
    // porque o corpo é lido inteiro antes de a rota existir
    payload: { content: "a".repeat(1_500_000) },
  });
  assert.equal(gigante.statusCode, 429, "veio 413: o corpo foi lido antes do limite — hook no lugar errado");
  await app.close();
});

test("classes diferentes têm baldes separados", async () => {
  const { app } = montar();
  // estoura o typing (a janela mais apertada)
  const limite = ORCAMENTOS.typing!.limite;
  for (let i = 0; i <= limite; i++) {
    await app.inject({ method: "POST", url: `/api/channels/${CANAL}/typing`, headers: auth("digitador") });
  }
  const t = await app.inject({ method: "POST", url: `/api/channels/${CANAL}/typing`, headers: auth("digitador") });
  assert.equal(t.statusCode, 429);
  assert.equal(t.json().error, "muitos avisos de digitação");

  // e ler o histórico continua funcionando: estourar o indicador de digitação
  // não pode cegar a pessoa
  const l = await app.inject({
    method: "GET",
    url: `/api/channels/${CANAL}/messages?limit=1`,
    headers: auth("digitador"),
  });
  assert.equal(l.statusCode, 200);
  await app.close();
});

test("ler o histórico não come a cota de carregar as imagens dele", async () => {
  // O download de anexo NÃO é lazy: sai no render. Uma página de 50 mensagens
  // com foto dispara até 50 GETs de uma vez, então no MESMO balde da paginação
  // rolar um canal com fotos estouraria a cota — o limite viraria um bug, e não
  // uma defesa. Este teste é o que impede alguém de "simplificar" juntando as
  // duas classes de novo.
  const { registerAttachmentRoutes } = await import("../src/attachments/routes.js");
  const db = openDb(":memory:");
  const store = new Store(db);
  const gateway = new Gateway(store);
  const app = Fastify({ trustProxy: 1 });
  registerRateLimit(app, store);
  registerRoutes(app, store, gateway);
  registerAttachmentRoutes(app, store);

  // estoura a leitura (rolando o histórico)
  const limite = ORCAMENTOS.leitura!.limite;
  for (let i = 0; i <= limite; i++) {
    await app.inject({ method: "GET", url: `/api/channels/${CANAL}/messages?limit=1`, headers: auth("rolador") });
  }
  const historico = await app.inject({
    method: "GET",
    url: `/api/channels/${CANAL}/messages?limit=1`,
    headers: auth("rolador"),
  });
  assert.equal(historico.statusCode, 429, "sanidade: a leitura estourou mesmo");

  // e a imagem da última página ainda carrega (404 porque o anexo não existe —
  // o que importa é que NÃO é 429)
  const imagem = await app.inject({ method: "GET", url: "/api/attachments/123", headers: auth("rolador") });
  assert.notEqual(imagem.statusCode, 429, "a mídia tem balde próprio: as fotos não podem morrer junto com o scroll");
  await app.close();
});

test("rota com limitador próprio não é cobrada duas vezes", async () => {
  const { registerAttachmentRoutes } = await import("../src/attachments/routes.js");
  const { UPLOAD_LIMIT } = await import("../src/attachments/limits.js");
  const db = openDb(":memory:");
  const store = new Store(db);
  const gateway = new Gateway(store);
  const app = Fastify();
  registerRoutes(app, store, gateway);
  registerAttachmentRoutes(app, store);
  registerRateLimit(app, store);

  // lixo de propósito: o que importa é a janela, não o arquivo
  const lixo = Buffer.from("nao e uma imagem");
  let ultimo = { statusCode: 0, json: () => ({ error: "" }) } as unknown as Awaited<
    ReturnType<(typeof app)["inject"]>
  >;
  for (let i = 0; i <= UPLOAD_LIMIT; i++) {
    ultimo = await app.inject({
      method: "POST",
      url: "/api/attachments?filename=x.png",
      headers: { ...auth("subidor"), "content-type": "application/octet-stream" },
      payload: lixo,
    });
  }
  assert.equal(ultimo.statusCode, 429);
  assert.equal(
    ultimo.json().error,
    "muitos envios seguidos",
    "o 429 tem de ser o do limitador ESPECÍFICO — o geral nem conta esta rota",
  );

  // e a cota de leitura da pessoa continua intacta: as recusas do upload não
  // podem ter comido o balde geral dela
  const l = await app.inject({
    method: "GET",
    url: `/api/channels/${CANAL}/messages?limit=1`,
    headers: auth("subidor"),
  });
  assert.equal(l.statusCode, 200);
  await app.close();
});

test("rajada concorrente não passa do limite", async () => {
  // `retryAfterMs` e `record` são duas chamadas; um `await` entre elas deixaria
  // N requisições paralelas passarem todas pela janela ainda em zero
  const { app } = montar();
  const limite = ORCAMENTOS.typing!.limite;
  const respostas = await Promise.all(
    Array.from({ length: limite + 20 }, () =>
      app.inject({ method: "POST", url: `/api/channels/${CANAL}/typing`, headers: auth("paralelo") }),
    ),
  );
  const aceitas = respostas.filter((r) => r.statusCode < 400).length;
  assert.ok(aceitas <= limite, `passaram ${aceitas} de um limite de ${limite}`);
  await app.close();
});
