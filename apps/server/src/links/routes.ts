import type { FastifyInstance, FastifyReply } from "fastify";
import type { LinkPreview } from "@danjocord/protocol";
import { authFromHeader } from "../auth.js";
import { SlidingWindow } from "../limits.js";
import type { Store } from "../store.js";
import { fetchHtmlForPreview, type FetchDeps } from "./fetch.js";
import { normalizeUrl } from "./guard.js";
import { extractMeta } from "./html.js";

/**
 * REST do preview de link (M11b, item 90) — a rota mais perigosa do projeto,
 * porque é a única que faz o SERVIDOR buscar um endereço escolhido por um
 * usuário. A defesa contra SSRF mora em `guard.ts` (política pura) e `fetch.ts`
 * (aplicação da política a cada salto); aqui ficam as três coisas que sobram:
 * quem pode pedir, com que frequência, e o que se guarda entre um pedido e o
 * próximo.
 *
 * Por que o preview é server-side (e não o cliente buscando a página): se cada
 * cliente buscasse, o IP de cada amigo iria para todo site que alguém colasse
 * no chat. O unfurl existe justamente para que o único IP que aparece lá seja o
 * do servidor.
 *
 * O CACHE é parte da segurança, e não uma otimização:
 *   - sem ele, cada render de cada cliente vira uma ida à internet — dez amigos
 *     rolando o histórico viram uma enxurrada de requisições saindo do pod;
 *   - o cache NEGATIVO é o que impede uma URL quebrada (ou um host interno
 *     recusado) de ser retentada para sempre a cada scroll.
 */

/**
 * TTLs. O positivo é longo porque título de página quase não muda; o negativo é
 * curto porque a falha costuma ser temporária (site fora do ar) e ninguém quer
 * esperar seis horas para um link voltar a ter preview.
 */
export const POSITIVE_TTL_MS = 6 * 60 * 60_000;
export const NEGATIVE_TTL_MS = 30 * 60_000;

/**
 * Rate limit POR USUÁRIO. Não é sobre banda: é sobre o servidor não virar um
 * scanner por procuração. Mesmo com todas as faixas internas fechadas, 30
 * buscas por minuto é o teto do que uma pessoa lendo o chat precisa — o resto
 * é laço.
 *
 * A janela conta a TENTATIVA (mesma regra do M9): um pedido recusado pelo
 * guard também custou uma resolução de DNS.
 */
export const PREVIEW_LIMIT = 30;
export const PREVIEW_WINDOW_MS = 60_000;

/** Só para os testes: injeta DNS e política. A produção nunca passa nada. */
export interface LinkRoutesDeps {
  fetchDeps?: FetchDeps;
}

export function registerLinkRoutes(app: FastifyInstance, store: Store, deps: LinkRoutesDeps = {}): void {
  const window = new SlidingWindow(PREVIEW_LIMIT, PREVIEW_WINDOW_MS);

  /**
   * `GET /api/link-preview?url=`
   *
   * Responde 200 mesmo quando não deu para pré-visualizar: `ok: false` com o
   * motivo. "Não deu" é o caso COMUM (PDF, site fora do ar, host interno) e o
   * cliente trata todos igual — mostra o link cru. Transformar isso em 4xx
   * faria o cliente distinguir erros que, para ele, são o mesmo estado.
   */
  app.get("/api/link-preview", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });

    const raw = (req.query as { url?: string }).url;
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
      return reply.code(400).send({ error: "parâmetro url ausente ou grande demais" });
    }

    // a normalização é a PRIMEIRA validação (esquema, porta, credencial
    // embutida) e também o que produz a chave do cache — as duas coisas têm que
    // ser a mesma função, senão dá para envenenar o cache com uma variação da
    // URL que passa por um caminho e é buscada por outro
    let url: URL;
    try {
      // as opções vêm das MESMAS deps do fetch para que a normalização da rota
      // e a do fetch nunca divirjam (em produção as duas são as estritas)
      url = normalizeUrl(raw, deps.fetchDeps?.allowAnyPort === true ? { allowAnyPort: true } : {});
    } catch (err) {
      // recusa de esquema/porta NÃO entra no cache: ela é instantânea e não
      // custou nada ao servidor, então guardá-la só ocuparia linha
      return reply.send(failed(raw, err));
    }
    const key = url.toString();

    const cached = store.getLinkPreview(key);
    if (cached !== null) return reply.send(cached);

    const wait = window.retryAfterMs(user.id);
    if (wait > 0) return tooManyRequests(reply, wait);
    window.record(user.id);

    try {
      const fetched = await fetchHtmlForPreview(key, deps.fetchDeps ?? {});
      const meta = extractMeta(fetched.html);
      // página sem título nenhum não vira card: um preview vazio é pior que
      // nenhum preview (ocupa espaço e não informa nada)
      if (meta.title === null && meta.description === null) {
        return reply.send(
          store.saveLinkPreview(
            { url: key, ok: false, title: null, description: null, site_name: null, error: "a página não tem título" },
            NEGATIVE_TTL_MS,
          ),
        );
      }
      return reply.send(
        store.saveLinkPreview(
          {
            url: key,
            ok: true,
            title: meta.title,
            description: meta.description,
            // sem `og:site_name`, o host é a melhor aproximação — e é o que o
            // usuário precisa para saber de onde veio aquele card
            site_name: meta.siteName ?? url.hostname,
            error: null,
          },
          POSITIVE_TTL_MS,
        ),
      );
    } catch (err) {
      // cache NEGATIVO: guardar o fracasso é o que impede a retentativa a cada
      // render. O motivo vai junto porque um cache negativo sem motivo é
      // impossível de depurar meses depois.
      const preview = failed(key, err);
      return reply.send(
        store.saveLinkPreview(
          {
            url: preview.url,
            ok: false,
            title: null,
            description: null,
            site_name: null,
            error: preview.error,
          },
          NEGATIVE_TTL_MS,
        ),
      );
    }
  });
}

/** Resposta de fracasso que NÃO passou pelo cache (recusa instantânea). */
function failed(url: string, err: unknown): LinkPreview {
  return {
    url,
    ok: false,
    title: null,
    description: null,
    site_name: null,
    error: err instanceof Error ? err.message : "não consegui buscar o link",
    fetched_at: Date.now(),
  };
}

function tooManyRequests(reply: FastifyReply, waitMs: number): FastifyReply {
  const seconds = waitMs / 1000;
  reply.header("retry-after", String(Math.max(1, Math.ceil(seconds))));
  return reply.code(429).send({ error: "muitas buscas de preview seguidas", retry_after: Number(seconds.toFixed(3)) });
}
