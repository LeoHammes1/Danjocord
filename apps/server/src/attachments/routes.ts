import type { FastifyInstance, FastifyReply } from "fastify";
import { CreateAttachmentQuery } from "@danjocord/protocol";
import { authFromHeader } from "../auth.js";
import { canonicalId } from "../db/snowflake.js";
import { SlidingWindow, tooManyRequests } from "../limits.js";
import { registerRawBodyParser } from "../raw-body.js";
import type { Store } from "../store.js";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  UPLOAD_LIMIT,
  UPLOAD_WINDOW_MS,
} from "./limits.js";
import { probeImage } from "./probe.js";

/**
 * REST dos anexos (M11b, item 89) — a SEGUNDA superfície de binário de usuário
 * do projeto. O molde é o `sounds/routes.ts` do M9, de propósito: aquele
 * caminho já foi revisado e o que ele decidiu não se reinventa aqui.
 *
 * O upload é em DUAS etapas, e isso é a única diferença estrutural para o som:
 *
 *   1. `POST /api/attachments` sobe o arquivo e devolve o id. O anexo nasce
 *      SOLTO — sem mensagem.
 *   2. o `POST` da mensagem cita os ids em `attachment_ids`, e é aí que os dois
 *      se amarram (na mesma transação da mensagem).
 *
 * Por que não num passo só: o corpo do POST de mensagem é JSON, e enfiar 8 MB
 * de imagem em base64 dentro dele custaria +33% de tráfego e uma string
 * gigante na memória do Node. Com duas etapas o cliente também consegue mostrar
 * o preview e a barra de progresso antes de a mensagem existir.
 *
 * O preço das duas etapas é o anexo ÓRFÃO — quem sobe e desiste de mandar. Ele
 * é lixo com prazo: `store.deleteOrphanAttachments` roda no boot e a cada 5
 * minutos (ver `index.ts` e `limits.ts`).
 *
 * As defesas, todas server-side:
 *   1. corpo binário cru com bodyLimit — o Fastify corta antes de bufferizar;
 *   2. formato sniffado por MAGIC BYTES, nunca por Content-Type/extensão (um
 *      `.exe` renomeado para `.png` morre no provador);
 *   3. dimensões MEDIDAS aqui, nunca as que o cliente declara;
 *   4. o GET devolve o mime GUARDADO + `nosniff` + `Content-Disposition` que só
 *      é `inline` para os quatro tipos reconhecidos;
 *   5. teto por arquivo, teto TOTAL da guild e rate limit checados ANTES de ler
 *      o corpo, onde dá.
 */

