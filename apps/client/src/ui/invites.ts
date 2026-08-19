/**
 * Painel de convites (M10, itens 43–46): criar link, ver os que existem e
 * revogar. Só admin+ chega aqui — a rota já recusa quem não é, e o item do
 * menu nem aparece para `member`.
 *
 * POR QUE ESTE MÓDULO EXISTE SEPARADO DO ui/invite-landing.ts, que trata do
 * MESMO assunto: os dois lados de um convite não compartilham nada. Este roda
 * DENTRO do app, com sessão, `UiContext` e a lista de membros para resolver
 * nomes; a landing roda ANTES de qualquer login, sem token, sem estado e sem
 * contexto — juntá-los faria o bundle da primeira tela que um estranho vê
 * carregar a UI inteira de administração.
 *
 * O QUE O CONVITE É, e o que a UI precisa deixar claro: o `code` É a
 * credencial. Quem tiver o link entra (se não estiver banido). Por isso:
 *
 * - o link nasce PRONTO para colar no WhatsApp (`<origem>/invite/<code>`) e o
 *   botão de copiar CONFIRMA que copiou — sem a confirmação a pessoa cola o
 *   que estava na área de transferência antes e descobre depois;
 * - convite morto (expirado, esgotado, revogado) fica ESMAECIDO na lista, não
 *   some. Quem mandou o link pelo WhatsApp semana passada precisa conseguir
 *   olhar aqui e entender por que o amigo diz que "não funciona". Uma lista que
 *   só mostra os vivos responde essa pergunta com o silêncio.
 *
 * O REST mora aqui e não num módulo à parte (o M9 separou `sound/soundboard.ts`
 * do `ui/soundboard.ts`) porque não há nada para reaproveitar: fora deste
 * diálogo ninguém no cliente cria, lista ou revoga convite. Um arquivo a mais
 * seria só cerimônia.
 */
import { z } from "zod";
import { Invite, displayName, isStaff } from "@danjocord/protocol";
import { API, getAccessToken, refresh } from "../auth.js";
import type { UiContext } from "./context.js";
import { createDialog, el, type DialogShell } from "./dialog.js";
import { icon } from "./icons.js";

// ---------------------------------------------------------------------------
// REST
//
// Mesmo molde do `sound/soundboard.ts` do M9 e pela mesma razão: o `api()` do
// main.ts é privado e carrega a política de logout do app. Aqui basta renovar
// UMA vez em 401 (o `refresh()` é single-flight, então duas chamadas
// simultâneas não brigam) e falhar com uma frase legível — quem desloga de
// verdade é o próximo `api()` do main.
// ---------------------------------------------------------------------------

