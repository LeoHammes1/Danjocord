/**
 * Card do membro (M9, item 48 do ROADMAP): o popover que abre ao clicar num
 * participante da lista de voz OU numa linha da coluna de membros.
 *
 * Por que ele existe: o M9 trouxe seis controles que não têm casa nenhuma na
 * tela — volume por pessoa, mute local, mute do soundboard, server mute e
 * desconectar. Espalhá-los pelo rodapé de voz seria errado: todos eles são
 * sobre UMA pessoa, e um controle sobre alguém pertence ao lugar onde esse
 * alguém aparece. O card é esse lugar. Perfil, kick e ban (M10) entram aqui
 * depois, na mesma caixa.
 *
 * TRÊS LINHAS QUE DIVIDEM O CARD, e vale ter na cabeça ao ler o resto:
 *
 * 1. "só para mim" — volume, mute local e mute do soundboard. Nada disso vai
 *    para o servidor, ninguém fica sabendo, e por isso cada um traz escrito na
 *    tela que é local. Confundir isto com o server mute é o erro caro aqui.
 * 2. "para todos" — server mute e desconectar, só para admin. São destrutivos
 *    (o alvo não escolheu nada disso), então: rótulo explícito, `--danger`
 *    RESERVADO a eles e confirmação no desconectar.
 * 3. O selo de "silenciado por um administrador" aparece para TODO MUNDO, não
 *    só para quem pode mexer: quem não entende por que fulano sumiu do áudio
 *    é justamente quem não é admin.
 *
 * ESTADO — o que mora onde (a regra do M7 vale em dobro aqui):
 * - o volume e o mute local VIVOS são do VoiceClient (ver voice.ts): ele já
 *   guarda os dois fora da sessão de mídia, aplica nos consumers que chegarem
 *   depois e NÃO os zera no leave. Este módulo lê de lá para desenhar.
 * - o localStorage daqui é só MEMÓRIA ENTRE SESSÕES. Ninguém reaplica essas
 *   preferências sozinho no join — o VoiceClient nasce vazio a cada F5 —,
 *   então `mountUserControls` empurra o que estava salvo de volta para ele no
 *   boot. É o único momento em que este módulo escreve sem o usuário pedir.
 * - estado próprio, só o do popover: quem está aberto, para quem, e o eco do
 *   server mute enquanto não há VoiceState para conferir.
 *
 * O módulo não conhece o main.ts nem o VoiceClient: tudo entra pelo
 * UserControlsContext, que estende o UiContext com as ações do M9 (mesma
 * saída do SidebarContext em ui/sidebar.ts — a alternativa seria inchar o
 * UiActions de todo mundo com seis métodos que só este arquivo usa).
 */
import { avatarEl } from "./avatar.js";
import type { UiContext, User } from "./context.js";
import { icon } from "./icons.js";

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

/**
 * O que o card dispara. Os quatro primeiros são delegação direta para o
 * VoiceClient; os dois últimos são op 20 (VoiceRequest) e podem FALHAR — daí
 * devolverem Promise: o card mostra o erro na própria caixa, e não no console.
 */
export interface UserControlsActions {
  /** 1 = 100%; a escala do VoiceClient é 0..2, e é a mesma que se persiste */
  getUserVolume(userId: string): number;
  setUserVolume(userId: string, volume: number): void;
  isUserMuted(userId: string): boolean;
  setUserMuted(userId: string, muted: boolean): void;
  /**
   * Soundboard (M9) por pessoa — OPCIONAIS de propósito: o pacote do soundboard
   * é vizinho deste e pode chegar depois. Sem o par, a linha simplesmente não
   * é desenhada: uma chave que não desliga nada é pior que chave nenhuma.
   * Vêm aos pares — implementar só um dos dois deixa a linha inerte.
   */
  isSoundboardMuted?: (userId: string) => boolean;
  setSoundboardMuted?: (userId: string, muted: boolean) => void;
  /** op 20 `server_mute` (só admin) — o servidor pausa o producer do alvo */
  serverMute(userId: string, muted: boolean): Promise<void>;
  /** op 20 `disconnect_user` (só admin) — tira o alvo do canal de voz */
  disconnectUser(userId: string): Promise<void>;
}

