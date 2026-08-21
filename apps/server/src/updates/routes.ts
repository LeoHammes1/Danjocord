import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authFromHeader } from "../auth.js";
import { config } from "../config.js";
import { SlidingWindow, tooManyRequests } from "../limits.js";
import type { Store } from "../store.js";
import {
  type Buscador,
  GithubReleasesError,
  catalogoDeReleases,
  instalador,
  urlDeDownload,
} from "./github.js";
import { TicketStore } from "./tickets.js";

/**
 * REST da distribuição do app desktop (M14): a página de download e o feed que
 * o `electron-updater` consome.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ISTO É AUTENTICADO
 * ---------------------------------------------------------------------------
 *
 * O instalador leva 12 sons proprietários do Discord dentro (ATTRIBUTIONS.md).
 * A condição que o Leonardo escreveu para usá-los é "repo privado, sem
 * instalador para fora, instância fechada" — e um `.exe` num link público seria
 * exatamente o "para fora". Então a porta existe, mas só abre para quem já é
 * membro: o feed e o download exigem tíquete, e tíquete só sai para quem tem
 * sessão.
 *
 * Isso não custa nada a ninguém: para USAR o app é preciso estar na allowlist
 * de qualquer jeito. Quem legitimamente quer o instalador consegue entrar na
 * web e clicar; quem não consegue entrar também não teria o que fazer com ele.
 *
 * ---------------------------------------------------------------------------
 * AS QUATRO ROTAS
 * ---------------------------------------------------------------------------
 *
 *   POST /api/updates/ticket        Bearer  → tíquete opaco (30 min)
 *   GET  /api/updates/latest        Bearer  → o que existe para baixar
 *   GET  /api/updates/download      tíquete → 302 para o `.exe` (o navegador)
 *   GET  /api/updates/feed/:file    tíquete → 302 para o asset (o updater)
 *
 * As duas primeiras entram na classe `leitura` do rate limit geral. As duas
 * últimas são `proprio`: elas NÃO trazem Bearer (a credencial está na query), e
 * o hook geral responde 401 a tudo que não traz — então o freio delas é a
 * janela deste arquivo, chaveada pelo usuário DONO do tíquete, que é uma chave
 * tão honesta quanto a do hook.
 */

/**
 * Um ciclo de atualização são DUAS requisições ao feed (`latest.yml` e o
 * `.exe`) — ver o `disableDifferentialDownload` no `apps/desktop/src/updater.ts`
 * para o porquê de não serem dezenas. 60/min cobre isso, cobre as retentativas
 * do electron-updater e cobre alguém clicando em "Baixar" várias vezes, e ainda
 * corta um laço automatizado.
 */
export const FEED_LIMITE = 60;
export const FEED_JANELA_MS = 60_000;

/** Só para o teste: injeta o `fetch` que fala com a API do GitHub. */
export interface UpdateRoutesDeps {
  fetchImpl?: Buscador;
}

/**
 * O 503 de servidor sem releases configurados. É um estado NORMAL em dev (não
 * há token, nem repo, nem release) e a frase precisa dizer isso — um 500 seco
 * mandaria alguém procurar bug onde só falta configuração.
 */
function indisponivel(reply: FastifyReply, err: unknown): FastifyReply {
  const motivo = err instanceof GithubReleasesError ? err.message : String(err);
  return reply.code(503).send({ error: `distribuição do app indisponível: ${motivo}` });
}

