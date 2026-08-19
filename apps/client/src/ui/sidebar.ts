/**
 * Sidebar (M7): categorias de canais, participantes de voz, rodapé de voz e
 * painel do usuário. Substitui as funções de render que moravam no main.ts
 * (renderChannels/textChannelEl/voiceChannelEl/voiceUserEl/renderMe/
 * renderVoiceFooter) — a LÓGICA é a mesma; o que muda é a forma.
 *
 * O módulo não conhece o `state` do main.ts nem o VoiceClient: tudo entra pelo
 * SidebarContext (ver ui/context.ts). Estado próprio, só o VISUAL: quais
 * categorias estão colapsadas.
 */
import { avatarColor, avatarEl } from "./avatar.js";
import type { Channel, UiContext, VoiceState } from "./context.js";
import { icon, type IconName } from "./icons.js";
import { openUserControls } from "./user-controls.js";
import { invitesMenuItem } from "./invites.js";
import { presenceMenuItems } from "./presence.js";
import { soundMenuItem } from "./settings.js";
import { applyChannelUnread } from "./unread.js";

/**
 * O UiContext base não carrega estes três — e a sidebar precisa deles: o
 * rodapé distingue "Conectando voz…" de "Voz conectada" (connected) e acende
 * os botões de câmera/transmissão (M4/M5), e a regra de quem é "assistível"
 * exige estar CONECTADO no mesmo canal (doc §3.6). São leituras do
 * VoiceClient, não estado de domínio — daí a extensão local em vez de inchar
 * o UiState de todo mundo.
 */
export interface SidebarVoice {
  connected: boolean;
  cameraOn: boolean;
  streamOn: boolean;
}

export interface SidebarContext extends UiContext {
  voice: SidebarVoice;
}

const el = {
  sidebarHead: document.getElementById("sidebar-head") as HTMLButtonElement,
  channels: document.getElementById("channels")!,
  // painel do usuário
  meAvatar: document.getElementById("me-avatar") as HTMLImageElement,
  meName: document.getElementById("me-name")!,
  meSub: document.getElementById("me-sub")!,
  userPanel: document.getElementById("user-panel")!,
  userMute: document.getElementById("user-mute") as HTMLButtonElement,
  userDeafen: document.getElementById("user-deafen") as HTMLButtonElement,
  userSettings: document.getElementById("user-settings") as HTMLButtonElement,
  logout: document.getElementById("logout") as HTMLButtonElement,
  // rodapé de voz (M3/M4/M5) — o PTT (M6) é do main.ts, aqui só existe no CSS
  voiceFooter: document.getElementById("voice-footer")!,
  voiceFooterStatus: document.getElementById("voice-footer-status")!,
  voiceFooterChannel: document.getElementById("voice-footer-channel")!,
  voiceCamera: document.getElementById("voice-camera") as HTMLButtonElement,
  voiceStream: document.getElementById("voice-stream") as HTMLButtonElement,
  voiceMute: document.getElementById("voice-mute") as HTMLButtonElement,
  voiceDeafen: document.getElementById("voice-deafen") as HTMLButtonElement,
  voiceLeave: document.getElementById("voice-leave") as HTMLButtonElement,
};

// ---------------------------------------------------------------------------
// Categorias
//
// O banco NÃO tem categoria: um canal só sabe se é `text` ou `voice` (categoria
// de verdade é item 72 do ROADMAP). As duas seções abaixo são derivadas do
// type — nada de modelo de dados novo escondido no cliente.
// ---------------------------------------------------------------------------

const CATEGORIES: { type: Channel["type"]; label: string; icon: IconName }[] = [
  { type: "text", label: "Canais de texto", icon: "hash" },
  { type: "voice", label: "Canais de voz", icon: "volume" },
];

/**
 * Colapso é estado VISUAL (por isso mora aqui e não no UiState), mas é o tipo
 * de preferência que irrita quando se perde a cada F5 — daí o localStorage.
 */
const COLLAPSED_KEY = "danjocord_collapsed_categories";

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed.filter((v): v is string => typeof v === "string"));
    }
  } catch {
    // JSON corrompido: volta ao default (tudo expandido)
  }
  return new Set();
}

const collapsed = loadCollapsed();

function saveCollapsed(): void {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
}

function anyExpanded(): boolean {
  return CATEGORIES.some((c) => !collapsed.has(c.type));
}

