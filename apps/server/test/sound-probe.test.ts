/**
 * Testes do provador de áudio do M9 (apps/server/src/sounds/probe.ts) e das
 * janelas de rate limit. É a peça mais "algoritmo puro" do servidor: nenhum
 * Fastify, nenhum banco — buffer entra, duração sai.
 *
 * Os arquivos de teste são GERADOS aqui: WAV e MP3 dá para montar à mão (e
 * montar é justamente o que prova que o parser lê os campos certos); para Ogg
 * usamos um dos 9 embutidos, que é Ogg/Vorbis de verdade — forjar um Ogg
 * válido à mão seria reimplementar um encoder.
 *
 * O runner é o node:test nativo; o código de src importa com sufixo ".js"
 * (NodeNext) e o type stripping do Node NÃO remapeia ".js" → ".ts", por isso os
 * hooks do tsx e o import dinâmico (mesmo padrão das outras suítes).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { register } from "tsx/esm/api";

register();

const { probeAudio, sniffContainer } = await import("../src/sounds/probe.js");
const { SlidingWindow, clampGain, MIN_GAIN, MAX_GAIN } = await import("../src/sounds/limits.js");

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "soundboard");

// ---------------------------------------------------------------------------
// Forjadores (o equivalente, aqui, aos rtpParameters forjados do voice.test.ts)
// ---------------------------------------------------------------------------

/** WAV PCM com `ms` de silêncio — o cabeçalho é o que interessa ao parser. */
function makeWav(ms: number, { rate = 44_100, channels = 1, bits = 16 } = {}): Buffer {
  const byteRate = (rate * channels * bits) / 8;
  const dataLen = Math.round((byteRate * ms) / 1000);
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "latin1");
  buf.write("fmt ", 12, "latin1");
  buf.writeUInt32LE(16, 16); // tamanho do fmt (PCM)
  buf.writeUInt16LE(1, 20); // formato 1 = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE((channels * bits) / 8, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36, "latin1");
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

/**
 * MP3 MPEG1 Layer III, 128 kbps, 44,1 kHz, estéreo: cabeçalho FF FB 90 00 e
 * quadro de 417 bytes (floor(1152/8 × 128000/44100)), 1152 amostras cada —
 * 26,122 ms por quadro. Com `id3` na frente e/ou `Xing` no primeiro quadro,
 * que é onde os dois cuidados do parser aparecem.
 */
const MP3_FRAME_BYTES = 417;
const MP3_FRAME_MS = (1152 * 1000) / 44_100;

function makeMp3(frames: number, { id3 = false, xing = false } = {}): Buffer {
  const parts: Buffer[] = [];
  if (id3) {
    // tag de 50 bytes de corpo, tamanho em syncsafe (7 bits por byte)
    const tag = Buffer.alloc(10 + 50);
    tag.write("ID3", 0, "latin1");
    tag[3] = 3; // versão 2.3
    tag[9] = 50;
    parts.push(tag);
  }
  for (let i = 0; i < frames; i++) {
    const frame = Buffer.alloc(MP3_FRAME_BYTES);
    frame[0] = 0xff;
    frame[1] = 0xfb; // MPEG1, Layer III, sem CRC
    frame[2] = 0x90; // 128 kbps, 44,1 kHz, sem padding
    frame[3] = 0x00; // estéreo
    if (i === 0 && xing) {
      // MPEG1 estéreo: o Xing mora 36 bytes depois do início do quadro
      frame.write("Xing", 36, "latin1");
      frame.writeUInt32BE(0x01, 40); // flag "tem contagem de quadros"
      frame.writeUInt32BE(frames, 44);
    }
    parts.push(frame);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Sniff por magic bytes
// ---------------------------------------------------------------------------

test("sniff é por MAGIC BYTES: .png renomeado para .ogg não passa", () => {
  // PNG de verdade começa com 89 50 4E 47 0D 0A 1A 0A — o nome do arquivo e o
  // Content-Type do request são texto escolhido por quem sobe, e não entram na
  // decisão em lugar nenhum
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(2048, 0x42),
  ]);
  assert.equal(sniffContainer(png), null, "PNG não é container de áudio");
  assert.throws(() => probeAudio(png), /formato não reconhecido/);
});

