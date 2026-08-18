/**
 * Soundboard (M9) — o catálogo VIVO e o playback LOCAL.
 *
 * Diferença central para o M8: lá o catálogo é DADO ESTÁTICO (`catalog.ts`,
 * 14 clipes versionados no repo); aqui ele vem do servidor e muda em tempo de
 * execução — qualquer membro sobe um som e ele vale para a guild inteira. Por
 * isso este módulo não mora dentro do `catalog.ts`/`assets.ts`: ali o Vite
 * enxerga cada arquivo em tempo de build, e aqui não existe arquivo nenhum em
 * tempo de build.
 *
 * O áudio NÃO passa pelo SFU (doc §4 / ROADMAP 22): o gateway só faz fan-out
 * do id e cada cliente toca o arquivo que já baixou. É imediato, não entra no
 * cancelamento de eco de ninguém e não gasta banda de upstream de quem apertou.
 *
 * CARREGAMENTO — a estratégia, com o argumento:
 *   1. no boot NÃO se baixa nada. Com teto de 100 sons na guild, baixar tudo
 *      no READY seria megabytes que a maioria das sessões nunca usa (muita
 *      gente entra só para ler o chat);
 *   2. ABRIR o pad dispara o preload de tudo o que falta. Abrir o pad É o
 *      sinal de intenção — quem abriu vai apertar em segundos, e é a única
 *      janela em que dá para pagar o download sem ninguém esperando;
 *   3. `SOUND_CREATE` NÃO carrega. O som novo de outra pessoa pode nunca ser
 *      tocado nesta sessão; ele entra no catálogo e só vira bytes quando
 *      alguém apertar (ou quando o pad for aberto de novo);
 *   4. evento com o buffer ausente carrega na hora e ainda toca, desde que
 *      chegue dentro de `LATE_MS`. Passou disso, o download continua (o cache
 *      fica quente para a próxima) mas o som É DESCARTADO: som atrasado é
 *      pior que silêncio — a mesma regra do player do M8.
 *
 * O cache é por ID e o id é snowflake: os bytes de um som NUNCA mudam. Daí
 * `SOUND_UPDATE` (que só renomeia) não pode invalidar buffer nenhum, e só
 * `SOUND_DELETE` apaga.
 *
 * Sobre o AudioContext próprio: o `player.ts` do M8 tem um, mas ele não sabe
 * tocar um AudioBuffer arbitrário — a API dele é fechada nos 14 nomes do
 * catálogo estático (`play(name, gain)`), e o contexto não é exportado. Este
 * módulo abre o seu. Não é o ideal (são dois devices de saída abertos, três
 * com o da voz) e está no relatório do M9 como o pedido ao dono do M8:
 * exportar `context()` + `playBuffer(buffer, gain)` e este arquivo perde ~40
 * linhas.
 */
import { Sound, type VoiceSoundboardData } from "@danjocord/protocol";
import { z } from "zod";
import { API, getAccessToken, refresh } from "../auth.js";
import { ByteLru } from "./lru.js";
import { getPrefs as getAppSoundPrefs } from "./prefs.js";

// ---------------------------------------------------------------------------
// Limites — ESPELHO do servidor (apps/server/src/sounds/limits.ts)
//
// A validação que vale é a de lá, sempre: aqui é só para o usuário descobrir
// que o arquivo não serve ANTES de esperar um upload que vai ser recusado.
// ---------------------------------------------------------------------------

export const MAX_BYTES = 512 * 1024;
export const MAX_DURATION_MS = 5000;
export const MAX_NAME_LENGTH = 32;
/** faixa em que o servidor clampa o `gain` sugerido pelo cliente */
export const GAIN_MIN = 0.05;
export const GAIN_MAX = 2;
/** cooldown por usuário no servidor (1 a cada 2 s), espelhado para não pedir 429 de propósito */
export const PLAY_COOLDOWN_MS = 2000;