export interface UserControlsContext extends UiContext {
  controls: UserControlsActions;
}

// ---------------------------------------------------------------------------
// Preferências por usuário (localStorage)
//
// Mesmo molde do sound/prefs.ts: leitura TOLERANTE (qualquer coisa fora do
// formato vira o default) e escrita que nunca derruba nada. Um JSON estragado
// aqui não pode deixar o cliente sem áudio — no máximo sem a lembrança do
// volume de alguém.
// ---------------------------------------------------------------------------

const PREFS_KEY = "danjocord_user_prefs";

/**
 * O que ESTE módulo guarda. O mute do soundboard NÃO entra aqui de propósito:
 * quem o guarda é o pacote do soundboard, nas próprias prefs — o card só liga
 * e desliga pelos ganchos. Duas cópias do mesmo fato é o começo de um bug em
 * que a tela mostra uma coisa e o áudio faz outra.
 */
interface UserPref {
  /** 0..2, a MESMA unidade do VoiceClient — converter só na hora de desenhar */
  volume: number;
  /** mute local: eu paro de ouvir esta pessoa */
  mute: boolean;
}

function emptyPref(): UserPref {
  return { volume: 1, mute: false };
}

function isDefault(pref: UserPref): boolean {
  return pref.volume === 1 && !pref.mute;
}

function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(2, Math.max(0, v));
}

function loadPrefs(): Map<string, UserPref> {
  const out = new Map<string, UserPref>();
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw === null) return out;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return out;
    for (const [userId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const obj = value as Record<string, unknown>;
      const pref = emptyPref();
      if (typeof obj["volume"] === "number") pref.volume = clampVolume(obj["volume"]);
      if (typeof obj["mute"] === "boolean") pref.mute = obj["mute"];
      // entrada que só tem default é lixo de versão anterior: não volta a ser gravada
      if (!isDefault(pref)) out.set(userId, pref);
    }
  } catch {
    // JSON corrompido / storage bloqueado: começa sem preferência nenhuma
  }
  return out;
}

const prefs = loadPrefs();

function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(Object.fromEntries(prefs)));
  } catch {
    // storage cheio ou bloqueado: a preferência vale nesta sessão e pronto
  }
}

/** Lê a preferência guardada de alguém (cópia — a edição passa por `writePref`). */
function prefOf(userId: string): UserPref {
  return { ...(prefs.get(userId) ?? emptyPref()) };
}

/** Grava e persiste. Preferência igual ao default SAI do mapa: o storage de
 *  um servidor de dez amigos não precisa colecionar `{volume:1}` de ninguém. */
function writePref(userId: string, patch: Partial<UserPref>): void {
  const next = { ...prefOf(userId), ...patch };
  if (isDefault(next)) prefs.delete(userId);
  else prefs.set(userId, next);
  savePrefs();
}

// ---------------------------------------------------------------------------
// Estado do módulo
// ---------------------------------------------------------------------------

const TITLE_ID = "uc-title";
/** folga entre o card e a linha que o abriu, e entre o card e a borda da tela */
const GAP = 8;

/**
 * SÓ o que o `sync()` repinta — nada mais. Os controles locais (volume, mute,
 * soundboard) não entram aqui de propósito: eles se bastam com os listeners
 * montados no `build`, e guardar referência para eles seria convidar alguém a
 * repintá-los por fora, atropelando um arrasto em andamento.
 */
interface Parts {
  sub: HTMLElement;
  serverFlag: HTMLElement;
  adminMute: HTMLInputElement | null;
  adminDisconnect: HTMLButtonElement | null;
  /** fecha a confirmação do desconectar, se houver uma no ar (ver `sync`) */
  cancelConfirm: (() => void) | null;
  error: HTMLElement;
}