// ---------------------------------------------------------------------------
// Montagem: o que é ligado UMA vez (ícones estáticos, listeners, o menu)
// ---------------------------------------------------------------------------

/**
 * Avatar do "eu". Aqui NÃO se usa o avatarEl() de ui/avatar.ts, e o motivo é
 * único: o `id="me-avatar"` é contrato do index.html e precisa continuar no
 * DOM — o factory devolveria uma <img> nova (ou nem <img>, quando não há
 * foto). O que se reaproveita é o resto: as MESMAS classes (.av/.av-cut/
 * .av-dot/.av-initial, em members.css) e a MESMA cor derivada do id, para o
 * painel do usuário não virar o único avatar diferente da tela.
 */
const avatarSlot = document.createElement("span");
avatarSlot.className = "av av-cut";
avatarSlot.style.setProperty("--avatar-size", "32px");
/** fallback de quem não tem foto — o par do initialEl() do ui/avatar.ts */
const avatarFallback = document.createElement("span");
avatarFallback.className = "avatar av-initial";
avatarFallback.setAttribute("aria-hidden", "true");
/** bolinha de presença recortada no canto (decorativa: quem informa é o #me-sub) */
const statusDot = document.createElement("span");
statusDot.className = "av-dot av-offline";
statusDot.setAttribute("aria-hidden", "true");

/** menu da engrenagem — o #logout do HTML passa a morar aqui dentro */
const userMenu = document.createElement("div");
userMenu.className = "user-menu";
userMenu.setAttribute("role", "menu");
userMenu.hidden = true;

function setMenuOpen(open: boolean): void {
  userMenu.hidden = !open;
  el.userSettings.setAttribute("aria-expanded", String(open));
  // primeiro item, não o último: com mais de um item, focar o "Sair" jogaria
  // quem abre por teclado direto no destrutivo (convenção de menu do ARIA)
  if (open) userMenu.querySelector<HTMLElement>(".menu-item")?.focus();
}

let mounted = false;

/**
 * Liga o que não muda com o estado. Chamar UMA vez, depois de o DOM existir e
 * antes do primeiro render.
 */
