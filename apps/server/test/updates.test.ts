/**
 * Distribuição do app desktop (M14): tíquete, artefatos no PVC e as rotas.
 *
 * O que estes testes protegem, em ordem de importância:
 *
 *   1. **O feed funciona SEM Bearer.** Ele é autenticado por tíquete na query,
 *      porque quem o chama é uma navegação do navegador e o electron-updater.
 *      Se alguém "arrumar" a classe dessas rotas para `leitura`, o hook geral
 *      do rate limit responde 401 antes delas e o auto-update morre EM
 *      SILÊNCIO — o app continua abrindo, só nunca mais atualiza.
 *   2. **Um POST sem token não deixa arquivo nenhum.** O que o teste prova é o
 *      observável: 401 e diretório vazio. A guarda estar num `onRequest` de
 *      ROTA (e não dentro do handler) é o que garante que ela roda antes de
 *      qualquer leitura do corpo; isso o teste não consegue distinguir, porque
 *      o parser deste upload é de FLUXO e só escreve quando o handler puxa —
 *      está escrito no código, e é por isso que fica escrito aqui também.
 *   3. **O commit é o que publica.** Os artefatos podem chegar pela metade (o
 *      job cai, a rede corta); o que os amigos baixam só muda quando o servidor
 *      confere que o `.exe` E o `latest.yml` estão no disco.
 *   4. **O nome do artefato é uma allowlist**, e o caminho nunca é concatenado
 *      a partir do pedido.
 *
 * Banco ":memory:", Fastify de verdade por `app.inject()`, diretório de
 * artefatos num tmpdir por teste — nenhuma rede e nenhum arquivo do repo.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { register } from "tsx/esm/api";

register();

process.env.DANJOCORD_DEV_AUTH = "1";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { registerRateLimit } = await import("../src/rate-limit.js");
const { registerUpdateRoutes } = await import("../src/updates/routes.js");
const { TicketStore, TICKET_TTL_MS } = await import("../src/updates/tickets.js");
const { MAX_ARTEFATO_BYTES, TIPO_RELEASE, gravarArtefato, limparTemporarios, nomeDeArtefatoValido, podar, versaoValida } =
  await import("../src/updates/store.js");

const TOKEN = "token-de-publicacao-do-ci-1234567890";
const EXE = "Danjocord-Setup-0.1.0.exe";
const AUTH = { authorization: "Bearer dev.leo" };
const PUB = { authorization: `Bearer ${TOKEN}`, "content-type": TIPO_RELEASE };

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "danjocord-releases-"));
}

// ---------------------------------------------------------------------------
// Nome de artefato e versão — puros, e é aqui que mora a allowlist
// ---------------------------------------------------------------------------

test("nome de artefato: só o que a gente publica entra", () => {
  for (const bom of [EXE, `${EXE}.blockmap`, "latest.yml"]) {
    assert.equal(nomeDeArtefatoValido(bom), true, bom);
  }
  for (const mau of [
    "../danjocord.db", // subir um nível
    "sub/dir.exe", // barra
    "..exe", // começa com ponto
    ".env", // idem, e sem extensão nossa
    "release.json", // metadado NOSSO, não é artefato — nem entra nem sai
    "danjocord.db", // extensão fora da lista
    "x".repeat(200) + ".exe", // nome absurdo
    "", // vazio
  ]) {
    assert.equal(nomeDeArtefatoValido(mau), false, mau);
  }
});

test("versão: semver simples, como a tag produz", () => {
  assert.equal(versaoValida("0.1.0"), true);
  assert.equal(versaoValida("1.20.3-beta.1"), true);
  assert.equal(versaoValida("v1.2.3"), false, "o `v` sai no workflow, não chega aqui");
  assert.equal(versaoValida("1.2"), false);
  assert.equal(versaoValida("../1.2.3"), false);
});

// ---------------------------------------------------------------------------
// Gravação e poda
// ---------------------------------------------------------------------------

test("gravar artefato: passa do teto, nada fica no disco", async () => {
  const dir = await tmp();
  // um fluxo maior que o teto, gerado sem alocar tudo de uma vez
  const pedaco = Buffer.alloc(1024 * 1024);
  const fluxo = Readable.from(
    (function* () {
      for (let i = 0; i <= MAX_ARTEFATO_BYTES / pedaco.length; i++) yield pedaco;
    })(),
  );
  await assert.rejects(() => gravarArtefato(dir, EXE, fluxo), /passou de/);
  assert.deepEqual(await readdir(dir), [], "nem o arquivo final nem o temporário sobram");
});

test("poda: guarda os dois instaladores mais novos e o resto vai junto do blockmap", async () => {
  const dir = await tmp();
  const versoes = ["0.1.0", "0.2.0", "0.3.0"];
  for (const [i, v] of versoes.entries()) {
    const exe = `Danjocord-Setup-${v}.exe`;
    await writeFile(join(dir, exe), "x");
    await writeFile(join(dir, `${exe}.blockmap`), "x");
    // mtime crescente: a ordem de CHEGADA é a ordem certa por construção
    const quando = new Date(1_700_000_000_000 + i * 60_000);
    await utimes(join(dir, exe), quando, quando);
  }
  await writeFile(join(dir, "latest.yml"), "version: 0.3.0");
  await writeFile(join(dir, "release.json"), "{}");

  const apagados = await podar(dir, 2);
  const restou = (await readdir(dir)).sort();
  assert.deepEqual(apagados.sort(), ["Danjocord-Setup-0.1.0.exe", "Danjocord-Setup-0.1.0.exe.blockmap"]);
  assert.ok(restou.includes("latest.yml"), "o manifesto é substituído, nunca podado");
  assert.ok(restou.includes("release.json"), "o metadado também não");
  assert.ok(restou.includes("Danjocord-Setup-0.3.0.exe") && restou.includes("Danjocord-Setup-0.2.0.exe"));
  assert.ok(!restou.includes("Danjocord-Setup-0.1.0.exe"));
});

// ---------------------------------------------------------------------------
// O tíquete
// ---------------------------------------------------------------------------

test("tíquete: resolve para o dono, e só até vencer", () => {
  const store = new TicketStore();
  const t0 = 1_000_000;
  const { ticket, expiresIn } = store.issue("42", t0);

  assert.equal(store.resolve(ticket, t0), "42");
  assert.equal(expiresIn, Math.floor(TICKET_TTL_MS / 1000));
  // MÚLTIPLOS USOS de propósito: uma atualização são duas requisições ao feed
  // (latest.yml e o .exe) ao longo de minutos, não uma
  assert.equal(store.resolve(ticket, t0 + 60_000), "42", "não é de uso único");

  assert.equal(store.resolve(ticket, t0 + TICKET_TTL_MS), null, "vence no limite, não depois");
  assert.equal(store.size, 0, "o vencido some do mapa em vez de acumular");
});

test("tíquete: qualquer coisa que não foi emitida não vale", () => {
  const store = new TicketStore();
  store.issue("42");
  assert.equal(store.resolve("inventado"), null);
  assert.equal(store.resolve(""), null);
  assert.equal(store.resolve(undefined), null);
});

// ---------------------------------------------------------------------------
// As rotas
// ---------------------------------------------------------------------------

async function montar(opts: { publishToken?: string } = {}): Promise<{ app: ReturnType<typeof Fastify>; dir: string }> {
  const dir = await tmp();
  const store = new Store(openDb(":memory:"));
  const app = Fastify();
  // a ordem do index.ts: o hook do rate limit ANTES das rotas, senão o onRoute
  // não as vê e o limite vira no-op
  registerRateLimit(app, store);
  await registerUpdateRoutes(app, store, { releasesDir: dir, publishToken: opts.publishToken ?? TOKEN });
  await app.ready();
  return { app, dir };
}

/** Sobe o `.exe` e o `latest.yml` e vira a chave — o caminho do workflow. */
async function publicar(app: ReturnType<typeof Fastify>, versao = "0.1.0"): Promise<string> {
  const exe = `Danjocord-Setup-${versao}.exe`;
  await app.inject({ method: "POST", url: `/api/updates/publish?file=${exe}`, headers: PUB, payload: "instalador" });
  await app.inject({
    method: "POST",
    url: "/api/updates/publish?file=latest.yml",
    headers: PUB,
    payload: `version: ${versao}\npath: ${exe}\n`,
  });
  const r = await app.inject({
    method: "POST",
    url: "/api/updates/publish/commit",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { version: versao, file: exe },
  });
  assert.equal(r.statusCode, 200, r.body);
  return exe;
}

