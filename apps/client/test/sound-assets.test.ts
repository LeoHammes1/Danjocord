/**
 * Os 14 assets de som (M12) — e o único teste do projeto que olha arquivo de
 * mídia.
 *
 * POR QUE ELE PASSOU A EXISTIR. O contrato do M8 sempre foi "trocar um som é
 * trocar o arquivo E recalcular o ganho" (docs/som.md §3.1). Só que a segunda
 * metade vivia como uma RECEITA para colar no console do navegador
 * (ATTRIBUTIONS.md): ninguém a rodava sem querer, e esquecê-la produz o pior
 * tipo de defeito — o som toca, não há erro nenhum, e o nível fica errado até
 * alguém reclamar.
 *
 * COMO ELE CONSEGUE, SEM DECODIFICAR NADA. Medir exige decodificar, e o Node
 * não decodifica .mp3. Quem mede é `scripts/measure-sounds.mjs`, no Chromium do
 * Electron, e deixa o resultado em `assets/sounds/measured.json`. O que amarra
 * as duas pontas é o **sha256**: o teste confere que a medição descreve os
 * arquivos que estão no disco AGORA. Sem isso, `measured.json` seria uma
 * promessa — trocar um clipe sem re-medir passaria batido.
 *
 * As três perguntas, então, ficam respondidas em `node --test`:
 *   1. o measured.json fala DESTES arquivos?          → sha256
 *   2. o catálogo copiou o número de lá?              → gain
 *   3. o conjunto está completo, sem órfão?           → catálogo × pasta
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ACTIVE, RECIPES } from "../scripts/gen-sounds.mjs";
import { CATALOG, SOUND_NAMES } from "../src/sound/catalog.js";

const SOUNDS_DIR = fileURLToPath(new URL("../assets/sounds/", import.meta.url));
const AUDIO = /\.(mp3|wav|ogg|oga|opus|m4a|flac)$/i;

interface Medida {
  file: string;
  sha256: string;
  bytes: number;
  canais: number;
  taxa: number;
  ms: number;
  ms_ativos: number;
  rms: number;
  pico: number;
  quieter_db: number;
  gain: number;
}

const medido: { alvo_rms_dbfs: number; teto_pico: number; sons: Medida[] } = JSON.parse(
  readFileSync(SOUNDS_DIR + "measured.json", "utf8"),
);
const POR_ARQUIVO = new Map(medido.sons.map((s) => [s.file, s]));

function bytesDe(file: string): Buffer {
  return readFileSync(SOUNDS_DIR + file);
}

const REMEDIR = "rode `pnpm --filter @danjocord/client sounds:measure`";

test("o catálogo e a pasta de assets descrevem o MESMO conjunto", () => {
  const naPasta = readdirSync(SOUNDS_DIR)
    .filter((f) => AUDIO.test(f))
    .sort();
  const noCatalogo = SOUND_NAMES.map((n) => CATALOG[n].file).sort();
  assert.deepEqual(naPasta, noCatalogo, "arquivo de áudio órfão em assets/sounds, ou som do catálogo sem arquivo");
});

test("o measured.json descreve os arquivos que estão no disco AGORA (sha256)", () => {
  // é este caso que o sha256 existe para pegar: trocar o clipe e não re-medir.
  // Sem ele o ganho do catálogo continuaria "batendo" com uma medição de um
  // arquivo que não existe mais.
  for (const name of SOUND_NAMES) {
    const file = CATALOG[name].file;
    const m = POR_ARQUIVO.get(file);
    assert.ok(m !== undefined, `${file}: sem linha no measured.json — ${REMEDIR}`);
    const sha = createHash("sha256").update(bytesDe(file)).digest("hex");
    assert.equal(sha, m.sha256, `${file}: o arquivo mudou desde a última medição — ${REMEDIR}`);
    assert.equal(bytesDe(file).length, m.bytes, `${file}: tamanho diferente do medido — ${REMEDIR}`);
  }
});

test("o ganho do catálogo é o ganho medido", () => {
  for (const name of SOUND_NAMES) {
    const m = POR_ARQUIVO.get(CATALOG[name].file) as Medida;
    assert.equal(
      CATALOG[name].gain,
      m.gain,
      `${name}: o catálogo diz ${CATALOG[name].gain} e a medição diz ${m.gain}. ` +
        "Mediu e esqueceu de copiar o número para o catalog.ts.",
    );
  }
});

test("o ganho põe todo clipe no alvo sem estourar o teto de pico", () => {
  // A conta do §3.1 em forma de asserção: se um dia alguém editar um ganho à
  // mão "só para subir um pouquinho", isto reprova antes de clipar no ouvido.
  //
  // A folga de 1% não é frouxidão: `rms` é gravado com 4 casas e `gain` com 3
  // (números para humano ler num diff, não para máquina), e o produto herda os
  // dois arredondamentos — o `voice-leave` dá 0.10005 contra um alvo de 0.1. O
  // que se está testando é ordem de grandeza do nível, e 1% é uma ordem de
  // grandeza abaixo do menor degrau audível.
  const FOLGA = 1.01;
  for (const name of SOUND_NAMES) {
    const m = POR_ARQUIVO.get(CATALOG[name].file) as Medida;
    const picoTocado = m.pico * CATALOG[name].gain;
    assert.ok(
      picoTocado <= medido.teto_pico * FOLGA,
      `${name}: tocaria em pico ${picoTocado.toFixed(3)}, acima do teto de ${medido.teto_pico}`,
    );
    const rmsTocado = m.rms * CATALOG[name].gain;
    assert.ok(rmsTocado <= 0.1 * FOLGA, `${name}: tocaria em RMS ${rmsTocado.toFixed(4)}, acima do alvo de -20 dBFS`);
  }
});

test("há clipe abaixo do limite de inline do Vite — o vite.config.ts é OBRIGATÓRIO", () => {
  // Deixou de ser hipótese no M12: os dois de PTT do Discord têm ~1,6 KB, bem
  // abaixo dos 4096 B do default do Vite. Inlinados viram `data:` URI, que as
  // duas CSPs do projeto barram — e o som sumiria SÓ em produção, com um erro
  // de CSP que ninguém liga a arquivo de som.
  const pequenos = SOUND_NAMES.map((n) => CATALOG[n].file).filter((f) => bytesDe(f).length < 4096);
  assert.ok(pequenos.length > 0, "se nenhum clipe é pequeno, este teste perdeu o objeto — reveja");

  const config = readFileSync(fileURLToPath(new URL("../vite.config.ts", import.meta.url)), "utf8");
  const regra = /assetsInlineLimit[\s\S]{0,300}?\/([^/]+)\/i\.test\(filePath\) \? false/.exec(config);
  assert.ok(regra !== null, "vite.config.ts não desativa mais o inline de áudio — os clipes pequenos sumiriam do build");
  const cobertos = new RegExp(regra[1] as string, "i");
  for (const f of pequenos) {
    assert.ok(cobertos.test(f), `${f} tem ${bytesDe(f).length} B e a regra do vite.config.ts não cobre a extensão dele`);
  }
});

test("duração: nada vira trilha, e o PTT é o mais curto de todos", () => {
  const ms = (name: string): number => (POR_ARQUIVO.get(CATALOG[name].file) as Medida).ms;
  for (const name of SOUND_NAMES) {
    assert.ok(ms(name) < 2000, `${name}: ${ms(name)} ms — som de UI não pode durar isso`);
  }
  // o PTT toca NO MEIO da fala: perto dos outros em duração, vira gagueira
  for (const ptt of ["ptt-on", "ptt-off"]) {
    assert.ok(ms(ptt) < 200, `${ptt}: ${ms(ptt)} ms — longo demais para tocar durante a fala`);
    assert.ok(ms(ptt) < ms("message"), `${ptt} devia ser mais curto que o de mensagem`);
  }
});

test("os sons sintetizados são exatamente os que o gerador declara em ACTIVE", () => {
  // Duas fontes que precisam concordar: o catálogo (quem é .wav) e o gerador
  // (quem ele escreve). Discordar significa ou receita que ninguém gera, ou
  // arquivo gerado que ninguém usa — os dois passariam despercebidos.
  const wavNoCatalogo = SOUND_NAMES.filter((n) => CATALOG[n].file.endsWith(".wav")).sort();
  assert.deepEqual([...ACTIVE].sort(), wavNoCatalogo, "ACTIVE do gen-sounds.mjs ≠ sons .wav do catálogo");
  for (const name of ACTIVE) {
    assert.ok(RECIPES[name] !== undefined, `${name} está em ACTIVE mas não tem receita`);
  }
});

test("todo som do catálogo tem receita de reserva no gerador", () => {
  // O caminho de volta: se um dia o repositório precisar ser público, os 12
  // .mp3 do Discord saem e `pnpm sounds --all` repõe os 14. Isso só continua
  // valendo enquanto TODAS as receitas existirem — ver ATTRIBUTIONS.md.
  for (const name of SOUND_NAMES) {
    assert.ok(RECIPES[name] !== undefined, `${name} não tem receita: o conjunto sintetizado deixou de ser completo`);
  }
});
