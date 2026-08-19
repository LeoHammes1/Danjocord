import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { blockedAddressReason as defaultBlockedAddressReason, normalizeUrl } from "./guard.js";

/**
 * A busca em si do preview de link (M11b, item 90) — a única coisa no projeto
 * que faz o SERVIDOR abrir conexão para um endereço escolhido por um usuário.
 * A política de quais endereços valem está no `guard.ts` (puro e testado); aqui
 * mora o cuidado de APLICÁ-LA no lugar certo.
 *
 * A decisão estrutural deste arquivo: resolvemos o DNS NÓS MESMOS e conectamos
 * ao IP resolvido, mandando o nome no header `Host` (e no SNI, quando é TLS).
 *
 * Por que não simplesmente `fetch(url)` e uma checagem antes? Porque entre "eu
 * resolvi o nome e vi que é público" e "o socket conectou" existe uma segunda
 * resolução, feita pela biblioteca — e um servidor DNS hostil devolve o IP
 * público na primeira e o 127.0.0.1 na segunda. É o DNS rebinding, e é uma
 * corrida que o atacante ganha quando quer. Conectando ao endereço que já foi
 * aprovado, não existe segunda resolução para envenenar.
 *
 * O resto das defesas, cada uma contra um abuso conhecido:
 *   - 3 redirects no máximo, e CADA salto passa pelas mesmas regras (o clássico
 *     é o primeiro host ser público e mandar um 302 para o metadata da nuvem);
 *   - prazo de 5 s para o CONJUNTO da operação, não por salto — senão três
 *     saltos lentos viram 15 s de socket segurado no pod;
 *   - teto de 512 KB lidos: o `<head>` basta, e baixar o corpo inteiro de um
 *     ISO de 4 GB é DoS de graça;
 *   - só `text/html`: qualquer outro tipo nem começa a ser lido;
 *   - NENHUM header de identidade sai daqui — sem cookie, sem Authorization,
 *     sem `x-forwarded-for`. O servidor busca como um estranho, e o IP de quem
 *     colou o link nunca chega ao site (que é o motivo de o unfurl ser
 *     server-side, item 90).
 */

export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 5_000;
export const MAX_HTML_BYTES = 512 * 1024;

/**
 * Identificação honesta. Um user-agent próprio (em vez de fingir ser um
 * navegador) é o que permite a um site nos bloquear se quiser — e vazar a
 * versão do Node no default do `http` não ajuda ninguém.
 */
const USER_AGENT = "DanjocordLinkPreview/1.0 (+unfurl server-side)";

/**
 * Injeções que existem para o TESTE, e só. A produção (`routes.ts`) chama
 * `fetchHtmlForPreview(url)` sem segundo argumento, e aí valem o DNS de
 * verdade e a política de verdade.
 *
 * O `blockedAddressReason` é injetável porque os testes de redirect, de prazo,
 * de teto de bytes e de content-type precisam de um servidor HTTP alcançável —
 * e todo servidor de teste mora em 127.0.0.1, que a política real (com razão)
 * recusa antes de conectar. Esses testes passam uma política que libera SÓ o
 * loopback; os testes de SSRF usam a real e afirmam que nada é sequer
 * conectado.
 */
export interface FetchDeps {
  resolve?: (hostname: string) => Promise<string[]>;
  blockedAddressReason?: (address: string) => string | null;
  /** SÓ TESTE: ver `NormalizeOptions.allowAnyPort` no guard. */
  allowAnyPort?: boolean;
  /** SÓ TESTE: encurta o prazo para o teste de timeout não durar 5 s. */
  timeoutMs?: number;
}

export interface FetchedHtml {
  /** a URL FINAL (depois dos redirects), normalizada */
  url: string;
  html: string;
}