async function ticket(app: ReturnType<typeof Fastify>): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/api/updates/ticket", headers: AUTH });
  assert.equal(r.statusCode, 200, r.body);
  return (r.json() as { ticket: string }).ticket;
}

test("o feed passa SEM Bearer — a credencial dele é o tíquete", async () => {
  const { app } = await montar();
  await publicar(app);
  const t = await ticket(app);

  // ESTE é o teste que importa: nenhum header de autorização, e ainda assim 200.
  // Com a classe trocada para `leitura`, o hook geral responde 401 aqui e o
  // auto-update morre sem um erro que aponte para a causa.
  const res = await app.inject({ method: "GET", url: `/api/updates/feed/latest.yml?ticket=${encodeURIComponent(t)}` });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /version: 0\.1\.0/);
  assert.match(String(res.headers["content-disposition"]), /attachment/);
  await app.close();
});

test("o feed sem tíquete (ou com um inventado) é 401", async () => {
  const { app } = await montar();
  await publicar(app);
  for (const url of ["/api/updates/feed/latest.yml", "/api/updates/feed/latest.yml?ticket=abc"]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401, url);
  }
  // e um Bearer válido NÃO substitui o tíquete: quem chama isto é o updater
  const comBearer = await app.inject({ method: "GET", url: "/api/updates/feed/latest.yml", headers: AUTH });
  assert.equal(comBearer.statusCode, 401);
  await app.close();
});

