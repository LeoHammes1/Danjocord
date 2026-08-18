/**
 * Provador de áudio do soundboard (M9): descobre o CONTAINER pelos magic bytes
 * e mede a DURAÇÃO abrindo o cabeçalho — em TypeScript puro, sem ffmpeg (que
 * não existe no pod e não vai passar a existir por causa de um pad de sons).
 *
 * Por que medir no servidor: o teto de 5 s é uma regra de servidor, e a duração
 * que o cliente declara é só uma opinião dele — um cliente modificado mandaria
 * "1000" com um arquivo de 4 minutos. Aqui a resposta vem do arquivo.
 *
 * Por que sniffar por magic bytes: Content-Type e extensão são texto escolhido
 * por quem sobe. O mime que gravamos (e que o GET de áudio devolve) sai DAQUI —
 * é o que impede servir text/html na mesma origem do app, que seria XSS de graça.
 *
 * Cada parser é deliberadamente pequeno e comentado: o valor didático do M9
 * está justamente em ver que "duração" é uma conta diferente em cada container.
 */

export type SoundMime = "audio/ogg" | "audio/wav" | "audio/mpeg";

export interface AudioProbe {
  /** mime CANÔNICO do container detectado — nunca o do request */
  mime: SoundMime;
  /** duração medida, arredondada para ms */
  durationMs: number;
}

/** Container reconhecido pelos primeiros bytes (nunca pela extensão). */
export type Container = "ogg" | "wav" | "mp3";

function ascii(buf: Buffer, start: number, end: number): string {
  return buf.length >= end ? buf.toString("latin1", start, end) : "";
}

/**
 * Magic bytes (doc do M9): "OggS", "RIFF"…"WAVE", e MP3 por "ID3" (tag v2 na
 * frente) ou pelo frame sync 0xFFE. Nada mais é aceito — um .png renomeado
 * para .ogg morre aqui, antes de qualquer parser.
 */
export function sniffContainer(buf: Buffer): Container | null {
  if (ascii(buf, 0, 4) === "OggS") return "ogg";
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 12) === "WAVE") return "wav";
  if (ascii(buf, 0, 3) === "ID3") return "mp3";
  if (buf.length >= 2 && buf[0] === 0xff && ((buf[1] ?? 0) & 0xe0) === 0xe0) return "mp3";
  return null;
}

const MIME_BY_CONTAINER: Record<Container, SoundMime> = {
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp3: "audio/mpeg",
};

/**
 * Sniffa e mede. Lança Error com frase curta em pt-BR (vira o corpo do 400 da
 * rota de upload) quando o arquivo não é de um dos três containers, está
 * truncado ou não tem áudio decodificável.
 */
export function probeAudio(buf: Buffer): AudioProbe {
  const container = sniffContainer(buf);
  if (container === null) {
    throw new Error("formato não reconhecido — envie ogg, wav ou mp3");
  }
  const durationMs =
    container === "ogg" ? probeOgg(buf) : container === "wav" ? probeWav(buf) : probeMp3(buf);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("não consegui medir a duração do arquivo");
  }
  return { mime: MIME_BY_CONTAINER[container], durationMs: Math.round(durationMs) };
}

// ---------------------------------------------------------------------------
// Ogg (Vorbis e Opus)
// ---------------------------------------------------------------------------

/** granule "sem pacote completo nesta página" (todos os bits em 1) */
const OGG_GRANULE_NONE = 0xffff_ffff_ffff_ffffn;

/**
 * Duração de um Ogg = granule position da ÚLTIMA página ÷ taxa de amostragem.
 * O granule é um contador de amostras já decodificadas, então a última página
 * carrega o total — não existe campo "duração" no container.
 *
 * A taxa sai do pacote de identificação, que é o primeiro pacote do stream:
 * - Vorbis: pacote 0x01 "vorbis", com sample_rate no offset 12;
 * - Opus:   "OpusHead", cujo granule é SEMPRE em 48 kHz (independente da taxa
 *   original) e traz um `pre-skip` de amostras de aquecimento a descontar.
 *
 * Percorrer as páginas uma a uma (em vez de procurar o último "OggS" de trás
 * para frente) é o que detecta truncamento: um arquivo cortado no meio acaba
 * numa página incompleta, ou sem a página de fim de stream (EOS).
 */