/**
 * Normalização, o MESMO critério do M8: alvo de ~-20 dBFS de RMS (som de UI
 * fica abaixo da voz da chamada) com teto de pico em 0.89. O arquivo sobe
 * intacto — o nivelamento vira DADO (a coluna `gain`), aplicado no playback.
 */
const TARGET_RMS = 0.1; // 10^(-20/20)
const PEAK_CEIL = 0.89;

/** ~5 ms nas bordas, como no player do M8: mata o "click" sem editar o arquivo */
const FADE_S = 0.005;

/** evento cujo buffer demorou mais que isto para chegar não toca mais */
const LATE_MS = 2000;

/** quantos downloads simultâneos no preload — o suficiente para ser rápido sem afogar a rede */
const PRELOAD_PARALLEL = 3;

/**
 * Teto de bytes do preload. O pior caso do catálogo é 100 × 512 KB = 50 MB, e
 * baixar isso porque alguém abriu o pad seria abuso da conexão de quem só
 * queria uma buzina. Os primeiros do catálogo cabem no orçamento (os 9
 * embutidos somam 93 KB); o resto continua carregando sob demanda, no aperto.
 */
const PRELOAD_BUDGET_BYTES = 8 * 1024 * 1024;

/**
 * Teto do CACHE decodificado — coisa diferente do orçamento acima.
 *
 * O `PRELOAD_BUDGET_BYTES` conta bytes COMPRIMIDOS e governa só a pré-carga. O
 * caminho sob demanda (`ensureBuffer` no aperto) não passava por ele: quem
 * tocasse os 100 sons ao longo de uma sessão acumulava os 100 buffers, e um
 * clipe de 5 s a 48 kHz estéreo é ~1,9 MB DESCOMPRIMIDO — perto de 190 MB numa
 * aba. No app desktop, que fica semanas aberto na bandeja, isso não volta.
 *
 * 24 MB decodificados são ~12 sons no pior caso e várias dezenas no caso real
 * (os clipes são curtos). Estourando, sai o menos recentemente usado.
 */
const BUFFER_CACHE_BYTES = 24 * 1024 * 1024;

/** bytes que um AudioBuffer ocupa de verdade: float32 por amostra, por canal */
function bufferBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * 4;
}

/**
 * Content-Types que o servidor aceita no upload. O que decide o container lá
 * são os magic bytes, mas o header ainda passa por uma allowlist — então um
 * `file.type` exótico do SO vira o genérico em vez de virar 415.
 */
const UPLOAD_MIME = new Set([
  "application/octet-stream",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
  "audio/mpeg",
  "audio/mp3",
]);

// ---------------------------------------------------------------------------
// Erro de soundboard: mensagem JÁ EM PORTUGUÊS
//
// A tradução de status HTTP mora aqui, ao lado das rotas que os produzem, e
// não na UI: assim existe UM lugar que sabe o que 409 significa nesta API, e a
// UI só sabe mostrar `err.message`.
// ---------------------------------------------------------------------------

export class SoundboardError extends Error {
  constructor(
    message: string,
    /** null quando o erro é local (decode, tamanho, sem áudio) */
    readonly status: number | null = null,
    /** segundos a esperar, só no 429 */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "SoundboardError";
  }
}

// ---------------------------------------------------------------------------
// Catálogo (metadados) — a fonte é o servidor
// ---------------------------------------------------------------------------

/**
 * Map e não array porque a busca por id é o acesso quente (evento, cache,
 * permissão). A ORDEM de inserção é a do servidor (created_at, id: embutidos
 * primeiro) e é ela que o pad desenha — renomear não muda a posição, que é o
 * que evita o pad se reorganizar debaixo do dedo de quem ia apertar.
 */
const catalog = new Map<string, Sound>();
const catalogListeners = new Set<() => void>();

function notifyCatalog(): void {
  for (const cb of catalogListeners) cb();
}

/** Notifica quem desenha o pad. Devolve o cancelamento da inscrição. */
export function subscribeCatalog(cb: () => void): () => void {
  catalogListeners.add(cb);
  return () => catalogListeners.delete(cb);
}