export class InviteError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "InviteError";
  }
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${getAccessToken() ?? ""}`, ...extra };
}

async function authFetch(path: string, init: RequestInit): Promise<Response> {
  const send = (): Promise<Response> =>
    fetch(API + path, { ...init, headers: authHeaders(init.headers as Record<string, string> | undefined) });
  let res: Response;
  try {
    res = await send();
  } catch {
    // rede fora / servidor caído: não é status nenhum, e a mensagem tem que
    // dizer isso em vez de inventar um erro de permissão
    throw new InviteError("sem conexão com o servidor");
  }
  if (res.status !== 401) return res;
  const result = await refresh();
  if (result !== "ok") throw new InviteError("sessão expirada — recarregue a página", 401);
  return send();
}

/** Corpo de erro do servidor: `{error, retry_after?}`. Fora do formato, fica o status. */
async function errorFrom(res: Response, fallback: string): Promise<InviteError> {
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
    // corpo não-JSON (502 do Traefik no meio de um deploy): fica o fallback
  }
  // as frases são NOSSAS: o `error` cru do servidor é para o log, não para
  // quem só quer chamar um amigo
  const message =
    res.status === 403
      ? "só administradores podem convidar"
      : res.status === 404
        ? "este convite não existe mais"
        : res.status === 429
          ? retryAfter !== null
            ? `calma aí — espere ${Math.ceil(retryAfter)} s`
            : "calma aí — espere um pouco"
          : res.status === 400
            ? (detail ?? fallback)
            : fallback;
  return new InviteError(message, res.status);
}

/** `GET /api/invites` (admin+) — a lista COMPLETA, mortos inclusive. */
export async function fetchInvites(): Promise<Invite[]> {
  const res = await authFetch("/api/invites", { method: "GET" });
  if (!res.ok) throw await errorFrom(res, "não consegui carregar os convites");
  // schema Zod na entrada, como todo payload do projeto
  return z.array(Invite).parse(await res.json());
}

/** `POST /api/invites` (admin+). Campo ausente = sem limite (o default do Discord). */
export async function createInvite(opts: { expiresInS: number | null; maxUses: number | null }): Promise<Invite> {
  // objeto montado campo a campo: com `exactOptionalPropertyTypes`, mandar
  // `{expires_in_s: undefined}` não é o mesmo que omitir — e o schema do
  // servidor lê a OMISSÃO como "não expira"
  const body: Record<string, number> = {};
  if (opts.expiresInS !== null) body["expires_in_s"] = opts.expiresInS;
  if (opts.maxUses !== null) body["max_uses"] = opts.maxUses;
  const res = await authFetch("/api/invites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res, "não consegui criar o convite");
  return Invite.parse(await res.json());
}

/** `DELETE /api/invites/:code` → 204. Admin+, ou quem criou. */
export async function revokeInvite(code: string): Promise<void> {
  const res = await authFetch(`/api/invites/${encodeURIComponent(code)}`, { method: "DELETE" });
  if (!res.ok) throw await errorFrom(res, "não consegui revogar o convite");
}

// ---------------------------------------------------------------------------
// Link e área de transferência
// ---------------------------------------------------------------------------

/**
 * Base do link que vai para o WhatsApp. NÃO é sempre o `location.origin`:
 *
 * - no desktop (M6) a origem é `app://` — colar isso num grupo não leva
 *   ninguém a lugar nenhum; ali vale a URL pública do servidor, que é
 *   exatamente o que a ponte injetou em `API`;
 * - no navegador vale o `location.origin`, e não o `API`, porque em dev o
 *   cliente mora no vite (:5173) e o backend no :8080 — o link tem que abrir a
 *   PÁGINA. Em produção os dois são a mesma origem e a escolha não muda nada.
 */
export function inviteLinkBase(): string {
  return location.protocol.startsWith("http") ? location.origin : API;
}

export function inviteLink(code: string): string {
  return `${inviteLinkBase()}/invite/${code}`;
}

/**
 * Copiar de verdade, nos dois mundos. `navigator.clipboard` exige contexto
 * seguro (https ou localhost) — num self-hosted em http puro, que é um caso
 * real deste projeto, ele simplesmente não existe. O fallback do `<textarea>`
 * + `execCommand` é feio e obsoleto, e é o único que funciona lá.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // permissão negada ou contexto inseguro: cai no fallback abaixo
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // fora da tela mas ainda selecionável (display:none não seleciona)
  area.style.position = "fixed";
  area.style.top = "-1000px";
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/**
 * Confirmação de que copiou, NO PRÓPRIO botão. É o ponto do item 45: sem ela a
 * pessoa não tem como saber se a área de transferência trocou, e cola no grupo
 * o que estava lá antes. O texto também vai para o `aria-live` do diálogo —
 * quem usa leitor de tela não vê o botão mudar de desenho.
 */
const copyTimers = new WeakMap<HTMLButtonElement, number>();

function flashCopied(btn: HTMLButtonElement, ok: boolean): void {
  const previous = copyTimers.get(btn);
  if (previous !== undefined) window.clearTimeout(previous);
  const idle = (): void => {
    btn.replaceChildren(document.createTextNode("Copiar"));
    btn.classList.remove("is-copied", "is-failed");
  };
  btn.replaceChildren(
    icon(ok ? "check" : "close", 14),
    document.createTextNode(ok ? "Copiado!" : "Copie à mão"),
  );
  btn.classList.toggle("is-copied", ok);
  btn.classList.toggle("is-failed", !ok);
  copyTimers.set(btn, window.setTimeout(idle, 2400));
}

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

