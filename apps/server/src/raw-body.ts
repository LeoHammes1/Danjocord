import type { FastifyInstance } from "fastify";

/**
 * O parser de CORPO BINÁRIO CRU, num lugar só (M11b).
 *
 * Por que existe: o Fastify 5 só entende JSON e texto de fábrica, e ler
 * multipart exigiria plugin — que o projeto não instala (regra do M9). A saída
 * decidida lá foi mandar o arquivo cru no corpo e os metadados na query; o M11b
 * repete o padrão para os anexos, e aí apareceu o problema que este arquivo
 * resolve: `addContentTypeParser` LANÇA se o mesmo content-type for registrado
 * duas vezes, e `application/octet-stream` serve aos dois uploads.
 *
 * No Fastify 5 o `bodyLimit` da ROTA vence o do parser
 * (`lib/content-type-parser.js`: `options.limit === null ? parser.bodyLimit :
 * options.limit`), então cada rota é dona do próprio limite — as duas de upload
 * declaram os 8 MB (anexos) e os 512 KB (sons).
 *
 * O QUE MUDOU NO M12 (auditoria, rodada 2). O teto daqui era 8 MB, "o do maior
 * consumidor", e o comentário afirmava que era "só o chão comum". Era chão
 * comum mesmo — e é aí que estava o problema: rota que NÃO declara limite
 * herdava 8 MB em vez do 1 MiB padrão do Fastify. Como o parser é registrado no
 * app RAIZ, isso valia para TODA rota POST, inclusive as anônimas: medido,
 * `POST /auth/logout` com `content-type: application/octet-stream` lia 8 MB
 * inteiros ANTES de qualquer autenticação (com `application/json` o mesmo corpo
 * levava 413, porque aí o default de 1 MiB valia).
 *
 * O chão agora é pequeno de propósito. Rota que precisa de binário grande é
 * rota de upload, e rota de upload TEM que declarar o limite dela — as duas
 * declaram. Se uma futura esquecer, ela falha cedo e visivelmente em
 * desenvolvimento, que é exatamente quando se quer descobrir; um chão generoso
 * faria o esquecimento passar despercebido até virar superfície de ataque.
 */

/** Marca no app para o registro ser idempotente (as duas rotas chamam). */
const FLAG = "danjocordRawBodyParser";

/**
 * Content-Types aceitos no corpo cru. `application/octet-stream` é o caminho
 * padrão; os mimes concretos entram porque um `fetch(arquivo)` manda o
 * `file.type` do navegador sem pensar.
 *
 * NADA disto é levado a sério além de escolher o parser: quem decide o tipo do
 * arquivo são os MAGIC BYTES, nos dois provadores (`sounds/probe.ts` e
 * `attachments/probe.ts`).
 */
const RAW_TYPES = [
  "application/octet-stream",
  // áudio (M9)
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
  "audio/mpeg",
  "audio/mp3",
  // imagem (M11b)
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

/**
 * CHÃO do parser — o que vale para rota que não declara `bodyLimit`.
 *
 * 64 KB não atende upload nenhum, e é essa a intenção: quem faz upload declara
 * o limite (`MAX_ATTACHMENT_BYTES`, `MAX_SOUND_BYTES`) e vence este número.
 * Quem não declara não deveria estar recebendo binário — e agora não recebe
 * mais que um punhado de bytes antes de o Fastify cortar.
 */
export const RAW_BODY_FLOOR_BYTES = 64 * 1024;

export function registerRawBodyParser(app: FastifyInstance): void {
  if (app.hasDecorator(FLAG)) return;
  app.decorate(FLAG, true);
  app.addContentTypeParser(
    RAW_TYPES,
    { parseAs: "buffer", bodyLimit: RAW_BODY_FLOOR_BYTES },
    (_req, body, done) => {
      done(null, body);
    },
  );
}
