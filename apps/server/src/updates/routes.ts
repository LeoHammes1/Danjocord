import { mkdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authFromHeader } from "../auth.js";
import { config } from "../config.js";
import { SlidingWindow, tooManyRequests } from "../limits.js";
import type { Store } from "../store.js";
import {
  ARQUIVO_FEED,
  TIPO_RELEASE,
  artefatoExiste,
  gravarArtefato,
  gravarRelease,
  lerRelease,
  nomeDeArtefatoValido,
  podar,
  versaoValida,
} from "./store.js";
import { TicketStore } from "./tickets.js";

/**
 * REST da distribuição do app desktop (M14): a página de download, o feed que o
 * `electron-updater` consome e a porta por onde o CI entrega o instalador.
 *
 * ---------------------------------------------------------------------------
 * POR QUE ISTO É AUTENTICADO
 * ---------------------------------------------------------------------------
 *
 * O instalador leva 12 sons proprietários do Discord dentro (ATTRIBUTIONS.md).
 * A condição escrita para usá-los é "instância fechada", e um `.exe` num link
 * público seria o contrário disso. Então a porta existe, mas só abre para quem
 * já é membro: o feed e o download exigem tíquete, e tíquete só sai para quem
 * tem sessão.
 *
 * Isso não custa nada a ninguém: para USAR o app é preciso estar na allowlist
 * de qualquer jeito. Quem legitimamente quer o instalador consegue entrar na
 * web e clicar; quem não consegue entrar também não teria o que fazer com ele.
 *
 * ---------------------------------------------------------------------------
 * AS ROTAS
 * ---------------------------------------------------------------------------
 *
 *   POST /api/updates/ticket          Bearer  → tíquete opaco (30 min)
 *   GET  /api/updates/latest          Bearer  → o que existe para baixar
 *   GET  /api/updates/download        tíquete → 302 para o arquivo (o navegador)
 *   GET  /api/updates/feed/:file      tíquete → o arquivo (o updater)
 *   POST /api/updates/publish         token   → grava um artefato (o CI)
 *   POST /api/updates/publish/commit  token   → vira a chave: este é o release
 *
 * As duas de tíquete NÃO trazem Bearer (a credencial está na query), e o hook
 * geral do rate limit responde 401 a tudo que não traz — por isso elas são
 * `proprio` na tabela, com a janela deste arquivo, chaveada pelo usuário DONO
 * do tíquete. As duas de publish são autenticadas por um token de máquina.
 *
 * Tudo mora num plugin ENCAPSULADO por dois motivos concretos: o
 * `@fastify/static` precisa de um segundo `root` (o do cliente estático já
 * ocupa o da raiz, e o decorator `sendFile` colidiria), e o parser de corpo do
 * upload de release não pode vazar para o resto do app.
 */

/**
 * Um ciclo de atualização são DUAS requisições ao feed (`latest.yml` e o
 * `.exe`) — ver o `disableDifferentialDownload` no `apps/desktop/src/updater.ts`
 * para o porquê de não serem dezenas. 60/min cobre isso, cobre as retentativas
 * do electron-updater, cobre o navegador retomando um download cortado, e ainda
 * corta um laço automatizado.
 */
export const FEED_LIMITE = 60;
export const FEED_JANELA_MS = 60_000;

/**
 * O publish é do CI, uma vez por release. 20/min é folga absurda de propósito:
 * o número existe para capar um laço, não para regular uso — e o upload em si
 * já é caro o suficiente para se autolimitar.
 */
const PUBLISH_LIMITE = 20;
const PUBLISH_JANELA_MS = 60_000;

/**
 * Só para o teste. A produção não passa nada — o `config` manda.
 *
 * O token entra por aqui, e não é lido do `config` dentro do handler, por uma
 * razão prática do arranjo de testes deste repo: o `config` congela o
 * `process.env` no PRIMEIRO import de `src/`, e a ordem do `test/index.js` faz
 * isso acontecer antes desta suíte rodar. Uma env setada no topo do arquivo de
 * teste simplesmente não chegaria.
 */
export interface UpdateRoutesDeps {
  releasesDir?: string;
  publishToken?: string;
}