const RELATIVE = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
const ABSOLUTE = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

/**
 * "em 6 dias", "há 2 horas". A unidade é escolhida pela ordem de grandeza para
 * a frase não virar "em 10080 minutos" — ninguém lê isso como uma semana.
 */
function relative(deltaMs: number): string {
  const minutes = Math.round(deltaMs / 60_000);
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, "minute");
  const hours = Math.round(deltaMs / 3_600_000);
  if (Math.abs(hours) < 48) return RELATIVE.format(hours, "hour");
  return RELATIVE.format(Math.round(deltaMs / 86_400_000), "day");
}

// ---------------------------------------------------------------------------
// Estado de um convite
// ---------------------------------------------------------------------------

type InviteStatus = "ativo" | "revogado" | "expirado" | "esgotado";

/**
 * A MESMA ordem do `inviteProblem` do servidor (revogado > expirado >
 * esgotado). Se as duas divergirem, a lista vai chamar de "esgotado" um
 * convite que o servidor recusa dizendo "expirado" — e ninguém entende por quê.
 */
function inviteStatus(inv: Invite, now: number): InviteStatus {
  if (inv.revoked_at !== null) return "revogado";
  if (inv.expires_at !== null && inv.expires_at <= now) return "expirado";
  if (inv.max_uses !== null && inv.uses >= inv.max_uses) return "esgotado";
  return "ativo";
}

// ---------------------------------------------------------------------------
// Opções do formulário (os defaults são os do Discord: 7 dias, ilimitado)
// ---------------------------------------------------------------------------

interface Choice {
  label: string;
  /** null = sem limite */
  value: number | null;
}

const EXPIRY: Choice[] = [
  { label: "1 hora", value: 3_600 },
  { label: "1 dia", value: 86_400 },
  { label: "7 dias", value: 604_800 },
  { label: "Nunca expira", value: null },
];
const DEFAULT_EXPIRY = 2; // 7 dias

const USES: Choice[] = [
  { label: "1 uso", value: 1 },
  { label: "5 usos", value: 5 },
  { label: "25 usos", value: 25 },
  { label: "Usos ilimitados", value: null },
];
const DEFAULT_USES = 3; // ilimitado

// ---------------------------------------------------------------------------
// O diálogo
// ---------------------------------------------------------------------------

/** null = ainda não montado. O diálogo é único e vive entre aberturas. */
let shell: DialogShell | null = null;
let ctxRef: UiContext | null = null;

/** cache da última listagem — o render lê daqui, o fetch escreve */
let invites: Invite[] = [];
/** o link recém-criado, em destaque até fechar o diálogo */
let created: Invite | null = null;
/** corrida: só a resposta do último GET pode pintar a lista */
let loadToken = 0;

let expirySelect: HTMLSelectElement;
let usesSelect: HTMLSelectElement;
let generateBtn: HTMLButtonElement;
let resultBox: HTMLElement;
let resultInput: HTMLInputElement;
let resultCopy: HTMLButtonElement;
let statusLine: HTMLElement;
let listEl: HTMLElement;

function selectFrom(id: string, choices: Choice[], defaultIndex: number): HTMLSelectElement {
  const sel = el("select", "inv-select");
  sel.id = id;
  choices.forEach((c, i) => {
    const opt = document.createElement("option");
    // o índice e não o valor: `null` não sobrevive a um atributo de HTML, e
    // "" como sentinela de "sem limite" é exatamente o tipo de convenção que
    // alguém troca por engano depois
    opt.value = String(i);
    opt.textContent = c.label;
    sel.append(opt);
  });
  sel.value = String(defaultIndex);
  return sel;
}

