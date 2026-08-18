import {
  CloseCode,
  type Channel,
  type DispatchName,
  type Message,
  type ReadyData,
  type User,
  type VoiceState,
} from "@danjocord/protocol";
import { GatewayClient, type GatewayStatus } from "./gateway.js";
import { API, AuthError, devLogin, exchangeOtc, getAccessToken, getUser, hydrateAuth, logout, refresh } from "./auth.js";
import { desktop } from "./bridge.js";
import { playJoin, playLeave } from "./sounds.js";
import { TypingSender, TypingTracker, typingLabel } from "./typing.js";
import { VoiceClient } from "./voice.js";

// Em produção same-origin a API é https e o replace produz wss:// (doc §4).
const GATEWAY = API.replace(/^http/, "ws") + "/gateway";

// resto do M0: o token dev cru não é mais a credencial — limpa na passagem
localStorage.removeItem("danjocord_token");

const el = {
  // tela de login
  login: document.getElementById("login")!,
  loginError: document.getElementById("login-error")!,
  loginDiscord: document.getElementById("login-discord") as HTMLButtonElement,
  devForm: document.getElementById("dev-form") as HTMLFormElement,
  devUsername: document.getElementById("dev-username") as HTMLInputElement,
  // app
  app: document.getElementById("app")!,
  meAvatar: document.getElementById("me-avatar") as HTMLImageElement,
  meName: document.getElementById("me-name")!,
  logout: document.getElementById("logout") as HTMLButtonElement,
  status: document.getElementById("status")!,
  channels: document.getElementById("channels")!,
  members: document.getElementById("members")!,
  messages: document.getElementById("messages")!,
  typing: document.getElementById("typing")!,
  composer: document.getElementById("composer") as HTMLFormElement,
  input: document.getElementById("input") as HTMLInputElement,
  // voz (M3)
  voiceFooter: document.getElementById("voice-footer")!,
  voiceFooterStatus: document.getElementById("voice-footer-status")!,
  voiceFooterChannel: document.getElementById("voice-footer-channel")!,
  voiceMute: document.getElementById("voice-mute") as HTMLButtonElement,
  voiceDeafen: document.getElementById("voice-deafen") as HTMLButtonElement,
  voiceLeave: document.getElementById("voice-leave") as HTMLButtonElement,
  // vídeo (M4)
  voiceCamera: document.getElementById("voice-camera") as HTMLButtonElement,
  videoPanel: document.getElementById("video-panel")!,
  videoGrid: document.getElementById("video-grid")!,
  videoCollapse: document.getElementById("video-collapse") as HTMLButtonElement,
  // screen share (M5)
  voiceStream: document.getElementById("voice-stream") as HTMLButtonElement,
  streamPanel: document.getElementById("stream-panel")!,
  streamTitle: document.getElementById("stream-title")!,
  streamBox: document.getElementById("stream-box")!,
  streamStop: document.getElementById("stream-stop") as HTMLButtonElement,
  streamUnmute: document.getElementById("stream-unmute") as HTMLButtonElement,
  // push-to-talk (M6, só desktop)
  pttSection: document.getElementById("ptt-section")!,
  pttToggle: document.getElementById("ptt-toggle") as HTMLInputElement,
  pttLabel: document.getElementById("ptt-label")!,
  pttKey: document.getElementById("ptt-key") as HTMLButtonElement,
};

interface State {
  me: User | null;
  channels: Channel[];
  members: Map<string, User>;
  online: Set<string>;
  currentChannel: string | null;
  /** nonce → elemento renderizado otimisticamente, aguardando o Dispatch */
  pending: Map<string, HTMLElement>;
  /** user_id → estado de voz (M3) — só quem ESTÁ num canal; sair = sai do mapa */
  voiceStates: Map<string, VoiceState>;
  /** channel_id → user_ids falando AGORA (cada VOICE_SPEAKING substitui o conjunto) */
  speaking: Map<string, Set<string>>;
}
const state: State = {
  me: null,
  channels: [],
  members: new Map(),
  online: new Set(),
  currentChannel: null,
  pending: new Map(),
  voiceStates: new Map(),
  speaking: new Map(),
};

// ---------------------------------------------------------------------------
// Paginação + janela de DOM (M2, doc §8: leveza)
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;
/** teto de mensagens no DOM; o excedente sai do lado OPOSTO ao carregamento */
const MAX_RENDERED = 600;
/** px do topo que disparam a carga de mais histórico */
const TOP_THRESHOLD = 200;
/** px do fundo que contam como "colado no presente" (autoscroll / resync) */
const BOTTOM_THRESHOLD = 200;
const TYPING_TTL_MS = 10_000;
const TYPING_THROTTLE_MS = 8_000;

/**
 * Estado de paginação do canal ATUAL. Um objeto NOVO nasce a cada troca de
 * canal — o cursor (`before`) deriva do DOM, que é recriado na troca, então
 * nada do canal anterior pode vazar. Operações async capturam a referência
 * e comparam com `view` na volta: se trocou, a resposta é descartada.
 */
interface PaginationView {
  channelId: string;
  /** o servidor devolveu menos que PAGE_SIZE — não há mais histórico acima */
  reachedStart: boolean;
  loadingOlder: boolean;
  /**
   * a janela de DOM perdeu o fundo (trim após prepend): o fim renderizado já
   * não é o presente do canal, então MESSAGE_CREATE não pode dar append
   * (viraria buraco na timeline) — ao voltar ao fundo, recarrega o final
   */
  detachedBottom: boolean;
  resyncing: boolean;
}

function inertView(): PaginationView {
  // channelId vazio nunca casa com um canal real; reachedStart trava cargas
  return { channelId: "", reachedStart: true, loadingOlder: false, detachedBottom: false, resyncing: false };
}

let view: PaginationView = inertView();

// ---------------------------------------------------------------------------
// Typing (M2): tracker recebe TYPING_START, sender emite com throttle
// ---------------------------------------------------------------------------

const typingTracker = new TypingTracker(TYPING_TTL_MS, (channelId) => {
  if (channelId === state.currentChannel) renderTyping();
});

const typingSender = new TypingSender(TYPING_THROTTLE_MS, (channelId) => {
  // corpo "{}" de propósito: com content-type json, corpo vazio é 400 no Fastify
  void api(`/api/channels/${channelId}/typing`, { method: "POST", body: "{}" }).catch(() => {
    // melhor esforço — typing perdido não é erro que o usuário precise ver
  });
});

// ---------------------------------------------------------------------------
// Views: login ⇄ app
// ---------------------------------------------------------------------------

function showLogin(error?: string): void {
  el.app.hidden = true;
  el.login.hidden = false;
  el.loginError.textContent = error ?? "";
  el.loginError.hidden = error === undefined;
}

function startApp(): void {
  el.login.hidden = true;
  el.app.hidden = false;
  renderMe(getUser()); // snapshot do storage; o READY corrige se estiver velho
  setStatus("connecting");
  startGateway();
}

function resetState(): void {
  state.me = null;
  state.channels = [];
  state.members = new Map();
  state.online = new Set();
  state.currentChannel = null;
  state.pending = new Map();
  state.voiceStates = new Map();
  state.speaking = new Map();
  // mídia local cai junto com o logout (o servidor limpa via sessionGone);
  // o onChange do leaveLocal esconde o rodapé de voz
  voice.leaveLocal();
  view = inertView();
  typingTracker.clear(); // timers pendentes disparariam sobre um DOM vazio
  typingSender.clear();
  el.channels.replaceChildren();
  el.members.replaceChildren();
  el.messages.replaceChildren();
  el.typing.textContent = "";
}

function authErrorMessage(code: string): string {
  if (code === "not_allowed") return "Seu Discord não está na allowlist — peça convite ao dono.";
  return "Falha no login, tente de novo."; // state, discord e afins
}

function devErrorMessage(err: unknown): string {
  if (err instanceof AuthError && err.status === 404) {
    return "Login dev desligado neste servidor — use o Discord.";
  }
  return err instanceof AuthError ? `Login dev falhou: ${err.message}` : "Login dev falhou — servidor fora do ar?";
}

