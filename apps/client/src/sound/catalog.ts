/**
 * Catálogo de sons (M8, doc §8): a tabela do pacote virando DADO.
 *
 * Este módulo é PURO de propósito — só nomes, ganhos e categorias. Ele não
 * importa nenhum arquivo: quem faz isso é o `assets.ts`, e a separação existe
 * porque a política (`policy.ts`) é testada no Node, que não resolveria um
 * import de asset do Vite. Se o catálogo importasse os arquivos, o teste iria
 * junto e quebraria.
 *
 * Os `gain` NÃO são gosto: cada um leva aquele clipe a ~-20 dBFS de RMS (som
 * de UI tem que ficar ABAIXO da voz da chamada), com teto de pico em 0.89.
 * Normalizar no PLAYBACK e não no arquivo mantém os arquivos INTACTOS — os 12
 * .mp3 são byte a byte o que o Discord serve — e o nivelamento vira dado
 * versionado, auditável num diff.
 *
 * Os números saem de `scripts/measure-sounds.mjs` (que decodifica com o
 * Chromium do Electron — o mesmo que vai tocar), ficam registrados em
 * `assets/sounds/measured.json` junto com o sha256 do arquivo medido, e o
 * `test/sound-assets.test.ts` reprova se esta tabela discordar de lá. Trocar um
 * som é trocar o arquivo, rodar o medidor E copiar o número — e a terceira
 * parte deixou de ser esquecível.
 *
 * Duas extensões convivem de propósito: 12 sons vêm do Discord (.mp3) e 2 são
 * sintetizados (.wav, `scripts/gen-sounds.mjs`) porque a fonte não tem
 * equivalente para "alguém começou a transmitir" nem para erro. Ver
 * ATTRIBUTIONS.md — e a advertência de distribuição que está lá.
 */

export type SoundName =
  | "voice-join"
  | "voice-leave"
  | "stream-start"
  | "message"
  | "mention"
  | "self-mute"
  | "self-unmute"
  | "self-deafen"
  | "self-undeafen"
  | "ptt-on"
  | "ptt-off"
  | "disconnected"
  | "reconnected"
  | "error";

/**
 * A categoria é o que o usuário liga/desliga no painel — e é o que o deafen
 * consulta. Não é decoração: `voice`/`notify` são som que vem de FORA (dos
 * outros), `self` é a resposta a uma ação MINHA e `system` é aviso de estado.
 */
export type SoundCategory = "voice" | "notify" | "self" | "system";

export interface SoundSpec {
  /** nome do arquivo em assets/sounds — a URL final é do bundler (assets.ts) */
  file: string;
  /** ganho de normalização, 0..~1.1 (ver cabeçalho) */
  gain: number;
  category: SoundCategory;
}

export const CATALOG: Record<SoundName, SoundSpec> = {
  "voice-join": { file: "voice-join.mp3", gain: 1.052, category: "voice" },
  "voice-leave": { file: "voice-leave.mp3", gain: 1.061, category: "voice" },
  "stream-start": { file: "stream-start.wav", gain: 0.535, category: "voice" },
  message: { file: "message.mp3", gain: 0.958, category: "notify" },
  mention: { file: "mention.mp3", gain: 1.127, category: "notify" },
  "self-mute": { file: "self-mute.mp3", gain: 0.782, category: "self" },
  "self-unmute": { file: "self-unmute.mp3", gain: 0.699, category: "self" },
  "self-deafen": { file: "self-deafen.mp3", gain: 1.032, category: "self" },
  "self-undeafen": { file: "self-undeafen.mp3", gain: 0.918, category: "self" },
  "ptt-on": { file: "ptt-on.mp3", gain: 0.667, category: "self" },
  "ptt-off": { file: "ptt-off.mp3", gain: 0.641, category: "self" },
  disconnected: { file: "disconnected.mp3", gain: 1.247, category: "system" },
  reconnected: { file: "reconnected.mp3", gain: 0.955, category: "system" },
  error: { file: "error.wav", gain: 0.527, category: "system" },
};

/** Ordem em que o painel de configurações lista as categorias. */
export const CATEGORIES: SoundCategory[] = ["voice", "notify", "self", "system"];

export const CATEGORY_LABEL: Record<SoundCategory, string> = {
  voice: "Voz",
  notify: "Notificações",
  self: "Minhas ações",
  system: "Sistema",
};

/**
 * Ensurdecer é "não quero ouvir NADA de fora" — logo silencia o que vem dos
 * outros. `self` e `system` continuam tocando: são a resposta às MINHAS
 * ações e o aviso de estado crítico. Sem essa distinção o próprio som de
 * "voltar a ouvir" não tocaria, o que é absurdo.
 */
export const DEAFEN_SILENCES: readonly SoundCategory[] = ["voice", "notify"];

/** Lista tipada dos 14 nomes — útil para preload e para validar o assets.ts. */
export const SOUND_NAMES: SoundName[] = Object.keys(CATALOG) as SoundName[];
