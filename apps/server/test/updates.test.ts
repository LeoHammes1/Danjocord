/**
 * Distribuição do app desktop (M14): tíquete, catálogo de releases e as rotas.
 *
 * O que estes testes protegem, em ordem de importância:
 *
 *   1. **O feed funciona SEM Bearer.** Ele é autenticado por tíquete na query,
 *      porque quem o chama é uma navegação do navegador e o electron-updater.
 *      Se alguém "arrumar" a classe dessas duas rotas para `leitura`, o hook
 *      geral do rate limit responde 401 antes delas e o auto-update morre EM
 *      SILÊNCIO — o app continua abrindo, só nunca mais atualiza.
 *   2. **A lista de nomes é o próprio catálogo.** `:file` só existe se casar,
 *      por igualdade exata, um asset publicado — não há concatenação de
 *      caminho em lugar nenhum.
 *   3. **O 302 só vai para o GitHub.** Não é SSRF (nós nunca buscamos a URL) —
 *      é redirect aberto: sem a checagem, a nossa origem mandaria o navegador
 *      de um amigo para onde a resposta da API mandasse.
 *   4. Rascunho e prerelease não contam como versão publicada.
 *
 * Banco ":memory:", Fastify de verdade por `app.inject()`, e um `fetch` falso
 * no lugar da API do GitHub — nenhuma rede.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "tsx/esm/api";

register();

process.env.DANJOCORD_DEV_AUTH = "1";
process.env.DANJOCORD_RELEASE_REPO = "dono/repo";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { registerRateLimit } = await import("../src/rate-limit.js");
const { registerUpdateRoutes } = await import("../src/updates/routes.js");
const { TicketStore, TICKET_TTL_MS } = await import("../src/updates/tickets.js");
const { catalogoDeReleases, instalador, limparCacheDeReleases, urlDeDownload } = await import("../src/updates/github.js");

// ---------------------------------------------------------------------------
// A API do GitHub, de mentira
// ---------------------------------------------------------------------------

const EXE = "Danjocord-Setup-1.2.0.exe";

/** Um release como a API devolve, com só o que o nosso código lê. */
function release(tag: string, extras: Record<string, unknown> = {}, assetId = 1): unknown {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: `2026-0${assetId}-01T00:00:00Z`,
    assets: [
      { id: assetId * 10, name: `Danjocord-Setup-${tag.slice(1)}.exe`, size: 120_000_000 },
      { id: assetId * 10 + 1, name: "latest.yml", size: 400 },
    ],
    ...extras,
  };
}

interface Chamada {
  url: string;
  redirect?: string;
}

/**
 * `fetch` falso. `releases` responde à listagem; `locationDoAsset` responde ao
 * pedido de download com um 302 (ou o que o teste quiser).
 */
function fakeFetch(opts: {
  releases?: unknown;
  status?: number;
  location?: string | null;
  chamadas?: Chamada[];
}): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const s = String(url);
    opts.chamadas?.push({ url: s, ...(init?.redirect === undefined ? {} : { redirect: init.redirect }) });
    if (s.includes("/releases?")) {
      const status = opts.status ?? 200;
      return new Response(status === 200 ? JSON.stringify(opts.releases ?? []) : "{}", {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    // pedido de asset: a API responde 302 e NÓS não seguimos
    const headers = new Headers();
    if (opts.location != null) headers.set("location", opts.location);
    return new Response(null, { status: 302, headers });
  }) as unknown as typeof fetch;
}

const CDN = "https://release-assets.githubusercontent.com/abc?token=xyz";

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
// O catálogo
// ---------------------------------------------------------------------------

test("catálogo: rascunho e prerelease não são a versão publicada", async () => {
  limparCacheDeReleases();
  const c = await catalogoDeReleases(
    fakeFetch({
      releases: [
        release("v2.0.0", { draft: true }, 9),
        release("v1.9.0", { prerelease: true }, 8),
        release("v1.2.0", {}, 1),
      ],
    }),
    0,
  );
  assert.equal(c.latest?.version, "1.2.0", "o `v` sai — o electron-updater compara semver");
  assert.equal(c.latest?.tag, "v1.2.0");
  assert.equal(instalador(c.latest!)?.name, EXE);
});

