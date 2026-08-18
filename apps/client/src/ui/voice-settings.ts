/**
 * Configurações de voz e vídeo (M9, item 38 + 39 + 40).
 *
 * O maior atrito real da voz até aqui: `getUserMedia` sem `deviceId` e consumer
 * sem `setSinkId`. Quem tem headset USB e webcam integrada não escolhia nada —
 * a chamada saía pelo alto-falante do monitor e entrava pelo microfone da
 * webcam, e a única saída era mudar o dispositivo PADRÃO do Windows. Este
 * diálogo é onde essa escolha passa a existir, junto com as duas perguntas que
 * vêm logo atrás dela: "estão me ouvindo?" e "a minha internet está ruim?".
 *
 * TRÊS DECISÕES QUE EXPLICAM O ARQUIVO
 *
 * 1. **O teste do microfone GRAVA e REPRODUZ.** Ver a barrinha mexer prova que
 *    o navegador captou alguma coisa — não prova que o áudio SAI num nível
 *    audível, nem que a saída escolhida é a que está no seu ouvido. Gravar 3 s
 *    e devolver pelo dispositivo de saída escolhido testa o caminho inteiro de
 *    uma vez, e é o único teste que a pessoa consegue julgar sozinha.
 *
 * 2. **Nada abre o microfone ou a câmera sozinho.** Abrir configurações não
 *    pode acender a luz da webcam: o medidor "ao vivo" fora da chamada e a
 *    prévia da câmera são explicitamente ligados por botão. Dentro da chamada o
 *    medidor não custa nada (`onLocalLevel` usa o mic que já está aberto) e
 *    aparece sozinho — lá a captura já é um fato.
 *
 * 3. **A escolha do usuário é um DESEJO, não um estado.** Se o headset é
 *    desplugado, a escolha guardada continua apontando para ele: o cliente cai
 *    no padrão do sistema (a constraint de `deviceId` vai como `ideal`, ver
 *    voice.ts) e este diálogo AVISA — mas não apaga a preferência. Plugar de
 *    volta restaura sem a pessoa precisar reescolher. Por isso `DeviceWish`
 *    guarda também o `label`: sem o nome, o aviso viraria "o dispositivo
 *    escolhido sumiu", que não ajuda ninguém a entender qual.
 *
 * Este módulo NÃO conhece o estado global nem importa o VoiceClient: recebe um
 * `VoiceSettingsDeps`, que é o subconjunto do VoiceClient que ele usa (a classe
 * satisfaz a interface estruturalmente — o integrador passa `voice` direto).
 */
import { CATALOG, type SoundName } from "../sound/index.js";
import { SOUND_URL } from "../sound/assets.js";
import type { AudioProcessing, ConnectionStats, VoiceDevices } from "../voice.js";
import { createDialog, el, type DialogShell } from "./dialog.js";
import { icon } from "./icons.js";

// ---------------------------------------------------------------------------
// Contrato com o VoiceClient
// ---------------------------------------------------------------------------

/**
 * O que este diálogo precisa do VoiceClient — e só isso. É uma interface e não
 * o tipo da classe de propósito: o módulo de UI não pode arrastar o cliente de
 * mídia inteiro (regra do M7), e um contrato pequeno é o que permite ler este
 * arquivo sem abrir o voice.ts de 2300 linhas.
 */
export interface VoiceSettingsDeps {
  /** canal de voz atual, ou null — decide se o medidor tem de onde ler */
  readonly channelId: string | null;
  readonly inputDeviceIds: { audio: string | null; video: string | null };
  readonly outputDevice: string | null;
  readonly audioProcessing: AudioProcessing;
  /** a câmera JÁ ABERTA pela chamada, se houver (a prévia toma emprestada) */
  readonly cameraTrack: MediaStreamTrack | null;
  listDevices(): Promise<VoiceDevices>;
  setInputDevice(kind: "audio" | "video", deviceId: string | null): Promise<void>;
  setOutputDevice(deviceId: string | null): Promise<void>;
  setAudioProcessing(options: Partial<AudioProcessing>): Promise<void>;
  onLocalLevel(cb: (level: number) => void): () => void;
  getConnectionStats(): Promise<ConnectionStats | null>;
}

// ---------------------------------------------------------------------------
// Preferências (localStorage, mesmo padrão do sound/prefs.ts)
// ---------------------------------------------------------------------------

const PREFS_KEY = "danjocord_voice_prefs";

/** Escolha de dispositivo. O `label` existe só para o aviso de "sumiu" (ver o cabeçalho). */
interface DeviceWish {
  id: string | null;
  label: string;
}

interface VoicePrefs {
  mic: DeviceWish;
  camera: DeviceWish;
  output: DeviceWish;
  processing: AudioProcessing;
}

type DeviceKind = "mic" | "camera" | "output";

/** Com artigo e maiúscula: estes nomes só aparecem no COMEÇO de uma frase. */
const KIND_NOUN: Record<DeviceKind, string> = {
  mic: "O microfone",
  camera: "A câmera",
  output: "A saída de áudio",
};

function defaultPrefs(): VoicePrefs {
  return {
    mic: { id: null, label: "" },
    camera: { id: null, label: "" },
    output: { id: null, label: "" },
    // os mesmos três `true` que estavam fixos no captureAudio até o M8: o
    // default continua sendo o que serve para o notebook de todo mundo
    processing: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  };
}

