/**
 * Gerador de sons de UI por síntese (M12).
 * `pnpm --filter @danjocord/client sounds`.
 *
 * O QUE ELE PRODUZ HOJE
 * ---------------------
 * Dois arquivos: `stream-start.wav` e `error.wav` — ver `ACTIVE` lá embaixo.
 * Os outros 12 sons do catálogo vêm do Discord (ATTRIBUTIONS.md), e a lista de
 * origem simplesmente **não tem** equivalente para "alguém começou a
 * transmitir" nem para erro: o que sobra nela são toques de chamada (5 s e 22 s)
 * e navegação de menu. Som sem evento que o dispare não entra; evento sem som
 * também não pode ficar mudo. Estes dois preenchem o buraco.
 *
 * As receitas dos 14 continuam aqui, e de propósito: elas são o conjunto
 * COMPLETO e coerente que existia antes da troca, e o caminho de volta se um dia
 * o repositório precisar ser público (§3.8 do docs/som.md — a advertência de
 * distribuição está no ATTRIBUTIONS.md). `--all` regenera os 14 e SOBRESCREVE os
 * arquivos do Discord; sem a flag, só os de `ACTIVE`.
 *
 * POR QUE SINTETIZAR, E POR QUE .wav
 * ----------------------------------
 * Não há ffmpeg/oggenc nesta máquina e o projeto não instala dependência para
 * isto (a mesma regra que fez o upload do soundboard ser corpo binário cru em
 * vez de multipart). WAV PCM é o único formato que se escreve em 20 linhas sem
 * codec — e não há codec com perda no caminho, o que importa: transiente de 3 ms
 * é o pior caso de um codec por transformada (pré-eco).
 *
 * Som gerado aqui não tem licença nenhuma: é código deste repositório.
 *
 * A GRAMÁTICA DOS SONS (o que faz as receitas soarem como um conjunto)
 * -------------------------------------------------------------------
 *   - **Direção carrega significado** (docs/som.md §3.6): sobe = entrar,
 *     abrir, ligar; desce = sair, fechar, desligar. Os pares são o MESMO motivo
 *     invertido, com o timbre do sentido "fechado" mais escuro.
 *   - **Escala pentatônica em Dó** — nenhum par de sons do app forma intervalo
 *     dissonante, mesmo se dois tocarem juntos (e tocam: entrar num canal
 *     dispara o join e o unmute quase junto).
 *   - **Senoide + 2º/3º harmônico**, nunca dente-de-serra/quadrada: harmônico
 *     alto em clipe curto é o que produz o "bip de brinquedo".
 *   - **Parciais agudos decaem mais rápido** (`decayScale`) — é o que qualquer
 *     corpo físico faz, e é o que separa "sino" de "oscilador".
 *   - **Ataque em cosseno levantado de 3–6 ms**, nunca degrau: degrau é clique.
 *   - **Transiente de ruído opcional** de 2–4 ms, filtrado: é ele que dá
 *     presença sem levantar o nível médio.
 *   - **Ruído por PRNG semeado pelo NOME do som**: rodar duas vezes dá arquivos
 *     iguais, e mexer numa receita não mexe nas outras.
 *
 * O GANHO NÃO SAI DAQUI. Quem mede é `scripts/measure-sounds.mjs`, para os 14
 * igualmente — arquivo do Discord e arquivo gerado passam pelo mesmo
 * decodificador e pela mesma conta.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 48_000;
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "sounds");

// ---------------------------------------------------------------------------
// Primitivas
// ---------------------------------------------------------------------------

/** PRNG determinístico (mulberry32) — build reprodutível, ver cabeçalho. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** FNV-1a do nome do som: cada receita tem a SUA sequência de ruído. */
function seedOf(name) {
  let h = 2_166_136_261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

/**
 * Uma nota: soma de parciais senoidais com envelope ataque-cosseno + decaimento
 * exponencial. `freqEnd` faz glissando exponencial (em oitavas por segundo, que
 * é como o ouvido mede altura) durante `glide` segundos.
 */
function tone(out, v) {
  const { start = 0, freq, freqEnd = null, glide = 0.08, amp = 1, attack = 0.005, tau = 0.06, partials } = v;
  const i0 = Math.round(start * SAMPLE_RATE);
  const phases = partials.map(() => 0);
  for (let i = Math.max(0, i0); i < out.length; i++) {
    const t = (i - i0) / SAMPLE_RATE;
    const f = freqEnd === null ? freq : freq * (freqEnd / freq) ** (Math.min(t, glide) / glide);
    const rise = t < attack ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attack) : null;
    let s = 0;
    for (let p = 0; p < partials.length; p++) {
      const [ratio, pAmp, decayScale = 1] = partials[p];
      phases[p] += (2 * Math.PI * f * ratio) / SAMPLE_RATE;
      const env = rise ?? Math.exp(-(t - attack) / (tau * decayScale));
      s += Math.sin(phases[p]) * pAmp * env;
    }
    out[i] += s * amp;
  }
}