interface Open {
  userId: string;
  pop: HTMLElement;
  /** a linha que abriu o card; some (e é reencontrada) a cada re-render da lista */
  anchor: HTMLElement | null;
  /** de qual lista veio — para reencontrar a linha na MESMA coluna, e não na outra */
  from: "voice" | "member";
  parts: Parts;
  observer: MutationObserver;
  /**
   * Server mute que o servidor JÁ confirmou por op 21, enquanto o
   * VOICE_STATE_UPDATE não chega — e para sempre, no caso de quem está fora da
   * voz (silenciar alguém fora do canal é legítimo: o servidor guarda por
   * USUÁRIO, não por sessão de voz, e aí não há VoiceState nenhum). Some
   * assim que o estado alcança o valor: dali em diante o servidor é a única
   * fonte. Ver `sync`.
   */
  serverMuteEcho: boolean | null;
}

let ctx: UserControlsContext | null = null;
let open: Open | null = null;
let mounted = false;

// ---------------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------------

/**
 * Liga os listeners globais (Esc, clique fora, reposicionamento) e devolve ao
 * VoiceClient as preferências salvas na sessão anterior. Chamar UMA vez, no
 * boot, depois de o contexto existir.
 *
 * A reaplicação é aqui e não no join porque os setters do VoiceClient valem
 * FORA da voz: o valor fica guardado e é aplicado no consumer que chegar — não
 * há corrida com o join, e não é preciso lembrar de repetir isto a cada
 * entrada em canal.
 */
export function mountUserControls(context: UserControlsContext): void {
  ctx = context;
  if (mounted) return;
  mounted = true;

  for (const [userId, pref] of prefs) {
    if (pref.volume !== 1) context.controls.setUserVolume(userId, pref.volume);
    if (pref.mute) context.controls.setUserMuted(userId, true);
  }

  // Esc devolve o foco a quem abriu (é o único jeito de sair sem mouse sem
  // perder o lugar na lista); clique fora só fecha, como o menu da engrenagem.
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || open === null) return;
    ev.preventDefault();
    closeUserControls();
  });
  // pointerdown e não click: fecha antes de o clique chegar ao alvo. A linha
  // do PRÓPRIO usuário é exceção — senão o card fecharia aqui e reabriria no
  // click do âncora, e o segundo clique nunca conseguiria fechá-lo.
  document.addEventListener("pointerdown", (ev) => {
    const o = open;
    if (o === null) return;
    const target = ev.target;
    if (!(target instanceof Node)) return;
    if (o.pop.contains(target)) return;
    if (target instanceof Element && anchorUserId(target) === o.userId) return;
    closeUserControls(false);
  });
  // o card é `position: fixed` ancorado numa linha que rola junto com a
  // sidebar: sem seguir o scroll ele "descola" da pessoa. Captura porque quem
  // rola é uma coluna interna, e scroll de elemento não borbulha.
  window.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);
}

/** id do usuário da linha (de qualquer uma das duas listas) que contém `node` */
function anchorUserId(node: Element): string | null {
  const row = node.closest<HTMLElement>("[data-user-id], [data-voice-user]");
  if (row === null) return null;
  return row.dataset["userId"] ?? row.dataset["voiceUser"] ?? null;
}

/**
 * Reencontra a linha da pessoa. As duas listas se redesenham inteiras
 * (replaceChildren) a cada evento de presença/voz, então o nó guardado no
 * `open.anchor` morre o tempo todo — sem isto o card ficaria pendurado onde a
 * linha ESTAVA. `prefer` mantém o card na coluna de onde ele foi aberto.
 */
function findAnchor(userId: string, prefer: "voice" | "member"): HTMLElement | null {
  const id = CSS.escape(userId);
  const voice = document.querySelector<HTMLElement>(`[data-voice-user="${id}"]`);
  const member = document.querySelector<HTMLElement>(`[data-user-id="${id}"]`);
  return prefer === "voice" ? (voice ?? member) : (member ?? voice);
}

// ---------------------------------------------------------------------------
// Abrir e fechar
// ---------------------------------------------------------------------------

