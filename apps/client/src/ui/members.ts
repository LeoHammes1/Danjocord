/**
 * Coluna de membros (M7, estendida no M10). Substitui o renderMembers() do
 * main.ts, que era um <ul> de <li> com o username em texto puro rolando junto
 * com os canais.
 *
 * O M7 tinha DUAS seções — "Online" e "Offline" — porque presença era um
 * booleano. Com o status do M10 (item 56) elas viram QUATRO, na ordem do mais
 * presente ao menos: a seção é a leitura de longe ("dá para chamar o fulano?")
 * e a bolinha do avatar é a leitura de perto. Seção vazia não aparece: numa
 * guild de dez pessoas, quatro cabeçalhos com "— 0" seriam mais cabeçalho que
 * gente.
 *
 * A ordenação dentro da seção é ALFABÉTICA de propósito: o `state.members` é um
 * Map alimentado pelo READY e pelos MEMBER_ADD, então a ordem de inserção muda
 * a cada reconexão — a lista "embaralhava" sozinha sem ninguém ter entrado ou
 * saído. Ordena-se pelo nome EXIBIDO (item 55): quem lê procura o que está
 * escrito na tela, não o username que o apelido escondeu.
 *
 * Re-render total (replaceChildren) a cada chamada, e não diff: renderMembers
 * roda em todo PRESENCE_UPDATE, mas o teto do projeto é 10 pessoas — são ~50
 * nós. O único efeito colateral real do re-render é o foco de teclado, que
 * este módulo devolve na mão (ver focusedMemberId/restoreFocus).
 */
import { type PresenceStatus, type Role, displayName } from "@danjocord/protocol";
import { avatarEl } from "./avatar.js";
import type { UiContext, User } from "./context.js";
import { STATUS_LABEL, STATUS_ORDER, statusOf } from "./presence.js";

/**
 * O nó é resolvido uma vez: o main.ts importa este módulo depois do parse do
 * documento (script type="module" no fim do body), então o #members já existe.
 */
const root = document.getElementById("members")!;

/**
 * Selo de cargo (M10, item 51). Substitui o `is_admin === true` do M2, que era
 * um booleano e por isso não sabia distinguir o dono de quem ele promoveu —
 * distinção que importa justamente na hora de saber a quem pedir alguma coisa.
 * `member` não ganha selo: é o normal, e um selo em todo mundo não informa nada.
 */
const ROLE_BADGE: Record<Role, string> = { owner: "dono", admin: "admin", member: "" };

/**
 * Desenha a coluna inteira. `onSelectMember` é OPCIONAL porque o card do membro
 * pode não estar montado ainda — sem handler a linha nasce `disabled`, e um
 * botão que não faz nada mas parece clicável é pior que um desabilitado.
 */
export function renderMembers(ctx: UiContext, onSelectMember?: (userId: string) => void): void {
  const all = [...ctx.state.members.values()].sort(byName);

  const focused = focusedMemberId();
  const nodes: HTMLElement[] = [headEl(all.length)];
  if (all.length === 0) nodes.push(emptyEl());
  for (const status of STATUS_ORDER) {
    const group = all.filter((m) => statusOf(ctx.state, m.id) === status);
    if (group.length > 0) nodes.push(sectionEl(STATUS_LABEL[status], group, status, onSelectMember));
  }
  root.replaceChildren(...nodes);
  restoreFocus(focused);
}

/**
 * MEMBER_REMOVE (M10, item 52): kick, ban ou remoção pelo CLI. O integrador
 * apaga o membro do `state` e chama isto — a lista não pode continuar mostrando
 * (nem deixando moderar) alguém que já não pode entrar.
 *
 * Existe em vez de "chame renderMembers de novo" por uma razão só, e ela é de
 * teclado: se a linha que sumiu era a focada, o `restoreFocus` não acha mais
 * nada e o foco cai no <body> — quem navega sem mouse recomeça do topo do
 * documento. Aqui o foco vai para o cabeçalho da coluna, que é o vizinho vivo
 * mais próximo.
 */