/** READY (ou um GET /api/sounds de resync): substitui o catálogo inteiro. */
export function setCatalog(sounds: readonly Sound[]): void {
  catalog.clear();
  for (const s of sounds) catalog.set(s.id, s);
  // buffer de som que sumiu do catálogo vira lixo preso na memória
  buffers.retain((id) => catalog.has(id));
  notifyCatalog();
}

/** SOUND_CREATE e SOUND_UPDATE: o mesmo caminho — o id é a chave. */
export function upsertSound(sound: Sound): void {
  // Deliberadamente NÃO mexe em `buffers`: o áudio é imutável e o PATCH só
  // renomeia. Rebaixar o arquivo por causa de um rename seria pagar rede por
  // um byte que não mudou.
  catalog.set(sound.id, sound);
  notifyCatalog();
}

export function removeSound(id: string): void {
  catalog.delete(id);
  buffers.delete(id);
  stopSound(id); // som apagado no meio da própria reprodução para na hora
  notifyCatalog();
}

/** Cópia na ordem do servidor — quem desenha o pad itera isto. */
export function listSounds(): Sound[] {
  return [...catalog.values()];
}

export function getSound(id: string): Sound | null {
  return catalog.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Preferências (localStorage, como no M8)
//
// Não é segredo, é conforto: mesma decisão do `sound/prefs.ts` — localStorage
// serve web e Electron sem código diferente. A leitura é TOLERANTE: qualquer
// coisa fora do formato vira o default, um JSON estragado não pode calar o pad.
// ---------------------------------------------------------------------------

export interface SoundboardPrefs {
  /** a chave "desativar soundboard" do ROADMAP 27, invertida para o positivo */
  enabled: boolean;
  /** volume PRÓPRIO do pad, 0..1 — multiplica o `gain` de normalização do som */
  volume: number;
  /**
   * user_ids cujos sons eu não quero ouvir. É o que evita o pad virar briga:
   * dá para calar UMA pessoa sem desligar o recurso para todo mundo e sem
   * pedir moderação por causa de uma buzina.
   */
  silenced: string[];
}

const PREFS_KEY = "danjocord_soundboard_prefs";

function defaultPrefs(): SoundboardPrefs {
  // 0.7: o `gain` de cada som já o leva a ~-20 dBFS, então o volume aqui é
  // ajuste fino. Um pouco abaixo do teto porque o pad é som de brincadeira
  // por cima de uma conversa.
  return { enabled: true, volume: 0.7, silenced: [] };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return defaultPrefs().volume;
  return Math.min(1, Math.max(0, v));
}

function loadPrefs(): SoundboardPrefs {
  const prefs = defaultPrefs();
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw === null) return prefs;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return prefs;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj["enabled"] === "boolean") prefs.enabled = obj["enabled"];
    if (typeof obj["volume"] === "number") prefs.volume = clamp01(obj["volume"]);
    const silenced = obj["silenced"];
    if (Array.isArray(silenced)) prefs.silenced = silenced.filter((v): v is string => typeof v === "string");
  } catch {
    // JSON corrompido / storage bloqueado: default (pad ligado)
  }
  return prefs;
}

let prefs: SoundboardPrefs = loadPrefs();
const prefsListeners = new Set<(p: SoundboardPrefs) => void>();

/** Cópia: ninguém edita as prefs por referência — a mudança passa pelos setters. */
export function getSoundboardPrefs(): SoundboardPrefs {
  return { ...prefs, silenced: [...prefs.silenced] };
}

function commitPrefs(next: SoundboardPrefs): void {
  prefs = next;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // storage cheio ou bloqueado: vale nesta sessão e pronto
  }
  for (const cb of prefsListeners) cb(getSoundboardPrefs());
}

export function setSoundboardEnabled(on: boolean): void {
  if (!on) stopAllSounds(); // desligar no meio de um som tem que calar AGORA
  commitPrefs({ ...getSoundboardPrefs(), enabled: on });
}