/**
 * Abre o card de `userId`. `anchor` é a linha clicada — é dela que sai a
 * posição do popover e para ela que o foco volta no Esc. Clicar de novo na
 * mesma pessoa fecha (o card é um toggle, como o menu da engrenagem).
 *
 * Sem `anchor` o card se ancora na linha que encontrar sozinho, e no centro da
 * tela se não houver nenhuma — abrir "solto" é melhor que não abrir.
 */
export function openUserControls(userId: string, anchor?: HTMLElement | null): void {
  const c = ctx;
  if (c === null) return; // mountUserControls ainda não rodou
  if (open !== null && open.userId === userId) {
    closeUserControls();
    return;
  }
  closeUserControls(false);

  const from: "voice" | "member" = anchor?.dataset["voiceUser"] !== undefined ? "voice" : "member";
  const built = build(c, userId);
  const o: Open = {
    userId,
    pop: built.pop,
    anchor: anchor ?? findAnchor(userId, from),
    from,
    parts: built.parts,
    // o card é a coisa mais próxima da lista: quando a lista se redesenha, ele
    // se reancora ou se fecha. Observar só os dois contêineres das linhas
    // (e não o app inteiro) mantém isto barato — mensagem chegando não mexe aqui.
    observer: new MutationObserver(onListMutation),
    serverMuteEcho: null,
  };
  open = o;

  document.body.append(o.pop);
  sync();
  place();
  for (const id of ["channels", "members"]) {
    const host = document.getElementById(id);
    if (host !== null) o.observer.observe(host, { childList: true, subtree: true });
  }
  // foco no painel (e não no primeiro controle): o leitor de tela anuncia de
  // quem é o card antes de qualquer chave — mesma escolha do diálogo de som
  o.pop.focus();
}

/**
 * Fecha. `returnFocus` só é falso quando quem fechou foi um clique fora ou a
 * abertura de outro card: nesses casos o usuário já está com a atenção em
 * outro lugar, e roubar o foco de volta é que seria o incômodo.
 */
export function closeUserControls(returnFocus = true): void {
  const o = open;
  if (o === null) return;
  open = null;
  o.observer.disconnect();
  o.pop.remove();
  if (!returnFocus) return;
  // a linha guardada pode ter sido destruída por um re-render enquanto o card
  // estava aberto: refoca a linha ATUAL da mesma pessoa, se ainda houver
  const back = o.anchor?.isConnected === true ? o.anchor : findAnchor(o.userId, o.from);
  back?.focus();
}

/**
 * Repinta o que depende do estado (server mute, canal, presença) e reancora.
 * O módulo já faz isto sozinho quando as listas se redesenham; existe
 * exportado para quem quiser forçar depois de um dispatch que não mexeu no DOM.
 */
export function refreshUserControls(): void {
  if (open === null) return;
  sync();
  place();
}

function onListMutation(): void {
  const o = open;
  if (o === null) return;
  if (o.anchor === null || !o.anchor.isConnected) {
    const again = findAnchor(o.userId, o.from);
    // a pessoa saiu da lista (saiu da voz, por exemplo) e não há onde ancorar:
    // um card pendurado no vazio, sobre a linha de outra pessoa, é pior que
    // nenhum card — fecha sem mexer no foco de quem já está fazendo outra coisa
    if (again === null) {
      closeUserControls(false);
      return;
    }
    o.anchor = again;
  }
  sync();
  place();
}

// ---------------------------------------------------------------------------
// Posição
// ---------------------------------------------------------------------------

/**
 * Encosta o card na linha: à direita dela por padrão, à esquerda quando não
 * couber (é o que atende as duas colunas — a sidebar abre para dentro da tela,
 * a lista de membros abre para o outro lado). Sempre dentro da janela.
 */
