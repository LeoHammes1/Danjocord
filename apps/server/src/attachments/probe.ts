/**
 * Provador de imagem dos anexos (M11b, item 89): descobre o FORMATO pelos
 * magic bytes e lê as DIMENSÕES do cabeçalho — em TypeScript puro, sem
 * dependência nenhuma. É o irmão do `sounds/probe.ts` do M9, e o parentesco é
 * de propósito: o padrão de "aceitar binário de usuário" já foi decidido lá e
 * não se reinventa aqui.
 *
 * Por que sniffar por magic bytes: `Content-Type` e extensão são texto
 * escolhido por quem sobe. O mime que gravamos (e que o `GET /api/attachments/
 * :id` devolve) sai DAQUI — é o que impede servir `text/html` na mesma origem
 * do app, que seria XSS de graça, e é o que faz um `.exe` renomeado para `.png`
 * morrer na porta em vez de virar um download que o navegador executa.
 *
 * Por que ler as dimensões: o cliente reserva a caixa da imagem ANTES de ela
 * carregar. Sem isso, cada imagem que termina de baixar empurra o texto que a
 * pessoa está lendo — o "pulo de layout" clássico, que numa lista com scroll
 * ancorado no fim é especialmente cruel.
 *
 * Cada leitor abaixo é pequeno e comentado porque "onde ficam a largura e a
 * altura" é uma resposta diferente em cada formato — e essa é a metade
 * didática do item.
 */

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageProbe {
  /** mime CANÔNICO do formato detectado — nunca o do request */
  mime: ImageMime;
  width: number;
  height: number;
}

/** Formato reconhecido pelos primeiros bytes (nunca pela extensão). */
export type ImageFormat = "png" | "jpeg" | "gif" | "webp";

const MIME_BY_FORMAT: Record<ImageFormat, ImageMime> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Teto de sanidade das dimensões. 20000 × 20000 já é absurdo para uma foto
 * colada num chat, e um cabeçalho que declara mais que isso está mentindo ou
 * corrompido — em qualquer dos casos, o cliente reservaria uma caixa de
 * quilômetros. O teto de BYTES continua sendo a defesa principal (limits.ts);
 * esta é a defesa contra a "bomba de dimensão" que cabe em poucos bytes.
 */
const MAX_DIMENSION = 20_000;

function ascii(buf: Buffer, start: number, end: number): string {
  return buf.length >= end ? buf.toString("latin1", start, end) : "";
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Magic bytes dos quatro formatos aceitos. Qualquer outra coisa — inclusive um
 * PE do Windows (`MZ`), um ELF, um SVG (que é XML e viraria script no
 * navegador) ou um ZIP — devolve null e morre antes de qualquer parser.
 */
export function sniffImage(buf: Buffer): ImageFormat | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  // JPEG: SOI (FFD8) seguido de qualquer marcador (FFxx)
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  const gif = ascii(buf, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "gif";
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 12) === "WEBP") return "webp";
  return null;
}

/**
 * Sniffa e mede. Lança Error com frase curta em pt-BR (que vira o corpo do 400
 * da rota de upload) quando o arquivo não é de um dos quatro formatos, está
 * truncado, ou declara dimensões impossíveis.
 */
export function probeImage(buf: Buffer): ImageProbe {
  const format = sniffImage(buf);
  if (format === null) {
    throw new Error("formato não reconhecido — envie png, jpeg, gif ou webp");
  }
  const size =
    format === "png"
      ? probePng(buf)
      : format === "jpeg"
        ? probeJpeg(buf)
        : format === "gif"
          ? probeGif(buf)
          : probeWebp(buf);

  if (size.width <= 0 || size.height <= 0) {
    throw new Error("imagem com dimensão zero");
  }
  if (size.width > MAX_DIMENSION || size.height > MAX_DIMENSION) {
    throw new Error(`imagem de ${size.width}×${size.height} — o teto é ${MAX_DIMENSION} px por lado`);
  }
  return { mime: MIME_BY_FORMAT[format], width: size.width, height: size.height };
}