export function setSoundboardVolume(volume: number): void {
  commitPrefs({ ...getSoundboardPrefs(), volume: clamp01(volume) });
}

export function isUserSilenced(userId: string): boolean {
  return prefs.silenced.includes(userId);
}

export function setUserSilenced(userId: string, silenced: boolean): void {
  const next = getSoundboardPrefs();
  const has = next.silenced.includes(userId);
  if (silenced === has) return;
  next.silenced = silenced ? [...next.silenced, userId] : next.silenced.filter((id) => id !== userId);
  commitPrefs(next);
}

export function subscribeSoundboardPrefs(cb: (p: SoundboardPrefs) => void): () => void {
  prefsListeners.add(cb);
  return () => prefsListeners.delete(cb);
}

// ---------------------------------------------------------------------------
// Política: "este VOICE_SOUNDBOARD deve virar som aqui, e com que volume?"
//
// Função PURA e num lugar só, pelo mesmo motivo do `policy.ts` do M8: regra
// espalhada em `if` de call site é como uma regra vira três regras diferentes.
// A diferença é que esta não tem suíte de teste — importar este módulo no Node
// esbarra no `auth.ts` (que lê `import.meta.env` no topo). Extrair a função
// para um arquivo próprio resolveria; está no relatório.
// ---------------------------------------------------------------------------

export interface SoundboardWorld {
  meId: string | null;
  deafened: boolean;
  /** o canal de voz em que EU estou (null = não estou em voz) */
  voiceChannelId: string | null;
}

/** null = não toca. Devolve o multiplicador de volume quando toca. */
export function decideSoundboard(ev: VoiceSoundboardData, w: SoundboardWorld, p: SoundboardPrefs): number | null {
  // A chave geral do M8 ("Ativar sons") desliga TODOS os sons do app, e o pad
  // é um som do app. Sem isto, desligar o som do Danjocord ainda deixaria a
  // buzina de alguém entrar pela porta dos fundos.
  if (!getAppSoundPrefs().master) return null;
  if (!p.enabled) return null;
  // Deafen é "não quero ouvir NADA de fora" — e com playback local o deafen do
  // M3 não silencia o pad sozinho (ROADMAP 27: o áudio não passa pelo SFU, não
  // há consumer para pausar). Vale inclusive para o MEU próprio aperto: se eu
  // não ouço o canal, ouvir só a minha buzina confundiria mais que ajudaria —
  // e o pad continua dando o retorno VISUAL de que o botão funcionou.
  if (w.deafened) return null;
  // silenciar alguém não vale para mim mesmo (a UI nem oferece)
  if (ev.user_id !== w.meId && p.silenced.includes(ev.user_id)) return null;
  // o canal é o que o SERVIDOR viu; quem não está nele ignora
  if (w.voiceChannelId === null || ev.channel_id !== w.voiceChannelId) return null;
  return p.volume;
}

// ---------------------------------------------------------------------------
// Áudio: contexto, cache de buffers, reprodução
// ---------------------------------------------------------------------------

let ctx: AudioContext | null = null;
let ctxFailed = false;
const buffers = new ByteLru<AudioBuffer>(BUFFER_CACHE_BYTES, bufferBytes);

const loading = new Map<string, Promise<AudioBuffer | null>>();
/** o source em voo por SOM — apertar o mesmo som de novo corta o anterior */
const playing = new Map<string, AudioBufferSourceNode>();

/**
 * Cria o contexto na primeira necessidade, e não num listener de destravamento
 * como o `player.ts` faz. Aqui dá: todo caminho que chega até aqui vem depois
 * de um gesto — para ouvir o pad de alguém eu preciso estar num canal de voz,
 * e entrar num canal é um clique. `resume()` de melhor esforço cobre a aba que
 * ficou em segundo plano tempo demais.
 */
function ensureContext(): AudioContext | null {
  if (ctx !== null) return ctx;
  if (ctxFailed) return null;
  try {
    ctx = new AudioContext();
  } catch {
    ctxFailed = true; // sem WebAudio não há pad — e som é cortesia, nunca erro
    return null;
  }
  void ctx.resume().catch(() => undefined);
  return ctx;
}

