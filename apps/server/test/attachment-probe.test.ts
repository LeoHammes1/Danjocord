/**
 * Testes do provador de imagem dos anexos (M11b, item 89) — o irmão do
 * `sound-probe.test.ts` do M9.
 *
 * O que está sendo protegido aqui são duas promessas do servidor:
 *   1. o TIPO sai dos magic bytes, não da extensão nem do Content-Type — é o
 *      que impede um `.exe` (ou um SVG, que é XML e vira script no navegador)
 *      de ser servido como imagem na mesma origem do app;
 *   2. as DIMENSÕES saem do cabeçalho do arquivo, não do que o cliente declara
 *      — é o que faz o cliente reservar a caixa certa e não dar pulo de layout.
 *
 * Os arquivos são montados byte a byte no próprio teste, e não lidos de
 * fixtures: assim dá para construir exatamente o caso ruim (truncado no meio do
 * cabeçalho, DHT antes do SOF, VP8X com dimensão-1) sem procurar um arquivo do
 * mundo real que por acaso tenha aquele defeito.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "tsx/esm/api";

register();

const { probeImage, sniffImage } = await import("../src/attachments/probe.js");

// ---------------------------------------------------------------------------
// Construtores dos quatro formatos
// ---------------------------------------------------------------------------

function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); // tamanho do IHDR
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = 6; // color type RGBA
  return buf;
}

/**
 * JPEG com uma ARMADILHA de propósito: um segmento DHT (FFC4) antes do SOF.
 * FFC4 está no meio da faixa C0..CF, e um parser que só olhe "está entre C0 e
 * CF" leria os bytes do DHT como altura e largura — dando um número plausível
 * e errado. Os bytes do DHT abaixo são 0x0BB8 (3000), que não é nenhuma das
 * dimensões pedidas: se o teste ler 3000, o parser confundiu os dois.
 */
function jpeg(width: number, height: number, { comDht = true } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];

  const app0 = Buffer.alloc(18);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  app0.write("JFIF\0", 4, "latin1");
  parts.push(app0);

  if (comDht) {
    const dht = Buffer.alloc(8);
    dht.writeUInt16BE(0xffc4, 0);
    dht.writeUInt16BE(6, 2);
    dht.writeUInt16BE(0x0bb8, 4); // 3000 — o número que um parser ingênuo leria
    dht.writeUInt16BE(0x0bb8, 6);
    parts.push(dht);
  }

  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8; // precisão
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3; // componentes
  parts.push(sof);

  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function gif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "latin1");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function riff(chunkId: string, chunk: Buffer): Buffer {
  const body = Buffer.alloc(8 + chunk.length);
  body.write(chunkId, 0, "latin1");
  body.writeUInt32LE(chunk.length, 4);
  chunk.copy(body, 8);

  const out = Buffer.alloc(12 + body.length);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(4 + body.length, 4);
  out.write("WEBP", 8, "latin1");
  body.copy(out, 12);
  return out;
}

/** WebP com perda: o quadro-chave do VP8, com o código de sincronismo 9D 01 2A. */
function webpLossy(width: number, height: number): Buffer {
  const chunk = Buffer.alloc(10);
  chunk[0] = 0x9d; // (os 3 primeiros bytes são o frame tag; o conteúdo não importa aqui)
  chunk[3] = 0x9d;
  chunk[4] = 0x01;
  chunk[5] = 0x2a;
  chunk.writeUInt16LE(width, 6);
  chunk.writeUInt16LE(height, 8);
  return riff("VP8 ", chunk);
}

/** WebP sem perda: 14 bits de (largura-1) e 14 de (altura-1) empacotados. */
function webpLossless(width: number, height: number): Buffer {
  const chunk = Buffer.alloc(5);
  chunk[0] = 0x2f;
  chunk.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  return riff("VP8L", chunk);
}

/** WebP estendido (é o que carrega animação e alfa): dimensões-1 em 24 bits. */
function webpExtended(width: number, height: number): Buffer {
  const chunk = Buffer.alloc(10);
  chunk.writeUIntLE(width - 1, 4, 3);
  chunk.writeUIntLE(height - 1, 7, 3);
  return riff("VP8X", chunk);
}

// ---------------------------------------------------------------------------
// Dimensões dos quatro formatos
// ---------------------------------------------------------------------------

test("dimensões: PNG (IHDR)", () => {
  assert.deepEqual(probeImage(png(1920, 1080)), { mime: "image/png", width: 1920, height: 1080 });
  assert.deepEqual(probeImage(png(1, 1)), { mime: "image/png", width: 1, height: 1 });
});

