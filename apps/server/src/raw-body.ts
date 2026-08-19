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
 * O teto daqui é o do MAIOR consumidor (8 MB, dos anexos). Isso NÃO afrouxa o
 * upload de som: no Fastify 5, o `bodyLimit` da ROTA vence o do parser
 * (`lib/content-type-parser.js`: `options.limit === null ? parser.bodyLimit :
 * options.limit`), e a rota de som declara os 512 KB dela. Cada rota continua
 * dona do próprio limite; este número é só o chão comum.
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

/** Teto do parser: o do maior consumidor. Cada rota aperta o dela. */
export const RAW_BODY_MAX_BYTES = 8 * 1024 * 1024;

export function registerRawBodyParser(app: FastifyInstance): void {
  if (app.hasDecorator(FLAG)) return;
  app.decorate(FLAG, true);
  app.addContentTypeParser(
    RAW_TYPES,
    { parseAs: "buffer", bodyLimit: RAW_BODY_MAX_BYTES },
    (_req, body, done) => {
      done(null, body);
    },
  );
}