/**
 * Erro do oauthLogin() da ponte (M6): a rejeição carrega o auth_error que o
 * servidor mandou ao listener local (not_allowed etc.) OU um erro do próprio
 * fluxo (timeout de 120s, listener caiu) — o mapa de códigos cobre o primeiro
 * caso e o fallback genérico, os demais.
 */
function desktopLoginErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout|tempo/i.test(msg)) return "Tempo esgotado — tente entrar de novo.";
  return authErrorMessage(msg);
}

// ---------------------------------------------------------------------------
// Render (inalterado do M0, mais o usuário no header)
// ---------------------------------------------------------------------------

function setStatus(status: GatewayStatus): void {
  el.status.textContent =
    status === "online" ? "online" : status === "resuming" ? "retomando…" : status === "offline" ? "reconectando…" : "conectando…";
  el.status.className = status === "online" ? "online" : status === "offline" ? "offline" : "";
}

function renderMe(user: User | null): void {
  el.meName.textContent = user?.username ?? "";
  const avatar = user?.avatar_url ?? null;
  if (avatar !== null) {
    el.meAvatar.src = avatar;
    el.meAvatar.hidden = false;
  } else {
    el.meAvatar.removeAttribute("src");
    el.meAvatar.hidden = true;
  }
}

function renderChannels(): void {
  el.channels.replaceChildren(
    ...state.channels.map((c) => (c.type === "voice" ? voiceChannelEl(c) : textChannelEl(c))),
  );
}

function textChannelEl(c: Channel): HTMLElement {
  const btn = document.createElement("button");
  btn.textContent = "# " + c.name;
  btn.className = c.id === state.currentChannel ? "active" : "";
  btn.onclick = () => void selectChannel(c.id);
  return btn;
}

/** Canal de voz (M3): botão de join + lista de participantes logo abaixo. */
function voiceChannelEl(c: Channel): HTMLElement {
  const wrap = document.createElement("div");
  const btn = document.createElement("button");
  btn.textContent = "🔊 " + c.name;
  // .active aqui marca o canal de voz CONECTADO — independente do canal de
  // texto ativo (os dois realces coexistem; contrato do M3)
  btn.className = voice.channelId === c.id ? "active" : "";
  // entrar em voz NÃO troca o canal de texto atual
  btn.onclick = () => void joinVoice(c.id);
  wrap.append(btn);

  const inChannel = [...state.voiceStates.values()].filter((v) => v.channel_id === c.id);
  if (inChannel.length > 0) {
    const speaking = state.speaking.get(c.id);
    const ul = document.createElement("ul");
    ul.className = "voice-users";
    for (const v of inChannel) ul.append(voiceUserEl(v, speaking?.has(v.user_id) === true));
    wrap.append(ul);
  }
  return wrap;
}

function voiceUserEl(v: VoiceState, speaking: boolean): HTMLElement {
  const li = document.createElement("li");
  li.className = speaking ? "voice-user speaking" : "voice-user";
  const member = state.members.get(v.user_id);
  // mesmo fallback do MESSAGE_CREATE: membro ainda não conhecido vira placeholder
  const name = member?.username ?? `user-${v.user_id.slice(-4)}`;
  const avatarUrl = member?.avatar_url ?? null;
  if (avatarUrl !== null) {
    const img = document.createElement("img");
    img.className = "voice-avatar";
    img.alt = "";
    img.src = avatarUrl;
    li.append(img);
  } else {
    // sem avatar: círculo com a inicial (o anel de "falando" fica na borda)
    const initial = document.createElement("span");
    initial.className = "voice-avatar";
    initial.textContent = name.slice(0, 1).toUpperCase();
    li.append(initial);
  }
  const label = document.createElement("span");
  label.className = "voice-name";
  label.textContent = name;
  li.append(label);
  // badge AO VIVO (M5): self_stream é DERIVADO no servidor (producer source
  // screen vivo) — e o item vira "Assistir" para os OUTROS no mesmo canal
  // (viewers sob demanda, doc §3.6: ninguém consome sem clicar)
  if (v.self_stream) {
    const badge = document.createElement("span");
    badge.className = "live-badge";
    badge.textContent = "AO VIVO";
    li.append(badge);
    const isMe = v.user_id === state.me?.id;
    // NUNCA autoconsumo: o streamer não assiste a própria transmissão; e só
    // quem está CONECTADO neste canal tem transports para consumir
    if (!isMe && voice.connected && voice.channelId === v.channel_id) {
      li.classList.add("watchable");
      const watchingThis = voice.watchingUserId === v.user_id;
      li.title = watchingThis ? "Assistindo — use “Parar de assistir”" : "Assistir transmissão";
      if (!watchingThis) {
        li.onclick = () => {
          const producerId = voice.streamProducerIdOf(v.user_id);
          if (producerId === null) return; // anúncio ainda em trânsito — clique de novo
          void voice.watchStream(producerId, v.user_id).catch((err: unknown) => {
            console.warn("voz: falha ao assistir a transmissão", err);
            flashVoiceError("não foi possível assistir a esta transmissão"); // rev. M5 #2
          });
        };
      }
    }
  }
  // surdo implica mudo — um só ícone de áudio; a câmera (M4) soma o dela
  const icons: { icon: string; label: string }[] = [];
  if (v.self_video) icons.push({ icon: "📷", label: "câmera ligada" });
  if (v.self_deaf) icons.push({ icon: "🔕", label: "ensurdecido" });
  else if (v.self_mute) icons.push({ icon: "🔇", label: "mutado" });
  if (icons.length > 0) {
    const flags = document.createElement("span");
    flags.className = "voice-flags";
    flags.textContent = icons.map((i) => i.icon).join(" ");
    flags.title = icons.map((i) => i.label).join(", ");
    li.append(flags);
  }
  return li;
}

function renderMembers(): void {
  el.members.replaceChildren(
    ...[...state.members.values()].map((m) => {
      const li = document.createElement("li");
      li.textContent = m.username;
      if (state.online.has(m.id)) li.classList.add("online");
      return li;
    }),
  );
}

function authorName(id: string): string {
  return state.members.get(id)?.username ?? "?";
}

function renderTyping(): void {
  const cid = state.currentChannel;
  const names = cid === null ? [] : typingTracker.typers(cid).map(authorName);
  el.typing.textContent = typingLabel(names);
}

function messageEl(msg: Message, pending = false): HTMLElement {
  const div = document.createElement("div");
  div.className = pending ? "msg pending" : "msg";
  // âncora para MESSAGE_UPDATE/DELETE acharem o elemento; no pending é o
  // nonce (uuid), que nunca colide com um snowflake numérico
  div.dataset.id = msg.id;
  const time = new Date(msg.created_at).toLocaleTimeString();
  const edited = msg.edited_at != null ? `<span class="muted"> (editado)</span>` : "";
  div.innerHTML = `<span class="author"></span><span class="content"></span>${edited}<span class="time">${time}</span>`;
  div.querySelector(".author")!.textContent = authorName(msg.author_id);
  div.querySelector(".content")!.textContent = msg.content;
  // pending ainda não existe no servidor — sem id real, não há o que editar
  if (!pending) appendActions(div, msg);
  return div;
}

function findMessageEl(id: string): HTMLElement | null {
  return el.messages.querySelector<HTMLElement>(`.msg[data-id="${id}"]`);
}

// ---------------------------------------------------------------------------
// Edição e exclusão (M2): PATCH/DELETE são a fonte da verdade; o broadcast
// MESSAGE_UPDATE/DELETE reconcilia todos os clientes (inclusive este — as
// substituições diretas abaixo são só resposta imediata, e são idempotentes)
// ---------------------------------------------------------------------------

