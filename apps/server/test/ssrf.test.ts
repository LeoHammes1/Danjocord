/**
 * Testes de SSRF do preview de link (M11b, item 90).
 *
 * São testes de PRIMEIRA CLASSE, e não um apêndice dos testes da rota: esta é a
 * única parte do marco que, feita errado, é furo de segurança de verdade. Um
 * servidor que busca URLs coladas por usuários e não filtra o destino entrega o
 * metadata da nuvem, os serviços internos do cluster e ele mesmo.
 *
 * O arquivo cobre quatro camadas, de dentro para fora:
 *   1. a POLÍTICA pura (`blockedAddressReason`): cada faixa bloqueada, uma a
 *      uma, e as formas em que um IPv6 carrega um IPv4 dentro;
 *   2. a NORMALIZAÇÃO (`normalizeUrl`): esquema, porta, credencial embutida;
 *   3. o REDIRECT (`nextHop`): o clássico "host público que manda um 302 para o
 *      metadata";
 *   4. o caminho INTEIRO, com socket de verdade — inclusive o teste que importa
 *      mais que todos: com a política REAL, um servidor rodando em 127.0.0.1
 *      não recebe UMA requisição sequer.
 *
 * A política e a porta são injetáveis (ver os comentários "SÓ TESTE" em
 * `links/fetch.ts` e `links/guard.ts`): sem isso, os testes de redirect, prazo,
 * teto de bytes e content-type não teriam servidor alcançável — todo servidor
 * de teste mora em 127.0.0.1, que a política real recusa antes de conectar.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { register } from "tsx/esm/api";

register();

const { blockedAddressReason, normalizeUrl } = await import("../src/links/guard.js");
const { fetchHtmlForPreview, nextHop, MAX_HTML_BYTES } = await import("../src/links/fetch.js");

// ---------------------------------------------------------------------------
// 1. A política pura: cada faixa fechada, uma a uma
// ---------------------------------------------------------------------------

test("SSRF: toda faixa IPv4 interna é recusada", () => {
  const blocked = [
    ["0.0.0.0", "este host"],
    ["0.1.2.3", "este host"],
    ["10.0.0.1", "privada 10/8"],
    ["10.255.255.255", "privada 10/8"],
    ["100.64.0.1", "CGNAT"],
    ["100.127.255.255", "CGNAT"],
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback (a faixa INTEIRA, não só o .0.0.1)"],
    ["169.254.169.254", "metadata de nuvem"],
    ["169.254.0.1", "link-local"],
    ["172.16.0.1", "privada 172.16/12"],
    ["172.31.255.255", "privada 172.16/12 (borda de cima)"],
    ["192.168.0.1", "privada 192.168/16"],
    ["192.0.0.1", "reservada 192.0.0/24"],
    ["198.18.0.1", "benchmark 198.18/15"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.255", "multicast (borda)"],
    ["240.0.0.1", "reservada 240/4"],
    ["255.255.255.255", "broadcast"],
  ] as const;
  for (const [ip, porque] of blocked) {
    assert.notEqual(blockedAddressReason(ip), null, `${ip} (${porque}) deveria ser recusado`);
  }
});

test("SSRF: endereço público de verdade passa (a política não pode barrar tudo)", () => {
  // sem estes, um bug que devolvesse "bloqueado" para tudo passaria despercebido
  for (const ip of ["8.8.8.8", "1.1.1.1", "72.61.44.156", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.20.0.1"]) {
    assert.equal(blockedAddressReason(ip), null, `${ip} é público e deveria passar`);
  }
});

test("SSRF: IPv6 interno é recusado, inclusive quando carrega um IPv4 dentro", () => {
  const blocked = [
    ["::1", "loopback"],
    ["::", "não especificado"],
    ["fc00::1", "ULA fc00::/7"],
    ["fd12:3456::1", "ULA (metade de cima do /7)"],
    ["fe80::1", "link-local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentação"],
    // as três formas de esconder um IPv4 dentro de um IPv6:
    ["::ffff:127.0.0.1", "IPv4-mapeado com notação decimal"],
    ["::ffff:7f00:1", "IPv4-mapeado com notação hexadecimal"],
    ["::ffff:169.254.169.254", "metadata de nuvem mapeado"],
    ["64:ff9b::169.254.169.254", "NAT64 para o metadata"],
    ["2002:7f00:0001::", "6to4 para 127.0.0.1"],
  ] as const;
  for (const [ip, porque] of blocked) {
    assert.notEqual(blockedAddressReason(ip), null, `${ip} (${porque}) deveria ser recusado`);
  }
  // e um IPv6 público de verdade continua passando
  assert.equal(blockedAddressReason("2606:4700:4700::1111"), null);
  assert.equal(blockedAddressReason("::ffff:8.8.8.8"), null);
});

test("SSRF: o que não é IP não passa por engano", () => {
  for (const nao of ["", "localhost", "127.0.0.1.evil.com", "999.1.1.1", "0x7f.0.0.1", "127.0.0.01 "]) {
    assert.notEqual(blockedAddressReason(nao), null, `"${nao}" não é IP e não pode ser liberado`);
  }
});

// ---------------------------------------------------------------------------
// 2. A normalização: esquema, porta, credencial
// ---------------------------------------------------------------------------

test("SSRF: só http e https — file://, javascript:, ftp:, data: são recusados", () => {
  for (const url of [
    "file:///etc/passwd",
    "file://C:/Windows/win.ini",
    "javascript:alert(1)",
    "ftp://ftp.exemplo.com/",
    "data:text/html,<script>",
    "gopher://exemplo.com:70/",
  ]) {
    assert.throws(() => normalizeUrl(url), /não é suportado|inválida/, `${url} deveria ser recusada`);
  }
});

test("SSRF: porta não padrão é recusada (o preview não é um scanner por procuração)", () => {
  assert.throws(() => normalizeUrl("http://exemplo.com:6379/"), /porta não padrão/);
  assert.throws(() => normalizeUrl("http://exemplo.com:22/"), /porta não padrão/);
  // a porta padrão explícita continua valendo
  assert.equal(normalizeUrl("http://exemplo.com:80/a").toString(), "http://exemplo.com/a");
  assert.equal(normalizeUrl("https://exemplo.com:443/a").toString(), "https://exemplo.com/a");
});

test("SSRF: credencial embutida na URL é recusada (disfarça o host real)", () => {
  // o clássico: parece google.com, vai para 10.0.0.1
  assert.throws(() => normalizeUrl("http://google.com@10.0.0.1/"), /usuário e senha/);
  assert.throws(() => normalizeUrl("https://user:pass@exemplo.com/"), /usuário e senha/);
});

test("normalizeUrl canoniza para virar chave de cache (caixa e fragmento)", () => {
  assert.equal(normalizeUrl("HTTP://Exemplo.COM/Caminho?a=1#topo").toString(), "http://exemplo.com/Caminho?a=1");
  // o caminho NÃO é minusculizado: em servidor Unix "/A" e "/a" são páginas diferentes
  assert.notEqual(normalizeUrl("http://x.com/A").toString(), normalizeUrl("http://x.com/a").toString());
});

// ---------------------------------------------------------------------------
// 3. O redirect: o ataque que mais funciona no mundo real
// ---------------------------------------------------------------------------

test("SSRF: redirect para host interno é recusado no salto (relativo e absoluto)", () => {
  const publico = new URL("https://exemplo.com/pagina");
  // O `nextHop` é a metade do salto que valida ESQUEMA, PORTA e credencial; o
  // ENDEREÇO é checado no fetch, com o socket na mão (teste adiante). O que se
  // fixa aqui é que o salto volta a passar por `normalizeUrl` — sem isso, um
  // Location `file://` entraria sem ser olhado.
  assert.equal(nextHop("http://169.254.169.254/latest/meta-data/", publico).hostname, "169.254.169.254");
  // esquema proibido num Location morre aqui
  assert.throws(() => nextHop("file:///etc/passwd", publico), /não é suportado/);
  assert.throws(() => nextHop("http://interno:6379/", publico), /porta não padrão/);
  // Location relativo resolve contra a URL atual (comportamento correto de HTTP)
  assert.equal(nextHop("/outra", publico).toString(), "https://exemplo.com/outra");
});

// ---------------------------------------------------------------------------
// 4. O caminho inteiro, com socket de verdade
// ---------------------------------------------------------------------------

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

/** Sobe um servidor HTTP em 127.0.0.1 e devolve a base e um contador de acessos. */
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

