import {
  CloseCode,
  type Channel,
  type DispatchName,
  type Message,
  type ReadyData,
  type User,
} from "@danjocord/protocol";
import { GatewayClient, type GatewayStatus } from "./gateway.js";
import { API, AuthError, devLogin, exchangeOtc, getAccessToken, getUser, logout, refresh } from "./auth.js";
import { TypingSender, TypingTracker, typingLabel } from "./typing.js";

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
};

interface State {
  me: User | null;
  channels: Channel[];
  members: Map<string, User>;
  online: Set<string>;
  currentChannel: string | null;
  /** nonce → elemento renderizado otimisticamente, aguardando o Dispatch */
  pending: Map<string, HTMLElement>;
}
const state: State = {
  me: null,
  channels: [],
  members: new Map(),
  online: new Set(),
  currentChannel: null,
  pending: new Map(),
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
    ...state.channels.map((c) => {
      const btn = document.createElement("button");
      btn.textContent = (c.type === "text" ? "# " : "🔊 ") + c.name;
      btn.className = c.id === state.currentChannel ? "active" : "";
      btn.disabled = c.type === "voice"; // voz chega no M3
      btn.onclick = () => selectChannel(c.id);
      return btn;
    }),
  );
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
    renderMe(ready.user);
    renderChannels();
    renderMembers();
    const first = ready.channels.find((c) => c.type === "text");
    if (first && state.currentChannel === null) void selectChannel(first.id);
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
  currentGateway?.stop();
  currentGateway = null;
  await logout();
  resetState();
  showLogin();
}

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
  // o backend inicia o fluxo (state + PKCE ficam server-side) e redireciona
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