test("sniff reconhece os três containers pelos primeiros bytes", () => {
  assert.equal(sniffContainer(readFileSync(join(assetsDir, "ping.ogg"))), "ogg");
  assert.equal(sniffContainer(makeWav(100)), "wav");
  assert.equal(sniffContainer(makeMp3(2)), "mp3");
  assert.equal(sniffContainer(makeMp3(2, { id3: true })), "mp3", "ID3v2 na frente ainda é mp3");
  assert.equal(sniffContainer(Buffer.alloc(0)), null, "buffer vazio não é nada");
  assert.equal(sniffContainer(Buffer.from("nem de longe um arquivo de áudio")), null);
});

// ---------------------------------------------------------------------------
// Ogg
// ---------------------------------------------------------------------------

test("Ogg: os 9 embutidos medem duração plausível de pad (< 1 s) e viram audio/ogg", () => {
  const embutidos = [
    "fanfarra.ogg",
    "deu-ruim.ogg",
    "buzina.ogg",
    "cristal.ogg",
    "scratch.ogg",
    "hein.ogg",
    "subiu.ogg",
    "caiu.ogg",
    "ping.ogg",
  ];
  for (const file of embutidos) {
    const probe = probeAudio(readFileSync(join(assetsDir, file)));
    assert.equal(probe.mime, "audio/ogg", `${file}: mime canônico do container`);
    assert.ok(
      probe.durationMs > 50 && probe.durationMs < 1000,
      `${file}: ${probe.durationMs} ms fora do esperado para um pad`,
    );
  }
});

test("Ogg TRUNCADO é recusado (a granule da última página seria uma mentira)", () => {
  const inteiro = readFileSync(join(assetsDir, "fanfarra.ogg"));
  // corte no meio: acaba numa página incompleta
  assert.throws(() => probeAudio(inteiro.subarray(0, Math.floor(inteiro.length / 2))), /truncado/i);
  // só o cabeçalho da primeira página: nem o pacote de identificação cabe
  assert.throws(() => probeAudio(inteiro.subarray(0, 20)), /truncado/i);
  // capture pattern certo, resto lixo
  assert.throws(() => probeAudio(Buffer.from("OggS e mais nada que preste")), /Ogg/);
});

test("Ogg com codec desconhecido no pacote de identificação → recusa", () => {
  const inteiro = Buffer.from(readFileSync(join(assetsDir, "ping.ogg")));
  // estraga o "\x01vorbis" do primeiro pacote (o cabeçalho de página fica válido)
  inteiro.write("XXXXXXX", 27 + inteiro[26]!, "latin1");
  assert.throws(() => probeAudio(inteiro), /Vorbis ou Opus/);
});

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

test("WAV: duração = bytes do data ÷ byte rate do fmt (mono e estéreo, 16 e 8 bits)", () => {
  assert.deepEqual(probeAudio(makeWav(1500)), { mime: "audio/wav", durationMs: 1500 });
  assert.equal(probeAudio(makeWav(2500, { channels: 2 })).durationMs, 2500, "estéreo dobra bytes E byte rate");
  assert.equal(probeAudio(makeWav(800, { bits: 8, rate: 22_050 })).durationMs, 800);
  // acima do teto do M9 o parser NÃO reclama: medir e limitar são papéis
  // diferentes (quem recusa 6 s é a rota, com a mensagem certa)
  assert.equal(probeAudio(makeWav(6000)).durationMs, 6000);
});

test("WAV mentiroso: data declarando mais bytes do que existem é CLAMPADO", () => {
  const wav = makeWav(1000);
  // 1 GB declarado num arquivo de ~88 KB: acreditar daria duração inventada
  wav.writeUInt32LE(1_000_000_000, 40);
  const probe = probeAudio(wav);
  assert.ok(probe.durationMs <= 1000, `duração deveria vir dos bytes reais, veio ${probe.durationMs}`);
});

test("WAV sem fmt ou sem data → recusa", () => {
  const semData = makeWav(500).subarray(0, 36); // corta antes do chunk data
  assert.throws(() => probeAudio(semData), /WAV sem chunk/);
  const semFmt = Buffer.alloc(44);
  semFmt.write("RIFF", 0, "latin1");
  semFmt.write("WAVE", 8, "latin1");
  semFmt.write("data", 12, "latin1");
  semFmt.writeUInt32LE(16, 16);
  assert.throws(() => probeAudio(semFmt), /fmt/);
});