export function mountSidebar(ctx: SidebarContext): void {
  if (mounted) return;
  mounted = true;

  // --- cabeçalho da sidebar: recolhe/expande TODAS as categorias de uma vez.
  // É o único trabalho honesto para este botão hoje (não há convite nem
  // configurações de guild para um servidor de dez amigos), e é o que faz o
  // aria-expanded que já estava no HTML deixar de ser mentira.
  el.sidebarHead.append(icon("chevron", 16));
  el.sidebarHead.setAttribute("aria-controls", "channels");
  el.sidebarHead.addEventListener("click", () => {
    const collapse = anyExpanded();
    for (const cat of CATEGORIES) {
      if (collapse) collapsed.add(cat.type);
      else collapsed.delete(cat.type);
    }
    saveCollapsed();
    renderChannels(ctx);
  });

  // --- painel do usuário: avatar vira "slot" (imagem OU inicial + bolinha)
  el.meAvatar.replaceWith(avatarSlot);
  avatarSlot.append(el.meAvatar, avatarFallback, statusDot);
  // o par do onerror do ui/avatar.ts: a URL do CDN do Discord 404 depois que a
  // pessoa troca de foto, e este era o único avatar da tela que ficaria com o
  // quadradinho quebrado (revisão M7 #9). Registrado UMA vez — o <img> é o
  // mesmo nó para sempre, então não precisa voltar a cada render.
  el.meAvatar.onerror = () => {
    el.meAvatar.hidden = true;
    avatarFallback.hidden = false;
  };

  el.userMute.addEventListener("click", () => ctx.actions.toggleMute());
  el.userDeafen.addEventListener("click", () => ctx.actions.toggleDeafen());

  // --- menu da engrenagem: o #logout sai do painel e entra aqui (o id e o
  // significado continuam; o que muda é onde ele mora)
  el.userSettings.setAttribute("aria-haspopup", "menu");
  el.userSettings.setAttribute("aria-expanded", "false");
  el.userSettings.replaceChildren(icon("settings"));
  el.userSettings.addEventListener("click", () => setMenuOpen(userMenu.hidden));

  el.logout.className = "menu-item danger"; // o único destrutivo do menu
  el.logout.removeAttribute("aria-label"); // agora tem texto visível
  el.logout.setAttribute("role", "menuitem");
  el.logout.replaceChildren(icon("logout", 16), document.createTextNode("Sair"));
  el.logout.addEventListener("click", () => {
    setMenuOpen(false);
    ctx.actions.logout();
  });
  // status → som → convidar → "Sair". O destrutivo fica por último, e o
  // "Voz e vídeo" é inserido pelo main.ts (só ele conhece o VoiceClient).
  userMenu.append(
    ...presenceMenuItems(ctx, el.userSettings, () => setMenuOpen(false)),
    soundMenuItem(el.userSettings, () => setMenuOpen(false)),
    invitesMenuItem(ctx, el.userSettings, () => setMenuOpen(false)),
    el.logout,
  );
  el.userPanel.append(userMenu);

  // fechar o menu: Esc devolve o foco à engrenagem (quem abriu por teclado
  // ficaria com o foco perdido no fim do documento); clique fora só fecha.
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || userMenu.hidden) return;
    setMenuOpen(false);
    el.userSettings.focus();
  });
  // pointerdown (e não click): fecha antes de o clique chegar ao alvo, e o
  // guard do próprio botão evita o fecha-e-reabre do toggle
  document.addEventListener("pointerdown", (ev) => {
    if (userMenu.hidden) return;
    const target = ev.target;
    if (!(target instanceof Node)) return;
    if (userMenu.contains(target) || el.userSettings.contains(target)) return;
    setMenuOpen(false);
  });
  // sair por Tab é o terceiro jeito de deixar o menu (Esc e clique fora já
  // eram tratados): sem isto ele ficava aberto com o foco longe dele, e o
  // próximo clique fora "sumia" com um menu que a pessoa nem via mais.
  // Não devolve o foco — quem saiu por Tab quer seguir adiante (revisão M7 #5).
  userMenu.addEventListener("focusout", (ev) => {
    const to = ev.relatedTarget;
    if (to instanceof Node && (userMenu.contains(to) || el.userSettings.contains(to))) return;
    setMenuOpen(false);
  });

  // --- rodapé de voz: os ícones que nunca trocam de desenho + os listeners
  // das ações que o contrato conhece. Câmera (M4) e transmissão (M5) NÃO
  // estão no UiActions: quem escuta o clique delas continua sendo o main.ts —
  // aqui só se pinta o estado.
  el.voiceCamera.classList.add("icon-btn");
  el.voiceStream.classList.add("icon-btn");
  el.voiceMute.classList.add("icon-btn");
  el.voiceDeafen.classList.add("icon-btn");
  el.voiceLeave.classList.add("icon-btn");
  el.voiceLeave.replaceChildren(icon("logout"));
  el.voiceLeave.setAttribute("aria-label", "Desconectar da voz");
  el.voiceLeave.title = "Desconectar";
  el.voiceMute.addEventListener("click", () => ctx.actions.toggleMute());
  el.voiceDeafen.addEventListener("click", () => ctx.actions.toggleDeafen());
  el.voiceLeave.addEventListener("click", () => ctx.actions.leaveVoice());
}

// ---------------------------------------------------------------------------
// Lista de canais
// ---------------------------------------------------------------------------

function isOpen(ctx: SidebarContext, c: Channel): boolean {
  return c.id === ctx.state.currentChannel;
}

/** conectado = ESTOU em voz neste canal (nada a ver com o canal de texto aberto) */
function isConnected(ctx: SidebarContext, c: Channel): boolean {
  return c.type === "voice" && c.id === ctx.state.voiceChannelId;
}

/**
 * Chave do elemento focado dentro da lista, para reencontrá-lo depois do
 * replaceChildren. Sem isto, colapsar uma categoria PELO TECLADO destrói o
 * próprio botão que recebeu o Enter e o foco volta para o <body> — quem
 * navega sem mouse recomeça do zero a cada clique (revisão M7 #7).
 */
function focusKey(): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !el.channels.contains(active)) return null;
  if (active.classList.contains("cat-head")) return `.cat-head[aria-controls="${active.getAttribute("aria-controls") ?? ""}"]`;
  const canal = active.dataset["channelId"];
  if (canal !== undefined) return `[data-channel-id="${CSS.escape(canal)}"]`;
  const voz = active.dataset["voiceUser"];
  if (voz !== undefined) return `[data-voice-user="${CSS.escape(voz)}"]`;
  return null;
}

