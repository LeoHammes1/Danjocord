/**
 * "Cromo" do canal (M7): o header (ícone + nome do canal ATUAL), o título da
 * janela e a faixa de conexão.
 *
 * Três problemas do M0–M6 morrem aqui:
 *
 * 1. O header mostrava `<h1>Danjocord</h1>` cravado no HTML — com mais de um
 *    canal de texto a única pista de onde a pessoa estava era o realce na
 *    sidebar. Agora o header diz o canal, como no Discord.
 * 2. O título da janela era fixo. No desktop (M6) o título do documento É o
 *    título da janela do Electron — trocá-lo aqui já resolve a barra de tarefas
 *    e o Alt+Tab, sem nenhum IPC novo.
 * 3. O estado do gateway vivia numa pill de 12px no canto do header. Numa queda
 *    de rede a pessoa continuava digitando sem perceber que estava offline. A
 *    faixa abaixo do header é o sinal forte; o #status virou só um ponto.
 */
import type { GatewayStatus } from "../gateway.js";
import type { UiContext } from "./context.js";
import { icon } from "./icons.js";

const APP_NAME = "Danjocord";

/** Escolha do usuário sobre a coluna de membros — sobrevive ao reload. */
const MEMBERS_KEY = "danjocord_members_visible";

const el = {
  app: document.getElementById("app")!,
  channelIcon: document.getElementById("channel-icon")!,
  channelName: document.getElementById("channel-name")!,
  channelTopic: document.getElementById("channel-topic")!,
  toggleMembers: document.getElementById("toggle-members") as HTMLButtonElement,
  status: document.getElementById("status")!,
};

// ---------------------------------------------------------------------------
// Header do canal
// ---------------------------------------------------------------------------

export function renderChannelHead(ctx: UiContext): void {
  const channel = ctx.state.channels.find((c) => c.id === ctx.state.currentChannel) ?? null;
  // o ícone é recriado a cada render (e não trocado por classe) porque texto e
  // voz são desenhos diferentes, não estados do mesmo desenho
  el.channelIcon.replaceChildren(icon(channel?.type === "voice" ? "volume" : "hash"));
  el.channelName.textContent = channel?.name ?? APP_NAME;
  // O banco não tem coluna de tópico (e inventar uma seria mudar o protocolo,
  // que o M7 não faz). O elemento fica vazio de propósito: o `:empty` do
  // chrome.css esconde o divisor vertical, então não sobra um risco solto no
  // meio do header — e o dia em que o tópico existir, só o texto muda.
  el.channelTopic.textContent = "";
  syncDocumentTitle(ctx);
}

/**
 * `#geral · Danjocord` na aba do navegador e, no desktop, na janela do
 * Electron (o main espelha o title do documento sozinho — sem IPC).
 */
export function syncDocumentTitle(ctx: UiContext): void {
  const channel = ctx.state.channels.find((c) => c.id === ctx.state.currentChannel) ?? null;
  document.title = channel === null ? APP_NAME : `#${channel.name} · ${APP_NAME}`;
}

// ---------------------------------------------------------------------------
// Coluna de membros: o botão do header
// ---------------------------------------------------------------------------

function setMembersVisible(visible: boolean): void {
  // classe no #app (e não [hidden] no painel): a media query de 1100px também
  // esconde a coluna, e um atributo no elemento brigaria com ela — quem manda
  // no fim é sempre o CSS (ver o comentário do layout.css)
  el.app.classList.toggle("hide-members", !visible);
  el.toggleMembers.setAttribute("aria-pressed", String(visible));
  el.toggleMembers.title = visible ? "Ocultar membros" : "Mostrar membros";
  localStorage.setItem(MEMBERS_KEY, visible ? "1" : "0");
}

// ---------------------------------------------------------------------------
// Faixa de conexão
// ---------------------------------------------------------------------------

const LABEL: Record<GatewayStatus, string> = {
  connecting: "Conectando…",
  resuming: "Retomando a conexão…",
  offline: "Sem conexão — tentando reconectar…",
  online: "Conectado",
};

const TONE: Record<GatewayStatus, string> = {
  connecting: "warn",
  resuming: "warn",
  offline: "danger",
  online: "ok",
};

/** Carência antes de aparecer: um soluço de meio segundo não vira faixa. */
const GRACE_MS = 600;
/** Quanto o "Conectado" fica na tela antes de sumir sozinho. */
const OK_MS = 2000;

let bar: HTMLElement | null = null;
let barVisible = false;
let barTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A faixa é criada em JS porque o index.html tem dono único e este elemento é
 * inteiramente deste módulo. Ela é filha do #app mas `position: fixed` — assim
 * NÃO vira um item do grid de quatro colunas (item fora de fluxo não participa
 * do grid) e não precisa de uma grid-area só para ela; a posição sai das
 * variáveis --col-* do próprio #app, que as media queries já ajustam.
 */
function ensureBar(): HTMLElement {
  if (bar !== null) return bar;
  const div = document.createElement("div");
  div.className = "conn-bar";
  // role=status ⇒ aria-live polite: o leitor de tela anuncia a queda sem roubar
  // o foco de quem está digitando. É por isso que o #status vira aria-hidden
  // logo abaixo — dois live regions dizendo a mesma coisa seria eco.
  div.setAttribute("role", "status");
  el.app.append(div);
  bar = div;
  return div;
}

function paintBar(status: GatewayStatus): void {
  const div = ensureBar();
  div.textContent = LABEL[status];
  div.className = `conn-bar ${TONE[status]}${barVisible ? " on" : ""}`;
}

export function setConnectionStatus(status: GatewayStatus): void {
  // o ponto do header acompanha SEMPRE — é o estado permanente, discreto
  el.status.className = status === "online" ? "online" : status === "offline" ? "offline" : "";
  el.status.title = LABEL[status];

  ensureBar();
  if (barTimer !== null) {
    clearTimeout(barTimer);
    barTimer = null;
  }

  if (status === "online") {
    // ninguém viu o problema (boot normal, reconexão instantânea): não faz
    // sentido anunciar a solução — a faixa só some se antes apareceu
    if (!barVisible) return;
    paintBar(status);
    barTimer = setTimeout(() => {
      barTimer = null;
      barVisible = false;
      paintBar("online"); // mantém o texto enquanto desliza para fora
    }, OK_MS);
    return;
  }

  // já na tela: só troca texto e cor (connecting → offline não re-anima)
  if (barVisible) {
    paintBar(status);
    return;
  }
  barTimer = setTimeout(() => {
    barTimer = null;
    barVisible = true;
    paintBar(status);
  }, GRACE_MS);
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/** Liga o que é estático (ícones, botão de membros, faixa). Chamar UMA vez. */
export function mountChrome(): void {
  el.channelIcon.replaceChildren(icon("hash"));
  el.toggleMembers.replaceChildren(icon("members"));
  // o HTML nasce com aria-expanded; um botão que liga/desliga uma coluna é
  // toggle (aria-pressed), não disclosure — manter os dois seria manter duas
  // verdades sobre o mesmo estado
  el.toggleMembers.removeAttribute("aria-expanded");
  // ausente = visível: quem nunca escolheu vê a coluna, como no Discord
  setMembersVisible(localStorage.getItem(MEMBERS_KEY) !== "0");
  el.toggleMembers.addEventListener("click", () => {
    setMembersVisible(el.app.classList.contains("hide-members"));
  });

  // o ponto perde o texto "conectando…" que vinha do HTML: quem fala agora é a
  // faixa (e o title, para quem passa o mouse)
  el.status.textContent = "";
  el.status.setAttribute("aria-hidden", "true");
  ensureBar();
}