function stopSound(id: string): void {
  const source = playing.get(id);
  if (source === undefined) return;
  source.onended = null; // o stop dispara ended: sem isto ele apagaria a entrada do source NOVO
  playing.delete(id);
  try {
    source.stop();
  } catch {
    // source que ainda não começou lança InvalidStateError em alguns motores
  }
}

/** Corta tudo o que está tocando (deafen, sair da voz, desligar o pad). */
export function stopAllSounds(): void {
  for (const id of [...playing.keys()]) stopSound(id);
}

/**
 * Toca um buffer já decodificado. `key` agrupa a "rajada": duas apertadas do
 * MESMO som cortam a anterior (é o que o Discord faz e é o que impede uma
 * pessoa sozinha de empilhar dez cópias do mesmo áudio).
 */
function playBuffer(key: string, buffer: AudioBuffer, gain: number): void {
  const audio = ensureContext();
  if (audio === null) return;
  if (audio.state === "suspended") void audio.resume().catch(() => undefined);

  stopSound(key);

  const source = audio.createBufferSource();
  source.buffer = buffer;
  const envelope = audio.createGain();
  const start = audio.currentTime;
  const end = start + buffer.duration;
  const fade = Math.min(FADE_S, buffer.duration / 2);
  envelope.gain.setValueAtTime(0, start);
  envelope.gain.linearRampToValueAtTime(gain, start + fade);
  envelope.gain.setValueAtTime(gain, end - fade);
  envelope.gain.linearRampToValueAtTime(0, end);
  source.connect(envelope).connect(audio.destination);
  source.onended = (): void => {
    if (playing.get(key) === source) playing.delete(key);
  };
  source.start(start);
  playing.set(key, source);
}

/** Preview do upload: buffer que ainda não é um som do servidor (não tem id). */
export function previewBuffer(buffer: AudioBuffer, gain: number): void {
  playBuffer("__preview__", buffer, gain * prefs.volume);
}

export function stopPreview(): void {
  stopSound("__preview__");
}

/**
 * Baixa e decodifica os bytes de um som, UMA vez. Chamadas concorrentes para o
 * mesmo id compartilham a promise (o preload e um evento podem correr juntos).
 * Devolve null em qualquer falha: som é cortesia, o pad não quebra por isso.
 */
export async function ensureBuffer(id: string): Promise<AudioBuffer | null> {
  const cached = buffers.get(id); // o get do ByteLru já marca uso
  if (cached !== undefined) return cached;
  const inFlight = loading.get(id);
  if (inFlight !== undefined) return inFlight;

  const task = (async (): Promise<AudioBuffer | null> => {
    const audio = ensureContext();
    if (audio === null) return null;
    try {
      // A resposta é `immutable` com um ano de validade — o cache HTTP do
      // navegador cobre o F5; este Map cobre a sessão.
      const res = await authFetch(`/api/sounds/${encodeURIComponent(id)}/audio`, { method: "GET" });
      if (!res.ok) return null;
      const buffer = await audio.decodeAudioData(await res.arrayBuffer());
      // o som pode ter sido apagado durante o download: não repovoar o cache
      if (!catalog.has(id)) return null;
      buffers.put(id, buffer);
      return buffer;
    } catch (err) {
      console.warn("soundboard: falha ao carregar o som", id, err);
      return null;
    } finally {
      loading.delete(id);
    }
  })();
  loading.set(id, task);
  return task;
}

/**
 * Pré-carrega o catálogo inteiro. Chamado ao ABRIR o pad (ver o cabeçalho): é
 * a única janela em que dá para pagar o download sem ninguém esperando.
 * Concorrência limitada para não abrir 100 requisições de uma vez.
 */