test("o nome do arquivo é uma allowlist, e o caminho nunca é concatenado", async () => {
  const { app, dir } = await montar();
  await publicar(app);
  await writeFile(join(dir, "..", "vizinho.txt"), "segredo");
  const t = await ticket(app);
  for (const nome of ["nao-existe.exe", "release.json", "..%2fvizinho.txt", "LATEST.YML"]) {
    const res = await app.inject({ method: "GET", url: `/api/updates/feed/${nome}?ticket=${t}` });
    assert.ok(res.statusCode === 404 || res.statusCode === 400, `${nome} → ${res.statusCode}`);
  }
  await app.close();
});

test("GET /api/updates/latest: 404 antes, e o tamanho REAL do disco depois", async () => {
  const { app, dir } = await montar();
  const antes = await app.inject({ method: "GET", url: "/api/updates/latest", headers: AUTH });
  assert.equal(antes.statusCode, 404);
  assert.match((antes.json() as { error: string }).error, /nenhum instalador/i);

  const exe = await publicar(app);
  const depois = await app.inject({ method: "GET", url: "/api/updates/latest", headers: AUTH });
  assert.equal(depois.statusCode, 200);
  const corpo = depois.json() as { version: string; file: string; size: number };
  assert.equal(corpo.version, "0.1.0");
  assert.equal(corpo.file, exe);
  // o `size` do commit é zero de propósito — quem manda é o arquivo
  assert.equal(corpo.size, (await stat(join(dir, exe))).size);
  await app.close();
});