export function renderChannels(ctx: SidebarContext): void {
  // replaceChildren zera o scroll; sem isto a lista pula para o topo a cada
  // VOICE_STATE_UPDATE de quem estiver no fim dela
  const scroll = el.channels.scrollTop;
  const focused = focusKey();
  el.sidebarHead.setAttribute("aria-expanded", String(anyExpanded()));

  const sections: HTMLElement[] = [];
  for (const cat of CATEGORIES) {
    const list = ctx.state.channels.filter((c) => c.type === cat.type);
    if (list.length === 0) continue; // categoria vazia é só ruído
    const isCollapsed = collapsed.has(cat.type);
    // colapsada, o canal ABERTO (ou o de voz CONECTADO) continua visível —
    // sem isto, recolher a categoria some com o canal que se está usando
    const visible = isCollapsed ? list.filter((c) => isOpen(ctx, c) || isConnected(ctx, c)) : list;

    const section = document.createElement("div");
    section.className = "cat";
    section.append(categoryHead(ctx, cat.type, cat.label, isCollapsed));
    // a <ul> entra mesmo vazia (colapsada sem canal ativo): é o alvo do
    // aria-controls do cabeçalho, e sem filhos ela não ocupa altura nenhuma
    const ul = document.createElement("ul");
    ul.className = "cat-list";
    ul.id = `cat-${cat.type}`;
    for (const c of visible) ul.append(channelItem(ctx, c));
    section.append(ul);
    sections.push(section);
  }
  el.channels.replaceChildren(...sections);
  el.channels.scrollTop = scroll;
  if (focused !== null) el.channels.querySelector<HTMLElement>(focused)?.focus();
}

function categoryHead(ctx: SidebarContext, type: string, label: string, isCollapsed: boolean): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cat-head";
  btn.setAttribute("aria-expanded", String(!isCollapsed));
  btn.setAttribute("aria-controls", `cat-${type}`);
  btn.append(icon("chevron", 12)); // aponta para baixo; o CSS gira quando colapsa
  const text = document.createElement("span");
  text.textContent = label;
  btn.append(text);
  btn.onclick = () => {
    if (collapsed.has(type)) collapsed.delete(type);
    else collapsed.add(type);
    saveCollapsed();
    renderChannels(ctx);
  };
  return btn;
}

function channelItem(ctx: SidebarContext, c: Channel): HTMLElement {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "channel";
  btn.dataset.channelId = c.id; // âncora do refoco após replaceChildren
  // a badge é pintada AQUI e não por fora: esta lista se recria sozinha
  // (colapsar categoria faz replaceChildren) e badge de fora não sobreviveria
  applyChannelUnread(btn, c.id);
  // As duas marcações eram a MESMA classe `.active` no M0–M6, e coexistiam
  // idênticas na tela: `.is-open` é o canal de texto ABERTO, `.is-connected` é
  // o canal de voz em que estou. Um canal de voz pode estar conectado sem
  // estar aberto (entrar em voz não troca o canal de texto).
  if (isOpen(ctx, c)) {
    btn.classList.add("is-open");
    btn.setAttribute("aria-current", "true");
  }
  if (isConnected(ctx, c)) btn.classList.add("is-connected");
  btn.append(icon(c.type === "voice" ? "volume" : "hash", 18));
  const name = document.createElement("span");
  name.className = "channel-name";
  name.textContent = c.name;
  btn.append(name);
  // entrar em voz NÃO troca o canal de texto atual (contrato do M3)
  btn.onclick = c.type === "voice" ? () => ctx.actions.joinVoice(c.id) : () => ctx.actions.selectChannel(c.id);
  li.append(btn);

  if (c.type === "voice") {
    const inChannel = [...ctx.state.voiceStates.values()].filter((v) => v.channel_id === c.id);
    if (inChannel.length > 0) {
      const speaking = ctx.state.speaking.get(c.id);
      const ul = document.createElement("ul");
      ul.className = "voice-users";
      for (const v of inChannel) ul.append(voiceUserItem(ctx, v, speaking?.has(v.user_id) === true));
      li.append(ul);
    }
  }
  return li;
}