function chosen(sel: HTMLSelectElement, choices: Choice[]): number | null {
  return choices[Number(sel.value)]?.value ?? null;
}

/** Mensagem única do diálogo (erro ou aviso). "" apaga. */
function setStatus(text: string, danger = true): void {
  statusLine.textContent = text;
  statusLine.hidden = text === "";
  statusLine.classList.toggle("is-danger", danger);
}

function build(): DialogShell {
  const dialog = createDialog({
    id: "invites-dialog",
    title: "Convidar amigos",
    onOpen: () => {
      setStatus("");
      void load();
    },
    onClose: () => {
      // o destaque do link novo não sobrevive ao fechamento: reabrir o
      // diálogo é começar de novo, e um link antigo em destaque seria uma
      // armadilha para copiar o convite errado
      created = null;
      renderResult();
    },
  });

  const intro = el(
    "p",
    "inv-intro",
    "Quem tiver o link entra no servidor. Mande só para quem você quer dentro — e revogue se o link vazar.",
  );

  // --- criar
  const form = el("div", "inv-section");
  form.append(el("h3", "inv-section-title", "Criar um link"));

  const fields = el("div", "inv-fields");
  const expiryField = el("div", "inv-field");
  const expiryLabel = el("label", "inv-field-label", "Validade");
  expiryLabel.htmlFor = "inv-expiry";
  expirySelect = selectFrom("inv-expiry", EXPIRY, DEFAULT_EXPIRY);
  expiryField.append(expiryLabel, expirySelect);

  const usesField = el("div", "inv-field");
  const usesLabel = el("label", "inv-field-label", "Número de usos");
  usesLabel.htmlFor = "inv-uses";
  usesSelect = selectFrom("inv-uses", USES, DEFAULT_USES);
  usesField.append(usesLabel, usesSelect);

  generateBtn = el("button", "inv-btn inv-btn-primary", "Gerar link");
  generateBtn.type = "button";
  generateBtn.addEventListener("click", () => void generate());

  fields.append(expiryField, usesField, generateBtn);
  form.append(fields);

  // --- o link novo
  resultBox = el("div", "inv-result");
  resultBox.hidden = true;
  resultInput = el("input", "inv-link");
  resultInput.type = "text";
  resultInput.readOnly = true;
  resultInput.setAttribute("aria-label", "Link do convite");
  // selecionar tudo ao focar: quem prefere Ctrl+C não precisa mirar no texto
  resultInput.addEventListener("focus", () => resultInput.select());
  resultCopy = el("button", "inv-btn inv-copy", "Copiar");
  resultCopy.type = "button";
  resultCopy.addEventListener("click", () => void copyInto(resultCopy, resultInput.value));
  resultBox.append(resultInput, resultCopy);
  form.append(resultBox);

  statusLine = el("p", "inv-status");
  statusLine.hidden = true;
  // as duas frases que mudam sem que nada ganhe foco (erro e "Copiado!")
  // passam por aqui, senão quem usa leitor de tela não fica sabendo de nenhuma
  statusLine.setAttribute("role", "status");
  statusLine.setAttribute("aria-live", "polite");
  form.append(statusLine);

  // --- lista
  const listSection = el("div", "inv-section");
  listSection.append(el("h3", "inv-section-title", "Links deste servidor"));
  listEl = el("ul", "inv-list");
  listSection.append(listEl);

  dialog.body.append(intro, form, listSection);

  const done = el("button", "inv-done", "Concluído");
  done.type = "button";
  done.addEventListener("click", () => dialog.close());
  dialog.foot.append(done);

  return dialog;
}

async function copyInto(btn: HTMLButtonElement, text: string): Promise<void> {
  const ok = await copyText(text);
  flashCopied(btn, ok);
  setStatus(ok ? "Link copiado — é só colar." : "Não consegui copiar; selecione o link e use Ctrl+C.", !ok);
  // o `<textarea>` do fallback rouba o foco por um instante; sem isto o foco
  // volta para o <body> e a armadilha de Tab do diálogo perde o rastro
  btn.focus();
}

