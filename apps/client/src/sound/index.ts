/**
 * Som (M8) — a fachada que o resto do cliente usa. Substitui o sounds.ts do
 * M6 (dois osciladores sine) pelos clipes CC0 da Kenney em assets/sounds.
 *
 * Divisão de trabalho: `catalog.ts` é a tabela, `assets.ts` são as URLs,
 * `policy.ts` decide, `player.ts` toca, `prefs.ts` lembra. Aqui só se junta
 * tudo — e é POR AQUI que todo mundo passa: nenhum módulo do cliente deve
 * importar `player.ts` direto, senão a política volta a se espalhar.
 *
 * `mountSound` recebe um CALLBACK e não um objeto de estado de propósito: o
 * dono do estado é o main.ts, e o mundo tem que ser lido no INSTANTE do
 * evento — uma foto tirada no boot estaria errada no primeiro join.
 */
import type { GatewayStatus } from "../gateway.js";
import { CATALOG, type SoundName } from "./catalog.js";
import { armUnlock, play } from "./player.js";
import { decide, type SoundEvent, type SoundWorld } from "./policy.js";
import { getPrefs } from "./prefs.js";

export { CATALOG, CATEGORIES, CATEGORY_LABEL, DEAFEN_SILENCES, SOUND_NAMES } from "./catalog.js";
export type { SoundCategory, SoundName, SoundSpec } from "./catalog.js";
export type { SoundEvent, SoundPrefs, SoundWorld } from "./policy.js";
export { getPrefs, resetPrefs, setCategory, setMaster, setVolume, subscribe } from "./prefs.js";
export { isReady } from "./player.js";

/** O mundo MENOS as prefs: elas o módulo busca sozinho, o main.ts não as conhece. */
type WorldSource = () => Omit<SoundWorld, "prefs">;

let readWorld: WorldSource | null = null;

export function mountSound(getWorld: WorldSource): void {
  readWorld = getWorld;
  armUnlock();
}

export function emit(ev: SoundEvent): void {
  if (readWorld === null) return; // som antes do mount: ignorar, nunca enfileirar
  const decision = decide(ev, { ...readWorld(), prefs: getPrefs() });
  if (decision === null) return;
  play(ev.name, decision.gain);
}

/**
 * Toca um clipe IGNORANDO a política — só para o painel de configurações,
 * onde o clique no som É a intenção do usuário (a política responderia "você
 * não está num canal de voz" e o botão pareceria quebrado). O volume geral
 * continua valendo: é justamente ele que se está ajustando.
 */
export function previewSound(name: SoundName): void {
  play(name, CATALOG[name].gain * getPrefs().volume);
}

/**
 * Anti-flapping da conexão: um blip de rede de 300 ms não pode virar
 * metralhadora de "caiu"/"voltou". Só o estado que SOBREVIVE ~2 s vira som.
 *
 * O status do gateway tem quatro valores, mas para o ouvido só existem dois:
 * "online" é estar de pé, todo o resto é estar fora (connecting e resuming
 * são tentativas, não conexões).
 */
const SETTLE_MS = 2000;

/** null = nada anunciado ainda. O boot normal termina em "up" SEM som. */
let announced: "up" | "down" | null = null;
let settleTimer: number | undefined;

/**
 * Volta o anti-flapping ao estado de boot. Existe por causa do LOGOUT, e o
 * caminho que o revelou foi o close 4016 (kick): o handler de close emite
 * `status("offline")` ANTES de emitir `closed(4016)`, então o timer de 2 s é
 * armado; logo depois o app sai para a tela de login — e `announced`/
 * `settleTimer` são estado de MÓDULO, que nem `resetState` nem `showLogin`
 * conhecem. Resultado sem isto: o som de "conexão perdida" tocava POR CIMA da
 * tela de login (categoria `system`, que deafen não silencia), e o login
 * seguinte tocava "reconectado" — exatamente o que o comentário do SETTLE_MS
 * diz que não pode acontecer, porque boot não é reconexão.
 */
export function resetConnectionSound(): void {
  if (settleTimer !== undefined) clearTimeout(settleTimer);
  settleTimer = undefined;
  announced = null;
}

export function emitConnection(status: GatewayStatus): void {
  const level: "up" | "down" = status === "online" ? "up" : "down";
  if (settleTimer !== undefined) clearTimeout(settleTimer);
  settleTimer = undefined;
  // já é o estado anunciado: o que houve foi um blip que voltou ao lugar
  if (level === announced) return;
  settleTimer = window.setTimeout(() => {
    settleTimer = undefined;
    // "voltou" só faz sentido depois de um "caiu" anunciado — o primeiro
    // online da vida do app é o boot, e boot não é reconexão
    if (level === "up" && announced === "down") emit({ name: "reconnected" });
    else if (level === "down") emit({ name: "disconnected" });
    announced = level;
  }, SETTLE_MS);
}