export function registerAttachmentRoutes(app: FastifyInstance, store: Store): void {
  registerRawBodyParser(app);

  const uploadWindow = new SlidingWindow(UPLOAD_LIMIT, UPLOAD_WINDOW_MS);

  app.post(
    "/api/attachments",
    {
      // teto de corpo na ROTA: no Fastify 5 ele vence o do parser, então é
      // ESTA linha que define os 8 MB deste endpoint
      bodyLimit: MAX_ATTACHMENT_BYTES,
      // onRequest roda ANTES de ler o corpo: quem já estourou a cota, ou vai
      // esbarrar no teto da guild, é recusado sem transferir 8 MB
      onRequest: async (req, reply) => {
        const user = authFromHeader(req.headers.authorization, store);
        if (!user) return reply.code(401).send({ error: "não autenticado" });
        const used = store.totalAttachmentBytes();
        if (used + MAX_ATTACHMENT_BYTES > MAX_ATTACHMENTS_TOTAL_BYTES) {
          return storageFull(reply, used);
        }
        const wait = uploadWindow.retryAfterMs(user.id);
        if (wait > 0) return tooManyRequests(reply, wait, "muitos envios seguidos");
        // CONSOME A COTA AQUI, no mesmo passo síncrono da checagem (auditoria
        // M12). Antes o `record` morava no handler, e entre os dois o Fastify
        // LIA O CORPO — um await. N requisições disparadas juntas passavam
        // todas pelo `retryAfterMs` com a janela ainda em zero: medido, 60
        // uploads simultâneos deram 60 aceitos com UPLOAD_LIMIT = 10 (as mesmas
        // 60 em série davam 10 e 50).
        //
        // Nada entre a leitura e a escrita da janela pode ceder o event loop.
        // `authFromHeader`, `totalAttachmentBytes` e os dois métodos da janela
        // são todos síncronos, então este bloco é atômico na prática — e é por
        // isso que ele precisa ficar junto, e não porque "é mais organizado".
        uploadWindow.record(user.id);
      },
    },
    async (req, reply) => {
      const user = authFromHeader(req.headers.authorization, store);
      if (!user) return reply.code(401).send({ error: "não autenticado" });

      const raw = req.query as { filename?: string };
      const query = CreateAttachmentQuery.safeParse({ filename: raw.filename });
      if (!query.success) {
        return reply.code(400).send({ error: "nome de arquivo inválido (1 a 120 caracteres, sem caminho)" });
      }

      const bytes = req.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        return reply.code(400).send({ error: "corpo vazio — mande o arquivo cru no corpo do POST" });
      }
      // o bodyLimit já cortaria antes; defesa em profundidade para o dia em que
      // o parser ou a rota mudarem
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        return reply.code(413).send({ error: `imagem acima de ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB` });
      }

      let probe;
      try {
        probe = probeImage(bytes);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : "imagem inválida" });
      }

      // revalidação do teto da guild com o tamanho REAL (o onRequest usou o
      // pior caso, porque ainda não sabia quantos bytes viriam)
      const used = store.totalAttachmentBytes();
      if (used + bytes.length > MAX_ATTACHMENTS_TOTAL_BYTES) return storageFull(reply, used);

      const attachment = store.createAttachment({
        uploaderId: user.id,
        filename: query.data.filename,
        mime: probe.mime,
        bytes,
        width: probe.width,
        height: probe.height,
      });
      // 201 sem evento no gateway: o anexo ainda não é de ninguém a não ser de
      // quem subiu — quem anuncia é o MESSAGE_CREATE, quando ele for amarrado
      return reply.code(201).send(attachment);
    },
  );

  /**
   * Os bytes. Cache imutável porque o id é snowflake e o conteúdo NUNCA muda.
   *
   * O `content-type` sai do BANCO, jamais do request — e o banco só guarda os
   * quatro que o provador reconhece (CHECK na migration 006). Servir um
   * content-type escolhido por quem sobe, na mesma origem do app, seria XSS de
   * graça: bastaria subir um `.html`.
   */
  app.get("/api/attachments/:attachmentId", async (req, reply) => {
    const user = authFromHeader(req.headers.authorization, store);
    if (!user) return reply.code(401).send({ error: "não autenticado" });

    const attachmentId = canonicalId((req.params as { attachmentId: string }).attachmentId);
    const file = attachmentId === null ? null : store.getAttachmentBytes(attachmentId);
    if (!file) return reply.code(404).send({ error: "anexo não encontrado" });

    reply.header("content-type", file.mime);
    // nosniff repetido aqui (além do hook global do index.ts) porque a rota tem
    // que ser segura mesmo se alguém remover o hook
    reply.header("x-content-type-options", "nosniff");
    reply.header("cache-control", "public, max-age=31536000, immutable");
    // `inline` só porque o mime GUARDADO é um dos quatro de imagem — o banco
    // não deixa ser outro. Se algum dia entrar um tipo não reconhecido, ele
    // tem que sair como anexo de download, nunca renderizado na página.
    reply.header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    reply.header("content-length", String(file.bytes.length));
    return reply.send(file.bytes);
  });
}

/**
 * 507 e não 413: o problema não é o tamanho DESTE arquivo, é a guild ter
 * enchido. A mensagem diz quanto foi usado porque a saída é humana — alguém
 * precisa ir apagar mensagens antigas com imagem.
 */
function storageFull(reply: FastifyReply, used: number): FastifyReply {
  const mb = (n: number): string => (n / (1024 * 1024)).toFixed(0);
  return reply.code(507).send({
    error:
      `o servidor já guarda ${mb(used)} MB de imagens (teto de ${mb(MAX_ATTACHMENTS_TOTAL_BYTES)} MB) — ` +
      "apague mensagens com anexo antes de subir outra",
  });
}