function probeOgg(buf: Buffer): number {
  let pos = 0;
  let serial: number | null = null;
  let rate = 0;
  let preSkip = 0;
  let opus = false;
  let lastGranule = 0n;
  let sawEos = false;

  while (pos < buf.length) {
    if (buf.length - pos < 27) throw new Error("Ogg truncado (cabeçalho de página incompleto)");
    if (buf.toString("latin1", pos, pos + 4) !== "OggS") throw new Error("Ogg inválido (página sem OggS)");
    if (buf[pos + 4] !== 0) throw new Error("Ogg de versão desconhecida");

    const headerType = buf[pos + 5] ?? 0;
    const pageSerial = buf.readUInt32LE(pos + 14);
    const segments = buf[pos + 26] ?? 0;
    const headerLen = 27 + segments;
    if (buf.length - pos < headerLen) throw new Error("Ogg truncado (tabela de segmentos incompleta)");
    let payloadLen = 0;
    for (let i = 0; i < segments; i++) payloadLen += buf[pos + 27 + i] ?? 0;
    if (buf.length - pos < headerLen + payloadLen) throw new Error("Ogg truncado (última página incompleta)");

    if (serial === null) {
      // primeira página = pacote de identificação do primeiro stream lógico
      serial = pageSerial;
      const head = buf.subarray(pos + headerLen, pos + headerLen + payloadLen);
      if (head.length >= 16 && head.toString("latin1", 0, 7) === "\x01vorbis") {
        rate = head.readUInt32LE(12);
      } else if (head.length >= 16 && head.toString("latin1", 0, 8) === "OpusHead") {
        opus = true;
        preSkip = head.readUInt16LE(10);
        rate = 48_000; // o granule do Opus é sempre 48 kHz, não a taxa de entrada
      } else {
        throw new Error("Ogg sem stream de Vorbis ou Opus");
      }
    }

    if (pageSerial === serial) {
      const granule = buf.readBigUInt64LE(pos + 6);
      // -1 = nenhum pacote TERMINA nesta página (pacote grande atravessando)
      if (granule !== OGG_GRANULE_NONE) lastGranule = granule;
      if ((headerType & 0x04) !== 0) sawEos = true;
    }
    pos += headerLen + payloadLen;
  }

  if (serial === null) throw new Error("Ogg sem páginas");
  // sem a página de fim de stream, o arquivo foi cortado num limite de página:
  // o granule que temos seria uma duração MENOR que a real
  if (!sawEos) throw new Error("Ogg truncado (sem página de fim de stream)");
  if (rate <= 0) throw new Error("Ogg sem taxa de amostragem");

  const samples = Number(lastGranule) - (opus ? preSkip : 0);
  return (samples / rate) * 1000;
}

// ---------------------------------------------------------------------------
// WAV (RIFF)
// ---------------------------------------------------------------------------

/**
 * Duração de um WAV = bytes do chunk `data` ÷ byte rate do chunk `fmt `. É a
 * conta mais direta dos três — PCM é fluxo constante.
 *
 * O tamanho do `data` é CLAMPADO pelos bytes que existem de verdade: um
 * cabeçalho pode declarar 1 GB num arquivo de 10 KB, e acreditar nele daria uma
 * duração inventada (para cima, o que passaria a checar limite errado).
 */
function probeWav(buf: Buffer): number {
  let pos = 12; // pula "RIFF" + tamanho + "WAVE"
  let byteRate = 0;
  let dataBytes = -1;

  while (pos + 8 <= buf.length) {
    const id = buf.toString("latin1", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;

    if (id === "fmt " && size >= 16 && body + 16 <= buf.length) {
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      byteRate = buf.readUInt32LE(body + 8);
      const bits = buf.readUInt16LE(body + 14);
      // alguns encoders zeram o byteRate: recompõe pelo resto do fmt
      if (byteRate === 0) byteRate = Math.floor((sampleRate * channels * bits) / 8);
    } else if (id === "data") {
      dataBytes = Math.min(size, buf.length - body);
      break; // o áudio começa aqui; o que vier depois não muda a duração
    }

    // chunks são alinhados em 2 bytes; o +8 garante que o laço sempre anda
    pos = body + size + (size % 2);
  }

  if (byteRate <= 0) throw new Error("WAV sem chunk fmt válido");
  if (dataBytes < 0) throw new Error("WAV sem chunk data");
  return (dataBytes / byteRate) * 1000;
}

// ---------------------------------------------------------------------------
// MP3 (MPEG 1/2/2.5 Layer I/II/III)
// ---------------------------------------------------------------------------

/** kbps por índice de bitrate, por (versão, layer) — 0 e 15 são inválidos */
const BITRATES_V1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0];
const BITRATES_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0];
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2_L1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0];
const BITRATES_V2_L23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
/** taxas por índice, por versão (3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5) */
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44_100, 48_000, 32_000],
  2: [22_050, 24_000, 16_000],
  0: [11_025, 12_000, 8_000],
};

interface Mp3Frame {
  lengthBytes: number;
  samples: number;
  sampleRate: number;
  /** offset do Xing/Info dentro do quadro (depende de versão e canais) */
  xingOffset: number;
}

