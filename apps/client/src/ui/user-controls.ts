/**
 * Card do membro (item 48 do ROADMAP): o popover que abre ao clicar num
 * participante da lista de voz OU numa linha da coluna de membros.
 *
 * Por que ele existe: o M9 trouxe seis controles que não têm casa nenhuma na
 * tela — volume por pessoa, mute local, mute do soundboard, server mute e
 * desconectar. Espalhá-los pelo rodapé de voz seria errado: todos eles são
 * sobre UMA pessoa, e um controle sobre alguém pertence ao lugar onde esse
 * alguém aparece. O card é esse lugar. O M10 traz a outra metade — perfil,
 * bloquear, timeout de chat, cargo, kick e ban — na MESMA caixa, pela mesma
 * razão.
 *
 * QUATRO FAIXAS QUE DIVIDEM O CARD, e vale ter na cabeça ao ler o resto:
 *
 * 0. PERFIL (M10) — avatar, nome exibido, @username do Discord, cargo e
 *    "membro desde". É o cabeçalho: quem é essa pessoa, antes de qualquer
 *    botão que faça algo com ela.
 * 1. "só para você" — volume, mute local, mute do soundboard e BLOQUEAR. Nada
 *    disso vai para o servidor, ninguém fica sabendo, e por isso cada um traz
 *    escrito na tela que é local. Confundir isto com o server mute é o erro
 *    caro aqui.
 * 2. MODERAÇÃO reversível — cargo, timeout de chat, server mute e desconectar
 *    da voz. Impostos a outra pessoa, mas com volta: confirmação em todos.
 * 3. IRREVERSÍVEL — expulsar e banir, atrás de um divisor próprio. A regra do
 *    M10 é que ninguém clique em "banir" mirando em "volume": o que não dá para
 *    desfazer não fica na mesma pilha do que dá.
 *
 * Os selos de "silenciado por um administrador" (voz) e "silenciado no chat"
 * (timeout) aparecem para TODO MUNDO, não só para quem pode mexer: quem não
 * entende por que fulano sumiu do áudio — ou parou de escrever — é justamente
 * quem não é admin.
 *
 * PERMISSÃO É DO SERVIDOR; a UI só evita OFERECER o que será recusado
 * (`permsOf`). O espelho pode ficar defasado — por isso todo erro de rota vira
 * frase em português dentro do card (`humanError`), nunca um código solto.
 *
 * ESTADO — o que mora onde (a regra do M7 vale em dobro aqui):
 * - o volume e o mute local VIVOS são do VoiceClient (ver voice.ts): ele já
 *   guarda os dois fora da sessão de mídia, aplica nos consumers que chegarem
 *   depois e NÃO os zera no leave. Este módulo lê de lá para desenhar.
 * - o localStorage daqui é só MEMÓRIA ENTRE SESSÕES. Ninguém reaplica essas
 *   preferências sozinho no join — o VoiceClient nasce vazio a cada F5 —,
 *   então `mountUserControls` empurra o que estava salvo de volta para ele no
 *   boot. É o único momento em que este módulo escreve sem o usuário pedir.
 * - a lista de BLOQUEADOS (item 54) também é local e persistida aqui, mas é
 *   lida de fora (`isBlocked`/`subscribeBlocked`): o filtro das mensagens mora
 *   no main.ts, e este módulo é a fonte da verdade que ele consulta.
 * - estado próprio, só o do popover: quem está aberto, para quem, o eco do
 *   server mute enquanto não há VoiceState para conferir, e o relógio do
 *   timeout.
 *
 * O módulo não conhece o main.ts nem o VoiceClient: tudo entra pelo
 * UserControlsContext, que estende o UiContext com as ações do M9/M10 (mesma
 * saída do SidebarContext em ui/sidebar.ts — a alternativa seria inchar o
 * UiActions de todo mundo com métodos que só este arquivo usa).
 */
import { displayName, isStaff, roleRank } from "@danjocord/protocol";
import type { PresenceStatus } from "@danjocord/protocol";
import { API, getAccessToken, refresh } from "../auth.js";
import { avatarEl } from "./avatar.js";
import type { UiContext, User } from "./context.js";
import { icon, type IconName } from "./icons.js";
import { STATUS_LABEL, statusOf } from "./presence.js";

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

/**
 * O que o card dispara POR FORA do próprio módulo. Os quatro primeiros são
 * delegação direta para o VoiceClient; os dois de moderação de voz são op 20
 * (VoiceRequest) e podem FALHAR — daí devolverem Promise: o card mostra o erro
 * na própria caixa, e não no console.
 *
 * O M10 não acrescentou NADA a esta interface, de propósito: kick, ban,
 * timeout e cargo são REST, e o REST mora aqui embaixo (ver a seção
 * "Moderação (REST)"). O molde é o do `ui/invites.ts` e o do
 * `sound/soundboard.ts` — quem depende do gateway (voz) precisa do main.ts;
 * quem só precisa de um `fetch` com token não precisa incomodar ninguém.
 */
export interface UserControlsActions {
  /** 1 = 100%; a escala do VoiceClient é 0..2, e é a mesma que se persiste */
  getUserVolume(userId: string): number;
  setUserVolume(userId: string, volume: number): void;
  /**
   * O mute VIVO do VoiceClient. O card não o usa para desenhar a chave (quem
   * manda ali é a preferência salva, porque o valor vivo já traz o bloqueio
   * embutido — ver `applyEffectiveMute`), mas ele continua no contrato: é a
   * única leitura possível para quem precisar conferir o estado real do áudio.
   */
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
// Moderação (REST)
//
// Mesmo molde do `ui/invites.ts` e do `sound/soundboard.ts`, e pela mesma
// razão: o `api()` do main.ts é privado e carrega a política de logout do app.
// Aqui basta renovar UMA vez no 401 (o `refresh()` é single-flight) e falhar
// com uma FRASE — quem desloga de verdade é o próximo `api()` do main.
//
// Nenhuma destas funções lê o corpo da resposta, nem no PATCH de cargo, que
// devolve o membro inteiro: quem atualiza o estado é o MEMBER_UPDATE /
// MEMBER_REMOVE que o servidor manda para todo mundo. Aplicar aqui o retorno
// criaria uma segunda fonte da verdade que só a MINHA aba conhece — e que
// diverge das outras no primeiro erro de rede.
// ---------------------------------------------------------------------------

/** Cargo que o card sabe ATRIBUIR — "owner" fica fora (ver `UpdateRoleBody`). */
export type AssignableRole = "admin" | "member";

class ModerationError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "ModerationError";
  }
}

