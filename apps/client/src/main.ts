import type { Channel, Message, ReadyData, User } from "@danjocord/protocol";
import { GatewayClient, type GatewayStatus } from "./gateway.js";

const API = import.meta.env.VITE_API_BASE ?? "http://localhost:8080";
const GATEWAY = API.replace(/^http/, "ws") + "/gateway";

// Auth de desenvolvimento (M0): "dev.<username>". OAuth do Discord chega no M1.
// ?user=<nome> na URL troca de usuário sem apagar o localStorage — bom para
// abrir várias abas com usuários diferentes.
const qsUser = new URLSearchParams(location.search).get("user");
let token = qsUser ? `dev.${qsUser.toLowerCase()}` : localStorage.getItem("danjocord_token");
if (!token) {
  const username = (prompt("username de desenvolvimento:") ?? "anon").trim() || "anon";
  token = `dev.${username.toLowerCase()}`;
}
localStorage.setItem("danjocord_token", token);

const el = {
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

function setStatus(status: GatewayStatus): void {
  el.status.textContent =
    status === "online" ? "online" : status === "resuming" ? "retomando…" : status === "offline" ? "reconectando…" : "conectando…";
  el.status.className = status === "online" ? "online" : status === "offline" ? "offline" : "";
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

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(API + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init?.headers },
  });
  if (!res.ok) throw new Error(`${res.status} em ${path}`);
  return res.json();
}

const gateway = new GatewayClient(GATEWAY, token, {
  status: setStatus,
  dispatch: (t, d) => {
    if (t === "READY") {
      const ready = d as ReadyData;
      state.me = ready.user;
      state.channels = ready.channels;
      state.members = new Map(ready.members.map((m) => [m.id, m]));
      state.online = new Set([ready.user.id]);
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
  },
});

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

setStatus("connecting");
gateway.connect();