/** Decodifica um cabeçalho de 4 bytes; null = não é um quadro válido aqui. */
function parseMp3Frame(buf: Buffer, at: number): Mp3Frame | null {
  if (at + 4 > buf.length) return null;
  const b0 = buf[at] ?? 0;
  const b1 = buf[at + 1] ?? 0;
  const b2 = buf[at + 2] ?? 0;
  const b3 = buf[at + 3] ?? 0;
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const version = (b1 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 1=reservado, 0=MPEG2.5
  const layerBits = (b1 >> 1) & 0x03; // 3=Layer I, 2=Layer II, 1=Layer III, 0=reservado
  if (version === 1 || layerBits === 0) return null;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const rateIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;

  const layer = 4 - layerBits; // 1, 2 ou 3
  const mpeg1 = version === 3;
  const table = mpeg1
    ? layer === 1
      ? BITRATES_V1_L1
      : layer === 2
        ? BITRATES_V1_L2
        : BITRATES_V1_L3
    : layer === 1
      ? BITRATES_V2_L1
      : BITRATES_V2_L23;
  const kbps = table[bitrateIndex] ?? 0;
  const sampleRate = SAMPLE_RATES[version]?.[rateIndex] ?? 0;
  if (kbps === 0 || sampleRate === 0) return null;

  const padding = (b2 >> 1) & 0x01;
  const bitrate = kbps * 1000;
  // Layer I conta em "slots" de 4 bytes; II e III em bytes
  const samples = layer === 1 ? 384 : layer === 2 ? 1152 : mpeg1 ? 1152 : 576;
  const lengthBytes =
    layer === 1
      ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
      : Math.floor((samples / 8) * (bitrate / sampleRate)) + padding;
  if (lengthBytes < 24) return null;

  const mono = ((b3 >> 6) & 0x03) === 3;
  const xingOffset = 4 + (mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17);
  return { lengthBytes, samples, sampleRate, xingOffset };
}

/**
 * Duração de um MP3 = soma da duração de cada quadro. Não há cabeçalho global
 * de duração: o formato é um fluxo de quadros auto-descritos, e com VBR a
 * conta "tamanho ÷ bitrate" mente feio.
 *
 * Dois cuidados que sempre pegam quem escreve isso pela primeira vez:
 * 1. ID3v2 no INÍCIO — é um bloco arbitrário antes do primeiro quadro (com
 *    tamanho em "syncsafe", 7 bits por byte); ler o quadro sem pular o ID3 dá
 *    lixo, e a tag pode até conter uma imagem com bytes que parecem sync.
 * 2. VBR — se o primeiro quadro carrega um Xing/Info com a contagem de quadros,
 *    ela resolve a duração direto; senão, caminhamos quadro a quadro.
 */
function probeMp3(buf: Buffer): number {
  let pos = 0;
  if (buf.toString("latin1", 0, 3) === "ID3" && buf.length >= 10) {
    const flags = buf[5] ?? 0;
    // tamanho syncsafe: 4 bytes de 7 bits úteis cada (o bit alto fica zerado
    // justamente para não parecer um frame sync)
    const size =
      ((buf[6] ?? 0) & 0x7f) * 0x20_0000 +
      ((buf[7] ?? 0) & 0x7f) * 0x4000 +
      ((buf[8] ?? 0) & 0x7f) * 0x80 +
      ((buf[9] ?? 0) & 0x7f);
    pos = 10 + size + ((flags & 0x10) !== 0 ? 10 : 0); // bit 4 = footer de 10 bytes
    if (pos >= buf.length) throw new Error("MP3 só com tag ID3, sem áudio");
  }

  // o primeiro quadro pode não começar exatamente onde a tag acabou (padding)
  let first: Mp3Frame | null = null;
  const scanLimit = Math.min(buf.length, pos + 64 * 1024);
  while (pos < scanLimit) {
    first = parseMp3Frame(buf, pos);
    if (first !== null) break;
    pos += 1;
  }
  if (first === null) throw new Error("MP3 sem quadro válido");

  // Xing (VBR) ou Info (CBR) escrito pelo encoder no primeiro quadro: o campo
  // de contagem de quadros dá a duração exata sem percorrer o arquivo
  const xingAt = pos + first.xingOffset;
  if (xingAt + 12 <= buf.length) {
    const tag = buf.toString("latin1", xingAt, xingAt + 4);
    if (tag === "Xing" || tag === "Info") {
      const flags = buf.readUInt32BE(xingAt + 4);
      if ((flags & 0x01) !== 0) {
        const frames = buf.readUInt32BE(xingAt + 8);
        if (frames > 0) return (frames * first.samples * 1000) / first.sampleRate;
      }
    }
  }

  // caminhada: quadro a quadro, somando amostras ÷ taxa de cada um (a taxa pode
  // variar entre quadros em teoria, e somar amostras "no geral" erraria)
  let ms = 0;
  let frames = 0;
  while (pos < buf.length) {
    const frame = parseMp3Frame(buf, pos);
    if (frame === null) {
      // lixo entre quadros (tag ID3v1 no fim, bytes de padding): tenta
      // ressincronizar por uma janela curta antes de desistir
      const resyncEnd = Math.min(buf.length, pos + 2048);
      let next = pos + 1;
      while (next < resyncEnd && parseMp3Frame(buf, next) === null) next += 1;
      if (next >= resyncEnd) break;
      pos = next;
      continue;
    }
    ms += (frame.samples * 1000) / frame.sampleRate;
    frames += 1;
    pos += frame.lengthBytes;
  }
  if (frames === 0) throw new Error("MP3 sem quadro válido");
  return ms;
}