/**
 * Transiente de ruído: passa-alta + passa-baixa de um polo cada, decaimento
 * rápido. É o "toque" do som — sem ele um clipe de senoide pura soa mole; com
 * ele soa como algo que ACONTECEU.
 */
function noiseBurst(out, n, rand) {
  const { start = 0, amp = 0.05, tau = 0.004, hp = 2500, lp = 9000 } = n;
  const i0 = Math.max(0, Math.round(start * SAMPLE_RATE));
  const aHp = Math.exp((-2 * Math.PI * hp) / SAMPLE_RATE);
  const aLp = 1 - Math.exp((-2 * Math.PI * lp) / SAMPLE_RATE);
  const end = Math.min(out.length, i0 + Math.ceil(tau * 9 * SAMPLE_RATE));
  let xPrev = 0;
  let yHp = 0;
  let yLp = 0;
  for (let i = i0; i < end; i++) {
    const t = (i - i0) / SAMPLE_RATE;
    const x = rand() * 2 - 1;
    yHp = aHp * (yHp + x - xPrev);
    xPrev = x;
    yLp += (yHp - yLp) * aLp;
    // 0.5 ms de subida: o próprio burst não pode começar num degrau
    const rise = t < 0.0005 ? t / 0.0005 : 1;
    out[i] += yLp * amp * rise * Math.exp(-t / tau);
  }
}

/**
 * Passa-baixa de dois polos, com corte varrendo exponencialmente de `from` a
 * `to` ao longo de `over` segundos. A varredura é o que faz o `self-deafen`
 * soar como algo se FECHANDO em vez de só descer de tom — é o mesmo gesto de
 * pôr a mão no ouvido.
 */
function lowpass(buf, from, to = from, over = null) {
  const span = over === null ? Math.max(1, buf.length) : Math.max(1, Math.round(over * SAMPLE_RATE));
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const fc = from * (to / from) ** (Math.min(i, span) / span);
    const a = 1 - Math.exp((-2 * Math.PI * fc) / SAMPLE_RATE);
    y1 += (buf[i] - y1) * a;
    y2 += (y1 - y2) * a;
    buf[i] = y2;
  }
}

/**
 * Normaliza para o pico alvo e corta a cauda inaudível.
 *
 * O corte não é economia de bytes (embora seja): o ganho do catálogo sai do RMS
 * do arquivo INTEIRO, então cauda longa em silêncio derruba o RMS e faz o som
 * ser levantado demais no playback. Cortar em -40 dB do pico — que, com o clipe
 * tocando perto de -20 dBFS, é -60 dBFS de verdade — mantém a medida honesta.
 */
function finalize(buf, { peak = 0.89, tailDb = -40, fade = 0.02 } = {}) {
  let max = 0;
  for (const v of buf) max = Math.max(max, Math.abs(v));
  if (max === 0) throw new Error("receita produziu silêncio");
  for (let i = 0; i < buf.length; i++) buf[i] *= peak / max;

  const floor = peak * 10 ** (tailDb / 20);
  let last = buf.length - 1;
  while (last > 0 && Math.abs(buf[last]) < floor) last--;

  const fadeN = Math.round(fade * SAMPLE_RATE);
  const out = buf.subarray(0, Math.min(buf.length, last + fadeN + 1));
  const from = Math.max(0, out.length - fadeN);
  for (let i = from; i < out.length; i++) {
    out[i] *= 0.5 + 0.5 * Math.cos((Math.PI * (i - from)) / (out.length - from));
  }
  return out;
}

