/**
 * CONTRATO entre os módulos de UI (ui/*.ts) e o main.ts.
 *
 * Os módulos de UI não importam o `state` do main.ts nem o VoiceClient: eles
 * recebem um UiContext e leem/disparam só o que está declarado aqui. Duas
 * razões — (a) o módulo vira testável e relegível sem carregar o main inteiro;
 * (b) a direção da dependência fica clara: main.ts conhece a UI, a UI não
 * conhece o main.ts.
 *
 * Regra que acompanha o contrato: um módulo de UI não guarda estado de
 * DOMÍNIO. Estado puramente VISUAL (quais categorias estão colapsadas, por
 * exemplo) pode viver num Map/Set no topo do módulo, com comentário dizendo
 * por que não está aqui.
 */
import type { Channel, Message, User, VoiceState } from "@danjocord/protocol";

/** Fatia de estado que a UI lê. main.ts passa o próprio `state` + os campos de voz. */
export interface UiState {
  me: User | null;
  channels: Channel[];
  members: Map<string, User>;
  online: Set<string>;
  currentChannel: string | null;
  voiceStates: Map<string, VoiceState>;
  speaking: Map<string, Set<string>>;
  /** canal de voz em que EU estou, ou null (vem do VoiceClient) */
  voiceChannelId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  /** user_id da transmissão que estou assistindo, ou null */
  watchingUserId: string | null;
}

/** Ações que a UI dispara. main.ts injeta as implementações reais. */
export interface UiActions {
  selectChannel(channelId: string): void;
  joinVoice(channelId: string): void;
  leaveVoice(): void;
  toggleMute(): void;
  toggleDeafen(): void;
  watchStream(userId: string): void;
  stopWatching(): void;
  logout(): void;
}

export interface UiContext {
  state: UiState;
  actions: UiActions;
}

/**
 * Reexportado para os módulos de UI não precisarem importar de dois lugares
 * (o tipo Message é usado pelo módulo de mensagens).
 */
export type { Channel, Message, User, VoiceState };