test("dimensões: JPEG (SOF), sem confundir o DHT que vem antes", () => {
  const probe = probeImage(jpeg(800, 600));
  assert.deepEqual(probe, { mime: "image/jpeg", width: 800, height: 600 });
  // se o parser tivesse lido o DHT como SOF, teria dado 3000 (ver o construtor)
  assert.notEqual(probe.width, 3000);
  // e sem o DHT o resultado é o mesmo
  assert.deepEqual(probeImage(jpeg(800, 600, { comDht: false })), {
    mime: "image/jpeg",
    width: 800,
    height: 600,
  });
});

test("dimensões: GIF (descritor de tela, little-endian)", () => {
  assert.deepEqual(probeImage(gif(320, 240)), { mime: "image/gif", width: 320, height: 240 });
});

test("dimensões: WebP nas TRÊS formas (VP8, VP8L, VP8X)", () => {
  assert.deepEqual(probeImage(webpLossy(640, 480)), { mime: "image/webp", width: 640, height: 480 });
  assert.deepEqual(probeImage(webpLossless(640, 480)), { mime: "image/webp", width: 640, height: 480 });
  // VP8X é o caso do WebP ANIMADO, que é o mais comum em figurinha de chat
  assert.deepEqual(probeImage(webpExtended(1024, 768)), { mime: "image/webp", width: 1024, height: 768 });
});

// ---------------------------------------------------------------------------
// Arquivo truncado — o caso do upload interrompido
// ---------------------------------------------------------------------------

test("truncado: cada formato cortado no meio do cabeçalho vira erro, não dimensão inventada", () => {
  const casos: [string, Buffer][] = [
    ["PNG sem IHDR completo", png(100, 100).subarray(0, 20)],
    ["JPEG sem SOF", jpeg(100, 100).subarray(0, 12)],
    ["GIF sem descritor", gif(100, 100).subarray(0, 8)],
    ["WebP sem chunk", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])],
    ["WebP com VP8 cortado", webpLossy(100, 100).subarray(0, 18)],
    ["WebP com VP8L cortado", webpLossless(100, 100).subarray(0, 19)],
  ];
  for (const [nome, buf] of casos) {
    assert.throws(() => probeImage(buf), /truncado|sem chunk|não reconhecido|inválido/, nome);
  }
});

test("truncado: um PNG só com a assinatura não passa por PNG válido", () => {
  const assinatura = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // o sniff reconhece (a assinatura está lá), mas o provador recusa — é a
  // diferença entre "parece" e "é"
  assert.equal(sniffImage(assinatura), "png");
  assert.throws(() => probeImage(assinatura), /truncado/);
});

// ---------------------------------------------------------------------------
// O que NÃO é imagem
// ---------------------------------------------------------------------------

test(".exe renomeado para .png morre nos magic bytes", () => {
  // um PE do Windows de verdade começa com "MZ"
  const exe = Buffer.concat([Buffer.from("MZ\x90\x00\x03"), Buffer.alloc(1024, 0x41)]);
  assert.equal(sniffImage(exe), null, "MZ não é formato de imagem");
  assert.throws(() => probeImage(exe), /formato não reconhecido/);
});

test("SVG, HTML e ZIP renomeados também morrem (nenhum vira imagem)", () => {
  const casos: [string, Buffer][] = [
    // SVG é XML: servido como image/svg+xml na mesma origem, viraria script
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')],
    ["HTML", Buffer.from("<!doctype html><html><body>oi</body></html>")],
    ["ZIP", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])],
    ["PDF", Buffer.from("%PDF-1.7\n")],
    // um OGG válido: é arquivo bom, do formato ERRADO — a rota de anexo não é
    // a de soundboard
    ["OGG", Buffer.from("OggS\x00\x02\x00\x00\x00\x00")],
    ["vazio", Buffer.alloc(0)],
  ];
  for (const [nome, buf] of casos) {
    assert.equal(sniffImage(buf), null, `${nome} não pode ser reconhecido como imagem`);
    assert.throws(() => probeImage(buf), /formato não reconhecido/, nome);
  }
});

test("RIFF que NÃO é WEBP (um WAV) não passa por imagem", () => {
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")]);
  assert.equal(sniffImage(wav), null);
});

// ---------------------------------------------------------------------------
// Bomba de dimensão
// ---------------------------------------------------------------------------

test("cabeçalho que declara dimensão absurda é recusado (bomba de dimensão)", () => {
  // 33 bytes de PNG que fariam o cliente reservar uma caixa de 4 bilhões de px
  assert.throws(() => probeImage(png(4_000_000_000, 1)), /o teto é/);
  assert.throws(() => probeImage(png(50_000, 50_000)), /o teto é/);
  // e dimensão zero também não é imagem
  assert.throws(() => probeImage(png(0, 100)), /dimensão zero/);
});