async function load(): Promise<void> {
  const token = ++loadToken;
  try {
    const list = await fetchInvites();
    if (token !== loadToken) return; // chegou uma listagem mais nova
    invites = list;
    renderList();
  } catch (err) {
    if (token !== loadToken) return;
    setStatus(err instanceof InviteError ? err.message : "não consegui carregar os convites");
  }
}

async function generate(): Promise<void> {
  generateBtn.disabled = true;
  setStatus("");
  try {
    const invite = await createInvite({
      expiresInS: chosen(expirySelect, EXPIRY),
      maxUses: chosen(usesSelect, USES),
    });
    created = invite;
    // otimista e sem esperar o GET: o link novo é o motivo de a pessoa ter
    // aberto o diálogo, e ele já veio inteiro na resposta
    invites = [invite, ...invites];
    renderResult();
    renderList();
    // copiar não é automático de propósito: mexer na área de transferência de
    // alguém sem a pessoa pedir apaga o que ela tinha copiado antes
    resultCopy.focus();
  } catch (err) {
    setStatus(err instanceof InviteError ? err.message : "não consegui criar o convite");
  } finally {
    generateBtn.disabled = false;
    // desabilitar o botão que está com o foco joga o foco no <body> — dali o
    // Tab não passa mais pelo listener do overlay e a armadilha morre calada
    shell?.keepFocus();
  }
}

function renderResult(): void {
  if (created === null) {
    resultBox.hidden = true;
    resultInput.value = "";
    return;
  }
  resultBox.hidden = false;
  resultInput.value = inviteLink(created.code);
}

function renderList(): void {
  const now = Date.now();
  if (invites.length === 0) {
    const empty = el("li", "inv-empty", "Nenhum link criado ainda.");
    listEl.replaceChildren(empty);
    return;
  }
  listEl.replaceChildren(...invites.map((inv) => inviteRow(inv, now)));
}

function inviteRow(inv: Invite, now: number): HTMLElement {
  const status = inviteStatus(inv, now);
  const alive = status === "ativo";
  const li = el("li", alive ? "inv-row" : "inv-row is-dead");

  const head = el("div", "inv-row-head");
  const code = el("code", "inv-code", inv.code);
  head.append(code);
  if (created?.code === inv.code) head.append(el("span", "inv-pill is-new", "novo"));
  if (!alive) head.append(el("span", "inv-pill is-dead", status));
  li.append(head);

  // quem criou: o membro pode não estar no mapa (saiu da guild) — o id curto
  // ainda diz mais do que "desconhecido" quando são dez pessoas
  const author = ctxRef?.state.members.get(inv.created_by);
  const authorName = author === undefined ? `user-${inv.created_by.slice(-4)}` : displayName(author);

  const meta = el("div", "inv-meta");
  meta.append(el("span", "", `por ${authorName}`));
  meta.append(el("span", "", `criado em ${ABSOLUTE.format(inv.created_at)}`));
  meta.append(el("span", "", usesText(inv)));
  meta.append(el("span", "", expiryText(inv, status, now)));
  li.append(meta);

  const actions = el("div", "inv-actions");
  if (alive) {
    const copy = el("button", "inv-btn inv-copy", "Copiar");
    copy.type = "button";
    copy.addEventListener("click", () => void copyInto(copy, inviteLink(inv.code)));

    const revoke = el("button", "inv-btn inv-danger", "Revogar");
    revoke.type = "button";
    revoke.addEventListener("click", () => void doRevoke(inv.code, revoke));
    actions.append(copy, revoke);
  } else {
    // morto não ganha botão de copiar: copiar um link que não funciona só
    // adianta a próxima mensagem de "não entrou"
    actions.append(el("span", "inv-dead-note", "este link não funciona mais"));
  }
  li.append(actions);
  return li;
}

