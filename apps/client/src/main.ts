// o CSS do cliente inteiro entra por aqui (M7): um único grafo de @import,
// resolvido pelo vite — o index.html não tem mais <style>
import "./styles/index.css";
import {
  CloseCode,
  displayName,
  type Channel,
  type DispatchName,
  type Message,
  type Attachment,
  type MessageAckData,
  type PresenceStatus,
  type ReactionData,
  type PresenceUpdateData,
  type ReadyData,
  type Sound,
  type User,
  type VoiceState,
} from "@danjocord/protocol";
import { GatewayClient, type GatewayStatus } from "./gateway.js";
import { API, AuthError, devLogin, exchangeOtc, getAccessToken, getUser, hydrateAuth, logout, refresh } from "./auth.js";
import { desktop } from "./bridge.js";
import { emit, emitConnection, mountSound, resetConnectionSound } from "./sound/index.js";
import { TypingSender, TypingTracker } from "./typing.js";
import { mountChrome, renderChannelHead, resetConnectionBar, setConnectionStatus } from "./ui/chrome.js";
import {
  clearComposer,
  focusComposer,
  mountComposer,
  replyTargetId,
  restoreComposerAttachments,
  setComposerChannel,
  setReplyTarget,
  setComposerMuted,
  setComposerValue,
} from "./ui/composer.js";
import { renderMembers } from "./ui/members.js";
import { mountEmojiComposer } from "./ui/emoji.js";
import { mountSearch } from "./ui/search.js";
import { uploadAttachment } from "./ui/upload.js";
import { isUserSilenced, setUserSilenced } from "./sound/soundboard.js";
import {
  applySoundCatalog,
  applySoundDelete,
  applySoundUpsert,
  handleSoundboardEvent,
  mountSoundboard,
  renderSoundboard,
  soundboardSettingsSection,
} from "./ui/soundboard.js";
import {
  closeUserControls,
  mountUserControls,
  isBlocked,
  openUserControls,
  refreshUserControls,
  subscribeBlocked,
  type UserControlsContext,
} from "./ui/user-controls.js";
import { closeVoiceSettings, restoreVoicePrefs, voiceSettingsMenuItem } from "./ui/voice-settings.js";
import { closeInvites, refreshInvitesMenu } from "./ui/invites.js";
import { inviteCodeFromLocation, renderInviteLanding } from "./ui/invite-landing.js";
import { memberRemoved } from "./ui/members.js";
import { mountPresence, myStatus, syncPresence } from "./ui/presence.js";
import { closeSettings } from "./ui/settings.js";
import {
  applyReaction,
  editDraftOf,
  editLastOwnMessage,
  findMessageEl,
  markFailed,
  mentionsMe,
  messageEl,
  regroupAll,
  regroupAt,
  renderTyping,
  startEdit,
  type MessageActions,
} from "./ui/messages.js";
import {
  ackDoFundo,
  ackVisivel,
  applyAck,
  applyReadState,
  mountUnread,
  noteMessage,
  openedChannel,
  setDetached,
  syncUnreadDivider,
} from "./ui/unread.js";
import {
  mountSidebar,
  renderChannels as renderChannelList,
  renderUserPanel,
  renderVoiceFooter as renderVoiceFooterUi,
  updateSpeaking,
  type SidebarContext,
} from "./ui/sidebar.js";
import { ApiError, lerErro } from "./api-error.js";
import { deveRearmarPaginacao } from "./pagination.js";
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
  loginDev: document.getElementById("login-dev")!,
  // app
  app: document.getElementById("app")!,
  guildHome: document.getElementById("guild-home") as HTMLButtonElement,
  sidebarHead: document.getElementById("sidebar-head") as HTMLButtonElement,
  userPanel: document.getElementById("user-panel")!,
  meAvatar: document.getElementById("me-avatar") as HTMLImageElement,
  meName: document.getElementById("me-name")!,
  meSub: document.getElementById("me-sub")!,
  userMute: document.getElementById("user-mute") as HTMLButtonElement,
  userDeafen: document.getElementById("user-deafen") as HTMLButtonElement,
  userSettings: document.getElementById("user-settings") as HTMLButtonElement,
  logout: document.getElementById("logout") as HTMLButtonElement,
  channelHead: document.getElementById("channel-head")!,
  channelIcon: document.getElementById("channel-icon")!,
  channelName: document.getElementById("channel-name")!,
  channelTopic: document.getElementById("channel-topic")!,
  toggleMembers: document.getElementById("toggle-members") as HTMLButtonElement,
  status: document.getElementById("status")!,
  channels: document.getElementById("channels")!,
  membersPanel: document.getElementById("members-panel")!,
  members: document.getElementById("members")!,
  messages: document.getElementById("messages")!,
  typing: document.getElementById("typing")!,
  composer: document.getElementById("composer") as HTMLFormElement,
  input: document.getElementById("input") as HTMLTextAreaElement,
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

// login dev só existe em build de desenvolvimento: em produção o /auth/dev
// responde 404, e um formulário que só sabe falhar não merece espaço na tela
if (import.meta.env.DEV) el.loginDev.hidden = false;

// Os botões de ícone nascem vazios no HTML porque o ícone é um SVGElement
// criado em JS (ui/icons.ts) — o cliente não usa innerHTML em lugar nenhum.
// Quem os desenha são os módulos de ui/, no mount: mountChrome() cuida do
// header, mountSidebar() do painel do usuário. Nada de ícone estático aqui.

