/**
 * Medidor dos sons de UI (M12). `pnpm --filter @danjocord/client sounds:measure`.
 *
 * O QUE ELE RESOLVE
 * -----------------
 * O contrato do M8 é "trocar um som é trocar o arquivo E recalcular o ganho"
 * (docs/som.md §3.1). A conta em si é trivial; o problema sempre foi ONDE
 * rodá-la. Ela vivia como uma receita para colar no console do navegador
 * (ATTRIBUTIONS.md) — ninguém a rodava sem querer, e esquecê-la produz o pior
 * tipo de defeito: o som toca, não há erro nenhum, e o nível fica errado até
 * alguém reclamar.
 *
 * Medir exige DECODIFICAR, e aí está o nó: os clipes são .mp3, não há ffmpeg
 * nesta máquina, o Node não decodifica áudio e o projeto não instala
 * dependência para isto (a mesma regra que fez o upload do soundboard ser corpo
 * binário cru em vez de multipart).
 *
 * A saída é usar o decodificador que já está no repositório: **o Chromium do
 * Electron** de `apps/desktop`. Ele não é uma aproximação do que vai tocar o
 * som — ele É o que vai tocar o som, no app empacotado. Medir com o mesmo
 * decodificador do playback elimina a classe inteira de "no meu medidor deu
 * outro número".
 *
 * O QUE SAI DAQUI
 * ---------------
 * `assets/sounds/measured.json`, com uma linha por som: sha256, bytes, duração,
 * RMS, pico e o ganho. O sha256 é o que dá dente ao `sound-assets.test.ts`: com
 * ele, trocar um arquivo sem re-medir REPROVA — a medição deixa de ser uma
 * promessa e passa a descrever, comprovadamente, os arquivos que estão lá.
 *
 * O ganho ainda tem que ser copiado à mão para o `catalog.ts`. É de propósito:
 * o nivelamento é dado versionado e revisável num diff (§3.1), não um artefato
 * que aparece sozinho. O teste é que garante que a cópia aconteceu.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOUNDS = path.join(HERE, "..", "assets", "sounds");
const OUT = path.join(SOUNDS, "measured.json");

/**
 * Atenuação DELIBERADA, em dB, por som — a única porta por onde gosto entra no
 * ganho. Fora dela o número é medida pura.
 *
 * Está vazio hoje: os clipes vieram do Discord já equilibrados entre si, e
 * mexer neles seria justamente desfazer o que se foi buscar. O campo fica
 * porque a decisão que ele registra é recorrente — o par de PTT dispara dezenas
 * de vezes por conversa e toca no meio da fala, então é o primeiro candidato se
 * algum dia incomodar. Um número aqui é uma decisão; um clipe que "já era
 * baixinho" é um acidente.
 */
const QUIETER_DB = {};

const AUDIO = /\.(mp3|wav|ogg|oga|opus|m4a|flac)$/i;

function electronBinary() {
  const base = path.join(HERE, "..", "..", "desktop", "node_modules", ".bin");
  for (const name of ["electron.CMD", "electron"]) {
    const bin = path.join(base, name);
    if (existsSync(bin)) return bin;
  }
  console.error(
    "electron não encontrado em apps/desktop/node_modules.\n" +
      "Este script usa o Chromium do Electron para decodificar (ver cabeçalho).\n" +
      "Rode `pnpm install` na raiz e tente de novo.",
  );
  process.exit(1);
}

const files = readdirSync(SOUNDS)
  .filter((f) => AUDIO.test(f))
  .sort();
if (files.length === 0) {
  console.error(`nenhum arquivo de áudio em ${SOUNDS}`);
  process.exit(1);
}

const run = spawnSync(electronBinary(), [path.join(HERE, "measure-sounds-app.cjs")], {
  encoding: "utf8",
  timeout: 120_000,
  shell: process.platform === "win32", // .CMD não é executável sem shell
});
const line = (run.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("RELATORIO "));
if (line === undefined) {
  console.error("o medidor não devolveu relatório.");
  console.error(((run.stderr ?? "") + (run.stdout ?? "")).slice(0, 2000));
  process.exit(1);
}

const medidos = JSON.parse(line.slice("RELATORIO ".length));
const linhas = medidos.map((m) => {
  const bytes = readFileSync(path.join(SOUNDS, m.file));
  const quieterDb = QUIETER_DB[m.file.replace(AUDIO, "")] ?? 0;
  const limitadoPor = m.porRms <= m.porPico ? "rms" : "pico";
  const gain = +(Math.min(m.porRms, m.porPico) * 10 ** (quieterDb / 20)).toFixed(3);
  return {
    file: m.file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    canais: m.canais,
    taxa: m.taxa,
    ms: m.ms,
    ms_ativos: m.msAtivos,
    rms: m.rms,
    pico: m.pico,
    limitado_por: limitadoPor,
    quieter_db: quieterDb,
    gain,
  };
});

// snake_case em arquivo que cruza módulos — convenção do repo
writeFileSync(OUT, JSON.stringify({ alvo_rms_dbfs: -20, teto_pico: 0.89, sons: linhas }, null, 2) + "\n", "utf8");

console.table(
  linhas.map((l) => ({
    arquivo: l.file,
    canais: l.canais,
    ms: l.ms,
    ativos: l.ms_ativos,
    KB: +(l.bytes / 1024).toFixed(1),
    rms: l.rms,
    pico: l.pico,
    limitado_por: l.limitado_por,
    ganho: l.gain,
  })),
);
console.log(`\n${OUT.replace(/.*assets/, "assets")} escrito.`);
console.log("cole os ganhos em src/sound/catalog.ts (o sound-assets.test.ts confere):");
for (const l of linhas) console.log(`  ${l.file.replace(AUDIO, "")}: ${l.gain}`);