test("catálogo: o mapa de nomes cobre releases anteriores, não só o mais novo", async () => {
  limparCacheDeReleases();
  const c = await catalogoDeReleases(fakeFetch({ releases: [release("v1.2.0", {}, 1), release("v1.1.0", {}, 2)] }), 0);
  // entre ler o latest.yml e baixar o .exe passam minutos; um release publicado
  // nesse intervalo faria o arquivo pedido sumir do catálogo — 404 no meio da
  // atualização de alguém
  assert.ok(c.porNome.has("Danjocord-Setup-1.1.0.exe"), "o instalador anterior continua resolvível");
  assert.ok(c.porNome.has(EXE));
});

test("catálogo: repo privado sem token responde 404, e a frase diz isso", async () => {
  limparCacheDeReleases();
  await assert.rejects(
    () => catalogoDeReleases(fakeFetch({ status: 404 }), 0),
    (err: Error) => {
      assert.match(err.message, /privado|permissão/i);
      return true;
    },
  );
});

test("catálogo: o erro é cacheado, senão cada cliente paga 8 s de timeout", async () => {
  limparCacheDeReleases();
  const chamadas: Chamada[] = [];
  const f = fakeFetch({ status: 500, chamadas });
  await assert.rejects(() => catalogoDeReleases(f, 0));
  await assert.rejects(() => catalogoDeReleases(f, 1_000));
  assert.equal(chamadas.length, 1, "a segunda saiu do cache negativo");
});

// ---------------------------------------------------------------------------
// O 302
// ---------------------------------------------------------------------------

test("download: pede sem seguir o redirect — o pod NÃO baixa os 100 MB", async () => {
  const chamadas: Chamada[] = [];
  const url = await urlDeDownload(10, fakeFetch({ location: CDN, chamadas }));
  assert.equal(url, CDN);
  assert.equal(chamadas[0]?.redirect, "manual", "seguir aqui faria o pod carregar o instalador inteiro");
});

test("download: Location fora do GitHub é recusado (redirect aberto)", async () => {
  await assert.rejects(
    () => urlDeDownload(10, fakeFetch({ location: "https://exemplo.invalido/malware.exe" })),
    /host inesperado/,
  );
  // http puro também não: a página que redireciona é https
  await assert.rejects(() => urlDeDownload(10, fakeFetch({ location: "http://github.com/x" })), /host inesperado/);
  await assert.rejects(() => urlDeDownload(10, fakeFetch({ location: null })), /não redirecionou/);
});

// ---------------------------------------------------------------------------
// As rotas
// ---------------------------------------------------------------------------

function montar(fetchImpl: typeof fetch): ReturnType<typeof Fastify> {
  limparCacheDeReleases();
  const store = new Store(openDb(":memory:"));
  const app = Fastify();
  // a ordem do index.ts: o hook do rate limit ANTES das rotas, senão o onRoute
  // não as vê e o limite vira no-op
  registerRateLimit(app, store);
  registerUpdateRoutes(app, store, { fetchImpl });
  return app;
}

const AUTH = { authorization: "Bearer dev.leo" };

test("o feed passa SEM Bearer — a credencial dele é o tíquete", async () => {
  const app = montar(fakeFetch({ releases: [release("v1.2.0", {}, 1)], location: CDN }));

  const t = await app.inject({ method: "POST", url: "/api/updates/ticket", headers: AUTH });
  assert.equal(t.statusCode, 200);
  const { ticket } = t.json() as { ticket: string };

  // ESTE é o teste que importa: nenhum header de autorização, e ainda assim 302.
  // Com a classe trocada para `leitura`, o hook geral responde 401 aqui e o
  // auto-update morre sem um erro que aponte para a causa.
  const res = await app.inject({
    method: "GET",
    url: `/api/updates/feed/latest.yml?ticket=${encodeURIComponent(ticket)}`,
  });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers["location"], CDN);
  await app.close();
});

