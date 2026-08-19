/**
 * Política de anexo de imagem no cliente (M11b, item 89) — a metade PURA.
 *
 * Este arquivo NÃO importa `../auth.js`, não toca DOM e não faz rede, por uma
 * razão prática: é ele que o `node --test` consegue importar. É a mesma
 * separação que o M8 fez entre `sound/catalog.ts` (dado puro, testado) e
 * `sound/assets.ts` (o único que importa `.ogg`) — sem ela a regra de "o que é
 * uma imagem aceitável" só poderia ser verificada abrindo o navegador. O
 * transporte mora em `ui/upload.ts` e o desenho, em `ui/composer.ts`.
 *
 * O QUE ESTA CHECAGEM É E O QUE ELA NÃO É. Ela é uma RECUSA CEDO, para a
 * pessoa não esperar o upload de 8 MB de um `.exe` renomeado para descobrir
 * que não era imagem. Ela NÃO é a decisão: quem decide o formato (e o mime que
 * será gravado e devolvido) é o `attachments/probe.ts` do servidor, sobre os
 * bytes que chegaram lá. Por isso os limiares aqui são cópia EXATA do
 * `sniffImage()` de lá — um cliente mais permissivo daria um upload que morre
 * no 400, e um cliente mais rígido esconderia um arquivo que o servidor
 * aceitaria.
 */

/**
 * Teto por arquivo. Duplicado do `attachments/limits.ts` do servidor (que o
 * cliente não importa — são pacotes diferentes) e conferido contra ele: se um
 * dia mudar lá, muda aqui. Recusar antes de subir é o ponto todo do número.
 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Mesmo teto do `CreateMessageBody.attachment_ids` (protocolo) e do Discord. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * Quantos bytes do começo do arquivo bastam para sniffar. O WebP é o que exige
 * mais: "RIFF" nos bytes 0..3 e "WEBP" nos 8..11.
 */
export const SNIFF_BYTES = 16;

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Compara um trecho como texto ASCII; trecho fora do buffer vira "" (truncado). */
function ascii(bytes: Uint8Array, start: number, end: number): string {
  if (bytes.length < end) return "";
  let out = "";
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i] as number);
  return out;
}

/**
 * Formato pelos MAGIC BYTES — nunca pela extensão nem pelo `file.type` que o
 * navegador declara (os dois são texto escolhido por quem manda; um `.exe`
 * renomeado para `.png` chega com `type: "image/png"`).
 *
 * Espelho fiel do `sniffImage()` do servidor, inclusive nos tamanhos mínimos:
 * arquivo truncado antes da assinatura devolve null em vez de "talvez".
 */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return "image/png";
  // JPEG: SOI (FFD8) seguido de qualquer marcador (FFxx)
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const gif = ascii(bytes, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  // WebP é um container RIFF: o "WEBP" só aparece depois dos 4 bytes de tamanho
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Tamanho legível — o teto é anunciado em MB, então o erro também é. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

export interface AttachmentCandidate {
  /** `file.size` */
  size: number;
  /** os primeiros `SNIFF_BYTES` bytes do arquivo (o cliente lê com `file.slice`) */
  head: Uint8Array;
  /** quantos anexos JÁ estão na bandeja do composer */
  anexosAtuais: number;
}

/**
 * A frase de recusa, ou null quando o arquivo pode subir. Uma frase (e não um
 * código) porque o único consumidor é a linha de erro do composer, e um mapa
 * de código→texto no meio do caminho só criaria um lugar a mais para o texto
 * ficar velho.
 *
 * A ORDEM importa: quantidade antes de tamanho, e tamanho antes de formato.
 * Sniffar exige ler bytes do disco; dizer "já são 10" ou "passa de 8 MB" não
 * exige — e essas duas respostas não mudam depois de ler.
 */
export function attachmentProblem(c: AttachmentCandidate): string | null {
  if (c.anexosAtuais >= MAX_ATTACHMENTS_PER_MESSAGE) {
    return `no máximo ${MAX_ATTACHMENTS_PER_MESSAGE} imagens por mensagem`;
  }
  if (c.size === 0) return "arquivo vazio";
  if (c.size > MAX_ATTACHMENT_BYTES) {
    return `imagem de ${formatBytes(c.size)} — o limite é ${formatBytes(MAX_ATTACHMENT_BYTES)}`;
  }
  if (sniffImageMime(c.head) === null) return "só imagem: png, jpeg, gif ou webp";
  return null;
}
