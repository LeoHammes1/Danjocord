/**
 * Política de som (M8): "este evento deve virar som agora, e com que ganho?".
 *
 * Módulo PURO — nada de `window`, `document` ou WebAudio aqui. Isso não é
 * purismo: é o que permite testar a regra no Node (`node --test`), e é o que
 * permite ter as regras num lugar SÓ. Antes do M8 elas viviam implícitas e
 * DUPLICADAS no main.ts — o join dos outros era decidido no dispatch do
 * VOICE_STATE_UPDATE e o meu no `onChange` do VoiceClient, cada um com sua
 * própria checagem de deafen. Dois caminhos para a mesma pergunta é como uma
 * regra vira duas regras diferentes sem ninguém perceber.
 *
 * O contrato é minúsculo: `decide` recebe o evento e uma FOTO do mundo, e
 * devolve o ganho final ou `null` (não toca). Quem tira a foto é o index.ts,
 * no instante do evento.
 */
import { CATALOG, DEAFEN_SILENCES, type SoundCategory, type SoundName } from "./catalog.js";

export interface SoundEvent {
  name: SoundName;
  /** quem causou o evento (id do usuário). Ausente = evento sem autor (sistema). */
  actorId?: string | null;
  /** canal a que o evento pertence — de voz nos `voice`, de texto nos `notify`. */
  channelId?: string | null;
}

/** Preferências do usuário; persistidas em prefs.ts, mas o TIPO mora aqui (a política é a dona). */
export interface SoundPrefs {
  master: boolean;
  /** volume geral, 0..1 — multiplica o ganho de normalização do catálogo */
  volume: number;
  categories: Record<SoundCategory, boolean>;
}

export interface SoundWorld {
  meId: string | null;
  deafened: boolean;
  /** o canal de voz em que EU estou (null = não estou em voz) */
  voiceChannelId: string | null;
  /** o canal de texto ABERTO na tela */
  viewingChannelId: string | null;
  windowFocused: boolean;
  /** mute manual do próprio microfone (vence o push-to-talk, ver voice.ts) */
  muted: boolean;
  prefs: SoundPrefs;
}

/** O evento partiu de mim? (`meId` null = ainda não sei quem sou → não é meu.) */
function isMine(ev: SoundEvent, w: SoundWorld): boolean {
  return w.meId !== null && ev.actorId === w.meId;
}

/** O evento aconteceu no canal de voz em que estou agora? */
function inMyVoiceChannel(ev: SoundEvent, w: SoundWorld): boolean {
  // o `!== null` não é redundante: sem ele, "não estou em voz" (null) casaria
  // com "evento sem canal" (null) e o som tocaria fora de qualquer canal
  return w.voiceChannelId !== null && ev.channelId === w.voiceChannelId;
}

/** A parte da decisão que depende do CONTEXTO (quem, onde, com a janela em foco). */
function isRelevant(ev: SoundEvent, w: SoundWorld): boolean {
  switch (ev.name) {
    // Entrar/sair: só o que acontece no MEU canal. O próprio usuário TAMBÉM
    // ouve o seu join/leave — o Discord faz assim, e o feedback da própria
    // ação é metade da razão de o som existir.
    //
    // O evento MEU não passa pelo teste de canal, e não é preguiça: quando eu
    // saio, o VoiceClient já zerou o channelId antes de avisar, então no
    // instante do "voice-leave" o meu canal atual é null e a comparação seria
    // sempre falsa. Um evento meu já é, por definição, sobre o canal em que eu
    // estava — basta ele dizer QUAL (null = evento sem contexto, não toca).
    case "voice-join":
    case "voice-leave":
      return isMine(ev, w) ? ev.channelId !== null && ev.channelId !== undefined : inMyVoiceChannel(ev, w);

    // Go Live: ninguém se anuncia para si mesmo.
    case "stream-start":
      return inMyVoiceChannel(ev, w) && !isMine(ev, w);

    // Mensagem: nunca a minha própria, e só quando ela não está à vista —
    // ou seja, canal diferente do aberto, OU a janela sem foco (o canal pode
    // estar aberto atrás do navegador, e aí eu não vi nada).
    case "message":
      return !isMine(ev, w) && (ev.channelId !== w.viewingChannelId || !w.windowFocused);

    // Menção: nunca a minha própria; fora isso sempre — menciona-se justamente
    // para ser ouvido, inclusive no canal que já está aberto na minha frente.
    case "mention":
      return !isMine(ev, w);

    // Push-to-talk: o hook do desktop é GLOBAL e fica instalado enquanto o
    // modo estiver ligado — inclusive fora de qualquer chamada e com a janela
    // na bandeja. Sem este recorte, cada aperto da tecla vira bipe vindo de um
    // app escondido que não está transmitindo para ninguém. E com o mute manual
    // ligado o track nem abre (`track.enabled = !selfMute && …` em voice.ts):
    // anunciar "mic aberto" aí faria a pessoa falar achando que transmite.
    case "ptt-on":
    case "ptt-off":
      return w.voiceChannelId !== null && !w.muted;

    // self-* e system: são sobre MIM e sobre o estado do app, não dependem de
    // canal nem de foco.
    default:
      return true;
  }
}

/** null = não toca. Devolve o ganho final (0..1) quando toca. */
export function decide(ev: SoundEvent, w: SoundWorld): { gain: number } | null {
  const spec = CATALOG[ev.name];
  if (!w.prefs.master) return null;
  if (!w.prefs.categories[spec.category]) return null;
  if (w.deafened && DEAFEN_SILENCES.includes(spec.category)) return null;
  if (!isRelevant(ev, w)) return null;
  return { gain: spec.gain * w.prefs.volume };
}