// ---------------------------------------------------------------------------
// MP3
// ---------------------------------------------------------------------------

test("MP3 CBR: soma quadro a quadro (100 quadros = 2,61 s)", () => {
  const probe = probeAudio(makeMp3(100));
  assert.equal(probe.mime, "audio/mpeg");
  assert.equal(probe.durationMs, Math.round(100 * MP3_FRAME_MS));
});

test("MP3 com ID3v2 na frente: a tag é PULADA (senão o primeiro quadro vira lixo)", () => {
  const semTag = probeAudio(makeMp3(60)).durationMs;
  const comTag = probeAudio(makeMp3(60, { id3: true })).durationMs;
  assert.equal(comTag, semTag, "a tag não pode entrar na conta da duração");
});

test("MP3 com Xing (VBR): a contagem de quadros resolve direto", () => {
  const probe = probeAudio(makeMp3(40, { xing: true }));
  assert.equal(probe.durationMs, Math.round(40 * MP3_FRAME_MS));
});

test("MP3 sem quadro válido → recusa (0xFF solto não é sync)", () => {
  // começa com FF Ex (passa no sniff) mas nenhum cabeçalho fecha: bitrate 15
  const falso = Buffer.alloc(4096, 0x00);
  falso[0] = 0xff;
  falso[1] = 0xfb;
  falso[2] = 0xf0; // índice de bitrate 15 = inválido
  assert.throws(() => probeAudio(falso), /quadro válido/);
});

test("MP3 que é só tag ID3, sem áudio → recusa", () => {
  const tag = Buffer.alloc(10 + 50);
  tag.write("ID3", 0, "latin1");
  tag[3] = 3;
  tag[9] = 50;
  assert.throws(() => probeAudio(tag), /ID3|quadro válido/);
});

// ---------------------------------------------------------------------------
// Limites: ganho clampado e janelas deslizantes
// ---------------------------------------------------------------------------

test("clampGain segura o ganho na faixa útil (cliente modificado não estoura ouvido)", () => {
  assert.equal(clampGain(undefined), 1, "sem ganho declarado = 1.0");
  assert.equal(clampGain(0.7), 0.7, "valor sensato passa intacto");
  assert.equal(clampGain(50), MAX_GAIN, "gain 50 viraria grito");
  assert.equal(clampGain(0), MIN_GAIN);
  assert.equal(clampGain(-3), MIN_GAIN);
  assert.equal(clampGain(Number.NaN), 1, "NaN cai no default, não vira silêncio");
  assert.equal(clampGain(Number.POSITIVE_INFINITY), 1);
});

test("SlidingWindow: consulta e consumo são separados (o 429 de uma janela não gasta a outra)", () => {
  const janela = new SlidingWindow(1, 2000);
  const t0 = 1_000_000;
  assert.equal(janela.retryAfterMs("alice", t0), 0, "primeira vez sempre libera");
  assert.equal(janela.retryAfterMs("alice", t0), 0, "consultar NÃO consome vaga");
  janela.record("alice", t0);
  assert.equal(janela.retryAfterMs("alice", t0), 2000, "consumida: falta a janela inteira");
  assert.equal(janela.retryAfterMs("alice", t0 + 1500), 500, "o tempo que falta encolhe");
  assert.equal(janela.retryAfterMs("bob", t0), 0, "a janela é POR CHAVE");
  assert.equal(janela.retryAfterMs("alice", t0 + 2001), 0, "passada a janela, libera de novo");
});

test("SlidingWindow com limite > 1 (o teto por canal) libera na vaga mais antiga", () => {
  const janela = new SlidingWindow(3, 10_000);
  const t0 = 5_000_000;
  janela.record("canal", t0);
  janela.record("canal", t0 + 1000);
  janela.record("canal", t0 + 2000);
  assert.equal(janela.retryAfterMs("canal", t0 + 3000), 7000, "espera a PRIMEIRA vaga expirar");
  assert.equal(janela.retryAfterMs("canal", t0 + 10_001), 0, "a mais antiga saiu da janela");
});