/** Leitura TOLERANTE: qualquer coisa fora do formato vira o default (idem M8). */
function loadPrefs(): VoicePrefs {
  const prefs = defaultPrefs();
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw === null) return prefs;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return prefs;
    const obj = parsed as Record<string, unknown>;
    for (const kind of ["mic", "camera", "output"] as const) {
      const wish = obj[kind];
      if (typeof wish !== "object" || wish === null) continue;
      const w = wish as Record<string, unknown>;
      const id = w["id"];
      const label = w["label"];
      prefs[kind] = {
        id: typeof id === "string" && id !== "" ? id : null,
        label: typeof label === "string" ? label : "",
      };
    }
    const proc = obj["processing"];
    if (typeof proc === "object" && proc !== null) {
      const map = proc as Record<string, unknown>;
      // percorre as chaves QUE EU CONHEÇO, não as do JSON
      for (const key of Object.keys(prefs.processing) as (keyof AudioProcessing)[]) {
        const value = map[key];
        if (typeof value === "boolean") prefs.processing[key] = value;
      }
    }
  } catch {
    // JSON corrompido / storage bloqueado: default. Ficar sem preferência é
    // chato; não abrir a tela de configuração de áudio seria pior.
  }
  return prefs;
}

let prefs: VoicePrefs = loadPrefs();

function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // storage cheio ou bloqueado: vale nesta sessão e pronto
  }
}

/**
 * Repõe as escolhas guardadas no VoiceClient. **O integrador chama isto UMA vez
 * no boot**, antes de qualquer join: todos os setters funcionam fora da voz e
 * valem para a próxima entrada (ver voice.ts). Sem esta chamada a preferência
 * existe no localStorage e não vale nada.
 */
export function restoreVoicePrefs(deps: VoiceSettingsDeps): void {
  const fail = (what: string) => (err: unknown) => console.warn(`voz: não deu para repor ${what}`, err);
  if (prefs.mic.id !== null) void deps.setInputDevice("audio", prefs.mic.id).catch(fail("o microfone"));
  if (prefs.camera.id !== null) void deps.setInputDevice("video", prefs.camera.id).catch(fail("a câmera"));
  if (prefs.output.id !== null) void deps.setOutputDevice(prefs.output.id).catch(fail("a saída"));
  void deps.setAudioProcessing(prefs.processing).catch(fail("o processamento do microfone"));
}

// ---------------------------------------------------------------------------
// Constantes de comportamento
// ---------------------------------------------------------------------------

/** de quanto em quanto tempo a qualidade da conexão é amostrada (ver getConnectionStats) */
const STATS_MS = 2000;
/** duração da gravação de teste — 3 s é o suficiente para uma frase inteira */
const TEST_SECONDS = 3;
/** medidor a ~20 fps, igual ao do voice.ts (setInterval, não rAF: rAF congela em segundo plano) */
const METER_MS = 50;

/**
 * A barra é logarítmica: em escala linear, fala normal (RMS 0,05..0,3) mexeria
 * o primeiro terço da barra e o resto ficaria morto para sempre. -55 dBFS é o
 * chão (ruído de sala) e -5 dBFS o topo (perto de estourar).
 */
const METER_FLOOR_DB = -55;
const METER_CEIL_DB = -5;

/** o clipe do teste de saída — o mesmo que o M8 usa para calibrar volume */
const OUTPUT_TEST_SOUND: SoundName = "message";

interface ProcessingSpec {
  key: keyof AudioProcessing;
  label: string;
  desc: string;
}

/**
 * Uma linha por chave: sem a descrição, "ganho automático" é adivinhação — e
 * estas três são justamente as que a pessoa só desliga se entender o que fazem.
 */
const PROCESSING: ProcessingSpec[] = [
  {
    key: "echoCancellation",
    label: "Cancelamento de eco",
    desc: "Tira do seu microfone o som que sai dos seus alto-falantes, para os outros não se ouvirem de volta.",
  },
  {
    key: "noiseSuppression",
    label: "Supressão de ruído",
    desc: "Abafa som constante de fundo (ventilador, ar-condicionado, teclado). Em troca, come o começo de algumas palavras.",
  },
  {
    key: "autoGainControl",
    label: "Ganho automático",
    desc: "Nivela o seu volume sozinho. Em microfone bom e perto da boca, costuma “bombear” — subir o ruído nas pausas.",
  },
];

const QUALITY_LABEL: Record<ConnectionStats["quality"], string> = {
  boa: "Boa",
  media: "Média",
  ruim: "Ruim",
  desconhecida: "Sem dados",
};

// ---------------------------------------------------------------------------
// Estado do módulo (só o do diálogo — preferência mora no localStorage)
// ---------------------------------------------------------------------------

type TestState = "idle" | "opening" | "recording" | "playing";

interface Ui {
  permissionNote: HTMLElement;
  permissionBtn: HTMLButtonElement;
  lostNote: HTMLElement;
  micSelect: HTMLSelectElement;
  meterFill: HTMLElement;
  meterHint: HTMLElement;
  testBtn: HTMLButtonElement;
  testStatus: HTMLElement;
  toggles: Map<keyof AudioProcessing, HTMLInputElement>;
  echoWarn: HTMLElement;
  outSelect: HTMLSelectElement;
  outBtn: HTMLButtonElement;
  outStatus: HTMLElement;
  camSelect: HTMLSelectElement;
  camBtn: HTMLButtonElement;
  camVideo: HTMLVideoElement;
  camHint: HTMLElement;
  statValues: Map<StatRow, HTMLElement>;
  statPill: HTMLElement;
  statHint: HTMLElement;
}

type StatRow = "rtt" | "loss" | "jitter" | "rate";

let shell: DialogShell | null = null;
let ui: Ui | null = null;
let client: VoiceSettingsDeps | null = null;

let devices: VoiceDevices = { audioInputs: [], audioOutputs: [], videoInputs: [] };

/** AudioContext PRÓPRIO deste diálogo: é o único jeito de tocar num sink escolhido. */
let ctx: AudioContext | null = null;
/** o decodificado do clipe de teste — decodificar de novo a cada clique é desperdício */
let testClip: AudioBuffer | null = null;

/** desinscrição do medidor do VoiceClient (dentro da chamada) */
let stopLevel: (() => void) | null = null;
/** nós do medidor local (fora da chamada, durante a gravação de teste) */
let localMeter: { timer: number; analyser: AnalyserNode; source: MediaStreamAudioSourceNode; sink: GainNode } | null =
  null;

