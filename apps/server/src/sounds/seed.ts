import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeAudio } from "./probe.js";
import type { Store } from "../store.js";

/**
 * Sons embutidos do soundboard (M9): os 9 .ogg de `assets/soundboard` entram na
 * tabela `sounds` no primeiro boot, quando ela está vazia.
 *
 * Por que semear no banco em vez de manter um catálogo fixo no código: com o
 * upload livre (contrato do M9) existiriam DUAS fontes da verdade e dois
 * caminhos no cliente — um para o som embutido, outro para o som do banco. Com
 * o seed, o embutido é só um som cujo `uploader_id` é null; o cliente tem um
 * caminho só, e o admin pode até apagar um embutido que ninguém usa.
 *
 * Procedência: CC0 dos packs da Kenney (ATTRIBUTIONS.md). Estes 9 não foram
 * tocados pelo M12 — o que mudou lá foi o catálogo de sons de INTERFACE, que é
 * outro conjunto e outra licença. Os ganhos abaixo já vêm calculados pelo
 * critério do M8 (~-20 dBFS de RMS, teto de pico 0.89) — nada é reencodado, a
 * normalização é dado. Diferença que vale saber: aqui o RMS é do arquivo
 * inteiro; do lado do cliente ele passou a ser da região ativa (docs/som.md
 * §3.9), porque lá entraram clipes com silêncio nas pontas.
 */

// Vive em <pacote>/assets/soundboard — mesmo truque do migrationsDir: o caminho
// relativo vale a partir de src/sounds (tsx) e de dist/sounds (build).
const soundboardDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "soundboard");

interface Builtin {
  file: string;
  name: string;
  gain: number;
}

const BUILTINS: Builtin[] = [
  { file: "fanfarra.ogg", name: "Fanfarra", gain: 0.519 },
  { file: "deu-ruim.ogg", name: "Deu ruim", gain: 0.513 },
  { file: "buzina.ogg", name: "Buzina", gain: 0.881 },
  { file: "cristal.ogg", name: "Cristal", gain: 0.804 },
  { file: "scratch.ogg", name: "Scratch", gain: 0.61 },
  { file: "hein.ogg", name: "Hein?", gain: 0.32 },
  { file: "subiu.ogg", name: "Subiu", gain: 0.603 },
  { file: "caiu.ogg", name: "Caiu", gain: 0.978 },
  { file: "ping.ogg", name: "Ping", gain: 0.343 },
];

/**
 * Semeia se — e só se — a tabela estiver vazia. Não é idempotente por nome de
 * propósito: se o dono apagar um embutido, ele fica apagado; ressuscitá-lo a
 * cada boot seria uma surpresa desagradável.
 *
 * A duração passa pelo MESMO provador do upload: os 9 arquivos viram, na
 * prática, um teste de fumaça do parser de Ogg a cada primeiro boot.
 * @returns quantos sons foram inseridos
 */
export function seedSounds(store: Store, log?: (msg: string) => void): number {
  if (store.countSounds() > 0) return 0;
  let inserted = 0;
  for (const builtin of BUILTINS) {
    try {
      const bytes = readFileSync(join(soundboardDir, builtin.file));
      const probe = probeAudio(bytes);
      store.createSound({
        name: builtin.name,
        uploaderId: null, // embutido: sem dono, só admin apaga
        mime: probe.mime,
        bytes,
        durationMs: probe.durationMs,
        gain: builtin.gain,
      });
      inserted += 1;
    } catch (err) {
      // arquivo ausente (imagem sem a pasta de assets) não pode derrubar o boot:
      // o soundboard nasce vazio e os amigos sobem os próprios sons
      log?.(`som embutido "${builtin.file}" não foi semeado: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return inserted;
}