/**
 * Política de TESTE: libera SÓ o loopback e mantém o resto da política real.
 * É o que permite ter um servidor alcançável sem afrouxar nada mais.
 */
const { blockedAddressReason: real } = await import("../src/links/guard.js");
const loopbackOk = (ip: string): string | null => (ip === "127.0.0.1" ? null : real(ip));
const testDeps = { blockedAddressReason: loopbackOk, allowAnyPort: true };

test("SSRF (o teste que mais importa): com a política REAL, o loopback não recebe UMA requisição", async () => {
  const { base, hits } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>não deveria chegar aqui</title>");
  });

  // `allowAnyPort` para chegar até a checagem de endereço (senão a porta alta
  // barraria antes e o teste provaria a coisa errada)
  await assert.rejects(
    fetchHtmlForPreview(base, { allowAnyPort: true }),
    /endereço interno recusado/,
    "loopback tem que ser recusado",
  );
  // a prova: o servidor não foi tocado. Recusar DEPOIS de conectar já teria
  // sido um scan bem-sucedido.
  assert.equal(hits(), 0, "o servidor local não pode ter recebido requisição nenhuma");
});

test("SSRF: DNS rebinding — nome que resolve para 127.0.0.1 é recusado pelo ENDEREÇO", async () => {
  const { base, hits } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>interno</title>");
  });
  const port = new URL(base).port;

  await assert.rejects(
    fetchHtmlForPreview(`http://site-inocente.example:${port}/`, {
      // um DNS hostil devolvendo o loopback para um nome de aparência pública
      resolve: async () => ["127.0.0.1"],
      allowAnyPort: true,
    }),
    /endereço interno recusado/,
  );
  assert.equal(hits(), 0, "nem com nome bonito o servidor interno pode ser tocado");
});