let testState: TestState = "idle";
let testStream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let recordTimer: number | undefined;
let testCancelled = false;
let playback: AudioBufferSourceNode | null = null;

/** captura PRÓPRIA da prévia (parar no fim); null quando a prévia usa o track da chamada */
let camStream: MediaStream | null = null;
let camBorrowed = false;

let statsTimer: number | undefined;
/** invalida respostas em voo de um poll que já foi desligado */
let statsToken = 0;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function listFor(kind: DeviceKind): MediaDeviceInfo[] {
  if (kind === "mic") return devices.audioInputs;
  if (kind === "camera") return devices.videoInputs;
  return devices.audioOutputs;
}

/** Motivo legível de uma falha de mídia — `NotAllowedError` sozinho não diz nada. */
function reason(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permissão negada.";
  if (name === "NotFoundError") return "nenhum dispositivo encontrado.";
  if (name === "NotReadableError") return "o dispositivo está em uso por outro programa.";
  if (name === "OverconstrainedError") return "o dispositivo escolhido não aceita essa configuração.";
  return err instanceof Error && err.message !== "" ? err.message : "erro desconhecido.";
}

/** Constraints do microfone: o desejo guardado + o processamento em vigor. */
function micConstraints(): MediaTrackConstraints {
  const proc = client?.audioProcessing ?? prefs.processing;
  const c: MediaTrackConstraints = {
    echoCancellation: proc.echoCancellation,
    noiseSuppression: proc.noiseSuppression,
    autoGainControl: proc.autoGainControl,
  };
  // `ideal` e não `exact` — mesma razão do voice.ts: com `exact`, headset
  // desplugado faria o getUserMedia falhar em vez de cair no padrão
  if (prefs.mic.id !== null) c.deviceId = { ideal: prefs.mic.id };
  return c;
}

function camConstraints(): MediaTrackConstraints {
  // a prévia tem 280px de largura: pedir 4K aqui só esquentaria o notebook
  const c: MediaTrackConstraints = { width: { ideal: 640 }, height: { ideal: 360 } };
  if (prefs.camera.id !== null) c.deviceId = { ideal: prefs.camera.id };
  return c;
}

function ensureCtx(): AudioContext | null {
  if (ctx !== null) return ctx;
  try {
    ctx = new AudioContext();
  } catch {
    return null; // sem WebAudio não há teste — e não é erro fatal
  }
  void ctx.resume().catch(() => undefined);
  void applySinkToCtx();
  return ctx;
}

/**
 * `AudioContext.setSinkId` é Chromium 110+ e ainda não está no lib.dom — daí o
 * cast. Onde não existir, o teste sai pelo dispositivo padrão: degradar em
 * silêncio é melhor que não ter botão de teste.
 */
async function applySinkToCtx(): Promise<void> {
  const audio = ctx;
  if (audio === null) return;
  const withSink = audio as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (withSink.setSinkId === undefined) return;
  try {
    await withSink.setSinkId(prefs.output.id ?? "");
  } catch (err) {
    console.warn("voz: setSinkId recusado no contexto do teste", err);
  }
}

// ---------------------------------------------------------------------------
// Medidor de nível
// ---------------------------------------------------------------------------

function setMeter(level: number): void {
  const d = ui;
  if (d === null) return;
  // -inf dB quando o nível é 0: o Math.log10(0) é -Infinity e o clamp resolve
  const db = level > 0 ? 20 * Math.log10(level) : METER_FLOOR_DB;
  const ratio = (db - METER_FLOOR_DB) / (METER_CEIL_DB - METER_FLOOR_DB);
  const pct = Math.min(100, Math.max(0, ratio * 100));
  d.meterFill.style.width = `${pct.toFixed(1)}%`;
  // acima de -5 dBFS a captura está a um grito de estourar: a cor avisa antes
  // de o outro lado ouvir a distorção (é decoração — o texto abaixo é quem
  // explica o que fazer, cor sozinha não informa nada)
  d.meterFill.classList.toggle("is-hot", pct >= 98);
}

function stopMeter(): void {
  stopLevel?.();
  stopLevel = null;
  if (localMeter !== null) {
    clearInterval(localMeter.timer);
    localMeter.source.disconnect();
    localMeter.analyser.disconnect();
    localMeter.sink.disconnect();
    localMeter = null;
  }
  setMeter(0);
}

/**
 * Liga o medidor na melhor fonte disponível AGORA, nesta ordem:
 *  1. a captura de teste, se estiver aberta (é ela que está sendo julgada);
 *  2. o `onLocalLevel` do VoiceClient, se estou num canal (é o que os OUTROS
 *     ouvem — passa depois do gate de mute/PTT, e isso é a informação certa);
 *  3. nada: barra em zero e o texto explica.
 */
function startMeter(): void {
  stopMeter();
  const d = ui;
  const c = client;
  if (d === null || c === null) return;

  if (testStream !== null) {
    startLocalMeter(testStream);
    d.meterHint.textContent = "Medindo direto do microfone, sem passar pelo mute nem pelo push-to-talk.";
    return;
  }
  if (c.channelId !== null) {
    stopLevel = c.onLocalLevel(setMeter);
    d.meterHint.textContent =
      "É o que os outros ouvem: mutado, silenciado pelo servidor ou fora do aperto do push-to-talk, a barra fica em zero.";
    return;
  }
  d.meterHint.textContent =
    "Você não está em um canal de voz. Use “Gravar e ouvir” para abrir o microfone e ver o nível.";
}

/** Medidor próprio: um AnalyserNode sobre a captura de teste. */
function startLocalMeter(stream: MediaStream): void {
  const audio = ensureCtx();
  if (audio === null) return;
  const source = audio.createMediaStreamSource(stream);
  const analyser = audio.createAnalyser();
  analyser.fftSize = 1024;
  // dreno MUDO até o destino (mesma armadilha do voice.ts): um analisador
  // pendurado no vazio pode não ser "puxado" pelo grafo. Ganho 0 porque ligar
  // o microfone no alto-falante seria larsen imediato.
  const sink = audio.createGain();
  sink.gain.value = 0;
  source.connect(analyser);
  analyser.connect(sink).connect(audio.destination);
  const data = new Float32Array(analyser.fftSize);
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const sample of data) sum += sample * sample;
    setMeter(Math.min(1, Math.sqrt(sum / data.length)));
  }, METER_MS);
  localMeter = { timer, analyser, source, sink };
}