/** Comparação de token em tempo constante (o `===` vaza o prefixo certo). */
function tokenConfere(recebido: string, esperado: string): boolean {
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  // `timingSafeEqual` LANÇA com tamanhos diferentes, e o tamanho já é público
  // (está no header) — comparar antes não vaza nada que o atacante não saiba.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function registerUpdateRoutes(
  app: FastifyInstance,
  store: Store,
  deps: UpdateRoutesDeps = {},
): Promise<void> {
  const releasesDir = deps.releasesDir ?? config.releasesDir;
  const publishToken = deps.publishToken ?? config.publishToken;
  // O diretório nasce vazio num deploy limpo e o @fastify/static exige que o
  // root exista no registro. Criar aqui é uma linha; deixar o boot quebrar por
  // causa de uma pasta ausente seria o app inteiro fora por causa de uma página.
  mkdirSync(releasesDir, { recursive: true });

  const tickets = new TicketStore();
  const janela = new SlidingWindow(FEED_LIMITE, FEED_JANELA_MS);
  const janelaPublish = new SlidingWindow(PUBLISH_LIMITE, PUBLISH_JANELA_MS);

  await app.register(async (escopo: FastifyInstance) => {
    // `serve: false`: queremos só o `reply.sendFile` — que traz Range, ETag e
    // Last-Modified de graça. Range importa de verdade aqui: são ~100 MB numa
    // conexão doméstica, e sem ele um download cortado em 90% recomeça do zero.
    await escopo.register(fastifyStatic, { root: releasesDir, serve: false });

    // Parser do upload de release: devolve o FLUXO cru, sem bufferizar. O
    // `raw-body.ts` bufferiza (chão de 64 KB) e é o certo para anexo e som; um
    // instalador de 100 MB por aquele caminho viraria 200 MB de pico de memória
    // num pod de 1 GiB. O teto aqui é contado em `gravarArtefato`, porque o
    // `bodyLimit` do Fastify não alcança parser de fluxo.
    escopo.addContentTypeParser(TIPO_RELEASE, (_req, payload, done) => done(null, payload));

    // -----------------------------------------------------------------------
    // O que a página de download usa
    // -----------------------------------------------------------------------

    escopo.post("/api/updates/ticket", async (req, reply) => {
      const user = authFromHeader(req.headers.authorization, store);
      if (!user) return reply.code(401).send({ error: "não autenticado" });
      const { ticket, expiresIn } = tickets.issue(user.id);
      return reply.send({ ticket, expires_in: expiresIn });
    });

    /**
     * O que a página mostra ANTES de pedir o tíquete: versão, nome do arquivo e
     * tamanho. Sem isto o botão "Baixar" seria um salto no escuro, e um servidor
     * sem release publicado só revelaria o problema depois do clique.
     */
    escopo.get("/api/updates/latest", async (req, reply) => {
      const user = authFromHeader(req.headers.authorization, store);
      if (!user) return reply.code(401).send({ error: "não autenticado" });
      const release = await lerRelease(releasesDir);
      if (release === null) {
        // 404 e não 503: o servidor está bem, só não há instalador publicado
        // ainda. A diferença decide o que fazer.
        return reply.code(404).send({
          error: "nenhum instalador publicado ainda (o release sobe pela tag v* — ver desktop-release.yml)",
        });
      }
      return reply.send(release);
    });

    // -----------------------------------------------------------------------
    // O tíquete, e as duas rotas que ele abre
    // -----------------------------------------------------------------------

    /** Valida o tíquete e cobra a janela. null = já respondeu (401/429). */
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
     * `GET /api/updates/download?ticket=` — o botão da página.
     *
     * Redireciona para o próprio feed em vez de servir o arquivo: assim existe
     * UM caminho de leitura de bytes (com Range e cache), e a URL final já
     * carrega o nome do arquivo, que é o que o navegador usa para nomear o
     * download.
     *
     * O ERRO sai como redirect de volta para `/download`, e não como JSON: isto
     * é uma NAVEGAÇÃO. Um corpo JSON aqui tiraria a pessoa da página e a
     * deixaria olhando `{"error":...}` numa aba branca, sem botão que refizesse
     * o pedido.
     */
    escopo.get("/api/updates/download", async (req, reply) => {
      const ticket = (req.query as { ticket?: string }).ticket;
      if (tickets.resolve(ticket) === null) return reply.redirect("/download?erro=ticket", 302);
      if (autorizar(req, reply) === null) return reply; // 429 (o 401 já saiu acima)
      const release = await lerRelease(releasesDir);
      if (release === null) return reply.redirect("/download?erro=sem-release", 302);
      const query = `?ticket=${encodeURIComponent(ticket ?? "")}`;
      return reply.redirect(`/api/updates/feed/${encodeURIComponent(release.file)}${query}`, 302);
    });

    /**
     * `GET /api/updates/feed/:file?ticket=` — o feed `generic` do
     * electron-updater. Ele pede `latest.yml` e depois o arquivo que o yml
     * apontar, os dois relativos à URL base (com a query preservada).
     *
     * `:file` passa por `nomeDeArtefatoValido` e vira `join(releasesDir, nome)`
     * — não há concatenação de caminho vinda do pedido em lugar nenhum, e o
     * `sendFile` ainda resolve contra o root por conta própria.
     */
    escopo.get("/api/updates/feed/:file", async (req, reply) => {
      if (autorizar(req, reply) === null) return reply;
      const nome = (req.params as { file: string }).file;
      if (!(await artefatoExiste(releasesDir, nome))) {
        return reply.code(404).send({ error: "arquivo não existe neste release" });
      }
      // `attachment` para o navegador salvar com o nome certo em vez de tentar
      // exibir; o electron-updater ignora o header e não se importa.
      reply.header("content-disposition", `attachment; filename="${nome}"`);
      return reply.sendFile(nome);
    });

    // -----------------------------------------------------------------------
    // A porta do CI
    // -----------------------------------------------------------------------

    /**
     * Guarda das duas rotas de publish. É um `onRequest` de ROTA de propósito:
     * ele roda ANTES do parser de corpo, então um POST sem token não chega a
     * escrever um byte no disco.
     */
    async function guardaDePublish(req: FastifyRequest, reply: FastifyReply): Promise<void> {
      if (publishToken === "") {
        return void reply.code(503).send({
          error: "publicação de release desligada neste servidor (falta DANJOCORD_PUBLISH_TOKEN)",
        });
      }
      const header = req.headers.authorization;
      const recebido = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : "";
      if (!tokenConfere(recebido, publishToken)) {
        return void reply.code(401).send({ error: "token de publicação inválido" });
      }
      // Chave única ("publish") de propósito: é uma credencial de MÁQUINA, uma
      // só, e não há usuário para separar baldes. Quem passou no token é o CI.
      const espera = janelaPublish.retryAfterMs("publish");
      if (espera > 0) return void tooManyRequests(reply, espera, "muitas publicações seguidas");
      janelaPublish.record("publish");
    }

    /**
     * `POST /api/updates/publish?file=<nome>` — um artefato, corpo binário cru.
     *
     * A ORDEM importa e está no workflow: o `.exe` sobe primeiro, o
     * `latest.yml` depois, e o commit por último. Assim nunca existe um
     * `latest.yml` novo apontando para um `.exe` que ainda não chegou. Cada
     * arquivo em si é atômico (temporário + rename).
     */
    escopo.post(
      "/api/updates/publish",
      { onRequest: guardaDePublish },
      async (req, reply) => {
        const nome = (req.query as { file?: string }).file ?? "";
        if (!nomeDeArtefatoValido(nome)) {
          return reply.code(400).send({ error: "nome de artefato inválido" });
        }
        try {
          const bytes = await gravarArtefato(releasesDir, nome, req.body as Readable);
          req.log.info({ file: nome, bytes }, "artefato de release recebido");
          return reply.code(201).send({ file: nome, size: bytes });
        } catch (err) {
          req.log.warn({ file: nome, err }, "upload de artefato falhou");
          return reply.code(413).send({ error: `upload falhou: ${String(err)}` });
        }
      },
    );

    /**
     * `POST /api/updates/publish/commit` — vira a chave.
     *
     * É este passo que decide qual release os amigos baixam, e ele só aceita
     * depois de conferir que os arquivos ESTÃO no disco. Sem ele, um upload
     * interrompido no meio publicaria meia versão; com ele, o pior caso é um
     * artefato órfão que a poda seguinte remove.
     */
    escopo.post("/api/updates/publish/commit", { onRequest: guardaDePublish }, async (req, reply) => {
      const corpo = (req.body ?? {}) as { version?: unknown; file?: unknown };
      const version = typeof corpo.version === "string" ? corpo.version : "";
      const file = typeof corpo.file === "string" ? corpo.file : "";
      if (!versaoValida(version)) return reply.code(400).send({ error: "versão inválida (esperado 1.2.3)" });
      if (!nomeDeArtefatoValido(file) || !file.toLowerCase().endsWith(".exe")) {
        return reply.code(400).send({ error: "o instalador precisa ser um .exe" });
      }
      for (const necessario of [file, ARQUIVO_FEED]) {
        if (!(await artefatoExiste(releasesDir, necessario))) {
          return reply.code(409).send({ error: `"${necessario}" não está no servidor — suba os artefatos antes do commit` });
        }
      }
      // `size` sai daqui zerado de propósito: o `lerRelease` devolve o tamanho
      // REAL do arquivo, e um número declarado que discordasse do disco só
      // serviria para a página mostrar um valor errado.
      await gravarRelease(releasesDir, { version, file, size: 0, published_at: Date.now() });
      const apagados = await podar(releasesDir);
      req.log.info({ version, file, apagados }, "release publicado");
      return reply.send({ version, file, pruned: apagados });
    });
  });

  app.log.info({ releasesDir, publish: publishToken !== "" }, "distribuição do app desktop registrada");
}