function appendActions(div: HTMLElement, msg: Message): void {
  const own = msg.author_id === state.me?.id;
  // apagar: autor OU admin; editar: só o autor (espelha as regras do servidor)
  const canDelete = own || state.me?.is_admin === true;
  if (!own && !canDelete) return;
  const actions = document.createElement("span");
  actions.className = "actions";
  if (own) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "✎";
    edit.title = "Editar";
    edit.onclick = () => startEdit(div, msg);
    actions.append(edit);
  }
  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "✕";
  del.title = "Apagar";
  del.onclick = () => confirmDelete(msg);
  actions.append(del);
  div.append(actions);
}

function startEdit(container: HTMLElement, msg: Message): void {
  if (container.querySelector(".edit-input")) return; // já em edição
  const content = container.querySelector(".content");
  if (!content) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "edit-input";
  input.maxLength = 4000;
  input.value = msg.content;
  content.replaceWith(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  // cancelar = reconstruir o elemento do zero (mais simples que restaurar spans)
  const cancel = () => container.replaceWith(messageEl(msg));
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      cancel();
      return;
    }
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const next = input.value.trim();
    if (next === "" || next === msg.content) {
      cancel();
      return;
    }
    input.disabled = true; // evita Enter duplo virar dois PATCHes
    void api(`/api/channels/${msg.channel_id}/messages/${msg.id}`, {
      method: "PATCH",
      body: JSON.stringify({ content: next }),
    }).then(
      (updated) => {
        // lookup por id (não pelo container): o broadcast pode ter chegado antes
        findMessageEl(msg.id)?.replaceWith(messageEl(updated as Message));
      },
      () => {
        // 403/404/rede: restaura o original, se o broadcast já não o refez
        if (container.isConnected) container.replaceWith(messageEl(msg));
      },
    );
  });
}

function confirmDelete(msg: Message): void {
  if (!confirm("Apagar esta mensagem?")) return;
  void api(`/api/channels/${msg.channel_id}/messages/${msg.id}`, { method: "DELETE" })
    .then(() => findMessageEl(msg.id)?.remove())
    .catch(() => {
      // 403/404/rede: a mensagem fica; o estado real volta pelo broadcast
    });
}

// ---------------------------------------------------------------------------
// Canal atual + paginação por cursor (M2, doc §6): before = id da mensagem
// mais antiga renderizada; prepend preserva o ponto de leitura via delta de
// scrollHeight (o CSS desliga o scroll anchoring do navegador para não brigar)
// ---------------------------------------------------------------------------

async function selectChannel(channelId: string): Promise<void> {
  state.currentChannel = channelId;
  renderChannels();
  renderTyping(); // troca a barra para os digitadores DESTE canal (ou nada)
  view = { channelId, reachedStart: true, loadingOlder: false, detachedBottom: false, resyncing: false };
  // DOM e pendências do canal anterior somem JÁ: se o fetch abaixo falhar, uma
  // lista vazia é honesta — a antiga viraria timeline mista com o canal novo
  el.messages.replaceChildren();
  state.pending.clear();
  resyncBuffer = [];
  await loadLatest(channelId);
  // canal curto numa tela alta pode não ter rolagem — sem evento de scroll,
  // a única chance de completar a janela é agora
  if (view.channelId === channelId) void maybeLoadOlder();
}

/**
 * MESSAGE_CREATEs que chegam DURANTE um loadLatest: o snapshot do servidor
 * pode não os conter e o replaceChildren os descartaria — ficam aqui e são
 * aplicados depois do replace (dedup por data-id).
 */
let resyncBuffer: Message[] = [];

/** Carrega o FINAL do canal (últimas PAGE_SIZE) e cola o scroll no fundo. */
async function loadLatest(channelId: string): Promise<void> {
  const v = view;
  // loadingOlder junto: um resync no meio de um prepend em voo trocaria o DOM
  // sob o cursor do maybeLoadOlder e a resposta tardia abriria buraco na timeline
  if (v.channelId !== channelId || v.resyncing || v.loadingOlder) return;
  v.resyncing = true;
  try {
    const history = (await api(`/api/channels/${channelId}/messages?limit=${PAGE_SIZE}`)) as Message[];
    if (v !== view || state.currentChannel !== channelId) return; // trocou de canal durante o fetch
    v.reachedStart = history.length < PAGE_SIZE;
    v.detachedBottom = false;
    history.reverse();
    el.messages.replaceChildren(...history.map((m) => messageEl(m)));
    // drena o que chegou pelo gateway durante o fetch e não veio no snapshot
    for (const m of resyncBuffer) {
      if (m.channel_id === channelId && findMessageEl(m.id) === null) el.messages.append(messageEl(m));
    }
    resyncBuffer = [];
    el.messages.scrollTop = el.messages.scrollHeight;
  } catch {
    if (v === view && state.currentChannel === channelId && el.messages.childElementCount === 0) {
      // canal recém-trocado sem nada na tela: dá um gatilho manual de retry
      // (sem conteúdo não há scroll, e sem scroll nenhum gatilho automático)
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "load-retry";
      retry.textContent = "Falha ao carregar mensagens — tentar de novo";
      retry.onclick = () => {
        retry.remove();
        void loadLatest(channelId);
      };
      el.messages.replaceChildren(retry);
    }
  } finally {
    v.resyncing = false;
  }
}

async function maybeLoadOlder(): Promise<void> {
  const v = view;
  const cid = state.currentChannel;
  if (cid === null || v.channelId !== cid || v.loadingOlder || v.resyncing || v.reachedStart) return;
  if (el.messages.scrollTop > TOP_THRESHOLD) return;
  // o cursor sai do DOM (não de um contador): pending fica de fora porque o
  // data-id dele é nonce, não um snowflake que o servidor entenda como before
  const before = el.messages.querySelector<HTMLElement>(".msg:not(.pending)")?.dataset.id;
  if (before === undefined) return;
  v.loadingOlder = true;
  try {
    const older = (await api(`/api/channels/${cid}/messages?limit=${PAGE_SIZE}&before=${before}`)) as Message[];
    if (v !== view || state.currentChannel !== cid) return;
    // um resync (loadLatest) trocou o DOM durante o fetch: o cursor sumiu e
    // prependar aqui costuraria um trecho antigo num DOM novo — buraco na
    // timeline E reachedStart falso (achado nº 1 da revisão do M2)
    if (findMessageEl(before) === null) return;
    if (older.length < PAGE_SIZE) v.reachedStart = true; // acabou o histórico: para de pedir
    if (older.length > 0) {
      const prevHeight = el.messages.scrollHeight;
      const frag = document.createDocumentFragment();
      older.reverse();
      for (const m of older) frag.append(messageEl(m));
      el.messages.prepend(frag);
      // tudo que cresceu acima do viewport vira delta — o texto sob os olhos não se move
      el.messages.scrollTop += el.messages.scrollHeight - prevHeight;
      trimBottom(v);
    }
  } catch {
    // falhou: sem retry automático — o próximo scroll perto do topo tenta de novo
  } finally {
    v.loadingOlder = false;
  }
  // viewport alto demais para a página carregada: ainda sem rolagem, completa já
  if (v === view && !v.reachedStart && el.messages.scrollTop <= TOP_THRESHOLD) void maybeLoadOlder();
}

/** Prepend estourou a janela: o excedente sai do FUNDO (lado oposto à carga). */
function trimBottom(v: PaginationView): void {
  if (el.messages.childElementCount <= MAX_RENDERED) return;
  while (el.messages.childElementCount > MAX_RENDERED) el.messages.lastElementChild?.remove();
  v.detachedBottom = true;
}

/** Append estourou a janela: o excedente sai do TOPO (lado oposto à carga). */
function trimTop(v: PaginationView): void {
  if (el.messages.childElementCount <= MAX_RENDERED) return;
  const prevHeight = el.messages.scrollHeight;
  const prevTop = el.messages.scrollTop;
  while (el.messages.childElementCount > MAX_RENDERED) el.messages.firstElementChild?.remove();
  // compensa o que sumiu acima, senão o conteúdo visível pula para cima
  el.messages.scrollTop = prevTop - (prevHeight - el.messages.scrollHeight);
  // o que saiu do DOM volta a ser "histórico acima da janela": pode pedir de novo
  v.reachedStart = false;
}