/**
 * Próximo salto de um redirect: resolve o `Location` (que pode ser relativo)
 * contra a URL atual e passa o resultado pelas MESMAS regras da primeira.
 *
 * Exportada por causa do teste: "o primeiro host é público e redireciona para
 * o interno" é o ataque que mais funciona no mundo real, e ele se resume a
 * esta função.
 */
export function nextHop(location: string, current: URL, deps: FetchDeps = {}): URL {
  let candidate: URL;
  try {
    candidate = new URL(location, current);
  } catch {
    throw new Error("redirecionamento para URL inválida");
  }
  // normalizeUrl é a MESMA que validou a URL original: esquema, porta,
  // credencial embutida. `file://` num Location morre aqui.
  return normalizeUrl(candidate.toString(), deps.allowAnyPort === true ? { allowAnyPort: true } : {});
}

/**
 * Busca o HTML de uma URL colada por um usuário, com todas as defesas acima.
 * Lança Error com frase curta em pt-BR — a frase vira o `error` da resposta E
 * do cache negativo (uma URL que falhou não pode ser retentada a cada render).
 */
export async function fetchHtmlForPreview(raw: string, deps: FetchDeps = {}): Promise<FetchedHtml> {
  let url = normalizeUrl(raw, deps.allowAnyPort === true ? { allowAnyPort: true } : {});
  // prazo do CONJUNTO: os saltos dividem os mesmos 5 s
  const deadline = Date.now() + (deps.timeoutMs ?? FETCH_TIMEOUT_MS);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const result = await requestOnce(url, deadline, deps);
    if (result.kind === "html") return { url: url.toString(), html: result.html };
    // aqui está a regra 4 da política: revalidar A CADA salto
    url = nextHop(result.location, url, deps);
  }
  throw new Error(`redirecionamentos demais (limite de ${MAX_REDIRECTS})`);
}

type OnceResult = { kind: "html"; html: string } | { kind: "redirect"; location: string };

/**
 * Resolve o nome e devolve os endereços. `dns.lookup` (e não `resolve4`)
 * porque é ele que respeita `/etc/hosts` e a ordem do sistema — que é o que a
 * biblioteca HTTP usaria; queremos ver exatamente o que ela veria.
 */
async function resolveHost(hostname: string, deps: FetchDeps): Promise<string[]> {
  if (deps.resolve) return deps.resolve(hostname);
  // host que já é um IP literal não passa por DNS nenhum — `dns.lookup` até
  // devolveria o próprio endereço, mas dizer isso explicitamente deixa claro
  // que o caminho do literal também é checado
  if (isIP(hostname) !== 0) return [hostname];
  const found = await dnsLookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
}