test("o release some quando o arquivo some, mesmo com o metadado intacto", async () => {
  const { app, dir } = await montar();
  const exe = await publicar(app);
  await (await import("node:fs/promises")).rm(join(dir, exe));
  const res = await app.inject({ method: "GET", url: "/api/updates/latest", headers: AUTH });
  // um botão "Baixar" que dá 404 é pior que a mensagem honesta de "não há versão"
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("o tíquete exige sessão", async () => {
  const { app } = await montar();
  assert.equal((await app.inject({ method: "POST", url: "/api/updates/ticket" })).statusCode, 401);
  await app.close();
});

// ---------------------------------------------------------------------------
// A porta do CI
// ---------------------------------------------------------------------------

test("publish sem token é 401 e não deixa arquivo nenhum", async () => {
  const { app, dir } = await montar();
  const grande = "A".repeat(2 * 1024 * 1024);

  const semNada = await app.inject({
    method: "POST",
    url: `/api/updates/publish?file=${EXE}`,
    headers: { "content-type": TIPO_RELEASE },
    payload: grande,
  });
  assert.equal(semNada.statusCode, 401);

  const errado = await app.inject({
    method: "POST",
    url: `/api/updates/publish?file=${EXE}`,
    headers: { authorization: "Bearer quase-certo", "content-type": TIPO_RELEASE },
    payload: grande,
  });
  assert.equal(errado.statusCode, 401);

  assert.deepEqual(await readdir(dir), [], "nenhum arquivo, nenhum temporário");
  await app.close();
});

test("publish desligado responde 503 dizendo o que falta", async () => {
  const { app } = await montar({ publishToken: "" });
  const res = await app.inject({
    method: "POST",
    url: `/api/updates/publish?file=${EXE}`,
    headers: PUB,
    payload: "x",
  });
  assert.equal(res.statusCode, 503);
  assert.match((res.json() as { error: string }).error, /DANJOCORD_PUBLISH_TOKEN/);
  await app.close();
});

test("publish recusa nome inválido antes de tocar no disco", async () => {
  const { app, dir } = await montar();
  const res = await app.inject({
    method: "POST",
    url: "/api/updates/publish?file=../danjocord.db",
    headers: PUB,
    payload: "x",
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(await readdir(dir), []);
  await app.close();
});

test("o COMMIT é o que publica: sem o latest.yml, 409 e nada muda", async () => {
  const { app } = await montar();
  await app.inject({ method: "POST", url: `/api/updates/publish?file=${EXE}`, headers: PUB, payload: "instalador" });

  const semManifesto = await app.inject({
    method: "POST",
    url: "/api/updates/publish/commit",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { version: "0.1.0", file: EXE },
  });
  assert.equal(semManifesto.statusCode, 409);
  assert.match((semManifesto.json() as { error: string }).error, /latest\.yml/);

  // e a página continua dizendo "não há versão", em vez de anunciar meia release
  const latest = await app.inject({ method: "GET", url: "/api/updates/latest", headers: AUTH });
  assert.equal(latest.statusCode, 404);
  await app.close();
});

test("o commit poda o que passou de dois instaladores", async () => {
  const { app, dir } = await montar();
  for (const v of ["0.1.0", "0.2.0", "0.3.0"]) await publicar(app, v);
  const restou = (await readdir(dir)).filter((n) => n.endsWith(".exe")).sort();
  assert.deepEqual(restou, ["Danjocord-Setup-0.2.0.exe", "Danjocord-Setup-0.3.0.exe"]);
  assert.equal(JSON.parse(await readFile(join(dir, "release.json"), "utf8")).version, "0.3.0");
  await app.close();
});

test("o download do navegador leva ao feed, com o tíquete junto", async () => {
  const { app } = await montar();
  const exe = await publicar(app);
  const t = await ticket(app);
  const res = await app.inject({ method: "GET", url: `/api/updates/download?ticket=${encodeURIComponent(t)}` });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers["location"], `/api/updates/feed/${encodeURIComponent(exe)}?ticket=${encodeURIComponent(t)}`);
  await app.close();
});

test("o download do navegador erra VOLTANDO para a página, não com JSON", async () => {
  const { app } = await montar();
  // tíquete inválido: quem está aqui é uma NAVEGAÇÃO, e um corpo JSON deixaria
  // a pessoa numa aba branca com `{"error":...}` e sem botão de tentar de novo
  const mau = await app.inject({ method: "GET", url: "/api/updates/download?ticket=nao-existe" });
  assert.equal(mau.statusCode, 302);
  assert.equal(mau.headers["location"], "/download?erro=ticket");

  const t = await ticket(app);
  const semRelease = await app.inject({ method: "GET", url: `/api/updates/download?ticket=${t}` });
  assert.equal(semRelease.statusCode, 302);
  assert.equal(semRelease.headers["location"], "/download?erro=sem-release");
  await app.close();
});

// ---------------------------------------------------------------------------
// O estágio do manifesto — o que faz o commit ser a chave DE VERDADE
// ---------------------------------------------------------------------------

test("subir o latest.yml NÃO publica: antes do commit o feed continua no release velho", async () => {
  const { app, dir } = await montar();
  await publicar(app, "0.1.0"); // release corrente, já commitado

  // agora a metade de cima de uma publicação nova, sem o commit
  const novo = "Danjocord-Setup-0.2.0.exe";
  await app.inject({ method: "POST", url: `/api/updates/publish?file=${novo}`, headers: PUB, payload: "novo" });
  await app.inject({
    method: "POST",
    url: "/api/updates/publish?file=latest.yml",
    headers: PUB,
    payload: `version: 0.2.0\npath: ${novo}\n`,
  });

  // O feed é o cliente que importa: o electron-updater lê ISTO. Sem o estágio,
  // o arquivo novo já estaria no lugar e os apps instalados enxergariam a 0.2.0
  // — mesmo que o job morresse antes do commit.
  const t = await ticket(app);
  const feed = await app.inject({ method: "GET", url: `/api/updates/feed/latest.yml?ticket=${t}` });
  assert.equal(feed.statusCode, 200);
  assert.match(feed.body, /version: 0\.1\.0/, "o manifesto servido ainda é o do release commitado");
  assert.ok((await readdir(dir)).includes("latest.yml.pendente"), "o novo está em estágio, não no lugar");

  // e o commit promove
  const r = await app.inject({
    method: "POST",
    url: "/api/updates/publish/commit",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { version: "0.2.0", file: novo },
  });
  assert.equal(r.statusCode, 200, r.body);
  const depois = await app.inject({ method: "GET", url: `/api/updates/feed/latest.yml?ticket=${t}` });
  assert.match(depois.body, /version: 0\.2\.0/);
  assert.ok(!(await readdir(dir)).includes("latest.yml.pendente"), "o estágio some ao virar a chave");
  await app.close();
});

test("o commit não aceita sem o manifesto em estágio, mesmo com um latest.yml velho no disco", async () => {
  const { app } = await montar();
  await publicar(app, "0.1.0"); // deixa um latest.yml legítimo no disco
  const novo = "Danjocord-Setup-0.2.0.exe";
  await app.inject({ method: "POST", url: `/api/updates/publish?file=${novo}`, headers: PUB, payload: "novo" });
  // sem subir o latest.yml da 0.2.0: o commit não pode se contentar com o velho
  const r = await app.inject({
    method: "POST",
    url: "/api/updates/publish/commit",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { version: "0.2.0", file: novo },
  });
  assert.equal(r.statusCode, 409);
  assert.match((r.json() as { error: string }).error, /latest\.yml/);
  await app.close();
});

test("a poda nunca apaga o instalador do release que acabou de ser publicado", async () => {
  const { app, dir } = await montar();
  const atual = await publicar(app, "0.1.0");

  // Dois jobs que subiram o `.exe` e morreram antes do commit. Eles são MAIS
  // NOVOS por mtime que o instalador no ar.
  for (const orfa of ["0.8.0", "0.9.0"]) {
    await app.inject({
      method: "POST",
      url: `/api/updates/publish?file=Danjocord-Setup-${orfa}.exe`,
      headers: PUB,
      payload: "orfao",
    });
  }

  // Agora um commit da MESMA versão que já está no ar — é o caso concreto de
  // reexecutar um run antigo pela UI do GitHub. Sem a proteção, a poda ordena
  // por mtime, acha os dois órfãos mais novos e apaga o instalador que o
  // `release.json` acabou de apontar: a página passa a oferecer um 404.
  await app.inject({
    method: "POST",
    url: "/api/updates/publish?file=latest.yml",
    headers: PUB,
    payload: `version: 0.1.0
path: ${atual}
`,
  });
  const r = await app.inject({
    method: "POST",
    url: "/api/updates/publish/commit",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { version: "0.1.0", file: atual },
  });
  assert.equal(r.statusCode, 200, r.body);

  assert.ok((await readdir(dir)).includes(atual), "o instalador do release corrente sobreviveu à própria poda");
  const latest = await app.inject({ method: "GET", url: "/api/updates/latest", headers: AUTH });
  assert.equal(latest.statusCode, 200, "e continua baixável — não vira um botão que dá 404");
});

test("temporário órfão de um pod morto no meio do upload some no boot", async () => {
  const dir = await tmp();
  await writeFile(join(dir, ".tmp-deadbeef"), "meio instalador");
  await writeFile(join(dir, "latest.yml"), "version: 1.0.0");
  const limpos = await limparTemporarios(dir);
  assert.deepEqual(limpos, [".tmp-deadbeef"]);
  const restou = await readdir(dir);
  assert.deepEqual(restou, ["latest.yml"], "só o temporário some");
});