function nearBottom(): boolean {
  return el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight <= BOTTOM_THRESHOLD;
}

el.messages.addEventListener("scroll", () => {
  void maybeLoadOlder();
  // janela sem fundo + usuário voltou ao fundo = recarrega o presente do canal
  if (view.detachedBottom && view.channelId === state.currentChannel && nearBottom()) {
    void loadLatest(view.channelId);
  }
});

// ---------------------------------------------------------------------------
// REST com renovação: 401 → refresh → repete UMA vez; falhou → volta ao login
// ---------------------------------------------------------------------------

function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  // o access é relido a cada chamada: um refresh (desta aba ou de outra) já
  // vale para a próxima requisição sem recriar nada
  const headers: Record<string, string> = {
    authorization: `Bearer ${getAccessToken() ?? ""}`,
    ...(init?.headers as Record<string, string> | undefined),
  };
  // content-type só quando há corpo: DELETE sem body com header json é 400
  // no Fastify (FST_ERR_CTP_EMPTY_JSON_BODY — pego em verificação de UI)
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  return fetch(API + path, { ...init, headers });
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  let res = await apiFetch(path, init);
  if (res.status === 401) {
    const r = await refresh();
    if (r === "invalid") {
      await doLogout();
      throw new Error("sessão expirada");
    }
    // transitório (deploy/rede): NÃO desloga — a operação falha e o usuário
    // repete quando o servidor voltar (o composer devolve o texto ao input)
    if (r === "transient") throw new Error("servidor indisponível");
    res = await apiFetch(path, init);
    if (res.status === 401) {
      await doLogout();
      throw new Error("sessão expirada");
    }
  }
  if (!res.ok) throw new Error(`${res.status} em ${path}`);
  if (res.status === 204) return null; // DELETE/typing não têm corpo — .json() lançaria
  return res.json();
}

// ---------------------------------------------------------------------------
// Gateway com renovação: close 4004 → refresh → reconecta; falhou → login.
// ---------------------------------------------------------------------------

/**
 * GatewayClient não conhece close codes nem troca de token (e pertence a outro
 * pacote de trabalho — não pode ser alterado agora). Esta subclasse observa o
 * close 4004 (AuthenticationFailed: access vencido no Identify) por fora; o
 * cast para alcançar o ws privado é o preço de não tocar gateway.ts. Como o
 * token de uma instância é fixo, renovar = descartar a instância e criar outra
 * — o flag `stopped` corta o auto-reconnect interno da instância descartada.
 */
class AuthGateway extends GatewayClient {
  private stopped = false;

  override connect(): void {
    if (this.stopped) return; // o scheduleReconnect interno chama connect(); aqui o ciclo morre
    super.connect();
    const ws = (this as unknown as { ws?: WebSocket | null }).ws;
    if (ws === undefined) {
      // o campo privado sumiu numa refatoração do gateway.ts — falhar alto é
      // melhor que reconectar para sempre com token morto sem enxergar o 4004
      throw new Error("AuthGateway: GatewayClient.ws mudou — atualizar o observador do close 4004");
    }
    ws?.addEventListener("close", (ev) => {
      if (ev.code === CloseCode.AuthenticationFailed) void onGatewayAuthFailed(this);
    });
  }

  stop(): void {
    this.stopped = true;
    this.disconnect();
  }
}

let currentGateway: AuthGateway | null = null;

function onDispatch(t: DispatchName, d: unknown): void {
  if (t === "READY") {
    const ready = d as ReadyData;
    state.me = ready.user;
    state.channels = ready.channels;
    state.members = new Map(ready.members.map((m) => [m.id, m]));
    state.online = new Set([ready.user.id]);
    // snapshot de voz (M3): quem já está em canal quando entramos
    state.voiceStates = new Map();
    for (const v of ready.voice_states ?? []) {
      if (v.channel_id !== null) state.voiceStates.set(v.user_id, v);
    }
    state.speaking = new Map(); // "quem fala" não vem no snapshot; o próximo VOICE_SPEAKING repõe
    renderMe(ready.user);
    renderChannels();
    renderMembers();
    renderVoiceFooter();
    // READY = sessão NOVA (re-Identify): o estado de voz da sessão antiga
    // morreu no servidor — se estávamos em voz, re-join limpo, mídia zerada
    // primeiro (RESUMED não passa aqui: sessão viva, mídia intocada)
    if (voice.channelId !== null) {
      const target = voice.channelId;
      voice.leaveLocal();
      void joinVoice(target);
    }
    const first = ready.channels.find((c) => c.type === "text");
    if (first && state.currentChannel === null) void selectChannel(first.id);
    return;
  }
  if (t === "VOICE_STATE_UPDATE") {
    const v = d as VoiceState;
    // canal ANTERIOR deste usuário, capturado ANTES da mutação — é o que
    // permite distinguir "entrou/saiu do MEU canal" de um mero toggle de flag
    const prevChannel = state.voiceStates.get(v.user_id)?.channel_id ?? null;
    if (v.channel_id === null) {
      state.voiceStates.delete(v.user_id);
      // some do anel já — o servidor só esvaziaria no próximo tick do observer
      for (const set of state.speaking.values()) set.delete(v.user_id);
      // o SERVIDOR nos tirou da voz (transporte morto, kick por outra sessão)
      // OU é só o eco do nosso próprio leave — onSelfRemoved distingue os dois
      // (o eco atrasado matava um re-join rápido em voo; pego em verificação)
      if (v.user_id === state.me?.id) voice.onSelfRemoved();
    } else {
      state.voiceStates.set(v.user_id, v);
      // fantasma da PRÓPRIA sessão (join que completou no servidor com o WS
      // caindo antes da resposta): estamos idle mas o servidor nos vê em voz
      // — um leave de melhor esforço reconcilia (revisão M3 #3)
      if (v.user_id === state.me?.id) voice.reconcile(v.channel_id);
    }
    // sons de join/leave (M6, doc §8): só os movimentos dos OUTROS no MEU
    // canal — os próprios tocam no onChange local (mais imediato, e na saída
    // o voice.channelId daqui já estaria null quando o eco chegasse)
    const mine = voice.channelId;
    if (mine !== null && v.user_id !== state.me?.id) {
      if (v.channel_id === mine && prevChannel !== mine) playVoiceSound("join");
      else if (prevChannel === mine && v.channel_id !== mine) playVoiceSound("leave");
    }
    renderVoiceUi();
    return;
  }
  if (t === "VOICE_NEW_PRODUCER") {
    const p = d as { channel_id: string; user_id: string; producer_id: string; kind?: string; source?: string };
    // o PRÓPRIO user_id não se consome (inclui outra aba do mesmo usuário — eco;
    // e a nossa câmera: o preview local é o track cru, nunca via servidor)
    if (p.user_id === state.me?.id) return;
    if (p.channel_id !== voice.channelId) return; // producer de outro canal não nos diz respeito
    // M5: a rota é por SOURCE. Tela/soundshare NÃO se consomem no anúncio —
    // viram só estado no VoiceClient (o badge vem do self_stream; o clique em
    // "Assistir" acha o producer por lá) — viewers sob demanda, doc §3.6
    const source = p.source ?? (p.kind === "video" ? "camera" : "mic");
    if (source === "screen" || source === "screen_audio") {
      voice.registerStreamProducer(p.user_id, p.producer_id, source);
      renderChannels(); // o item da lista pode virar clicável antes do VOICE_STATE_UPDATE chegar
      return;
    }
    // mic → <audio> (M3); camera → tile na grade (M4)
    const task = source === "camera" ? voice.consumeVideo(p.user_id, p.producer_id) : voice.consume(p.producer_id);
    void task.catch((err: unknown) => console.warn("voz: consume falhou", err));
    return;
  }
  if (t === "VOICE_PRODUCER_CLOSED") {
    const p = d as { channel_id: string; producer_id: string };
    voice.handleProducerClosed(p.producer_id);
    return;
  }
  if (t === "VOICE_SPEAKING") {
    const s = d as { channel_id: string; speaking: string[] };
    state.speaking.set(s.channel_id, new Set(s.speaking));
    renderChannels(); // só os anéis mudam, mas re-render completo é barato nesta escala
    return;
  }
  if (t === "MESSAGE_CREATE") {
    const msg = d as Message;
    // quem publicou obviamente parou de digitar — some antes dos 10s
    typingTracker.stop(msg.channel_id, msg.author_id);
    if (!state.members.has(msg.author_id)) {
      // fallback para MEMBER_ADD perdido fora da janela de Resume; o evento
      // real substitui este placeholder quando (re)chegar
      state.members.set(msg.author_id, { id: msg.author_id, username: `user-${msg.author_id.slice(-4)}`, avatar_url: null });
      renderMembers();
    }
    if (msg.channel_id !== state.currentChannel) return;
    // resync em voo: o snapshot pode não conter esta mensagem e o
    // replaceChildren descartaria o append — bufferiza e aplica depois
    if (view.resyncing) {
      resyncBuffer.push(msg);
      return;
    }
    // fundo fora da janela de DOM: append viraria buraco na timeline — o
    // loadLatest do retorno ao fundo traz esta mensagem junto
    if (view.detachedBottom) return;
    if (findMessageEl(msg.id) !== null) return; // dedup: loadLatest × Dispatch podem se cruzar
    const pendingEl = msg.nonce ? state.pending.get(msg.nonce) : undefined;
    // decidido ANTES do append (que muda o scrollHeight): cola no fundo quem
    // já estava perto dele, ou quem acabou de enviar NESTA aba (reconciliação
    // de pending) — outra aba do mesmo autor lendo histórico não é arrancada
    const stick = nearBottom() || (pendingEl !== undefined && pendingEl.isConnected);
    if (pendingEl !== undefined && pendingEl.isConnected) {
      state.pending.delete(msg.nonce!);
      pendingEl.replaceWith(messageEl(msg));
    } else {
      // pending que saiu do DOM (troca de canal ida-e-volta, trim) não pode
      // engolir a mensagem real: cai no append normal
      if (pendingEl !== undefined) state.pending.delete(msg.nonce!);
      el.messages.append(messageEl(msg));
      trimTop(view);
    }
    if (stick) el.messages.scrollTop = el.messages.scrollHeight;
    return;
  }
  if (t === "MESSAGE_UPDATE") {
    const msg = d as Message;
    if (msg.channel_id !== state.currentChannel) return;
    // fora da janela de DOM (histórico não carregado ou fundo trimado) não há o que trocar
    const current = findMessageEl(msg.id);
    if (current === null) return;
    // editor inline aberto NESTA mensagem: substituir o nó jogaria fora o
    // rascunho digitado — troca o nó mas reabre a edição com o texto preservado
    const draft = current.querySelector<HTMLInputElement>(".edit-input")?.value ?? null;
    const fresh = messageEl(msg);
    current.replaceWith(fresh);
    if (draft !== null) {
      startEdit(fresh, msg);
      const input = fresh.querySelector<HTMLInputElement>(".edit-input");
      if (input) input.value = draft;
    }
    return;
  }
  if (t === "MESSAGE_DELETE") {
    const del = d as { id: string; channel_id: string };
    if (del.channel_id !== state.currentChannel) return;
    findMessageEl(del.id)?.remove();
    return;
  }
  if (t === "TYPING_START") {
    const typing = d as { channel_id: string; user_id: string };
    if (typing.user_id === state.me?.id) return; // o eco do próprio typing não interessa
    typingTracker.start(typing.channel_id, typing.user_id);
    return;
  }
  if (t === "MEMBER_ADD") {
    const user = d as User;
    state.members.set(user.id, user); // substitui o placeholder "user-XXXX", se havia
    renderMembers();
    renderTyping(); // um "?" na barra pode virar o nome real
    return;
  }
  if (t === "PRESENCE_UPDATE") {
    const p = d as { user_id: string; online: boolean };
    if (p.online) state.online.add(p.user_id);
    else state.online.delete(p.user_id);
    renderMembers();
  }
}