/** Float -> int16. O playback do navegador lê de volta como v/32768. */
function quantize(samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32_767);
  }
  return pcm;
}

/** RIFF/WAVE PCM 16 bits mono. 44 bytes de cabeçalho e os dados. */
function wav16(pcm) {
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + pcm.length * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // tamanho do bloco fmt
  buf.writeUInt16LE(1, 20); // 1 = PCM sem compressão
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // bytes por segundo
  buf.writeUInt16LE(2, 32); // alinhamento de bloco
  buf.writeUInt16LE(16, 34); // bits por amostra
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

// ---------------------------------------------------------------------------
// A paleta: escala e timbres. Tudo o que as receitas usam sai daqui — é o que
// mantém os 14 parecidos entre si.
// ---------------------------------------------------------------------------

/** Dó maior pentatônica (temperamento igual, Lá4 = 440 Hz). */
const N = {
  D4: 293.66,
  F4: 349.23,
  C5: 523.25,
  D5: 587.33,
  F5: 698.46,
  G5: 783.99,
  A5: 880.0,
  C6: 1046.5,
  D6: 1174.66,
  E6: 1318.51,
};

// [razão do parcial, amplitude, fator do tempo de decaimento]
const ROUND = [[1, 1], [2, 0.28, 0.6], [3, 0.07, 0.45]]; // o timbre padrão da casa
const DARK = [[1, 1], [2, 0.15, 0.55]]; // o mesmo, "fechado" — sentido de desligar
const BRIGHT = [[1, 1], [2, 0.32, 0.6], [3, 0.14, 0.45], [4, 0.05, 0.35]];
const BELL = [[1, 1], [2.0, 0.3, 0.55], [3.01, 0.13, 0.4], [4.17, 0.06, 0.3]]; // parciais inarmônicos = sino
const BODY = [[1, 1], [2, 0.35, 0.6], [3, 0.1, 0.4]]; // grave com corpo, para o `error`

// ---------------------------------------------------------------------------
// As 14 receitas
// ---------------------------------------------------------------------------

const RECIPES = {
  "voice-join": {
    why: "sobe uma quarta (Sol5→Dó6): chegada. Timbre redondo, com transiente para soar presente sem ser alto.",
    length: 0.7,
    voices: [
      { start: 0, freq: N.G5, amp: 0.85, attack: 0.006, tau: 0.065, partials: ROUND },
      { start: 0.075, freq: N.C6, amp: 1.0, attack: 0.005, tau: 0.09, partials: ROUND },
    ],
    noises: [{ start: 0, amp: 0.07, tau: 0.004, hp: 2500 }],
    lowpass: { from: 9000 },
  },

  "voice-leave": {
    why: "o MESMO motivo ao contrário (Dó6→Sol5) e um timbre mais escuro: sair fecha, entrar abre.",
    length: 0.7,
    voices: [
      { start: 0, freq: N.C6, amp: 0.9, attack: 0.006, tau: 0.055, partials: DARK },
      { start: 0.075, freq: N.G5, amp: 1.0, attack: 0.006, tau: 0.085, partials: DARK },
    ],
    lowpass: { from: 5000 },
  },

  "stream-start": {
    why: "tríade ascendente (Sol5-Dó6-Mi6): três notas é 'anúncio', duas é 'estado'. Mais brilhante que o join, para não se confundir com ele.",
    length: 0.75,
    voices: [
      { start: 0, freq: N.G5, amp: 0.7, attack: 0.005, tau: 0.05, partials: BRIGHT },
      { start: 0.07, freq: N.C6, amp: 0.8, attack: 0.004, tau: 0.05, partials: BRIGHT },
      { start: 0.14, freq: N.E6, amp: 1.0, attack: 0.004, tau: 0.085, partials: BRIGHT },
    ],
    noises: [{ start: 0, amp: 0.07, tau: 0.003, hp: 3000 }],
    lowpass: { from: 11000 },
  },

  message: {
    why: "uma nota só, timbre de sino, decaimento curto. Mensagem é o som mais frequente que vem de fora — tem que ser notado e esquecido no mesmo instante.",
    length: 0.55,
    voices: [{ start: 0, freq: N.C6, amp: 1.0, attack: 0.003, tau: 0.075, partials: BELL }],
    noises: [{ start: 0, amp: 0.08, tau: 0.0025, hp: 2500 }],
    lowpass: { from: 10000 },
  },

  mention: {
    why: "DUAS batidas de sino subindo uma terça (Dó6→Mi6). O que separa de `message` não é o volume, é a contagem: uma batida é recado, duas é alguém te chamando.",
    length: 0.75,
    voices: [
      { start: 0, freq: N.C6, amp: 0.9, attack: 0.003, tau: 0.07, partials: BELL },
      { start: 0.125, freq: N.E6, amp: 1.0, attack: 0.003, tau: 0.085, partials: BELL },
    ],
    noises: [
      { start: 0, amp: 0.08, tau: 0.0025, hp: 3000 },
      { start: 0.125, amp: 0.08, tau: 0.0025, hp: 3000 },
    ],
    lowpass: { from: 11000 },
  },

  "self-mute": {
    why: "Lá5→Ré5, curto e abafado. É resposta a um clique meu: quanto mais seco, mais parece o botão respondendo.",
    length: 0.35,
    voices: [
      { start: 0, freq: N.A5, amp: 0.9, attack: 0.004, tau: 0.032, partials: DARK },
      { start: 0.055, freq: N.D5, amp: 1.0, attack: 0.004, tau: 0.042, partials: DARK },
    ],
    lowpass: { from: 2600 },
  },

  "self-unmute": {
    why: "o espelho exato (Ré5→Lá5) com o timbre aberto — o par mais usado do app, e o que mais precisa ser distinguível de ouvido.",
    length: 0.35,
    voices: [
      { start: 0, freq: N.D5, amp: 0.9, attack: 0.004, tau: 0.032, partials: ROUND },
      { start: 0.055, freq: N.A5, amp: 1.0, attack: 0.004, tau: 0.045, partials: ROUND },
    ],
    lowpass: { from: 6000 },
  },

  "self-deafen": {
    why: "Sol5→Dó5 com o filtro FECHANDO de 7 kHz para 800 Hz. A varredura é o gesto: não é só grave, é abafado — a mão no ouvido.",
    length: 0.55,
    voices: [
      { start: 0, freq: N.G5, amp: 0.9, attack: 0.005, tau: 0.045, partials: ROUND },
      { start: 0.07, freq: N.C5, amp: 1.0, attack: 0.005, tau: 0.075, partials: ROUND },
    ],
    lowpass: { from: 7000, to: 800, over: 0.28 },
  },

  "self-undeafen": {
    why: "espelho: Dó5→Sol5 com o filtro ABRINDO. Tocado no instante em que o deafen ainda vale (policy.ts) — é justamente o som que prova que `self` escapa do deafen.",
    length: 0.55,
    voices: [
      { start: 0, freq: N.C5, amp: 0.9, attack: 0.005, tau: 0.045, partials: ROUND },
      { start: 0.07, freq: N.G5, amp: 1.0, attack: 0.005, tau: 0.075, partials: ROUND },
    ],
    lowpass: { from: 900, to: 8000, over: 0.22 },
  },

  "ptt-on": {
    why: "Ré6, ~100 ms, uma nota. É o som que mais dispara no app inteiro e toca NO MEIO da fala: qualquer coisa mais longa vira gagueira.",
    quieterDb: -5,
    length: 0.2,
    voices: [{ start: 0, freq: N.D6, amp: 1.0, attack: 0.0025, tau: 0.018, partials: [[1, 1], [2, 0.16, 0.5]] }],
    noises: [{ start: 0, amp: 0.1, tau: 0.002, hp: 3000 }],
    lowpass: { from: 8000 },
  },

  "ptt-off": {
    why: "Lá5 — o mesmo gesto uma quarta abaixo. Mesma duração: o par tem que ser simétrico no tempo, senão soltar a tecla parece mais lento que apertar.",
    quieterDb: -5,
    length: 0.2,
    voices: [{ start: 0, freq: N.A5, amp: 1.0, attack: 0.0025, tau: 0.02, partials: [[1, 1], [2, 0.12, 0.5]] }],
    noises: [{ start: 0, amp: 0.1, tau: 0.002, hp: 2500 }],
    lowpass: { from: 6000 },
  },

  disconnected: {
    why: "três notas DESCENDO (Lá5-Fá5-Ré5), escuro e um pouco mais lento. Três notas porque é aviso, não estado; descendo porque é perda.",
    length: 0.9,
    voices: [
      { start: 0, freq: N.A5, amp: 0.8, attack: 0.006, tau: 0.045, partials: DARK },
      { start: 0.095, freq: N.F5, amp: 0.9, attack: 0.006, tau: 0.045, partials: DARK },
      { start: 0.19, freq: N.D5, amp: 1.0, attack: 0.006, tau: 0.085, partials: DARK },
    ],
    lowpass: { from: 3200 },
  },

  reconnected: {
    why: "o espelho de `disconnected` (Ré5-Lá5-Ré6), aberto e resolvendo na oitava. Quem ouviu o de cima reconhece este sem aprender.",
    length: 0.85,
    voices: [
      { start: 0, freq: N.D5, amp: 0.8, attack: 0.005, tau: 0.045, partials: ROUND },
      { start: 0.085, freq: N.A5, amp: 0.9, attack: 0.005, tau: 0.045, partials: ROUND },
      { start: 0.17, freq: N.D6, amp: 1.0, attack: 0.005, tau: 0.08, partials: ROUND },
    ],
    lowpass: { from: 9000 },
  },

  error: {
    why: "duas batidas graves com glissando para BAIXO (Fá4→Ré4). Erro não precisa ser feio para ser entendido: o que diz 'não' é a queda repetida, não a dissonância.",
    length: 0.6,
    voices: [
      { start: 0, freq: N.F4, freqEnd: N.D4, glide: 0.09, amp: 0.85, attack: 0.005, tau: 0.05, partials: BODY },
      { start: 0.115, freq: N.F4, freqEnd: N.D4, glide: 0.09, amp: 1.0, attack: 0.005, tau: 0.065, partials: BODY },
    ],
    lowpass: { from: 2200 },
  },
};

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Renderiza uma receita e devolve o PCM 16 bits pronto para o arquivo. */
export function render(name) {
  const recipe = RECIPES[name];
  if (recipe === undefined) throw new Error(`receita desconhecida: ${name}`);
  const buf = new Float32Array(Math.ceil(recipe.length * SAMPLE_RATE));
  const rand = mulberry32(seedOf(name));
  for (const v of recipe.voices) tone(buf, v);
  for (const n of recipe.noises ?? []) noiseBurst(buf, n, rand);
  if (recipe.lowpass !== undefined) {
    lowpass(buf, recipe.lowpass.from, recipe.lowpass.to ?? recipe.lowpass.from, recipe.lowpass.over ?? null);
  }
  return quantize(finalize(buf));
}

export const NAMES = Object.keys(RECIPES);

/**
 * As receitas que viram arquivo na rodada normal. Uma fonte só: o
 * `sound-assets.test.ts` importa esta lista e confere que ela é exatamente o
 * conjunto de sons cujo arquivo no catálogo é .wav — assim "adicionei uma
 * receita e esqueci de gerar" e "gerei um arquivo que ninguém usa" reprovam.
 */
export const ACTIVE = ["stream-start", "error"];

export { RECIPES, SAMPLE_RATE, wav16 };

function main() {
  const todos = process.argv.includes("--all");
  const alvos = todos ? NAMES : ACTIVE;
  if (todos) {
    console.log("--all: regenerando os 14 e SOBRESCREVENDO os .mp3 do Discord pelos sintetizados.");
    console.log("       (o catálogo aponta para .mp3 nos 12 — troque as extensões lá também)");
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const rows = [];
  for (const name of alvos) {
    const pcm = render(name);
    const bytes = wav16(pcm);
    writeFileSync(path.join(OUT_DIR, `${name}.wav`), bytes);
    rows.push({
      som: name,
      ms: Math.round((pcm.length / SAMPLE_RATE) * 1000),
      KB: +(bytes.length / 1024).toFixed(1),
      dB_intencao: RECIPES[name].quieterDb ?? 0,
    });
  }
  console.table(rows);
  console.log("agora rode `pnpm --filter @danjocord/client sounds:measure` — o ganho sai de lá.");
}

// só executa quando chamado direto (o teste importa `render`/`measure`)
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