interface State {
  me: User | null;
  channels: Channel[];
  members: Map<string, User>;
  /**
   * M10 (item 56): status de quem NÃO está offline. A ausência É o offline —
   * o mapa espelha o fio, onde "offline" viaja para APAGAR a entrada.
   */
  presences: Map<string, PresenceStatus>;
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
  presences: new Map(),
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
/** quantas mensagens foram DESCARTADAS desde que o fundo se soltou (item 83) */
let novasNoDetached = 0;

// ---------------------------------------------------------------------------
// Typing (M2): tracker recebe TYPING_START, sender emite com throttle
// ---------------------------------------------------------------------------

const typingTracker = new TypingTracker(TYPING_TTL_MS, (channelId) => {
  if (channelId === state.currentChannel) renderTypingBar();
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
  // As três camadas flutuantes são filhas do <body>, não da view: sem isto
  // ficam por cima do formulário de login com o foco preso dentro (foi o
  // achado M8 #7, e o M9 repetiu para os dois novos).
  //
  // Aqui e não no doLogout: showLogin é o ponto ÚNICO por onde passam TODOS os
  // caminhos de volta ao login — logout pelo menu, token revogado, falha de
  // OAuth. Fechar só no doLogout cobria um de nove.
  closeSettings();
  closeVoiceSettings();
  closeUserControls(false);
  closeInvites();
  el.app.hidden = true;
  el.login.hidden = false;
  el.loginError.textContent = error ?? "";
  el.loginError.hidden = error === undefined;
}

function startApp(): void {
  el.login.hidden = true;
  el.app.hidden = false;
  state.me = getUser(); // snapshot do storage; o READY corrige se estiver velho
  renderUserPanel(ui);
  setConnectionStatus("connecting");
  startGateway();
}

function resetState(): void {
  state.me = null;
  state.channels = [];
  state.members = new Map();
  state.presences = new Map();
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
  setComposerChannel(null);
  clearComposer();
  renderChannelHead(ui); // devolve o título da janela para "Danjocord"
}

function authErrorMessage(code: string): string {
  // M10: quem chega por link de convite precisa saber POR QUE não entrou —
  // "tente de novo" manda a pessoa repetir uma coisa que nunca vai funcionar
  if (code === "banned") return "Seu acesso a este servidor foi bloqueado.";
  if (code === "invite_expired") return "Esse convite expirou — peça um link novo para quem te chamou.";
  if (code === "invite_exhausted") return "Esse convite já foi usado o número máximo de vezes — peça um link novo.";
  if (code === "invite_revoked") return "Esse convite foi revogado — peça um link novo para quem te chamou.";
  if (code === "invite_invalid") return "Esse link de convite não existe. Confira se copiou inteiro.";
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
// Ponte com os módulos de ui/ (M7). O render deixou de morar aqui: sidebar,
// membros, mensagens, header e composer são módulos próprios. O que sobra
// neste arquivo é a cola — o contexto (montado junto do VoiceClient, mais
// abaixo, porque os getters de voz dependem dele) e os atalhos que preservam
// os call sites antigos.
// ---------------------------------------------------------------------------

function renderChannels(): void {
  renderChannelList(ui);
}

function renderVoiceFooter(): void {
  renderVoiceFooterUi(ui);
}

/**
 * Mutações de mensagem que ui/messages dispara. Ficam aqui porque o api() com
 * renovação de token vive neste módulo — o componente não conhece rede.
 */
const msgActions: MessageActions = {
  editMessage: (m, content) =>
    api(`/api/channels/${m.channel_id}/messages/${m.id}`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    }) as Promise<Message>,
  deleteMessage: (m) =>
    api(`/api/channels/${m.channel_id}/messages/${m.id}`, { method: "DELETE" }).then(() => undefined),
  // o alvo vira estado do CAMPO (ui/composer): ele acompanha o que está sendo
  // escrito, some no envio e some na troca de canal — o servidor recusa citar
  // mensagem de outro canal, então deixar o alvo vivo daria 400 na cara
  replyTo: (m) => {
    const autor = state.members.get(m.author_id);
    setReplyTarget({ id: m.id, autor: autor === undefined ? "alguém" : displayName(autor) });
  },
};

/** todo call site de mensagem precisa do mesmo contexto + actions */
function renderMsg(m: Message, pending = false): HTMLElement {
  return messageEl(m, ui, msgActions, pending);
}

/**
 * Bloquear (M10, item 54) é LOCAL: esconder as mensagens é metade do recurso —
 * a outra metade (silenciar a voz) o próprio card faz pelo VoiceClient.
 */
function visivel(m: Message): boolean {
  return !isBlocked(m.author_id);
}

/** corpo do POST: `attachment_ids` só viaja quando há anexo (item 89) */
function corpo(content: string, attachments: Attachment[]): Record<string, unknown> {
  const ids = attachments.map((a) => a.id);
  const reply = replyTargetId();
  return {
    content,
    ...(ids.length > 0 ? { attachment_ids: ids } : {}),
    ...(reply !== null ? { reply_to_id: reply } : {}),
  };
}

function renderTypingBar(): void {
  const cid = state.currentChannel;
  renderTyping(el.typing, ui, cid === null ? [] : typingTracker.typers(cid));
}

// ---------------------------------------------------------------------------
// Canal atual + paginação por cursor (M2, doc §6): before = id da mensagem
// mais antiga renderizada; prepend preserva o ponto de leitura via delta de
// scrollHeight (o CSS desliga o scroll anchoring do navegador para não brigar)
// ---------------------------------------------------------------------------

async function selectChannel(channelId: string): Promise<void> {
  state.currentChannel = channelId;
  setReplyTarget(null); // citar mensagem de outro canal é 400 no servidor
  openedChannel(channelId);
  novasNoDetached = 0;
  setDetached(false, 0);
  renderChannels();
  renderChannelHead(ui); // header + document.title
  setComposerChannel(state.channels.find((c) => c.id === channelId)?.name ?? null);
  focusComposer(); // trocou de canal: o cursor já fica pronto para digitar
  renderTypingBar(); // troca a barra para os digitadores DESTE canal (ou nada)
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
    el.messages.replaceChildren(...history.filter(visivel).map((m) => renderMsg(m)));
    // drena o que chegou pelo gateway durante o fetch e não veio no snapshot
    for (const m of resyncBuffer) {
      if (m.channel_id === channelId && visivel(m) && findMessageEl(el.messages, m.id) === null) {
        el.messages.append(renderMsg(m));
      }
    }
    resyncBuffer = [];
    // agrupamento e separadores de data só existem em RELAÇÃO ao vizinho: o
    // lote inteiro entrou solto, então a passada vem agora — e ANTES do
    // scroll, que depende das alturas finais
    regroupAll(el.messages);
    // ANTES de mexer no scroll: a linha de "novas mensagens" tem ~28px, e medir
    // a altura depois dela entrar faria o texto pular
    syncUnreadDivider(el.messages);
    el.messages.scrollTop = el.messages.scrollHeight;
    novasNoDetached = 0;
    setDetached(false, 0);
    ackDoFundo(channelId, el.messages); // acabamos de colar no presente
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
  // "progrediu?" — o que decide o rearme lá embaixo. Ver `pagination.ts`: sem
  // isto, falha de rede e página inteira de gente bloqueada viravam laço.
  let avancou = false;
  try {
    const older = (await api(`/api/channels/${cid}/messages?limit=${PAGE_SIZE}&before=${before}`)) as Message[];
    if (v !== view || state.currentChannel !== cid) return;
    // um resync (loadLatest) trocou o DOM durante o fetch: o cursor sumiu e
    // prependar aqui costuraria um trecho antigo num DOM novo — buraco na
    // timeline E reachedStart falso (achado nº 1 da revisão do M2)
    if (findMessageEl(el.messages, before) === null) return;
    if (older.length < PAGE_SIZE) v.reachedStart = true; // acabou o histórico: para de pedir
    if (older.length > 0) {
      const prevHeight = el.messages.scrollHeight;
      const frag = document.createDocumentFragment();
      older.reverse();
      for (const m of older) if (visivel(m)) frag.append(renderMsg(m));
      avancou = frag.childElementCount > 0;
      el.messages.prepend(frag);
      // OBRIGATORIAMENTE entre o prepend e o delta de scroll: as mensagens que
      // chegaram ganham avatar/separador e a antiga primeira PERDE os dela —
      // medir a altura antes disso faria o texto sob os olhos pular
      regroupAll(el.messages);
      syncUnreadDivider(el.messages); // mesma razão do loadLatest: ele tem altura
      el.messages.scrollTop += el.messages.scrollHeight - prevHeight;
      trimBottom(v);
    }
  } catch {
    // falhou: sem retry automático — o próximo scroll perto do topo tenta de
    // novo. `avancou` continua false, e é ELE que faz esta frase ser verdade:
    // até o M12 a linha do rearme, logo abaixo, era um retry automático.
  } finally {
    v.loadingOlder = false;
  }
  // viewport alto demais para a página carregada: ainda sem rolagem, completa já
  if (
    deveRearmarPaginacao({
      mesmaView: v === view,
      reachedStart: v.reachedStart,
      scrollTop: el.messages.scrollTop,
      topThreshold: TOP_THRESHOLD,
      avancou,
    })
  ) {
    void maybeLoadOlder();
  }
}

/** Prepend estourou a janela: o excedente sai do FUNDO (lado oposto à carga). */
function trimBottom(v: PaginationView): void {
  if (el.messages.childElementCount <= MAX_RENDERED) return;
  while (el.messages.childElementCount > MAX_RENDERED) el.messages.lastElementChild?.remove();
  v.detachedBottom = true;
  setDetached(true, novasNoDetached); // o botão "pular para o presente" acende
}

/** Append estourou a janela: o excedente sai do TOPO (lado oposto à carga). */
function trimTop(v: PaginationView): void {
  if (el.messages.childElementCount <= MAX_RENDERED) return;
  const prevHeight = el.messages.scrollHeight;
  const prevTop = el.messages.scrollTop;
  while (el.messages.childElementCount > MAX_RENDERED) el.messages.firstElementChild?.remove();
  // quem virou a primeira do DOM era continuação de um bloco que não existe
  // mais: precisa recuperar avatar, nome e separador de data (antes de medir
  // a altura, que é o que compensa o scroll)
  regroupAt(el.messages.firstElementChild);
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
  if (!res.ok) {
    // O corpo é lido AQUI, e antes não era: `{error, retry_after}` é a forma
    // de toda resposta de erro do servidor, e o 429 do rate limit geral (M12)
    // é o primeiro erro que aparece sem o usuário ter feito nada de errado —
    // dizer "429 em /api/..." para ele seria esconder a única informação útil,
    // que é quanto tempo esperar. `res.json()` pode falhar (204, 502 do proxy
    // com HTML), e aí fica o status.
    let corpo: unknown = null;
    try {
      corpo = await res.json();
    } catch {
      /* corpo vazio ou não-JSON */
    }
    const { mensagem, retryAfter } = lerErro(res.status, corpo, path);
    throw new ApiError(res.status, mensagem, retryAfter);
  }
  if (res.status === 204) return null; // DELETE/typing não têm corpo — .json() lançaria
  return res.json();
}

// ---------------------------------------------------------------------------
// Gateway com renovação: close 4004 → refresh → reconecta; falhou → login.
// ---------------------------------------------------------------------------

/**
 * O token de uma instância é fixo, então renovar = descartar a instância e
 * criar outra; o flag `stopped` corta o auto-reconnect interno da descartada.
 *
 * O close code chega pelo evento `closed` do GatewayEvents. Antes ele era lido
 * alcançando o campo `ws` PRIVADO do GatewayClient por um cast — remendo que só
 * enxergava o 4004 e deixava o 4016 virar laço infinito de reconexão.
 */
class AuthGateway extends GatewayClient {
  private stopped = false;

  override connect(): void {
    if (this.stopped) return; // o scheduleReconnect interno chama connect(); aqui o ciclo morre
    super.connect();
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
    // o READY passou a trazer presença (M10): antes disto quem entrava via todo
    // mundo offline até alguém reconectar. Só entradas != "offline" viajam.
    state.presences = new Map(ready.presences.map((p) => [p.user_id, p.status]));
    // snapshot de voz (M3): quem já está em canal quando entramos
    state.voiceStates = new Map();
    for (const v of ready.voice_states ?? []) {
      if (v.channel_id !== null) state.voiceStates.set(v.user_id, v);
    }
    state.speaking = new Map(); // "quem fala" não vem no snapshot; o próximo VOICE_SPEAKING repõe
    applySoundCatalog(ready.sounds); // antes dos renders: o pad já nasce certo
    applyReadState(ready.read_state); // antes do renderChannels: a badge nasce certa
    syncPresence(); // sessão nova começa "online" no servidor — redeclara o meu
    setComposerMuted(ready.user.muted_until); // timeout de chat vem no snapshot
    refreshInvitesMenu(ui); // o cargo só é conhecido a partir daqui
    renderUserPanel(ui);
    renderChannels();
    renderChannelHead(ui); // a lista de canais só existe a partir daqui
    renderMembers(ui, (userId) => openUserControls(userId));
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
      if (v.user_id === state.me?.id) {
        voice.reconcile(v.channel_id);
        // M9: silenciado por admin. O servidor pausa o producer de verdade —
        // aqui o cliente fecha o mic e a UI passa a explicar que desmutar não
        // adianta (é o primeiro flag de voz que NÃO é declarativo).
        voice.setServerMuted(v.server_mute);
      }
    }
    // o card aberto (se for deste usuário) repinta: quem está com server_mute
    // aparece para TODOS, não só para o admin que aplicou
    refreshUserControls();
    // sons de join/leave (M8): quem decide se toca é sound/policy — aqui só se
    // relata o FATO. No leave o canal do evento é o `prevChannel` (de ONDE a
    // pessoa saiu), nunca o v.channel_id, que já é o destino (ou null).
    //
    // Os MEUS movimentos NÃO saem daqui: já saíram do voice.onChange, antes
    // deste eco. A política não tem como separar as duas origens (ela precisa
    // deixar o evento próprio passar, senão o onChange emudece), então quem
    // corta a duplicata é este guard — sem ele o próprio join toca DUAS vezes.
    if (v.user_id !== state.me?.id && v.channel_id !== prevChannel) {
      if (v.channel_id !== null) emit({ name: "voice-join", actorId: v.user_id, channelId: v.channel_id });
      if (prevChannel !== null) emit({ name: "voice-leave", actorId: v.user_id, channelId: prevChannel });
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
    // só a tela anuncia; o screen_audio vem logo atrás como par e tocaria duas vezes
    if (source === "screen") emit({ name: "stream-start", actorId: p.user_id, channelId: p.channel_id });
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
    updateSpeaking(ui); // chega a cada ~200 ms: só alterna a classe, sem recriar a lista
    return;
  }
  if (t === "SOUND_CREATE" || t === "SOUND_UPDATE") {
    applySoundUpsert(d as Sound);
    return;
  }
  if (t === "SOUND_DELETE") {
    applySoundDelete((d as { id: string }).id);
    return;
  }
  if (t === "VOICE_SOUNDBOARD") {
    // o servidor manda só o id: o áudio nunca passa pelo SFU. Todo mundo do
    // canal (inclusive quem apertou) toca pelo MESMO caminho — sem regra
    // separada para o eco próprio.
    handleSoundboardEvent(d as { user_id: string; channel_id: string; sound_id: string });
    return;
  }
  if (t === "MESSAGE_CREATE") {
    const msg = d as Message;
    // quem publicou obviamente parou de digitar — some antes dos 10s
    typingTracker.stop(msg.channel_id, msg.author_id);
    if (!state.members.has(msg.author_id)) {
      // fallback para MEMBER_ADD perdido fora da janela de Resume; o evento
      // real substitui este placeholder quando (re)chegar
      state.members.set(msg.author_id, {
        id: msg.author_id,
        username: `user-${msg.author_id.slice(-4)}`,
        nickname: null,
        avatar_url: null,
        role: "member", // placeholder nunca vira staff: o MEMBER_ADD real corrige
        muted_until: null,
      });
      renderMembers(ui, (userId) => openUserControls(userId));
    }
    if (isBlocked(msg.author_id)) return; // bloqueado: sem nó, sem som, sem badge
    noteMessage(msg); // badge do canal + contagem de menção
    // Som ANTES do return abaixo: mensagem em canal que não estou vendo é
    // justamente o caso que precisa avisar. A política descarta a minha
    // própria e decide entre "estou vendo este canal" e "janela sem foco".
    // `type === "user"`: "fulano entrou no servidor" não toca som de mensagem.
    // E a menção agora vem RESOLVIDA do servidor — a regex local do M8 divergia
    // dele em nome com ponto e não conhecia @todos.
    if (msg.type === "user") {
      emit({
        name: mentionsMe(msg, state.me?.id ?? null) ? "mention" : "message",
        actorId: msg.author_id,
        channelId: msg.channel_id,
      });
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
    if (view.detachedBottom) {
      // descartada de propósito (append viraria buraco): o contador é o que faz
      // o botão "pular para o presente" dizer QUANTAS chegaram
      setDetached(true, ++novasNoDetached);
      return;
    }
    if (findMessageEl(el.messages, msg.id) !== null) return; // dedup: loadLatest × Dispatch podem se cruzar
    const pendingEl = msg.nonce ? state.pending.get(msg.nonce) : undefined;
    // decidido ANTES do append (que muda o scrollHeight): cola no fundo quem
    // já estava perto dele, ou quem acabou de enviar NESTA aba (reconciliação
    // de pending) — outra aba do mesmo autor lendo histórico não é arrancada
    const stick = nearBottom() || (pendingEl !== undefined && pendingEl.isConnected);
    if (pendingEl !== undefined && pendingEl.isConnected) {
      state.pending.delete(msg.nonce!);
      const fresh = renderMsg(msg);
      pendingEl.replaceWith(fresh);
      regroupAt(fresh);
    } else {
      // pending que saiu do DOM (troca de canal ida-e-volta, trim) não pode
      // engolir a mensagem real: cai no append normal
      if (pendingEl !== undefined) state.pending.delete(msg.nonce!);
      const fresh = renderMsg(msg);
      el.messages.append(fresh);
      regroupAt(fresh); // continua (ou não) o bloco de quem já estava no fim
      trimTop(view);
    }
    if (stick) {
      el.messages.scrollTop = el.messages.scrollHeight;
      ackVisivel(msg.channel_id, msg.id); // só sai com a janela em foco
    }
    return;
  }
  if (t === "MESSAGE_UPDATE") {
    const msg = d as Message;
    if (msg.channel_id !== state.currentChannel) return;
    // fora da janela de DOM (histórico não carregado ou fundo trimado) não há o que trocar
    const current = findMessageEl(el.messages, msg.id);
    if (current === null) return;
    // editor inline aberto NESTA mensagem: substituir o nó jogaria fora o
    // rascunho digitado — troca o nó mas reabre a edição com o texto preservado
    const draft = editDraftOf(current);
    const fresh = renderMsg(msg);
    current.replaceWith(fresh);
    regroupAt(fresh);
    regroupAt(fresh.nextElementSibling); // o vizinho de baixo pode ter mudado de bloco
    if (draft !== null) startEdit(fresh, msg, ui, msgActions, draft);
    return;
  }
  if (t === "MESSAGE_DELETE") {
    const del = d as { id: string; channel_id: string };
    if (del.channel_id !== state.currentChannel) return;
    const gone = findMessageEl(el.messages, del.id);
    const next = gone?.nextElementSibling ?? null;
    gone?.remove();
    regroupAt(next); // quem estava abaixo pode virar o início do bloco
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
    renderMembers(ui, (userId) => openUserControls(userId));
    renderTypingBar(); // "Usuário desconhecido" na barra pode virar o nome real
    return;
  }
  if (t === "REACTION_ADD" || t === "REACTION_REMOVE") {
    // delta e não a mensagem inteira: a função ignora sozinha o que não é do
    // canal aberto ou não está na janela de DOM
    applyReaction(el.messages, d as ReactionData, t === "REACTION_ADD", ui);
    return;
  }
  if (t === "MESSAGE_ACK") {
    // só as MINHAS sessões recebem: é o que impede a badge sumir no desktop e
    // continuar acesa na aba. É estado (não delta), então reaplicar é inócuo.
    applyAck(d as MessageAckData);
    return;
  }
  if (t === "MEMBER_UPDATE") {
    const user = d as User;
    state.members.set(user.id, user);
    // o MEU cargo/apelido/timeout também chegam por aqui: sem isto o menu de
    // convites não apareceria numa promoção, e o composer não travaria no timeout
    if (user.id === state.me?.id) {
      state.me = user;
      setComposerMuted(user.muted_until); // pôr e tirar o timeout passam por aqui
    }
    renderMembers(ui, (userId) => openUserControls(userId));
    renderUserPanel(ui);
    renderTypingBar(); // o nome exibido pode ter mudado
    refreshInvitesMenu(ui); // promoção/rebaixamento mostra ou some com o item
    refreshUserControls();
    return;
  }
  if (t === "MEMBER_REMOVE") {
    const gone = d as { id: string };
    state.members.delete(gone.id);
    state.presences.delete(gone.id);
    state.voiceStates.delete(gone.id);
    for (const set of state.speaking.values()) set.delete(gone.id);
    memberRemoved(ui, gone.id, (userId) => openUserControls(userId));
    renderChannels(); // some da lista de participantes do canal de voz também
    return;
  }
  if (t === "PRESENCE_UPDATE") {
    const p = d as PresenceUpdateData;
    // "offline" APAGA a entrada em vez de preencher: o mapa guarda só quem tem
    // status para mostrar, e quem não está lá está fora — sem estado morto
    if (p.status === "offline") state.presences.delete(p.user_id);
    else state.presences.set(p.user_id, p.status);
    renderMembers(ui, (userId) => openUserControls(userId));
    renderUserPanel(ui); // a bolinha de status do painel do usuário é minha presença
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
      if (gw === currentGateway) {
        setConnectionStatus(s);
        emitConnection(s); // anti-flapping mora lá dentro: ~2 s estáveis viram som
      }
    },
    dispatch: (t, d) => {
      if (gw === currentGateway) onDispatch(t, d);
    },
    // o close code separa casos que pedem ações OPOSTAS; o resto (queda de
    // rede, 1006, servidor reiniciando) fica com o backoff do GatewayClient
    closed: (code) => {
      if (gw !== currentGateway) return;
      if (code === CloseCode.AuthenticationFailed) void onGatewayAuthFailed(gw);
      else if (code === CloseCode.NotAMember) void onNoLongerMember();
    },
  },
  // status já no Identify: sem isto o servidor anunciava "online" à guild antes
  // de o op 3 poder chegar, e quem estava invisível piscava verde a cada
  // reconexão. Getter e não valor — o status muda entre uma reconexão e outra.
  () => myStatus());
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
  setConnectionStatus("offline");
  emitConnection("offline");
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

async function doLogout(motivo?: string): Promise<void> {
  // avisa o "leave" de voz ANTES de derrubar o gateway — senão o fantasma
  // fica no canal para os outros até a sessão expirar no servidor (~2 min)
  await voice.leave();
  currentGateway?.stop();
  currentGateway = null;
  await logout();
  resetState();
  // Estado de MÓDULO que o resetState não alcança: o anti-flapping do som e os
  // timers da faixa de conexão. Sem estes dois, um close que leva ao logout
  // (kick com 4016, refresh inválido) deixava um timer armado disparando DEPOIS
  // que a tela de login já estava na frente — som de "conexão perdida" por cima
  // dela, e o próximo login herdando "caiu" para tocar "reconectado".
  resetConnectionSound();
  resetConnectionBar();
  showLogin(motivo);
}

/**
 * Close 4016 (M10 item 114): a sessão perdeu o direito de existir DEPOIS do
 * Identify — kick, ban, cargo revogado ou allowlist mexida por fora pelo CLI.
 *
 * Precisa de caminho próprio porque é o oposto do 4004: ali o token está velho
 * e renovar resolve; aqui NENHUM token resolve, e o servidor repete o mesmo
 * close a cada tentativa. Sem isto o cliente reconectava para sempre e ficava
 * presa a faixa "Sem conexão — tentando reconectar…", que descreve um problema
 * de rede e esconde o de verdade: você não está mais no servidor.
 */
async function onNoLongerMember(): Promise<void> {
  await doLogout("Você não faz mais parte deste servidor.");
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
/**
 * Delegador do op 20. Extraído do construtor do VoiceClient porque a moderação
 * de voz (M9: server_mute e disconnect_user) fala pelo MESMO caminho — e tem
 * que ser o gateway ATUAL, que é recriado a cada renovação de token.
 */
const voiceRequest = (m: string, p?: unknown): Promise<unknown> => {
  const gw = currentGateway;
  if (gw === null) return Promise.reject(new Error("gateway desconectado"));
  return gw.request(m, p);
};

const voice = new VoiceClient(voiceRequest);

/**
 * O contexto que os módulos de ui/ enxergam (M7). Nasce aqui, depois do
 * VoiceClient, porque metade dos getters vem dele.
 *
 * Os campos são GETTERS de propósito: o objeto é criado UMA vez e entregue no
 * mount, mas cada render precisa ler o estado do instante — um snapshot por
 * chamada devolveria a lista de canais do boot para sempre.
 */
const ui: SidebarContext & UserControlsContext = {
  state: {
    get me() {
      return state.me;
    },
    get channels() {
      return state.channels;
    },
    get members() {
      return state.members;
    },
    get presences() {
      return state.presences;
    },
    // derivado das chaves do mapa: enquanto sidebar e user-controls ainda
    // perguntam "está online?", este getter existe para não haver uma segunda
    // verdade para desencontrar (ver o comentário em ui/context.ts)
    get online() {
      return new Set(state.presences.keys());
    },
    get currentChannel() {
      return state.currentChannel;
    },
    get voiceStates() {
      return state.voiceStates;
    },
    get speaking() {
      return state.speaking;
    },
    get voiceChannelId() {
      return voice.channelId;
    },
    get selfMute() {
      return voice.muted;
    },
    get selfDeaf() {
      return voice.deafened;
    },
    get watchingUserId() {
      return voice.watchingUserId;
    },
  },
  voice: {
    get connected() {
      return voice.connected;
    },
    get cameraOn() {
      return voice.cameraOn;
    },
    get streamOn() {
      return voice.streamOn;
    },
  },
  actions: {
    selectChannel: (id) => void selectChannel(id),
    joinVoice: (id) => void joinVoice(id),
    leaveVoice: () => void voice.leave(),
    // seguros fora da call: applyMute() protege com track != null e pushState()
    // sai cedo sem canal — mutar antes de entrar VALE para o próximo join.
    //
    // O som sai SÍNCRONO, logo após a chamada: o toggle já mudou o estado na
    // primeira linha, antes de qualquer await. Esperar a promise amarraria o
    // clipe ao round-trip do update_state — dois cliques rápidos resolveriam
    // fora de ordem e tocariam o som errado duas vezes (revisão M8 #2).
    toggleMute: () => {
      void voice.toggleMute();
      emit({ name: voice.muted ? "self-mute" : "self-unmute" });
    },
    toggleDeafen: () => {
      void voice.toggleDeafen();
      emit({ name: voice.deafened ? "self-deafen" : "self-undeafen" });
    },
    watchStream: (userId) => {
      const producerId = voice.streamProducerIdOf(userId);
      if (producerId === null) return; // anúncio ainda em trânsito — clique de novo
      void voice.watchStream(producerId, userId).catch((err: unknown) => {
        console.warn("voz: falha ao assistir a transmissão", err);
        flashVoiceError("não foi possível assistir a esta transmissão"); // rev. M5 #2
      });
    },
    stopWatching: () => voice.stopWatching(),
    logout: () => void doLogout(),
  },
  // M9: o card do membro. O volume/mute VIVOS são do VoiceClient; o
  // localStorage é só memória entre sessões, e quem o reaplica é o
  // mountUserControls — um ponto só, senão duas fontes divergem.
  controls: {
    getUserVolume: (id) => voice.getUserVolume(id),
    setUserVolume: (id, v) => voice.setUserVolume(id, v),
    isUserMuted: (id) => voice.isUserMuted(id),
    setUserMuted: (id, m) => voice.setUserMuted(id, m),
    isSoundboardMuted: isUserSilenced,
    setSoundboardMuted: setUserSilenced,
    serverMute: async (userId, muted) => {
      await voiceRequest("server_mute", { user_id: userId, muted });
    },
    disconnectUser: async (userId) => {
      await voiceRequest("disconnect_user", { user_id: userId });
    },
  },
};
mountSidebar(ui);
mountSoundboard(ui);
mountUnread(ui, {
  ack: (channelId, messageId) =>
    api(`/api/channels/${channelId}/ack`, { method: "POST", body: JSON.stringify({ message_id: messageId }) }).then(
      () => undefined,
    ),
  pularParaOPresente: () => {
    if (state.currentChannel !== null) void loadLatest(state.currentChannel);
  },
});
mountUserControls(ui); // aqui as preferências salvas voltam para o VoiceClient
restoreVoicePrefs(voice); // dispositivo escolhido vale para o próximo join

// "Voz e vídeo" no menu da engrenagem: o menu é montado pela sidebar, mas o
// item precisa do VoiceClient — que a sidebar não conhece, e nem deveria.
// Entra ANTES do "Sair", que continua sendo o último (é o destrutivo).
const userMenu = el.userPanel.querySelector<HTMLElement>(".user-menu");
if (userMenu !== null) userMenu.insertBefore(voiceSettingsMenuItem(voice, el.userSettings), el.logout);

/**
 * Som (M8). O callback é lido no INSTANTE de cada evento — nada de listener de
 * focus/blur nem de espelhar estado: a política pergunta, o main responde.
 */
// M10: o status desta sessão. `declare` manda o op 3; `repaint` atualiza a
// bolinha do painel do usuário sem re-renderizar a tela toda.
mountPresence({
  declare: (status) => currentGateway?.presence(status),
  repaint: () => renderUserPanel(ui),
});

// bloquear é local e some com a pessoa da tela: refazer a janela inteira é o
// caminho certo por causa da regra do M7 (o trim corta nas DUAS pontas, e o
// loadLatest já cuida do regroup) — tirar nós à mão deixaria o agrupamento torto
subscribeBlocked(() => {
  if (state.currentChannel !== null) void loadLatest(state.currentChannel);
});

mountSound(() => ({
  meId: state.me?.id ?? null,
  deafened: voice.deafened,
  muted: voice.muted,
  voiceChannelId: voice.channelId,
  viewingChannelId: state.currentChannel,
  windowFocused: document.hasFocus(),
  dnd: myStatus() === "dnd", // "não perturbe" cala notificação, não a voz
}));

/**
 * Sons de join/leave (M6, doc §8): tocam quando ALGUÉM (inclusive eu) entra
 * ou sai do MEU canal de voz — web e desktop. Os movimentos dos OUTROS saem do
 * VOICE_STATE_UPDATE; os MEUS saem daqui: o onChange dispara na hora do
 * join/leave local (mais imediato que o eco do gateway, e cobre kick/logout,
 * onde o eco nem viria a tempo).
 */
let lastOwnVoiceChannel: string | null = null;
voice.onChange = () => {
  const cur = voice.channelId;
  if (cur !== lastOwnVoiceChannel) {
    // troca direta de canal (X→Y) toca só o join — a saída é implícita.
    // No leave o voice.channelId JÁ é null: o canal do evento tem que vir do
    // último conhecido, senão a política não tem com o que comparar.
    emit({
      name: cur !== null ? "voice-join" : "voice-leave",
      actorId: state.me?.id ?? null,
      channelId: cur ?? lastOwnVoiceChannel,
    });
    lastOwnVoiceChannel = cur;
  }
  renderVoiceUi();
};

function renderVoiceUi(): void {
  renderChannels(); // as listas de participantes moram sob os canais de voz
  renderVoiceFooter();
  renderUserPanel(ui); // mic/fone do painel do usuário espelham o estado de voz
  renderSoundboard(); // o pad só existe conectado
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
  // o par sonoro do aviso visual: se a mensagem existe porque o usuário PRECISA
  // perceber, o som pertence ao mesmo lugar (revisão M8 #3)
  emit({ name: "error" });
  el.voiceFooter.hidden = false;
  el.voiceFooterStatus.textContent = msg;
  el.voiceFooterStatus.classList.add("error");
  if (voiceErrorTimer !== null) clearTimeout(voiceErrorTimer);
  voiceErrorTimer = setTimeout(() => {
    el.voiceFooterStatus.classList.remove("error");
    renderVoiceFooter();
  }, 4000);
}

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
    // o retorno audível É o ponto do PTT: quem segura a tecla costuma estar
    // com a janela escondida atrás de um jogo, sem ver o rótulo mudar. Quem
    // decide se ele CABE (em chamada, mic não mutado) é a política.
    emit({ name: down ? "ptt-on" : "ptt-off" });
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
// Composer (render otimista do M0 + typing do M2). O campo em si — textarea
// que cresce, Enter/Shift+Enter, contador do limite — é de ui/composer; aqui
// fica só o que o componente não pode saber: paginação, nonce e rede.
// ---------------------------------------------------------------------------

mountComposer({
  // ↑ no campo VAZIO (item 93). O composer não conhece `el.messages` nem quem
  // eu sou; ele só pergunta se alguém tratou a tecla.
  onEditLast: () => state.me !== null && editLastOwnMessage(el.messages, state.me.id),
  // sem isto o botão de anexar nem nasce (item 89)
  uploadAttachment,
  onTyping: () => {
    if (state.currentChannel === null) return;
    typingSender.typed(state.currentChannel);
  },
  onSubmit: (content, attachments) => {
    // sem canal (janela entre o startApp e o READY, ou boot com gateway fora)
    // o composer JÁ limpou o campo — devolver o texto é o contrato dele, e o
    // mesmo que os dois catch de rede abaixo fazem. Sem isto a frase digitada
    // desaparece sem enviar e sem aviso (revisão M7 #1).
    if (state.currentChannel === null || state.me === null) {
      setComposerValue(content);
      restoreComposerAttachments(attachments);
      return;
    }
    const channelId = state.currentChannel;
    const me = state.me;
    const corpoDoEnvio = corpo(content, attachments); // ANTES de limpar o alvo
    setReplyTarget(null);
    typingSender.sent(channelId); // enviar encerra a "sessão de digitação" do throttle

    if (view.detachedBottom && view.channelId === channelId) {
      // fundo fora da janela de DOM: não há onde ancorar o render otimista —
      // envia sem nonce e recarrega o final (o dedup por data-id segura o
      // cruzamento entre o reload e o Dispatch)
      void api(`/api/channels/${channelId}/messages`, {
        method: "POST",
        body: JSON.stringify(corpoDoEnvio),
      })
        .then(() => loadLatest(channelId))
        .catch(() => {
          setComposerValue(content); // devolve o texto para retry manual
          // e o anexo junto: sem isto ele some em silêncio, e pode ter sido um
          // print que a pessoa nem salvou. Não há reupload — ele já está no
          // servidor (o relógio de órfão é de 15 min).
          restoreComposerAttachments(attachments);
        });
      return;
    }

    // render otimista (doc §8): aparece já, reconcilia quando o Dispatch voltar
    const nonce = crypto.randomUUID();
    const pending = renderMsg(
      {
        id: nonce,
        channel_id: channelId,
        author_id: me.id,
        content,
        created_at: Date.now(),
        type: "user",
        mentions: [], // o servidor resolve; o otimista ainda não sabe
        mentions_everyone: false,
        // os anexos JÁ existem no servidor (upload em duas etapas), então o
        // otimista desenha a imagem com as dimensões certas — sem pulo de layout
        attachments,
        reactions: [],
      },
      true,
    );
    state.pending.set(nonce, pending);
    el.messages.append(pending);
    regroupAt(pending); // continua o bloco de quem enviou a anterior
    el.messages.scrollTop = el.messages.scrollHeight;

    // A mensagem que falha NÃO some mais (item 82): sumir é o pior feedback —
    // para quem olha, ela simplesmente desapareceu. Ela fica em vermelho, com
    // "Reenviar" e "Descartar".
    //
    // Duas regras que não são óbvias: (a) o texto NÃO volta para o composer,
    // porque ele está na tela — devolver duplicaria; (b) o `pending` só sai do
    // Map no DESCARTE, senão o MESSAGE_CREATE do reenvio bem-sucedido não
    // reconcilia e a mensagem aparece duas vezes.
    const enviar = (): void => {
      void api(`/api/channels/${channelId}/messages`, {
        method: "POST",
        body: JSON.stringify({ ...corpoDoEnvio, nonce }),
      }).catch(() => {
        markFailed(pending, {
          onResend: enviar,
          onDiscard: () => {
            const next = pending.nextElementSibling;
            pending.remove();
            regroupAt(next);
            state.pending.delete(nonce);
          },
        });
      });
    };
    enviar();
  },
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


// header do canal, faixa de conexão e o botão de esconder a lista de membros
mountChrome();
mountEmojiComposer(); // botão de emoji + autocomplete de :nome: (item 88)
mountSearch({ ctx: ui, api, jumpTo }); // item 91

/**
 * Leva a conversa até uma mensagem qualquer do histórico (resultado de busca,
 * clique numa citação de reply). É o único pedaço que só este arquivo sabe
 * fazer: a janela de DOM tem ~600 mensagens, e uma antiga exige recarregar
 * EM VOLTA dela.
 *
 * `before` é EXCLUSIVO e os ids são snowflakes inteiros, então `id + 1` devolve
 * a página que TERMINA na mensagem procurada. BigInt e não Number: um snowflake
 * de 64 bits não cabe num double (regra do projeto).
 */
async function jumpTo(channelId: string, messageId: string): Promise<void> {
  if (state.currentChannel !== channelId) await selectChannel(channelId);
  let alvo = findMessageEl(el.messages, messageId);
  if (alvo === null) {
    const antes = (BigInt(messageId) + 1n).toString();
    const janela = (await api(`/api/channels/${channelId}/messages?limit=${PAGE_SIZE}&before=${antes}`)) as Message[];
    if (state.currentChannel !== channelId) return; // trocou de canal durante o fetch
    janela.reverse();
    view = {
      channelId,
      reachedStart: janela.length < PAGE_SIZE,
      loadingOlder: false,
      // o fundo NÃO está na janela: reaproveita o mecanismo do M2 — quando a
      // pessoa rolar de volta ao fim, o listener de scroll recarrega o presente
      detachedBottom: true,
      resyncing: false,
    };
    el.messages.replaceChildren(...janela.filter(visivel).map((m) => renderMsg(m)));
    regroupAll(el.messages); // o lote entrou solto; antes de medir altura
    syncUnreadDivider(el.messages);
    setDetached(true, novasNoDetached);
    alvo = findMessageEl(el.messages, messageId);
  }
  if (alvo === null) throw new Error("mensagem não encontrada");
  alvo.scrollIntoView({ block: "center" });
  alvo.classList.add("msg-highlight");
  const marcado = alvo;
  window.setTimeout(() => marcado.classList.remove("msg-highlight"), 2000);
}

async function boot(): Promise<void> {
  // desktop (M6): hidrata o cache de segredos ANTES de qualquer getAccessToken
  // síncrono — sem isto, uma sessão salva no safeStorage pareceria logout
  await hydrateAuth();

  // M10 (item 47): /invite/<code>. Vem ANTES de tudo que é sessão porque quem
  // clica num link de convite normalmente NÃO tem conta — a tela de login
  // genérica seria a pior recepção possível. O código sobrevive ao ida-e-volta
  // do OAuth viajando no `state` (o servidor cuida disso).
  const inviteCode = inviteCodeFromLocation();
  if (inviteCode !== null && getAccessToken() === null) {
    // desktop: o mesmo fluxo loopback do M6, agora levando o convite junto —
    // sem isto, quem já tem o app instalado e recebe um link não entra. O
    // `exactOptionalPropertyTypes` do projeto não aceita `onEnter: undefined`,
    // então o objeto é montado antes.
    const bridge = desktop;
    const opts =
      bridge === undefined
        ? { onDismiss: () => showLogin() }
        : {
            onDismiss: () => showLogin(),
            onEnter: (code: string) => {
              void bridge
                .oauthLogin(code)
                .then((otc) => exchangeOtc(otc))
                .then(() => startApp())
                .catch((err: unknown) => showLogin(desktopLoginErrorMessage(err)));
            },
          };
    renderInviteLanding(inviteCode, opts);
    return;
  }
  // já logado num /invite/<code>: a pessoa já é membro e o caminho não diz
  // nada — limpa a barra de endereço e segue para o app
  if (inviteCode !== null) history.replaceState(null, "", "/");

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