function startGateway(): void {
  currentGateway?.stop();
  const token = getAccessToken();
  if (token === null) {
    void doLogout();
    return;
  }
  // eventos filtrados pela identidade da instância: a descartada ainda dispara
  // um close tardio ("offline") que não deve sobrescrever o status da nova
  const gw: AuthGateway = new AuthGateway(GATEWAY, token, {
    status: (s) => {
      if (gw === currentGateway) setStatus(s);
    },
    dispatch: (t, d) => {
      if (gw === currentGateway) onDispatch(t, d);
    },
  });
  currentGateway = gw;
  gw.connect();
}

async function onGatewayAuthFailed(gw: AuthGateway): Promise<void> {
  gw.stop(); // o access desta instância é imprestável — reconectar com ele só repete o 4004
  if (gw !== currentGateway) return;
  const r = await refresh();
  if (gw !== currentGateway) return; // logout/troca aconteceu durante o await
  if (r === "invalid") {
    await doLogout();
    return;
  }
  if (r === "ok") {
    startGateway();
    return;
  }
  // transitório: reconectar já repetiria o 4004 num loop quente — espera e
  // tenta o ciclo inteiro de novo (o guard mata a retentativa se houve logout)
  setStatus("offline");
  setTimeout(() => {
    if (gw === currentGateway) void onGatewayRetry();
  }, 5000);
}

async function onGatewayRetry(): Promise<void> {
  const r = await refresh();
  if (r === "invalid") {
    await doLogout();
    return;
  }
  if (currentGateway !== null) startGateway();
}

async function doLogout(): Promise<void> {
  // avisa o "leave" de voz ANTES de derrubar o gateway — senão o fantasma
  // fica no canal para os outros até a sessão expirar no servidor (~2 min)
  await voice.leave();
  currentGateway?.stop();
  currentGateway = null;
  await logout();
  resetState();
  showLogin();
}

// ---------------------------------------------------------------------------
// Voz (M3): o VoiceClient cuida de mídia/sinalização; o estado de QUEM está
// em voz / falando vive no state acima, alimentado pelos dispatches VOICE_*
// ---------------------------------------------------------------------------

/**
 * O request é injetado como delegador (e não a instância do gateway) porque o
 * AuthGateway é descartado e recriado a cada renovação de token — o VoiceClient
 * sempre fala com o gateway ATUAL.
 */
const voice = new VoiceClient((m, p) => {
  const gw = currentGateway;
  if (gw === null) return Promise.reject(new Error("gateway desconectado"));
  return gw.request(m, p);
});

/**
 * Sons de join/leave (M6, doc §8): tocam quando ALGUÉM (inclusive eu) entra
 * ou sai do MEU canal de voz — web e desktop. Deafen silencia tudo, sons de
 * UI inclusive. Os movimentos dos OUTROS saem do VOICE_STATE_UPDATE; os MEUS
 * saem daqui: o onChange dispara na hora do join/leave local (mais imediato
 * que o eco do gateway, e cobre kick/logout, onde eco nem viria a tempo).
 */
function playVoiceSound(kind: "join" | "leave"): void {
  if (voice.deafened) return;
  if (kind === "join") playJoin();
  else playLeave();
}

let lastOwnVoiceChannel: string | null = null;
voice.onChange = () => {
  const cur = voice.channelId;
  if (cur !== lastOwnVoiceChannel) {
    // troca direta de canal (X→Y) toca só o join — a saída é implícita
    playVoiceSound(cur !== null ? "join" : "leave");
    lastOwnVoiceChannel = cur;
  }
  renderVoiceUi();
};

function renderVoiceUi(): void {
  renderChannels(); // as listas de participantes moram sob os canais de voz
  renderVoiceFooter();
  renderVideoGrid(); // câmera ligada/desligada e teardown mexem nos tiles (M4)
  renderStreamPanel(); // nome do streamer/visibilidade do painel assistido (M5)
}