export function memberRemoved(ctx: UiContext, userId: string, onSelectMember?: (userId: string) => void): void {
  const hadFocus = focusedMemberId() === userId;
  renderMembers(ctx, onSelectMember);
  if (!hadFocus) return;
  const head = root.querySelector<HTMLElement>(".members-head");
  if (head === null) return;
  head.tabIndex = -1; // alvo de foco programático; não entra na ordem do Tab
  head.focus();
}

/** pt-BR + sensitivity "base": acento e caixa não mandam alguém para o fim. */
function byName(a: User, b: User): number {
  return displayName(a).localeCompare(displayName(b), "pt-BR", { sensitivity: "base" });
}

function headEl(total: number): HTMLElement {
  const h = document.createElement("h2");
  h.className = "members-head";
  h.textContent = `Membros — ${total}`;
  return h;
}

function emptyEl(): HTMLElement {
  const p = document.createElement("p");
  p.className = "members-empty";
  p.textContent = "ninguém por aqui ainda";
  return p;
}

function sectionEl(
  label: string,
  users: User[],
  status: PresenceStatus,
  onSelectMember?: (userId: string) => void,
): HTMLElement {
  const section = document.createElement("section");
  section.className = `member-group member-group-${status}`;

  const title = `${label} — ${users.length}`;
  const head = document.createElement("h3");
  head.className = "member-group-head";
  head.textContent = title;

  const list = document.createElement("ul");
  list.className = "member-list";
  // a <ul> carrega o rótulo da seção: o leitor de tela anuncia "lista Ausente —
  // 3" ao entrar nela, sem depender de o usuário ter passado pelo <h3>
  list.setAttribute("aria-label", title);
  list.append(...users.map((u) => rowEl(u, status, onSelectMember)));

  section.append(head, list);
  return section;
}

function rowEl(user: User, status: PresenceStatus, onSelectMember?: (userId: string) => void): HTMLElement {
  const li = document.createElement("li");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "member";
  btn.dataset["userId"] = user.id; // âncora do restoreFocus
  if (onSelectMember === undefined) btn.disabled = true;
  else btn.onclick = () => onSelectMember(user.id);

  btn.append(avatarEl(user, 32, status));

  const name = document.createElement("span");
  name.className = "member-name";
  name.textContent = displayName(user);
  // o username fica no title de quem tem apelido: com dois amigos de apelido
  // parecido, é a única forma de saber quem é quem sem abrir o card
  if (user.nickname !== null) name.title = user.username;
  btn.append(name);

  // Silenciado no texto (item 53). `muted_until` chega RESOLVIDO do servidor
  // (vencido = null), mas o vencimento em si não gera evento — a comparação
  // com o relógio local evita o selo fantasma até o próximo MEMBER_UPDATE.
  if (user.muted_until !== null && user.muted_until > Date.now()) {
    const timeout = document.createElement("span");
    timeout.className = "member-badge is-timeout";
    timeout.textContent = "silenciado";
    timeout.title = `Sem escrever até ${new Date(user.muted_until).toLocaleString("pt-BR")}`;
    btn.append(timeout);
  }

  const role = ROLE_BADGE[user.role];
  if (role !== "") {
    const badge = document.createElement("span");
    badge.className = `member-badge is-${user.role}`;
    badge.textContent = role;
    btn.append(badge);
  }

  li.append(btn);
  return li;
}

// --- foco -----------------------------------------------------------------
// O replaceChildren joga fora o elemento focado e o foco volta para o <body>:
// quem estava navegando a lista por Tab/setas era cuspido para o começo da
// página toda vez que alguém ficasse online. Guardar o id e refocar depois
// custa duas funções e resolve.

function focusedMemberId(): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
  return active.dataset["userId"] ?? null;
}

function restoreFocus(userId: string | null): void {
  if (userId === null) return;
  // CSS.escape: o id é um snowflake em string, e um seletor de atributo com
  // valor não escapado é uma porta aberta que não custa nada fechar
  const again = root.querySelector<HTMLButtonElement>(`.member[data-user-id="${CSS.escape(userId)}"]`);
  again?.focus();
}