function voiceUserItem(ctx: SidebarContext, v: VoiceState, speaking: boolean): HTMLElement {
  const li = document.createElement("li");
  const member = ctx.state.members.get(v.user_id);
  // mesmo fallback do MESSAGE_CREATE: membro ainda não conhecido vira placeholder
  const name = member?.username ?? `user-${v.user_id.slice(-4)}`;
  const isMe = v.user_id === ctx.state.me?.id;
  const watchingThis = ctx.state.watchingUserId === v.user_id;
  // Regra de "assistível" do M5, preservada: transmitindo, não sou eu (nunca
  // autoconsumo) e estou CONECTADO neste mesmo canal — só quem tem transports
  // consegue consumir (viewers sob demanda, doc §3.6).
  const watchable =
    v.self_stream && !isMe && ctx.voice.connected && ctx.state.voiceChannelId === v.channel_id && !watchingThis;

  let row: HTMLElement;
  if (watchable) {
    // controle clicável é <button>, nunca um <li> com onclick (era assim no M5)
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", `Assistir à transmissão de ${name}`);
    btn.title = "Assistir transmissão";
    btn.onclick = () => ctx.actions.watchStream(v.user_id);
    row = btn;
  } else {
    // M9: sem transmissão para assistir, o clique abre os controles daquela
    // pessoa (volume, mute local, moderação). Vira <button> — controle
    // clicável nunca é <div> com onclick, mesma regra do M5.
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", `Controles de ${name}`);
    btn.onclick = () => openUserControls(v.user_id, btn);
    row = btn;
    if (watchingThis) row.title = "Assistindo — use “Parar de assistir”";
  }
  // a linha ASSISTÍVEL não perde o gesto do M5: nela os controles saem pelo
  // menu de contexto, que serve às duas sem disputar o clique
  row.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    openUserControls(v.user_id, row);
  });
  row.className = speaking ? "voice-user speaking" : "voice-user";
  if (watchable) row.classList.add("watchable");
  // âncoras do updateSpeaking: o anel de "falando" muda sem re-render da lista
  row.dataset.voiceUser = v.user_id;
  row.dataset.voiceChannel = v.channel_id ?? "";

  // sem bolinha de presença: quem está na lista está, por definição, em voz
  row.append(avatarEl(member ?? { id: v.user_id, username: name, avatar_url: null }, 24));

  const label = document.createElement("span");
  label.className = "voice-name";
  label.textContent = name;
  row.append(label);

  // badge AO VIVO (M5): self_stream é DERIVADO no servidor (producer de tela
  // vivo), então não mente sobre a mídia
  if (v.self_stream) {
    const badge = document.createElement("span");
    badge.className = "live-badge";
    badge.append(icon("live", 12));
    const text = document.createElement("span");
    text.textContent = "AO VIVO";
    badge.append(text);
    row.append(badge);
  }

  // surdo implica mudo — um só indicador de áudio; a câmera (M4) soma o dela
  const flags: { name: IconName; label: string }[] = [];
  if (v.self_video) flags.push({ name: "video", label: "câmera ligada" });
  if (v.self_deaf) flags.push({ name: "headphones-off", label: "ensurdecido" });
  else if (v.self_mute) flags.push({ name: "mic-off", label: "mutado" });
  for (const f of flags) {
    const span = document.createElement("span");
    span.className = "voice-flag";
    span.title = f.label;
    span.append(icon(f.name, 14));
    // o ícone é aria-hidden por contrato: o rótulo de verdade vem daqui
    const sr = document.createElement("span");
    sr.className = "sr-only";
    sr.textContent = f.label;
    span.append(sr);
    row.append(span);
  }

  li.append(row);
  return li;
}

/**
 * Só o anel de quem fala. VOICE_SPEAKING chega a cada ~200 ms enquanto alguém
 * fala; recriar a lista inteira nesse ritmo derrubava o foco do teclado e
 * fazia o hover piscar — aqui só se alterna uma classe nos nós já montados.
 */
export function updateSpeaking(ctx: SidebarContext): void {
  el.channels.querySelectorAll<HTMLElement>("[data-voice-user]").forEach((row) => {
    const userId = row.dataset.voiceUser;
    const channelId = row.dataset.voiceChannel;
    if (userId === undefined || channelId === undefined) return;
    row.classList.toggle("speaking", ctx.state.speaking.get(channelId)?.has(userId) === true);
  });
}

// ---------------------------------------------------------------------------
// Painel do usuário
// ---------------------------------------------------------------------------

/**
 * Botão de ícone que reflete um estado ligado/desligado.
 *
 * O nome acessível é INVARIANTE (o objeto: "Microfone") e o estado vai só no
 * aria-pressed. Com o verbo no aria-label os dois se contradiziam — mutado
 * saía como "Desmutar microfone, pressionado", que descreve a ação e o estado
 * em sentidos opostos (revisão M7 #6). O verbo fica no title, para o mouse.
 */