async function joinVoice(channelId: string): Promise<void> {
  if (voice.channelId === channelId) return; // clique repetido no mesmo canal
  try {
    await voice.join(channelId);
  } catch (err) {
    // getUserMedia negado, canal inexistente, gateway fora: o leaveLocal do
    // join já zerou o estado e escondeu o rodapé — só registra o motivo
    console.warn("voz: falha ao entrar no canal", err);
  }
}

/**
 * Erro de voz VISÍVEL (revisão M5 #2): falhas de transmitir/assistir não podem
 * morrer só no console — "cliquei e nada aconteceu" é o pior feedback. A
 * mensagem pisca no status do rodapé de voz por ~4s e o render normal volta.
 */
let voiceErrorTimer: ReturnType<typeof setTimeout> | null = null;
function flashVoiceError(msg: string): void {
  el.voiceFooter.hidden = false;
  el.voiceFooterStatus.textContent = msg;
  el.voiceFooterStatus.classList.add("error");
  if (voiceErrorTimer !== null) clearTimeout(voiceErrorTimer);
  voiceErrorTimer = setTimeout(() => {
    el.voiceFooterStatus.classList.remove("error");
    renderVoiceFooter();
  }, 4000);
}

function renderVoiceFooter(): void {
  const cid = voice.channelId;
  if (cid === null) {
    el.voiceFooter.hidden = true;
    return;
  }
  el.voiceFooter.hidden = false;
  el.voiceFooter.classList.toggle("connecting", !voice.connected);
  el.voiceFooterStatus.textContent = voice.connected ? "Voz conectada" : "Conectando voz…";
  el.voiceFooterChannel.textContent = "#" + (state.channels.find((c) => c.id === cid)?.name ?? "?");
  el.voiceMute.textContent = voice.muted ? "🔇" : "🎙️";
  el.voiceMute.title = voice.muted ? "Desmutar" : "Mutar";
  el.voiceMute.classList.toggle("on", voice.muted);
  el.voiceDeafen.textContent = voice.deafened ? "🔕" : "🎧";
  el.voiceDeafen.title = voice.deafened ? "Voltar a ouvir" : "Ensurdecer";
  el.voiceDeafen.classList.toggle("on", voice.deafened);
  // câmera (M4): mesmo padrão .on dos vizinhos — ligada grita de propósito
  el.voiceCamera.title = voice.cameraOn ? "Desligar câmera" : "Ligar câmera";
  el.voiceCamera.classList.toggle("on", voice.cameraOn);
  // transmitir (M5): idem — o badge AO VIVO ao lado do próprio nome vem do
  // self_stream (VOICE_STATE_UPDATE), não deste botão
  el.voiceStream.title = voice.streamOn ? "Parar transmissão" : "Transmitir tela";
  el.voiceStream.classList.toggle("on", voice.streamOn);
}

el.voiceMute.addEventListener("click", () => void voice.toggleMute());
el.voiceDeafen.addEventListener("click", () => void voice.toggleDeafen());
el.voiceLeave.addEventListener("click", () => void voice.leave());
el.voiceCamera.addEventListener("click", () => {
  // getUserMedia negado, servidor recusou, voz caindo: só registra — o estado
  // visível (botão/preview) já foi zerado pelo próprio toggleCamera
  void voice.toggleCamera().catch((err: unknown) => console.warn("voz: falha ao alternar a câmera", err));
});
el.voiceStream.addEventListener("click", () => {
  void voice.toggleStream().catch((err: unknown) => {
    console.warn("voz: falha ao alternar a transmissão", err);
    // seletor cancelado = escolha do usuário, sem alarde; o resto (palco
    // ocupado, voz caindo) merece UI (revisão M5 #2)
    if (err instanceof Error && err.name !== "NotAllowedError") {
      flashVoiceError(err.message || "falha ao transmitir");
    }
  });
});

// ---------------------------------------------------------------------------
// Push-to-talk (M6, SÓ desktop): o hook global de teclado vive no MAIN do
// Electron (uiohook — o globalShortcut não separa keydown/keyup e consome a
// tecla); aqui só a configuração e o reflexo no VoiceClient. A seção fica no
// rodapé de voz e só sai do [hidden] quando a ponte existe.
//
// Persistência em localStorage — e NÃO em secretSet — DE PROPÓSITO: keycode e
// label não são segredo, e a leitura síncrona no load do módulo dispensa mais
// uma hidratação assíncrona (no scheme app:// do desktop, que é "standard", o
// localStorage persiste normalmente no perfil do Electron).
// ---------------------------------------------------------------------------

interface PttConfig {
  on: boolean;
  keycode: number | null;
  /** rótulo legível da tecla ("F13", "tecla 91"…) — vem do pttCaptureNextKey */
  label: string | null;
}

const PTT_STORAGE_KEY = "danjocord_ptt";

function loadPtt(): PttConfig {
  try {
    const raw = localStorage.getItem(PTT_STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<PttConfig>;
      return {
        on: parsed.on === true,
        keycode: typeof parsed.keycode === "number" ? parsed.keycode : null,
        label: typeof parsed.label === "string" ? parsed.label : null,
      };
    }
  } catch {
    // JSON corrompido: volta ao default (PTT desligado)
  }
  return { on: false, keycode: null, label: null };
}

const ptt: PttConfig = loadPtt();
/** a tecla está segurada AGORA — só alimenta o rótulo; o mic é o VoiceClient */
let pttHeld = false;
let pttCapturing = false;
/** captura disparada pelo TOGGLE (ligar sem tecla): o checkbox fica aceso enquanto espera */
let pttEnablePending = false;

function savePtt(): void {
  localStorage.setItem(PTT_STORAGE_KEY, JSON.stringify(ptt));
}

function renderPtt(): void {
  if (desktop === undefined) return; // no web a seção nem existe visualmente
  el.pttSection.hidden = false;
  el.pttToggle.checked = ptt.on || pttEnablePending;
  el.pttToggle.disabled = pttCapturing; // sem des/marcar no meio da captura
  el.pttKey.textContent = pttCapturing ? "pressione uma tecla…" : (ptt.label ?? "definir tecla");
  el.pttKey.disabled = pttCapturing;
  // o botão de MUTE não muda com o PTT ligado (contrato M6): mic fechado
  // entre presses NÃO é "mutado" — é o RÓTULO do toggle que conta o estado
  el.pttLabel.textContent = !ptt.on
    ? "Push-to-talk"
    : pttHeld
      ? "Push-to-talk — transmitindo"
      : `Push-to-talk — segure ${ptt.label ?? "a tecla"}`;
  el.pttSection.classList.toggle("transmitting", ptt.on && pttHeld);
}

/** Instala/desliga o hook global conforme o estado atual (melhor esforço). */
function syncPttHook(): void {
  if (desktop === undefined) return;
  void desktop
    .pttSetKey(ptt.on ? ptt.keycode : null)
    .catch((err: unknown) => console.warn("ptt: pttSetKey falhou", err));
}

async function capturePttKey(enableAfter: boolean): Promise<void> {
  if (desktop === undefined || pttCapturing) return;
  pttCapturing = true;
  pttEnablePending = enableAfter;
  renderPtt(); // o botão vira o feedback "pressione uma tecla…"
  try {
    const captured = await desktop.pttCaptureNextKey();
    ptt.keycode = captured.keycode;
    ptt.label = captured.label;
    if (enableAfter) ptt.on = true;
    savePtt();
    voice.setPttMode(ptt.on);
    syncPttHook(); // troca a tecla do hook vivo (ou o instala, se acabou de ligar)
  } catch (err) {
    console.warn("ptt: captura de tecla falhou", err);
  } finally {
    pttCapturing = false;
    pttEnablePending = false;
    renderPtt();
  }
}

