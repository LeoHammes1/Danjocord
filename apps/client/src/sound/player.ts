/**
 * Reprodução (M8): UM AudioContext, cada clipe decodificado UMA vez.
 *
 * O sounds.ts do M6 criava o contexto no primeiro toque e justificava assim:
 * "todo som sucede um clique — para alguém entrar no meu canal eu preciso já
 * estar nele, e entrar é um clique". Isso DEIXOU DE VALER no M8: mensagem,
 * menção e desconexão disparam com a aba parada, sem gesto nenhum antes. Daí
 * o destravamento explícito — um listener único de pointerdown/keydown que
 * cria o contexto, faz resume() e dispara o preload.
 *
 * Enquanto está travado, pedido de som é IGNORADO, nunca enfileirado: som
 * atrasado de um evento de 30 s atrás é pior que silêncio.
 *
 * Falha de decode não é erro: som é cortesia. O clipe que não decodificou
 * simplesmente não toca, e o resto do app nem fica sabendo.
 */
import { SOUND_URL } from "./assets.js";
import { SOUND_NAMES, type SoundName } from "./catalog.js";

let ctx: AudioContext | null = null;
let armed = false;
const buffers = new Map<SoundName, AudioBuffer>();
/** o source em voo por nome — rajada do MESMO som corta o anterior (Discord faz assim) */
const playing = new Map<SoundName, AudioBufferSourceNode>();

/** ~5 ms nas bordas: mata o "click" de borda sem editar os arquivos. */
const FADE_S = 0.005;

async function preload(audio: AudioContext): Promise<void> {
  await Promise.allSettled(
    SOUND_NAMES.map(async (name) => {
      const res = await fetch(SOUND_URL[name]);
      if (!res.ok) throw new Error(`sound ${name}: HTTP ${res.status}`);
      // decodeAudioData CONSOME o ArrayBuffer — daí um fetch por som, sem
      // reaproveitar buffers entre eles
      buffers.set(name, await audio.decodeAudioData(await res.arrayBuffer()));
    }),
  );
}

/**
 * Arma o destravamento. Idempotente: chamar duas vezes não duplica listener.
 * Deve ser chamado no boot, MUITO antes do primeiro som — o gesto que
 * destrava costuma ser o login ou o primeiro clique na sidebar.
 */
export function armUnlock(): void {
  if (armed) return;
  armed = true;
  const unlock = (): void => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
    try {
      ctx = new AudioContext();
    } catch {
      return; // sem WebAudio não há som — e som é cortesia, nunca erro
    }
    void ctx.resume().catch(() => undefined);
    void preload(ctx);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

/** Já dá para tocar? (o painel de configurações usa isto para explicar o silêncio) */
export function isReady(): boolean {
  return ctx !== null;
}

export function play(name: SoundName, gain: number): void {
  const audio = ctx;
  const buffer = buffers.get(name);
  if (audio === null || buffer === undefined) return; // travado, ou clipe que não decodificou
  // aba em segundo plano por muito tempo suspende o contexto; melhor esforço,
  // o pior caso é ESTE som se perder (o próximo já pega o contexto de volta)
  if (audio.state === "suspended") void audio.resume().catch(() => undefined);

  const previous = playing.get(name);
  if (previous !== undefined) {
    previous.onended = null; // o stop dispara ended: sem isto ele apagaria a entrada do source NOVO
    previous.stop();
  }

  const source = audio.createBufferSource();
  source.buffer = buffer;
  const envelope = audio.createGain();
  const start = audio.currentTime;
  const end = start + buffer.duration;
  // clipe curtíssimo não tem espaço para dois fades inteiros: metade da
  // duração para cada um, e o platô some
  const fade = Math.min(FADE_S, buffer.duration / 2);
  envelope.gain.setValueAtTime(0, start);
  envelope.gain.linearRampToValueAtTime(gain, start + fade);
  envelope.gain.setValueAtTime(gain, end - fade);
  envelope.gain.linearRampToValueAtTime(0, end);
  source.connect(envelope).connect(audio.destination);
  source.onended = (): void => {
    if (playing.get(name) === source) playing.delete(name);
  };
  source.start(start);
  playing.set(name, source);
}
