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
  el.channels.replaceChildren();
  el.members.replaceChildren();
  el.messages.replaceChildren();
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

function messageEl(msg: Message, pending = false): HTMLElement {
  const div = document.createElement("div");
  div.className = pending ? "msg pending" : "msg";
  const time = new Date(msg.created_at).toLocaleTimeString();
  div.innerHTML = `<span class="author"></span><span class="content"></span><span class="time">${time}</span>`;
  div.querySelector(".author")!.textContent = authorName(msg.author_id);
  div.querySelector(".content")!.textContent = msg.content;
  return div;
}

async function selectChannel(channelId: string): Promise<void> {
  state.currentChannel = channelId;
  renderChannels();
  const history = (await api(`/api/channels/${channelId}/messages?limit=50`)) as Message[];
  el.messages.replaceChildren(...history.reverse().map((m) => messageEl(m)));
  el.messages.scrollTop = el.messages.scrollHeight;
}

// ---------------------------------------------------------------------------
// REST com renovação: 401 → refresh → repete UMA vez; falhou → volta ao login
// ---------------------------------------------------------------------------

function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  // o access é relido a cada chamada: um refresh (desta aba ou de outra) já
  // vale para a próxima requisição sem recriar nada
  return fetch(API + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${getAccessToken() ?? ""}`, ...init?.headers },
  });
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
    if (!state.members.has(msg.author_id)) {
      // autor entrou depois do nosso READY — snapshot desatualizado é esperado; M2 traz MEMBER_ADD
      state.members.set(msg.author_id, { id: msg.author_id, username: `user-${msg.author_id.slice(-4)}`, avatar_url: null });
      renderMembers();
    }
    if (msg.channel_id !== state.currentChannel) return;
    const pendingEl = msg.nonce ? state.pending.get(msg.nonce) : undefined;
    if (pendingEl) {
      state.pending.delete(msg.nonce!);
      pendingEl.replaceWith(messageEl(msg));
    } else {
      el.messages.append(messageEl(msg));
    }
    el.messages.scrollTop = el.messages.scrollHeight;
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
// Composer (render otimista, inalterado do M0)
// ---------------------------------------------------------------------------

el.composer.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const content = el.input.value.trim();
  if (!content || !state.currentChannel || !state.me) return;
  el.input.value = "";

  // render otimista (doc §8): aparece já, reconcilia quando o Dispatch voltar
  const nonce = crypto.randomUUID();
  const pending = messageEl(
    { id: nonce, channel_id: state.currentChannel, author_id: state.me.id, content, created_at: Date.now() },
    true,
  );
  state.pending.set(nonce, pending);
  el.messages.append(pending);
  el.messages.scrollTop = el.messages.scrollHeight;

  void api(`/api/channels/${state.currentChannel}/messages`, {
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