async function authFetch(path: string, init: RequestInit): Promise<Response> {
  const send = (): Promise<Response> =>
    fetch(API + path, {
      ...init,
      headers: {
        authorization: `Bearer ${getAccessToken() ?? ""}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  let res: Response;
  try {
    res = await send();
  } catch {
    // rede fora / servidor caído: não há status nenhum, e a mensagem tem que
    // dizer isso em vez de inventar um erro de permissão
    throw new ModerationError("sem conexão com o servidor");
  }
  if (res.status !== 401) return res;
  const result = await refresh();
  if (result !== "ok") throw new ModerationError("sua sessão expirou — recarregue a página", 401);
  return send();
}

/**
 * Erro do servidor vira frase em português. O `{error}` do corpo entra no 400 e
 * no 409 porque ali ele diz a única coisa que a UI não sabia ("o dono não pode
 * ser rebaixado"); no 403 e no 404 as frases são NOSSAS, porque o texto do
 * servidor é escrito para o log e não para quem só queria calar um amigo.
 */
async function errorFrom(res: Response, fallback: string): Promise<ModerationError> {
  let detail: string | null = null;
  let retryAfter: number | null = null;
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj["error"] === "string") detail = obj["error"];
      if (typeof obj["retry_after"] === "number") retryAfter = obj["retry_after"];
    }
  } catch {
    // corpo não-JSON (502 do proxy no meio de um deploy): fica o fallback
  }
  const message =
    res.status === 403
      ? (detail ?? "seu cargo não permite fazer isso com esta pessoa")
      : res.status === 404
        ? "esta pessoa não está mais na guild"
        : res.status === 429
          ? retryAfter !== null
            ? `calma aí — espere ${Math.ceil(retryAfter)} s`
            : "calma aí — espere um pouco"
          : res.status === 400 || res.status === 409
            ? (detail ?? fallback)
            : res.status >= 500
              ? "o servidor falhou ao processar — tente de novo"
              : fallback;
  return new ModerationError(message, res.status);
}

function memberPath(userId: string, suffix: string): string {
  return `/api/members/${encodeURIComponent(userId)}${suffix}`;
}

async function postReason(path: string, reason: string | null, fallback: string): Promise<void> {
  // corpo montado campo a campo: com `exactOptionalPropertyTypes`, mandar
  // `{reason: undefined}` não é o mesmo que omitir, e o schema do servidor lê
  // a OMISSÃO como "sem motivo"
  const body: Record<string, string> = {};
  if (reason !== null) body["reason"] = reason;
  const res = await authFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res, fallback);
}

/** `POST /api/members/:id/kick` — sai da allowlist; volta com um convite novo. */
export async function kickMember(userId: string, reason: string | null): Promise<void> {
  await postReason(memberPath(userId, "/kick"), reason, "não consegui expulsar");
}

/** `POST /api/members/:id/ban` — entra em `bans`; nenhum convite serve depois. */
export async function banMember(userId: string, reason: string | null): Promise<void> {
  await postReason(memberPath(userId, "/ban"), reason, "não consegui banir");
}

/** `POST /api/members/:id/timeout` — `minutes: 0` LIBERA (é o "desmutar"). */
export async function timeoutMember(userId: string, minutes: number, reason: string | null): Promise<void> {
  const body: Record<string, string | number> = { minutes };
  if (reason !== null) body["reason"] = reason;
  const res = await authFetch(memberPath(userId, "/timeout"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res, minutes === 0 ? "não consegui liberar" : "não consegui silenciar");
}

/** `PATCH /api/members/:id/role`. O MEMBER_UPDATE é que atualiza a tela. */
export async function setMemberRole(userId: string, role: AssignableRole): Promise<void> {
  const res = await authFetch(memberPath(userId, "/role"), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw await errorFrom(res, "não consegui trocar o cargo");
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
 *
 * O bloqueio também não entra: ele tem chave própria porque é lido por outro
 * módulo (o filtro de mensagens do main.ts) e precisa sobreviver a qualquer
 * mudança de formato daqui — misturar as duas coisas faria um JSON de volume
 * corrompido apagar a lista de bloqueados junto.
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
// Bloqueio (item 54) — 100% LOCAL
//
// Bloquear é a única coisa deste card que outro módulo precisa consultar: o
// render das mensagens (main.ts) esconde o que vem de quem está aqui. Por isso
// a lista é exportada por função (`isBlocked`) e por assinatura
// (`subscribeBlocked`), e não por um Set solto — quem lê não pode escrever, e
// quem escreve avisa todo mundo.
//
// A DIFERENÇA para "parar de ouvir", que a UI precisa deixar clara: mute local
// é só ÁUDIO; bloquear é áudio MAIS texto. As duas são invisíveis para o outro
// lado, e nenhuma das duas é moderação — ninguém além de mim é afetado.
// ---------------------------------------------------------------------------

const BLOCKED_KEY = "danjocord_blocked";

function loadBlocked(): Set<string> {
  const out = new Set<string>();
  try {
    const raw = localStorage.getItem(BLOCKED_KEY);
    if (raw === null) return out;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return out;
    for (const id of parsed) if (typeof id === "string" && id !== "") out.add(id);
  } catch {
    // mesma tolerância das prefs: lista ilegível = ninguém bloqueado
  }
  return out;
}

const blocked = loadBlocked();
const blockListeners = new Set<(userId: string, isNowBlocked: boolean) => void>();

/** O render de mensagens do main.ts pergunta isto para cada autor. */
export function isBlocked(userId: string): boolean {
  return blocked.has(userId);
}

/** Cópia da lista — para uma futura tela de "bloqueados" nas configurações. */
export function blockedIds(): string[] {
  return [...blocked];
}

/**
 * Avisa quando alguém entra ou sai da lista. Devolve a função de cancelar
 * (mesmo formato dos outros assinantes do cliente). O main.ts assina isto para
 * re-renderizar o canal atual: sem re-render, o bloqueio só valeria para as
 * mensagens que chegassem DEPOIS.
 */
export function subscribeBlocked(fn: (userId: string, isNowBlocked: boolean) => void): () => void {
  blockListeners.add(fn);
  return () => {
    blockListeners.delete(fn);
  };
}

/**
 * Bloqueia/desbloqueia. Exportada porque a mesma ação pode nascer de outro
 * lugar depois (menu de contexto da mensagem, tela de bloqueados) — e todos
 * precisam passar pelo MESMO caminho, senão o áudio e o texto discordam.
 */
export function setUserBlocked(userId: string, on: boolean): void {
  if (on === blocked.has(userId)) return;
  if (on) blocked.add(userId);
  else blocked.delete(userId);
  try {
    localStorage.setItem(BLOCKED_KEY, JSON.stringify([...blocked]));
  } catch {
    // vale para esta sessão; o áudio e o filtro já foram aplicados
  }
  applyEffectiveMute(userId);
  for (const fn of blockListeners) fn(userId, on);
}

/**
 * O VoiceClient tem UM botão de mute por pessoa, e duas coisas querem apertá-lo
 * (o mute local e o bloqueio). Quem decide é esta função, sempre: sem ela,
 * desbloquear alguém desfaria um mute que o usuário tinha ligado à mão — e
 * bloquear alguém já mutado deixaria a preferência e o áudio contando
 * histórias diferentes na próxima sessão.
 */
function applyEffectiveMute(userId: string): void {
  ctx?.controls.setUserMuted(userId, prefOf(userId).mute || blocked.has(userId));
}

// ---------------------------------------------------------------------------
// Estado do módulo
// ---------------------------------------------------------------------------

const TITLE_ID = "uc-title";
/** folga entre o card e a linha que o abriu, e entre o card e a borda da tela */
const GAP = 8;

/** Durações oferecidas no timeout de chat. O servidor limita em 7 dias. */
const TIMEOUTS: ReadonlyArray<{ minutes: number; label: string; phrase: string }> = [
  { minutes: 5, label: "5 min", phrase: "5 minutos" },
  { minutes: 10, label: "10 min", phrase: "10 minutos" },
  { minutes: 60, label: "1 hora", phrase: "1 hora" },
  { minutes: 60 * 24, label: "1 dia", phrase: "1 dia" },
];

/**
 * Época dos snowflakes do projeto (2026-01-01Z) — a MESMA de
 * `apps/server/src/db/snowflake.ts`. Ela mora aqui porque o `User` do fio não
 * tem `created_at`: o id JÁ carrega o instante em que a linha nasceu, que é o
 * primeiro login da pessoa, que é exatamente o "membro desde" do card. Copiar
 * constante não é de graça — o lugar certo dela é `packages/protocol`, junto de
 * um `idTimestamp()`; está registrado no relatório do M10.
 */
const SNOWFLAKE_EPOCH_MS = 1_767_225_600_000n;

const SINCE_FORMAT = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", year: "numeric" });

/**
 * O que TODA ação precisa saber para reportar falha: a caixa de erro do card.
 * Passar só isto (e não o `Parts` inteiro) é o que permite construir as linhas
 * ANTES de o `Parts` existir — sem `null!` em campo nenhum.
 */
interface ErrorSink {
  error: HTMLElement;
}

/**
 * SÓ o que o `sync()` repinta. O volume não entra aqui de propósito: ele não
 * tem outra fonte além do próprio card, e guardar referência para ele seria
 * convidar alguém a repintá-lo por fora, atropelando um arrasto em andamento.
 */
interface Parts extends ErrorSink {
  avatarSlot: HTMLElement;
  /** último status desenhado — o avatar só é refeito quando ele muda (a <img>
   *  recarrega a cada troca de nó, e piscar por causa de presença é feio) */
  avatarStatus: PresenceStatus | null;
  name: HTMLElement;
  handle: HTMLElement;
  badge: HTMLElement;
  sub: HTMLElement;
  serverFlag: HTMLElement;
  timeoutFlag: HTMLElement;
  /** as duas chaves locais que dependem UMA DA OUTRA (ver `paintLocalMute`) */
  muteInput: HTMLInputElement;
  muteHint: HTMLElement;
  blockInput: HTMLInputElement;
  modSection: HTMLElement;
  roleRow: HTMLElement;
  rolePromote: ActionRow;
  roleDemote: ActionRow;
  timeoutRow: HTMLElement;
  timeoutClear: HTMLButtonElement;
  cancelTimeoutConfirm: () => void;
  adminMuteRow: HTMLElement;
  adminMute: HTMLInputElement;
  adminDisconnect: ActionRow;
  dangerSection: HTMLElement;
  kick: ActionRow;
  ban: ActionRow;
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
  /**
   * Relógio do timeout de chat (item 53). Só existe enquanto há timeout ATIVO e
   * o card está aberto: o servidor manda MEMBER_UPDATE ao pôr e ao tirar, mas o
   * VENCIMENTO não gera evento nenhum (o `muted_until` simplesmente deixa de
   * valer na leitura) — quem percebe que o prazo acabou é este relógio.
   */
  timeoutTicker: number | null;
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
  }
  // o mute passa pelo `applyEffectiveMute` (e não pelo pref direto) para que o
  // bloqueio da sessão passada continue valendo no áudio deste boot
  for (const userId of new Set([...prefs.keys(), ...blocked])) applyEffectiveMute(userId);

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
    timeoutTicker: null,
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
  // o relógio do timeout morre com o card: um setInterval sobrevivente ficaria
  // repintando nós que já saíram do documento, para sempre
  if (o.timeoutTicker !== null) window.clearInterval(o.timeoutTicker);
  o.pop.remove();
  if (!returnFocus) return;
  // a linha guardada pode ter sido destruída por um re-render enquanto o card
  // estava aberto: refoca a linha ATUAL da mesma pessoa, se ainda houver
  const back = o.anchor?.isConnected === true ? o.anchor : findAnchor(o.userId, o.from);
  back?.focus();
}

/**
 * Repinta o que depende do estado (perfil, cargo, timeout, server mute) e
 * reancora. O módulo já faz isto sozinho quando as listas se redesenham;
 * existe exportado para quem quiser forçar depois de um dispatch que não mexeu
 * no DOM — MEMBER_UPDATE é o caso típico: trocar o apelido ou o cargo de
 * alguém não necessariamente redesenha a lista onde o card está ancorado.
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
    // a pessoa saiu da lista (saiu da voz, foi expulsa) e não há onde ancorar:
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
// Permissões (espelho da regra do servidor)
// ---------------------------------------------------------------------------

interface Perms {
  /** server mute e desconectar da voz: o servidor pede só "admin ou owner" */
  voice: boolean;
  /** timeout, kick e ban: preciso de cargo ESTRITAMENTE maior que o do alvo */
  social: boolean;
  /** promover/rebaixar: só o dono mexe em cargo (e nunca no do próprio dono) */
  role: boolean;
}

const NO_PERMS: Perms = { voice: false, social: false, role: false };

/**
 * O que EU posso fazer com o alvo. A regra vale no SERVIDOR; isto aqui existe
 * para o card não oferecer botão que vai voltar 403 — e para as três linhas de
 * hierarquia do M10 ficarem escritas em UM lugar:
 *
 * - ninguém rebaixa, expulsa ou bane o OWNER (nem outro admin, nem ele mesmo);
 * - admin não expulsa/bane admin — para isso é preciso ser owner;
 * - ninguém modera a si mesmo (para as MINHAS mídias existem os botões do
 *   rodapé de voz, e o dia em que eu me expulsar sozinho não vem).
 *
 * A moderação de VOZ é mais frouxa de propósito: o servidor (voice.ts) só
 * pergunta `isAdmin`, sem comparar cargos. Espelhar aqui uma regra mais dura
 * que a de lá esconderia um botão que funciona.
 */
function permsOf(me: User | null, target: User): Perms {
  if (me === null || me.id === target.id || !isStaff(me)) return NO_PERMS;
  return {
    voice: true,
    social: roleRank(me.role) > roleRank(target.role),
    role: me.role === "owner" && target.role !== "owner",
  };
}

// ---------------------------------------------------------------------------
// Utilitários de construção
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

function sectionEl(className: string, title: string): HTMLElement {
  const section = make("section", className);
  section.append(make("h3", "uc-section-head", title));
  return section;
}

/** Nome de quem ainda não veio no READY — o mesmo fallback da lista de voz. */
function userOf(c: UserControlsContext, userId: string): User {
  return (
    c.state.members.get(userId) ?? {
      id: userId,
      username: `user-${userId.slice(-4)}`,
      nickname: null,
      avatar_url: null,
      role: "member",
      muted_until: null,
    }
  );
}

/**
 * "Membro desde" a partir do snowflake (ver `SNOWFLAKE_EPOCH_MS`): o id nasceu
 * no primeiro login da pessoa. Devolve null para id que não seja um snowflake
 * nosso (id vindo torto de um fallback, por exemplo) — uma data de 1970 no
 * perfil de alguém seria pior que linha nenhuma.
 */
function memberSince(userId: string): Date | null {
  if (!/^\d{1,20}$/.test(userId)) return null;
  const date = new Date(Number((BigInt(userId) >> 22n) + SNOWFLAKE_EPOCH_MS));
  const ms = date.getTime();
  if (Number.isNaN(ms) || ms < Number(SNOWFLAKE_EPOCH_MS) || ms > Date.now() + 86_400_000) return null;
  return date;
}

/** "faltam 4 min" — do mais grosso para o mais fino, nunca com dois zeros. */
function remainingText(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours} h` : `${hours} h ${restMinutes} min`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} d` : `${days} d ${restHours} h`;
}

// ---------------------------------------------------------------------------
// Linha de ação com confirmação
//
// Confirmação INLINE e não `window.confirm`: o diálogo do navegador rouba a
// janela inteira, não é estilizável e no app empacotado parece erro. Aqui a
// pergunta fica no mesmo lugar do botão, e o botão que confirma só existe
// depois de a pessoa pedir por ele. Ela mora DENTRO da mesma linha: trocada
// por fora, a linha ficaria como uma caixa vazia com o botão sumido.
//
// Isto era, no M9, código solto dentro do "desconectar da voz". Virou fábrica
// porque o M10 tem cinco ações com exatamente a mesma coreografia (perguntar,
// desabilitar durante o voo, mostrar o erro, voltar ao estado real) — e cinco
// cópias divergiriam na primeira correção.
// ---------------------------------------------------------------------------

interface ActionRowOptions {
  /** texto do botão que ABRE a confirmação */
  label: string;
  desc: string;
  /** a pergunta, já com o nome exibido do alvo dentro */
  question: string;
  /** texto do botão que CONFIRMA (verbo no infinitivo: "Expulsar", "Banir") */
  confirmLabel: string;
  /** pinta de --danger e marca a linha; reservado ao que atinge outra pessoa */
  danger: boolean;
  /** oferece o campo de motivo (kick e ban: o texto vai para o mod_log) */
  withReason: boolean;
  /** sufixo do id do campo de motivo — precisa ser único dentro do card */
  reasonKey?: string;
  iconName?: IconName;
  run(reason: string | null): Promise<void>;
}

interface ActionRow {
  row: HTMLElement;
  /** esconde a linha E derruba a confirmação que estiver no ar */
  setVisible(visible: boolean): void;
  /** desabilita com explicação no `title` (ex.: alvo fora da voz) */
  setEnabled(enabled: boolean, whyDisabled: string): void;
}

function actionRow(sink: ErrorSink, options: ActionRowOptions): ActionRow {
  const row = make("div", options.danger ? "uc-row uc-destructive" : "uc-row");
  const button = make("button", options.danger ? "uc-danger-btn" : "uc-action-btn", options.label);
  button.type = "button";
  if (options.iconName !== undefined) button.prepend(icon(options.iconName, 16));
  const desc = make("p", "uc-desc", options.desc);
  desc.hidden = options.desc === "";
  row.append(button, desc);

  const confirm = make("div", "uc-confirm");
  confirm.hidden = true;
  confirm.append(make("p", "uc-confirm-text", options.question));

  let reasonInput: HTMLInputElement | null = null;
  if (options.withReason) {
    const input = make("input", "uc-reason");
    input.type = "text";
    input.id = `uc-reason-${options.reasonKey ?? "acao"}`;
    input.maxLength = 500; // o mesmo teto do ModerationReasonBody
    input.placeholder = "motivo (opcional)";
    // rótulo invisível e não só placeholder: placeholder some ao digitar e o
    // leitor de tela ficaria com um campo sem nome nenhum
    const label = make("label", "sr-only", "Motivo (opcional)");
    label.htmlFor = input.id;
    confirm.append(label, input);
    reasonInput = input;
  }

  const cancelBtn = make("button", "uc-cancel", "Cancelar");
  cancelBtn.type = "button";
  const yes = make("button", options.danger ? "uc-danger-btn" : "uc-action-btn", options.confirmLabel);
  yes.type = "button";
  confirm.append(cancelBtn, yes);
  row.append(confirm);

  const setConfirm = (on: boolean): void => {
    // já está assim: sai antes de mexer no foco. O `sync` chama isto a cada
    // repintura, e mover o foco por causa de um evento de outra pessoa seria
    // arrancar o cursor da mão de quem está usando o card.
    if (confirm.hidden === !on) return;
    confirm.hidden = !on;
    button.hidden = on;
    desc.hidden = on || options.desc === "";
    if (!on && reasonInput !== null) reasonInput.value = "";
    // linha escondida (ou botão desabilitado): mexer no foco aqui só o jogaria
    // no <body>, e de lá o teclado não acha mais o card
    if (row.hidden) return;
    // com motivo, o foco vai para o campo (é onde a pessoa vai escrever); sem
    // motivo, direto para o botão que confirma
    const target = on ? (reasonInput ?? yes) : button.disabled ? null : button;
    target?.focus();
  };

  button.addEventListener("click", () => setConfirm(true));
  cancelBtn.addEventListener("click", () => setConfirm(false));
  yes.addEventListener("click", () => {
    const typed = reasonInput?.value.trim() ?? "";
    yes.disabled = true;
    cancelBtn.disabled = true;
    void options
      .run(typed === "" ? null : typed)
      .then(() => showError(sink, null))
      .catch((err: unknown) =>
        showError(sink, humanError(err, `não foi possível ${options.confirmLabel.toLowerCase()}`)),
      )
      .finally(() => {
        yes.disabled = false;
        cancelBtn.disabled = false;
        setConfirm(false);
        sync(); // repinta a partir do estado real
        keepFocusInCard();
      });
  });

  return {
    row,
    setVisible: (visible) => {
      // esconde PRIMEIRO e cancela depois: uma pergunta pendurada reapareceria
      // intacta no próximo `hidden = false`, e cancelar antes moveria o foco
      // para um botão que está prestes a sumir
      row.hidden = !visible;
      if (!visible) setConfirm(false);
    },
    setEnabled: (enabled, whyDisabled) => {
      button.disabled = !enabled;
      button.title = enabled ? "" : whyDisabled;
      if (!enabled) setConfirm(false);
    },
  };
}

// ---------------------------------------------------------------------------
// Construção do card
// ---------------------------------------------------------------------------

function build(c: UserControlsContext, userId: string): { pop: HTMLElement; parts: Parts } {
  const user = userOf(c, userId);
  const isMe = userId === c.state.me?.id;

  const pop = make("div", "uc-pop");
  // dialog não-modal: o resto do app continua clicável (o card é um popover,
  // não um modal — nada de `inert` no #app como no diálogo de som)
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-labelledby", TITLE_ID);
  pop.tabIndex = -1;

  // --- cabeçalho de perfil (item 48)
  const head = make("header", "uc-head");
  const avatarSlot = make("div", "uc-avatar");
  head.append(avatarSlot);

  const idBox = make("div", "uc-idbox");
  const name = make("h2", "uc-name");
  name.id = TITLE_ID;
  const badge = make("span", "uc-badge");
  badge.hidden = true;
  idBox.append(name, badge);
  // o @username fica ENTRE o nome e o status: quem usa apelido precisa ver de
  // quem é a conta do Discord — é o que liga o "Zé" da guild ao `ze_2000` que
  // aparece na allowlist e no log de moderação
  const handle = make("p", "uc-handle");
  handle.hidden = true;
  idBox.append(handle);
  const sub = make("p", "uc-sub");
  idBox.append(sub);
  const since = memberSince(userId);
  if (since !== null) idBox.append(make("p", "uc-since", `Membro desde ${SINCE_FORMAT.format(since)}`));
  head.append(idBox);

  const close = make("button", "icon-btn uc-close");
  close.type = "button";
  close.setAttribute("aria-label", "Fechar");
  close.title = "Fechar";
  close.append(icon("close", 16));
  close.addEventListener("click", () => closeUserControls());
  head.append(close);
  pop.append(head);

  // Selos de estado IMPOSTO: fora da seção de moderação de propósito — eles são
  // informação para TODOS (ver o cabeçalho do arquivo), não controles.
  const serverFlag = make("p", "uc-flag uc-flag-voice");
  serverFlag.append(icon("mic-off", 14));
  serverFlag.append(document.createTextNode("Silenciado pelo administrador — ninguém ouve"));
  serverFlag.hidden = true;
  pop.append(serverFlag);

  // sem ícone: `ui/icons.ts` não tem relógio, e o de microfone diria "voz" —
  // que é justamente a confusão que o timeout de CHAT não pode causar
  const timeoutFlag = make("p", "uc-flag uc-flag-chat");
  timeoutFlag.hidden = true;
  pop.append(timeoutFlag);

  const error = make("p", "uc-error");
  error.setAttribute("role", "status");
  error.hidden = true;
  const sink: ErrorSink = { error };

  const local = localSection(c, userId, user, isMe);
  const mod = moderationSection(c, userId, user, sink);
  const danger = dangerSection(c, userId, user, sink);

  const body = make("div", "uc-body");
  body.append(local.section, mod.section, danger.section, error);
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

  const parts: Parts = {
    error,
    avatarSlot,
    avatarStatus: null,
    name,
    handle,
    badge,
    sub,
    serverFlag,
    timeoutFlag,
    muteInput: local.muteInput,
    muteHint: local.muteHint,
    blockInput: local.blockInput,
    modSection: mod.section,
    roleRow: mod.roleRow,
    rolePromote: mod.promote,
    roleDemote: mod.demote,
    timeoutRow: mod.timeoutRow,
    timeoutClear: mod.timeoutClear,
    cancelTimeoutConfirm: mod.cancelTimeoutConfirm,
    adminMuteRow: mod.adminMuteRow,
    adminMute: mod.adminMute,
    adminDisconnect: mod.disconnect,
    dangerSection: danger.section,
    kick: danger.kick,
    ban: danger.ban,
  };
  return { pop, parts };
}

// ---------------------------------------------------------------------------
// Faixa 1: "só para você"
// ---------------------------------------------------------------------------

interface LocalSection {
  section: HTMLElement;
  muteInput: HTMLInputElement;
  muteHint: HTMLElement;
  blockInput: HTMLInputElement;
}

// nada nesta faixa vai à rede — por isso ela é a única que não recebe o
// `ErrorSink`: não existe falha para reportar
function localSection(c: UserControlsContext, userId: string, user: User, isMe: boolean): LocalSection {
  const section = sectionEl("uc-section", "Só para você");
  const name = displayName(user);

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
  volumeReset.setAttribute("aria-label", `Voltar o volume de ${name} para 100%`);
  const boost = make(
    "p",
    "uc-warn",
    "Acima de 100% não vale para o áudio de uma transmissão de tela: o navegador limita o volume do vídeo.",
  );
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
  section.append(volumeRow);

  // --- mute local (item 33)
  const mute = switchRow(
    "uc-mute",
    "Parar de ouvir",
    "Só o ÁUDIO: a pessoa some da voz para você, mas o que ela escreve continua aparecendo. Ela não fica sabendo de nada.",
  );
  const muteHint = make("p", "uc-hint", "O bloqueio já silencia esta pessoa.");
  muteHint.hidden = true;
  mute.row.append(muteHint);
  mute.input.checked = prefOf(userId).mute;
  mute.input.addEventListener("change", () => {
    writePref(userId, { mute: mute.input.checked });
    applyEffectiveMute(userId);
  });
  section.append(mute.row);

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
    section.append(sb.row);
  }

  // --- bloquear (item 54)
  // A diferença para o "parar de ouvir" está escrita nas DUAS descrições porque
  // é exatamente aqui que se erra: um esconde a voz, o outro esconde a pessoa
  // inteira. Nenhum dos dois é moderação — nada disso sai desta máquina.
  const block = switchRow(
    "uc-block",
    "Bloquear",
    "Esconde as mensagens desta pessoa E silencia a voz dela. Também é só para você: ela não fica sabendo, e para os outros nada muda.",
  );
  block.input.checked = isBlocked(userId);
  block.input.addEventListener("change", () => {
    setUserBlocked(userId, block.input.checked);
    if (open !== null) paintLocalMute(open.parts, userId);
  });
  // bloquear a si mesmo é absurdo (sumiriam as próprias mensagens do chat) — e
  // é o tipo de chave que alguém aperta "só para ver o que acontece"
  block.row.hidden = isMe;
  section.append(block.row);

  return { section, muteInput: mute.input, muteHint, blockInput: block.input };
}

/**
 * A chave de "parar de ouvir" e a de bloquear contam a mesma história para o
 * áudio, e por isso se pintam juntas: com o bloqueio ligado, o mute local está
 * implícito e sua chave vira ruído — desabilitada e explicada, em vez de
 * marcada por baixo dos panos (o que faria o usuário achar que ele mesmo mutou
 * e, ao desbloquear, estranhar o silêncio que não existe mais).
 */
function paintLocalMute(parts: Parts, userId: string): void {
  const isNowBlocked = isBlocked(userId);
  parts.blockInput.checked = isNowBlocked;
  parts.muteInput.checked = prefOf(userId).mute || isNowBlocked;
  parts.muteInput.disabled = isNowBlocked;
  parts.muteHint.hidden = !isNowBlocked;
}

// ---------------------------------------------------------------------------
// Faixa 2: moderação reversível
// ---------------------------------------------------------------------------

interface ModerationSection {
  section: HTMLElement;
  roleRow: HTMLElement;
  promote: ActionRow;
  demote: ActionRow;
  timeoutRow: HTMLElement;
  timeoutClear: HTMLButtonElement;
  cancelTimeoutConfirm: () => void;
  adminMuteRow: HTMLElement;
  adminMute: HTMLInputElement;
  disconnect: ActionRow;
}

function moderationSection(
  c: UserControlsContext,
  userId: string,
  user: User,
  sink: ErrorSink,
): ModerationSection {
  const section = sectionEl("uc-section uc-admin", "Moderação");
  const name = displayName(user);

  // --- cargo (item 51)
  const roleRow = make("div", "uc-row uc-role");
  roleRow.append(make("p", "uc-label", "Cargo"));
  roleRow.append(
    make(
      "p",
      "uc-desc",
      "Administrador modera os outros membros: silencia, expulsa e bane. Só o dono muda cargo, e o cargo de dono não se mexe por aqui.",
    ),
  );
  const promote = actionRow(sink, {
    label: "Promover a administrador",
    desc: "",
    question: `Tornar ${name} administrador?`,
    confirmLabel: "Promover",
    danger: false,
    withReason: false,
    iconName: "check",
    run: () => setMemberRole(userId, "admin"),
  });
  const demote = actionRow(sink, {
    label: "Rebaixar a membro",
    desc: "",
    question: `Tirar o cargo de administrador de ${name}?`,
    confirmLabel: "Rebaixar",
    danger: false,
    withReason: false,
    run: () => setMemberRole(userId, "member"),
  });
  // as duas linhas internas não repetem descrição: quem explica é o parágrafo
  // do `uc-role` acima, e três textos empilhados só dariam scroll
  promote.row.classList.add("uc-subrow");
  demote.row.classList.add("uc-subrow");
  roleRow.append(promote.row, demote.row);
  section.append(roleRow);

  // --- timeout de chat (item 53)
  const timeoutRow = make("div", "uc-row uc-timeout");
  timeoutRow.append(make("p", "uc-label", "Silenciar no chat"));
  timeoutRow.append(
    make(
      "p",
      "uc-desc",
      "Por um tempo a pessoa não escreve. Continua ouvindo e falando na voz — para calar o microfone é o controle abaixo.",
    ),
  );
  const chips = make("div", "uc-chips");
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", "Duração do silêncio no chat");

  // UMA confirmação para as quatro durações, com o texto trocado no clique:
  // quatro caixas empilhadas seriam quatro vezes o mesmo botão "Cancelar" na
  // tela, e o card já é alto.
  const confirm = make("div", "uc-confirm");
  confirm.hidden = true;
  const confirmText = make("p", "uc-confirm-text");
  const cancelBtn = make("button", "uc-cancel", "Cancelar");
  cancelBtn.type = "button";
  const yes = make("button", "uc-action-btn", "Silenciar");
  yes.type = "button";
  confirm.append(confirmText, cancelBtn, yes);

  let pendingMinutes = 0;
  const setConfirm = (on: boolean): void => {
    if (confirm.hidden === !on) return;
    confirm.hidden = !on;
    chips.hidden = on;
    // mesma regra do `actionRow`: com a linha escondida (o `sync` cancela a
    // confirmação quando a permissão some), mexer no foco o perde no <body>
    if (timeoutRow.hidden) return;
    const back = chips.querySelector<HTMLButtonElement>("button");
    (on ? yes : (back ?? yes)).focus();
  };
  for (const option of TIMEOUTS) {
    const chip = make("button", "uc-chip", option.label);
    chip.type = "button";
    chip.addEventListener("click", () => {
      pendingMinutes = option.minutes;
      confirmText.textContent = `Silenciar ${name} no chat por ${option.phrase}?`;
      setConfirm(true);
    });
    chips.append(chip);
  }
  cancelBtn.addEventListener("click", () => setConfirm(false));
  yes.addEventListener("click", () => {
    yes.disabled = true;
    cancelBtn.disabled = true;
    void timeoutMember(userId, pendingMinutes, null)
      .then(() => showError(sink, null))
      .catch((err: unknown) => showError(sink, humanError(err, "não foi possível silenciar no chat")))
      .finally(() => {
        yes.disabled = false;
        cancelBtn.disabled = false;
        setConfirm(false);
        sync();
        keepFocusInCard();
      });
  });

  // liberar NÃO pergunta nada: desfazer uma punição é o movimento seguro, e
  // uma confirmação aqui só atrasaria quem já se arrependeu
  const clear = make("button", "uc-action-btn uc-timeout-clear", "Liberar agora");
  clear.type = "button";
  clear.hidden = true;
  clear.addEventListener("click", () => {
    clear.disabled = true;
    void timeoutMember(userId, 0, null)
      .then(() => showError(sink, null))
      .catch((err: unknown) => showError(sink, humanError(err, "não foi possível liberar")))
      .finally(() => {
        clear.disabled = false;
        sync();
        keepFocusInCard();
      });
  });

  timeoutRow.append(chips, confirm, clear);
  section.append(timeoutRow);

  // --- silenciar para todos (item 34) — M9, preservado
  const serverMute = switchRow(
    "uc-server-mute",
    "Silenciar o microfone para todos",
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
        showError(sink, null);
      })
      .catch((err: unknown) => showError(sink, humanError(err, "não foi possível silenciar")))
      .finally(() => {
        serverMute.input.disabled = false;
        sync(); // repinta a partir do estado real, desfazendo o clique que falhou
      });
  });
  section.append(serverMute.row);

  // --- desconectar da voz (item 37) — M9, preservado (agora pela fábrica)
  const disconnect = actionRow(sink, {
    label: "Desconectar da voz",
    desc: "Tira a pessoa do canal agora. Ela pode entrar de novo — barrar de vez é banir.",
    question: `Desconectar ${name} da voz?`,
    confirmLabel: "Desconectar",
    danger: true,
    withReason: false,
    iconName: "logout",
    run: () => c.controls.disconnectUser(userId),
  });
  section.append(disconnect.row);

  return {
    section,
    roleRow,
    promote,
    demote,
    timeoutRow,
    timeoutClear: clear,
    cancelTimeoutConfirm: () => setConfirm(false),
    adminMuteRow: serverMute.row,
    adminMute: serverMute.input,
    disconnect,
  };
}

// ---------------------------------------------------------------------------
// Faixa 3: irreversível
// ---------------------------------------------------------------------------

interface DangerSection {
  section: HTMLElement;
  kick: ActionRow;
  ban: ActionRow;
}

function dangerSection(c: UserControlsContext, userId: string, user: User, sink: ErrorSink): DangerSection {
  // Divisor e título próprios: do ponto de vista de quem aperta, kick e ban não
  // têm "desfazer" (o unban existe, mas quem foi embora já foi). Estas duas
  // linhas NÃO podem dividir vizinhança com volume nem com timeout.
  const section = sectionEl("uc-section uc-danger-zone", "Não dá para desfazer");
  const name = displayName(user);

  const kick = actionRow(sink, {
    label: "Expulsar",
    desc: "Sai da guild e cai da sessão na hora. Pode voltar se alguém mandar um convite novo.",
    question: `Expulsar ${name} da guild?`,
    confirmLabel: "Expulsar",
    danger: true,
    withReason: true,
    reasonKey: "kick",
    iconName: "logout",
    run: (reason) => kickMember(userId, reason),
  });

  const ban = actionRow(sink, {
    label: "Banir",
    desc: "Sai da guild e NENHUM convite volta a funcionar para ela. Só um administrador desfaz, pela lista de banidos.",
    question: `Banir ${name}? Depois disso nenhum convite funciona para ela.`,
    confirmLabel: "Banir",
    danger: true,
    withReason: true,
    reasonKey: "ban",
    iconName: "close",
    run: (reason) => banMember(userId, reason),
  });

  section.append(kick.row, ban.row);
  return { section, kick, ban };
}

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

/**
 * Erro de rota vira FRASE. A regra do M10: um 403 de "só o dono faz isso" não
 * pode chegar ao usuário como número — ele não fez nada errado, tentou uma
 * coisa que o cargo dele não alcança, e isso se diz em português.
 *
 * A ordem da tentativa: (1) a mensagem que o servidor escreveu (ele já responde
 * `{error: "…"}` em pt-BR, e é sempre mais específica que qualquer tabela
 * daqui); (2) a tabela por código; (3) o texto genérico do chamador.
 */
function humanError(err: unknown, fallback: string): string {
  // fetch rejeita com TypeError quando a requisição nem sai (offline, DNS,
  // CORS); o `authFetch` daqui já traduz o caso dele, mas o op 20 da voz passa
  // pelo gateway e pode chegar cru
  if (err instanceof TypeError) return "Sem conexão com o servidor. Tente de novo.";

  const raw = err instanceof Error ? err.message.trim() : "";
  // Um erro com CÓDIGO no começo ("403 em /api/…", o formato do `api()` do
  // main.ts) é código, não frase, e não pode ir para a tela; qualquer outra
  // coisa já é português — tanto o `ModerationError` daqui quanto o
  // `{ok:false, error}` do op 21, que o servidor escreve em pt-BR.
  if (raw !== "" && !/^\d{3}\b/.test(raw)) return capitalize(raw);
  return capitalize(fallback);
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/**
 * Depois de uma ação, o `sync` pode ESCONDER o botão que estava com o foco
 * ("Promover" vira "Rebaixar"; a linha some quando a permissão muda). Um
 * elemento escondido larga o foco no `<body>`, e de lá o teclado não volta
 * mais para o card — este é o mesmo conserto que o `keepFocus` da casca de
 * diálogo faz, e pela mesma razão.
 */
function keepFocusInCard(): void {
  const o = open;
  if (o !== null && !o.pop.contains(document.activeElement)) o.pop.focus();
}

function showError(sink: ErrorSink, text: string | null): void {
  sink.error.textContent = text ?? "";
  sink.error.hidden = text === null;
}

// ---------------------------------------------------------------------------
// Pintura do que depende do estado
// ---------------------------------------------------------------------------

/**
 * Repinta SÓ o que vem de fora (perfil, presença, cargo, timeout, server mute)
 * e liga/desliga o que a permissão permite. O volume fica de fora de propósito:
 * ele não tem outra fonte além do próprio card, e reescrevê-lo aqui
 * atropelaria um arrasto em andamento.
 *
 * Por que as seções de moderação são CONSTRUÍDAS sempre e só escondidas aqui:
 * cargo é estado do servidor e muda com o card aberto (um MEMBER_UPDATE
 * promovendo ou rebaixando alguém — inclusive a mim). Se a permissão decidisse
 * o que CONSTRUIR, cada mudança dessas exigiria remontar o card no meio do uso,
 * com foco e confirmação em andamento. Esconder é reversível; remontar não é.
 */
function sync(): void {
  const o = open;
  const c = ctx;
  if (o === null || c === null) return;

  const user = userOf(c, o.userId);
  const parts = o.parts;
  const perms = permsOf(c.state.me, user);

  // --- perfil
  parts.name.textContent = displayName(user);
  const hasNickname = user.nickname !== null && user.nickname !== "";
  parts.handle.textContent = `@${user.username}`;
  parts.handle.hidden = !hasNickname; // sem apelido, o nome exibido JÁ é o @username
  parts.badge.textContent = user.role === "owner" ? "dono" : "admin";
  parts.badge.hidden = user.role === "member";
  parts.badge.classList.toggle("uc-badge-owner", user.role === "owner");

  const status = statusOf(c.state, o.userId);
  if (parts.avatarStatus !== status) {
    // só quando o status MUDA: trocar o nó recarrega a <img> do CDN, e um
    // avatar piscando a cada PRESENCE_UPDATE de outra pessoa seria gratuito
    parts.avatarStatus = status;
    parts.avatarSlot.replaceChildren(avatarEl(user, 56, status));
  }

  const vs = c.state.voiceStates.get(o.userId) ?? null;
  const inVoice = vs !== null && vs.channel_id !== null;
  if (inVoice && vs !== null) {
    const channel = c.state.channels.find((ch) => ch.id === vs.channel_id);
    parts.sub.textContent = `na voz — ${channel?.name ?? "?"}`;
  } else {
    parts.sub.textContent = STATUS_LABEL[status];
  }

  // --- selo do server mute
  // O eco do request VENCE o VoiceState até o VOICE_STATE_UPDATE alcançá-lo:
  // entre o `ok` do op 21 e o dispatch há uma ida e volta de rede, e sem isto
  // a chave voltaria sozinha para o valor antigo por uma fração de segundo —
  // o que se lê como "não funcionou". Alcançado o eco, ele se aposenta e o
  // estado do servidor volta a ser a única fonte (inclusive para desfazer um
  // server mute que outro admin tirou).
  const fromState = vs !== null ? vs.server_mute : null;
  const serverMuted = o.serverMuteEcho ?? fromState ?? false;
  if (fromState !== null && fromState === o.serverMuteEcho) o.serverMuteEcho = null;
  parts.serverFlag.hidden = !serverMuted;

  // --- chaves locais (a de mute depende do bloqueio)
  paintLocalMute(parts, o.userId);

  // --- moderação: a seção inteira some quando não sobra nada dentro dela
  const showMod = perms.voice || perms.social || perms.role;
  parts.modSection.hidden = !showMod;
  parts.dangerSection.hidden = !perms.social;

  parts.roleRow.hidden = !perms.role;
  // um cargo por vez: quem já é admin só pode ser rebaixado, e vice-versa
  parts.rolePromote.setVisible(perms.role && user.role === "member");
  parts.roleDemote.setVisible(perms.role && user.role === "admin");

  parts.timeoutRow.hidden = !perms.social;
  if (!perms.social) parts.cancelTimeoutConfirm();
  parts.timeoutClear.hidden = user.muted_until === null;

  parts.adminMuteRow.hidden = !perms.voice;
  if (!parts.adminMute.disabled) parts.adminMute.checked = serverMuted;
  parts.adminDisconnect.setVisible(perms.voice);
  parts.adminDisconnect.setEnabled(inVoice, "a pessoa não está em nenhum canal de voz");

  parts.kick.setVisible(perms.social);
  parts.ban.setVisible(perms.social);

  // por último: o relógio pode esconder o "Liberar agora" que a linha acima
  // acabou de mostrar, quando o prazo já venceu entre um dispatch e outro
  paintTimeout();
}

/**
 * Pinta o selo "silenciado no chat" e mantém o relógio vivo. Separado do
 * `sync` porque roda de segundo em segundo: o vencimento do timeout não gera
 * evento nenhum no servidor, então é este relógio que apaga o selo na hora
 * certa — para TODO MUNDO, não só para quem pode moderar.
 */
function paintTimeout(): void {
  const o = open;
  const c = ctx;
  if (o === null || c === null) return;

  const until = userOf(c, o.userId).muted_until;
  const left = until === null ? 0 : until - Date.now();

  if (left <= 0) {
    o.parts.timeoutFlag.hidden = true;
    o.parts.timeoutClear.hidden = true;
    if (o.timeoutTicker !== null) {
      window.clearInterval(o.timeoutTicker);
      o.timeoutTicker = null;
    }
    return;
  }

  o.parts.timeoutFlag.hidden = false;
  o.parts.timeoutFlag.textContent = `Silenciado no chat — faltam ${remainingText(left)}`;
  // 1 s é mais fino do que o texto precisa quase sempre, mas é o único jeito de
  // o "faltam 3 s" final não ficar parado na tela; o custo é um repaint de um
  // parágrafo enquanto o card está aberto
  if (o.timeoutTicker === null) o.timeoutTicker = window.setInterval(paintTimeout, 1000);
}