export function preloadCatalog(): void {
  const pending: string[] = [];
  let budget = PRELOAD_BUDGET_BYTES;
  for (const sound of catalog.values()) {
    if (buffers.has(sound.id) || loading.has(sound.id)) continue;
    // o orçamento é gasto na ORDEM do catálogo (embutidos e sons antigos
    // primeiro), que é a mesma ordem em que os pads aparecem na tela
    if (sound.size_bytes > budget) break;
    budget -= sound.size_bytes;
    pending.push(sound.id);
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < pending.length) {
      const id = pending[next++];
      if (id === undefined) return;
      await ensureBuffer(id);
    }
  };
  for (let i = 0; i < Math.min(PRELOAD_PARALLEL, pending.length); i++) void worker();
}

/**
 * O evento chegou: decide, e toca. Devolve se o som foi (ou vai ser) tocado —
 * a UI usa só para registrar, o anel de "quem tocou" NÃO depende disto (ver
 * ui/soundboard.ts: silenciar alguém é parar de OUVIR, não deixar de ver).
 */
export function playFromEvent(ev: VoiceSoundboardData, world: SoundboardWorld): boolean {
  const sound = getSound(ev.sound_id);
  if (sound === null) return false; // som apagado entre o aperto e o evento
  const volume = decideSoundboard(ev, world, prefs);
  if (volume === null) return false;
  const gain = sound.gain * volume;

  const cached = buffers.get(sound.id); // marca uso: o som da moda não sai primeiro
  if (cached !== undefined) {
    playBuffer(sound.id, cached, gain);
    return true;
  }
  // buffer ausente: carrega e ainda toca, se chegar a tempo (ver LATE_MS)
  const asked = performance.now();
  void ensureBuffer(sound.id).then((buffer) => {
    if (buffer === null) return;
    if (performance.now() - asked > LATE_MS) return; // tarde demais: fica só o cache quente
    playBuffer(sound.id, buffer, gain);
  });
  return true;
}

// ---------------------------------------------------------------------------
// REST
//
// O fetch com Authorization mora aqui e não no main.ts de propósito: o
// `api()` de lá é privado e carrega a política de logout do app. Aqui basta
// renovar UMA vez em 401 (o `refresh()` do auth.ts é single-flight, então
// duas rotas do pad renovando ao mesmo tempo não brigam) e falhar com uma
// mensagem legível — quem desloga de verdade é o próximo `api()` do main.
// ---------------------------------------------------------------------------

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${getAccessToken() ?? ""}`, ...extra };
}

async function authFetch(path: string, init: RequestInit): Promise<Response> {
  const send = (): Promise<Response> =>
    fetch(API + path, { ...init, headers: authHeaders(init.headers as Record<string, string> | undefined) });
  const res = await send();
  if (res.status !== 401) return res;
  const result = await refresh();
  if (result !== "ok") throw new SoundboardError("sessão expirada — recarregue a página", 401);
  return send();
}

/** Corpo de erro do servidor: `{error, retry_after?}`. Fora do formato, fica o status. */
async function errorFrom(res: Response, fallback: string): Promise<SoundboardError> {
  let retryAfter: number | null = null;
  let detail: string | null = null;
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj["error"] === "string") detail = obj["error"];
      if (typeof obj["retry_after"] === "number") retryAfter = obj["retry_after"];
    }
  } catch {
    // corpo não-JSON (proxy no meio, 502 do Traefik): fica a mensagem padrão
  }
  // As mensagens são NOSSAS e não o `error` cru do servidor: os status que a
  // pessoa pode causar merecem instrução ("use ogg, wav ou mp3"), não rótulo.
  const message =
    res.status === 413
      ? `arquivo grande demais — o limite é ${Math.round(MAX_BYTES / 1024)} KB`
      : res.status === 415
        ? "formato não aceito — use ogg, wav ou mp3"
        : res.status === 409
          ? "a guild já tem 100 sons; apague um antes de subir outro"
          : res.status === 429
            ? retryAfter !== null
              ? `calma aí — espere ${Math.ceil(retryAfter)} s`
              : "calma aí — espere um pouco"
            : res.status === 403
              ? (detail ?? "você não pode fazer isso")
              : res.status === 404
                ? "este som não existe mais"
                : res.status === 400
                  ? (detail ?? fallback)
                  : fallback;
  return new SoundboardError(message, res.status, retryAfter);
}

/** `GET /api/sounds` — resync do catálogo (o READY já traz o mesmo conteúdo). */
export async function fetchSounds(): Promise<Sound[]> {
  const res = await authFetch("/api/sounds", { method: "GET" });
  if (!res.ok) throw await errorFrom(res, "não consegui carregar os sons");
  // schema Zod na entrada, como todo payload do projeto (nada de JSON.parse
  // cru virando objeto confiável)
  return z.array(Sound).parse(await res.json());
}

/**
 * `POST /api/voice/soundboard` — pede para TOCAR. Não toca nada localmente: o
 * som (inclusive o meu) sai do `VOICE_SOUNDBOARD` que volta pelo gateway, para
 * existir UM caminho de reprodução só, igual para todo mundo do canal.
 */
export async function requestPlay(soundId: string): Promise<void> {
  const res = await authFetch("/api/voice/soundboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sound_id: soundId }),
  });
  if (!res.ok) throw await errorFrom(res, "não consegui tocar o som");
}

export async function renameSound(id: string, name: string): Promise<Sound> {
  const res = await authFetch(`/api/sounds/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw await errorFrom(res, "não consegui renomear o som");
  return Sound.parse(await res.json());
}