function place(): void {
  const o = open;
  if (o === null) return;
  const pop = o.pop;
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rect = o.anchor?.isConnected === true ? o.anchor.getBoundingClientRect() : null;

  let left: number;
  let top: number;
  if (rect === null) {
    left = (vw - w) / 2;
    top = (vh - h) / 2;
  } else {
    left = rect.right + GAP;
    if (left + w > vw - GAP) left = rect.left - GAP - w;
    // alinhado pelo topo da linha; o clamp abaixo cuida de quem está no rodapé
    top = rect.top;
  }
  pop.style.left = `${Math.round(Math.max(GAP, Math.min(left, vw - w - GAP)))}px`;
  pop.style.top = `${Math.round(Math.max(GAP, Math.min(top, vh - h - GAP)))}px`;
}

// ---------------------------------------------------------------------------
// Construção
// ---------------------------------------------------------------------------

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

/**
 * Chave liga/desliga. Continua sendo um `<input type=checkbox>` de verdade —
 * o desenho é do CSS; teclado, foco e leitor de tela são do navegador.
 *
 * A classe é a `.settings-switch` do M8, e não uma cópia local: a chave é a
 * primitiva mais repetida do app agora (som, voz e este card), e duas chaves
 * com formas diferentes para o mesmo papel é o que o M7 veio acabar. O lugar
 * definitivo dela é o base.css, junto do `.icon-btn`.
 */
function switchRow(id: string, label: string, desc: string): { row: HTMLElement; input: HTMLInputElement } {
  const row = make("div", "uc-row uc-switch-row");
  const input = make("input", "settings-switch");
  input.type = "checkbox";
  input.id = id;
  const text = make("label", "uc-label", label);
  text.htmlFor = id;
  row.append(input, text, make("p", "uc-desc", desc));
  return { row, input };
}

/** Nome de quem ainda não veio no READY — o mesmo fallback da lista de voz. */
function userOf(c: UserControlsContext, userId: string): User {
  return c.state.members.get(userId) ?? { id: userId, username: `user-${userId.slice(-4)}`, avatar_url: null };
}