function requestOnce(url: URL, deadline: number, deps: FetchDeps): Promise<OnceResult> {
  const blocked = deps.blockedAddressReason ?? defaultBlockedAddressReason;

  return (async () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("tempo esgotado ao buscar o link");

    let addresses: string[];
    try {
      addresses = await resolveHost(url.hostname, deps);
    } catch {
      throw new Error("não consegui resolver o endereço do site");
    }
    if (addresses.length === 0) throw new Error("não consegui resolver o endereço do site");

    // TODOS os endereços são checados e o primeiro liberado é o escolhido. Se
    // nenhum passa, o motivo do PRIMEIRO é o que a pessoa vê — um host com
    // A e AAAA privados dá a mesma resposta por qualquer um deles.
    let firstReason: string | null = null;
    let target: string | null = null;
    for (const address of addresses) {
      const reason = blocked(address);
      if (reason === null) {
        target = address;
        break;
      }
      firstReason ??= reason;
    }
    if (target === null) {
      throw new Error(`endereço interno recusado: ${firstReason ?? "endereço bloqueado"}`);
    }

    return await new Promise<OnceResult>((resolve, reject) => {
      const secure = url.protocol === "https:";
      const transport = secure ? https : http;
      const request = transport.request({
        // conectamos ao ENDEREÇO já aprovado; o nome vai no Host e no SNI
        host: target,
        family: isIP(target),
        port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        // `agent: false` = um agente descartável por requisição: nada de socket
        // reaproveitado entre hosts diferentes, nada de keep-alive segurando
        // conexão para um site que a gente nunca mais vai visitar
        agent: false,
        // SNI e validação do certificado pelo NOME, não pelo IP — sem isto,
        // todo https daria erro de certificado
        ...(secure ? { servername: url.hostname, rejectUnauthorized: true } : {}),
        headers: {
          // o Host é o que faz o servidor de destino saber qual site servir
          host: url.host,
          accept: "text/html",
          "accept-language": "pt-BR,pt;q=0.9,en;q=0.7",
          "user-agent": USER_AGENT,
          // e mais NADA. Sem cookie, sem authorization, sem x-forwarded-for:
          // o servidor busca como um estranho e o IP de quem colou o link não
          // viaja (é o motivo de o unfurl ser server-side).
        },
      });

      // prazo do CONJUNTO, medido aqui de novo porque o DNS já consumiu parte
      const timer = setTimeout(
        () => request.destroy(new Error("tempo esgotado ao buscar o link")),
        Math.max(1, deadline - Date.now()),
      );
      const fail = (err: Error): void => {
        clearTimeout(timer);
        reject(err);
      };

      request.on("error", (err: Error) => fail(new Error(err.message || "falha ao conectar no site")));

      request.on("response", (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400) {
          // o corpo do redirect não interessa: fecha o socket na hora
          response.destroy();
          clearTimeout(timer);
          if (typeof location !== "string" || location === "") {
            reject(new Error(`o site respondeu ${status} sem destino`));
            return;
          }
          resolve({ kind: "redirect", location });
          return;
        }
        if (status < 200 || status >= 300) {
          response.destroy();
          fail(new Error(`o site respondeu ${status}`));
          return;
        }

        const contentType = String(response.headers["content-type"] ?? "");
        // só HTML. PDF, imagem, JSON, octet-stream: nem começam a ser lidos —
        // e é isso que impede o preview de virar um proxy de download.
        if (!/^text\/html\b/i.test(contentType)) {
          response.destroy();
          fail(new Error("o link não é uma página HTML"));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          total += chunk.length;
          // teto de bytes: o `<head>` cabe de sobra nos primeiros 512 KB, e o
          // que já veio basta. Truncar NÃO é erro — é o caso normal.
          if (total >= MAX_HTML_BYTES) response.destroy();
        });
        // `end` e `close` disparam os dois no caminho feliz, e só `close`
        // quando o teto de bytes cortou o stream — a trava garante uma
        // resolução só (a segunda seria ignorada, mas o `clearTimeout` duplo
        // esconde bug de verdade no dia em que este trecho mudar)
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ kind: "html", html: decodeHtml(Buffer.concat(chunks).subarray(0, MAX_HTML_BYTES), contentType) });
        };
        response.on("end", finish);
        // `close` cobre o caso do destroy() acima: já temos bytes suficientes
        response.on("close", finish);
        response.on("error", () => finish());
      });

      request.end();
    });
  })();
}

/**
 * Bytes → texto. O charset sai do `Content-Type`; a `<meta charset>` do
 * documento é ignorada de propósito (lê-la exigiria decodificar antes de saber
 * como decodificar, e o ganho seria em sites de 2003).
 *
 * `latin1` cobre iso-8859-1 e windows-1252, que é o que ainda aparece em site
 * brasileiro antigo. Qualquer outro rótulo cai em utf-8, que é o certo em
 * 99% dos casos e, no pior deles, produz um título com acento estranho — nunca
 * um erro.
 */
function decodeHtml(buffer: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)?.[1]?.toLowerCase();
  if (charset === "iso-8859-1" || charset === "latin1" || charset === "windows-1252") {
    return buffer.toString("latin1");
  }
  return buffer.toString("utf8");
}