test("SSRF: host público que redireciona para o metadata da nuvem é barrado no salto", async () => {
  const { base } = await serve((req, res) => {
    if (req.url === "/armadilha") {
      // o clássico: a primeira URL é aceitável, o 302 é que ataca
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>ok</title>");
  });

  await assert.rejects(
    fetchHtmlForPreview(`${base}/armadilha`, testDeps),
    /endereço interno recusado/,
    "o segundo salto tem que passar pela mesma política do primeiro",
  );
});

test("preview: no máximo 3 redirects", async () => {
  const { base } = await serve((req, res) => {
    const n = Number(req.url?.slice(1) ?? "0");
    // uma corrente infinita: sem teto, o servidor ficaria pulando para sempre
    res.writeHead(302, { location: `/${n + 1}` });
    res.end();
  });

  await assert.rejects(fetchHtmlForPreview(`${base}/0`, testDeps), /redirecionamentos demais/);
});

test("preview: 3 redirects ainda chegam ao destino", async () => {
  const { base } = await serve((req, res) => {
    const n = Number(req.url?.slice(1) ?? "0");
    if (n < 3) {
      res.writeHead(302, { location: `/${n + 1}` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><head><title>chegou</title></head></html>");
  });

  const result = await fetchHtmlForPreview(`${base}/0`, testDeps);
  assert.match(result.html, /chegou/);
});

test("preview: só text/html — qualquer outro Content-Type nem começa a ser lido", async () => {
  for (const type of ["application/pdf", "image/png", "application/json", "text/plain", "application/octet-stream"]) {
    const { base } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": type });
      res.end("conteúdo que não deveria virar preview");
    });
    await assert.rejects(fetchHtmlForPreview(base, testDeps), /não é uma página HTML/, `${type} deveria ser recusado`);
  }
});

test("preview: prazo estourado vira erro (e não um socket segurado para sempre)", async () => {
  const { base } = await serve(() => {
    // nunca responde: é o "servidor lento" que trava um cliente sem timeout
  });

  await assert.rejects(
    fetchHtmlForPreview(base, { ...testDeps, timeoutMs: 150 }),
    /tempo esgotado/,
  );
});

test("preview: o corpo é cortado no teto de bytes (o <head> basta)", async () => {
  const { base } = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.write("<html><head><title>título no começo</title></head><body>");
    // 4 MB de lixo depois do head: sem teto, o servidor baixaria tudo
    res.write("x".repeat(4 * 1024 * 1024));
    res.end("</body></html>");
  });

  const result = await fetchHtmlForPreview(base, testDeps);
  assert.match(result.html, /título no começo/, "o head tem que ter chegado");
  assert.ok(
    result.html.length <= MAX_HTML_BYTES,
    `baixou ${result.html.length} bytes; o teto é ${MAX_HTML_BYTES}`,
  );
});

test("preview: resposta de erro do site vira erro, não preview vazio", async () => {
  const { base } = await serve((_req, res) => {
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<title>não achei</title>");
  });
  await assert.rejects(fetchHtmlForPreview(base, testDeps), /respondeu 404/);
});

test("preview: NENHUM header de identidade é enviado ao site", async () => {
  let seen: Record<string, string | string[] | undefined> = {};
  const { base } = await serve((req, res) => {
    seen = req.headers;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>ok</title>");
  });

  await fetchHtmlForPreview(base, testDeps);
  // o unfurl é server-side justamente para o IP de quem colou não vazar; se
  // mandássemos x-forwarded-for, teríamos vazado do mesmo jeito
  assert.equal(seen.cookie, undefined);
  assert.equal(seen.authorization, undefined);
  assert.equal(seen["x-forwarded-for"], undefined);
  assert.equal(seen["x-real-ip"], undefined);
  assert.match(String(seen["user-agent"]), /Danjocord/);
});