function build(c: UserControlsContext, userId: string): { pop: HTMLElement; parts: Parts } {
  const user = userOf(c, userId);
  const isMe = userId === c.state.me?.id;
  const iAmAdmin = c.state.me?.is_admin === true;

  const pop = make("div", "uc-pop");
  // dialog não-modal: o resto do app continua clicável (o card é um popover,
  // não um modal — nada de `inert` no #app como no diálogo de som)
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-labelledby", TITLE_ID);
  pop.tabIndex = -1;

  // --- cabeçalho
  const head = make("header", "uc-head");
  head.append(avatarEl(user, 40, c.state.online.has(userId) ? "online" : "offline"));
  const idBox = make("div", "uc-idbox");
  const name = make("h2", "uc-name", user.username);
  name.id = TITLE_ID;
  idBox.append(name);
  // o selo entra ENTRE o nome e o status: o .uc-sub ocupa a linha inteira, e
  // depois dele o "admin" cairia sozinho numa terceira linha
  if (user.is_admin === true) idBox.append(make("span", "uc-badge", "admin"));
  const sub = make("p", "uc-sub");
  idBox.append(sub);
  head.append(idBox);
  const close = make("button", "icon-btn uc-close");
  close.type = "button";
  close.setAttribute("aria-label", "Fechar");
  close.title = "Fechar";
  close.append(icon("close", 16));
  close.addEventListener("click", () => closeUserControls());
  head.append(close);
  pop.append(head);

  // Selo de silenciado por admin: fora da seção de moderação de propósito —
  // ele é informação para TODOS (ver o cabeçalho do arquivo), não um controle.
  const serverFlag = make("p", "uc-server-flag");
  serverFlag.append(icon("mic-off", 14));
  serverFlag.append(document.createTextNode("Silenciado pelo administrador — ninguém ouve"));
  serverFlag.hidden = true;
  pop.append(serverFlag);

  const body = make("div", "uc-body");

  // --- volume (item 36)
  const volumeRow = make("div", "uc-row uc-volume");
  const volume = make("input");
  volume.type = "range";
  volume.id = "uc-volume";
  volume.min = "0";
  volume.max = "200";
  volume.step = "1";
  volume.value = String(Math.round(c.controls.getUserVolume(userId) * 100));
  const volumeLabel = make("label", "uc-label", "Volume");
  volumeLabel.htmlFor = volume.id;
  const volumeValue = make("span", "uc-value");
  // o próprio range já anuncia a porcentagem; este número é para os olhos
  volumeValue.setAttribute("aria-hidden", "true");
  // O duplo-clique é o gesto de sempre para "voltar ao padrão", mas é só do
  // mouse: o botão faz o mesmo para quem está no teclado, e some quando não
  // há o que redefinir (um "voltar a 100%" em 100% é ruído).
  const volumeReset = make("button", "uc-reset", "voltar a 100%");
  volumeReset.type = "button";
  volumeReset.setAttribute("aria-label", `Voltar o volume de ${user.username} para 100%`);
  const boost = make("p", "uc-warn", "Acima de 100% não vale para o áudio de uma transmissão de tela: o navegador limita o volume do vídeo.");
  boost.hidden = true;
  volumeRow.append(volumeLabel, volumeValue, volumeReset, volume);
  volumeRow.append(make("p", "uc-desc", "Só para você. Duplo-clique no controle volta a 100%."), boost);

  const paintVolume = (): void => {
    const percent = Number(volume.value);
    volumeValue.textContent = `${percent}%`;
    volumeReset.hidden = percent === 100;
    boost.hidden = percent <= 100;
  };
  const applyVolume = (percent: number, persist: boolean): void => {
    const v = Math.min(2, Math.max(0, percent / 100));
    c.controls.setUserVolume(userId, v);
    volume.value = String(Math.round(v * 100));
    paintVolume();
    if (persist) writePref(userId, { volume: v });
  };
  // aplicar no `input` (a cada pixel do arrasto) e PERSISTIR no `change` (ao
  // soltar): o áudio tem que acompanhar a mão, mas gravar no localStorage
  // dezenas de vezes por segundo é desperdício puro
  volume.addEventListener("input", () => applyVolume(Number(volume.value), false));
  volume.addEventListener("change", () => applyVolume(Number(volume.value), true));
  volume.addEventListener("dblclick", () => applyVolume(100, true));
  volumeReset.addEventListener("click", () => {
    // foco ANTES: o próprio clique some com este botão (100% não tem o que
    // redefinir), e esconder o elemento focado jogaria o foco no <body>
    volume.focus();
    applyVolume(100, true);
  });
  paintVolume();
  body.append(volumeRow);

  // --- mute local (item 33)
  const mute = switchRow(
    "uc-mute",
    "Parar de ouvir",
    "Só para você: a pessoa continua falando para todo mundo e não fica sabendo de nada.",
  );
  mute.input.checked = c.controls.isUserMuted(userId);
  mute.input.addEventListener("change", () => {
    c.controls.setUserMuted(userId, mute.input.checked);
    writePref(userId, { mute: mute.input.checked });
  });
  body.append(mute.row);

  // --- soundboard por pessoa — só quando o pacote do soundboard expõe o par
  // de ganchos (ver UserControlsActions). Quem PERSISTE é ele, não este
  // módulo: aqui só se liga e desliga.
  const readSoundboard = c.controls.isSoundboardMuted;
  const writeSoundboard = c.controls.setSoundboardMuted;
  if (readSoundboard !== undefined && writeSoundboard !== undefined) {
    const sb = switchRow(
      "uc-soundboard",
      "Silenciar o soundboard desta pessoa",
      "Os pads que ela tocar não tocam para você. Também é só para você.",
    );
    sb.input.checked = readSoundboard(userId);
    sb.input.addEventListener("change", () => writeSoundboard(userId, sb.input.checked));
    body.append(sb.row);
  }

  const parts: Parts = {
    sub,
    serverFlag,
    adminMute: null,
    adminDisconnect: null,
    cancelConfirm: null,
    error: make("p", "uc-error"),
  };
  parts.error.setAttribute("role", "status");
  parts.error.hidden = true;

  // --- moderação (itens 34 e 37): só admin, e não sobre mim mesmo — para as
  // minhas próprias mídias existem o mic e o "desconectar" do rodapé de voz
  if (iAmAdmin && !isMe) body.append(adminSection(c, userId, user.username, parts));

  body.append(parts.error);
  pop.append(body);

  // Sair por Tab é o terceiro jeito de deixar o card (Esc e clique fora já
  // estão): sem isto ele ficaria aberto com o foco longe dele. Não devolve o
  // foco — quem saiu por Tab quer seguir adiante (mesma decisão do menu da
  // engrenagem em ui/sidebar.ts).
  //
  // `relatedTarget` nulo NÃO fecha: é o que acontece quando o foco não foi
  // para lugar nenhum — desabilitar (a chave em voo) ou esconder (o "voltar a
  // 100%") o elemento focado joga o foco no <body> e o card se fecharia
  // sozinho no meio da própria ação. Clique fora sem destino focável já é
  // tratado pelo pointerdown do mount.
  pop.addEventListener("focusout", (ev) => {
    const to = ev.relatedTarget;
    if (!(to instanceof Node) || pop.contains(to)) return;
    closeUserControls(false);
  });

  return { pop, parts };
}