export function registerUpdateRoutes(app: FastifyInstance, store: Store, deps: UpdateRoutesDeps = {}): void {
  const tickets = new TicketStore();
  const janela = new SlidingWindow(FEED_LIMITE, FEED_JANELA_MS);
  const fetchImpl = deps.fetchImpl ?? fetch;

  /**
   * `POST /api/updates/ticket` — troca a sessão por uma credencial que cabe
   * numa URL. Quem chama: a página de download (para navegar até o `.exe`) e o
   * cliente desktop (para montar a URL do feed antes de mandar o main checar).
   */
  app.post("/api/updates/ticket", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });
    const { ticket, expiresIn } = tickets.issue(user.id);
    return reply.send({ ticket, expires_in: expiresIn });
  });

  /**
   * `GET /api/updates/latest` — o que a página de download mostra ANTES de
   * pedir o tíquete: versão, nome do arquivo e tamanho. Sem isto o botão
   * "Baixar" seria um salto no escuro, e um servidor sem release publicado só
   * revelaria o problema depois do clique.
   */
  app.get("/api/updates/latest", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });
    let catalogo;
    try {
      catalogo = await catalogoDeReleases(fetchImpl);
    } catch (err) {
      return indisponivel(reply, err);
    }
    const release = catalogo.latest;
    const exe = release === null ? null : instalador(release);
    if (release === null || exe === null) {
      // 404 e não 503: o servidor está bem, só não há instalador publicado
      // ainda (o `desktop-release.yml` cria o Release como DRAFT — falta
      // publicar). A frase diz isso porque a diferença decide o que fazer.
      return reply.code(404).send({
        error:
          release === null
            ? "nenhum release publicado ainda (o workflow cria o Release como rascunho — publique-o no GitHub)"
            : `o release ${release.tag} não tem instalador .exe`,
      });
    }
    return reply.send({
      version: release.version,
      file: exe.name,
      size: exe.size,
      published_at: release.publishedAt,
    });
  });

  /**
   * Valida o tíquete e cobra a janela. Devolve o id do usuário, ou null se já
   * respondeu (401/429) — o chamador só precisa checar por null.
   */
  function autorizar(req: FastifyRequest, reply: FastifyReply): string | null {
    const ticket = (req.query as { ticket?: string }).ticket;
    const userId = tickets.resolve(ticket);
    if (userId === null) {
      reply.code(401).send({ error: "tíquete de download inválido ou expirado" });
      return null;
    }
    const espera = janela.retryAfterMs(userId);
    if (espera > 0) {
      tooManyRequests(reply, espera, "muitos downloads seguidos");
      return null;
    }
    janela.record(userId);
    return userId;
  }

  /**
   * `GET /api/updates/download?ticket=` — o botão da página de download.
   *
   * O erro sai como REDIRECT de volta para `/download`, e não como JSON: isto é
   * uma NAVEGAÇÃO do navegador. Um corpo JSON aqui tiraria a pessoa da página e
   * a deixaria olhando `{"error":...}` numa aba branca, sem botão de voltar que
   * refaça o pedido. No caminho feliz nada disso aparece — a resposta do CDN
   * vem com `Content-Disposition: attachment`, então o navegador baixa e a
   * página continua onde estava.
   */
  app.get("/api/updates/download", async (req, reply) => {
    const ticket = (req.query as { ticket?: string }).ticket;
    if (tickets.resolve(ticket) === null) return reply.redirect("/download?erro=ticket", 302);
    if (autorizar(req, reply) === null) return reply; // 429 (o 401 já foi tratado acima)
    let catalogo;
    try {
      catalogo = await catalogoDeReleases(fetchImpl);
    } catch {
      return reply.redirect("/download?erro=indisponivel", 302);
    }
    const exe = catalogo.latest === null ? null : instalador(catalogo.latest);
    if (exe === null) return reply.redirect("/download?erro=sem-release", 302);
    try {
      return reply.redirect(await urlDeDownload(exe.id, fetchImpl), 302);
    } catch {
      return reply.redirect("/download?erro=indisponivel", 302);
    }
  });

  /**
   * `GET /api/updates/feed/:file?ticket=` — o feed `generic` do
   * electron-updater. Ele pede `latest.yml` e depois o arquivo que o yml
   * apontar, os dois relativos à URL base (com a query preservada).
   *
   * O ALLOWLIST DE NOMES É O PRÓPRIO CATÁLOGO: `:file` tem de casar, por
   * igualdade exata, o nome de um asset publicado. Não há concatenação de
   * caminho em lugar nenhum — o nome vira um `id` numérico de asset e é só isso
   * que vai para a API do GitHub. `..%2f` e afins não têm por onde entrar.
   *
   * O mapa cobre os últimos releases, e não só o mais novo, por um motivo
   * concreto: entre a leitura do `latest.yml` e o download do `.exe` passam
   * minutos, e um release publicado nesse intervalo faria o arquivo que o
   * cliente está pedindo desaparecer do catálogo — 404 no meio da atualização.
   */
  app.get("/api/updates/feed/:file", async (req, reply) => {
    if (autorizar(req, reply) === null) return reply;
    const nome = (req.params as { file: string }).file;
    let catalogo;
    try {
      catalogo = await catalogoDeReleases(fetchImpl);
    } catch (err) {
      return indisponivel(reply, err);
    }
    const asset = catalogo.porNome.get(nome);
    if (asset === undefined) return reply.code(404).send({ error: "arquivo não existe neste release" });
    try {
      return reply.redirect(await urlDeDownload(asset.id, fetchImpl), 302);
    } catch (err) {
      return indisponivel(reply, err);
    }
  });

  app.log.info(
    { repo: config.releaseRepo, token: config.releaseToken !== "" },
    "distribuição do app desktop registrada (/api/updates)",
  );
}