test("o feed sem tíquete (ou com um inventado) é 401", async () => {
  const app = montar(fakeFetch({ releases: [release("v1.2.0", {}, 1)], location: CDN }));
  const semNada = await app.inject({ method: "GET", url: "/api/updates/feed/latest.yml" });
  assert.equal(semNada.statusCode, 401);
  const inventado = await app.inject({ method: "GET", url: "/api/updates/feed/latest.yml?ticket=abc" });
  assert.equal(inventado.statusCode, 401);
  // e um Bearer válido NÃO substitui o tíquete: quem chama isto é o updater
  const comBearer = await app.inject({ method: "GET", url: "/api/updates/feed/latest.yml", headers: AUTH });
  assert.equal(comBearer.statusCode, 401);
  await app.close();
});

test("o tíquete exige sessão", async () => {
  const app = montar(fakeFetch({ releases: [] }));
  const res = await app.inject({ method: "POST", url: "/api/updates/ticket" });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("o nome do arquivo é o catálogo, e nada mais", async () => {
  const app = montar(fakeFetch({ releases: [release("v1.2.0", {}, 1)], location: CDN }));
  const { ticket } = (
    await app.inject({ method: "POST", url: "/api/updates/ticket", headers: AUTH })
  ).json() as { ticket: string };

  for (const nome of ["nao-existe.exe", "..%2f..%2fetc%2fpasswd", "LATEST.YML"]) {
    const res = await app.inject({ method: "GET", url: `/api/updates/feed/${nome}?ticket=${ticket}` });
    assert.equal(res.statusCode, 404, `${nome} não é asset publicado`);
  }
  await app.close();
});

test("GET /api/updates/latest descreve o que existe para baixar", async () => {
  const app = montar(fakeFetch({ releases: [release("v1.2.0", {}, 1)] }));
  const res = await app.inject({ method: "GET", url: "/api/updates/latest", headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    version: "1.2.0",
    file: EXE,
    size: 120_000_000,
    published_at: Date.parse("2026-01-01T00:00:00Z"),
  });
  await app.close();
});

test("sem release publicado é 404 (o servidor está bem), não 503", async () => {
  const app = montar(fakeFetch({ releases: [] }));
  const res = await app.inject({ method: "GET", url: "/api/updates/latest", headers: AUTH });
  assert.equal(res.statusCode, 404);
  assert.match((res.json() as { error: string }).error, /nenhum release/i);
  await app.close();
});

test("o download do navegador erra VOLTANDO para a página, não com JSON", async () => {
  const app = montar(fakeFetch({ releases: [], location: CDN }));
  // tíquete inválido: quem está aqui é uma NAVEGAÇÃO, e um corpo JSON deixaria
  // a pessoa numa aba branca com `{"error":...}` e sem botão para tentar de novo
  const mau = await app.inject({ method: "GET", url: "/api/updates/download?ticket=nao-existe" });
  assert.equal(mau.statusCode, 302);
  assert.equal(mau.headers["location"], "/download?erro=ticket");

  const { ticket } = (
    await app.inject({ method: "POST", url: "/api/updates/ticket", headers: AUTH })
  ).json() as { ticket: string };
  const semRelease = await app.inject({ method: "GET", url: `/api/updates/download?ticket=${ticket}` });
  assert.equal(semRelease.statusCode, 302);
  assert.equal(semRelease.headers["location"], "/download?erro=sem-release");
  await app.close();
});

test("o download do navegador leva ao instalador", async () => {
  const app = montar(fakeFetch({ releases: [release("v1.2.0", {}, 1)], location: CDN }));
  const { ticket } = (
    await app.inject({ method: "POST", url: "/api/updates/ticket", headers: AUTH })
  ).json() as { ticket: string };
  const res = await app.inject({ method: "GET", url: `/api/updates/download?ticket=${ticket}` });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers["location"], CDN);
  await app.close();
});
