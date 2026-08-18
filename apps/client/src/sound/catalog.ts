/**
 * Catálogo de sons (M8, doc §8): a tabela do pacote virando DADO.
 *
 * Este módulo é PURO de propósito — só nomes, ganhos e categorias. Ele não
 * importa nenhum .ogg: quem faz isso é o `assets.ts`, e a separação existe
 * porque a política (`policy.ts`) é testada no Node, que não sabe carregar
 * um .ogg. Se o catálogo importasse os arquivos, o teste iria junto e
 * quebraria.
 *
 * Os `gain` NÃO são gosto: os clipes da Kenney vêm com níveis muito
 * diferentes entre si, e cada ganho foi calculado para levar aquele clipe a
 * ~-20 dBFS de RMS (som de UI tem que ficar ABAIXO da voz da chamada), com
 * teto de pico em 0.89. Normalizar no PLAYBACK e não no arquivo mantém os
 * .ogg intactos — o nivelamento vira dado versionado, não um reencode
 * irreversível. Quatro deles (message, ptt-on/off, disconnected) não chegam
 * a -20 dBFS sem clipar e ficam um pouco mais baixos de propósito; no caso do
 * PTT isso é até desejável, ele dispara o tempo todo.
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
  "voice-join": { file: "voice-join.ogg", gain: 0.327, category: "voice" },
  "voice-leave": { file: "voice-leave.ogg", gain: 0.327, category: "voice" },
  "stream-start": { file: "stream-start.ogg", gain: 0.582, category: "voice" },
  message: { file: "message.ogg", gain: 0.885, category: "notify" },
  mention: { file: "mention.ogg", gain: 0.324, category: "notify" },
  "self-mute": { file: "self-mute.ogg", gain: 0.569, category: "self" },
  "self-unmute": { file: "self-unmute.ogg", gain: 0.407, category: "self" },
  "self-deafen": { file: "self-deafen.ogg", gain: 0.692, category: "self" },
  "self-undeafen": { file: "self-undeafen.ogg", gain: 0.684, category: "self" },
  "ptt-on": { file: "ptt-on.ogg", gain: 1.101, category: "self" },
  "ptt-off": { file: "ptt-off.ogg", gain: 1.076, category: "self" },
  disconnected: { file: "disconnected.ogg", gain: 0.958, category: "system" },
  reconnected: { file: "reconnected.ogg", gain: 0.785, category: "system" },
  error: { file: "error.ogg", gain: 0.767, category: "system" },
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