// ---------------------------------------------------------------------------
// Teste do microfone: grava 3 s e devolve pela saída escolhida
// ---------------------------------------------------------------------------

function setTestStatus(text: string): void {
  if (ui !== null) ui.testStatus.textContent = text;
}

function paintTestButton(): void {
  const d = ui;
  if (d === null) return;
  if (testState === "recording") {
    d.testBtn.textContent = "Cancelar";
    d.testBtn.disabled = false;
    return;
  }
  d.testBtn.textContent = `Gravar e ouvir (${TEST_SECONDS} s)`;
  d.testBtn.disabled = testState !== "idle";
  // desabilitar o botão que está com o foco joga o foco no <body>, de onde o
  // Tab não passa mais pela armadilha do diálogo (mesma lição do M8)
  shell?.keepFocus();
}

/** Solta o microfone da gravação. Chamado assim que a gravação termina — não no fim da reprodução. */
function stopTestStream(): void {
  if (testStream === null) return;
  for (const track of testStream.getTracks()) track.stop();
  testStream = null;
}

function cancelTest(): void {
  testCancelled = true;
  if (recordTimer !== undefined) {
    clearInterval(recordTimer);
    recordTimer = undefined;
  }
  if (recorder !== null && recorder.state !== "inactive") recorder.stop();
  recorder = null;
  playback?.stop();
  playback = null;
  stopTestStream();
  testState = "idle";
  paintTestButton();
  // fechando o diálogo, quem chama é o onClose: religar o medidor aqui abriria
  // um AudioContext logo antes de ele ser destruído
  if (shell?.isOpen === true) startMeter();
}

async function startTest(): Promise<void> {
  const d = ui;
  if (d === null || testState !== "idle") return;
  testCancelled = false;
  testState = "opening";
  paintTestButton();
  setTestStatus("Abrindo o microfone…");
  try {
    testStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
  } catch (err) {
    testState = "idle";
    paintTestButton();
    setTestStatus(`Não deu para abrir o microfone: ${reason(err)}`);
    return;
  }
  if (testCancelled) {
    stopTestStream();
    return;
  }
  // a permissão acabou de ser concedida: os nomes dos dispositivos existem agora
  void refreshDevices();

  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(testStream);
  } catch (err) {
    stopTestStream();
    testState = "idle";
    paintTestButton();
    setTestStatus(`Este navegador não grava áudio: ${reason(err)}`);
    return;
  }
  const chunks: Blob[] = [];
  rec.addEventListener("dataavailable", (ev) => {
    if (ev.data.size > 0) chunks.push(ev.data);
  });
  rec.addEventListener("stop", () => {
    if (testCancelled) return;
    void playRecording(new Blob(chunks, { type: rec.mimeType }));
  });
  recorder = rec;
  rec.start();
  testState = "recording";
  paintTestButton();
  startMeter(); // passa a medir a captura de teste

  let left = TEST_SECONDS;
  setTestStatus(`Gravando… fale alguma coisa (${left} s)`);
  recordTimer = window.setInterval(() => {
    left -= 1;
    if (left > 0) {
      setTestStatus(`Gravando… fale alguma coisa (${left} s)`);
      return;
    }
    if (recordTimer !== undefined) clearInterval(recordTimer);
    recordTimer = undefined;
    if (rec.state !== "inactive") rec.stop();
  }, 1000);
}

/**
 * Reproduz a gravação pelo AudioContext do diálogo (que já está no sink
 * escolhido). **Não é um `<audio>` com `URL.createObjectURL`** de propósito: a
 * CSP de produção (apps/server/src/index.ts) é `default-src 'self'` sem
 * `media-src`, então um `blob:` seria bloqueado — e só em produção, que é o
 * pior tipo de bug. Decodificar e tocar por WebAudio não passa por URL nenhuma.
 */
async function playRecording(blob: Blob): Promise<void> {
  recorder = null;
  // diálogo já fechado: o `ensureCtx` abaixo abriria um AudioContext novo
  // (o do diálogo morre no onClose) que ninguém mais fecharia
  if (shell?.isOpen !== true) {
    stopTestStream();
    return;
  }
  stopTestStream(); // solta o microfone antes de reproduzir
  startMeter(); // volta para o medidor da chamada, ou zera
  const audio = ensureCtx();
  if (audio === null) {
    testState = "idle";
    paintTestButton();
    setTestStatus("Sem WebAudio neste navegador: não deu para reproduzir a gravação.");
    return;
  }
  let buffer: AudioBuffer;
  try {
    buffer = await audio.decodeAudioData(await blob.arrayBuffer());
  } catch (err) {
    testState = "idle";
    paintTestButton();
    setTestStatus(`A gravação não pôde ser decodificada: ${reason(err)}`);
    return;
  }
  if (testCancelled || shell === null || !shell.isOpen) return;
  testState = "playing";
  paintTestButton();
  setTestStatus("Reproduzindo o que foi gravado…");
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.connect(audio.destination);
  source.addEventListener("ended", () => {
    if (playback !== source) return;
    playback = null;
    testState = "idle";
    paintTestButton();
    setTestStatus("Ouviu a sua voz? Então o microfone e a saída escolhidos estão certos.");
  });
  playback = source;
  source.start();
}

// ---------------------------------------------------------------------------
// Teste da saída
// ---------------------------------------------------------------------------