interface Size {
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// PNG — IHDR
// ---------------------------------------------------------------------------

/**
 * O PNG é o mais previsível dos quatro: depois da assinatura de 8 bytes vem
 * SEMPRE o chunk IHDR, e ele é o primeiro por exigência do formato. Layout:
 * tamanho (4, big-endian) | "IHDR" | largura (4) | altura (4) | ...
 *
 * O tamanho declarado do IHDR é conferido (13): um arquivo com a assinatura
 * certa e um IHDR de outro tamanho não é um PNG, é alguém testando o parser.
 */
function probePng(buf: Buffer): Size {
  if (buf.length < 24) throw new Error("PNG truncado (sem cabeçalho IHDR)");
  if (buf.toString("latin1", 12, 16) !== "IHDR") throw new Error("PNG sem chunk IHDR no início");
  if (buf.readUInt32BE(8) !== 13) throw new Error("PNG com IHDR de tamanho inválido");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ---------------------------------------------------------------------------
// JPEG — o marcador SOF
// ---------------------------------------------------------------------------

/**
 * No JPEG a dimensão não mora num lugar fixo: o arquivo é uma sequência de
 * segmentos (`FF <marcador> <tamanho de 2 bytes> <corpo>`) e só o marcador
 * "Start Of Frame" carrega altura e largura. É preciso caminhar pelos
 * segmentos até achar um SOF — o que também significa pular EXIF, ICC e
 * miniaturas, que podem ocupar dezenas de KB antes da imagem de verdade.
 *
 * Quais marcadores são SOF: C0..CF, MENOS C4 (tabelas de Huffman), C8
 * (extensão JPEG, reservado) e CC (aritmético). Confundir DHT com SOF é o erro
 * clássico aqui — o corpo do DHT tem qualquer coisa nos bytes onde o SOF teria
 * a altura, e o resultado é uma dimensão aleatória que parece plausível.
 */
function probeJpeg(buf: Buffer): Size {
  let pos = 2; // pula o SOI
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) throw new Error("JPEG corrompido (segmento sem marcador)");
    let marker = buf[pos + 1] ?? 0;
    // sequências de FF são preenchimento legítimo antes de um marcador
    while (marker === 0xff && pos + 2 < buf.length) {
      pos += 1;
      marker = buf[pos + 1] ?? 0;
    }
    // marcadores sem corpo (RSTn, SOI, TEM): andam 2 bytes e seguem
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      pos += 2;
      continue;
    }
    const length = buf.readUInt16BE(pos + 2);
    if (length < 2) throw new Error("JPEG corrompido (segmento de tamanho inválido)");

    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // corpo do SOF: precisão (1) | altura (2) | largura (2) | componentes…
      if (pos + 9 > buf.length) throw new Error("JPEG truncado (cabeçalho SOF incompleto)");
      return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
    }
    // SOS (DA) = começo dos dados comprimidos: passar daqui é caminhar sobre
    // bytes que não são segmentos, e é onde um parser ingênuo se perde
    if (marker === 0xda) break;
    pos += 2 + length;
  }
  throw new Error("JPEG truncado (sem cabeçalho SOF)");
}

// ---------------------------------------------------------------------------
// GIF — o Logical Screen Descriptor
// ---------------------------------------------------------------------------

/**
 * O mais simples dos quatro: logo depois de "GIF89a" vêm largura e altura em
 * 16 bits LITTLE-endian (o GIF é o único dos quatro que não é big-endian).
 *
 * Nota: esta é a tela LÓGICA, não necessariamente o tamanho do primeiro quadro
 * — mas é exatamente a caixa que o navegador reserva ao desenhar o GIF, que é
 * para o que a medida serve aqui.
 */
function probeGif(buf: Buffer): Size {
  if (buf.length < 10) throw new Error("GIF truncado (sem descritor de tela)");
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

// ---------------------------------------------------------------------------
// WebP — VP8 (com perda), VP8L (sem perda) e VP8X (estendido)
// ---------------------------------------------------------------------------

/**
 * WebP é um contêiner RIFF com TRÊS formas de guardar a dimensão, e é preciso
 * ler o chunk certo:
 *
 *   - "VP8 " (com perda): quadro-chave do VP8. Depois do tag de 3 bytes vem o
 *     código de sincronismo 9D 01 2A, e então largura e altura em 14 bits cada
 *     (os 2 bits altos de cada 16 são a escala, que se descarta).
 *   - "VP8L" (sem perda): 1 byte de assinatura (0x2F) e então 14 bits de
 *     largura-1 e 14 de altura-1, empacotados em 4 bytes little-endian. O "-1"
 *     é do formato: ele guarda o tamanho menos um para caber a dimensão máxima.
 *   - "VP8X" (estendido — é o que carrega animação, alfa e ICC): 4 bytes de
 *     flags e então largura-1 e altura-1 em 24 bits little-endian.
 *
 * Um WebP animado (o "GIF moderno") é sempre VP8X: ler só o VP8 daria erro
 * justamente no caso mais comum de figurinha colada no chat.
 */
function probeWebp(buf: Buffer): Size {
  // o tamanho do RIFF é conferido contra os bytes que EXISTEM: um cabeçalho
  // pode declarar 1 GB num arquivo de 10 KB, e acreditar nele seria ler lixo
  if (buf.length < 16) throw new Error("WebP truncado (sem chunk de imagem)");

  let pos = 12; // "RIFF" + tamanho + "WEBP"
  while (pos + 8 <= buf.length) {
    const id = buf.toString("latin1", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;

    if (id === "VP8X") {
      if (body + 10 > buf.length) throw new Error("WebP truncado (VP8X incompleto)");
      return {
        width: readUInt24LE(buf, body + 4) + 1,
        height: readUInt24LE(buf, body + 7) + 1,
      };
    }
    if (id === "VP8 ") {
      if (body + 10 > buf.length) throw new Error("WebP truncado (VP8 incompleto)");
      if (buf[body + 3] !== 0x9d || buf[body + 4] !== 0x01 || buf[body + 5] !== 0x2a) {
        throw new Error("WebP com quadro VP8 inválido");
      }
      return {
        width: buf.readUInt16LE(body + 6) & 0x3fff,
        height: buf.readUInt16LE(body + 8) & 0x3fff,
      };
    }
    if (id === "VP8L") {
      if (body + 5 > buf.length) throw new Error("WebP truncado (VP8L incompleto)");
      if (buf[body] !== 0x2f) throw new Error("WebP com quadro VP8L inválido");
      const bits = buf.readUInt32LE(body + 1);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }

    // chunks do RIFF são alinhados em 2 bytes; o +8 garante que o laço anda
    pos = body + size + (size % 2);
  }
  throw new Error("WebP sem chunk de imagem (VP8/VP8L/VP8X)");
}

function readUInt24LE(buf: Buffer, at: number): number {
  return (buf[at] ?? 0) | ((buf[at + 1] ?? 0) << 8) | ((buf[at + 2] ?? 0) << 16);
}