export async function deleteSound(id: string): Promise<void> {
  const res = await authFetch(`/api/sounds/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw await errorFrom(res, "não consegui apagar o som");
}

/**
 * `POST /api/sounds?name=&gain=` — o corpo é o arquivo BINÁRIO CRU e os
 * metadados vão na query. Não é multipart: o Fastify 5 não lê multipart sem
 * plugin e o M9 não ganha dependência por causa disso (regra do pacote).
 *
 * XHR e não fetch pelo `upload.onprogress`: o `fetch` não reporta progresso de
 * envio (ReadableStream de upload exige HTTP/2 e ainda não é universal). São
 * 512 KB no máximo, mas num link doméstico de subida ruim isso é segundos —
 * tempo suficiente para a pessoa achar que travou.
 */
export function uploadSound(
  file: File,
  name: string,
  gain: number,
  onProgress: (fraction: number) => void,
): Promise<Sound> {
  const send = (): Promise<Sound> =>
    new Promise<Sound>((resolve, reject) => {
      const query = `?name=${encodeURIComponent(name)}&gain=${encodeURIComponent(gain.toFixed(3))}`;
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API}/api/sounds${query}`);
      xhr.responseType = "text";
      xhr.setRequestHeader("authorization", `Bearer ${getAccessToken() ?? ""}`);
      xhr.setRequestHeader("content-type", UPLOAD_MIME.has(file.type) ? file.type : "application/octet-stream");
      xhr.upload.addEventListener("progress", (ev) => {
        if (ev.lengthComputable) onProgress(ev.total === 0 ? 1 : ev.loaded / ev.total);
      });
      xhr.addEventListener("load", () => {
        if (xhr.status === 201 || xhr.status === 200) {
          try {
            resolve(Sound.parse(JSON.parse(xhr.responseText) as unknown));
          } catch {
            reject(new SoundboardError("o servidor devolveu uma resposta que eu não entendi", xhr.status));
          }
          return;
        }
        // status 0 é resposta que não chegou (o construtor de Response nem
        // aceita esse valor) — para o usuário é falha de rede, não erro da API
        if (xhr.status < 200) {
          reject(new SoundboardError("falha de rede ao enviar o som"));
          return;
        }
        // o XHR não tem Response: monta uma para reusar a MESMA tradução de
        // status das outras rotas (uma tabela de erros só). `Response.json()`
        // não olha content-type, então o texto cru basta.
        const fake = new Response(xhr.responseText, { status: xhr.status });
        void errorFrom(fake, "não consegui enviar o som").then(reject, reject);
      });
      xhr.addEventListener("error", () => reject(new SoundboardError("falha de rede ao enviar o som")));
      xhr.addEventListener("abort", () => reject(new SoundboardError("envio cancelado")));
      xhr.send(file);
    });

  return send().catch(async (err: unknown) => {
    // 401 aqui é access vencido no meio do upload — renova e manda de novo
    if (err instanceof SoundboardError && err.status === 401) {
      const result = await refresh();
      if (result !== "ok") throw new SoundboardError("sessão expirada — recarregue a página", 401);
      return send();
    }
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Análise do arquivo antes de subir
// ---------------------------------------------------------------------------

export interface SoundAnalysis {
  buffer: AudioBuffer;
  durationMs: number;
  /** RMS linear do arquivo como está (0..1) */
  rms: number;
  /** maior pico absoluto (0..1) */
  peak: number;
  /** o ganho SUGERIDO ao servidor — ele clampa em GAIN_MIN..GAIN_MAX */
  gain: number;
}

/**
 * Ganho de normalização, MESMO critério do M8: leva o clipe a ~-20 dBFS de
 * RMS, mas sem deixar o pico passar de 0.89 — som percussivo (um "tec" curto)
 * tem RMS baixíssimo e um ganho só por RMS o faria clipar feio.
 */
function suggestGain(rms: number, peak: number): number {
  if (rms <= 0 || peak <= 0) return 1; // silêncio: não há o que normalizar
  const byRms = TARGET_RMS / rms;
  const byPeak = PEAK_CEIL / peak;
  return Math.min(GAIN_MAX, Math.max(GAIN_MIN, Math.min(byRms, byPeak)));
}

/**
 * Decodifica o arquivo ANTES de subir. Serve a três coisas de uma vez: recusar
 * cedo o que o servidor recusaria (tamanho, duração), tocar o preview, e medir
 * o RMS para sugerir o `gain`. Quem manda na duração continua sendo o servidor
 * — ele mede abrindo o container, sem confiar no que o cliente declara.
 */
export async function analyzeAudioFile(file: File): Promise<SoundAnalysis> {
  if (file.size === 0) throw new SoundboardError("arquivo vazio");
  if (file.size > MAX_BYTES) {
    const kb = Math.round(file.size / 1024);
    throw new SoundboardError(`este arquivo tem ${kb} KB e o limite é ${Math.round(MAX_BYTES / 1024)} KB`);
  }
  const audio = ensureContext();
  if (audio === null) throw new SoundboardError("o navegador não abriu o áudio nesta janela");

  let buffer: AudioBuffer;
  try {
    // decodeAudioData CONSOME o ArrayBuffer; o upload lê o File de novo
    buffer = await audio.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new SoundboardError("não consegui abrir este arquivo — use ogg, wav ou mp3");
  }

  const durationMs = Math.round(buffer.duration * 1000);
  if (durationMs > MAX_DURATION_MS) {
    throw new SoundboardError(
      `este som tem ${(durationMs / 1000).toFixed(1)} s e o limite é ${MAX_DURATION_MS / 1000} s`,
    );
  }

  // RMS e pico sobre TODOS os canais somados: um som que só existe no canal
  // direito ainda precisa do ganho certo
  let sum = 0;
  let count = 0;
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const v = data[i] ?? 0;
      sum += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    count += data.length;
  }
  const rms = count === 0 ? 0 : Math.sqrt(sum / count);
  return { buffer, durationMs, rms, peak, gain: suggestGain(rms, peak) };
}

/** Nome pré-preenchido a partir do arquivo: sem extensão, aparado no limite. */
export function nameFromFile(file: File): string {
  const base = file.name.replace(/\.[^.]+$/, "").trim();
  // caractere de controle é recusado pelo schema do servidor; some aqui antes
  // de virar 400 na cara de quem só arrastou um arquivo
  const clean = [...base].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
  return clean.slice(0, MAX_NAME_LENGTH).join("").trim() || "som";
}