if (desktop !== undefined) {
  // registrado UMA vez, para a vida toda do app. NADA de renderVoiceUi aqui:
  // um re-render completo recriaria os tiles de vídeo a cada aperto — só o
  // track do mic (VoiceClient) e o rótulo do toggle mudam por tecla
  desktop.onPtt((down) => {
    pttHeld = down;
    voice.setPttPressed(down);
    renderPtt();
  });

  el.pttToggle.addEventListener("change", () => {
    if (el.pttToggle.checked && ptt.keycode === null) {
      // ligou sem tecla definida: captura primeiro — o modo ativa junto (um
      // PTT "ligado" sem tecla seria um mic fechado sem jeito de abrir)
      void capturePttKey(true);
      return;
    }
    ptt.on = el.pttToggle.checked;
    savePtt();
    voice.setPttMode(ptt.on);
    syncPttHook();
    renderPtt();
  });

  el.pttKey.addEventListener("click", () => void capturePttKey(false));

  // config persistida religa modo + hook ao abrir o app
  if (ptt.on && ptt.keycode !== null) {
    voice.setPttMode(true);
    syncPttHook();
  }
  renderPtt();
}

// ---------------------------------------------------------------------------
// Grade de vídeo (M4): tiles remotos entregues pelo VoiceClient (onVideoTile)
// + preview local com o próprio cameraTrack (nunca passa pelo servidor).
// Colapsar a grade pausa os consumers NO SERVIDOR — economia real (doc §8).
// ---------------------------------------------------------------------------

/**
 * producer_id → tile remoto; o preview local fica fora (não tem producer
 * nosso consumido). el null = tile-placeholder: o consume foi recusado por
 * codec (rev. M4 #2) e não há <video> — mas o sintoma precisa aparecer.
 */
const videoTiles = new Map<string, { userId: string; el: HTMLVideoElement | null; reason?: string }>();
let videoCollapsed = false;
/** <video> do preview local + o track exibido (recriado quando a câmera religa) */
let localPreview: HTMLVideoElement | null = null;
let localPreviewTrack: MediaStreamTrack | null = null;

voice.onVideoTile = (userId, producerId, videoEl) => {
  if (videoEl === null) {
    videoTiles.delete(producerId);
    tileLayer.delete(producerId); // a histerese não pode herdar camada de consumer morto
  } else {
    videoTiles.set(producerId, { userId, el: videoEl });
    // o consumer nasce pausado no servidor: com a grade expandida, acorda já;
    // colapsada, fica pausado até o usuário expandir (setTileVisibility true)
    if (!videoCollapsed) void voice.setTileVisibility(producerId, true);
  }
  updateTileLayers();
  renderVideoGrid();
};

// consume recusado por codec (rev. M4 #2): tile sem <video> — renderVideoGrid
// mostra o placeholder; a remoção chega pelo onVideoTile null de sempre
voice.onVideoTileFailed = (userId, producerId, reason) => {
  videoTiles.set(producerId, { userId, el: null, reason });
  renderVideoGrid();
};

/** última camada pedida por tile — a memória da histerese (rev. M4 #8) */
const tileLayer = new Map<string, number>();

/** altura → camada, com os limiares-base (270/540) escalados por factor */
function layerForHeight(h: number, factor: number): number {
  return h >= 540 * factor ? 2 : h >= 270 * factor ? 1 : 0;
}

let tileLayersScheduled = false;

/**
 * Camada pelo TAMANHO RENDERIZADO do tile, não pela contagem (revisão M4 #1):
 * com captura 4K a camada 2 vale ~10 Mbps — um tile de 300 px puxando 2160p
 * seria a economia do doc §8 invertida. O assinante não sabe a resolução do
 * produtor (só a escada relativa), então o mapeamento é pelo que ele mesmo
 * exibe: tiles grandes merecem camada alta; thumbnails, a baixa.
 */
function updateTileLayers(): void {
  if (videoTiles.size === 0 || tileLayersScheduled) return;
  tileLayersScheduled = true;
  // pós-layout: offsetHeight só é real depois do renderVideoGrid assentar
  requestAnimationFrame(() => {
    tileLayersScheduled = false;
    for (const [pid, tile] of videoTiles) {
      if (tile.el === null) continue; // placeholder de codec — não há consumer
      const h = tile.el.offsetHeight;
      if (h === 0) continue; // grade colapsada — consumer já está pausado
      // histerese de ±15% (rev. M4 #8): um tile parado na fronteira (e cada
      // reflow mexe pixels) flipava de camada a cada passada — e cada flip
      // custa um keyframe novo do produtor. Subir exige cruzar o limiar com
      // 15% de folga (factor 1.15); descer, ficar 15% abaixo dele (0.85);
      // entre as duas bandas, a camada atual segura.
      const current = tileLayer.get(pid);
      const spatial =
        current === undefined
          ? layerForHeight(h, 1)
          : Math.min(Math.max(current, layerForHeight(h, 1.15)), layerForHeight(h, 0.85));
      tileLayer.set(pid, spatial);
      // o VoiceClient dedupa por consumer — repetir a mesma camada não gera tráfego
      void voice.setTileLayer(pid, spatial);
    }
  });
}

// a grade é fluida (auto-fit): redimensionar a janela muda a altura dos tiles
// sem passar por renderVideoGrid — reavalia as camadas a cada resize (o rAF
// coalesce a rajada; a histerese segura o ping-pong na fronteira)
window.addEventListener("resize", updateTileLayers);

function videoTileEl(content: HTMLElement, name: string): HTMLElement {
  const tile = document.createElement("div");
  tile.className = "video-tile";
  const label = document.createElement("span");
  label.className = "video-tile-name";
  label.textContent = name;
  tile.append(content, label);
  return tile;
}

/** miolo do tile quando NÃO há <video>: consume recusado por codec (rev. M4 #2) */
function videoPlaceholderEl(reason?: string): HTMLElement {
  const ph = document.createElement("div");
  ph.className = "video-tile-placeholder";
  ph.textContent = "sem vídeo — " + (reason ?? "indisponível");
  return ph;
}

function renderVideoGrid(): void {
  const inVoice = voice.channelId !== null;
  if (!inVoice) videoCollapsed = false; // a próxima chamada nasce expandida
  const camTrack = voice.cameraTrack;
  if (camTrack === null) {
    localPreview = null; // câmera desligou: solta o <video> do preview
    localPreviewTrack = null;
  }
  const total = videoTiles.size + (camTrack !== null ? 1 : 0);
  if (!inVoice || total === 0) {
    el.videoPanel.hidden = true;
    el.videoGrid.replaceChildren();
    return;
  }
  el.videoPanel.hidden = false;
  el.videoCollapse.textContent = videoCollapsed ? "▸" : "▾";
  el.videoCollapse.title = videoCollapsed ? "Expandir vídeos" : "Recolher vídeos";
  el.videoGrid.hidden = videoCollapsed;
  if (videoCollapsed) {
    // os <video> saem do DOM; os consumers já estão pausados no servidor
    el.videoGrid.replaceChildren();
    return;
  }

  const tiles: HTMLElement[] = [];
  if (camTrack !== null) {
    // preview local: o PRÓPRIO track num <video> mudo — sem servidor no meio
    if (localPreview === null || localPreviewTrack !== camTrack) {
      localPreview = document.createElement("video");
      localPreview.muted = true;
      localPreview.autoplay = true;
      localPreview.playsInline = true;
      localPreview.srcObject = new MediaStream([camTrack]);
      localPreviewTrack = camTrack;
    }
    tiles.push(videoTileEl(localPreview, (state.me?.username ?? "você") + " (você)"));
  }
  for (const t of videoTiles.values()) {
    // mesmo fallback da lista de voz: membro desconhecido vira placeholder
    const name = state.members.get(t.userId)?.username ?? `user-${t.userId.slice(-4)}`;
    tiles.push(videoTileEl(t.el ?? videoPlaceholderEl(t.reason), name));
  }
  el.videoGrid.replaceChildren(...tiles);
  // re-inserir um <video> no DOM pode pausá-lo em alguns navegadores; como
  // todos são muted, o play() volta sem exigir gesto do usuário
  for (const tile of tiles) {
    const v = tile.querySelector("video");
    if (v !== null) void v.play().catch(() => undefined);
  }
}