/**
 * Toca um clipe do M8 NO DISPOSITIVO ESCOLHIDO. O `previewSound` do M8 não
 * serve aqui: ele toca no AudioContext do `sound/player.ts`, que não expõe o
 * contexto nem aceita sink — testar a saída por ele diria "o áudio funciona",
 * que é exatamente a pergunta que já não estava em dúvida.
 *
 * O ganho é o do catálogo (≈ -20 dBFS de RMS) e NÃO o volume geral dos sons: o
 * que se testa aqui é o dispositivo, não a calibragem — e um teste mudo porque
 * a pessoa desligou os sons do app no outro diálogo seria só confusão.
 */
async function playOutputTest(): Promise<void> {
  const d = ui;
  if (d === null) return;
  const audio = ensureCtx();
  if (audio === null) {
    d.outStatus.textContent = "Sem WebAudio neste navegador: não deu para tocar o teste.";
    return;
  }
  d.outBtn.disabled = true;
  shell?.keepFocus();
  d.outStatus.textContent = "Tocando…";
  try {
    if (testClip === null) {
      const res = await fetch(SOUND_URL[OUTPUT_TEST_SOUND]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      testClip = await audio.decodeAudioData(await res.arrayBuffer());
    }
  } catch (err) {
    d.outBtn.disabled = false;
    d.outStatus.textContent = `Não deu para carregar o som de teste: ${reason(err)}`;
    return;
  }
  const source = audio.createBufferSource();
  source.buffer = testClip;
  const gain = audio.createGain();
  gain.gain.value = CATALOG[OUTPUT_TEST_SOUND].gain;
  source.connect(gain).connect(audio.destination);
  source.addEventListener("ended", () => {
    if (ui === null) return;
    ui.outBtn.disabled = false;
    ui.outStatus.textContent = "Ouviu no fone/caixa certo? Então a saída está certa.";
  });
  source.start();
}

// ---------------------------------------------------------------------------
// Prévia da câmera
// ---------------------------------------------------------------------------

function previewOn(): boolean {
  return camStream !== null || camBorrowed;
}

function stopCameraPreview(): void {
  const d = ui;
  // só paro o que é MEU: o track emprestado é o da chamada, e pará-lo
  // derrubaria a câmera de quem está assistindo
  if (camStream !== null) {
    for (const track of camStream.getTracks()) track.stop();
    camStream = null;
  }
  camBorrowed = false;
  if (d !== null) {
    d.camVideo.srcObject = null;
    d.camVideo.hidden = true;
    d.camBtn.textContent = "Ativar prévia";
    d.camHint.textContent = "A prévia abre a câmera só enquanto esta janela estiver aberta.";
  }
}

async function startCameraPreview(): Promise<void> {
  const d = ui;
  const c = client;
  if (d === null || c === null || previewOn()) return;
  d.camBtn.disabled = true;
  shell?.keepFocus();
  const live = c.cameraTrack;
  try {
    if (live !== null) {
      // a câmera já está aberta pela chamada: abrir uma SEGUNDA captura do
      // mesmo dispositivo falha em boa parte das webcams do Windows
      d.camVideo.srcObject = new MediaStream([live]);
      camBorrowed = true;
      d.camHint.textContent = "Mostrando a câmera que já está ligada na chamada.";
    } else {
      camStream = await navigator.mediaDevices.getUserMedia({ video: camConstraints() });
      d.camVideo.srcObject = camStream;
      d.camHint.textContent = "A prévia é só sua — ninguém na chamada está vendo isto.";
    }
  } catch (err) {
    d.camBtn.disabled = false;
    d.camHint.textContent = `Não deu para abrir a câmera: ${reason(err)}`;
    return;
  }
  d.camVideo.hidden = false;
  d.camBtn.disabled = false;
  d.camBtn.textContent = "Desligar prévia";
  void d.camVideo.play().catch(() => undefined);
  // a permissão de câmera acabou de sair: os nomes das câmeras existem agora
  void refreshDevices();
}

/** Depois de trocar de câmera: a prévia precisa reapontar para o track novo. */
async function restartCameraPreview(): Promise<void> {
  if (!previewOn()) return;
  stopCameraPreview();
  await startCameraPreview();
}

// ---------------------------------------------------------------------------
// Dispositivos
// ---------------------------------------------------------------------------

/**
 * Preenche um `<select>` e diz se o desejo guardado EXISTE na lista atual.
 * Quando não existe, o select mostra "Padrão do sistema" (que é o que o
 * navegador vai usar de fato) mas a preferência continua guardada.
 */
function fillSelect(select: HTMLSelectElement, kind: DeviceKind, fallbackName: string): boolean {
  const wish = prefs[kind];
  const list = listFor(kind);
  select.replaceChildren();
  const auto = el("option", "", "Padrão do sistema");
  auto.value = "";
  select.append(auto);
  let found = false;
  list.forEach((device, index) => {
    // sem permissão o `label` vem vazio (regra do navegador, não bug): um
    // <option> em branco pareceria lista quebrada, então numeramos
    const option = el("option", "", device.label !== "" ? device.label : `${fallbackName} ${index + 1}`);
    option.value = device.deviceId;
    if (device.deviceId === wish.id) found = true;
    select.append(option);
  });
  select.value = found ? (wish.id ?? "") : "";
  return wish.id === null || found;
}

function paintDevices(): void {
  const d = ui;
  if (d === null) return;
  const ok: Record<DeviceKind, boolean> = {
    mic: fillSelect(d.micSelect, "mic", "Microfone"),
    output: fillSelect(d.outSelect, "output", "Saída"),
    camera: fillSelect(d.camSelect, "camera", "Câmera"),
  };

  // aviso de "o escolhido sumiu" — nomeando qual, que é a única forma de a
  // pessoa saber se aquilo importa (ver a decisão 3 no cabeçalho)
  const missing = (Object.keys(ok) as DeviceKind[]).filter((kind) => !ok[kind]);
  d.lostNote.hidden = missing.length === 0;
  d.lostNote.textContent =
    missing.length === 0
      ? ""
      : missing
          .map((kind) => {
            const name = prefs[kind].label !== "" ? `“${prefs[kind].label}”` : "que você escolheu";
            return `${KIND_NOUN[kind]} ${name} não está disponível agora — usando o padrão do sistema. A escolha foi mantida: religue o dispositivo e ela volta sozinha.`;
          })
          .join(" ");

  // labels vazios = ainda sem permissão de mídia. Lista anônima sem explicação
  // é o pior dos mundos: parece que o app não achou os dispositivos.
  const anyDevice = devices.audioInputs.length + devices.audioOutputs.length + devices.videoInputs.length > 0;
  const anonymous = [...devices.audioInputs, ...devices.audioOutputs, ...devices.videoInputs].every(
    (device) => device.label === "",
  );
  d.permissionNote.hidden = !(anyDevice && anonymous);
}

async function refreshDevices(): Promise<void> {
  const c = client;
  if (c === null) return;
  try {
    devices = await c.listDevices();
  } catch (err) {
    console.warn("voz: não deu para enumerar os dispositivos", err);
    devices = { audioInputs: [], audioOutputs: [], videoInputs: [] };
  }
  paintDevices();
  // o desejo pode ter VOLTADO (headset replugado): reaplicar aqui é o que faz
  // a preferência se restaurar sozinha, sem a pessoa reescolher
  for (const kind of ["mic", "camera", "output"] as const) {
    const wish = prefs[kind];
    if (wish.id === null) continue;
    if (!listFor(kind).some((device) => device.deviceId === wish.id)) continue;
    void applyWish(kind, wish.id).catch((err: unknown) => console.warn("voz: reaplicar dispositivo falhou", err));
  }
}

async function applyWish(kind: DeviceKind, id: string | null): Promise<void> {
  const c = client;
  if (c === null) return;
  if (kind === "output") {
    if (c.outputDevice === id) return;
    await c.setOutputDevice(id);
    await applySinkToCtx();
    return;
  }
  // setInputDevice já sai fora quando o id é o mesmo — barato de chamar à toa
  await c.setInputDevice(kind === "mic" ? "audio" : "video", id);
}

/** Um `change` de `<select>`: guarda o desejo (id + nome) e aplica no cliente. */
function onPick(kind: DeviceKind, select: HTMLSelectElement): void {
  const id = select.value === "" ? null : select.value;
  const label = id === null ? "" : (listFor(kind).find((device) => device.deviceId === id)?.label ?? "");
  prefs[kind] = { id, label };
  savePrefs();
  paintDevices();
  void applyWish(kind, id)
    // a prévia mostra um track que acabou de ser trocado: sem reapontar, ela
    // continuaria congelada na câmera antiga
    .then(() => (kind === "camera" ? restartCameraPreview() : undefined))
    .catch((err: unknown) => {
      const d = ui;
      if (d === null) return;
      const message = `Não deu para usar esse dispositivo: ${reason(err)}`;
      if (kind === "camera") d.camHint.textContent = message;
      else if (kind === "mic") d.testStatus.textContent = message;
      else d.outStatus.textContent = message;
    });
}

// ---------------------------------------------------------------------------
// Processamento do microfone
// ---------------------------------------------------------------------------

function setProcessing(key: keyof AudioProcessing, on: boolean): void {
  const next: AudioProcessing = { ...prefs.processing };
  next[key] = on;
  prefs.processing = next;
  savePrefs();
  paintEchoWarning();
  void client?.setAudioProcessing(next).catch((err: unknown) => {
    if (ui !== null) ui.testStatus.textContent = `O navegador recusou a mudança: ${reason(err)}`;
  });
}

function paintEchoWarning(): void {
  if (ui !== null) ui.echoWarn.hidden = prefs.processing.echoCancellation;
}

// ---------------------------------------------------------------------------
// Qualidade da conexão
// ---------------------------------------------------------------------------

function paintStats(stats: ConnectionStats | null): void {
  const d = ui;
  if (d === null) return;
  const value = (row: StatRow, text: string): void => {
    const node = d.statValues.get(row);
    if (node !== undefined) node.textContent = text;
  };
  if (stats === null) {
    for (const row of ["rtt", "loss", "jitter", "rate"] as const) value(row, "—");
    d.statPill.textContent = QUALITY_LABEL.desconhecida;
    d.statPill.className = "vs-pill is-desconhecida";
    d.statHint.textContent = "Entre em um canal de voz para medir a conexão.";
    return;
  }
  const ms = (n: number | null): string => (n === null ? "—" : `${n} ms`);
  const pct = (n: number | null): string => (n === null ? "—" : `${n}%`);
  value("rtt", ms(stats.rttMs));
  value("jitter", ms(stats.jitterMs));
  value("loss", `envio ${pct(stats.sendLossPct)} · recepção ${pct(stats.recvLossPct)}`);
  value(
    "rate",
    stats.sendKbps === null || stats.recvKbps === null ? "—" : `envio ${stats.sendKbps} · recepção ${stats.recvKbps} kbps`,
  );
  d.statPill.textContent = QUALITY_LABEL[stats.quality];
  d.statPill.className = `vs-pill is-${stats.quality}`;
  // perdas e taxas são DELTAS entre duas amostras: a primeira não tem com o
  // que comparar e vem em null. Dizer isso evita o "por que está tudo vazio?"
  d.statHint.textContent =
    stats.sendKbps === null
      ? `Medindo… perda e taxa aparecem na segunda leitura (${STATS_MS / 1000} s).`
      : `Atualiza a cada ${STATS_MS / 1000} s enquanto esta janela estiver aberta.`;
}

function startStats(): void {
  stopStats();
  statsToken += 1;
  const token = statsToken;
  const tick = async (): Promise<void> => {
    const c = client;
    if (c === null || token !== statsToken) return;
    let stats: ConnectionStats | null = null;
    try {
      stats = await c.getConnectionStats();
    } catch (err) {
      console.warn("voz: getStats falhou", err);
    }
    if (token !== statsToken) return; // o diálogo fechou durante a amostragem
    paintStats(stats);
  };
  void tick();
  statsTimer = window.setInterval(() => void tick(), STATS_MS);
}

function stopStats(): void {
  statsToken += 1; // invalida qualquer resposta em voo
  if (statsTimer !== undefined) {
    clearInterval(statsTimer);
    statsTimer = undefined;
  }
}

// ---------------------------------------------------------------------------
// Construção
// ---------------------------------------------------------------------------

function section(title: string): HTMLElement {
  const node = el("section", "vs-section");
  const heading = el("h3", "vs-section-title", title);
  node.append(heading);
  return node;
}

function deviceRow(kind: DeviceKind, id: string, labelText: string): { row: HTMLElement; select: HTMLSelectElement } {
  const row = el("div", "vs-field");
  const label = el("label", "vs-field-label", labelText);
  label.htmlFor = id;
  const select = el("select", "vs-select");
  select.id = id;
  // `change` e não `input`: no <select> os dois disparam junto, e `change` é o
  // que o teclado emite ao CONFIRMAR — com `input`, navegar de seta pela lista
  // trocaria o microfone a cada opção percorrida
  select.addEventListener("change", () => onPick(kind, select));
  row.append(label, select);
  return { row, select };
}

/** Chave liga/desliga: reusa o `.settings-switch` do M8 (é a primitiva, não o diálogo dele). */
function switchInput(id: string): HTMLInputElement {
  const input = el("input", "settings-switch");
  input.type = "checkbox";
  input.id = id;
  return input;
}

function statRow(label: string, hint: string): { row: HTMLElement; value: HTMLElement } {
  const row = el("div", "vs-stat");
  const name = el("span", "vs-stat-label", label);
  const value = el("span", "vs-stat-value", "—");
  const desc = el("span", "vs-stat-desc", hint);
  row.append(name, value, desc);
  return { row, value };
}

function build(): { shell: DialogShell; ui: Ui } {
  const dialog = createDialog({
    id: "voice-settings",
    title: "Voz e vídeo",
    onOpen: () => {
      void refreshDevices();
      navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
      paintProcessing();
      startMeter();
      startStats();
    },
    onClose: () => {
      navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
      stopStats();
      stopMeter();
      cancelTest();
      stopCameraPreview();
      // fechar o contexto solta o dispositivo de saída — deixá-lo aberto
      // mantém o fone "em uso" para o sistema mesmo com o diálogo fechado
      if (ctx !== null) {
        void ctx.close().catch(() => undefined);
        ctx = null;
        testClip = null; // o buffer pertence ao contexto que acabou de morrer
      }
    },
  });

  // --- aviso de permissão (nomes dos dispositivos)
  const permissionNote = el("div", "vs-note vs-warn");
  permissionNote.hidden = true;
  permissionNote.append(
    el(
      "span",
      "",
      "Os nomes dos dispositivos só aparecem depois que você autoriza o acesso — até lá a lista fica numerada. " +
        "O botão pede o microfone; os nomes das câmeras aparecem ao ativar a prévia.",
    ),
  );
  const permissionBtn = el("button", "vs-btn", "Permitir microfone");
  permissionBtn.type = "button";
  permissionBtn.addEventListener("click", () => void askPermission());
  permissionNote.append(permissionBtn);

  const lostNote = el("p", "vs-note vs-warn");
  lostNote.hidden = true;

  // --- microfone
  const micSection = section("Microfone");
  const mic = deviceRow("mic", "vs-mic", "Dispositivo de entrada");
  const meter = el("div", "vs-meter");
  // a barra é decoração: quem navega por leitor de tela não tem como julgar
  // uma barrinha — para essa pessoa o teste honesto é o "Gravar e ouvir",
  // cujo estado sai em texto no `vs-status` (aria-live)
  meter.setAttribute("aria-hidden", "true");
  const meterFill = el("div", "vs-meter-fill");
  meter.append(meterFill);
  const meterHint = el("p", "vs-hint");
  const testBtn = el("button", "vs-btn", "");
  testBtn.type = "button";
  testBtn.addEventListener("click", () => {
    if (testState === "recording") cancelTest();
    else void startTest();
  });
  const testStatus = el("p", "vs-status");
  // o estado do teste é a única saída não-visual desta seção
  testStatus.setAttribute("aria-live", "polite");
  const testNote = el(
    "p",
    "vs-hint",
    "Grava alguns segundos e devolve pelo dispositivo de saída escolhido: é o único jeito de saber que o áudio realmente SAI. Dentro de uma chamada, os outros podem ouvir a reprodução.",
  );
  micSection.append(mic.row, meter, meterHint, testBtn, testStatus, testNote);

  // --- processamento
  const procSection = section("Processamento do microfone");
  const toggles = new Map<keyof AudioProcessing, HTMLInputElement>();
  for (const spec of PROCESSING) {
    const input = switchInput(`vs-proc-${spec.key}`);
    input.addEventListener("change", () => setProcessing(spec.key, input.checked));
    toggles.set(spec.key, input);
    const row = el("div", "vs-switch-row");
    const label = el("label", "vs-switch-label", spec.label);
    label.htmlFor = input.id;
    row.append(input, label, el("p", "vs-switch-desc", spec.desc));
    procSection.append(row);
  }
  const echoWarn = el(
    "p",
    "vs-note vs-warn",
    "Sem cancelamento de eco e sem headset, o som dos seus alto-falantes volta pelo seu microfone: quem escuta o eco são OS OUTROS, não você — e ninguém vai saber que a origem é a sua máquina.",
  );
  echoWarn.hidden = true;
  procSection.append(echoWarn);

  // --- saída
  const outSection = section("Saída de áudio");
  const out = deviceRow("output", "vs-out", "Dispositivo de saída");
  const outBtn = el("button", "vs-btn", "Tocar som de teste");
  outBtn.type = "button";
  outBtn.addEventListener("click", () => void playOutputTest());
  const outStatus = el("p", "vs-status");
  outStatus.setAttribute("aria-live", "polite");
  outSection.append(
    out.row,
    outBtn,
    outStatus,
    el(
      "p",
      "vs-hint",
      "O teste toca no dispositivo escolhido aqui, não no padrão do Windows. Se o som sair no lugar errado, é este seletor que resolve.",
    ),
  );

  // --- câmera
  const camSection = section("Câmera");
  const cam = deviceRow("camera", "vs-cam", "Dispositivo de vídeo");
  const camVideo = el("video", "vs-preview");
  camVideo.muted = true;
  camVideo.autoplay = true;
  camVideo.playsInline = true;
  camVideo.hidden = true;
  const camBtn = el("button", "vs-btn", "Ativar prévia");
  camBtn.type = "button";
  camBtn.addEventListener("click", () => {
    if (previewOn()) stopCameraPreview();
    else void startCameraPreview();
  });
  const camHint = el("p", "vs-hint", "A prévia abre a câmera só enquanto esta janela estiver aberta.");
  camSection.append(cam.row, camBtn, camVideo, camHint);

  // --- qualidade da conexão
  const statsSection = section("Qualidade da conexão");
  // O veredito é uma LINHA e não um enfeite no título: título que muda de
  // nome ("Qualidade da conexão Ruim") confunde leitor de tela, e o resumo
  // precisa ser anunciado quando muda — daí o aria-live aqui.
  const verdict = el("div", "vs-stat");
  const statPill = el("span", "vs-pill is-desconhecida", QUALITY_LABEL.desconhecida);
  verdict.setAttribute("aria-live", "polite");
  verdict.append(el("span", "vs-stat-label", "Estado"), statPill);
  statsSection.append(verdict);
  const statValues = new Map<StatRow, HTMLElement>();
  const rows: [StatRow, string, string][] = [
    ["rtt", "Latência", "ida e volta até o servidor; acima de 150 ms a conversa começa a atropelar"],
    ["loss", "Perda de pacotes", "o que não chegou; acima de 2% a voz picota"],
    ["jitter", "Jitter", "variação na chegada do áudio; alto = voz robótica mesmo com latência baixa"],
    ["rate", "Taxa", "quanto está subindo e descendo agora"],
  ];
  for (const [key, label, hint] of rows) {
    const row = statRow(label, hint);
    statValues.set(key, row.value);
    statsSection.append(row.row);
  }
  const statHint = el("p", "vs-hint");
  statsSection.append(statHint);

  dialog.body.append(permissionNote, lostNote, micSection, procSection, outSection, camSection, statsSection);

  const done = el("button", "vs-done", "Concluir");
  done.type = "button";
  done.addEventListener("click", () => dialog.close());
  dialog.foot.append(done);

  return {
    shell: dialog,
    ui: {
      permissionNote,
      permissionBtn,
      lostNote,
      micSelect: mic.select,
      meterFill,
      meterHint,
      testBtn,
      testStatus,
      toggles,
      echoWarn,
      outSelect: out.select,
      outBtn,
      outStatus,
      camSelect: cam.select,
      camBtn,
      camVideo,
      camHint,
      statValues,
      statPill,
      statHint,
    },
  };
}

/**
 * Permissão só para revelar os nomes: pede o microfone, e **desliga na hora**.
 * Ficar com a captura aberta depois disso acenderia a luz do microfone sem
 * nenhuma razão — a captura de verdade é a do teste ou a da chamada.
 */
async function askPermission(): Promise<void> {
  const d = ui;
  if (d === null) return;
  d.permissionBtn.disabled = true;
  shell?.keepFocus();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
  } catch (err) {
    d.permissionBtn.disabled = false;
    d.testStatus.textContent = `Sem permissão de microfone: ${reason(err)}`;
    return;
  }
  d.permissionBtn.disabled = false;
  await refreshDevices();
}

