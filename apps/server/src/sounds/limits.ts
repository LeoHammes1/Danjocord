/**
 * Limites do soundboard (M9) e a janela deslizante que os aplica.
 *
 * O projeto não tem NENHUM rate limit hoje (roadmap 117) — este é o primeiro, e
 * existe porque o M9 abre duas superfícies abusáveis de verdade: gravar bytes
 * de usuário no banco e fazer barulho no ouvido dos outros. O estado vive em
 * memória, como presença e voice states: um restart zera as janelas, e tudo bem
 * (o restart já derruba as sessões de voz).
 */

/** teto por som: 512 KB cobre 5 s com folga em qualquer um dos três formatos */
export const MAX_SOUND_BYTES = 512 * 1024;

/** teto de duração: 5 s é pad de soundboard; acima disso é música, não piada */
export const MAX_SOUND_MS = 5_000;

/** teto de sons da guild INTEIRA (não por usuário): 100 × 512 KB = 50 MB no PVC */
export const MAX_SOUNDS = 100;

/**
 * Faixa do ganho aceito no upload. O cliente mede o RMS do arquivo decodificado
 * e sugere o ganho que leva o som a ~-20 dBFS (mesmo alvo do M8, com teto de
 * pico 0.89); o servidor CLAMPA — cliente modificado não manda 50 para estourar
 * o ouvido da guild, nem 0 para "esconder" um som mudo.
 */
export const MIN_GAIN = 0.05;
export const MAX_GAIN = 2.0;

/**
 * Upload: 12 tentativas por minuto por usuário. A TENTATIVA conta, não só o
 * sucesso — mandar lixo repetidamente não pode sair de graça, porque cada
 * tentativa custa ler e abrir o container.
 *
 * O número é generoso de propósito: quem chega com uma pasta de sons sobe seis
 * ou sete de uma vez, e errar o arquivo duas vezes no meio disso é normal. Com
 * 5 (o valor original) dava para travar durante uma verificação comum — foi o
 * que aconteceu na integração. 12 × 512 KB continua limitando o pior caso a
 * ~6 MB/min, que é o que a trava existe para conter.
 */
export const UPLOAD_LIMIT = 12;
export const UPLOAD_WINDOW_MS = 60_000;

/** tocar: 1 som a cada 2 s POR USUÁRIO (o mesmo cooldown que o Discord usa) */
export const PLAY_USER_LIMIT = 1;
export const PLAY_USER_WINDOW_MS = 2_000;

/** e 5 sons a cada 10 s POR CANAL — quatro amigos revezando também é spam */
export const PLAY_CHANNEL_LIMIT = 5;
export const PLAY_CHANNEL_WINDOW_MS = 10_000;

/** Clampa o ganho sugerido pelo cliente na faixa útil. */
export function clampGain(gain: number | undefined): number {
  if (gain === undefined || !Number.isFinite(gain)) return 1;
  return Math.min(Math.max(gain, MIN_GAIN), MAX_GAIN);
}

// A janela deslizante em si mora em ../limits.ts desde o M10 (o GET público de
// convite virou o segundo usuário dela); reexportada aqui para os call sites e
// os testes do M9 continuarem apontando para o mesmo lugar.
export { SlidingWindow } from "../limits.js";