el.videoCollapse.addEventListener("click", () => {
  videoCollapsed = !videoCollapsed;
  // pausa/retoma NO SERVIDOR (pause_consumer/resume_consumer): a banda de
  // vídeo zera de verdade quando a grade colapsa, não só some da tela
  for (const pid of videoTiles.keys()) void voice.setTileVisibility(pid, !videoCollapsed);
  renderVideoGrid();
  // expandir devolve altura aos tiles — reavalia camadas (a janela pode ter
  // sido redimensionada enquanto a grade esteve recolhida)
  if (!videoCollapsed) updateTileLayers();
});

// ---------------------------------------------------------------------------
// Painel de stream (M5): UMA transmissão assistida por vez, ACIMA da grade de
// vídeo e maior que ela (60vh) — o estado de "assistindo" vive no VoiceClient;
// aqui só se renderiza o que o onStreamView entrega (el ou null).
// ---------------------------------------------------------------------------

/** o <video> grande entregue pelo VoiceClient + o dono, para o título do painel */
let streamView: { userId: string; el: HTMLVideoElement } | null = null;

voice.onStreamView = (userId, videoEl) => {
  if (videoEl === null) {
    // o null de um stream antigo (troca A→B) não pode apagar o painel novo
    if (streamView !== null && streamView.userId === userId) streamView = null;
  } else {
    streamView = { userId, el: videoEl };
  }
  renderStreamPanel();
  renderChannels(); // o realce/title do item "Assistir" acompanha o assistindo
};

function renderStreamPanel(): void {
  if (streamView === null) {
    el.streamPanel.hidden = true;
    el.streamBox.replaceChildren();
    el.streamUnmute.hidden = true;
    return;
  }
  el.streamPanel.hidden = false;
  el.streamTitle.textContent = state.members.get(streamView.userId)?.username ?? `user-${streamView.userId.slice(-4)}`;
  // só (re)insere quando o <video> ainda não está no DOM: re-inserir pausa o
  // elemento em alguns navegadores e re-dispararia o fluxo de autoplay abaixo
  if (streamView.el.parentElement !== el.streamBox) {
    el.streamUnmute.hidden = true;
    el.streamBox.replaceChildren(streamView.el);
    const v = streamView.el;
    // o <video> do stream NÃO é muted (o soundshare toca por ele — contrato
    // M5): o play() costuma passar porque assistir nasceu de um clique; se o
    // navegador barrar, toca MUDO (autoplay muted sempre pode) e oferece o
    // botão de unmute — o gesto nele destrava o som
    void v.play().catch((err: unknown) => {
      console.warn("voz: play() do stream rejeitado — tocando mudo até o clique", err);
      v.muted = true;
      void v.play().catch(() => undefined);
      if (streamView?.el === v) el.streamUnmute.hidden = false;
    });
  }
}

el.streamStop.addEventListener("click", () => voice.stopWatching());
el.streamUnmute.addEventListener("click", () => {
  el.streamUnmute.hidden = true;
  if (streamView === null) return;
  // o clique é o gesto que o autoplay exigia; deafen continua mandando (o
  // un-deafen do rodapé é quem desfaz o silêncio nesse caso)
  streamView.el.muted = voice.deafened;
  void streamView.el.play().catch((err: unknown) => console.warn("voz: play() do stream rejeitado", err));
});

// ---------------------------------------------------------------------------
// Composer (render otimista do M0 + typing do M2)
// ---------------------------------------------------------------------------

el.input.addEventListener("input", () => {
  // só texto de verdade conta como "digitando" (colar espaço/apagar tudo, não)
  if (state.currentChannel === null || el.input.value.trim() === "") return;
  typingSender.typed(state.currentChannel);
});

el.composer.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const content = el.input.value.trim();
  if (!content || !state.currentChannel || !state.me) return;
  const channelId = state.currentChannel;
  el.input.value = "";
  typingSender.sent(channelId); // enviar encerra a "sessão de digitação" do throttle

  if (view.detachedBottom && view.channelId === channelId) {
    // fundo fora da janela de DOM: não há onde ancorar o render otimista —
    // envia sem nonce e recarrega o final (o dedup por data-id segura o
    // cruzamento entre o reload e o Dispatch)
    void api(`/api/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify({ content }) })
      .then(() => loadLatest(channelId))
      .catch(() => {
        el.input.value = content; // devolve o texto para retry manual
      });
    return;
  }

  // render otimista (doc §8): aparece já, reconcilia quando o Dispatch voltar
  const nonce = crypto.randomUUID();
  const pending = messageEl(
    { id: nonce, channel_id: channelId, author_id: state.me.id, content, created_at: Date.now() },
    true,
  );
  state.pending.set(nonce, pending);
  el.messages.append(pending);
  el.messages.scrollTop = el.messages.scrollHeight;

  void api(`/api/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, nonce }),
  }).catch(() => {
    pending.remove();
    state.pending.delete(nonce);
    el.input.value = content; // devolve o texto para retry manual
  });
});

// ---------------------------------------------------------------------------
// Login e boot
// ---------------------------------------------------------------------------

el.loginDiscord.addEventListener("click", () => {
  if (desktop !== undefined) {
    // desktop (M6, doc §5): fluxo loopback — o main abre o navegador EXTERNO
    // (start?redirect_port=<listener local>) e resolve com o OTC quando o
    // callback bater no 127.0.0.1; daí o caminho é o mesmo do web
    const idle = el.loginDiscord.textContent ?? "Entrar com Discord";
    el.loginDiscord.disabled = true;
    el.loginDiscord.textContent = "aguardando o navegador…";
    showLogin(); // limpa um erro anterior enquanto o fluxo roda lá fora
    desktop
      .oauthLogin()
      .then((otc) => exchangeOtc(otc))
      .then(() => startApp())
      .catch((err: unknown) => showLogin(desktopLoginErrorMessage(err)))
      .finally(() => {
        el.loginDiscord.disabled = false;
        el.loginDiscord.textContent = idle;
      });
    return;
  }
  // web: o backend inicia o fluxo (state + PKCE ficam server-side) e redireciona
  location.href = API + "/auth/discord/start";
});

el.devForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const username = el.devUsername.value.trim().toLowerCase();
  if (username === "") return;
  void devLogin(username).then(
    () => startApp(),
    (err: unknown) => showLogin(devErrorMessage(err)),
  );
});

el.logout.addEventListener("click", () => void doLogout());

async function boot(): Promise<void> {
  // desktop (M6): hidrata o cache de segredos ANTES de qualquer getAccessToken
  // síncrono — sem isto, uma sessão salva no safeStorage pareceria logout
  await hydrateAuth();
  const params = new URLSearchParams(location.search);
  // o OTC chega no FRAGMENT (#otc=) de propósito: fragment não é enviado ao
  // servidor, então a credencial nunca aparece em access log nem em Referer
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const otc = hash.get("otc");
  const authError = params.get("auth_error");
  const qsUser = params.get("user");

  // credencial de uso único / estado de erro somem da barra de endereço antes
  // de tudo (um F5 não deve reapresentar um OTC já gasto)
  if (otc !== null || authError !== null || qsUser !== null) {
    history.replaceState(null, "", location.pathname);
  }

  if (authError !== null) {
    showLogin(authErrorMessage(authError));
    return;
  }

  if (otc !== null) {
    try {
      await exchangeOtc(otc);
    } catch {
      showLogin("Falha no login, tente de novo.");
      return;
    }
  } else if (qsUser !== null) {
    // atalho do M0 preservado: ?user=<nome> loga direto como <nome>, agora com
    // sessão de verdade via /auth/dev. Como o localStorage é por origem, isto
    // TROCA a sessão persistida — para dois usuários em paralelo, aba anônima.
    try {
      await devLogin(qsUser.trim().toLowerCase());
    } catch (err) {
      showLogin(devErrorMessage(err));
      return;
    }
  }

  if (getAccessToken() === null) {
    showLogin();
    return;
  }
  startApp();
}

void boot();