function onDeviceChange(): void {
  // plugar/tirar headset reordena a lista inteira: repintar do zero é o que
  // mantém a seleção coerente (o desejo é por id, não por posição)
  void refreshDevices();
}

function paintProcessing(): void {
  const d = ui;
  if (d === null) return;
  // a fonte da verdade é o VoiceClient quando ele existe: ele pode ter sido
  // ajustado por outro caminho, e o diálogo não pode discordar dele
  const current = client?.audioProcessing ?? prefs.processing;
  for (const [key, input] of d.toggles) input.checked = current[key];
  prefs.processing = { ...current };
  paintEchoWarning();
  paintTestButton();
  setTestStatus("");
  d.outStatus.textContent = "";
}

// ---------------------------------------------------------------------------
// Abrir e fechar
// ---------------------------------------------------------------------------

/**
 * Abre o diálogo. `deps` é o VoiceClient (a classe satisfaz a interface);
 * `opener` é quem recebe o foco de volta ao fechar — por padrão a engrenagem
 * do painel do usuário, que é de onde ele vem.
 */
export function openVoiceSettings(deps: VoiceSettingsDeps, opener?: HTMLElement): void {
  client = deps;
  if (shell === null || ui === null) {
    const built = build();
    shell = built.shell;
    ui = built.ui;
  }
  shell.open(opener ?? document.getElementById("user-settings") ?? undefined);
}

export function closeVoiceSettings(): void {
  shell?.close();
}

/**
 * Item pronto para o menu da engrenagem (sidebar.ts), gêmeo do `soundMenuItem`
 * do M8 — existe para o integrador não redigitar classe, `role` e rótulo.
 */
export function voiceSettingsMenuItem(
  deps: VoiceSettingsDeps,
  opener: HTMLElement,
  onPickItem?: () => void,
): HTMLButtonElement {
  const item = el("button", "menu-item");
  item.type = "button";
  item.setAttribute("role", "menuitem");
  item.append(icon("mic", 16), document.createTextNode("Voz e vídeo"));
  item.addEventListener("click", () => {
    onPickItem?.();
    openVoiceSettings(deps, opener);
  });
  return item;
}