function paintToggle(
  btn: HTMLButtonElement,
  name: IconName,
  aria: string,
  hint: string,
  on: boolean,
  danger = false,
): void {
  btn.replaceChildren(icon(name));
  btn.title = hint;
  btn.setAttribute("aria-label", aria);
  btn.setAttribute("aria-pressed", String(on));
  btn.classList.toggle("danger", danger && on);
}

export function renderUserPanel(ctx: SidebarContext): void {
  const me = ctx.state.me;
  el.meName.textContent = me?.username ?? "";
  const avatar = me?.avatar_url ?? null;
  if (avatar !== null) {
    el.meAvatar.src = avatar;
    el.meAvatar.hidden = false;
  } else {
    el.meAvatar.removeAttribute("src");
    el.meAvatar.hidden = true;
  }
  avatarFallback.textContent = me === null ? "?" : (me.username.trim().charAt(0).toUpperCase() || "?");
  avatarFallback.hidden = avatar !== null;
  // a cor do fallback é derivada do id (ui/avatar.ts): a mesma pessoa tem a
  // mesma cor no painel, na lista de voz, nos membros e no nome da mensagem
  avatarSlot.style.setProperty("--av", me === null ? "var(--brand)" : avatarColor(me.id));

  // "online" aqui é o meu próprio id no set de presença: antes do READY o
  // painel mostra o snapshot do storage, e dizer "online" ali seria mentira
  const online = me !== null && ctx.state.online.has(me.id);
  statusDot.className = online ? "av-dot av-online" : "av-dot av-offline";
  el.meSub.textContent = me === null ? "" : online ? "online" : "conectando…";

  // Mute/deafen FORA da voz são seguros e têm efeito: o VoiceClient guarda os
  // flags, o applyMute só toca no track se ele existir, o pushState desiste
  // sem canal — e o join avisa o servidor se entramos "sujos". Por isso os
  // botões não ficam disabled; o título é que avisa quando o efeito é diferido.
  const inVoice = ctx.state.voiceChannelId !== null;
  const muteLabel = ctx.state.selfMute ? "Desmutar microfone" : "Mutar microfone";
  const deafLabel = ctx.state.selfDeaf ? "Voltar a ouvir" : "Ensurdecer";
  const later = inVoice ? "" : " (vale ao entrar na voz)";
  const mute = ctx.state.selfMute;
  const deaf = ctx.state.selfDeaf;
  paintToggle(el.userMute, mute ? "mic-off" : "mic", "Microfone", muteLabel + later, mute, true);
  paintToggle(el.userDeafen, deaf ? "headphones-off" : "headphones", "Fones de ouvido", deafLabel + later, deaf, true);
}

// ---------------------------------------------------------------------------
// Rodapé de voz
// ---------------------------------------------------------------------------

export function renderVoiceFooter(ctx: SidebarContext): void {
  const cid = ctx.state.voiceChannelId;
  if (cid === null) {
    el.voiceFooter.hidden = true;
    return;
  }
  el.voiceFooter.hidden = false;
  el.voiceFooter.classList.toggle("connecting", !ctx.voice.connected);
  el.voiceFooterStatus.textContent = ctx.voice.connected ? "Voz conectada" : "Conectando voz…";
  // sem o "#" do M3: o canal é de VOZ, e o cerquilha é do canal de texto
  el.voiceFooterChannel.textContent = ctx.state.channels.find((c) => c.id === cid)?.name ?? "?";

  const cam = ctx.voice.cameraOn;
  const stream = ctx.voice.streamOn;
  const mute = ctx.state.selfMute;
  const deaf = ctx.state.selfDeaf;
  paintToggle(el.voiceCamera, cam ? "video" : "video-off", "Câmera", cam ? "Desligar câmera" : "Ligar câmera", cam);
  // transmitindo usa o mesmo vermelho do AO VIVO — não é "perigo", é "no ar"
  paintToggle(el.voiceStream, "screen", "Transmitir tela", stream ? "Parar transmissão" : "Transmitir tela", stream, true);
  paintToggle(el.voiceMute, mute ? "mic-off" : "mic", "Microfone", mute ? "Desmutar" : "Mutar", mute, true);
  paintToggle(el.voiceDeafen, deaf ? "headphones-off" : "headphones", "Fones de ouvido", deaf ? "Voltar a ouvir" : "Ensurdecer", deaf, true);
}