function usesText(inv: Invite): string {
  if (inv.max_uses === null) return inv.uses === 1 ? "1 uso · ilimitado" : `${inv.uses} usos · ilimitado`;
  return `${inv.uses} de ${inv.max_uses} usos`;
}

function expiryText(inv: Invite, status: InviteStatus, now: number): string {
  if (status === "revogado") return inv.revoked_at === null ? "revogado" : `revogado ${relative(inv.revoked_at - now)}`;
  if (inv.expires_at === null) return "não expira";
  return inv.expires_at <= now ? `expirou ${relative(inv.expires_at - now)}` : `expira ${relative(inv.expires_at - now)}`;
}

async function doRevoke(code: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  setStatus("");
  try {
    await revokeInvite(code);
    // otimista, com o mesmo carimbo que o servidor usaria: o convite continua
    // na lista, agora esmaecido — que é o comportamento pedido no item 46
    invites = invites.map((inv) => (inv.code === code ? { ...inv, revoked_at: Date.now() } : inv));
    renderList();
  } catch (err) {
    btn.disabled = false;
    setStatus(err instanceof InviteError ? err.message : "não consegui revogar o convite");
  } finally {
    shell?.keepFocus();
  }
}

// ---------------------------------------------------------------------------
// API do módulo
// ---------------------------------------------------------------------------

/**
 * Abre o painel. `opener` recebe o foco de volta ao fechar (contrato da casca
 * de ui/dialog.ts). Chamar com um `ctx` de quem não é admin não abre nada — a
 * checagem de verdade é do servidor, esta só evita mostrar um diálogo que
 * responderia 403 em todos os botões.
 */
export function openInvites(ctx: UiContext, opener?: HTMLElement): void {
  const me = ctx.state.me;
  if (me === null || !isStaff(me)) return;
  ctxRef = ctx;
  shell ??= build();
  shell.open(opener);
}

/** Fecha (o `showLogin` do main.ts fecha TODAS as camadas flutuantes). */
export function closeInvites(): void {
  shell?.close();
}

/** os itens já criados, para o refresh alcançar todos (hoje é sempre um) */
const menuItems = new Set<HTMLButtonElement>();

/**
 * Item pronto para o menu da engrenagem (ui/sidebar.ts), no molde do
 * `soundMenuItem` (M8) e do `voiceSettingsMenuItem` (M9): existe para o
 * integrador não redigitar classe, `role` e rótulo.
 *
 * Nasce escondido para `member`. Como o cargo MUDA em tempo de execução (um
 * MEMBER_UPDATE promove alguém sem F5) e o menu é montado UMA vez, quem quiser
 * o item correto depois da promoção precisa chamar `refreshInvitesMenu(ctx)` —
 * está descrito no relatório, junto do call site.
 */
export function invitesMenuItem(ctx: UiContext, opener: HTMLElement, onPickItem?: () => void): HTMLButtonElement {
  const item = el("button", "menu-item");
  item.type = "button";
  item.setAttribute("role", "menuitem");
  item.append(icon("plus", 16), document.createTextNode("Convidar amigos"));
  item.addEventListener("click", () => {
    onPickItem?.();
    openInvites(ctx, opener);
  });
  menuItems.add(item);
  syncItem(item, ctx);
  return item;
}

function syncItem(item: HTMLButtonElement, ctx: UiContext): void {
  const me = ctx.state.me;
  item.hidden = me === null || !isStaff(me);
}

/**
 * Reavalia se o item do menu deve aparecer. Chamar de onde o cargo pode ter
 * mudado — o mesmo lugar em que o main.ts já repinta o painel do usuário.
 */
export function refreshInvitesMenu(ctx: UiContext): void {
  for (const item of menuItems) syncItem(item, ctx);
  // perder o cargo com o diálogo aberto: fecha, senão sobra uma tela de
  // administração cujos botões todos respondem 403
  const me = ctx.state.me;
  if ((me === null || !isStaff(me)) && shell?.isOpen === true) shell.close();
}