function adminSection(c: UserControlsContext, userId: string, username: string, parts: Parts): HTMLElement {
  const section = make("section", "uc-admin");
  section.append(make("h3", "uc-admin-head", "Moderação"));

  // --- silenciar para todos (item 34)
  const serverMute = switchRow(
    "uc-server-mute",
    "Silenciar para todos",
    "O servidor pausa o microfone dela: ninguém ouve, e desmutar do lado dela não resolve.",
  );
  serverMute.row.classList.add("uc-destructive");
  serverMute.input.addEventListener("change", () => {
    const muted = serverMute.input.checked;
    serverMute.input.disabled = true;
    void c.controls
      .serverMute(userId, muted)
      .then(() => {
        // o servidor confirmou; o VOICE_STATE_UPDATE vem logo atrás (e para
        // quem está fora da voz, não vem nunca) — o eco cobre esse intervalo,
        // ver o comentário do `sync`. O guard existe porque o card pode ter
        // fechado, ou já ser de outra pessoa, no meio do round-trip.
        if (open !== null && open.userId === userId) open.serverMuteEcho = muted;
        showError(parts, null);
      })
      .catch((err: unknown) => showError(parts, message(err, "não foi possível silenciar")))
      .finally(() => {
        serverMute.input.disabled = false;
        sync(); // repinta a partir do estado real, desfazendo o clique que falhou
      });
  });
  parts.adminMute = serverMute.input;
  section.append(serverMute.row);

  // --- desconectar da voz (item 37)
  const kickRow = make("div", "uc-row uc-destructive");
  const kick = make("button", "uc-danger-btn", "Desconectar da voz");
  kick.type = "button";
  kick.prepend(icon("logout", 16));
  const kickDesc = make("p", "uc-desc", "Tira a pessoa do canal agora. Ela pode entrar de novo — barrar de vez é banir.");
  kickRow.append(kick, kickDesc);

  // Confirmação INLINE e não `window.confirm`: o diálogo do navegador rouba a
  // janela inteira, não é estilizável e no app empacotado parece erro. Aqui a
  // pergunta fica no mesmo lugar do botão, e o "Desconectar" só existe depois
  // de a pessoa pedir por ele. Ela mora DENTRO da mesma linha: trocada por
  // fora, a linha ficaria como uma caixa vazia com o botão sumido.
  const confirm = make("div", "uc-confirm");
  confirm.hidden = true;
  confirm.append(make("p", "uc-confirm-text", `Desconectar ${username} da voz?`));
  const cancel = make("button", "uc-cancel", "Cancelar");
  cancel.type = "button";
  const yes = make("button", "uc-danger-btn", "Desconectar");
  yes.type = "button";
  confirm.append(cancel, yes);
  kickRow.append(confirm);

  const setConfirm = (on: boolean): void => {
    // já está assim: sai antes de mexer no foco. O `sync` chama isto a cada
    // repintura, e mover o foco por causa de um evento de outra pessoa seria
    // arrancar o cursor da mão de quem está usando o card.
    if (confirm.hidden === !on) return;
    confirm.hidden = !on;
    kick.hidden = on;
    kickDesc.hidden = on;
    (on ? yes : kick).focus();
  };
  kick.addEventListener("click", () => setConfirm(true));
  cancel.addEventListener("click", () => setConfirm(false));
  yes.addEventListener("click", () => {
    yes.disabled = true;
    cancel.disabled = true;
    void c.controls
      .disconnectUser(userId)
      .then(() => {
        showError(parts, null);
        // some da lista de voz → o observer fecha o card sozinho quando ele
        // estava ancorado ali; aberto pela coluna de membros, ele fica e o
        // botão vira "não está na voz"
        setConfirm(false);
      })
      .catch((err: unknown) => {
        showError(parts, message(err, "não foi possível desconectar"));
        setConfirm(false);
      })
      .finally(() => {
        yes.disabled = false;
        cancel.disabled = false;
        sync();
      });
  });

  parts.adminDisconnect = kick;
  parts.cancelConfirm = () => setConfirm(false);
  section.append(kickRow);
  return section;
}

