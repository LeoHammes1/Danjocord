/**
 * Testes da rota de preview de link (M11b, item 90) e do extrator de
 * metadados. A parte de SSRF — que é a que importa de verdade — mora em
 * `ssrf.test.ts`, como suíte de primeira classe; aqui ficam o CACHE (que
 * também é defesa: sem ele cada render vira uma ida à internet), o rate limit e
 * o que se extrai do HTML.
 *
 * A rota recebe as injeções de teste (`allowAnyPort` + política que libera o
 * loopback) porque todo servidor de teste mora em 127.0.0.1 numa porta alta, e
 * a política real recusa os dois — ver os comentários "SÓ TESTE" em
 * `links/fetch.ts` e `links/guard.ts`. A produção registra a rota sem nada.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { register } from "tsx/esm/api";
import type { LinkPreview } from "@danjocord/protocol";

register();

process.env.DANJOCORD_DEV_AUTH = "1";

const { default: Fastify } = await import("fastify");
const { openDb } = await import("../src/db/index.js");
const { Store } = await import("../src/store.js");
const { registerLinkRoutes, PREVIEW_LIMIT } = await import("../src/links/routes.js");
const { blockedAddressReason } = await import("../src/links/guard.js");
const { extractMeta } = await import("../src/links/html.js");

const db = openDb(":memory:");
const store = new Store(db);
const app = Fastify();
registerLinkRoutes(app, store, {
  fetchDeps: {
    allowAnyPort: true,
    blockedAddressReason: (ip) => (ip === "127.0.0.1" ? null : blockedAddressReason(ip)),
  },
});

function auth(username: string): Record<string, string> {
  return { authorization: `Bearer dev.${username}` };
}

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

async function serve(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<{ base: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, hits: () => hits };
}

async function preview(username: string, url: string): Promise<LinkPreview> {
  const res = await app.inject({
    method: "GET",
    url: `/api/link-preview?url=${encodeURIComponent(url)}`,
    headers: auth(username),
  });
  assert.equal(res.statusCode, 200, `preview deveria dar 200, deu ${res.statusCode} (${res.body})`);
  return res.json() as LinkPreview;
}

// ---------------------------------------------------------------------------
// O extrator de metadados (puro)
// ---------------------------------------------------------------------------

test("extrator: Open Graph vence o <title> (é o que o autor escolheu mostrar)", () => {
  const meta = extractMeta(`
    <html><head>
      <title>Site — Seção — Página</title>
      <meta property="og:title" content="Página">
      <meta property="og:description" content="Uma descrição curta.">
      <meta property="og:site_name" content="Site">
    </head></html>`);
  assert.equal(meta.title, "Página");
  assert.equal(meta.description, "Uma descrição curta.");
  assert.equal(meta.siteName, "Site");
});

test("extrator: sem Open Graph, cai no <title> e no meta description", () => {
  const meta = extractMeta('<head><title>Só o título</title><meta name="description" content="desc"></head>');
  assert.equal(meta.title, "Só o título");
  assert.equal(meta.description, "desc");
});

test("extrator: entidades HTML são decodificadas", () => {
  const meta = extractMeta("<head><title>Ma&ccedil;&atilde;s &amp; peras &#8212; 10&#37;</title></head>");
  // &ccedil; e &atilde; não estão na tabela curta (e tudo bem: sobrevivem como
  // texto); o que precisa funcionar são as comuns e as numéricas
  assert.match(meta.title ?? "", /&/);
  assert.match(meta.title ?? "", /—/);
  assert.match(meta.title ?? "", /%/);
});

test("extrator: quebra de linha vira espaço e controle/invisível some", () => {
  // o U+202E (RIGHT-TO-LEFT OVERRIDE) escreveria o resto do titulo ao contrario
  // na tela de todo mundo: ele SOME (nao separa palavra), enquanto o \n vira
  // espaco (separa). Os dois entram por escape para nao virarem byte invisivel
  // no arquivo — que e o mesmo cuidado do SoundName no protocolo.
  const bruto = 'linha um\nlinha dois\u202Edir';
  const meta = extractMeta(`<head><meta property="og:title" content="${bruto}">`);
  assert.equal(meta.title, "linha um linha doisdir");
});

test("extrator: título longo demais é aparado", () => {
  const meta = extractMeta(`<head><title>${"a".repeat(1000)}</title></head>`);
  assert.ok((meta.title ?? "").length <= 200);
});

test("extrator: página sem nada devolve tudo null (e a rota não vira card vazio)", () => {
  assert.deepEqual(extractMeta("<html><body>oi</body></html>"), {
    title: null,
    description: null,
    siteName: null,
  });
});

test("extrator: <title> depois do </head> é ignorado (SVG embutido no corpo)", () => {
  const meta = extractMeta("<head><title>certo</title></head><body><svg><title>errado</title></svg></body>");
  assert.equal(meta.title, "certo");
});

// ---------------------------------------------------------------------------
// A rota
// ---------------------------------------------------------------------------

test("preview de uma página normal devolve título, descrição e site", async () => {
  const { base } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      '<html><head><title>t</title><meta property="og:title" content="Receita de pão">' +
        '<meta property="og:description" content="Com fermento natural."></head></html>',
    );
  });

  const result = await preview("ana", base);
  assert.equal(result.ok, true);
  assert.equal(result.title, "Receita de pão");
  assert.equal(result.description, "Com fermento natural.");
  // sem og:site_name, o host é a melhor aproximação
  assert.equal(result.site_name, "127.0.0.1");
  assert.equal(result.error, null);
});

test("a segunda consulta vem do CACHE (o site não é tocado de novo)", async () => {
  const { base, hits } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<head><title>cacheado</title></head>");
  });

  const primeira = await preview("bruno", base);
  const segunda = await preview("carla", `${base}/`); // a mesma URL normalizada
  assert.equal(primeira.title, "cacheado");
  assert.equal(segunda.title, "cacheado");
  assert.equal(hits(), 1, "sem cache, cada render de cada cliente viraria uma ida à internet");
});

test("o cache é NEGATIVO também: URL que falhou não é retentada", async () => {
  const { base, hits } = await serve((_req, res) => {
    res.writeHead(500, { "content-type": "text/html" });
    res.end("erro");
  });

  const primeira = await preview("dora", base);
  assert.equal(primeira.ok, false);
  assert.match(primeira.error ?? "", /respondeu 500/);

  const segunda = await preview("elias", base);
  assert.equal(segunda.ok, false);
  assert.equal(hits(), 1, "o fracasso também precisa ser lembrado");
});

test("página sem título nenhum não vira card vazio", async () => {
  const { base } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>sem cabeçalho</body></html>");
  });
  const result = await preview("fabio", base);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /não tem título/);
});

test("esquema proibido responde ok:false com o motivo (e não 4xx)", async () => {
  const result = await preview("gabi", "file:///etc/passwd");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /não é suportado/);
});

test("endereço interno responde ok:false — e o motivo diz qual faixa", async () => {
  // com a política de teste, só 127.0.0.1 é liberado: o metadata continua fora
  const result = await preview("heitor", "http://169.254.169.254/latest/meta-data/");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /link-local|interno/);
});

test("rate limit por usuário: a partir do teto, 429", async () => {
  const { base } = await serve((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<head><title>${req.url}</title></head>`);
  });

  // URLs diferentes de propósito: o cache serviria as repetidas sem gastar cota
  for (let i = 0; i < PREVIEW_LIMIT; i += 1) {
    const res = await app.inject({
      method: "GET",
      url: `/api/link-preview?url=${encodeURIComponent(`${base}/p${i}`)}`,
      headers: auth("limitado"),
    });
    assert.equal(res.statusCode, 200, `a ${i + 1}ª deveria passar`);
  }
  const bloqueado = await app.inject({
    method: "GET",
    url: `/api/link-preview?url=${encodeURIComponent(`${base}/depois`)}`,
    headers: auth("limitado"),
  });
  assert.equal(bloqueado.statusCode, 429);
  assert.ok(Number(bloqueado.headers["retry-after"]) >= 1);
});

test("sem autenticação é 401; url ausente é 400", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/link-preview?url=http://x.com" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/link-preview", headers: auth("ivo") })).statusCode, 400);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `/api/link-preview?url=${"x".repeat(3000)}`,
        headers: auth("ivo"),
      })
    ).statusCode,
    400,
  );
});
