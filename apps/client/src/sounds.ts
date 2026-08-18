/**
 * Sons de UI (M6, doc §8): join/leave de voz PROCEDURAIS via WebAudio — zero
 * assets. Vale para web E desktop.
 *
 * AudioContext LAZY de propósito: criado no primeiro toque, que sempre sucede
 * um gesto do usuário — o primeiro som possível é o do PRÓPRIO join (para
 * alguém entrar no meu canal eu preciso já estar nele, e entrar é um clique),
 * então a autoplay policy nunca barra. Volume baixo (~0.08): é notificação,
 * não efeito sonoro.
 *
 * Quem silencia no deafen é o CHAMADOR (main.ts checa voice.deafened antes de
 * tocar) — este módulo não conhece o estado de voz.
 */

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext {
  ctx ??= new AudioContext();
  // um contexto suspenso (aba em segundo plano por muito tempo) retoma aqui;
  // melhor esforço — se não der, o pior caso é um som perdido
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  return ctx;
}

const VOLUME = 0.08;
/** duração de cada tom; o envelope de gain evita o "click" de borda */
const TONE_S = 0.09;
/** espaçamento entre os dois tons — menor que TONE_S: leve sobreposição soa musical */
const GAP_S = 0.07;

/** Dois tons curtos em sequência — a direção (subindo/descendo) é a mensagem. */
function chirp(freqs: readonly number[]): void {
  let audio: AudioContext;
  try {
    audio = ensureCtx();
  } catch {
    return; // sem WebAudio não há som — e som é cortesia, nunca erro
  }
  const now = audio.currentTime;
  freqs.forEach((freq, i) => {
    const start = now + i * GAP_S;
    const osc = audio.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(VOLUME, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, start + TONE_S);
    osc.connect(gain).connect(audio.destination);
    osc.start(start);
    osc.stop(start + TONE_S + 0.01);
  });
}

/** Alguém (inclusive eu) ENTROU no meu canal de voz: dois tons subindo. */
export function playJoin(): void {
  chirp([440, 587.33]); // A4 → D5, uma quarta justa para cima
}

/** Alguém (inclusive eu) SAIU do meu canal de voz: os mesmos tons descendo. */
export function playLeave(): void {
  chirp([587.33, 440]);
}