/** Mensagem de erro do op 21 (`{ok:false, error}`) vira Error no gateway. */
function message(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message !== "") return err.message;
  return fallback;
}

function showError(parts: Parts, text: string | null): void {
  parts.error.textContent = text ?? "";
  parts.error.hidden = text === null;
}

// ---------------------------------------------------------------------------
// Pintura do que depende do estado
// ---------------------------------------------------------------------------

/**
 * Repinta SÓ o que vem de fora (presença, canal, server mute). O volume e as
 * chaves locais ficam de fora de propósito: eles não têm outra fonte além do
 * próprio card, e reescrevê-los aqui atropelaria um arrasto em andamento.
 */
function sync(): void {
  const o = open;
  const c = ctx;
  if (o === null || c === null) return;

  const vs = c.state.voiceStates.get(o.userId) ?? null;
  const inVoice = vs !== null && vs.channel_id !== null;
  // O eco do request VENCE o VoiceState até o VOICE_STATE_UPDATE alcançá-lo:
  // entre o `ok` do op 21 e o dispatch há uma ida e volta de rede, e sem isto
  // a chave voltaria sozinha para o valor antigo por uma fração de segundo —
  // o que se lê como "não funcionou". Alcançado o eco, ele se aposenta e o
  // estado do servidor volta a ser a única fonte (inclusive para desfazer um
  // server mute que outro admin tirou).
  const fromState = vs !== null ? vs.server_mute : null;
  const serverMuted = o.serverMuteEcho ?? fromState ?? false;
  if (fromState !== null && fromState === o.serverMuteEcho) o.serverMuteEcho = null;

  if (inVoice && vs !== null) {
    const channel = c.state.channels.find((ch) => ch.id === vs.channel_id);
    o.parts.sub.textContent = `na voz — ${channel?.name ?? "?"}`;
  } else {
    o.parts.sub.textContent = c.state.online.has(o.userId) ? "online" : "offline";
  }

  o.parts.serverFlag.hidden = !serverMuted;

  if (o.parts.adminMute !== null && !o.parts.adminMute.disabled) o.parts.adminMute.checked = serverMuted;
  if (o.parts.adminDisconnect !== null) {
    o.parts.adminDisconnect.disabled = !inVoice;
    o.parts.adminDisconnect.title = inVoice ? "" : "a pessoa não está em nenhum canal de voz";
    // a confirmação não pode sobreviver ao alvo sair da voz por conta própria:
    // o "Desconectar" ficaria perguntando por uma ação que já não existe
    if (!inVoice) o.parts.cancelConfirm?.();
  }
}
